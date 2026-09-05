/**
 * CAPCOM: the one voice that speaks to the fleet on your behalf.
 *
 * Two modes, one window, because there are two ways to have a command loop:
 *
 *  - **Transcript.** When a CLI session with `role: 'capcom'` is in the fleet,
 *    this window is that session's transcript — its state, its burn, what it
 *    is doing right now, what you told it, what it answered, and every order
 *    it passed down to the fleet. It is the agent window of the one agent you
 *    talk to, not a second kind of conversation.
 *  - **API command.** Until such a session exists, the window keeps the old
 *    API/scripted CEO conversation exactly as it was, with one line at the top
 *    saying which loop you are looking at and how to get the other one.
 *
 * Either way the input at the bottom calls `hub.say`. Who receives it is the
 * hub's problem, not the window's — that is the whole point of one voice.
 *
 * The hub keeps only the *last* thing CAPCOM said and the *last* thing you
 * told it. A transcript that forgets everything but its final line is not a
 * transcript, so this window accumulates its own history in memory (see
 * `capcomLog`): every change it witnesses becomes an entry, bounded, and the
 * log grows for as long as the window is open.
 */

import type { Agent, AgentMessage, Escalation, FeedItem } from '../../../shared/types.ts';
import { store } from '../../store.ts';
import { hub } from '../../net/client.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { slabFlash } from '../fx.ts';
import { ago, clock, esc, money, stateVar, stateWord, tokens } from '../../util.ts';

const ORDERS = ['FLEET STATUS', 'WHAT NEEDS ME', 'SPEND', 'STOP THE BURNERS', 'WHO IS STUCK'];

/** No CAPCOM session on this machine: what the API/scripted loop is, in one line. */
const API_NOTE = 'API COMMAND · no CAPCOM session on this machine · start one with orca capcom';

/** Nothing above this many entries is worth the memory or the scroll. */
export const CAPCOM_LOG_MAX = 200;

/* ── The log ──────────────────────────────────────────────────────── */

export type CapcomRole = 'human' | 'capcom' | 'system';

/** One line of the CAPCOM transcript, as this window remembers it. */
export interface CapcomEntry {
  /**
   * Stable across renders, and the whole dedupe strategy: a prompt or a reply
   * is identified by its text, so re-seeing the same `lastSay` adds nothing
   * and a changed one is a new line. Traffic and feed carry real ids.
   */
  id: string;
  at: number;
  role: CapcomRole;
  text: string;
  /** Second line, dimmer: a tool detail, a message body, a feed source. */
  note?: string;
  /** Set for traffic: the message kind, so the row can wear its colour. */
  kind?: AgentMessage['kind'];
  /** Set for traffic: which way it went, from CAPCOM's side. */
  dir?: 'out' | 'in';
  /** Set for traffic: who is at the other end. Id first, callsign as fallback. */
  peerId?: string | null;
  peerCallsign?: string | null;
}

type CapcomAgentLike = Pick<Agent, 'id' | 'lastPrompt' | 'lastSay' | 'updatedAt'>;

/**
 * Fold everything the hub currently knows about CAPCOM into a growing log.
 *
 * Pure on purpose: `prev` in, new array out, no store, no clock. The window
 * owns the accumulator; this decides what a change means.
 *
 * Ordering is by time, and ties keep insertion order — a prompt and the reply
 * it caused usually share `updatedAt`, and the prompt goes in first.
 */
export function capcomLog(
  agent: CapcomAgentLike,
  traffic: readonly AgentMessage[],
  feed: readonly FeedItem[],
  prev: readonly CapcomEntry[],
): CapcomEntry[] {
  const next: CapcomEntry[] = [];

  if (agent.lastPrompt) {
    next.push({ id: `p:${agent.lastPrompt}`, at: agent.updatedAt, role: 'human', text: agent.lastPrompt });
  }
  if (agent.lastSay) {
    next.push({ id: `s:${agent.lastSay}`, at: agent.updatedAt, role: 'capcom', text: agent.lastSay });
  }
  for (const t of traffic) {
    const out = t.fromAgentId === agent.id;
    next.push({
      id: `m:${t.id}`,
      at: t.at,
      role: 'system',
      text: t.subject,
      note: t.body ?? undefined,
      kind: t.kind,
      dir: out ? 'out' : 'in',
      peerId: out ? t.toAgentId : t.fromAgentId,
      peerCallsign: out ? null : t.fromCallsign,
    });
  }
  for (const f of feed) {
    if (f.agentId !== agent.id) continue;
    next.push({ id: `f:${f.id}`, at: f.at, role: 'system', text: f.text, note: f.source });
  }

  // First sighting wins: an entry this window already remembers keeps the
  // moment it was first seen. Re-deriving it from a later `updatedAt` would
  // march the whole history forward every time CAPCOM breathes.
  const byId = new Map<string, CapcomEntry>();
  for (const e of prev) byId.set(e.id, e);
  for (const e of next) if (!byId.has(e.id)) byId.set(e.id, e);

  const all = [...byId.values()].sort((a, b) => a.at - b.at);
  return all.length > CAPCOM_LOG_MAX ? all.slice(all.length - CAPCOM_LOG_MAX) : all;
}

/* ── The window ───────────────────────────────────────────────────── */

/** The CAPCOM session, if this fleet has one. `role` arrives with the backend. */
function capcomOf(): Agent | undefined {
  return Object.values(store.world.agents).find((a) => (a as { role?: string }).role === 'capcom');
}

function escalationFor(a: Agent): Escalation | undefined {
  if (a.block?.escalationId) return store.world.escalations[a.block.escalationId];
  return Object.values(store.world.escalations)
    .find((e) => e.agentId === a.id && (e.status === 'pending' || e.status === 'with_ceo'));
}

/** Per-window memory of the transcript. Keyed by window id, dropped on dispose. */
const LOGS = new Map<string, CapcomEntry[]>();

export function mountCeo(ctx: WinCtx, c: Console) {
  const body = ctx.body;
  const key = ctx.win.id;
  body.innerHTML = `
    <div class="band" data-band></div>
    <p class="px px--tiny capcom__note" data-note hidden></p>
    <div class="win__scroll scroll" data-log></div>
    <div class="ceo__orders" data-orders>${ORDERS.map((o, i) => `<button class="chip" type="button" data-order="${esc(o)}"${i < 9 ? ` data-key="${i + 1}"` : ''}>${o}</button>`).join('')}</div>
    <div class="ceo__in">
      <textarea class="input" rows="2" data-in placeholder="message capcom · enter sends, shift+enter newline"></textarea>
      <button class="slab-btn" type="button" data-send data-key="enter">SEND</button>
    </div>
  `;
  const log = body.querySelector<HTMLElement>('[data-log]')!;
  const band = body.querySelector<HTMLElement>('[data-band]')!;
  const note = body.querySelector<HTMLElement>('[data-note]')!;
  const orders = body.querySelector<HTMLElement>('[data-orders]')!;
  const input = body.querySelector<HTMLTextAreaElement>('[data-in]')!;
  // The stamp is drawn from the window kind, and the kind stays `ceo` so the
  // wiring in main.ts keeps working. The operator should not have to know that.
  const stamp = ctx.win.el.querySelector('.win__stamp');
  if (stamp) stamp.textContent = 'capcom';
  let pinned = true;
  let sig = '';

  log.addEventListener('scroll', () => { pinned = log.scrollTop + log.clientHeight >= log.scrollHeight - 24; });

  function who(role: CapcomRole): string {
    return role === 'human' ? 'YOU' : role === 'capcom' ? 'CAPCOM' : 'SYS';
  }
  function cls(role: CapcomRole): string {
    return role === 'human' ? 'is-human' : role === 'capcom' ? 'is-ceo' : 'is-system';
  }

  /* ── Transcript mode ────────────────────────────────────────────── */

  function renderTranscript(a: Agent) {
    const now = Date.now();
    const p = store.world.projects[a.projectId];
    ctx.setCallsign('CAPCOM', p?.code);
    ctx.setTitle(a.title || a.mission || 'COMMAND SESSION');
    const peer = a.state === 'blocked' && a.block?.kind === 'peer';
    ctx.setState(a.state === 'blocked' && !peer ? 'blocked' : a.state === 'dead' ? 'dead' : null, stateVar(a));

    band.hidden = false;
    band.classList.toggle('is-off', a.state !== 'working' && a.state !== 'thinking');
    band.style.setProperty('--band-t', `${Math.max(0.35, 1.6 - Math.min(1, a.metrics.tokensPerSec / 80) * 1.2)}s`);
    note.hidden = true;

    const traffic = store.trafficFor(a.id);
    const esca = a.state === 'blocked' ? escalationFor(a) : undefined;
    const entries = capcomLog(a, traffic, store.world.feed, LOGS.get(key) ?? []);
    LOGS.set(key, entries);

    const s = [
      'tx', a.state, a.tool, a.toolDetail, a.metrics.costUSD.toFixed(2),
      Math.round(a.metrics.tokensPerSec), esca?.id, esca?.status, esca?.options.join('|'),
      entries.length, entries.length ? entries[entries.length - 1]!.id : '',
      Math.floor(now / 15000),
    ].join('|');
    if (s === sig) return;
    sig = s;

    const nowLine = a.state === 'working' && a.tool
      ? `<span class="px px--tiny" style="color:var(--lime)">${esc(a.tool)}</span> <span class="mono">${esc(a.toolDetail ?? '')}</span>`
      : a.lastSay ? `<span class="mono">${esc(a.lastSay)}</span>`
      : `<span class="mono" style="color:var(--ink-faint)">—</span>`;

    let block = '';
    if (esca) {
      block = `<div class="block">
        <div class="block__k"><span>${esc(a.block?.kind ?? 'question')} · WAITING ${ago(esca.askedAt, now)}</span></div>
        <div class="block__q mono">${esc(esca.question)}</div>
        ${esca.context ? `<div class="mono" style="margin-top:6px;color:var(--ink-dim)">${esc(esca.context)}</div>` : ''}
        <div class="block__opts">${esca.options.map((o) => `<button class="slab-btn slab-btn--amber slab-btn--sm" type="button" data-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div>
        ${esca.optionsOnly ? '' : `<div class="row" style="margin-top:8px"><input class="input" data-ans placeholder="type an answer" /><button class="slab-btn slab-btn--amber slab-btn--sm slab-btn--fit" type="button" data-ans-send>SEND</button></div>`}
      </div>`;
    } else if (a.state === 'blocked' && a.block) {
      block = `<div class="block">
        <div class="block__k"><span>${esc(a.block.kind)} · ${ago(a.block.since, now)}</span></div>
        <div class="block__q mono">${esc(a.block.summary)}</div>
      </div>`;
    }

    log.innerHTML = `
      <div class="sec row row--wrap capcom__head" style="gap:10px">
        <span class="status ${a.state === 'blocked' && !peer ? 'is-alert' : a.state === 'working' ? 'is-on' : a.state === 'dead' ? 'is-dead' : ''}">${esc(stateWord(a))}</span>
        <span class="px px--tiny">${Math.round(a.metrics.tokensPerSec)} TOK/S</span>
        <span class="px px--tiny">${esc(money(a.metrics.costUSD))}</span>
        <span class="px px--tiny">${esc(tokens(a.metrics.outputTokens))} OUT</span>
      </div>
      ${block}
      <div class="sec"><div class="sec__k px">NOW</div><div class="sec__v">${nowLine}</div></div>
      <div class="sec capcom__acts"><div class="chips">
        <button class="chip" type="button" data-open="${esc(a.id)}">OPEN AGENT</button>
        <button class="chip" type="button" data-fly="${esc(a.id)}">FLY</button>
      </div></div>
      ${entries.length ? `<div class="ceo__log">${entries.map((e) => {
        const peerName = e.peerId ? store.world.agents[e.peerId]?.callsign ?? e.peerCallsign ?? e.peerId : e.peerCallsign ?? (e.dir ? 'FLEET' : '');
        const head = e.kind
          ? `<span class="msg__kind px is-${e.kind}">${e.kind}</span> <b>${e.dir === 'out' ? '→' : '←'} ${esc(peerName)}</b> `
          : '';
        return `<div class="ceo__m ${cls(e.role)}">
          <div class="ceo__who px" title="${clock(e.at)}">${who(e.role)}</div>
          <div>
            <div class="ceo__text mono">${head}${esc(e.text)}</div>
            ${e.note ? `<div class="capcom__note2 mono">${esc(e.note)}</div>` : ''}
          </div>
        </div>`;
      }).join('')}</div>` : `<div class="ceo__empty mono">Nothing said yet. CAPCOM commands the fleet on your behalf — it surveys, spawns agents with real briefs, unblocks them, and absorbs the questions they raise so you only see the ones that need you.</div>`}
    `;

    log.querySelector('[data-open]')?.addEventListener('click', () => c.openAgent(a.id));
    log.querySelector('[data-fly]')?.addEventListener('click', () => c.go(a.id));
    if (esca) {
      log.querySelectorAll<HTMLElement>('[data-opt]').forEach((b) => b.addEventListener('click', () => { slabFlash(b); c.answer(esca.id, b.dataset.opt!, null); }));
      const ans = log.querySelector<HTMLInputElement>('[data-ans]');
      const ansBtn = log.querySelector<HTMLElement>('[data-ans-send]');
      const sendAns = () => { const v = ans?.value.trim(); if (v) { slabFlash(ansBtn); c.answer(esca.id, v, null); ans!.value = ''; } };
      ansBtn?.addEventListener('click', sendAns);
      ans?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendAns(); } });
    }
    if (pinned) log.scrollTop = log.scrollHeight;
  }

  /* ── API command mode ───────────────────────────────────────────── */

  function renderApi() {
    const ceo = store.world.ceo;
    const under = Object.values(store.world.agents).filter((a) => a.state !== 'done' && a.state !== 'dead').length;
    const blocked = store.world.fleet.blocked;
    ctx.setCallsign('CAPCOM');
    ctx.setTitle(`${ceo.thinking ? 'THINKING · ' : ''}${under} UNDER COMMAND · ${blocked} BLOCKED`);
    ctx.setState(null, ceo.thinking ? 'var(--st-thinking)' : blocked ? 'var(--amber)' : 'var(--lime)');
    band.hidden = true;
    note.hidden = false;
    note.textContent = API_NOTE;

    const s = 'api' + ceo.messages.map((m) => `${m.id}:${m.text.length}:${m.streaming ? 1 : 0}:${m.actions.map((a) => a.status).join('')}`).join('|') + `|${ceo.thinking}`;
    if (s === sig) return;
    sig = s;

    if (!ceo.messages.length) {
      log.innerHTML = `<div class="ceo__empty mono">CAPCOM commands the fleet on your behalf. It surveys, spawns agents with real briefs, unblocks them, and absorbs the questions they raise so you only see the ones that need you.${store.linkUp ? '' : '<br/><br/><span style="color:var(--red)">LINK DOWN · nothing you say here will arrive until it comes back.</span>'}</div>`;
      return;
    }
    log.innerHTML = `<div class="ceo__log">${ceo.messages.map((m) => `
      <div class="ceo__m is-${m.role}">
        <div class="ceo__who px" title="${clock(m.at)}">${m.role === 'human' ? 'YOU' : m.role === 'ceo' ? 'CAPCOM' : 'SYS'}</div>
        <div>
          <div class="ceo__text mono ${m.streaming ? 'is-streaming' : ''}">${esc(m.text)}</div>
          ${m.actions.length ? `<div class="ceo__acts">${m.actions.map((a) => `<div class="ceo__act is-${a.status} mono" title="${esc(a.detail ?? '')}"><i></i><span>${esc(a.summary || a.name)}</span></div>`).join('')}</div>` : ''}
          ${m.escalationId ? `<button class="chip" type="button" data-esc="${esc(m.escalationId)}" style="margin-top:6px;--chip-state:var(--amber)">OPEN INTERRUPT</button>` : ''}
        </div>
      </div>`).join('')}${ceo.thinking && !ceo.messages.some((m) => m.streaming) ? `<div class="ceo__m"><div class="ceo__who px">CAPCOM</div><div class="ceo__text mono is-streaming"></div></div>` : ''}</div>`;
    log.querySelectorAll<HTMLElement>('[data-esc]').forEach((b) => b.addEventListener('click', () => c.openInterrupt(b.dataset.esc!)));
    if (pinned) log.scrollTop = log.scrollHeight;
  }

  function render() {
    const a = capcomOf();
    if (a) renderTranscript(a); else renderApi();
  }

  /** The hub decides who hears this; the window only sends it. */
  function send(text: string) {
    const t = text.trim();
    if (!t) return;
    if (!store.linkUp) { c.note('link down · CAPCOM cannot hear you', 'warn'); return; }
    hub.say(t);
    pinned = true;
  }
  const sendBtn = body.querySelector<HTMLElement>('[data-send]')!;
  // §6.2: the slab inverts to ink for a frame as the line leaves. There is no
  // band on it — CAPCOM answers in the transcript, which is the real ack.
  sendBtn.addEventListener('click', () => { slabFlash(sendBtn); send(input.value); input.value = ''; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); slabFlash(sendBtn); send(input.value); input.value = ''; }
  });
  orders.querySelectorAll<HTMLElement>('[data-order]').forEach((b) => b.addEventListener('click', () => send(b.dataset.order!.toLowerCase())));

  const off = store.on((e) => {
    if (e.k === 'ceo' || e.k === 'world' || e.k === 'link' || e.k === 'agents' || e.k === 'traffic' || e.k === 'feed' || e.k === 'escalations') render();
  });
  const tick = window.setInterval(render, 5000);
  render();
  setTimeout(() => input.focus(), 80);
  return { dispose() { off(); clearInterval(tick); LOGS.delete(key); } };
}

/** The name this window has in the plan. `mountCeo` stays for the wiring. */
export const mountCapcom = mountCeo;
