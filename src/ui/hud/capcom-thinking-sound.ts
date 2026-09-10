import { TURN_AFTER_MS } from '../../shared/capcom.ts';

/** A local activity cue, never a receipt. Snapshots/reconnects consume old
 * requests silently; no timer, loop, replay, or delivery status is involved. */
export class ThinkingSoundGate {
  private consumed = new Set<string>();
  private lastAt = -Infinity;
  private active = false;

  observe(input: { request: { id: string; at: number } | null; processing: boolean;
    baseline: boolean; now: number }): boolean {
    const { request, processing, baseline, now } = input;
    const started = processing && !this.active;
    this.active = processing;
    if (!request) return false;
    if (baseline) { this.remember(request.id); return false; }
    if (!started || this.consumed.has(request.id)) return false;
    this.remember(request.id);
    if (now < request.at || now - request.at > TURN_AFTER_MS || now - this.lastAt < 10_000) return false;
    this.lastAt = now;
    return true;
  }

  private remember(id: string) {
    this.consumed.add(id);
    // The store retains at most 100 outgoing messages.
    if (this.consumed.size > 100) this.consumed.delete(this.consumed.values().next().value!);
  }
}
