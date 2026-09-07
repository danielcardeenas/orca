/**
 * Blocks: a parent and the children that only ever talk to it.
 *
 * A child that has no interlocutor but its parent is not a node of the graph,
 * it is part of the parent. Drawn as a tile of its own it costs a cell, a
 * pipe and, when it lives three minutes, a birth and a death — for a fact
 * the operator cannot act on. So the console folds it into the parent's
 * **block**: a tray of small cells standing next to the parent's tile, no
 * pipe between them, one silhouette from afar.
 *
 * Who is folded (`absorbedChildren`):
 *
 *  - a Claude Code `Task` subagent (`Agent.subagent`), always — it was made
 *    to do one job for its parent and report back;
 *  - a child ORCA spawned (`origin: 'orca'`) while its only traffic is with
 *    its parent — the first message to or from anyone else, and it steps out
 *    of the block and gets a tile: it talks to the world now.
 *
 * Never folded, whatever the rule above says: a child blocked on a *person*
 * (amber must be seen), one that has children of its own (it is a parent
 * too), one enlisted in a squad (the squad is its block), one in another
 * project, or one whose parent is not on the field.
 *
 * Pure. The layout decides where the tray stands; the field decides what to
 * draw. This only decides who belongs to whom.
 */

import type { Agent, AgentMessage } from '../../shared/types.ts';
import { squadName } from '../../shared/squads.ts';

/** Small cells per tray. A seventh child opens a second tray next to the first. */
export const TRAY_CELLS = 6;

/** child id → parent id, for every child folded into its parent's block. */
export function absorbedChildren(
  agents: Iterable<Agent>,
  messages: Iterable<AgentMessage> = [],
): Map<string, string> {
  const byId = new Map<string, Agent>();
  for (const a of agents) byId.set(a.id, a);

  // Who each agent has talked to, besides its parent.
  const talks = new Map<string, Set<string>>();
  const note = (who: string, other: string) => {
    let set = talks.get(who);
    if (!set) { set = new Set(); talks.set(who, set); }
    set.add(other);
  };
  for (const m of messages) {
    if (m.toAgentId) { note(m.fromAgentId, m.toAgentId); note(m.toAgentId, m.fromAgentId); }
    // A message to a project, a squad or the fleet is a message to the world.
    else note(m.fromAgentId, '*');
  }

  const hasKids = new Set<string>();
  for (const a of byId.values()) if (a.parentId && byId.has(a.parentId)) hasKids.add(a.parentId);

  const out = new Map<string, string>();
  for (const a of byId.values()) {
    if (!a.parentId) continue;
    const p = byId.get(a.parentId);
    if (!p || p.projectId !== a.projectId) continue;
    if (hasKids.has(a.id)) continue;
    if (squadName(a.squad)) continue;
    if (a.state === 'blocked' && a.block?.kind !== 'peer') continue;
    if (a.subagent) { out.set(a.id, p.id); continue; }
    if (a.origin !== 'orca') continue;
    const others = talks.get(a.id);
    let external = false;
    if (others) for (const o of others) if (o !== p.id) { external = true; break; }
    if (!external) out.set(a.id, p.id);
  }
  return out;
}
