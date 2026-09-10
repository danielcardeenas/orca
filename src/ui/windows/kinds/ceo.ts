import { mdLite } from '../markdown.ts';
export { mdLite } from '../markdown.ts';
/**
 * CAPCOM: the one voice that speaks to the fleet on your behalf.
 *
 * One window, three tabs, and the conversation is the window:
 *
 *  - **TALK.** What you said and what CAPCOM did about it, as an exchange:
 *    your line, then its thinking, every tool it reached for, what came back,
 *    and its reply in full — in the order it happened, arriving block by
 *    block while it works. This is the CAPCOM session's own transcript, fed
 *    by the collector (`talk` frames), not a one-line summary of it.
 *  - **WORK.** The agents CAPCOM has out there, with a way to each one.
 *  - **EVENTS.** The traffic and telemetry around CAPCOM — what it sent
 *    down to the fleet, what came up — which used to be spliced into the
 *    conversation and made it unreadable.
 *
 * Behind TALK sits CAPCOM — a CLI session with `role: 'capcom'` — or nobody.
 * The input calls `hub.say` either way; who hears it is the hub's problem, and
 * with no CAPCOM the hub answers with a line saying so. (The file is still
 * called ceo.ts: that was the API commander removed on 2026-09-06; the window
 * kind is persisted in layouts, so it is renamed separately.)
 *
 * ── The rail is a door, not a view ─────────────────────────────────────
 *
 * A mission used to be a tab here: pressing one swapped this window for that
 * mission's conversation, so having two in front of you was impossible and
 * reading a result while writing to the commander meant choosing. Missions
 * now have windows of their own (`kinds/mission.ts`), and the rail at the top
 * is the index that opens them — the same call the HUD's mission panel makes,
 * so there is exactly one way to be inside a mission. What stays here is what
 * was always CAPCOM's: its own session.
 *
 * The strip above the input is the one line that says what CAPCOM is doing
 * *right now* — state, the tool in its hand, speed, burn — so you never have
 * to scroll to know whether it heard you.
 */

import type { Agent, AgentMessage, Escalation, FeedItem, TalkItem } from '../../../shared/types.ts';
import { missionGlimpse, visibleMissions, type MissionMessage } from '../../../shared/missions.ts';
import { PHASE_DOT, PHASE_WORD, missionRows, railSplit, type MissionRow } from '../../hud/mission-status.ts';
import { pick, type PickHandle } from '../../controls.ts';
import { capcomOf as sharedCapcomOf } from '../../../shared/capcom.ts';
import { store, type OutgoingMessage } from '../../store.ts';
import { drafts, draftKey } from '../../drafts.ts';
import { hub, uploadFile } from '../../net/client.ts';
import { bindAttach } from '../attach.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { glyphBurst, slabFlash } from '../fx.ts';
import { ago, clock, esc, money, stateVar, stateWord, tokens } from '../../util.ts';
import { talkStepHtml } from '../talk-step.ts';
import { echoLanded, foldTalk, pendingEchoes, timeOrdered, toolLabel, type TalkGroup } from '../talk.ts';
import { refIndex, type RefIndex } from '../refs.ts';
import { linkPaths } from '../paths.ts';
import { handoffNotice } from '../capcom-handoff.ts';
import { dismissNotice, noticeDismissed, setNoticeOpen } from '../notice.ts';
import { handoffText } from '../../../shared/handoff.ts';
import { bindComposer, composerHint } from '../composer.ts';
import { mountCapcomModel } from '../capcom-model.ts';
import type { HistoryPage } from '../../../shared/provider-handoff.ts';


/** No CAPCOM session on this machine: what the API loop is, in one line. */
const API_NOTE = 'API COMMAND · no CAPCOM session on this machine · start one with orca capcom';

/** Nothing above this many entries is worth the memory or the scroll. */
export const CAPCOM_LOG_MAX = 200;

type Tab = 'talk' | 'work' | 'events';
const TABS: Tab[] = ['talk', 'work', 'events'];

/* ── The events log ───────────────────────────────────────────────── */

export type CapcomRole = 'human' | 'capcom' | 'system';

/** One line of the CAPCOM events log, as this window remembers it. */
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
 * owns the accumulator; this decides what a change means. The EVENTS tab
 * shows the `system` entries; the `human`/`capcom` one-liners are kept so a
 * fleet whose collector predates `talk` frames still has a trace of the
 * conversation somewhere.
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

/**
 * The CAPCOM session, if this fleet has one — chosen exactly as the hub
 * chooses who hears what you type, so the transcript on screen is the session
 * that is actually answering.
 */
function capcomOf(): Agent | undefined {
  return sharedCapcomOf(store.world.agents) ?? undefined;
}

function escalationFor(a: Agent): Escalation | undefined {
  if (a.block?.escalationId) return store.world.escalations[a.block.escalationId];
  return Object.values(store.world.escalations)
    .find((e) => e.agentId === a.id && (e.status === 'pending' || e.status === 'with_ceo'));
}

/** Per-window memory of the events log. Keyed by window id, dropped on dispose. */
const LOGS = new Map<string, CapcomEntry[]>();

function echoLabel(m: OutgoingMessage): string {
  return m.status === 'sending' ? 'SENDING…'
    : m.status === 'failed' ? 'DELIVERY UNCONFIRMED'
    : m.status === 'accepted' ? 'ACCEPTED BY COMMAND'
    : `DELIVERED · ${((m.elapsedMs ?? 0) / 1000).toFixed(1)}s`;
}

export function mountCeo(ctx: WinCtx, c: Console) {
  const body = ctx.body;
  const key = ctx.win.id;
  let tab: Tab = 'talk';
  try { const t = localStorage.getItem('orca.capcom.tab'); if (TABS.includes(t as Tab)) tab = t as Tab; } catch {}
  let missionPicker: PickHandle | null = null;
  let railSig = '';
  /** Steps the operator unfolded. Survives a re-render; not a reload. */
  const opened = new Set<string>();
  let stopGlyphs: (() => void) | null = null;

  body.innerHTML = `
    <div class="capcom__top">
      <div class="rail" data-strip aria-label="missions"></div>
      <div class="rail__end">
        <div data-more hidden></div>
        <button class="chip" type="button" data-new-mission>+ NEW</button>
      </div>
    </div>
    <div class="tabs" role="tablist" data-tabs>
      <button class="tab" type="button" role="tab" data-tab="talk">TALK</button>
      <button class="tab" type="button" role="tab" data-tab="work">WORK<span class="tab__n" data-work-count></span></button>
      <button class="tab" type="button" role="tab" data-tab="events">EVENTS<span class="tab__n" data-events-count></span></button>
    </div>
    <div class="band" data-band></div>
    <div data-handoff hidden></div>
    <div class="win__scroll scroll" data-log></div>
    <div class="capcom__status" data-status></div>
    <div class="ceo__in">
      <textarea class="input" rows="2" data-in aria-label="Message capcom" placeholder="${esc(composerHint('message capcom'))}"></textarea>
      <button class="slab-btn" type="button" data-send>SEND</button>
    </div>
  `;
  const modelHost = document.createElement('div');
  body.querySelector('.ceo__in')!.before(modelHost);
  const modelControl = mountCapcomModel(modelHost, cmd => hub.cmd(cmd), id => c.openTerminal(id), path => c.openFile({ path, agentId: capcomOf()?.id ?? null }));
  const log = body.querySelector<HTMLElement>('[data-log]')!;
  const stripEl = body.querySelector<HTMLElement>('[data-strip]')!;
  const moreHost = body.querySelector<HTMLElement>('[data-more]')!;
  const handoffHost = body.querySelector<HTMLElement>('[data-handoff]')!;
  let handoffSig = '';
  handoffHost.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const drop = target.closest<HTMLElement>('[data-notice-dismiss]');
    if (drop?.dataset.noticeDismiss) {
      dismissNotice(drop.dataset.noticeDismiss);
      // Vaciar aquí, no dejárselo a `render`: sin aviso su firma es la vacía,
      // que es la que ya había, y el repintado se saltaría con el aside puesto.
      handoffHost.innerHTML = ''; handoffSig = '';
      render();
      return;
    }
    const button = target.closest<HTMLElement>('[data-handoff-file]');
    if (!button?.dataset.handoffFile) return;
    c.openFile({ path: button.dataset.handoffFile, agentId: capcomOf()?.id ?? null });
  });
  // Abrir un aviso es una decisión: se recuerda, y sobrevive al re-render.
  handoffHost.addEventListener('toggle', (event) => {
    const details = event.target as HTMLDetailsElement;
    const id = details.closest<HTMLElement>('[data-notice]')?.dataset.notice;
    if (id) setNoticeOpen(id, details.open);
  }, true);
  const band = body.querySelector<HTMLElement>('[data-band]')!;
  const status = body.querySelector<HTMLElement>('[data-status]')!;
  const input = body.querySelector<HTMLTextAreaElement>('[data-in]')!;
  // The unsent line, per conversation, survives a reload (drafts.ts).
  const draft = drafts.bind(input, draftKey('capcom'));
  draft.restore();
  const tabsEl = body.querySelector<HTMLElement>('[data-tabs]')!;
  const workCount = body.querySelector<HTMLElement>('[data-work-count]')!;
  const eventsCount = body.querySelector<HTMLElement>('[data-events-count]')!;
  // The stamp is drawn from the window kind, and the kind stays `ceo` so the
  // wiring in main.ts keeps working. The operator should not have to know that.
  const stamp = ctx.win.el.querySelector('.win__stamp');
  if (stamp) stamp.textContent = 'capcom';

  let pinned = true;
  /**
   * Dónde iba la lectura de cada conversación. Volver a una misión y aterrizar
   * en el fondo es perder el sitio donde la dejaste; sobrevive al cambio de
   * pestaña, no a la recarga, igual que un scroll.
   */
  let sig = '';
  let statusSig = '';
  let historyAgent = '';
  let historyText = '';
  let historyNext: number | null = 0;
  let historyBefore = 0;
  let historyLoading = false;
  let historyError = '';
  let historyDisposed = false;
  async function loadHistory() {
    const a = capcomOf(); if (!a || historyLoading || historyNext === null) return;
    const id = a.id; historyLoading = true; historyError = ''; sig = ''; render();
    try {
      const page = await hub.cmd({ k: 'handoff:history', agentId: id, offset: historyNext, before: historyBefore }) as HistoryPage;
      if (historyDisposed || historyAgent !== id) return;
      historyText = page.text + '\n' + historyText; historyNext = page.next;
    } catch (e) { if (historyAgent === id) historyError = e instanceof Error ? e.message : String(e); }
    finally { historyLoading = false; if (!historyDisposed) { sig = ''; render(); } }
  }
  log.addEventListener('click', event => { if ((event.target as HTMLElement).closest('[data-earlier]')) void loadHistory(); });
  /** The fleet's names, for turning callsigns in CAPCOM's prose into places. Rebuilt per render. */
  let refs: RefIndex = refIndex([]);
  log.addEventListener('scroll', () => {
    pinned = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
  });

  const setTab = (t: Tab) => {
    if (tab === t) return;
    tab = t;
    try { localStorage.setItem('orca.capcom.tab', t); } catch {}
    sig = ''; pinned = true;
    render();
    if (t === 'work') log.scrollTop = 0;
  };
  tabsEl.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab as Tab)));
  function paintTabs() {
    tabsEl.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  body.querySelector<HTMLButtonElement>('[data-new-mission]')!.addEventListener('click', async (e) => {
    const button = e.currentTarget as HTMLButtonElement;
    button.disabled = true;
    // Nace y se abre en su propia ventana, que es donde se le escribe: crear
    // una misión y no tener dónde decirle qué es sería media orden.
    try { const mission = await hub.createMission(); store.upsertMission(mission); c.openMission(mission.id, { tab: 'talk' }); }
    catch (err) { c.note(`Could not create mission: ${String(err)}`, 'warn'); }
    finally { button.disabled = false; }
  });

  /**
   * La cinta de misiones: las abiertas, siempre a la vista, un clic cada una.
   *
   * Era un selector de vista —pulsar una cambiaba ESTA ventana por su
   * conversación— y ahora es una puerta: cada misión tiene ventana propia, así
   * que pulsar una la abre o la trae al frente. La otra puerta es el panel del
   * HUD, y las dos llaman a lo mismo (`c.openMission`), de manera que no puede
   * haber dos maneras de estar en una misión.
   *
   * Esta ventana se queda con lo que siempre fue suyo: la sesión de CAPCOM.
   * El punto de cada pestaña lleva la fase que ya lee el panel del HUD
   * (`missionRows`), así que la ventana y el panel no pueden discrepar; el
   * ámbar es «te toca a ti». Lo terminado se pliega bajo MORE.
   */
  function renderRail() {
    const rows = missionRows(visibleMissions(store.world.missions ?? {}), (id) => store.world.agents[id]);
    const { strip, folded } = railSplit(rows, store.activeMissionId);
    const s = JSON.stringify([store.activeMissionId, strip.map((r) => [r.id, r.title, r.phase]), folded.map((r) => [r.id, r.title])]);
    if (s === railSig || missionPicker?.isOpen()) return;
    railSig = s;

    const tab = (r: MissionRow) => `<button class="rail__c${r.id === store.activeMissionId ? ' is-on' : ''}" type="button"
      data-conv="${esc(r.id)}"
      title="${esc(`${r.title} · ${PHASE_WORD[r.phase]} · moved ${ago(r.at)} · opens its own window`)}"
      style="--dot:${PHASE_DOT[r.phase]}"><i class="rail__dot"></i><b>${esc(r.title)}</b><span class="rail__ago">${ago(r.at)}</span></button>`;
    stripEl.innerHTML = strip.length ? strip.map(tab).join('')
      : `<span class="rail__none px px--tiny">NO OPEN MISSIONS</span>`;
    stripEl.querySelectorAll<HTMLElement>('[data-conv]').forEach((b) =>
      b.addEventListener('click', () => c.openMission(b.dataset.conv!)));
    // Que la que está delante se vea sin buscarla: la cinta puede haber crecido
    // más allá de su ancho.
    stripEl.querySelector<HTMLElement>('.rail__c.is-on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    missionPicker?.dispose(); missionPicker = null;
    moreHost.replaceChildren();
    moreHost.hidden = folded.length === 0;
    if (!folded.length) return;
    missionPicker = pick({ name: 'finished missions', placeholder: `MORE ${folded.length}`, value: '', search: folded.length > 6,
      options: folded.map((r) => ({ value: r.id, label: r.title, hint: PHASE_WORD[r.phase] })),
      onChange: (id) => { if (id) c.openMission(id); },
    });
    moreHost.appendChild(missionPicker.el);
  }

  /* ── Pieces ─────────────────────────────────────────────────────── */

  /** The workers CAPCOM has out there. A mission's own crew is in its window. */
  function workers(): Agent[] {
    return Object.values(store.world.agents)
      .filter((a) => a.role !== 'capcom' && (a.mission || a.squad || a.parentId))
      .sort((a, b) => Number(b.state === 'blocked') - Number(a.state === 'blocked') || b.startedAt - a.startedAt);
  }

  /** Every event this window has seen around CAPCOM, oldest first. */
  function events(a: Agent | undefined): CapcomEntry[] {
    const saved: CapcomEntry[] = (store.world.capcomHandoffs ?? []).map((h) => ({ id: h.id, at: h.at, role: 'system', text: handoffText(h), note: 'SESSION HANDOFF' }));
    for (const e of a?.modelControl?.events ?? []) saved.push({ id: e.id, at: e.at, role: 'system', text: e.text, note: 'MODEL CHANGE' });
    const entries = a ? capcomLog(a, store.trafficFor(a.id), store.world.feed, LOGS.get(key) ?? []) : LOGS.get(key) ?? [];
    LOGS.set(key, entries);
    const unique = new Map(saved.map((e) => [e.id, e]));
    for (const e of entries) if (e.role === 'system' && !unique.has(e.id.replace(/^f:/, ''))) unique.set(e.id, e);
    return [...unique.values()].sort((x, y) => x.at - y.at);
  }

  /** Local echoes for CAPCOM's own conversation that the transcript has not confirmed yet. */
  function echoes(items: readonly TalkItem[]): OutgoingMessage[] {
    const mine = store.outgoing.filter((m) => m.agentId === null && !m.missionId);
    return pendingEchoes(mine, (m) => echoLanded(m.text, m.at, items)).slice(-3);
  }


  /** Cuánto de una misión se lee desde GENERAL antes de que sea la misión. */
  const GLIMPSE = 260;
  /** Quién dijo la línea que la mirilla enseña. Un worker tiene nombre; tú, no. */
  function saidBy(m: MissionMessage): string {
    if (m.role === 'human') return 'YOU';
    return store.world.agents[m.agentId ?? '']?.callsign ?? m.role.toUpperCase();
  }
  function cut(text: string, max: number): string {
    const raw = text.trim();
    if (raw.length <= max) return raw;
    const head = raw.slice(0, max);
    const space = head.lastIndexOf(' ');
    return `${(space > max * 0.7 ? head.slice(0, space) : head).trimEnd()}…`;
  }

  function groupHtml(g: TalkGroup): string {
    const t = `<span class="talk__t">${clock(g.at)}</span>`;
    switch (g.role) {
      case 'human':
        return `<div class="talk__g is-human"><div class="talk__who px">YOU ${t}</div><div class="talk__text mono">${esc(g.text)}</div></div>`;
      case 'fleet': {
        const e = g.escalationId ? store.world.escalations[g.escalationId] : undefined;
        const live = e && (e.status === 'pending' || e.status === 'with_ceo');
        return `<div class="talk__g is-fleet"><div class="talk__who px">FLEET ${t}</div><div>
          <div class="talk__text talk__ctx mono">${esc(g.text)}</div>
          ${g.escalationId ? `<button class="chip" type="button" data-esc="${esc(g.escalationId)}"${live ? ' style="--chip-state:var(--amber)"' : ''}>${live ? 'STILL OPEN · ANSWER' : e ? esc(e.status.toUpperCase()) : 'QUESTION'}</button>` : ''}
        </div></div>`;
      }
      case 'mission': {
        const mission = g.missionId ? store.world.missions?.[g.missionId] : undefined;
        const seen = mission ? missionGlimpse(mission, g.at) : null;
        return `<div class="talk__g is-mission"><div class="talk__who px">MISSION ${t}</div><div>
          <button class="chip" type="button" data-mission-go="${esc(g.missionId ?? '')}"><span>${esc(mission?.title ?? g.text.split('\n')[0] ?? 'mission')}</span> ▸</button>
          ${seen?.said ? `<div class="talk__text mono"><b>${esc(saidBy(seen.said))}</b> ${esc(cut(seen.said.text, GLIMPSE))}</div>` : ''}
          ${seen?.back ? `<div class="talk__text talk__ctx mono"><b>CAPCOM</b> ${mdLite(cut(seen.back.text, GLIMPSE), refs)}</div>` : ''}
          <div class="talk__ctx mono">${seen?.said ? 'The mission has the rest.' : "CAPCOM was handed this mission's conversation. Open it to read the exchange."}</div>
        </div></div>`;
      }
      case 'system':
        return `<div class="talk__g is-system"><div class="talk__who px">ORCA ${t}</div><div class="talk__text talk__ctx mono">${esc(g.text)}</div></div>`;
      case 'capcom':
        return `<div class="talk__g is-capcom"><div class="talk__who px">CAPCOM ${t}</div><div class="talk__body">${g.parts.map((p) =>
          p.kind === 'text' ? `<div class="talk__text mono">${mdLite(p.text, refs)}</div>` : talkStepHtml(p.step, opened.has(p.step.id))).join('')}</div></div>`;
    }
  }

  function echoHtml(m: OutgoingMessage): string {
    return `<div class="talk__g is-human is-echo"><div class="talk__who px">YOU <span class="talk__t">${clock(m.at)}</span></div><div>
      <div class="talk__text mono">${esc(m.text)}</div>
      <div class="talk__echo px" style="color:var(${m.status === 'failed' ? '--amber' : '--ink-dimmer'})">${esc(echoLabel(m))}${m.detail ? ` · ${esc(m.detail)}` : ''}</div>
    </div></div>`;
  }

  /**
   * The row that says CAPCOM is on it, appended while it is. When the reply
   * already shows the running tool as a step, the row would say it twice, so
   * it stays out; thinking has no step until the block closes, so it shows.
   */
  function liveHtml(a: Agent, stepShowing = false): string {
    // What the pane shows it typing, if the collector can read the pane. The
    // finished block replaces it the moment the transcript has it.
    const typing = store.world.talkLive?.[a.id];
    if (typing && (a.state === 'thinking' || a.state === 'working')) {
      return `<div class="talk__g is-capcom is-live"><div class="talk__who px">CAPCOM <span class="talk__t">typing</span></div><div class="talk__text mono is-streaming">${esc(typing)}</div></div>`;
    }
    const since = a.updatedAt ? Math.max(0, Math.round((Date.now() - a.updatedAt) / 1000)) : 0;
    const dur = since >= 2 ? ` · ${since}s` : '';
    if (a.state === 'thinking' || a.state === 'booting') {
      return `<div class="talk__g is-capcom is-live"><div class="talk__who px">CAPCOM</div><div class="talk__live"><span class="glyphs" data-glyphs></span><span class="px px--tiny">THINKING${dur}</span></div></div>`;
    }
    if (a.state === 'working' && !stepShowing) {
      return `<div class="talk__g is-capcom is-live"><div class="talk__who px">CAPCOM</div><div class="talk__live"><i class="talk__dot"></i><b class="px px--tiny">${esc(a.tool ? toolLabel(a.tool) : 'WORKING')}${dur}</b><span class="mono">${esc(a.toolDetail ?? '')}</span></div></div>`;
    }
    return '';
  }

  function blockHtml(a: Agent, now: number): string {
    const esca = a.state === 'blocked' ? escalationFor(a) : undefined;
    if (esca) {
      return `<div class="block" data-block="${esc(esca.id)}">
        <div class="block__k"><span>${esc(a.block?.kind ?? 'question')} · WAITING ${ago(esca.askedAt, now)}</span></div>
        <div class="block__q mono">${esc(esca.question)}</div>
        ${esca.context ? `<div class="mono" style="margin-top:6px;color:var(--ink-dim)">${esc(esca.context)}</div>` : ''}
        <div class="block__opts">${esca.options.map((o) => `<button class="slab-btn slab-btn--amber slab-btn--sm" type="button" data-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div>
        ${esca.optionsOnly ? '' : `<div class="row" style="margin-top:8px"><textarea class="input" rows="2" data-ans aria-label="Answer" placeholder="${esc(composerHint('type an answer'))}"></textarea><button class="slab-btn slab-btn--amber slab-btn--sm slab-btn--fit" type="button" data-ans-send>SEND</button></div>`}
      </div>`;
    }
    if (a.state === 'blocked' && a.block) {
      return `<div class="block">
        <div class="block__k"><span>${esc(a.block.kind)} · ${ago(a.block.since, now)}</span></div>
        <div class="block__q mono">${esc(a.block.summary)}</div>
      </div>`;
    }
    return '';
  }

  /** Wire what a freshly rendered log can do. */
  function wire(a?: Agent) {
    log.querySelectorAll<HTMLElement>('[data-esc]').forEach((b) => b.addEventListener('click', () => c.openInterrupt(b.dataset.esc!)));
    log.querySelectorAll<HTMLElement>('[data-question]').forEach((b) => b.addEventListener('click', () => c.openInterrupt(b.dataset.question!)));
    log.querySelectorAll<HTMLElement>('[data-mission-go]').forEach((b) => b.addEventListener('click', () => { if (b.dataset.missionGo) c.openMission(b.dataset.missionGo); }));
    log.querySelectorAll<HTMLDetailsElement>('[data-step]').forEach((d) => d.addEventListener('toggle', () => {
      if (d.open) opened.add(d.dataset.step!); else opened.delete(d.dataset.step!);
    }));
    log.querySelectorAll<HTMLElement>('[data-worker]').forEach((b) => b.addEventListener('click', () => c.openAgent(b.dataset.worker!)));
    log.querySelectorAll<HTMLElement>('[data-locate]').forEach((b) => b.addEventListener('click', () => c.go(b.dataset.locate!)));
    // A callsign in CAPCOM's prose: click flies there, ⌘click (ctrl on a PC) opens it too.
    log.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault();
      const id = b.dataset.go!;
      if (!store.world.agents[id]) { c.note(`${b.textContent ?? id} is not on the field any more`, 'warn'); return; }
      c.go(id);
      if (e.metaKey || e.ctrlKey) c.openAgent(id);
    }));
    log.querySelectorAll<HTMLElement>('[data-go-squad]').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault();
      const name = b.dataset.goSquad!;
      c.pushView();
      if (!c.field.frameSquad(name, b.dataset.goProject ?? null) && !c.field.frameSquad(name)) { c.note(`squad ${name} is not on the field any more`, 'warn'); return; }
      if (e.metaKey || e.ctrlKey) c.openSquad(name);
    }));
    log.querySelectorAll<HTMLElement>('[data-terminal]').forEach((b) => b.addEventListener('click', () => c.openTerminal(b.dataset.terminal!)));
    log.querySelector('[data-fleet]')?.addEventListener('click', () => c.openFleet());
    const blockEl = log.querySelector<HTMLElement>('[data-block]');
    if (blockEl && a) {
      const escId = blockEl.dataset.block!;
      blockEl.querySelectorAll<HTMLElement>('[data-opt]').forEach((b) => b.addEventListener('click', () => { slabFlash(b); c.answer(escId, b.dataset.opt!, null); }));
      const ans = blockEl.querySelector<HTMLTextAreaElement>('[data-ans]');
      const ansBtn = blockEl.querySelector<HTMLElement>('[data-ans-send]');
      const sendAns = () => { const v = ans?.value.trim(); if (v) { slabFlash(ansBtn); c.answer(escId, v, null); ans!.value = ''; } };
      ansBtn?.addEventListener('click', sendAns);
      // Varias líneas: Enter salta, ⌘/⌃Enter manda. El bloque se repinta entero,
      // así que el listener se va con el elemento viejo.
      if (ans) bindComposer(ans, sendAns);
    }
    stopGlyphs?.(); stopGlyphs = null;
    const glyphHost = log.querySelector<HTMLElement>('[data-glyphs]');
    if (glyphHost) stopGlyphs = glyphBurst(glyphHost);
    // TALK and EVENTS read newest-last and follow the tail; WORK is a list
    // and starts at the top like one.
    if (pinned && tab !== 'work') log.scrollTop = log.scrollHeight;
  }

  /* ── TALK ───────────────────────────────────────────────────────── */

  function renderTalkGeneral(a: Agent) {
    const now = Date.now();
    const items: TalkItem[] = [...(store.world.talk?.[a.id] ?? []).map(item => item.kind === 'prompt' && item.text.startsWith('[ORCA CONTEXT EVENT — information only]\nYou are preparing a CAPCOM provider handoff.')
      ? { ...item, text: '[ORCA CONTEXT EVENT — information only]\nThis session received the archived conversation and pending-work checkpoint. Load previous conversation to read earlier messages.' } : item), ...(a.modelControl?.events ?? []).map(e => ({ id: e.id, agentId: a.id, at: e.at, kind: 'prompt' as const, text: `[ORCA CONTEXT EVENT — information only]\n${e.text}` }))].sort((x, y) => x.at - y.at);
    if (historyAgent !== a.id) { historyAgent = a.id; historyText = ''; historyNext = 0; historyError = ''; historyBefore = items[0]?.at ?? Date.now(); }
    const groups = foldTalk(items);
    const echo = echoes(items);
    const esca = a.state === 'blocked' ? escalationFor(a) : undefined;
    const live = a.state === 'thinking' || a.state === 'working' || a.state === 'booting';
    const s = JSON.stringify([
      'talk', a.id, a.state, a.tool, a.toolDetail, esca?.id, esca?.status,
      items.length, items[items.length - 1]?.id,
      echo.map((m) => [m.id, m.status, m.elapsedMs]),
      groups.filter((g) => g.escalationId).map((g) => store.world.escalations[g.escalationId!]?.status),
      // La mirilla de una misión vive de su conversación, no del transcript:
      // sin esto, CAPCOM contesta dentro de la misión y aquí no cambia nada.
      groups.filter((g) => g.missionId).map((g) => [g.missionId, store.world.missions?.[g.missionId!]?.updatedAt]),
      store.world.talkLive?.[a.id] ?? null,
      // While it works the row carries a seconds counter; otherwise a coarse clock is enough.
      live ? Math.floor(now / 1000) : Math.floor(now / 30000),
    ]);
    if (s === sig) return;
    sig = s;
    const last = groups[groups.length - 1];
    const stepShowing = !!last && last.role === 'capcom' && last.parts.some((p) => p.kind === 'step' && p.step.kind === 'tool' && !p.step.result);
    // Por hora, no por fuente: un eco todavía sin confirmar pertenece al minuto
    // en que lo escribiste, no al final de todo lo que CAPCOM dijo desde entonces.
    const talk = timeOrdered([
      ...groups.map((g) => ({ at: g.at, html: groupHtml(g) })),
      ...echo.map((m) => ({ at: m.at, html: echoHtml(m) })),
    ]);
    const body = groups.length || echo.length
      ? `<div class="talk">${talk}${liveHtml(a, stepShowing)}</div>`
      : `<div class="ceo__empty mono">Nothing said yet. CAPCOM commands the fleet on your behalf — it surveys, spawns agents with real briefs, unblocks them, and absorbs the questions they raise so you only see the ones that need you.${
        items.length === 0 && a.lastSay ? '<br/><br/><span style="color:var(--ink-dimmer)">This collector does not send the conversation yet · restart it to see the transcript here.</span>' : ''}</div>`;
    log.dataset.fileAgent = a.id;
    const archive = `<div class="capcom__archive">${historyNext !== null ? `<button type="button" class="chip" data-earlier ${historyLoading ? 'disabled' : ''}>${historyLoading ? 'LOADING HISTORY…' : historyText ? 'LOAD EARLIER MESSAGES' : 'LOAD PREVIOUS CONVERSATION'}</button>` : '<span class="mono">Beginning of saved conversation</span>'}${historyError ? `<p class="mono">${esc(historyError)}</p>` : ''}${historyText ? `<div class="md capcom__archive-text">${mdLite(historyText)}</div><div class="mono capcom__archive-boundary">CURRENT SESSION</div>` : ''}</div>`;
    log.innerHTML = linkPaths(`${archive}${blockHtml(a, now)}${body}`, { root: store.world.projects[a.projectId]?.path ?? null });
    wire(a);
  }

  function renderTalkApi() {
    const ceo = store.world.ceo;
    const s = 'api' + ceo.messages.map((m) => `${m.id}:${m.text.length}:${m.streaming ? 1 : 0}:${m.actions.map((a) => a.status).join('')}`).join('|') + `|${ceo.thinking}|${store.linkUp}`;
    if (s === sig) return;
    sig = s;
    if (!ceo.messages.length) {
      log.innerHTML = `<div class="ceo__empty mono">CAPCOM commands the fleet on your behalf. It surveys, spawns agents with real briefs, unblocks them, and absorbs the questions they raise so you only see the ones that need you.${store.linkUp ? '' : '<br/><br/><span style="color:var(--red)">LINK DOWN · nothing you say here will arrive until it comes back.</span>'}</div>`;
      return;
    }
    log.innerHTML = `<div class="talk">${ceo.messages.map((m) => `
      <div class="talk__g is-${m.role === 'ceo' ? 'capcom' : m.role}">
        <div class="talk__who px" title="${clock(m.at)}">${m.role === 'human' ? 'YOU' : m.role === 'ceo' ? 'CAPCOM' : 'SYS'}</div>
        <div>
          <div class="talk__text mono ${m.streaming ? 'is-streaming' : ''}">${m.role === 'ceo' ? mdLite(m.text, refs) : esc(m.text)}</div>
          ${m.actions.length ? `<div class="ceo__acts">${m.actions.map((a) => `<div class="ceo__act is-${a.status} mono" title="${esc(a.detail ?? '')}"><i></i><span>${esc(a.summary || a.name)}</span></div>`).join('')}</div>` : ''}
          ${m.escalationId ? `<button class="chip" type="button" data-esc="${esc(m.escalationId)}" style="margin-top:6px;--chip-state:var(--amber)">OPEN INTERRUPT</button>` : ''}
        </div>
      </div>`).join('')}${ceo.thinking && !ceo.messages.some((m) => m.streaming) ? `<div class="talk__g is-capcom is-live"><div class="talk__who px">CAPCOM</div><div class="talk__live"><span class="glyphs" data-glyphs></span><span class="px px--tiny">THINKING</span></div></div>` : ''}</div>`;
    wire();
  }

  /* ── WORK ───────────────────────────────────────────────────────── */

  function renderWork() {
    const agents = workers();
    const s = JSON.stringify(['work', agents.map((a) => [a.id, a.callsign, a.state, a.block?.summary, a.mission, a.title, a.squad, a.pane, store.world.projects[a.projectId]?.code])]);
    if (s === sig) return;
    sig = s;
    log.innerHTML = `
      <p class="capcom__note mono">Everyone CAPCOM has out there. Open one for its mission and results; LOCATE shows it on the field; TERMINAL opens its CLI.</p>
      ${agents.length ? agents.slice(0, 60).map((a) => `
      <div class="sec capcom__worker">
        <div class="row row--wrap" style="gap:6px">
          <button class="chip" type="button" data-worker="${esc(a.id)}" style="--chip-state:${stateVar(a)}">${esc(a.callsign)} · ${esc(stateWord(a))}</button>
          <span class="px px--tiny">${esc(store.world.projects[a.projectId]?.code ?? '')}${a.squad ? ` · ${esc(a.squad)}` : ''}</span>
          <button class="chip" type="button" data-locate="${esc(a.id)}">LOCATE</button>
          ${a.pane ? `<button class="chip" type="button" data-terminal="${esc(a.id)}">TERMINAL</button>` : ''}
        </div>
        <div class="mono capcom__mission">${esc(a.mission || a.title)}</div>
        ${a.block ? `<div class="mono" style="color:var(--amber)">${esc(a.block.summary)}</div>` : ''}
      </div>`).join('') : `<p class="sec mono">Nobody out there yet. Ask CAPCOM for something and it will spawn who it needs.</p>`}
      <div class="sec"><button class="chip" type="button" data-fleet>VIEW FULL FLEET</button></div>`;
    wire();
  }

  /* ── EVENTS ─────────────────────────────────────────────────────── */

  function renderEvents(a: Agent | undefined) {
    const entries = events(a);
    const s = JSON.stringify(['events', entries.length, entries[entries.length - 1]?.id, a?.id]);
    if (s === sig) return;
    sig = s;
    log.innerHTML = entries.length ? `<div class="ceo__log">${entries.map((e) => {
      const peerName = e.peerId ? store.world.agents[e.peerId]?.callsign ?? e.peerCallsign ?? e.peerId : e.peerCallsign ?? (e.dir ? 'FLEET' : '');
      const head = e.kind
        ? `<span class="msg__kind px is-${e.kind}">${e.kind}</span> <b>${e.dir === 'out' ? '→' : '←'} ${esc(peerName)}</b> `
        : '';
      return `<div class="ceo__m is-system">
        <div class="ceo__who px" title="${clock(e.at)}">${clock(e.at)}</div>
        <div>
          <div class="ceo__text mono">${head}${esc(e.text)}</div>
          ${e.note ? `<div class="capcom__note2 mono">${esc(e.note)}</div>` : ''}
        </div>
      </div>`;
    }).join('')}</div>` : '<div class="ceo__empty mono">Nothing yet. Orders CAPCOM passes down to the fleet and telemetry about it land here, out of the way of the conversation.</div>';
    wire();
  }

  /* ── The strip ──────────────────────────────────────────────────── */

  function renderStatus(a: Agent | undefined) {
    const ceo = store.world.ceo;
    const parts: string[] = [];
    let s: string;
    // Un relevo en marcha manda sobre el estado de la sesión: la que se va está
    // ociosa mientras se prepara la que llega, y anunciar IDLE durante los dos
    // minutos que eso dura es lo que hace pensar que no está pasando nada.
    const moving = modelControl.transition();
    if (a) {
      const peer = a.state === 'blocked' && a.block?.kind === 'peer';
      const now = moving ?? (a.state === 'working' && a.tool ? `${toolLabel(a.tool)} · ${a.toolDetail ?? ''}` : a.state === 'thinking' ? 'composing' : a.state === 'blocked' ? a.block?.summary ?? 'blocked' : '');
      s = JSON.stringify(['cap', a.state, now, Math.round(a.metrics.tokensPerSec), a.metrics.costUSD.toFixed(2), a.pane, store.linkUp, moving]);
      if (s === statusSig) return;
      statusSig = s;
      parts.push(`<span class="status ${moving ? 'is-on' : a.state === 'blocked' && !peer ? 'is-alert' : a.state === 'working' || a.state === 'thinking' ? 'is-on' : a.state === 'dead' ? 'is-dead' : ''}">${esc(moving ? 'CHANGING' : stateWord(a))}</span>`);
      if (now) parts.push(`<span class="capcom__now mono" title="${esc(now)}">${esc(now)}</span>`);
      parts.push(`<span class="px px--tiny capcom__stat">${Math.round(a.metrics.tokensPerSec)} TOK/S</span>`);
      parts.push(`<span class="px px--tiny capcom__stat">${esc(money(a.metrics.costUSD))}</span>`);
      parts.push(`<span class="capcom__acts"><button class="chip" type="button" data-term title="${a.pane ? 'The CLI itself: the whole conversation, live, and a keyboard into it' : 'No pane: this CAPCOM runs with --bg (no tmux on its machine)'}">TERM</button><button class="chip" type="button" data-fly>FLY</button></span>`);
      if (!store.linkUp) parts.push('<span class="px px--tiny" style="color:var(--red)">LINK DOWN</span>');
      band.hidden = false;
      band.classList.toggle('is-off', !moving && a.state !== 'working' && a.state !== 'thinking');
      band.style.setProperty('--band-t', `${Math.max(0.35, 1.6 - Math.min(1, a.metrics.tokensPerSec / 80) * 1.2)}s`);
      ctx.setCallsign('CAPCOM', store.world.projects[a.projectId]?.code);
      ctx.setState(a.state === 'blocked' && !peer ? 'blocked' : a.state === 'dead' ? 'dead' : null, stateVar(a));
    } else {
      s = JSON.stringify(['api', ceo.thinking, store.linkUp, moving]);
      if (s === statusSig) return;
      statusSig = s;
      // El hueco del relevo: la sesión vieja ya no está y la nueva aún no se
      // ha publicado. Sin esto la ventana pasa a hablar de la API, como si no
      // hubiera mando — justo en el minuto en que se está fabricando uno.
      if (moving) parts.push(`<span class="status is-on">CHANGING</span><span class="capcom__now mono">${esc(moving)}</span>`);
      else parts.push(`<span class="px px--tiny">${API_NOTE}</span>`);
      band.hidden = !moving;
      band.classList.toggle('is-off', !moving);
      ctx.setCallsign('CAPCOM');
      ctx.setState(null, ceo.thinking ? 'var(--st-thinking)' : 'var(--lime)');
    }
    status.innerHTML = parts.join('');
    const termBtn = status.querySelector<HTMLElement>('[data-term]');
    termBtn?.addEventListener('click', () => {
      if (!a) return;
      if (!a.pane) { c.note('CAPCOM has no pane · it runs with --bg on a machine without tmux, so there is no screen to attach', 'warn'); return; }
      const r = termBtn.getBoundingClientRect();
      c.openTerminal(a.id, { x: r.right, y: r.top });
    });
    status.querySelector('[data-fly]')?.addEventListener('click', () => { if (a) c.go(a.id); });
  }

  /* ── Render ─────────────────────────────────────────────────────── */

  function render() {
    refs = refIndex(store.world.agents);
    const a = capcomOf();
    modelControl.update(a, store.linkUp);
    const handoff = (store.world.capcomHandoffs ?? []).filter((h) => !a || h.toId === a.id)
      .filter((h) => !noticeDismissed(`handoff:${h.id}`)).at(-1);
    handoffHost.hidden = !handoff || tab !== 'talk';
    const nextHandoffSig = handoff ? JSON.stringify(handoff) : '';
    if (handoffSig !== nextHandoffSig) {
      handoffSig = nextHandoffSig;
      handoffHost.innerHTML = handoff ? handoffNotice(handoff) : '';
    }
    paintTabs();
    renderRail();
    renderStatus(a);
    const n = workers().length;
    workCount.textContent = n ? ` ${n}` : '';
    const blocked = workers().filter((w) => w.state === 'blocked').length;
    tabsEl.querySelector('[data-tab="work"]')?.classList.toggle('is-hot', blocked > 0);
    const ev = events(a).length;
    eventsCount.textContent = ev ? ` ${ev}` : '';

    if (a) {
      ctx.setTitle(a.state === 'working' && a.tool ? `${toolLabel(a.tool)} · ${a.toolDetail ?? ''}` : a.state === 'thinking' ? 'THINKING' : a.title || a.mission || 'COMMAND SESSION');
    } else {
      const under = Object.values(store.world.agents).filter((x) => x.state !== 'done' && x.state !== 'dead').length;
      ctx.setTitle(`${store.world.ceo.thinking ? 'THINKING · ' : ''}${under} UNDER COMMAND · ${store.world.fleet.blocked} BLOCKED`);
    }

    if (tab === 'work') { renderWork(); return; }
    if (tab === 'events') { renderEvents(a); return; }
    if (a) renderTalkGeneral(a); else renderTalkApi();
  }

  /** The hub decides who hears this; the window only sends it. */
  function send(text: string) {
    const t = text.trim();
    if (!t) return false;
    if (!store.linkUp) { c.note('link down · CAPCOM cannot hear you', 'warn'); return false; }
    hub.say(t);
    pinned = true;
    if (tab !== 'talk') setTab('talk');
    return true;
  }
  const sendBtn = body.querySelector<HTMLElement>('[data-send]')!;
  // §6.2: the slab inverts to ink for a frame as the line leaves. The echo in
  // TALK carries the collector's receipt independently of the reply.
  const sent = () => { input.value = ''; draft.clear(); };
  sendBtn.addEventListener('click', () => { slabFlash(sendBtn); if (send(input.value)) sent(); });
  // Enter salta línea; manda ⌘/⌃Enter y manda el botón. Ver `windows/composer.ts`.
  const unbindComposer = bindComposer(input, () => { slabFlash(sendBtn); if (send(input.value)) sent(); });
  // Un archivo soltado o pegado sube al hub y su ruta entra en el texto; el
  // lienzo deja aquí los que se soltaron fuera de toda baldosa (attach.ts).
  const unbindAttach = bindAttach(input, { key: draftKey('capcom'), upload: uploadFile, note: c.note });

  const off = store.on((e) => {
    if (e.k === 'missions' || e.k === 'ceo' || e.k === 'world' || e.k === 'link' || e.k === 'agents' || e.k === 'traffic'
      || e.k === 'feed' || e.k === 'escalations' || e.k === 'talk' || e.k === 'delivery') render();
  });
  // One second: the live row counts seconds while CAPCOM works, and the
  // signatures make an idle render a no-op.
  const tick = window.setInterval(render, 1000);
  render();
  setTimeout(() => { if (input.isConnected && document.activeElement === document.body) input.focus(); }, 80);
  return { dispose() { historyDisposed = true; modelControl.dispose(); missionPicker?.dispose(); off(); clearInterval(tick); stopGlyphs?.(); unbindComposer(); unbindAttach(); draft.dispose(); LOGS.delete(key); } };
}

/** The name this window has in the plan. `mountCeo` stays for the wiring. */
export const mountCapcom = mountCeo;
