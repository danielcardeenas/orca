/**
 * SELF-IMPROVEMENT — la sección de auto-revisión, bajo el panel de misiones.
 *
 * Lo que hay en el campo habla de la FLOTA. Esto habla del INSTRUMENTO: cómo
 * se está usando ORCA, qué estorba y qué podría hacerse mejor. Es una sección
 * aparte y se ve que lo es —color propio, silueta propia, su propio aviso—
 * porque leer una propuesta sobre la consola con el vestido del panel de
 * misiones la haría pasar por trabajo de un agente.
 *
 * ── Lo que enseña una fila, en el orden en que se decide ────────────
 *
 *   cerrada    UNA LÍNEA, como una misión: el título, impacto y esfuerzo como
 *              dos medidores de tres celdas —y SÓLO si la revisión tuvo con
 *              qué estimarlos: una casilla vacía dice «no lo sé», que es
 *              verdad, y una inventada ordenaría la lista mal—, el área, si es
 *              medición o hipótesis, y cuándo se movió.
 *   abierta    el resumen entero, la evidencia (cifras medidas), la hipótesis
 *              cuando la idea no viene de una medición, el detalle largo, la
 *              pregunta al operador y la conversación entera.
 *
 * Era una ficha de tres líneas, y ocho fichas tapaban media pantalla para
 * decir ocho titulares. Lo que se lee en diagonal es la lista; lo que se lee
 * de verdad es una propuesta cada vez, y para eso está el detalle.
 *
 * La barra del borde izquierdo es CONTINUA cuando la propuesta se apoya en
 * mediciones y DISCONTINUA cuando es una hipótesis. La textura lo dice antes
 * que la etiqueta, como la trama de un tile dice qué runtime corre dentro.
 *
 * ── Los gestos ─────────────────────────────────────────────────────
 *
 * Plegar y devolver son los del panel de misiones, hasta el fotograma: las
 * piezas se van estrechándose de abajo arriba y el cuerpo se cierra tras ellas
 * como una persiana (`algnFold`); al volver, la caja crece al ritmo al que se
 * llena (`algnUnfold`) y las piezas entran en el compás del comp
 * (`algnRowBack`). Lo que NO se comparte es la entrada: allí es la onda de
 * alineación de la flota y aquí un barrido que descubre cada fila de izquierda
 * a derecha (`algnRowSweep`). Dos paneles con la misma entrada se leen como el
 * mismo panel, y este habla del instrumento, no de la flota.
 *
 * ── El aviso ───────────────────────────────────────────────────────
 *
 * Una propuesta avisa UNA vez: cuenta en la cabecera, un punto en su esquina,
 * un paso lateral del panel y un sonido, y nada de eso vuelve a ocurrir por
 * ella. Se apaga al abrirla —que es cuando de verdad se ha visto— o pulsando
 * la cuenta. Nada late, nada se repite y nada aquí abre una ventana solo: lo
 * único que en ORCA puede reclamar a un humano por su cuenta es un agente
 * parado, y una propuesta no para a nadie.
 *
 * ── Lo que cuesta, a la vista ──────────────────────────────────────
 *
 * La línea de estado dice por qué no toca revisar todavía —«NEXT IN 3H»,
 * «WAITING FOR SIGNAL 12/40», «CAPCOM IS MID-TURN»— y no un genérico. Al lado,
 * REVIEW NOW para saltárselo y PAUSE para pararlo. SETUP abre los tres
 * límites. Una revisión periódica que el operador no puede ver, parar ni
 * espaciar es un gasto que no controla.
 */

import gsap from 'gsap';

import type { Console } from '../console.ts';
import { store } from '../store.ts';
import { hub } from '../net/client.ts';
import { getPref, setPref } from '../prefs.ts';
import { ago, besidesTitle, esc } from '../util.ts';
import { REDUCE } from '../motion.ts';
import { getSound } from './sound.ts';
import { pick, type PickHandle } from '../controls.ts';
import type { ProviderModel } from '../../shared/provider-handoff.ts';
import { sigilBits, sigilRows } from '../gfx/sigil.ts';
import {
  type AlgnGesture, algnFold, algnFoldClear, algnRowBack, algnRowSweep, algnUnfold, paintBits,
} from '../gfx/algn.ts';
import {
  BUDGET_MAX, BUDGET_MIN, IMPROVE_GRADES, REVIEW_MAX_MS,
  activeReview, effectiveStatus, heldReason, openProposals, sortProposals,
  type ImproveGrade, type ImproveProposal, type ImproveReview, type ImproveState, type ImproveStatus,
} from '../../shared/improve.ts';
import { ceilingTokens } from '../../shared/tokens.ts';
import { stateVar, stateWord } from '../util.ts';
import { isSendChord } from '../windows/composer.ts';
import { gesture } from '../gestures.ts';

/** Cuántas cerradas se enseñan antes de plegar el resto bajo una cuenta. */
const CLOSED_SHOWN = 3;
/** Cada cuánto se refrescan los «2M». Texto y nada más. */
const AGO_TICK_MS = 30_000;
/** Lo que pospone LATER. Tres días: una semana entierra, un día no descansa. */
const SNOOZE_MS = 3 * 86_400_000;

/** Los pasos del reloj, en minutos. Lo que un operador querría de verdad. */
const EVERY_STEPS = [60, 180, 360, 720, 1440];
const PER_DAY_STEPS = [1, 2, 4, 8, 12];
const SIGNAL_STEPS = [0, 10, 40, 100, 250];
/**
 * El techo de UN revisor. Empieza en 100k —una pasada corta que lee el informe
 * y poco más— y llega a 2M para quien quiera una revisión que se lea el repo
 * entero. Es un eje distinto del tope diario: ver `REVIEWER_BUDGET_TOKENS`.
 */
const BUDGET_STEPS = [100_000, 200_000, 400_000, 800_000, 2_000_000];

function nextStep(steps: number[], current: number): number {
  const i = steps.findIndex((s) => s >= current);
  return steps[(i < 0 ? steps.length - 1 : i) + 1 >= steps.length ? 0 : (i < 0 ? 0 : i + 1)]!;
}

function hours(min: number): string {
  return min < 60 ? `${min}M` : min % 60 === 0 ? `${min / 60}H` : `${(min / 60).toFixed(1)}H`;
}

/** Cómo acabó una revisión, en dos palabras. Ver la nota en `paintStatus`. */
function outcome(r: ImproveReview): string {
  switch (r.status) {
    case 'reported': return `· ${r.filed}+${r.merged}`;
    case 'launching': case 'running': return '· RUNNING';
    case 'ended': return '· ENDED WITH NOTHING FILED';
    case 'failed': return '· FAILED';
    case 'cancelled': return '· CANCELLED';
    case 'expired': return '· TIMED OUT';
    case 'overbudget': return '· STOPPED OVER BUDGET';
  }
}

/** Un medidor de tres celdas, o nada. Nada es una respuesta: no se sabe. */
function meter(label: string, g?: ImproveGrade): string {
  if (!g) return '';
  const n = IMPROVE_GRADES.indexOf(g) + 1;
  const cells = '▮'.repeat(n) + '▯'.repeat(3 - n);
  return `<span class="imp__meter" title="${esc(label.toLowerCase())}: ${esc(g)}">${esc(label)} <i>${cells}</i></span>`;
}

function talkHtml(p: ImproveProposal): string {
  if (!p.notes.length) return '';
  return `<span class="imp__k">CONVERSATION</span><ul class="imp__talk">`
    + p.notes.map((n) => `<li class="is-${esc(n.role)}"><span class="imp__who">${esc(n.role === 'human' ? 'YOU' : n.role)}</span><span>${esc(n.text)}</span></li>`).join('')
    + `</ul>`;
}

function detailHtml(p: ImproveProposal, status: ImproveStatus): string {
  const parts: string[] = [];
  // El título ENTERO abre el detalle. La fila lo corta con puntos suspensivos y
  // hasta hoy lo entero sólo vivía en el `title=`, o sea en un tooltip: algo
  // que no se puede tabular, no se puede tocar en un teléfono y se va mientras
  // lo lees. Un titular que no se puede leer no es un titular.
  parts.push(`<p class="imp__full">${esc(p.title)}</p>`);
  // Y debajo el resumen, salvo cuando es el título otra vez —una propuesta cuya
  // frase cabía en el titular— por lo mismo que en el panel de misiones: ver
  // `besidesTitle`.
  const summary = besidesTitle(p.title, p.summary ?? '');
  if (summary) parts.push(`<p class="imp__sum">${esc(summary)}</p>`);
  if (p.evidence.length) {
    parts.push(`<span class="imp__k">EVIDENCE · MEASURED</span><ul class="imp__ev">`
      + p.evidence.map((e) => `<li>${esc(e)}</li>`).join('') + `</ul>`);
  }
  if (p.hypothesis) {
    parts.push(`<span class="imp__k">HYPOTHESIS · NOT MEASURED</span><p class="imp__hyp">${esc(p.hypothesis)}</p>`);
  }
  if (p.detail) parts.push(`<span class="imp__k">DETAIL</span><p class="imp__long">${esc(p.detail)}</p>`);
  if (p.question) parts.push(`<span class="imp__k">ASKS YOU</span><p class="imp__q">${esc(p.question)}</p>`);
  // Quién la propuso, y cómo llegar a él. Es lo que ata una idea al trabajo
  // que la produjo: una propuesta sin autor no se puede auditar.
  if (p.callsign || p.agentId) {
    parts.push(`<p class="imp__by px">PROPOSED BY <button class="imp__who-go" type="button" data-do="author" title="fly to the reviewer that wrote this">${esc(p.callsign ?? p.agentId!.slice(0, 8))}</button></p>`);
  }
  parts.push(talkHtml(p));

  // Contestar sigue disponible después de enviarla o descartarla: una decisión
  // no cierra una conversación, y lo que se diga aquí viaja con la propuesta.
  parts.push(`<div class="imp__reply">
      <textarea data-reply rows="2" placeholder="${p.question ? 'ANSWER CAPCOM…' : 'SAY SOMETHING ABOUT THIS…'}" aria-label="reply"></textarea>
      <button class="imp__act" type="button" data-do="reply">REPLY</button>
    </div>`);

  const acts: string[] = [];
  if (p.missionId) {
    acts.push(`<button class="imp__mission" type="button" data-do="mission">OPEN MISSION</button>`);
  } else {
    // IMPLEMENT y no SEND TO CAPCOM: lo que pasa al pulsar es que ORCA lanza
    // un agente propio sobre su repositorio como líder de una misión nueva.
    // CAPCOM no trabaja en ella; recibe el resultado cuando el líder acaba.
    acts.push(`<button class="imp__act is-send" type="button" data-do="send" title="Opens a mission and launches ORCA's own implementer on its repository. CAPCOM only receives the result.">IMPLEMENT</button>`);
  }
  if (status === 'open') {
    acts.push(`<button class="imp__act" type="button" data-do="snooze">LATER · 3D</button>`);
    acts.push(`<button class="imp__act" type="button" data-do="dismiss">DISMISS</button>`);
  } else if (status === 'snoozed' || status === 'dismissed') {
    acts.push(`<button class="imp__act" type="button" data-do="reopen">REOPEN</button>`);
  }
  parts.push(`<div class="imp__acts">${acts.join('')}</div>`);
  return `<div class="imp__d">${parts.join('')}</div>`;
}

/**
 * Una propuesta, en una línea.
 *
 * Título, los dos medidores, el área y cuándo se movió, y la flecha que abre
 * el resto. El título lleva `title=` porque la fila lo corta: lo entero está
 * en el detalle, y el tooltip es sólo el atajo del ratón.
 *
 * Lo que NO va en la línea es si la propuesta es una medición o una hipótesis.
 * Lo decía en palabras —«USABILITY · MEASURED · 1H»— y esas ocho letras se las
 * quitaba al título, que es lo único que se lee en diagonal: en una lista de
 * ocho propuestas el titular quedaba en «THE QUEUE B…». La barra del borde ya
 * lo dice, continua o discontinua, sin gastar ancho, y el detalle lo dice con
 * todas las letras al abrirlo.
 */
function rowHtml(p: ImproveProposal, status: ImproveStatus, open: boolean, now: number): string {
  // Una terminada lo dice con una palabra: la barra ya dice que es una misión,
  // y sin esto una misión cerrada y una en marcha se leían igual.
  const when = status === 'snoozed' && p.snoozeUntil
    ? `BACK IN ${Math.max(1, Math.round((p.snoozeUntil - now) / 86_400_000))}D`
    : status === 'completed' ? `DONE · ${ago(p.updatedAt, now)}`
      : ago(p.updatedAt, now);
  const raised = p.raised > 1 ? ` · RAISED ${p.raised}×` : '';
  return `
    <i class="imp__dot" aria-hidden="true"></i>
    <button class="imp__title" type="button" data-toggle aria-expanded="${open}" title="${esc(p.title)}">${esc(p.title)}</button>
    <span class="imp__grade">${meter('IMP', p.impact)}${meter('EFF', p.effort)}</span>
    <span class="imp__tags ${p.kind === 'hypothesis' ? 'is-hyp' : ''}">${esc(p.area.toUpperCase())} · ${esc(when)}${raised}</span>
    <button class="imp__chev" type="button" data-toggle aria-label="detail">▸</button>
    ${open ? detailHtml(p, status) : ''}`;
}

export interface ImproveHandle {
  el: HTMLElement;
  render(): void;
  /** Despliega la sección y la trae a la vista. Lo que hace ⌥I. */
  reveal(): void;
  dispose(): void;
}

export function mountImprove(host: HTMLElement, c: Console): ImproveHandle {
  const el = document.createElement('aside');
  el.className = 'improve';
  el.setAttribute('aria-label', 'automejora');
  el.innerHTML = `
    <button class="improve__head" type="button" data-fold aria-expanded="true">
      <canvas class="improve__sigil" data-sigil aria-hidden="true"></canvas>
      <span class="px improve__t">SELF-IMPROVEMENT</span>
      <span class="improve__n px" data-n title="open proposals">0</span>
      <span class="px improve__fold" data-fold-mark>FOLD</span>
    </button>
    <div class="improve__body" data-body>
      <div class="improve__status">
        <span class="improve__when px" data-when>ASKING THE HUB…</span>
        <button class="improve__btn" type="button" data-run>REVIEW NOW</button>
        <button class="improve__btn" type="button" data-pause>PAUSE</button>
        <button class="improve__btn" type="button" data-setup>SETUP</button>
      </div>
      <div class="improve__agent" data-agent hidden>
        <button class="improve__agent-go" type="button" data-go>REVIEWER</button>
        <span class="improve__agent-meta px" data-agent-meta></span>
        <button class="improve__btn improve__agent-stop" type="button" data-stop>STOP</button>
      </div>
      <div class="improve__setup">
        <span class="improve__field">EVERY <b data-every>—</b>
          <button class="improve__btn" type="button" data-cfg="everyMin">CHANGE</button></span>
        <span class="improve__field">MAX PER DAY <b data-perday>—</b>
          <button class="improve__btn" type="button" data-cfg="perDay">CHANGE</button></span>
        <span class="improve__field">MIN SIGNAL <b data-signal>—</b>
          <button class="improve__btn" type="button" data-cfg="minSignal">CHANGE</button></span>
        <span class="improve__field">REVIEWER BUDGET <b data-budget>—</b>
          <button class="improve__btn" type="button" data-cfg="budgetTokens">CHANGE</button></span>
        <span class="improve__custom">
          <input class="improve__num" data-budget-input type="text" inputmode="numeric"
                 placeholder="OR TYPE ONE" aria-label="reviewer budget in tokens" maxlength="12">
          <button class="improve__btn" type="button" data-budget-set>SET</button>
        </span>
        <span class="improve__pick">RUNTIME <span data-pick-runtime></span></span>
        <span class="improve__pick">MODEL <span data-pick-model></span></span>
        <span class="improve__note" data-effective></span>
      </div>
      <div class="improve__list scroll" data-list></div>
    </div>
  `;
  host.appendChild(el);
  /*
   * El sigilo, en lienzo y no en DOM. Aquí va a un tamaño fijo junto a una
   * insignia, y el lienzo lo deja nítido al píxel sin depender de cómo redondee
   * el navegador una rejilla en `em`. Los bits son los mismos (`sigilBits`),
   * así que el glifo es el de siempre; sólo cambia con qué se pinta. (La razón
   * histórica era otra: `sigilHTML` pintaba con sombras exteriores, que se
   * recortan contra la caja del propio elemento y no dibujaban nada; eso ya
   * está arreglado en `gfx/sigil.ts`.)
   */
  paintBits(el.querySelector<HTMLCanvasElement>('[data-sigil]')!, sigilRows(sigilBits('automejora')), 3, '#b47cff');

  const list = el.querySelector<HTMLElement>('[data-list]')!;
  const body = el.querySelector<HTMLElement>('[data-body]')!;
  const countEl = el.querySelector<HTMLElement>('[data-n]')!;
  const whenEl = el.querySelector<HTMLElement>('[data-when]')!;
  const head = el.querySelector<HTMLElement>('[data-fold]')!;
  const foldMark = el.querySelector<HTMLElement>('[data-fold-mark]')!;
  const pauseBtn = el.querySelector<HTMLButtonElement>('[data-pause]')!;
  const runBtn = el.querySelector<HTMLButtonElement>('[data-run]')!;
  const agentRow = el.querySelector<HTMLElement>('[data-agent]')!;
  const budgetInput = el.querySelector<HTMLInputElement>('[data-budget-input]')!;
  const effectiveEl = el.querySelector<HTMLElement>('[data-effective]')!;
  const runtimeHost = el.querySelector<HTMLElement>('[data-pick-runtime]')!;
  const modelHost = el.querySelector<HTMLElement>('[data-pick-model]')!;
  const goBtn = el.querySelector<HTMLButtonElement>('[data-go]')!;
  const agentMeta = el.querySelector<HTMLElement>('[data-agent-meta]')!;
  const stopBtn = el.querySelector<HTMLButtonElement>('[data-stop]')!;

  /** Las fichas abiertas. Se olvidan al recargar, como una posición de scroll. */
  const opened = new Set<string>();
  /** Lo cerrado desplegado bajo «…AND N MORE». */
  let showMore = false;
  /** ¿Ya se jugó el barrido de entrada? Se juega una vez, como toda entrada. */
  let swept = false;
  /** Lo ya anunciado: es lo que impide que el mismo aviso suene dos veces. */
  const announced = new Set<string>();
  /** El primer pintado no es noticia: lo que llega después, sí. */
  let settled = false;
  let busy = false;

  /**
   * Si la sección está plegada, según el operador y no según el DOM: el
   * `display: none` llega al final del gesto, y un segundo clic en ese hueco
   * tiene que leerse como «vuelve». Lo mismo que en el panel de misiones.
   */
  let folded = getPref('improveFolded');
  /** El gesto de pliegue en marcha, para poder cortarlo. */
  let foldTl: AlgnGesture | null = null;

  /**
   * Lo que se va al plegar, de arriba abajo y en el compás: la línea de
   * estado, el revisor si lo hay, los límites si están abiertos, y después
   * cada propuesta. La lista entera como bloque no diría nada del orden.
   */
  function foldParts(): HTMLElement[] {
    const parts: HTMLElement[] = [];
    for (const n of body.children) {
      const e = n as HTMLElement;
      if (e === list || !e.getClientRects().length) continue;
      parts.push(e);
    }
    parts.push(...list.querySelectorAll<HTMLElement>('.imp'));
    return parts;
  }

  function setFolded(next: boolean, animate: boolean) {
    head.setAttribute('aria-expanded', next ? 'false' : 'true');
    foldMark.textContent = next ? 'UNFOLD' : 'FOLD';
    foldTl?.kill();
    foldTl = null;
    if (!animate || REDUCE.value || store.booting) {
      algnFoldClear(body);
      el.classList.toggle('is-folded', next);
      return;
    }
    if (next) {
      // Igual que el panel de misiones: las piezas se van estrechándose de
      // abajo arriba y el cuerpo se cierra tras ellas como una persiana.
      foldTl = algnFold(body, foldParts(), false, () => { if (folded) el.classList.add('is-folded'); });
      return;
    }
    el.classList.remove('is-folded');
    // La caja crece al ritmo al que se llena y las piezas entran en compás. La
    // primera vez que la sección se enseña, ese compás es su barrido —su
    // entrada— y no el de vuelta de un pliegue.
    const parts = foldParts();
    algnUnfold(body, parts.length, false);
    for (const [i, e] of parts.entries()) {
      if (swept) algnRowBack(e, i, false); else algnRowSweep(e, i, false);
    }
    swept = true;
  }
  setFolded(folded, false);
  head.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-n]')) return;
    folded = !folded;
    setPref('improveFolded', folded);
    setFolded(folded, true);
    gesture('hud', folded ? 'improve-fold' : 'improve-unfold');
  });

  /* ── acciones ───────────────────────────────────────────────────── */

  /**
   * Toda acción pasa por aquí: se bloquean los botones mientras vuela, el
   * tablero que conteste el hub sustituye al que había, y un fallo se dice en
   * el feed con su motivo. Un botón que no hace nada y no explica por qué se
   * pulsa tres veces, y tres veces es lo que no puede pasar con SEND.
   */
  function act(run: () => Promise<{ state: ImproveState; verdict?: unknown }>, ok?: (data: never) => void): void {
    if (busy) return;
    busy = true;
    el.classList.add('is-busy');
    void run()
      .then((data) => {
        const w = data as Partial<import('../net/client.ts').ImproveWire>;
        store.putImprove(data.state, w.verdict ?? null,
          { ...(w.choice ? { choice: w.choice } : {}), ...(w.machineId !== undefined ? { machineId: w.machineId } : {}) });
        ok?.(data as never);
      })
      .catch((err: unknown) => c.note(err instanceof Error ? err.message : String(err), 'warn'))
      .finally(() => { busy = false; el.classList.remove('is-busy'); render(); });
  }

  runBtn.addEventListener('click', () => {
    runBtn.blur();
    act(() => hub.improveRun(), (data: { ok: boolean; reason: string }) => {
      c.note(data.ok ? `self-review asked: ${data.reason.toLowerCase()}` : data.reason, data.ok ? 'info' : 'warn');
    });
  });

  pauseBtn.addEventListener('click', () => {
    pauseBtn.blur();
    const paused = !(store.improve?.config.paused ?? false);
    act(() => hub.improveConfig({ paused }));
  });

  goBtn.addEventListener('click', () => {
    goBtn.blur();
    const id = store.improve ? activeReview(store.improve, Date.now())?.agentId : null;
    if (!id) return;
    c.go(id);
    c.openAgent(id);
  });

  stopBtn.addEventListener('click', () => {
    stopBtn.blur();
    act(() => hub.improveCancel(), (data: { reason: string }) => c.note(data.reason, 'warn'));
  });

  /**
   * Un presupuesto escrito a mano.
   *
   * Los presets cubren lo normal; esto cubre lo que no. Quien manda es el
   * SERVIDOR: aquí sólo se comprueba que es un número para no mandar basura, y
   * el hub lo recorta a su rango y devuelve lo que quedó — que es lo que se
   * pinta. Así el operador ve el valor de verdad y no el que escribió.
   */
  function setCustomBudget(): void {
    const raw = budgetInput.value.replace(/[\s,._]/g, '');
    const n = Number(raw);
    if (!raw || !Number.isFinite(n) || n <= 0) {
      c.note('write the budget in tokens, e.g. 650000', 'warn');
      return;
    }
    act(() => hub.improveConfig({ budgetTokens: Math.round(n) }), () => {
      budgetInput.value = '';
      const got = store.improve?.budgetTokens ?? 0;
      if (got !== Math.round(n)) c.note(`budget set to ${tok(got)}: ${tok(BUDGET_MIN)}–${tok(BUDGET_MAX)} is the range`, 'warn');
    });
  }
  el.querySelector('[data-budget-set]')!.addEventListener('click', (e) => {
    (e.currentTarget as HTMLElement).blur();
    setCustomBudget();
  });
  budgetInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    setCustomBudget();
  });

  el.querySelector('[data-setup]')!.addEventListener('click', (e) => {
    (e.currentTarget as HTMLElement).blur();
    el.classList.toggle('show-setup');
  });

  el.querySelector<HTMLElement>('.improve__setup')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-cfg]');
    if (!btn) return;
    btn.blur();
    const cfg = store.improve?.config;
    if (!cfg) return;
    const key = btn.dataset.cfg as 'everyMin' | 'perDay' | 'minSignal' | 'budgetTokens';
    if (key === 'budgetTokens') {
      const cur = store.improve?.budgetTokens ?? 0;
      act(() => hub.improveConfig({ budgetTokens: nextStep(BUDGET_STEPS, cur) }));
      return;
    }
    const steps = key === 'everyMin' ? EVERY_STEPS : key === 'perDay' ? PER_DAY_STEPS : SIGNAL_STEPS;
    act(() => hub.improveConfig({ [key]: nextStep(steps, cfg[key]) }));
  });

  countEl.addEventListener('click', (e) => {
    e.stopPropagation();
    countEl.blur();
    if (!el.classList.contains('has-new')) return;
    act(() => hub.improveSeen());
  });

  /*
   * ⌘/⌃Enter manda la respuesta; Enter a secas salta de línea, que es lo que
   * una caja de varias líneas tiene que hacer en un teléfono. Por delegación
   * porque las fichas se repintan enteras en cada render y una caja cableada
   * a mano se quedaría sin listener a la primera. Ver `windows/composer.ts`.
   */
  list.addEventListener('keydown', (e) => {
    const box = (e.target as HTMLElement).closest<HTMLTextAreaElement>('textarea[data-reply]');
    if (!box || !isSendChord(e)) return;
    e.preventDefault();
    box.closest('[data-imp]')?.querySelector<HTMLElement>('[data-do="reply"]')?.click();
  });

  list.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const card = t.closest<HTMLElement>('[data-imp]');
    if (!card) return;
    const id = card.dataset.imp!;

    if (t.closest('[data-toggle]')) {
      if (opened.has(id)) opened.delete(id);
      else {
        opened.add(id);
        // Abrirla ES verla: el aviso se apaga aquí y no al pintarla, que es lo
        // que distingue «lo he leído» de «estaba en pantalla».
        if (store.improve?.proposals[id]?.seenAt === undefined) act(() => hub.improveSeen([id]));
      }
      render();
      return;
    }

    const doer = t.closest<HTMLElement>('[data-do]');
    if (!doer) return;
    doer.blur();
    switch (doer.dataset.do) {
      case 'send': {
        act(() => hub.improveSend(id), (data: { missionId: string; delivery: 'launched' | 'saved'; callsign?: string }) => {
          getSound()?.play('check');
          c.note(data.delivery === 'saved'
            ? `mission ${data.missionId} written, but no implementer could be launched · open it to see why`
            : `${data.callsign ?? 'an agent'} is implementing it as mission ${data.missionId} · CAPCOM only gets the result`,
          data.delivery === 'saved' ? 'warn' : 'info');
        });
        return;
      }
      case 'snooze': act(() => hub.improveAct(id, 'snooze', { untilMs: Date.now() + SNOOZE_MS })); return;
      case 'dismiss': act(() => hub.improveAct(id, 'dismiss')); return;
      case 'reopen': act(() => hub.improveAct(id, 'reopen')); return;
      case 'author': {
        const who = store.improve?.proposals[id]?.agentId;
        if (!who) return;
        // Un revisor terminado sigue en el campo un rato; si ya no está, se
        // dice en vez de volar a un sitio vacío.
        if (!store.knownAgent(who)) { c.note('that reviewer is no longer on the fleet', 'warn'); return; }
        c.go(who);
        c.openAgent(who);
        return;
      }
      case 'mission': {
        const missionId = store.improve?.proposals[id]?.missionId;
        if (missionId) c.openMission(missionId);
        return;
      }
      case 'reply': {
        const box = card.querySelector<HTMLTextAreaElement>('[data-reply]');
        const text = box?.value.trim() ?? '';
        if (!text) { c.note('write the answer first', 'warn'); return; }
        act(() => hub.improveAct(id, 'reply', { text }), () => c.note('answer saved and handed to CAPCOM'));
        return;
      }
    }
  });

  /* ── pintado ────────────────────────────────────────────────────── */

  /**
   * La fila del revisor en vuelo.
   *
   * Enseña su ESTADO REAL —el color y la palabra que llevaría en cualquier
   * otra parte de la consola— y no un «revisando» genérico: si está bloqueado
   * es ámbar y si murió es rojo, porque un revisor que se ha atascado es
   * exactamente lo que hay que ver. Lo violeta es el marco, que dice qué
   * función cumple, no cómo le va.
   *
   * El callsign vuela la cámara hasta él y abre su ventana: desde una
   * propuesta se llega al trabajo que la produjo, que es el punto de que la
   * revisión sea un agente y no un turno.
   */
  function paintAgent(state: ImproveState | null, now: number): void {
    const live = state ? activeReview(state, now) : null;
    agentRow.hidden = !live;
    if (!live) return;
    const a = live.agentId ? store.world.agents[live.agentId] ?? store.knownAgent(live.agentId) : null;
    const name = a?.callsign ?? live.callsign ?? live.shortId?.slice(0, 8) ?? 'REVIEWER';
    /*
     * Un resultado ya decidido gana a lo que diga el estado del agente. Lo que
     * el operador quiere saber entonces no es que «sigue WORKING» —lo estará,
     * hasta que se muera— sino por qué la sección está bloqueada y cuántas
     * veces se le ha pedido parar. Ver `heldReason`.
     */
    const held = heldReason(live, now);
    const word = held ?? (a ? stateWord(a) : live.status === 'launching' ? 'STARTING' : 'NO TILE YET');
    agentRow.classList.toggle('is-stopping', held !== null);
    stopBtn.disabled = held !== null;
    stopBtn.textContent = held !== null ? 'STOPPING…' : 'STOP';
    // `stateVar` ya devuelve `var(--st-…)`: envolverlo otra vez producía
    // `var(var(--st-blocked))`, que no es válido, y el punto y la lectura caían
    // al violeta de la sección — un revisor bloqueado habría pasado por sano.
    agentRow.style.setProperty('--st', a ? stateVar(a) : 'var(--auto-dim)');
    goBtn.textContent = name;
    goBtn.disabled = !a;
    goBtn.title = a ? `fly to ${name} and open it` : 'the session has not appeared yet';
    const spent = a ? ceilingTokens(a.metrics) : 0;
    const cap = live.budgetTokens ?? state?.budgetTokens ?? 0;
    // Cuánto lleva, cuánto ha gastado y de cuánto: el gasto de una revisión no
    // puede ser algo que se descubra después.
    agentMeta.textContent = held !== null
      ? `${word} · ${tok(live.tokens ?? spent)}${cap ? `/${tok(cap)}` : ''}`
      : `${word} · ${ago(live.at, now)} IN${cap ? ` · ${tok(spent)}/${tok(cap)}` : spent ? ` · ${tok(spent)}` : ''}`;
    agentMeta.title = `review ${live.id} · ${live.reason.toLowerCase()} · expires ${Math.round(REVIEW_MAX_MS / 60_000)}m after launch`;
  }

/**
 * Cómo acabó una revisión, en dos palabras.
 *
 * `reported` es el único final que cuenta como revisión hecha, y lleva las
 * cifras. Todos los demás dicen lo que pasó de verdad: un agente que terminó
 * sin archivar nada no propuso nada, y llamarlo «completada» sería la clase de
 * resultado falso que hace inútil un panel que corre solo.
 */
  /** Tokens como los lee una persona: 128K, 1.4M. */
  function tok(n: number): string {
    return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n);
  }

  /* ── con qué nace el próximo revisor ────────────────────────────── */

  /**
   * El catálogo de la máquina donde correrá el revisor.
   *
   * Se pide a esa máquina y no a un agente: cuando se elige el modelo todavía
   * no hay agente que preguntar, y la máquina puede no tener ninguna sesión
   * viva. Es el mismo `providerModels()` que usa el traspaso de proveedor —los
   * alias de Claude Code y el caché de Codex—, cada uno diciendo si su CLI
   * está instalado aquí.
   *
   * Se lee una vez por máquina y se recuerda: es un catálogo local, no cambia
   * mientras el operador mira un panel, y pedirlo en cada repintado sería un
   * comando por fotograma.
   */
  let catalog: ProviderModel[] = [];
  let catalogFor: string | null = null;
  let catalogError = '';
  let runtimePick: PickHandle | undefined;
  let modelPick: PickHandle | undefined;
  let pickSig = '';

  function loadCatalog(): void {
    const machineId = store.improveMachine;
    if (!machineId || catalogFor === machineId) return;
    catalogFor = machineId;
    void hub.models(machineId)
      .then((list) => { catalog = list; catalogError = ''; })
      .catch((err: unknown) => {
        catalogError = err instanceof Error ? err.message : String(err);
        // Que se pueda reintentar: la máquina puede estar reconectando.
        catalogFor = null;
      })
      .finally(() => paintChoice());
  }

  /**
   * Los dos selectores y la línea que dice qué va a pasar de verdad.
   *
   * «Heredado» es una opción con nombre y no una casilla vacía: sin ella, el
   * operador que no ha elegido nada ve un hueco y tiene que adivinar si eso
   * significa «ninguno» o «el de siempre». La línea de abajo lo remata diciendo
   * el valor resuelto y de dónde sale.
   */
  function paintChoice(): void {
    const state = store.improve;
    const choice = store.improveChoice;
    if (!state) return;
    loadCatalog();

    const runtimes: string[] = [...new Set(catalog.map((m) => m.runtime as string))];
    const installed = new Set<string>(catalog.filter((m) => m.installed).map((m) => m.runtime as string));
    const wantRuntime = state.runtime ?? '';
    const forRuntime = catalog.filter((m) => m.runtime === (state.runtime ?? choice?.runtime ?? 'claude'));

    const sig = JSON.stringify([wantRuntime, state.model ?? '', catalog.map((m) => [m.runtime, m.id, m.installed]), catalogError]);
    if (sig !== pickSig && !runtimePick?.isOpen() && !modelPick?.isOpen()) {
      pickSig = sig;
      runtimePick?.dispose();
      modelPick?.dispose();
      runtimeHost.replaceChildren();
      modelHost.replaceChildren();

      runtimePick = pick({
        name: 'improve-runtime',
        value: wantRuntime,
        options: [
          { value: '', label: `INHERIT · ${choice?.runtime ?? 'claude'}` },
          ...(runtimes.length ? runtimes : ['claude']).map((r) => ({
            value: r,
            label: installed.has(r) ? r.toUpperCase() : `${r.toUpperCase()} · NOT INSTALLED HERE`,
            // No se desactiva: el catálogo es de una máquina y puede cambiar
            // entre elegir y lanzar. Se dice, y el spawn falla con el mensaje
            // del CLI si de verdad no está.
          })),
        ],
        // Sólo el runtime. Cambiar de CLI invalida el modelo —un alias de
        // Claude no existe en Codex— pero de eso se encarga `setConfig` en el
        // hub, que es quien sabe cuál es el runtime EFECTIVO cuando se hereda.
        // Mandarlo también desde aquí duplicaría la regla en dos sitios y sólo
        // uno de los dos manda.
        onChange: (v) => act(() => hub.improveConfig({ runtime: v || null })),
      });
      runtimeHost.appendChild(runtimePick.el);

      modelPick = pick({
        name: 'improve-model',
        value: state.model ?? '',
        search: forRuntime.length > 6,
        options: [
          { value: '', label: choice?.model ? `INHERIT · ${choice.model}` : 'INHERIT · THE CLI DECIDES' },
          ...forRuntime.map((m) => ({ value: m.id, label: m.installed ? m.label : `${m.label} · NOT INSTALLED HERE` })),
        ],
        onChange: (v) => act(() => hub.improveConfig({ model: v || null })),
      });
      modelHost.appendChild(modelPick.el);
    }

    /*
     * Lo que va a pasar, en una línea.
     *
     * Dice las tres cosas que un operador necesita para decidir si el número
     * del presupuesto es el adecuado: qué se cuenta (entrada, salida y
     * escritura de caché; la LECTURA de caché no, que es la mayor parte de una
     * revisión que lee código y cuesta una décima — ver shared/tokens.ts), y
     * que el techo es un FRENO y no un muro, así que un rebase es posible.
     */
    const cap = state.budgetTokens;
    /*
     * Lo elegido manda sobre lo que el hub resolvió la última vez.
     *
     * `improveChoice` viene de un empujón y puede tener un instante de retraso
     * respecto a lo que el operador acaba de guardar; el estado ya lo tiene. Y
     * mientras el runtime elegido no coincida con el que el hub resolvió, no se
     * hereda modelo: el del entorno es el de SU CLI, no uno universal.
     */
    const effRuntime = state.runtime ?? choice?.runtime ?? '—';
    const effModel = state.model ?? (state.runtime && state.runtime !== choice?.runtime ? null : choice?.model ?? null);
    effectiveEl.textContent = catalogError
      ? `COULD NOT READ THE MODEL CATALOGUE · ${catalogError}`
      : `NEXT REVIEWER · ${effRuntime}${effModel ? `/${effModel}` : ' · CLI DEFAULT MODEL'}`
        + ` · ${tok(cap)} TOKENS = INPUT + OUTPUT + CACHE WRITES · CACHE READS NOT COUNTED`
        + ' · A BRAKE, NOT A HARD CEILING: IT CAN OVERSHOOT BEFORE ORCA SEES IT';
    effectiveEl.title = choice
      ? `runtime from the ${choice.from.runtime}, model from the ${choice.from.model}`
      : '';
    el.classList.toggle('is-catalog-error', !!catalogError);
  }

  function paintStatus(state: ImproveState | null): void {
    /*
     * Tres cosas malas, y ninguna se calla: no se pudo traer el tablero, el
     * enlace está caído (lo que hay puede estar viejo), o el hub no puede
     * guardar. Un panel que no dice cuál de las tres es le pide al operador
     * que recargue para averiguarlo.
     */
    el.classList.toggle('is-offline', !store.linkUp);
    if (!state) {
      runBtn.disabled = true;
      pauseBtn.disabled = true;
      whenEl.textContent = boardError
        ? (store.linkUp ? 'COULD NOT READ THE BOARD' : 'NO LINK TO THE HUB')
        : 'ASKING THE HUB…';
      whenEl.title = boardError ?? '';
      return;
    }
    runBtn.disabled = false;
    pauseBtn.disabled = false;
    const verdict = store.improveVerdict;
    const cfg = state.config;
    el.classList.toggle('is-paused', cfg.paused);
    pauseBtn.textContent = cfg.paused ? 'RESUME' : 'PAUSE';
    pauseBtn.classList.toggle('is-on', cfg.paused);

    // La ÚLTIMA CERRADA, no la primera de la lista: la que está en vuelo tiene
    // su propia fila justo debajo, con su estado y su gasto, y repetirla aquí
    // como «LAST 7M · RUNNING» sólo gasta la línea.
    const last = state.reviews.find((r) => r.endedAt !== undefined);
    // Que el hub no pueda guardar gana a cualquier otra cosa que decir aquí:
    // el operador está tomando decisiones que se van a perder.
    if (state.degraded) {
      el.classList.add('is-degraded');
      whenEl.textContent = 'NOT SAVING · DECISIONS WILL BE LOST ON RESTART';
      whenEl.title = state.degraded;
      runBtn.disabled = !!activeReview(state, Date.now());
      return;
    }
    el.classList.remove('is-degraded');
    // Con el enlace caído lo que se enseña es lo último que se supo, y se dice:
    // un veredicto de hace diez minutos presentado como actual es una mentira
    // pequeña que hace tomar una decisión mala.
    if (!store.linkUp) {
      whenEl.textContent = 'NO LINK · SHOWING THE LAST BOARD';
      whenEl.title = boardError ?? 'the console is not talking to the hub right now';
      runBtn.disabled = true;
      return;
    }
    const head = verdict?.reason ?? (cfg.paused ? 'PAUSED BY THE OPERATOR' : '');
    // La última revisión se resume por cómo ACABÓ, no por si ocurrió: una que
    // terminó sin archivar nada no es una revisión hecha, y decir «(0+0)» sin
    // más dejaría al operador creyendo que no había nada que proponer.
    whenEl.textContent = last ? `${head} · LAST ${ago(last.at)} ${outcome(last)}` : head || 'NO REVIEW YET';
    whenEl.title = last
      ? `last review ${last.trigger} · ${last.reason.toLowerCase()} · ${last.status}`
        + `${last.callsign ? ` · ${last.callsign}` : ''} · ${last.filed} new, ${last.merged} merged`
        + `${last.note ? ` · ${last.note}` : ''}`
      : 'no review has run yet';

    el.querySelector<HTMLElement>('[data-every]')!.textContent = hours(cfg.everyMin);
    el.querySelector<HTMLElement>('[data-perday]')!.textContent = String(cfg.perDay);
    el.querySelector<HTMLElement>('[data-signal]')!.textContent = String(cfg.minSignal);
    el.querySelector<HTMLElement>('[data-budget]')!.textContent = tok(state.budgetTokens);
    paintChoice();
    runBtn.disabled = !!activeReview(state, Date.now());
  }

  function render(): void {
    const state = store.improve;
    const now = Date.now();
    paintStatus(state);
    paintAgent(state, now);

    if (!state) {
      countEl.textContent = '—';
      // «No ha llegado» y «no hay nada» son dos pantallas distintas, y
      // confundirlas es lo que dejó la sección diciendo «ASKING THE HUB…»
      // mientras el operador creía que no había propuestas.
      list.innerHTML = boardError
        ? `<p class="improve__empty">${store.linkUp
          ? 'THE HUB DID NOT ANSWER FOR THE BOARD'
          : 'NO LINK TO THE HUB · NOTHING TO SHOW YET'} · ${esc(boardError)}</p>`
          + `<button class="improve__more" type="button" data-retry>TRY AGAIN</button>`
        : `<p class="improve__empty">ASKING THE HUB FOR THE BOARD…</p>`;
      list.querySelector('[data-retry]')?.addEventListener('click', (e) => {
        (e.currentTarget as HTMLElement).blur();
        attempt = 0;
        askBoard();
      });
      return;
    }

    const open = openProposals(state, now);
    // Una archivada se fue con su misión: no está en el panel de misiones y
    // tampoco aquí, que es lo que evita dos tableros con dos versiones del
    // mismo trabajo. Sigue en el estado, y `list_improvements` la enseña si se
    // le pide por su nombre.
    const closed = sortProposals(
      Object.values(state.proposals).filter((p) => { const s = effectiveStatus(p, now); return s !== 'open' && s !== 'archived'; }), now,
    );
    const unseen = open.filter((p) => p.seenAt === undefined);
    countEl.textContent = unseen.length ? `${unseen.length} NEW` : String(open.length);
    countEl.title = unseen.length ? 'click to mark them read' : 'open proposals';
    el.classList.toggle('has-new', unseen.length > 0);

    const shown = showMore ? [...open, ...closed] : [...open, ...closed.slice(0, CLOSED_SHOWN)];
    if (!shown.length) {
      list.innerHTML = state.reviews.length
        ? `<p class="improve__empty">NOTHING ON THE BOARD · THE LAST REVIEW FOUND NOTHING WORTH YOUR TIME</p>`
        : `<p class="improve__empty">NO REVIEW HAS RUN YET · ORCA WILL LOOK AT ITSELF WHEN THERE IS ENOUGH TO LOOK AT, OR PRESS REVIEW NOW</p>`;
      return;
    }

    const fresh: HTMLElement[] = [];
    list.innerHTML = '';
    for (const p of shown) {
      const status = effectiveStatus(p, now);
      const card = document.createElement('article');
      // `is-mission` es la marca de «convertida en misión» y la lleva mientras
      // haya enlace, esté la misión en marcha o terminada: el color no cambia
      // con el estado, sólo la palabra de la fila.
      card.className = `imp is-${status} is-${p.kind}${p.missionId ? ' is-mission' : ''}`;
      card.dataset.imp = p.id;
      card.classList.toggle('is-new', p.seenAt === undefined && status === 'open');
      card.classList.toggle('is-open', opened.has(p.id));
      card.innerHTML = rowHtml(p, status, opened.has(p.id), now);
      list.appendChild(card);
      if (!announced.has(p.id)) fresh.push(card);
    }

    /*
     * El barrido de entrada: una vez, cuando el tablero se enseña por primera
     * vez y hay quien lo mire.
     *
     * No es la onda del panel de misiones —esa es la alineación de la flota— y
     * no puede serlo: dos paneles con el mismo gesto se leen como el mismo
     * panel. Aquí las filas se descubren de izquierda a derecha en el compás
     * del comp, y se acabó (`algnRowSweep`). Detrás de la cortina del boot o
     * con el panel plegado no se juega: se jugaría donde nadie lo ve, y
     * entonces no se jugaría nunca donde sí.
     */
    if (!swept && !folded && !REDUCE.value && !store.booting) {
      swept = true;
      for (const [i, card] of [...list.querySelectorAll<HTMLElement>('.imp')].entries()) {
        algnRowSweep(card, i, false);
      }
    }

    if (closed.length > CLOSED_SHOWN && !showMore) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'improve__more';
      more.textContent = `…AND ${closed.length - CLOSED_SHOWN} MORE`;
      more.addEventListener('click', () => { showMore = true; more.blur(); render(); });
      list.appendChild(more);
    } else if (showMore && closed.length > CLOSED_SHOWN) {
      const less = document.createElement('button');
      less.type = 'button';
      less.className = 'improve__more';
      less.textContent = 'FOLD THE CLOSED ONES';
      less.addEventListener('click', () => { showMore = false; less.blur(); render(); });
      list.appendChild(less);
    }

    announce(shown.map((p) => p.id), fresh, unseen.length);
  }

  /**
   * El aviso, una vez por propuesta.
   *
   * La primera carga no es noticia —abrir la consola no es que haya pasado
   * algo—, así que sólo se marca. Después, lo que llega entra con el gesto de
   * llegada de una ventana (`back.out(2)` a 0.22s, el mismo de todo el
   * console) y la sección da UN paso lateral. No hay latido, no hay repetición
   * y nada se abre solo.
   */
  function announce(all: string[], fresh: HTMLElement[], unseen: number): void {
    const news = settled && fresh.length > 0;
    for (const id of all) announced.add(id);
    if (!news) return;
    if (unseen > 0) getSound()?.play('artifact');
    if (REDUCE.value) return;
    for (const [i, card] of fresh.entries()) {
      gsap.fromTo(card, { autoAlpha: 0, x: 12 }, { autoAlpha: 1, x: 0, duration: 0.22, ease: 'back.out(2)', delay: i * 0.05 });
    }
    gsap.fromTo(el, { x: 8 }, { x: 0, duration: 0.3, ease: 'power2.out' });
  }

  function reveal(): void {
    const was = folded;
    folded = false;
    setPref('improveFolded', false);
    setFolded(false, was);
    if (!REDUCE.value) gsap.fromTo(el, { x: 10 }, { x: 0, duration: 0.24, ease: 'back.out(2)' });
  }

  const off = store.on((e) => {
    /*
     * El enlace volvió: se vuelve a pedir el tablero. Un hub reiniciado no
     * empuja nada por su cuenta, así que sin esto la consola se quedaría con
     * lo de antes de la caída — o con nada, si nunca llegó.
     */
    if (e.k === 'link') {
      if (e.up) { attempt = 0; askBoard(); } else { window.clearTimeout(retryTimer); render(); }
      return;
    }
    if (e.k === 'improve') { render(); settled = true; }
    // El veredicto depende de si CAPCOM está vivo y en mitad de un turno, y eso
    // lo sabe el mundo antes que nadie: sin esto la línea diría «NO CAPCOM»
    // hasta la siguiente revisión.
    // El estado del revisor y su gasto se mueven con la flota, no con el
    // tablero: sin esto la fila diría «STARTING» hasta la siguiente revisión.
    else if (e.k === 'world' || e.k === 'agents') { paintStatus(store.improve); paintAgent(store.improve, Date.now()); }
  });
  const tick = window.setInterval(() => { if (!el.classList.contains('is-folded')) render(); }, AGO_TICK_MS);

  /* ── traer el tablero ───────────────────────────────────────────── */

  /**
   * Pedir el tablero, y volver a pedirlo.
   *
   * Antes esto era UNA llamada al montar con el `catch` vacío, esperando a que
   * un push lo arreglara. No lo arreglaba: el hub sólo empuja cuando el
   * tablero CAMBIA, así que una petición perdida —el hub reiniciándose, el
   * handshake todavía sin terminar— dejaba la sección en «ASKING THE HUB…»
   * para siempre. Ocurrió de verdad el 2026-09-08.
   *
   * Tres arreglos, y el importante es el primero:
   *
   *  1. **Se pide al conectar y en cada reconexión**, no sólo al montar. Es
   *     además lo correcto por sí mismo: un hub que se reinicia no empuja
   *     nada, y sin volver a preguntar la consola enseñaría un tablero viejo.
   *  2. **Reintento acotado con espera creciente** mientras el enlace está
   *     arriba. Con el enlace caído no se gasta ni un intento: se espera al
   *     evento, que es información y no una conjetura.
   *  3. **Un botón**, porque un panel que falla y no deja intentarlo obliga a
   *     recargar la consola entera.
   *
   * Lo que se sabía NO se borra: un fallo de red no vacía el tablero, sólo
   * añade una línea que dice que puede estar viejo.
   */
  const RETRY_MS = [700, 1_500, 3_000, 6_000, 12_000];
  let asking = false;
  let attempt = 0;
  let retryTimer = 0;
  /** Lo último que falló, o null. Se enseña; no se traga. */
  let boardError: string | null = null;

  function askBoard(): void {
    if (asking) return;
    asking = true;
    window.clearTimeout(retryTimer);
    void hub.improve()
      .then((wire) => {
        store.putImprove(wire.state, wire.verdict, { choice: wire.choice, machineId: wire.machineId });
        settled = true;
        attempt = 0;
        boardError = null;
      })
      .catch((err: unknown) => {
        boardError = err instanceof Error ? err.message : String(err);
        // Sólo se reintenta con enlace: sin él, el evento de reconexión es
        // quien vuelve a pedirlo, y gastar intentos a ciegas sólo agota los
        // que harán falta cuando el hub conteste.
        if (store.linkUp && attempt < RETRY_MS.length) {
          const wait = RETRY_MS[attempt++]!;
          retryTimer = window.setTimeout(askBoard, wait);
        }
      })
      .finally(() => { asking = false; render(); });
  }

  render();
  askBoard();

  return {
    el, render, reveal,
    dispose() {
      off();
      window.clearInterval(tick);
      window.clearTimeout(retryTimer);
      runtimePick?.dispose();
      modelPick?.dispose();
      el.remove();
    },
  };
}
