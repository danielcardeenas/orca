/**
 * The mission panel: what CAPCOM is on, top left, under the mast.
 *
 * One row per mission conversation, in the boot's ALGN dress (`gfx/algn.ts`):
 * title, a zipper that says how far along it is, the phase and how long ago
 * anything moved. Open missions first, the ones with crew on them ahead of the
 * rest, then by what was last said. Se enseñan todas, siempre: la lista es la
 * lista, y lo único que se pliega es el panel entero, desde su título. El orden
 * y el «hace cuánto» los deciden noticias y no el reloj a propósito: ver
 * `missionRows`.
 *
 * ── One row is one line ────────────────────────────────────────────
 *
 * A row used to carry its crew on a second line that wrapped, so a squad of
 * six turned the panel into paragraphs and the phase column stopped lining
 * up. The rule now is that the collapsed row is exactly one line — title,
 * zipper, phase · ago, and a count of who is on it — and everything that does
 * not fit on it lives one keystroke away instead of being cut and left to a
 * tooltip.
 *
 * ── The detail, and why it is a button ─────────────────────────────
 *
 * The full title and the mission's opening brief were reachable only by
 * hovering the row, which is no way to reach anything: a hover cannot be
 * tabbed to, cannot be tapped, and vanishes while you read it. Each row now
 * carries a disclosure (`▸`) that opens the whole title, the whole brief, its
 * crew, and the two ways into the mission — the conversation and the results.
 * It is a real `<button>` with `aria-expanded`, so Tab reaches it and Enter
 * and Space open it. The title itself is a button too: clicking it opens the
 * mission's conversation while it runs, and its results once it has finished,
 * which is what the operator wants in each case.
 *
 * It sits below the mast — `--hud-top` is the mast's bottom, which the
 * clock is part of — so it covers nothing and moves nothing. Windows stack
 * above the HUD, so a window over it wins. It holds no text input: buttons
 * blur on click so the field keeps the keyboard.
 *
 * ── La alineación ─────────────────────────────────────────────────
 *
 * El movimiento es el del comp (`docs/offworld.mp4`, 11.5–14 s), medido
 * fotograma a fotograma en `gfx/algn.ts`: las filas aparecen una cada 83 ms,
 * estrechas y enteras; esperan un segundo mientras cae el resto; y entonces
 * una onda baja por la lista ensanchando cada fila hasta ras a la vez que su
 * cremallera asienta. La escalera que se ve a mitad es esa onda, no un
 * estado.
 *
 * Se juega una vez. Después, lo que llega entra en su sitio y en su orden y
 * nada más, y sólo se mueve lo que es noticia: una fase que cambia da un paso
 * y vuelve a ras. Nada aquí hace bucle.
 *
 * El panel se pliega con un clic en su título y el pliegue se recuerda en
 * prefs. Al plegar, las filas se van estrechándose de abajo arriba y la lista
 * se cierra tras ellas como una persiana (`algnFold`); el `display: none`
 * llega al final, y sólo si para entonces el operador no se ha arrepentido.
 *
 * Al devolverlo, la caja crece hasta su alto al ritmo al que se llena
 * (`algnUnfold`) —crecer es lo que dice que hay más panel que antes, y lo que
 * empuja a la sección de debajo en vez de saltársela— y las filas entran en el
 * compás del comp: una cada 83 ms y en el orden de la lista, que es lo que
 * dice «esto está aquí, y en este orden». La persiana va siempre un poco por
 * delante del compás, así que ninguna fila ya encendida asoma fuera de una
 * caja a medio abrir. No se repite la onda entera —la espera de un segundo y
 * el ensanche son la alineación, y una alineación se juega una vez—, así que
 * desplegar cuesta un pestañeo, no un segundo y medio.
 */

import type { Console } from '../console.ts';
import { store } from '../store.ts';
import { getPref, setPref } from '../prefs.ts';
import { ago, esc } from '../util.ts';
import { REDUCE } from '../motion.ts';
import {
  ALGN_BEAT, ALGN_HOLD, ALGN_SEAT, ZIP_SVG, type AlgnGesture,
  algnFold, algnFoldClear, algnRowBack, algnRowIn, algnRowPulse, algnUnfold, algnZipDelay, algnZipTo,
  paintBadge,
} from '../gfx/algn.ts';
import { PHASE_WORD, isOpen, missionRows, type MissionPhase, type MissionRow } from './mission-status.ts';
import { visibleMissions } from '../../shared/missions.ts';

/** Callsigns named in an open row's detail before the rest become a count. */
const CREW_SHOWN = 8;
/** How often the "2M" ago readouts are refreshed. Text only, no motion. */
const AGO_TICK_MS = 10_000;

/** Where the zipper sits for each phase: seated, or not yet. */
const ZIP_AT: Record<MissionPhase, number> = { waiting: 1, progress: 1, stalled: 0, queued: 0, completed: 1, failed: 0 };

interface Mounted { el: HTMLElement; zip: HTMLElement; detail: HTMLElement; phase: MissionPhase; sig: string }

export interface MissionsHandle {
  el: HTMLElement;
  /** Re-read the store and paint; the store's events call this already. */
  render(): void;
  /** Play the ALGN wave over the rows on screen, once, when the field goes live. */
  align(): void;
  dispose(): void;
}

export function mountMissions(host: HTMLElement, c: Console): MissionsHandle {
  const el = document.createElement('aside');
  el.className = 'missions algn';
  el.setAttribute('aria-label', 'missions');
  el.innerHTML = `
    <header class="algn__head missions__head" data-fold aria-expanded="true">
      <span class="algn__badge"><canvas data-badge></canvas></span>
      <p class="px px--modal missions__t">MISSIONS <span class="missions__n" data-n>0</span></p>
      <span class="px px--tiny missions__fold" data-fold-mark>FOLD</span>
    </header>
    <div class="missions__list scroll" data-list></div>
  `;
  host.appendChild(el);
  paintBadge(el.querySelector<HTMLCanvasElement>('[data-badge]')!);

  const list = el.querySelector<HTMLElement>('[data-list]')!;
  const countEl = el.querySelector<HTMLElement>('[data-n]')!;
  const head = el.querySelector<HTMLElement>('[data-fold]')!;
  const foldMark = el.querySelector<HTMLElement>('[data-fold-mark]')!;
  const rows = new Map<string, Mounted>();
  /** The rows the operator has opened. Forgotten on reload, like a scroll position. */
  const opened = new Set<string>();
  let emptyEl: HTMLElement | null = null;
  /**
   * Cuándo acaba la onda que está corriendo, en reloj de pared. `0` es «el
   * panel todavía no se ha alineado».
   *
   * Es un instante y no un `aligned` de sí o no porque la tanda no siempre
   * llega junta: el mundo puede traer dos misiones y el hub tres más doscientos
   * milisegundos después, y esas tres tienen que entrar en la misma onda, no
   * aparecer ya a ras mientras las primeras siguen estrechas. Mientras el
   * reloj no pase de aquí, lo que llega se alinea; a partir de aquí, entra y
   * ya está.
   *
   * Un mundo que llega mientras el boot ocupa la pantalla no cuenta —la onda
   * se jugaría detrás de la cortina y nadie la vería—, así que mientras
   * `store.booting` las filas se sientan enteras, esto sigue en `0`, y
   * `align()`, que `main.ts` llama cuando el campo se enciende, arranca la
   * onda entonces.
   */
  let waveEndsAt = 0;
  const waving = () => waveEndsAt === 0 || Date.now() < waveEndsAt;
  /** Lo que tarda en asentarse una onda de `n` filas, en milisegundos. */
  const waveMs = (n: number) => (ALGN_HOLD + Math.max(0, n - 1) * ALGN_BEAT + ALGN_SEAT) * 1000;

  /**
   * Si el panel está plegado, según el operador y no según el DOM.
   *
   * El `display: none` llega al final del gesto, así que durante medio segundo
   * la clase dice todavía «desplegado» mientras el panel se está recogiendo. Un
   * segundo clic en ese hueco tiene que leerse como «vuelve», y para eso hace
   * falta la intención, no lo que el DOM enseñe en ese fotograma.
   */
  let folded = getPref('missionsFolded');
  /** El gesto que esté corriendo, para poder cortarlo si el operador se arrepiente. */
  let foldTl: AlgnGesture | null = null;

  function setFolded(next: boolean, animate: boolean) {
    head.setAttribute('aria-expanded', next ? 'false' : 'true');
    foldMark.textContent = next ? 'UNFOLD' : 'FOLD';
    foldTl?.kill();
    foldTl = null;
    if (!animate || REDUCE.value || store.booting) {
      algnFoldClear(list);
      el.classList.toggle('is-folded', next);
      return;
    }
    if (next) {
      // Las filas se van y la lista se cierra tras ellas; el `display: none`
      // sólo al final, y sólo si para entonces sigue plegado.
      foldTl = algnFold(list, [...rows.values()].map((m) => m.el), false, () => {
        if (folded) el.classList.add('is-folded');
      });
      return;
    }
    // La caja crece hasta su alto —lo que dice que hay más panel que antes, y
    // lo que empuja a lo que tenga debajo— al ritmo al que se llena, y las
    // filas entran en el compás del comp, una tras otra, como cuando llegaron.
    el.classList.remove('is-folded');
    algnUnfold(list, rows.size, false);
    reveal();
  }
  setFolded(folded, false);
  head.addEventListener('click', () => {
    folded = !folded;
    setPref('missionsFolded', folded);
    setFolded(folded, true);
  });

  /**
   * What a click on the row itself does: open the mission — what it is, what
   * was asked and what came out — whether it is running or done. The
   * conversation is one tab away, and it is not what a click comes to read.
   */
  const primary = (_r: MissionRow): 'talk' | 'crew' | 'results' => 'results';

  function rowHtml(r: MissionRow): string {
    const detailId = `missions-d-${r.id}`;
    return `
      <button class="missions__open" type="button" data-open aria-describedby="${detailId}">
        <span class="px px--tiny missions__title" data-title></span>
      </button>
      <div class="algn-bar"><div class="algn-zip" data-zip>${ZIP_SVG}</div></div>
      <span class="px px--tiny missions__meta"><span data-phase>${PHASE_WORD[r.phase]}</span> · <span data-ago>${ago(r.at)}</span></span>
      <button class="missions__peek" type="button" data-peek aria-expanded="false" aria-controls="${detailId}">
        <span class="missions__crewn" data-crewn hidden></span><span class="missions__chev" aria-hidden="true">▸</span>
      </button>
      <div class="missions__detail" id="${detailId}" data-detail hidden></div>`;
  }

  function crewHtml(r: MissionRow): string {
    if (!r.crew.length) {
      return `<p class="px px--tiny missions__none">${isOpen(r.phase) ? 'NOBODY ON IT RIGHT NOW' : 'NO CREW STILL RUNNING'}</p>`;
    }
    // A squad of twenty would push the detail into a paragraph of its own. The
    // count is the number; the callsigns are how you reach one, and eight of
    // them is a reach.
    const shown = r.crew.slice(0, CREW_SHOWN);
    const rest = r.crew.length - shown.length;
    return `<div class="missions__crew px px--tiny">`
      + shown.map((a) => `<button class="missions__cs" type="button" data-go="${esc(a.id)}" title="fly to ${esc(a.callsign)}">${esc(a.callsign)}</button>`).join('')
      + (rest > 0 ? `<span class="missions__crewn">+${rest}</span>` : '')
      + `</div>`;
  }

  function detailHtml(r: MissionRow): string {
    const brief = r.brief.trim();
    // El encargo, salvo cuando el título ES el encargo —una misión que tomó su
    // nombre de la primera línea del operador— porque entonces enseñarlo dos
    // veces es ruido, no información.
    const body = !brief
      ? `<p class="px px--tiny missions__none">NOTHING WRITTEN IN THIS MISSION YET</p>`
      : brief === r.headline ? ''
      : `<div class="missions__brief mono scroll">${esc(brief)}</div>`;
    return `
      <p class="missions__full mono">${esc(r.headline)}</p>
      ${body}
      ${crewHtml(r)}
      <div class="missions__acts">
        <button class="missions__act" type="button" data-act="results">MISSION</button>
        <button class="missions__act" type="button" data-act="talk">CONVERSATION</button>
        <button class="missions__act" type="button" data-act="crew">CREW</button>
      </div>`;
  }

  function setOpen(m: Mounted, r: MissionRow, on: boolean) {
    if (on) opened.add(r.id); else opened.delete(r.id);
    const peek = m.el.querySelector<HTMLElement>('[data-peek]')!;
    peek.setAttribute('aria-expanded', on ? 'true' : 'false');
    peek.querySelector<HTMLElement>('.missions__chev')!.textContent = on ? '▾' : '▸';
    m.detail.hidden = !on;
    m.el.classList.toggle('is-open', on);
  }

  function paintRow(m: Mounted, r: MissionRow, index: number, fresh: boolean) {
    const row = m.el;
    const sig = JSON.stringify([r.title, r.headline, r.brief, r.phase, r.crew.map((a) => a.id + a.callsign)]);
    const phaseChanged = m.phase !== r.phase;
    if (sig !== m.sig) {
      m.sig = sig;
      const title = row.querySelector<HTMLElement>('[data-title]')!;
      title.textContent = `+ ${r.title}`;
      const open = row.querySelector<HTMLButtonElement>('[data-open]')!;
      open.title = `${r.headline} · open the mission`;
      row.querySelector<HTMLElement>('[data-phase]')!.textContent = PHASE_WORD[r.phase];
      const crewn = row.querySelector<HTMLElement>('[data-crewn]')!;
      crewn.textContent = String(r.crew.length);
      crewn.hidden = !r.crew.length;
      row.querySelector<HTMLElement>('[data-peek]')!.setAttribute(
        'aria-label', `${r.headline} — full title, brief and crew`);
      m.detail.innerHTML = detailHtml(r);
      for (const p of Object.keys(ZIP_AT) as MissionPhase[]) row.classList.toggle(`is-${p}`, r.phase === p);
      row.classList.toggle('is-done', !isOpen(r.phase));
      m.phase = r.phase;
    }
    row.querySelector<HTMLElement>('[data-ago]')!.textContent = ago(r.at);
    row.classList.toggle('is-current', store.activeMissionId === r.id);
    setOpen(m, r, opened.has(r.id));

    const reduce = REDUCE.value || store.booting;
    if (fresh && waving()) {
      algnRowIn(row, index, reduce);
      algnZipTo(m.zip, ZIP_AT[r.phase], reduce, algnZipDelay(index));
    } else if (fresh) {
      // La onda ya pasó: lo que llega después entra en su sitio y en su orden,
      // sin ella. Una misión nueva se anuncia igual cuando cambie de fase, que
      // es lo que de verdad es noticia.
      algnRowBack(row, index, reduce);
      // La cremallera se sienta donde toca sin barrer: barrer es la onda.
      algnZipTo(m.zip, ZIP_AT[r.phase], true);
    } else if (phaseChanged) {
      algnRowPulse(row, reduce);
      algnZipTo(m.zip, ZIP_AT[r.phase], reduce);
    }
  }

  function mountRow(r: MissionRow, index: number): Mounted {
    const row = document.createElement('div');
    row.className = 'algn-row missions__row';
    row.dataset.mission = r.id;
    row.innerHTML = rowHtml(r);
    const m: Mounted = {
      el: row,
      zip: row.querySelector<HTMLElement>('[data-zip]')!,
      detail: row.querySelector<HTMLElement>('[data-detail]')!,
      phase: r.phase, sig: '',
    };
    rows.set(r.id, m);
    paintRow(m, r, index, true);
    return m;
  }

  /** The rows on screen right now, by id, so a click can ask what its row says. */
  let shownRows = new Map<string, MissionRow>();

  function render() {
    const agentOf = (id: string) => store.knownAgent(id);
    const shown = missionRows(visibleMissions(store.world.missions ?? {}), agentOf);
    const openCount = shown.filter((r) => isOpen(r.phase)).length;
    countEl.textContent = String(openCount);
    el.classList.toggle('has-open', openCount > 0);

    shownRows = new Map(shown.map((r) => [r.id, r]));
    const keep = new Set(shown.map((r) => r.id));
    for (const [id, m] of rows) if (!keep.has(id)) { m.el.remove(); rows.delete(id); opened.delete(id); }

    /*
     * Walk in order and move only what is out of place.
     *
     * Appending every row on every render re-inserts the node, and a node that
     * is re-inserted loses the focus inside it: the operator opens a row's
     * detail with the keyboard, the ten-second clock ticks, and the next key
     * goes to the field. So a row that is already where it belongs is left
     * exactly where it is.
     */
    let arrivals = 0;
    let at = 0;
    for (const r of shown) {
      const had = rows.get(r.id);
      const m = had ?? mountRow(r, arrivals++);
      if (had) paintRow(m, r, 0, false);
      if (list.children[at] !== m.el) list.insertBefore(m.el, list.children[at] ?? null);
      at++;
    }
    // La onda se declara jugada al acabar la tanda entera, no al pintar su
    // primera fila: si se declarase ahí, el resto de esa misma tanda entraría
    // ya a ras y la primera se ensancharía sola un segundo después.
    if (arrivals && waving() && !(REDUCE.value || store.booting)) {
      waveEndsAt = Date.now() + waveMs(arrivals);
    }

    if (!shown.length) {
      if (!emptyEl) {
        emptyEl = document.createElement('p');
        emptyEl.className = 'px px--tiny missions__empty';
        emptyEl.textContent = 'NO MISSIONS · NEW MISSION IN CAPCOM';
      }
      if (emptyEl.parentNode !== list || list.lastChild !== emptyEl) list.appendChild(emptyEl);
    } else if (emptyEl) { emptyEl.remove(); emptyEl = null; }
  }

  /** The three thirds of a mission's window, from a row or from its detail. */
  function enter(id: string, what: 'talk' | 'crew' | 'results') {
    c.openMission(id, { tab: what });
  }

  list.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const go = t.closest<HTMLElement>('[data-go]');
    if (go) { e.stopPropagation(); go.blur(); c.go(go.dataset.go!); return; }

    const row = t.closest<HTMLElement>('[data-mission]');
    const id = row?.dataset.mission;
    if (!row || !id) return;
    const m = rows.get(id);
    const r = shownRows.get(id);
    if (!m || !r) return;

    const act = t.closest<HTMLElement>('[data-act]');
    if (act) { e.stopPropagation(); act.blur(); enter(id, act.dataset.act as 'talk' | 'crew' | 'results'); return; }

    if (t.closest('[data-peek]')) {
      e.stopPropagation();
      setOpen(m, r, m.detail.hidden);
      return;
    }
    // Anywhere else on the row — the title button included — is the way in.
    (t.closest<HTMLElement>('[data-open]'))?.blur();
    enter(id, primary(r));
  });

  /**
   * Las filas que vuelven de un pliegue, en el compás del comp y en su orden.
   *
   * No es `align()`: la onda —estrecha, espera, ensancha, cremallera— es la
   * alineación del panel y se juega una vez. Aquí no llega nada nuevo, así que
   * queda el compás, que es lo que dice «esto está aquí, y en este orden».
   */
  function reveal() {
    if (REDUCE.value || store.booting || !rows.size) return;
    let i = 0;
    for (const id of shownRows.keys()) {
      const m = rows.get(id);
      if (m) algnRowBack(m.el, i++, false);
    }
  }

  /** La onda del comp sobre las filas que ya están, en orden. */
  function align() {
    if (!waving() || REDUCE.value || store.booting || !rows.size) return;
    let i = 0;
    for (const [id, r] of shownRows) {
      const m = rows.get(id);
      if (!m) continue;
      algnRowIn(m.el, i, false);
      algnZipTo(m.zip, ZIP_AT[r.phase], false, algnZipDelay(i));
      i++;
    }
    if (i) waveEndsAt = Date.now() + waveMs(i);
  }

  const off = store.on((e) => {
    if (e.k === 'missions' || e.k === 'agents' || e.k === 'world') render();
  });
  // The "2M" readouts age; an idle render changes text and nothing else.
  const agoTimer = window.setInterval(render, AGO_TICK_MS);
  render();

  return {
    el,
    render,
    align,
    dispose() { off(); window.clearInterval(agoTimer); el.remove(); },
  };
}
