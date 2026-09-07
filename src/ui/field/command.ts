/**
 * The command post's halo — what CAPCOM has around it.
 *
 * CAPCOM is one body (§1.3: a tile, cyan, at `CAPCOM_SCALE`). Several bodies
 * would read as a squad, so what makes it the command post is not its shape
 * but what it *carries*: a ring around the core that says how much the post
 * is holding, and the way the core itself beats.
 *
 * - **The ring** is a rounded outline a gutter out from the tile, drawn in
 *   segments: one arc per task the hub keeps open (`WorldState.tasks`, status
 *   `active`). An arc is lit while the task moves — its conversation grew in
 *   the last `TASK_HOT_MS`, or one of its agents is thinking or working — and
 *   dim while it waits. A completed task is gone from the ring. The arc of the
 *   task the operator has open (`store.activeTaskId`) is drawn heavier. With
 *   no task at all the ring is one faint continuous line: the post is there,
 *   and it holds nothing.
 * - **The notches** are amber ticks on the bottom of the ring, one per
 *   escalation nobody has answered yet (`pending` or `with_ceo`, the same rule
 *   `pendingAgents` uses): the load the operator will have to take.
 * - **The turn** lives on the core, in swarm.ts, from the same state: at rest
 *   the tile breathes as slowly as it always did; in a turn (thinking,
 *   working) it beats faster and its outline goes solid; waiting on the
 *   operator, the halo and the glow tint amber. The ring only shimmers.
 * - **The links** are pipes, in field.ts (`PipeKind` 'command'): faint cyan
 *   ties from CAPCOM to every agent it launched — `commandLinked` — that go
 *   dimmer when the agent is done. Fifty of them are noise, so they are a
 *   preference and off by default.
 *
 * Every piece is a `Prefs` flag (`capcomTasks`, `capcomNotches`,
 * `capcomPulse`, `capcomLinks`), and each falls back to what the field drew
 * before it existed. The state is computed once per feed and once a second
 * (`commandState` is pure, and tested), and the halo is one quad with one
 * fragment shader: whatever the fleet's size, this costs one draw call.
 *
 * Cyan stays CAPCOM's alone: the ring is cyan, the notches are amber, and no
 * other tile is handed either.
 */

import * as THREE from 'three';
import type { Agent, WorldState } from '../../shared/types.ts';
import type { CapcomTask } from '../../shared/tasks.ts';
import { TILE_W, TILE_H } from './layout.ts';
import { shaderMotion } from '../motion.ts';

/* ── Geometry, in world units ─────────────────────────────────────── */

/** From the tile's edge to the ring's centre line. */
export const RING_OFF = 0.16;
/** The ring's thickness; clamped to two screen pixels from afar. */
export const RING_W = 0.06;
/** How far a notch reaches out past the ring. */
export const NOTCH_LEN = 0.10;
/** Corner radius of the ring: rounder than the tile, so it reads as a dial and not a second frame. */
export const RING_R = 0.24;
/**
 * How far the halo reaches past the tile's edge. `layout.ts` keeps
 * `CAPCOM_CLEAR` (0.4) of air around CAPCOM; the halo must fit inside it.
 */
export const HALO_REACH = RING_OFF + RING_W / 2 + NOTCH_LEN + 0.04;

/** A task whose conversation moved this recently is lit. */
export const TASK_HOT_MS = 2 * 60_000;
/** Bits in a float mantissa the shader can trust. */
export const MAX_SEGMENTS = 24;
/** Past this the ticks stop being marks and become a bar. */
export const MAX_NOTCHES = 12;

/* ── State ────────────────────────────────────────────────────────── */

export interface CommandFlags {
  tasks: boolean;
  notches: boolean;
  pulse: boolean;
  links: boolean;
}

export interface CommandState {
  /** Arcs on the ring. 0 draws the faint continuous line. */
  segments: number;
  /** Bit i set: segment i is lit (its task moved recently). */
  lit: number;
  /** Segment of the task the operator has open, or -1. */
  active: number;
  /** Amber ticks: questions nobody has answered. */
  notches: number;
  /** CAPCOM is in a turn: thinking or working. */
  turn: 0 | 1;
  /** CAPCOM is waiting on the operator. */
  waiting: 0 | 1;
}

export const REST: CommandState = { segments: 0, lit: 0, active: -1, notches: 0, turn: 0, waiting: 0 };

/** The hub's open tasks, oldest first — the order the ring is read in, clockwise from the top. */
export function openTasks(tasks: WorldState['tasks']): CapcomTask[] {
  return Object.values(tasks ?? {})
    .filter((t) => t.status === 'active')
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** A task is lit while it moves: a fresh message, or an agent of its own at work. */
export function taskHot(t: CapcomTask, agent: (id: string) => Agent | undefined, now: number): boolean {
  if (now - t.updatedAt < TASK_HOT_MS) return true;
  for (const id of t.agentIds) {
    const a = agent(id);
    if (a && (a.state === 'working' || a.state === 'thinking' || a.state === 'booting')) return true;
  }
  return false;
}

/**
 * The ring, the notches and the turn, from the world. Pure: the field calls
 * it once per feed and once a second (a task cools by the clock alone), and
 * a test calls it with a world it made up.
 *
 * `pending` is the set of agents with an escalation a person can still
 * answer, which the field already resolves per feed; the notches count the
 * escalations themselves, so one agent asking twice is two ticks.
 */
export function commandState(
  w: Pick<WorldState, 'tasks' | 'escalations'>,
  capcom: Agent | null,
  agent: (id: string) => Agent | undefined,
  now: number,
  activeTaskId: string | null,
  flags: Pick<CommandFlags, 'tasks' | 'notches' | 'pulse'>,
): CommandState {
  if (!capcom) return REST;
  let segments = 0, lit = 0, active = -1;
  if (flags.tasks) {
    const open = openTasks(w.tasks);
    segments = Math.min(open.length, MAX_SEGMENTS);
    for (let i = 0; i < segments; i++) {
      const t = open[i]!;
      if (taskHot(t, agent, now)) lit += 2 ** i;
      if (t.id === activeTaskId) active = i;
    }
  }
  let notches = 0;
  if (flags.notches) {
    for (const e of Object.values(w.escalations ?? {})) {
      if (e.status === 'pending' || e.status === 'with_ceo') notches++;
    }
    notches = Math.min(notches, MAX_NOTCHES);
  }
  let turn: 0 | 1 = 0, waiting: 0 | 1 = 0;
  if (flags.pulse) {
    const s = capcom.state;
    if (s === 'thinking' || s === 'working' || s === 'booting') turn = 1;
    // A block on a peer is CAPCOM waiting on an agent, not on a person.
    if (s === 'blocked' && capcom.block?.kind !== 'peer') waiting = 1;
  }
  return { segments, lit, active, notches, turn, waiting };
}

/**
 * Whom a command link reaches: what CAPCOM launched. A spawn CAPCOM asked
 * for arrives as a root with `origin: 'orca'` and no parent (the hub only
 * records a parent when CAPCOM names one), so the rule is the ORCA-launched
 * roots plus anything that carries CAPCOM as its parent outright. A `Task`
 * subagent is folded into its parent and never had a tile to tie to.
 */
export function commandLinked(a: Agent, capcomId: string): boolean {
  if (a.id === capcomId || a.role === 'capcom' || a.subagent) return false;
  if (a.parentId === capcomId) return true;
  return a.origin === 'orca' && !a.parentId;
}

/** Two states are the same picture; the halo only rewrites its uniforms when they differ. */
export function sameState(a: CommandState, b: CommandState): boolean {
  return a.segments === b.segments && a.lit === b.lit && a.active === b.active
    && a.notches === b.notches && a.turn === b.turn && a.waiting === b.waiting;
}

/* ── The halo ─────────────────────────────────────────────────────── */

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  #define TAU 6.28318530718
  uniform float uTime;
  uniform float uPxPerUnit;
  uniform float uReduce;
  uniform float uFocus;
  uniform float uBreathe;
  uniform vec2 uQuad;     // the quad, in world units
  uniform vec2 uBox;      // half extents of the ring's centre line
  uniform float uRadius;  // its corner radius
  uniform float uRingW;   // ring thickness, world units
  uniform float uNotchLen;
  uniform float uSeg;     // segments; 0 is the faint line
  uniform float uLit;     // bitmask of lit segments
  uniform float uActive;  // the operator's open task, or -1
  uniform float uNotch;   // amber ticks
  uniform vec3 uMode;     // turn, waiting, selected
  uniform vec2 uAlpha;    // alpha, alpha under focus
  uniform vec3 uCyan;
  uniform vec3 uAmber;
  varying vec2 vUv;

  float sdBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }

  void main() {
    vec2 p = (vUv - 0.5) * uQuad;
    float px = 1.0 / uPxPerUnit;
    // 0 on the ring's centre line, negative toward the tile.
    float d = sdBox(p, uBox, uRadius);
    // Clockwise from the top, 0 → 1. The way a dial is read.
    float u = fract(atan(p.x, p.y) / TAU);
    float perim = 4.0 * (uBox.x + uBox.y) - (8.0 - TAU) * uRadius;

    float breathe = 0.5 + 0.5 * sin(uTime * uBreathe * 0.5);
    breathe = mix(breathe, 1.0, uReduce);

    /* The ring: continuous and faint with nothing to hold, else arcs. */
    float w = max(uRingW, 2.0 * px);
    float ringA;
    float heavy = 0.0;
    if (uSeg < 0.5) {
      ringA = 0.22;
    } else {
      float seg = floor(u * uSeg);
      float t = fract(u * uSeg);
      // A gap of four pixels between arcs, as a fraction of one arc.
      float gap = clamp((4.0 * px) / (perim / uSeg), 0.0, 0.4);
      float inSeg = step(gap * 0.5, t) * step(t, 1.0 - gap * 0.5);
      float bit = mod(floor(uLit / exp2(min(seg, 23.0))), 2.0);
      heavy = step(abs(seg - uActive), 0.5);
      // In a turn the lit arcs shimmer: a slow band running round the dial.
      float shimmer = 1.0 - 0.22 * uMode.x * (1.0 - uReduce) * (0.5 + 0.5 * sin(TAU * (u * 2.0 - uTime * 0.3)));
      ringA = inSeg * mix(0.30, 0.92 * shimmer, bit);
    }
    w *= mix(1.0, 1.8, heavy);
    float ring = 1.0 - smoothstep(w * 0.5 - px, w * 0.5 + px, abs(d));
    // Selected: the ring comes up the way a selected tile's line does.
    ringA = ringA * ring * mix(1.0, 1.35, uMode.z);

    /* The notches: amber ticks across the bottom, one per open question. */
    float notch = 0.0;
    float halfW = (1.5 * px) / perim;
    for (int j = 0; j < 12; j++) {
      if (float(j) >= uNotch) break;
      float uj = 0.5 + (float(j) - (uNotch - 1.0) * 0.5) * 0.055;
      float du = abs(fract(u - uj + 0.5) - 0.5);
      float ang = 1.0 - smoothstep(halfW, halfW + px / perim, du);
      float rad = step(-w * 0.5, d) * (1.0 - smoothstep(w * 0.5 + uNotchLen, w * 0.5 + uNotchLen + px, d));
      notch = max(notch, ang * rad);
    }

    /* Waiting on the operator: the whole halo tints amber and breathes. */
    vec3 col = mix(uCyan, uAmber, 0.8 * uMode.y);
    ringA *= mix(1.0, 0.7 + 0.3 * breathe, uMode.y);
    col = mix(col, uAmber, notch);
    float a = max(ringA, notch * 0.95);
    a *= mix(uAlpha.x, uAlpha.y, uFocus);
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }
`;

export interface CommandHaloHandle {
  /** Place the halo around CAPCOM's tile for this frame. `sel` is 1 when CAPCOM is selected. */
  write(x: number, y: number, z: number, scale: number, state: CommandState, alpha: number, focusAlpha: number, sel: number): void;
  /** No CAPCOM on the field, or the deck: nothing to draw. */
  hide(): void;
  commit(time: number, pxPerUnit: number): void;
  /** 0 → 1: how far into focus mode the field is. Eased by the caller. */
  setFocus(v: number): void;
  dispose(): void;
}

export function createCommandHalo(scene: THREE.Scene): CommandHaloHandle {
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uPxPerUnit: { value: 60 },
      uReduce: { value: shaderMotion().reduce },
      uFocus: { value: 0 },
      uBreathe: { value: shaderMotion().breathe },
      uQuad: { value: new THREE.Vector2(1, 1) },
      uBox: { value: new THREE.Vector2(0.5, 0.5) },
      uRadius: { value: RING_R },
      uRingW: { value: RING_W },
      uNotchLen: { value: NOTCH_LEN },
      uSeg: { value: 0 },
      uLit: { value: 0 },
      uActive: { value: -1 },
      uNotch: { value: 0 },
      uMode: { value: new THREE.Vector3(0, 0, 0) },
      uAlpha: { value: new THREE.Vector2(1, 1) },
      uCyan: { value: new THREE.Color(0x4fe3ff) },
      uAmber: { value: new THREE.Color(0xf5a524) },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  // Under the pipes (−1) and the tiles: the ring is ground the post stands on.
  mesh.renderOrder = -2;
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);

  let last: CommandState = { ...REST };
  const u = mat.uniforms;

  return {
    write(x, y, z, scale, state, alpha, focusAlpha, sel) {
      const bx = TILE_W / 2 * scale + RING_OFF, by = TILE_H / 2 * scale + RING_OFF;
      const reach = RING_W / 2 + NOTCH_LEN + 0.04;
      const qw = (bx + reach) * 2, qh = (by + reach) * 2;
      mesh.position.set(x, y, z - 0.01);
      mesh.scale.set(qw, qh, 1);
      (u.uQuad!.value as THREE.Vector2).set(qw, qh);
      (u.uBox!.value as THREE.Vector2).set(bx, by);
      (u.uMode!.value as THREE.Vector3).set(state.turn, state.waiting, sel);
      (u.uAlpha!.value as THREE.Vector2).set(alpha, focusAlpha);
      if (!sameState(last, state)) {
        u.uSeg!.value = state.segments;
        u.uLit!.value = state.lit;
        u.uActive!.value = state.active;
        u.uNotch!.value = state.notches;
        last = { ...state };
      }
      mesh.visible = true;
    },
    hide() { mesh.visible = false; },
    commit(time, pxPerUnit) {
      u.uTime!.value = time;
      u.uPxPerUnit!.value = pxPerUnit;
    },
    setFocus(v) { u.uFocus!.value = v; },
    dispose() {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
}
