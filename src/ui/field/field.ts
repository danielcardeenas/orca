import { groupOrigin } from '../../shared/origin.ts';
import { gesture } from '../gestures.ts';
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
import { HARNESS_LABEL, harnessHome, harnessIsland } from '../../shared/synthetic.ts';
import { OFF_FLEET_LABEL, islandOf } from '../../shared/workspaces.ts';
import { store } from '../store.ts';
import { forgeViews } from './forge.ts';
import { reviewerIds } from '../../shared/improve.ts';
import { esc, STATE_HEX, STATE_VAR } from '../util.ts';
import { CAPCOM_BITS, sigilBits, sigilHTML } from '../gfx/sigil.ts';
import { FieldCamera } from './camera.ts';
import type { Rect as PxRect } from './framing.ts';
import { createGround, GROUND_Z } from './ground.ts';
import { createLabels, rememberMachine, rememberProjectCode, rememberProjectName, type LabelItem } from './labels.ts';
import { createMedia } from './media.ts';
import { badgeVisible, shelfBadge, shelfChips, shelfIds, shelfVisible } from './shelf.ts';
import { chipStem, originPortScale, tetherHot, tetherRoute, tetherWeight, type Rect, type Tether } from './tether.ts';
import { createShelves, type ShelfItem } from './shelves.ts';
import { createPipes, laneShift, pathLength, routeGutter, routeGutterMsg, routeLineage, routeMessage, spanOf, type Pt } from './pipes.ts';
import { absorbedChildren } from './blocks.ts';
import { createSwarm } from './swarm.ts';
import { commandLinked, commandState, createCommandHalo, REST as COMMAND_REST, RING_OFF, sameState, type CommandFlags, type CommandState } from './command.ts';
import { getPref } from '../prefs.ts';
import { beats, dur, EASE, REDUCE, T } from '../motion.ts';
import * as anim from './anim.ts';
import { getSound } from '../hud/sound.ts';
import { longPress } from '../hud/longpress.ts';
import { emptyLayout, isLead, islandIn, layoutFleet, squadKey, squadOf, TILE_H, TILE_W, type Layout, type LayoutMode, type Region, type RegionPlacement, type SquadBlock, type SquadPlacement, type Spot, BLOCK_PAD, CAPCOM_SCALE } from './layout.ts';

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
  /**
   * El índice de un agente: lo que el contador de su estantería abre. El lienzo
   * dice «hizo cuarenta» con cinco fichas, y la puerta a las cuarenta es esto.
   */
  onOpenGallery(agentId: string): void;
  /** Right click: the field names what is under the pointer and where. */
  onContext(target: FieldTarget, sx: number, sy: number): void;
  onPlace(agentId: string, x: number, y: number, z: number): void;
  /** `w`: the width the operator dragged the surface to, when it was a resize and not a move. */
  onPlaceArtifact(artifactId: string, x: number, y: number, z: number, w?: number): void;
  onUnplaceArtifact(artifactId: string): void;
  onHover(id: string | null): void;
  /**
   * Files from the operator's desktop, dropped on the stage: on a tile, with
   * that agent's id; anywhere else, with null. `at` is the point on the
   * media plane, so an image can be placed exactly where it was let go. The
   * field names the target and where; what to do with the bytes is the
   * console's (main.ts).
   */
  onDropFiles?(files: File[], agentId: string | null, sx: number, sy: number, at: { x: number; y: number; z: number }): void;
}

/** `visible`: on screen or near it. `ahead`: in front of the camera, so the rect is a real place on the glass however far off it. */
export interface ScreenRect { x: number; y: number; w: number; h: number; visible: boolean; ahead: boolean }

export interface FieldHandle {
  setActive(on: boolean): void;
  /** Pull the world from the store and re-lay it out. Coalesced per frame. */
  feed(): void;
  /**
   * Fly to a tile. It lands centred, unless a window in front (`front` or
   * `pinned`, see `setObstacles`) would cover it there: then the camera aims
   * so the tile sits in the clear. Squads, projects and the whole fleet frame
   * the same way. `flyToPoint` is the raw flight — bookmarks and the minimap
   * mean a place, not a thing to be seen.
   */
  flyTo(agentId: string, distance?: number): void;
  flyToPoint(x: number, y: number, distance?: number): void;
  /**
   * Who is standing in front of the glass, in canvas pixels, read at the
   * moment of every flight. The console answers with the window manager's
   * screen-fixed windows; a canvas window moves with the plane and no
   * flight can get out from under it.
   */
  setObstacles(fn: () => PxRect[]): void;
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
  windowOrigin(id: string): { x: number; y: number } | null;
  frameWindow(bounds: { minX: number; minY: number; maxX: number; maxY: number }): void;
  windowPlane(): { origin: { x: number; y: number }; ppu: number };
  windowProjection(x: number, y: number): { x: number; y: number };
  windowPoint(x: number, y: number): { x: number; y: number };
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
  /**
   * Where to put an artifact pulled from this agent, or null when the agent has
   * no tile on the field — archived, or on a machine that is gone. Never a made
   * up anchor: see `placeNear`.
   */
  placeNear(agentId: string, index: number): { x: number; y: number; z: number } | null;
  /**
   * Surfaces that are not the hub's: the operator's own files, placed on the
   * field (ui/placed-files.ts). Drawn with the artifacts, next feed.
   */
  setExtraMedia(list: Artifact[]): void;
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
   * Frame the smallest rectangle that holds these agents' tiles. One agent
   * is a flight to it; none on the field is false and the camera stays.
   */
  frameAgents(agentIds: string[]): boolean;
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
/**
 * The harness enclosure: a region's own line, dimmed. It is drawn TWICE —
 * one outline inside the other, `HARNESS_WALL` apart — because the field has
 * exactly one thin box per region and a second concentric line is read
 * instantly as a different kind of thing: a fence, not a plot. Colour alone
 * would only say "far away".
 */
const C_HARNESS = new THREE.Color(0x22252d).multiplyScalar(0.85);
/**
 * The gap between the enclosure's two walls: a little under a gutter. Half of
 * that read as one thick line at the zoom where the whole region fits on
 * screen, which is the zoom the fence has to work at; wider than a gutter and
 * the inner wall starts to look like a second region inside the first.
 */
const HARNESS_WALL = 0.22;
const C_AMBER = new THREE.Color(0xf5a524);
/** A command tie: CAPCOM's cyan at 60 %, so the post stays the brightest cyan thing. */
const C_CYAN_DIM = new THREE.Color(0x4fe3ff).multiplyScalar(0.6);
const C_FORGE_DIM = new THREE.Color(0xb47cff).multiplyScalar(0.6);
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

/**
 * Los agentes que cuelgan una estantería de su baldosa: los que han declarado
 * algo (`shelf.ts`). Uno solo recorrido de los artefactos por feed, en vez de
 * uno por agente.
 */
function shelvedAgents(artifacts: Record<string, Artifact> | undefined): Set<string> {
  const out = new Set<string>();
  for (const a of Object.values(artifacts ?? {})) if (a.source === 'declared') out.add(a.agentId);
  return out;
}

export function createField(root: HTMLElement, ev: FieldEvents): FieldHandle {
  root.innerHTML = `
    <canvas class="field__canvas" data-canvas></canvas>
    <div class="field__layer" data-labels></div>
    <div class="field__layer" data-shelves></div>
    <div class="field__layer" data-surfaces></div>
    <div class="field__layer" data-regions></div>
    <div class="field__layer"><div class="lasso" data-lasso></div></div>
  `;
  const canvas = root.querySelector<HTMLCanvasElement>('[data-canvas]')!;
  const labelsLayer = root.querySelector<HTMLElement>('[data-labels]')!;
  const shelvesLayer = root.querySelector<HTMLElement>('[data-shelves]')!;
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
  const halo = createCommandHalo(scene);
  const ground = createGround(scene);
  const labels = createLabels(labelsLayer);
  // Quién hizo una superficie, para su pie: el agente de este feed, o el que
  // el almacén recuerda si ya se archivó — un artefacto sobrevive a su autor.
  const media = createMedia(scene, surfacesLayer, camera, (id) => ev.onUnplaceArtifact(id),
    (id) => byId.get(id)?.callsign ?? store.knownAgent(id)?.callsign ?? null,
    (id, x, y, z, w) => ev.onPlaceArtifact(id, x, y, z, w));
  const shelves = createShelves(shelvesLayer, {
    onOpenArtifact: (id, x, y) => ev.onOpenArtifact(id, x, y),
    onOpenGallery: (agentId) => ev.onOpenGallery(agentId),
    onHoverChip: (artId, agentId) => { hoverArt = artId; hoverOrigin = artId ? null : agentId; },
  });

  const reduce = REDUCE.value;

  /* ── State ──────────────────────────────────────────────────────── */
  let layout: Layout = emptyLayout();
  let agents: Agent[] = [];
  const byId = new Map<string, Agent>();
  let projects = new Map<string, Project>();
  let artifacts: Artifact[] = [];
  /** The operator's placed files; see `setExtraMedia`. */
  let extraMedia: Artifact[] = [];
  const selected = new Set<string>();
  /** Lo que hay bajo el puntero en el lienzo: un agente, una superficie o una escuadra (`pickAt`). */
  let hover: string | null = null;
  /**
   * La ficha de estantería bajo el puntero, que es DOM y no pasa por `pickAt`:
   * su artefacto, o su agente si es el contador (`shelves.ts`). Encienden el
   * tirante de esa ficha y la baldosa de la que cuelga (`tether.ts`).
   */
  let hoverArt: string | null = null;
  let hoverOrigin: string | null = null;
  /** La superficie bajo el puntero aunque tape una baldosa (`mediaAt`), que `hover` no dice. */
  let hoverMedia: string | null = null;
  /** Los tirantes de las fichas de este fotograma, en unidades de mundo. Los consume `buildPipes`. */
  const stems: Tether[] = [];
  /**
   * Resueltos una vez por fotograma, antes del bucle de baldosas: el artefacto
   * bajo el puntero venga de donde venga —ficha o superficie—, y los orígenes
   * calientes: la baldosa o la escuadra bajo el puntero, y el agente del
   * contador bajo el puntero. `tether.ts` decide con esto qué tirante se
   * enciende, y el bucle de baldosas qué baldosa.
   */
  let hovArt: string | null = null;
  const hotOrigins = new Set<string>();
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
  /** child id → parent id for every child folded into its parent's block this feed. */
  let absorbed = new Map<string, string>();
  /** Quién cuelga una estantería de su baldosa; ver `shelvedAgents`. */
  let shelved = new Set<string>();
  /** Los artefactos por id, para las fichas de la estantería. */
  const artById = new Map<string, Artifact>();
  /** How many of those each project holds — the number on its YOU node. */
  const pendingByProject = new Map<string, number>();
  const byCallsign = new Map<string, string>();
  const regionById = new Map<string, Region>();

  /* ── The command post (command.ts) ──────────────────────────────── */
  /** CAPCOM's id this feed, or null: the one tile the halo and the links hang off. */
  let capcomId: string | null = null;
  /** The four preferences, read once a frame: four property reads off a cached object. */
  const cmdFlags: CommandFlags = { missions: true, notches: true, pulse: true, links: false };
  let cmdState: CommandState = COMMAND_REST;
  /** Clock instant of the last `commandState`. A mission cools by the clock alone, so it is redone once a second. */
  let cmdAt = -1e9;
  function readCommandFlags() {
    cmdFlags.missions = getPref('capcomMissions');
    cmdFlags.notches = getPref('capcomNotches');
    cmdFlags.pulse = getPref('capcomPulse');
    cmdFlags.links = getPref('capcomLinks');
  }
  function refreshCommand() {
    cmdAt = clock;
    const cap = capcomId ? byId.get(capcomId) ?? null : null;
    // The open mission is the live console's; a replayed world has none.
    const next = commandState(world(), cap, (id) => byId.get(id), Date.now(), replay ? null : store.activeMissionId, cmdFlags);
    if (!sameState(next, cmdState)) cmdState = next;
  }

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
  /**
   * Los agentes que han sido revisores de AUTOMEJORA, del tablero de la
   * sección. Se recalcula cuando el tablero cambia —cada varias horas— y no
   * por fotograma: `runtimeOf` lo consulta una vez por tile y por paint.
   */
  let reviewers = reviewerIds(store.improve);
  let forge = forgeViews([], {});
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

  /**
   * 0 claude · 1 codex · 2 grok · 3 anything else · 8 AUTOMEJORA reviewer · 9 CAPCOM.
   *
   * The reviewer's mark comes off the self-improvement board rather than off a
   * field on the agent: the board already travels whole, already knows which
   * review each agent ran, and keeps the last `MAX_REVIEWS` of them, so a
   * reviewer stays recognisable long after it finished. A new `role` would
   * have to be threaded through the collector, the hub and the protocol to say
   * nothing this does not already say.
   *
   * It sits at 8 and not above CAPCOM because it is not a runtime: the shader
   * reads 8 as solid, which is what a Claude session should draw anyway. What
   * marks it is the violet outline, not the stripe — its state keeps the edge.
   */
  function runtimeOf(a: Agent): number {
    if (a.role === 'capcom') return 9;
    if (forge.get(a.id)?.active) return 4 + (RUNTIME_ID[a.runtime] ?? 3);
    if (reviewers.has(a.id)) return 8;
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
  /* ── Slabs: the plate a block stands on ─────────────────────────── */
  const SLAB_Z = -0.3;
  const slabMat = new THREE.MeshBasicMaterial({ color: 0x141721, transparent: true, opacity: 1, depthWrite: false });
  const slabGeo = new THREE.PlaneGeometry(1, 1);
  const slabs: THREE.Mesh[] = [];
  function slab(i: number, cx: number, cy: number, w: number, h: number, z: number) {
    let m = slabs[i];
    if (!m) {
      m = new THREE.Mesh(slabGeo, slabMat);
      m.renderOrder = -2;
      slabs.push(m);
      scene.add(m);
    }
    m.visible = true;
    m.position.set(cx, cy, z);
    m.scale.set(w, h, 1);
  }

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
  /**
   * Las máquinas del arnés → el slug del directorio del que salieron. Vacío
   * mientras no corran pruebas, que es casi siempre. Ver `shared/synthetic.ts`.
   */
  let harness = new Map<string, string>();
  /** La isla de un agente, con el recinto del arnés ya contado. */
  const island = (a: Agent) => islandIn(harness, a);

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
    // La isla de fuera de la flota no llega en `projects` —no es uno— así que
    // su rótulo se registra igual, o cada tesela de ahí dentro diría `??`.
    for (const a of Object.values(w.agents)) {
      if (!a.workspace) continue;
      const id = islandOf(a);
      rememberProjectCode(id, OFF_FLEET_LABEL.code);
      rememberProjectName(id, OFF_FLEET_LABEL.name);
    }
    /*
     * Las máquinas del arnés y de dónde salieron, una vez por feed: es lo que
     * decide en qué recinto cae cada tesela de fixture, y lo consultan tanto
     * el layout como el reparto de escalaciones y de nodos YOU de aquí abajo.
     * El recinto tampoco llega en `projects`, así que lleva su propio rótulo.
     */
    harness = new Map();
    for (const m of Object.values(w.machines ?? {})) {
      const home = harnessHome(m);
      if (home === null) continue;
      harness.set(m.id, home);
      const id = harnessIsland(home);
      rememberProjectCode(id, HARNESS_LABEL.code);
      rememberProjectName(id, HARNESS_LABEL.name);
    }
    for (const m of Object.values(w.machines ?? {})) rememberMachine(m.id, m.hostname);
    agents = Object.values(w.agents);
    byId.clear();
    byCallsign.clear();
    for (const a of agents) { byId.set(a.id, a); byCallsign.set(a.callsign.toUpperCase(), a.id); }
    capcomId = agents.find((a) => a.role === 'capcom')?.id ?? null;

    // Which blocks a person can actually clear, resolved once per feed: the
    // shader asks this per tile and the YOU nodes ask it per region.
    pendingAgents.clear();
    pendingByProject.clear();
    for (const e of Object.values(w.escalations ?? {})) {
      if (e.status !== 'pending' && e.status !== 'with_ceo') continue;
      pendingAgents.add(e.agentId);
      const a = byId.get(e.agentId);
      const pid = a ? island(a) : e.projectId;
      pendingByProject.set(pid, (pendingByProject.get(pid) ?? 0) + 1);
    }
    readCommandFlags();
    refreshCommand();
    // Quién es revisor sale del tablero de AUTOMEJORA, que cambia cada varias
    // horas: se relee con el mundo y no por fotograma.
    reviewers = reviewerIds(store.improve);
    forge = forgeViews(agents, w.missions ?? {});
    syncForgeLabels();

    const placements = new Map<string, Placement>();
    for (const [id, p] of Object.entries(w.placements ?? {})) placements.set(id, p);
    for (const p of loadLocalPlacements()) placements.set(p.agentId, p);

    /*
     * Blocks (`blocks.ts`): a child that only talks to its parent stands in
     * the parent's tray, not in a cell of its own, and no pipe joins them.
     * The deck lists everyone — order is its whole point — so it folds nobody.
     */
    absorbed = lmode.kind === 'field' ? absorbedChildren(agents, Object.values(w.messages ?? {})) : new Map();
    /*
     * Quién cuelga una estantería de su baldosa: quien haya declarado algo
     * (`shelf.ts`). La rejilla le hace hueco debajo, así que la franja no puede
     * caer encima de la fila de abajo. La cubierta no: es una rejilla estricta
     * cuyo sentido entero es el orden, y una fila más alta que otra la rompe.
     */
    shelved = lmode.kind === 'field' ? shelvedAgents(w.artifacts) : new Set<string>();
    layout = layoutFleet(agents, projects, placements, layout, lmode, squadPlaced, regionPlaced, absorbed, harness, shelved);
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
        if (!first && layout.spots.has(a.id) && !reduce && absorbed.has(a.id)) {
          // A cell in its parent's tray: no pipe to grow down, so it simply arrives.
          anim.set(`tile:${a.id}`, 0);
          anim.grow(`tile:${a.id}`, { dur: T.quick, ease: EASE.arrive });
        } else if (!first && layout.spots.has(a.id) && !reduce) {
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

    artifacts = [...Object.values(w.artifacts ?? {}), ...extraMedia];
    // Un índice por id, una vez por feed: las fichas lo leen por fotograma y
    // buscar en una lista por cada una sería el bucle dentro del bucle.
    artById.clear();
    for (const a of artifacts) artById.set(a.id, a);
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
    for (const a of agents) if (island(a) === q.projectId && squadOf(a) === q.name) out.push(a.id);
    return out;
  }

  /* ── Region labels (DOM) ────────────────────────────────────────── */
  const regionEls = new Map<string, HTMLElement>();
  const youEls = new Map<string, HTMLElement>();
  /**
   * CAPCOM's rótulo (§1.3): the word CAPCOM over its tile, the way a region
   * wears its code. It is there at the zooms where the tile is too small to
   * carry its own label, and steps aside once the tile can say it itself.
   * Click opens the conversation, which is what the word is an invitation to.
   */
  const capcomEl = document.createElement('button');
  capcomEl.type = 'button';
  capcomEl.className = 'rgn rgn--capcom';
  capcomEl.style.pointerEvents = 'auto';
  capcomEl.style.display = 'none';
  capcomEl.innerHTML = '<span class="rgn__code">CAPCOM</span><span class="rgn__name">COMMAND</span>';
  capcomEl.addEventListener('click', (e) => {
    if (swallowClick) { swallowClick = false; return; }
    const cap = agents.find((a) => a.role === 'capcom');
    if (cap) ev.onOpen(cap.id, e.clientX, e.clientY);
  });
  regionsLayer.appendChild(capcomEl);

  // The label belongs to the real lead, just like CAPCOM's. No second node
  // or selection identity: every gesture opens the existing agent window.
  const forgeEls = new Map<string, HTMLButtonElement>();
  function syncForgeLabels() {
    for (const [id, el] of forgeEls) {
      if (!forge.has(id)) { el.remove(); forgeEls.delete(id); }
    }
    for (const [id, view] of forge) {
      let el = forgeEls.get(id);
      if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'rgn rgn--forge';
        el.style.pointerEvents = 'auto';
        el.addEventListener('pointerdown', (e) => e.stopPropagation());
        el.addEventListener('click', (e) => { e.stopPropagation(); if (byId.has(id)) ev.onOpen(id, e.clientX, e.clientY); });
        regionsLayer.appendChild(el);
        forgeEls.set(id, el);
      }
      const callsign = byId.get(id)?.callsign ?? id;
      const html = `<span class="rgn__code">FORGE</span><span class="rgn__name">LEAD ${esc(callsign)} · ${esc(view.label)}</span>`;
      if (el.innerHTML !== html) el.innerHTML = html;
      el.setAttribute('aria-label', `FORGE · lead ${callsign} · ${view.label}`);
      el.classList.toggle('is-inactive', !view.active);
    }
  }
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
    const forgeView = lead ? forge.get(lead.id) : undefined;
    const sig = sigilHTML(sigilBits(q.name));
    let html = `<span class="squad__sigil sigil--lg">${sig}</span><span class="squad__roster">${roster}</span>`;
    if (forgeView) html += `<span class="squad__k">FORGE · ${esc(forgeView.label)}</span>`;
    if (tier >= 2) {
      html += `<span class="squad__k">${esc(q.name)} · ${groupOrigin(agents.filter((a) => island(a) === q.projectId && squadOf(a) === q.name))}</span><span class="squad__n">${q.count}</span>`;
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
      // Ciudadanos de segunda: la isla de fuera de la flota lleva su propia
      // clase y se dibuja apagada, para que no se lea como un proyecto más.
      el.classList.toggle('rgn--off', r.offFleet);
      // Y el recinto del arnés lleva la suya: nada de lo que hay ahí dentro
      // ocurrió, y el rótulo es lo que lo dice con una palabra.
      el.classList.toggle('rgn--harness', r.harness);
      const sig = `${r.code}|${r.name}|${r.count}|${r.blocked}`;
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        el.innerHTML = `<span class="rgn__code">${esc(r.code)}</span><span class="rgn__name">${esc(r.name)}</span>`
          + `<span class="rgn__n">${r.blocked ? `${r.blocked} NEED YOU · ` : ''}${r.count}</span>`
          + `<span class="rgn__open" title="${r.harness ? 'Open what the tests brought up' : r.offFleet ? 'Open what is off the fleet' : 'Open this project'}">▸</span>`;
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
    // CAPCOM's rótulo sits over its tile at every zoom, like a squad's
    // legend and unlike a region's label: it names the one tile that must
    // always be findable, and it never yields to a collision or to `fade`.
    {
      const sp = capcomId ? layout.spots.get(capcomId) : undefined;
      // Centred over the tile, not hung off its corner like a region's: the
      // tile is one cell wide and the word should sit on it, not beside it.
      const p = sp ? camera.project(sp.x, sp.y + TILE_H / 2 * sp.scale, sp.z) : null;
      if (!sp || !p || !p.visible || lmode.kind === 'deck') capcomEl.style.display = 'none';
      else {
        // It sits on the halo's top edge (command.ts), a legend on its
        // fieldset — and never lower than clear of the tile, which from afar
        // the ring is not.
        const ring = camera.project(sp.x, sp.y + TILE_H / 2 * sp.scale + RING_OFF, sp.z);
        const cy = Math.min(ring.y, p.y - 13);
        capcomEl.style.display = '';
        capcomEl.style.opacity = '1';
        capcomEl.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(cy)}px, 0) translate(-50%, -50%)`;
      }
    }
    for (const [id, el] of forgeEls) {
      const sp = layout.spots.get(id);
      const p = sp ? camera.project(sp.x, sp.y + TILE_H / 2 * sp.scale, sp.z) : null;
      if (!sp || !p?.visible || lmode.kind === 'deck') { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.opacity = '1';
      const half = el.offsetWidth / 2;
      const x = Math.max(half + 8, Math.min(root.clientWidth - half - 8, p.x));
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(p.y - 13)}px, 0) translate(-50%, -50%)`;
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
   * CAPCOM never had a cell — it stands at the origin, outside every region
   * (layout.ts) — so anything tied to it takes the direct route too.
   */
  const offGrid = (a: Pt, b: Pt) =>
    (a as Partial<Spot>).pinned === true || (b as Partial<Spot>).pinned === true
    || (a as Partial<Spot>).scale === CAPCOM_SCALE || (b as Partial<Spot>).scale === CAPCOM_SCALE;

  /**
   * The region a point stands in, when it is a tile at all.
   *
   * A YOU node, a project label and a squad port are bare points with no
   * `projectId`: they live outside the tile grid, which is exactly why they
   * need the routes below and not `routeGutterMsg`.
   */
  function regionOf(p: Pt): Region | undefined {
    if ((p as Partial<Spot>).scale === CAPCOM_SCALE) return undefined;
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
    const childRegion = regionOf(c);
    if (forge.has((p as Spot).id) && (p as Spot).scale === CAPCOM_SCALE && childRegion
      && !(c as Spot).pinned && !insideRegion(childRegion, p)) {
      const edge = { x: p.x + (c.x >= p.x ? 1 : -1) * TILE_W * CAPCOM_SCALE / 2, y: p.y };
      return landOn(exitRegion(c, childRegion, p, laneOf(seed)), edge).reverse();
    }
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
    // The command links are a relationship too, while they are drawn: focus
    // on CAPCOM holds up what it launched, and focus on one of those holds
    // up CAPCOM.
    if (cmdFlags.links && capcomId) {
      if (selected.has(capcomId)) {
        for (const a of agents) if (commandLinked(a, capcomId)) focusNear.add(a.id);
      } else {
        for (const id of selected) {
          const a = byId.get(id);
          if (a && commandLinked(a, capcomId)) { focusNear.add(capcomId); break; }
        }
      }
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
    // A child standing in its parent's tray is part of the parent: no pipe.
    if (absorbed.has(a.id) && c.trayOf === fromId) return;
    const pts = lineageRoute(p, c, fromId);
    const touch = selected.has(a.id) || selected.has(fromId);
    const hot = touch || hover === a.id || hover === fromId;
    const sel = touch ? 1 : 0;
    /*
     * How far the tie reaches decides whether it survives a zoom-out: a lazo
     * between fleets or across a region is the picture from afar, one between
     * neighbours is detail you zoom in for. A tie the operator is looking at
     * — selected or hovered — is never detail.
     */
    const span = hot ? 1 : spanOf(pathLength(pts), regionOf(p) !== regionOf(c));
    const len = pipes.add(pts, z, C_LINE, 'lineage', 0, bus, sel, span);

    const gone = a.state === 'done' || a.state === 'dead';
    const fill = gone ? 0 : anim.get(`core:${a.id}`, 1);
    if (fill > 0) {
      pipes.add(pts, z + 0.002, hot || a.state === 'working' ? C_LIME : C_LIME_55, 'core', fill * len, core, sel, span);
    }
    const head = pts[0]!, tail = pts[pts.length - 1]!;
    const landed = fill >= 1;
    pipes.port(head.x, head.y, z + 0.003, C_INK, 1, sel, false, 1 - span);
    pipes.port(tail.x, tail.y, z + 0.003, landed ? C_INK : C_INK_DIM, 1, sel, !landed, 1 - span);
  }

  /**
   * De dónde sale el tirante de una superficie colocada (`tether.ts`): la
   * baldosa de su agente, y si ya no tiene baldosa —archivado, fuera de
   * `w.agents`— el puerto de su escuadra, si la escuadra sigue en el campo.
   * Sin ninguna de las dos no hay tirante: un archivo del operador
   * (`extraMedia`, sin agente) no es el output de nadie, y a uno huérfano no
   * se le inventa un origen, que es la regla que la estantería ya sigue.
   * `key` es lo que `hover` trae cuando el puntero está sobre ese origen.
   */
  function tetherOrigin(a: Artifact): { rect: Rect; z: number; key: string } | null {
    if (!a.agentId) return null;
    const s = layout.spots.get(a.agentId);
    if (s) return { rect: { x: s.x, y: s.y, w: TILE_W * s.scale, h: TILE_H * s.scale }, z: s.z, key: a.agentId };
    // `knownAgent` lee el almacén vivo, que un mundo reproducido no es.
    const known = replay ? undefined : store.knownAgent(a.agentId);
    const sq = known ? squadOf(known) : null;
    if (!known || !sq) return null;
    const hit = blockFor(sq, island(known));
    if (!hit) return null;
    const p = squadPortAt(hit.q);
    return { rect: { x: p.x, y: p.y, w: 0, h: 0 }, z: SQ_Z + 0.004, key: hit.key };
  }

  /**
   * Tirantes (`tether.ts`): cada output del canvas, unido a quien lo hizo.
   *
   * Las fichas cuelgan de su baldosa por el hilo que el bucle de baldosas dejó
   * en `stems`; cada superficie colocada lleva un camino ortogonal hasta su
   * origen y un puerto en él. Tenues en reposo y lima calientes — el output
   * bajo el puntero, o todos los de la baldosa bajo el puntero —, y el foco
   * los trata como a cualquier pipe: sólo los del seleccionado guardan su
   * peso. Varias superficies de un agente convergen en el mismo punto de su
   * baldosa, así que N outputs leen como un haz.
   */
  function drawTethers() {
    for (const t of stems) {
      pipes.add(t.pts, t.z, t.hot ? C_LIME : C_INK_DIM, 'tether', t.hot, tetherWeight(t.hot > 0), t.sel, 1);
    }
    for (const m of media.rects()) {
      if (!m.shown) continue;
      const a = artById.get(m.id);
      if (!a) continue;
      const o = tetherOrigin(a);
      if (!o) continue;
      const hot = tetherHot(a, o.key, hovArt, hotOrigins);
      const sel = selected.has(a.agentId) ? 1 : 0;
      const pts = tetherRoute({ x: m.x, y: m.y, w: m.w, h: m.h }, o.rect);
      const z = Math.min(o.z, m.z) - 0.02;
      const color = hot ? C_LIME : C_INK_DIM;
      pipes.add(pts, z, color, 'tether', hot ? 1 : 0, tetherWeight(hot), sel, 1);
      const end = pts[pts.length - 1]!;
      pipes.port(end.x, end.y, z + 0.003, color, originPortScale(hot), sel);
    }
  }

  function buildPipes(now: number) {
    pipes.begin();
    const w = world();
    // Region outlines: the comp's thin panel border. The harness's is the
    // same border twice, one wall inside the other: what is in there is
    // fenced off, and that has to read from the zoom where a region is a
    // block — before any label can say the word.
    for (const r of layout.regions) {
      const x0 = r.cx - r.hw, x1 = r.cx + r.hw, y0 = r.cy - r.hh, y1 = r.cy + r.hh;
      const box = (a: number, b: number, c: number, d: number) =>
        [{ x: a, y: d }, { x: c, y: d }, { x: c, y: b }, { x: a, y: b }, { x: a, y: d }];
      pipes.add(box(x0, y0, x1, y1), -0.4, r.harness ? C_HARNESS : C_RGN, 'frame', 0, 0.4);
      if (r.harness) {
        const w = HARNESS_WALL;
        pipes.add(box(x0 + w, y0 + w, x1 - w, y1 - w), -0.4, C_HARNESS, 'frame', 0, 0.4);
      }
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
      const len = pipes.add(pts, SQ_Z, C_SQUAD, 'frame', 0, 0.4);
      const t = anim.get(`sq:${k}`, 1);
      if (t < 1) pipes.add(pts, SQ_Z + 0.002, C_LIME, 'core', t * len, 0.4, 0, 1);
      // The port on the top edge: where a `toSquad` message lands and where
      // the fan leaves from. Ink while one is in the air, `--ink-dim` after.
      const port = squadPortAt(q);
      pipes.port(port.x, port.y, SQ_Z + 0.004, lit ? C_INK : C_INK_DIM, 1.3, 0);
    }
    /*
     * Blocks (`blocks.ts`): the parent's tile and its tray share one frame,
     * so from afar they are one shape, and inside it the folded children are
     * cells with no pipe to anyone. The frame follows the tray, which follows
     * the parent when the operator pinned it.
     */
    let slabN = 0;
    for (const t of layout.trays) {
      const p = layout.spots.get(t.parentId);
      if (!p) continue;
      const x0 = Math.min(p.x, t.cx) - TILE_W / 2 - BLOCK_PAD, x1 = Math.max(p.x, t.cx) + TILE_W / 2 + BLOCK_PAD;
      const y0 = Math.min(p.y, t.cy) - TILE_H / 2 - BLOCK_PAD, y1 = Math.max(p.y, t.cy) + TILE_H / 2 + BLOCK_PAD;
      // The slab: a filled plate under parent and tray, one step up from the
      // ground. It says "one piece" without adding a line to a field that
      // already has the region's and the squad's; the outline appears only
      // when the block is selected.
      slab(slabN++, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, SLAB_Z);
      const sel = selected.has(t.parentId) || t.ids.some((id) => selected.has(id));
      if (sel) pipes.add([{ x: x0, y: y1 }, { x: x1, y: y1 }, { x: x1, y: y0 }, { x: x0, y: y0 }, { x: x0, y: y1 }], SLAB_Z + 0.01, C_LIME, 'frame', 0, 0.5, 1);
    }
    for (let i = slabN; i < slabs.length; i++) slabs[i]!.visible = false;
    /*
     * Lineage, the comp's way: a grey **bus** that says the child exists, and
     * a lime **core** inside it that says the child is working. The bus never
     * changes — the relationship is a fact. The core grows out of the parent
     * at birth, drains back at death, and is simply absent once the child is
     * done: lime is activity, not wiring.
     */
    for (const a of agents) {
      if (!a.parentId) continue;
      // A child of CAPCOM's is a command link while those are drawn.
      if (cmdFlags.links && a.parentId === capcomId) continue;
      const p = layout.spots.get(a.parentId), c = layout.spots.get(a.id);
      if (!p || !c) continue;
      tie(a, a.parentId, p, c, Math.min(p.z, c.z) - 0.03, 1.0, 0.42);
    }
    /*
     * Command links (command.ts): CAPCOM to what it launched, faint cyan and
     * under everything. Direct routes — CAPCOM has no cell, so its pipes never
     * had a gutter — dimmed to a third once the agent is done. A preference,
     * off by default: with fifty agents they are the noise the halo is not.
     */
    if (cmdFlags.links && capcomId) {
      const p = layout.spots.get(capcomId);
      if (p) {
        for (const a of agents) {
          if (!commandLinked(a, capcomId)) continue;
          const c = layout.spots.get(a.id);
          if (!c || c.trayOf !== null) continue;
          const gone = a.state === 'done' || a.state === 'dead';
          const sel = selected.has(a.id) || selected.has(capcomId) ? 1 : 0;
          pipes.add(routeLineage(p, c), Math.min(p.z, c.z) - 0.06, C_CYAN_DIM, 'command', gone ? 0.35 : 1, 0.7, sel, 1);
        }
      }
    }
    // Project affiliation is visible without putting FORGE inside its box.
    // Ports meet the existing region perimeter and the real lead's tile.
    // This is a presentation edge, never mission or approval state.
    if (lmode.kind !== 'deck') for (const [id, view] of forge) {
      const a = byId.get(id), p = layout.spots.get(id);
      if (!a || !p || p.scale !== CAPCOM_SCALE) continue;
      const r = layout.regions.find((r) => !r.harness && !r.offFleet && projects.get(r.id)?.slug === 'orca') ?? regionById.get(island(a));
      if (!r || insideRegion(r, p)) continue;
      const edge = { x: Math.max(r.cx - r.hw, Math.min(r.cx + r.hw, p.x)), y: Math.max(r.cy - r.hh, Math.min(r.cy + r.hh, p.y)) };
      const horizontal = Math.abs(p.x - edge.x) >= Math.abs(p.y - edge.y);
      const end = horizontal
        ? { x: p.x - Math.sign(p.x - edge.x) * TILE_W * p.scale / 2, y: p.y }
        : { x: p.x, y: p.y - Math.sign(p.y - edge.y) * TILE_H * p.scale / 2 };
      const corner = horizontal ? { x: end.x, y: edge.y } : { x: edge.x, y: end.y };
      const pts = [edge, corner, end];
      const color = view.active ? C_FORGE_DIM : C_INK_DIM;
      pipes.add(pts, p.z - 0.065, color, 'command', view.active ? 1 : 0.35, 0.7, selected.has(id) ? 1 : 0, 1);
      pipes.port(edge.x, edge.y, p.z - 0.06, color, 1, 0);
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
    drawTethers();
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
      // A notice between neighbours is detail; one across the fleet is news from afar.
      const to = m.toAgentId ? layout.spots.get(m.toAgentId) : undefined;
      const a = layout.spots.get(m.fromAgentId);
      const span = spanOf(pathLength(path.pts), !to || !a || regionOf(a) !== regionOf(to));
      pipes.add(path.pts, path.z, hot ? C_LIME : path.color, open ? 'ask' : hot ? 'hot' : 'notice', age, 1, hot ? 1 : 0, span);
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
        const ka = byId.get(id);
        if (key === DECK_YOU || (ka && island(ka) === key)) { mine = 1; break; }
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
        const you = youOf(lmode.kind === 'deck' ? DECK_YOU : island(a));
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

  /** The pointer's ray into the world, or null when it runs parallel to the plane. */
  function rayAt(sx: number, sy: number): { o: THREE.Vector3; d: THREE.Vector3 } | null {
    const r = canvas.getBoundingClientRect();
    ndc.set(((sx - r.left) / r.width) * 2 - 1, -((sy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera.three);
    const o = ray.ray.origin, d = ray.ray.direction;
    return Math.abs(d.z) < 1e-6 ? null : { o, d };
  }

  /**
   * La superficie bajo el puntero, haya o no baldosa debajo. `pickAt` prueba
   * los agentes antes que media a propósito —una baldosa bajo un cuadro sigue
   * ganando el clic y el arrastre—, pero para el tirante lo que cuenta es lo
   * que se ve, y lo que se ve es el cuadro: pasar el puntero por una imagen
   * que tapa a un vecino tiene que encender la línea de la imagen, no la del
   * vecino enterrado.
   */
  function mediaAt(sx: number, sy: number): string | null {
    const hit = rayAt(sx, sy);
    if (!hit) return null;
    const { o, d } = hit;
    for (const m of media.rects()) {
      if (!m.shown) continue;
      const t = (m.z - o.z) / d.z;
      const x = o.x + d.x * t, y = o.y + d.y * t;
      if (Math.abs(x - m.x) <= m.w / 2 && Math.abs(y - m.y) <= m.h / 2) return m.id;
    }
    return null;
  }

  function pickAt(sx: number, sy: number): { kind: 'agent' | 'media' | 'squad'; id: string } | null {
    const hit = rayAt(sx, sy);
    if (!hit) return null;
    const { o, d } = hit;
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
  /** What the pointer went down on, when it differs from the drag handle (a cell of a block). */
  let clickId: string | null = null;
  let dragMoved = false;
  let lastX = 0, lastY = 0, downX = 0, downY = 0, downAt = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  /** Everything that moves with the dragged tile. */
  let dragSet: string[] = [];
  /**
   * What moves with it without being pinned: the cells of a dragged block.
   * A block is one piece — a hand on the parent or on any cell moves parent,
   * trays and cells together — but only the parent is placed: the layout
   * stands the trays beside a pinned parent, and a pinned cell would be a
   * tile again (`blocks.ts`), so the block would explode in the hand.
   */
  let dragFollow: string[] = [];

  /** The parent of a block, given any of its agents: itself, or the tray it stands in. */
  function blockParentOf(id: string): string | null {
    const s = layout.spots.get(id);
    if (!s) return null;
    if (s.trayOf) return s.trayOf;
    return layout.trays.some((t) => t.parentId === id) ? id : null;
  }
  /** Every cell in a parent's trays. */
  function cellsOf(parentId: string): string[] {
    const out: string[] = [];
    for (const t of layout.trays) if (t.parentId === parentId) out.push(...t.ids);
    return out;
  }

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
      for (const sp of layout.spots.values()) if (sp.projectId === rgn && sp.scale !== CAPCOM_SCALE) dragSet.push(sp.id);
      return;
    }
    const rotulo = target?.closest?.<HTMLElement>('.squad')?.dataset.key ?? null;
    const hit = rotulo && squadBlocks.has(rotulo) ? { kind: 'squad' as const, id: rotulo } : pickAt(e.clientX, e.clientY);
    if (hit?.kind === 'agent') {
      mode = 'agent';
      const block = blockParentOf(hit.id);
      // A hand on a block is a hand on the whole block; the parent is the handle.
      dragId = block ?? hit.id;
      dragSet = selected.has(hit.id) ? [...selected].map((id) => blockParentOf(id) ?? id) : [dragId];
      dragSet = [...new Set(dragSet)].filter((id) => !layout.spots.get(id)?.trayOf);
      dragFollow = dragSet.flatMap(cellsOf);
      // A click, though, is on what was clicked: a cell can be selected and opened.
      clickId = hit.id;
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
      hoverMedia = mediaAt(e.clientX, e.clientY);
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
        // The block goes with its parent: trays and cells by the same delta, unpinned.
        for (const tr of layout.trays) if (tr.parentId === id) { tr.cx += dx * per; tr.cy -= dy * per; }
      }
      for (const id of dragFollow) {
        const t = layout.spots.get(id);
        if (!t) continue;
        t.x += dx * per; t.y -= dy * per; t.tx = t.x; t.ty = t.y;
      }
    } else if (mode === 'media' && dragId) {
      const m = media.rects().find((r) => r.id === dragId);
      if (!m) return;
      const per = camera.worldPerPixel(m.z);
      const nx = m.x + dx * per, ny = m.y - dy * per;
      media.nudge(dragId, nx, ny);
      // Live, like a tile's: a feed that lands mid-drag rebuilds the media from
      // the artifacts, and without this the surface would snap back under the
      // hand to where the grab began. Only the save waits for the release.
      const a = artifacts.find((x) => x.id === dragId);
      if (a?.placement) { a.placement.x = nx; a.placement.y = ny; }
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
        const id = clickId ?? dragId;
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          if (selected.has(id)) selected.delete(id); else selected.add(id);
        } else {
          selected.clear();
          selected.add(id);
        }
        selRev++;
        ev.onSelect([...selected], at);
      }
      clickId = null;
      dragFollow = [];
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
    // Agent pointer-up already toggled once per click. A native dblclick
    // must not open it a third time after the second click closed it.
    if (hit?.kind === 'media') ev.onOpenArtifact(hit.id, e.clientX, e.clientY);
    else if (hit?.kind === 'squad') { const q = squadBlocks.get(hit.id); if (q) ev.onOpenSquad(q.name, q.projectId, e.clientX, e.clientY); }
  });

  /*
   * Right click names what is under the pointer and hands it to the console.
   * An agent outside the selection becomes the selection first — without the
   * `at`, so nothing opens — and one inside it asks on behalf of all of them.
   * A surface's own content keeps the browser's menu.
   */
  // Con el dedo no hay botón derecho: mantener pulsado dispara este mismo
  // `contextmenu` sobre lo que haya debajo. Ver `hud/longpress.ts`.
  longPress(root, { skip: '.srf iframe, .srf pre, .srf__x' });
  root.addEventListener('contextmenu', (e) => {
    if (keeps(e.target)) return;
    e.preventDefault();
    /*
     * La guarda es el MOVIMIENTO, no el modo.
     *
     * `mode` se fija en el `pointerdown` —`agent` sobre una baldosa, `pan`
     * sobre el vacío— antes de que nada se haya movido, así que «modo distinto
     * de none» también es cierto con el dedo quieto encima. Con el ratón daba
     * igual: el botón derecho llega con el izquierdo levantado. Con una
     * pulsación larga el dedo sigue abajo cuando el menú tiene que salir, y
     * esta guarda se lo comía. Lo que se quería evitar era un menú a mitad de
     * un arrastre, y eso es `dragMoved`.
     */
    if (mode !== 'none' && dragMoved) return;
    // El dedo todavía está abajo: al levantarlo habría un clic que
    // seleccionaría o abriría lo que hay debajo del menú.
    swallowClick = true;
    const t = e.target as HTMLElement | null;
    const rgn = t?.closest?.<HTMLElement>('.rgn')?.dataset.project;
    if (rgn) { ev.onContext({ kind: 'project', id: rgn, moved: regionById.get(rgn)?.moved ?? false }, e.clientX, e.clientY); return; }
    const rotulo = t?.closest?.<HTMLElement>('.squad')?.dataset.key ?? null;
    /*
     * Con el dedo quieto, el sujeto es el que se picó AL BAJAR, no el que haya
     * bajo el punto medio segundo después. El campo se recoloca solo —una
     * baldosa nueva, un squad que crece— y volver a picar por coordenadas
     * abriría el menú de otro, o el del campo vacío, sobre el mismo dedo que
     * no se ha movido. `clickId` y `dragId` son lo que ya se guarda al bajar
     * justo para esto.
     */
    const held = !dragMoved
      ? mode === 'agent' && clickId ? { kind: 'agent' as const, id: clickId }
        : mode === 'squad' && dragId ? { kind: 'squad' as const, id: dragId }
        : mode === 'media' && dragId ? { kind: 'media' as const, id: dragId }
        : null
      : null;
    const hit = held ?? (rotulo && squadBlocks.has(rotulo) ? { kind: 'squad' as const, id: rotulo } : pickAt(e.clientX, e.clientY));
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
  const shelfItems: ShelfItem[] = [];

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
    halo.setFocus(focusV);
    // The command post: the flags every frame (a toggle takes on the next
    // frame), the state once a second — a mission cools by the clock alone.
    readCommandFlags();
    if (clock - cmdAt > 1) refreshCommand();
    swarm.setCommand(cmdState.turn, cmdState.waiting, cmdFlags.pulse ? 1 : 0);

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
    let haloDrawn = false;
    labelItems.length = 0;
    shelfItems.length = 0;
    stems.length = 0;
    // El hover de los tirantes, resuelto una vez: ver `hovArt` y `hotOrigins`.
    hovArt = hoverArt ?? hoverMedia ?? (hover !== null && artById.has(hover) ? hover : null);
    hotOrigins.clear();
    if (hover !== null && !artById.has(hover)) hotOrigins.add(hover);
    if (hoverOrigin !== null) hotOrigins.add(hoverOrigin);
    /*
     * La baldosa de la que cuelga el output bajo el puntero se enciende como
     * si el puntero estuviera sobre ella: es el realce del extremo de origen,
     * y sale gratis del `sel` que el shader ya tiene para el hover.
     */
    const hotTile = hoverOrigin ?? (hovArt !== null ? artById.get(hovArt)?.agentId ?? null : null);
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
      let scale = anim.get(`tile:${a.id}`, 1) * s.scale, alpha = 1;
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
      // CAPCOM idle is CAPCOM listening: it never fades the way a worker does.
      alpha = a.state === 'done' ? 0.35 : a.state === 'dead' ? 0.55 : a.state === 'idle' && a.role !== 'capcom' ? 0.8 : 1;
      const isSel = selected.has(a.id);
      const sel = isSel ? 2 : hover === a.id || hotTile === a.id ? 1 : 0;
      const near = focusNear.has(a.id);
      const focusA = isSel ? FOCUS_A.sel : near ? FOCUS_A.near : FOCUS_A.far;
      /*
       * The form (§2.3): what the silhouette says. A child wears the bite —
       * the port its parent's pipe lands in; a root is a whole rectangle. A
       * parent grows a tab under its bottom edge where its ties leave. A
       * squad member stands on a plate, a lead on two. A session ORCA did
       * not launch has a dashed outline: in the fleet, not of it. A cell in a
       * tray is too small for any of it and says only its state.
       */
      const cell = s.trayOf !== null;
      const hasParent = !cell && !!a.parentId && byId.has(a.parentId);
      const hasKids = !cell && a.childIds.some((id) => byId.has(id));
      const plates = cell ? 0 : squadOf(a) ? (isLead(a) ? 2 : 1) : 0;
      // Bit 8: la baldosa tiene resultados colgando (`shelf.ts`). La marca del
      // shader es lo único que lo dice cuando ni la tarjeta ni la fila caben.
      const topo = (hasParent ? 1 : 0) + (hasKids ? 2 : 0) + (!cell && a.origin === 'external' ? 4 : 0) + (!cell && shelved.has(a.id) ? 8 : 0);
      const life = a.state === 'done' ? 1 : a.state === 'dead' ? 2 : 0;
      swarm.write(
        slot, s.x, s.y, s.z, Math.max(0.001, scale), color, alert, speed, sel, alpha, hash(a.id),
        flashAt.get(a.id) ?? -9e3, focusA, isLead(a) ? 1 : 0, sigilOf(a), runtimeOf(a),
        [Math.max(0.001, scale), plates, topo, life],
      );
      slot++;
      // The halo rides CAPCOM's tile, at its eased spot and scale. Not in the
      // deck: a ring in a strict grid would lie across its neighbours.
      if (a.role === 'capcom' && lmode.kind !== 'deck') {
        halo.write(s.x, s.y, s.z, scale, cmdState, alpha, focusA, isSel ? 1 : 0);
        haloDrawn = true;
      }

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
        /*
         * En pantalla por la CAJA, no por la esquina: acercándose mucho, la
         * esquina superior izquierda sale del lienzo mientras la baldosa —y
         * la estantería que cuelga de ella— siguen llenando media pantalla,
         * y con `p.visible` el rótulo y las fichas desaparecían justo ahí.
         * La franja cuelga por debajo de la caja, de ahí el margen.
         */
        const ahead = p.ahead && q.ahead;
        const onTile = ahead && camera.boxOnScreen(p.x, p.y, q.x, q.y);
        const onShelf = ahead && camera.boxOnScreen(p.x, p.y, q.x, q.y + bh * 0.45);
        if (onTile && bw >= LABEL_PX && bh > 2) {
          labelItems.push({ agent: a, forge: forge.get(a.id), sx: p.x, sy: p.y, w: bw, h: bh, sel: isSel || near, selected: isSel, amber: alert >= 0.75 });
        }
        /*
         * La estantería, en el mismo fotograma y con el mismo recorte que el
         * rótulo. Sube un peldaño más tarde que las palabras (`shelfVisible`):
         * más abajo una ficha son diecinueve píxeles, y un color no es una
         * miniatura. El hueco sigue reservado, así que la flota no se recoloca
         * al alejarse — sólo se queda la franja vacía.
         */
        if (onShelf && shelved.has(a.id) && shelfVisible(bw)) {
          const ids = shelfIds(artifacts, a.id);
          const chips = shelfChips(ids, { x: s.x, y: s.y, z: s.z, scale, trayOf: s.trayOf });
          if (chips.length) {
            const dim = a.state === 'dead' || a.state === 'done';
            const hot = hotOrigins.has(a.id);
            const items = chips.map((c) => {
              const c0 = camera.project(c.x - c.w / 2, c.y + c.h / 2, c.z);
              const c1 = camera.project(c.x + c.w / 2, c.y - c.h / 2, c.z);
              /*
               * El hilo del que cuelga la ficha (`tether.ts`), en unidades de
               * mundo: `buildPipes` lo dibuja con los demás tirantes. Caliente
               * el de la ficha bajo el puntero, o todos si el puntero está
               * sobre la baldosa o sobre el contador.
               */
              const id = c.id ?? `+${a.id}`;
              const stemHot = hot || tetherHot({ id }, a.id, hovArt, hotOrigins);
              stems.push({ id, pts: chipStem(c, { y: s.y, scale }), z: c.z, hot: stemHot ? 1 : 0, sel: isSel ? 1 : 0 });
              return { art: artById.get(c.id ?? '') ?? null, more: c.more, sx: c0.x, sy: c0.y, px: Math.max(1, c1.x - c0.x) };
            });
            shelfItems.push({ agentId: a.id, chips: items, dim, hot, badge: null });
          }
        } else if (onShelf && shelved.has(a.id) && badgeVisible(bw)) {
          /*
           * El peldaño de en medio (`shelf.ts`): la tarjeta con el más nuevo y
           * la cuenta, colgada del borde inferior por un solo hilo. Con un solo
           * output el hilo es el suyo; con varios, el de la baldosa, como el
           * del contador.
           */
          const ids = shelfIds(artifacts, a.id);
          const b = shelfBadge(ids, { x: s.x, y: s.y, z: s.z, scale, trayOf: s.trayOf });
          if (b) {
            const dim = a.state === 'dead' || a.state === 'done';
            const hot = hotOrigins.has(a.id);
            const id = b.count === 1 ? b.id : `+${a.id}`;
            const stemHot = hot || tetherHot({ id }, a.id, hovArt, hotOrigins);
            stems.push({ id, pts: chipStem(b, { y: s.y, scale }), z: b.z, hot: stemHot ? 1 : 0, sel: isSel ? 1 : 0 });
            const c0 = camera.project(b.x - b.w / 2, b.y + b.h / 2, b.z);
            shelfItems.push({ agentId: a.id, chips: [], dim, hot, badge: { art: artById.get(b.id) ?? null, count: b.count, sx: c0.x, sy: c0.y } });
          }
        }
      }
    }
    swarm.commit(slot, clock, ppu);
    if (!haloDrawn) halo.hide();
    halo.commit(clock, ppu);
    drawn = slot;
    labels.update(labelItems);
    shelves.update(shelfItems);

    // Las superficies se proyectan antes que los pipes: el tirante de una
    // superficie sigue a si se dibuja o no (`MediaRect.shown`) este fotograma.
    media.reproject();
    buildPipes(wallNow);
    pipes.step(dt);
    ground.update(cx, cy, camera.pxPerUnit(GROUND_Z), renderer.domElement.width, renderer.domElement.height);
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
  // the browser only offers the drop if the dragover is claimed. A file from
  // the desktop is claimed the same way; the tile under it is the target.
  const carriesFiles = (dt: DataTransfer | null) => !!dt && [...dt.types].includes('Files');
  root.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes(ART_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      return;
    }
    if (!carriesFiles(e.dataTransfer) || !ev.onDropFiles) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    // No pointermove arrives during a native drag; the hover follows from here.
    const hit = pickAt(e.clientX, e.clientY);
    const id = hit?.kind === 'agent' ? hit.id : null;
    if (id !== hover) { hover = id; ev.onHover(id); }
  });
  root.addEventListener('dragleave', (e) => {
    if (!carriesFiles(e.dataTransfer) || !hover) return;
    if (root.contains(e.relatedTarget as Node | null)) return;
    hover = null; ev.onHover(null);
  });
  root.addEventListener('drop', (e) => {
    const id = e.dataTransfer?.getData(ART_MIME);
    if (id) {
      e.preventDefault();
      dropArtifactAt(id, e.clientX, e.clientY);
      return;
    }
    if (!carriesFiles(e.dataTransfer) || !ev.onDropFiles) return;
    e.preventDefault();
    if (hover) { hover = null; ev.onHover(null); }
    const hit = pickAt(e.clientX, e.clientY);
    const cpt = toCanvas(e);
    const p = camera.screenToWorld(cpt.x, cpt.y, ART_Z);
    ev.onDropFiles([...e.dataTransfer!.files], hit?.kind === 'agent' ? hit.id : null, e.clientX, e.clientY, { x: p.x, y: p.y, z: ART_Z });
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

  /** The world box a tile stands on: what a flight to it has to keep in the clear. Same extent `screenOf` reports. */
  function tileBox(s: Spot): { minX: number; minY: number; maxX: number; maxY: number } {
    return { minX: s.x - TILE_W / 2, maxX: s.x + TILE_W / 2, minY: s.y - TILE_H / 2, maxY: s.y + TILE_H / 2 };
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
    // Los dos vuelos son gestos para AUTOMEJORA, y se cuentan aquí y no en
    // cada botón que los pide porque aquí es donde el campo decide que fue
    // el operador quien movió la cámara (`userMoved`). Sin el agente ni el
    // punto: sólo que se voló, y a qué clase de cosa.
    flyTo(id, distance = 4.2) {
      const s = layout.spots.get(id);
      if (s) { userMoved = true; gesture('fly', 'agent'); camera.show(tileBox(s), distance); }
    },
    flyToPoint(x, y, distance = 6) { userMoved = true; gesture('fly', 'point'); camera.flyTo(x, y, distance); },
    setObstacles(fn) { camera.setObstacles(fn); },
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
    windowOrigin(id) {
      const s = layout.spots.get(id);
      return s ? { x: s.x + TILE_W / 2, y: s.y + TILE_H / 2 } : null;
    },
    frameWindow(bounds) {
      userMoved = true;
      camera.setTilt(false);
      // Fit the window between the mast and dock, not the fleet around it.
      const ppu = Math.min(Math.max(1, camera.width - 160) / Math.max(0.01, bounds.maxX - bounds.minX),
        Math.max(1, camera.height - 260) / Math.max(0.01, bounds.maxY - bounds.minY));
      const distance = camera.height / (2 * Math.tan(camera.three.fov * Math.PI / 360) * ppu);
      camera.flyTo((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2 + 6 / ppu, distance);
    },
    windowPlane() { return { origin: camera.project(0, 0, 0), ppu: camera.pxPerUnit(0) }; },
    windowProjection(x, y) { return camera.project(x, y, 0); },
    windowPoint(x, y) { return camera.screenToWorld(x, y); },
    screenOf(id) {
      const s = layout.spots.get(id);
      if (!s) return null;
      const a = camera.project(s.x - TILE_W / 2, s.y + TILE_H / 2, s.z);
      const b = camera.project(s.x + TILE_W / 2, s.y - TILE_H / 2, s.z);
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, visible: a.visible || b.visible, ahead: a.ahead && b.ahead };
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
    setExtraMedia(list) { extraMedia = list; dirty = true; },
    /*
     * An artifact goes beside its own agent or it does not go on the field at
     * all. This used to fall back to the camera — it dropped the surface
     * wherever the operator happened to be looking, with nothing under it that
     * explained why it was there, and the placement then kept it there. An
     * artifact outlives its agent by design (`hub/world.ts` evicts by age and
     * by cap, not by the life of whoever made it), so that was not the rare
     * case: it was most of them. Null, and the console says why.
     */
    placeNear(agentId, index) {
      const s = layout.spots.get(agentId);
      if (!s) return null;
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
    frameAgents(ids) {
      const spots = ids.map((id) => layout.spots.get(id)).filter((s): s is Spot => !!s);
      if (!spots.length) return false;
      if (spots.length === 1) { userMoved = true; camera.show(tileBox(spots[0]!), 4.2); return true; }
      userMoved = true;
      camera.frame({
        minX: Math.min(...spots.map((s) => s.x)) - TILE_W, maxX: Math.max(...spots.map((s) => s.x)) + TILE_W,
        minY: Math.min(...spots.map((s) => s.y)) - TILE_H, maxY: Math.max(...spots.map((s) => s.y)) + TILE_H,
      }, 1.3);
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
      swarm.dispose(); pipes.dispose(); halo.dispose(); ground.dispose(); labels.dispose(); media.dispose(); shelves.dispose();
      for (const m of slabs) scene.remove(m);
      slabGeo.dispose(); slabMat.dispose();
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
