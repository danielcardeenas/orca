/**
 * When to recycle CAPCOM.
 *
 * A CLI session compacts its context when it fills up, and it does so for
 * ever: after the third or fourth compaction the commander is working from a
 * summary of a summary, and what it "remembers" about the fleet is whatever
 * survived each squeeze. Nothing errors. Answers just get vaguer.
 *
 * The fix is to stop treating the session as the record. The hub is the
 * record — the tasks, the escalations, the memory all live there and survive a
 * restart — and `briefing` reads it in one call. So a session past a
 * threshold is simply replaced by a fresh one with the same brief, which
 * calls `briefing` and carries on. That is a rotation, and this file is the
 * rule that says when.
 *
 * ── The signal ─────────────────────────────────────────────────────
 *
 * Compactions, counted off the transcript (`compact_boundary`), are the
 * primary signal: each one is a concrete, observed loss of memory, and the
 * count only ever goes up. Context tokens fall back to a few thousand after
 * every compaction, so they say nothing about how much has been lost; turns
 * are a proxy — a session can spend two hundred turns on one-line answers or
 * fill its window in ten. Turns stay as a safety net with a high default for
 * a CLI that never writes the boundary line.
 *
 * ── Only when idle ─────────────────────────────────────────────────
 *
 * Rotating mid-turn kills a tool call half way; rotating with a question in
 * flight loses the question. So a rotation waits for a session that is idle,
 * has had nothing delivered to it for a while, and has no escalation pending
 * on this machine — and it can wait indefinitely, because a CAPCOM that is
 * busy is a CAPCOM that is working, whatever its context looks like.
 */

import type { AgentState } from '../shared/types.ts';

export interface RotationConfig {
  /** Rotate at this many compactions. 0 disables the signal. */
  maxCompactions: number;
  /** Rotate at this many turns. 0 disables the signal. */
  maxTurns: number;
  /** How long CAPCOM must have been quiet — no activity, nothing delivered. */
  idleMs: number;
}

export const ROTATION_DEFAULTS: RotationConfig = {
  maxCompactions: 2,
  maxTurns: 300,
  idleMs: 30_000,
};

/**
 * `ORCA_CAPCOM_MAX_COMPACTIONS`, `ORCA_CAPCOM_MAX_TURNS`,
 * `ORCA_CAPCOM_ROTATE_IDLE_MS`. Anything unparseable keeps the default; 0
 * turns that signal off, and both at 0 turns rotation off entirely.
 */
export function rotationConfig(env: Record<string, string | undefined> = process.env): RotationConfig {
  const read = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  return {
    maxCompactions: read('ORCA_CAPCOM_MAX_COMPACTIONS', ROTATION_DEFAULTS.maxCompactions),
    maxTurns: read('ORCA_CAPCOM_MAX_TURNS', ROTATION_DEFAULTS.maxTurns),
    idleMs: read('ORCA_CAPCOM_ROTATE_IDLE_MS', ROTATION_DEFAULTS.idleMs),
  };
}

/** What the collector can see of its CAPCOM session at one instant. */
export interface RotationObservation {
  state: AgentState;
  turns: number;
  compactions: number;
  contextTokens: number;
  /** Last line the transcript gained. */
  lastActivityAt: number;
  /** Last `say` this collector pasted into it; 0 for never. */
  lastDeliveryAt: number;
  /** Escalations still open on this machine — questions CAPCOM may be about to get. */
  pendingEscalations: number;
}

export interface RotationVerdict {
  rotate: boolean;
  /** Why, in one line. Logged either way when the threshold is over. */
  reason: string;
  /** The threshold was crossed — rotation is due, whether or not it is safe now. */
  due: boolean;
}

export function rotationVerdict(
  o: RotationObservation, cfg: RotationConfig = ROTATION_DEFAULTS, now = Date.now(),
): RotationVerdict {
  const overCompactions = cfg.maxCompactions > 0 && o.compactions >= cfg.maxCompactions;
  const overTurns = cfg.maxTurns > 0 && o.turns >= cfg.maxTurns;
  if (!overCompactions && !overTurns) {
    return { rotate: false, due: false, reason: `under threshold (${o.compactions} compactions, ${o.turns} turns)` };
  }
  const why = overCompactions
    ? `${o.compactions} compactions ≥ ${cfg.maxCompactions}`
    : `${o.turns} turns ≥ ${cfg.maxTurns}`;
  const hold = (what: string): RotationVerdict => ({ rotate: false, due: true, reason: `${why}, but ${what}` });
  if (o.state !== 'idle') return hold(`CAPCOM is ${o.state}`);
  if (o.pendingEscalations > 0) return hold(`${o.pendingEscalations} escalation(s) pending`);
  const quietFor = now - Math.max(o.lastActivityAt, o.lastDeliveryAt);
  if (quietFor < cfg.idleMs) return hold(`quiet only ${Math.round(quietFor / 1000)}s of ${Math.round(cfg.idleMs / 1000)}s`);
  return { rotate: true, due: true, reason: why };
}
