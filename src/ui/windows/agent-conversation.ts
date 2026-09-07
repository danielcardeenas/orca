import { hub } from '../net/client.ts';
import type { HistoryPage } from '../../shared/provider-handoff.ts';
import { store } from '../store.ts';
import { esc, stateWord } from '../util.ts';
import { foldTalk, echoLanded } from './talk.ts';
import { talkStepHtml } from './talk-step.ts';
import { mdLite } from './markdown.ts';
import { linkPaths } from './paths.ts';

/** A chronological transcript. Updates preserve expanded steps and reading position. */
export function mountAgentConversation(host: HTMLElement, agentId: string) {
  host.innerHTML = `<div class="agent-thread scroll" tabindex="0" aria-label="Conversation history" data-thread data-file-agent="${agentId}"></div>
    <button class="btn agent-thread__latest" type="button" data-latest hidden>Latest messages</button>`;
  const thread = host.querySelector<HTMLElement>('[data-thread]')!;
  const latest = host.querySelector<HTMLButtonElement>('[data-latest]')!;
  let archive = ''; let offset: number | null = 0; let loading = false; let archiveError = ''; let before: number | undefined; let disposed = false;
  let signature = '';
  let first = true;
  const bottom = () => thread.scrollHeight - thread.clientHeight - thread.scrollTop < 64;
  latest.addEventListener('click', () => { thread.scrollTop = thread.scrollHeight; latest.hidden = true; });
  thread.addEventListener('scroll', () => { if (bottom()) latest.hidden = true; });
  function render() {
    const a = store.knownAgent(agentId);
    const items = store.world.talk?.[agentId] ?? [];
    const echoes = store.outgoing.filter((m) => m.agentId === agentId && !echoLanded(m.text, m.at, items));
    const live = store.world.talkLive?.[agentId];
    const next = JSON.stringify([items, echoes, live, a?.state, a?.pane, a?.block, a?.lastSay, a?.lastPrompt, a?.tool, a?.continuation, a?.modelControl?.events, archive, offset, loading, archiveError]);
    if (signature === next) return;
    signature = next;
    const follow = first || bottom();
    const top = thread.scrollTop;
    const opened = new Set([...thread.querySelectorAll<HTMLDetailsElement>('details[open]')].map((d) => d.dataset.step));
    const time = (at: number) => `<time class="talk__t" datetime="${new Date(at).toISOString()}">${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>`;
    const groups = foldTalk(items);
    // Every path the agent wrote opens in ORCA's viewer; relative ones are its project's.
    const scope = { root: store.world.projects[a?.projectId ?? '']?.path ?? null };
    thread.innerHTML = linkPaths(`<div class="talk">
    ${a?.continuation ? `<div class="talk__ctx mono">ORCA · Continued from ${esc(a.continuation.fromId)}. Previous history is preserved in ${esc(a.continuation.historyPath)}.</div>` : ''}
    ${a?.continuation && offset !== null ? `<button class="chip" type="button" data-earlier ${loading ? 'disabled' : ''}>${loading ? 'LOADING…' : archive ? 'LOAD EARLIER MESSAGES' : 'LOAD PREVIOUS CONVERSATION'}</button>` : ''}
    ${archiveError ? `<div role="status" class="mono">${esc(archiveError)}</div>` : ''}
    ${archive ? `<div class="capcom__archive mono">${mdLite(archive)}</div>` : ''}
    ${(a?.modelControl?.events ?? []).map(e => `<div class="talk__ctx mono">ORCA ${time(e.at)} · ${esc(e.text)}</div>`).join('')}
    ${groups.map((g) => {
      if (g.role === 'human' && g.text.startsWith('[ORCA CONTEXT EVENT — information only]\nYou are preparing a CAPCOM provider handoff.')) return `<div class="talk__ctx mono">ORCA supplied the archived conversation and pending-work checkpoint to prepare this session.</div>`;
      const assistant = g.role === 'capcom';
      return `<article class="talk__g ${assistant ? 'is-capcom' : g.role === 'human' ? 'is-human' : 'is-system'}">
        <div class="talk__who px">${assistant ? esc(a?.callsign ?? 'AGENT') : g.role === 'human' ? 'YOU' : 'CONTEXT'}${time(g.at)}</div>
        <div class="talk__body">${assistant ? g.parts.map((p) => {
          if (p.kind === 'text') return `<div class="talk__text mono">${mdLite(p.text)}</div>`;
          return talkStepHtml(p.step, opened.has(p.step.id));
        }).join('') : `<div class="talk__text mono">${esc(g.text)}</div>`}</div></article>`;
    }).join('')}
    ${!items.length ? `<div class="talk__ctx mono">${a?.lastPrompt || a?.lastSay ? 'Full history is not available yet. Latest recorded exchange:' : 'The conversation will appear here when the agent receives a message.'}</div>
      ${a?.lastPrompt ? `<article class="talk__g is-human"><div class="talk__who px">YOU</div><div class="talk__text mono">${esc(a.lastPrompt)}</div></article>` : ''}
      ${a?.lastSay ? `<article class="talk__g is-capcom"><div class="talk__who px">${esc(a.callsign)}</div><div class="talk__text mono">${mdLite(a.lastSay)}</div></article>` : ''}` : ''}
    ${echoes.map((m) => `<article class="talk__g is-human is-echo"><div class="talk__who px">YOU${time(m.at)}</div><div><div class="talk__text mono">${esc(m.text)}</div><div class="talk__echo px" style="color:var(${m.status === 'failed' ? '--amber' : '--ink-dimmer'})">${m.status === 'failed' ? 'Delivery unconfirmed — your draft is available to retry.' : m.status === 'sending' ? 'Sending…' : 'Sent · waiting for transcript'}${m.detail ? ` · ${esc(m.detail)}` : ''}</div></div></article>`).join('')}
    ${live ? `<article class="talk__g is-capcom is-live"><div class="talk__who px">${esc(a?.callsign ?? 'AGENT')}</div><div class="talk__text mono is-streaming">${esc(live)}</div></article>` : ''}
    ${a && (a.state === 'working' || a.state === 'thinking' || a.state === 'blocked') ? `<div class="agent-thread__activity mono" role="status">${a.state === 'blocked' ? `${esc(a.block?.summary ?? 'Waiting for input')}<div class="row"><button class="btn" data-open-details>Review request</button><button class="btn" data-open-terminal${a.pane ? '' : ' disabled title="No terminal available for this session"'}>Open terminal</button></div>` : esc(a.tool ? `Running ${a.tool}` : stateWord(a))}</div>` : ''}
    </div>`, scope);
    thread.querySelector('[data-earlier]')?.addEventListener('click', async () => {
      if (loading || offset === null) return;
      loading = true; archiveError = ''; before ??= items[0]?.at ?? Date.now(); render();
      const height = thread.scrollHeight; const scroll = thread.scrollTop;
      try { const page = await hub.cmd({ k: 'handoff:history', agentId, offset, before }) as HistoryPage; if (disposed) return; archive = page.text + archive; offset = page.next; }
      catch (e) { archiveError = String(e); }
      finally { loading = false; if (!disposed) { render(); thread.scrollTop = scroll + thread.scrollHeight - height; } }
    });
    thread.querySelector('[data-open-details]')?.addEventListener('click', () => host.parentElement?.querySelector<HTMLButtonElement>('[data-view="details"]')?.click());
    thread.querySelector('[data-open-terminal]')?.addEventListener('click', () => host.parentElement?.querySelector<HTMLButtonElement>('[data-view="terminal"]')?.click());
    if (follow) { thread.scrollTop = thread.scrollHeight; latest.hidden = true; }
    else { thread.scrollTop = top; latest.hidden = false; }
    first = false;
  }
  const off = store.on((e) => {
    if (e.k === 'world' || e.k === 'delivery' || ((e.k === 'talk' || e.k === 'agents') && e.ids.includes(agentId))) render();
  });
  render();
  return () => { disposed = true; off(); };
}
