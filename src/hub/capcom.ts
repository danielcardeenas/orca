/**
 * CAPCOM routing — who gets what the human types, and who triages a question.
 *
 * CAPCOM (NASA: the one voice that talks to the crew on behalf of control) is
 * not a model loop inside this process. It is a CLI session out in the fleet,
 * like any other agent, with `role: 'capcom'` on it and the hub's MCP server as
 * its toolbelt. That single fact is what makes the command layer cost nothing:
 * it runs on the operator's Claude subscription, not on the API.
 *
 * So the hub's job here is small and entirely about routing:
 *
 *   the human types    →  a `say` command to the CAPCOM session
 *   an agent asks      →  a `say` carrying `[ESCALATION <id>] …`
 *   CAPCOM goes quiet  →  after 90 s the question goes to the human anyway
 *
 * That last line is the one that earns this file. Handing a question to a
 * session that might be wedged, out of context, or simply not reading is how a
 * blocked agent waits forever with nobody watching — the exact failure ORCA
 * exists to remove. A deadline turns "CAPCOM is thinking" into "the human sees
 * it", and the human sees *why* they are seeing it.
 *
 * Everything is injected, the clock included, so the 90 s rule is a test that
 * runs in a millisecond instead of a minute and a half.
 */

import type { Agent, Escalation } from '../shared/types.ts';
import { TERMINAL_STATES } from '../shared/types.ts';

/**
 * How long CAPCOM gets to answer an agent's question before the human sees it.
 *
 * Ninety seconds is a CLI turn: long enough for a session to survey the fleet,
 * recall, and decide; short enough that a person waiting on an agent that is
 * waiting on CAPCOM never has to wonder whether anything is happening.
 */
export const CAPCOM_ANSWER_MS = 90_000;

/** Written onto the escalation so the operator knows why it reached them. */
export const CAPCOM_TIMEOUT_REASON = 'capcom did not answer in time';

/** The prefix CAPCOM's brief tells it to look for. Change one, change both. */
export const ESCALATION_PREFIX = 'ESCALATION';

/**
 * The live CAPCOM session, if this fleet has one.
 *
 * "Live" means not terminal: a `done` or `dead` CAPCOM is a session whose
 * process is gone, and delivering to it would be dropping the message in
 * silence. Two candidates is a bug upstream (a collector that launched a second
 * one), not a reason to return nothing: the newest wins, because it is the one
 * whose process is actually up.
 */
export function capcomOf(agents: Iterable<Agent> | Record<string, Agent>): Agent | null {
  const list: Agent[] = Symbol.iterator in Object(agents)
    ? [...(agents as Iterable<Agent>)]
    : Object.values(agents as Record<string, Agent>);
  let best: Agent | null = null;
  for (const a of list) {
    if (a.role !== 'capcom') continue;
    if (TERMINAL_STATES.has(a.state)) continue;
    if (!best || a.startedAt > best.startedAt) best = a;
  }
  return best;
}

/**
 * An agent's question, as one line CAPCOM can act on.
 *
 * The id goes first and in brackets because CAPCOM has to quote it back — into
 * `answer_agent`, or into `ask_human`'s `escalation_id` — and a prefix is the
 * one place a model reliably finds it. The options follow on the same line
 * because they are what turns "think about this" into "pick one".
 */
export function escalationSay(esc: Escalation, callsign?: string | null): string {
  const who = callsign ? `${callsign} asks: ` : '';
  const head = `[${ESCALATION_PREFIX} ${esc.id}] ${who}${esc.question.trim()}`;
  const parts = [head];
  if (esc.options.length > 0) parts.push(`· options: ${esc.options.join(' | ')}`);
  if (esc.urgency === 'blocking') parts.push('· BLOCKING: the agent is stopped until this is answered');
  const line = parts.join(' ');
  return esc.context ? `${line}\n${esc.context.trim()}` : line;
}

/* ── the router ───────────────────────────────────────────────────── */

export interface CapcomTimer { cancel(): void }

export interface CapcomDeps {
  /** The live CAPCOM session, or null when this fleet has none. */
  capcom(): Agent | null;
  /** Deliver text to a session. The hub turns this into a `say` command. */
  say(agentId: string, text: string): void;
  escalation(id: string): Escalation | undefined;
  /** Mark it as being triaged, so the console shows it is not sitting unread. */
  markWithCeo(id: string): void;
  /** Give up on CAPCOM: put the question in front of the human, with a reason. */
  giveUp(id: string, reason: string): void;
  /** Callsign of an agent, for the line CAPCOM reads. */
  callsign?(agentId: string): string | null;
  /** One line for the operator's feed. Optional so tests need not care. */
  note?(text: string): void;
  setTimer(fn: () => void, ms: number): CapcomTimer;
}

export interface CapcomOptions {
  /** `--api-command` turns this off: the API CEO commands even if CAPCOM is up. */
  enabled?: boolean;
  answerMs?: number;
}

export class CapcomRouter {
  private deps: CapcomDeps;
  private enabled: boolean;
  private answerMs: number;
  /** escalation id → the deadline timer, while CAPCOM holds it. */
  private held = new Map<string, CapcomTimer>();
  /** Said once, the first time a fleet actually gets a CAPCOM. */
  private announced = false;

  constructor(deps: CapcomDeps, opts: CapcomOptions = {}) {
    this.deps = deps;
    this.enabled = opts.enabled ?? true;
    this.answerMs = opts.answerMs ?? CAPCOM_ANSWER_MS;
  }

  /** The session commanding this fleet, or null. */
  live(): Agent | null {
    return this.enabled ? this.deps.capcom() : null;
  }

  /**
   * The human said something.
   *
   * Returns true when CAPCOM took it. False means there is no CAPCOM session
   * and the caller should fall back to whatever command it has — the API CEO,
   * the scripted one, or nothing.
   */
  humanSays(text: string): boolean {
    const cap = this.live();
    if (!cap) return false;
    this.announce(cap);
    this.deps.say(cap.id, text);
    return true;
  }

  /**
   * An agent asked something. Offer it to CAPCOM first.
   *
   * Returns true when CAPCOM has it; the caller must NOT also hand it to the
   * API CEO, or the same question gets triaged twice by two different minds.
   */
  offer(escalationId: string): boolean {
    const cap = this.live();
    if (!cap) return false;
    const esc = this.deps.escalation(escalationId);
    if (!esc || esc.status !== 'pending') return false;
    // Its own question would loop straight back into it.
    if (esc.agentId === cap.id) return false;
    if (this.held.has(escalationId)) return true;

    this.announce(cap);
    this.deps.markWithCeo(escalationId);
    const who = esc.agentId && this.deps.callsign ? this.deps.callsign(esc.agentId) : null;
    this.deps.say(cap.id, escalationSay(esc, who));

    const timer = this.deps.setTimer(() => {
      this.held.delete(escalationId);
      const now = this.deps.escalation(escalationId);
      // Answered, withdrawn, or already passed up: nothing owed.
      if (!now || now.status !== 'with_ceo') return;
      this.deps.giveUp(escalationId, CAPCOM_TIMEOUT_REASON);
      this.deps.note?.(`CAPCOM did not answer ${escalationId} in ${Math.round(this.answerMs / 1000)}s — it is yours`);
    }, this.answerMs);
    this.held.set(escalationId, timer);
    return true;
  }

  /**
   * The escalation CAPCOM is currently holding on behalf of `agentId`.
   *
   * `ask_human` is supposed to carry the id it is passing up, and the brief
   * says so — but a model that forgets would create a second record and the
   * human would read the same question twice. This lets the tool recover the
   * id from the one thing that is never ambiguous: the agent that asked.
   */
  openFor(agentId: string | null): string | null {
    if (!agentId) return null;
    for (const id of this.held.keys()) {
      const esc = this.deps.escalation(id);
      if (esc && esc.agentId === agentId) return id;
    }
    return null;
  }

  /** Every escalation CAPCOM is holding right now. For diagnostics. */
  holding(): string[] { return [...this.held.keys()]; }

  /** Stop waiting on everything. Called when the hub closes. */
  stop(): void {
    for (const t of this.held.values()) t.cancel();
    this.held.clear();
  }

  private announce(cap: Agent): void {
    if (this.announced) return;
    this.announced = true;
    this.deps.note?.(`CAPCOM online: ${cap.callsign} is commanding this fleet`);
  }
}

/** Real timers, unref'd so a pending deadline never holds the process open. */
export function realTimers(): CapcomDeps['setTimer'] {
  return (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return { cancel: () => clearTimeout(t) };
  };
}
