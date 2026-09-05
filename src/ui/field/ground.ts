/**
 * The ground: the panel itself.
 *
 * Under the fleet there is a screen — a matrix of RGB subpixels seen close,
 * the way a macro lens sees an LCD: three dim stripes per cell, a black mask
 * between them, a faint light falling from the top-left and the edges going
 * soft and dark. It is what makes the canvas read as a surface you are
 * looking at rather than a void things float in, and it is the motion cue
 * when the camera pans.
 *
 * One plane, one shader, no texture. The cell pitch is chosen per frame so a
 * cell always covers 8–16 screen pixels: below that a subpixel matrix is
 * moiré, above it is a wall of stripes. Two octaves are drawn and blended by
 * the fractional part of the zoom, so pulling back never pops from one pitch
 * to the next — the finer cells dissolve into the coarser ones.
 *
 * Nothing here moves on its own. The per-cell variation is a hash, fixed
 * for the life of the panel, so the matrix is uneven like a real one and
 * still perfectly still.
 */

import * as THREE from 'three';

/** Depth of the panel under the plane the tiles stand on. */
export const GROUND_Z = -2.5;

/** Screen pixels a cell should cover, at the low end; the high end is twice. */
const CELL_PX = 12;
/** Stripe brightness at level 1. Level 0.5 is the console's default. */
const GLOW_MAX = 0.14;

export interface GroundHandle {
  /**
   * Once per frame: where the camera is, pixels per world unit *at the
   * ground's depth*, and the drawing buffer size in device pixels.
   */
  update(camX: number, camY: number, ppuAtGround: number, bufW: number, bufH: number): void;
  /** How bright the matrix glows, 0 (a plain bezel) … 1. The operator's knob. */
  setLevel(v: number): void;
  /** Colour stripes, or the same grid in grey. */
  setColor(on: boolean): void;
  dispose(): void;
}

const VERT = /* glsl */ `
  varying vec2 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xy;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform float uPitch;   // world units per cell, coarse octave = 2·uPitch
  uniform float uBlend;   // 0 → all fine, 1 → all coarse
  uniform vec2  uRes;     // drawing buffer, device px
  uniform vec3  uBase;    // the bezel: what the mask between subpixels is
  uniform float uGlow;    // stripe brightness, 0..1
  uniform float uChroma;  // 1 keeps the RGB stripes, 0 turns them the same grey
  varying vec2 vWorld;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  /*
   * One octave of the matrix at pitch \`p\`: returns the lit colour of the
   * subpixel under this fragment, or the mask. Stripes are vertical (R G B
   * left to right); the mask is a 12 % gutter on every side and 8 % between
   * stripes — the comp's LCD macro, not a Bayer pattern.
   */
  vec3 octave(vec2 w, float p, float aa) {
    vec2 cell = floor(w / p);
    vec2 f = fract(w / p);
    // Cell-level unevenness, skewed dark: most cells barely glow and a few
    // catch the light — the macro's sparkle, not a uniform field.
    float v = 0.18 + 0.82 * pow(hash(cell), 3.0);
    // Lit blocks: rectangular patches of the panel that are driven, the way
    // the reference has a few bright windows on a dark matrix. Static.
    vec2 blk = floor(cell / vec2(11.0, 6.0));
    float lit = step(0.92, hash(blk + 17.0));
    v *= 1.0 + 2.2 * lit;
    // Horizontal gutter (rows).
    float rowIn = smoothstep(0.12 - aa, 0.12 + aa, f.y) * (1.0 - smoothstep(0.88 - aa, 0.88 + aa, f.y));
    // Three stripes across x, each in its own third with 8 % of black between.
    float sx = f.x * 3.0;
    float k = floor(sx);
    float g = fract(sx);
    float colIn = smoothstep(0.14 - aa, 0.14 + aa, g) * (1.0 - smoothstep(0.86 - aa, 0.86 + aa, g));
    vec3 stripe = k < 0.5 ? vec3(0.62, 0.16, 0.14) : (k < 1.5 ? vec3(0.16, 0.62, 0.22) : vec3(0.14, 0.24, 0.68));
    // Mono: the same three stripes, in the grey their colours weigh — the
    // grid stays, the chroma goes.
    stripe = mix(vec3(dot(stripe, vec3(0.2126, 0.7152, 0.0722))), stripe, uChroma);
    float on = rowIn * colIn;
    return mix(uBase, uBase + stripe * uGlow * v, on);
  }

  void main() {
    // Anti-aliasing width in cell units, from how fast the cell uv changes
    // per pixel. Coarser octave has half the rate.
    float aaF = fwidth(vWorld.x / uPitch) * 1.2;
    float aaC = aaF * 0.5;
    vec3 fine = octave(vWorld, uPitch, aaF);
    vec3 coarse = octave(vWorld, uPitch * 2.0, aaC);
    vec3 col = mix(fine, coarse, uBlend);

    // Screen-space shading: a light from the top-left, and the edges falling
    // away — dark and soft, the macro's depth of field.
    vec2 s = gl_FragCoord.xy / uRes;          // 0..1, y up
    float light = 1.0 - 0.3 * smoothstep(-0.2, 1.3, (s.x + (1.0 - s.y)) * 0.5);
    vec2 c = s - 0.5;
    c.x *= uRes.x / uRes.y;
    float r = length(c);
    float soft = smoothstep(0.42, 1.05, r);
    // Out of focus: the stripes dissolve toward the panel's mean colour.
    vec3 mean = uBase + vec3(0.20, 0.22, 0.24) * uGlow;
    col = mix(col, mean, soft * 0.85);
    col *= light * (1.0 - 0.55 * smoothstep(0.55, 1.15, r));

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

function lin(hex: number): THREE.Vector3 {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

export function createGround(scene: THREE.Scene): GroundHandle {
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uPitch: { value: 0.25 },
      uBlend: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
      // The bezel, in linear light: the shader converts to sRGB on output.
      uBase: { value: lin(0x0b0a0d) },
      uGlow: { value: GLOW_MAX * 0.5 },
      uChroma: { value: 0 },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  // Far enough behind the tiles that a tilted camera never cuts it, and big
  // enough that no edge ever shows; the shader works in world space so the
  // size of the quad is not the size of anything.
  mesh.position.z = GROUND_Z;
  mesh.scale.set(4000, 4000, 1);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  scene.add(mesh);

  return {
    update(cx, cy, ppu, bufW, bufH) {
      mesh.position.x = cx;
      mesh.position.y = cy;
      // Pitch in world units so a cell spans CELL_PX..2·CELL_PX device pixels:
      // pick the power of two just above CELL_PX / ppu and blend toward the
      // next one by where the zoom sits between them.
      const want = CELL_PX / Math.max(1e-4, ppu);
      const k = Math.ceil(Math.log2(want));
      const pitch = Math.pow(2, k);
      // 0 just after a step in (cells at 2·CELL_PX), 1 as cells shrink to
      // CELL_PX — where the coarse octave has fully taken over and becomes
      // the fine one of the next step without a seam.
      const frac = Math.log2(want) - (k - 1);
      mat.uniforms.uPitch!.value = pitch;
      mat.uniforms.uBlend!.value = Math.max(0, Math.min(1, frac));
      (mat.uniforms.uRes!.value as THREE.Vector2).set(Math.max(1, bufW), Math.max(1, bufH));
    },
    setColor(on) { mat.uniforms.uChroma!.value = on ? 1 : 0; },
    setLevel(v) {
      mat.uniforms.uGlow!.value = GLOW_MAX * Math.max(0, Math.min(1, v));
    },
    dispose() {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
}
