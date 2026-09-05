/**
 * The cursor: an 8px difference-blend square, opening to a reticle over
 * anything live. The native cursor is hidden everywhere but text inputs.
 *
 * It has two gestures, both from IDENTITY §6.3, and neither of them fades:
 *
 *   - **Click.** The square pinches to half its size and comes back in
 *     `T.snap`. It is the only acknowledgement a click gets before whatever
 *     it opened arrives, and the machine that does not answer the hand feels
 *     broken.
 *   - **Blocked.** Over anything the operator cannot go through — a blocked
 *     window, an amber tray tile, an amber tile in the field — the reticle
 *     **cuts** to amber. A palette change, so one frame, never a transition.
 *
 * The field has no DOM to hover, so it says so itself: `setAmber(true)` while
 * the tile under the pointer is one of its amber ones. Nobody has to call it;
 * the DOM side stands on its own.
 */

import gsap from 'gsap';
import { EASE, REDUCE, T, dur } from '../motion.ts';

const LIVE = 'button, a, input, select, textarea, summary, .arow, .qrow, .thumb, .chip, .rgn, .tile, .gauge, .win__head, .win__grip, .srf';
/** What the operator cannot answer from here, and what is already shouting. */
const BLOCKED = '.is-blocked, .is-alert, .tile.is-alert';

export interface CursorHandle {
  setTarget(on: boolean): void;
  /** The field's amber flag: the tile under the pointer wants a person. */
  setAmber(on: boolean): void;
  dispose(): void;
}

export function mountCursor(): CursorHandle {
  const el = document.querySelector<HTMLElement>('[data-cursor]');
  if (!el || !matchMedia('(pointer: fine)').matches) {
    el?.remove();
    document.body.style.cursor = 'auto';
    return { setTarget() { /* touch: no cursor */ }, setAmber() { /* touch: no cursor */ }, dispose() { /* nothing */ } };
  }
  let fieldTarget = false;
  let domTarget = false;
  let fieldAmber = false;
  let domAmber = false;
  const paint = () => {
    el.classList.toggle('is-target', fieldTarget || domTarget);
    el.classList.toggle('is-amber', fieldAmber || domAmber);
  };
  const move = (e: PointerEvent) => {
    el.style.left = `${e.clientX}px`;
    el.style.top = `${e.clientY}px`;
    const t = e.target as HTMLElement | null;
    const hit = !!t && !!t.closest?.(LIVE);
    const bad = !!t && !!t.closest?.(BLOCKED);
    if (hit !== domTarget || bad !== domAmber) { domTarget = hit; domAmber = bad; paint(); }
  };
  // The pinch. `scale` composes with the centring translate GSAP reads off the
  // element, so the square stays under the point it was clicked at.
  const down = () => {
    if (REDUCE.value) return;
    gsap.killTweensOf(el);
    gsap.fromTo(el, { scale: 0.5 }, { scale: 1, duration: dur(T.snap), ease: EASE.out });
  };
  window.addEventListener('pointermove', move, { passive: true });
  window.addEventListener('pointerdown', down, { passive: true, capture: true });
  return {
    setTarget(on) { if (on !== fieldTarget) { fieldTarget = on; paint(); } },
    setAmber(on) { if (on !== fieldAmber) { fieldAmber = on; paint(); } },
    dispose() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', down, true);
      gsap.killTweensOf(el);
    },
  };
}
