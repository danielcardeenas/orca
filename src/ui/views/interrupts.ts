/**
 * The interrupt queue — agents asking the human for something.
 *
 * This is the reason the console exists. An agent that needs a decision is the
 * only thing in ORCA allowed to demand attention, so this panel gets the one
 * loud colour (amber) and, when a blocking question has waited too long, the
 * comp's full-field breach treatment.
 *
 * The flow behind each card:
 *   agent asks -> CEO tries to answer from project memory -> if it cannot, the
 *   question lands here. Answering with "remember" means the CEO can field the
 *   same question itself next time, so the queue gets quieter with use.
 */

import gsap from 'gsap';
import type { Agent, Escalation } from '../../shared/types.ts';
import { leave, sweepLeaving } from '../leave.ts';
import { store } from '../store.ts';
import { hub } from '../net/client.ts';

/**
 * A blocking question unanswered this long escalates to the full-field alarm.
 *
 * Overridable with `?breachAfter=<ms>` so the visual harness can photograph the
 * alarm without waiting a minute and a half. It is a timing knob, not a way to
 * fake the state: the question still has to be real, blocking, and unanswered.
 */
const BREACH_AFTER_MS = (() => {
  const v = Number(new URL(location.href).searchParams.get('breachAfter'));
  return Number.isFinite(v) && v > 0 ? v : 90_000;
})();

export function mountInterrupts(el: HTMLElement) {
  el.innerHTML = `
    <div class="ints">
      <header class="ints__head">
        <p class="px px--tiny">INTERRUPTS</p>
        <span class="status" data-count>0</span>
      </header>
      <div class="ints__list scroll" data-list>
        <div data-questions></div>
        <p class="ints__label px px--tiny" data-blocked-label hidden>WAITING ON YOU</p>
        <div data-blocked></div>
      </div>
      <p class="ints__quiet px px--tiny" data-quiet>NOTHING NEEDS YOU</p>
    </div>
  `;

  const list = el.querySelector<HTMLElement>('[data-questions]')!;
  const blockedEl = el.querySelector<HTMLElement>('[data-blocked]')!;
  const blockedLabel = el.querySelector<HTMLElement>('[data-blocked-label]')!;
  const countEl = el.querySelector<HTMLElement>('[data-count]')!;
  const quietEl = el.querySelector<HTMLElement>('[data-quiet]')!;
  const nodes = new Map<string, HTMLElement>();
  const blockedNodes = new Map<string, HTMLElement>();

  const breach = mountBreach();

  function paint() {
    const pending = store.pending();
    const seen = new Set<string>();

    sweepLeaving(list);
    sweepLeaving(blockedEl);

    for (const e of pending) {
      seen.add(e.id);
      let node = nodes.get(e.id);
      const fresh = !node;
      if (!node) {
        node = build(e);
        nodes.set(e.id, node);
      }
      update(node, e);
      list.appendChild(node);
      if (fresh) {
        gsap.fromTo(node,
          { autoAlpha: 0, y: -8, scale: 0.96 },
          { autoAlpha: 1, y: 0, scale: 1, duration: 0.26, ease: 'back.out(1.6)' });
      }
    }
    for (const [id, node] of nodes) {
      if (seen.has(id)) continue;
      nodes.delete(id);
      leave(node, {
        // Answered questions leave with a lime confirm wipe, as in the comp.
        before: (n) => {
          const wipe = document.createElement('i');
          wipe.className = 'int__confirm';
          n.appendChild(wipe);
          gsap.fromTo(wipe, { scaleX: 0 },
            { scaleX: 1, duration: 0.28, ease: 'power2.inOut', transformOrigin: 'left center' });
        },
        to: { scale: 1, height: 0, marginBottom: 0, duration: 0.3, delay: 0.28 },
      });
    }

    // Un agente bloqueado esperando un permiso también te necesita, aunque no
    // haya hecho una pregunta. Sin esto el panel decía "nada te necesita" con
    // cuatro agentes parados, que es exactamente la mentira que este producto
    // existe para no contar.
    const waiting = store.blockedAgents()
      .filter((a) => !a.block?.escalationId);
    paintBlocked(waiting);

    const n = pending.length + waiting.length;
    countEl.textContent = String(n);
    countEl.classList.toggle('is-alert', n > 0);
    quietEl.hidden = n > 0;
    el.classList.toggle('has-work', n > 0);

    breach.evaluate(pending);
  }

  function paintBlocked(list: Agent[]) {
    const seen = new Set<string>();
    for (const a of list) {
      seen.add(a.id);
      let node = blockedNodes.get(a.id);
      const fresh = !node;
      if (!node) {
        node = buildBlocked(a);
        blockedNodes.set(a.id, node);
      }
      updateBlocked(node, a);
      blockedEl.appendChild(node);
      if (fresh) {
        gsap.fromTo(node, { autoAlpha: 0, y: -6 },
          { autoAlpha: 1, y: 0, duration: 0.22, ease: 'power2.out' });
      }
    }
    for (const [id, node] of blockedNodes) {
      if (seen.has(id)) continue;
      blockedNodes.delete(id);
      leave(node, { to: { scale: 1, height: 0, marginBottom: 0, duration: 0.2 } });
    }
    blockedLabel.hidden = list.length === 0;
  }

  function buildBlocked(a: Agent): HTMLElement {
    const node = document.createElement('article');
    node.className = 'int int--block';
    node.dataset.agentId = a.id;
    node.innerHTML = `
      <header class="int__head">
        <span class="int__call px"></span>
        <span class="int__proj px px--tiny"></span>
        <span class="int__spacer"></span>
        <span class="int__kind px px--tiny"></span>
        <span class="int__age px px--tiny"></span>
      </header>
      <p class="int__q mono"></p>
      <div class="int__opts" data-blockopts></div>
    `;
    node.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!b) {
        // Cualquier otro punto de la tarjeta abre el agente: el operador casi
        // siempre quiere ver qué pasó antes de decidir.
        window.dispatchEvent(new CustomEvent('orca:open-agent', { detail: { id: a.id } }));
        return;
      }
      if (b.dataset.act === 'open') {
        window.dispatchEvent(new CustomEvent('orca:open-agent', { detail: { id: a.id } }));
      }
    });
    return node;
  }

  function updateBlocked(node: HTMLElement, a: Agent) {
    const proj = store.world.projects[a.projectId];
    const set = (sel: string, text: string) => {
      const n = node.querySelector<HTMLElement>(sel);
      if (n && n.textContent !== text) n.textContent = text;
    };
    set('.int__call', a.callsign);
    set('.int__proj', proj?.code ?? '--');
    set('.int__kind', (a.block?.kind ?? '').toUpperCase());
    set('.int__q', a.block?.summary ?? 'waiting');

    const since = a.block?.since ?? a.updatedAt;
    const ms = Date.now() - since;
    set('.int__age', ms < 60_000 ? Math.floor(ms / 1000) + 'S'
      : ms < 3_600_000 ? Math.floor(ms / 60_000) + 'M'
        : Math.floor(ms / 3_600_000) + 'H');

    /*
     * Un prompt de permisos NO se puede contestar desde aquí: Claude Code
     * 2.1.260 no expone forma de responderlo desde fuera del proceso. Un botón
     * ALLOW que falla en silencio sería peor que no tenerlo, así que la consola
     * dice la verdad — dónde está ese agente y que hay que ir a su terminal.
     *
     * Cuando el CLI lo exponga, aquí vuelven los tres botones y `Command.permit`
     * ya está en el protocolo esperándolos.
     */
    const opts = node.querySelector<HTMLElement>('[data-blockopts]')!;
    const kind = a.block?.kind ?? 'input';
    if (opts.dataset.sig !== kind) {
      opts.dataset.sig = kind;
      opts.innerHTML = kind === 'permission'
        ? `<span class="int__note px px--tiny">ANSWER IN ITS TERMINAL</span>
           <button class="int__opt" type="button" data-act="open"><span class="px px--tiny">WHERE IS IT</span></button>`
        : `<button class="int__opt" type="button" data-act="open"><span class="px px--tiny">OPEN AGENT</span></button>`;
    }
  }

  function build(e: Escalation): HTMLElement {
    const node = document.createElement('article');
    node.className = 'int';
    node.dataset.escId = e.id;
    node.innerHTML = `
      <header class="int__head">
        <span class="int__call px"></span>
        <span class="int__proj px px--tiny"></span>
        <span class="int__spacer"></span>
        <span class="int__age px px--tiny"></span>
      </header>
      <p class="int__q mono"></p>
      <details class="int__ctx"><summary class="px px--tiny">CONTEXT</summary>
        <p class="int__ctxbody mono"></p></details>
      <div class="int__ceo" hidden>
        <p class="px px--tiny">CEO TRIED</p>
        <p class="int__ceobody mono"></p>
      </div>
      <div class="int__opts" data-opts></div>
      <div class="int__free">
        <input class="int__input mono" type="text" placeholder="type an answer" />
        <button class="int__send slab" type="button"><span class="px px--tiny">SEND</span></button>
      </div>
      <label class="int__remember">
        <input type="checkbox" data-remember />
        <span class="px px--tiny">REMEMBER - LET THE CEO ANSWER THIS NEXT TIME</span>
      </label>
    `;
    wire(node, e.id);
    return node;
  }

  function update(node: HTMLElement, e: Escalation) {
    const agent = store.world.agents[e.agentId];
    const proj = store.world.projects[e.projectId];
    const set = (sel: string, text: string) => {
      const n = node.querySelector<HTMLElement>(sel);
      if (n && n.textContent !== text) n.textContent = text;
    };

    node.dataset.urgency = e.urgency;
    set('.int__call', agent?.callsign ?? '--');
    set('.int__proj', proj?.code ?? '--');
    set('.int__q', e.question);

    const ctx = node.querySelector<HTMLDetailsElement>('.int__ctx')!;
    ctx.hidden = !e.context;
    if (e.context) set('.int__ctxbody', e.context);

    const ceo = node.querySelector<HTMLElement>('.int__ceo')!;
    ceo.hidden = !e.ceoAttempt;
    if (e.ceoAttempt) {
      set('.int__ceobody', `${e.ceoAttempt.answer} / punted: ${e.ceoAttempt.reason}`);
    }

    // One-tap options. These are how a question gets answered from a phone.
    const opts = node.querySelector<HTMLElement>('[data-opts]')!;
    const want = e.options.join(' ');
    if (opts.dataset.sig !== want) {
      opts.dataset.sig = want;
      opts.innerHTML = e.options
        .map((o) => `<button class="int__opt" type="button" data-answer="${escAttr(o)}">
            <span class="px px--tiny">${escHtml(o)}</span></button>`)
        .join('');
    }
    node.querySelector<HTMLElement>('.int__free')!.hidden = e.optionsOnly;

    tickAge(node, e);
  }

  function wire(node: HTMLElement, id: string) {
    const remember = () => {
      const cb = node.querySelector<HTMLInputElement>('[data-remember]');
      return cb?.checked ? 'auto' : null;
    };
    const input = node.querySelector<HTMLInputElement>('.int__input')!;

    function send() {
      const v = input.value.trim();
      if (!v) return;
      hub.answer(id, v, remember());
      input.value = '';
    }

    node.addEventListener('click', (ev) => {
      const opt = (ev.target as HTMLElement).closest<HTMLElement>('[data-answer]');
      if (opt) { hub.answer(id, opt.dataset.answer!, remember()); return; }
      if ((ev.target as HTMLElement).closest('.int__send')) send();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); send(); }
    });
  }

  /** Ages tick every second so "waiting 4m" stays honest without a repaint. */
  function tickAge(node: HTMLElement, e: Escalation) {
    const age = node.querySelector<HTMLElement>('.int__age')!;
    const ms = Date.now() - e.askedAt;
    const txt = ms < 60_000 ? Math.floor(ms / 1000) + 'S'
      : ms < 3_600_000 ? Math.floor(ms / 60_000) + 'M'
        : Math.floor(ms / 3_600_000) + 'H';
    if (age.textContent !== txt) age.textContent = txt;
  }

  setInterval(() => {
    for (const [id, node] of nodes) {
      const e = store.world.escalations[id];
      if (e) tickAge(node, e);
    }
    for (const [id, node] of blockedNodes) {
      const a = store.world.agents[id];
      if (a) updateBlocked(node, a);
    }
    breach.evaluate(store.pending());
  }, 1000);

  /**
   * El cajón de agente delega aquí: pulsar ANSWER en un agente bloqueado por
   * una pregunta debe llevar al humano a la tarjeta donde puede contestarla,
   * no a otro formulario paralelo. Una sola caja de respuesta por pregunta.
   */
  window.addEventListener('orca:open-escalation', (ev) => {
    const detail = (ev as CustomEvent<{ id?: string; agentId?: string }>).detail ?? {};
    const target = detail.id
      ? nodes.get(detail.id)
      : [...nodes.entries()].find(([id]) => store.world.escalations[id]?.agentId === detail.agentId)?.[1];
    if (!target) return;

    // En móvil la columna lateral está oculta hasta que algo la reclama.
    document.querySelector('.console')?.classList.add('show-side');
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    target.querySelector<HTMLInputElement>('.int__input')?.focus();

    gsap.fromTo(target,
      { boxShadow: '0 0 0 2px var(--amber)' },
      { boxShadow: '0 0 0 0px rgba(245,165,36,0)', duration: 0.9,
        ease: 'power2.out', clearProps: 'boxShadow' });
  });

  store.on((ev) => {
    if (ev.k === 'world' || ev.k === 'escalations' || ev.k === 'agents') paint();
  });
  paint();
}

/* ── The breach takeover ──────────────────────────────────────────────
   When a blocking question has gone unanswered long enough that work has
   genuinely stalled, the console stops being polite and does what the comp
   does: the field goes red and a banner runs. It clears the moment the
   question is answered. Nothing else in ORCA is allowed to do this. */

function mountBreach() {
  const el = document.createElement('div');
  el.className = 'breach';
  el.innerHTML = `
    <div class="marquee breach__banner">
      <div class="marquee__track" data-track>
        ${Array.from({ length: 2 }).map(() => `
          <div class="banner banner--red">
            <span class="warn"></span><span class="px px--banner">AGENT BLOCKED</span>
            <span class="warn"></span><span class="px px--banner">AGENT BLOCKED</span>
          </div>`).join('')}
      </div>
    </div>
    <p class="breach__sub px px--tiny" data-sub></p>
    <p class="breach__dismiss px px--tiny">CLICK TO DISMISS</p>
  `;
  document.body.appendChild(el);
  gsap.set(el, { autoAlpha: 0 });

  let on = false;
  let tl: gsap.core.Timeline | null = null;

  /**
   * Questions the operator has already been shouted at about. Without this,
   * opening the console on a fleet with old unanswered questions means an
   * immediate, permanent breach — which is not an alarm, it is wallpaper.
   */
  const dismissed = new Set<string>();

  /**
   * When this console first saw each question. The clock starts when the
   * operator could plausibly have acted, not when the agent asked — otherwise
   * every reload re-fires on history.
   */
  const firstSeen = new Map<string, number>();

  function evaluate(pending: Escalation[]) {
    const now = Date.now();
    const live = new Set<string>();

    for (const e of pending) {
      live.add(e.id);
      if (!firstSeen.has(e.id)) firstSeen.set(e.id, now);
    }
    // Forget anything answered, so a future question with a recycled id is
    // treated as new.
    for (const id of [...firstSeen.keys()]) if (!live.has(id)) firstSeen.delete(id);
    for (const id of [...dismissed]) if (!live.has(id)) dismissed.delete(id);

    const stalled = pending.filter((e) => {
      if (e.urgency !== 'blocking') return false;
      if (dismissed.has(e.id)) return false;
      const seen = firstSeen.get(e.id) ?? now;
      return now - seen > BREACH_AFTER_MS;
    });

    const want = stalled.length > 0;

    if (want) {
      const sub = el.querySelector<HTMLElement>('[data-sub]')!;
      const noun = stalled.length === 1 ? 'QUESTION' : 'QUESTIONS';
      const txt = `${stalled.length} BLOCKING ${noun} / WORK HAS STOPPED`;
      if (sub.textContent !== txt) sub.textContent = txt;
      el.dataset.ids = stalled.map((e) => e.id).join(',');
    }
    if (want === on) return;
    on = want;

    if (want) {
      document.body.classList.add('is-breach');
      gsap.to(el, { autoAlpha: 1, duration: 0.3 });
      tl = gsap.timeline({ repeat: -1 })
        .fromTo(el.querySelector('[data-track]'),
          { xPercent: 0 }, { xPercent: -50, duration: 2.6, ease: 'none' });
    } else {
      document.body.classList.remove('is-breach');
      tl?.kill();
      tl = null;
      gsap.to(el, { autoAlpha: 0, duration: 0.3 });
    }
  }

  /*
   * Se descarta con cualquier clic en la página, no sólo sobre el velo: el velo
   * no recibe eventos precisamente para que el clic con el que respondes la
   * pregunta también apague la alarma. Descartar es por pregunta y permanente
   * para ella; la cola la sigue mostrando en ámbar.
   */
  document.addEventListener('click', () => {
    if (!on) return;
    for (const id of (el.dataset.ids ?? '').split(',')) if (id) dismissed.add(id);
    document.body.classList.remove('is-breach');
    tl?.kill();
    tl = null;
    on = false;
    gsap.to(el, { autoAlpha: 0, duration: 0.2 });
  }, { capture: true });

  return { evaluate };
}

function escHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}
function escAttr(s: string) {
  return escHtml(s).replace(/"/g, '&quot;');
}
