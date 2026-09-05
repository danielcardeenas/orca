/**
 * The field — the only stage.
 *
 * Owns the renderer, the camera, the layout and every layer drawn over the
 * canvas, and turns pointer gestures into the handful of things an operator
 * does here: look around, pick an agent, move one, lasso a few, open one.
 * Everything that needs a window goes out through `FieldEvents`; the field
 * never builds UI of its own.
 *
 * Four things reach in from outside and are documented on `FieldHandle`
 * above their signatures: `setFocus` (the Space key), `setLayoutMode` (the
 * align deck), `setReplay` (history) and `dropArtifactAt` (a drag out of the
 * gallery).
 *
 * **Three roles, three weights** (docs/IDENTITY.md §4). Structure is grey and
 * still: a region outline, a squad outline, the *bus* of a lineage pipe. Life
 * is lime and lives *inside* the structure: the `core` that runs down the
 * middle of a bus, full when the child is working, at 55 % when it is only
 * thinking, absent when it is done. Attention is amber and reserved for what
 * only a person can clear. The lime stopped meaning "there is a pipe here" and
 * went back to meaning "there is work here", which is what it means on a tile.
 *
 * **Nothing crosses a tile.** Every pipe is routed through the gutters of the
 * grid — `routeGutter` for lineage, `routeGutterMsg` for traffic — and enters a
 * tile only through a port on its edge. A tile the operator pinned has broken
 * the grid on purpose, so its pipes fall back to the old direct routes.
 *
 * **A squad is a tile made of tiles** (§3): the same notched outline, a port on
 * its top edge where a `toSquad` message lands and the fan-out leaves from, and
 * a rótulo sitting on that edge like a fieldset legend, carrying a roster that
 * reads the squadron's pulse at a zoom where the tiles are motes.
 *
 * **Discrete motion is GSAP, continuous motion is the shader** (§5). Births,
 * deaths, answers and traces are scalars in `anim.ts`; breathing, travelling
 * bands and dashes stay in the shaders, because they have no end.
 */

import * as THREE from 'three';
import gsap from 'gsap';
import type { Agent, AgentMessage, AgentState, Artifact, Placement, Project, WorldState } from '../../shared/types.ts';
import { squadsOf, type Squad } from '../../shared/squads.ts';
import { store } from '../store.ts';
import { esc, STATE_HEX, STATE_VAR } from '../util.ts';
import { CAPCOM_BITS, sigilBits, sigilHTML } from '../gfx/sigil.ts';
import { FieldCamera } from './camera.ts';
import { createGround, GROUND_Z } from './ground.ts';
import { createLabels, rememberMachine, rememberProjectCode, rememberProjectName, type LabelItem } from './labels.ts';
import { createMedia } from './media.ts';
import { createPipes, laneShift, pathLength, routeGutter, routeGutterMsg, routeLineage, routeMessage, type Pt } from './pipes.ts';
import { createSwarm } from './swarm.ts';
import { beats, dur, EASE, REDUCE, T } from '../motion.ts';
import * as anim from './anim.ts';
import { getSound } from '../hud/sound.ts';
import { emptyLayout, isLead, layoutFleet, squadKey, squadOf, TILE_H, TILE_W, type Layout, type LayoutMode, type Region, type RegionPlacement, type SquadBlock, type SquadPlacement, type Spot } from './layout.ts';

/**
 * What the pointer is over when the operator asks for a menu. The field
 * only names the thing; the console decides what can be done to it.
 */
export type FieldTarget =
  | { kind: 'agent'; id: string; selection: string[] }
  | { kind: 'squad'; name: string; projectId: string; moved: boolean }
  | { kind: 'project'; id: string; moved: boolean }
  | { kind: 'artifact'; id: string }
  | { kind: 'field' };

export interface FieldEvents {
  onSelect(ids: string[], at: { sx: number; sy: number } | null): void;
  onOpen(agentId: string, sx: number, sy: number): void;
  onOpenProject(projectId: string, sx: number, sy: number): void;
  onOpenSquad(name: string, projectId: string, sx: number, sy: number): void;
  onOpenArtifact(artifactId: string, sx: number, sy: number): void;
  /** Right click: the field names what is under the pointer and where. */
  onContext(target: FieldTarget, sx: number, sy: number): void;
  onPlace(agentId: string, x: number, y: number, z: number): void;
  onPlaceArtifact(artifactId: string, x: number, y: number, z: number): void;
  onUnplaceArtifact(artifactId: string): void;
  onHover(id: string | null): void;
}

export interface ScreenRect { x: number; y: number; w: number; h: number; visible: boolean }

export interface FieldHandle {
  setActive(on: boolean): void;
  /** Pull the world from the store and re-lay it out. Coalesced per frame. */
  feed(): void;
  flyTo(agentId: string, distance?: number): void;
  flyToPoint(x: number, y: number, distance?: number): void;
  frameAll(): void;
  frameProject(projectId: string): void;
  setTilt(on: boolean): void;
  tilted(): boolean;
  /** Brightness of the subpixel panel under the fleet, 0 (off) … 1. */
  setGroundLevel(v: number): void;
  /** Colour stripes on the panel, or grey. */
  setGroundColor(on: boolean): void;
  /**
   * Order the same tiles into the comp's align deck, or let them fall back to
   * the project spiral. Nothing else changes: same field, same fleet, same
   * pipes — only where each tile stands and, in deck, what decides that.
   *
   * Entering the deck locks the tilt flat (a strict grid read at an angle is
   * a strict grid nobody can read), drops the region labels with the regions
   * and frames the grid. `{ kind: 'deck', sort }` called again with a
   * different `sort` re-orders in place. Leaving restores the spiral, the
   * operator's pinned placements and the whole-fleet frame.
   *
   * Both are automatic frames, so they leave `userMoved` clear: the field
   * keeps following the fleet until a hand moves the camera.
   */
  setLayoutMode(mode: LayoutMode): void;
  layoutMode(): LayoutMode;
  select(ids: string[]): void;
  selection(): string[];
  screenOf(agentId: string): ScreenRect | null;
  screenToWorld(sx: number, sy: number): { x: number; y: number };
  spotOf(agentId: string): Spot | undefined;
  /** Frame one squad's block. False when there is no such block on the field. */
  frameSquad(name: string, projectId?: string | null): boolean;
  /** Whether a squad's block stands where the operator dragged it. */
  squadMoved(name: string, projectId?: string | null): boolean;
  /** Forget an agent's placement: the automatic layout takes it back. */
  unplace(agentId: string): void;
  /** Forget where a squad was dragged: the block returns to its cells. */
  resetSquad(name: string, projectId?: string | null): void;
  /** Whether a project's region stands where the operator dragged it. */
  regionMoved(projectId: string): boolean;
  /** Forget where a region was dragged: it returns to its spiral slot. */
  resetRegion(projectId: string): void;
  /** Whether anything on the field is where a hand put it. */
  arranged(): boolean;
  /** Forget every placement, agents and squads alike. */
  resetArrangement(): void;
  /** Where to put an artifact pulled from this agent. */
  placeNear(agentId: string, index: number): { x: number; y: number; z: number };
  stats(): { agents: number; drawn: number; segments: number; fps: number };
  /** The current layout, for the minimap. Read-only by convention. */
  layout(): Layout;
  /** The world rectangle the viewport covers, on the plane. */
  viewRect(): { minX: number; minY: number; maxX: number; maxY: number };
  /**
   * Temporary zoom-out: frame the smallest rectangle that holds both what is
   * on screen now and the given agent's tile, so an anchored window whose
   * tile wandered off-screen can be seen without losing where you were.
   */
  frameAround(agentId: string): boolean;
  /**
   * Focus mode: hold everything the selection is not wired to at arm's
   * length. Selected tiles keep alpha 1, whoever is at the other end of one
   * of their pipes drops to 0.45, everyone else to 0.12 with no glow; the
   * pipes and the DOM labels follow. Eased over 120 ms in both directions.
   *
   * Returns false when the call was refused because there is nothing to
   * focus — an empty selection — and true when it took effect.
   */
  setFocus(on: boolean): boolean;
  /**
   * Draw a `WorldState` that is not the store's: history replay. While a
   * world is set, every read the field makes — agents, projects, messages,
   * escalations, collisions, artifacts — comes from it, and `feed()` keeps
   * working. `null` returns to the live store. Crossing between worlds never
   * animates a spawn, a death or a message pulse: nothing arrived, the
   * operator moved the scrubber.
   */
  setReplay(world: WorldState | null): void;
  /**
   * Place an artifact at a screen point — where a drag from the gallery let
   * go. The point is resolved on the z=0.05 plane and handed to
   * `onPlaceArtifact`. HTML5 drops carrying `text/orca-artifact` on the field
   * root take the same path without anyone calling this.
   */
  dropArtifactAt(artifactId: string, sx: number, sy: number): void;
  dispose(): void;
}

/* Linear-space state colours for the shader, converted once. */
const STATE_RGB = Object.fromEntries(
  (Object.keys(STATE_HEX) as AgentState[]).map((s) => {
    const c = new THREE.Color(STATE_HEX[s]);
    return [s, [c.r, c.g, c.b] as [number, number, number]];
  }),
) as Record<AgentState, [number, number, number]>;

const C_LIME = new THREE.Color(0xc0f94a);
/**
 * The core of a pipe whose child is alive but not working. Not a separate
 * colour: the same lime at 55 %, so "thinking" reads as the same activity
 * turned down rather than as a different thing.
 */
const C_LIME_55 = new THREE.Color(0xc0f94a).multiplyScalar(0.55);
const C_LINE = new THREE.Color(0x3a4150);
const C_RGN = new THREE.Color(0x22252d);
/** A squad's outline: one step brighter than a region's, `--line`. */
const C_SQUAD = new THREE.Color(0x2a2e38);
const C_AMBER = new THREE.Color(0xf5a524);
const C_BLUE = new THREE.Color(0x8fb8ff);
const C_RED = new THREE.Color(0xff2a12);
const C_WHITE = new THREE.Color(0xf2f4f0);
/** Ports: ink when the core has reached them, `--ink-dim` when they only wait. */
const C_INK = new THREE.Color(0xf2f4f0);
const C_INK_DIM = new THREE.Color(0x8b9088);

/** Tile must be at least this wide on screen to earn a label. */
const LABEL_PX = 44;
const NOTICE_TTL = 60_000;
/** The plane an artifact dropped on the field lands on. */
const ART_Z = 0.05;
/** What a gallery drag carries. */
const ART_MIME = 'text/orca-artifact';
/** How far outside a region's corner the YOU node stands, in world units. */
const YOU_OUT = 0.5;
/**
 * The deck has no regions, so it has one YOU, off the grid's top-right
 * corner. This is its key in `youEls` — no project can collide with it.
 */
const DECK_YOU = '\u0000deck';
/**
 * How long the slowest tile waits before it starts sliding to a new layout.
 * The comp's deck lights in groups of 4-2-3-5-2-6, not in a wave; `beats()`
 * gives that rhythm and this compresses it into a third of a second so a
 * thousand tiles still land together.
 */
const RELAYOUT_SPREAD = 0.35;
/** Focus fades in and out over this, in seconds. */
const FOCUS_T = 0.12;
/** Alpha under focus: the selection, its neighbours, everyone else. */
const FOCUS_A = { sel: 1, near: 0.45, far: 0.12 };

/* ── Squads, in world units ───────────────────────────────────────── */
/**
 * The step cut out of a squad's top-right corner. Fixed, never proportional:
 * a forty-tile block with a proportional bite would read as a different shape
 * from the tile it is quoting. Two tiers, like the shader's nested bite.
 */
const SQ_STEP_W = 0.50;
const SQ_STEP_H = 0.30;
/** The squad port, measured in from the left corner of the top edge. */
const SQ_PORT_X = 0.15;
/** The rótulo, measured in from the same corner. It interrupts the line. */
const SQ_LABEL_X = 0.30;
/** Squad outlines sit over the region outline and under the tiles. */
const SQ_Z = -0.38;

/* ── Leaving a region ─────────────────────────────────────────────── */
/** How far outside a region's outline a pipe bound elsewhere steps. */
const RGN_OUT = 0.25;
/**
 * The tile-free bands inside a region's outline, measured from its edges.
 * `layoutFleet` leaves `RGN_PAD` of air on every side and another half unit
 * under the top for the label, so these two lines cross nothing at any zoom.
 */
const RGN_BAND_TOP = 0.3;
const RGN_BAND_BOT = 0.25;
/** How wide a world unit must be on screen before a rótulo earns more words. */
const SQ_TIER_PX = [40, 120] as const;
/** The roster stops here; past it the squares stop being a shape and become a bar. */
const ROSTER_MAX = 32;
/** A lead's mission on the rótulo, in characters. */
const SQ_MISSION = 48;
/** Pulses run at this many world units a second — `pipes.step`'s speed. */
const PULSE_SPEED = 9;

/** Runtime ids for `swarm.write`. 9 is CAPCOM, which is a role, not a CLI. */
const RUNTIME_ID: Record<string, number> = { claude: 0, codex: 1, grok: 2 };

export function createField(root: HTMLElement, ev: FieldEvents): FieldHandle {
  root.innerHTML = `
    <canvas class="field__canvas" data-canvas></canvas>
    <div class="field__layer" data-labels></div>
    <div class="field__layer" data-surfaces></div>
    <div class="field__layer" data-regions></div>
    <div class="field__layer"><div class="lasso" data-lasso></div></div>
  `;
  const canvas = root.querySelector<HTMLCanvasElement>('[data-canvas]')!;
  const labelsLayer = root.querySelector<HTMLElement>('[data-labels]')!;
  const surfacesLayer = root.querySelector<HTMLElement>('[data-surfaces]')!;
  const regionsLayer = root.querySelector<HTMLElement>('[data-regions]')!;
  const lassoEl = root.querySelector<HTMLElement>('[data-lasso]')!;
  regionsLayer.style.pointerEvents = 'none';

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    root.innerHTML = `<p class="field__nogl px px--sm">WEBGL UNAVAILABLE · THE FIELD NEEDS IT</p>`;
    throw new Error('WEBGL_UNAVAILABLE');
  }
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new FieldCamera();
  const swarm = createSwarm(scene);
  const pipes = createPipes(scene);
  const ground = createGround(scene);
  const labels = createLabels(labelsLayer);
  const media = createMedia(scene, surfacesLayer, camera, (id) => ev.onUnplaceArtifact(id));

  const reduce = REDUCE.value;

  /* ── State ──────────────────────────────────────────────────────── */
  let layout: Layout = emptyLayout();
  let agents: Agent[] = [];
  const byId = new Map<string, Agent>();
  let projects = new Map<string, Project>();
  let artifacts: Artifact[] = [];
  const selected = new Set<string>();
  let hover: string | null = null;
  let active = false;
  let dirty = true;
  /** Until the operator moves the camera, the field keeps framing what arrives. */
  let userMoved = false;
  let lastFramedCount = -1;
  /** Spiral of projects, or the align deck. See `setLayoutMode`. */
  let lmode: LayoutMode = { kind: 'field' };
  /**
   * Clock instant before which a spot stays where it is, then slides. Set on
   * a change of layout mode so the fleet arrives in the comp's irregular
   * groups instead of all at once. Empty the rest of the time — the cost of
   * this is one map lookup per tile per frame, and only while it is moving.
   */
  const holdUntil = new Map<string, number>();

  const seenAgents = new Set<string>();
  const seenMsgs = new Set<string>();
  const lastState = new Map<string, AgentState>();
  let clock = 0;
  /**
   * Bumped on every feed. The squad rótulos repaint against it and the zoom
   * tier, so a frame where neither moved costs one string compare per squad
   * instead of a roster rebuilt sixty times a second.
   */
  let feedRev = 0;

  /**
   * Asks we have seen open. When one of them turns up with an answer, that is
   * the moment §5.3 asks for: a frame of full lime, then the amber core
   * retracting into whoever answered. A message that arrives already answered
   * is not an event — nobody was watching the question.
   */
  const openAsks = new Set<string>();
  interface Answered { m: AgentMessage; flashed: boolean }
  const answered = new Map<string, Answered>();

  /** Shader-clock instant of each agent's last state change. The beat. */
  const flashAt = new Map<string, number>();
  /** Agents with an escalation you can actually answer from here. */
  const pendingAgents = new Set<string>();
  /** How many of those each project holds — the number on its YOU node. */
  const pendingByProject = new Map<string, number>();
  const byCallsign = new Map<string, string>();
  const regionById = new Map<string, Region>();

  /* ── Squads ───────────────────────────────────────────────────── */
  /** Squad name → the agent marked `lead`, when there is one. */
  const squadLead = new Map<string, string>();
  /** Squad name → the roster, in `memberIds` order. `squadsOf`'s answer. */
  const squadByName = new Map<string, Squad>();
  /** Squad name → its block, keyed `projectId\0name`. Where a rótulo stands. */
  const squadBlocks = new Map<string, SquadBlock>();
  /**
   * Block key → the clock instant a pulse in flight toward its port lands.
   * While one is out the port is filled ink instead of `--ink-dim`: the squad
   * is being spoken to.
   */
  const squadLit = new Map<string, number>();
  /**
   * Sigil bits per agent, and the seed they were made from. Recomputed only
   * when the seed changes — an agent that joins a squad gets the squadron's
   * patch, and nobody hashes a thousand strings a frame.
   */
  const sigils = new Map<string, { seed: string; bits: number }>();
  /** Block keys we have already drawn, so a new squadron traces itself once. */
  const seenSquads = new Set<string>();
  /**
   * Each block's outline polyline, built once per feed. A block only moves
   * when the layout does, and `buildPipes` runs sixty times a second: nine
   * points per squad per frame is nine allocations this does not make.
   */
  const squadPaths = new Map<string, Pt[]>();

  /**
   * The seed of an agent's sigil: the squadron's name when it has one, so five
   * members wear the same patch, and its own id when it does not.
   */
  function sigilOf(a: Agent): number {
    if (a.role === 'capcom') return CAPCOM_BITS;
    const seed = squadOf(a) ?? a.id;
    const had = sigils.get(a.id);
    if (had && had.seed === seed) return had.bits;
    const bits = sigilBits(seed);
    sigils.set(a.id, { seed, bits });
    return bits;
  }

  /** 0 claude · 1 codex · 2 grok · 3 anything else · 9 CAPCOM. */
  function runtimeOf(a: Agent): number {
    if (a.role === 'capcom') return 9;
    return RUNTIME_ID[a.runtime] ?? 3;
  }
  /**
   * A squadron does not arrive all at once. The lead grows out of its parent
   * the way any tile does, and every member that lands within `BURST_WINDOW`
   * seconds sprouts from the lead one beat later — `beats()` gives the comp's
   * 4-2-3-5-2-6, so five agents read as a squad forming, not as a paste.
   */
  const bursts = new Map<string, { t0: number; n: number }>();
  const BURST_WINDOW = 3;
  function burstOffset(squad: string): number {
    let b = bursts.get(squad);
    if (!b || clock - b.t0 > BURST_WINDOW) { b = { t0: clock, n: 1 }; bursts.set(squad, b); }
    const off = beats(b.n + 1)[b.n] ?? 0;
    b.n++;
    return off;
  }
  /** The block a message to `name` should land on: the sender's own, if any. */
  function blockFor(name: string, projectId?: string | null): { key: string; q: SquadBlock } | null {
    if (projectId) {
      const k = squadKey(projectId, name);
      const mine = squadBlocks.get(k);
      if (mine) return { key: k, q: mine };
    }
    for (const [k, b] of squadBlocks) if (b.name === name) return { key: k, q: b };
    return null;
  }
  /**
   * Where a message addressed to a squad lands: the **port** on the block's top
   * edge (§3.3), which is also where the fan-out to its members leaves from.
   * The sender's own project wins a name collision.
   */
  function squadAnchor(name: string, projectId?: string | null): Pt | null {
    const hit = blockFor(name, projectId);
    return hit ? squadPortAt(hit.q) : null;
  }
  /** The port on a block's top edge, 0.15 in from its left corner. */
  function squadPortAt(q: SquadBlock): Pt {
    return { x: q.cx - q.hw + SQ_PORT_X, y: q.cy + q.hh };
  }
  /**
   * A squad's outline: the tile's own silhouette at block scale, traced
   * clockwise from the lead's corner — the top-left cell, which `squadOrder`
   * guarantees is the lead's. Nine points, because the step out of the
   * top-right corner is two tiers, the way the shader's bite is.
   *
   * The step is a fixed 0.50 × 0.30 and never proportional: a block twelve
   * tiles wide with a proportional bite would stop quoting the tile and start
   * being some other shape.
   */
  function squadOutline(q: SquadBlock): Pt[] {
    const x0 = q.cx - q.hw, x1 = q.cx + q.hw, y0 = q.cy - q.hh, y1 = q.cy + q.hh;
    const w = Math.min(SQ_STEP_W, q.hw), h = Math.min(SQ_STEP_H, q.hh);
    return [
      { x: x0, y: y1 },
      { x: x1 - w, y: y1 },
      { x: x1 - w, y: y1 - h / 2 },
      { x: x1 - w / 2, y: y1 - h / 2 },
      { x: x1 - w / 2, y: y1 - h },
      { x: x1, y: y1 - h },
      { x: x1, y: y0 },
      { x: x0, y: y0 },
      { x: x0, y: y1 },
    ];
  }

  /** Replay: a world that is not the store's. See `setReplay`. */
  let replay: WorldState | null = null;
  const world = () => replay ?? store.world;
  /** Set across a world swap so the next feed animates nothing. */
  let swapped = true;

  let focusOn = false;
  /** Eased 0 → 1; the shaders and the label layer read it. */
  let focusV = 0;
  /** Agents at the other end of a pipe from the selection. */
  const focusNear = new Set<string>();
  /** Agents blocked behind the selection, when it is a chain's terminus. */
  const damSet = new Set<string>();
  /** Bumped whenever the selection or the world changes; gates the two above. */
  let selRev = 0;
  let selRevDone = -1;

  /* ── Feeding ────────────────────────────────────────────────────── */

  function feedNow() {
    dirty = false;
    const w = world();
    projects = new Map(Object.entries(w.projects));
    // Both, and both per feed: a title that only repeats the project's name is
    // no title, and `labels.ts` needs the name as well as the code to see it.
    for (const p of projects.values()) { rememberProjectCode(p.id, p.code); rememberProjectName(p.id, p.name); }
    for (const m of Object.values(w.machines ?? {})) rememberMachine(m.id, m.hostname);
    agents = Object.values(w.agents);
    byId.clear();
    byCallsign.clear();
    for (const a of agents) { byId.set(a.id, a); byCallsign.set(a.callsign.toUpperCase(), a.id); }

    // Which blocks a person can actually clear, resolved once per feed: the
    // shader asks this per tile and the YOU nodes ask it per region.
    pendingAgents.clear();
    pendingByProject.clear();
    for (const e of Object.values(w.escalations ?? {})) {
      if (e.status !== 'pending' && e.status !== 'with_ceo') continue;
      pendingAgents.add(e.agentId);
      const pid = byId.get(e.agentId)?.projectId ?? e.projectId;
      pendingByProject.set(pid, (pendingByProject.get(pid) ?? 0) + 1);
    }

    const placements = new Map<string, Placement>();
    for (const [id, p] of Object.entries(w.placements ?? {})) placements.set(id, p);
    for (const p of loadLocalPlacements()) placements.set(p.agentId, p);

    layout = layoutFleet(agents, projects, placements, layout, lmode, squadPlaced, regionPlaced);
    // The router reads the gutters off the layout: the deck's are wider.
    gaps.x = layout.gapX; gaps.y = layout.gapY;
    regionById.clear();
    squadBlocks.clear();
    for (const r of layout.regions) {
      regionById.set(r.id, r);
      for (const q of r.squads) squadBlocks.set(squadKey(q.projectId, q.name), q);
    }
    // A squadron that has just formed traces its own outline (§3.1). Done
    // here rather than in `buildPipes` because a feed is the only place a
    // block can be new, and the trace must start on the frame it appears.
    for (const k of seenSquads) if (!squadBlocks.has(k)) { seenSquads.delete(k); squadSeen.delete(k); }
    squadPaths.clear();
    for (const [k, q] of squadBlocks) squadPaths.set(k, squadOutline(q));
    for (const k of squadBlocks.keys()) {
      if (seenSquads.has(k)) continue;
      seenSquads.add(k);
      if (seenAgents.size === 0 || swapped || reduce) continue;
      anim.set(`sq:${k}`, 0);
      anim.grow(`sq:${k}`, { dur: T.move, ease: EASE.inout });
    }
    // `squadsOf` is the shared rule — same grouping the hub routes squad
    // traffic by, same tie-break when two agents both claim the lead. The
    // roster on every rótulo is `memberIds`, so it is kept whole, not just the
    // lead: the order of that list *is* the order of the squares.
    squadLead.clear();
    squadByName.clear();
    for (const q of squadsOf(agents)) {
      squadByName.set(q.name, q);
      if (q.leaderId) squadLead.set(q.name, q.leaderId);
    }

    // Arrivals grow out of their parent; departures flash and sink. A world
    // swap is neither: nothing arrived, the operator moved the scrubber.
    const first = seenAgents.size === 0 || swapped;
    swapped = false;
    for (const a of agents) {
      if (!seenAgents.has(a.id)) {
        seenAgents.add(a.id);
        /*
         * Birth, the comp's way (§5.1). The tile does not fly in from its
         * parent any more: its cell shows a hollow port in this very frame,
         * the bus appears whole and grey, and the *core* grows down the pipe.
         * Only when the core lands does the tile enter, already in its cell.
         * A squad member waits for its beat first, so five of them read as a
         * squadron forming instead of a paste.
         */
        if (!first && layout.spots.has(a.id) && !reduce) {
          const sq = squadOf(a);
          const leadId = sq && !isLead(a) ? squadLead.get(sq) : undefined;
          const off = leadId && leadId !== a.id ? burstOffset(sq!) : 0;
          const id = a.id;
          anim.set(`tile:${id}`, 0);
          anim.set(`core:${id}`, 0);
          anim.grow(`core:${id}`, {
            dur: T.move, ease: EASE.inout, delay: off,
            onDone: () => anim.grow(`tile:${id}`, { dur: T.quick, ease: EASE.arrive }),
          });
        }
      }
      const was = lastState.get(a.id);
      // The beat: everything that changed in this patch flashes together, on
      // the same clock reading. No stagger — that is what makes it one beat.
      if (was && was !== a.state && !first && !reduce) flashAt.set(a.id, clock);
      if (was && was !== 'dead' && a.state === 'dead' && !reduce) {
        // The core drains back toward the parent and the child's port goes
        // hollow again. The bus stays: the child existed.
        anim.drain(`core:${a.id}`, { dur: T.move, ease: EASE.inout });
        // Dying kills the core's tween, and with it the callback that was
        // going to bring the tile in. An agent that died mid-birth still has
        // to be visible enough to be seen dying.
        if (anim.get(`tile:${a.id}`, 1) <= 0) anim.set(`tile:${a.id}`, 1);
        anim.set(`die:${a.id}`, 0);
        anim.grow(`die:${a.id}`, { dur: 0.7, ease: EASE.none });
      }
      lastState.set(a.id, a.state);
    }
    for (const id of seenAgents) if (!byId.has(id)) { seenAgents.delete(id); lastState.delete(id); flashAt.delete(id); holdUntil.delete(id); selected.delete(id); sigils.delete(id); }
    for (const [sq, b] of bursts) if (clock - b.t0 > BURST_WINDOW * 4) bursts.delete(sq);
    for (const [k, t] of squadLit) if (clock > t) squadLit.delete(k);
    // Scalars whose subject the world no longer has. `ans:` keys retire
    // themselves when their drain finishes, so they are never swept here.
    anim.sweep((k) => {
      const i = k.indexOf(':');
      if (i < 0) return true;
      const what = k.slice(0, i), id = k.slice(i + 1);
      if (what === 'core' || what === 'tile' || what === 'die') return byId.has(id);
      if (what === 'sq') return squadBlocks.has(id);
      return true;
    });
    feedRev++;
    selRev++;

    // A message we have not seen runs its pipe once.
    for (const m of Object.values(w.messages ?? {})) {
      if (!seenMsgs.has(m.id)) {
        seenMsgs.add(m.id);
        if (m.kind === 'ask' && !m.answer) openAsks.add(m.id);
        if (!first) {
          if (m.toSquad) fanOut(m);
          else {
            const path = pathFor(m);
            if (path) pipes.pulse(path.pts, path.z, path.color.clone().lerp(C_WHITE, 0.5));
          }
        }
        continue;
      }
      /*
       * An answer, §5.3. The amber pipe cuts to full lime for one frame and
       * then retracts into whoever answered — never a fade, and never a pipe
       * that simply is not there next frame.
       */
      if (m.answer && openAsks.delete(m.id) && !first && !reduce) {
        answered.set(m.id, { m, flashed: false });
        anim.set(`ans:${m.id}`, 1);
        anim.drain(`ans:${m.id}`, {
          dur: T.quick, ease: EASE.inout,
          onDone: () => { answered.delete(m.id); anim.kill(`ans:${m.id}`); },
        });
      }
    }
    if (seenMsgs.size > 5000) {
      const drop = [...seenMsgs].slice(0, 2000);
      for (const id of drop) { seenMsgs.delete(id); openAsks.delete(id); }
    }

    artifacts = Object.values(w.artifacts ?? {});
    media.update(artifacts);
    syncRegions();
    if (!userMoved && agents.length !== lastFramedCount) { lastFramedCount = agents.length; camera.frame(layout.bounds); }
  }

  const PLACEMENT_KEY = 'orca.placements.v2';
  function loadLocalPlacements(): Placement[] {
    try {
      const raw = localStorage.getItem(PLACEMENT_KEY);
      if (!raw) return [];
      const list = JSON.parse(raw) as Placement[];
      return Array.isArray(list) ? list.filter((p) => p && typeof p.agentId === 'string') : [];
    } catch { return []; }
  }
  let saveTimer = 0;
  function saveLocalPlacement(p: Placement) {
    store.world.placements[p.agentId] = p;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        const list = Object.values(store.world.placements).filter((x) => x.pinned).slice(-2000);
        localStorage.setItem(PLACEMENT_KEY, JSON.stringify(list));
      } catch { /* private mode; the arrangement lives for this tab only */ }
    }, 300);
  }
  function unplaceLocal(agentId: string) {
    delete store.world.placements[agentId];
    clearTimeout(saveTimer);
    try {
      const list = Object.values(store.world.placements).filter((x) => x.pinned).slice(-2000);
      localStorage.setItem(PLACEMENT_KEY, JSON.stringify(list));
    } catch { /* fine */ }
  }

  /*
   * Where the operator left each squad, keyed like `squadBlocks`. The hub has
   * no channel for it yet, so — like an agent's placement — it lives in this
   * browser and comes back with it.
   */
  const SQUAD_KEY = 'orca.squads.placed.v1';
  const squadPlaced = new Map<string, SquadPlacement>();
  try {
    const raw = localStorage.getItem(SQUAD_KEY);
    const list = raw ? JSON.parse(raw) as SquadPlacement[] : [];
    if (Array.isArray(list)) for (const p of list) {
      if (p && typeof p.projectId === 'string' && typeof p.name === 'string' && Number.isFinite(p.x) && Number.isFinite(p.y)) squadPlaced.set(squadKey(p.projectId, p.name), p);
    }
  } catch { /* fine */ }
  function saveSquadPlacements() {
    try { localStorage.setItem(SQUAD_KEY, JSON.stringify([...squadPlaced.values()].slice(-500))); }
    catch { /* private mode */ }
  }
  /* Where the operator left each region. Same life as a squad's: this browser. */
  const REGION_KEY = 'orca.regions.placed.v1';
  const regionPlaced = new Map<string, RegionPlacement>();
  try {
    const raw = localStorage.getItem(REGION_KEY);
    const list = raw ? JSON.parse(raw) as RegionPlacement[] : [];
    if (Array.isArray(list)) for (const p of list) {
      if (p && typeof p.projectId === 'string' && Number.isFinite(p.x) && Number.isFinite(p.y)) regionPlaced.set(p.projectId, p);
    }
  } catch { /* fine */ }
  function saveRegionPlacements() {
    try { localStorage.setItem(REGION_KEY, JSON.stringify([...regionPlaced.values()].slice(-500))); }
    catch { /* private mode */ }
  }

  /** The block a name refers to: the project's own when given, else the first. */
  function blockOf(name: string, projectId?: string | null): { key: string; q: SquadBlock } | null {
    if (projectId) {
      const k = squadKey(projectId, name);
      const q = squadBlocks.get(k);
      return q ? { key: k, q } : null;
    }
    for (const [k, q] of squadBlocks) if (q.name === name) return { key: k, q };
    return null;
  }
  /** Every agent standing in a block: same project, same squad. */
  function membersOf(q: SquadBlock): string[] {
    const out: string[] = [];
    for (const a of agents) if (a.projectId === q.projectId && squadOf(a) === q.name) out.push(a.id);
    return out;
  }

  /* ── Region labels (DOM) ────────────────────────────────────────── */
  const regionEls = new Map<string, HTMLElement>();
  const youEls = new Map<string, HTMLElement>();
  /** One rótulo per squad block, keyed the same way `squadBlocks` is. */
  const squadEls = new Map<string, HTMLElement>();
  /**
   * The states the roster was last painted with, per block. A square whose
   * state moved since then jumps to `--ink-bright` for one `T.snap` and cuts
   * to its new colour — the tile's own beat, at the scale of a dot.
   */
  const squadSeen = new Map<string, Map<string, AgentState>>();
  /** Timers stripping `.is-beat` off a roster. One per block, replaced. */
  const squadBeat = new Map<string, number>();

  /** Which of the three rótulo states this zoom earns (§3.2). */
  function squadTier(ppu: number): number {
    return ppu >= SQ_TIER_PX[1] ? 3 : ppu >= SQ_TIER_PX[0] ? 2 : 1;
  }

  /**
   * The rótulo: a sigil, a roster, and — as the tiles become legible — the
   * name, the lead and what the lead is there to do.
   *
   * Repainted only when the world moved (`feedRev`) or the zoom crossed a
   * rung. Everything inside is a string compare away from being skipped, so a
   * still field costs one per squad per frame.
   */
  function paintSquad(k: string, el: HTMLElement, q: SquadBlock, tier: number) {
    const stamp = `${feedRev}|${tier}`;
    if (el.dataset.paint === stamp) return;
    el.dataset.paint = stamp;

    const sq = squadByName.get(q.name);
    const ids = (sq?.memberIds ?? []).slice(0, ROSTER_MAX);
    const lead = q.leadId ? byId.get(q.leadId) : null;
    let need = 0;
    for (const id of ids) if (pendingAgents.has(id)) need++;

    // What changed since the last paint. Read before it is overwritten.
    const was = squadSeen.get(k);
    const now = new Map<string, AgentState>();
    let beat = false;

    let roster = '';
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const a = byId.get(id);
      if (!a) continue;
      now.set(id, a.state);
      const changed = was ? was.get(id) !== undefined && was.get(id) !== a.state : false;
      if (changed) beat = true;
      roster += `<i class="rsq${i === 0 ? ' rsq--lead' : ''}${changed ? ' is-beat' : ''}"`
        + ` style="--c:${STATE_VAR[a.state]}"></i>`;
    }
    squadSeen.set(k, now);

    // The squadron's patch: seeded on the *name*, so it is the same glyph every
    // member wears on its tile (§1.1) — the block is a body before the outline
    // even resolves. `.sigil--lg` is column A's double size.
    const sig = sigilHTML(sigilBits(q.name));
    let html = `<span class="squad__sigil sigil--lg">${sig}</span><span class="squad__roster">${roster}</span>`;
    if (tier >= 2) {
      html += `<span class="squad__k">${esc(q.name)}</span><span class="squad__n">${q.count}</span>`;
    }
    if (tier >= 3) {
      if (lead) html += `<span class="squad__lead">LEAD ${esc(lead.callsign)}</span>`;
      const mission = lead?.mission ? clip(lead.mission, SQ_MISSION) : '';
      if (mission) html += `<span class="squad__mission">${esc(mission)}</span>`;
      if (need) html += `<span class="squad__need">${need} NEED YOU</span>`;
    }
    el.innerHTML = html;

    // The flash is a class, not a tween: palettes cut. One timer per block
    // takes every square back to its state colour together.
    if (!beat || reduce) return;
    clearTimeout(squadBeat.get(k));
    squadBeat.set(k, window.setTimeout(() => {
      squadBeat.delete(k);
      for (const n of el.querySelectorAll('.rsq.is-beat')) n.classList.remove('is-beat');
    }, T.snap * 1000));
  }

  /** Everything in the fleet that waits on a person. The deck's YOU counts these. */
  function pendingAll(): number {
    let n = 0;
    for (const v of pendingByProject.values()) n += v;
    return n;
  }

  /**
   * Where a YOU node stands.
   *
   * In the field, one per region, just outside its top-right corner, so the
   * pipes that converge on it leave the region and meet in open space. In the
   * deck there are no regions and there is one YOU, off the grid's top-right
   * corner, and every ask in the fleet runs to it — the same inverted V, at
   * fleet scale.
   */
  function youOf(key: string): Pt | null {
    if (lmode.kind === 'deck') {
      if (key !== DECK_YOU || !pendingAll()) return null;
      return { x: layout.bounds.maxX + YOU_OUT, y: layout.bounds.maxY + YOU_OUT };
    }
    const r = regionById.get(key);
    if (!r || !(pendingByProject.get(key) ?? 0)) return null;
    return { x: r.cx + r.hw + YOU_OUT, y: r.cy + r.hh + YOU_OUT };
  }

  /** Which YOU nodes exist right now, and the count each one carries. */
  function youNodes(): Map<string, number> {
    const out = new Map<string, number>();
    if (lmode.kind === 'deck') {
      const n = pendingAll();
      if (n) out.set(DECK_YOU, n);
      return out;
    }
    for (const r of layout.regions) {
      const n = pendingByProject.get(r.id) ?? 0;
      if (n) out.set(r.id, n);
    }
    return out;
  }

  function syncRegions() {
    // The deck has no regions, so this drops every region label with them.
    const want = new Set(layout.regions.map((r) => r.id));
    for (const [id, el] of regionEls) if (!want.has(id)) { el.remove(); regionEls.delete(id); }
    // A YOU node exists only while something behind it waits on a person.
    const you = youNodes();
    for (const [id, el] of youEls) if (!you.has(id)) { el.remove(); youEls.delete(id); }
    for (const [id, n] of you) {
      let el = youEls.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'you';
        youEls.set(id, el);
        regionsLayer.appendChild(el);
      }
      const sig = String(n);
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        el.innerHTML = `YOU<span class="you__n">·&nbsp;${n}</span>`;
      }
    }
    // Squad rótulos live in the same layer and on the same fade as regions:
    // they name a sub-block of one, and two labels with different lifetimes
    // over the same tiles would read as two systems.
    for (const [k, el] of squadEls) if (!squadBlocks.has(k)) { el.remove(); squadEls.delete(k); squadSeen.delete(k); }
    for (const k of squadBlocks.keys()) {
      if (squadEls.has(k)) continue;
      const el = document.createElement('div');
      el.className = 'squad';
      // Named in the DOM so the visual harness can find a block at a zoom
      // where the rótulo has no words in it yet.
      el.dataset.squad = squadBlocks.get(k)!.name;
      // The rótulo is the block's handle: it is the one part of a squad that
      // is never under a tile, and it never hides, so it can always be grabbed.
      el.dataset.key = k;
      el.style.pointerEvents = 'auto';
      regionsLayer.appendChild(el);
      squadEls.set(k, el);
    }
    for (const r of layout.regions) {
      let el = regionEls.get(r.id);
      if (!el) {
        el = document.createElement('button');
        (el as HTMLButtonElement).type = 'button';
        el.className = 'rgn';
        el.style.pointerEvents = 'auto';
        el.dataset.project = r.id;
        el.addEventListener('click', (e) => {
          // A drag that ended on the label is not a click on it.
          if (swallowClick) { swallowClick = false; return; }
          if ((e.target as HTMLElement).closest('.rgn__open')) ev.onOpenProject(r.id, e.clientX, e.clientY);
          else frameProject(r.id);
        });
        regionsLayer.appendChild(el);
        regionEls.set(r.id, el);
      }
      el.classList.toggle('is-moved', r.moved);
      const sig = `${r.code}|${r.name}|${r.count}|${r.blocked}`;
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        el.innerHTML = `<span class="rgn__code">${esc(r.code)}</span><span class="rgn__name">${esc(r.name)}</span>`
          + `<span class="rgn__n">${r.blocked ? `${r.blocked} NEED YOU · ` : ''}${r.count}</span>`
          + `<span class="rgn__open" title="Open this project">▸</span>`;
        el.classList.toggle('has-blocked', r.blocked > 0);
      }
    }
  }
  function placeRegions() {
    const ppu = camera.pxPerUnit(0);
    const fade = Math.max(0, Math.min(1, (300 - ppu) / 160));
    // Labels that would sit on one already placed hide at this zoom. The
    // ones with a human waiting go first, so they are never the ones hidden.
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const order = [...layout.regions].sort((a, b) => b.blocked - a.blocked || b.count - a.count);
    for (const r of order) {
      const el = regionEls.get(r.id);
      if (!el) continue;
      const p = camera.project(r.cx - r.hw, r.cy + r.hh, 0);
      if (!p.visible || fade < 0.03) { el.style.display = 'none'; continue; }
      const w = el.offsetWidth || 160, h = 22;
      const box = { x: p.x, y: p.y - 26, w, h };
      if (placed.some((q) => box.x < q.x + q.w && box.x + box.w > q.x && box.y < q.y + q.h && box.y + box.h > q.y)) {
        el.style.display = 'none';
        continue;
      }
      placed.push(box);
      el.style.display = '';
      el.style.opacity = String(fade);
      el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y - 26)}px, 0)`;
    }
    // A squad rótulo sits on the top-left corner of its block, inside the
    // region's own label, and never hides: it names tiles nothing else names.
    //
    // It sits *on* the top line, not above it — a fieldset legend, with the
    // bezel behind it interrupting the outline the pipes drew. The roster
    // still reads when the region's own label has faded out, so this ignores
    // `fade`: at the zoom where a tile is a mote, the roster is the only thing
    // left saying "five working, one waiting on you".
    const tier = squadTier(ppu);
    for (const [k, el] of squadEls) {
      const q = squadBlocks.get(k);
      if (!q) { el.style.display = 'none'; continue; }
      const p = camera.project(q.cx - q.hw + SQ_LABEL_X, q.cy + q.hh, 0);
      if (!p.visible) { el.style.display = 'none'; continue; }
      paintSquad(k, el, q, tier);
      el.classList.toggle('is-moved', q.moved);
      el.style.display = '';
      el.style.opacity = '1';
      el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0) translateY(-50%)`;
    }
    // YOU labels ride their node, not the region's corner, and never yield to
    // a collision: the count is the one number worth the overlap.
    for (const [id, el] of youEls) {
      const you = youOf(id);
      if (!you) { el.style.display = 'none'; continue; }
      const p = camera.project(you.x, you.y, 0);
      if (!p.visible || fade < 0.03) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.opacity = String(fade);
      el.style.transform = `translate3d(${Math.round(p.x + 10)}px, ${Math.round(p.y - 8)}px, 0)`;
    }
  }

  /* ── Routing ────────────────────────────────────────────────────── */

  /**
   * The gutters this layout left, handed to the router. One object, rebuilt
   * once per feed rather than once per pipe: `buildPipes` runs sixty times a
   * second over every relationship in the fleet and must not allocate in it.
   */
  const gaps = { x: layout.gapX, y: layout.gapY };

  /**
   * Which of the three lanes in a gutter a pipe takes. Hung on the *parent*
   * (on the sender, for traffic) so a family shares one lane and two families
   * in the same gutter do not lie on top of each other.
   */
  function laneOf(seed: string): -1 | 0 | 1 {
    return ((hash(seed) * 3 | 0) - 1) as -1 | 0 | 1;
  }

  /**
   * A tile the operator pinned has broken the grid on purpose: there is no
   * gutter to its cell any more, so its pipes go back to the direct routes.
   */
  const offGrid = (a: Pt, b: Pt) =>
    (a as Partial<Spot>).pinned === true || (b as Partial<Spot>).pinned === true;

  /**
   * The region a point stands in, when it is a tile at all.
   *
   * A YOU node, a project label and a squad port are bare points with no
   * `projectId`: they live outside the tile grid, which is exactly why they
   * need the routes below and not `routeGutterMsg`.
   */
  function regionOf(p: Pt): Region | undefined {
    const pid = (p as Partial<Spot>).projectId;
    return pid ? regionById.get(pid) : undefined;
  }
  const insideRegion = (r: Region, p: Pt) =>
    Math.abs(p.x - r.cx) <= r.hw && Math.abs(p.y - r.cy) <= r.hh;

  /**
   * Out of a region, cleanly.
   *
   * `routeGutter` and `routeGutterMsg` are safe inside one region because the
   * region *is* the grid whose gutters they compute. Two tiles in different
   * regions share no grid, so a "gutter" between them is an arbitrary line
   * through whatever stands in the way — in the synthetic fleet, four dashed
   * amber verticals straight down every row of the region in between.
   *
   * So a pipe that leaves a region leaves it the way a pipe leaves a tile: by
   * a door. It takes the side port, steps into the vertical gutter beside its
   * own column — no tile stands in that gutter at any row, which is what makes
   * the long run safe — and then either rides that gutter straight out through
   * the top or the bottom, or turns into one of the region's **margin bands**.
   *
   * The bands are the air `RGN_PAD` (and the label's half unit) leave inside
   * the outline: 1.05 units under the top edge and 0.55 over the bottom one,
   * where `layoutFleet` never puts a tile. Running along one of those to the
   * side of the region costs two legs and crosses nothing.
   */
  function exitRegion(a: Pt, r: Region, towards: Pt, lane: -1 | 0 | 1): Pt[] {
    const lx = lane * laneShift(gaps.x);
    const ly = lane * laneShift(gaps.y);
    const sx = towards.x >= a.x ? 1 : -1;
    const ay = a.y + TILE_H * 0.12;
    const px = a.x + sx * TILE_W / 2;
    const vx = a.x + sx * (TILE_W / 2 + gaps.x / 2) + lx;

    // Which wall to leave by: the one the target is mostly beyond. Measured
    // against the region's centre, not the tile's, so every pipe bound the
    // same way leaves by the same wall and they run together.
    const wide = Math.abs(towards.x - r.cx) / Math.max(r.hw, 0.01);
    const tall = Math.abs(towards.y - r.cy) / Math.max(r.hh, 0.01);
    if (tall > wide) {
      const up = towards.y >= r.cy;
      return [{ x: px, y: ay }, { x: vx, y: ay }, { x: vx, y: r.cy + (up ? r.hh + RGN_OUT : -r.hh - RGN_OUT) }];
    }
    // The nearer band, so the run along it is the short one.
    const top = r.cy + r.hh - RGN_BAND_TOP;
    const bot = r.cy - r.hh + RGN_BAND_BOT;
    const my = (Math.abs(ay - top) <= Math.abs(ay - bot) ? top : bot) + ly;
    const ex = r.cx + (towards.x >= r.cx ? r.hw + RGN_OUT : -r.hw - RGN_OUT);
    return [{ x: px, y: ay }, { x: vx, y: ay }, { x: vx, y: my }, { x: ex, y: my }];
  }

  /** Does an axis-aligned leg touch a region's rectangle at all? */
  function hitsRegion(a: Pt, b: Pt, r: Region): boolean {
    return Math.max(a.x, b.x) >= r.cx - r.hw && Math.min(a.x, b.x) <= r.cx + r.hw
      && Math.max(a.y, b.y) >= r.cy - r.hh && Math.min(a.y, b.y) <= r.cy + r.hh;
  }

  /**
   * The leg between two points already outside their regions. Two Manhattan
   * candidates, and the one that walks over fewer *other* regions wins — a
   * dozen rectangle tests, which is cheaper than any of the alternatives and
   * is the only thing standing between "a pipe in open space" and "a pipe
   * through somebody else's fleet". A tie goes to horizontal-first, so
   * parallel traffic between two regions reads as one bundle.
   */
  function bridge(p: Pt, q: Pt, ra: Region, rb: Region): Pt[] {
    if (Math.abs(p.x - q.x) < 1e-4 || Math.abs(p.y - q.y) < 1e-4) return [];
    const h = { x: q.x, y: p.y };
    const v = { x: p.x, y: q.y };
    let ch = 0, cv = 0;
    for (const r of layout.regions) {
      if (r === ra || r === rb) continue;
      if (hitsRegion(p, h, r) || hitsRegion(h, q, r)) ch++;
      if (hitsRegion(p, v, r) || hitsRegion(v, q, r)) cv++;
    }
    return [cv < ch ? v : h];
  }

  /** Region → region: out of one by a door, across open space, in by another. */
  function crossRegion(a: Pt, b: Pt, ra: Region, rb: Region, lane: -1 | 0 | 1): Pt[] {
    const out = exitRegion(a, ra, b, lane);
    const back = exitRegion(b, rb, a, lane).reverse();
    return [...out, ...bridge(out[out.length - 1]!, back[0]!, ra, rb), ...back];
  }

  const lineageRoute = (p: Pt, c: Pt, seed: string): Pt[] => {
    if (offGrid(p, c)) return routeLineage(p, c);
    const rp = regionOf(p), rc = regionOf(c);
    if (rp && rc && rp !== rc) return crossRegion(p, c, rp, rc, laneOf(seed));
    return routeGutter(p, c, gaps, laneOf(seed));
  };
  const messageRoute = (a: Pt, b: Pt, seed: string): Pt[] => {
    if (offGrid(a, b)) return routeMessage(a, b);
    const lane = laneOf(seed);
    const ra = regionOf(a), rb = regionOf(b);
    if (ra && rb && ra !== rb) return crossRegion(a, b, ra, rb, lane);
    // A YOU node or a project label is a bare point outside the grid. Leave
    // the region by a door and land on it; `landOn` squares up the last leg.
    if (ra && !rb && !insideRegion(ra, b)) return landOn(exitRegion(a, ra, b, lane), b);
    return routeGutterMsg(a, b, gaps, lane);
  };

  /* ── Pipes per frame ────────────────────────────────────────────── */

  function pathFor(m: AgentMessage): { pts: Pt[]; z: number; color: THREE.Color } | null {
    const a = layout.spots.get(m.fromAgentId);
    if (!a) return null;
    let to: Pt | null = null;
    if (m.scope === 'agent' && m.toAgentId) {
      const b = layout.spots.get(m.toAgentId);
      if (b) to = b;
    } else if (m.scope === 'project' && m.toProjectId) {
      const r = layout.regions.find((x) => x.id === m.toProjectId);
      if (r) to = { x: r.cx - r.hw + 0.3, y: r.cy + r.hh - 0.3 };
    }
    // A squad is a name, not a record, and it can span projects: the pipe
    // lands on the port of the block nearest the sender.
    if (!to && m.toSquad) to = squadAnchor(m.toSquad, m.fromProjectId);
    if (!to) return null;
    const color = m.kind === 'ask' ? C_AMBER : m.kind === 'warning' ? C_RED : m.kind === 'handoff' ? C_LIME : C_BLUE;
    return { pts: messageRoute(a, to, m.fromAgentId), z: Math.min(a.z, 0.05) - 0.02, color };
  }

  /**
   * The fan (§5.3). A message to a squadron lands on the block's port, lights
   * it, and from there `n` pulses leave for the top port of every member on
   * the beats of `beats(n)`. That picture — one arrival, then the spray — is
   * "I spoke to the flotilla", and it is the only thing that distinguishes it
   * from having typed the same line five times.
   */
  function fanOut(m: AgentMessage) {
    const from = layout.spots.get(m.fromAgentId);
    const hit = m.toSquad ? blockFor(m.toSquad, m.fromProjectId) : null;
    if (!from || !hit) return;
    const port = squadPortAt(hit.q);
    const z = Math.min(from.z, 0.05) - 0.02;
    const color = C_LIME.clone().lerp(C_WHITE, 0.5);
    const pts = messageRoute(from, port, m.fromAgentId);
    pipes.pulse(pts, z, color);

    // The port stays ink for exactly as long as the pulse is in the air.
    const flight = Math.max(T.quick, pathLength(pts) / PULSE_SPEED);
    squadLit.set(hit.key, clock + flight);

    const ids = squadByName.get(hit.q.name)?.memberIds ?? [];
    const offs = beats(ids.length);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      gsap.delayedCall(dur(flight + (offs[i] ?? 0)), () => {
        const s = layout.spots.get(id);
        if (!s) return;
        // Into the member's top port — the same door lineage uses (§4.1).
        const top = { x: s.x - TILE_W * 0.32, y: s.y + TILE_H / 2 };
        pipes.pulse([port, { x: port.x, y: top.y }, top], z, color);
      });
    }
  }

  /** `block.waitingOn` is whatever the collector had: a callsign or an id. */
  function resolveWaiting(who: string | undefined): string | null {
    if (!who) return null;
    if (byId.has(who)) return who;
    return byCallsign.get(who.toUpperCase()) ?? null;
  }

  /**
   * Who the selection is wired to, and who is dammed behind it. Both are
   * pure functions of the selection and the world, so they are recomputed
   * only when one of the two moved — not on every frame.
   */
  function recomputeSelection() {
    selRevDone = selRev;
    focusNear.clear();
    damSet.clear();
    if (!selected.size) return;

    const w = world();
    for (const a of agents) {
      if (a.parentId && selected.has(a.id) !== selected.has(a.parentId)) {
        focusNear.add(selected.has(a.id) ? a.parentId : a.id);
      }
      const on = a.block?.kind === 'peer' ? resolveWaiting(a.block.waitingOn) : null;
      if (!on) continue;
      if (selected.has(a.id)) focusNear.add(on);
      if (selected.has(on)) focusNear.add(a.id);
    }
    for (const m of Object.values(w.messages ?? {})) {
      if (!m.toAgentId) continue;
      if (selected.has(m.fromAgentId)) focusNear.add(m.toAgentId);
      if (selected.has(m.toAgentId)) focusNear.add(m.fromAgentId);
    }
    for (const c of Object.values(w.collisions ?? {})) {
      if (c.acknowledged || !c.agentIds.some((id) => selected.has(id))) continue;
      for (const id of c.agentIds) focusNear.add(id);
    }
    // A squadron is a relationship the operator is watching, so focusing one
    // of its members holds up the whole block — and the outline with it.
    for (const id of selected) {
      const one = byId.get(id);
      const sq = one ? squadOf(one) : null;
      if (!sq) continue;
      for (const m of squadByName.get(sq)?.memberIds ?? []) focusNear.add(m);
    }
    for (const id of selected) focusNear.delete(id);

    // `dammedBehind` reads the live store, which a replayed world is not.
    if (replay) return;
    for (const id of selected) for (const behind of store.dammedBehind(id)) damSet.add(behind);
  }

  /**
   * `routeMessage` aims at a tile and stops at its edge; YOU is a bare point.
   * Two more orthogonal legs put the pipe on the node, which is the whole
   * picture: every ask in the region ends on the same square.
   */
  function landOn(pts: Pt[], to: Pt): Pt[] {
    const last = pts[pts.length - 1]!;
    if (Math.abs(last.y - to.y) > 0.01) pts.push({ x: last.x, y: to.y });
    if (Math.abs(last.x - to.x) > 0.01) pts.push({ x: to.x, y: to.y });
    return pts;
  }

  /**
   * One lineage-shaped tie: bus, core and the two ports (§4.2, §4.3).
   *
   * `fromId` is who the tie hangs off — the parent, or the lead for a squad
   * member — and it is also the lane seed, so a family shares a lane in the
   * gutter. The child's port stays hollow until its core has arrived, which
   * is what makes a newborn's empty cell legible before it has a tile.
   */
  function tie(a: Agent, fromId: string, p: Spot, c: Spot, z: number, bus: number, core: number) {
    const pts = lineageRoute(p, c, fromId);
    const touch = selected.has(a.id) || selected.has(fromId);
    const hot = touch || hover === a.id || hover === fromId;
    const sel = touch ? 1 : 0;
    const len = pipes.add(pts, z, C_LINE, 'lineage', 0, bus, sel);

    const gone = a.state === 'done' || a.state === 'dead';
    const fill = gone ? 0 : anim.get(`core:${a.id}`, 1);
    if (fill > 0) {
      pipes.add(pts, z + 0.002, hot || a.state === 'working' ? C_LIME : C_LIME_55, 'core', fill * len, core, sel);
    }
    const head = pts[0]!, tail = pts[pts.length - 1]!;
    const landed = fill >= 1;
    pipes.port(head.x, head.y, z + 0.003, C_INK, 1, sel);
    pipes.port(tail.x, tail.y, z + 0.003, landed ? C_INK : C_INK_DIM, 1, sel, !landed);
  }

  function buildPipes(now: number) {
    pipes.begin();
    const w = world();
    // Region outlines: the comp's thin panel border.
    for (const r of layout.regions) {
      const x0 = r.cx - r.hw, x1 = r.cx + r.hw, y0 = r.cy - r.hh, y1 = r.cy + r.hh;
      pipes.add([{ x: x0, y: y1 }, { x: x1, y: y1 }, { x: x1, y: y0 }, { x: x0, y: y0 }, { x: x0, y: y1 }], -0.4, C_RGN, 'lineage', 0, 0.4);
    }
    /*
     * Squad outlines: a tile made of tiles (§3.1). Same silhouette, same step
     * out of the top-right corner, one step brighter than a region because a
     * squadron is a tighter fact than a project. When a squad first appears
     * the outline is *traced* — a core whose filled length runs from the
     * lead's corner clockwise round the whole polyline in `T.move`. No fade:
     * the console does not fade, it draws.
     */
    for (const [k, q] of squadBlocks) {
      const pts = squadPaths.get(k);
      if (!pts) continue;
      const lit = clock < (squadLit.get(k) ?? -1);
      const len = pipes.add(pts, SQ_Z, C_SQUAD, 'lineage', 0, 0.4);
      const t = anim.get(`sq:${k}`, 1);
      if (t < 1) pipes.add(pts, SQ_Z + 0.002, C_LIME, 'core', t * len, 0.4);
      // The port on the top edge: where a `toSquad` message lands and where
      // the fan leaves from. Ink while one is in the air, `--ink-dim` after.
      const port = squadPortAt(q);
      pipes.port(port.x, port.y, SQ_Z + 0.004, lit ? C_INK : C_INK_DIM, 1.3, 0);
    }
    /*
     * Lineage, the comp's way: a grey **bus** that says the child exists, and
     * a lime **core** inside it that says the child is working. The bus never
     * changes — the relationship is a fact. The core grows out of the parent
     * at birth, drains back at death, and is simply absent once the child is
     * done: lime is activity, not wiring.
     */
    for (const a of agents) {
      if (!a.parentId) continue;
      const p = layout.spots.get(a.parentId), c = layout.spots.get(a.id);
      if (!p || !c) continue;
      tie(a, a.parentId, p, c, Math.min(p.z, c.z) - 0.03, 1.0, 0.42);
    }
    /*
     * Squad ties. Lineage already draws the lead→child pipes; a member the
     * lead did not spawn gets the same pipe, thinner, because it is the same
     * kind of tie and a second palette for it would be a second meaning
     * nobody asked for.
     */
    for (const a of agents) {
      const sq = squadOf(a);
      if (!sq || isLead(a)) continue;
      const leadId = squadLead.get(sq);
      if (!leadId || leadId === a.id || a.parentId === leadId) continue;
      const p = layout.spots.get(leadId), c = layout.spots.get(a.id);
      if (!p || !c) continue;
      tie(a, leadId, p, c, Math.min(p.z, c.z) - 0.035, 0.8, 0.35);
    }
    // Traffic: unanswered asks always, everything else while it is fresh.
    // Pairs drawn here are pairs the wait below must not draw twice.
    const drawn = new Set<string>();
    for (const m of Object.values(w.messages ?? {})) {
      // An answered ask is not traffic any more; it is the retraction below.
      if (answered.has(m.id)) continue;
      const open = m.kind === 'ask' && !m.answer;
      const age = (now - m.at) / 1000;
      if (!open && now - m.at > NOTICE_TTL) continue;
      const path = pathFor(m);
      if (!path) continue;
      if (m.toAgentId) drawn.add(`${m.fromAgentId}>${m.toAgentId}`);
      const hot = selected.has(m.fromAgentId) || (m.toAgentId ? selected.has(m.toAgentId) : false);
      pipes.add(path.pts, path.z, hot ? C_LIME : path.color, open ? 'ask' : hot ? 'hot' : 'notice', age, 1, hot ? 1 : 0);
    }
    /*
     * An answer arriving (§5.3): one frame of full lime down the whole pipe,
     * then the amber core retracting into whoever answered. The path is
     * reversed so the fill that survives longest is the end that answered —
     * the pipe disappears *into* them. Never a fade.
     */
    for (const [id, e] of answered) {
      const path = pathFor(e.m);
      if (!path) continue;
      if (!e.flashed) {
        e.flashed = true;
        pipes.add(path.pts, path.z, C_LIME, 'hot', 0, 1, 1);
        continue;
      }
      const back = path.pts.slice().reverse();
      const v = anim.get(`ans:${id}`, 0);
      if (v > 0) pipes.add(back, path.z, C_AMBER, 'core', v * pathLength(back), 1, 1);
    }
    // Collisions: two agents on one file.
    for (const c of Object.values(w.collisions ?? {})) {
      if (c.acknowledged) continue;
      const touch = c.agentIds.some((id) => selected.has(id)) ? 1 : 0;
      for (let i = 0; i < c.agentIds.length; i++) for (let j = i + 1; j < c.agentIds.length; j++) {
        const a = layout.spots.get(c.agentIds[i]!), b = layout.spots.get(c.agentIds[j]!);
        if (a && b) pipes.add(routeMessage(a, b), Math.max(a.z, b.z) + 0.01, C_RED, 'collision', 0, 1, touch);
      }
    }

    /*
     * Every wait, drawn to whoever owes the answer.
     *
     * A block that terminates at a person runs to its region's YOU node, so
     * the inverted V of pipes converging there *is* "this answer unblocks n".
     * A block that terminates at another agent runs to that agent and stays
     * blue: amber is reserved for waits a human has to clear, and a pipe that
     * lies about that is worse than no pipe. When the selected agent is the
     * terminus of a chain, its tributaries go solid instead of dashed.
     */
    for (const key of youEls.keys()) {
      const you = youOf(key);
      if (!you) continue;
      // YOU stays lit under focus when the selection is one of the asks it holds.
      let mine = 0;
      for (const id of selected) {
        if (!pendingAgents.has(id)) continue;
        if (key === DECK_YOU || byId.get(id)?.projectId === key) { mine = 1; break; }
      }
      pipes.port(you.x, you.y, 0.03, C_AMBER, 1.7, mine);
    }
    for (const a of agents) {
      if (a.state !== 'blocked' || !a.block) continue;
      const s = layout.spots.get(a.id);
      if (!s) continue;
      const kind = damSet.has(a.id) ? 'hot' : 'ask';
      if (a.block.kind === 'peer') {
        const other = resolveWaiting(a.block.waitingOn);
        if (!other || other === a.id || drawn.has(`${a.id}>${other}`)) continue;
        drawn.add(`${a.id}>${other}`);
        const b = layout.spots.get(other);
        if (!b) continue;
        const touch = selected.has(a.id) || selected.has(other);
        pipes.add(messageRoute(s, b, a.id), Math.min(s.z, b.z) - 0.02, touch ? C_LIME : C_BLUE, kind, 0, 1, touch ? 1 : 0);
      } else if (pendingAgents.has(a.id)) {
        const you = youOf(lmode.kind === 'deck' ? DECK_YOU : a.projectId);
        if (!you || drawn.has(`${a.id}>you`)) continue;
        drawn.add(`${a.id}>you`);
        pipes.add(landOn(messageRoute(s, you, a.id), you), Math.min(s.z, 0.05) - 0.02, C_AMBER, kind, 0, 1, selected.has(a.id) ? 1 : 0);
      }
    }
    pipes.end(clock, camera.pxPerUnit(0));
  }

  /* ── Picking ────────────────────────────────────────────────────── */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function pickAt(sx: number, sy: number): { kind: 'agent' | 'media' | 'squad'; id: string } | null {
    const r = canvas.getBoundingClientRect();
    ndc.set(((sx - r.left) / r.width) * 2 - 1, -((sy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera.three);
    const o = ray.ray.origin, d = ray.ray.direction;
    if (Math.abs(d.z) < 1e-6) return null;
    let best: string | null = null;
    let bestZ = -Infinity;
    for (const s of layout.spots.values()) {
      const t = (s.z - o.z) / d.z;
      const x = o.x + d.x * t, y = o.y + d.y * t;
      if (Math.abs(x - s.x) > TILE_W / 2 || Math.abs(y - s.y) > TILE_H / 2) continue;
      if (s.z > bestZ) { bestZ = s.z; best = s.id; }
    }
    if (best) return { kind: 'agent', id: best };
    for (const m of media.rects()) {
      const t = (m.z - o.z) / d.z;
      const x = o.x + d.x * t, y = o.y + d.y * t;
      if (Math.abs(x - m.x) <= m.w / 2 && Math.abs(y - m.y) <= m.h / 2) return { kind: 'media', id: m.id };
    }
    // The gutters inside a squad's outline belong to the squad: a grab there
    // moves the block, the way a grab on the rótulo does.
    {
      const t = (0 - o.z) / d.z;
      const x = o.x + d.x * t, y = o.y + d.y * t;
      for (const [k, q] of squadBlocks) {
        if (Math.abs(x - q.cx) <= q.hw && Math.abs(y - q.cy) <= q.hh) return { kind: 'squad', id: k };
      }
    }
    return null;
  }

  function toCanvas(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /* ── Gestures ───────────────────────────────────────────────────── */
  type Mode = 'none' | 'pan' | 'agent' | 'media' | 'squad' | 'region' | 'lasso';
  let mode: Mode = 'none';
  /**
   * The root captures the pointer on every press, so a press-and-release on a
   * region label delivers its `click` to the root, not to the label. The
   * field therefore answers the label itself on release, and this flag makes
   * the label's own click listener stand down if a browser fires it anyway.
   */
  let swallowClick = false;
  /** Whether the press that started a region gesture landed on the label's ▸. */
  let downOnOpen = false;
  let dragId: string | null = null;
  let dragMoved = false;
  let lastX = 0, lastY = 0, downX = 0, downY = 0, downAt = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  /** Everything that moves with the dragged tile. */
  let dragSet: string[] = [];

  /**
   * Gestures live on the field root, not the canvas: a region label or a
   * placed surface sits over the canvas, and a wheel or a drag that starts on
   * one must still move the field. Only a surface's own content keeps them.
   */
  const keeps = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('.srf iframe, .srf pre, .srf__x');
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || keeps(e.target)) return;
    root.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      pinchDist = Math.hypot(p!.x - q!.x, p!.y - q!.y);
      mode = 'none';
      return;
    }
    lastX = downX = e.clientX; lastY = downY = e.clientY; downAt = performance.now();
    dragMoved = false;
    swallowClick = false;
    const target = e.target as HTMLElement | null;
    const rgn = target?.closest?.<HTMLElement>('.rgn')?.dataset.project ?? null;
    if (rgn && regionById.has(rgn)) {
      // The label is the region's handle: a drag here moves the project —
      // outline, tiles, squads and all. A click is still a click (frame).
      mode = 'region';
      dragId = rgn;
      downOnOpen = !!target?.closest?.('.rgn__open');
      dragSet = [];
      for (const sp of layout.spots.values()) if (sp.projectId === rgn) dragSet.push(sp.id);
      return;
    }
    const rotulo = target?.closest?.<HTMLElement>('.squad')?.dataset.key ?? null;
    const hit = rotulo && squadBlocks.has(rotulo) ? { kind: 'squad' as const, id: rotulo } : pickAt(e.clientX, e.clientY);
    if (hit?.kind === 'agent') {
      mode = 'agent';
      dragId = hit.id;
      dragSet = selected.has(hit.id) ? [...selected] : [hit.id];
    } else if (hit?.kind === 'media') {
      mode = 'media';
      dragId = hit.id;
    } else if (hit?.kind === 'squad') {
      // The whole block moves as one: outline, rótulo and every member,
      // pinned or not — a hand on the squad is a hand on all of it.
      mode = 'squad';
      dragId = hit.id;
      dragSet = membersOf(squadBlocks.get(hit.id)!);
    } else if (e.shiftKey) {
      mode = 'lasso';
      lassoEl.classList.add('is-on');
      drawLasso(e.clientX, e.clientY);
    } else {
      mode = 'pan';
      canvas.classList.add('is-grab');
    }
  });

  root.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      const d = Math.hypot(p!.x - q!.x, p!.y - q!.y);
      if (pinchDist > 0) {
        const c = toCanvas({ clientX: (p!.x + q!.x) / 2, clientY: (p!.y + q!.y) / 2 });
        camera.zoomAt(c.x, c.y, pinchDist / d);
      }
      pinchDist = d;
      return;
    }
    if (mode === 'none') {
      const hit = pickAt(e.clientX, e.clientY);
      const id = hit ? hit.id : null;
      if (id !== hover) { hover = id; ev.onHover(id); }
      return;
    }
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) dragMoved = true;

    if (mode === 'pan') {
      userMoved = true;
      camera.panPx(dx, dy);
    } else if (mode === 'agent' && dragId) {
      // In the deck the order is the order: a tile has no place to be moved
      // to. The operator's pinned placements are untouched and come back with
      // the field.
      if (lmode.kind !== 'field') return;
      const s = layout.spots.get(dragId);
      if (!s) return;
      const per = camera.worldPerPixel(s.z);
      for (const id of dragSet) {
        const t = layout.spots.get(id);
        if (!t) continue;
        t.x += dx * per; t.y -= dy * per; t.tx = t.x; t.ty = t.y; t.pinned = true;
        // Live, like a squad's: a feed mid-drag must not ease the tile back.
        store.world.placements[id] = { agentId: id, x: t.x, y: t.y, z: t.z, pinned: true, at: Date.now() };
      }
    } else if (mode === 'media' && dragId) {
      const m = media.rects().find((r) => r.id === dragId);
      if (!m) return;
      const per = camera.worldPerPixel(m.z);
      media.nudge(dragId, m.x + dx * per, m.y - dy * per);
    } else if (mode === 'squad' && dragId) {
      if (lmode.kind !== 'field') return;
      const q = squadBlocks.get(dragId);
      if (!q) return;
      const per = camera.worldPerPixel(0);
      q.cx += dx * per; q.cy -= dy * per;
      q.moved = true;
      squadPaths.set(dragId, squadOutline(q));
      // The placement is live from the first pixel: a feed that lands
      // mid-drag re-lays the fleet, and without it the block would snap back
      // to its cells under the hand. Only the save waits for the release.
      squadPlaced.set(dragId, { projectId: q.projectId, name: q.name, x: q.cx, y: q.cy, at: Date.now() });
      for (const id of dragSet) {
        const t = layout.spots.get(id);
        if (!t) continue;
        t.x += dx * per; t.y -= dy * per; t.tx = t.x; t.ty = t.y;
        if (t.pinned) store.world.placements[id] = { agentId: id, x: t.x, y: t.y, z: t.z, pinned: true, at: Date.now() };
      }
    } else if (mode === 'region' && dragId) {
      if (lmode.kind !== 'field') return;
      const r = regionById.get(dragId);
      if (!r) return;
      const per = camera.worldPerPixel(0);
      const wx = dx * per, wy = -dy * per;
      r.cx += wx; r.cy += wy; r.moved = true;
      regionPlaced.set(dragId, { projectId: dragId, x: r.cx, y: r.cy, at: Date.now() });
      // Everything standing in the region goes with it, whatever placed it.
      for (const q of r.squads) {
        q.cx += wx; q.cy += wy;
        const k = squadKey(q.projectId, q.name);
        squadPaths.set(k, squadOutline(q));
        if (squadPlaced.has(k)) squadPlaced.set(k, { projectId: q.projectId, name: q.name, x: q.cx, y: q.cy, at: Date.now() });
      }
      for (const id of dragSet) {
        const t = layout.spots.get(id);
        if (!t) continue;
        t.x += wx; t.y += wy; t.tx = t.x; t.ty = t.y;
        if (t.pinned) store.world.placements[id] = { agentId: id, x: t.x, y: t.y, z: t.z, pinned: true, at: Date.now() };
      }
    } else if (mode === 'lasso') {
      drawLasso(e.clientX, e.clientY);
    }
  });

  root.addEventListener('pointerup', (e) => {
    pointers.delete(e.pointerId);
    if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    canvas.classList.remove('is-grab');
    const quick = performance.now() - downAt < 400;
    const at = { sx: e.clientX, sy: e.clientY };

    if (mode === 'agent' && dragId) {
      // A drag in the deck moved nothing, so there is nothing to save.
      if (dragMoved && lmode.kind === 'field') {
        for (const id of dragSet) {
          const s = layout.spots.get(id);
          if (!s) continue;
          const p: Placement = { agentId: id, x: s.x, y: s.y, z: s.z, pinned: true, at: Date.now() };
          saveLocalPlacement(p);
          ev.onPlace(id, s.x, s.y, s.z);
        }
      } else if (!dragMoved && quick) {
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          if (selected.has(dragId)) selected.delete(dragId); else selected.add(dragId);
        } else {
          selected.clear();
          selected.add(dragId);
        }
        selRev++;
        ev.onSelect([...selected], at);
      }
    } else if (mode === 'media' && dragId) {
      const m = media.rects().find((r) => r.id === dragId);
      if (dragMoved && m) ev.onPlaceArtifact(dragId, m.x, m.y, m.z);
      else if (quick) ev.onOpenArtifact(dragId, e.clientX, e.clientY);
    } else if (mode === 'squad' && dragId) {
      const q = squadBlocks.get(dragId);
      if (dragMoved && q && lmode.kind === 'field') {
        squadPlaced.set(dragId, { projectId: q.projectId, name: q.name, x: q.cx, y: q.cy, at: Date.now() });
        saveSquadPlacements();
        // A member the operator had pinned keeps its own placement, moved by
        // the same hand; everyone else follows the block from the layout.
        for (const id of dragSet) {
          const s = layout.spots.get(id);
          if (!s?.pinned) continue;
          const p: Placement = { agentId: id, x: s.x, y: s.y, z: s.z, pinned: true, at: Date.now() };
          saveLocalPlacement(p);
          ev.onPlace(id, s.x, s.y, s.z);
        }
        getSound()?.play('placed');
        dirty = true;
      } else if (!dragMoved && quick && q) {
        // A click on the block is a click on the squad: every member, as a lasso would.
        selected.clear();
        for (const id of membersOf(q)) { selected.add(id); if (!reduce) flashAt.set(id, clock); }
        selRev++;
        ev.onSelect([...selected], at);
      }
    } else if (mode === 'region' && dragId) {
      const r = regionById.get(dragId);
      if (dragMoved && r && lmode.kind === 'field') {
        swallowClick = true;
        saveRegionPlacements();
        saveSquadPlacements();
        for (const id of dragSet) {
          const s = layout.spots.get(id);
          if (!s?.pinned) continue;
          const p: Placement = { agentId: id, x: s.x, y: s.y, z: s.z, pinned: true, at: Date.now() };
          saveLocalPlacement(p);
          ev.onPlace(id, s.x, s.y, s.z);
        }
        getSound()?.play('placed');
        dirty = true;
      } else if (!dragMoved) {
        // The label's click, answered here because the capture took it.
        swallowClick = true;
        if (downOnOpen) ev.onOpenProject(dragId, e.clientX, e.clientY);
        else frameProject(dragId);
      }
    } else if (mode === 'pan' && !dragMoved && quick) {
      if (!(e.target as HTMLElement).closest?.('.rgn') && selected.size) { selected.clear(); selRev++; ev.onSelect([], null); }
    } else if (mode === 'lasso') {
      lassoEl.classList.remove('is-on');
      const ids = agentsInLasso(downX, downY, e.clientX, e.clientY);
      if (!e.metaKey && !e.ctrlKey) selected.clear();
      // Everything the lasso caught beats once, on one clock reading (§6.4):
      // the selection is a thing that happened to those tiles, not a colour.
      for (const id of ids) { selected.add(id); if (!reduce) flashAt.set(id, clock); }
      selRev++;
      ev.onSelect([...selected], at);
    }
    mode = 'none';
    dragId = null;
    dragSet = [];
  });

  root.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); mode = 'none'; dragId = null; lassoEl.classList.remove('is-on'); });

  root.addEventListener('dblclick', (e) => {
    if (keeps(e.target) || (e.target as HTMLElement).closest?.('.rgn')) return;
    const rotulo = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.squad')?.dataset.key ?? null;
    const hit = rotulo && squadBlocks.has(rotulo) ? { kind: 'squad' as const, id: rotulo } : pickAt(e.clientX, e.clientY);
    if (hit?.kind === 'agent') ev.onOpen(hit.id, e.clientX, e.clientY);
    else if (hit?.kind === 'media') ev.onOpenArtifact(hit.id, e.clientX, e.clientY);
    else if (hit?.kind === 'squad') { const q = squadBlocks.get(hit.id); if (q) ev.onOpenSquad(q.name, q.projectId, e.clientX, e.clientY); }
  });

  /*
   * Right click names what is under the pointer and hands it to the console.
   * An agent outside the selection becomes the selection first — without the
   * `at`, so nothing opens — and one inside it asks on behalf of all of them.
   * A surface's own content keeps the browser's menu.
   */
  root.addEventListener('contextmenu', (e) => {
    if (keeps(e.target)) return;
    e.preventDefault();
    if (mode !== 'none') return;
    const t = e.target as HTMLElement | null;
    const rgn = t?.closest?.<HTMLElement>('.rgn')?.dataset.project;
    if (rgn) { ev.onContext({ kind: 'project', id: rgn, moved: regionById.get(rgn)?.moved ?? false }, e.clientX, e.clientY); return; }
    const rotulo = t?.closest?.<HTMLElement>('.squad')?.dataset.key ?? null;
    const hit = rotulo && squadBlocks.has(rotulo) ? { kind: 'squad' as const, id: rotulo } : pickAt(e.clientX, e.clientY);
    if (hit?.kind === 'agent') {
      if (!selected.has(hit.id)) { selected.clear(); selected.add(hit.id); selRev++; ev.onSelect([hit.id], null); }
      ev.onContext({ kind: 'agent', id: hit.id, selection: [...selected] }, e.clientX, e.clientY);
    } else if (hit?.kind === 'media') {
      ev.onContext({ kind: 'artifact', id: hit.id }, e.clientX, e.clientY);
    } else if (hit?.kind === 'squad') {
      const q = squadBlocks.get(hit.id)!;
      ev.onContext({ kind: 'squad', name: q.name, projectId: q.projectId, moved: q.moved }, e.clientX, e.clientY);
    } else {
      ev.onContext({ kind: 'field' }, e.clientX, e.clientY);
    }
  });

  root.addEventListener('wheel', (e) => {
    if (keeps(e.target)) return;
    e.preventDefault();
    const c = toCanvas(e);
    /*
     * Scrolling moves you across the field; it never zooms. Zoom is a
     * deliberate gesture: ⌘/Ctrl + scroll, or a pinch, which the browser
     * reports as a wheel with ctrlKey set. A mouse wheel therefore pans too,
     * so the field behaves like one surface under every input device.
     */
    userMoved = true;
    if (e.ctrlKey || e.metaKey) {
      const k = e.deltaMode === 0 ? 0.012 : 0.05;
      camera.zoomAt(c.x, c.y, Math.exp(e.deltaY * k));
      return;
    }
    const step = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 120 : 1;
    camera.panPx(-e.deltaX * step, -e.deltaY * step);
  }, { passive: false });

  function drawLasso(x2: number, y2: number) {
    const r = canvas.getBoundingClientRect();
    const x = Math.min(downX, x2) - r.left, y = Math.min(downY, y2) - r.top;
    lassoEl.style.left = `${x}px`; lassoEl.style.top = `${y}px`;
    lassoEl.style.width = `${Math.abs(x2 - downX)}px`; lassoEl.style.height = `${Math.abs(y2 - downY)}px`;
  }
  function agentsInLasso(x1: number, y1: number, x2: number, y2: number): string[] {
    const r = canvas.getBoundingClientRect();
    const minX = Math.min(x1, x2) - r.left, maxX = Math.max(x1, x2) - r.left;
    const minY = Math.min(y1, y2) - r.top, maxY = Math.max(y1, y2) - r.top;
    const out: string[] = [];
    for (const s of layout.spots.values()) {
      const p = camera.project(s.x, s.y, s.z);
      if (p.visible && p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) out.push(s.id);
    }
    return out;
  }

  /* ── Frame ──────────────────────────────────────────────────────── */
  let raf = 0;
  let last = performance.now();
  let fps = 60;
  let drawn = 0;
  const labelItems: LabelItem[] = [];

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    renderer.setSize(r.width, r.height, false);
    camera.resize(r.width, r.height);
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    fps = fps * 0.92 + (1 / Math.max(dt, 0.001)) * 0.08;
    if (dirty) feedNow();

    camera.step(dt);
    const wallNow = Date.now();

    // Focus, eased both ways over FOCUS_T. Losing the selection loses focus:
    // there is nothing left to hold at arm's length.
    if (focusOn && !selected.size) { focusOn = false; labels.setFocus(false); }
    const fTarget = focusOn ? 1 : 0;
    if (focusV !== fTarget) {
      const stepF = reduce ? 1 : dt / FOCUS_T;
      focusV = fTarget > focusV ? Math.min(fTarget, focusV + stepF) : Math.max(fTarget, focusV - stepF);
    }
    // The dammed chain is drawn whether or not focus is on, so this cannot
    // hang off focusV. It is gated on the selection and the world instead.
    if (selRevDone !== selRev) recomputeSelection();
    swarm.setFocus(focusV);
    pipes.setFocus(focusV);

    // Ease every spot toward its target.
    const k = reduce ? 1 : 1 - Math.pow(0.004, dt);
    for (const s of layout.spots.values()) {
      const hold = holdUntil.get(s.id);
      if (hold !== undefined) {
        if (clock < hold) continue;
        holdUntil.delete(s.id);
        getSound()?.play('deck.tick');
        if (holdUntil.size === 0) getSound()?.play('deck.settle');
      }
      s.x += (s.tx - s.x) * k; s.y += (s.ty - s.y) * k; s.z += (s.tz - s.z) * k;
    }

    // Cull to the view. When tilted the frustum is a trapezoid; be generous.
    const r = canvas.getBoundingClientRect();
    const per = camera.worldPerPixel(0);
    const margin = camera.tilted() ? 3.2 : 1.3;
    const halfW = (r.width / 2) * per * margin + TILE_W;
    const halfH = (r.height / 2) * per * margin + TILE_H;
    const cx = camera.cam.x, cy = camera.cam.y;
    const ppu = 1 / per;

    swarm.ensure(agents.length);
    let slot = 0;
    labelItems.length = 0;
    for (const a of agents) {
      const s = layout.spots.get(a.id);
      if (!s) continue;
      if (Math.abs(s.x - cx) > halfW || Math.abs(s.y - cy) > halfH) continue;

      /*
       * The tile's scale is one scalar in `anim.ts`. It is 0 while the core is
       * still crossing — the cell holds nothing but a hollow port then, which
       * is exactly the comp's A8 — and 1 for every agent that was already on
       * the field when the console opened and therefore never arrived in front
       * of anyone. `die:` rides on top as the sink's bump.
       */
      let scale = anim.get(`tile:${a.id}`, 1), alpha = 1;
      const dying = anim.get(`die:${a.id}`, 1);
      if (dying < 1) scale *= 1 + Math.sin(dying * Math.PI) * 0.18;
      const peer = a.state === 'blocked' && a.block?.kind === 'peer';
      const color = peer ? STATE_RGB.thinking : STATE_RGB[a.state];
      /*
       * The amber discipline. Full amber — inverted body, glow, breathing —
       * is reserved for a block you can clear from here: one with an
       * escalation still pending. A permission prompt or an error waiting in
       * somebody else's terminal is real, but shouting about it teaches the
       * operator that amber sometimes means nothing.
       */
      const alert = !peer && a.state === 'blocked' ? (pendingAgents.has(a.id) ? 1 : 0.5) : 0;
      const speed = a.state === 'working' ? Math.min(1, a.metrics.tokensPerSec / 80) + 0.05 : a.state === 'thinking' ? 0.08 : 0;
      alpha = a.state === 'done' ? 0.35 : a.state === 'dead' ? 0.55 : a.state === 'idle' ? 0.8 : 1;
      const isSel = selected.has(a.id);
      const sel = isSel ? 2 : hover === a.id ? 1 : 0;
      const near = focusNear.has(a.id);
      const focusA = isSel ? FOCUS_A.sel : near ? FOCUS_A.near : FOCUS_A.far;
      swarm.write(
        slot, s.x, s.y, s.z, Math.max(0.001, scale), color, alert, speed, sel, alpha, hash(a.id),
        flashAt.get(a.id) ?? -9e3, focusA, isLead(a) ? 1 : 0, sigilOf(a), runtimeOf(a),
      );
      slot++;

      /*
       * Label if the tile is readable. The label is the tile's whole interior
       * now, so its box has to be the tile's box: both corners are projected
       * rather than one corner plus `pxPerUnit`, because under tilt the plane
       * is foreshortened and a height taken from the scale alone would run the
       * metrics row a hundred pixels below the tile it belongs to.
       */
      const wpx = TILE_W * camera.pxPerUnit(s.z) * scale;
      if (wpx >= LABEL_PX) {
        const p = camera.project(s.x - TILE_W / 2 * scale, s.y + TILE_H / 2 * scale, s.z);
        const q = camera.project(s.x + TILE_W / 2 * scale, s.y - TILE_H / 2 * scale, s.z);
        const bw = q.x - p.x, bh = q.y - p.y;
        if (p.visible && bw >= LABEL_PX && bh > 2) {
          labelItems.push({ agent: a, sx: p.x, sy: p.y, w: bw, h: bh, sel: isSel || near, selected: isSel, amber: alert >= 0.75 });
        }
      }
    }
    swarm.commit(slot, clock, ppu);
    drawn = slot;
    labels.update(labelItems);

    buildPipes(wallNow);
    pipes.step(dt);
    ground.update(cx, cy, camera.pxPerUnit(GROUND_Z), renderer.domElement.width, renderer.domElement.height);
    media.reproject();
    placeRegions();
    renderer.render(scene, camera.three);
  }

  const ro = new ResizeObserver(() => { if (active) resize(); });
  ro.observe(canvas);

  /* ── Artifacts dropped onto the field ───────────────────────────── */

  function dropArtifactAt(artifactId: string, sx: number, sy: number) {
    const c = toCanvas({ clientX: sx, clientY: sy });
    // Artifacts float just off the plane, clear of the tiles and the pipes.
    const p = camera.screenToWorld(c.x, c.y, ART_Z);
    ev.onPlaceArtifact(artifactId, p.x, p.y, ART_Z);
  }

  // A drag out of the gallery must be droppable anywhere on the stage, and
  // the browser only offers the drop if the dragover is claimed.
  root.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes(ART_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  root.addEventListener('drop', (e) => {
    const id = e.dataTransfer?.getData(ART_MIME);
    if (!id) return;
    e.preventDefault();
    dropArtifactAt(id, e.clientX, e.clientY);
  });

  /**
   * Hold every tile back by a different sliver of a second, so a relayout
   * arrives the way the comp's deck lights: in groups of 4-2-3-5-2-6, several
   * tiles on each strike, never a wave and never all at once. `beats()` owns
   * the rhythm; this only compresses it to `RELAYOUT_SPREAD` and hangs it on
   * the layout's own order, which in the deck is the sort the operator asked
   * for — so the deck fills the way it is read.
   */
  function stagger() {
    holdUntil.clear();
    if (reduce) return;
    const ids = [...layout.spots.keys()];
    const offs = beats(ids.length);
    const span = offs[offs.length - 1] ?? 0;
    if (span <= 0) return;
    const k = RELAYOUT_SPREAD / span;
    for (let i = 0; i < ids.length; i++) holdUntil.set(ids[i]!, clock + offs[i]! * k);
  }

  function setLayoutMode(mode: LayoutMode) {
    if (mode.kind === lmode.kind && (mode.kind !== 'deck' || lmode.kind !== 'deck' || mode.sort === lmode.sort)) return;
    lmode = mode;
    // A grid read at an angle is not a grid. The deck is always flat.
    if (mode.kind === 'deck') camera.setTilt(false);
    feedNow();
    stagger();
    // Changing mode is the console framing itself, not a hand on the camera.
    userMoved = false;
    lastFramedCount = agents.length;
    camera.frame(layout.bounds);
  }

  function frameProject(projectId: string) {
    const rg = layout.regions.find((x) => x.id === projectId);
    if (!rg) return;
    userMoved = true;
    camera.frame({ minX: rg.cx - rg.hw, maxX: rg.cx + rg.hw, minY: rg.cy - rg.hh, maxY: rg.cy + rg.hh }, 1.3);
  }

  /* ── Public ─────────────────────────────────────────────────────── */
  const handle: FieldHandle = {
    setActive(on) {
      if (on === active) return;
      active = on;
      if (on) { resize(); last = performance.now(); raf = requestAnimationFrame(frame); }
      else { cancelAnimationFrame(raf); raf = 0; }
    },
    feed() { dirty = true; },
    flyTo(id, distance = 4.2) {
      const s = layout.spots.get(id);
      if (s) { userMoved = true; camera.flyTo(s.x, s.y, distance); }
    },
    flyToPoint(x, y, distance = 6) { userMoved = true; camera.flyTo(x, y, distance); },
    frameAll() { if (dirty) feedNow(); userMoved = false; lastFramedCount = agents.length; camera.frame(layout.bounds); },
    frameProject,
    setTilt(on) { camera.setTilt(on); },
    setGroundLevel(v) { ground.setLevel(v); },
    setGroundColor(on) { ground.setColor(on); },
    tilted: () => camera.tilted(),
    setLayoutMode,
    layoutMode: () => lmode,
    select(ids) { selected.clear(); for (const id of ids) selected.add(id); selRev++; },
    selection: () => [...selected],
    screenOf(id) {
      const s = layout.spots.get(id);
      if (!s) return null;
      const a = camera.project(s.x - TILE_W / 2, s.y + TILE_H / 2, s.z);
      const b = camera.project(s.x + TILE_W / 2, s.y - TILE_H / 2, s.z);
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, visible: a.visible || b.visible };
    },
    screenToWorld(sx, sy) { const c = toCanvas({ clientX: sx, clientY: sy }); return camera.screenToWorld(c.x, c.y); },
    spotOf: (id) => layout.spots.get(id),
    frameSquad(name, projectId) {
      const hit = blockOf(name, projectId);
      if (!hit) return false;
      const { q } = hit;
      userMoved = true;
      camera.frame({ minX: q.cx - q.hw, maxX: q.cx + q.hw, minY: q.cy - q.hh, maxY: q.cy + q.hh }, 1.6);
      return true;
    },
    squadMoved: (name, projectId) => blockOf(name, projectId)?.q.moved ?? false,
    unplace(agentId) {
      unplaceLocal(agentId);
      dirty = true;
    },
    resetSquad(name, projectId) {
      const hit = blockOf(name, projectId);
      if (!hit || !squadPlaced.delete(hit.key)) return;
      saveSquadPlacements();
      dirty = true;
    },
    regionMoved: (projectId) => regionPlaced.has(projectId),
    resetRegion(projectId) {
      if (!regionPlaced.delete(projectId)) return;
      saveRegionPlacements();
      dirty = true;
    },
    arranged() {
      if (squadPlaced.size || regionPlaced.size) return true;
      for (const p of Object.values(store.world.placements)) if (p.pinned) return true;
      return false;
    },
    resetArrangement() {
      for (const id of Object.keys(store.world.placements)) delete store.world.placements[id];
      try { localStorage.removeItem(PLACEMENT_KEY); } catch { /* fine */ }
      squadPlaced.clear();
      saveSquadPlacements();
      regionPlaced.clear();
      saveRegionPlacements();
      dirty = true;
    },
    placeNear(agentId, index) {
      const s = layout.spots.get(agentId);
      if (!s) return { x: camera.cam.x, y: camera.cam.y, z: 0.1 };
      return { x: s.x + TILE_W * 0.5 + 1.5 + (index % 3) * 2.7, y: s.y + TILE_H * 0.4 - Math.floor(index / 3) * 2.0, z: s.z + 0.05 };
    },
    stats: () => ({ agents: agents.length, drawn, segments: pipes.segments(), fps: Math.round(fps) }),
    layout: () => layout,
    frameAround(id) {
      const s = layout.spots.get(id);
      if (!s) return false;
      const v = this.viewRect();
      userMoved = true;
      camera.frame({
        minX: Math.min(v.minX, s.x - TILE_W), maxX: Math.max(v.maxX, s.x + TILE_W),
        minY: Math.min(v.minY, s.y - TILE_H), maxY: Math.max(v.maxY, s.y + TILE_H),
      }, 1.15);
      return true;
    },
    viewRect() {
      const w = camera.width, h = camera.height;
      const pts = [camera.screenToWorld(0, 0), camera.screenToWorld(w, 0), camera.screenToWorld(0, h), camera.screenToWorld(w, h)];
      return {
        minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
        minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
      };
    },
    setFocus(on) {
      // Nothing selected is nothing to focus; the key falls through to the hint.
      if (on && selected.size === 0) return false;
      if (on !== focusOn) {
        focusOn = on;
        labels.setFocus(on);
        if (on) recomputeSelection();
      }
      return true;
    },
    setReplay(w) {
      if (replay === w) return;
      replay = w;
      // A different world is not an event in this one: no spawns, no deaths,
      // no message pulses, no beat.
      swapped = true;
      // A different world is not a continuation of this one's motion: every
      // scalar goes, and the fallbacks put the fleet in its finished state.
      anim.sweep(() => false);
      answered.clear();
      openAsks.clear();
      seenSquads.clear();
      squadLit.clear();
      flashAt.clear();
      dirty = true;
      feedNow();
    },
    dropArtifactAt,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      for (const t of squadBeat.values()) clearTimeout(t);
      squadBeat.clear();
      anim.sweep(() => false);
      swarm.dispose(); pipes.dispose(); ground.dispose(); labels.dispose(); media.dispose();
      renderer.dispose();
    },
  };
  return handle;
}

/** One line of somebody else's prose, cut to fit a rótulo. */
function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}\u2026`;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}
