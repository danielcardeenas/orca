/**
 * Where everything stands.
 *
 * Projects are regions on a phyllotaxis spiral, so adding a project never
 * moves the ones already there and the operator's memory of "DIJOSI is up and
 * to the left" survives. Inside a region, agents pack into a grid in lineage
 * order — a child is placed right after its parent — so the pipes that join
 * them stay short and readable.
 *
 * A placement the operator made always wins. The automatic layout only ever
 * touches agents nobody has touched.
 *
 * The gaps between cells are not slack: they are the **gutters** every pipe
 * runs in, so the layout publishes its own `gapX`/`gapY` and the router in
 * `pipes.ts` reads them from there — the deck's are wider than the field's.
 *
 * Except in **deck mode**, the comp's align deck: one grid at the origin,
 * every tile in it, ordered by whatever the operator asked to see. There the
 * order *is* the information, so a pinned placement is set aside — kept, not
 * forgotten, and honoured again the moment the field comes back.
 */

import { squadName } from '../../shared/squads.ts';
import type { Agent, AgentState, Placement, Project } from '../../shared/types.ts';

/**
 * Where the operator left a squad.
 *
 * A squad is not a record (`shared/squads.ts`), so it cannot carry a
 * placement the way an agent does; this is the one thing the console keeps
 * about one. `x`/`y` are the centre of the block — the box `layoutFleet`
 * would have packed, shifted to where the hand let go — and the members that
 * have no placement of their own move with it. A member the operator pinned
 * individually keeps its own spot: a placement the operator made always wins.
 */
export interface SquadPlacement {
  projectId: string;
  name: string;
  x: number;
  y: number;
  at: number;
}

/**
 * Where the operator left a project's region: its centre, instead of the
 * spiral slot the layout would have given it. Everything inside — tiles,
 * squads, outline, label — goes with it, the way it does when the spiral
 * moves a region; only a member pinned by hand keeps its own spot.
 */
export interface RegionPlacement {
  projectId: string;
  x: number;
  y: number;
  at: number;
}

/** The key a squad block is filed under: its project and its name. */
export const squadKey = (projectId: string, name: string) => `${projectId}\u0000${name}`;

export const TILE_W = 1.0;
export const TILE_H = 0.78;
export const GAP_X = 0.24;
export const GAP_Y = 0.26;
/** The deck breathes a little more than a region, the way the comp's does. */
export const DECK_GAP_X = 0.3;
export const DECK_GAP_Y = 0.32;
/** Padding between a region's tiles and its outline. */
const RGN_PAD = 0.55;
/** Golden angle. */
const PHI = 2.399963;

export interface Spot {
  id: string;
  /** Current, eased. */
  x: number; y: number; z: number;
  /** Target the field eases toward. */
  tx: number; ty: number; tz: number;
  pinned: boolean;
  projectId: string;
}

/**
 * A squad's footprint inside a region: the bounding box of the cells its
 * members took, with the lead in the first one. The field draws a rótulo over
 * it and a `toSquad` message lands on it, the way a project message lands on
 * its region label.
 */
export interface SquadBlock {
  /** The squad's name — the value every member carries in `squad`. */
  name: string;
  projectId: string;
  count: number;
  /** Lead's agent id, when one is marked. */
  leadId: string | null;
  cx: number; cy: number;
  hw: number; hh: number;
  /** True when the block stands where the operator dragged it, not where the grid put it. */
  moved: boolean;
}

export interface Region {
  id: string;
  code: string;
  name: string;
  machineId: string;
  cx: number; cy: number;
  hw: number; hh: number;
  count: number;
  blocked: number;
  /** Squads standing inside this region, in the order they were packed. */
  squads: SquadBlock[];
  /** True when the region stands where the operator dragged it, not on the spiral. */
  moved: boolean;
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

/** What the deck is ordered by. The order is the whole point of the mode. */
export type DeckSort = 'state' | 'project' | 'cost' | 'age';

/**
 * Two ways to stand the fleet up.
 *
 * `field` is the console's home: projects as regions on a spiral, lineage
 * packed inside, the operator's placements on top. `deck` is the comp's
 * align deck: one grid at the origin, nothing pinned, read in order.
 */
export type LayoutMode =
  | { kind: 'field' }
  | { kind: 'deck'; sort: DeckSort };

export interface Layout {
  spots: Map<string, Spot>;
  regions: Region[];
  /** Spiral slot per project — persists so a project keeps its place. */
  order: Map<string, number>;
  bounds: Bounds;
  /**
   * The gutters this layout left between tiles. Pipes are routed through them
   * (`routeGutter`), and the deck's are wider than the field's, so the router
   * reads them off the layout instead of the constants.
   */
  gapX: number;
  gapY: number;
}

export function emptyLayout(): Layout {
  return {
    spots: new Map(), regions: [], order: new Map(),
    bounds: { minX: -6, minY: -4, maxX: 6, maxY: 4 },
    gapX: GAP_X, gapY: GAP_Y,
  };
}

/**
 * Depth from what the agent is doing. Front to back: needs a human, working,
 * thinking, booting, waiting on a peer, idle, done, dead.
 */
export function depthOf(a: Agent): number {
  switch (a.state) {
    case 'blocked': return a.block?.kind === 'peer' ? 0.12 : 0.42;
    case 'working': return 0.16 + Math.min(1, a.metrics.tokensPerSec / 80) * 0.12;
    case 'thinking': return 0.1;
    case 'booting': return 0.06;
    case 'idle': return -0.18;
    case 'done': return -0.5;
    case 'dead': return -0.7;
  }
}

export function layoutFleet(
  agents: Agent[],
  projects: Map<string, Project>,
  placements: Map<string, Placement>,
  prev: Layout,
  mode: LayoutMode = { kind: 'field' },
  squadPlacements: Map<string, SquadPlacement> = new Map(),
  regionPlacements: Map<string, RegionPlacement> = new Map(),
): Layout {
  if (mode.kind === 'deck') return layoutDeck(agents, projects, prev, mode.sort);
  const order = prev.order;
  const spots = new Map<string, Spot>();
  const regions: Region[] = [];

  /* ── Group by project, lineage order inside ─────────────────────── */
  const byProject = new Map<string, Agent[]>();
  for (const a of agents) {
    const list = byProject.get(a.projectId);
    if (list) list.push(a); else byProject.set(a.projectId, [a]);
  }
  // Projects that have gone quiet keep their slot; new ones take the next.
  const ids = [...byProject.keys()].sort((p, q) => (projects.get(p)?.name ?? p).localeCompare(projects.get(q)?.name ?? q));
  for (const id of ids) if (!order.has(id)) order.set(id, order.size);

  /* ── Size every region first: the spiral spacing depends on the largest ── */
  const sized = ids.map((id) => {
    const list = squadOrder(lineageOrder(byProject.get(id)!));
    const n = list.length;
    const cols = Math.max(2, Math.min(12, Math.ceil(Math.sqrt(n * 1.35))));
    const cells = packCells(list, cols);
    const rows = Math.max(1, Math.ceil(((cells[cells.length - 1] ?? 0) + 1) / cols));
    const w = cols * TILE_W + (cols - 1) * GAP_X + RGN_PAD * 2;
    const h = rows * TILE_H + (rows - 1) * GAP_Y + RGN_PAD * 2 + 0.5; // room for the label
    return { id, list, cells, cols, rows, w, h };
  });
  const maxDiag = sized.reduce((m, s) => Math.max(m, Math.hypot(s.w, s.h)), 4);
  const spacing = maxDiag * 0.78 + 1.2;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const s of sized) {
    const slot = order.get(s.id) ?? 0;
    const r = spacing * Math.sqrt(slot);
    const ang = slot * PHI;
    // The spiral only places what nobody has placed.
    const placedRegion = regionPlacements.get(s.id);
    const cx = placedRegion ? placedRegion.x : Math.round(Math.cos(ang) * r * 2) / 2;
    const cy = placedRegion ? placedRegion.y : Math.round(Math.sin(ang) * r * 2) / 2;

    const p = projects.get(s.id);
    const region: Region = {
      id: s.id,
      code: p?.code ?? '??',
      name: p?.name ?? s.id,
      machineId: p?.machineId ?? '',
      cx, cy, hw: s.w / 2, hh: s.h / 2,
      count: s.list.length,
      blocked: 0,
      squads: [],
      moved: !!placedRegion,
    };
    regions.push(region);

    const x0 = cx - s.w / 2 + RGN_PAD + TILE_W / 2;
    const y0 = cy + s.h / 2 - RGN_PAD - 0.5 - TILE_H / 2;

    /*
     * Two passes. The grid is laid first, so every squad's box is known
     * before any tile is placed; then a squad the operator moved shifts its
     * whole box — members and outline together — by one offset, and only
     * then do the tiles land. A block that followed one dragged member would
     * stop naming a block, so the box is always the *cells*, never where a
     * pinned tile wandered off to.
     */
    const cells = s.list.map((a, i) => {
      const cell = s.cells[i] ?? i;
      const col = cell % s.cols, row = Math.floor(cell / s.cols);
      return { a, gx: x0 + col * (TILE_W + GAP_X), gy: y0 - row * (TILE_H + GAP_Y) };
    });
    const boxes = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; n: number; lead: string | null }>();
    for (const { a, gx, gy } of cells) {
      const sq = squadOf(a);
      if (!sq) continue;
      const b = boxes.get(sq);
      if (!b) boxes.set(sq, { minX: gx, minY: gy, maxX: gx, maxY: gy, n: 1, lead: isLead(a) ? a.id : null });
      else {
        b.minX = Math.min(b.minX, gx); b.maxX = Math.max(b.maxX, gx);
        b.minY = Math.min(b.minY, gy); b.maxY = Math.max(b.maxY, gy);
        b.n++;
        if (isLead(a)) b.lead = a.id;
      }
    }
    const shift = new Map<string, { dx: number; dy: number }>();
    for (const [name, b] of boxes) {
      const p = squadPlacements.get(squadKey(s.id, name));
      if (!p) continue;
      shift.set(name, { dx: p.x - (b.minX + b.maxX) / 2, dy: p.y - (b.minY + b.maxY) / 2 });
    }

    for (const { a, gx, gy } of cells) {
      if (a.state === 'blocked' && a.block?.kind !== 'peer') region.blocked++;
      const sq = squadOf(a);
      const off = sq ? shift.get(sq) : undefined;
      let tx = gx + (off?.dx ?? 0);
      let ty = gy + (off?.dy ?? 0);
      const tz = depthOf(a);
      const placed = placements.get(a.id);
      let pinned = false;
      if (placed?.pinned) { tx = placed.x; ty = placed.y; pinned = true; }

      const old = prev.spots.get(a.id);
      const spot: Spot = old
        ? { ...old, tx, ty, tz, pinned, projectId: a.projectId }
        : { id: a.id, x: tx, y: ty, z: tz, tx, ty, tz, pinned, projectId: a.projectId };
      spots.set(a.id, spot);

      minX = Math.min(minX, tx - TILE_W); maxX = Math.max(maxX, tx + TILE_W);
      minY = Math.min(minY, ty - TILE_H); maxY = Math.max(maxY, ty + TILE_H);
    }

    for (const [name, b] of boxes) {
      const off = shift.get(name);
      region.squads.push({
        name,
        projectId: s.id,
        count: b.n,
        leadId: b.lead,
        cx: (b.minX + b.maxX) / 2 + (off?.dx ?? 0),
        cy: (b.minY + b.maxY) / 2 + (off?.dy ?? 0),
        hw: (b.maxX - b.minX) / 2 + TILE_W / 2,
        hh: (b.maxY - b.minY) / 2 + TILE_H / 2,
        moved: !!off,
      });
    }

    minX = Math.min(minX, cx - s.w / 2); maxX = Math.max(maxX, cx + s.w / 2);
    minY = Math.min(minY, cy - s.h / 2); maxY = Math.max(maxY, cy + s.h / 2);
  }

  const bounds: Bounds = Number.isFinite(minX)
    ? { minX, minY, maxX, maxY }
    : { minX: -6, minY: -4, maxX: 6, maxY: 4 };

  return { spots, regions, order, bounds, gapX: GAP_X, gapY: GAP_Y };
}

/* ── Deck ─────────────────────────────────────────────────────────── */

/**
 * How far up the deck a state stands when the sort is `state`. Front of the
 * list is what a person has to look at: an escalation you can answer, then a
 * permission somebody has to grant, then the fleet working down to the dead.
 * A wait on another agent sits below every live state — it is real, but it is
 * not yours.
 */
const STATE_RANK: Record<AgentState, number> = {
  blocked: 0, working: 2, thinking: 3, booting: 4, idle: 6, done: 7, dead: 8,
};
function rankOf(a: Agent): number {
  if (a.state !== 'blocked' || !a.block) return STATE_RANK[a.state];
  if (a.block.kind === 'peer') return 5;
  // An escalation is a question this console can answer; everything else
  // blocked is a prompt waiting in somebody's terminal.
  return a.block.escalationId ? 0 : 1;
}

/** Same order every time for the same fleet: the deck must not shuffle itself. */
function tieBreak(p: Agent, q: Agent): number {
  return p.startedAt - q.startedAt || p.id.localeCompare(q.id);
}

function deckOrder(agents: Agent[], projects: Map<string, Project>, sort: DeckSort): Agent[] {
  const list = [...agents];
  const byState = (p: Agent, q: Agent) =>
    rankOf(p) - rankOf(q)
    // Inside `working`, the fastest first: the deck's top row is the fleet's speed.
    || (p.state === 'working' && q.state === 'working' ? q.metrics.tokensPerSec - p.metrics.tokensPerSec : 0)
    || tieBreak(p, q);
  switch (sort) {
    case 'project': {
      const code = (a: Agent) => projects.get(a.projectId)?.code ?? a.projectId;
      list.sort((p, q) => code(p).localeCompare(code(q)) || byState(p, q));
      break;
    }
    case 'cost':
      list.sort((p, q) => q.metrics.costUSD - p.metrics.costUSD || tieBreak(p, q));
      break;
    case 'age':
      list.sort(tieBreak);
      break;
    default:
      list.sort(byState);
  }
  return list;
}

/**
 * The comp's align deck: one grid centred on the origin, everything in it,
 * read left to right and top to bottom in the order the sort asked for.
 *
 * `1.6` makes the grid wider than it is tall, because the viewport is, so a
 * framed deck fills the screen instead of leaving two dark columns. Nothing
 * is pinned here — a placement the operator made is kept in `placements` and
 * comes back with the field — and there are no regions: a grid that carries
 * one project per band would be a second layout arguing with the sort.
 *
 * Only `tx`/`ty` move. An existing spot keeps the `x`/`y` it is drawn at, so
 * the change of mode is the field sliding into formation, not a cut.
 */
function layoutDeck(agents: Agent[], projects: Map<string, Project>, prev: Layout, sort: DeckSort): Layout {
  const spots = new Map<string, Spot>();
  const list = deckOrder(agents, projects, sort);
  const n = list.length;
  if (!n) return { spots, regions: [], order: prev.order, bounds: emptyLayout().bounds, gapX: DECK_GAP_X, gapY: DECK_GAP_Y };

  const cols = Math.max(4, Math.min(40, Math.ceil(Math.sqrt(n * 1.6))));
  const rows = Math.ceil(n / cols);
  const w = cols * TILE_W + (cols - 1) * DECK_GAP_X;
  const h = rows * TILE_H + (rows - 1) * DECK_GAP_Y;
  const x0 = -w / 2 + TILE_W / 2;
  const y0 = h / 2 - TILE_H / 2;

  list.forEach((a, i) => {
    const tx = x0 + (i % cols) * (TILE_W + DECK_GAP_X);
    const ty = y0 - Math.floor(i / cols) * (TILE_H + DECK_GAP_Y);
    const tz = depthOf(a);
    const old = prev.spots.get(a.id);
    spots.set(a.id, old
      ? { ...old, tx, ty, tz, pinned: false, projectId: a.projectId }
      : { id: a.id, x: tx, y: ty, z: tz, tx, ty, tz, pinned: false, projectId: a.projectId });
  });

  const bounds: Bounds = {
    minX: x0 - TILE_W, maxX: x0 + (cols - 1) * (TILE_W + DECK_GAP_X) + TILE_W,
    minY: y0 - (rows - 1) * (TILE_H + DECK_GAP_Y) - TILE_H, maxY: y0 + TILE_H,
  };
  return { spots, regions: [], order: prev.order, bounds, gapX: DECK_GAP_X, gapY: DECK_GAP_Y };
}

/* ── Squads ───────────────────────────────────────────────────────── */

/*
 * A collector that has not shipped squads yet sends neither field, so both are
 * read off the side: a fleet without squads lays out exactly as it did before.
 * `squadName` is `shared/squads.ts`'s, so the console groups agents by the same
 * rule the hub routes them by.
 */
export function squadOf(a: Agent): string | null {
  return squadName((a as { squad?: unknown }).squad);
}
export function isLead(a: Agent): boolean {
  return (a as { lead?: boolean }).lead === true;
}

/**
 * Which grid cell each agent takes, once squads are allowed to break the flow.
 *
 * A squad that wraps a row is not a block: its bounding box would swallow the
 * tiles on either side of the break and its rótulo would name a stranger. So a
 * squad that would straddle a row start is pushed to the next one, and the
 * remainder of the row it ends in is left empty. The cells that costs are the
 * price of the block reading as one thing, which is the whole point of it.
 *
 * `squadOrder` has already made each squad contiguous in `list`.
 */
function packCells(list: Agent[], cols: number): number[] {
  const cells: number[] = [];
  let cell = 0;
  let i = 0;
  while (i < list.length) {
    const sq = squadOf(list[i]!);
    if (!sq) { cells.push(cell++); i++; continue; }
    let n = 0;
    while (i + n < list.length && squadOf(list[i + n]!) === sq) n++;
    const col = cell % cols;
    if (col !== 0 && n <= cols && col + n > cols) cell += cols - col;
    for (let k = 0; k < n; k++) cells.push(cell++);
    i += n;
    if (cell % cols !== 0) cell += cols - (cell % cols);
  }
  return cells;
}

/**
 * A squad stands together, lead first.
 *
 * Lineage order already packs a child behind its parent, which is right for a
 * tree and wrong for a squadron: members spawned by different parents would
 * end up scattered across the region and the block would not read as one
 * unit. So the squad is lifted out at the position of its first member and
 * laid down contiguously — the lead in the first cell, everyone else behind
 * it in the order lineage gave them. Everything without a squad keeps the
 * place lineage put it in.
 */
function squadOrder(list: Agent[]): Agent[] {
  let any = false;
  for (const a of list) if (squadOf(a)) { any = true; break; }
  if (!any) return list;

  const groups = new Map<string, Agent[]>();
  for (const a of list) {
    const s = squadOf(a);
    if (!s) continue;
    const g = groups.get(s);
    if (g) g.push(a); else groups.set(s, [a]);
  }
  // Two agents claiming the lead is a bug upstream, not a reason to lose the
  // block: the oldest leads, which is `squadsOf`'s rule too.
  for (const g of groups.values()) {
    let li = -1;
    for (let i = 0; i < g.length; i++) {
      const a = g[i]!;
      if (!isLead(a)) continue;
      const cur = li < 0 ? null : g[li]!;
      if (!cur || a.startedAt < cur.startedAt || (a.startedAt === cur.startedAt && a.id < cur.id)) li = i;
    }
    if (li > 0) g.unshift(...g.splice(li, 1));
  }

  const out: Agent[] = [];
  const done = new Set<string>();
  for (const a of list) {
    const s = squadOf(a);
    if (!s) { out.push(a); continue; }
    if (done.has(s)) continue;
    done.add(s);
    out.push(...groups.get(s)!);
  }
  return out;
}

/**
 * Roots by age, each followed by its descendants depth-first. A child lands
 * right after its parent, so lineage pipes are one cell long.
 */
function lineageOrder(list: Agent[]): Agent[] {
  const byId = new Map(list.map((a) => [a.id, a]));
  const kids = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const a of list) {
    if (a.parentId && byId.has(a.parentId)) {
      const k = kids.get(a.parentId);
      if (k) k.push(a); else kids.set(a.parentId, [a]);
    } else {
      roots.push(a);
    }
  }
  const byAge = (p: Agent, q: Agent) => p.startedAt - q.startedAt;
  roots.sort(byAge);
  const out: Agent[] = [];
  const seen = new Set<string>();
  const walk = (a: Agent) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    out.push(a);
    for (const c of (kids.get(a.id) ?? []).sort(byAge)) walk(c);
  };
  for (const r of roots) walk(r);
  // A cycle would be a collector bug, but a layout cannot lose an agent over it.
  for (const a of list) if (!seen.has(a.id)) { seen.add(a.id); out.push(a); }
  return out;
}
