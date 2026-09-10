/**
 * Which agent is CAPCOM — shared by the hub (who gets what the human types)
 * and the console (whose transcript is the command window). Two answers to
 * that question would be a message the human sees going to one session while
 * another one answers it.
 */

import type { Agent, AgentState } from './types.ts';
import { LIVE_STATES, TERMINAL_STATES } from './types.ts';

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

/* ── The turn ────────────────────────────────────────────────────── */

/**
 * What CAPCOM is doing with your line right now, as the command line shows
 * it. One of four words: nothing, thinking, working (with the tool in its
 * hand), or waiting on you. A block on another agent is not waiting on you,
 * so it reads as working; a CAPCOM that is booting is thinking, for the same
 * reason a cursor blinks before the first character.
 */
export type CapcomTurn =
  | { kind: 'idle' }
  | { kind: 'thinking' }
  | { kind: 'working'; tool: string | null }
  | { kind: 'waiting' };

export function capcomTurn(agents: Iterable<Agent> | Record<string, Agent>, ceo?: { thinking: boolean }): CapcomTurn {
  const a = capcomOf(agents);
  if (!a) return ceo?.thinking ? { kind: 'thinking' } : { kind: 'idle' };
  switch (a.state) {
    case 'booting': case 'thinking': return { kind: 'thinking' };
    case 'working': return { kind: 'working', tool: a.tool ?? null };
    case 'blocked': return a.block?.kind === 'peer' ? { kind: 'working', tool: null } : { kind: 'waiting' };
    default: return { kind: 'idle' };
  }
}

/** How long after your line a turn that starts still counts as yours. */
export const TURN_AFTER_MS = 30_000;

/**
 * CAPCOM took your line: it was not live, now it is, and you sent it
 * something moments ago. A turn it starts on its own — a relayed question,
 * a mission's next step — is not this; the command line shows it, but the
 * sound is for the line you are waiting on.
 */
export function turnStarted(before: AgentState | undefined, after: AgentState, sentAt: number | null, now: number): boolean {
  if (sentAt === null || now - sentAt > TURN_AFTER_MS || now < sentAt) return false;
  const wasLive = before !== undefined && LIVE_STATES.has(before) && before !== 'blocked';
  return !wasLive && LIVE_STATES.has(after) && after !== 'blocked';
}
