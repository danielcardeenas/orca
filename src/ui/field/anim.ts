/**
 * The field's animated scalars.
 *
 * The field used to carry its own `anims` map and a hand-written `backOut`,
 * which meant the one place in the console that animates the most read none of
 * `motion.ts`'s numbers. This is that map, tweened by GSAP through `T`, `EASE`
 * and `dur()`, so the field moves on the same contract as the windows and the
 * HUD.
 *
 * A scalar is a key and a number: `core:<agentId>` is how far a lineage core
 * has grown along its pipe, `tile:<agentId>` is a tile's scale, `sq:<key>` is
 * how far a squad's outline has been traced. The RAF reads them
 * (`get('core:' + id, 1)`) and nothing else: there is no per-frame stepping
 * here, GSAP's ticker owns that.
 *
 * Two rules make it safe to read from a hot loop:
 *
 * 1. **A missing key is not an error.** `get` takes the fallback the caller
 *    wants — 1 for an agent that was already on the field when the console
 *    opened and therefore never animated in, 0 for one that is arriving.
 * 2. **Nothing is kept for an agent that is gone.** `sweep` drops the keys
 *    whose subject the world no longer has, so a fleet that churns for a day
 *    does not leave a map with a hundred thousand dead scalars in it.
 *
 * Under `prefers-reduced-motion` every call lands on its end value in the same
 * turn — including `onDone`, which is what chains a spawn's core into its
 * tile — because `dur()` returns zero and a zero-length tween would still cost
 * a tick.
 *
 * No DOM, no three.js: this is testable on its own.
 */

import gsap from 'gsap';
import { dur, EASE, T } from '../motion.ts';

export interface AnimOpts {
  /** Where the scalar lands. `grow` defaults to 1, `drain` to 0. */
  to?: number;
  /** Seconds, before `dur()` has its say. */
  dur?: number;
  /** A GSAP ease name — always one of `EASE`. */
  ease?: string;
  /** Seconds to wait first: the burst offsets of a squadron forming. */
  delay?: number;
  /** Fires when the value has landed, and synchronously under reduced motion. */
  onDone?(): void;
}

/** One scalar. The tween mutates `v` in place; the field only ever reads it. */
interface Cell { v: number; tw: gsap.core.Tween | null }

const cells = new Map<string, Cell>();

function cellOf(key: string): Cell {
  let c = cells.get(key);
  if (!c) { c = { v: 0, tw: null }; cells.set(key, c); }
  return c;
}

function tween(key: string, to: number, o: AnimOpts, fallbackDur: number, fallbackEase: string): void {
  const c = cellOf(key);
  // A second gesture on the same key replaces the first outright: a tile that
  // dies while it is still growing must not finish growing.
  c.tw?.kill();
  c.tw = null;
  const d = dur(o.dur ?? fallbackDur);
  if (d <= 0) {
    c.v = to;
    o.onDone?.();
    return;
  }
  c.tw = gsap.to(c, {
    v: to,
    duration: d,
    ease: o.ease ?? fallbackEase,
    delay: o.delay ?? 0,
    overwrite: true,
    onComplete() { c.tw = null; o.onDone?.(); },
  });
}

/** Run `key` up to `to` (1 by default) from wherever it stands. */
export function grow(key: string, o: AnimOpts = {}): void {
  tween(key, o.to ?? 1, o, T.move, EASE.inout);
}

/** Run `key` back down to 0 — a core draining toward the parent. */
export function drain(key: string, o: AnimOpts = {}): void {
  tween(key, o.to ?? 0, o, T.move, EASE.inout);
}

/**
 * The value, or `fallback` when nothing ever animated this key. The fallback
 * is the whole interface to "this agent was here before we were": pass 1 and
 * an agent that never spawned in front of the operator is simply finished.
 */
export function get(key: string, fallback = 0): number {
  const c = cells.get(key);
  return c ? c.v : fallback;
}

export function has(key: string): boolean {
  return cells.has(key);
}

/** Land a key on a value with no tween — a cut. */
export function set(key: string, v: number): void {
  const c = cellOf(key);
  c.tw?.kill();
  c.tw = null;
  c.v = v;
}

/** Forget a key and stop whatever was moving it. */
export function kill(key: string): void {
  const c = cells.get(key);
  if (!c) return;
  c.tw?.kill();
  cells.delete(key);
}

/**
 * Drop every key the world no longer has a subject for.
 *
 * Takes either the set of keys worth keeping or a predicate over the key, so
 * the field can answer per prefix — `core:`/`tile:` against the fleet,
 * `sq:` against the squad blocks — without building a set of every live key
 * on every feed.
 */
export function sweep(live: Set<string> | ((key: string) => boolean)): void {
  const keep = typeof live === 'function' ? live : (k: string) => live.has(k);
  for (const [k, c] of cells) {
    if (keep(k)) continue;
    c.tw?.kill();
    cells.delete(k);
  }
}

/** How many scalars are held. For tests and the stats line. */
export function size(): number {
  return cells.size;
}
