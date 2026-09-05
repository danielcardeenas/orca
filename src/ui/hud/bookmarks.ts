/**
 * Camera bookmarks and the way back (IDEAS B1 + B2).
 *
 * A fleet of a thousand agents is a landscape, and nobody walks a landscape
 * twice by hand. Nine slots hold a view — a point on the plane plus the
 * distance the camera was at — and one key flies to it. Every flight first
 * pushes where you were, so `back()` undoes navigation the way an editor
 * undoes typing: `/find K9` stops being a one-way ticket.
 *
 * Wiring (main.ts owns the keys and the calls):
 *
 *   const marks = mountBookmarks(hudEl, c);
 *   // keys: Shift+1…9 → marks.save(n) · 1…9 → marks.go(n) · Backspace → marks.back()
 *   // before every camera flight the operator did not ask to be undone:
 *   marks.push();  field.flyTo(id);
 *
 * `go()` pushes on its own, so the wiring never has to remember to.
 * Flying carries no animation of its own: the flight *is* the animation, and
 * the camera already eases it. Saving does, because nothing else moves when
 * you save — the slot cuts to lime with one frame of ink in front of it
 * (IDENTITY §6.3), the same beat a tile makes when its state changes.
 */

import type { Console } from '../console.ts';
import { getSound } from './sound.ts';
import { REDUCE } from '../motion.ts';
import { FOV } from '../field/camera.ts';

/** A camera view, in world units. `d` is the camera distance to the plane. */
export interface Mark { x: number; y: number; d: number }

export interface BookmarksHandle {
  /** The instrument, already in the host. Exposed so main.ts can move it. */
  el: HTMLElement;
  /** Store the current view in slot 1…9. Persists immediately. */
  save(slot: number): void;
  /** Fly to slot 1…9. Pushes the current view first. False if the slot is empty. */
  go(slot: number): boolean;
  /** Remember where we are, so `back()` can return. Call before any flight. */
  push(): void;
  /** Undo the last push. False when the history is empty. */
  back(): boolean;
  /** Whether slot 1…9 holds a view. */
  has(slot: number): boolean;
  /** How many views the history holds. */
  depth(): number;
  dispose(): void;
}

const KEY = 'orca.bookmarks.v1';
const SLOTS = 9;
/** Deep enough to undo a hunt, shallow enough to never be a list. */
const HISTORY_MAX = 30;
/** Two views closer than this are the same view; do not stack them. */
const SAME = 0.5;

export function mountBookmarks(host: HTMLElement, c: Console): BookmarksHandle {
  const el = document.createElement('div');
  el.className = 'bmarks';
  el.innerHTML = `
    <button class="bmarks__back" type="button" data-back title="BACK · BACKSPACE" disabled>&#8592;</button>
    <div class="bmarks__row">${Array.from({ length: SLOTS }, (_, i) =>
      `<button class="bmarks__c" type="button" data-slot="${i + 1}" title="${i + 1} FLY · SHIFT+${i + 1} SAVE">${i + 1}</button>`,
    ).join('')}</div>`;
  host.appendChild(el);
  const backEl = el.querySelector<HTMLButtonElement>('[data-back]')!;
  const cells = Array.from(el.querySelectorAll<HTMLButtonElement>('[data-slot]'));

  const marks = load();
  const history: Mark[] = [];

  /* ── The current view ───────────────────────────────────────────── */

  /**
   * Where the camera is, read back from what it covers.
   *
   * The field hands out `viewRect()` and nothing else, so the distance is
   * reconstructed from the rectangle's width and the fixed FOV — the same
   * inversion `hud/minimap.ts` does to keep the zoom while dragging.
   */
  function current(): Mark {
    const v = c.field.viewRect();
    const aspect = Math.max(0.2, window.innerWidth / Math.max(1, window.innerHeight));
    const w = Math.max(0.001, v.maxX - v.minX);
    return {
      x: (v.minX + v.maxX) / 2,
      y: (v.minY + v.maxY) / 2,
      d: Math.max(1.4, w / (2 * Math.tan((FOV * Math.PI) / 360) * aspect)),
    };
  }

  const near = (a: Mark, b: Mark) =>
    Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.d - b.d) < SAME;

  /* ── Persistence ────────────────────────────────────────────────── */

  function load(): (Mark | null)[] {
    const empty = Array.from({ length: SLOTS }, () => null as Mark | null);
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return empty;
      const list = JSON.parse(raw) as unknown;
      if (!Array.isArray(list)) return empty;
      return empty.map((_, i) => {
        const m = list[i] as Mark | null;
        return m && Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.d) ? m : null;
      });
    } catch { return empty; }
  }
  function persist() {
    // Private mode just means the marks live for this tab. Never a throw.
    try { localStorage.setItem(KEY, JSON.stringify(marks)); } catch { /* ignore */ }
  }

  /* ── Paint ──────────────────────────────────────────────────────── */

  function render() {
    cells.forEach((cell, i) => cell.classList.toggle('is-on', !!marks[i]));
    backEl.disabled = history.length === 0;
  }

  /** The heartbeat, at slot scale: ink for one frame, then the lime of `is-on`. */
  function beat(cell: HTMLElement | undefined) {
    if (!cell || REDUCE.value) return;
    cell.classList.add('is-hit');
    requestAnimationFrame(() => cell.classList.remove('is-hit'));
  }

  /* ── Interaction ────────────────────────────────────────────────── */

  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-slot],[data-back]');
    if (!b) return;
    if (b.hasAttribute('data-back')) { api.back(); return; }
    const slot = Number(b.dataset.slot);
    // Shift is the save gesture everywhere here: the same modifier as the key.
    if (e.shiftKey) api.save(slot); else api.go(slot);
  });

  const api: BookmarksHandle = {
    el,
    save(slot) {
      if (slot < 1 || slot > SLOTS) return;
      marks[slot - 1] = current();
      persist();
      render();
      beat(cells[slot - 1]);
      getSound()?.play('bookmark.save');
      c.note(`bookmark ${slot} set`);
    },
    go(slot) {
      if (slot < 1 || slot > SLOTS) return false;
      const m = marks[slot - 1];
      if (!m) return false;
      api.push();
      c.field.flyToPoint(m.x, m.y, m.d);
      getSound()?.play('bookmark.go');
      return true;
    },
    push() {
      const now = current();
      const top = history[history.length - 1];
      if (top && near(top, now)) return; // no stack of identical views
      history.push(now);
      if (history.length > HISTORY_MAX) history.shift();
      render();
    },
    back() {
      const m = history.pop();
      render();
      if (!m) return false;
      c.field.flyToPoint(m.x, m.y, m.d);
      getSound()?.play('back');
      return true;
    },
    has: (slot) => slot >= 1 && slot <= SLOTS && !!marks[slot - 1],
    depth: () => history.length,
    dispose() { el.remove(); },
  };

  render();
  return api;
}
