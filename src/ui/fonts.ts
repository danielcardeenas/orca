/**
 * Type — the two faces the console is drawn in, and the switch between them.
 *
 * Everything in the world reads `--font-display` or `--font-mono`; no rule
 * names a family any more. This file owns what those two properties may hold,
 * writes them onto <html>, and tells the few surfaces that cannot read CSS —
 * a canvas, an xterm — when they changed.
 *
 * `data-font-display` rides along on <html> because one thing does depend on
 * *which* face is up and not just on its stack: `-webkit-font-smoothing: none`
 * keeps Tiny5 on its pixel grid and turns any vector face to gravel.
 */

import { getPref, setPref } from './prefs.ts';

export interface FontChoice {
  id: string;
  /** Display type, uppercased by CSS. What the operator picks by. */
  label: string;
  /** Mono, to the right of the label. What the face is for. */
  hint: string;
  /** The whole stack, fallbacks included. Goes straight into the property. */
  stack: string;
}

/** The face the console speaks in: labels, titles, every instrument caption. */
export const DISPLAY_FONTS = [
  { id: 'space-grotesk', label: 'SPACE GROTESK', hint: 'grotesk', stack: "'Space Grotesk', 'Tiny5', system-ui, sans-serif" },
  { id: 'tiny5',         label: 'TINY5',         hint: 'pixel',   stack: "'Tiny5', 'Jersey 10', monospace" },
  { id: 'martian-mono',  label: 'MARTIAN MONO',  hint: 'wide',    stack: "'Martian Mono', 'Geist Mono', ui-monospace, monospace" },
] as const satisfies readonly FontChoice[];

/** The face a machine wrote in: logs, code, paths, the terminal. */
export const MONO_FONTS = [
  { id: 'commit-mono',  label: 'COMMIT MONO',  hint: 'code',  stack: "'Commit Mono', 'Geist Mono', ui-monospace, SFMono-Regular, monospace" },
  { id: 'geist-mono',   label: 'GEIST MONO',   hint: 'plain', stack: "'Geist Mono', ui-monospace, SFMono-Regular, monospace" },
  { id: 'martian-mono', label: 'MARTIAN MONO', hint: 'wide',  stack: "'Martian Mono', 'Geist Mono', ui-monospace, monospace" },
] as const satisfies readonly FontChoice[];

export type FontDisplayId = (typeof DISPLAY_FONTS)[number]['id'];
export type FontMonoId = (typeof MONO_FONTS)[number]['id'];

/** An id off the catalogue — a stale blob, a face we dropped — lands on the first. */
function choose<T extends FontChoice>(list: readonly T[], id: string): T {
  return list.find((f) => f.id === id) ?? list[0]!;
}

export function displayFont(): FontChoice { return choose(DISPLAY_FONTS, getPref('fontDisplay')); }
export function monoFont(): FontChoice { return choose(MONO_FONTS, getPref('fontMono')); }

/* ── Who has to be told ─────────────────────────────────────────────── */

type Listener = () => void;
const listeners = new Set<Listener>();

/** A canvas or an xterm cannot inherit a custom property; it gets a call. */
export function onFontsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Write both faces onto the document. Called once before anything mounts —
 * the CSS `:root` already carries the same defaults, so this is a no-op on a
 * fresh console and the change the operator asked for on a returning one.
 */
export function applyFonts(): void {
  const d = displayFont();
  const m = monoFont();
  const root = document.documentElement;
  root.style.setProperty('--font-display', d.stack);
  root.style.setProperty('--font-mono', m.stack);
  root.dataset.fontDisplay = d.id;
  root.dataset.fontMono = m.id;
  for (const fn of listeners) fn();
}

/* The pickers hand these a plain string, so both go through the catalogue. */
export function setDisplayFont(id: string): void { setPref('fontDisplay', choose(DISPLAY_FONTS, id).id); applyFonts(); }
export function setMonoFont(id: string): void { setPref('fontMono', choose(MONO_FONTS, id).id); applyFonts(); }
