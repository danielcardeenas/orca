/**
 * CEO panel — el único punto de contacto entre el humano y la flota.
 *
 * Todo lo que el operador quiere pedir pasa por aquí: no hay una consola de
 * comandos paralela. El panel es un instrumento de conversación, no un chat de
 * producto — por eso el texto legible por máquina va en 'Geist Mono' y las
 * etiquetas en Tiny5.
 *
 * Dos decisiones que no se ven en el markup:
 *  - No hacemos eco optimista del mensaje humano. El hub es la única fuente de
 *    verdad de `ceo.messages`; un eco local se duplicaría al volver con otro id.
 *  - Reconciliamos por id de mensaje con una firma barata. Un stream de tokens
 *    emite un evento 'ceo' por delta: repintar la lista entera en cada uno
 *    tiraría el scroll y la selección del operador cientos de veces por turno.
 */

import type { Agent, CeoAction, CeoMessage } from '../../shared/types.ts';
import { LIVE_STATES } from '../../shared/types.ts';
import { store } from '../store.ts';
import { hub } from '../net/client.ts';

/** 5 líneas de 'Geist Mono' a 11px/1.35 más el padding vertical del campo. */
const MAX_COMPOSER_PX = 5 * 15 + 12;
/** Cuántas acciones se ven antes de plegar el resto. */
const ACTIONS_VISIBLE = 3;
/** Margen en px por debajo del cual consideramos que el log está "al fondo". */
const STICK_SLOP = 28;

interface Row {
  el: HTMLElement;
  body: HTMLElement;
  acts: HTMLElement | null;
  sig: string;
}

export interface CeoHandle {
  destroy(): void;
}

export function mountCeo(el: HTMLElement): CeoHandle {
  el.innerHTML = `
    <section class="ceo">
      <header class="ceo__head">
        <span class="px px--sm ceo__title">CEO</span>
        <span class="status" data-status>IDLE</span>
        <span class="ceo__count" data-count></span>
      </header>

      <div class="ceo__log scroll" data-log role="log" aria-live="polite" aria-label="CEO conversation"></div>
      <div class="ceo__blank" data-blank>
        <p class="px px--tiny">NO ORDERS YET</p>
        <p class="ceo__blankbody mono">The CEO commands the fleet on your behalf. It surveys, spawns agents, unblocks them, and absorbs the questions they raise so you only see the ones that need you.</p>
        <div class="ceo__seeds" data-seeds>
          <button type="button" class="ceo__seed" data-seed="What is every agent doing right now?"><span class="px px--tiny">FLEET STATUS</span></button>
          <button type="button" class="ceo__seed" data-seed="Which agents are stuck, and what do they need from me?"><span class="px px--tiny">WHAT NEEDS ME</span></button>
          <button type="button" class="ceo__seed" data-seed="Where is the spend going today?"><span class="px px--tiny">SPEND</span></button>
        </div>
      </div>

      <form class="ceo__composer" data-composer>
        <textarea class="ceo__ta mono" data-input rows="1" spellcheck="false"
                  aria-label="Message the CEO"></textarea>
        <button type="submit" class="slab ceo__send" data-send aria-label="Send message to CEO">
          <span class="px px--sm">SEND</span>
        </button>
      </form>
    </section>
  `;

  const $ = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const statusEl = $('[data-status]');
  const countEl = $('[data-count]');
  const logEl = $('[data-log]');
  const formEl = $<HTMLFormElement>('[data-composer]');
  const inputEl = $<HTMLTextAreaElement>('[data-input]');
  const sendEl = $<HTMLButtonElement>('[data-send]');
  const blankEl = $('[data-blank]');

  // Los arranques rellenan el composer en vez de enviar directo: el operador
  // debe poder editar la pregunta antes de gastar un turno del CEO.
  blankEl.addEventListener('click', (ev) => {
    const seed = (ev.target as HTMLElement).closest<HTMLElement>('[data-seed]');
    if (!seed) return;
    inputEl.value = seed.dataset.seed ?? '';
    inputEl.focus();
    inputEl.dispatchEvent(new Event('input'));
  });

  /** Filas vivas por id de mensaje. La reconciliación se apoya en este mapa. */
  const rows = new Map<string, Row>();
  /** Qué grupos de acciones dejó desplegados el humano. Sobrevive a repintados. */
  const expanded = new Set<string>();
  /** El indicador de "pensando" es un nodo suelto que vive al final del log. */
  const thinkEl = document.createElement('div');
  thinkEl.className = 'think';
  thinkEl.innerHTML = '<i></i><i></i><i></i>';
  thinkEl.setAttribute('aria-label', 'CEO is thinking');

  /* ── Log ────────────────────────────────────────────────────────── */

  function atBottom(): boolean {
    // scrollHeight es 0 en un DOM sin layout; ahí siempre pegamos al fondo.
    if (!logEl.scrollHeight) return true;
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < STICK_SLOP;
  }

  function paintLog() {
    // Se lee ANTES de tocar el DOM: si el humano subió a releer algo, no le
    // robamos el scroll cuando entra un token nuevo.
    const stick = atBottom();
    const msgs = store.world.ceo.messages;
    const seen = new Set<string>();

    let prev: HTMLElement | null = null;
    for (const m of msgs) {
      seen.add(m.id);
      let row = rows.get(m.id);
      const sig = signature(m);
      if (!row) {
        row = buildRow(m);
        rows.set(m.id, row);
      } else if (row.sig !== sig) {
        updateRow(row, m);
      }
      row.sig = sig;
      // Orden: sólo movemos el nodo si no está ya donde toca.
      const want: ChildNode | null = prev ? prev.nextSibling : logEl.firstChild;
      if (row.el !== want) logEl.insertBefore(row.el, want);
      prev = row.el;
    }

    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      row.el.remove();
      rows.delete(id);
      expanded.delete(id);
    }

    paintThinking();
    if (stick) logEl.scrollTop = logEl.scrollHeight;
    const blank = store.world.ceo.messages.length === 0;
    if (blankEl.hidden === blank) blankEl.hidden = !blank;
  }

  /** El indicador va al final; se retira en cuanto hay texto que leer. */
  function paintThinking() {
    const ceo = store.world.ceo;
    const last = ceo.messages[ceo.messages.length - 1];
    const alreadyTalking = !!last && last.role === 'ceo' && last.streaming === true && last.text.length > 0;
    const want = ceo.thinking && !alreadyTalking;
    if (want) {
      if (thinkEl.parentNode !== logEl || logEl.lastChild !== thinkEl) logEl.appendChild(thinkEl);
    } else if (thinkEl.parentNode) {
      thinkEl.remove();
    }
  }

  /**
   * Firma barata de un mensaje. Sólo cambia cuando cambia algo pintable, así un
   * evento 'ceo' que no toca este mensaje no lo repinta.
   */
  function signature(m: CeoMessage): string {
    const acts = m.actions.map((a) => `${a.id}:${a.status}:${a.summary.length}`).join('|');
    return `${m.role}~${m.text.length}~${m.streaming ? 1 : 0}~${m.escalationId ?? ''}~${acts}`;
  }

  function buildRow(m: CeoMessage): Row {
    const el = document.createElement('div');
    el.className = `msg msg--${m.role}`;
    el.dataset.mid = m.id;

    // Un mensaje del CEO puede ser el relevo de una pregunta de un agente: eso
    // deja de ser "el CEO opinando" y pasa a ser "alguien espera un humano".
    const relay = document.createElement('div');
    relay.className = 'msg__relay px px--tiny';
    el.appendChild(relay);

    const body = document.createElement('div');
    body.className = m.role === 'system' ? 'msg__body px px--tiny' : 'msg__body mono';
    el.appendChild(body);

    const acts = m.role === 'system' ? null : document.createElement('div');
    if (acts) {
      acts.className = 'acts';
      el.appendChild(acts);
    }

    const row: Row = { el, body, acts, sig: '' };
    updateRow(row, m);
    return row;
  }

  function updateRow(row: Row, m: CeoMessage) {
    const relayEl = row.el.querySelector<HTMLElement>('.msg__relay')!;
    const relayed = m.role === 'ceo' && !!m.escalationId;
    row.el.classList.toggle('is-relay', relayed);
    if (relayed) {
      relayEl.textContent = `RELAYED FROM ${callsignFor(m.escalationId!)}`;
      relayEl.hidden = false;
    } else {
      relayEl.textContent = '';
      relayEl.hidden = true;
    }

    // textContent, nunca innerHTML: este texto viene de agentes y de la red.
    row.body.textContent = m.text;
    row.el.classList.toggle('is-streaming', m.streaming === true);
    if (m.streaming) {
      const caret = document.createElement('i');
      caret.className = 'msg__caret';
      row.body.appendChild(caret);
    }

    if (row.acts) paintActions(row.acts, m);
  }

  function paintActions(host: HTMLElement, m: CeoMessage) {
    host.textContent = '';
    const list = m.actions;
    if (!list.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const open = expanded.has(m.id);
    const shown = open ? list : list.slice(0, ACTIONS_VISIBLE);
    for (const a of shown) host.appendChild(actionRow(a));

    if (list.length > ACTIONS_VISIBLE) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'acts__more px px--tiny';
      more.textContent = open ? '— COLLAPSE' : `+ ${list.length - ACTIONS_VISIBLE} MORE`;
      more.addEventListener('click', () => {
        if (open) expanded.delete(m.id); else expanded.add(m.id);
        paintActions(host, m);
      });
      host.appendChild(more);
    }
  }

  function actionRow(a: CeoAction): HTMLElement {
    const el = document.createElement('div');
    el.className = 'act';
    el.dataset.st = a.status;

    const led = document.createElement('i');
    led.className = 'act__led';
    el.appendChild(led);

    const name = document.createElement('span');
    name.className = 'act__name px px--tiny';
    name.textContent = a.name;
    el.appendChild(name);

    const sum = document.createElement('span');
    sum.className = 'act__sum mono';
    sum.textContent = a.summary;
    el.appendChild(sum);

    if (a.detail) el.title = a.detail;
    return el;
  }

  function callsignFor(escalationId: string): string {
    const esc = store.world.escalations[escalationId];
    const agent: Agent | undefined = esc ? store.world.agents[esc.agentId] : undefined;
    return agent?.callsign ?? 'AGENT';
  }

  /* ── Cabecera ───────────────────────────────────────────────────── */

  function paintHead() {
    const ceo = store.world.ceo;
    const last = ceo.messages[ceo.messages.length - 1];
    const acting = !!last && last.actions.some((a) => a.status === 'running');
    const label = acting ? 'ACTING' : ceo.thinking ? 'THINKING' : 'IDLE';
    if (statusEl.textContent !== label) statusEl.textContent = label;
    // Lima sólo cuando de verdad está ejecutando algo; ámbar cuando espera al humano.
    statusEl.classList.toggle('is-on', acting);
    statusEl.classList.toggle('is-alert', !acting && ceo.awaitingHuman);

    let live = 0;
    let blocked = 0;
    for (const a of Object.values(store.world.agents)) {
      if (LIVE_STATES.has(a.state)) live++;
      if (a.state === 'blocked') blocked++;
    }
    const txt = `${live} UNDER COMMAND${blocked ? ` · ${blocked} BLOCKED` : ''}`;
    if (countEl.textContent !== txt) countEl.textContent = txt;
    countEl.className = `ceo__count px px--tiny${blocked ? ' has-block' : ''}`;
  }

  /* ── Composer ───────────────────────────────────────────────────── */

  function paintLink() {
    const up = store.linkUp;
    inputEl.disabled = !up;
    sendEl.disabled = !up;
    sendEl.classList.toggle('is-off', !up);
    inputEl.placeholder = up
      ? 'message the ceo · enter sends, shift+enter newline'
      : 'link down · reconnecting, cannot reach the ceo';
  }

  /** Crece hasta 5 líneas y luego scrollea; el composer nunca come el log. */
  function autosize() {
    inputEl.style.height = 'auto';
    const h = inputEl.scrollHeight;
    if (h) inputEl.style.height = Math.min(h, MAX_COMPOSER_PX) + 'px';
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text || !store.linkUp) return;
    hub.say(text);
    inputEl.value = '';
    autosize();
    // Al enviar volvemos al fondo: el humano acaba de hablar, quiere la respuesta.
    logEl.scrollTop = logEl.scrollHeight;
  }

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    send();
  };
  const onSubmit = (e: Event) => { e.preventDefault(); send(); };
  const onInput = () => autosize();

  inputEl.addEventListener('keydown', onKeydown);
  inputEl.addEventListener('input', onInput);
  formEl.addEventListener('submit', onSubmit);

  /* ── Suscripción ────────────────────────────────────────────────── */

  const off = store.on((e) => {
    switch (e.k) {
      case 'ceo':
        paintHead();
        paintLog();
        break;
      case 'world':
        paintHead();
        paintLog();
        break;
      case 'agents':
        paintHead();
        break;
      case 'escalations':
        // Cambia el callsign que muestra una etiqueta RELAYED FROM.
        paintLog();
        break;
      case 'link':
        paintLink();
        break;
    }
  });

  paintLink();
  paintHead();
  paintLog();
  autosize();

  return {
    destroy() {
      off();
      inputEl.removeEventListener('keydown', onKeydown);
      inputEl.removeEventListener('input', onInput);
      formEl.removeEventListener('submit', onSubmit);
      rows.clear();
      el.textContent = '';
    },
  };
}
