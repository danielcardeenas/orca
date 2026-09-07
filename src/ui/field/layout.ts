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
import { OFF_FLEET_LABEL, islandOf, isOffFleet } from '../../shared/workspaces.ts';
import type { Agent, AgentState, Placement, Project } from '../../shared/types.ts';
import { TRAY_CELLS } from './blocks.ts';

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
/**
 * Air between a squad's tiles and its outline, and between a block's tiles
 * and its frame. Both live inside the gutter (`GAP_X` 0.24 wide), and the
 * block's is the smaller so that a block standing inside a squad shows two
 * frames, not one drawn twice. A frame flush against a tile's edge read as
 * the tile's own border, and a tile touching it read as sticking out.
 */
export const SQUAD_PAD = 0.15;
export const BLOCK_PAD = 0.08;
/**
 * CAPCOM's tile, against a worker's. Bigger, not huge: it has to read as the
 * command from the zoom where a region is a block, and still be one tile of
 * the same silhouette up close — the colour does the rest (§1.3).
 */
export const CAPCOM_SCALE = 1.4;
/** Air CAPCOM keeps from any region or pinned tile: about a gutter and a half. */
export const CAPCOM_CLEAR = 0.4;
/** Golden angle. */
const PHI = 2.399963;

/*
 * A tray: one grid cell next to a parent, holding the children folded into
 * its block (`blocks.ts`) as small cells — three across, two down, each a
 * tile at `CELL_SCALE`. The header strip above them is where the field
 * writes the parent's callsign and the count.
 */
export const CELL_SCALE = 0.3;
const TRAY_INSET = 0.04;
const TRAY_GAP = 0.02;

/**
 * How the cells fill the tray, by how many there are. One child is not a
 * speck in an empty cell: it gets most of the tray. Six are the comp's 3 × 2
 * at `CELL_SCALE`. The scale is what the shader, the labels and the picker
 * see, so a lone subagent is readable two zoom steps before six would be.
 */
export function trayGrid(n: number): { cols: number; scale: number } {
  if (n <= 1) return { cols: 1, scale: 0.62 };
  if (n === 2) return { cols: 2, scale: 0.44 };
  if (n <= 4) return { cols: 2, scale: 0.42 };
  return { cols: 3, scale: CELL_SCALE };
}

export interface Spot {
  id: string;
  /** Current, eased. */
  x: number; y: number; z: number;
  /** Target the field eases toward. */
  tx: number; ty: number; tz: number;
  pinned: boolean;
  projectId: string;
  /** 1 for a tile; `CELL_SCALE` for a child standing in its parent's tray. */
  scale: number;
  /** The parent whose tray this spot stands in, or null for a tile. */
  trayOf: string | null;
}

/** A parent's tray: the cell it occupies and who stands in it. */
export interface Tray {
  parentId: string;
  projectId: string;
  cx: number; cy: number;
  hw: number; hh: number;
  /** The children in it, in tray order. */
  ids: string[];
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
  /**
   * True para la isla de fuera de la flota: el directorio del mando, sus
   * runtimes de relevo y los scratchpads de sesión. No es un proyecto y se
   * dibuja como lo que es —apagada, al margen— para que quien mira el campo no
   * la lea como una isla más. Ver `shared/workspaces.ts`.
   */
  offFleet: boolean;
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
  /** Trays of folded children, one per parent (two when it has more than `TRAY_CELLS`). */
  trays: Tray[];
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
    spots: new Map(), regions: [], trays: [], order: new Map(),
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
  absorbed: Map<string, string> = new Map(),
): Layout {
  if (mode.kind === 'deck') return layoutDeck(agents, projects, prev, mode.sort);
  const order = prev.order;
  const spots = new Map<string, Spot>();
  const regions: Region[] = [];
  const trays: Tray[] = [];

  /*
   * Folded children (`blocks.ts`) do not take a grid cell: they stand in
   * their parent's tray. A child the operator pinned by hand is a tile
   * wherever the rule put it — a placement the operator made always wins.
   */
  const kidsOf = new Map<string, Agent[]>();
  const folded = new Set<string>();
  for (const a of agents) {
    const pid = absorbed.get(a.id);
    if (!pid || placements.get(a.id)?.pinned) continue;
    folded.add(a.id);
    const k = kidsOf.get(pid);
    if (k) k.push(a); else kidsOf.set(pid, [a]);
  }
  for (const k of kidsOf.values()) k.sort((p, q) => p.startedAt - q.startedAt || p.id.localeCompare(q.id));

  /*
   * CAPCOM is not in a project. It is the command, and it stands at the
   * origin of the spiral with every region around it — the one tile the
   * operator can always find by zooming out. Its own directory on disk is a
   * home, not a repo, so it never earns a region of its own; a worker that
   * strayed in there still does, which is how a stray shows.
   */
  const capcom = agents.find((a) => a.role === 'capcom') ?? null;

  /* ── Group by project, lineage order inside ─────────────────────── */
  const byProject = new Map<string, Agent[]>();
  for (const a of agents) {
    if (folded.has(a.id) || a === capcom) continue;
    const list = byProject.get(islandOf(a));
    if (list) list.push(a); else byProject.set(islandOf(a), [a]);
  }
  const countOf = new Map<string, number>();
  for (const a of agents) if (a !== capcom) countOf.set(islandOf(a), (countOf.get(islandOf(a)) ?? 0) + 1);
  // Projects that have gone quiet keep their slot; new ones take the next.
  const ids = [...byProject.keys()].sort((p, q) => (projects.get(p)?.name ?? p).localeCompare(projects.get(q)?.name ?? q));
  for (const id of ids) if (!order.has(id)) order.set(id, order.size);

  /* ── Size every region first: the spiral spacing depends on the largest ── */
  const sized = ids.map((id) => {
    const list = withTrays(squadOrder(lineageOrder(byProject.get(id)!)), kidsOf);
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
    // Slot 0 is one ring out: the centre of the spiral is the command's.
    const r = spacing * Math.sqrt(slot + 1);
    const ang = slot * PHI;
    // The spiral only places what nobody has placed.
    const placedRegion = regionPlacements.get(s.id);
    const cx = placedRegion ? placedRegion.x : Math.round(Math.cos(ang) * r * 2) / 2;
    const cy = placedRegion ? placedRegion.y : Math.round(Math.sin(ang) * r * 2) / 2;

    const p = projects.get(s.id);
    // La isla de fuera de la flota no tiene proyecto del que sacar rótulo: lo
    // trae puesto. El id crudo sólo queda para lo que no es ni una cosa ni la
    // otra, que es un proyecto que aún no ha llegado en el snapshot.
    const off = !p && isOffFleet(s.id);
    const region: Region = {
      id: s.id,
      code: p?.code ?? (off ? OFF_FLEET_LABEL.code : '??'),
      name: p?.name ?? (off ? OFF_FLEET_LABEL.name : s.id),
      offFleet: off,
      machineId: p?.machineId ?? s.id.slice(0, Math.max(0, s.id.indexOf('/'))),
      cx, cy, hw: s.w / 2, hh: s.h / 2,
      count: countOf.get(s.id) ?? 0,
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
    const cells = s.list.map((e, i) => {
      const cell = s.cells[i] ?? i;
      const col = cell % s.cols, row = Math.floor(cell / s.cols);
      return { e, gx: x0 + col * (TILE_W + GAP_X), gy: y0 - row * (TILE_H + GAP_Y) };
    });
    const boxes = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; n: number; lead: string | null }>();
    for (const { e, gx, gy } of cells) {
      const sq = entrySquad(e);
      if (!sq) continue;
      // A tray is in the squad's box but is not a member: it counts nobody.
      const a = e.kind === 'tile' ? e.a : null;
      const b = boxes.get(sq);
      if (!b) boxes.set(sq, { minX: gx, minY: gy, maxX: gx, maxY: gy, n: a ? 1 : 0, lead: a && isLead(a) ? a.id : null });
      else {
        b.minX = Math.min(b.minX, gx); b.maxX = Math.max(b.maxX, gx);
        b.minY = Math.min(b.minY, gy); b.maxY = Math.max(b.maxY, gy);
        if (a) { b.n++; if (isLead(a)) b.lead = a.id; }
      }
    }
    const shift = new Map<string, { dx: number; dy: number }>();
    for (const [name, b] of boxes) {
      const p = squadPlacements.get(squadKey(s.id, name));
      if (!p) continue;
      shift.set(name, { dx: p.x - (b.minX + b.maxX) / 2, dy: p.y - (b.minY + b.maxY) / 2 });
    }

    for (const { e, gx, gy } of cells) {
      const sq = entrySquad(e);
      const off = sq ? shift.get(sq) : undefined;
      let tx = gx + (off?.dx ?? 0);
      let ty = gy + (off?.dy ?? 0);

      if (e.kind === 'tray') {
        /*
         * The tray stands in the cell the grid gave it — unless the operator
         * pinned the parent, in which case it goes with the parent: a block
         * whose tray stayed behind in the grid would name nobody.
         */
        const ps = spots.get(e.parent.id);
        if (ps?.pinned) { tx = ps.tx + (e.index + 1) * (TILE_W + GAP_X); ty = ps.ty; }
        trays.push({ parentId: e.parent.id, projectId: s.id, cx: tx, cy: ty, hw: TILE_W / 2, hh: TILE_H / 2, ids: e.kids.map((k) => k.id) });
        // Cells centred in the tray, as many across as the count calls for.
        const g = trayGrid(e.kids.length);
        const cw = TILE_W * g.scale, ch = TILE_H * g.scale;
        const rows = Math.ceil(e.kids.length / g.cols);
        const gridW = g.cols * cw + (g.cols - 1) * TRAY_GAP;
        const gridH = rows * ch + (rows - 1) * TRAY_GAP;
        const left = tx - gridW / 2 + cw / 2;
        const top = ty + gridH / 2 - ch / 2;
        e.kids.forEach((k, i) => {
          const col = i % g.cols, row = Math.floor(i / g.cols);
          const kx = left + col * (cw + TRAY_GAP);
          const ky = top - row * (ch + TRAY_GAP);
          const kz = depthOf(k);
          const old = prev.spots.get(k.id);
          spots.set(k.id, old
            ? { ...old, tx: kx, ty: ky, tz: kz, pinned: false, projectId: islandOf(k), scale: g.scale, trayOf: e.parent.id }
            : { id: k.id, x: kx, y: ky, z: kz, tx: kx, ty: ky, tz: kz, pinned: false, projectId: islandOf(k), scale: g.scale, trayOf: e.parent.id });
        });
        void TRAY_INSET;
        minX = Math.min(minX, tx - TILE_W); maxX = Math.max(maxX, tx + TILE_W);
        minY = Math.min(minY, ty - TILE_H); maxY = Math.max(maxY, ty + TILE_H);
        continue;
      }

      const a = e.a;
      if (a.state === 'blocked' && a.block?.kind !== 'peer') region.blocked++;
      const tz = depthOf(a);
      const placed = placements.get(a.id);
      let pinned = false;
      if (placed?.pinned) { tx = placed.x; ty = placed.y; pinned = true; }

      const old = prev.spots.get(a.id);
      const spot: Spot = old
        ? { ...old, tx, ty, tz, pinned, projectId: islandOf(a), scale: 1, trayOf: null }
        : { id: a.id, x: tx, y: ty, z: tz, tx, ty, tz, pinned, projectId: islandOf(a), scale: 1, trayOf: null };
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
        hw: (b.maxX - b.minX) / 2 + TILE_W / 2 + SQUAD_PAD,
        hh: (b.maxY - b.minY) / 2 + TILE_H / 2 + SQUAD_PAD,
        moved: !!off,
      });
    }

    minX = Math.min(minX, cx - s.w / 2); maxX = Math.max(maxX, cx + s.w / 2);
    minY = Math.min(minY, cy - s.h / 2); maxY = Math.max(maxY, cy + s.h / 2);
  }

  if (capcom) {
    /*
     * The origin is CAPCOM's. The spiral never reaches it (slot 0 is a ring
     * out), but a region or a tile the operator dragged can: then CAPCOM
     * steps out of the way, straight up, to the first clear spot — it stands
     * beside the fleet, never inside a project or a squad. Pinned by hand it
     * goes where the hand left it: a placement the operator made always wins.
     */
    const placed = placements.get(capcom.id);
    const pinned = placed?.pinned === true;
    const hw = TILE_W / 2 * CAPCOM_SCALE + CAPCOM_CLEAR, hh = TILE_H / 2 * CAPCOM_SCALE + CAPCOM_CLEAR;
    const boxes: { minX: number; minY: number; maxX: number; maxY: number }[] = regions
      .map((r) => ({ minX: r.cx - r.hw, minY: r.cy - r.hh, maxX: r.cx + r.hw, maxY: r.cy + r.hh }));
    for (const sp of spots.values()) {
      if (!sp.pinned) continue;
      boxes.push({ minX: sp.tx - TILE_W / 2, minY: sp.ty - TILE_H / 2, maxX: sp.tx + TILE_W / 2, maxY: sp.ty + TILE_H / 2 });
    }
    const covering = (x: number, y: number) =>
      boxes.filter((b) => x + hw > b.minX && x - hw < b.maxX && y + hh > b.minY && y - hh < b.maxY);
    let tx = pinned ? placed!.x : 0, ty = pinned ? placed!.y : 0;
    if (!pinned) {
      for (let i = 0; i < 32; i++) {
        const hit = covering(tx, ty);
        if (hit.length === 0) break;
        ty = Math.max(...hit.map((b) => b.maxY)) + hh;
      }
    }
    const tz = depthOf(capcom);
    const old = prev.spots.get(capcom.id);
    spots.set(capcom.id, old
      ? { ...old, tx, ty, tz, pinned, projectId: islandOf(capcom), scale: CAPCOM_SCALE, trayOf: null }
      : { id: capcom.id, x: tx, y: ty, z: tz, tx, ty, tz, pinned, projectId: islandOf(capcom), scale: CAPCOM_SCALE, trayOf: null });
    minX = Math.min(minX, tx - hw); maxX = Math.max(maxX, tx + hw);
    minY = Math.min(minY, ty - hh); maxY = Math.max(maxY, ty + hh);
  }

  const bounds: Bounds = Number.isFinite(minX)
    ? { minX, minY, maxX, maxY }
    : { minX: -6, minY: -4, maxX: 6, maxY: 4 };

  return { spots, regions, trays, order, bounds, gapX: GAP_X, gapY: GAP_Y };
}

/* ── Blocks: a parent's trays follow it into the grid ─────────────── */

/** What takes a grid cell: a tile, or a tray of a parent's folded children. */
type Entry =
  | { kind: 'tile'; a: Agent }
  | { kind: 'tray'; parent: Agent; kids: Agent[]; index: number };

/** The squad an entry stands in: a tray stands in its parent's. */
function entrySquad(e: Entry): string | null {
  return squadOf(e.kind === 'tile' ? e.a : e.parent);
}

/**
 * Lineage order already puts a child right after its parent; a tray goes in
 * the same place, one per `TRAY_CELLS` children, so the block is the parent's
 * tile and the cell (or two) beside it.
 */
function withTrays(list: Agent[], kidsOf: Map<string, Agent[]>): Entry[] {
  const out: Entry[] = [];
  for (const a of list) {
    out.push({ kind: 'tile', a });
    const kids = kidsOf.get(a.id);
    if (!kids) continue;
    for (let i = 0; i < kids.length; i += TRAY_CELLS) {
      out.push({ kind: 'tray', parent: a, kids: kids.slice(i, i + TRAY_CELLS), index: i / TRAY_CELLS });
    }
  }
  return out;
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
  if (!n) return { spots, regions: [], trays: [], order: prev.order, bounds: emptyLayout().bounds, gapX: DECK_GAP_X, gapY: DECK_GAP_Y };

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
      ? { ...old, tx, ty, tz, pinned: false, projectId: islandOf(a), scale: 1, trayOf: null }
      : { id: a.id, x: tx, y: ty, z: tz, tx, ty, tz, pinned: false, projectId: islandOf(a), scale: 1, trayOf: null });
  });

  const bounds: Bounds = {
    minX: x0 - TILE_W, maxX: x0 + (cols - 1) * (TILE_W + DECK_GAP_X) + TILE_W,
    minY: y0 - (rows - 1) * (TILE_H + DECK_GAP_Y) - TILE_H, maxY: y0 + TILE_H,
  };
  return { spots, regions: [], trays: [], order: prev.order, bounds, gapX: DECK_GAP_X, gapY: DECK_GAP_Y };
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
function packCells(list: Entry[], cols: number): number[] {
  const cells: number[] = [];
  let cell = 0;
  let i = 0;
  while (i < list.length) {
    const sq = entrySquad(list[i]!);
    if (!sq) { cells.push(cell++); i++; continue; }
    let n = 0;
    while (i + n < list.length && entrySquad(list[i + n]!) === sq) n++;
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
