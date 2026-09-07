/**
 * The queue: everything waiting on a person, most urgent first.
 *
 * Questions the CEO could not answer, and agents stuck on a permission prompt
 * the console cannot answer for them. Each row says how many agents it
 * unblocks, because that is what decides the order you take them in.
 */

import { store } from '../../store.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { ago, esc } from '../../util.ts';

export function mountQueue(ctx: WinCtx, c: Console) {
  const body = ctx.body;
  body.innerHTML = `<div class="sec row row--split"><span class="px px--tiny" data-sum></span><span class="px px--tiny" data-oldest></span></div><div class="win__scroll scroll" data-list></div>`;
  const list = body.querySelector<HTMLElement>('[data-list]')!;
  const sum = body.querySelector<HTMLElement>('[data-sum]')!;
  const oldest = body.querySelector<HTMLElement>('[data-oldest]')!;
  let sig = '';

  function render() {
    const now = Date.now();
    const pending = store.pending();
    const withEsc = new Set(pending.map((e) => e.agentId));
    const perms = store.blockedAgents().filter((a) => a.block?.kind !== 'peer' && !withEsc.has(a.id));
    const n = pending.length + perms.length;
    const s = [pending.map((e) => e.id + e.status).join(','), perms.map((a) => a.id).join(','), Math.floor(now / 10000)].join('|');
    if (s === sig) return;
    sig = s;

    sum.textContent = n ? `${n} WAITING ON YOU` : 'NOTHING IS WAITING ON YOU';
    ctx.setState(n ? 'blocked' : null, n ? 'var(--amber)' : undefined);
    const first = [...pending.map((e) => e.askedAt), ...perms.map((a) => a.block?.since ?? now)].sort((p, q) => p - q)[0];
    oldest.textContent = first ? `OLDEST ${ago(first, now)}` : '';

    if (!n) {
      list.innerHTML = `<p class="px px--tiny" style="padding:16px 12px;line-height:1.7;color:var(--ink-dim)">THE QUEUE IS EMPTY.<br/>WHEN AN AGENT NEEDS YOU, IT LANDS HERE AND OPENS NEXT TO ITS TILE.</p>`;
      return;
    }
    list.innerHTML = pending.map((e) => {
      const a = store.world.agents[e.agentId];
      const p = store.world.projects[e.projectId];
      const unblocks = 1 + store.dammedBehind(e.agentId).length;
      return `<div class="qrow" data-esc="${esc(e.id)}" data-agent="${esc(e.agentId)}">
        <div class="qrow__h"><span class="qrow__cs">${esc(a?.callsign ?? '??')} <span class="win__pj">${esc(p?.code ?? '')}</span></span><span class="qrow__meta">${ago(e.askedAt, now)}</span></div>
        <div class="qrow__q mono">${esc(e.question)}</div>
        <div class="qrow__meta">${e.status === 'with_ceo' ? 'CAPCOM LOOKING · ' : ''}${e.urgency.toUpperCase()} · <b>UNBLOCKS ${unblocks}</b>${e.options.length ? ` · ${e.options.length} OPTIONS` : ''}</div>
      </div>`;
    }).join('') + perms.map((a) => {
      const p = store.world.projects[a.projectId];
      const m = store.world.machines[a.machineId];
      return `<div class="qrow" data-agent="${esc(a.id)}">
        <div class="qrow__h"><span class="qrow__cs">${esc(a.callsign)} <span class="win__pj">${esc(p?.code ?? '')}</span></span><span class="qrow__meta">${ago(a.block?.since ?? now, now)}</span></div>
        <div class="qrow__q mono">${esc(a.block?.summary ?? '')}</div>
        <div class="qrow__meta">${esc((a.block?.kind ?? '').toUpperCase())} · ANSWER IN ITS TERMINAL ON ${esc((m?.hostname ?? a.machineId).toUpperCase())}</div>
      </div>`;
    }).join('');

    list.querySelectorAll<HTMLElement>('.qrow').forEach((row) => row.addEventListener('click', (ev) => {
      const agentId = row.dataset.agent!;
      c.go(agentId);
      if (row.dataset.esc) c.openInterrupt(row.dataset.esc, { x: ev.clientX, y: ev.clientY });
      else c.openAgent(agentId, { x: ev.clientX, y: ev.clientY });
    }));
    list.querySelectorAll<HTMLElement>('.qrow').forEach((row) => row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      c.menu({ kind: 'agent', id: row.dataset.agent! }, { x: ev.clientX, y: ev.clientY });
    }));
  }

  const off = store.on((e) => { if (e.k === 'world' || e.k === 'escalations' || e.k === 'agents') render(); });
  const tick = window.setInterval(render, 5000);
  render();
  return { dispose() { off(); clearInterval(tick); } };
}
