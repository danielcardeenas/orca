/**
 * The comp's gestures, reusable over any `.win` and over the controls inside
 * one.
 *
 * The boot sequence (`boot.ts`) already speaks the whole motion vocabulary of
 * the Axolots `/system` comp and then dies at 11.9s. This file is where that
 * vocabulary goes on living: the lime sweep, the pixel check, the collapse to
 * a bar, the glyph bursts — and, since IDENTITY §6, the small ones a window
 * makes every time the operator touches it. Nothing here fades: the comp never
 * fades a confirmation, and a palette change is always a cut.
 *
 * API — nothing else in the console needs wiring for this file:
 *
 *   ── closing (the manager's `closeWith`) ──────────────────────────────
 *   wipe(el, color?)      → Promise<void>  A5, boot.ts:167
 *   check(el)             → Promise<void>  A6 + A12, boot.ts:173-175, :225
 *   collapse(el)          → Promise<void>  A12, boot.ts:225-228
 *   collapseShort(el)     → Promise<void>  A12 short: the normal close
 *
 *   ── opening and folding (IDENTITY §6.1) ─────────────────────────────
 *   assemble(el, text)    → void           A2: 3 scrambled frames, then a cut
 *   stopAssemble(el)      → void           cancel one mid-flight
 *   cascade(container)    → void           A1: `.sec`/`.arow`/`.qrow` by cut
 *   foldTo(el, rect)      → Promise<void>  the housing flies to its tray tile
 *   unfoldFrom(el, rect)  → void           the inverse, on restore
 *
 *   ── controls (IDENTITY §6.2) ────────────────────────────────────────
 *   slabFlash(btn)        → void           invert to ink and cut back
 *   slabBusy(btn)         → () => void     A3 band on the slab's bottom edge
 *   echoKbd(el)           → void           the keyboard echo on a `<kbd>`
 *
 *   ── the rest ────────────────────────────────────────────────────────
 *   glyphBurst(host)      → () => void     A4, boot.ts:161-166 (stop function)
 *   screenFlash(color?)   → void           A19, boot.ts:196-197
 *
 * `el` is the window element (`.win`); the sweep and the check paint over its
 * `.win__body`, the collapses scale the whole housing. They resolve when the
 * gesture is over — they do NOT remove anything from the DOM, because who owns
 * a window is the window manager's business (see `WindowManager.closeWith`).
 *
 * Every duration comes from `T`, every ease from `EASE`, and every tween goes
 * through `dur()`. Under `prefers-reduced-motion` each gesture is a no-op that
 * resolves on the spot and leaves the end state, so a caller can always
 * `await` and then close.
 */

import gsap from 'gsap';
import { beats, dur, EASE, REDUCE, T } from '../motion.ts';

const reduce = () => REDUCE.value;

/**
 * Named colours only — the contract has three, and a hex on a call site is how
 * a fourth accent gets into the world by accident.
 */
const INK: Record<string, string> = {
  lime: '#c0f94a',
  amber: '#f5a524',
  red: '#ff2a12',
};

function bodyOf(el: HTMLElement): HTMLElement {
  return el.querySelector<HTMLElement>('.win__body') ?? el;
}

/* ── A5 · The lime sweep ────────────────────────────────────────────── */

/**
 * A solid bar grows left to right — the direction of reading, which is why the
 * comp uses it for a confirmation and never for the zipper — and the body's ink
 * inverts to `#1a0000` (the ink a lime slab writes with, as on `.tile.is-dead`)
 * as it passes. When it fills, what it ate is cut.
 *
 * The bar sits *under* the body's own children (z-index 0 against their 1) so
 * the text it has reached reads black-on-lime; text it has not reached yet is
 * `#1a0000` on the dark glass, i.e. already eaten. That is the comp's read.
 */
export function wipe(el: HTMLElement, color: string = 'lime'): Promise<void> {
  if (reduce()) return Promise.resolve();
  const body = bodyOf(el);
  const bar = document.createElement('i');
  bar.className = 'winfx winfx--wipe';
  bar.style.background = INK[color] ?? color;
  const eaten = [...body.children] as HTMLElement[];
  body.insertBefore(bar, body.firstChild);
  body.classList.add('is-fx-wipe');

  return new Promise((done) => {
    const tl = gsap.timeline({ onComplete: () => done() });
    tl.fromTo(bar, { scaleX: 0 }, { scaleX: 1, duration: dur(T.wipe), ease: EASE.inout });
    // A cut: everything under the bar goes at once. With nothing to eat it is
    // the same beat of nothing, so the rhythm does not change.
    const eat = dur(T.snap * 1.5);
    tl.to(eaten.length ? eaten : bar, eaten.length ? { autoAlpha: 0, duration: eat } : { duration: eat });
  });
}

/* ── A6 · The pixel check, then A12 ─────────────────────────────────── */

/**
 * The checkmark the comp punches out of the lime square: eight black pixels on
 * an 8×6 grid, drawn one at a time left to right, down four and up four. It is
 * the only "well done" this console has, so it is spent only on `done`.
 */
const CHECK: [number, number][] = [
  [1, 3], [2, 4], [3, 5], [4, 6], [5, 5], [6, 4], [7, 3], [8, 2],
];

export function check(el: HTMLElement): Promise<void> {
  if (reduce()) return Promise.resolve();
  const body = bodyOf(el);
  const board = document.createElement('i');
  board.className = 'winfx winfx--check';
  board.innerHTML =
    `<i class="check__plus check__plus--tl"></i><i class="check__plus check__plus--tr"></i>`
    + `<i class="check__plus check__plus--bl"></i><i class="check__plus check__plus--br"></i>`
    + `<div class="winfx__check">${CHECK.map(([x, y]) =>
      `<i class="winfx__px" style="grid-column:${x};grid-row:${y}"></i>`).join('')}</div>`;
  body.appendChild(board);
  const px = [...board.querySelectorAll<HTMLElement>('.winfx__px')];
  gsap.set(px, { autoAlpha: 0 });

  return new Promise((done) => {
    const tl = gsap.timeline();
    tl.fromTo(board, { scale: 0.82, autoAlpha: 0 },
      { scale: 1, autoAlpha: 1, duration: dur(T.quick), ease: EASE.out }, 0);
    // ~40ms each, as steps. A stagger that eases would read as an animation.
    px.forEach((p, i) => tl.to(p, { autoAlpha: 1, duration: 0.05 }, 0.30 + i * (T.check / 8)));
    // The check is read, then the panel goes the way every lime panel goes.
    tl.call(() => { void collapse(el).then(() => done()); }, undefined,
      0.30 + px.length * 0.04 + 0.10);
  });
}

/* ── A12 · The collapse ─────────────────────────────────────────────── */

/**
 * The panel grows a little, falls to a horizontal bar, and to nothing. Never a
 * fade: in the comp a lime confirmation always leaves as geometry.
 */
export function collapse(el: HTMLElement): Promise<void> {
  if (reduce()) return Promise.resolve();
  return new Promise((done) => {
    const tl = gsap.timeline({ onComplete: () => done() });
    // `.win` sets transform-origin 0 0 for its arrival; the collapse is centred.
    tl.set(el, { transformOrigin: 'center center' });
    tl.to(el, { scaleX: 1.05, scaleY: 1.04, duration: dur(T.snap), ease: EASE.out });
    tl.to(el, { scaleY: 0.02, duration: dur(T.quick * 0.8), ease: EASE.inout });
    tl.to(el, { scaleX: 0, duration: dur(T.snap * 0.7), ease: 'power2.in' });
  });
}

/**
 * The short A12: how an ordinary window leaves.
 *
 * No overshoot and no celebration — the body drops under the housing's edge,
 * the housing flattens to a 2px bar, and the bar is cut. It is the collapse
 * with the applause taken out, which is exactly what closing a window is.
 */
export function collapseShort(el: HTMLElement): Promise<void> {
  if (reduce()) return Promise.resolve();
  const body = el.querySelector<HTMLElement>('.win__body');
  // 2px of whatever height the housing happens to have: the bar the comp
  // leaves behind is a thickness, not a fraction.
  const bar = 2 / Math.max(1, el.offsetHeight);
  return new Promise((done) => {
    const tl = gsap.timeline({ onComplete: () => done() });
    tl.set(el, { transformOrigin: 'center center' });
    if (body) tl.to(body, { yPercent: 120, duration: dur(T.quick * 0.55), ease: EASE.inout }, 0);
    tl.to(el, { scaleY: bar, duration: dur(T.quick), ease: EASE.inout }, 0);
    // The cut. A bar that fades out is a bar apologising for leaving.
    tl.set(el, { autoAlpha: 0 });
  });
}

/* ── A2 · The callsign assembles ────────────────────────────────────── */

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** One frame of the assembly, 60ms apart: three of them make the 0.18s. */
const ASSEMBLE_FRAMES = 3;
const ASSEMBLE_STEP = 0.06;
let asmSeq = 0;

/** Same length, same punctuation, wrong glyphs. `boot.ts`'s `scramble`, sized. */
function scrambleLike(text: string): string {
  let out = '';
  for (const ch of text) {
    out += /[A-Za-z0-9]/.test(ch) ? GLYPHS[(Math.random() * GLYPHS.length) | 0]! : ch;
  }
  return out;
}

/**
 * The wordmark move at callsign scale: three frames of scrambled glyphs at
 * 60ms and then a cut to the real text. Never a fade and never a typewriter —
 * the comp's pixels converge, they do not arrive one letter at a time.
 *
 * Re-entrant: a second call, or `stopAssemble`, abandons the first. The token
 * lives on the element so a rewrite of the header cannot be clobbered by a
 * run that started before it.
 */
export function assemble(el: HTMLElement, text: string): void {
  const token = String(++asmSeq);
  el.dataset.asm = token;
  if (reduce() || !text) { delete el.dataset.asm; el.textContent = text; return; }
  let i = 0;
  const step = () => {
    if (el.dataset.asm !== token) return;
    if (++i > ASSEMBLE_FRAMES) { delete el.dataset.asm; el.textContent = text; return; }
    el.textContent = scrambleLike(text);
    window.setTimeout(step, dur(ASSEMBLE_STEP) * 1000);
  };
  step();
}

/** Abandon a running `assemble` so a live rewrite of the same element wins. */
export function stopAssemble(el: HTMLElement): void { delete el.dataset.asm; }

/* ── A1 · The body cascades ─────────────────────────────────────────── */

/**
 * What a kind builds its interior out of; a cascade knows only these. Depth is
 * deliberately not part of it — every kind wraps its rows in a scroller, and
 * some wrap that, so a scoped selector would find nothing in half of them.
 */
const CASCADE_SEL = '.sec, .arow, .qrow';
/** IDENTITY §6.1: `beats(n)`, compressed to 40ms per step. */
const CASCADE_STEP = 0.04;
/** And never longer than this, however many sections a kind grew. */
const CASCADE_MAX = 0.3;

/**
 * The POST log's cascade, at instrument scale: every section of a freshly
 * mounted body appears **by cut**, on the comp's irregular beat rather than a
 * uniform stagger — `beats(n)` compressed so one step is 40ms.
 *
 * Called once, by the manager, right after a kind mounts. Sections a live
 * re-render adds later do not cascade: the gesture says "this window just
 * opened", and a window that keeps cascading says it forever.
 */
export function cascade(container: HTMLElement): void {
  if (reduce()) return;
  const rows = [...container.querySelectorAll<HTMLElement>(CASCADE_SEL)];
  if (rows.length < 2) return;
  const raw = beats(rows.length);
  // The unit step of `beats` is 0.1s in a burst and 0.3s in a strike; whatever
  // it is, compress it so the smallest real gap becomes 40ms.
  let gap = Infinity;
  for (let i = 1; i < raw.length; i++) {
    const d = raw[i]! - raw[i - 1]!;
    if (d > 1e-6) gap = Math.min(gap, d);
  }
  let k = Number.isFinite(gap) ? CASCADE_STEP / gap : 1;
  const last = raw[raw.length - 1]! * k;
  if (last > CASCADE_MAX) k *= CASCADE_MAX / last;

  gsap.set(rows, { autoAlpha: 0 });
  const tl = gsap.timeline();
  // `set`, not `to`: a section arrives by cut. Only the offsets are the gesture.
  rows.forEach((row, i) => tl.set(row, { autoAlpha: 1 }, dur(raw[i]! * k)));
  tl.set(rows, { clearProps: 'visibility,opacity' });
}

/* ── Folding into the tray, and back out ────────────────────────────── */

export interface FxRect { x: number; y: number; w: number; h: number }

/**
 * The housing flies to its tray tile and shrinks into it, then cuts. `to` is a
 * viewport rect — the tile's own, when the tray already holds one, and the
 * bottom-left corner when it does not.
 *
 * The transform is cleared on the way out, so the manager's `left/top` stay
 * the one truth about where a window is.
 */
export function foldTo(el: HTMLElement, to: FxRect): Promise<void> {
  if (reduce()) return Promise.resolve();
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return Promise.resolve();
  const dx = (to.x + to.w / 2) - (r.left + r.width / 2);
  const dy = (to.y + to.h / 2) - (r.top + r.height / 2);
  gsap.killTweensOf(el);
  return new Promise((done) => {
    gsap.fromTo(el,
      { x: 0, y: 0, scaleX: 1, scaleY: 1, transformOrigin: 'center center' },
      {
        x: dx, y: dy, scaleX: to.w / r.width, scaleY: to.h / r.height,
        duration: dur(T.quick), ease: EASE.inout,
        onComplete: () => { gsap.set(el, { clearProps: 'transform' }); done(); },
      });
  });
}

/** The inverse: the window arrives out of the tile it was folded into. */
export function unfoldFrom(el: HTMLElement, from: FxRect): void {
  if (reduce()) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dx = (from.x + from.w / 2) - (r.left + r.width / 2);
  const dy = (from.y + from.h / 2) - (r.top + r.height / 2);
  gsap.killTweensOf(el);
  gsap.fromTo(el,
    { x: dx, y: dy, scaleX: from.w / r.width, scaleY: from.h / r.height, transformOrigin: 'center center' },
    {
      x: 0, y: 0, scaleX: 1, scaleY: 1,
      duration: dur(T.quick), ease: EASE.inout, clearProps: 'transform',
    });
}

/* ── §6.2 · The controls ────────────────────────────────────────────── */

/**
 * The comp's local flash, on the slab that just took an order: it inverts to
 * ink for `T.snap` and cuts back. Two cuts, no fade — a palette never eases.
 *
 * Red is exempt. The armed STOP is the one button in the console that must
 * look like it is not going to move, and red does not animate.
 */
export function slabFlash(btn: HTMLElement | null | undefined): void {
  if (!btn || reduce()) return;
  if (btn.classList.contains('slab-btn--red')) return;
  btn.classList.add('is-flash');
  window.setTimeout(() => btn.classList.remove('is-flash'), dur(T.snap) * 1000);
}

/**
 * A3, at the size of a button: the thin loading band runs along the slab's
 * bottom edge while the action is out with the hub, and stops when the ack
 * comes back. Progress is never claimed — the band reports that something is
 * in flight, which is the only honest thing a console knows here.
 *
 *   const done = slabBusy(btn);
 *   try { await hub.cmd(...); } finally { done(); }
 */
export function slabBusy(btn: HTMLElement | null | undefined): () => void {
  if (!btn) return () => { /* nothing to stop */ };
  btn.classList.add('is-busy');
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    btn.classList.remove('is-busy');
  };
}

/**
 * The keyboard echo: the cap of the chord that just fired cuts to lime and
 * falls back after `T.snap`. It is how a key press proves it landed on the
 * button it promised, without moving the button.
 */
export function echoKbd(el: HTMLElement | null | undefined): void {
  if (!el || reduce()) return;
  el.classList.add('is-echo');
  window.setTimeout(() => el.classList.remove('is-echo'), dur(T.snap) * 1000);
}

/* ── A4 · Glyphs in bursts ──────────────────────────────────────────── */

/**
 * The handshake glyphs, looping: four in, half a second of nothing, four more.
 * The pause is the whole point — a constant stagger reads as an animation, an
 * irregular one reads as a machine thinking. This replaces every spinner.
 *
 * Fills `host` with eight `.glyph` spans (the boot's markup, styled in
 * window.css for the smaller size) and returns the stop function.
 */
export function glyphBurst(host: HTMLElement): () => void {
  host.innerHTML = Array.from({ length: 8 })
    .map(() => `<span class="glyph"><i></i><i></i><i></i><i></i></span>`).join('');
  const gs = [...host.querySelectorAll<HTMLElement>('.glyph')];
  if (reduce()) {
    // Reduced motion still deserves the "it is thinking" signal, just still.
    gsap.set(gs, { autoAlpha: 1, scale: 1 });
    return () => { /* nothing running */ };
  }
  gsap.set(gs, { autoAlpha: 0, scale: 0.6 });
  const tl = gsap.timeline({ repeat: -1 });
  // boot.ts:161-166 verbatim: the burst offsets `beats()` already speaks.
  const off = beats(gs.length);
  gs.forEach((g, i) => {
    tl.to(g, { autoAlpha: 1, scale: 1, duration: dur(T.snap), ease: EASE.arrive }, off[i]!);
  });
  tl.to(gs, { autoAlpha: 0, duration: dur(T.snap * 1.5) }, 1.16);
  tl.set(gs, { scale: 0.6 }, 1.40);
  return () => { tl.kill(); };
}

/* ── A19 · The lime flash ───────────────────────────────────────────── */

/**
 * One frame of lime over the whole field. The only celebration the contract
 * allows, and it is spent on a fleet going up. Reuses the element the alarm
 * already owns (`[data-alarm-flash]` in index.html).
 */
export function screenFlash(color: string = 'lime'): void {
  if (reduce()) return;
  const flash = document.querySelector<HTMLElement>('[data-alarm-flash]');
  if (!flash) return;
  gsap.killTweensOf(flash);
  gsap.set(flash, { background: INK[color] ?? color });
  gsap.fromTo(flash, { opacity: 0.55 }, { opacity: 0, duration: dur(T.flash * 1.8), ease: EASE.none });
}
