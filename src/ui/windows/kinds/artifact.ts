/**
 * An artifact: something an agent made, looked at where you are.
 *
 * Images and video render directly; HTML runs in a sandboxed frame that
 * cannot reach the hub; text is fetched and shown. PLACE pulls it out into
 * the field next to the agent that made it.
 */

import { store } from '../../store.ts';
import { authedUrl } from '../../net/client.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { ago, esc } from '../../util.ts';
import { slabFlash } from '../fx.ts';

export function mountArtifact(ctx: WinCtx, c: Console) {
  const id = ctx.win.spec.params?.artifactId ?? '';
  const body = ctx.body;
  let sig = '';

  function render() {
    const a = store.world.artifacts?.[id];
    if (!a) { body.innerHTML = `<p class="px px--tiny" style="padding:14px 12px">THIS ARTIFACT IS GONE.</p>`; return; }
    const agent = store.world.agents[a.agentId];
    const p = store.world.projects[a.projectId];
    ctx.setCallsign(agent?.callsign ?? '??', p?.code);
    ctx.setTitle(a.title);
    const url = authedUrl(a.url);
    const s = `${a.url}|${a.kind}|${a.placement ? 1 : 0}|${a.at}`;
    if (s === sig) return;
    sig = s;

    let view = '';
    if (!url) view = `<p class="px px--tiny" style="color:var(--ink-dim)">NOT FETCHED YET · THE HUB PULLS IT FROM ${esc(store.world.machines[a.machineId]?.hostname ?? a.machineId)} ON FIRST OPEN</p>`;
    else if (a.kind === 'image') view = `<img src="${esc(url)}" alt="${esc(a.title)}" />`;
    else if (a.kind === 'video') view = `<video src="${esc(url)}" controls muted playsinline></video>`;
    else if (a.kind === 'html') view = `<iframe sandbox="" src="${esc(url)}" title="${esc(a.title)}"></iframe>`;
    else view = `<pre class="mono" data-text>loading…</pre>`;

    body.innerHTML = `
      <div class="art">${view}</div>
      <div class="art__bar">
        <span class="art__path mono" title="${esc(a.path)}">${esc(a.path)}</span>
        <div class="row">
          <span class="px px--tiny">${esc(a.kind)} · ${ago(a.at)}</span>
          ${url ? `<button class="btn" type="button" data-raw data-key="r">RAW</button>` : ''}
        </div>
      </div>
      <div class="art__go">
        <button class="slab-btn${a.placement ? ' slab-btn--ghost' : ''}" type="button" data-place data-key="p">${a.placement ? 'REMOVE FROM FIELD' : 'PLACE IN FIELD'}</button>
      </div>
    `;
    if (url && (a.kind === 'text' || a.kind === 'file')) {
      const pre = body.querySelector<HTMLElement>('[data-text]')!;
      fetch(url).then((r) => r.text()).then((t) => { pre.textContent = t.slice(0, 60_000); }).catch(() => { pre.textContent = 'could not load'; });
    }
    body.querySelector('[data-raw]')?.addEventListener('click', () => window.open(url!, '_blank', 'noopener'));
    const place = body.querySelector<HTMLElement>('[data-place]')!;
    place.addEventListener('click', () => {
      slabFlash(place);
      if (a.placement) c.unplaceArtifact(a.id); else c.placeArtifact(a.id);
    });
  }

  const off = store.on((e) => { if (e.k === 'world' || (e.k as string) === 'artifacts') render(); });
  render();
  return { dispose: off };
}
