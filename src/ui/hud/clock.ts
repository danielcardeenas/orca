/**
 * The clock: the operator's local time, top right of the mast, 24h with
 * seconds. A readout, not a control — it opens nothing and answers no key.
 *
 * It sits in the mast's flow, after the gauges, pushed to the right edge by
 * an auto margin: the tools wrap to their own row on any ordinary screen,
 * and that leaves the first row's right corner free. On a screen wide enough
 * for one row the tools take the slack and the clock closes the gauge row.
 * In the flow, so it can never cover a tool or a window; before the tools, so
 * it never pushes them down a row.
 *
 * The seconds are deliberate. The mast already ticks (tele every 700 ms,
 * counters landing) and a clock that only moved once a minute would read as
 * a frozen instrument next to it. The digits are tabular, so the column
 * never reflows.
 *
 * Ticks land on the second boundary instead of drifting on a `setInterval`:
 * each write schedules the next one for the moment the second turns.
 */

/** `HH:MM:SS` (or `HH:MM`) in the operator's local time, 24h, zero-padded. */
export function clockText(d: Date, seconds = true): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return seconds ? `${hm}:${p(d.getSeconds())}` : hm;
}

/** Milliseconds until the next second turns: always in (0, 1000]. */
export function msToNextSecond(nowMs: number): number {
  return 1000 - (nowMs % 1000);
}

/** The timer and clock the runner leans on. Injected so a test can hold them still. */
export interface ClockIO {
  now(): number;
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

const REAL: ClockIO = {
  now: () => Date.now(),
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (h) => window.clearTimeout(h),
};

/**
 * Keep `target.textContent` on the current time until `stop()` is called.
 * Returns the stop, which also clears whatever tick is pending, so an
 * unmounted HUD leaves no timer behind.
 */
export function runClock(target: { textContent: string | null }, io: ClockIO = REAL): () => void {
  let handle: number | null = null;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const now = io.now();
    target.textContent = clockText(new Date(now));
    handle = io.set(tick, msToNextSecond(now));
  };
  tick();
  return () => {
    stopped = true;
    if (handle !== null) { io.clear(handle); handle = null; }
  };
}

/**
 * Build the readout, start it, and hand back the element and its stop.
 * `before` places it in the host's flow; `null` appends.
 */
export function mountClock(host: HTMLElement, before: Node | null = null): { el: HTMLElement; stop(): void } {
  const el = document.createElement('div');
  el.className = 'mast__clock';
  el.setAttribute('role', 'timer');
  el.setAttribute('aria-label', 'local time');
  el.innerHTML = `<span class="mast__clock__n" data-clock>00:00:00</span><span class="mast__clock__k px">LOCAL</span>`;
  host.insertBefore(el, before);
  const stop = runClock(el.querySelector<HTMLElement>('[data-clock]')!);
  return { el, stop };
}
