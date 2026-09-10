/**
 * The console's sound — samples, not a synthesiser's imitation of them.
 *
 * ── Events, clips, packs, presets ────────────────────────────────────
 *
 * Four words, and they are not the same word:
 *
 *   - an **event** (`SoundName`) is something the console did. There are 48,
 *     in five groups: FLEET, WINDOWS, NAVIGATION, DECK, REPLAY.
 *   - a **clip** is one audio file. There are 32 in a pack, because siblings
 *     share: the five windows that open a list of rows all ring `open.list`,
 *     `deck.tick` and `replay.step` are both `tick`. `CLIP_OF` below is that
 *     mapping and it is the same in every pack.
 *   - a **pack** is one voice for all 32: `public/sfx/packs/<pack>/`, a
 *     manifest and its mp3s, made by `tools/sfx-gen.mjs`. Five of them —
 *     `cinema` (film UI: glass, air, a soft sub and a very short tail),
 *     `mac` (a modern Apple system sound made richer: round warm marimba and
 *     glass notes, groovy, brief), `capcom` (mission control with the radio
 *     off: pure tones, a distant relay, tape), `mechanical` (tiny soft clicks
 *     and latches, nothing tonal), and `legacy`, the console's first voice.
 *   - a **preset** is a pack plus per-event overrides. Four of them are just
 *     their pack; `mixed` is CINEMA for the fleet, MAC for the windows,
 *     MECHANICAL for the way you move around and CAPCOM for the deck and the
 *     replay. The operator saves their own with SAVE PRESET in the SFX window.
 *
 * Every clip is a micro-sound built to be heard over ambient music: no voice,
 * no words, and nothing that sounds like a game console. `tools/sfx-gen.mjs
 * --check` refuses the whole set if a prompt ever drifts back there.
 *
 * An override is `"clip"` (in the current pack) or `"pack:clip"` (anywhere).
 * That second form is the whole of what makes `mixed` possible.
 *
 * Resolution, in order, and it ends in silence rather than in a throw:
 *
 *   the event's override → the current pack's clip for that event (or for the
 *   sibling clip it shares) → nothing.
 *
 * ── What it costs to be loud ─────────────────────────────────────────
 *
 * Audible by default and persisted. It used to start muted, and the cost of
 * that default was invisible: the console is one origin per address, so the
 * same console on `127.0.0.1` and on the tailnet address are two different
 * `localStorage` stores, and opening ORCA anywhere new brought back a silence
 * that read as a bug rather than as a setting. Silence is a choice the
 * operator makes once and it is remembered; it is not a thing to rediscover
 * at every address. Master volume is `orca.sfx.vol.v1`, ten steps in the
 * window. `prefers-reduced-motion` is about motion, not audio, and silences
 * nothing.
 *
 * Nothing is fetched or decoded until it is first heard, and no browser makes
 * a sound before the first gesture, so an unattended console that nobody has
 * touched still costs nothing and stays quiet.
 *
 * Coalescing: one sound of a kind per 400 ms, three per second in total. The
 * deck's arrival is the exception — `deck.tick` and `replay.step` may fire six
 * times a second, up to eight per slide, and they do not spend the global
 * budget. A quarter of a second of quiet starts a new slide.
 *
 * ── What it says by itself ───────────────────────────────────────────
 *
 * It subscribes to the store, so nothing has to remember to ring it:
 *
 *   alarm on ................. interrupt   a human is required
 *   escalation → answered .... answer      you closed one
 *   one or two agents born ... spawn       lineage grew
 *   three or more at once .... squad       a squadron formed
 *   agent → dead ............. dead
 *   link up / down ........... link / breach
 *   a new artifact ........... artifact
 *   observed CAPCOM activity   capcom.thinking   opt-in, once per recent outgoing line
 *
 * Everything else is a gesture the console made, not a fact the world
 * reported, so its caller rings it: `getSound()?.play('deck.enter')`. The
 * full list of call sites is in DESIGN.md under Sound.
 *
 * Wiring (main.ts):
 *
 *   const snd = mountSound();
 *   hudEl.querySelector('.mast__tools')!.appendChild(snd.el);
 *   // key: S → snd.toggle()
 *
 * The handle's `el` is a `.tool.snd` button; place it, do not restyle it.
 */

import type { AgentState, EscalationStatus } from '../../shared/types.ts';
import { capcomOf } from '../../shared/capcom.ts';
import { capcomFeedback } from '../windows/capcom-feedback.ts';
import { ThinkingSoundGate } from './capcom-thinking-sound.ts';
import { store } from '../store.ts';

/* ── The taxonomy ───────────────────────────────────────────────────── */

export type FleetSound =
  | 'interrupt' | 'answer' | 'spawn' | 'launch' | 'squad'
  | 'dead' | 'breach' | 'link' | 'artifact' | 'placed'
  /** Observed activity near your outgoing line; never proof of receipt or a reply. */
  | 'capcom.thinking';

export type WindowSound =
  | 'open.agent' | 'open.interrupt' | 'open.queue' | 'open.capcom' | 'open.feed'
  | 'open.fleet' | 'open.spawn' | 'open.launch' | 'open.artifact' | 'open.gallery'
  | 'open.timeline' | 'open.sfx' | 'open.help' | 'open.music'
  | 'close' | 'fold' | 'unfold' | 'wipe' | 'check';

export type NavSound =
  | 'bookmark.save' | 'bookmark.go' | 'back' | 'frame'
  | 'tilt.on' | 'tilt.off' | 'focus.on' | 'focus.off' | 'lasso' | 'select';

export type DeckSound = 'deck.enter' | 'deck.exit' | 'deck.sort' | 'deck.settle' | 'deck.tick';

export type ReplaySound = 'replay.enter' | 'replay.exit' | 'replay.step';

export type SoundName = FleetSound | WindowSound | NavSound | DeckSound | ReplaySound;

export interface SoundGroup {
  id: 'fleet' | 'windows' | 'navigation' | 'deck' | 'replay';
  label: string;
  names: readonly SoundName[];
}

/** The five groups, in the order the SFX window stacks them. */
export const SOUND_GROUPS: readonly SoundGroup[] = [
  {
    id: 'fleet', label: 'FLEET',
    names: ['interrupt', 'answer', 'spawn', 'launch', 'squad', 'dead', 'breach', 'link', 'artifact', 'placed', 'capcom.thinking'],
  },
  {
    id: 'windows', label: 'WINDOWS',
    names: [
      'open.agent', 'open.interrupt', 'open.queue', 'open.capcom', 'open.feed', 'open.fleet',
      'open.spawn', 'open.launch', 'open.artifact', 'open.gallery', 'open.timeline', 'open.sfx',
      'open.help', 'open.music', 'close', 'fold', 'unfold', 'wipe', 'check',
    ],
  },
  {
    id: 'navigation', label: 'NAVIGATION',
    names: ['bookmark.save', 'bookmark.go', 'back', 'frame', 'tilt.on', 'tilt.off', 'focus.on', 'focus.off', 'lasso', 'select'],
  },
  { id: 'deck', label: 'DECK', names: ['deck.enter', 'deck.exit', 'deck.sort', 'deck.settle', 'deck.tick'] },
  { id: 'replay', label: 'REPLAY', names: ['replay.enter', 'replay.exit', 'replay.step'] },
];

/** Every event, flat, in group order. */
export const SOUND_NAMES: readonly SoundName[] = SOUND_GROUPS.flatMap((g) => [...g.names]);

/**
 * Event → the clip a pack must have for it. Siblings share, which is the
 * whole reason a pack is 32 files and not 47: five list windows are one
 * sound, four tool windows are one sound, a deck tick and a replay step are
 * the same tap. `tools/sfx-gen.mjs --check` keeps this table and the
 * generator's honest with each other.
 */
export const CLIP_OF: Record<SoundName, string> = {
  /* fleet — every one of these earns its own clip */
  interrupt: 'interrupt',
  answer: 'answer',
  spawn: 'spawn',
  launch: 'launch',
  squad: 'squad',
  dead: 'dead',
  breach: 'breach',
  link: 'link',
  artifact: 'artifact',
  placed: 'placed',
  // The smallest sound in the set: CAPCOM starting on your line is a blink,
  // not an announcement. The deck's tile tick is already that.
  'capcom.thinking': 'tick',

  /* windows — an agent, an alert, a list, a tool, a channel */
  'open.agent': 'open.agent',
  'open.interrupt': 'open.alert',
  'open.capcom': 'open.capcom',
  'open.queue': 'open.list',
  'open.feed': 'open.list',
  'open.fleet': 'open.list',
  'open.gallery': 'open.list',
  'open.timeline': 'open.list',
  'open.spawn': 'open.tool',
  'open.launch': 'open.tool',
  'open.sfx': 'open.tool',
  'open.help': 'open.tool',
  'open.music': 'open.tool',
  // An artifact window opening and an artifact arriving are the same subject.
  'open.artifact': 'artifact',
  close: 'close',
  fold: 'fold',
  unfold: 'unfold',
  wipe: 'wipe',
  // The check is a confirmation, and the console already owns one.
  check: 'answer',

  /* navigation — a flight is a flight, whichever key asked for it */
  'bookmark.save': 'bookmark.save',
  'bookmark.go': 'fly',
  back: 'fly',
  frame: 'fly',
  'tilt.on': 'mode.on',
  'focus.on': 'mode.on',
  'tilt.off': 'mode.off',
  'focus.off': 'mode.off',
  lasso: 'lasso',
  select: 'select',

  /* deck */
  'deck.enter': 'deck.enter',
  'deck.exit': 'deck.exit',
  'deck.sort': 'deck.sort',
  'deck.settle': 'deck.settle',
  'deck.tick': 'tick',

  /* replay */
  'replay.enter': 'replay.enter',
  'replay.exit': 'replay.exit',
  'replay.step': 'tick',
};

/** The 32 clip ids a complete pack holds, in group order, without repeats. */
export const CLIP_IDS: readonly string[] = [...new Set(SOUND_NAMES.map((n) => CLIP_OF[n]))];

/**
 * `WinKind` → the event a window of that kind rings when it arrives. Kept
 * here rather than in the window manager so that a kind gets a sound by being
 * added to one table, and so that `wm.ts` never has to know what a sound is:
 *
 *   onFocus: (w) => {
 *     if (w && !w.el.dataset.heard) {
 *       w.el.dataset.heard = '1';
 *       getSound()?.play(openSoundFor(w.spec.kind));
 *     }
 *   }
 */
export const OPEN_OF_KIND: Record<string, SoundName> = {
  agent: 'open.agent',
  interrupt: 'open.interrupt',
  // A breach window opened itself because something is wrong. Same voice.
  breach: 'open.interrupt',
  queue: 'open.queue',
  ceo: 'open.capcom',
  feed: 'open.feed',
  fleet: 'open.fleet',
  spawn: 'open.spawn',
  launch: 'open.launch',
  artifact: 'open.artifact',
  gallery: 'open.gallery',
  timeline: 'open.timeline',
  sfx: 'open.sfx',
  help: 'open.help',
  music: 'open.music',
};

/** A kind nobody has given a voice yet still opens like an instrument. */
export function openSoundFor(kind: string): SoundName {
  return OPEN_OF_KIND[kind] ?? 'open.agent';
}

/* ── The files ──────────────────────────────────────────────────────── */

/** One line of a pack's `manifest.json`. `file` is relative to `/sfx/`. */
export interface PackClip {
  /** `open.list`. What an override names. */
  id: string;
  /** `packs/capcom/open.list.mp3`, under `/sfx/`. */
  file: string;
  /** What it is, in three words. */
  label: string;
  /** Seconds. */
  len: number;
}

export interface PackManifest {
  pack: string;
  label: string;
  style: string;
  clips: PackClip[];
}

/** One line of `packs/index.json`. */
export interface PackInfo {
  id: string;
  label: string;
  style: string;
  /** How many of the 32 it actually has on disk. */
  count: number;
  manifest: string;
}

/* ── Presets ────────────────────────────────────────────────────────── */

/** A pack, plus whatever the operator wanted different. */
export interface Preset {
  id: string;
  label: string;
  /** Which pack answers every event this preset does not override. */
  pack: string;
  /** Event → `"clip"` or `"pack:clip"`. */
  over: Partial<Record<SoundName, string>>;
  /** Factory presets cannot be deleted. */
  builtin: boolean;
}

const GROUP_OF = new Map<SoundName, SoundGroup['id']>();
for (const g of SOUND_GROUPS) for (const n of g.names) GROUP_OF.set(n, g.id);

/** Every event of these groups, pointed at another pack's clip for it. */
function borrow(pack: string, groups: SoundGroup['id'][]): Partial<Record<SoundName, string>> {
  const out: Partial<Record<SoundName, string>> = {};
  for (const n of SOUND_NAMES) if (groups.includes(GROUP_OF.get(n)!)) out[n] = `${pack}:${CLIP_OF[n]}`;
  return out;
}

export const DEFAULT_PACK = 'cinema';

/**
 * Five from the factory. The four pure ones are a pack and nothing else;
 * `mixed` is the argument that the console does not have one voice but four
 * instruments — glass for what the fleet does, a warm note for the windows,
 * a switch for the way you move around, and a pure tone for the deck and the
 * past.
 */
export const FACTORY_PRESETS: readonly Preset[] = [
  { id: 'cinema', label: 'CINEMA', pack: 'cinema', over: {}, builtin: true },
  { id: 'mac', label: 'MAC', pack: 'mac', over: {}, builtin: true },
  { id: 'capcom', label: 'CAPCOM', pack: 'capcom', over: {}, builtin: true },
  { id: 'mechanical', label: 'MECHANICAL', pack: 'mechanical', over: {}, builtin: true },
  { id: 'legacy', label: 'LEGACY', pack: 'legacy', over: {}, builtin: true },
  {
    id: 'mixed', label: 'MIXED', pack: 'cinema', builtin: true,
    over: {
      ...borrow('cinema', ['fleet']),
      ...borrow('mac', ['windows']),
      ...borrow('mechanical', ['navigation']),
      ...borrow('capcom', ['deck', 'replay']),
    },
  },
];

/* ── The handle ─────────────────────────────────────────────────────── */

export type SoundOverrides = Partial<Record<SoundName, string>>;

export interface SoundHandle {
  /** The mute button. Unparented styling; main.ts decides where it sits. */
  el: HTMLButtonElement;
  /**
   * Ring an event. Silent while muted, coalesced, and a no-op — never a
   * throw — for a name no pack has a clip for, including names that are not
   * events at all. A caller may ring the future.
   */
  play(name: SoundName | (string & {})): void;
  /**
   * Audition one clip. `"clip"` uses the current pack, `"pack:clip"` any
   * other. Ignores the mute and the coalescing, because the operator asked
   * for it with a click — this is the one sound that is not the console
   * speaking.
   */
  preview(ref: string): void;

  /** What an event will actually play, as `"pack:clip"`, or null for silence. */
  refOf(name: SoundName): string | null;

  /** Every pack, from `/sfx/packs/index.json`. Fetched once, then cached. */
  packs(): Promise<PackInfo[]>;
  /** One pack's clips. Defaults to the current pack. */
  clips(packId?: string): Promise<PackClip[]>;
  pack(): string;
  setPack(id: string): void;

  presets(): Preset[];
  /** The preset in force, or `''` once the operator has changed anything. */
  preset(): string;
  usePreset(id: string): void;
  /** Freeze the current pack and overrides under a name. Returns the new id. */
  savePreset(name: string): string;
  /** User presets only; a factory one is never deleted. */
  deletePreset(id: string): void;

  /** The live per-event overrides. A copy; write through `setMap`. */
  map(): SoundOverrides;
  /** `''` clears the override and gives the event back to the pack. */
  setMap(name: SoundName, ref: string): void;
  /** Drop every override, back to the current pack, plain. */
  resetMap(): void;

  thinkingVolume(): number;
  setThinkingVolume(v: number): void;
  volume(): number;
  setVolume(v: number): void;
  muted(): boolean;
  setMuted(on: boolean): void;
  /** Flip the mute. Returns the new muted state. */
  toggle(): boolean;
  dispose(): void;
}

const MUTE_KEY = 'orca.sound.muted';
const PACK_KEY = 'orca.sfx.pack.v2';
const OVER_KEY = 'orca.sfx.map.v2';
const PRESETS_KEY = 'orca.sfx.presets.v1';
const PRESET_KEY = 'orca.sfx.preset.v2';
const VOL_KEY = 'orca.sfx.vol.v1';
const THINKING_VOL_KEY = 'orca.sfx.capcom-thinking.vol.v1';

const INDEX = '/sfx/packs/index.json';
const DIR = '/sfx/';

/** Where the master sits when the operator has never touched it. */
const DEFAULT_VOL = 0.8;
/** Per-play variation, in decibels either way. Enough that two blips in a row
 *  are not the same blip; not enough to read as a level change. */
const VARY_DB = 1;
/** One sound of a kind per this window. Ten agents blocking is one alert. */
const PER_KIND_MS = 400;
/** And never more than this many sounds in any one second, of any kind. */
const PER_SECOND = 3;

/** The deck's arrival is a texture, not an event, so it has its own budget. */
const FAST: ReadonlySet<SoundName> = new Set<SoundName>(['deck.tick', 'replay.step']);
/** Six a second, at most. */
const FAST_MS = 165;
/** Eight taps per slide: a hundred tiles landing is still one arrival. */
const FAST_BURST = 8;
/** This much quiet, and the next tap is a new slide. */
const FAST_GAP = 250;

/* ── The singleton ──────────────────────────────────────────────────── */

let current: SoundHandle | null = null;

/**
 * The mounted sound, for anything that needs to ring it without holding a
 * reference to the Console — a window, a command handler, the field. Null
 * before `mountSound()` and after its `dispose()`; callers use `?.`.
 */
export function getSound(): SoundHandle | null { return current; }

/** `"capcom:tick"` → both halves; `"tick"` → the current pack's. */
function splitRef(ref: string, fallbackPack: string): { pack: string; clip: string } {
  const i = ref.indexOf(':');
  return i < 0 ? { pack: fallbackPack, clip: ref } : { pack: ref.slice(0, i), clip: ref.slice(i + 1) };
}

export function mountSound(): SoundHandle {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'tool snd';

  let mute = loadMuted();
  let vol = loadVol();
  const storedThinking = Number(read(THINKING_VOL_KEY));
  let thinkingVol = Number.isFinite(storedThinking) && storedThinking >= 0 && storedThinking <= 1 ? storedThinking : 0;
  let thinkingEpoch = 0;
  let thinkingSource: AudioBufferSourceNode | null = null;
  let disposed = false;
  function cancelThinking() {
    thinkingEpoch++;
    try { thinkingSource?.stop(); } catch { /* already ended */ }
    thinkingSource = null;
  }
  let packId = loadPack();
  let over = loadOver();
  let presetId = loadPresetId();
  let userPresets = loadUserPresets();

  /* ── The audio graph, built on the first gesture ─────────────────── */

  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;

  /**
   * Browsers refuse an AudioContext outside a user gesture, so one is built
   * on the first pointer or key the operator gives the console, whatever it
   * was for. It costs nothing while muted and it is ready when unmuted.
   */
  function unlock() {
    if (disposed) return;
    if (ctx) { void ctx.resume().catch(() => {}); return; }
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = vol;
      master.connect(ctx.destination);
      void ctx.resume().catch(() => {});
    } catch { ctx = null; master = null; }
  }
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true });

  /* ── The packs, fetched once each ────────────────────────────────── */

  let index: Promise<PackInfo[]> | null = null;
  const manifests = new Map<string, Promise<PackManifest | null>>();
  const buffers = new Map<string, Promise<AudioBuffer | null>>();

  function packs(): Promise<PackInfo[]> {
    if (!index) {
      index = fetch(INDEX)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j) => (Array.isArray(j) ? (j as PackInfo[]) : []))
        .then((list) => {
          // A pack can be retired between two runs, and a stored id that no
          // longer exists is a console that has gone quiet for no reason the
          // operator can see. Take the default back rather than say nothing.
          if (list.length && !list.some((p) => p.id === packId)) {
            packId = list.some((p) => p.id === DEFAULT_PACK) ? DEFAULT_PACK : list[0]!.id;
            write(PACK_KEY, packId);
            goCustom();
          }
          return list;
        })
        // A missing index is a console without sound, never a console that
        // throws. The window will show an empty list and say so.
        .catch(() => [] as PackInfo[]);
    }
    return index;
  }

  function manifest(id: string): Promise<PackManifest | null> {
    const had = manifests.get(id);
    if (had) return had;
    const p = fetch(`${DIR}packs/${id}/manifest.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => (j && Array.isArray((j as PackManifest).clips) ? (j as PackManifest) : null))
      .catch(() => null);
    manifests.set(id, p);
    return p;
  }

  function clips(id = packId): Promise<PackClip[]> {
    return manifest(id).then((m) => m?.clips ?? []);
  }

  /**
   * Decode on demand: the first time a clip is actually needed, not at boot.
   * Five packs is 160 files, and a console that is muted should not have
   * spent a byte on any of them.
   */
  function load(pack: string, clip: string): Promise<AudioBuffer | null> {
    // No gesture yet, so no context to decode into — and nothing to remember
    // about it either: caching that null would silence the clip for good.
    if (!ctx) return Promise.resolve(null);
    const key = `${pack}:${clip}`;
    const had = buffers.get(key);
    if (had) return had;
    const p = (async () => {
      if (!ctx) return null;
      const m = await manifest(pack);
      const cl = m?.clips.find((c) => c.id === clip);
      if (!cl) return null;
      const res = await fetch(DIR + cl.file);
      if (!res.ok) throw new Error(`sfx ${key}: ${res.status}`);
      const bytes = await res.arrayBuffer();
      // decodeAudioData's promise form is the one Safari also honours today.
      return await ctx.decodeAudioData(bytes);
    })().catch(() => {
      // Do not cache a failure: a clip that lost a race with the AudioContext
      // must be allowed to load on the next press.
      buffers.delete(key);
      return null;
    });
    buffers.set(key, p);
    return p;
  }

  /** One clip, now, at master × a hair. No pitch shifting: it is the take. */
  function fire(pack: string, clip: string, thinking = false) {
    const epoch = thinkingEpoch;
    const requestedAt = performance.now();
    if (!ctx || !master) return;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    void load(pack, clip).then((buf) => {
      if (!buf || !ctx || !master || disposed) return;
      if (thinking && (epoch !== thinkingEpoch || mute || vol === 0 || thinkingVol === 0
        || document.hidden || ctx.state !== 'running' || !processing()
        || performance.now() - requestedAt > 1000)) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = thinking ? thinkingVol * 0.25 : Math.pow(10, ((Math.random() * 2 - 1) * VARY_DB) / 20);
      if (thinking) {
        // Enveloped and capped even if an operator maps a longer clip.
        const at = ctx.currentTime;
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(thinkingVol * 0.25, at + 0.012);
        g.gain.linearRampToValueAtTime(0, at + 0.16);
        thinkingSource = src;
      }
      src.connect(g).connect(master);
      if (thinking) src.start(0, 0, Math.min(buf.duration, 0.18));
      else src.start();
      src.onended = () => {
        if (thinkingSource === src) thinkingSource = null;
        try { src.disconnect(); g.disconnect(); } catch { /* gone */ }
      };
    }).catch(() => { /* Audio unavailable: never interrupt the console. */ });
  }

  /* ── Resolution ─────────────────────────────────────────────────── */

  function refOf(name: SoundName): string | null {
    const o = over[name];
    if (o) { const s = splitRef(o, packId); return `${s.pack}:${s.clip}`; }
    const clip = CLIP_OF[name];
    return clip ? `${packId}:${clip}` : null;
  }

  /* ── Coalescing ─────────────────────────────────────────────────── */

  const lastOf = new Map<string, number>();
  let recent: number[] = [];
  /** How many taps this slide has already had, and when the last one was. */
  let burst = 0;
  let burstAt = -1e9;

  function allowed(name: SoundName): boolean {
    const now = performance.now();
    if (FAST.has(name)) {
      if (now - burstAt > FAST_GAP) burst = 0;
      if (now - burstAt < FAST_MS) return false;
      if (burst >= FAST_BURST) return false;
      burst++;
      burstAt = now;
      return true;
    }
    if (now - (lastOf.get(name) ?? -1e9) < PER_KIND_MS) return false;
    recent = recent.filter((t) => now - t < 1000);
    if (recent.length >= PER_SECOND) return false;
    lastOf.set(name, now);
    recent.push(now);
    return true;
  }

  function play(name: SoundName | (string & {})) {
    if (mute || disposed) return;
    if (name === 'capcom.thinking' && (thinkingVol === 0 || vol === 0 || document.hidden || !processing())) return;
    if (!ctx || !master) return; // no gesture yet: silence, never a throw
    // A name no group lists is a caller ringing something this build does not
    // have a sound for yet. That is allowed, and it is quiet.
    if (!(name in CLIP_OF)) return;
    const n = name as SoundName;
    if (!allowed(n)) return;
    const ref = refOf(n);
    if (!ref) return;
    const s = splitRef(ref, packId);
    fire(s.pack, s.clip, n === 'capcom.thinking');
  }

  function preview(ref: string) {
    unlock();
    const s = splitRef(ref, packId);
    fire(s.pack, s.clip);
  }

  /* ── Persistence ────────────────────────────────────────────────── */

  function read(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function write(key: string, v: string | null) {
    try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, v); }
    catch { /* private mode: the session still works, it just forgets */ }
  }

  function loadPack(): string { return read(PACK_KEY) || DEFAULT_PACK; }
  function loadPresetId(): string { return read(PRESET_KEY) ?? DEFAULT_PACK; }
  function loadVol(): number {
    // `Number(null)` is 0, and a console that has never been touched is not a
    // console at zero. Nothing stored means the default, not silence.
    const raw = read(VOL_KEY);
    if (raw === null || raw === '') return DEFAULT_VOL;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_VOL;
  }
  /** Only an explicit mute silences the console; anything else is sound on. */
  function loadMuted(): boolean { return read(MUTE_KEY) === '1'; }

  /** Only keys that are events and values that are strings survive the trip. */
  function sane(j: unknown): SoundOverrides {
    const out: SoundOverrides = {};
    if (!j || typeof j !== 'object') return out;
    const src = j as Record<string, unknown>;
    for (const n of SOUND_NAMES) {
      const v = src[n];
      if (typeof v === 'string' && v) out[n] = v;
    }
    return out;
  }

  function loadOver(): SoundOverrides {
    try { const raw = read(OVER_KEY); return raw ? sane(JSON.parse(raw)) : {}; }
    catch { return {}; }
  }
  function saveOver() { write(OVER_KEY, JSON.stringify(over)); }

  function loadUserPresets(): Preset[] {
    try {
      const raw = read(PRESETS_KEY);
      if (!raw) return [];
      const j = JSON.parse(raw);
      if (!Array.isArray(j)) return [];
      return (j as Partial<Preset>[])
        .filter((p) => typeof p?.id === 'string' && typeof p?.pack === 'string')
        .map((p) => ({ id: p.id!, label: p.label || p.id!, pack: p.pack!, over: sane(p.over), builtin: false }));
    } catch { return []; }
  }
  function saveUserPresets() { write(PRESETS_KEY, JSON.stringify(userPresets)); }

  /** Anything the operator turns by hand leaves the preset behind. */
  function goCustom() {
    if (!presetId) return;
    presetId = '';
    write(PRESET_KEY, '');
  }

  /* ── Mute and level ─────────────────────────────────────────────── */

  function setMuted(on: boolean) {
    mute = on;
    if (on) cancelThinking();
    write(MUTE_KEY, on ? '1' : '0');
    paint();
  }
  function setVolume(v: number) {
    if (!Number.isFinite(v)) return;
    vol = Math.min(1, Math.max(0, v));
    if (vol === 0) cancelThinking();
    write(VOL_KEY, String(vol));
    if (master) master.gain.value = vol;
  }
  function paint() {
    el.textContent = mute ? 'SND OFF' : 'SND ON';
    el.classList.toggle('is-on', !mute);
    el.title = mute ? 'SOUND MUTED · S' : 'SOUND ON · S';
  }
  el.addEventListener('click', () => { unlock(); setMuted(!mute); });
  paint();

  /* ── What the store makes it say ────────────────────────────────── */

  // Our own baselines: the store keeps its transitions private, and the ones
  // we need (escalation status, agent birth, an artifact appearing) are not
  // events it emits.
  const seenAgents = new Set<string>();
  const agentState = new Map<string, AgentState>();
  const escState = new Map<string, EscalationStatus>();
  const seenArt = new Set<string>();

  function reseed() {
    seenAgents.clear(); agentState.clear(); escState.clear(); seenArt.clear();
    for (const a of Object.values(store.world.agents)) { seenAgents.add(a.id); agentState.set(a.id, a.state); }
    for (const e of Object.values(store.world.escalations)) escState.set(e.id, e.status);
    for (const id of Object.keys(store.world.artifacts ?? {})) seenArt.add(id);
  }
  reseed();

  /** Three tiles appearing in one patch is a squadron, not three spawns. */
  const SQUAD_AT = 3;

  /**
   * Nada del arnés suena.
   *
   * Las máquinas de fixture nacen, se mueren y preguntan a un ritmo que no es
   * el de nadie: veinte teselas apareciendo a la vez y una pregunta cada pocos
   * segundos, durante todo lo que dure `npm run visual`. El oído no distingue
   * un mundo del otro, así que un arnés en marcha convierte la banda sonora
   * de la consola en un timbre continuo y deja de significar nada — que es
   * justo lo contrario de para qué está. Se mira si hace falta (la cola sigue
   * llena, el mástil sigue contando); no se oye. Ver `shared/synthetic.ts`.
   */
  const real = (x: { machineId: string } | undefined | null) => !!x && !store.fromHarness(x);

  const thinkingGate = new ThinkingSoundGate();
  function processing() {
    const a = capcomOf(store.world.agents);
    return !!a && real(a) && !store.booting && store.linkUp && store.authed()
      && a.modelControl?.phase !== 'applying'
      && capcomFeedback({ agents: store.world.agents, linkUp: store.linkUp,
        authed: store.authed(), seenLink: true, thinking: store.world.ceo.thinking }).kind === 'processing'
      && (a.state === 'thinking' || a.state === 'working' || (a.state === 'blocked' && a.block?.kind === 'peer'));
  }
  function observeThinking(baseline: boolean) {
    const active = processing();
    if (!active || baseline) cancelThinking();
    return thinkingGate.observe({ request: store.outgoing.filter(m => m.agentId === null).at(-1) ?? null,
      processing: active, baseline, now: Date.now() });
  }
  observeThinking(true);
  const visibility = () => { if (document.hidden) cancelThinking(); };
  document.addEventListener('visibilitychange', visibility);
  const off = store.on((e) => {
    const relevant = ['world', 'agents', 'ceo', 'link', 'auth'].includes(e.k);
    const turn = relevant && observeThinking(store.booting || e.k === 'world' || e.k === 'link' || e.k === 'auth');
    if (turn && e.k !== 'agents') play('capcom.thinking');
    // The boot owns the screen and has its own rhythm; it does not need a
    // chorus for a fleet that is only now arriving.
    if (store.booting) {
      if (e.k === 'world' || e.k === 'agents' || e.k === 'escalations' || e.k === 'artifacts') reseed();
      return;
    }

    switch (e.k) {
      case 'world':
        reseed();
        break;
      case 'alarm':
        // La alarma se enciende igual —la pregunta está ahí y se ve— pero no
        // suena si la levantó el arnés y nadie más: no hay nadie esperando.
        if (e.on && store.pending().some(real)) play('interrupt');
        break;
      case 'agents': {
        let births = 0, death = false;
        for (const id of e.ids) {
          const a = store.world.agents[id];
          if (!a) { seenAgents.delete(id); agentState.delete(id); continue; }
          if (!seenAgents.has(id)) {
            seenAgents.add(id);
            // Only a spawn has a parent; a root agent is the operator's doing
            // and already had its own confirmation on the command line.
            if (a.parentId && real(a)) births++;
          }
          const before = agentState.get(id);
          agentState.set(id, a.state);
          if (before !== 'dead' && a.state === 'dead' && real(a)) death = true;
        }
        // Death outranks birth: a patch that carries both should not sound
        // cheerful. One beat per patch either way.
        if (death) play('dead');
        else if (births >= SQUAD_AT) play('squad');
        else if (births) play('spawn');
        else if (turn) play('capcom.thinking');
        break;
      }
      case 'escalations': {
        let answered = false;
        for (const id of e.ids) {
          const x = store.world.escalations[id];
          if (!x) { escState.delete(id); continue; }
          const before = escState.get(id);
          escState.set(id, x.status);
          if (before !== 'answered' && x.status === 'answered' && real(x)) answered = true;
        }
        if (answered) play('answer');
        break;
      }
      case 'artifacts': {
        let fresh = false;
        for (const id of e.ids) {
          const art = store.world.artifacts?.[id];
          if (!art) { seenArt.delete(id); continue; }
          if (seenArt.has(id)) continue;
          seenArt.add(id);
          if (real(art)) fresh = true;
        }
        if (fresh) play('artifact');
        break;
      }
      case 'link':
        play(e.up ? 'link' : 'breach');
        break;
    }
  });

  /* ── The handle ─────────────────────────────────────────────────── */

  const handle: SoundHandle = {
    el,
    play,
    preview,
    refOf,
    packs,
    clips,
    pack: () => packId,
    setPack(id: string) {
      if (id === packId) return;
      packId = id;
      write(PACK_KEY, id);
      goCustom();
    },
    presets: () => [...FACTORY_PRESETS, ...userPresets].map((p) => ({ ...p, over: { ...p.over } })),
    preset: () => presetId,
    usePreset(id: string) {
      const p = [...FACTORY_PRESETS, ...userPresets].find((x) => x.id === id);
      if (!p) return;
      packId = p.pack;
      over = { ...p.over };
      presetId = p.id;
      write(PACK_KEY, packId);
      write(PRESET_KEY, presetId);
      saveOver();
    },
    savePreset(name: string) {
      const label = (name.trim() || 'PRESET').toUpperCase().slice(0, 20);
      const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset';
      let id = `u:${base}`;
      // A second SAVE under a name that is already the operator's overwrites
      // it; one that collides with a factory name gets a suffix instead.
      if (FACTORY_PRESETS.some((p) => p.id === base)) id = `u:${base}-2`;
      const next: Preset = { id, label, pack: packId, over: { ...over }, builtin: false };
      const at = userPresets.findIndex((p) => p.id === id);
      if (at >= 0) userPresets[at] = next; else userPresets.push(next);
      saveUserPresets();
      presetId = id;
      write(PRESET_KEY, id);
      return id;
    },
    deletePreset(id: string) {
      if (FACTORY_PRESETS.some((p) => p.id === id)) return;
      userPresets = userPresets.filter((p) => p.id !== id);
      saveUserPresets();
      if (presetId === id) goCustom();
    },
    map: () => ({ ...over }),
    setMap(name: SoundName, ref: string) {
      if (ref) over[name] = ref; else delete over[name];
      saveOver();
      goCustom();
    },
    resetMap() {
      over = {};
      write(OVER_KEY, null);
      goCustom();
    },
    thinkingVolume: () => thinkingVol,
    setThinkingVolume(v) {
      if (!Number.isFinite(v)) return;
      cancelThinking();
      thinkingVol = Math.min(1, Math.max(0, v));
      write(THINKING_VOL_KEY, String(thinkingVol));
    },
    volume: () => vol,
    setVolume,
    muted: () => mute,
    setMuted,
    toggle() { unlock(); setMuted(!mute); return mute; },
    dispose() {
      disposed = true;
      cancelThinking();
      document.removeEventListener('visibilitychange', visibility);
      off();
      el.remove();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      try { void ctx?.close(); } catch { /* already gone */ }
      if (current === handle) current = null;
    },
  };
  current = handle;
  return handle;
}
