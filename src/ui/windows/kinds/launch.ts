/**
 * Launch: a saved fleet, and the comp's ALGN window while it goes up. (B4)
 *
 * `spawn.ts` launches one agent with a real brief. This launches the five you
 * always launch together, and it does it inside the one gesture the comp is
 * built around: rows arrive flush, open into a **staircase** (A10), each
 * **zipper** fills from the centre outward when that agent's spawn is
 * acknowledged (A11), and when every row is full they rejoin flush and the
 * window collapses (A12). The staircase *is* the launch state — it is not
 * decoration, and it cannot finish before the fleet does.
 *
 * If a spawn fails, its row turns red with the reason and the window stays
 * open. A launch that half-worked is a thing you must look at.
 *
 * ── WIRING (main.ts) ───────────────────────────────────────────────────
 *
 *   import { mountLaunch, fetchPresets } from './windows/kinds/launch.ts';
 *   wm.register('launch', (ctx) => mountLaunch(ctx, c));
 *
 *   // on the Console object:
 *   openLaunch(preset?: string, fire?: boolean): void {
 *     wm.open({
 *       kind: 'launch', key: 'launch', callsign: 'LAUNCH', ephemeral: true,
 *       params: { preset: preset ?? '', fire: fire ? '1' : '' },
 *     });
 *   }
 *   // console.ts: openLaunch(preset?: string, fire?: boolean): void;
 *
 * ── WIRING (hud/command.ts) ────────────────────────────────────────────
 *
 *   { name: 'launch', help: 'launch a saved fleet · /launch audit' }
 *   case 'launch': c.openLaunch(arg || undefined, !!arg); break;
 *
 * `params.preset` preselects a preset by name (case-insensitive); if it does
 * not match, the window opens on the first one. `params.fire === '1'` fires it
 * on open — that is what `/launch audit` should do, while a bare `/launch`
 * should open the window and let the operator choose.
 *
 * `fetchPresets()` is exported so the command line can complete preset names.
 *
 * ── SQUADS ─────────────────────────────────────────────────────────────
 *
 * A preset may mark one of its agents `lead`. When it does, that one goes up
 * first and alone, and every other member is spawned with `parentId` set to the
 * id its ack came back with — a squad has a head before it has members, or it
 * is not a squad. If the collector could not name the session inside
 * `SPAWN_ACK_TIMEOUT_MS` the ack carries `agentId: null`: the leader is running
 * and ORCA cannot point at it yet, so the members go up unparented and the row
 * says so, which is worse than a tree and much better than a dead launch.
 *
 * Every launch carries a squad name, leader or not. A preset can fix one; when
 * it does not, the launch takes the next `<preset>-NN` from the hub's counter —
 * the same one `launch_squad` uses from CAPCOM. Two squads called `audit-01` on
 * one fleet are one squad as far as `squadsOf()` is concerned, and that is not
 * a mistake worth making twice.
 */

import gsap from 'gsap';
import { ZIP_SVG } from '../../gfx/algn.ts';
import { REDUCE } from '../../motion.ts';
import { store } from '../../store.ts';
import { getSound } from '../../hud/sound.ts';
import { hub } from '../../net/client.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { esc } from '../../util.ts';
import type { SpawnAck } from '../../../shared/protocol.ts';
import { squadName } from '../../../shared/squads.ts';
import { parsePresets, squadStem, type Preset, type PresetAgent } from '../../../shared/fleets.ts';
import { authedApi } from '../../history.ts';
import { screenFlash, slabFlash } from '../fx.ts';
import { fold, pick, type PickHandle } from '../../controls.ts';

/* ── Presets ────────────────────────────────────────────────────────── */

/**
 * Presets live on the hub — `~/.orca/fleets/<name>.json` — not in this
 * browser. That is what lets "launch the audit" typed at CAPCOM and `/launch
 * audit` typed here mean the same list. The console reads and replaces the
 * whole list over `/api/fleets`; validation is shared (`shared/fleets.ts`).
 */
export type { Preset, PresetAgent } from '../../../shared/fleets.ts';

interface FleetsReply {
  presets: Preset[];
  broken: { file: string; why: string }[];
  dir?: string;
  error?: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(authedApi(path), { cache: 'no-store', ...init });
  const body = await res.json().catch(() => null) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `${path} → ${res.status}`);
  return body as T;
}

/** What the hub has. Never throws: a hub that is down shows an empty list, and says so. */
export async function fetchPresets(): Promise<FleetsReply> {
  try { return await api<FleetsReply>('/api/fleets'); }
  catch (err) { return { presets: [], broken: [], error: (err as Error).message }; }
}

function savePresets(list: Preset[]): Promise<FleetsReply> {
  return api<FleetsReply>('/api/fleets', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(list),
  });
}

/**
 * The next name for a preset that does not carry one: `audit-01`, `audit-02`.
 *
 * Asked of the hub, because the collision it prevents is not local to a
 * window: `squadsOf()` groups by label, so a squad CAPCOM launched as
 * `audit-01` and one launched here under the same name are one squad with two
 * leaders. The hub numbers both from one counter. If it cannot be reached the
 * launch would fail anyway — the spawns go through the same hub — so there is
 * no fallback worth having beyond saying why.
 */
async function nextSquadName(presetName: string): Promise<string> {
  const base = squadStem(presetName);
  const r = await api<{ ok: boolean; name: string }>(`/api/squads/next?base=${encodeURIComponent(base)}`, { method: 'POST' });
  return squadName(r.name) ?? `${base}-01`;
}

/* ── The window ─────────────────────────────────────────────────────── */

/** The comp's zipper, shared with the boot and the HUD's mission panel. */

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export function mountLaunch(ctx: WinCtx, c: Console) {
  const body = ctx.body;
  const reduce = REDUCE.value;
  let presets: Preset[] = [];
  /** Until the hub answers, the window says so instead of showing nothing. */
  let loading = true;
  let loadError = '';
  let broken: { file: string; why: string }[] = [];
  let sel = 0;
  let disposed = false;
  let launched = false;
  /** The console's own dropdown; it outlives no render, so it is disposed. */
  let projectPick: PickHandle | null = null;
  /** What the operator chose, so a patch from the hub cannot undo it. */
  let chosen = '';
  let editOpen = false;

  const wanted = (ctx.win.spec.params?.preset ?? '').trim().toLowerCase();
  ctx.setCallsign('LAUNCH');

  void fetchPresets().then((r) => {
    if (disposed) return;
    loading = false;
    presets = r.presets;
    broken = r.broken;
    loadError = r.error ?? '';
    if (wanted) {
      const i = presets.findIndex((p) => p.name.toLowerCase() === wanted);
      if (i >= 0) sel = i;
    }
    renderPick();
    // `/launch audit` fires on open — once the list is here to fire from.
    if (ctx.win.spec.params?.fire === '1') window.setTimeout(() => void fire(), 60);
  });

  /* ── Phase one: pick ─────────────────────────────────────────────── */

  function renderPick() {
    if (disposed || launched) return;
    const preset = presets[sel];
    const projects = Object.values(store.world.projects).sort((a, b) => a.name.localeCompare(b.name));
    // A preset names a project by code, so it survives being carried between machines.
    const preferred = preset?.project
      ? projects.find((p) => p.code.toUpperCase() === preset.project!.toUpperCase())
      : undefined;
    ctx.setTitle(preset ? `${preset.name.toUpperCase()} · ${preset.agents.length} AGENTS` : loading ? 'LOADING PRESETS' : 'NO PRESETS');

    body.innerHTML = `
      <div class="win__scroll scroll launch">
        <div class="sec">
          <div class="sec__k px">PRESET</div>
          <div class="chips" data-presets>
            ${presets.map((p, i) => `<button class="chip ${i === sel ? 'is-on' : ''}" type="button" data-p="${i}">${esc(p.name)}<small>${p.agents.length}</small></button>`).join('')
              || `<span class="px px--tiny" style="color:var(--ink-faint)">${loading ? 'LOADING…' : loadError ? `HUB: ${esc(loadError.toUpperCase())}` : 'NONE SAVED'}</span>`}
          </div>
          ${broken.length ? `<p class="px px--tiny" style="color:var(--red);margin-top:6px;line-height:1.7">${broken.map((b) => `${esc(b.file)} · ${esc(b.why)}`).join('<br>')}</p>` : ''}
        </div>
        <div class="sec">
          <div class="sec__k px">PROJECT</div>
          ${projects.length ? `<div data-project></div>` : `<p class="px px--tiny" style="color:var(--ink-dim);line-height:1.7">NO PROJECTS YET. A COLLECTOR DISCOVERS THEM FROM ~/.claude/projects ON EACH MACHINE.</p>`}
        </div>
        ${preset ? `<div class="sec">
          <div class="sec__k px">FLEET${preset.squad ? ` · ${esc(preset.squad)}` : ''}</div>
          ${preset.agents.map((a, i) => `<div class="launch__brief">
            <span class="px px--tiny launch__n">${String(i + 1).padStart(2, '0')}</span>
            <span class="mono">${a.lead ? `<b class="px px--tiny launch__lead">LEAD</b>` : ''}${esc(a.mission)}</span>
          </div>`).join('')}
        </div>` : ''}
        <div class="launch__go">
          <button class="slab-btn slab-btn--lg" type="button" data-go data-key="enter" ${preset && projects.length ? '' : 'disabled'}>
            LAUNCH FLEET
          </button>
        </div>
        <div class="sec launch__edit" data-edit></div>
      </div>
    `;

    body.querySelectorAll<HTMLElement>('[data-p]').forEach((b) => b.addEventListener('click', () => {
      sel = Number(b.dataset.p); renderPick();
    }));

    projectPick?.dispose();
    projectPick = null;
    const phost = body.querySelector<HTMLElement>('[data-project]');
    if (phost && projects.length) {
      projectPick = pick({
        name: 'project',
        search: projects.length > 6,
        value: chosen || preferred?.id,
        onChange: (v) => { chosen = v; },
        options: projects.map((p) => ({
          value: p.id,
          label: `${p.code} · ${p.name}`,
          hint: store.world.machines[p.machineId]?.hostname ?? '',
        })),
      });
      phost.appendChild(projectPick.el);
    }

    // The JSON is the preset file itself; it folds away because most launches
    // never touch it, and a `<details>` triangle is not from this world.
    const edit = document.createElement('div');
    edit.innerHTML = `
      <textarea class="input mono launch__json" data-json spellcheck="false"></textarea>
      <div class="row row--split" style="margin-top:6px">
        <span class="px px--tiny" data-jstat></span>
        <button class="btn" type="button" data-save>SAVE</button>
      </div>`;
    const editFold = fold({ label: 'EDIT PRESETS · JSON', open: editOpen, body: edit, onToggle: (o) => { editOpen = o; } });
    // `E` opens the presets file. The manager paints the cap from `data-key`.
    editFold.querySelector('.fold__k')?.setAttribute('data-key', 'e');
    body.querySelector<HTMLElement>('[data-edit]')?.appendChild(editFold);

    const json = body.querySelector<HTMLTextAreaElement>('[data-json]');
    if (json) json.value = JSON.stringify(presets, null, 2);
    const jstat = body.querySelector<HTMLElement>('[data-jstat]')!;
    body.querySelector('[data-save]')?.addEventListener('click', () => {
      const parsed = parsePresets(json?.value ?? '');
      if (typeof parsed === 'string') {
        jstat.textContent = parsed.toUpperCase();
        jstat.style.color = 'var(--red)';
        return;
      }
      jstat.textContent = 'SAVING…';
      jstat.style.color = '';
      savePresets(parsed).then((r) => {
        if (disposed) return;
        presets = r.presets;
        broken = r.broken;
        sel = Math.min(sel, Math.max(0, presets.length - 1));
        c.note(`saved ${presets.length} fleet preset${presets.length === 1 ? '' : 's'} to the hub`);
        renderPick();
      }).catch((err: Error) => {
        jstat.textContent = err.message.toUpperCase();
        jstat.style.color = 'var(--red)';
      });
    });
    // §6.2: LAUNCH FLEET inverts to ink for a frame as it commits. No band on
    // it — the ALGN staircase that opens next *is* the report of the launch,
    // and two things reporting the same wait is one thing too many.
    const go = body.querySelector<HTMLElement>('[data-go]');
    go?.addEventListener('click', () => { slabFlash(go); void fire(); });
  }

  /* ── Phase two: the ALGN window ──────────────────────────────────── */

  async function fire() {
    if (disposed || launched) return;
    const preset = presets[sel];
    const projectId = projectPick?.value() ?? '';
    if (!preset || !preset.agents.length || !projectId) return;
    launched = true;

    // A19: the only celebration the contract allows, spent on a fleet going up.
    getSound()?.play('launch');
    screenFlash('lime');

    // Row order is launch order. The leader is first because everyone else is
    // parented to it and cannot go up until its ack comes back; `sort` is
    // stable, so the rest keep the order the preset wrote them in.
    const agents = [...preset.agents].sort((a, b) => Number(!!b.lead) - Number(!!a.lead));
    const hasLead = !!agents[0]?.lead;
    // Taken here and not on open: a window you looked at and closed must not
    // burn audit-03.
    let squad: string;
    try {
      squad = (preset.squad && squadName(preset.squad)) || await nextSquadName(preset.name);
    } catch (err) {
      launched = false;
      c.note(`fleet ${preset.name}: the hub would not name the squad — ${(err as Error).message}`, 'alert');
      return;
    }
    if (disposed) return;
    let leadCallsign = '';

    const n = agents.length;
    const code = store.world.projects[projectId]?.code ?? '';
    ctx.setTitle(`${squad.toUpperCase()} → ${code}`);
    body.innerHTML = `
      <div class="win__scroll scroll launch__stage">
        <div class="algn launch__algn">
          <header class="algn__head">
            <p class="px px--modal">FLEET ALIGNMENT · ${esc(squad)}</p>
            <span class="px px--modal" data-count>0/${n}</span>
          </header>
          <div data-rows>
            ${agents.map((a, i) => `
              <div class="algn-row ${hasLead && i === 0 ? 'is-lead' : ''}" data-row="${i}">
                <span class="px px--tiny" data-left>${hasLead && i === 0 ? 'LEAD' : `+ SYNC ${String(i + 1).padStart(2, '0')}`}</span>
                <div class="algn-bar"><div class="algn-zip" data-zip>${ZIP_SVG}</div></div>
                <span class="px px--tiny" data-right>SYNC ${String(i + 1).padStart(2, '0')} +</span>
                <p class="launch__mission mono" data-note>${esc(a.mission)}</p>
                <p class="px px--tiny launch__warn" data-warn hidden></p>
              </div>`).join('')}
          </div>
        </div>
      </div>
    `;

    const rows = [...body.querySelectorAll<HTMLElement>('.algn-row')];
    const zips = rows.map((r) => r.querySelector<HTMLElement>('[data-zip]')!);
    const count = body.querySelector<HTMLElement>('[data-count]')!;
    let filled = 0, failed = 0, zipped = 0;

    gsap.set(zips, { scaleX: 0, transformOrigin: 'center center' });
    if (!reduce) {
      gsap.set(rows, { autoAlpha: 0, y: 14, paddingLeft: 10, paddingRight: 10 });
      rows.forEach((row, i) => {
        // A10: flush in on a 44ms stagger…
        gsap.to(row, { autoAlpha: 1, y: 0, duration: 0.26, ease: 'power2.out', delay: i * 0.044 });
        // …then the staircase, inset more on the left than on the right.
        gsap.to(row, {
          paddingLeft: 10 + i * 14, paddingRight: 10 + i * 10,
          duration: 0.46, ease: 'power2.inOut', delay: 0.34 + i * 0.032,
        });
      });
    }

    /** Every zipper full and no failure: the fleet is up, the window is done. */
    function maybeFinish() {
      if (disposed || failed || filled < n || zipped < n) return;
      // The window is about to close; the feed is where the squad's name and
      // the callsign to answer it with survive the collapse.
      c.note(`squad ${squad} launched · ${leadCallsign ? `leader ${leadCallsign}` : 'no leader'}`);
      if (reduce) { ctx.close(); return; }
      // A11's return: the staircase rejoins flush before the panel collapses.
      gsap.to(rows, {
        paddingLeft: 10, paddingRight: 10, duration: 0.40, ease: 'power2.inOut', stagger: 0.026,
        onComplete: () => { if (!disposed) void c.wm.closeWith(ctx.win, 'collapse'); },
      });
    }

    function ack(i: number, data: SpawnAck | null) {
      const row = rows[i], zip = zips[i];
      if (disposed || !row || !zip) return;
      // The collector may hand back the callsign it assigned; use it if it did.
      const cs = data?.callsign;
      if (cs) {
        const right = row.querySelector<HTMLElement>('[data-right]');
        if (right) right.textContent = `${cs} +`;
      }
      filled++;
      count.textContent = `${filled + failed}/${n}`;
      if (reduce) { gsap.set(zip, { scaleX: 1 }); zipped++; maybeFinish(); return; }
      // A11: from the centre outward — synchrony, not time.
      gsap.to(zip, {
        scaleX: 1, duration: 0.74, ease: 'power2.inOut',
        onComplete: () => { zipped++; maybeFinish(); },
      });
    }

    /** Something the operator must know about a row that did not fail. */
    function warnRow(i: number, text: string) {
      const el = rows[i]?.querySelector<HTMLElement>('[data-warn]');
      if (!el) return;
      el.textContent = text;
      el.hidden = false;
    }

    function fail(i: number, why: string) {
      const row = rows[i];
      if (disposed || !row) return;
      failed++;
      count.textContent = `${filled + failed}/${n}`;
      row.classList.add('is-fail');
      const left = row.querySelector<HTMLElement>('[data-left]');
      const note = row.querySelector<HTMLElement>('[data-note]');
      if (left) left.textContent = '! FAILED';
      if (note) note.textContent = why;
      c.note(`fleet ${preset!.name}: agent ${i + 1} did not spawn — ${why}`, 'alert');
    }

    const spawn = async (a: PresetAgent, parentId: string | null, lead: boolean): Promise<SpawnAck | null> =>
      (await hub.cmd({
        k: 'spawn',
        projectId,
        prompt: a.prompt,
        mission: a.mission,
        model: a.model,
        runtime: a.runtime ?? 'claude',
        parentId,
        squad,
        lead,
        background: true,
        permissionMode: 'auto',
      })) as SpawnAck | null;

    async function one(i: number, parentId: string | null) {
      const a = agents[i];
      if (!a) return;
      try {
        ack(i, await spawn(a, parentId, false));
      } catch (err) {
        fail(i, (err as Error).message);
      }
    }

    c.note(`launching ${preset.name} · ${n} agents on ${code || projectId} · squad ${squad}`);

    let from = 0;
    let parentId: string | null = null;
    if (hasLead) {
      from = 1;
      try {
        // Awaited, alone: the members have nothing to hang off until this
        // returns an id, and a squad assembled out of order is a tree of five
        // orphans with the same label.
        const data = await spawn(agents[0]!, null, true);
        if (disposed) return;
        ack(0, data);
        leadCallsign = data?.callsign ?? '';
        parentId = data?.agentId ?? null;
        // SPAWN_ACK_TIMEOUT_MS elapsed before the session showed up. It is
        // running and ORCA cannot name it yet, so the members go up without a
        // parent — the label still puts them in the squad, and the lineage
        // arrives late instead of never.
        if (!parentId) warnRow(0, 'NO ID · MEMBERS UNPARENTED');
      } catch (err) {
        fail(0, (err as Error).message);
        // A squad with no head is not what was asked for. The rest stay on the
        // ground, and the window stays open saying why.
        for (let i = 1; i < n; i++) fail(i, 'LEADER DID NOT SPAWN');
        return;
      }
    }

    // Sequential, 150ms apart: a hub that takes ten spawns in one frame reports
    // them in one patch, and the staircase would fill all at once.
    for (let i = from; i < n; i++) {
      if (disposed) return;
      if (i > from) await wait(150);
      void one(i, parentId);
    }
  }

  renderPick();

  // A patch every second must not rebuild the form while a menu is open on it.
  const off = store.on((e) => {
    if (launched || projectPick?.isOpen()) return;
    if (e.k === 'world' || e.k === 'projects') renderPick();
  });
  return { dispose() { disposed = true; off(); projectPick?.dispose(); projectPick = null; } };
}
