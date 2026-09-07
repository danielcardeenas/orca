/**
 * Telemetry: what the fleet is saying, one line at a time.
 *
 * Click a line to fly to the agent that wrote it. `WARN+` hides the trace so
 * a busy fleet's feed is readable.
 */

import type { FeedItem } from '../../../shared/types.ts';
import { store } from '../../store.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { clock, esc } from '../../util.ts';
import { linkPaths } from '../paths.ts';

const MAX = 250;

export function mountFeed(ctx: WinCtx, c: Console) {
  const body = ctx.body;
  body.innerHTML = `
    <div class="sec row row--split" style="padding:6px 10px">
      <div class="row">
        <button class="chip is-on" type="button" data-f="all">ALL</button>
        <button class="chip" type="button" data-f="warn">WARN+</button>
      </div>
      <span class="px px--tiny" data-n></span>
    </div>
    <div class="win__scroll scroll" data-list></div>
  `;
  const list = body.querySelector<HTMLElement>('[data-list]')!;
  const nEl = body.querySelector<HTMLElement>('[data-n]')!;
  let filter: 'all' | 'warn' = 'all';
  let pinned = true;
  let lastId = '';

  list.addEventListener('scroll', () => { pinned = list.scrollTop + list.clientHeight >= list.scrollHeight - 24; });

  function line(f: FeedItem): string {
    // A path in a line opens the file; the click stops there and does not fly to the agent.
    const a = f.agentId ? store.knownAgent(f.agentId) : undefined;
    const scope = { root: store.world.projects[a?.projectId ?? '']?.path ?? null };
    return `<div class="feed__line is-${f.level}" ${f.agentId ? `data-agent="${esc(f.agentId)}" data-file-agent="${esc(f.agentId)}"` : ''}>
      <span class="feed__t mono">${clock(f.at)}</span><span class="feed__src">${esc(f.source)}</span><span class="feed__txt mono">${linkPaths(esc(f.text), scope)}</span></div>`;
  }

  function render(full = false) {
    const items = store.recentFeed(MAX).filter((f) => filter === 'all' || f.level === 'warn' || f.level === 'alert');
    nEl.textContent = `${items.length} LINES`;
    const tail = items[items.length - 1]?.id ?? '';
    if (!full && tail === lastId) return;
    lastId = tail;
    list.innerHTML = items.length ? items.map(line).join('') : `<p class="px px--tiny" style="padding:14px 12px;color:var(--ink-dim)">NO TELEMETRY YET.</p>`;
    list.querySelectorAll<HTMLElement>('[data-agent]').forEach((el) => el.addEventListener('click', () => c.go(el.dataset.agent!)));
    if (pinned) list.scrollTop = list.scrollHeight;
  }

  body.querySelectorAll<HTMLElement>('[data-f]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.f as 'all' | 'warn';
    body.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('is-on', x === b));
    render(true);
  }));

  const off = store.on((e) => { if (e.k === 'feed' || e.k === 'world') render(); });
  render(true);
  return { dispose: off };
}
