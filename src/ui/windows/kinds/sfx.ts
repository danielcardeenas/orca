/**
 * SOUND: which voice the console has, and what it says with it.
 *
 * Four decks, top to bottom:
 *
 *   1. the instrument — PRESET, PACK, the ten-step master, the mute, and the
 *      two buttons that make a preset out of what you are hearing;
 *   2. the events, grouped FLEET / WINDOWS / NAVIGATION / DECK / REPLAY, one
 *      row each: what it means, which clip answers it, and a ▶;
 *   3. the packs, one row each: a sample, the count, and the voice in a line.
 *
 * A row's picker offers the current pack's clips by their plain id and every
 * other pack's as `pack:clip`, so a preset like MIXED — CAPCOM for the fleet,
 * MECHANICAL for the windows — is something the operator can also build by
 * hand, one row at a time, and then SAVE PRESET under a name.
 *
 * Auditioning ignores the mute: a ▶ is the operator asking, not the console
 * speaking. Everything else is `sound.ts`'s state; this window only turns its
 * knobs. RESET drops the overrides and leaves the pack alone.
 *
 * Wiring (main.ts — not this file's to change):
 *
 *   import { mountSfx } from './windows/kinds/sfx.ts';
 *   wm.register('sfx', (ctx) => mountSfx(ctx, c));
 *   c.openSfx = () => wm.open({ kind: 'sfx', key: 'sfx', callsign: 'SFX' });
 *
 * It takes the sound handle from `getSound()`, the singleton `mountSound()`
 * registers, so nothing has to be threaded through the Console for it.
 */

import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { pick, toggle, type PickHandle, type PickOption, type ToggleHandle } from '../../controls.ts';
import {
  getSound, CLIP_OF, SOUND_GROUPS,
  type PackClip, type PackInfo, type SoundName,
} from '../../hud/sound.ts';
import { esc } from '../../util.ts';

/** What each event is, in the console's own words, under its name. */
const WHAT: Record<SoundName, string> = {
  interrupt: 'AN AGENT NEEDS A HUMAN',
  answer: 'YOU CLOSED AN ESCALATION',
  spawn: 'LINEAGE GREW',
  launch: 'A FLEET WENT UP',
  squad: 'A SQUADRON FORMED',
  dead: 'AN AGENT ENDED',
  breach: 'THE LINK WENT DOWN',
  link: 'THE LINK CAME BACK',
  artifact: 'AN ARTIFACT ARRIVED',
  placed: 'AN ARTIFACT WENT ON THE FIELD',

  'open.agent': 'AN AGENT WINDOW',
  'open.interrupt': 'A QUESTION OPENED ITSELF',
  'open.queue': 'THE QUEUE',
  'open.capcom': 'THE CAPCOM CHANNEL',
  'open.feed': 'THE FEED',
  'open.fleet': 'A FLEET, A PROJECT, A SQUAD',
  'open.spawn': 'THE SPAWN FORM',
  'open.launch': 'THE LAUNCH PANEL',
  'open.artifact': 'AN ARTIFACT WINDOW',
  'open.gallery': 'THE GALLERY',
  'open.timeline': 'THE LAST 24 HOURS',
  'open.sfx': 'THIS WINDOW',
  'open.help': 'THE KEYS',
  'open.music': 'THE MUSIC PANEL',
  close: 'A WINDOW LEFT',
  fold: 'FOLDED INTO THE TRAY',
  unfold: 'BACK OUT OF THE TRAY',
  wipe: 'THE LIME SWEEP CONFIRMED IT',
  check: 'THE PIXEL CHECK',

  'bookmark.save': 'A VIEW PINNED TO A SLOT',
  'bookmark.go': 'JUMPED TO A SLOT',
  back: 'BACKSPACE, WHERE YOU WERE',
  frame: 'FRAMED EVERYTHING',
  'tilt.on': 'THE FIELD TILTED',
  'tilt.off': 'THE FIELD WENT FLAT',
  'focus.on': 'FOCUS HELD',
  'focus.off': 'FOCUS RELEASED',
  lasso: 'A LASSO CLOSED',
  select: 'A TILE PICKED',

  'deck.enter': 'THE ALIGN DECK',
  'deck.exit': 'BACK TO THE FIELD',
  'deck.sort': 'THE DECK REORDERED',
  'deck.settle': 'THE DECK FINISHED LANDING',
  'deck.tick': 'ONE TILE LANDED',

  'replay.enter': 'INTO THE PAST',
  'replay.exit': 'BACK TO LIVE',
  'replay.step': 'ONE STEP OF THE SCRUBBER',
};

/** How many steps the master has. Ten is a level, not a curve. */
const VOL_STEPS = 10;

/** `0.6` → `0.60 s`. A clip's only fact that its name does not carry. */
const secs = (n: number) => `${n.toFixed(2)} s`;

export function mountSfx(ctx: WinCtx, c: Console) {
  const body = ctx.body;
  const snd = getSound();
  ctx.setTitle('SOUND');

  if (!snd) {
    body.innerHTML = `<p class="px px--tiny" style="padding:14px 12px;line-height:1.7;color:var(--ink-dim)">SOUND IS NOT MOUNTED.</p>`;
    return;
  }

  body.innerHTML = `
    <div class="sec sfx__head">
      <div class="sfx__deck">
        <label class="sfx__lab px px--tiny">PRESET</label><div data-c="preset"></div>
        <label class="sfx__lab px px--tiny">PACK</label><div data-c="pack"></div>
        <label class="sfx__lab px px--tiny">LEVEL</label><div class="sfx__vol" data-c="vol"></div>
      </div>
      <div class="row row--split sfx__acts">
        <div data-c="mute"></div>
        <div class="row sfx__save">
          <input class="input mono sfx__name-in" data-name type="text" placeholder="name it" maxlength="20" autocomplete="off" spellcheck="false" aria-label="preset name" />
          <button class="btn" type="button" data-save data-key="s">SAVE PRESET</button>
          <button class="btn" type="button" data-del hidden>DELETE</button>
          <button class="btn" type="button" data-reset data-key="r">RESET</button>
        </div>
      </div>
    </div>
    <div class="win__scroll scroll" data-scroll>
      <div data-events><p class="px px--tiny" style="padding:10px 12px;color:var(--ink-dim)">LOADING…</p></div>
      <div class="sec">
        <div class="sec__k px">PACKS</div>
        <div data-packs><p class="px px--tiny" style="color:var(--ink-dim)">LOADING…</p></div>
      </div>
    </div>
  `;

  const slot = (k: string) => body.querySelector<HTMLElement>(`[data-c="${k}"]`)!;
  const eventsEl = body.querySelector<HTMLElement>('[data-events]')!;
  const packsEl = body.querySelector<HTMLElement>('[data-packs]')!;
  const nameIn = body.querySelector<HTMLInputElement>('[data-name]')!;
  const delBtn = body.querySelector<HTMLButtonElement>('[data-del]')!;

  /** Controls that live for the window's whole life. */
  const fixed: { dispose(): void }[] = [];
  /** Controls that a pack change throws away and builds again. */
  let perPack: { dispose(): void }[] = [];
  let gone = false;

  /* ── The mute, the one control that is not about the mapping ────── */

  const mute: ToggleHandle = toggle({
    name: 'sound',
    // The cap is the window's own key, injected by the manager: inside SFX
    // `S` saves a preset, so the mute is `M` and the label must not say `S`.
    label: 'SOUND',
    checked: !snd.muted(),
    onChange: (on) => snd.setMuted(!on),
  });
  // `M` is the mute, the way it is everywhere else on the glass.
  mute.el.setAttribute('data-key', 'm');
  slot('mute').appendChild(mute.el);
  fixed.push(mute);

  // `S` and the mast button change the same state behind this switch's back.
  const sync = window.setInterval(() => {
    const on = !snd.muted();
    if (mute.checked() !== on) mute.set(on);
  }, 400);

  /* ── The master, ten steps of it ────────────────────────────────── */

  const volEl = slot('vol');
  const bar = document.createElement('div');
  bar.className = 'vol';
  bar.setAttribute('role', 'slider');
  bar.tabIndex = 0;
  bar.setAttribute('aria-label', 'master level');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(VOL_STEPS));
  const cells: HTMLElement[] = [];
  for (let i = 0; i < VOL_STEPS; i++) {
    const cell = document.createElement('i');
    cell.className = 'vol__cell';
    cell.setAttribute('aria-hidden', 'true');
    bar.appendChild(cell);
    cells.push(cell);
  }
  const volN = document.createElement('span');
  volN.className = 'mono vol__n';
  volEl.append(bar, volN);

  function paintVol() {
    const step = Math.round(snd!.volume() * VOL_STEPS);
    cells.forEach((cell, i) => cell.classList.toggle('is-lit', i < step));
    bar.setAttribute('aria-valuenow', String(step));
    volN.textContent = `${Math.round(snd!.volume() * 100)}%`;
  }
  /** Where in the bar the pointer is, as a step. Clamped, never negative. */
  function stepAt(clientX: number): number {
    const r = bar.getBoundingClientRect();
    if (r.width <= 0) return 0;
    const t = (clientX - r.left) / r.width;
    return Math.min(VOL_STEPS, Math.max(0, Math.ceil(t * VOL_STEPS)));
  }
  function setStep(n: number) {
    snd!.setVolume(Math.min(VOL_STEPS, Math.max(0, n)) / VOL_STEPS);
    paintVol();
  }
  bar.addEventListener('pointerdown', (e) => {
    bar.setPointerCapture(e.pointerId);
    setStep(stepAt(e.clientX));
  });
  bar.addEventListener('pointermove', (e) => {
    if (!bar.hasPointerCapture(e.pointerId)) return;
    setStep(stepAt(e.clientX));
  });
  // A level the operator just set is a level they want to hear.
  bar.addEventListener('pointerup', () => snd.preview(CLIP_OF.select));
  bar.addEventListener('keydown', (e) => {
    const at = Math.round(snd.volume() * VOL_STEPS);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setStep(at + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setStep(at - 1); }
    else if (e.key === 'Home') { e.preventDefault(); setStep(0); }
    else if (e.key === 'End') { e.preventDefault(); setStep(VOL_STEPS); }
  });
  paintVol();

  /* ── PRESET and PACK ────────────────────────────────────────────── */

  let presetPick: PickHandle | null = null;
  let packPick: PickHandle | null = null;

  function paintPreset() {
    presetPick?.dispose();
    const list = snd!.presets();
    const cur = snd!.preset();
    const options: PickOption[] = [
      { value: '', label: 'CUSTOM', hint: 'UNSAVED' },
      ...list.map((p) => ({
        value: p.id,
        label: p.label,
        // A factory preset that borrows from other packs is a blend, not a
        // pack; saying MIXED next to a preset called MIXED says nothing.
        hint: p.builtin ? (Object.keys(p.over).length ? 'BLEND' : 'PACK') : 'YOURS',
      })),
    ];
    presetPick = pick({
      name: 'preset',
      options,
      value: cur,
      onChange: (v) => {
        if (!v) return;
        snd!.usePreset(v);
        paintPack();
        paintPreset();
        rebuildEvents();
        paintPacks();
        c.note(`sound preset · ${list.find((p) => p.id === v)?.label.toLowerCase() ?? v}`);
      },
    });
    slot('preset').appendChild(presetPick.el);
    delBtn.hidden = !list.find((p) => p.id === cur && !p.builtin);
  }

  function paintPack() {
    packPick?.dispose();
    const options: PickOption[] = packList.length
      ? packList.map((p) => ({ value: p.id, label: p.label, hint: `${p.count}` }))
      : [{ value: snd!.pack(), label: snd!.pack().toUpperCase(), hint: '?' }];
    packPick = pick({
      name: 'pack',
      options,
      value: snd!.pack(),
      onChange: (v) => {
        snd!.setPack(v);
        paintPreset();
        rebuildEvents();
        paintPacks();
        c.note(`sound pack · ${v}`);
      },
    });
    slot('pack').appendChild(packPick.el);
  }

  /* ── One row per event ──────────────────────────────────────────── */

  let packList: PackInfo[] = [];
  /** Pack id → its clips, for the options and for the pack rows' samples. */
  const clipsOf = new Map<string, PackClip[]>();
  const picks = new Map<SoundName, PickHandle>();

  /**
   * Every clip in the console, once, shared by all 47 pickers: the current
   * pack's by their plain id first, then every other pack's as `pack:clip`.
   * Building this list once is the difference between 160 objects and 7 500.
   */
  function optionsForRows(): PickOption[] {
    const cur = snd!.pack();
    const out: PickOption[] = [];
    for (const cl of clipsOf.get(cur) ?? []) out.push({ value: cl.id, label: cl.id, hint: secs(cl.len) });
    for (const p of packList) {
      if (p.id === cur) continue;
      for (const cl of clipsOf.get(p.id) ?? []) out.push({ value: `${p.id}:${cl.id}`, label: `${p.id}:${cl.id}`, hint: p.label });
    }
    return out;
  }

  function rebuildEvents() {
    if (gone) return;
    for (const h of perPack) h.dispose();
    perPack = [];
    picks.clear();

    const cur = snd!.pack();
    const have = new Set((clipsOf.get(cur) ?? []).map((cl) => cl.id));
    const shared = optionsForRows();
    const map = snd!.map();

    eventsEl.innerHTML = SOUND_GROUPS.map((g) => `
      <div class="sec">
        <div class="sec__k px">${esc(g.label)}</div>
        ${g.names.map((n) => `
          <div class="sfx__row">
            <div class="sfx__name">
              <b class="px">${esc(n)}</b>
              <span class="px px--tiny sfx__what">${esc(WHAT[n])}</span>
            </div>
            <div class="sfx__pick" data-p="${esc(n)}"></div>
            <button class="sfx__play" type="button" data-ev="${esc(n)}" title="HEAR IT" aria-label="play ${esc(n)}">▶</button>
          </div>`).join('')}
      </div>`).join('');

    for (const g of SOUND_GROUPS) {
      for (const n of g.names) {
        const host = eventsEl.querySelector<HTMLElement>(`[data-p="${CSS.escape(n)}"]`);
        if (!host) continue;
        const fallback = CLIP_OF[n];
        // The clip is the label and DEFAULT is the note beside it, not the
        // other way round: at 150 px a row that led with the word DEFAULT
        // would spend its whole width saying nothing and then truncate the one
        // fact that matters. MISSING is a pack with a hole in it — a silent
        // row, saying so rather than pretending.
        const options: PickOption[] = [
          { value: '', label: fallback, hint: have.has(fallback) ? 'DEFAULT' : 'MISSING' },
          ...shared,
        ];
        const want = map[n] ?? '';
        const h = pick({
          name: n,
          options: options.some((o) => o.value === want) ? options : [...options, { value: want, label: want, hint: 'GONE' }],
          search: true,
          value: want,
          onChange: (v) => { snd!.setMap(n, v); paintPreset(); },
        });
        host.appendChild(h.el);
        picks.set(n, h);
        perPack.push(h);
      }
    }

    eventsEl.querySelectorAll<HTMLElement>('[data-ev]').forEach((b) => b.addEventListener('click', () => {
      const n = b.dataset.ev as SoundName;
      const ref = picks.get(n)?.value() || snd!.refOf(n);
      if (ref) snd!.preview(ref);
    }));
  }

  /* ── One row per pack ───────────────────────────────────────────── */

  function paintPacks() {
    if (!packList.length) {
      packsEl.innerHTML = `<p class="px px--tiny" style="color:var(--ink-dim)">NO INDEX AT /SFX/PACKS/INDEX.JSON.</p>`;
      return;
    }
    const cur = snd!.pack();
    packsEl.innerHTML = packList.map((p) => `
      <div class="sfx__pack${p.id === cur ? ' is-cur' : ''}">
        <button class="sfx__play" type="button" data-pk="${esc(p.id)}" title="HEAR ${esc(p.label)}" aria-label="sample ${esc(p.label)}">▶</button>
        <button class="sfx__packname px" type="button" data-use="${esc(p.id)}">${esc(p.label)}</button>
        <span class="mono sfx__meta">${p.count} CLIPS</span>
        <p class="px px--tiny sfx__style">${esc(p.style)}</p>
      </div>`).join('');
    packsEl.querySelectorAll<HTMLElement>('[data-pk]').forEach((b) => b.addEventListener('click', () => {
      // open.agent is the sample: the sound the console makes most often.
      snd!.preview(`${b.dataset.pk}:${CLIP_OF['open.agent']}`);
    }));
    packsEl.querySelectorAll<HTMLElement>('[data-use]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.use!;
      if (id === snd!.pack()) return;
      snd!.setPack(id);
      packPick?.set(id);
      paintPreset();
      rebuildEvents();
      paintPacks();
      c.note(`sound pack · ${id}`);
    }));
  }

  /* ── Load the index, then every manifest, then draw ─────────────── */

  void (async () => {
    const list = await snd.packs();
    if (gone) return;
    packList = list;
    await Promise.all(list.map(async (p) => { clipsOf.set(p.id, await snd.clips(p.id)); }));
    if (gone) return;
    paintPreset();
    paintPack();
    rebuildEvents();
    paintPacks();
  })();

  /* ── Save, delete, reset ────────────────────────────────────────── */

  body.querySelector<HTMLElement>('[data-save]')!.addEventListener('click', () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); c.note('a preset needs a name', 'warn'); return; }
    snd.savePreset(name);
    nameIn.value = '';
    paintPreset();
    c.note(`sound preset saved · ${name.toLowerCase()}`);
  });
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); body.querySelector<HTMLElement>('[data-save]')!.click(); }
    e.stopPropagation();
  });

  delBtn.addEventListener('click', () => {
    const id = snd.preset();
    const p = snd.presets().find((x) => x.id === id);
    if (!p || p.builtin) return;
    snd.deletePreset(id);
    paintPreset();
    c.note(`sound preset deleted · ${p.label.toLowerCase()}`);
  });

  body.querySelector<HTMLElement>('[data-reset]')!.addEventListener('click', () => {
    snd.resetMap();
    paintPreset();
    rebuildEvents();
    c.note('sound overrides cleared · the pack answers everything');
  });

  return {
    dispose() {
      gone = true;
      clearInterval(sync);
      presetPick?.dispose();
      packPick?.dispose();
      for (const h of perPack) h.dispose();
      for (const h of fixed) h.dispose();
    },
  };
}
