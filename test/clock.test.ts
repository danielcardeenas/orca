/**
 * hud/clock.ts — the operator's local time, top right of the mast.
 *
 * What is worth guarding: the text is 24h and zero-padded, every tick lands
 * on the second boundary instead of drifting, and `stop()` clears the tick
 * that is pending, so an unmounted HUD leaves no timer behind.
 */

import { clockText, msToNextSecond, runClock, type ClockIO } from '../src/ui/hud/clock.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

/** A clock and timer that only move when the test pushes them. */
function fakeIO(start: number) {
  let now = start;
  let next = 1;
  const pending = new Map<number, { fn: () => void; at: number }>();
  const io: ClockIO = {
    now: () => now,
    set: (fn, ms) => { const h = next++; pending.set(h, { fn, at: now + ms }); return h; },
    clear: (h) => { pending.delete(h); },
  };
  /** Advance to the next pending tick and fire it. */
  const fire = () => {
    const [h, p] = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
    pending.delete(h); now = p.at; p.fn();
  };
  return { io, pending, fire, set: (ms: number) => { now = ms; } };
}

const mod: TestModule = {
  suite: 'clock',
  tests: [
    test('clockText: 24h, zero-padded, with and without seconds', () => {
      const early = new Date(2026, 8, 6, 0, 5, 9);
      const late = new Date(2026, 8, 6, 23, 59, 59);
      const noon = new Date(2026, 8, 6, 13, 7, 0);
      const a = clockText(early), b = clockText(late), c = clockText(noon, false);
      return ok('clockText', a === '00:05:09' && b === '23:59:59' && c === '13:07', `${a} ${b} ${c}`);
    }),
    test('msToNextSecond: always in (0, 1000], landing on the boundary', () => {
      const cases: [number, number][] = [[0, 1000], [1, 999], [999, 1], [1000, 1000], [123_456_789, 211]];
      const bad = cases.filter(([ms, want]) => msToNextSecond(ms) !== want);
      return eq('msToNextSecond', bad, []);
    }),
    test('runClock: writes now, schedules the next second, and stop() clears it', () => {
      const base = new Date(2026, 8, 6, 14, 30, 15).getTime() + 250;
      const f = fakeIO(base);
      const target = { textContent: null as string | null };
      const stop = runClock(target, f.io);
      const first = target.textContent;
      const scheduled = [...f.pending.values()][0]?.at;
      f.fire();
      const second = target.textContent;
      stop();
      const left = f.pending.size;
      return ok('runClock',
        first === '14:30:15' && scheduled === base + 750 && second === '14:30:16' && left === 0,
        `first=${first} at=+${(scheduled ?? 0) - base}ms second=${second} pending=${left}`);
    }),
    test('runClock: a tick that fires after stop() writes nothing', () => {
      const f = fakeIO(new Date(2026, 8, 6, 9, 0, 0).getTime());
      const target = { textContent: null as string | null };
      const stop = runClock(target, f.io);
      const [h, p] = [...f.pending.entries()][0]!;
      stop();
      // Simulate a timer the host already dispatched before `clear` landed.
      f.pending.delete(h); f.set(p.at); p.fn();
      return ok('silent after stop', target.textContent === '09:00:00' && f.pending.size === 0, `${target.textContent} pending=${f.pending.size}`);
    }),
  ],
};

export default mod;
