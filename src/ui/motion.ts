/**
 * Motion — the single source of truth for how ORCA moves.
 *
 * Three engines animate the console: GSAP (windows, boot, fx), CSS (bands,
 * hover, fades) and the shaders (breathing, travelling bands, flashes). Each
 * used to carry its own numbers. They all read from here now, so one change
 * moves all three the same way.
 *
 * The contract, taken from the Offworld comp frame by frame:
 *
 *   - Shapes ease, palettes cut. A colour change is one frame, never a fade.
 *   - Nothing arrives at a constant rhythm. Glyphs come in bursts, tiles light
 *     in beats of 4-2-3-5-2-6. A uniform stagger reads as an animation; an
 *     irregular one reads as a machine. Use `beats()`.
 *   - Red does not animate. The red square on the radar sits still for four
 *     seconds between moving beams; the stillness is what makes it visible.
 *   - A fill grows from an origin that means something: left for reading,
 *     centre for symmetric sync, the parent for a spawn.
 *   - `prefers-reduced-motion` removes motion, never information. Every tween
 *     goes through `dur()` so it collapses to zero and the end state lands.
 */

import gsap from 'gsap';

/* ── Durations, in seconds ────────────────────────────────────────── */

export const T = {
  /** A state flip. Instruments snap, they do not cross-fade. */
  snap: 0.12,
  /** A window arriving, a panel appearing. */
  quick: 0.28,
  /** A wipe or a fill. */
  move: 0.55,
  /** The lime wipe that confirms an answer (comp: password beat). */
  wipe: 0.5,
  /** The eight pixels of the check, drawn one by one. */
  check: 0.32,
  /** The fleet heartbeat: a tile flashing on a state change. */
  flash: 0.12,
  /** Reference for a camera flight; the camera eases exponentially toward
   *  this feel, it does not run a tween. */
  fly: 0.9,
} as const;

/* ── Easings ──────────────────────────────────────────────────────── */

/** GSAP names. */
export const EASE = {
  out: 'power2.out',
  inout: 'power2.inOut',
  /** Arrivals: a window, a glyph, a spawned tile. */
  arrive: 'back.out(2)',
  /** Marquees and bands: constant speed, no end state. */
  none: 'none',
} as const;

/** The same curves for CSS. `--ease-out`/`--ease-inout` in tokens.css read these. */
export const EASE_CSS = {
  out: 'cubic-bezier(0.22, 1, 0.36, 1)',
  inout: 'cubic-bezier(0.65, 0, 0.35, 1)',
  /** back.out(2) has no exact bezier; this overshoots by the same ~10%. */
  arrive: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  none: 'linear',
} as const;

/* ── Reduced motion ───────────────────────────────────────────────── */

/**
 * Live, not a snapshot: macOS can flip the preference while the console is
 * open. Mutable on purpose so tests can simulate it.
 */
export const REDUCE = { value: false };

if (typeof matchMedia === 'function') {
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  REDUCE.value = mq.matches;
  mq.addEventListener?.('change', (e) => { REDUCE.value = e.matches; });
}

/** A tween duration that honours the preference: zero means "land at the end". */
export function dur(seconds: number): number {
  return REDUCE.value ? 0 : seconds;
}

/* ── Rhythm ───────────────────────────────────────────────────────── */

/** The comp's tile beats: how many light on each strike. */
const GROUPS = [4, 2, 3, 5, 2, 6];
const BEAT = 0.3;
/** The comp's glyph bursts: four fast, a pause, the rest fast. */
const BURST = 4;
const BURST_STEP = 0.1;
const BURST_PAUSE = 0.5;

/**
 * Offsets, in seconds, for `n` things arriving the way the video's things
 * arrive: never at a constant rhythm.
 *
 * Small counts (up to ten) are the password glyphs — a burst of four at
 * 100 ms, half a second of nothing, then the rest at 100 ms. Larger counts
 * are the align-deck tiles: strikes every ~300 ms that light 4, 2, 3, 5, 2, 6
 * at once, repeating. Everything in one strike shares one offset; that
 * simultaneity is the beat.
 */
export function beats(n: number): number[] {
  const out: number[] = [];
  if (n <= 0) return out;
  if (n <= 10) {
    for (let i = 0; i < n; i++) {
      out.push(i < BURST ? i * BURST_STEP : BURST * BURST_STEP + BURST_PAUSE + (i - BURST) * BURST_STEP);
    }
    return out;
  }
  let strike = 0;
  let g = 0;
  while (out.length < n) {
    const size = GROUPS[g % GROUPS.length]!;
    for (let i = 0; i < size && out.length < n; i++) out.push(strike * BEAT);
    strike++;
    g++;
  }
  return out;
}

/* ── Wiring the engines ───────────────────────────────────────────── */

/** The subset of `documentElement.style` this needs, so tests can pass a fake. */
export interface RootLike { style: { setProperty(name: string, value: string): void } }

/**
 * Write the tokens into `:root` so CSS reads the same numbers. The names
 * match tokens.css; the values there are the fallback for a page where this
 * never ran (the boot, before main.ts).
 */
export function applyToRoot(root?: RootLike): void {
  const r = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (!r) return;
  const s = r.style;
  s.setProperty('--t-snap', `${T.snap}s`);
  s.setProperty('--t-quick', `${T.quick}s`);
  s.setProperty('--t-move', `${T.move}s`);
  s.setProperty('--t-wipe', `${T.wipe}s`);
  s.setProperty('--t-check', `${T.check}s`);
  s.setProperty('--t-flash', `${T.flash}s`);
  s.setProperty('--ease-out', EASE_CSS.out);
  s.setProperty('--ease-inout', EASE_CSS.inout);
  s.setProperty('--ease-arrive', EASE_CSS.arrive);
}

/**
 * GSAP defaults: every tween that does not say otherwise arrives with the
 * console's ease and duration. Reduced motion is handled per tween through
 * `dur()` rather than by scaling the global timeline, so a tween that carries
 * an `onComplete` still fires it in order.
 */
export function gsapDefaults(): void {
  gsap.defaults({ ease: EASE.out, duration: T.quick });
}

/** Shader-side view of the same contract, to hand to uniforms. */
export function shaderMotion(): { reduce: number; flash: number; breathe: number } {
  return {
    reduce: REDUCE.value ? 1 : 0,
    /** Decay rate for `exp(-(t - t0) * k)` so the flash lasts ~T.flash. */
    flash: 4 / T.flash,
    /** Radians per second of the blocked tile's 2.2 s breathing cycle. */
    breathe: (2 * Math.PI) / 2.2,
  };
}
