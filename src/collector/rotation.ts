/**
 * When to recycle CAPCOM.
 *
 * A CLI session compacts its context when it fills up, and it does so for
 * ever: after the third or fourth compaction the commander is working from a
 * summary of a summary, and what it "remembers" about the fleet is whatever
 * survived each squeeze. Nothing errors. Answers just get vaguer.
 *
 * The fix is to stop treating the session as the record. The hub is the
 * record — the missions, the escalations, the memory all live there and survive a
 * restart — and `briefing` reads it in one call. So a session past a
 * threshold is simply replaced by a fresh one with the same brief, which
 * calls `briefing` and carries on. That is a rotation, and this file is the
 * rule that says when.
 *
 * ── The signal ─────────────────────────────────────────────────────
 *
 * How full the window is, when the CLI reports both the prompt and the window
 * size, is the signal to prefer: it arrives *before* the first compaction, so
 * the replacement inherits a checkpoint instead of a summary of a summary. It
 * says nothing about accumulated loss, though — the number collapses back to a
 * few thousand each time the CLI compacts — so it cannot be the only one.
 *
 * Compactions, counted off the transcript (`compact_boundary` for Claude,
 * `compacted` for Codex), are the other signal: each one is a concrete,
 * observed loss of memory, and the count only ever goes up. Turns are a
 * proxy — a session can spend two hundred turns on one-line answers or fill
 * its window in ten — and stay as a safety net with a high default for a CLI
 * that reports neither.
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
  /**
   * Rotate when the prompt fills this much of the model's window. 0 disables
   * the signal, and so does a CLI that never reports its window size.
   */
  maxContextFraction: number;
  /** How long CAPCOM must have been quiet — no activity, nothing delivered. */
  idleMs: number;
  /**
   * What the replacement is given: `continuity` hands it the hub's short
   * checkpoint, `clean` hands it nothing. A rotation nobody asked for should
   * not cost the operator the thread they were on, so the default is
   * continuity; `clean` is what an operator picks deliberately.
   */
  mode: 'continuity' | 'clean';
}

export const ROTATION_DEFAULTS: RotationConfig = {
  maxCompactions: 4,
  maxTurns: 300,
  maxContextFraction: 0.75,
  idleMs: 30_000,
  mode: 'continuity',
};

const pct = (f: number) => `${Math.round(f * 100)}%`;

/**
 * `ORCA_CAPCOM_MAX_COMPACTIONS`, `ORCA_CAPCOM_MAX_TURNS`,
 * `ORCA_CAPCOM_MAX_CONTEXT_PCT`, `ORCA_CAPCOM_ROTATE_IDLE_MS` and
 * `ORCA_CAPCOM_ROTATE_MODE` (`continuity` | `clean`). Anything unparseable
 * keeps the default; 0 turns a signal off, and all three at 0 turns rotation
 * off entirely.
 */
export function rotationConfig(env: Record<string, string | undefined> = process.env): RotationConfig {
  const read = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  const fraction = env['ORCA_CAPCOM_MAX_CONTEXT_PCT'];
  const parsed = fraction === undefined || fraction.trim() === '' ? NaN : Number(fraction);
  const mode = env['ORCA_CAPCOM_ROTATE_MODE'];
  return {
    maxCompactions: read('ORCA_CAPCOM_MAX_COMPACTIONS', ROTATION_DEFAULTS.maxCompactions),
    maxTurns: read('ORCA_CAPCOM_MAX_TURNS', ROTATION_DEFAULTS.maxTurns),
    // Given as a percentage, because that is how a CLI shows it.
    maxContextFraction: Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
      ? parsed / 100 : ROTATION_DEFAULTS.maxContextFraction,
    idleMs: read('ORCA_CAPCOM_ROTATE_IDLE_MS', ROTATION_DEFAULTS.idleMs),
    mode: mode === 'clean' || mode === 'continuity' ? mode : ROTATION_DEFAULTS.mode,
  };
}

/** What the collector can see of its CAPCOM session at one instant. */
export interface RotationObservation {
  state: AgentState;
  turns: number;
  compactions: number;
  contextTokens: number;
  /** 0 when the CLI does not say how big the window is. */
  contextWindow: number;
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
  const filled = o.contextWindow > 0 && o.contextTokens > 0 ? o.contextTokens / o.contextWindow : 0;
  const overContext = cfg.maxContextFraction > 0 && filled >= cfg.maxContextFraction;
  if (!overCompactions && !overTurns && !overContext) {
    return { rotate: false, due: false, reason: `under threshold (${o.compactions} compactions, ${o.turns} turns${filled ? `, ${pct(filled)} of window` : ''})` };
  }
  const why = overContext
    ? `${pct(filled)} of the context window ≥ ${pct(cfg.maxContextFraction)}`
    : overCompactions
    ? `${o.compactions} compactions ≥ ${cfg.maxCompactions}`
    : `${o.turns} turns ≥ ${cfg.maxTurns}`;
  const hold = (what: string): RotationVerdict => ({ rotate: false, due: true, reason: `${why}, but ${what}` });
  if (o.state !== 'idle') return hold(`CAPCOM is ${o.state}`);
  if (o.pendingEscalations > 0) return hold(`${o.pendingEscalations} escalation(s) pending`);
  const quietFor = now - Math.max(o.lastActivityAt, o.lastDeliveryAt);
  if (quietFor < cfg.idleMs) return hold(`quiet only ${Math.round(quietFor / 1000)}s of ${Math.round(cfg.idleMs / 1000)}s`);
  return { rotate: true, due: true, reason: why };
}

/** Between two attempts at rotating by preparing the replacement. */
export const HANDOFF_RETRY_MS = 10 * 60_000;

export interface RotationRoute {
  /**
   * `none` under the threshold; `wait` when it is due but not now; `relaunch`
   * to stop the session and start a fresh one; `handoff` to prepare the
   * replacement first and retire the current session only once it answers.
   */
  act: 'none' | 'wait' | 'relaunch' | 'handoff';
  reason: string;
  mode: 'continuity' | 'clean';
}

/**
 * The verdict, plus how to carry it out.
 *
 * A session that was itself prepared — a Codex thread, or any activated
 * handoff — cannot be recycled by killing it: its id was never ORCA's to
 * choose, so the replacement has to exist before the current one goes. That is
 * the `handoff` route, and it costs a CLI process per attempt, which is why a
 * failed one is not retried until `HANDOFF_RETRY_MS` has passed. The threshold
 * that triggered it stays crossed the whole time, so without that pause a
 * quota failure would ask for a new process every tick of the watchdog.
 */
export function rotationRoute(
  o: RotationObservation,
  ctx: { prepared: boolean; lastHandoffAt: number },
  cfg: RotationConfig = ROTATION_DEFAULTS,
  now = Date.now(),
): RotationRoute {
  const v = rotationVerdict(o, cfg, now);
  const mode = cfg.mode;
  if (!v.due) return { act: 'none', reason: v.reason, mode };
  if (!v.rotate) return { act: 'wait', reason: v.reason, mode };
  if (!ctx.prepared) return { act: 'relaunch', reason: v.reason, mode };
  const since = now - ctx.lastHandoffAt;
  if (ctx.lastHandoffAt > 0 && since < HANDOFF_RETRY_MS) {
    return { act: 'wait', mode, reason: `${v.reason}, but a prepared rotation was attempted ${Math.round(since / 60_000)}m ago` };
  }
  return { act: 'handoff', reason: v.reason, mode };
}
