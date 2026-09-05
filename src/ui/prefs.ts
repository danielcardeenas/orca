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
}

const DEFAULTS: Prefs = { panel: 0.5, panelColor: false, musicAutoplay: false };

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
