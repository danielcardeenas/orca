/**
 * Every agent in the fleet, in one draw call.
 *
 * One InstancedMesh of quads and a fragment shader that draws the comp's
 * notched tile: dark body, 1px line, the state colour riding the left edge,
 * a bite out of the right side. A blocked tile inverts to its colour and
 * breathes; a working tile carries a travelling band whose speed is
 * tokens/sec; a selected tile gets a lime line. Around the tile, in the same
 * quad, a glow that only alert and working tiles are allowed to have.
 *
 * Two things ride on top of that. `iFlash` is the shader-clock instant an
 * agent last changed state: the tile snaps to its state colour and decays in
 * ~120 ms, so a patch that moves twenty agents reads as one beat. `uFocus`
 * is the focus mode: everything the selection does not touch drops to the
 * alpha the field asked for and loses its glow, so the relationships stay.
 *
 * Two more ride there, and they are the tile's identity rather than its state.
 * `iSigil` carries fifteen bits (see gfx/sigil.ts) that the shader decodes
 * into a 5×5 mirrored glyph in the top-right corner, clear of the bite: the
 * agent's mark, or its squad's, legible at sixty pixels where no label fits.
 * `iAux.z` marks a squad's lead, and a lead wears that same glyph inverted —
 * a block of ink with the cells cut out — which is what "head of the squad"
 * looks like when it also has to say *of which squad*. `iAux.w` is the
 * runtime, and it textures the state stripe on the left edge: solid for
 * Claude, 2:1 dashes for Codex, 1:1 dots for Grok, a thinner solid for
 * anything else. Runtime 9 is CAPCOM, and it is the one tile in cyan: a
 * permanent cyan outline and glow, a cyan sigil, a faint cyan cast on the
 * body, and a trace that sweeps the tile top to bottom every few seconds
 * like the beam of a scope. There is one of it, it is the voice that talks
 * back, and nothing else on the field may wear that colour. Its *turn* —
 * a faster beat and a solid outline while it works, amber while it waits on
 * the operator — arrives as the `uCap` uniform from field/command.ts, which
 * also draws the halo of missions around it.
 *
 * No text here. Text at this scale is what kills a scene, and the field
 * solves it by not trying: labels are DOM, and only for tiles big enough to
 * read (see labels.ts).
 */

import * as THREE from 'three';
import { TILE_W, TILE_H } from './layout.ts';
import { shaderMotion } from '../motion.ts';

/** Glow margin around the tile, in world units, inside the same quad. */
export const PAD = 0.34;
const QUAD_W = TILE_W + PAD * 2;
const QUAD_H = TILE_H + PAD * 2;

const VERT = /* glsl */ `
  attribute vec3 iColor;
  attribute vec4 iFlags;
  attribute float iSeed;
  attribute float iSigil; // 15 bits, the 5x5 glyph (gfx/sigil.ts)
  attribute vec4 iAux; // last state change (shader clock), alpha under focus, squad lead, runtime id
  attribute vec4 iForm; // scale, plates (0-2), topology bits (1 child · 2 parent · 4 external), life (0 live · 1 done · 2 dead)
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec4 vFlags;
  varying float vSeed;
  varying float vSigil;
  varying vec4 vAux;
  varying vec4 vForm;
  void main() {
    vUv = uv;
    vColor = iColor;
    vFlags = iFlags;
    vSeed = iSeed;
    vSigil = iSigil;
    vAux = iAux;
    vForm = iForm;
    vec4 wp = instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uPxPerUnit;
  uniform vec2 uInner;
  uniform vec2 uSize;
  uniform vec3 uBody;
  uniform vec3 uLine;
  uniform vec3 uLineHot;
  uniform float uLinePx;
  uniform vec3 uLime;
  uniform vec3 uCyan;
  uniform vec3 uAuto;
  uniform vec3 uInk;
  uniform float uReduce;
  uniform float uFocus;
  uniform float uBreathe;
  uniform float uFlashK;
  uniform vec3 uCap; // CAPCOM's turn (command.ts): in a turn, waiting on the operator, pulse enabled
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec4 vFlags;
  varying float vSeed;
  varying float vSigil;
  varying vec4 vAux;
  varying vec4 vForm;

  /*
   * The tile's silhouette at a point: 1 inside, 0 outside.
   *
   * The bite is two nested rectangles cut from the right edge, as in the
   * comp — and it is the port the parent's pipe lands in, so only a child
   * wears it: a root is a whole rectangle. On a tile wide enough to read a
   * sentence in (labels.ts tier 4, 320 px) it only eats the words, so it
   * slides out of the right edge between 260 and 320 px (bk) and is gone.
   * The tab is a parent's: a small step under the bottom edge, where its
   * ties leave (pipes.ts: x = P.x - 0.32).
   */
  float shape(vec2 t, float bk, float tab) {
    float ins = step(0.0, t.x) * step(t.x, 1.0) * step(0.0, t.y) * step(t.y, 1.0);
    float b1 = step(mix(0.70, 1.0, bk), t.x) * step(0.36, t.y) * step(t.y, 0.64);
    float b2 = step(mix(0.82, 1.0, bk), t.x) * step(0.30, t.y) * step(t.y, 0.70);
    float tb = tab * step(0.11, t.x) * step(t.x, 0.25) * step(-0.055, t.y) * step(t.y, 0.0);
    return max(ins * (1.0 - max(b1, b2)), tb);
  }

  void main() {
    // Quad uv → tile uv. Outside 0..1 is the glow margin.
    vec2 t = (vUv - 0.5) / uInner + 0.5;
    // The form: bits and counts, see iForm.
    float topo = vForm.z;
    float isChild = mod(topo, 2.0);
    float isParent = mod(floor(topo / 2.0), 2.0);
    float isExt = mod(floor(topo / 4.0), 2.0);
    float plates = vForm.y;
    float life = vForm.w;
    // alert: 0 quiet · 0.5 amber edge only, dark body, no glow (the block is
    // real but you cannot answer it from here) · 1 full amber, glow and
    // breathing (there is a pending escalation with your name on it).
    float alert = vFlags.x;
    float speed = vFlags.y;
    float sel   = vFlags.z;
    float alpha = vFlags.w;
    float full  = step(0.75, alert);
    float rim   = step(0.25, alert) * (1.0 - full);

    // Focus: the selection keeps its alpha, everything else drops to what the
    // field decided (a neighbour is legible, a stranger is a ghost).
    float focusA = vAux.y;
    alpha = mix(alpha, focusA, uFocus);
    // Anything the focus dims is also denied its glow.
    float lit = step(0.99, focusA);
    float glowGate = 1.0 - uFocus * (1.0 - lit);

    // The beat: a state change snaps the body to the state colour and decays.
    float flash = exp(-(uTime - vAux.x) * uFlashK) * (1.0 - uReduce);

    // One screen pixel, in tile uv — of this instance, which may be a cell.
    vec2 px = 1.0 / (uSize * uPxPerUnit * vForm.x);

    // The bite leaves as the tile grows, and a root never had one.
    float bk = max(smoothstep(260.0, 320.0, uPxPerUnit * vForm.x), 1.0 - isChild);
    float m = shape(t, bk, isParent);
    /*
     * The command's turn (command.ts). There is one CAPCOM, so its state is a
     * uniform and costs no instance anything. With the pulse on, the outline
     * rests a shade under full cyan and comes up solid — and half again as
     * wide — while CAPCOM is in a turn; its glow beats 2.6× faster then, and
     * tints amber while it waits on the operator. With the pulse off every
     * factor here is 1 or 0 and the tile is what it was.
     */
    float rt = vAux.w;
    float isCap = step(8.5, rt);
    /*
     * Un agente revisor de AUTOMEJORA (runtime 8). Lleva una línea violeta
     * permanente y un sigilo violeta, igual que CAPCOM lleva la suya cian: es
     * una IDENTIDAD —qué función cumple— y por eso no toca el color del
     * cuerpo ni la banda del borde izquierdo, que siguen diciendo su estado
     * real. Un revisor bloqueado se ve ámbar y uno muerto se ve rojo; lo
     * violeta sólo dice quién es. Corre en Claude Code, así que su trama es
     * la sólida por serlo, no por ser 8.
     */
    // FORGE uses 4–7: the existing self-improvement outline, with
    // the actual runtime preserved in the low two bits.
    float isForge = step(3.5, rt) * step(rt, 7.5);
    float isRev = max(isForge, step(7.5, rt) * step(rt, 8.5));
    rt -= isForge * 4.0;
    float capTurn = isCap * uCap.x;
    float capWait = isCap * uCap.y;
    float capPulse = isCap * uCap.z;
    /*
     * The outline: a band uLinePx screen pixels wide just inside the
     * silhouette, plus the boundary pixel itself. One pixel of --line on a
     * body two shades darker was a border nobody could find; the band is
     * what makes a tile's area legible against the ground at every zoom.
     * Sampling the shape a band's width away in each direction follows the
     * bite as faithfully as the edge does.
     */
    // A cell in a tray is a small thing; two pixels of border would be most of it.
    float w = uLinePx * mix(0.5, 1.0, smoothstep(0.4, 0.8, vForm.x)) * (1.0 + 0.5 * capTurn);
    float inner = min(min(shape(t + vec2(px.x * w, 0.0), bk, isParent), shape(t - vec2(px.x * w, 0.0), bk, isParent)),
                      min(shape(t + vec2(0.0, px.y * w), bk, isParent), shape(t - vec2(0.0, px.y * w), bk, isParent)));
    float edge = max(step(0.001, fwidth(m)), m * (1.0 - inner));
    // A session ORCA did not launch: in the fleet, not of it. Its outline is dashed.
    float perim = (t.x * uSize.x + t.y * uSize.y) * uPxPerUnit * vForm.x;
    // Long dashes, short gaps: a break in the line, not a busy dotted border —
    // most of a working fleet is external sessions, and forty dotted tiles hum.
    edge *= 1.0 - isExt * step(0.72, fract(perim / 28.0));

    /*
     * Plates (§2.3): a squad member stands on one plate, its lead on two —
     * the same silhouette stepped down and to the right, a shade lighter
     * than the body, so the block reads as stacked without a camera angle.
     */
    vec2 stepOff = vec2(0.028, -0.036);
    float pl1 = step(0.5, plates) * shape(t - stepOff, bk, isParent) * (1.0 - m);
    float pl2 = step(1.5, plates) * shape(t - stepOff * 2.0, bk, isParent) * (1.0 - m) * (1.0 - pl1);

    float breathe = 0.5 + 0.5 * sin(uTime * uBreathe + vSeed * 6.283);
    breathe = mix(breathe, 1.0, uReduce);
    // CAPCOM's own beat: the tile's at rest, 2.6× in a turn.
    float capBeat = 0.5 + 0.5 * sin(uTime * uBreathe * mix(1.0, 2.6, capTurn) + vSeed * 6.283);
    capBeat = mix(capBeat, 1.0, uReduce);

    vec3 lineCol = sel > 1.5 ? uLime : (sel > 0.5 ? uLineHot : uLine);
    // CAPCOM (runtime 9) keeps a cyan outline whether or not it is selected:
    // there is one of it in the fleet and it is the one that talks back. At
    // rest, with the pulse on, it sits at 72 % so the turn has room to be solid.
    vec3 capLine = uCyan * mix(1.0, mix(0.72, 1.0, capTurn), capPulse);
    lineCol = mix(lineCol, capLine, isCap);
    // El revisor, igual pero sin latido: no manda, sólo mira. Se apaga bajo la
    // selección, que sigue siendo lima y sigue ganando.
    lineCol = mix(lineCol, uAuto, isRev * step(sel, 0.5));

    vec3 col;
    float a;
    if (m > 0.5) {
      col = mix(uBody, vColor * (0.80 + 0.20 * breathe), full);
      // The command's body: the same dark, cast a shade toward cyan. Linear
      // space: 2.5 % of a bright cyan on a body this dark already reads.
      col = mix(col, uCyan, isCap * (1.0 - full) * (0.025 + 0.03 * capTurn * capBeat));
      // Un tinte violeta del mismo orden que el del mando: a la distancia a la
      // que el cuerpo es lo único que se ve, el tile ya dice qué es.
      col = mix(col, uAuto, isRev * (1.0 - full) * 0.03);
      /*
       * The trace (§1.3): one cyan line crossing the tile top to bottom every
       * ~6 s with a short wake behind it, the way a beam crosses a scope. It
       * has no end, so it lives here and not in anim.ts; under reduced motion
       * it stands still and the colour alone says command.
       */
      float sy = 1.0 - fract(uTime * 0.16 * (1.0 - uReduce) + 0.35 * uReduce);
      float trace = exp(-abs(t.y - sy) * 70.0) * 0.55 + exp(-max(sy - t.y, 0.0) * 9.0) * 0.09;
      col = mix(col, uCyan, isCap * (1.0 - full) * trace);
      // State on the left edge, at least 2px. The rim treatment widens it:
      // that stripe is the whole signal when the body stays dark. Its texture
      // is the runtime — the one runtime signal that survives every zoom,
      // measured in tile units so a big tile does not show a hundred dashes:
      // 0 claude solid · 1 codex 2:1 dashes · 2 grok 1:1 dots · 3 other, a
      // thinner solid. 9 (CAPCOM) reads as solid; its outline says the rest.
      float edgeW = max(0.045, px.x * 2.5) * (1.0 + rim * 0.9);
      float isDash = step(0.5, rt) * step(rt, 1.5);
      float isDot  = step(1.5, rt) * step(rt, 2.5);
      float isThin = step(2.5, rt) * step(rt, 3.5);
      float duty = mix(mix(1.0, 0.667, isDash), 0.5, isDot);
      float tick = step(fract(t.y * 10.0), duty);
      float stripeW = edgeW * mix(1.0, 0.55, isThin);
      col = mix(col, vColor, (1.0 - full) * step(t.x, stripeW) * tick);
      // Travelling band along the bottom: speed, never progress.
      float bandH = max(0.07, px.y * 3.0);
      float inBand = step(px.y * 2.0, t.y) * step(t.y, px.y * 2.0 + bandH) * step(0.001, speed) * (1.0 - full);
      float ph = fract(t.x - uTime * (0.2 + speed * 1.1) * (1.0 - uReduce));
      col = mix(col, vColor, inBand * step(ph, 0.3) * 0.95);
      col = mix(col, vColor, flash * 0.9);
      /*
       * The sigil: a 5x5 glyph in the top-right corner, clear of the bite
       * (which starts at y 0.30 and stops at 0.70). Fifteen bits, mirrored
       * about the vertical axis — for cell (cx, cy) with cx' = min(cx, 4-cx),
       * the bit is at cy*3 + cx'. Row 0 is the top row, so the row index is
       * counted down from tile uv, which grows up. gfx/sigil.ts writes the
       * same bits to DOM for the window header and the squad label.
       *
       * No loop: the cell comes straight out of uv, so the whole mark is two
       * floors and one exp2 per pixel inside a 0.155 x 0.155 patch of tile.
       */
      vec2 sg = (t - vec2(0.80, 0.775)) / 0.155;
      float inSg = step(0.0, sg.x) * step(sg.x, 1.0) * step(0.0, sg.y) * step(sg.y, 1.0);
      vec2 cell = floor(clamp(sg, 0.0, 0.9999) * 5.0);
      float cx = min(cell.x, 4.0 - cell.x);
      float cy = 4.0 - cell.y;
      float bit = mod(floor(vSigil / exp2(cy * 3.0 + cx)), 2.0);
      /*
       * Ink on a dark body, body on a full amber tile: the sigil says who,
       * never how it is. The lead inverts it — the whole 5x5 block goes to
       * ink and the glyph's own cells are cut back out in body colour, which
       * is whatever the tile is at that pixel.
       */
      float lead = step(0.5, vAux.z);
      float on = mix(bit, 1.0 - bit, lead);
      // CAPCOM's mark is cyan ink: the C reads as the command's own seal.
      col = mix(col, mix(mix(mix(uInk, uCyan, isCap), uAuto, isRev), uBody, full), inSg * on);
      /*
       * Life (§2.3). Done: a perforation along the bottom margin — the tear
       * line of a used ticket. It runs at y 0.09, in the strip under the
       * label column (which stops at 11 %) where the speed band would be and
       * no text ever is, so it never crosses a word. Dead: hollow — the
       * outline and the mark remain, the body is gone, the way a port goes
       * hollow when its core drains.
       */
      float isDone = step(0.5, life) * step(life, 1.5);
      float perf = isDone * step(abs(t.y - 0.09), px.y) * step(0.06, t.x) * step(t.x, 0.94)
                 * step(0.5, fract(t.x * uSize.x * uPxPerUnit * vForm.x / 10.0));
      col = mix(col, lineCol, perf);
      col = mix(col, lineCol, edge);
      float isDead = step(1.5, life);
      a = alpha * mix(1.0, max(edge, inSg * on), isDead);
    } else {
      if (edge > 0.5) {
        col = lineCol;
        a = alpha;
      } else if (pl1 + pl2 > 0.5) {
        col = mix(uBody, uLine, pl1 > 0.5 ? 0.55 : 0.3);
        a = alpha;
      } else {
        vec2 dd = max(abs(t - 0.5) - 0.5, 0.0) * uSize;
        float dist = length(dd);
        // CAPCOM glows always, on a slow breath: the one lit thing at rest.
        // In a turn it is brighter and beats faster; waiting on the operator
        // it takes the state colour — amber — the way the halo does.
        float amt = full * (0.55 + 0.25 * breathe)
                  + (1.0 - full) * step(0.001, speed) * 0.22
                  + step(1.5, sel) * 0.2
                  + isCap * (1.0 - full) * (mix(0.26, 0.40, capTurn) + mix(0.16, 0.28, capTurn) * capBeat + 0.22 * capWait);
        float g = exp(-dist * 6.5) * amt * glowGate;
        col = mix(vColor, uLime, step(1.5, sel) * 0.5);
        col = mix(col, uCyan, isCap * (1.0 - full));
        col = mix(col, vColor, capWait * (1.0 - full) * 0.85);
        a = g * alpha;
      }
    }
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }
`;

export interface SwarmHandle {
  mesh: THREE.InstancedMesh;
  ensure(n: number): void;
  /**
   * One instance. `sigil` is the fifteen bits of `sigilBits(seed)` — the
   * agent's id for a loner, the squad's *name* for a member, `CAPCOM_BITS`
   * for CAPCOM — and `lead` inverts it. `runtime` is
   * 0 claude · 1 codex · 2 grok · 3 other · 9 capcom, and it textures the
   * state stripe (and, at 9, paints the tile as the command: cyan).
   */
  write(
    slot: number, x: number, y: number, z: number, scale: number,
    color: [number, number, number], alert: number, speed: number, sel: number, alpha: number, seed: number,
    flash: number, focusAlpha: number, lead: number, sigil: number, runtime: number,
    /** `iForm`: scale, plates, topology bits, life. See the vertex shader. */
    form: [number, number, number, number],
  ): void;
  commit(count: number, time: number, pxPerUnit: number): void;
  /** 0 → 1: how far into focus mode the field is. Eased by the caller. */
  setFocus(v: number): void;
  /**
   * CAPCOM's turn (command.ts): `turn` 1 while it thinks or works, `waiting`
   * 1 while it waits on the operator, `pulse` 0 to draw the tile as it was
   * before any of this. One CAPCOM, so these are uniforms.
   */
  setCommand(turn: number, waiting: number, pulse: number): void;
  dispose(): void;
}

function lin(hex: number): THREE.Vector3 {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

export function createSwarm(scene: THREE.Scene): SwarmHandle {
  let cap = 512;
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uPxPerUnit: { value: 60 },
      uInner: { value: new THREE.Vector2(TILE_W / QUAD_W, TILE_H / QUAD_H) },
      uSize: { value: new THREE.Vector2(TILE_W, TILE_H) },
      uBody: { value: lin(0x1c1f29) },
      // `--line-tile`: a step above `--line`. The instrument border is drawn
      // once around a window; a tile stands on the noisy ground among forty
      // others and needs the extra shade to hold its area.
      uLine: { value: lin(0x4a5262) },
      uLinePx: { value: 2.0 },
      uLineHot: { value: lin(0x8b9088) },
      uLime: { value: lin(0xc0f94a) },
      // `--cyan`: CAPCOM's, and nobody else's.
      uCyan: { value: lin(0x4fe3ff) },
      uAuto: { value: lin(0xb47cff) },
      uInk: { value: lin(0xf2f4f0) },
      uReduce: { value: shaderMotion().reduce ? 1 : 0 },
      uBreathe: { value: shaderMotion().breathe },
      uFlashK: { value: shaderMotion().flash },
      uFocus: { value: 0 },
      uCap: { value: new THREE.Vector3(0, 0, 0) },
    },
  });

  let mesh = new THREE.InstancedMesh(geo, mat, cap);
  let color = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  let flags = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  let seed = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  let sig = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  let aux = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  let form = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  attach();
  scene.add(mesh);

  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();

  function attach() {
    color.setUsage(THREE.DynamicDrawUsage);
    flags.setUsage(THREE.DynamicDrawUsage);
    seed.setUsage(THREE.DynamicDrawUsage);
    sig.setUsage(THREE.DynamicDrawUsage);
    aux.setUsage(THREE.DynamicDrawUsage);
    form.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('iForm', form);
    mesh.geometry.setAttribute('iColor', color);
    mesh.geometry.setAttribute('iFlags', flags);
    mesh.geometry.setAttribute('iSeed', seed);
    mesh.geometry.setAttribute('iSigil', sig);
    mesh.geometry.setAttribute('iAux', aux);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
  }

  return {
    get mesh() { return mesh; },

    ensure(n) {
      if (n <= cap) return;
      while (cap < n) cap *= 2;
      scene.remove(mesh);
      mesh.dispose();
      // Attributes live on the geometry, which is shared; rebuild them too.
      const g = new THREE.PlaneGeometry(1, 1);
      mesh = new THREE.InstancedMesh(g, mat, cap);
      color = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      flags = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      seed = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      sig = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      aux = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      form = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      attach();
      scene.add(mesh);
    },

    write(slot, x, y, z, scale, c, alert, speed, sel, alpha, sd, flash, focusAlpha, lead, sigil, runtime, f) {
      form.setXYZW(slot, f[0], f[1], f[2], f[3]);
      pos.set(x, y, z);
      scl.set(QUAD_W * scale, QUAD_H * scale, 1);
      m4.compose(pos, quat, scl);
      mesh.setMatrixAt(slot, m4);
      color.setXYZ(slot, c[0], c[1], c[2]);
      flags.setXYZW(slot, alert, speed, sel, alpha);
      seed.setX(slot, sd);
      sig.setX(slot, sigil);
      aux.setXYZW(slot, flash, focusAlpha, lead, runtime);
    },

    commit(count, time, pxPerUnit) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      color.needsUpdate = true;
      flags.needsUpdate = true;
      seed.needsUpdate = true;
      sig.needsUpdate = true;
      aux.needsUpdate = true;
      form.needsUpdate = true;
      mat.uniforms.uTime!.value = time;
      mat.uniforms.uPxPerUnit!.value = pxPerUnit;
    },

    setFocus(v) { mat.uniforms.uFocus!.value = v; },

    setCommand(turn, waiting, pulse) { (mat.uniforms.uCap!.value as THREE.Vector3).set(turn, waiting, pulse); },

    dispose() {
      scene.remove(mesh);
      mesh.dispose();
      geo.dispose();
      mat.dispose();
    },
  };
}
