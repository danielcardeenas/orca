/**
 * The fleet's timeline, client side.
 *
 * Three things: two fetches against `/api/history`, and the pure function that
 * turns one snapshot back into a `WorldState` the field can draw.
 *
 * The snapshot is deliberately thin — six values per agent — so this rebuilds
 * the rest from the *live* world: projects, machines, placements and whatever
 * the agent's row still says today. That is the honest split. Where the agent
 * stood and what project it belonged to are facts we kept; its last tool call
 * and what it said are not, and inventing them would put words in the past's
 * mouth. Replay draws state, colour, speed, regions and lineage. Nothing else.
 *
 * ── WHAT MAIN.TS HAS TO WIRE ───────────────────────────────────────────
 * Nothing here. This module is imported by the timeline window. The console
 * surface it needs is:
 *
 *   Console.setReplay(world: WorldState | null): void
 *   Console.openTimeline(): void
 *
 * See `src/ui/windows/kinds/timeline.ts` for the exact shape of both.
 */

import type { Agent, Project, WorldState } from '../shared/types.ts';
import { ceilingTokens } from '../shared/tokens.ts';
import { emptyRollup, emptyWorld } from '../shared/types.ts';
import type { HistoryRange, HistorySummary, Snapshot } from '../hub/history.ts';

export type { HistoryRange, HistorySummary, Snapshot, SummaryRow } from '../hub/history.ts';

/**
 * The console token, the same one `net/client.ts` puts on the socket.
 *
 * Read straight from localStorage rather than imported: `authedUrl` there keeps
 * its own private copy of this, and exporting it would make a fetch helper
 * depend on the socket module for no reason. The URL form (`?k=…`) is handled
 * once, by the link, before anything here ever runs.
 */
function token(): string {
  try { return localStorage.getItem('orca.token') ?? ''; } catch { return ''; }
}

/** `/api/history` is authenticated like the socket: the token rides the URL. */
export function authedApi(path: string): string {
  const t = token();
  if (!t) return path;
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}`;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(authedApi(path), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return await res.json() as T;
}

/** Snapshots in `[from, to]`, one per `step` ms. The hub caps the answer at 600. */
export function fetchHistory(from: number, to: number, step = 0): Promise<HistoryRange> {
  return getJson<HistoryRange>(
    `/api/history?from=${Math.round(from)}&to=${Math.round(to)}&step=${Math.round(step)}`,
  );
}

/** What happened since `since` (epoch ms). */
export function fetchSummary(since: number): Promise<HistorySummary> {
  return getJson<HistorySummary>(`/api/history/summary?since=${Math.round(since)}`);
}

/* ── snapshot → world ─────────────────────────────────────────────── */

/**
 * A minimal but complete `WorldState` for one instant.
 *
 * Complete matters: the field indexes agents by every field it reads, and an
 * agent missing `metrics` or `childIds` is a crash in a render loop, not a
 * blank tile. So every mandatory field is filled — from the live agent when it
 * still exists, from a neutral default when it does not.
 *
 * Escalations, messages, collisions and artifacts stay empty on purpose. We
 * never recorded them per instant, and drawing today's amber ask over a world
 * from four hours ago would be a lie in the one colour that must never lie.
 */
export function worldFromSnapshot(snapshot: Snapshot, live: WorldState): WorldState {
  const w = emptyWorld();
  w.rev = live.rev;
  w.at = snapshot.at;
  w.machines = live.machines;
  w.placements = live.placements;
  w.keys = live.keys;

  for (const [id, t] of Object.entries(snapshot.agents)) {
    const [state, costUSD, tokensPerSec, projectId, parentId, callsign, used] = t;
    const prev = live.agents[id];
    const base: Agent = prev ? { ...prev } : blankAgent(id, snapshot.at);
    base.id = id;
    base.state = state;
    base.projectId = projectId;
    base.parentId = parentId === '' ? null : parentId;
    base.callsign = callsign;
    base.childIds = [];
    base.updatedAt = snapshot.at;
    // El uso de ese instante entra como entrada: `ceilingTokens` lo devuelve
    // tal cual, que es lo que el rollup del replay tiene que sumar. Una
    // instantánea anterior al 2026-09-12 no lo trae y vale cero.
    base.metrics = {
      ...base.metrics, costUSD, tokensPerSec,
      inputTokens: used ?? 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    };
    // The tile inverts to amber off `state`, but the window chrome and the
    // "needs you" wording read `block`. Without a stand-in the replay would
    // show a blocked tile whose panel claims nothing is wrong.
    base.block = state === 'blocked'
      ? (prev?.block ?? { kind: 'question', summary: '', since: snapshot.at })
      : null;
    base.startedAt = Math.min(base.startedAt || snapshot.at, snapshot.at);
    base.uptimeMs = Math.max(0, snapshot.at - base.startedAt);
    w.agents[id] = base;
  }

  // Lineage is rebuilt from parentId, never carried over: a child that did not
  // exist yet at this instant must not hang off its parent's pipe.
  for (const a of Object.values(w.agents)) {
    if (!a.parentId) continue;
    const parent = w.agents[a.parentId];
    if (parent) parent.childIds.push(a.id);
    else a.depth = 0;   // the parent is outside this instant: draw it as a root
  }

  // Projects come from the live world, but their rollups come from this
  // instant. A region labelled with today's counts over a four-hour-old field
  // is the kind of half-truth that makes an operator stop trusting the replay.
  const fleet = emptyRollup();
  const rolls = new Map<string, ReturnType<typeof emptyRollup>>();
  for (const a of Object.values(w.agents)) {
    let r = rolls.get(a.projectId);
    if (!r) { r = emptyRollup(); rolls.set(a.projectId, r); }
    for (const acc of [r, fleet]) {
      acc.total += 1;
      acc.byState[a.state] += 1;
      acc.tokens += ceilingTokens(a.metrics);
      acc.tokensPerSec += a.metrics.tokensPerSec;
      if (a.state === 'blocked') acc.blocked += 1;
    }
  }
  for (const p of Object.values(live.projects)) {
    const roll = rolls.get(p.id) ?? emptyRollup();
    const copy: Project = { ...p, rollup: roll, sessionIds: [] };
    w.projects[p.id] = copy;
  }
  for (const a of Object.values(w.agents)) {
    w.projects[a.projectId]?.sessionIds.push(a.id);
  }
  w.fleet = fleet;
  return w;
}

/** An agent the live world no longer has. Every mandatory field, nothing said. */
function blankAgent(id: string, at: number): Agent {
  return {
    id, machineId: '', projectId: '',
    title: '', callsign: '', runtime: 'claude', squad: null, lead: false,
    state: 'done', block: null,
    parentId: null, depth: 0, childIds: [], mission: null,
    model: null, tool: null, toolDetail: null,
    lastPrompt: null, lastSay: null,
    startedAt: at, updatedAt: at, uptimeMs: 0,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
      tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0,
      toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    background: false, shortId: null,
  };
}

/* ── the cursor's neighbourhood ───────────────────────────────────── */

/** The snapshot nearest `at`. Binary search: the scrubber calls this per pointer move. */
export function nearestSnapshot(list: Snapshot[], at: number): number {
  if (list.length === 0) return -1;
  let lo = 0, hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.at < at) lo = mid + 1; else hi = mid;
  }
  const a = list[lo]!;
  const b = list[lo - 1];
  if (b && Math.abs(b.at - at) <= Math.abs(a.at - at)) return lo - 1;
  return lo;
}
