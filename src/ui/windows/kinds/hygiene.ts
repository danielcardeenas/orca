/**
 * HYGIENE — what ORCA costs the machines it runs on.
 *
 * One window, four questions in the order an operator actually asks them:
 * how much room is left, what is ORCA holding, what is growing, and what
 * could come back. Everything on screen is a number a collector measured, or
 * a dash that says nobody could measure it — never a zero standing in for
 * "unknown", which is the one lie a panel like this is tempted to tell.
 *
 * **Three marks, and they are not decoration.** A bare figure was measured.
 * A `≥` in front of it means the directory walk hit its budget and the number
 * is a floor. A dash means the platform refused, and hovering says why. The
 * legend is on the window because a mark nobody can decode is worse than no
 * mark at all.
 *
 * **GROWTH, never WRITES.** The row says `NET GROWTH` and the note under it
 * says what that excludes. We cannot see block writes without privileges ORCA
 * does not ask for; a rotating log writes megabytes and grows by nothing, and
 * an operator who reads "writes" here would draw exactly the wrong conclusion
 * about which category is busy.
 *
 * **Candidates are a preview and say so.** Nothing in this release deletes a
 * file, and the panel carries no button that could — the list exists so a
 * person can see where the gigabytes went. Recovery, handoffs and history are
 * never in it, and the window states that rule rather than leaving the
 * operator to infer it from an absence.
 *
 * Reports arrive on their own (`t:'hygiene'` pushes, every ten minutes per
 * machine); SAMPLE NOW asks every collector for a fresh walk. The window
 * always shows *when* each number was taken, because a cached figure
 * presented as live is the same lie in a different hat.
 */

import { hub } from '../../net/client.ts';
import type { Stray, StrayOutcome } from '../../../shared/strays.ts';
import { store } from '../../store.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { esc } from '../../util.ts';
import {
  CATEGORIES, CATEGORY_LABEL, formatBytes, formatReading, isPartial, MARK, orcaTotal, reclaimable,
  type HygieneCategory, type HygieneReport, type Reading,
} from '../../../shared/hygiene.ts';

/** Past this a report is history, not the current picture. */
const STALE_MS = 15 * 60_000;

function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

/** A reading as a cell: the value, the mark, and the reason in the tooltip. */
function cell(r: Reading, unit: 'bytes' | 'count' | 'pct' = 'bytes'): string {
  const text = formatReading(r, unit);
  // The mark is already in the text (`≥ ≤ ~ —`); the class only tunes the
  // weight, so nothing here depends on colour to be understood.
  const cls = r.confidence === 'measured' ? 'hyg__n'
    : r.confidence === 'unavailable' ? 'hyg__n is-none'
      : r.confidence === 'approximate' ? 'hyg__n is-approx' : 'hyg__n is-bound';
  const title = r.note ? ` title="${esc(r.note)}"` : '';
  return `<span class="${cls}"${title}>${esc(text)}</span>`;
}

/** The proportion bar under a category row. Width only; no number repeated. */
function bar(part: number, whole: number): string {
  const pct = whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0;
  return `<i class="hyg__bar"><i style="width:${pct.toFixed(1)}%"></i></i>`;
}

function volumeRow(v: HygieneReport['volumes'][number]): string {
  const total = v.totalBytes.value, free = v.freeBytes.value;
  const usedPct = total && free !== null ? ((total - free) / total) * 100 : null;
  return `<div class="hyg__row">
    <span class="hyg__k">${esc(v.path)}</span>
    ${bar(usedPct ?? 0, 100)}
    <span class="hyg__v">${cell(v.freeBytes)} free of ${cell(v.totalBytes)}</span>
  </div>`;
}

function categoryRow(c: HygieneReport['categories'][number], whole: number): string {
  const note = c.coverage.truncated
    ? ' title="the walk hit its budget here: this size is a floor"' : '';
  return `<div class="hyg__row"${note}>
    <span class="hyg__k">${esc(CATEGORY_LABEL[c.category])}</span>
    ${bar(c.bytes.value ?? 0, whole)}
    <span class="hyg__v">${cell(c.bytes)} <small>${cell(c.files, 'count')} files</small></span>
  </div>`;
}

function growthBlock(r: HygieneReport): string {
  if (!r.growth) {
    return `<p class="px px--tiny hyg__hint">NET GROWTH NEEDS TWO SAMPLES · THE NEXT ONE COMPLETES IT</p>`;
  }
  // A growth figure with no number is not a gap to hide: it is the sampler
  // refusing to subtract two floors, and the reason is worth the line.
  if (r.growth.netBytes.confidence === 'unavailable') {
    return `<div class="hyg__row hyg__row--pair">
        <span class="hyg__k">NET GROWTH</span>
        <span class="hyg__v"><span class="hyg__n is-none" title="${esc(r.growth.netBytes.note ?? '')}">—</span></span>
      </div>
      <p class="px px--tiny hyg__hint">A WALK WAS CUT SHORT, AND THE DIFFERENCE BETWEEN TWO FLOORS IS BOUNDED NEITHER WAY · RAISE THE BUDGET OR WAIT FOR TWO WHOLE SAMPLES</p>`;
  }
  const g = r.growth;
  // Said as it was, not rounded up to a minute: "48M over 1m · 862M/min" are
  // two numbers that cannot both be true, and the reader is right to distrust
  // the panel that prints them.
  const secs = Math.round(g.windowMs / 1000);
  const window = secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`;
  const per = (g.netBytesPerSec.value ?? 0) * 60;
  const rows = CATEGORIES
    .map((cat) => ({ cat, reading: g.byCategory[cat] }))
    .filter((x): x is { cat: HygieneCategory; reading: Reading } => !!x.reading && (x.reading.value ?? 0) !== 0)
    .sort((a, b) => Math.abs(b.reading.value ?? 0) - Math.abs(a.reading.value ?? 0));
  return `<div class="hyg__row hyg__row--pair">
      <span class="hyg__k">NET GROWTH</span>
      <span class="hyg__v">${cell(g.netBytes)} over ${esc(window)} · ${esc(formatBytes(per))}/min</span>
    </div>
    ${rows.map((x) => `<div class="hyg__row hyg__row--sub hyg__row--pair">
      <span class="hyg__k">${esc(CATEGORY_LABEL[x.cat])}</span>
      <span class="hyg__v">${cell(x.reading)}</span>
    </div>`).join('')}
    <p class="px px--tiny hyg__hint">HOW MUCH BIGGER ORCA’S OWN FILES GOT BETWEEN TWO SAMPLES · NOT DISK WRITES: A LOG THAT ROTATES WRITES MEGABYTES AND GROWS BY NOTHING</p>`;
}

function processRows(r: HygieneReport): string {
  if (r.processes.length === 0) return '';
  const rows = [...r.processes]
    .sort((a, b) => (b.rssBytes.value ?? 0) - (a.rssBytes.value ?? 0))
    .slice(0, 12);
  return `<div class="sec">
    <div class="sec__k px">PROCESSES · ${rows.length}</div>
    ${rows.map((p) => `<div class="hyg__row hyg__row--pair">
      <span class="hyg__k">${esc(p.name)} <small>${esc(p.role)} ${p.pid}</small></span>
      <span class="hyg__v">${cell(p.cpuPct, 'pct')} cpu · ${cell(p.rssBytes)} rss</span>
    </div>`).join('')}
  </div>`;
}

function candidateRows(r: HygieneReport): string {
  const total = reclaimable(r);
  if (r.candidates.length === 0) {
    return `<div class="sec">
      <div class="sec__k px">RECLAIMABLE · NOTHING QUALIFIES</div>
      <p class="px px--tiny hyg__hint">A DIRECTORY IS OFFERED ONLY WHEN IT IS BOTH BIG AND COLD · RECOVERY, HANDOFFS AND HISTORY ARE NEVER OFFERED AT ALL</p>
    </div>`;
  }
  const now = Date.now();
  return `<div class="sec">
    <div class="sec__k px">RECLAIMABLE · ${esc(formatReading(total))} IN ${r.candidates.length}</div>
    ${r.candidates.slice(0, 12).map((c) => {
      const days = c.newestAt === null ? null : Math.floor((now - c.newestAt) / 86_400_000);
      return `<div class="hyg__cand">
        <div class="hyg__row hyg__row--pair">
          <span class="hyg__k">${esc(c.path)}</span>
          <span class="hyg__v">${cell(c.bytes)} <small>${c.files} files</small></span>
        </div>
        <p class="hyg__why">${esc(CATEGORY_LABEL[c.category])} · ${esc(c.reason)}${days === null ? '' : ` · idle ${days}d`}</p>
      </div>`;
    }).join('')}
    <p class="px px--tiny hyg__hint">A PREVIEW · THIS RELEASE REMOVES NOTHING AND HAS NO BUTTON THAT WOULD · RECOVERY IMAGES, HANDOFFS AND HISTORY ARE EXCLUDED BY RULE, WHATEVER THEIR SIZE</p>
  </div>`;
}

/**
 * Memory: what is committed, what is cache, and whether anything is swapping.
 *
 * Three rows because they are three facts, and the version of this panel that
 * had one row told the operator his machine was full. It showed `≤47G of 48G`
 * — an honest ceiling, correctly marked, and still wrong in the only sense
 * that matters: nine gigabytes were free, and the figure that dominated the
 * window was the one counting file cache as memory in use.
 *
 * So MEMORY is what the platform says is actually committed, and the cache it
 * hands back on demand gets its own line rather than being hidden inside that
 * number or silently dropped from it. SWAP is under them because it is the row
 * that decides how to read the first: committed memory near the total is
 * comfortable until something is swapping, and then it is not.
 *
 * The sub-rows are absent, not zero, when an older collector sent no such
 * reading — a cache row showing nothing would say the machine has no cache.
 */
function memoryRows(r: HygieneReport): string {
  const swapTotal = r.swapTotalBytes;
  const swap = !r.swapUsedBytes ? ''
    : `<div class="hyg__row hyg__row--sub hyg__row--pair">
        <span class="hyg__k">SWAP</span>
        <span class="hyg__v">${swapTotal?.value === 0
          ? `<span class="hyg__n">none in use</span>`
          : `${cell(r.swapUsedBytes)}${swapTotal ? ` of ${cell(swapTotal)}` : ''}`}</span>
      </div>`;
  return `<div class="hyg__row">
      <span class="hyg__k">MEMORY</span>
      ${bar(r.memUsedBytes.value ?? 0, r.memTotalBytes.value ?? 1)}
      <span class="hyg__v">${cell(r.memUsedBytes)} of ${cell(r.memTotalBytes)}</span>
    </div>
    ${r.memCachedBytes ? `<div class="hyg__row hyg__row--sub hyg__row--pair">
      <span class="hyg__k">CACHED <small>RETURNED ON DEMAND</small></span>
      <span class="hyg__v">${cell(r.memCachedBytes)}</span>
    </div>` : ''}
    ${swap}`;
}

function machineBlock(r: HygieneReport): string {
  const now = Date.now();
  const stale = now - r.at > STALE_MS;
  const total = orcaTotal(r);
  const whole = Math.max(1, total.value ?? 1);
  return `<section class="hyg__machine">
    <header class="hyg__head">
      <span class="px hyg__host">${esc(r.hostname)}</span>
      <span class="px px--tiny hyg__when${stale ? ' is-stale' : ''}">${esc(ago(r.at, now))} · ${r.tookMs}ms${stale ? ' · STALE' : ''}</span>
    </header>
    ${isPartial(r) ? `<p class="px px--tiny hyg__warn">THE WALK HIT ITS BUDGET · EVERY SIZE MARKED ≥ IS A FLOOR, NOT A TOTAL · GROWTH CANNOT BE DERIVED FROM IT</p>` : ''}

    <div class="sec">
      <div class="sec__k px">DISK</div>
      ${r.volumes.map(volumeRow).join('')}
    </div>

    <div class="sec">
      <div class="sec__k px">ORCA HOLDS ${esc(formatReading(total))}</div>
      ${[...r.categories].sort((a, b) => (b.bytes.value ?? 0) - (a.bytes.value ?? 0))
        .map((c) => categoryRow(c, whole)).join('')}
    </div>

    <div class="sec">
      <div class="sec__k px">LOAD</div>
      <div class="hyg__row">
        <span class="hyg__k">CPU</span>${bar(r.cpuPct.value ?? 0, 100)}
        <span class="hyg__v">${cell(r.cpuPct, 'pct')}</span>
      </div>
      ${memoryRows(r)}
      ${growthBlock(r)}
    </div>

    ${processRows(r)}
    ${candidateRows(r)}

    ${r.limits.length ? `<div class="sec">
      <div class="sec__k px">WHAT COULD NOT BE MEASURED</div>
      ${r.limits.map((l) => `<p class="hyg__why">${esc(l)}</p>`).join('')}
    </div>` : ''}
  </section>`;
}

export function mountHygiene(ctx: WinCtx, c: Console) {
  // The chrome already carries the callsign; a title repeating it is one word
  // twice. It becomes the one line worth having up there: what this machine holds.
  ctx.setTitle('');
  const body = ctx.body;
  body.innerHTML = `
    <div class="sec row row--split" style="padding:8px 12px">
      <span class="px px--tiny" data-sum>READING…</span>
      <button class="chip" type="button" data-sample>SAMPLE NOW</button>
    </div>
    <p class="px px--tiny hyg__legend">
      <span class="hyg__n">1.2G</span> COUNTED ·
      <span class="hyg__n is-bound">≥</span> AT LEAST THIS, THE WALK WAS CUT SHORT ·
      <span class="hyg__n is-bound">≤</span> AT MOST THIS ·
      <span class="hyg__n is-approx">~</span> BOUNDS NEITHER WAY ·
      <span class="hyg__n is-none">—</span> NOT MEASURABLE HERE, HOVER FOR WHY
    </p>
    <section class="hyg__strays" data-strays hidden></section>
    <div class="win__scroll scroll" data-list></div>
  `;
  const list = body.querySelector<HTMLElement>('[data-list]')!;
  const straysEl = body.querySelector<HTMLElement>('[data-strays]')!;
  const sum = body.querySelector<HTMLElement>('[data-sum]')!;
  const sampleBtn = body.querySelector<HTMLButtonElement>('[data-sample]')!;

  function paint() {
    const reports = [...store.hygiene.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
    if (reports.length === 0) {
      list.innerHTML = `<p class="px px--tiny hyg__hint" style="padding:16px">
        NO MACHINE HAS REPORTED YET · A COLLECTOR FILES ITS FIRST SAMPLE ABOUT TWENTY SECONDS AFTER IT CONNECTS, THEN EVERY TEN MINUTES · SAMPLE NOW ASKS IMMEDIATELY
      </p>`;
      sum.textContent = 'NO REPORTS';
      return;
    }
    const totals = reports.map(orcaTotal);
    const bytes = totals.reduce((a, r) => a + (r.value ?? 0), 0);
    // The summary carries the same mark the rows do, and for the same reason:
    // a floor summed with a ceiling is neither, so it says so.
    const marks = new Set(totals.map((r) => MARK[r.confidence]).filter(Boolean));
    const floor = marks.size === 1 ? [...marks][0]! : marks.size > 1 ? MARK.approximate : '';
    const back = reports.reduce((a, r) => a + (reclaimable(r).value ?? 0), 0);
    sum.textContent = `${reports.length} MACHINE${reports.length === 1 ? '' : 'S'} · `
      + `${floor}${formatBytes(bytes)} HELD · ${formatBytes(back)} RECLAIMABLE`;
    ctx.setTitle(`${floor}${formatBytes(bytes)} ON DISK`);
    list.innerHTML = reports.map(machineBlock).join('');
  }

  sampleBtn.addEventListener('click', () => {
    sampleBtn.disabled = true;
    sampleBtn.textContent = 'ASKING…';
    void hub.hygiene(true)
      .then((res) => {
        store.putHygiene(res.reports);
        c.note(res.asked > 0
          ? `asked ${res.asked} machine${res.asked === 1 ? '' : 's'} for a fresh sample; reports arrive as each finishes`
          : 'no collector is connected, so nobody was asked', res.asked > 0 ? 'info' : 'warn');
      })
      .catch((err: unknown) => c.note(err instanceof Error ? err.message : String(err), 'warn'))
      .finally(() => { sampleBtn.disabled = false; sampleBtn.textContent = 'SAMPLE NOW'; });
  });

  /* ── Strays: what ORCA left behind, in processes ────────────────── */

  /*
   * Above the disk report on purpose: this is the half with an action, and a
   * panel puts what can be decided before what can only be read. It keeps the
   * window's own language — marks, not colours — because the amber in this
   * console means "a person is required by a stopped agent", and a leftover
   * vite is not that. `!` is offered, `?` is shown and not offered, `·` is
   * recognised and deliberately left alone.
   */
  const MARK_OF: Record<Stray['verdict'], string> = { orphan: '!', ambiguous: '?', protected: '·' };
  /** Rows the operator unfolded, by id. Forgotten on reload, like a scroll position. */
  const open = new Set<string>();
  let busy = false;

  function strayRow(s: Stray): string {
    const where = [s.pid ? `pid ${s.pid}` : '', s.cwd ?? '', s.pane ?? ''].filter(Boolean).join(' · ');
    return `<div class="hyg__stray is-${s.verdict}" data-stray="${esc(s.id)}">
      <button class="hyg__stray-head" type="button" data-open aria-expanded="${open.has(s.id)}">
        <span class="hyg__stray-mark" aria-hidden="true">${MARK_OF[s.verdict]}</span>
        <span class="hyg__stray-name">${esc(s.label)}</span>
        <span class="hyg__stray-where">${esc(where)}</span>
        <span class="hyg__stray-chev" aria-hidden="true">▸</span>
      </button>
      ${s.action === 'none' ? '' : `<button class="hyg__stray-act" type="button" data-clean>${s.action === 'retire' ? 'RETIRE' : 'STOP IT'}</button>`}
      ${open.has(s.id) ? `<div class="hyg__stray-why">
        <ul>${s.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
        ${s.why ? `<p class="hyg__stray-kept">${esc(s.why)}</p>` : ''}
      </div>` : ''}
    </div>`;
  }

  function paintStrays(): void {
    const all = [...store.hygiene.values()].flatMap((r) => (r.strays ?? []).map((s) => ({ ...s, machineId: r.machineId })));
    straysEl.hidden = all.length === 0;
    if (!all.length) return;
    const orphans = all.filter((s) => s.verdict === 'orphan');
    straysEl.innerHTML = `
      <header class="hyg__strays-head">
        <span class="px px--tiny">LEFT BEHIND <b>${orphans.length}</b> OF ${all.length}</span>
        ${orphans.length ? `<button class="chip hyg__stray-all" type="button" data-clean-all${busy ? ' disabled' : ''}>CLEAN ${orphans.length}</button>` : ''}
      </header>
      <p class="px px--tiny hyg__legend">
        <span class="hyg__stray-mark">!</span> NOBODY OWNS IT · ORCA CAN STOP IT ·
        <span class="hyg__stray-mark">?</span> ORCA'S, BUT SOMETHING DOES NOT ADD UP · SHOWN, NEVER TOUCHED ·
        <span class="hyg__stray-mark">·</span> RECOGNISED AND LEFT ALONE, HOVER FOR WHY
      </p>
      <div class="hyg__stray-list scroll">${all.map(strayRow).join('')}</div>`;
  }

  /**
   * Limpiar.
   *
   * Dos caminos, y ninguno es nuevo: un proceso va por `strays:clean`, que el
   * collector revalida antes de mandar una señal; un registro fantasma va por
   * el archivo de agentes que ya existe, que ignora a los vivos por su cuenta.
   * Fingir que se mata un agente que no tiene proceso sería la única forma de
   * hacer esto mal.
   */
  function clean(ids: string[]): void {
    if (busy || !ids.length) return;
    const all = [...store.hygiene.values()].flatMap((r) => (r.strays ?? []).map((s) => ({ s, machineId: r.machineId })));
    const picked = all.filter((x) => ids.includes(x.s.id) && x.s.verdict === 'orphan');
    if (!picked.length) return;
    busy = true;
    paintStrays();

    const ghosts = picked.filter((x) => x.s.action === 'retire').map((x) => x.s.agentId!).filter(Boolean);
    const procs = new Map<string, string[]>();
    for (const x of picked) {
      if (x.s.action !== 'terminate') continue;
      procs.set(x.machineId, [...(procs.get(x.machineId) ?? []), x.s.id]);
    }

    const jobs: Promise<string>[] = [];
    if (ghosts.length) {
      jobs.push(hub.archive({ ids: ghosts }).then((o) => `${o.archived.length} retired`));
    }
    for (const [machineId, list2] of procs) {
      jobs.push(hub.cmd({ k: 'strays:clean', machineId, ids: list2 }).then((data) => {
        const outcomes = (data ?? []) as StrayOutcome[];
        for (const o of outcomes) {
          if (o.result === 'stopped') continue;
          c.note(`${o.label}: ${o.detail}`, o.result === 'failed' ? 'warn' : 'info');
        }
        return `${outcomes.filter((o) => o.result === 'stopped').length} stopped`;
      }));
    }
    void Promise.allSettled(jobs)
      .then((res) => {
        const said = res.map((r) => (r.status === 'fulfilled' ? r.value : `failed: ${String(r.reason)}`));
        c.note(`hygiene: ${said.join(', ')}`);
      })
      .finally(() => {
        busy = false;
        // Se vuelve a medir: lo que se acaba de terminar tiene que dejar de
        // salir, y si algo no murió el panel lo enseña otra vez.
        void hub.hygiene(true).then((res) => store.putHygiene(res.reports)).catch(() => { /* el push lo hará */ });
        paintStrays();
      });
  }

  straysEl.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-clean-all]')) {
      const all = [...store.hygiene.values()].flatMap((r) => r.strays ?? []);
      clean(all.filter((s) => s.verdict === 'orphan').map((s) => s.id));
      return;
    }
    const row = t.closest<HTMLElement>('[data-stray]');
    if (!row) return;
    const id = row.dataset.stray!;
    if (t.closest('[data-clean]')) { clean([id]); return; }
    if (t.closest('[data-open]')) {
      if (open.has(id)) open.delete(id); else open.add(id);
      paintStrays();
    }
  });

  // What is already known paints at once; the request fills in the rest.
  paint();
  paintStrays();
  void hub.hygiene(false).then((res) => store.putHygiene(res.reports)).catch(() => { /* offline: the push will do it */ });

  const off = store.on((e) => { if (e.k === 'hygiene') { paint(); paintStrays(); } });
  // The clock alone turns a report stale, so the header is repainted on a slow tick.
  const tick = window.setInterval(paint, 30_000);
  return { dispose() { off(); window.clearInterval(tick); } };
}
