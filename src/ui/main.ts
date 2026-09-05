/**
 * ORCA entry.
 *
 * The link opens first so the boot has real numbers to report. Then the
 * field takes the whole viewport, the window manager sits over it, the HUD
 * over that, and the console object below is how they talk to each other.
 */

import './styles/tokens.css';
import './styles/boot.css';
import './styles/field.css';
import './styles/sigil.css';
import './styles/squad.css';
import './styles/window.css';
import './styles/hud.css';

import type { Artifact, Escalation, WorldState } from '../shared/types.ts';
import { store } from './store.ts';
import { hub } from './net/client.ts';
import { runBoot } from './boot.ts';
import { createField } from './field/field.ts';
import { WindowManager, kbdLabel } from './windows/wm.ts';
import { mountAgent } from './windows/kinds/agent.ts';
import { mountInterrupt } from './windows/kinds/interrupt.ts';
import { mountQueue } from './windows/kinds/queue.ts';
import { mountCeo } from './windows/kinds/ceo.ts';
import { mountFeed } from './windows/kinds/feed.ts';
import { mountFleet } from './windows/kinds/fleet.ts';
import { mountSpawn } from './windows/kinds/spawn.ts';
import { mountArtifact } from './windows/kinds/artifact.ts';
import { mountBreach, mountHelp, mountSettings } from './windows/kinds/misc.ts';
import { getPref } from './prefs.ts';
import { mountGallery } from './windows/kinds/gallery.ts';
import { mountLaunch } from './windows/kinds/launch.ts';
import { mountTimeline } from './windows/kinds/timeline.ts';
import { clock } from './util.ts';
import { mountMast } from './hud/mast.ts';
import { onFullscreen, toggleFullscreen } from './hud/fullscreen.ts';
import { mountCommand } from './hud/command.ts';
import { mountTray } from './hud/tray.ts';
import { mountMinimap } from './hud/minimap.ts';
import { mountBookmarks } from './hud/bookmarks.ts';
import { mountSound, getSound, openSoundFor } from './hud/sound.ts';
import { mountSfx } from './windows/kinds/sfx.ts';
import { activeMusic, mountMusic } from './windows/kinds/music.ts';
import { mountCursor } from './hud/cursor.ts';
import { showContext } from './hud/context.ts';
import { mountAlarm } from './hud/alarm.ts';
import type { Console } from './console.ts';
import { esc } from './util.ts';
import { applyToRoot, gsapDefaults } from './motion.ts';

// One motion contract for CSS, GSAP and the shaders, before anything mounts.
applyToRoot();
gsapDefaults();

const app = document.getElementById('app')!;
const params = new URL(location.href).searchParams;

/* ── Shell ────────────────────────────────────────────────────────── */

app.innerHTML = `
  <div class="field" data-field></div>
  <div class="hud" data-hud>
    <i class="xhair xhair--tl"></i><i class="xhair xhair--tr"></i>
    <i class="xhair xhair--bl"></i><i class="xhair xhair--br"></i>
    <div class="field__stats px px--tiny" data-stats></div>
    <div class="replay" data-replay hidden><span class="px px--sm" data-replay-t>REPLAY</span><button class="tool" type="button" data-replay-live>LIVE</button></div>
    <p class="field__hint px px--tiny" data-hint>DRAG OR SCROLL TO PAN · ⌘+SCROLL OR PINCH TO ZOOM · SHIFT+DRAG TO LASSO · RIGHT-CLICK FOR OPTIONS · DRAG A PROJECT OR SQUAD BY ITS LABEL · ⌘K TO TALK TO CAPCOM</p>

    <div class="selbar" data-selbar hidden>
      <button class="tool" type="button" data-s="window">WINDOW</button>
      <button class="tool" type="button" data-s="say">SAY</button>
      <button class="tool" type="button" data-s="frame">FRAME</button>
      <button class="tool" type="button" data-s="clear">×</button>
    </div>
  </div>
`;
const fieldEl = app.querySelector<HTMLElement>('[data-field]')!;
const hudEl = app.querySelector<HTMLElement>('[data-hud]')!;
// The dock — command line, hints, tray — sits above every window: a window
// may cover the mast, never the keyboard's home.
const dockEl = document.createElement('div');
dockEl.className = 'dock';
dockEl.innerHTML = `<div class="hints px px--tiny" data-hints></div>`;
const statsEl = hudEl.querySelector<HTMLElement>('[data-stats]')!;
const hintEl = hudEl.querySelector<HTMLElement>('[data-hint]')!;
const selbar = hudEl.querySelector<HTMLElement>('[data-selbar]')!;
const replayEl = hudEl.querySelector<HTMLElement>('[data-replay]')!;
replayEl.querySelector('[data-replay-live]')!.addEventListener('click', () => { c.setReplay(null); wm.closeKey('timeline'); });

hub.connect();

/* ── Window manager, before the field so the field can hand it events ── */

const wm = new WindowManager(app, {
  tileRect: (id) => field.screenOf(id),
  onTray: (list) => tray.render(list),
  onStack: (list) => tray.render(list),
  onReveal: (agentId) => { c.pushView(); field.frameAround(agentId); },
  onContext: (w, x, y) => c.menu({ kind: 'window', winId: w.id }, { x, y }),
  onFocus: (w) => {
    // With a window active, the window owns the keyboard; the mast's caps dim to say so.
    document.body.classList.toggle('has-window', !!w);
    if (w && !w.el.dataset.heard) { w.el.dataset.heard = '1'; getSound()?.play(openSoundFor(w.spec.kind)); }
  },
});
// The HUD sits above the field; the windows above the HUD; the dock above all.
app.appendChild(hudEl);
app.appendChild(dockEl);

/* ── The field ────────────────────────────────────────────────────── */

const field = createField(fieldEl, {
  onSelect(ids, at) {
    cmd.setSelection(ids);
    if (ids.length > 1 && at) {
      getSound()?.play('lasso');
      selbar.hidden = false;
      selbar.style.left = `${at.sx}px`;
      selbar.style.top = `${at.sy + 14}px`;
    } else {
      selbar.hidden = true;
    }
    if (ids.length === 1 && at) {
      getSound()?.play('select');
      // A single click opens the agent; nothing to configure, nothing to learn.
      c.openAgent(ids[0]!, { x: at.sx, y: at.sy });
    }
  },
  onOpen: (id, x, y) => c.openAgent(id, { x, y }),
  onOpenProject: (id, x, y) => c.openProject(id, { x, y }),
  onOpenSquad: (name, projectId, x, y) => { void projectId; c.openSquad(name, { x, y }); },
  onOpenArtifact: (id, x, y) => c.openArtifact(id, { x, y }),
  onContext: (target, x, y) => c.menu(target, { x, y }),
  onPlace: () => { /* persisted locally by the field; the hub has no placement channel yet */ },
  onPlaceArtifact(id, x, y, z) {
    const a = store.world.artifacts?.[id];
    if (a) { a.placement = { x, y, z }; saveArtifactPlacements(); }
  },
  onUnplaceArtifact: (id) => c.unplaceArtifact(id),
  onHover: (id) => cursor.setTarget(!!id),
});
// The panel's brightness is the operator's; it comes back the way they left it.
field.setGroundLevel(getPref('panel'));
field.setGroundColor(getPref('panelColor'));

/* ── HUD ──────────────────────────────────────────────────────────── */

const cursor = mountCursor();
mountAlarm();

/* ── The console object: everything crosses here ──────────────────── */

const c: Console = {
  field, wm,
  openAgent(agentId, at) {
    const a = store.world.agents[agentId];
    if (!a) return;
    const p = store.world.projects[a.projectId];
    wm.open({ kind: 'agent', key: `agent:${agentId}`, callsign: a.callsign, project: p?.code, title: a.title, anchor: agentId, at: at && { x: at.x, y: at.y }, params: { agentId }, ephemeral: true });
  },
  openInterrupt(escalationId, at) {
    const e = store.world.escalations[escalationId];
    if (!e) return;
    const a = store.world.agents[e.agentId];
    wm.open({ kind: 'interrupt', key: `int:${escalationId}`, callsign: a?.callsign ?? '??', project: store.world.projects[e.projectId]?.code, title: a?.title, anchor: e.agentId, at: at && { x: at.x, y: at.y }, params: { escalationId, agentId: e.agentId }, ephemeral: true });
  },
  openArtifact(artifactId, at) {
    const x = store.world.artifacts?.[artifactId];
    if (!x) return;
    const a = store.world.agents[x.agentId];
    wm.open({ kind: 'artifact', key: `art:${artifactId}`, callsign: a?.callsign ?? '??', project: store.world.projects[x.projectId]?.code, title: x.title, at: at && { x: at.x, y: at.y }, params: { artifactId, agentId: x.agentId }, ephemeral: true });
  },
  openProject(projectId, at) {
    const p = store.world.projects[projectId];
    wm.open({ kind: 'fleet', key: `project:${projectId}`, callsign: p?.code ?? '??', title: p?.name, at: at && { x: at.x, y: at.y }, params: { scope: 'project', id: projectId } });
  },
  openMachine(machineId, at) {
    const m = store.world.machines[machineId];
    wm.open({ kind: 'fleet', key: `machine:${machineId}`, callsign: (m?.hostname ?? '??').toUpperCase().slice(0, 12), at: at && { x: at.x, y: at.y }, params: { scope: 'machine', id: machineId } });
  },
  openSquad(name, at) {
    wm.open({ kind: 'fleet', key: `squad:${name}`, callsign: name.toUpperCase().slice(0, 12), at: at && { x: at.x, y: at.y }, params: { scope: 'squad', id: name } });
  },
  openGroup(ids, at) {
    if (!ids.length) return;
    wm.open({ kind: 'fleet', key: `group:${ids.slice().sort().join(',')}`, callsign: `${ids.length} AGENTS`, at: at && { x: at.x, y: at.y }, params: { scope: 'group', ids: ids.join(',') }, ephemeral: true });
  },
  openCeo: () => { wm.open({ kind: 'ceo', key: 'ceo', callsign: 'CAPCOM' }); },
  openQueue: () => { wm.open({ kind: 'queue', key: 'queue', callsign: 'QUEUE' }); },
  openFeed: () => { wm.open({ kind: 'feed', key: 'feed', callsign: 'FEED' }); },
  openFleet: () => { wm.open({ kind: 'fleet', key: 'fleet', callsign: 'FLEET', params: { scope: 'all' } }); },
  openSpawn(projectId, parentId) {
    wm.open({ kind: 'spawn', key: `spawn:${parentId ?? projectId ?? 'new'}`, callsign: 'SPAWN', params: { projectId: projectId ?? '', parentId: parentId ?? '' }, ephemeral: true });
  },
  openHelp: () => { wm.open({ kind: 'help', key: 'help', callsign: 'HELP', ephemeral: true }); },
  openSettings: () => { wm.open({ kind: 'settings', key: 'settings', callsign: 'SETTINGS', ephemeral: true }); },
  openGallery: () => { wm.open({ kind: 'gallery', key: 'gallery', callsign: 'GALLERY' }); },
  openTimeline: () => { wm.open({ kind: 'timeline', key: 'timeline', callsign: 'TIME' }); },
  openSfx: () => { wm.open({ kind: 'sfx', key: 'sfx', callsign: 'SFX' }); },
  openMusic: () => { wm.open({ kind: 'music', key: 'music', callsign: 'MUSIC' }); },
  startMusic() {
    const w = wm.open({ kind: 'music', key: 'music', callsign: 'MUSIC' });
    w.inst?.start?.();
  },
  setReplay(world: WorldState | null) {
    const entering = !!world && replayEl.hidden;
    if (entering) getSound()?.play('replay.enter');
    if (!world && !replayEl.hidden) getSound()?.play('replay.exit');
    field.setReplay(world);
    // The past may stand elsewhere on the field; frame it on the way in.
    if (entering) setTimeout(() => field.frameAll(), 60);
    replayEl.hidden = !world;
    fieldEl.classList.toggle('is-replay', !!world);
    if (world) replayEl.querySelector('[data-replay-t]')!.textContent = `REPLAY · ${clock(world.at)}`;
  },
  openLaunch(preset, fire) {
    wm.open({ kind: 'launch', key: 'launch', callsign: 'LAUNCH', ephemeral: true, params: { preset: preset ?? '', fire: fire ? '1' : '' } });
  },

  go(agentId) {
    marks.push();
    field.select([agentId]);
    field.flyTo(agentId);
    cmd.setSelection([]);
  },
  pushView() { marks.push(); },
  deck(sort) {
    const cur = field.layoutMode();
    marks.push();
    if (cur.kind === 'deck' && (!sort || cur.sort === sort)) { getSound()?.play('deck.exit'); field.setLayoutMode({ kind: 'field' }); mast.setDeck(null); c.note('back to the field'); }
    else { const s = sort ?? 'state'; getSound()?.play(cur.kind === 'deck' ? 'deck.sort' : 'deck.enter'); field.setLayoutMode({ kind: 'deck', sort: s }); mast.setDeck(s); c.note(`deck · by ${s}`); }
  },

  async say(ids, text) {
    let ok = 0;
    const failed: string[] = [];
    await Promise.all(ids.map(async (id) => {
      try { await hub.cmd({ k: 'say', agentId: id, text }); ok++; }
      catch { failed.push(store.world.agents[id]?.callsign ?? id); }
    }));
    if (failed.length) c.note(`could not reach ${failed.join(', ')}`, 'warn');
    else c.note(`said to ${ok} agent${ok === 1 ? '' : 's'}: ${text.slice(0, 60)}`);
    return { ok, failed };
  },
  async stop(agentId) {
    const cs = store.world.agents[agentId]?.callsign ?? agentId;
    try { await hub.cmd({ k: 'stop', agentId }); c.note(`stopped ${cs}`, 'warn'); }
    catch (err) { c.note(`could not stop ${cs}: ${(err as Error).message}`, 'alert'); }
  },
  answer(escalationId, answer, rememberAs) {
    hub.answer(escalationId, answer, rememberAs);
    const e = store.world.escalations[escalationId];
    if (e) { e.status = 'answered'; e.answer = answer; e.answeredBy = 'human'; store.injectForTest(e); }
    c.note(`answered ${store.world.agents[e?.agentId ?? '']?.callsign ?? ''}: ${answer.slice(0, 60)}`);
  },
  placeArtifact(id) {
    const a = store.world.artifacts?.[id];
    if (!a) return;
    const n = Object.values(store.world.artifacts).filter((x) => x.placement && x.agentId === a.agentId).length;
    a.placement = field.placeNear(a.agentId, n);
    getSound()?.play('placed');
    saveArtifactPlacements();
    field.feed();
    wm.closeKey(`art:${id}`);
    // Fly to where the tile and its new surface both fit.
    const s = field.spotOf(a.agentId);
    if (s) field.flyToPoint((s.x + a.placement.x) / 2, (s.y + a.placement.y) / 2, 7.5);
  },
  unplaceArtifact(id) {
    const a = store.world.artifacts?.[id];
    if (!a) return;
    a.placement = null;
    saveArtifactPlacements();
    field.feed();
  },
  note(text, level = 'info') {
    store.applyPatch(store.world.rev, [{ o: 'feed', v: [{ id: `local_${Date.now().toString(36)}`, at: Date.now(), level, source: 'YOU', text }] }]);
  },
  menu(target, at) {
    showContext({
      c,
      sayTo(ids) { field.select(ids); cmd.setSelection(ids); cmd.focus(); },
      toggleTilt() { field.setTilt(!field.tilted()); mast.setTilt(field.tilted()); getSound()?.play(field.tilted() ? 'tilt.on' : 'tilt.off'); },
    }, target, at);
  },
};

wm.register('agent', (ctx) => mountAgent(ctx, c));
wm.register('interrupt', (ctx) => mountInterrupt(ctx, c));
wm.register('queue', (ctx) => mountQueue(ctx, c));
wm.register('ceo', (ctx) => mountCeo(ctx, c));
wm.register('feed', (ctx) => mountFeed(ctx, c));
wm.register('fleet', (ctx) => mountFleet(ctx, c));
wm.register('spawn', (ctx) => mountSpawn(ctx, c));
wm.register('artifact', (ctx) => mountArtifact(ctx, c));
wm.register('breach', (ctx) => mountBreach(ctx));
wm.register('help', (ctx) => mountHelp(ctx));
wm.register('settings', (ctx) => mountSettings(ctx, c));
wm.register('gallery', (ctx) => mountGallery(ctx, c));
wm.register('launch', (ctx) => mountLaunch(ctx, c));
wm.register('timeline', (ctx) => mountTimeline(ctx, c));
wm.register('sfx', (ctx) => mountSfx(ctx, c));
wm.register('music', (ctx) => mountMusic(ctx, c));

const mast = mountMast(hudEl, c);
const cmd = mountCommand(dockEl, c);
const tray = mountTray(dockEl, wm, (w, x, y) => c.menu({ kind: 'window', winId: w.id }, { x, y }));
const minimap = mountMinimap(hudEl, c);
// The mast may wrap to two rows; the field clips its labels under whatever height it has.
{
  const mastEl = hudEl.querySelector<HTMLElement>('.mast');
  if (mastEl) {
    const ro = new ResizeObserver(() => app.style.setProperty('--hud-top', `${Math.round(mastEl.offsetTop + mastEl.offsetHeight + 8)}px`));
    ro.observe(mastEl);
  }
}
const marks = mountBookmarks(hudEl, c);
hudEl.querySelector('.mast__brand')?.appendChild(marks.el);
const snd = mountSound();
// The mute switch lives in the SFX window (⌥S, then M); the mast stays a row of openers.
void snd;

selbar.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-s]');
  if (!b) return;
  const ids = field.selection();
  switch (b.dataset.s) {
    case 'window': c.openGroup(ids, { x: e.clientX, y: e.clientY }); break;
    case 'say': cmd.focus(); break;
    case 'frame': { const first = ids[0]; if (first) { field.flyTo(first, 10); getSound()?.play('frame'); } break; }
    case 'clear': field.select([]); cmd.setSelection([]); selbar.hidden = true; break;
  }
});

/* ── Artifact placements persist locally, like agent placements ───── */

const ART_KEY = 'orca.artifacts.placed.v1';
function saveArtifactPlacements() {
  try {
    const list = Object.values(store.world.artifacts ?? {}).filter((a) => a.placement).map((a) => ({ id: a.id, p: a.placement }));
    localStorage.setItem(ART_KEY, JSON.stringify(list));
  } catch { /* fine */ }
}
function restoreArtifactPlacements() {
  try {
    const raw = localStorage.getItem(ART_KEY);
    if (!raw) return;
    for (const { id, p } of JSON.parse(raw) as { id: string; p: Artifact['placement'] }[]) {
      const a = store.world.artifacts?.[id];
      if (a && p) a.placement = p;
    }
  } catch { /* fine */ }
}

/* ── Store → console reactions ───────────────────────────────────── */

/*
 * Which interrupts open themselves. A backlog never does: loading a console
 * with forty pending questions and forty windows is a console you cannot see.
 * What arrives while you are looking opens next to its tile — if the tile is
 * on screen and big enough to read, and only three at a time. Everything else
 * is a count on the mast and a row in the queue.
 */
const MAX_AUTO_INTERRUPTS = 3;
const seenEsc = new Set<string>();
let backlogAbsorbed = false;
function autoOpenInterrupts() {
  if (store.booting) return;
  if (!backlogAbsorbed) {
    for (const e of store.pending()) seenEsc.add(e.id);
    backlogAbsorbed = true;
    return;
  }
  const open = wm.all().filter((w) => w.spec.kind === 'interrupt' && !w.minimized).length;
  let room = MAX_AUTO_INTERRUPTS - open;
  for (const e of store.pending()) {
    if (seenEsc.has(e.id)) continue;
    seenEsc.add(e.id);
    if (room <= 0) continue;
    const r = field.screenOf(e.agentId);
    if (!r || !r.visible || r.w < 40) continue;
    room--;
    const a = store.world.agents[e.agentId];
    wm.open({ kind: 'interrupt', key: `int:${e.id}`, callsign: a?.callsign ?? '??', project: store.world.projects[e.projectId]?.code, title: a?.title, anchor: e.agentId, params: { escalationId: e.id, agentId: e.agentId, quiet: '1' }, ephemeral: true });
  }
}
/*
 * An artifact an agent asked to open (`orca-show --open`) opens itself next
 * to the tile, with the same discipline as an interrupt: never from a
 * backlog, at most three at a time, only if its tile is on screen.
 */
const MAX_AUTO_ARTIFACTS = 3;
const seenArt = new Set<string>();
let artBacklogAbsorbed = false;
function autoOpenArtifacts(ids: string[]) {
  if (store.booting) return;
  if (!artBacklogAbsorbed) {
    for (const id of Object.keys(store.world.artifacts ?? {})) seenArt.add(id);
    artBacklogAbsorbed = true;
    return;
  }
  const open = wm.all().filter((w) => w.spec.kind === 'artifact' && !w.minimized).length;
  let room = MAX_AUTO_ARTIFACTS - open;
  for (const id of ids) {
    if (seenArt.has(id)) continue;
    seenArt.add(id);
    const a = store.world.artifacts?.[id];
    if (!a || !a.open || room <= 0) continue;
    const r = field.screenOf(a.agentId);
    if (!r || !r.visible) continue;
    room--;
    const ag = store.world.agents[a.agentId];
    wm.open({ kind: 'artifact', key: `art:${id}`, callsign: ag?.callsign ?? '??', project: store.world.projects[a.projectId]?.code, title: a.title, anchor: a.agentId, params: { artifactId: id, agentId: a.agentId }, ephemeral: true });
    c.note(`${ag?.callsign ?? '??'} opened ${a.title}`);
  }
}

function closeAnswered(ids: string[]) {
  for (const id of ids) {
    const e: Escalation | undefined = store.world.escalations[id];
    if (!e || (e.status !== 'pending' && e.status !== 'with_ceo')) wm.closeKey(`int:${id}`);
  }
}

store.on((e) => {
  if (e.k === 'world' || e.k === 'agents' || e.k === 'projects' || e.k === 'traffic' || e.k === 'artifacts' || e.k === 'escalations') field.feed();
  if (e.k === 'world') { restoreArtifactPlacements(); field.feed(); }
  if (e.k === 'escalations') { closeAnswered(e.ids); autoOpenInterrupts(); }
  if (e.k === 'artifacts') autoOpenArtifacts(e.ids);
  if (e.k === 'world') autoOpenArtifacts(Object.keys(store.world.artifacts ?? {}));
  if (e.k === 'world') autoOpenInterrupts();
  if (e.k === 'link') {
    fieldEl.classList.toggle('is-breach', !e.up);
    if (e.up) wm.closeKey('breach');
    else if (!store.booting) wm.open({ kind: 'breach', key: 'breach', callsign: 'SYS', ephemeral: true, w: 560, h: 110, at: { x: window.innerWidth / 2 - 290, y: 90 } });
  }
});

/* ── Keys ─────────────────────────────────────────────────────────── */

/*
 * Keyboard, in order of who owns it:
 *   1. the active window (single letters scoped to it, via wm.handleKey)
 *   2. chords with a modifier, which work anywhere: ⌘K the command line,
 *      ⌥+letter opens a window, ⌥1…9 bookmarks, ⌥⇧1…9 sets them
 *   3. the field's own keys, only when no window is active
 * Single letters are never global for openers: that is how a keyboard saturates.
 */
const ALT_OPEN: Record<string, () => void> = {
  KeyC: () => c.openCeo(), KeyQ: () => c.openQueue(), KeyF: () => c.openFeed(), KeyE: () => c.openFleet(),
  KeyN: () => c.openSpawn(), KeyL: () => c.openLaunch(), KeyG: () => c.openGallery(), KeyT: () => c.openTimeline(),
  KeyM: () => c.openMusic(), KeyS: () => c.openSfx(), KeyH: () => c.openHelp(), Comma: () => c.openSettings(),
};
/*
 * ⌥Tab is the switcher: hold ⌥, each Tab walks the stack (⇧ walks back)
 * with the tray cursor showing where you are, and letting go of ⌥ raises
 * the window under the cursor. Esc while holding cancels. It rides on the
 * tray mode the manager already has, so the row and the switcher agree.
 */
let switching = false;
const synth = (key: string, shift = false) => new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true });
function commitSwitch(cancel = false) {
  if (!switching) return;
  switching = false;
  const id = wm.trayCursorId();
  wm.exitTrayMode();
  if (cancel || !id) return;
  const w = wm.all().find((x) => x.id === id);
  if (!w) return;
  if (w.minimized) wm.restore(w); else wm.focus(w);
}
window.addEventListener('keyup', (e) => { if (e.key === 'Alt' && switching) commitSwitch(); });
window.addEventListener('blur', () => commitSwitch(true));

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (e.altKey && e.key === 'Tab') {
    e.preventDefault();
    if (!wm.all().length) return;
    if (!switching) { switching = true; if (!wm.trayMode()) wm.enterTrayMode(); }
    wm.handleKey(synth(e.shiftKey ? 'ArrowLeft' : 'ArrowRight'));
    return;
  }
  if (switching) {
    // ⌥ is still down, so the tray's own keys arrive mangled (⌥1 is ¡ on a
    // Mac). Rebuild them from the physical key and hand them to tray mode
    // without the modifier; ↵ lands like letting go of ⌥.
    e.preventDefault();
    if (e.key === 'Escape') { commitSwitch(true); return; }
    if (e.key === 'Enter') { commitSwitch(); return; }
    const code = e.code;
    const key = /^Digit[1-9]$/.test(code) ? code.slice(5)
      : /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase()
      : code === 'Minus' ? '-' : code === 'Backquote' ? '`'
      : (e.key === 'Backspace' || e.key === 'Delete' || e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') ? e.key : '';
    if (key) wm.handleKey(synth(key, e.shiftKey));
    return;
  }
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.code === 'KeyK') { e.preventDefault(); cmd.focus(); return; }
  if (e.altKey && !e.metaKey && !e.ctrlKey) {
    const open = ALT_OPEN[e.code];
    if (open) { e.preventDefault(); open(); return; }
    if (e.code >= 'Digit1' && e.code <= 'Digit9') {
      e.preventDefault();
      const n = Number(e.code.slice(5));
      if (e.shiftKey) marks.save(n);
      else { marks.push(); if (!marks.go(n)) c.note(`bookmark ${n} is empty · ⌥⇧${n} to set it`); }
      return;
    }
  }
  if (!typing && wm.handleKey(e)) return;
  if (e.key === 'Escape') {
    if (typing) { (t as HTMLElement).blur(); return; }
    const top = wm.focused();
    if (top) wm.close(top);
    else { field.select([]); cmd.setSelection([]); selbar.hidden = true; }
    return;
  }
  if (typing) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (e.repeat) return;
    if (field.setFocus(true)) getSound()?.play('focus.on');
    else { hintEl.textContent = 'SELECT AN AGENT FIRST · CLICK, OR SHIFT+DRAG A LASSO'; hintEl.classList.add('is-on'); setTimeout(() => hintEl.classList.remove('is-on'), 2500); }
    return;
  }
  if (e.key === '/') { e.preventDefault(); cmd.focus(); return; }
  if (e.key === 'F11') { e.preventDefault(); void toggleFullscreen(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Backspace') { e.preventDefault(); if (!marks.back()) c.note('nowhere to go back to'); return; }
  if (wm.focused()) return;
  switch (e.key.toLowerCase()) {
    case 'f': marks.push(); field.frameAll(); getSound()?.play('frame'); break;
    case 'o': field.setTilt(!field.tilted()); mast.setTilt(field.tilted()); getSound()?.play(field.tilted() ? 'tilt.on' : 'tilt.off'); break;
    case 'd': c.deck(); break;
    case 'm': minimap.toggle(); break;
    case 'z': void toggleFullscreen(); break;
    case '?': c.openHelp(); break;
    case 'tab': {
      e.preventDefault();
      const blocked = store.blockedAgents().filter((a) => a.block?.kind !== 'peer');
      if (!blocked.length) { c.note('nobody is waiting on you'); break; }
      tabIdx = (tabIdx + 1) % blocked.length;
      const a = blocked[tabIdx]!;
      c.go(a.id);
      const esc0 = Object.values(store.world.escalations).find((x) => x.agentId === a.id && (x.status === 'pending' || x.status === 'with_ceo'));
      if (esc0) c.openInterrupt(esc0.id); else c.openAgent(a.id);
      break;
    }
  }
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') { field.setFocus(false); getSound()?.play('focus.off'); } });
window.addEventListener('blur', () => field.setFocus(false));
onFullscreen((on) => c.note(on ? 'fullscreen · Z or ESC to leave' : 'back in the window'));
let tabIdx = -1;

/* ── Hints: who has the keyboard, and what it does ───────────────── */

const hintsEl = dockEl.querySelector<HTMLElement>('[data-hints]')!;
let hintsSig = '';
const FIELD_HINTS: [string, string][] = [
  ['⌘K', 'TALK'], ['F', 'FRAME'], ['D', 'DECK'], ['O', 'TILT'], ['Z', 'FULL'], ['M', 'MAP'], ['SPACE', 'FOCUS'], ['TAB', 'NEXT BLOCKED'], ['⌥TAB', 'SWITCH'], ['`', 'WINDOWS'], ['⌥H', 'HELP'],
];
const TRAY_HINTS: [string, string][] = [
  ['← →', 'MOVE'], ['1…9', 'JUMP'], ['↵', 'OPEN · CLOSE'], ['-', 'FOLD'], ['⌫', 'CLOSE'], ['V', 'REVEAL'], ['ESC', 'LEAVE'],
];
function hintsFor(): [string, string][] {
  if (wm.trayMode()) return TRAY_HINTS;
  const w = wm.focused();
  if (!w) return FIELD_HINTS;
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const b of w.el.querySelectorAll<HTMLElement>('[data-key]')) {
    if (b.hidden || b.offsetParent === null || (b as HTMLButtonElement).disabled) continue;
    const key = (b.dataset.key ?? '').split(' ')[0] ?? '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // The button's own words, without the keycap the manager injected.
    const label = b.dataset.keyLabel ?? [...b.childNodes].filter((n) => !(n instanceof HTMLElement && n.tagName === 'KBD')).map((n) => n.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    out.push([kbdLabel(key), label.toUpperCase().slice(0, 18)]);
    if (out.length >= 7) break;
  }
  out.push(['ESC', 'CLOSE'], ['-', 'FOLD'], ['⌥TAB', 'SWITCH'], ['`', 'WINDOWS']);
  if (w.spec.anchor) out.push(['V', 'REVEAL']);
  return out;
}
function renderHints() {
  const list = hintsFor();
  const sig = list.map((h) => h.join('=')).join('|');
  if (sig === hintsSig) return;
  hintsSig = sig;
  hintsEl.innerHTML = list.map(([k, v]) => `<span class="hints__i"><kbd>${esc(k)}</kbd>${esc(v)}</span>`).join('');
}

/* ── Frame loop for the DOM that follows the field ───────────────── */

let statsAt = 0;
function loop(now: number) {
  requestAnimationFrame(loop);
  wm.reproject();
  minimap.tick();
  if (now - statsAt > 250) {
    statsAt = now;
    renderHints();
    const s = field.stats();
    statsEl.innerHTML = `${s.agents} AGENTS · ${s.drawn} DRAWN<br/>${s.segments} PIPES · ${s.fps} FPS`;
  }
}

/* ── Boot, then the field ─────────────────────────────────────────── */

async function start() {
  const skipBoot = params.get('noboot') === '1' || sessionStorage.getItem('orca.booted') === '1';
  if (!skipBoot) {
    const boot = runBoot(app);
    await boot.done;
    try { sessionStorage.setItem('orca.booted', '1'); } catch { /* fine */ }
  } else {
    store.booting = false;
  }
  fieldEl.classList.add('is-live');
  document.body.classList.add('is-field');
  field.setActive(true);
  requestAnimationFrame(loop);
  wm.restoreSession((spec) => wm.open(spec));
  /*
   * The record player, if the operator asked for it. A window restored from
   * last time is already there and already arming itself; a fresh one opens
   * folded when Spotify will start on its own, and on the glass when the
   * record is a Bandcamp one, whose ▶ only a hand can press.
   */
  if (getPref('musicAutoplay') && !wm.all().some((w) => w.spec.key === 'music')) {
    const w = wm.open({ kind: 'music', key: 'music', callsign: 'MUSIC' });
    if (activeMusic()?.kind === 'spotify') wm.minimize(w);
  }
  restoreArtifactPlacements();
  field.feed();
  setTimeout(() => field.frameAll(), 50);
  autoOpenInterrupts();
  if (!store.linkUp) fieldEl.classList.add('is-breach');
  hintEl.classList.add('is-on');
  setTimeout(() => hintEl.classList.remove('is-on'), 9000);
  if (!wm.all().length && Object.keys(store.world.agents).length === 0) {
    c.note('no agents yet · run a collector on a machine with Claude Code sessions, or npm run mock');
  }
}

void start();

/* ── Test hooks ───────────────────────────────────────────────────── */

(window as unknown as { __orca: Record<string, unknown> }).__orca = {
  frame: () => field.frameAll(),
  open: (id: string) => c.openAgent(id),
  openKind: (k: string) => { ({ ceo: c.openCeo, queue: c.openQueue, feed: c.openFeed, fleet: c.openFleet, help: c.openHelp } as Record<string, () => void>)[k]?.(); },
  tilt: (on: boolean) => field.setTilt(on),
  stats: () => field.stats(),
  view: () => field.viewRect(),
  focus: (on: boolean) => field.setFocus(on),
  replay: (w: WorldState | null) => c.setReplay(w),
  openKind2: (k: string) => { ({ gallery: c.openGallery, timeline: c.openTimeline, launch: () => c.openLaunch() } as Record<string, () => void>)[k]?.(); },
  select: (ids: string[]) => field.select(ids),
  note: (t: string) => c.note(esc(t)),
  screenOf: (id: string) => field.screenOf(id),
  music: () => wm.all().find((w) => w.spec.key === 'music')?.inst?.state?.() ?? null,
  spotOf: (id: string) => field.spotOf(id),
};
