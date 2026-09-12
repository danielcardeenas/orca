/**
 * A wheel a canvas window cannot spend goes to the field.
 *
 * A window on the canvas is a thing standing *in* the space, not a page
 * floating over it, so the space has to behave like one surface: scroll a
 * CAPCOM conversation to its last line and the same unbroken gesture should
 * carry on and pan the field. Today it stops dead and the operator has to
 * lift off and start again — twice, because the second gesture lands on the
 * window too and has to be aimed past it.
 *
 * Native overscroll chaining cannot do this. It walks the DOM, and the field
 * is not a window's ancestor — it is its sibling, one layer down (`main.ts`
 * hangs `.field`, `.hud` and `.wm` off `#app` side by side). What is left of
 * the gesture has to be handed over explicitly, the way `onZoom` already
 * hands over a pinch.
 *
 * So this file answers one question, without touching the DOM: given a wheel
 * that landed on `from`, how much of it do the scrollers between `from` and
 * the window housing absorb, and how much is left? The caller (`wm.ts`)
 * decides what to do with each half. Splitting it this way is what keeps the
 * transition frame honest: the part the window can still take and the part
 * the field takes are computed from the same delta, so they add up to the
 * gesture and never to twice it.
 *
 * **`overscroll-behavior` is still the way to opt out.** A scroller that
 * declares `contain` or `none` on an axis swallows what it cannot spend on
 * that axis, and nothing downstream of it sees a remainder — the same
 * contract the browser gives, honoured here because the browser cannot apply
 * it once we have taken the event over. That is how the HUD's lists and the
 * modal dialogs keep the field still under them.
 */

/** Overflow values a wheel can actually scroll. `hidden` is not one. */
const SCROLLS = new Set(['auto', 'scroll', 'overlay']);

/**
 * Wheel units to pixels, with the steps `field/field.ts` uses for its own
 * pan. Both numbers have to agree or a forwarded remainder would move the
 * field by a different amount than the gesture that produced it.
 */
export function wheelPixels(e: { deltaX: number; deltaY: number; deltaMode: number }): { dx: number; dy: number } {
  const step = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 120 : 1;
  return { dx: e.deltaX * step, dy: e.deltaY * step };
}

/** One scroller and the pixels it would take. */
export interface Take { el: HTMLElement; dx: number; dy: number }

/** What the window absorbs, and what is left over for whoever is behind it. */
export interface Share { take: Take[]; dx: number; dy: number }

const clamp = (d: number, back: number, ahead: number) => d < 0 ? Math.max(d, -back) : Math.min(d, ahead);

/**
 * Spread `dx`/`dy` (pixels) over the scrollers from `from` up to — and not
 * including — `stop`. Reads geometry only; call `spend` to make it happen.
 */
export function share(from: Element | null, stop: Element, dx: number, dy: number): Share {
  const take: Take[] = [];
  for (let n = from; n && n !== stop; n = n.parentElement) {
    if (!(n instanceof HTMLElement)) continue;
    // Geometry before style: `getComputedStyle` on every element of every
    // wheel event is the expensive half, and most of them cannot scroll.
    const roomY = n.scrollHeight - n.clientHeight > 1;
    const roomX = n.scrollWidth - n.clientWidth > 1;
    if (!roomY && !roomX) continue;
    const cs = getComputedStyle(n);
    let ty = 0, tx = 0;
    if (dy && roomY && SCROLLS.has(cs.overflowY)) {
      ty = clamp(dy, n.scrollTop, n.scrollHeight - n.clientHeight - n.scrollTop);
      dy -= ty;
      if (dy && cs.overscrollBehaviorY !== 'auto') dy = 0;
    }
    if (dx && roomX && SCROLLS.has(cs.overflowX)) {
      tx = clamp(dx, n.scrollLeft, n.scrollWidth - n.clientWidth - n.scrollLeft);
      dx -= tx;
      if (dx && cs.overscrollBehaviorX !== 'auto') dx = 0;
    }
    if (ty || tx) take.push({ el: n, dx: tx, dy: ty });
    if (!dx && !dy) break;
  }
  return { take, dx, dy };
}

/** Apply what `share` worked out. */
export function spend(take: Take[]): void {
  for (const t of take) {
    if (t.dy) t.el.scrollTop += t.dy;
    if (t.dx) t.el.scrollLeft += t.dx;
  }
}
