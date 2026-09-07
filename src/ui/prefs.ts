/**
 * Preferences: the few knobs the operator sets once and expects to find
 * again. One JSON blob in localStorage, read whole and written whole, so a
 * knob is one line to add and never a second storage key.
 */

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
  /** The HUD's task panel folded to its head. A click on the head flips it. */
  tasksFolded: boolean;
  /*
   * CAPCOM's halo (field/command.ts). Four pieces, each its own switch, so
   * the command post can be read at whatever weight the fleet allows: with
   * fifty agents the links are noise, with five they are the picture.
   */
  /** Segment the halo by open task: one arc per task the hub keeps, lit while it moves. */
  capcomTasks: boolean;
  /** Amber notches on the halo, one per question nobody has answered yet. */
  capcomNotches: boolean;
  /** The turn: a faster pulse and a solid outline while CAPCOM works, amber while it waits on you. */
  capcomPulse: boolean;
  /** Faint cyan ties from CAPCOM to every agent it launched. Off by default: fifty of them hum. */
  capcomLinks: boolean;
}

const DEFAULTS: Prefs = {
  panel: 0.5, panelColor: false, musicAutoplay: false, showAll: false, origin: 'orca', tasksFolded: false,
  capcomTasks: true, capcomNotches: true, capcomPulse: true, capcomLinks: false,
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
