/**
 * Cajón de detalle de un agente.
 *
 * Se abre por evento (`orca:open-agent`) y no por ruta: cualquier rectángulo de
 * la consola — un tile del deck, una línea del feed, un hijo de este mismo
 * cajón — puede pedir que se abra sin conocerlo.
 *
 * El cajón se construye UNA vez por apertura y a partir de ahí sólo escribe
 * texto en nodos que ya existen. Un agente trabajando emite eventos varias
 * veces por segundo; reconstruir el panel en cada uno tiraría el foco del campo
 * de respuesta y el scroll del bloque de logs justo mientras el humano escribe.
 */

import gsap from 'gsap';
import type { Agent, BlockKind } from '../../shared/types.ts';
import { store } from '../store.ts';
import { hub } from '../net/client.ts';

/** Recorte de los bloques de texto largo antes del "show more". */
const CLAMP = 400;
/** Cuántas líneas pedimos al collector cuando el humano pulsa LOGS. */
const LOG_LINES = 200;
/** Cuánto sigue armado el STOP antes de volver a su estado seguro. */
const ARM_MS = 3000;

export interface AgentDrawerHandle {
  destroy(): void;
  open(id: string): void;
  close(): void;
  /** Id abierto ahora mismo, o null. Lo usa el arnés de pruebas. */
  current(): string | null;
}

interface MetricCell {
  key: string;
  label: string;
  read: (a: Agent) => string;
}

const METRICS: MetricCell[] = [
  { key: 'cost',   label: 'COST',   read: (a) => '$' + a.metrics.costUSD.toFixed(2) },
  { key: 'in',     label: 'TOK IN', read: (a) => fmtTokens(a.metrics.inputTokens) },
  { key: 'out',    label: 'TOK OUT', read: (a) => fmtTokens(a.metrics.outputTokens) },
  { key: 'tps',    label: 'TOK/S',  read: (a) => String(Math.round(a.metrics.tokensPerSec)) },
  { key: 'lines',  label: 'LINES',  read: (a) => `+${a.metrics.linesAdded}/-${a.metrics.linesRemoved}` },
  { key: 'tools',  label: 'TOOLS',  read: (a) => String(a.metrics.toolCalls) },
  { key: 'turns',  label: 'TURNS',  read: (a) => String(a.metrics.turns) },
  { key: 'uptime', label: 'UPTIME', read: (a) => fmtDur(a.uptimeMs) },
];

const TEXT_SECTIONS: { key: 'mission' | 'lastPrompt' | 'lastSay'; label: string }[] = [
  { key: 'mission',    label: 'MISSION' },
  { key: 'lastPrompt', label: 'LAST PROMPT' },
  { key: 'lastSay',    label: 'LAST SAY' },
];

export function mountAgentDrawer(el: HTMLElement): AgentDrawerHandle {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  el.innerHTML = `
    <div class="drw" data-drw hidden>
      <div class="drw__veil" data-veil></div>
      <aside class="drw__panel" data-panel role="dialog" aria-modal="true"
             aria-label="Agent detail" tabindex="-1">
        <header class="drw__head">
          <div class="drw__ident">
            <span class="px px--card" data-callsign>--</span>
            <span class="status" data-state>IDLE</span>
            <button type="button" class="drw__x" data-close aria-label="Close agent detail">
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <div class="drw__title mono" data-title></div>
          <div class="drw__where px px--tiny" data-where></div>
          <nav class="drw__lineage px px--tiny" data-lineage aria-label="Agent lineage" hidden></nav>
        </header>

        <div class="drw__body scroll" data-body>
          <section class="blk" data-block hidden>
            <div class="blk__top">
              <span class="px px--tiny" data-blkkind>BLOCKED</span>
              <span class="px px--tiny blk__age" data-blkage></span>
            </div>
            <div class="blk__sum mono" data-blksum></div>
            <div class="blk__acts" data-blkacts></div>
          </section>

          <section class="work" data-work hidden>
            <div class="work__top">
              <span class="px px--tiny">RUNNING</span>
              <span class="px px--sm work__tool" data-tool></span>
            </div>
            <div class="work__detail mono" data-tooldetail></div>
            <div class="actbar" data-actbar aria-hidden="true"><i></i></div>
          </section>

          <div class="mets" data-mets></div>
          <div data-texts></div>

          <section class="kids" data-kids hidden>
            <div class="sec__label px px--tiny" data-kidslabel>CHILDREN</div>
            <div class="kids__list" data-kidslist></div>
          </section>

          <section class="logs" data-logs hidden>
            <div class="sec__label px px--tiny">LOGS</div>
            <pre class="logs__out mono scroll" data-logout></pre>
          </section>
        </div>

        <footer class="drw__foot">
          <form class="drw__say" data-sayform>
            <input class="drw__sayin mono" data-sayin type="text" spellcheck="false"
                   placeholder="say something to this agent" aria-label="Say something to this agent" />
            <button type="submit" class="op op--say px px--tiny" data-saysend>SAY</button>
          </form>
          <div class="drw__ops">
            <button type="button" class="op px px--tiny" data-logsbtn>LOGS</button>
            <button type="button" class="op op--stop px px--tiny" data-stop>STOP</button>
          </div>
        </footer>
      </aside>
    </div>
  `;

  const $ = <T extends HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const drw = $('[data-drw]');
  const veil = $('[data-veil]');
  const panel = $('[data-panel]');
  const bodyEl = $('[data-body]');

  const callsignEl = $('[data-callsign]');
  const stateEl = $('[data-state]');
  const titleEl = $('[data-title]');
  const whereEl = $('[data-where]');
  const lineageEl = $('[data-lineage]');

  const blockEl = $('[data-block]');
  const blkKindEl = $('[data-blkkind]');
  const blkAgeEl = $('[data-blkage]');
  const blkSumEl = $('[data-blksum]');
  const blkActsEl = $('[data-blkacts]');

  const workEl = $('[data-work]');
  const toolEl = $('[data-tool]');
  const toolDetailEl = $('[data-tooldetail]');

  const metsEl = $('[data-mets]');
  const textsEl = $('[data-texts]');
  const kidsEl = $('[data-kids]');
  const kidsLabelEl = $('[data-kidslabel]');
  const kidsListEl = $('[data-kidslist]');
  const logsEl = $('[data-logs]');
  const logOutEl = $('[data-logout]');

  const sayForm = $<HTMLFormElement>('[data-sayform]');
  const sayIn = $<HTMLInputElement>('[data-sayin]');
  const logsBtn = $<HTMLButtonElement>('[data-logsbtn]');
  const stopBtn = $<HTMLButtonElement>('[data-stop]');

  /* ── Celdas fijas: se crean una vez, luego sólo se les escribe. ──── */

  const metricNodes = new Map<string, HTMLElement>();
  for (const m of METRICS) {
    const cell = document.createElement('div');
    cell.className = 'met';
    const n = document.createElement('span');
    n.className = 'met__n';
    n.textContent = '—';
    const k = document.createElement('span');
    k.className = 'met__k px px--tiny';
    k.textContent = m.label;
    cell.appendChild(n);
    cell.appendChild(k);
    metsEl.appendChild(cell);
    metricNodes.set(m.key, n);
  }

  const textNodes = new Map<string, { sec: HTMLElement; body: HTMLElement; more: HTMLButtonElement }>();
  for (const t of TEXT_SECTIONS) {
    const sec = document.createElement('section');
    sec.className = 'sec';
    sec.hidden = true;
    const label = document.createElement('div');
    label.className = 'sec__label px px--tiny';
    label.textContent = t.label;
    const body = document.createElement('div');
    body.className = 'sec__body mono';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'sec__more px px--tiny';
    more.textContent = 'SHOW MORE';
    more.hidden = true;
    more.addEventListener('click', () => {
      if (expandedText.has(t.key)) expandedText.delete(t.key);
      else expandedText.add(t.key);
      const a = currentAgent();
      if (a) paintTexts(a);
    });
    sec.appendChild(label);
    sec.appendChild(body);
    sec.appendChild(more);
    textsEl.appendChild(sec);
    textNodes.set(t.key, { sec, body, more });
  }

  /* ── Estado del cajón ───────────────────────────────────────────── */

  let openId: string | null = null;
  let lastFocus: HTMLElement | null = null;
  let tickTimer = 0;
  let stopArmed = false;
  let stopTimer = 0;
  let lastBlockKind: BlockKind | null = null;
  const expandedText = new Set<string>();
  const kidRows = new Map<string, { row: HTMLElement; state: HTMLElement; title: HTMLElement }>();

  function currentAgent(): Agent | null {
    return openId ? store.world.agents[openId] ?? null : null;
  }

  /* ── Pintado ────────────────────────────────────────────────────── */

  function put(node: HTMLElement, text: string) {
    if (node.textContent !== text) node.textContent = text;
  }

  function paint() {
    const a = currentAgent();
    if (!a) {
      // El agente desapareció del mundo mientras lo mirábamos: decirlo, no cerrar.
      put(stateEl, 'GONE');
      stateEl.className = 'status is-dead';
      return;
    }

    put(callsignEl, a.callsign);
    put(titleEl, a.title);
    put(stateEl, a.state.toUpperCase());
    stateEl.className = `status st-${a.state}`;

    const proj = store.world.projects[a.projectId];
    const mach = store.world.machines[a.machineId];
    put(whereEl, `${proj?.name ?? a.projectId} · ${mach?.hostname ?? a.machineId}${a.model ? ' · ' + a.model : ''}`);

    paintLineage(a);
    paintBlock(a);
    paintWork(a);
    paintMetrics(a);
    paintTexts(a);
    paintKids(a);
  }

  function paintLineage(a: Agent) {
    const chain = store.ancestryOf(a.id);
    if (chain.length < 2) {
      lineageEl.hidden = true;
      lineageEl.textContent = '';
      lineageEl.dataset.sig = '';
      return;
    }
    const sig = chain.map((x) => x.id).join('>');
    if (lineageEl.dataset.sig === sig) return;
    lineageEl.dataset.sig = sig;
    lineageEl.hidden = false;
    lineageEl.textContent = '';
    chain.forEach((x, i) => {
      if (i) {
        const sep = document.createElement('span');
        sep.className = 'drw__sep';
        sep.textContent = '›';
        lineageEl.appendChild(sep);
      }
      if (x.id === a.id) {
        const self = document.createElement('span');
        self.className = 'drw__crumb is-self';
        self.textContent = x.callsign;
        lineageEl.appendChild(self);
        return;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'drw__crumb';
      b.textContent = x.callsign;
      b.addEventListener('click', () => openAgent(x.id));
      lineageEl.appendChild(b);
    });
  }

  function paintBlock(a: Agent) {
    const b = a.block;
    if (a.state !== 'blocked' || !b) {
      blockEl.hidden = true;
      lastBlockKind = null;
      return;
    }
    blockEl.hidden = false;
    put(blkKindEl, `BLOCKED · ${b.kind.toUpperCase()}`);
    put(blkSumEl, b.summary);
    paintAge();
    if (lastBlockKind !== b.kind) {
      lastBlockKind = b.kind;
      buildBlockActions(a.id, b.kind, b.escalationId ?? null);
    }
  }

  /** El reloj del bloqueo es la métrica más honesta del producto: cuánto lleva
   *  un agente esperando a una persona. Se actualiza cada segundo. */
  function paintAge() {
    const a = currentAgent();
    if (!a?.block) return;
    put(blkAgeEl, 'WAITING ' + fmtDur(Date.now() - a.block.since));
  }

  function buildBlockActions(agentId: string, kind: BlockKind, escalationId: string | null) {
    blkActsEl.textContent = '';
    const add = (label: string, cls: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `op ${cls} px px--tiny`;
      b.textContent = label;
      b.addEventListener('click', fn);
      blkActsEl.appendChild(b);
      return b;
    };

    if (kind === 'permission') {
      add('ALLOW ONCE', 'op--go', () => permit(agentId, true, 'once'));
      add('ALLOW SESSION', 'op--go', () => permit(agentId, true, 'session'));
      add('DENY', 'op--stop', () => permit(agentId, false, 'once'));
      return;
    }

    if (kind === 'question') {
      // La respuesta se compone en la cola de interrupciones, que es donde
      // viven las opciones sugeridas y el "recuérdalo para la próxima". El
      // cajón sólo anuncia la intención y se aparta: 'orca:open-escalation'
      // con { id, agentId } es el contrato para interrupts.ts.
      add('ANSWER', 'op--go', () => {
        window.dispatchEvent(new CustomEvent('orca:open-escalation', {
          detail: { id: escalationId, agentId },
        }));
        close();
      });
      return;
    }

    if (kind === 'input') {
      const form = document.createElement('form');
      form.className = 'blk__form';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'drw__sayin mono';
      input.placeholder = 'type what the agent is waiting for';
      input.setAttribute('aria-label', 'Reply to a waiting agent');
      const send = document.createElement('button');
      send.type = 'submit';
      send.className = 'op op--go px px--tiny';
      send.textContent = 'SEND';
      form.appendChild(input);
      form.appendChild(send);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        void run(hub.cmd({ k: 'say', agentId, text }));
        input.value = '';
      });
      blkActsEl.appendChild(form);
      return;
    }

    // 'error': no hay nada seguro que ofrecer aquí salvo el STOP del pie.
    const note = document.createElement('div');
    note.className = 'mono blk__note';
    note.textContent = 'needs intervention on the machine';
    blkActsEl.appendChild(note);
  }

  function permit(agentId: string, allow: boolean, scope: 'once' | 'session') {
    void run(hub.cmd({ k: 'permit', agentId, allow, scope }));
  }

  function paintWork(a: Agent) {
    const on = a.state === 'working' && !!a.tool;
    workEl.hidden = !on;
    if (!on) return;
    put(toolEl, a.tool ?? '');
    put(toolDetailEl, a.toolDetail ?? '');
  }

  function paintMetrics(a: Agent) {
    for (const m of METRICS) {
      const node = metricNodes.get(m.key);
      if (node) put(node, m.read(a));
    }
  }

  function paintTexts(a: Agent) {
    for (const t of TEXT_SECTIONS) {
      const nodes = textNodes.get(t.key);
      if (!nodes) continue;
      const raw = a[t.key];
      if (!raw) {
        nodes.sec.hidden = true;
        continue;
      }
      nodes.sec.hidden = false;
      const open = expandedText.has(t.key);
      const long = raw.length > CLAMP;
      put(nodes.body, long && !open ? raw.slice(0, CLAMP) + '…' : raw);
      nodes.more.hidden = !long;
      if (long) put(nodes.more, open ? 'SHOW LESS' : `SHOW MORE (${raw.length - CLAMP} MORE)`);
    }
  }

  /** Los hijos se reconcilian por id: un agente padre puede lanzar decenas y
   *  la lista cambia mientras se mira. */
  function paintKids(a: Agent) {
    const kids = store.childrenOf(a.id);
    kidsEl.hidden = kids.length === 0;
    put(kidsLabelEl, `CHILDREN · ${kids.length}`);
    const seen = new Set<string>();
    let prev: HTMLElement | null = null;

    for (const k of kids) {
      seen.add(k.id);
      let row = kidRows.get(k.id);
      if (!row) {
        const el2 = document.createElement('button');
        el2.type = 'button';
        el2.className = 'kid';
        el2.dataset.agentId = k.id;
        const cs = document.createElement('span');
        cs.className = 'kid__cs px px--tiny';
        cs.textContent = k.callsign;
        const st = document.createElement('span');
        st.className = 'kid__st';
        const ti = document.createElement('span');
        ti.className = 'kid__title mono';
        el2.appendChild(cs);
        el2.appendChild(st);
        el2.appendChild(ti);
        el2.addEventListener('click', () => openAgent(k.id));
        row = { row: el2, state: st, title: ti };
        kidRows.set(k.id, row);
      }
      row.state.className = `kid__st st-${k.state}`;
      row.state.title = k.state;
      put(row.title, k.title);
      const want: ChildNode | null = prev ? prev.nextSibling : kidsListEl.firstChild;
      if (row.row !== want) kidsListEl.insertBefore(row.row, want);
      prev = row.row;
    }

    for (const [id, row] of kidRows) {
      if (seen.has(id)) continue;
      row.row.remove();
      kidRows.delete(id);
    }
  }

  /* ── Abrir / cerrar ─────────────────────────────────────────────── */

  function openAgent(id: string) {
    const first = openId === null;
    if (openId === id) return;
    openId = id;
    lastBlockKind = null;
    expandedText.clear();
    resetStop();
    logsEl.hidden = true;
    logOutEl.textContent = '';
    sayIn.value = '';
    bodyEl.scrollTop = 0;
    paint();

    if (first) {
      lastFocus = (document.activeElement as HTMLElement | null) ?? null;
      drw.hidden = false;
      if (reduce) {
        panel.style.transform = 'none';
      } else {
        gsap.killTweensOf(panel);
        gsap.fromTo(panel, { xPercent: 100 }, { xPercent: 0, duration: 0.28, ease: 'power3.out' });
        gsap.fromTo(veil, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.28, ease: 'power3.out' });
      }
      panel.focus?.();
      if (!tickTimer) tickTimer = window.setInterval(everySecond, 1000);
    }
  }

  function close() {
    if (openId === null) return;
    openId = null;
    if (tickTimer) { window.clearInterval(tickTimer); tickTimer = 0; }
    resetStop();
    const finish = () => { drw.hidden = true; };
    if (reduce) {
      finish();
    } else {
      gsap.killTweensOf(panel);
      gsap.to(panel, { xPercent: 100, duration: 0.2, ease: 'power2.in', onComplete: finish });
      gsap.to(veil, { autoAlpha: 0, duration: 0.2 });
    }
    lastFocus?.focus?.();
    lastFocus = null;
  }

  /** Un solo temporizador para todo lo que envejece: la espera y el uptime. */
  function everySecond() {
    const a = currentAgent();
    if (!a) return;
    paintAge();
    const up = metricNodes.get('uptime');
    // uptimeMs sólo llega en los patches; entre patches lo avanzamos nosotros.
    if (up) put(up, fmtDur(a.uptimeMs + (Date.now() - a.updatedAt)));
  }

  /* ── Acciones del pie ───────────────────────────────────────────── */

  function resetStop() {
    stopArmed = false;
    if (stopTimer) { window.clearTimeout(stopTimer); stopTimer = 0; }
    stopBtn.classList.remove('is-armed');
    stopBtn.textContent = 'STOP';
  }

  /** Una promesa de comando que falla no debe romper la UI, pero tampoco
   *  desaparecer en silencio: se escribe en el bloque de logs. */
  function run(p: Promise<unknown>): Promise<void> {
    return p.then(
      () => undefined,
      (err: unknown) => {
        logsEl.hidden = false;
        logOutEl.textContent = `command failed: ${err instanceof Error ? err.message : String(err)}`;
      },
    );
  }

  const onSay = (e: Event) => {
    e.preventDefault();
    const text = sayIn.value.trim();
    if (!text || !openId) return;
    void run(hub.cmd({ k: 'say', agentId: openId, text }));
    sayIn.value = '';
  };

  const onStop = () => {
    if (!openId) return;
    if (!stopArmed) {
      // Confirmación en el propio botón: parar un agente es destructivo y un
      // modal encima de un cajón deslizante es una pantalla de más.
      stopArmed = true;
      stopBtn.classList.add('is-armed');
      stopBtn.textContent = 'CONFIRM STOP';
      stopTimer = window.setTimeout(resetStop, ARM_MS);
      return;
    }
    const id = openId;
    resetStop();
    void run(hub.cmd({ k: 'stop', agentId: id }));
  };

  const onLogs = () => {
    if (!openId) return;
    logsEl.hidden = false;
    logOutEl.textContent = 'fetching…';
    hub.cmd({ k: 'logs', agentId: openId, lines: LOG_LINES }).then(
      (data) => { logOutEl.textContent = asText(data); },
      (err: unknown) => { logOutEl.textContent = `logs unavailable: ${err instanceof Error ? err.message : String(err)}`; },
    );
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && openId !== null) {
      e.preventDefault();
      close();
    }
  };

  const onOpenEvent = (e: Event) => {
    const id = (e as CustomEvent<{ id?: string }>).detail?.id;
    if (typeof id === 'string' && id) openAgent(id);
  };

  sayForm.addEventListener('submit', onSay);
  stopBtn.addEventListener('click', onStop);
  logsBtn.addEventListener('click', onLogs);
  veil.addEventListener('click', close);
  $('[data-close]').addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('orca:open-agent', onOpenEvent);

  const off = store.on((e) => {
    if (openId === null) return;
    switch (e.k) {
      case 'world':
        paint();
        break;
      case 'agents': {
        // Sólo repintamos si el cambio toca a este agente, a su linaje o a sus hijos.
        const a = currentAgent();
        const touched = e.ids.some((id) =>
          id === openId ||
          (a ? a.childIds.includes(id) : false) ||
          (a?.parentId ? id === a.parentId : false));
        if (touched) paint();
        break;
      }
      case 'escalations':
        paint();
        break;
    }
  });

  return {
    destroy() {
      off();
      close();
      document.removeEventListener('keydown', onKeydown);
      window.removeEventListener('orca:open-agent', onOpenEvent);
      if (tickTimer) window.clearInterval(tickTimer);
      if (stopTimer) window.clearTimeout(stopTimer);
      el.textContent = '';
    },
    open: openAgent,
    close,
    current: () => openId,
  };
}

/* ── Formateo ───────────────────────────────────────────────────────
   Números de instrumento: cortos, tabulares, sin unidades ambiguas. */

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(n || 0)));
  if (n < 1e6) {
    const k = n / 1e3;
    return (k < 10 ? k.toFixed(1) : Math.round(k).toString()) + 'k';
  }
  return (n / 1e6).toFixed(2) + 'M';
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function asText(data: unknown): string {
  if (typeof data === 'string') return data || '(empty)';
  if (Array.isArray(data)) return data.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
  if (data && typeof data === 'object') {
    const lines = (data as { lines?: unknown }).lines;
    if (typeof lines === 'string') return lines;
    if (Array.isArray(lines)) return lines.join('\n');
    return JSON.stringify(data, null, 2);
  }
  return String(data ?? '(no output)');
}
