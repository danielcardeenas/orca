/**
 * The context menu: one instrument, every right click.
 *
 * A menu is a list of things that can be done to what was under the pointer,
 * and nothing else — no state of its own, no memory. Whoever opens it hands
 * over the rows; the menu draws them, takes one choice, and is gone. There is
 * only ever one on the glass: opening a second closes the first by cut.
 *
 * Gestures follow the `pick` control (docs/IDENTITY.md §6.2), because a menu
 * that opened differently from the dropdown next to it would be a second
 * vocabulary: rows fall in cascade at 20 ms by cut, the chosen row jumps to
 * ink for one frame, cuts to lime, and the menu cuts away after `T.snap`.
 * With reduced motion the choice lands at once.
 *
 * Keyboard: ↑↓ walk, ↵ takes the row under the cursor, Esc leaves, and a
 * row's own key (the `kbd` on its right) takes it directly. While the menu
 * is open the keyboard is the menu's — the capture-phase listener swallows
 * every keydown, so the window manager and the field never see the Esc.
 */

import gsap from 'gsap';
import { dur, REDUCE, T } from '../motion.ts';
import { esc } from '../util.ts';
import { getSound } from './sound.ts';

export type MenuItem =
  | {
    label: string;
    /** A second, dimmer word: a callsign, a count, why it is off. */
    hint?: string;
    /** Single key that takes this row while the menu is open. Also drawn. */
    key?: string;
    /** Amber is what needs a person; red is a stop. Default is ink. */
    tone?: 'amber' | 'red' | 'lime';
    /** Listed but not takeable — the reason goes in `hint`. */
    off?: boolean;
    run: () => void;
  }
  | { sep: true }
  | { head: string; sub?: string };

export interface MenuOpts {
  /** First line of the menu: what this is a menu *of*. */
  title?: string;
  sub?: string;
}

/** How far the menu stands from the pointer, so the first row is not under it. */
const OFFSET = 4;
const MARGIN = 8;

let current: HTMLElement | null = null;
let closing: gsap.core.Tween | null = null;
let teardown: (() => void) | null = null;

export function menuOpen(): boolean {
  return current !== null;
}

/** Close the open menu, if any, by cut. */
export function closeMenu(): void {
  if (!current) return;
  closing?.kill();
  closing = null;
  teardown?.();
  teardown = null;
  current.remove();
  current = null;
}

/**
 * Open a menu at a screen point. Empty lists — or lists with nothing takeable
 * — open nothing: a menu with no verbs is a shrug, and the console does not
 * shrug.
 */
export function openMenu(at: { x: number; y: number }, items: MenuItem[], opts: MenuOpts = {}): void {
  closeMenu();
  const rows = items.filter((it): it is Extract<MenuItem, { label: string }> => 'label' in it);
  if (!rows.some((r) => !r.off)) return;

  const el = document.createElement('div');
  el.className = 'ctx';
  el.setAttribute('role', 'menu');
  let html = '';
  if (opts.title) html += `<div class="ctx__head"><b>${esc(opts.title)}</b>${opts.sub ? `<span>${esc(opts.sub)}</span>` : ''}</div>`;
  let i = 0;
  const takeable: { el: HTMLElement | null; it: Extract<MenuItem, { label: string }> }[] = [];
  for (const it of items) {
    if ('sep' in it) { html += `<i class="ctx__sep"></i>`; continue; }
    if ('head' in it) { html += `<div class="ctx__group"><b>${esc(it.head)}</b>${it.sub ? `<span>${esc(it.sub)}</span>` : ''}</div>`; continue; }
    const cls = ['ctx__item', it.tone ? `ctx__item--${it.tone}` : '', it.off ? 'is-off' : ''].filter(Boolean).join(' ');
    html += `<button class="${cls}" type="button" role="menuitem" data-i="${i}" style="--i:${i}"${it.off ? ' disabled' : ''}>`
      + `<b>${esc(it.label)}</b>`
      + `<span>${it.hint ? esc(it.hint) : ''}${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</span>`
      + `</button>`;
    takeable.push({ el: null, it });
    i++;
  }
  el.innerHTML = html;
  el.querySelectorAll<HTMLElement>('[data-i]').forEach((b) => { takeable[Number(b.dataset.i)]!.el = b; });

  document.body.appendChild(el);
  current = el;

  /* Keep it on the glass: flip left of or above the pointer at the edges. */
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = at.x + OFFSET, y = at.y + OFFSET;
  if (x + w + MARGIN > innerWidth) x = Math.max(MARGIN, at.x - OFFSET - w);
  if (y + h + MARGIN > innerHeight) y = Math.max(MARGIN, Math.min(at.y - OFFSET - h, innerHeight - h - MARGIN));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
  if (!REDUCE.value) el.classList.add('is-cascade');

  getSound()?.play('select');

  let active = -1;
  function paint() {
    takeable.forEach((r, k) => r.el?.classList.toggle('is-sel', k === active));
  }
  function step(dir: 1 | -1) {
    const n = takeable.length;
    if (!n) return;
    let k = active;
    for (let tries = 0; tries < n; tries++) {
      k = (k + dir + n) % n;
      if (!takeable[k]!.it.off) { active = k; break; }
    }
    paint();
  }
  function take(k: number) {
    const r = takeable[k];
    if (!r || r.it.off || el !== current) return;
    const done = () => { closeMenu(); r.it.run(); };
    if (!r.el || REDUCE.value) { done(); return; }
    // Ink for one frame, lime for one beat, then the cut. `pick` does the same.
    r.el.classList.add('is-hit');
    requestAnimationFrame(() => {
      r.el?.classList.remove('is-hit');
      r.el?.classList.add('is-took');
      closing = gsap.delayedCall(dur(T.snap), done);
    });
  }

  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (b) take(Number(b.dataset.i));
  });
  el.addEventListener('pointermove', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (!b) return;
    const k = Number(b.dataset.i);
    if (k !== active) { active = k; paint(); }
  });
  // The menu's own right click is nothing: never the browser's menu on top of ours.
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  const onDown = (e: PointerEvent) => { if (!el.contains(e.target as Node)) closeMenu(); };
  const onKey = (e: KeyboardEvent) => {
    if (closing) { e.preventDefault(); e.stopPropagation(); return; }
    switch (e.key) {
      case 'Escape': closeMenu(); break;
      case 'ArrowDown': step(1); break;
      case 'ArrowUp': step(-1); break;
      case 'Tab': step(e.shiftKey ? -1 : 1); break;
      case 'Enter': case ' ': if (active >= 0) take(active); break;
      default: {
        if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
        const k = e.key.toLowerCase();
        const hit = takeable.findIndex((r) => !r.it.off && r.it.key?.toLowerCase() === k);
        if (hit < 0) return;
        take(hit);
      }
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const onAway = () => closeMenu();
  const onWheel = (e: WheelEvent) => { if (!el.contains(e.target as Node)) closeMenu(); };
  window.addEventListener('pointerdown', onDown, { capture: true });
  window.addEventListener('keydown', onKey, { capture: true });
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  window.addEventListener('blur', onAway);
  window.addEventListener('resize', onAway);
  teardown = () => {
    window.removeEventListener('pointerdown', onDown, { capture: true });
    window.removeEventListener('keydown', onKey, { capture: true });
    window.removeEventListener('wheel', onWheel, { capture: true });
    window.removeEventListener('blur', onAway);
    window.removeEventListener('resize', onAway);
  };
}
