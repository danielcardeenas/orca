/**
 * Preferences: the few knobs the operator sets once and expects to find
 * again. One JSON blob in localStorage, read whole and written whole, so a
 * knob is one line to add and never a second storage key.
 */

import type { FontDisplayId, FontMonoId } from './fonts.ts';

const KEY = 'orca.prefs.v1';

export interface Prefs {
  /** Brightness of the subpixel panel under the fleet, 0 (off) … 1. */
  panel: number;
  /** True draws the panel's RGB stripes in colour; false keeps only the grid, in grey. */
  panelColor: boolean;
  /**
   * Put the last record on when the console opens. Spotify starts on the
   * operator's first click or key — a browser plays no sound before one —
   * and Bandcamp only ever starts from its own ▶, so the window is opened
   * where that button can be seen.
   */
  musicAutoplay: boolean;
  /**
   * Show every session the collectors report. Off (the default) the field
   * holds the fleet: agents ORCA launched, plus any other session only while
   * it is alive. A stranger that finished is history, not a tile — and a
   * dismissed agent stays hidden until this is on.
   */
  showAll: boolean;
  origin: 'orca' | 'external' | 'all';
  /** The HUD's mission panel folded to its head. A click on the head flips it. */
  missionsFolded: boolean;
  /** La sección AUTOMEJORA plegada a su cabecera. Igual que la de misiones. */
  improveFolded: boolean;
  /*
   * CAPCOM's halo (field/command.ts). Four pieces, each its own switch, so
   * the command post can be read at whatever weight the fleet allows: with
   * fifty agents the links are noise, with five they are the picture.
   */
  /** Segment the halo by open mission: one arc per mission the hub keeps, lit while it moves. */
  capcomMissions: boolean;
  /** Amber notches on the halo, one per question nobody has answered yet. */
  capcomNotches: boolean;
  /** The turn: a faster pulse and a solid outline while CAPCOM works, amber while it waits on you. */
  capcomPulse: boolean;
  /** Faint cyan ties from CAPCOM to every agent it launched. Off by default: fifty of them hum. */
  capcomLinks: boolean;
  /**
   * The two faces the console is drawn in (`fonts.ts` holds the catalogue and
   * the stacks). Display is every label and caption; mono is what a machine
   * wrote. An id no longer in the catalogue falls back to the first option,
   * so a stale blob never leaves the console unreadable.
   */
  fontDisplay: FontDisplayId;
  fontMono: FontMonoId;
  /**
   * Read CAPCOM's answer back when the line was spoken (`hud/voice.ts`).
   * Only the conclusion, only its first sentences, only for a spoken line;
   * off, ⌥V still talks and the reply stays in the window.
   */
  voiceReply: boolean;
  /**
   * The synthesiser voice, by the name the browser lists it under; a bare
   * name takes its best take (`Mónica` → `Mónica (mejorada)`). Empty picks
   * like `say` does: the system voice for the language (`voice.ts`). The
   * default is Mónica, Spain's Spanish, by the operator's choice on
   * 2026-09-09 — Siri's own voices are Siri's and no browser or `say` gets
   * them — and a machine without her falls back to AUTO without a word.
   */
  voiceName: string;
  /**
   * Who turns speech into text. `auto` is whisper.cpp on the hub whenever the
   * hub says it can (it hears the fleet's names), else the browser's own;
   * the other two force one. See docs/VOICE.md.
   */
  voiceEngine: 'auto' | 'whisper' | 'browser';
}

const DEFAULTS: Prefs = {
  panel: 0.5, panelColor: false, musicAutoplay: false, showAll: false, origin: 'orca', missionsFolded: false, improveFolded: false,
  capcomMissions: true, capcomNotches: true, capcomPulse: true, capcomLinks: false,
  fontDisplay: 'space-grotesk', fontMono: 'commit-mono',
  voiceReply: true, voiceName: 'Mónica', voiceEngine: 'auto',
};

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const got = JSON.parse(raw) as Partial<Prefs>;
    return { ...DEFAULTS, ...(got && typeof got === 'object' ? got : {}) };
  } catch { return { ...DEFAULTS }; }
}

let cache: Prefs | null = null;

export function getPref<K extends keyof Prefs>(k: K): Prefs[K] {
  if (!cache) cache = load();
  return cache[k];
}

export function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void {
  if (!cache) cache = load();
  cache[k] = v;
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* private mode: lives for this tab */ }
}
