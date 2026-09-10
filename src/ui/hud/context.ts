/**
 * What can be done to a thing, from wherever it is pointed at.
 *
 * The field, a window's chrome, a row in the fleet list and a tile in the
 * tray all name the same five kinds of thing — an agent, a squad, a project,
 * an artifact, a window — and the same thing gets the same menu from each of
 * them. This module is where that menu is written, once per kind; `menu.ts`
 * only draws it.
 *
 * Every row is a verb the console already has (`Console`), so a menu never
 * does anything a window or a key could not — it only puts the verb where
 * the pointer already is. Rows that need a person are amber; a stop is red
 * and always last, with a line above it, so a hand that overshoots lands on
 * the line and not on the stop.
 */

import { squadsOf } from '../../shared/squads.ts';
import type { Agent } from '../../shared/types.ts';
import type { At, Console } from '../console.ts';
import { store } from '../store.ts';
import { placedFiles } from '../placed-files.ts';
import { stateWord } from '../util.ts';
import type { Win } from '../windows/wm.ts';
import { openMenu, type MenuItem } from './menu.ts';

/** The thing under the pointer. Named by whoever caught the click. */
export type CtxTarget =
  | { kind: 'agent'; id: string; selection?: string[] }
  | { kind: 'squad'; name: string; projectId?: string | null }
  | { kind: 'project'; id: string }
  | { kind: 'machine'; id: string }
  | { kind: 'artifact'; id: string }
  | { kind: 'window'; winId: string }
  | { kind: 'field' };

/** The few things the builders need that the console does not carry. */
export interface CtxDeps {
  c: Console;
  /** Put the command line on these agents and give it the keyboard. */
  sayTo(ids: string[]): void;
  toggleTilt(): void;
}

const alive = (a: Agent) => a.state !== 'done' && a.state !== 'dead';

function pendingOf(agentId: string) {
  return Object.values(store.world.escalations).find((e) => e.agentId === agentId && (e.status === 'pending' || e.status === 'with_ceo')) ?? null;
}

function membersOf(name: string, projectId?: string | null): Agent[] {
  return Object.values(store.world.agents).filter((a) => a.squad === name && (!projectId || a.projectId === projectId));
}

export function showContext(d: CtxDeps, target: CtxTarget, at: At): void {
  const built = build(d, target, at);
  if (!built) return;
  openMenu(at, built.items, { title: built.title, sub: built.sub });
}

function build(d: CtxDeps, t: CtxTarget, at: At): { title: string; sub?: string; items: MenuItem[] } | null {
  switch (t.kind) {
    case 'agent': return agentMenu(d, t.id, t.selection ?? [], at);
    case 'squad': return squadMenu(d, t.name, t.projectId ?? null, at);
    case 'project': return projectMenu(d, t.id, at);
    case 'machine': return machineMenu(d, t.id, at);
    case 'artifact': return artifactMenu(d, t.id, at);
    case 'window': return windowMenu(d, t.winId, at);
    case 'field': return fieldMenu(d);
  }
}

/* ── An agent, or the selection it stands in ────────────────────── */

function agentMenu(d: CtxDeps, id: string, selection: string[], at: At) {
  const { c } = d;
  const a = store.world.agents[id];
  if (!a) return null;
  const p = store.world.projects[a.projectId];
  const group = selection.length > 1 && selection.includes(id) ? selection : null;
  const items: MenuItem[] = [];

  if (group) {
    const live = group.filter((x) => store.world.agents[x] && alive(store.world.agents[x]!));
    items.push(
      { label: 'OPEN GROUP', hint: `${group.length} AGENTS`, key: 'o', run: () => c.openGroup(group, at) },
      { label: 'SAY TO ALL…', hint: String(live.length), key: 's', off: !live.length, run: () => d.sayTo(live) },
      { label: 'FRAME', key: 'f', run: () => { c.pushView(); c.field.flyTo(id, 10); } },
      { label: 'CLEAR SELECTION', run: () => c.field.select([]) },
      { sep: true },
      { label: 'STOP ALL', hint: String(live.length), tone: 'red', key: 'x', off: !live.length, run: () => { for (const x of live) void c.stop(x); } },
      { label: 'DISMISS ALL', hint: 'HIDE', key: 'h', run: () => { const n = store.dismiss(group); c.field.select([]); c.note(`dismissed ${n} agent${n === 1 ? '' : 's'} · SETTINGS shows them again`); } },
      { sep: true },
      { head: a.callsign, sub: stateWord(a) },
    );
  }

  const esc0 = pendingOf(id);
  const kids = store.childrenOf(id);
  const squad = a.squad ?? null;
  const pinned = !!c.field.spotOf(id)?.pinned;

  items.push({ label: 'OPEN', key: group ? undefined : 'o', run: () => c.openAgent(id, at) });
  if (esc0) items.push({ label: 'ANSWER…', hint: 'NEEDS YOU', tone: 'amber', key: 'a', run: () => c.openInterrupt(esc0.id, at) });
  items.push({ label: 'TERMINAL', key: group ? undefined : 't', off: !a.pane, hint: a.pane ? undefined : 'NO PANE', run: () => c.openTerminal(id, at) });
  items.push(
    { label: 'FLY TO', key: group ? undefined : 'f', run: () => c.go(id) },
    { label: 'SAY…', key: group ? undefined : 's', off: !alive(a), hint: alive(a) ? undefined : stateWord(a), run: () => d.sayTo([id]) },
    { label: 'SPAWN CHILD', key: 'c', run: () => c.openSpawn(a.projectId, id) },
  );
  if (kids.length || squad || p) items.push({ sep: true });
  if (kids.length) items.push({ label: 'SELECT CHILDREN', hint: String(kids.length), run: () => c.field.select(kids.map((k) => k.id)) });
  if (squad) {
    items.push(
      { label: 'SQUAD', hint: squad, key: 'q', run: () => c.openSquad(squad, at) },
      { label: 'SELECT SQUAD', run: () => c.field.select(membersOf(squad, a.projectId).map((m) => m.id)) },
    );
  }
  if (p) items.push({ label: 'PROJECT', hint: p.code, key: 'p', run: () => c.openProject(p.id, at) });
  if (pinned) items.push({ sep: true }, { label: 'RETURN TO FORMATION', hint: 'UNPIN', run: () => c.field.unplace(id) });
  if (!group) {
    items.push({ sep: true });
    // Al CAPCOM vivo no se le ofrece DISMISS: el campo lo dibuja siempre y el
    // store no lo esconde, así que el item sería una tecla que no hace nada.
    if (!(a.role === 'capcom' && alive(a))) {
      items.push({ label: 'DISMISS', hint: 'HIDE FROM THE FIELD', key: 'h', run: () => { store.dismiss([id]); c.note(`dismissed ${a.callsign} · SETTINGS shows it again`); } });
    }
    items.push({ label: 'STOP', tone: 'red', key: 'x', off: !alive(a), hint: alive(a) ? undefined : stateWord(a), run: () => void c.stop(id) });
  }
  return { title: group ? `${group.length} AGENTS` : a.callsign, sub: group ? undefined : `${p?.code ?? ''} · ${stateWord(a)}`, items };
}

/* ── A squad ───────────────────────────────────────────────────────── */

function squadMenu(d: CtxDeps, name: string, projectId: string | null, at: At) {
  const { c } = d;
  const members = membersOf(name, projectId);
  if (!members.length) return null;
  const sq = squadsOf(members).find((q) => q.name === name);
  const lead = sq?.leaderId ? store.world.agents[sq.leaderId] : null;
  const live = members.filter(alive);
  const ids = members.map((m) => m.id);
  const onField = c.field.squadMoved(name, projectId) || !!c.field.layout().regions.some((r) => r.squads.some((q) => q.name === name && (!projectId || q.projectId === projectId)));
  const items: MenuItem[] = [
    { label: 'OPEN SQUAD', key: 'o', run: () => c.openSquad(name, at) },
    { label: 'FRAME', key: 'f', off: !onField, run: () => { c.pushView(); c.field.frameSquad(name, projectId); } },
    { label: 'SELECT MEMBERS', hint: String(members.length), key: 'm', run: () => c.field.select(ids) },
    { sep: true },
    { label: 'SAY TO ALL…', hint: String(live.length), key: 's', off: !live.length, run: () => d.sayTo(live.map((m) => m.id)) },
    { label: 'SAY TO LEAD…', hint: lead?.callsign ?? 'NO LEAD', key: 'l', off: !lead || !alive(lead), run: () => { if (lead) d.sayTo([lead.id]); } },
    { label: 'OPEN LEAD', hint: lead?.callsign, off: !lead, run: () => { if (lead) c.openAgent(lead.id, at); } },
  ];
  if (c.field.squadMoved(name, projectId)) items.push({ sep: true }, { label: 'RETURN TO FORMATION', hint: 'UNPIN', run: () => c.field.resetSquad(name, projectId) });
  items.push({ sep: true }, { label: 'STOP ALL', hint: String(live.length), tone: 'red', key: 'x', off: !live.length, run: () => { for (const m of live) void c.stop(m.id); } });
  return { title: name, sub: `SQUAD · ${members.length}${lead ? ` · LEAD ${lead.callsign}` : ''}`, items };
}

/* ── A project's region ────────────────────────────────────────────── */

function projectMenu(d: CtxDeps, id: string, at: At) {
  const { c } = d;
  const p = store.world.projects[id];
  if (!p) return null;
  const agents = store.agentsOf(id);
  const live = agents.filter(alive);
  const items: MenuItem[] = [
    { label: 'OPEN PROJECT', key: 'o', run: () => c.openProject(id, at) },
    { label: 'FRAME', key: 'f', run: () => { c.pushView(); c.field.frameProject(id); } },
    { label: 'SELECT ALL HERE', hint: String(agents.length), key: 'm', off: !agents.length, run: () => c.field.select(agents.map((a) => a.id)) },
    { sep: true },
    { label: 'SAY TO ALL…', hint: String(live.length), key: 's', off: !live.length, run: () => d.sayTo(live.map((a) => a.id)) },
    { label: 'SPAWN HERE', key: 'n', run: () => c.openSpawn(id) },
  ];
  if (c.field.regionMoved(id)) items.push({ sep: true }, { label: 'RETURN TO FORMATION', hint: 'UNPIN', run: () => c.field.resetRegion(id) });
  items.push({ sep: true }, { label: 'STOP ALL', hint: String(live.length), tone: 'red', key: 'x', off: !live.length, run: () => { for (const a of live) void c.stop(a.id); } });
  return { title: p.code, sub: p.name, items };
}

function machineMenu(d: CtxDeps, id: string, at: At) {
  const m = store.world.machines[id];
  if (!m) return null;
  const projects = store.projectsOf(id);
  const items: MenuItem[] = [
    { label: 'OPEN MACHINE', key: 'o', run: () => d.c.openMachine(id, at) },
    ...projects.map((p): MenuItem => ({ label: p.code, hint: p.name, run: () => d.c.openProject(p.id, at) })),
  ];
  return { title: m.hostname.toUpperCase(), sub: m.online ? 'ONLINE' : 'OFFLINE', items };
}

/* ── An artifact, on the field or in the gallery ───────────────────── */

function artifactMenu(d: CtxDeps, id: string, at: At) {
  const { c } = d;
  // The operator's own file on the field: no agent to open or fly to.
  const placed = placedFiles.get(id);
  if (placed) {
    const items: MenuItem[] = [
      { label: 'OPEN', key: 'o', run: () => c.openArtifact(id, at) },
      { label: 'REMOVE FROM FIELD', key: 'r', run: () => c.unplaceArtifact(id) },
    ];
    return { title: placed.path.split('/').pop() ?? placed.path, sub: `${placed.kind} · YOU`, items };
  }
  const x = store.world.artifacts?.[id];
  if (!x) return null;
  const a = store.world.agents[x.agentId];
  const items: MenuItem[] = [
    { label: 'OPEN', key: 'o', run: () => c.openArtifact(id, at) },
    x.placement
      ? { label: 'REMOVE FROM FIELD', key: 'r', run: () => c.unplaceArtifact(id) }
      : { label: 'PLACE ON FIELD', key: 'p', run: () => c.placeArtifact(id) },
    { sep: true },
    { label: 'OPEN AGENT', hint: a?.callsign, off: !a, run: () => c.openAgent(x.agentId, at) },
    { label: 'FLY TO AGENT', key: 'f', off: !a, run: () => c.go(x.agentId) },
  ];
  return { title: x.title, sub: `${x.kind}${a ? ` · ${a.callsign}` : ''}`, items };
}

/* ── A window, by its chrome or its tile in the tray ───────────────── */

function windowMenu(d: CtxDeps, winId: string, at: At) {
  const { c } = d;
  const wm = c.wm;
  const win = wm.all().find((w) => w.id === winId);
  if (!win) return null;
  const pin = win.el.querySelector<HTMLButtonElement>('[data-w-pin]');
  const others = wm.all().filter((w) => w !== win);
  const items: MenuItem[] = [];
  items.push({ label: win.mode === 'canvas' ? 'BRING TO FRONT' : 'RETURN TO CANVAS', run: () => win.mode === 'canvas' ? wm.bringForward(win) : wm.returnToCanvas(win) });
  if (pin && win.mode !== 'canvas') items.push({ label: win.mode === 'pinned' ? 'UNFIX FROM SCREEN' : 'FIX TO SCREEN', key: 'p', run: () => pin.click() });
  items.push(
    win.minimized
      ? { label: 'UNFOLD', key: 'u', run: () => wm.restore(win) }
      : { label: 'FOLD', hint: 'TO TRAY', key: '-', run: () => wm.minimize(win) },
    { label: 'CLOSE', key: 'w', run: () => wm.close(win) },
  );
  const own = ownRows(d, win, at);
  if (own.length) items.push({ sep: true }, ...own);
  items.push(
    { sep: true },
    { label: 'FOLD OTHERS', hint: String(others.filter((w) => !w.minimized).length), off: !others.some((w) => !w.minimized), run: () => { for (const w of others) if (!w.minimized) wm.minimize(w); } },
    { label: 'CLOSE OTHERS', hint: String(others.length), off: !others.length, run: () => { for (const w of others) wm.close(w); } },
    { label: 'CLOSE ALL', hint: String(others.length + 1), run: () => { for (const w of wm.all()) wm.close(w); } },
  );
  return { title: win.spec.callsign ?? win.spec.kind, sub: win.spec.project ? `${win.spec.project} · ${win.spec.kind}` : win.spec.kind, items };
}

/** What a window's subject can do, by kind: the field's verbs, from the chrome. */
function ownRows(d: CtxDeps, win: Win, at: At): MenuItem[] {
  const { c } = d;
  const p = win.spec.params ?? {};
  switch (win.spec.kind) {
    case 'agent': case 'interrupt': {
      const a = p.agentId ? store.world.agents[p.agentId] : null;
      if (!a) return [];
      return [
        { label: 'FLY TO', hint: a.callsign, key: 'f', run: () => c.go(a.id) },
        { label: 'SAY…', key: 's', off: !alive(a), run: () => d.sayTo([a.id]) },
        { label: 'STOP', tone: 'red', key: 'x', off: !alive(a), run: () => void c.stop(a.id) },
      ];
    }
    case 'fleet': {
      if (p.scope === 'project' && p.id) return [{ label: 'FRAME', key: 'f', run: () => { c.pushView(); c.field.frameProject(p.id!); } }];
      if (p.scope === 'squad' && p.id) return [{ label: 'FRAME', key: 'f', run: () => { c.pushView(); c.field.frameSquad(p.id!); } }];
      if (p.scope === 'group' && p.ids) return [{ label: 'SELECT', key: 'm', run: () => c.field.select(p.ids!.split(',')) }];
      return [];
    }
    case 'artifact': {
      const x = p.artifactId ? store.world.artifacts?.[p.artifactId] : null;
      if (!x) return [];
      return [x.placement
        ? { label: 'REMOVE FROM FIELD', key: 'r', run: () => c.unplaceArtifact(x.id) }
        : { label: 'PLACE ON FIELD', key: 'p', run: () => c.placeArtifact(x.id) }];
    }
    default: return [];
  }
}

/* ── The field itself ──────────────────────────────────────────────── */

function fieldMenu(d: CtxDeps) {
  const { c } = d;
  const mode = c.field.layoutMode();
  const inDeck = mode.kind === 'deck';
  const sort = inDeck ? mode.sort : null;
  const items: MenuItem[] = [
    { label: 'FRAME ALL', key: 'f', run: () => { c.pushView(); c.field.frameAll(); } },
    { label: c.field.tilted() ? 'TILT OFF' : 'TILT ON', key: 'o', run: () => d.toggleTilt() },
    { sep: true },
    { head: inDeck ? `DECK · BY ${sort}` : 'DECK' },
    ...(inDeck ? [{ label: 'BACK TO THE FIELD', key: 'd', run: () => c.deck() } as MenuItem] : []),
    ...(['state', 'project', 'cost', 'age'] as const)
      .filter((s) => s !== sort)
      .map((s): MenuItem => ({ label: `BY ${s.toUpperCase()}`, key: inDeck ? undefined : s === 'state' ? 'd' : undefined, run: () => c.deck(s) })),
    { sep: true },
    { label: 'SPAWN…', key: 'n', run: () => c.openSpawn() },
    { label: 'LAUNCH…', key: 'l', run: () => c.openLaunch() },
    { sep: true },
    { label: 'FLEET', key: 'e', run: () => c.openFleet() },
    { label: 'CAPCOM', key: 'k', run: () => c.openCeo() },
    { label: 'GALLERY', key: 'g', run: () => c.openGallery() },
    { label: 'TIMELINE', key: 't', run: () => c.openTimeline() },
  ];
  if (c.field.arranged()) items.push({ sep: true }, { label: 'RESET ARRANGEMENT', hint: 'UNPIN ALL', run: () => c.field.resetArrangement() });
  return { title: 'FIELD', sub: inDeck ? 'DECK' : undefined, items };
}
