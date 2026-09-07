/**
 * Which agent is CAPCOM — shared by the hub (who gets what the human types)
 * and the console (whose transcript is the command window). Two answers to
 * that question would be a message the human sees going to one session while
 * another one answers it.
 */

import type { Agent } from './types.ts';
import { TERMINAL_STATES } from './types.ts';

/**
 * The prefix the hub puts on an agent's question when it relays it to CAPCOM
 * (`[ESCALATION <id>] K9 asks: …`). Shared because both ends read it: the hub
 * writes the line, and the console recognises it in CAPCOM's transcript so it
 * can show "the fleet asked" instead of "you said". Change one, change both.
 */
export const ESCALATION_PREFIX = 'ESCALATION';

/**
 * The live CAPCOM session, if this fleet has one.
 *
 * "Live" means not terminal: a `done` or `dead` CAPCOM is a session whose
 * process is gone, and delivering to it would be dropping the message in
 * silence. Two candidates happen by design for a moment — every message goes
 * through `--bg --resume`, which makes a NEW session and leaves the old one
 * listed until the CLI reaps it — so the newest wins. Newest by `startedAt`,
 * and on a tie by `updatedAt`: a resumed transcript carries the original
 * conversation's first timestamp, so two CAPCOMs routinely share `startedAt`,
 * and the one that moved last is the one that just answered.
 */
export function capcomOf(agents: Iterable<Agent> | Record<string, Agent>): Agent | null {
  const list: Agent[] = Symbol.iterator in Object(agents)
    ? [...(agents as Iterable<Agent>)]
    : Object.values(agents as Record<string, Agent>);
  let best: Agent | null = null;
  for (const a of list) {
    if (a.role !== 'capcom') continue;
    if (TERMINAL_STATES.has(a.state)) continue;
    if (!best
      || a.startedAt > best.startedAt
      || (a.startedAt === best.startedAt && a.updatedAt > best.updatedAt)) best = a;
  }
  return best;
}
