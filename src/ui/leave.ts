/**
 * Removing a node, reliably.
 *
 * Every list in this console animates items out and removes them in the
 * animation's `onComplete`. That is a leak waiting to happen: GSAP drops
 * `onComplete` when a tween is killed, and a tween gets killed whenever a later
 * repaint touches the same element — which, in a console driven by a live
 * fleet, is constantly.
 *
 * Measured: with a churning fleet the deck grew from 47 tiles to 6,179 and the
 * DOM from 1,541 nodes to 156,672 in three minutes. Nothing looked wrong on
 * screen; the leaving nodes were transparent and zero-height. A tab left open
 * for a working day would have died.
 *
 * So removal never depends on an animation finishing. The animation is
 * decoration; three independent things guarantee the node actually goes:
 *
 *   1. `onComplete` when the tween does finish (the fast, common path)
 *   2. a timer, in case the tween is killed
 *   3. a sweep on the next repaint, in case the timer is throttled — which is
 *      exactly what a background tab does to timers
 */

import gsap from 'gsap';

const LEAVING = 'data-leaving';

/** How long after starting to leave a node is force-removed. */
const HARD_LIMIT_MS = 1200;

export interface LeaveOptions {
  /** Tween applied while leaving. Defaults to a quick collapse. */
  to?: gsap.TweenVars;
  /** Runs once, immediately, before the tween — e.g. to append a wipe. */
  before?: (node: HTMLElement) => void;
}

/**
 * Start removing `node`. Safe to call twice: the second call is a no-op, which
 * matters because a repaint can decide the same node should leave again before
 * the first animation has finished.
 */
export function leave(node: HTMLElement, opts: LeaveOptions = {}): void {
  if (node.hasAttribute(LEAVING)) return;
  node.setAttribute(LEAVING, String(Date.now()));

  const drop = () => {
    // remove() on a detached node is a no-op, so this is safe to call thrice.
    node.remove();
  };

  opts.before?.(node);

  gsap.to(node, {
    autoAlpha: 0,
    scale: 0.92,
    duration: 0.18,
    ease: 'power2.in',
    ...opts.to,
    onComplete: drop,
  });

  const t = window.setTimeout(drop, HARD_LIMIT_MS);
  // A background tab throttles this timer to minutes; the sweep below is what
  // actually covers that case.
  void t;
}

/**
 * Force-remove anything that started leaving and is still here. Call from each
 * list's repaint — it is O(leaving), not O(list), and leaving is normally zero.
 */
export function sweepLeaving(host: ParentNode, olderThanMs = HARD_LIMIT_MS): number {
  const stale = host.querySelectorAll<HTMLElement>(`[${LEAVING}]`);
  if (stale.length === 0) return 0;
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const node of stale) {
    if (Number(node.getAttribute(LEAVING)) <= cutoff) { node.remove(); removed++; }
  }
  return removed;
}

/** True while a node is on its way out; skip it in reconciliation. */
export function isLeaving(node: HTMLElement): boolean {
  return node.hasAttribute(LEAVING);
}
