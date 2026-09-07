/**
 * Merging conversation blocks, the same way on both ends.
 *
 * The hub appends what collectors send; the console appends what the hub
 * sends. Both have to answer the same question — where does this block go? —
 * and answer it the same way, or the operator reads one order in the window
 * and the hub stores another. So the rule lives here, once:
 *
 *  - a block already known (same id) is not a new block. A collector that
 *    reconnects re-reads its transcript's tail and sends the same blocks
 *    again; a console that resyncs gets the whole list again.
 *  - order is by time, and ties keep the order of arrival. The transcript is
 *    append-only and its timestamps grow with the file; what breaks order is
 *    *delivery*: a replay after a hub restart hands over yesterday's blocks
 *    after today's. Sorting on `at` puts them back where they happened. Ties
 *    (the blocks of one line share a timestamp) keep transcript order because
 *    the sort is stable and arrival order is transcript order.
 *  - the list is bounded to MAX_TALK, newest kept.
 */

import type { TalkItem } from './types.ts';
import { MAX_TALK } from './types.ts';

export function mergeTalk(current: readonly TalkItem[], incoming: readonly TalkItem[], max = MAX_TALK): TalkItem[] {
  const seen = new Set(current.map((t) => t.id));
  const fresh: TalkItem[] = [];
  for (const it of incoming) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    fresh.push(it);
  }
  if (fresh.length === 0) return current as TalkItem[];
  const all = current.concat(fresh);
  // Only sort when something actually arrived out of order: the common case
  // (live tail) is already sorted, and a stable sort of a sorted list is a
  // no-op anyway, but skipping it keeps the hot path cheap.
  let sorted = true;
  for (let i = 1; i < all.length; i++) if (all[i]!.at < all[i - 1]!.at) { sorted = false; break; }
  const out = sorted ? all : all.slice().sort((a, b) => a.at - b.at);
  return out.length > max ? out.slice(out.length - max) : out;
}
