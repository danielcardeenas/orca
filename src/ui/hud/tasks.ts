/**
 * The task panel: what CAPCOM is on, top right, under the mast.
 *
 * One row per task conversation, in the boot's ALGN dress (`gfx/algn.ts`):
 * title, a zipper that says how far along it is, the phase and how long ago
 * anything moved, and the callsigns still working it. Open tasks first by
 * last movement, then the newest finished ones, the rest folded under a
 * count. A row opens its conversation in the CAPCOM window; a callsign flies
 * the camera, like everywhere else on the console.
 *
 * It sits below the mast — `--hud-top` is the mast's bottom, which the
 * clock is part of — so it covers nothing and moves nothing. Windows stack
 * above the HUD, so a window over it wins. It holds no input and answers no
 * key: buttons blur on click so the field keeps the keyboard.
 *
 * Motion is the boot's and only on news: a row arriving lines up once, a
 * phase changing steps out and back once and re-seats its zipper. Nothing
 * here loops. The head folds on a click and the fold is remembered in prefs.
 */

import type { Console } from '../console.ts';
import { store } from '../store.ts';
import { getPref, setPref } from '../prefs.ts';
import { ago, esc } from '../util.ts';
import { REDUCE } from '../motion.ts';
import { ZIP_SVG, algnRowIn, algnRowPulse, algnZipTo, paintBadge } from '../gfx/algn.ts';
import { PHASE_WORD, isOpen, splitRows, taskRows, type TaskPhase, type TaskRow } from './task-status.ts';
import { visibleTasks } from '../../shared/tasks.ts';

/** Finished tasks shown in full before the rest fold. */
export const RECENT_DONE = 3;
/** Callsigns named in a row before the rest become a count. */
const CREW_SHOWN = 6;
/** How often the "2M" ago readouts are refreshed. Text only, no motion. */
const AGO_TICK_MS = 10_000;

/** Where the zipper sits for each phase: seated, or not yet. */
const ZIP_AT: Record<TaskPhase, number> = { waiting: 1, progress: 1, queued: 0, completed: 1, failed: 0 };

interface Mounted { el: HTMLElement; zip: HTMLElement; phase: TaskPhase; sig: string }

export interface TasksHandle {
  el: HTMLElement;
  /** Re-read the store and paint; the store's events call this already. */
  render(): void;
  dispose(): void;
}

export function mountTasks(host: HTMLElement, c: Console, opts: { recent?: number } = {}): TasksHandle {
  const recent = opts.recent ?? RECENT_DONE;
  const el = document.createElement('aside');
  el.className = 'tasks algn';
  el.setAttribute('aria-label', 'tasks');
  el.innerHTML = `
    <header class="algn__head tasks__head" data-fold aria-expanded="true">
      <span class="algn__badge"><canvas data-badge></canvas></span>
      <p class="px px--modal tasks__t">TASKS <span class="tasks__n" data-n>0</span></p>
      <span class="px px--tiny tasks__fold" data-fold-mark>FOLD</span>
    </header>
    <div class="tasks__list scroll" data-list></div>
  `;
  host.appendChild(el);
  paintBadge(el.querySelector<HTMLCanvasElement>('[data-badge]')!);

  const list = el.querySelector<HTMLElement>('[data-list]')!;
  const countEl = el.querySelector<HTMLElement>('[data-n]')!;
  const head = el.querySelector<HTMLElement>('[data-fold]')!;
  const foldMark = el.querySelector<HTMLElement>('[data-fold-mark]')!;
  const rows = new Map<string, Mounted>();
  /** The operator unfolded "…and N more"; forgotten on reload, like a scroll position. */
  let showMore = false;
  let moreBtn: HTMLButtonElement | null = null;
  let emptyEl: HTMLElement | null = null;
  /**
   * The world's first paint lands whole — a reload is not news — and only
   * what changes after it moves. Settled once the hub's world has arrived.
   */
  let settled = false;

  function setFolded(folded: boolean) {
    el.classList.toggle('is-folded', folded);
    head.setAttribute('aria-expanded', folded ? 'false' : 'true');
    foldMark.textContent = folded ? 'UNFOLD' : 'FOLD';
  }
  setFolded(getPref('tasksFolded'));
  head.addEventListener('click', () => {
    const folded = !el.classList.contains('is-folded');
    setPref('tasksFolded', folded);
    setFolded(folded);
  });

  function rowHtml(r: TaskRow): string {
    return `
      <span class="px px--tiny tasks__title" title="${esc(r.title)}">+ ${esc(r.title)}</span>
      <div class="algn-bar"><div class="algn-zip" data-zip>${ZIP_SVG}</div></div>
      <span class="px px--tiny tasks__meta"><span data-phase>${PHASE_WORD[r.phase]}</span> · <span data-ago>${ago(r.at)}</span></span>
      <div class="tasks__crew px px--tiny" data-crew></div>`;
  }

  function crewHtml(r: TaskRow): string {
    if (!r.crew.length) return '';
    const n = r.crew.length;
    // A squad of twenty would push the row into a paragraph. The count is the
    // number; the callsigns are how you reach one, and six of them is a reach.
    const shown = r.crew.slice(0, CREW_SHOWN);
    const rest = n - shown.length;
    return `<span class="tasks__crewn">${n} AGENT${n === 1 ? '' : 'S'}</span>`
      + shown.map((a) => `<button class="tasks__cs" type="button" data-go="${esc(a.id)}" title="fly to ${esc(a.callsign)}">${esc(a.callsign)}</button>`).join('')
      + (rest > 0 ? `<span class="tasks__crewn">+${rest}</span>` : '');
  }

  function paintRow(m: Mounted, r: TaskRow, index: number, fresh: boolean) {
    const row = m.el;
    const sig = JSON.stringify([r.title, r.phase, r.crew.map((a) => a.id + a.callsign)]);
    const phaseChanged = m.phase !== r.phase;
    if (sig !== m.sig) {
      m.sig = sig;
      row.querySelector<HTMLElement>('.tasks__title')!.textContent = `+ ${r.title}`;
      row.querySelector<HTMLElement>('.tasks__title')!.title = r.title;
      row.querySelector<HTMLElement>('[data-phase]')!.textContent = PHASE_WORD[r.phase];
      const crew = row.querySelector<HTMLElement>('[data-crew]')!;
      crew.innerHTML = crewHtml(r);
      crew.hidden = !r.crew.length;
      for (const p of Object.keys(ZIP_AT) as TaskPhase[]) row.classList.toggle(`is-${p}`, r.phase === p);
      row.classList.toggle('is-done', !isOpen(r.phase));
      m.phase = r.phase;
    }
    row.querySelector<HTMLElement>('[data-ago]')!.textContent = ago(r.at);
    row.classList.toggle('is-current', store.activeTaskId === r.id);

    const reduce = REDUCE.value || !settled;
    if (fresh) {
      algnRowIn(row, index, reduce);
      algnZipTo(m.zip, ZIP_AT[r.phase], reduce, 0.3 + index * 0.055);
    } else if (phaseChanged) {
      algnRowPulse(row, reduce);
      algnZipTo(m.zip, ZIP_AT[r.phase], reduce);
    }
  }

  function mountRow(r: TaskRow, index: number): Mounted {
    const row = document.createElement('div');
    row.className = 'algn-row tasks__row';
    row.dataset.task = r.id;
    row.innerHTML = rowHtml(r);
    const m: Mounted = { el: row, zip: row.querySelector<HTMLElement>('[data-zip]')!, phase: r.phase, sig: '' };
    rows.set(r.id, m);
    paintRow(m, r, index, true);
    return m;
  }

  function render() {
    const agentOf = (id: string) => store.knownAgent(id);
    const all = taskRows(visibleTasks(store.world.tasks ?? {}), agentOf);
    const { open, done, more } = splitRows(all, recent);
    countEl.textContent = String(open.length);
    el.classList.toggle('has-open', open.length > 0);

    const shown = showMore ? [...open, ...done, ...more] : [...open, ...done];
    const keep = new Set(shown.map((r) => r.id));
    for (const [id, m] of rows) if (!keep.has(id)) { m.el.remove(); rows.delete(id); }

    // Walk in order, appending as we go: an existing row moves, a new one arrives.
    let arrivals = 0;
    for (const r of shown) {
      const had = rows.get(r.id);
      const m = had ?? mountRow(r, arrivals++);
      if (had) paintRow(m, r, 0, false);
      list.appendChild(m.el);
    }

    if (!all.length) {
      if (!emptyEl) {
        emptyEl = document.createElement('p');
        emptyEl.className = 'px px--tiny tasks__empty';
        emptyEl.textContent = 'NO TASKS · NEW TASK IN CAPCOM';
      }
      list.appendChild(emptyEl);
    } else if (emptyEl) { emptyEl.remove(); emptyEl = null; }

    if (more.length && !showMore) {
      if (!moreBtn) {
        moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'px px--tiny tasks__more';
        moreBtn.addEventListener('click', (e) => { showMore = true; (e.currentTarget as HTMLElement).blur(); render(); });
      }
      moreBtn.textContent = `…AND ${more.length} MORE`;
      list.appendChild(moreBtn);
    } else if (moreBtn) { moreBtn.remove(); }
  }

  list.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const go = t.closest<HTMLElement>('[data-go]');
    if (go) { e.stopPropagation(); go.blur(); c.go(go.dataset.go!); return; }
    const row = t.closest<HTMLElement>('[data-task]');
    if (row?.dataset.task) c.openTask(row.dataset.task);
  });

  const off = store.on((e) => {
    if (e.k === 'tasks' || e.k === 'agents' || e.k === 'world') render();
    if (e.k === 'world') settled = true;
  });
  // The "2M" readouts age; an idle render changes text and nothing else.
  const agoTimer = window.setInterval(render, AGO_TICK_MS);
  render();

  return {
    el,
    render,
    dispose() { off(); window.clearInterval(agoTimer); el.remove(); },
  };
}
