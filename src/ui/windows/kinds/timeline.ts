/**
 * The fleet's timeline: a scrubber over 24 hours, and what happened while you
 * were not looking.
 *
 * The top half is a ruler, not a toolbar: hour marks in Tiny5 and a thin
 * histogram — lime for agents alive, amber for the ones that needed a human.
 * Drag anywhere on it and the field rewinds. The amber band is the only reason
 * to scrub at all: you are looking for the moment the fleet stalled, and a
 * count of live agents does not show it.
 *
 * The bottom half is the answer to the question you actually came back with.
 * It is computed once, on open, against the last time this tab was watching —
 * not against "now", which would always be empty.
 *
 * ── WHAT MAIN.TS HAS TO WIRE ───────────────────────────────────────────
 * 1. Register the kind, next to the others (`main.ts`, ~line 206):
 *
 *      import { mountTimeline } from './windows/kinds/timeline.ts';
 *      wm.register('timeline', (ctx) => mountTimeline(ctx, c));
 *
 * 2. Two members on `Console` (`src/ui/console.ts`), implemented in `main.ts`:
 *
 *      openTimeline(): void;
 *      setReplay(world: WorldState | null): void;
 *
 *    `openTimeline` is the same shape as `openFeed`:
 *
 *      openTimeline: () => { wm.open({ kind: 'timeline', key: 'timeline', callsign: 'TIME' }); },
 *
 *    `setReplay(world)` puts the field on a past world: it draws that world
 *    instead of the live store and the mast reads `REPLAY · hh:mm`.
 *    `setReplay(null)` returns to live. This window calls it optionally
 *    (`c.setReplay?.(…)`), so it compiles and no-ops until you land it.
 *
 *    While replay is on, the field must keep drawing from the world it was
 *    handed and ignore store patches — otherwise the next 10 Hz flush snaps
 *    the fleet back to the present under the operator's cursor.
 *
 * 3. Optional: a key and `/timeline` on the command line. Nothing here needs it.
 */

import type { WorldState } from '../../../shared/types.ts';
import { LIVE_STATES } from '../../../shared/types.ts';
import { store } from '../../store.ts';
import { getSound } from '../../hud/sound.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { esc, tokens } from '../../util.ts';
import { typing } from '../../keys.ts';
import {
  fetchHistory, fetchSummary, nearestSnapshot, worldFromSnapshot,
} from '../../history.ts';
import type { HistorySummary, Snapshot, SummaryRow } from '../../history.ts';

/** The console surface this window needs beyond what `console.ts` declares. */
type ReplayConsole = Console & { setReplay?(world: WorldState | null): void };

const HOUR = 3_600_000;
const SPAN_MS = 24 * HOUR;
/** How often the ring gains a snapshot at the hub. Reload at the same rate. */
const RELOAD_MS = 20_000;
/** `orca.lastSeen` is refreshed at this rate while the tab is visible. */
const SEEN_MS = 30_000;
const SEEN_KEY = 'orca.lastSeen';
/** With no `lastSeen` on record, one hour is the shortest absence worth a card. */
const FIRST_RUN_SPAN = HOUR;

export function mountTimeline(ctx: WinCtx, c: Console) {
  const rc = c as ReplayConsole;
  injectCss();

  const body = ctx.body;
  body.innerHTML = `
    <div class="tl">
      <div class="tl__bar row row--split">
        <span class="px px--tiny" data-at>—</span>
        <div class="row">
          <span class="px px--tiny" data-n></span>
          <button class="chip is-on" type="button" data-live data-key="l">LIVE</button>
        </div>
      </div>
      <div class="tl__scrub" data-scrub>
        <canvas class="tl__gram" data-gram></canvas>
        <div class="tl__ticks" data-ticks></div>
        <i class="tl__cursor" data-cursor hidden></i>
      </div>
      <div class="tl__legend row">
        <span class="px px--tiny tl__key tl__key--live">ALIVE</span>
        <span class="px px--tiny tl__key tl__key--blocked">NEEDED YOU</span>
        <span class="px px--tiny tl__hint">DRAG TO REWIND · ←/→ ONE STEP</span>
      </div>
      <div class="sec"><div class="sec__k px">WHILE YOU WERE AWAY</div>
        <div class="tl__away" data-away><span class="px px--tiny" style="color:var(--ink-dim)">READING…</span></div>
      </div>
      <div class="win__scroll scroll" data-rows></div>
    </div>
  `;

  const scrub = body.querySelector<HTMLElement>('[data-scrub]')!;
  const gram = body.querySelector<HTMLCanvasElement>('[data-gram]')!;
  const ticksEl = body.querySelector<HTMLElement>('[data-ticks]')!;
  const cursorEl = body.querySelector<HTMLElement>('[data-cursor]')!;
  const atEl = body.querySelector<HTMLElement>('[data-at]')!;
  const nEl = body.querySelector<HTMLElement>('[data-n]')!;
  const liveBtn = body.querySelector<HTMLButtonElement>('[data-live]')!;
  /**
   * LIVE is a fact while you are live — one more chip on the bar. The moment
   * the scrubber puts you in the past it becomes an amber slab: you are
   * looking at something that already happened, and this is the way back.
   */
  const setLive = (on: boolean) => {
    liveBtn.className = on ? 'chip is-on' : 'slab-btn slab-btn--amber slab-btn--sm slab-btn--fit';
  };
  const awayEl = body.querySelector<HTMLElement>('[data-away]')!;
  const rowsEl = body.querySelector<HTMLElement>('[data-rows]')!;

  let snaps: Snapshot[] = [];
  let from = Date.now() - SPAN_MS;
  let to = Date.now();
  /** Index into `snaps`. The last one means live; -1 means we have nothing. */
  let idx = -1;
  let disposed = false;

  /* ── the strip ──────────────────────────────────────────────────── */

  const isLive = () => idx < 0 || idx >= snaps.length - 1;

  function paint() {
    const w = Math.max(1, scrub.clientWidth);
    const h = Math.max(1, scrub.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    gram.width = Math.round(w * dpr);
    gram.height = Math.round(h * dpr);
    gram.style.width = `${w}px`;
    gram.style.height = `${h}px`;
    const g = gram.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const span = Math.max(1, to - from);
    const x = (t: number) => ((t - from) / span) * w;

    // Hour marks first, under the data: the ruler is background, the fleet is
    // the reading.
    g.fillStyle = cssVar('--line-soft', '#22252d');
    const firstHour = Math.ceil(from / HOUR) * HOUR;
    let ticks = '';
    for (let t = firstHour; t <= to; t += HOUR) {
      const px = Math.round(x(t)) + 0.5;
      g.fillRect(px, 0, 1, h);
      // Every third hour gets a number; twenty-four of them is a smear.
      if (new Date(t).getHours() % 3 === 0) {
        ticks += `<span class="tl__tick px px--tiny" style="left:${px}px">${String(new Date(t).getHours()).padStart(2, '0')}</span>`;
      }
    }
    if (ticksEl.innerHTML !== ticks) ticksEl.innerHTML = ticks;

    if (snaps.length === 0) { placeCursor(); return; }

    // One scale for both bands, so amber against lime reads as a proportion of
    // the fleet and not as its own chart.
    let peak = 1;
    const live: number[] = [];
    const blocked: number[] = [];
    for (const s of snaps) {
      let alive = 0;
      for (const t of Object.values(s.agents)) if (LIVE_STATES.has(t[0])) alive += 1;
      live.push(alive);
      blocked.push(s.blocked);
      if (alive > peak) peak = alive;
    }

    const bw = Math.max(1, Math.min(3, w / Math.max(1, snaps.length)));
    const limeC = cssVar('--lime', '#c0f94a');
    const amberC = cssVar('--amber', '#f5a524');
    for (let i = 0; i < snaps.length; i += 1) {
      const px = x(snaps[i]!.at);
      const lh = (live[i]! / peak) * (h - 2);
      g.fillStyle = limeC;
      g.globalAlpha = 0.55;
      g.fillRect(px, h - lh, bw, lh);
      const bh = (blocked[i]! / peak) * (h - 2);
      if (bh > 0) {
        g.globalAlpha = 1;
        g.fillStyle = amberC;
        g.fillRect(px, h - bh, bw, Math.max(1, bh));
      }
    }
    g.globalAlpha = 1;
    placeCursor();
  }

  function placeCursor() {
    const s = idx >= 0 ? snaps[idx] : undefined;
    if (!s || isLive()) { cursorEl.hidden = true; return; }
    const w = Math.max(1, scrub.clientWidth);
    const span = Math.max(1, to - from);
    cursorEl.hidden = false;
    cursorEl.style.left = `${Math.round(((s.at - from) / span) * w)}px`;
  }

  /* ── the cursor drives the field ────────────────────────────────── */

  function select(next: number, announce = true) {
    if (snaps.length === 0) return;
    idx = Math.max(0, Math.min(snaps.length - 1, next));
    const s = snaps[idx]!;
    if (isLive()) {
      atEl.textContent = 'LIVE';
      setLive(true);
      ctx.setState(null, 'var(--lime)');
      if (announce) rc.setReplay?.(null);
    } else {
      const d = new Date(s.at);
      const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      let alive = 0;
      for (const t of Object.values(s.agents)) if (LIVE_STATES.has(t[0])) alive += 1;
      atEl.textContent = `REPLAY · ${hhmm} · ${alive} ALIVE · ${s.blocked} BLOCKED`;
      setLive(false);
      // Amber only when somebody was waiting on a person at that instant. The
      // discipline holds in the past too.
      ctx.setState(s.blocked ? 'blocked' : null, s.blocked ? 'var(--amber)' : 'var(--st-thinking)');
      if (announce) rc.setReplay?.(worldFromSnapshot(s, store.world));
    }
    placeCursor();
  }

  function scrubTo(clientX: number) {
    const r = scrub.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    getSound()?.play('replay.step');
    select(nearestSnapshot(snaps, from + frac * (to - from)));
  }

  let dragging = false;
  scrub.addEventListener('pointerdown', (e) => {
    if (snaps.length === 0) return;
    dragging = true;
    scrub.setPointerCapture(e.pointerId);
    scrubTo(e.clientX);
  });
  scrub.addEventListener('pointermove', (e) => { if (dragging) scrubTo(e.clientX); });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try { scrub.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  };
  scrub.addEventListener('pointerup', endDrag);
  scrub.addEventListener('pointercancel', endDrag);

  liveBtn.addEventListener('click', () => select(snaps.length - 1));

  // One snapshot per arrow, but only when this window has focus: the field owns
  // the keyboard otherwise, and a scrubber that steals arrows from the console
  // is a scrubber the operator has to close.
  const onKey = (e: KeyboardEvent) => {
    if (!ctx.win.focused || ctx.win.minimized) return;
    if (typing(e)) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    select((idx < 0 ? snaps.length - 1 : idx) + (e.key === 'ArrowLeft' ? -1 : 1));
  };
  window.addEventListener('keydown', onKey);

  const onResize = () => paint();
  window.addEventListener('resize', onResize);

  /* ── loading ────────────────────────────────────────────────────── */

  async function load() {
    if (disposed) return;
    const now = Date.now();
    try {
      const r = await fetchHistory(now - SPAN_MS, now, 0);
      if (disposed) return;
      const wasLive = isLive();
      snaps = r.snapshots;
      from = now - SPAN_MS;
      to = now;
      nEl.textContent = `${r.total} SNAPSHOTS`;
      if (snaps.length === 0) {
        idx = -1;
        atEl.textContent = 'NO HISTORY YET';
        paint();
        return;
      }
      // Reloading must not yank the operator out of the past they are reading.
      if (wasLive) idx = snaps.length - 1;
      else idx = Math.min(idx, snaps.length - 1);
      select(idx, wasLive);
      paint();
    } catch (err) {
      if (disposed) return;
      atEl.textContent = 'HISTORY UNREACHABLE';
      nEl.textContent = '';
      console.warn('[timeline]', err);
    }
  }

  /* ── while you were away ────────────────────────────────────────── */

  /**
   * `since` is read once, before the ticker below starts moving it. Reading it
   * after would always answer "nothing happened", which is exactly the bug this
   * panel exists to avoid.
   */
  function lastSeen(): number {
    try {
      const raw = Number(localStorage.getItem(SEEN_KEY));
      if (Number.isFinite(raw) && raw > 0) return Math.min(raw, Date.now());
    } catch { /* private mode */ }
    return Date.now() - FIRST_RUN_SPAN;
  }
  const since = lastSeen();

  function rows(kind: string, list: SummaryRow[], colour: string): string {
    if (list.length === 0) return '';
    return list.map((r) => {
      const p = store.world.projects[r.projectId];
      return `<div class="tl__row" data-agent="${esc(r.id)}">
        <span class="px px--tiny tl__row-k" style="color:${colour}">${esc(kind)}</span>
        <span class="tl__row-cs px px--tiny">${esc(r.callsign || r.id.slice(0, 6))}</span>
        <span class="tl__row-pj mono">${esc(p?.name ?? r.projectId)}</span>
        <span class="tl__row-t mono">${hhmm(r.at)}</span>
      </div>`;
    }).join('');
  }

  function paintAway(s: HistorySummary) {
    const gone = span(s.spanMs);
    awayEl.innerHTML = `
      <div class="tl__stats row row--wrap">
        <span class="px px--tiny">AWAY ${esc(gone)}</span>
        <span class="px px--tiny">USED ${esc(tokens(s.tokens))} TOK</span>
        <span class="px px--tiny">${s.born.length} BORN</span>
        <span class="px px--tiny">${s.finished.length} DONE</span>
        <span class="px px--tiny ${s.died.length ? 'is-red' : ''}">${s.died.length} DEAD</span>
        <span class="px px--tiny ${s.stillBlocked.length ? 'is-amber' : ''}">${s.stillBlocked.length} STILL WAITING</span>
      </div>`;

    const body2 = [
      // Still waiting first: it is the only group you can still do something about.
      rows('WAITING', s.stillBlocked, 'var(--amber)'),
      rows('DEAD', s.died, 'var(--red)'),
      rows('BLOCKED', s.blocked.filter((b) => !s.stillBlocked.some((x) => x.id === b.id)), 'var(--amber)'),
      rows('DONE', s.finished, 'var(--ink-dim)'),
      rows('BORN', s.born, 'var(--lime)'),
    ].join('');

    const lines = s.lines.length
      ? `<div class="sec"><div class="sec__k px">${s.feedLines} LINES${s.linesTruncated ? ' · TAIL ONLY' : ''}</div>${
        s.lines.map((f) => `<div class="tl__line is-${esc(f.level)}"${f.agentId ? ` data-agent="${esc(f.agentId)}"` : ''}>`
          + `<span class="tl__row-t mono">${hhmm(f.at)}</span>`
          + `<span class="tl__row-cs px px--tiny">${esc(f.source)}</span>`
          + `<span class="mono">${esc(f.text)}</span></div>`).join('')
      }</div>`
      : '';

    rowsEl.innerHTML = (body2 || lines)
      ? `${body2}${lines}`
      : `<p class="px px--tiny" style="padding:14px 12px;color:var(--ink-dim)">NOTHING CHANGED WHILE YOU WERE AWAY.</p>`;
    rowsEl.querySelectorAll<HTMLElement>('[data-agent]').forEach((el) => {
      el.addEventListener('click', () => {
        // Flying to an agent only makes sense against the live field.
        select(snaps.length - 1);
        c.go(el.dataset.agent!);
      });
    });
  }

  fetchSummary(since)
    .then((s) => { if (!disposed) paintAway(s); })
    .catch((err) => {
      if (disposed) return;
      awayEl.innerHTML = `<span class="px px--tiny" style="color:var(--red)">SUMMARY UNREACHABLE</span>`;
      console.warn('[timeline]', err);
    });

  /* ── timers ─────────────────────────────────────────────────────── */

  const reload = window.setInterval(() => { if (isLive()) void load(); }, RELOAD_MS);
  // The console was being watched: remember that, so the next return knows how
  // long the absence was. Only while the tab is visible — a window left open on
  // a second monitor nobody looks at is still an absence.
  const seen = window.setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* private mode */ }
  }, SEEN_MS);

  ctx.setCallsign('TIME');
  ctx.setTitle('24H');
  void load();

  return {
    dispose() {
      disposed = true;
      window.clearInterval(reload);
      window.clearInterval(seen);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      // Closing the scrubber must never strand the field in the past.
      rc.setReplay?.(null);
    },
  };
}

/* ── helpers ──────────────────────────────────────────────────────── */

function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function span(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}M`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}H ${m % 60}M` : `${Math.round(h / 24)}D`;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.length ? v : fallback;
}

/**
 * The window's own styles, injected once.
 *
 * They live here rather than in `styles/window.css` because this is the only
 * kind that draws a ruler, and a stylesheet everybody loads should not carry
 * one window's canvas geometry.
 */
function injectCss(): void {
  if (document.getElementById('orca-timeline-css')) return;
  const el = document.createElement('style');
  el.id = 'orca-timeline-css';
  el.textContent = `
.tl { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.tl__bar { padding: 6px 10px; }
.tl__scrub { position: relative; height: 54px; margin: 0 10px; cursor: ew-resize;
  border: 1px solid var(--line-soft); background: var(--screen-in); touch-action: none; }
.tl__gram { display: block; width: 100%; height: 100%; }
.tl__ticks { position: absolute; inset: 0; pointer-events: none; }
.tl__tick { position: absolute; bottom: 1px; transform: translateX(2px);
  font-size: 9px; color: var(--ink-faint); }
.tl__cursor { position: absolute; top: -3px; bottom: -3px; width: 1px;
  background: var(--ink-bright); box-shadow: 0 0 6px var(--ink-bright); pointer-events: none; }
.tl__legend { padding: 5px 10px 8px; gap: 12px; }
.tl__key { position: relative; padding-left: 12px; color: var(--ink-dimmer); }
.tl__key::before { content: ''; position: absolute; left: 0; top: 3px; width: 7px; height: 7px; }
.tl__key--live::before { background: var(--lime); opacity: 0.55; }
.tl__key--blocked::before { background: var(--amber); }
.tl__hint { margin-left: auto; color: var(--ink-faint); }
.tl__stats { gap: 10px; }
.tl__stats .is-red { color: var(--red); }
.tl__stats .is-amber { color: var(--amber); }
.tl__row, .tl__line { display: flex; align-items: baseline; gap: 8px;
  padding: 3px 12px; font-size: 11px; cursor: pointer; }
.tl__row:hover, .tl__line:hover { background: var(--screen-in); }
.tl__row-k { width: 62px; flex: 0 0 auto; }
.tl__row-cs { flex: 0 0 auto; color: var(--ink-mid); }
.tl__row-pj { flex: 1 1 auto; color: var(--ink-dim); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.tl__row-t { flex: 0 0 auto; color: var(--ink-faint); }
.tl__line { color: var(--ink-dim); }
.tl__line.is-warn { color: var(--amber); }
.tl__line.is-alert { color: var(--red); }
`;
  document.head.appendChild(el);
}
