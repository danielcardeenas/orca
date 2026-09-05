/**
 * Squads: lineage with a name on it.
 *
 * `parentId` already says who launched whom, and that is a tree. What a tree
 * cannot say is "these five are the audit, and that one speaks for them" — and
 * that is the unit an operator thinks in when they send work out and wait for
 * one answer back.
 *
 * So a squad is not a record. There is no squad table, nothing to create and
 * nothing to garbage-collect: it is whatever set of agents currently carries
 * the same `squad` label, derived on demand from the agents themselves. An
 * agent that dies leaves the squad by dying. A squad whose last member is gone
 * stops existing without anybody deleting it.
 *
 * Lives in `shared/` because both ends need the same answer: the hub routes
 * `scope:'squad'` traffic with it, and the console draws the same grouping.
 */

import type { Agent } from './types.ts';

/**
 * What a squad name may be.
 *
 * It travels in an argv (`orca-tell --to squad:audit-01`), in a filename-free
 * JSON, and onto a tile in the console. Letters, digits, `-` and `_`, starting
 * with a letter or digit, at most 32 characters — long enough for "audit-01"
 * and "payments-migration", short enough to fit on a label.
 */
export const SQUAD_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** Max characters of a squad name, kept next to the regexp that enforces it. */
export const MAX_SQUAD_NAME = 32;

/**
 * A squad name, or null. Trims first, because a name that came from an argv or
 * a JSON an agent wrote usually has a space somewhere it should not.
 */
export function squadName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  return SQUAD_RE.test(name) ? name : null;
}

/** One squad, as the console draws it. */
export interface Squad {
  /** The label its members carry. */
  name: string;
  /** The member marked `lead`, or null when the squad has lost its leader. */
  leaderId: string | null;
  /**
   * Every agent carrying the label, the leader included and always first, then
   * the rest by `startedAt` and — for a tie — by id. Deterministic on purpose:
   * a list that reorders itself between frames makes the console flicker.
   */
  memberIds: string[];
}

/**
 * Group agents into squads.
 *
 * Takes anything the two ends actually hold: the hub has a
 * `Record<string, Agent>`, the console usually has an array. Agents without a
 * `squad` are not in one and simply do not appear.
 *
 * Two agents claiming `lead` of the same squad is a bug upstream, not a reason
 * to return nothing: the oldest one leads (tie broken by id), because that is
 * the one whose brief the others were spawned under.
 */
export function squadsOf(agents: Iterable<Agent> | Record<string, Agent>): Squad[] {
  const list: Agent[] = Symbol.iterator in Object(agents)
    ? [...(agents as Iterable<Agent>)]
    : Object.values(agents as Record<string, Agent>);

  const byName = new Map<string, Agent[]>();
  for (const a of list) {
    const name = squadName(a.squad);
    if (!name) continue;
    const bucket = byName.get(name);
    if (bucket) bucket.push(a); else byName.set(name, [a]);
  }

  const out: Squad[] = [];
  for (const [name, members] of byName) {
    let leader: Agent | null = null;
    for (const a of members) {
      if (!a.lead) continue;
      if (!leader || a.startedAt < leader.startedAt
        || (a.startedAt === leader.startedAt && a.id < leader.id)) leader = a;
    }
    const rest = members
      .filter((a) => a.id !== leader?.id)
      .sort((a, b) => (a.startedAt - b.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.push({
      name,
      leaderId: leader?.id ?? null,
      memberIds: [...(leader ? [leader.id] : []), ...rest.map((a) => a.id)],
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
