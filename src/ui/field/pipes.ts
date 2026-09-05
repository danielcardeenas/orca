/**
 * Pipes: the comp's tree, drawn between agents.
 *
 * Every relationship is an orthogonal pipe with a square port at each end.
 * Lineage is drawn twice, the way the comp draws it: a grey **bus** that says
 * the child exists, and inside it a thinner **core** that carries the lime and
 * says the child is working. The bus never changes; the core grows out of the
 * parent when the child is born and drains back when it dies, so lime means
 * activity again instead of "there is a pipe here". An `ask` is amber with a
 * dash that travels toward whoever owes the answer. A `notice` is blue and
 * fades over a minute. A collision is red and dotted.
 *
 * Pipes live in the grid's **gutters** (`routeGutter`, `routeGutterMsg`): the
 * GAP_X between columns and the GAP_Y between rows. A pipe enters a tile only
 * through a port on its edge and never crosses one, and three lanes
 * (−0.075 · 0 · +0.075, clamped to fit a narrower gutter) let two families
 * share a gutter without lying on top of each other.
 *
 * Ports are the comp's NULL/ACTIVE boxes without the word: **filled** with ink
 * when the core reaches them, **hollow** when it has not — a second quad in the
 * body colour, at half the scale, painted over the port.
 *
 * Segments are instanced quads: two thousand pipes are one draw call, and the
 * width is clamped to a minimum of pixels so a pipe never vanishes when the
 * camera pulls back.
 *
 * Focus mode rides on the same buffer: every pipe carries whether it belongs
 * to the current selection, and `uFocus` fades the rest to 0.12 without a
 * second pass.
 *
 * Order: bus, core and ports draw at `renderOrder −1` and pulses at `+1`.
 * All of it is transparent with no depth write, so without an explicit order
 * three would sort by insertion and a pipe would paint over a tile's face.
 */

import * as THREE from 'three';
import { TILE_W, TILE_H } from './layout.ts';
import { dur, shaderMotion, T } from '../motion.ts';

export type PipeKind = 'lineage' | 'notice' | 'ask' | 'collision' | 'hot' | 'core';
const KIND_ID: Record<PipeKind, number> = { lineage: 0, notice: 1, ask: 2, collision: 3, hot: 4, core: 5 };

export interface Pt { x: number; y: number }

/** The body colour a hollow port is punched out with — `--body` in tokens.css. */
const C_BODY = new THREE.Color(0x1c1f29);

const VERT = /* glsl */ `
  attribute vec2 iA;
  attribute vec2 iB;
  attribute float iZ;
  attribute vec3 iColor;
  attribute vec4 iMeta; // kind, age (or filled length for a core), offset along path, thickness multiplier
  attribute float iSel;  // 1 when the pipe touches the selection
  uniform float uThick;
  uniform float uMinPx;
  uniform float uPxPerUnit;
  varying vec3 vColor;
  varying vec4 vMeta;
  varying float vAlong;
  varying float vSel;
  void main() {
    vec2 d = iB - iA;
    float len = length(d);
    vec2 dir = len > 0.0001 ? d / len : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float thick = max(uThick * iMeta.w, uMinPx / uPxPerUnit);
    // Extend each end by half the width so corners meet square.
    vec2 p = iA + dir * (uv.x * len + (uv.x - 0.5) * thick) + nrm * ((uv.y - 0.5) * thick);
    vColor = iColor;
    vMeta = iMeta;
    vSel = iSel;
    vAlong = iMeta.z + uv.x * len;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, iZ, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uReduce;
  uniform float uFar;   // 1 close, → 0.3 when the camera is far: quiet pipes recede
  uniform float uFocus;
  varying vec3 vColor;
  varying vec4 vMeta;
  varying float vAlong;
  varying float vSel;
  void main() {
    float kind = vMeta.x;
    float age = vMeta.y;
    float a = 1.0;
    if (kind < 0.5) {
      a = 0.9 * uFar;
    } else if (kind < 1.5) {
      a = max(0.12, 1.0 - age / 60.0) * uFar;
    } else if (kind < 2.5) {
      float ph = fract((vAlong - uTime * 1.6 * (1.0 - uReduce)) / 0.7);
      a = ph < 0.55 ? 1.0 : 0.22;
    } else if (kind < 3.5) {
      a = fract(vAlong / 0.26) < 0.5 ? 1.0 : 0.0;
    } else if (kind < 4.5) {
      a = 1.0;
    } else {
      // Core: iMeta.y is the filled length in world units, not an age. The
      // core exists only as far as it has grown out of the parent.
      a = vAlong < age ? 1.0 : 0.0;
    }
    // In focus, only what the selection is wired to keeps its weight.
    a *= mix(1.0, mix(0.12, 1.0, vSel), uFocus);
    gl_FragColor = vec4(vColor, a);
    #include <colorspace_fragment>
  }
`;

/* ── Pulses ───────────────────────────────────────────────────────── */

const PULSE_VERT = /* glsl */ `
  attribute vec2 iA;
  attribute vec2 iB;
  attribute float iZ;
  attribute vec3 iColor;
  attribute float iAlpha;
  uniform float uThick;
  uniform float uMinPx;
  uniform float uPxPerUnit;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 d = iB - iA;
    float len = length(d);
    vec2 dir = len > 0.0001 ? d / len : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float thick = max(uThick, uMinPx / uPxPerUnit);
    vec2 p = iA + dir * (uv.x * len) + nrm * ((uv.y - 0.5) * thick);
    vColor = iColor;
    vAlpha = iAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, iZ, 1.0);
  }
`;

const PULSE_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(vColor, vAlpha);
    #include <colorspace_fragment>
  }
`;

/** How long the segment is, in world units (§5.3). */
const PULSE_LEN = 0.35;
/** How long the trail behind it takes to go out, in seconds. */
const PULSE_TRAIL = 0.6;
/** World units per second the duration is derived from: `len / 9`, min `T.quick`. */
const PULSE_SPEED = 9;
/**
 * Quads the pulses may spend in one frame, all trails together. A trail is
 * about seventeen of them, so this is a hundred messages in flight at once —
 * far past what a person can read. The buffer is this size and never grows.
 */
const PULSE_CAP = 2048;

interface Trace { d: number; t: number }
interface Pulse {
  pts: Pt[];
  z: number;
  color: THREE.Color;
  /** Seconds since it left. */
  t: number;
  /** Seconds it takes to arrive. */
  d: number;
  len: number;
  /** Where the head has been, newest last, for the trail. */
  hist: Trace[];
}

/** power2.inOut, the same curve `EASE.inout` names for GSAP. */
function easeInOut(x: number): number {
  return x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2;
}

/* ── Geometry helpers ─────────────────────────────────────────────── */

/** Total length of an orthogonal path, in world units. What `add()` returns. */
export function pathLength(pts: Pt[]): number {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) len += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
  return len;
}

export interface PipesHandle {
  begin(): void;
  /**
   * Add one orthogonal path. Ports are drawn at both ends. `sel` marks the
   * pipe as part of the current selection, which is all focus mode needs.
   *
   * For `kind: 'core'`, `age` is the **filled length** in world units: the
   * core paints only up to it. Returns the total length of the path, so the
   * caller can pass `fill * len` next frame.
   */
  add(points: Pt[], z: number, color: THREE.Color, kind: PipeKind, age: number, thick?: number, sel?: number): number;
  /**
   * A lone square port — a terminal that is not an agent, such as YOU, or a
   * child's cell before it has a tile. `hollow` punches the body colour out of
   * the middle: the comp's NULL box, waiting for a core to arrive.
   */
  port(x: number, y: number, z: number, color: THREE.Color, scale?: number, sel?: number, hollow?: boolean): void;
  end(time: number, pxPerUnit: number): void;
  /** Send a pulse along a path: a 0.35-unit segment with a trail behind it. */
  pulse(points: Pt[], z: number, color: THREE.Color): void;
  step(dt: number): void;
  segments(): number;
  /** 0 → 1: how far into focus mode the field is. Eased by the caller. */
  setFocus(v: number): void;
  dispose(): void;
}

export function createPipes(scene: THREE.Scene): PipesHandle {
  let cap = 1024;
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uThick: { value: 0.055 },
      uMinPx: { value: 1.2 },
      uPxPerUnit: { value: 60 },
      uFar: { value: 1 },
      uFocus: { value: 0 },
      uReduce: { value: shaderMotion().reduce ? 1 : 0 },
    },
  });

  let mesh!: THREE.InstancedMesh;
  let aA!: THREE.InstancedBufferAttribute;
  let aB!: THREE.InstancedBufferAttribute;
  let aZ!: THREE.InstancedBufferAttribute;
  let aC!: THREE.InstancedBufferAttribute;
  let aM!: THREE.InstancedBufferAttribute;
  let aS!: THREE.InstancedBufferAttribute;
  build();

  function build() {
    if (mesh) { scene.remove(mesh); mesh.dispose(); }
    const g = new THREE.PlaneGeometry(1, 1);
    mesh = new THREE.InstancedMesh(g, mat, cap);
    aA = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    aB = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    aZ = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    aC = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    aM = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    aS = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    for (const a of [aA, aB, aZ, aC, aM, aS]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', aA);
    g.setAttribute('iB', aB);
    g.setAttribute('iZ', aZ);
    g.setAttribute('iColor', aC);
    g.setAttribute('iMeta', aM);
    g.setAttribute('iSel', aS);
    mesh.frustumCulled = false;
    // Bus, core and ports go under the tiles: they are all transparent with no
    // depth write, and insertion order alone would let a pipe cover a tile.
    mesh.renderOrder = -1;
    // Instance matrices are identity: the vertex shader places everything.
    const id = new THREE.Matrix4();
    for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, id);
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
  }

  /* ── Ports: a square at each path end, hollow until the core lands ── */
  const PORT = 0.12;
  let portCap = 512;
  const portMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  let ports = newPortMesh(portCap);
  let holes = newPortMesh(portCap);
  scene.add(ports, holes);
  let portN = 0;
  let holeN = 0;

  function newPortMesh(n: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(PORT, PORT), portMat, n);
    m.frustumCulled = false;
    m.renderOrder = -1;
    return m;
  }

  /* ── Pulses ─────────────────────────────────────────────────────── */
  const pulseMat = new THREE.ShaderMaterial({
    vertexShader: PULSE_VERT,
    fragmentShader: PULSE_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uThick: { value: 0.11 },
      uMinPx: { value: 2 },
      uPxPerUnit: { value: 60 },
    },
  });
  let pulseMesh!: THREE.InstancedMesh;
  let pA!: THREE.InstancedBufferAttribute;
  let pB!: THREE.InstancedBufferAttribute;
  let pZ!: THREE.InstancedBufferAttribute;
  let pC!: THREE.InstancedBufferAttribute;
  let pAl!: THREE.InstancedBufferAttribute;
  buildPulses();

  function buildPulses() {
    const g = new THREE.PlaneGeometry(1, 1);
    pulseMesh = new THREE.InstancedMesh(g, pulseMat, PULSE_CAP);
    pA = new THREE.InstancedBufferAttribute(new Float32Array(PULSE_CAP * 2), 2);
    pB = new THREE.InstancedBufferAttribute(new Float32Array(PULSE_CAP * 2), 2);
    pZ = new THREE.InstancedBufferAttribute(new Float32Array(PULSE_CAP), 1);
    pC = new THREE.InstancedBufferAttribute(new Float32Array(PULSE_CAP * 3), 3);
    pAl = new THREE.InstancedBufferAttribute(new Float32Array(PULSE_CAP), 1);
    for (const a of [pA, pB, pZ, pC, pAl]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', pA);
    g.setAttribute('iB', pB);
    g.setAttribute('iZ', pZ);
    g.setAttribute('iColor', pC);
    g.setAttribute('iAlpha', pAl);
    pulseMesh.frustumCulled = false;
    // Over everything: a message in flight is the one thing that must be seen.
    pulseMesh.renderOrder = 1;
    pulseMesh.count = 0;
    const id = new THREE.Matrix4();
    for (let i = 0; i < PULSE_CAP; i++) pulseMesh.setMatrixAt(i, id);
    pulseMesh.instanceMatrix.needsUpdate = true;
    scene.add(pulseMesh);
  }

  const pulses: Pulse[] = [];
  let clock = 0;

  let n = 0;
  const m4 = new THREE.Matrix4();
  /*
   * Ports are opaque quads with no per-instance alpha, so focus dims them by
   * walking their colour toward the ground instead. Left bright, they would
   * float as squares over pipes that are no longer there.
   */
  let focus = 0;
  const cPort = new THREE.Color();
  const dimPort = (c: THREE.Color, sel: number): THREE.Color =>
    (sel > 0.5 || focus <= 0) ? c : cPort.copy(c).multiplyScalar(1 - focus * 0.88);
  const vPort = new THREE.Vector3();
  const qPort = new THREE.Quaternion();
  const sPort = new THREE.Vector3(1, 1, 1);

  function ensure(need: number) {
    if (need <= cap) return;
    while (cap < need) cap *= 2;
    build();
  }
  function ensurePorts(need: number) {
    if (need <= portCap) return;
    while (portCap < need) portCap *= 2;
    scene.remove(ports, holes);
    ports.dispose(); holes.dispose();
    ports = newPortMesh(portCap);
    holes = newPortMesh(portCap);
    scene.add(ports, holes);
  }

  function drawPort(x: number, y: number, z: number, color: THREE.Color, scale: number, sel: number, hollow: boolean) {
    ensurePorts(Math.max(portN, holeN) + 1);
    m4.compose(vPort.set(x, y, z + 0.001), qPort, sPort.set(scale, scale, 1));
    ports.setMatrixAt(portN, m4);
    ports.setColorAt(portN, dimPort(color, sel));
    portN++;
    if (!hollow) return;
    // The NULL box: the body colour punched out of the middle, so the port
    // reads as a ring the core has not reached yet.
    m4.compose(vPort.set(x, y, z + 0.002), qPort, sPort.set(scale * 0.5, scale * 0.5, 1));
    holes.setMatrixAt(holeN, m4);
    holes.setColorAt(holeN, dimPort(C_BODY, sel));
    holeN++;
  }

  /** Emit the piece of `p`'s path between two distances, at one alpha. */
  function emitRange(p: Pulse, d0: number, d1: number, alpha: number, k: number): number {
    if (d1 - d0 < 1e-5 || alpha <= 0.002) return k;
    let walked = 0;
    for (let s = 0; s < p.pts.length - 1 && k < PULSE_CAP; s++) {
      const a = p.pts[s]!, b = p.pts[s + 1]!;
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const lo = Math.max(d0, walked), hi = Math.min(d1, walked + L);
      walked += L;
      if (hi - lo < 1e-5 || L <= 0) continue;
      const f0 = (lo - (walked - L)) / L, f1 = (hi - (walked - L)) / L;
      pA.setXY(k, a.x + (b.x - a.x) * f0, a.y + (b.y - a.y) * f0);
      pB.setXY(k, a.x + (b.x - a.x) * f1, a.y + (b.y - a.y) * f1);
      pZ.setX(k, p.z + 0.002);
      pC.setXYZ(k, p.color.r, p.color.g, p.color.b);
      pAl.setX(k, alpha);
      k++;
    }
    return k;
  }

  return {
    begin() { n = 0; portN = 0; holeN = 0; },

    add(pts, z, color, kind, age, thick = 1, sel = 0) {
      if (pts.length < 2) return 0;
      ensure(n + pts.length - 1);
      let off = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!, b = pts[i + 1]!;
        aA.setXY(n, a.x, a.y);
        aB.setXY(n, b.x, b.y);
        aZ.setX(n, z);
        aC.setXYZ(n, color.r, color.g, color.b);
        aM.setXYZW(n, KIND_ID[kind], age, off, thick);
        aS.setX(n, sel);
        off += Math.hypot(b.x - a.x, b.y - a.y);
        n++;
      }
      for (const p of [pts[0]!, pts[pts.length - 1]!]) drawPort(p.x, p.y, z, color, 1, sel, false);
      return off;
    },

    port(x, y, z, color, scale = 1, sel = 0, hollow = false) {
      drawPort(x, y, z, color, scale, sel, hollow);
    },

    end(time, pxPerUnit) {
      mesh.count = n;
      for (const a of [aA, aB, aZ, aC, aM, aS]) a.needsUpdate = true;
      mat.uniforms.uTime!.value = time;
      mat.uniforms.uPxPerUnit!.value = pxPerUnit;
      mat.uniforms.uFar!.value = Math.max(0.3, Math.min(1, pxPerUnit / 40));
      pulseMat.uniforms.uPxPerUnit!.value = pxPerUnit;
      ports.count = portN;
      ports.instanceMatrix.needsUpdate = true;
      if (ports.instanceColor) ports.instanceColor.needsUpdate = true;
      holes.count = holeN;
      holes.instanceMatrix.needsUpdate = true;
      if (holes.instanceColor) holes.instanceColor.needsUpdate = true;
    },

    pulse(pts, z, color) {
      if (pts.length < 2) return;
      const len = Math.max(0.01, pathLength(pts));
      // §5.3: the run takes `len / 9`, never less than a window's arrival.
      const d = dur(Math.max(T.quick, len / PULSE_SPEED));
      // Reduced motion has no travel to watch: it lands, which is nothing.
      if (d <= 0) return;
      pulses.push({ pts, z, color, t: 0, d, len, hist: [{ d: 0, t: clock }] });
      if (pulses.length > 128) pulses.shift();
    },

    step(dt) {
      clock += dt;
      let k = 0;
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i]!;
        p.t += dt;
        // Cut at arrival: the trail goes with it, it does not linger.
        if (p.t >= p.d) { pulses.splice(i, 1); continue; }
        const head = easeInOut(p.t / p.d) * p.len;
        const last = p.hist[p.hist.length - 1]!;
        if (head - last.d >= 0.06 || clock - last.t >= 1 / 20) p.hist.push({ d: head, t: clock });
        while (p.hist.length > 1 && clock - p.hist[0]!.t > PULSE_TRAIL && head - p.hist[0]!.d > PULSE_LEN) p.hist.shift();
        while (p.hist.length > 16) p.hist.shift();

        // Oldest to newest, then the live head: the segment is opaque, what it
        // has already left behind goes out over PULSE_TRAIL seconds.
        for (let h = 0; h < p.hist.length && k < PULSE_CAP; h++) {
          const a = p.hist[h]!;
          const b = h + 1 < p.hist.length ? p.hist[h + 1]!.d : head;
          const alpha = head - a.d <= PULSE_LEN ? 1 : Math.max(0, 1 - (clock - a.t) / PULSE_TRAIL);
          k = emitRange(p, a.d, b, alpha, k);
        }
      }
      pulseMesh.count = k;
      for (const a of [pA, pB, pZ, pC, pAl]) a.needsUpdate = true;
    },

    segments: () => n,

    setFocus(v) { focus = v; mat.uniforms.uFocus!.value = v; },

    dispose() {
      scene.remove(mesh, ports, holes, pulseMesh);
      mesh.dispose(); ports.dispose(); holes.dispose(); pulseMesh.dispose();
      mat.dispose(); pulseMat.dispose(); portMat.dispose();
    },
  };
}

/* ── Routing ──────────────────────────────────────────────────────── */

/** Parent → child: down out of the parent, across, down into the child. */
export function routeLineage(a: Pt, b: Pt): Pt[] {
  const below = b.y <= a.y;
  const ay = below ? a.y - TILE_H / 2 : a.y + TILE_H / 2;
  const by = below ? b.y + TILE_H / 2 : b.y - TILE_H / 2;
  const ax = a.x - TILE_W * 0.32;
  const bx = b.x - TILE_W * 0.32;
  if (Math.abs(ax - bx) < 0.02) return [{ x: ax, y: ay }, { x: bx, y: by }];
  const my = (ay + by) / 2;
  return [{ x: ax, y: ay }, { x: ax, y: my }, { x: bx, y: my }, { x: bx, y: by }];
}

/** Peer → peer: out of a side, across, into a side. */
export function routeMessage(a: Pt, b: Pt): Pt[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) > Math.abs(dy) * 1.1) {
    const sx = dx > 0 ? 1 : -1;
    const ax = a.x + sx * TILE_W / 2, bx = b.x - sx * TILE_W / 2;
    const mx = (ax + bx) / 2;
    const ay = a.y + TILE_H * 0.12, by = b.y + TILE_H * 0.12;
    if (Math.abs(ay - by) < 0.02) return [{ x: ax, y: ay }, { x: bx, y: by }];
    return [{ x: ax, y: ay }, { x: mx, y: ay }, { x: mx, y: by }, { x: bx, y: by }];
  }
  const sy = dy > 0 ? 1 : -1;
  const ay = a.y + sy * TILE_H / 2, by = b.y - sy * TILE_H / 2;
  const my = (ay + by) / 2;
  const ax = a.x + TILE_W * 0.22, bx = b.x + TILE_W * 0.22;
  if (Math.abs(ax - bx) < 0.02) return [{ x: ax, y: ay }, { x: bx, y: by }];
  return [{ x: ax, y: ay }, { x: ax, y: my }, { x: bx, y: my }, { x: bx, y: by }];
}

/* ── Gutters ──────────────────────────────────────────────────────── */

/**
 * Lanes. A gutter of 0.24 takes three pipes of 0.055 at −0.075 · 0 · +0.075;
 * `LANE_CLEAR` is what a lane leaves between its centre and the tile edge, so
 * a narrower gutter (or a wider pipe) squeezes the lanes together instead of
 * pushing one onto a tile.
 */
const LANE = 0.075;
const LANE_CLEAR = 0.045;

/** How far off a gutter's centre line lane ±1 may sit, for a gutter of `gap`. */
export function laneShift(gap: number): number {
  return Math.min(LANE, Math.max(0, gap / 2 - LANE_CLEAR));
}

/** Where two points differ enough to be a leg rather than a rounding error. */
const EPS = 1e-4;

/**
 * Drop the legs that go nowhere and fuse the ones that keep going the same
 * way. Every route below is written as its full six-point form and simplified
 * here, so "the child is right below" is one rule instead of six branches.
 */
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < EPS && Math.abs(last.y - p.y) < EPS) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1]!, b = out[i]!, c = out[i + 1]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
    if (Math.abs(cross) < EPS && dot > 0) out.splice(i, 1);
  }
  return out;
}

/**
 * Parent → child through the gutters (§4.1).
 *
 * Out of the parent's bottom port, down into the horizontal gutter under it,
 * along to the vertical gutter left of the child's column, down that to the
 * gutter over the child, and into its top port. A child directly below in the
 * same column is a straight drop; a child *above* mirrors the whole thing; a
 * child in the same row goes down, along the gutter under the row, and up into
 * the bottom port. No leg ever crosses a tile.
 */
export function routeGutter(P: Pt, C: Pt, gaps: { x: number; y: number }, lane: -1 | 0 | 1): Pt[] {
  const lx = lane * laneShift(gaps.x);
  const ly = lane * laneShift(gaps.y);
  const px = P.x - TILE_W * 0.32;
  const cx = C.x - TILE_W * 0.32;
  // The vertical gutter left of the child's column: no tile stands in it at
  // any row, which is what makes the long descent safe.
  const vx = C.x - TILE_W / 2 - gaps.x / 2 + lx;
  const dy = C.y - P.y;

  // Same row (tiles that overlap vertically): both drop into the gutter below.
  if (Math.abs(dy) < TILE_H) {
    const gy = Math.min(P.y, C.y) - TILE_H / 2 - gaps.y / 2 + ly;
    return simplify([
      { x: px, y: P.y - TILE_H / 2 },
      { x: px, y: gy },
      { x: cx, y: gy },
      { x: cx, y: C.y - TILE_H / 2 },
    ]);
  }

  const down = dy < 0;
  const sy = down ? -1 : 1;                       // out of the parent this way
  const pEdge = P.y + sy * TILE_H / 2;            // the port the pipe leaves by
  const cEdge = C.y - sy * TILE_H / 2;            // the port it arrives at
  const gy1 = pEdge + sy * gaps.y / 2 + ly;       // gutter beside the parent
  const gy2 = cEdge - sy * gaps.y / 2 + ly;       // gutter beside the child

  // Directly below (or above) in the same column, one gutter apart: a drop.
  if (Math.abs(C.x - P.x) < EPS && Math.abs(cEdge - pEdge) <= gaps.y + EPS) {
    return [{ x: px, y: pEdge }, { x: cx, y: cEdge }];
  }

  return simplify([
    { x: px, y: pEdge },
    { x: px, y: gy1 },
    { x: vx, y: gy1 },
    { x: vx, y: gy2 },
    { x: cx, y: gy2 },
    { x: cx, y: cEdge },
  ]);
}

/**
 * Peer → peer through the gutters (§4.1).
 *
 * Out of the side port facing the other tile, into the vertical gutter beside
 * it, along that gutter to a horizontal one, across, and back up the vertical
 * gutter beside the target into its side port. Two tiles side by side in one
 * row are a straight run through the gutter between them.
 */
export function routeGutterMsg(A: Pt, B: Pt, gaps: { x: number; y: number }, lane: -1 | 0 | 1): Pt[] {
  const lx = lane * laneShift(gaps.x);
  const ly = lane * laneShift(gaps.y);
  const ay = A.y + TILE_H * 0.12;
  const by = B.y + TILE_H * 0.12;
  const dx = B.x - A.x, dy = B.y - A.y;
  const dir = dx > EPS ? 1 : dx < -EPS ? -1 : 0;
  // Same column: both ports on the same side, so the run is one gutter.
  const sa = dir === 0 ? 1 : dir;
  const sb = dir === 0 ? 1 : -dir;
  const ax = A.x + sa * TILE_W / 2;
  const bx = B.x + sb * TILE_W / 2;
  const vxa = A.x + sa * (TILE_W / 2 + gaps.x / 2) + lx;
  const vxb = B.x + sb * (TILE_W / 2 + gaps.x / 2) + lx;

  const sameRow = Math.abs(dy) < TILE_H;
  // Side by side in one row: straight through the gutter between them.
  if (sameRow && Math.abs(dy) < EPS && Math.abs(dx) <= TILE_W + gaps.x + EPS && dir !== 0) {
    return [{ x: ax, y: ay }, { x: bx, y: by }];
  }
  // The horizontal gutter to cross by: beside the target's row, or under both
  // when they share one — a run along a row would cross every tile in it.
  const hy = sameRow
    ? Math.min(A.y, B.y) - TILE_H / 2 - gaps.y / 2 + ly
    : B.y + (dy < 0 ? 1 : -1) * (TILE_H / 2 + gaps.y / 2) + ly;

  return simplify([
    { x: ax, y: ay },
    { x: vxa, y: ay },
    { x: vxa, y: hy },
    { x: vxb, y: hy },
    { x: vxb, y: by },
    { x: bx, y: by },
  ]);
}
