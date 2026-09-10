import { syncPushSubscription } from './push.ts';
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
import './styles/improve.css';
import './styles/strays.css';

import type { Artifact, Escalation, WorldState } from '../shared/types.ts';
import type { InterruptOutcome } from '../shared/interrupt.ts';
import { store } from './store.ts';
import { hub, uploadFile } from './net/client.ts';
import { gesture, mountGestures } from './gestures.ts';
import { guardStrayDrops, stage, uploadAll } from './windows/attach.ts';
import { fieldKindOf, isPlacedFileId, placedFiles } from './placed-files.ts';
import { draftKey } from './drafts.ts';
import { runBoot } from './boot.ts';
import { createField } from './field/field.ts';
import { mountDirector } from './director.ts';
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
import { mountHygiene } from './windows/kinds/hygiene.ts';
import { mountMission } from './windows/kinds/mission.ts';
import { getPref } from './prefs.ts';
import { mountGallery } from './windows/kinds/gallery.ts';
import { mountLaunch } from './windows/kinds/launch.ts';
import { mountTimeline } from './windows/kinds/timeline.ts';
import { mountTerminal } from './windows/kinds/terminal.ts';
import { mountFile, projectCodeOf } from './windows/kinds/file.ts';
import { mountFiles } from './windows/kinds/files.ts';
import { bindFileLinks } from './windows/file-links.ts';
import { clock } from './util.ts';
import { mountMast } from './hud/mast.ts';
import { onFullscreen, toggleFullscreen } from './hud/fullscreen.ts';
import { mountCommand } from './hud/command.ts';
import { mountTray } from './hud/tray.ts';
import { mountUpdate } from './hud/update.ts';
import { mountMinimap } from './hud/minimap.ts';
import { mountBookmarks } from './hud/bookmarks.ts';
import { mountSound, getSound, openSoundFor } from './hud/sound.ts';
import { mountVoice } from './hud/voice.ts';
import { mountSfx } from './windows/kinds/sfx.ts';
import { activeMusic, mountMusic } from './windows/kinds/music.ts';
import { mountCursor } from './hud/cursor.ts';
import { showContext } from './hud/context.ts';
import { mountAlarm } from './hud/alarm.ts';
import { mountHandshake } from './handshake.ts';
import { mountMissions } from './hud/missions.ts';
import { mountImprove } from './hud/improve.ts';
import { mountSections } from './hud/sections.ts';
import type { At, Console } from './console.ts';
import { esc } from './util.ts';
import { keyHold, typing as typingIn } from './keys.ts';
import { applyToRoot, gsapDefaults } from './motion.ts';
import { applyFonts } from './fonts.ts';

// One motion contract for CSS, GSAP and the shaders, before anything mounts.
applyToRoot();
gsapDefaults();
// And the two faces, before the boot paints its first glyph.
applyFonts();

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
// Push-to-talk (hud/voice.ts). Its strip lives in the dock, above every
// window, like the command line the spoken word stands in for. A heard line
// goes down the composer's own `say`, so CAPCOM never knows it was spoken.
const voice = mountVoice(dockEl, { send: (t) => hub.say(t), note: (t, l) => c.note(t, l) });
const statsEl = hudEl.querySelector<HTMLElement>('[data-stats]')!;
const hintEl = hudEl.querySelector<HTMLElement>('[data-hint]')!;
const selbar = hudEl.querySelector<HTMLElement>('[data-selbar]')!;
const replayEl = hudEl.querySelector<HTMLElement>('[data-replay]')!;
replayEl.querySelector('[data-replay-live]')!.addEventListener('click', () => { c.setReplay(null); wm.closeKey('timeline'); });

hub.connect();
// Los gestos de la interfaz salen hacia AUTOMEJORA por el enlace, en lotes.
// Se conecta aquí, antes de que exista nada que pulsar: lo que se cuente
// mientras el enlace sube espera en el contador y sale con el primer lote.
mountGestures((counts) => hub.gestures(counts));

/* ── Window manager, before the field so the field can hand it events ── */

const wm = new WindowManager(app, {
  tileRect: (id) => field.screenOf(id),
  plane: () => field.windowPlane(),
  agentOrigin: (id) => field.windowOrigin(id),
  onLocateWindow: (bounds) => { c.pushView(); field.frameWindow(bounds); },
  project: (x, y) => field.windowProjection(x, y),
  unproject: (x, y) => field.windowPoint(x, y),
  onZoom: (e) => fieldEl.dispatchEvent(new WheelEvent('wheel', {
    clientX: e.clientX, clientY: e.clientY, deltaY: e.deltaY, deltaMode: e.deltaMode,
    ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: true, cancelable: true,
  })),
  onTray: (list) => tray.render(list),
  onStack: (list) => { tray.render(list); document.body.classList.toggle('has-tray', wm.trayRow().length > 0); },
  onReveal: (agentId) => { c.pushView(); field.frameAround(agentId); },
  onContext: (w, x, y) => c.menu({ kind: 'window', winId: w.id }, { x, y }),
  onFocus: (w) => {
    // With a window active, the window owns the keyboard; the mast's caps dim to say so.
    document.body.classList.toggle('has-window', !!w);
    // «La misión abierta» es la ventana de misión que está delante: el panel
    // del HUD marca su fila y el arco del campo la sigue. Con varias abiertas
    // a la vez, la respuesta tiene que ser una sola, y es la que se mira.
    if (w?.spec.kind === 'mission' && w.spec.params?.missionId) store.selectMission(w.spec.params.missionId);
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
      const id = ids[0]!;
      const key = store.world.agents[id]?.role === 'capcom' ? 'ceo' : `agent:${id}`;
      wm.toggleSource(key, () => c.openAgent(id, { x: at.sx, y: at.sy }));
    }
  },
  onOpen: (id, x, y) => c.openAgent(id, { x, y }),
  onOpenProject: (id, x, y) => c.openProject(id, { x, y }),
  onOpenSquad: (name, projectId, x, y) => { void projectId; c.openSquad(name, { x, y }); },
  onOpenArtifact: (id, x, y) => c.openArtifact(id, { x, y }),
  onContext: (target, x, y) => c.menu(target, { x, y }),
  onPlace: () => { /* persisted locally by the field; the hub has no placement channel yet */ },
  onPlaceArtifact(id, x, y, z) {
    if (isPlacedFileId(id)) { placedFiles.move(id, { x, y, z }); field.setExtraMedia(placedFiles.artifacts()); return; }
    const a = store.world.artifacts?.[id];
    if (a) { a.placement = { x, y, z }; saveArtifactPlacements(); }
  },
  onUnplaceArtifact: (id) => c.unplaceArtifact(id),
  onHover: (id) => cursor.setTarget(!!id),
  /*
   * An image or a video dropped on the field stays on the field, where it
   * was let go: a surface like a placed artifact (ui/placed-files.ts). Any
   * other file goes to a conversation: dropped on a tile, to that agent;
   * on open ground, to CAPCOM. Nothing is sent: the window opens and the
   * file's path lands in its composer, for the operator to say what to do
   * with it. The window opens first, so the gesture answers at once; the
   * path follows the upload.
   */
  onDropFiles(files, agentId, sx, sy, at) {
    const media = files.filter((f) => fieldKindOf(f.name));
    const rest = files.filter((f) => !fieldKindOf(f.name));
    if (media.length) {
      void uploadAll(media, uploadFile, c.note).then((paths) => {
        // Several at once fan out a little, so none hides the one before it.
        paths.forEach((p, i) => placedFiles.add(p, { x: at.x + i * 0.5, y: at.y - i * 0.35, z: at.z }));
        if (paths.length) { getSound()?.play('placed'); syncPlacedFiles(); }
      });
    }
    if (!rest.length) return;
    const a = agentId ? store.world.agents[agentId] : undefined;
    const toAgent = !!a && a.role !== 'capcom';
    if (toAgent) c.openAgent(a.id, { x: sx, y: sy }); else c.openCeo({ x: sx, y: sy });
    void uploadAll(rest, uploadFile, c.note).then((paths) => stage(toAgent ? draftKey('agent', a.id) : draftKey('capcom'), paths));
  },
});
// A flight lands in the clear: the windows standing on the glass —front and
// pinned, in screen pixels— are what a tile can end up behind. Canvas windows
// move with the plane, so the camera cannot get a tile out from under one.
field.setObstacles(() => wm.stack().filter((w) => w.mode !== 'canvas').map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h })));
/** The operator's placed files are drawn with the artifacts; this hands the field the current list. */
function syncPlacedFiles() { field.setExtraMedia(placedFiles.artifacts()); field.feed(); }
syncPlacedFiles();
// A file dropped where nothing takes it must not become the page.
guardStrayDrops();
// The panel's brightness is the operator's; it comes back the way they left it.
field.setGroundLevel(getPref('panel'));
field.setGroundColor(getPref('panelColor'));

/* ── HUD ──────────────────────────────────────────────────────────── */

const cursor = mountCursor();
mountAlarm();
// Antes que los atajos de teclado de más abajo: mientras el hub no acepte el
// token, el handshake se come el evento y aquí no llega ninguno.
mountHandshake();

/* ── The console object: everything crosses here ──────────────────── */

/**
 * El navegador de una carpeta (kinds/files.ts). Un proyecto ata su ventana
 * por id, para que abrirlo dos veces sea volver a la misma; una carpeta
 * suelta —el arnés visual— va por su ruta.
 */
function openFilesAt(root: string, opts: { project?: string; key?: string; at?: At } = {}) {
  const params: Record<string, string> = { root };
  if (opts.project) params.project = opts.project;
  const at = opts.at;
  wm.open({ kind: 'files', key: opts.key ?? `files:${root}`, callsign: opts.project ?? 'FILES', project: opts.project ? 'FILES' : undefined, title: root.split('/').pop() || root, at: at && { x: at.x, y: at.y }, params });
}

const c: Console = {
  field, wm, voice,
  openAgent(agentId, at) {
    const a = store.world.agents[agentId];
    if (!a) return;
    // CAPCOM no tiene ventana de agente: el mando se mira en la ventana del
    // mando. La llave está aquí y no en cada llamador, así que la baldosa, el
    // rótulo, el director, la lista de flota y cualquier [data-go] acaban en
    // la misma ventana que abre ⌥C — misma `key`, luego enfoca, no duplica.
    if (a.role === 'capcom') {
      wm.open({ kind: 'ceo', key: 'ceo', callsign: 'CAPCOM', anchor: agentId, at });
      return;
    }
    const p = store.world.projects[a.projectId];
    wm.open({ kind: 'agent', key: `agent:${agentId}`, callsign: a.callsign, project: p?.code, title: a.title, anchor: agentId, at: at && { x: at.x, y: at.y }, params: { agentId }, ephemeral: true });
  },
  openTerminal(agentId, at) {
    const a = store.world.agents[agentId];
    if (!a) return;
    const p = store.world.projects[a.projectId];
    wm.open({ kind: 'terminal', key: `term:${agentId}`, callsign: a.callsign, project: p?.code, title: 'TERMINAL', anchor: agentId, at: at && { x: at.x, y: at.y }, params: { agentId }, ephemeral: true });
  },
  openInterrupt(escalationId, at) {
    const e = store.world.escalations[escalationId];
    if (!e) return;
    const a = store.world.agents[e.agentId];
    wm.open({ kind: 'interrupt', key: `int:${escalationId}`, callsign: a?.callsign ?? '??', project: store.world.projects[e.projectId]?.code, title: a?.title, anchor: e.agentId, at: at && { x: at.x, y: at.y }, params: { escalationId, agentId: e.agentId }, ephemeral: true });
  },
  openArtifact(artifactId, at) {
    // A placed file has no artifact window; the file viewer is its window.
    const placed = placedFiles.get(artifactId);
    if (placed) { c.openFile({ path: placed.path }, { at }); return; }
    const x = store.world.artifacts?.[artifactId];
    if (!x) return;
    const a = store.world.agents[x.agentId];
    wm.open({ kind: 'artifact', key: `art:${artifactId}`, callsign: a?.callsign ?? '??', project: store.world.projects[x.projectId]?.code, title: x.title, at: at && { x: at.x, y: at.y }, params: { artifactId, agentId: x.agentId }, ephemeral: true });
  },
  openFile(file, opts) {
    const key = `file:${file.path}${opts?.fresh ? `#${Date.now().toString(36)}` : ''}`;
    const line = file.line ?? null;
    const params: Record<string, string> = { path: file.path };
    if (line !== null) params.line = String(line);
    if (file.col != null) params.col = String(file.col);
    if (file.agentId) params.agentId = file.agentId;
    const project = file.project ?? projectCodeOf(file.agentId);
    if (project) params.project = project;
    const at = opts?.at;
    wm.open({ kind: 'file', key, project, title: file.path.split('/').pop() ?? file.path, at: at && { x: at.x, y: at.y }, params });
  },
  openFiles(projectId, at) {
    const p = store.world.projects[projectId];
    if (!p) return;
    openFilesAt(p.path, { project: p.code, key: `files:${projectId}`, at });
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
  openCeo: (at) => { wm.open({ kind: 'ceo', key: 'ceo', callsign: 'CAPCOM', at: at && { x: at.x, y: at.y } }); },
  openMission(missionId, opts) {
    // One window per mission: the key is the id, so a second click on the same
    // row raises the one that is up instead of stacking another copy of it.
    const win = wm.open({
      kind: 'mission', key: `mission:${missionId}`, callsign: 'MISSION',
      params: { missionId, ...(opts?.tab ? { tab: opts.tab } : {}) },
      ...(opts?.at ? { at: opts.at } : {}),
    });
    // Ya estaba abierta y la piden por la otra mitad: se cambia de pestaña en
    // vez de abrir una segunda ventana de lo mismo.
    if (opts?.tab) (win.inst as { setTab?(t: string): void } | undefined)?.setTab?.(opts.tab);
  },
  openQueue: () => { wm.open({ kind: 'queue', key: 'queue', callsign: 'QUEUE' }); },
  openFeed: () => { wm.open({ kind: 'feed', key: 'feed', callsign: 'FEED' }); },
  openFleet: () => { wm.open({ kind: 'fleet', key: 'fleet', callsign: 'FLEET', params: { scope: 'all' } }); },
  openSpawn(projectId, parentId) {
    wm.open({ kind: 'spawn', key: `spawn:${parentId ?? projectId ?? 'new'}`, callsign: 'SPAWN', params: { projectId: projectId ?? '', parentId: parentId ?? '' }, ephemeral: true });
  },
  openHelp: () => { wm.open({ kind: 'help', key: 'help', callsign: 'HELP', ephemeral: true }); },
  openSettings: () => { wm.open({ kind: 'settings', key: 'settings', callsign: 'SETTINGS', ephemeral: true }); },
  openHygiene: () => { wm.open({ kind: 'hygiene', key: 'hygiene', callsign: 'HYGIENE' }); },
  // No abre ventana: la sección vive en el campo, así que ⌥I la despliega y la
  // trae a la vista en vez de duplicarla en una ventana que taparía el campo.
  openImprove: () => {
    // En estrecho la sección es una hoja: desplegarla sin abrirla la dejaría
    // desplegada detrás de una media query que la esconde.
    if (sections.sheetMode('improve')) sections.open('improve');
    else gesture('hud', 'improve-reveal');
    improvePanel.reveal();
  },
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
  async interrupt(agentId, text) {
    const cs = store.world.agents[agentId]?.callsign ?? agentId;
    try {
      const out = await hub.cmd({ k: 'interrupt', agentId, text }) as InterruptOutcome | null;
      // Se dice lo que pasó, no lo que se quería: "sin acuse todavía" es una
      // respuesta legítima y el operador tiene que poder distinguirla.
      const how = out?.evidence === 'confirmed' ? 'interrupted' : 'interrupt sent';
      const tail = out?.message === 'queued' ? ' · message queued for delivery'
        : out?.message === 'pasted' ? ' · correction pasted'
          : out?.message === 'unsent' ? ' · message NOT sent' : '';
      c.note(`${how} ${cs}${tail}`, out?.evidence === 'confirmed' ? 'info' : 'warn');
      return out ?? null;
    } catch (err) {
      c.note(`could not interrupt ${cs}: ${(err as Error).message}`, 'alert');
      return null;
    }
  },
  async stop(agentId) {
    const cs = store.world.agents[agentId]?.callsign ?? agentId;
    try { await hub.cmd({ k: 'stop', agentId }); c.note(`stopped ${cs}`, 'warn'); }
    catch (err) { c.note(`could not stop ${cs}: ${(err as Error).message}`, 'alert'); }
  },
  answer(escalationId, answer, rememberAs) {
    hub.answer(escalationId, answer, rememberAs);
    const e = store.world.escalations[escalationId];
    if (e?.permission) { e.permission.phase = 'pending'; store.injectForTest(e); c.note('Permission response requested; confirmation pending', 'warn'); return; }
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
    if (placedFiles.remove(id)) { syncPlacedFiles(); return; }
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
wm.register('hygiene', (ctx) => mountHygiene(ctx, c));
wm.register('mission', (ctx) => mountMission(ctx, c));
wm.register('gallery', (ctx) => mountGallery(ctx, c));
wm.register('launch', (ctx) => mountLaunch(ctx, c));
wm.register('timeline', (ctx) => mountTimeline(ctx, c));
wm.register('sfx', (ctx) => mountSfx(ctx, c));
wm.register('music', (ctx) => mountMusic(ctx, c));
wm.register('terminal', (ctx) => mountTerminal(ctx, c));
wm.register('file', (ctx) => mountFile(ctx, c));
wm.register('files', (ctx) => mountFiles(ctx, c));
// A path in any transcript, feed line or CAPCOM reply opens the file viewer.
bindFileLinks(document.body, c);

const mast = mountMast(hudEl, c);
const cmd = mountCommand(dockEl, c);
const tray = mountTray(dockEl, wm, (w, x, y) => c.menu({ kind: 'window', winId: w.id }, { x, y }));
// A newer build never reloads the page by itself; it lights this, and the operator does.
mountUpdate(dockEl);
const minimap = mountMinimap(hudEl, c);
// The mast may wrap to two rows; the field clips its labels under whatever height it has.
{
  const mastEl = hudEl.querySelector<HTMLElement>('.mast');
  if (mastEl) {
    const measure = () => {
      app.style.setProperty('--hud-top', `${Math.round(mastEl.offsetTop + mastEl.offsetHeight + 8)}px`);
      app.style.setProperty('--col-top', `${Math.round(railTop(mastEl))}px`);
    };
    new ResizeObserver(measure).observe(mastEl);
    // La fuente de pantalla puede llegar después del primer pintado y mover
    // dónde envuelve la fila de herramientas sin cambiar el alto del mástil.
    document.fonts?.ready.then(measure).catch(() => { /* sin fuentes: la medida del primer pintado vale */ });
  }
}
/*
 * Dónde empieza el carril de la izquierda: debajo de lo que hay ENCIMA de él,
 * no debajo del mástil entero.
 *
 * A 1440 px el mástil envuelve —SFX y ? caen a una segunda fila de
 * herramientas y la telemetría a una tercera, las dos pegadas a la derecha— y
 * su borde inferior queda 70 px por debajo de lo último que de verdad hay
 * sobre la columna. Las misiones arrancaban ahí, con un hueco de campo vacío
 * entre FLEET y su cabecera. Se mide pieza a pieza: cada una que pise la
 * franja horizontal del carril lo empuja; las que quedan a la derecha, no.
 *
 * Las piezas son lo que el mástil dispone en filas: sus hijos directos menos
 * los dos que son contenedores de anchura completa (la fila de herramientas,
 * que se lee botón a botón, y la telemetría, que ocupa todo el ancho pero
 * escribe a la derecha, así que se mide su texto). En táctil el carril es
 * `display: contents` —no tiene caja— y aquí no hay nada que medir: las hojas
 * siguen `--hud-top`.
 */
function railTop(mastEl: HTMLElement): number {
  const rail = hudEl.querySelector<HTMLElement>('.hud__col')?.getBoundingClientRect();
  const origin = hudEl.getBoundingClientRect().top;
  const fallback = mastEl.offsetTop + mastEl.offsetHeight + 8;
  if (!rail || rail.width === 0) return fallback;
  const rects: DOMRect[] = [];
  for (const el of mastEl.querySelectorAll<HTMLElement>(':scope > :not(.mast__tools):not(.tele), :scope > .mast__tools > *')) {
    rects.push(el.getBoundingClientRect());
  }
  const tele = mastEl.querySelector('.tele');
  if (tele) {
    const r = document.createRange();
    r.selectNodeContents(tele);
    rects.push(r.getBoundingClientRect());
  }
  let bottom = 0;
  for (const r of rects) {
    if (r.width === 0 || r.height === 0) continue;
    if (r.right <= rail.left || r.left >= rail.right) continue;
    bottom = Math.max(bottom, r.bottom - origin);
  }
  return bottom > 0 ? bottom + 8 : fallback;
}
/*
 * El carril de la izquierda: las dos secciones, una debajo de otra.
 *
 * Van en la misma columna y en flujo —no flotando cada una en su esquina— para
 * que se EMPUJEN: plegar MISIONES sube AUTOMEJORA en el mismo gesto, y no deja
 * un hueco de panel donde no hay panel. Es también lo que las ordena: primero
 * la flota, debajo el instrumento. En táctil el carril se disuelve
 * (`display: contents`) y cada una vuelve a abrirse como hoja.
 */
const railEl = document.createElement('div');
railEl.className = 'hud__col';
hudEl.appendChild(railEl);
// What CAPCOM is on, under the mast's left corner; `hud/missions.ts` says why there.
const missionsPanel = mountMissions(railEl, c);
// AUTOMEJORA: ORCA mirándose a sí misma, debajo de las misiones. Sección
// aparte del panel de misiones a propósito — una habla del instrumento, la
// otra de la flota. Ver `hud/improve.ts`.
const improvePanel = mountImprove(railEl, c);
/*
 * La puerta a las dos secciones cuando no caben flotando: una barra en el dock
 * que abre cada una como hoja sobre el campo, una a la vez. En escritorio no
 * se ve. Ver `hud/sections.ts`; el panel de misiones dice por qué a la
 * izquierda y `hud/improve.ts` por qué a la derecha.
 */
const sections = mountSections(dockEl, { missions: missionsPanel.el, improve: improvePanel.el });
void sections;
const marks = mountBookmarks(hudEl, c);
// CAPCOM's hand on the camera: `camera` frames from the hub land here.
const director = mountDirector(c);
void director;
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
    /*
     * Una pregunta del arnés no se abre sola. Nadie la espera: la levantó una
     * máquina de fixture y el hub ya la tiene en cuarentena para que no llegue
     * al mando (`shared/synthetic.ts`). Abrirle una ventana encima de lo que
     * estabas mirando es el resto de esa misma factura, y se paga a razón de
     * tres por tanda cada vez que alguien corre las pruebas. Sigue en la cola,
     * rotulada, y se abre si la abres tú.
     */
    if (store.fromHarness(e)) continue;
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
    // Lo del arnés no se abre solo, por lo mismo que una pregunta suya: nada
    // de lo que enseña ocurrió, y la ventana la pagas tú con la pantalla.
    if (store.fromHarness(a)) continue;
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
  // `improve` entra en la lista porque el campo lee del tablero quién es
  // revisor: el agente y su tablero llegan por caminos distintos, y el que
  // llegue segundo tiene que repintar el tile.
  if (e.k === 'world' || e.k === 'agents' || e.k === 'projects' || e.k === 'traffic' || e.k === 'artifacts' || e.k === 'escalations' || e.k === 'improve' || e.k === 'missions') field.feed();
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
  KeyI: () => c.openImprove(),
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
  wm.activate(w);
}
window.addEventListener('keyup', (e) => { if (e.key === 'Alt' && switching) commitSwitch(); });
window.addEventListener('blur', () => commitSwitch(true));
/*
 * Space is FOCUS for as long as it is held. The hold remembers whether the
 * down half engaged — it does not while typing, on a repeat, or with nothing
 * selected — so the up half releases (and sounds) only when it did. Before
 * this, `keyup` fired `focus.off` on every space bar in every text field.
 */
const spaceHold = keyHold(' ');
/*
 * ⌥V is TALK for as long as it is held (hud/voice.ts). It engages inside a
 * text field too — the CAPCOM composer focuses itself on open, and that is
 * where the operator is when they want to speak — and it is read from the
 * physical key, because ⌥V on a Mac keyboard reports `√`. Esc while holding
 * throws the line away; letting go sends it.
 */
const talkHold = keyHold('KeyV', { whileTyping: true });

/**
 * Cada atajo que se ATIENDE es un gesto para AUTOMEJORA, con el nombre de la
 * tecla y nada más: `alt-c`, `mod-k`, `slash`, `f`. Se cuenta en el punto en
 * el que el atajo hace algo, no al pulsar — una tecla que no se atendió no
 * dice nada de la interfaz, y una que sí dice qué camino se usa de verdad.
 */
const keyed = (detail: string) => gesture('key', detail);
const altName = (code: string) => `alt-${code.startsWith('Key') ? code.slice(3).toLowerCase() : code.toLowerCase()}`;

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  const typing = typingIn(e);
  if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyV' && voice.supported) {
    e.preventDefault();
    if (e.repeat || talkHold.held()) return;
    if (talkHold.down({ key: e.code, repeat: e.repeat, target: e.target }, () => voice.start())) keyed('alt-v');
    return;
  }
  if (e.key === 'Escape' && talkHold.held()) { e.preventDefault(); talkHold.cancel(); voice.cancel(); return; }
  if (e.altKey && e.key === 'Tab') {
    e.preventDefault();
    if (!wm.all().length) return;
    if (!switching) { switching = true; keyed('alt-tab'); if (!wm.trayMode()) wm.enterTrayMode(); }
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
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.code === 'KeyK') { e.preventDefault(); keyed('mod-k'); cmd.focus(); return; }
  if (e.altKey && !e.metaKey && !e.ctrlKey) {
    const open = ALT_OPEN[e.code];
    if (open) { e.preventDefault(); keyed(altName(e.code)); open(); return; }
    if (e.code >= 'Digit1' && e.code <= 'Digit9') {
      e.preventDefault();
      const n = Number(e.code.slice(5));
      keyed(e.shiftKey ? 'alt-shift-digit' : 'alt-digit');
      if (e.shiftKey) marks.save(n);
      else { marks.push(); if (!marks.go(n)) c.note(`bookmark ${n} is empty · ⌥⇧${n} to set it`); }
      return;
    }
  }
  if (!typing && wm.handleKey(e)) { keyed('window'); return; }
  if (e.key === 'Escape') {
    if (typing) { (t as HTMLElement).blur(); return; }
    keyed('escape');
    const top = wm.focused();
    if (top) wm.close(top);
    else { field.select([]); cmd.setSelection([]); selbar.hidden = true; }
    return;
  }
  if (typing) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (e.repeat || spaceHold.held()) return;
    if (spaceHold.down(e, () => field.setFocus(true))) { keyed('space'); getSound()?.play('focus.on'); }
    else { hintEl.textContent = 'SELECT AN AGENT FIRST · CLICK, OR SHIFT+DRAG A LASSO'; hintEl.classList.add('is-on'); setTimeout(() => hintEl.classList.remove('is-on'), 2500); }
    return;
  }
  if (e.key === '/') { e.preventDefault(); keyed('slash'); cmd.focus(); return; }
  if (e.key === 'F11') { e.preventDefault(); keyed('f11'); void toggleFullscreen(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Backspace') { e.preventDefault(); keyed('backspace'); if (!marks.back()) c.note('nowhere to go back to'); return; }
  if (wm.focused()) return;
  switch (e.key.toLowerCase()) {
    case 'f': keyed('f'); marks.push(); field.frameAll(); getSound()?.play('frame'); break;
    case 'o': keyed('o'); field.setTilt(!field.tilted()); mast.setTilt(field.tilted()); getSound()?.play(field.tilted() ? 'tilt.on' : 'tilt.off'); break;
    case 'd': keyed('d'); c.deck(); break;
    case 'm': keyed('m'); minimap.toggle(); break;
    case 'z': keyed('z'); void toggleFullscreen(); break;
    case '?': keyed('help'); c.openHelp(); break;
    case 'tab': {
      e.preventDefault();
      keyed('tab');
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
window.addEventListener('keyup', (e) => {
  if (spaceHold.up(e)) { field.setFocus(false); getSound()?.play('focus.off'); }
  if (talkHold.up({ key: e.code })) voice.stop();
});
// Focus left mid-sentence: the line is dropped, not sent half-heard.
window.addEventListener('blur', () => { spaceHold.cancel(); field.setFocus(false); if (talkHold.cancel()) voice.cancel(); });
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
  out.push(['ESC', w.mode === 'front' ? 'CANVAS' : 'CLOSE'], ['-', 'FOLD'], ['⌥TAB', 'SWITCH'], ['`', 'WINDOWS']);
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
  // El mundo suele llegar mientras el boot ocupa la pantalla: las misiones se
  // sientan enteras entonces y la alineación se juega aquí, ya con público.
  missionsPanel.align();
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
  /** Un vuelo a un tile, como `go`: para fotografiar dónde aterriza con ventanas delante (framing.shots.ts). */
  fly: (id: string) => c.go(id),
  /** El visor de un archivo, para el arnés visual: igual que pinchar una ruta en una conversación. */
  openFile: (path: string, at?: { x: number; y: number }) => c.openFile({ path }, { at }),
  /** El navegador de una carpeta, para el arnés visual: la flota sintética no tiene carpetas de verdad. */
  openFiles: (root: string, at?: { x: number; y: number }) => openFilesAt(root, { at }),
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
  // The mission panel, for the visual harness: a mission the hub never saw, agents it did.
  mission: (m: import('../shared/missions.ts').CapcomMission) => store.upsertMission(m),
  /** Las misiones que el hub sirvió, para comprobar de fuera qué llegó. Sólo lectura. */
  missionsSeen: () => Object.values(store.world.missions ?? {}).map((m) => ({ id: m.id, title: m.title, status: m.status, messages: m.messages.length })),
  agentIds: () => Object.values(store.world.agents).filter((a) => a.role !== 'capcom' && a.state !== 'done' && a.state !== 'dead').map((a) => a.id),
  // AUTOMEJORA, para el arnés visual: un tablero que el hub nunca vio. Una
  // foto de ocho propuestas no puede dejar ocho propuestas en el disco del
  // operador, igual que con las misiones de arriba.
  improve: (
    state: import('../shared/improve.ts').ImproveState,
    verdict: import('../shared/improve.ts').DueVerdict | null,
    extra?: { choice?: ReturnType<typeof import('../shared/improve.ts').effectiveChoice>; machineId?: string | null },
  ) => store.putImprove(state, verdict, extra),
  improveReveal: () => c.openImprove(),
  callsignOf: (id: string) => store.knownAgent(id)?.callsign ?? null,
  machineOf: (id: string) => store.knownAgent(id)?.machineId ?? null,
  // Un informe de higiene que el hub nunca vio, para el arnés visual: una foto
  // de restos no puede depender de que la máquina tenga restos de verdad.
  hygiene: (reports: import('../shared/hygiene.ts').HygieneReport[]) => store.putHygiene(reports),
  openHygiene: () => c.openHygiene(),
  // El aviso de que el hub corre código viejo, sin tener que envejecer un hub:
  // lo manda el proceso de verdad (hub/source-rev.ts) y sólo cuando alguien
  // publica, que no es algo que una foto pueda esperar.
  server: (rev: string, stale: boolean, restartable = false) => store.putServer(rev, stale, restartable),
};

// A notification opens the live queue; it never replays an action from its payload.
if (new URL(location.href).searchParams.has('queue')) {
  c.openQueue();
  const u = new URL(location.href); u.searchParams.delete('queue'); history.replaceState(null, '', u);
}
navigator.serviceWorker?.addEventListener('message', ev => { if (ev.data?.t === 'orca:queue') c.openQueue(); });
store.on(e => { if (e.k === 'link' && e.up) void syncPushSubscription().catch(() => {}); });
