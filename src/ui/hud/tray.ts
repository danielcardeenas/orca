/**
 * The tray: the window stack, bottom-left, as the comp's notched tiles.
 *
 *   [ K9 ][ CAPCOM ][ QUEUE ] | [ FEED ][ TIME ]
 *     open, active first        ·  folded
 *
 * Everything open is on the left, the active one lime; a thin separator; then
 * the folded ones, which is all the tray used to hold. A tile is lit by the
 * state of what it holds — amber for an interrupt or a blocked agent, lime for
 * the window that has the keyboard — so a window still reports from down here.
 *
 * A tile opens or minimizes its window without changing its placement mode.
 * Retrieving a distant canvas window flies the camera to it. Closing is
 * explicit in the context menu or through the tray keyboard controls.
 *
 * ── Tray mode ────────────────────────────────────────────────────────
 *
 * `` ` `` hands the row the keyboard (`wm.enterTrayMode()`). The row lifts,
 * takes a lime edge, and a cursor — the comp's pixel `+` over a lime outline —
 * walks it with `←/→`. Every tile wears its index while the mode is on, so
 * `1…9` jumps. The manager owns the keys; the tray only draws them.
 *
 * ── Motion (IDENTITY §6.3) ───────────────────────────────────────────
 *
 * The row used to be one `innerHTML` string, which meant every tile was born
 * and died on every focus change and nothing could be animated. It is keyed
 * now: one slot element per window id, kept across draws, reordered in place.
 * That buys the three gestures:
 *
 *   - **A tile arrives** with `back.out(2)` from scale 0.6, in `T.quick`. It
 *     is the same arrival the window it came from makes, at tray scale.
 *   - **A tile leaves** the way a confirmation modal does (A12, short): it
 *     drops out of the flow so the row closes by cut, flattens to a 2 px bar
 *     in `T.quick`, and cuts.
 *   - **Tray mode** lifts the row 4 px in `T.snap` — a shape, so it eases —
 *     while the lime edge and the background cut in from CSS. Leaving is the
 *     inverse.
 *
 * Reduced motion lands all three at their end state: `dur()` for the tweens,
 * and the leave removes the tile outright.
 */

import gsap from 'gsap';
import type { Win, WindowManager } from '../windows/wm.ts';
import { EASE, REDUCE, T, dur } from '../motion.ts';
import { esc } from '../util.ts';
import { longPress } from './longpress.ts';

/**
 * The lit state of one tile.
 *
 * Open: lime is where the keyboard is, and nothing else in the row is lime —
 * the amber of a blocked window is already on its own header, and one lime in
 * the row is what makes the row readable as a stack. Folded: the old rule,
 * lit by what it holds, because a folded window has no other way to report.
 */
function lit(w: Win, active: boolean): string {
  const blocked = w.el.classList.contains('is-blocked');
  const dead = w.el.classList.contains('is-dead') || w.el.classList.contains('is-breach');
  const live = w.stateVar === 'var(--lime)' || w.stateVar === 'var(--st-working)';
  return active ? 'is-on'
    : blocked ? 'is-alert'
    : dead ? 'is-dead'
    : !w.minimized ? ''
    : live ? 'is-on' : '';
}

/**
 * The placement line under the callsign: `canvas`, `front`, `fixed`,
 * `folded` — and `off view` for a canvas window the camera has left behind.
 *
 * That last one is not a fifth mode, it is the same `canvas` seen from the
 * operator's side: the window is somewhere in the world with nothing of it on
 * the glass, and this tile is the only evidence it is open at all. Saying
 * `canvas` there is true and useless, which is the kind of true this console
 * tries not to be.
 */
function place(w: Win, off: boolean): string {
  if (w.minimized) return 'folded';
  if (w.mode === 'pinned') return 'fixed';
  return off ? 'off view' : w.mode;
}

/** What goes inside the button. Only the first nine can be jumped to. */
function inner(w: Win, index: number, mode: boolean, off: boolean): string {
  const label = w.spec.callsign ?? w.spec.kind.toUpperCase();
  const cap = mode && index <= 9 ? `<kbd class="key tile__n">${index}</kbd>` : '';
  return `<span>${esc(label.slice(0, 6))}</span><small>${esc(place(w, off))}</small>${cap}`;
}

export function mountTray(host: HTMLElement, wm: WindowManager, onContext?: (w: Win, x: number, y: number) => void): { render(list?: Win[]): void } {
  const el = document.createElement('div');
  el.className = 'tray';
  host.appendChild(el);

  /* One slot per window id, alive for as long as the window is. The slot
     exists for the cursor: `.tile` carries the world's clip-path, and a
     clip-path eats outlines and pseudo-elements alike. The mark rides outside. */
  const slots = new Map<string, HTMLElement>();
  const sep = document.createElement('i');
  sep.className = 'tray__sep';
  let lifted = false;
  let first = true;

  function make(): HTMLElement {
    const slot = document.createElement('span');
    slot.className = 'tray__slot';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tile';
    slot.appendChild(btn);
    return slot;
  }

  /** Arrival: the window's own gesture, at 58×44. */
  function arrive(slot: HTMLElement) {
    if (REDUCE.value) return;
    gsap.fromTo(slot, { scale: 0.6 }, { scale: 1, duration: dur(T.quick), ease: EASE.arrive });
  }

  /** A12, short: out of the flow, flat to a 2 px bar, cut. */
  function leave(slot: HTMLElement) {
    gsap.killTweensOf(slot);
    if (REDUCE.value) { slot.remove(); return; }
    // Measured before it leaves the flow, so it stays where the eye left it.
    const x = slot.offsetLeft;
    const y = slot.offsetTop;
    const w = slot.offsetWidth;
    const h = Math.max(1, slot.offsetHeight);
    slot.classList.add('is-gone');
    slot.style.left = `${x}px`;
    slot.style.top = `${y}px`;
    slot.style.width = `${w}px`;
    slot.style.height = `${h}px`;
    gsap.to(slot, {
      scaleY: 2 / h,
      duration: dur(T.quick),
      ease: EASE.inout,
      transformOrigin: 'center center',
      onComplete: () => slot.remove(),
    });
  }

  function draw() {
    const open = wm.stack();
    const folded = wm.trayList();
    const mode = wm.trayMode();
    const cursor = wm.trayCursorId();
    const active = open.find((w) => w.focused) ?? null;
    const list: { w: Win; on: boolean }[] = [
      ...open.map((w) => ({ w, on: w === active })),
      ...folded.map((w) => ({ w, on: false })),
    ];
    /* The rule is unchanged: a separator only where both sides exist. */
    const sepAt = open.length && folded.length ? open.length : -1;

    const seen = new Set<string>();
    const order: HTMLElement[] = [];
    const born: HTMLElement[] = [];

    list.forEach((it, i) => {
      seen.add(it.w.id);
      let slot = slots.get(it.w.id);
      if (!slot) { slot = make(); slots.set(it.w.id, slot); born.push(slot); }
      const btn = slot.firstElementChild as HTMLElement;
      const off = wm.offView(it.w);
      const cls = ['tile', lit(it.w, it.on), off ? 'is-away' : ''].filter(Boolean).join(' ');
      if (btn.className !== cls) btn.className = cls;
      if (btn.dataset.w !== it.w.id) btn.dataset.w = it.w.id;
      const title = `${it.w.spec.title ?? it.w.spec.kind} · ${it.w.minimized ? 'Open window' : off ? 'Fly to window' : it.on ? 'Minimize or locate window' : 'Open window'}`;
      if (btn.title !== title) btn.title = title;
      const html = inner(it.w, i + 1, mode, off);
      if (btn.innerHTML !== html) btn.innerHTML = html;
      slot.classList.toggle('is-cursor', it.w.id === cursor);
      if (i === sepAt) order.push(sep);
      order.push(slot);
    });

    for (const [id, slot] of Array.from(slots)) {
      if (seen.has(id)) continue;
      slots.delete(id);
      leave(slot);
    }
    if (sepAt < 0) sep.remove();

    // Reorder only when the order actually moved: re-inserting a node restarts
    // its CSS animations, and the row redraws on every focus change.
    const now = Array.from(el.children).filter((n) => !n.classList.contains('is-gone'));
    if (now.length !== order.length || now.some((n, i) => n !== order[i])) {
      for (const n of order) el.appendChild(n);
    }
    // On the first draw the windows were already there; they did not arrive.
    if (!first) born.forEach(arrive);

    el.classList.toggle('is-mode', mode);
    if (mode !== lifted) {
      lifted = mode;
      // The lift is a shape, so it eases; the lime edge is a palette, so CSS
      // cuts it. `gsap` owns the transform — hud.css must not set one here.
      gsap.to(el, { y: mode ? -4 : 0, duration: dur(T.snap), ease: EASE.out });
    }
    first = false;
  }

  // Delegated once: the tray redraws on every focus change, and a listener
  // per tile per redraw is a leak the operator would eventually feel.
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-w]');
    if (!b) return;
    const w = wm.all().find((x) => x.id === b.dataset.w);
    if (!w) return;
    wm.exitTrayMode();
    wm.toggleWindow(w);
  });

  // A tile's menu is its window's menu: the same rows the chrome gives —
  // con el dedo, manteniéndola pulsada.
  longPress(el, { allow: (t) => !!t.closest('[data-w]') });
  el.addEventListener('contextmenu', (e) => {
    const b = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-w]');
    if (!b) return;
    const w = wm.all().find((x) => x.id === b.dataset.w);
    if (!w) return;
    e.preventDefault();
    e.stopPropagation();
    onContext?.(w, e.clientX, e.clientY);
  });

  // The argument is what `onTray` has always passed; the tray reads the whole
  // stack from the manager either way, so `onStack` can drive it as well.
  return { render() { draw(); } };
}
