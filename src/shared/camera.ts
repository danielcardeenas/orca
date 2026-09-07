/**
 * CAPCOM moving the operator's camera.
 *
 * "Show me where K9 is" is a question about the field, and the only party
 * that can answer it is the console: the hub knows the fleet, but where a tile
 * stands is a layout the browser computes. So CAPCOM does not fly anything
 * itself. It names a target — one agent, several, a squad, a project, the
 * whole fleet — the hub broadcasts that as a `camera` frame, and every console
 * that hears it flies there, selects it and says who asked.
 *
 * The directive carries *references*, not positions, and the console
 * resolves them at arrival: an agent that has not reached the console yet
 * (the launch that just went up) is looked for until `until`, then dropped.
 * That deadline is what keeps a stale directive from moving the camera a
 * minute after the operator stopped caring.
 */

import type { Agent } from './types.ts';

export type CameraWhat = 'agent' | 'agents' | 'squad' | 'project' | 'fleet';

export interface CameraDirective {
  id: string;
  at: number;
  what: CameraWhat;
  /**
   * What to look at. Agents by id, callsign or short id; a squad by name; a
   * project by id. Empty for `fleet`. Resolved on the console, not here.
   */
  refs: string[];
  /** For `squad`: the project its block belongs to, when the hub knows it. */
  projectId: string | null;
  /** Also open the thing's window, not only fly to it. */
  open: boolean;
  /** One line for the operator's feed: what CAPCOM is pointing at, and why. */
  note: string | null;
  /** `capcom` asked for it; `launch` is the console following what just went up. */
  by: 'capcom' | 'launch';
  /** Keep looking for a target that is not on the field yet until this time. */
  until: number;
}

/**
 * How long the console keeps looking for a target that is not on the field
 * yet. A spawned session shows in seconds on a warm machine; forty-five
 * seconds covers a cold one and is still short enough that a directive
 * never fires after the operator has moved on.
 */
export const CAMERA_PENDING_MS = 45_000;

/**
 * The agent a reference names: an id, a short id, or a callsign (the human
 * types callsigns, the hub writes ids, the CLI prints short ids). Callsigns
 * are matched without case; ids exactly.
 */
export function findAgentRef(agents: Iterable<Agent> | Record<string, Agent>, ref: string): Agent | undefined {
  const list: Agent[] = Symbol.iterator in Object(agents)
    ? [...(agents as Iterable<Agent>)]
    : Object.values(agents as Record<string, Agent>);
  const r = ref.trim();
  if (!r) return undefined;
  const byId = list.find((a) => a.id === r);
  if (byId) return byId;
  const byShort = list.find((a) => a.shortId && a.shortId === r);
  if (byShort) return byShort;
  const low = r.toLowerCase();
  // Two agents may share a callsign across projects; the live one wins, and
  // among live ones the newest — the one the operator most likely means.
  const hits = list.filter((a) => a.callsign.toLowerCase() === low);
  if (!hits.length) return undefined;
  const alive = (a: Agent) => a.state !== 'done' && a.state !== 'dead';
  return [...hits].sort((a, b) => Number(alive(b)) - Number(alive(a)) || b.startedAt - a.startedAt)[0];
}
