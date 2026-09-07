import { mountCapcomModel } from '../capcom-model.ts';
import { mountAgentRecovery } from '../agent-recovery.ts';
import { agentOrigin, originLabel } from '../../../shared/origin.ts';
/**
 * An agent's interior.
 *
 * What it is doing, what it is waiting on, what it has cost, who spawned it
 * and whom it spawned, what it said to others, what it made — and a line to
 * talk to it. Everything on it is live.
 *
 * Two gestures from the comp live here, and neither needs wiring outside:
 *
 *  - **A4, glyph bursts.** While the agent is `thinking` with no tool call,
 *    NOW carries the handshake glyphs in two irregular bursts instead of a
 *    spinner. A constant rhythm reads as an animation; this reads as a machine.
 * Finished and failed agents remain open so their results can be read.
 */

import type { Agent, Escalation } from '../../../shared/types.ts';
import { store } from '../../store.ts';
import { drafts, draftKey } from '../../drafts.ts';
import { authedUrl, hub } from '../../net/client.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { ago, dur, esc, money, runtimeOf, stateVar, stateWord, tokens, nameOf } from '../../util.ts';
import { glyphBurst, slabBusy, slabFlash } from '../fx.ts';
import { mountAgentConversation } from '../agent-conversation.ts';
import { mountTerminal } from './terminal.ts';
import { toggle, type ToggleHandle } from '../../controls.ts';

export function mountAgent(ctx: WinCtx, c: Console) {
  const id = ctx.win.spec.params?.agentId ?? '';
  const body = ctx.body;
  body.classList.add('agent-workspace');
  body.innerHTML = `
    <div class="band" data-band></div>
    <div class="agent-workspace__status mono" data-status></div>
    <button class="chip" type="button" data-successor hidden>OPEN CONTINUED AGENT</button>
    <div class="tabs" role="tablist" aria-label="Agent views">
      <button class="tab is-on" role="tab" aria-selected="true" data-view="conversation">Conversation</button>
      <button class="tab" role="tab" aria-selected="false" data-view="terminal">Terminal</button>
      <button class="tab" role="tab" aria-selected="false" data-view="details">Details</button>
    </div>
    <div class="agent-workspace__conversation" data-conversation role="tabpanel"></div>
    <div class="agent-workspace__terminal" data-terminal role="tabpanel" hidden></div>
    <div class="win__scroll scroll" data-scroll role="tabpanel" hidden></div>
    <div data-agent-model></div>
    <div data-agent-recovery></div>
    <div class="ceo__in" data-composer>
      <textarea class="input" data-say rows="2" aria-label="Message agent" placeholder="message agent · enter sends, shift+enter newline"></textarea>
      <button class="slab-btn" type="button" data-send data-key="s">SEND</button>
    </div>
    <div class="row row--split" style="padding:0 8px 8px">
      <div class="row">
        <button class="btn" type="button" data-fly data-key="f">FLY</button>
        <button class="btn" type="button" data-term data-key="t" title="The pane itself: look at the CLI and type into it">TERM</button>
        <button class="btn" type="button" data-logs data-key="l">LOGS</button>
        <button class="btn" type="button" data-spawn data-key="c">SPAWN CHILD</button>
      </div>
      <div class="row">
        <button class="btn" type="button" data-interrupt data-key="i" title="Cut the turn it is in the middle of. The session, its id and its context survive. With text in the box, the correction goes with it">INTERRUPT</button>
        <button class="btn" type="button" data-stop data-key="x">STOP</button>
      </div>
    </div>
  `;
  const conversation = body.querySelector<HTMLElement>('[data-conversation]')!;
  const terminalHost = body.querySelector<HTMLElement>('[data-terminal]')!;
  const composer = body.querySelector<HTMLElement>('[data-composer]')!;
  const models = mountCapcomModel(body.querySelector<HTMLElement>('[data-agent-model]')!, cmd => hub.cmd(cmd), () => setView('terminal'), path => c.openFile({ path, agentId: id }), { scope: id, openAgent: agentId => c.openAgent(agentId) });
  const recovery = mountAgentRecovery(body.querySelector<HTMLElement>('[data-agent-recovery]')!, cmd => hub.cmd(cmd), agentId => c.openAgent(agentId));
  const offConversation = mountAgentConversation(conversation, id);
  let terminal: ReturnType<typeof mountTerminal> | null = null;
  function setView(next: string) {
    if (next === 'terminal' && !agent()?.pane) return;
    conversation.hidden = next !== 'conversation';
    terminalHost.hidden = next !== 'terminal';
    scroll.hidden = next !== 'details';
    composer.hidden = next !== 'conversation';
    body.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      button.setAttribute('aria-selected', String(button.dataset.view === next));
      button.classList.toggle('is-on', button.dataset.view === next);
      button.tabIndex = button.dataset.view === next ? 0 : -1;
    });
    if (next === 'terminal' && !terminal) {
      terminal = mountTerminal({ ...ctx, body: terminalHost, setTitle() {}, setCallsign() {}, setState() {} }, c);
    } else if (next !== 'terminal' && terminal) {
      terminal.dispose(); terminal = null; terminalHost.replaceChildren();
    }
  }
  const tabs = [...body.querySelectorAll<HTMLButtonElement>('[data-view]')];
  tabs.forEach((button, i) => {
    button.tabIndex = i === 0 ? 0 : -1;
    button.addEventListener('click', () => setView(button.dataset.view!));
    button.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const enabled = tabs.filter((tab) => !tab.disabled);
      const index = enabled.indexOf(button);
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? enabled.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
      setView(enabled[n]!.dataset.view!); enabled[n]!.focus();
    });
  });
  const scroll = body.querySelector<HTMLElement>('[data-scroll]')!;
  const band = body.querySelector<HTMLElement>('[data-band]')!;
  const sayIn = body.querySelector<HTMLTextAreaElement>('[data-say]')!;
  // The unsent line to this agent survives a reload (drafts.ts).
  const draft = drafts.bind(sayIn, draftKey('agent', id));
  draft.restore();
  const stopBtn = body.querySelector<HTMLButtonElement>('[data-stop]')!;

  let armed = 0;
  let logsOpen = false;
  let logsText = '';
  let sig = '';
  /** Kills the glyph loop before the section that holds it is rewritten. */
  let stopGlyphs: (() => void) | null = null;
  /** The REMEMBER switch of the current render, when a question is on screen. */
  let remembering: ToggleHandle | null = null;

  function agent(): Agent | undefined { return store.knownAgent(id); }

  function escalationFor(a: Agent): Escalation | undefined {
    if (a.block?.escalationId) return store.world.escalations[a.block.escalationId];
    return Object.values(store.world.escalations).find((e) => e.agentId === a.id && (e.status === 'pending' || e.status === 'with_ceo'));
  }

  function render() {
    const a = agent();
    models.update(a, store.linkUp); recovery.update(a, store.linkUp);
    const successor = Object.values(store.world.agents).find(other => other.continuation?.fromId === id);
    const successorButton = body.querySelector<HTMLButtonElement>('[data-successor]')!; successorButton.hidden = !successor; successorButton.onclick = () => { if (successor) c.openAgent(successor.id); };
    const terminalAvailable = !!a?.pane;
    for (const button of [termBtn, body.querySelector<HTMLButtonElement>('[data-view="terminal"]')!]) {
      button.disabled = !terminalAvailable;
      button.title = terminalAvailable ? 'Connect to this agent’s terminal' : 'No terminal available — this session has no hosted pane';
      button.classList.toggle('is-off', !terminalAvailable);
    }
    if (!terminalAvailable && !terminalHost.hidden) setView('conversation');
    // Completion and failure stay open: the result is what the user came to read.
    if (!a) {
      ctx.setTitle('GONE');
      stopGlyphs?.(); stopGlyphs = null;
      scroll.innerHTML = `<p class="px px--tiny" style="padding:14px 12px">THIS AGENT IS NO LONGER IN THE FLEET.</p>`;
      band.classList.add('is-off');
      return;
    }
    const p = store.world.projects[a.projectId];
    const status = body.querySelector<HTMLElement>('[data-status]')!;
    status.textContent = `${stateWord(a)} · ${runtimeOf(a)}${a.model ? ` · ${a.model}` : ''} · ${p?.name ?? a.projectId}`;
    const canSend = store.linkUp && a.state !== 'dead' && a.state !== 'done';
    sayIn.disabled = !canSend;
    body.querySelector<HTMLButtonElement>('[data-send]')!.disabled = !canSend;
    // Interrumpir es sobre un turno en vuelo: sin sesión viva no hay ninguno.
    body.querySelector<HTMLButtonElement>('[data-interrupt]')!.disabled = !canSend;
    body.querySelector<HTMLButtonElement>('[data-interrupt]')!.textContent = sayIn.value.trim() ? 'INTERRUPT + SEND' : 'INTERRUPT';
    sayIn.placeholder = !store.linkUp ? 'Disconnected — reconnect to send' : !canSend ? 'This session has ended' : 'message agent · enter sends, shift+enter newline';
    const m = store.world.machines[a.machineId];
    ctx.setCallsign(a.callsign, p?.code);
    ctx.setTitle(nameOf(a));
    const peer = a.state === 'blocked' && a.block?.kind === 'peer';
    ctx.setState(a.state === 'blocked' && !peer ? 'blocked' : a.state === 'dead' ? 'dead' : null, stateVar(a));

    band.classList.toggle('is-off', a.state !== 'working' && a.state !== 'thinking');
    termBtn.classList.toggle('is-off', !a.pane);
    band.style.setProperty('--band-t', `${Math.max(0.35, 1.6 - Math.min(1, a.metrics.tokensPerSec / 80) * 1.2)}s`);

    const esca = a.state === 'blocked' ? escalationFor(a) : undefined;
    const unblocks = 1 + store.dammedBehind(a.id).length;
    const now = Date.now();
    const s = [
      a.origin, a.role, a.state, a.block?.summary, a.tool, a.toolDetail, a.lastSay, a.lastPrompt, a.mission, a.title,
      a.metrics.costUSD.toFixed(2), a.metrics.outputTokens, a.metrics.tokensPerSec.toFixed(0), a.metrics.turns,
      a.childIds.join(','), esca?.id, esca?.status, esca?.permission?.phase, logsOpen, logsText.length,
      store.trafficFor(a.id).slice(0, 8).map((x) => x.id + (x.answer ? 'a' : '')).join(','),
      store.artifactsOf(a.id).map((x) => x.id).join(','),
      Math.floor(now / 15000),
    ].join('|');
    if (s === sig) return;
    sig = s;

    const kids = store.childrenOf(a.id);
    const parent = a.parentId ? store.world.agents[a.parentId] : null;
    const traffic = store.trafficFor(a.id).slice(0, 8);
    const arts = store.artifactsOf(a.id);

    let block = '';
    if (a.state === 'blocked' && a.block) {
      if (peer) {
        const other = a.block.waitingOn ? Object.values(store.world.agents).find((x) => x.callsign === a.block!.waitingOn || x.id === a.block!.waitingOn) : null;
        block = `<div class="block" style="border-color:var(--st-thinking);background:rgba(143,184,255,0.05)">
          <div class="block__k" style="color:var(--st-thinking)"><span>WAITING ON A PEER · ${ago(a.block.since, now)}</span></div>
          <div class="block__q mono">${esc(a.block.summary)}</div>
          ${other ? `<div class="chips" style="margin-top:8px"><button class="chip" type="button" data-go="${esc(other.id)}" style="--chip-state:${stateVar(other)}">${esc(other.callsign)} <small>${esc(stateWord(other))}</small></button></div>` : ''}
        </div>`;
      } else if (esca) {
        block = `<div class="block">
          <div class="block__k"><span>${esca.permission?.phase === 'pending' ? 'RESPONSE PENDING' : esc(a.block.kind) + ' · WAITING'} ${ago(esca.askedAt, now)}</span><span>UNBLOCKS ${unblocks}</span></div>
          <div class="block__q mono">${esc(esca.question)}</div>
          ${esca.context ? `<div class="mono" style="margin-top:6px;color:var(--ink-dim)">${esc(esca.context)}</div>` : ''}
          ${esca.ceoAttempt ? `<div class="block__tried mono"><b>CAPCOM TRIED · ${Math.round(esca.ceoAttempt.confidence * 100)}%</b>${esc(esca.ceoAttempt.answer)}<br/><span style="color:var(--ink-dimmer)">punted: ${esc(esca.ceoAttempt.reason)}</span></div>` : ''}
          <div class="block__opts">${esca.options.map((o) => `<button class="slab-btn slab-btn--amber slab-btn--sm" type="button" ${esca.permission?.phase === 'pending' ? 'disabled' : ''} data-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div>
          ${esca.optionsOnly ? '' : `<div class="row" style="margin-top:8px"><input class="input" data-ans placeholder="type an answer" /><button class="slab-btn slab-btn--amber slab-btn--sm slab-btn--fit" type="button" data-ans-send>SEND</button></div>`}
          <div data-remember style="margin-top:8px"></div>
        </div>`;
      } else if (a.block.kind === 'permission') {
        block = `<div class="block">
          <div class="block__k"><span>PERMISSION · WAITING ${ago(a.block.since, now)}</span><span>UNBLOCKS ${unblocks}</span></div>
          <div class="block__q mono">${esc(a.block.summary)}</div>
          ${a.pane
            ? `<p class="px px--tiny" style="margin-top:8px;color:var(--ink-dim)">NO VERIFIED REQUEST YET. WAIT FOR AN IDENTIFIED ESCALATION OR REVIEW THE TERMINAL.</p>`
            : `<p class="px px--tiny" style="margin-top:8px;color:var(--ink-dim)">CLAUDE CODE CANNOT TAKE THIS ANSWER FROM OUTSIDE THE PROCESS. ANSWER IN ITS TERMINAL ON ${esc(m?.hostname ?? a.machineId)}${a.shortId ? ` · <span class="mono">claude attach ${esc(a.shortId)}</span>` : ''}.</p>`}
        </div>`;
      } else {
        block = `<div class="block">
          <div class="block__k"><span>${esc(a.block.kind)} · ${ago(a.block.since, now)}</span><span>UNBLOCKS ${unblocks}</span></div>
          <div class="block__q mono">${esc(a.block.summary)}</div>
        </div>`;
      }
    }

    // A4: thinking with nothing to show for it yet is the only place in the
    // console that may animate while idle, and it animates in bursts.
    const pondering = a.state === 'thinking' && !a.tool;
    const now2 = a.state === 'working' && a.tool
      ? `<span class="px px--tiny" style="color:var(--lime)">${esc(a.tool)}</span> <span class="mono">${esc(a.toolDetail ?? '')}</span>`
      : pondering ? `<span class="glyphs" data-glyphs></span>`
      : a.lastSay ? `<span class="mono">${esc(a.lastSay)}</span>` : `<span class="mono" style="color:var(--ink-faint)">—</span>`;

    stopGlyphs?.(); stopGlyphs = null;
    remembering?.dispose(); remembering = null;
    scroll.innerHTML = `
      <div class="sec row row--wrap" style="gap:10px">
        <span class="origin-badge" data-origin-kind="${agentOrigin(a)}">${originLabel(a)}</span>
        <span class="status ${a.state === 'blocked' && !peer ? 'is-alert' : a.state === 'working' ? 'is-on' : a.state === 'dead' ? 'is-dead' : ''}">${esc(stateWord(a))}</span>
        <span class="px px--tiny">${esc(runtimeOf(a))}${a.model ? ` · ${esc(a.model)}` : ''}</span>
        <span class="px px--tiny">${esc(m?.hostname ?? a.machineId)}</span>
        <span class="px px--tiny">${a.background ? 'BACKGROUND' : 'FOREGROUND'}${a.shortId ? ` · ${esc(a.shortId)}` : ''}</span>
      </div>
      ${block}
      <div class="sec">
        <div class="grid4">
          <div><div class="num">${money(a.metrics.costUSD)}</div><div class="num__k px">COST</div></div>
          <div><div class="num">${tokens(a.metrics.inputTokens)}</div><div class="num__k px">TOK IN</div></div>
          <div><div class="num">${tokens(a.metrics.outputTokens)}</div><div class="num__k px">TOK OUT</div></div>
          <div><div class="num ${a.metrics.tokensPerSec > 0 ? 'is-lime' : ''}">${Math.round(a.metrics.tokensPerSec)}</div><div class="num__k px">TOK/S</div></div>
          <div><div class="num">+${a.metrics.linesAdded}/−${a.metrics.linesRemoved}</div><div class="num__k px">LINES</div></div>
          <div><div class="num">${a.metrics.toolCalls}</div><div class="num__k px">TOOLS</div></div>
          <div><div class="num">${a.metrics.turns}</div><div class="num__k px">TURNS</div></div>
          <div><div class="num">${dur(a.uptimeMs)}</div><div class="num__k px">UPTIME</div></div>
        </div>
      </div>
      <div class="sec"><div class="sec__k px">NOW</div><div class="sec__v">${now2}</div></div>
      <div class="sec"><div class="sec__k px">MISSION</div><div class="sec__v mono ${a.mission ? '' : 'is-empty'}">${esc(a.mission ?? 'not recorded')}</div></div>
      ${a.lastPrompt ? `<div class="sec"><div class="sec__k px">LAST PROMPT</div><div class="sec__v mono">${esc(a.lastPrompt)}</div></div>` : ''}
      <div class="sec">
        <div class="sec__k px">LINEAGE</div>
        <div class="chips">
          ${parent ? `<button class="chip" type="button" data-go="${esc(parent.id)}" style="--chip-state:${stateVar(parent)}"><small>PARENT</small>${esc(parent.callsign)}</button>` : `<span class="px px--tiny" style="color:var(--ink-faint)">ROOT SESSION</span>`}
          ${kids.map((k) => `<button class="chip" type="button" data-go="${esc(k.id)}" style="--chip-state:${stateVar(k)}"><small>CHILD</small>${esc(k.callsign)} <small>${esc(k.state)}</small></button>`).join('')}
        </div>
      </div>
      ${traffic.length ? `<div class="sec" style="padding:0"><div class="sec__k px" style="padding:10px 12px 4px">TRAFFIC</div>
        ${traffic.map((t) => {
          const out = t.fromAgentId === a.id;
          const other = out ? (t.toAgentId ? store.world.agents[t.toAgentId]?.callsign ?? (t.toProjectId ? `PROJECT ${store.world.projects[t.toProjectId]?.code ?? ''}` : 'FLEET') : (t.scope === 'project' ? `PROJECT ${store.world.projects[t.toProjectId ?? '']?.code ?? ''}` : 'FLEET')) : t.fromCallsign;
          return `<div class="msg"><span class="msg__kind px is-${t.kind}">${t.kind}${t.kind === 'ask' && !t.answer ? ' ·' : ''}</span><span class="msg__body mono"><b>${out ? '→' : '←'} ${esc(other)}</b>${esc(t.subject)}</span><span class="msg__t px">${ago(t.at, now)}</span></div>`;
        }).join('')}</div>` : ''}
      ${arts.length ? `<div class="sec" style="padding:0"><div class="sec__k px" style="padding:10px 12px 0">ARTIFACTS · ${arts.length}</div>
        <div class="thumbs">${arts.slice(0, 12).map((x) => `<button class="thumb" type="button" data-art="${esc(x.id)}" title="${esc(x.title)}">${x.kind === 'image' && x.url ? `<img src="${esc(authedUrl(x.url))}" alt="" loading="lazy" />` : x.kind === 'video' && x.url ? `<video src="${esc(authedUrl(x.url))}" muted playsinline preload="metadata"></video>` : `<span class="thumb__k">${esc(x.kind)}</span>`}<span class="thumb__t">${esc(x.title)}</span></button>`).join('')}</div></div>` : ''}
      ${logsOpen ? `<div class="sec"><div class="sec__k px">LOGS</div><pre class="mono sec__v" style="max-height:220px;overflow:auto">${esc(logsText || 'fetching…')}</pre></div>` : ''}
    `;

    const glyphHost = scroll.querySelector<HTMLElement>('[data-glyphs]');
    if (glyphHost) stopGlyphs = glyphBurst(glyphHost);

    scroll.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.addEventListener('click', () => { c.go(b.dataset.go!); c.openAgent(b.dataset.go!); }));
    scroll.querySelectorAll<HTMLElement>('[data-art]').forEach((b) => b.addEventListener('click', (e) => c.openArtifact(b.dataset.art!, { x: e.clientX, y: e.clientY })));
    scroll.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); c.menu({ kind: 'agent', id: b.dataset.go! }, { x: e.clientX, y: e.clientY }); }));
    scroll.querySelectorAll<HTMLElement>('[data-art]').forEach((b) => b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); c.menu({ kind: 'artifact', id: b.dataset.art! }, { x: e.clientX, y: e.clientY }); }));
    if (esca) {
      const host = scroll.querySelector<HTMLElement>('[data-remember]');
      if (host && !esca.permission) {
        remembering = toggle({ name: 'remember', label: 'REMEMBER · LET CAPCOM ANSWER THIS NEXT TIME' });
        host.appendChild(remembering.el);
      }
      const remember = () => (!esca.permission && remembering?.checked() ? esca.question : null);
      scroll.querySelectorAll<HTMLElement>('[data-opt]').forEach((b) => b.addEventListener('click', () => { slabFlash(b); c.answer(esca.id, b.dataset.opt!, remember()); }));
      const ans = scroll.querySelector<HTMLInputElement>('[data-ans]');
      const ansBtn = scroll.querySelector<HTMLElement>('[data-ans-send]');
      const send = () => { const v = ans?.value.trim(); if (v) { slabFlash(ansBtn); c.answer(esca.id, v, remember()); ans!.value = ''; } };
      ansBtn?.addEventListener('click', send);
      ans?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    }
  }

  const sendBtn = body.querySelector<HTMLElement>('[data-send]')!;
  /**
   * §6.2: the slab inverts to ink for a frame as the order leaves, and the
   * thin band runs along its bottom edge until the hub says it arrived. The
   * band reports flight, never progress.
   */
  let sending = false;
  const send = async () => {
    const t = sayIn.value.trim();
    if (!t || sending || sayIn.disabled) return;
    if (!store.linkUp) { c.note('link down · your message has not been sent', 'warn'); return; }
    sayIn.value = '';
    draft.clear();
    slabFlash(sendBtn);
    const done = slabBusy(sendBtn);
    sending = true;
    try {
      const result = await c.say([id], t);
      if (result.failed.length && !sayIn.value) sayIn.value = t;
    } catch (err) {
      if (!sayIn.value) sayIn.value = t;
      c.note(`Message not sent: ${(err as Error).message}`, 'warn');
    } finally { sending = false; done(); draft.save(); }
  };
  sendBtn.addEventListener('click', () => void send());

  /*
   * INTERRUPT is `say`'s twin, not `stop`'s: it cuts the turn in flight and
   * leaves the session standing. Whatever is in the composer rides along as
   * the correction, which is the whole point — cancelling to then type the
   * fix is two actions where the operator meant one, and the two runtimes
   * need the two halves in opposite orders anyway (shared/interrupt.ts).
   * Unlike STOP it is not armed: interrupting by accident costs a turn, and
   * making the operator click twice costs the seconds the correction was for.
   */
  const intBtn = body.querySelector<HTMLButtonElement>('[data-interrupt]')!;
  let interrupting = false;
  intBtn.addEventListener('click', async () => {
    if (interrupting) return;
    if (!store.linkUp) { c.note('link down · nothing was interrupted', 'warn'); return; }
    const t = sayIn.value.trim() || null;
    interrupting = true;
    slabFlash(intBtn);
    const done = slabBusy(intBtn);
    try {
      const out = await c.interrupt(id, t);
      // El texto sólo se retira del compositor si de verdad salió con el corte.
      if (t && (out?.message === 'pasted' || out?.message === 'queued')) { sayIn.value = ''; draft.clear(); }
    } finally { interrupting = false; done(); draft.save(); }
  });
  sayIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); } });
  // La etiqueta sigue a lo que hay escrito: el mismo botón corta a secas o
  // corta y entrega, y el operador tiene que ver cuál de las dos va a pasar.
  sayIn.addEventListener('input', () => {
    intBtn.textContent = sayIn.value.trim() ? 'INTERRUPT + SEND' : 'INTERRUPT';
  });
  body.querySelector('[data-fly]')!.addEventListener('click', () => c.go(id));
  body.querySelector('[data-spawn]')!.addEventListener('click', () => { const a = agent(); if (a) c.openSpawn(a.projectId, a.id); });
  const termBtn = body.querySelector<HTMLButtonElement>('[data-term]')!;
  termBtn.addEventListener('click', () => {
    setView('terminal');
  });
  body.querySelector('[data-logs]')!.addEventListener('click', async () => {
    setView('details');
    logsOpen = !logsOpen;
    if (logsOpen) {
      logsText = '';
      render();
      try {
        const data = await hub.cmd({ k: 'logs', agentId: id, lines: 120 }) as { lines?: string[]; text?: string } | string | null;
        logsText = typeof data === 'string' ? data : data?.text ?? (data?.lines ?? []).join('\n');
        if (!logsText) logsText = '(no output)';
      } catch (err) {
        logsText = `could not fetch logs: ${(err as Error).message}`;
      }
    }
    sig = ''; render();
  });
  /**
   * At rest STOP is one more button in the secondary row. Armed, it becomes
   * the red slab — the console's one destructive colour, and the only place
   * it appears in this window.
   */
  const disarm = () => { armed = 0; stopBtn.className = 'btn'; stopBtn.textContent = 'STOP'; };
  stopBtn.addEventListener('click', async () => {
    // Two clicks: STOP arms, STOP again fires. An unarmed stop on a live agent is a lost hour.
    if (armed && Date.now() - armed < 4000) {
      disarm();
      await c.stop(id);
      return;
    }
    armed = Date.now();
    stopBtn.className = 'slab-btn slab-btn--red slab-btn--sm slab-btn--fit';
    stopBtn.textContent = 'STOP · SURE?';
    setTimeout(() => { if (armed) disarm(); }, 4000);
  });

  const off = store.on((e) => {
    if (e.k === 'link' || e.k === 'world' || (e.k === 'agents' && e.ids.includes(id)) || e.k === 'escalations' || e.k === 'traffic' || (e.k as string) === 'artifacts') render();
  });
  const tick = window.setInterval(render, 5000);
  render();
  return { dispose() { models.dispose(); recovery.dispose(); offConversation(); terminal?.dispose(); body.classList.remove('agent-workspace'); off(); clearInterval(tick); stopGlyphs?.(); remembering?.dispose(); draft.dispose(); } };
}
