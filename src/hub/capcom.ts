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
import { capcomOf, ESCALATION_PREFIX } from '../shared/capcom.ts';

// Lives in shared/ so the console picks the same session the hub routes to,
// and recognises the escalation prefix the hub writes.
export { capcomOf, ESCALATION_PREFIX };

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

/**
 * How long the hub waits for a recycled CAPCOM to come back before it gives
 * up on the mail it held for it.
 *
 * A rotation is a pane killed and a pane spawned: the new transcript shows
 * within seconds, a slow machine within a minute. Three minutes is that with
 * room, and short enough that a rotation that never came back turns into the
 * plain "no CAPCOM" behaviour while the operator is still looking.
 */
export const CAPCOM_ROTATION_HOLD_MS = 180_000;

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

/** A line for CAPCOM, held while a rotation is in progress. */
interface QueuedSay {
  text: string;
  deliver: CapcomDeps['say'];
  /** What to do if the new session never shows. */
  dropped?: ((reason: string) => void) | undefined;
}

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
  answerMs?: number;
}

export class CapcomRouter {
  private deps: CapcomDeps;
  private answerMs: number;
  /** escalation id → the deadline timer, while CAPCOM holds it. */
  private held = new Map<string, CapcomTimer>();
  /** Said once, the first time a fleet actually gets a CAPCOM. */
  private announced = false;
  /**
   * A rotation in progress: the session going away, and the deadline for the
   * new one to show. While set, `fromId` is never a delivery target and what
   * would have gone to CAPCOM waits in `mail`.
   */
  private rotation: { fromId: string; timer: CapcomTimer } | null = null;
  private mail: QueuedSay[] = [];
  private transfer: { previousCutoff: number | null } | null = null;
  private cleanCutoff: number | null = null;
  holdingFor(id: string): boolean { return !!this.rotation && !this.live() && (this.rotation.fromId === id || this.deps.capcom()?.id === id); }
  contextCutoff(): number | null { return this.cleanCutoff; }
  setContext(mode?: 'continuity' | 'clean', cutoffAt?: number): void {
    this.cleanCutoff = mode === 'clean' ? cutoffAt ?? Date.now() : null;
  }
  beginTransfer(fromId: string, mode?: 'continuity' | 'clean', cutoffAt?: number): void {
    if (this.transfer) return;
    this.transfer = { previousCutoff: this.cleanCutoff };
    this.setContext(mode, cutoffAt);
    this.rotating(fromId, 15 * 60_000);
  }

  constructor(deps: CapcomDeps, opts: CapcomOptions = {}) {
    this.deps = deps;
    this.answerMs = opts.answerMs ?? CAPCOM_ANSWER_MS;
  }

  /**
   * The session commanding this fleet, or null.
   *
   * Never the one a rotation is retiring: the collector announces the rotation
   * before it stops that session, and for a few seconds the world still lists
   * it as alive. Delivering to it then is pasting into a pane about to die.
   */
  live(): Agent | null {
    const cap = this.deps.capcom();
    if (this.transfer) return null;
    if (cap && this.rotation && cap.id === this.rotation.fromId) return null;
    return cap;
  }

  /**
   * The human said something.
   *
   * `'delivered'` when CAPCOM took it; `'queued'` when CAPCOM is being
   * recycled and the line waits for the new session (`dropped` is called if
   * that session never shows); `false` when there is no CAPCOM at all — the
   * caller records the message and says so, because nothing else commands.
   */
  humanSays(
    text: string, deliver: CapcomDeps['say'] = this.deps.say, dropped?: (reason: string) => void,
  ): 'delivered' | 'queued' | false {
    const cap = this.live();
    if (cap) {
      this.announce(cap);
      deliver(cap.id, text);
      return 'delivered';
    }
    if (this.rotation) {
      this.mail.push({ text, deliver, dropped });
      return 'queued';
    }
    return false;
  }

  /* ── rotation ─────────────────────────────────────────────────── */

  /**
   * The collector is recycling CAPCOM: `fromId` is going away on purpose.
   *
   * From here until the new session shows — or `holdMs` runs out — the
   * retiring session is not a target, and everything addressed to CAPCOM is
   * held. Without this the window between the old pane dying and the new
   * transcript appearing reads as "no CAPCOM connected": the operator's
   * message is refused, a task prompt goes nowhere, and a rotation that was
   * meant to be invisible costs them a retype.
   */
  rotating(fromId: string, holdMs = CAPCOM_ROTATION_HOLD_MS): void {
    this.rotation?.timer.cancel();
    const timer = this.deps.setTimer(() => {
      if (!this.rotation) return;
      if (this.transfer) { this.deps.note?.('CAPCOM transfer is taking longer than expected; messages remain held. Inspect handoff status.'); return; }
      const lost = this.mail.splice(0);
      this.rotation = null;
      const reason = `CAPCOM did not come back ${Math.round(holdMs / 1000)}s after rotating`;
      this.deps.note?.(`${reason}${lost.length ? ` — ${lost.length} message(s) not delivered` : ''}`);
      for (const m of lost) m.dropped?.(reason);
    }, holdMs);
    this.rotation = { fromId, timer };
  }

  /** True while a rotation is in progress and mail is being held. */
  inRotation(): boolean { return this.rotation !== null; }
  /** A preparation failed or completed: release held mail to the current coordinator. */
  releaseTransfer(toId?: string): void {
    if (this.transfer && !toId) this.cleanCutoff = this.transfer.previousCutoff;
    this.transfer = null;
    const current = this.deps.capcom();
    // The collector may announce activation before its transcript is visible.
    // Keep mail held until the new identity can actually receive it.
    if (toId && current?.id !== toId) return;
    this.rotation?.timer.cancel(); this.rotation = null;
    const cap = this.live();
    const mail = this.mail.splice(0);
    for (const m of mail) { if (cap) m.deliver(cap.id, m.text); else m.dropped?.('CAPCOM unavailable after handoff'); }
  }

  /** Lines waiting for the new CAPCOM. */
  queued(): number { return this.mail.length; }

  /**
   * A new CAPCOM is live: end the rotation and hand it what was held.
   *
   * Called whenever the fleet changes and on every sweep; cheap when nothing
   * is pending. Returns how many lines went out.
   */
  flush(): number {
    if (!this.rotation) return 0;
    const cap = this.live();
    if (!cap) return 0;
    this.rotation.timer.cancel();
    this.rotation = null;
    const out = this.mail.splice(0);
    if (out.length) this.deps.note?.(`CAPCOM de vuelta (${cap.callsign}): ${out.length} mensaje(s) en espera entregados`);
    for (const m of out) m.deliver(cap.id, m.text);
    return out.length;
  }

  /**
   * An agent asked something. Offer it to CAPCOM first.
   *
   * Returns true when CAPCOM has it. False leaves the question in the human's
   * queue, where it was going to end up anyway.
   */
  offer(escalationId: string): boolean {
    const cap = this.live();
    if (!cap) return false;
    const esc = this.deps.escalation(escalationId);
    if (!esc || esc.status !== 'pending' || (esc.permission && esc.permission.phase !== 'requested')) return false;
    if (this.cleanCutoff !== null && esc.askedAt <= this.cleanCutoff) return false;
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

  /**
   * Offer CAPCOM whatever is pending and was never offered.
   *
   * `offer` runs once, the moment a question arrives. If CAPCOM was not in the
   * world at that moment — the collector that carries it was reconnecting, or
   * the question came in the same snapshot that announced CAPCOM — the
   * question fell through to nobody and stayed pending, unread, forever.
   * Measured on a hub restart: three permission prompts sat there for an hour.
   *
   * Only questions with no `ceoAttempt`: one CAPCOM already gave up on (the 90
   * second deadline writes the attempt) belongs to the human now, and offering
   * it again every sweep would bounce it between the two for the rest of time.
   */
  sweep(pending: Iterable<Escalation>): number {
    if (!this.live()) return 0;
    let offered = 0;
    for (const esc of pending) {
      if (esc.status !== 'pending' || esc.ceoAttempt || this.held.has(esc.id)) continue;
      if (this.offer(esc.id)) offered += 1;
    }
    return offered;
  }

  /** Stop waiting on everything. Called when the hub closes. */
  stop(): void {
    for (const t of this.held.values()) t.cancel();
    this.held.clear();
    this.rotation?.timer.cancel();
    this.rotation = null;
    this.mail = [];
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
