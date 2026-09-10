/**
 * A fleet window: a set of agents you address together.
 *
 * Five scopes with one body: a project, a machine, a squad, a lasso selection,
 * or everything. Rows fly to the agent; SAY ALL fans a message out; STOP ALL is
 * armed, because an unarmed stop on twelve agents is twelve lost hours.
 *
 * A squad is the one scope with a shape of its own. It is not a filter over the
 * world, it is `squadsOf()` — leader first, then the rest by age — and the list
 * keeps that order instead of sorting by urgency, because a leader that drifts
 * into the middle of its own squad stops being visibly the leader. SAY LEAD
 * talks only to it: the members hear it from the one that answers for them,
 * which is the entire reason a squad has a head.
 */

import { agentOrigin, originLabel, groupOrigin } from '../../../shared/origin.ts';
import { getPref, setPref } from '../../prefs.ts';
import type { Agent } from '../../../shared/types.ts';
import { squadsOf, type Squad } from '../../../shared/squads.ts';
import { OFF_FLEET_LABEL, islandOf, isOffFleet } from '../../../shared/workspaces.ts';
import { alive, store } from '../../store.ts';
import { bindComposer, composerHint } from '../composer.ts';
import { drafts, draftKey } from '../../drafts.ts';
import { hub } from '../../net/client.ts';
import type { ArchiveFilter } from '../../../shared/archive.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { slabBusy, slabFlash } from '../fx.ts';
import { ago, clock, esc, money, stateVar, stateWord } from '../../util.ts';
import { longPress } from '../../hud/longpress.ts';

type Scope = 'project' | 'machine' | 'group' | 'squad' | 'all';

export function mountFleet(ctx: WinCtx, c: Console) {
  const p = ctx.win.spec.params ?? {};
  const scope = (p.scope ?? 'all') as Scope;
  const body = ctx.body;
  body.innerHTML = `
    <div class="sec" data-origin-controls>
      <div class="chips">${['orca', 'external', 'all'].map((v) => `<button class="chip" type="button" data-origin="${v}">${v.toUpperCase()}</button>`).join('')}</div>
      <p class="mono" data-origin-counts></p>
      <div class="chips"><button class="chip" type="button" data-cleanup>CLEAN UP INACTIVE</button><button class="chip" type="button" data-history>SHOW HISTORY</button><button class="chip" type="button" data-archive>ARCHIVE FINISHED</button></div>
      <p class="mono">Filters apply to the field. Cleanup hides finished sessions and sessions idle for over an hour. History restores visibility; no processes are stopped. Archive removes finished sessions from the hub for every console; transcripts stay on disk and a resumed session comes back.</p>
    </div>
    <div class="sec row row--split" style="padding:8px 12px"><span class="px px--tiny" data-sum></span><span class="px px--tiny" data-cost></span></div>
    <div class="win__scroll scroll" data-list></div>
    <div class="slab-row" style="padding:8px;border-top:1px solid var(--line-soft)">
      <textarea class="input" rows="2" data-say aria-label="Message"
        placeholder="${esc(composerHint(scope === 'squad' ? 'say to the whole squad' : 'say to every agent here'))}"></textarea>
      <div class="slab-pair">
        <button class="slab-btn" type="button" data-send data-key="a">SAY ALL</button>
        ${scope === 'squad' ? `<button class="slab-btn slab-btn--ghost" type="button" data-lead data-key="l">SAY LEAD</button>` : ''}
      </div>
    </div>
    <div class="row row--split" style="padding:0 8px 8px">
      <div class="row">
        <button class="btn" type="button" data-frame data-key="f">FRAME</button>
        ${scope === 'project' && !isOffFleet(p.id ?? '') ? `<button class="btn" type="button" data-spawn data-key="n">SPAWN HERE</button>` : ''}
        ${scope === 'group' ? `<button class="btn" type="button" data-select>SELECT</button>` : ''}
      </div>
      <button class="btn" type="button" data-stop data-key="x">STOP ALL</button>
    </div>
  `;
  const list = body.querySelector<HTMLElement>('[data-list]')!;
  // Cada fila lleva el menú de su sujeto; con el dedo, manteniéndola pulsada.
  // Una vez al montar: las filas se repintan, la lista no.
  longPress(list, { allow: (t) => !!t.closest('[data-agent], [data-project], [data-machine], [data-squad]') });
  const sum = body.querySelector<HTMLElement>('[data-sum]')!;
  const cost = body.querySelector<HTMLElement>('[data-cost]')!;
  const sayIn = body.querySelector<HTMLTextAreaElement>('[data-say]')!;
  // The unsent line to this scope survives a reload (drafts.ts); the window key names the scope.
  const draft = drafts.bind(sayIn, draftKey('fleet', ctx.win.spec.key));
  draft.restore();
  const stopBtn = body.querySelector<HTMLButtonElement>('[data-stop]')!;
  body.querySelectorAll<HTMLElement>('[data-origin]').forEach((b) => b.addEventListener('click', () => {
    setPref('origin', b.dataset.origin as 'orca' | 'external' | 'all'); setPref('showAll', false); store.refilter();
  }));
  body.querySelector('[data-cleanup]')!.addEventListener('click', () => {
    setPref('showAll', false); const n = store.cleanup(); store.refilter(); c.note(`${n} inactive sessions hidden · SHOW HISTORY restores visibility`);
  });
  body.querySelector('[data-history]')!.addEventListener('click', () => { setPref('showAll', !getPref('showAll')); store.refilter(); });
  /**
   * ARCHIVE FINISHED: the hub-side cleanup, for what this window is on. The
   * first click asks the hub for a dry run and arms the button with the count;
   * a second click within four seconds archives exactly that. The filter is
   * the window's scope, not the rows on screen: a project window archives
   * every finished agent of the project, including the ones hidden locally.
   */
  const archiveBtn = body.querySelector<HTMLButtonElement>('[data-archive]')!;
  let archiveArmed = 0;
  const disarmArchive = () => { archiveArmed = 0; archiveBtn.textContent = 'ARCHIVE FINISHED'; archiveBtn.removeAttribute('aria-pressed'); };
  const archiveFilter = (): ArchiveFilter => {
    switch (scope) {
      case 'project': return { projectId: p.id ?? null };
      case 'squad': return { squad: p.id ?? null };
      case 'machine': return { ids: store.everyone().filter((a) => a.machineId === p.id && !alive(a)).map((a) => a.id) };
      case 'group': return { ids: (p.ids ?? '').split(',').filter(Boolean) };
      default: return {};
    }
  };
  archiveBtn.addEventListener('click', async () => {
    if (!store.linkUp) { c.note('no link to the hub: nothing can be archived', 'warn'); return; }
    if (archiveArmed && Date.now() - archiveArmed < 4000) {
      disarmArchive();
      const done = slabBusy(archiveBtn);
      try {
        const out = await hub.archive(archiveFilter(), false);
        const n = out.archived.length;
        c.note(`archived ${n} finished agent${n === 1 ? '' : 's'}`
          + (out.kept.length ? ` · ${out.kept.length} kept (live children)` : '')
          + (out.squadsRetired.length ? ` · squads retired: ${out.squadsRetired.join(', ')}` : ''), 'warn');
      } catch (err) { c.note(`could not archive: ${(err as Error).message}`, 'alert'); }
      finally { done(); }
      return;
    }
    try {
      const out = await hub.archive(archiveFilter(), true);
      const n = out.archived.length;
      if (!n) { c.note(`nothing finished to archive here${out.kept.length ? ` · ${out.kept.length} kept (live children)` : ''}`); return; }
      archiveArmed = Date.now();
      archiveBtn.textContent = `ARCHIVE ${n} · SURE?`;
      archiveBtn.setAttribute('aria-pressed', 'true');
      c.note(`${n} finished agent${n === 1 ? '' : 's'} would be archived · click again to confirm`, 'warn');
      setTimeout(() => { if (archiveArmed) disarmArchive(); }, 4000);
    } catch (err) { c.note(`could not ask the hub: ${(err as Error).message}`, 'alert'); }
  });
  let armed = 0;
  let sig = '';

  /** The squad this window is on, derived fresh. There is no squad record. */
  function squad(): Squad | null {
    if (scope !== 'squad' || !p.id) return null;
    return squadsOf(store.world.agents).find((s) => s.name === p.id) ?? null;
  }

  function members(): Agent[] {
    const all = Object.values(store.world.agents);
    switch (scope) {
      // Por ISLA, no por proyecto: la de fuera de la flota agrupa varios
      // directorios que nunca fueron uno. Ver `shared/workspaces.ts`.
      case 'project': return all.filter((a) => islandOf(a) === p.id);
      case 'machine': return all.filter((a) => a.machineId === p.id);
      case 'squad': {
        const sq = squad();
        if (!sq) return [];
        return sq.memberIds.map((id) => store.world.agents[id]).filter((a): a is Agent => !!a);
      }
      case 'group': { const ids = new Set((p.ids ?? '').split(',').filter(Boolean)); return all.filter((a) => ids.has(a.id)); }
      default: return all;
    }
  }
  const rank = (a: Agent) => a.state === 'blocked' && a.block?.kind !== 'peer' ? 0 : a.state === 'working' ? 1 : a.state === 'thinking' ? 2 : a.state === 'blocked' ? 3 : a.state === 'booting' ? 4 : a.state === 'idle' ? 5 : 6;

  /**
   * Quién fue el mando, y hasta cuándo.
   *
   * Un CAPCOM retirado queda con `role:'agent'` —el linaje lo degrada al
   * adoptar al siguiente, y si no lo hiciera el hub le seguiría hablando a la
   * sesión que se va—, así que en la isla de fuera de la flota se ve igual que
   * cualquier otra sesión terminada. El acta del relevo es lo único que
   * conserva la diferencia, y es exactamente lo que se busca al abrir esa
   * lista: cuál de esas dieciséis llevaba el mando y hasta qué hora.
   */
  const retired = (id: string) => (store.world.capcomHandoffs ?? []).find((h) => h.fromId === id);

  /** One agent row. `lead` only draws in a squad window, which has the column. */
  function rowOf(a: Agent, lead = false): string {
    const pr = store.world.projects[a.projectId];
    const was = retired(a.id);
    return `<div class="arow ${scope === 'squad' ? 'arow--squad' : ''} ${a.state === 'blocked' && a.block?.kind !== 'peer' ? 'is-blocked' : ''}" data-agent="${esc(a.id)}" style="--arow-state:${stateVar(a)}">
      <i class="arow__st"></i>
      ${scope === 'squad' ? `<span class="arow__lead">${lead ? 'LEAD' : ''}</span>` : ''}
      <span class="arow__cs">${esc(a.callsign)}<br/><span class="win__pj">${esc(pr?.code ?? '')}</span></span>
      <span class="arow__t mono"><span class="origin-badge" data-origin-kind="${agentOrigin(a)}">${originLabel(a)}</span><br/>${esc(a.title || a.mission || '')}<br/><span style="color:var(--ink-dim)">${a.state === 'working' && a.tool ? esc(a.tool) + ' ' + esc(a.toolDetail ?? '') : esc(stateWord(a))}${was ? ` · WAS CAPCOM UNTIL ${esc(clock(was.at))}` : ''}</span></span>
      <span class="arow__m">${money(a.metrics.costUSD)}<br/>${ago(a.updatedAt, Date.now())}</span>
    </div>`;
  }

  /** The Tiny5 line that opens a group of rows inside a project window. */
  const groupHead = (text: string) => `<div class="arow__group px px--tiny">${text}</div>`;

  function render() {
    const known = store.everyone();
    const counts = (kind: string) => known.filter((a) => agentOrigin(a) === kind).length;
    body.querySelector('[data-origin-counts]')!.textContent = `${counts('orca')} ORCA · ${counts('external')} EXTERNAL · ${counts('unknown')} UNVERIFIED · ${store.hiddenCount()} HIDDEN`;
    body.querySelectorAll<HTMLElement>('[data-origin]').forEach((b) => b.setAttribute('aria-pressed', String(!getPref('showAll') && getPref('origin') === b.dataset.origin)));
    body.querySelector('[data-history]')!.textContent = getPref('showAll') ? 'HIDE HISTORY' : 'SHOW HISTORY';
    const sq = squad();
    const found = members();
    // A squad arrives ordered by lineage, and stays that way.
    const ms = scope === 'squad' ? found : found.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
    const live = ms.filter((a) => a.state !== 'done' && a.state !== 'dead');
    const now = Date.now();
    const blocked = ms.filter((a) => a.state === 'blocked' && a.block?.kind !== 'peer').length;
    const costUSD = ms.reduce((s, a) => s + a.metrics.costUSD, 0);
    const tps = ms.reduce((s, a) => s + a.metrics.tokensPerSec, 0);

    if (scope === 'project') {
      const pr = store.world.projects[p.id ?? ''];
      const off = !pr && isOffFleet(p.id ?? '');
      ctx.setCallsign(pr?.code ?? (off ? OFF_FLEET_LABEL.code : '??'));
      ctx.setTitle(off
        ? `${OFF_FLEET_LABEL.name} · capcom's own directory and session scratchpads`
        : `${pr?.name ?? p.id}${pr?.gitBranch ? ` · ${pr.gitBranch}${pr.gitDirty ? '*' : ''}` : ''}`);
    } else if (scope === 'machine') {
      const m = store.world.machines[p.id ?? ''];
      ctx.setCallsign(m?.hostname?.toUpperCase().slice(0, 12) ?? '??');
      ctx.setTitle(`${m?.platform ?? ''} · ${m?.online ? 'ONLINE' : 'OFFLINE'} · ${m?.load.activeSessions ?? 0} ACTIVE`);
    } else if (scope === 'squad') {
      const lead = sq?.leaderId ? store.world.agents[sq.leaderId] : undefined;
      ctx.setCallsign((p.id ?? '??').toUpperCase().slice(0, 12));
      ctx.setTitle(`${p.id ?? ''} · ${groupOrigin(ms)} · ${ms.length} · LEAD ${lead?.callsign ?? '—'}`);
    } else if (scope === 'group') {
      ctx.setCallsign(`${ms.length} AGENTS`);
      ctx.setTitle(ms.map((a) => a.callsign).join(' '));
    } else {
      ctx.setCallsign('FLEET');
      ctx.setTitle(`${Object.keys(store.world.machines).length} MACHINES · ${Object.keys(store.world.projects).length} PROJECTS`);
    }
    ctx.setState(blocked ? 'blocked' : null, blocked ? 'var(--amber)' : live.length ? 'var(--lime)' : undefined);
    sum.textContent = `${live.length} LIVE · ${blocked} NEED YOU · ${ms.length} TOTAL`;
    cost.textContent = `${money(costUSD)} · ${Math.round(tps)} TOK/S`;

    // The squad label is part of the picture: an agent enlisted since the last
    // frame regroups the list, and a signature that ignores it would not redraw.
    const s = ms.map((a) => `${a.id}${a.state}${a.title}${a.tool}${a.origin ?? ''}${a.role ?? ''}${a.squad ?? ''}${a.lead ? '!' : ''}${retired(a.id)?.at ?? ''}`).join('|') + `|${Math.floor(now / 15000)}`;
    if (s === sig) return;
    sig = s;

    let head = '';
    if (scope === 'all') {
      const sqs = squadsOf(ms);
      head = `<div class="sec"><div class="sec__k px">MACHINES</div><div class="chips">${store.machines().map((m) => `<button class="chip" type="button" data-machine="${esc(m.id)}" style="--chip-state:${m.online ? 'var(--lime)' : 'var(--red)'}">${esc(m.hostname)} <small>${store.projectsOf(m.id).length} PJ</small></button>`).join('') || '<span class="px px--tiny" style="color:var(--ink-faint)">NO COLLECTOR CONNECTED</span>'}</div></div>
        <div class="sec"><div class="sec__k px">PROJECTS</div><div class="chips">${Object.values(store.world.projects).sort((a, b) => b.rollup.blocked - a.rollup.blocked || a.name.localeCompare(b.name)).map((pr) => `<button class="chip" type="button" data-project="${esc(pr.id)}" style="--chip-state:${pr.rollup.blocked ? 'var(--amber)' : pr.rollup.byState.working ? 'var(--lime)' : 'var(--line)'}">${esc(pr.code)} <small>${esc(pr.name)}</small> <small>${pr.rollup.total}</small></button>`).join('') || '<span class="px px--tiny" style="color:var(--ink-faint)">NONE YET</span>'}</div></div>
        ${sqs.length ? `<div class="sec"><div class="sec__k px">SQUADS</div><div class="chips">${sqs.map((g) => {
          // A squad that lost its leader is amber: it still works, but nobody
          // answers for it, and that is a thing to go and look at.
          const lead = g.leaderId ? store.world.agents[g.leaderId] : undefined;
          return `<button class="chip" type="button" data-squad="${esc(g.name)}" style="--chip-state:${lead ? 'var(--lime)' : 'var(--amber)'}">${esc(g.name)} <small>${groupOrigin(g.memberIds.map((id) => store.world.agents[id]).filter((a): a is Agent => !!a))}</small> <small>${g.memberIds.length}</small> <small>${esc(lead?.callsign ?? 'NO LEAD')}</small></button>`;
        }).join('')}</div></div>` : ''}
        <div class="sec__k px" style="padding:10px 12px 0">AGENTS</div>`;
    }

    let rows: string;
    if (scope === 'squad') {
      rows = ms.map((a) => rowOf(a, !!sq && a.id === sq.leaderId)).join('');
    } else if (scope === 'project') {
      // Inside a project, a squad is the unit that was sent out together. Show
      // it as one, and only invent an UNASSIGNED heading when there is a squad
      // for the loose agents to be unassigned from.
      const groups = squadsOf(ms);
      if (groups.length) {
        const taken = new Set<string>();
        const parts: string[] = [];
        for (const g of groups) {
          const mem = g.memberIds.map((id) => store.world.agents[id]).filter((a): a is Agent => !!a);
          for (const a of mem) taken.add(a.id);
          const lead = g.leaderId ? store.world.agents[g.leaderId] : undefined;
          parts.push(groupHead(`${esc(g.name)} · ${mem.length}${lead ? ` · LEAD ${esc(lead.callsign)}` : ' · NO LEAD'}`));
          parts.push(mem.map((a) => rowOf(a, a.id === g.leaderId)).join(''));
        }
        const rest = ms.filter((a) => !taken.has(a.id));
        if (rest.length) {
          parts.push(groupHead(`UNASSIGNED · ${rest.length}`));
          parts.push(rest.map((a) => rowOf(a)).join(''));
        }
        rows = parts.join('');
      } else rows = ms.map((a) => rowOf(a)).join('');
    } else {
      rows = ms.map((a) => rowOf(a)).join('');
    }

    list.innerHTML = head + (ms.length ? rows : `<p class="px px--tiny" style="padding:14px 12px;color:var(--ink-dim)">${scope === 'squad' ? 'THIS SQUAD IS GONE.' : 'NO AGENTS HERE.'}</p>`);

    list.querySelectorAll<HTMLElement>('[data-agent]').forEach((r) => r.addEventListener('click', (e) => { c.go(r.dataset.agent!); c.openAgent(r.dataset.agent!, { x: e.clientX, y: e.clientY }); }));
    list.querySelectorAll<HTMLElement>('[data-project]').forEach((r) => r.addEventListener('click', (e) => c.openProject(r.dataset.project!, { x: e.clientX, y: e.clientY })));
    list.querySelectorAll<HTMLElement>('[data-machine]').forEach((r) => r.addEventListener('click', (e) => c.openMachine(r.dataset.machine!, { x: e.clientX, y: e.clientY })));
    list.querySelectorAll<HTMLElement>('[data-squad]').forEach((r) => r.addEventListener('click', (e) => c.openSquad(r.dataset.squad!, { x: e.clientX, y: e.clientY })));
    // Every row and chip has the menu its subject has on the field.
    const menuOn = (sel: string, target: (el: HTMLElement) => Parameters<Console['menu']>[0]) => {
      list.querySelectorAll<HTMLElement>(sel).forEach((r) => r.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        c.menu(target(r), { x: e.clientX, y: e.clientY });
      }));
    };
    menuOn('[data-agent]', (r) => ({ kind: 'agent', id: r.dataset.agent! }));
    menuOn('[data-project]', (r) => ({ kind: 'project', id: r.dataset.project! }));
    menuOn('[data-machine]', (r) => ({ kind: 'machine', id: r.dataset.machine! }));
    menuOn('[data-squad]', (r) => ({ kind: 'squad', name: r.dataset.squad! }));
  }

  const sendBtn = body.querySelector<HTMLElement>('[data-send]')!;
  const leadBtn = body.querySelector<HTMLElement>('[data-lead]');
  /** §6.2: ink for a frame, then the band until every ack is back. */
  const send = async () => {
    const t = sayIn.value.trim();
    if (!t) return;
    const ids = members().filter((a) => a.state !== 'done' && a.state !== 'dead').map((a) => a.id);
    if (!ids.length) { c.note('nobody live to say it to', 'warn'); return; }
    sayIn.value = '';
    draft.clear();
    slabFlash(sendBtn);
    const done = slabBusy(sendBtn);
    try { await c.say(ids, t); } finally { done(); }
  };
  /** One recipient, on purpose: the leader hands it out. */
  const sendLead = async () => {
    const t = sayIn.value.trim();
    if (!t) return;
    const id = squad()?.leaderId;
    if (!id) { c.note('this squad has no leader to talk to', 'warn'); return; }
    sayIn.value = '';
    draft.clear();
    slabFlash(leadBtn);
    const done = slabBusy(leadBtn);
    try { await c.say([id], t); } finally { done(); }
  };
  sendBtn.addEventListener('click', () => void send());
  leadBtn?.addEventListener('click', () => void sendLead());
  // Un mensaje a una flota es un mensaje: Enter salta, ⌘/⌃Enter manda.
  const unbindComposer = bindComposer(sayIn, () => void send());
  body.querySelector('[data-frame]')!.addEventListener('click', () => {
    if (scope === 'project' && p.id) c.field.frameProject(p.id);
    else if (scope === 'group' || scope === 'squad') { const ids = members().map((a) => a.id); c.field.select(ids); const first = ids[0]; if (first) c.field.flyTo(first, 9); }
    else c.field.frameAll();
  });
  body.querySelector('[data-spawn]')?.addEventListener('click', () => c.openSpawn(p.id));
  body.querySelector('[data-select]')?.addEventListener('click', () => c.field.select(members().map((a) => a.id)));
  /** One more button until it is armed; armed, the red slab. Same as STOP. */
  const disarm = () => { armed = 0; stopBtn.className = 'btn'; stopBtn.textContent = 'STOP ALL'; };
  stopBtn.addEventListener('click', async () => {
    if (armed && Date.now() - armed < 4000) {
      disarm();
      const live = members().filter((a) => a.state !== 'done' && a.state !== 'dead');
      for (const a of live) await c.stop(a.id);
      return;
    }
    armed = Date.now();
    stopBtn.className = 'slab-btn slab-btn--red slab-btn--sm slab-btn--fit';
    stopBtn.textContent = 'STOP ALL · SURE?';
    setTimeout(() => { if (armed) disarm(); }, 4000);
  });

  const off = store.on((e) => { if (e.k === 'world' || e.k === 'agents' || e.k === 'projects' || e.k === 'machines') render(); });
  const tick = window.setInterval(render, 5000);
  render();
  return { dispose() { off(); clearInterval(tick); unbindComposer(); draft.dispose(); } };
}
