/**
 * The window manager.
 *
 * A window is a small instrument in the comp's HUD shell. It is either
 * anchored to an agent — it follows the tile as the camera moves and draws a
 * pipe to it — or docked to the screen. Drag the header to move it, the
 * corner to resize it, `—` to fold it into the tray, `×` to close it.
 *
 * Kinds register a mount function; the manager only knows chrome, geometry,
 * focus and persistence. Docked windows come back on reload; anchored ones
 * do not, because the agent they were anchored to may not.
 *
 * ── The contract with the rest of the console ──────────────────────────
 *
 * **With a window active, the window owns the keyboard.** `main.ts` calls
 * `if (wm.handleKey(e)) return;` as the first line of its global keydown, so
 * the field's letters (F O D G T C Q L N M S 1…9 Backspace /) only reach the
 * field when no window is focused. `main.ts` also carries the other half of
 * that story on the glass: `document.body.classList.toggle('has-window', …)`
 * from `onFocus`, which dims the mast's own `<kbd>` (see `hud.css`).
 *
 *   handleKey(e: KeyboardEvent): boolean
 *     True when the active window ate the key. Never fires while the focus
 *     is in an input, textarea or select — Enter already means "send" there,
 *     and a primary slab must not send the same line twice.
 *
 *   stack(): Win[]              open windows, active first, z descending
 *   cycle(dir: 1 | -1): Win|null  next/previous in the stack, folded skipped
 *   trayList(): Win[]           the folded ones, as before
 *   trayRow(): Win[]            what the tray paints: open, then folded
 *   trayMode(): boolean         is the row holding the keyboard
 *   enterTrayMode() / exitTrayMode()
 *   toggleWindow(win)           folded → unfold · behind → raise · in front → close
 *   toggleKey(key, open)        the same switch by key, for the mast
 *   trayCursorId(): string|null the window under the tray cursor
 *   kbdLabel(spec): string      (module export) a chord in the platform's hand
 *
 *   WmEvents.onStack(list)      every open/close/focus/minimize/restore
 *   WmEvents.onReveal(agentId)  the operator asked to see an off-screen tile;
 *                               main answers `c.pushView(); field.frameAround(id)`
 *
 * **Chords.** `data-key` speaks whole chords — `s`, `1`, `enter`, `meta+k`,
 * `alt+c`, `alt+shift+1` — and the dispatcher matches the modifiers exactly:
 * a bare letter never fires while ⌘/⌥/⌃ are down, and a chord never fires
 * without its modifier, so the console's own ⌘K and ⌥-letters pass straight
 * through to `main.ts`. Bases are read off `e.code` when the layout mangles
 * `e.key` (⌥C is `ç` on macOS, ⇧1 is `!`).
 *
 * **Tray mode.** `` ` `` gives the tray row the keyboard instead of cycling
 * blind: the row lifts, a lime cursor lands on the active window, and
 * `←/→` (or `H/L`), `Home/End` and `1…9` walk it, `Enter` throws the switch
 * and leaves, `-` folds or unfolds under the cursor, `Backspace`/`Delete`/`x`
 * closes it, `v` reveals an anchored one, `Escape` leaves. `` ` `` again
 * inside the mode is the fast path: it raises as it walks. While the mode is
 * on, every one of those keys is consumed — `main.ts` never sees them.
 *
 * `Enter` is `toggleWindow`, so on the window already in front it closes
 * rather than re-raising, and the row stays open to keep going. `` ` `` puts
 * the cursor on what it raised, so `Escape` — not `Enter` — is how you keep
 * what you just cycled to.
 *
 * **Every button says its key.** A kind writes `data-key="s"` (a space-separated
 * list is allowed, and `shift+x` for a modified one); the manager injects the
 * `<kbd>` itself, on mount and after every rewrite of the body, so no kind
 * ever types a keycap by hand. `data-key-label` overrides the cap. When more
 * than one button in a window answers the same key — the gallery's PLACE, one
 * per thumbnail — the one under the cursor or holding the focus wins.
 *
 * The assignment, from PLAN §12:
 *
 *   agent      S say · F fly · L logs · C spawn child · X stop (armed, twice)
 *   interrupt  1…9 options · Enter send · O open agent · D dismiss
 *   fleet      A say all · L say lead · F frame · N spawn here · X stop all
 *   capcom     Enter send · 1…5 orders
 *   spawn      Enter spawn
 *   launch     Enter launch · E edit presets
 *   artifact   P place/remove · R raw
 *   gallery    P on the thumbnail under the hand
 *   timeline   L live · ←/→ one step (the scrubber's own listener)
 *   music      A add
 *   sfx        S save preset · R reset · M mute
 *
 * Single letters stay single inside a window: they are bounded to whichever
 * window is active, so nothing global has to give way for them.
 *
 * Universal, with a window active: `Esc` closes, `-` folds (and hands the
 * keyboard down the stack), `v` reveals an anchored window's tile when it is
 * off screen, and `` ` `` opens tray mode.
 *
 * ── Every moment has a gesture (IDENTITY §6.1) ──────────────────────────
 *
 * The manager owns the ones that belong to the housing; `fx.ts` owns the
 * shapes and `window.css` owns the palettes, which cut. Nothing here fades.
 *
 *   open     `back.out(2)` from the point that opened it, scale 0.86→1 and no
 *            fade · the anchor pipe traces itself from the tile · the header
 *            callsign assembles out of scrambled glyphs (A2) · the body's
 *            sections cascade in by cut (A1). Only the first paint cascades.
 *   close    the short collapse (A12) — body under the edge, housing to a 2px
 *            bar, cut — while the anchor pipe drains back to the tile. The
 *            answered / done / dead exits stay `closeWith`'s wipe and check.
 *   focus    `.win__head::after` grows left to right in `T.snap`; blur cuts.
 *   fold     the housing flies into its tray tile and cuts; unfold arrives
 *            back out of it.
 *   pin      the button cuts to lime; the pipe traces (pin) or drains (unpin).
 *   tele     the hex scrambles at 70ms only while its agent is `working` (A9).
 *   state    the housing's state channel flashes `--ink-bright` for a frame
 *            and falls to the new colour in `T.snap`. Red does not animate.
 *   drag     direct, never tweened: chrome that lags the hand feels broken.
 *
 * **`win.anchorFill`** (0…1) is how far the pipe to the tile has been drawn.
 * `reproject` cuts the tether's polyline at that fraction of its length, so
 * the same scalar traces it on open and drains it on close, and the field can
 * read it if it ever wants to draw the same pipe in world space.
 */

import gsap from 'gsap';
import { esc, hexNoise } from '../util.ts';
import { dur, EASE, REDUCE, T } from '../motion.ts';
import { getSound } from '../hud/sound.ts';
import {
  assemble, cascade, check, collapse, collapseShort, echoKbd, foldTo, stopAssemble, unfoldFrom, wipe,
} from './fx.ts';

export type WinKind =
  | 'agent' | 'interrupt' | 'queue' | 'ceo' | 'feed' | 'fleet' | 'spawn' | 'artifact' | 'breach' | 'help' | 'settings'
  | 'gallery' | 'launch' | 'timeline' | 'sfx' | 'music';

export interface WinSpec {
  kind: WinKind;
  /** Stable identity: the same key reuses the window instead of opening twice. */
  key: string;
  /** Header. */
  callsign?: string;
  project?: string;
  title?: string;
  /** Agent this window follows, if any. */
  anchor?: string | null;
  /** Initial geometry, screen px. `at` is the point it opens from. */
  at?: { x: number; y: number };
  w?: number; h?: number;
  /** Extra params for the kind. */
  params?: Record<string, string>;
  /** Do not persist across reloads. */
  ephemeral?: boolean;
}

export interface WinCtx {
  win: Win;
  body: HTMLElement;
  setTitle(t: string): void;
  setCallsign(cs: string, project?: string): void;
  setState(cls: 'blocked' | 'dead' | 'breach' | null, stateVar?: string): void;
  close(): void;
}

export interface KindMount {
  (ctx: WinCtx): { dispose?(): void; update?(): void; start?(): void; state?(): unknown } | void;
}

export interface Win {
  id: string;
  spec: WinSpec;
  el: HTMLElement;
  body: HTMLElement;
  x: number; y: number; w: number; h: number;
  /** Offset from the anchor tile's top-right, when anchored. */
  ax: number; ay: number;
  z: number;
  minimized: boolean;
  focused: boolean;
  stateVar: string | null;
  /**
   * How much of the pipe to the anchor tile is drawn, 0…1. It traces on open
   * and on PIN, drains on close and on unpin, and `reproject` cuts the
   * tether's polyline at this fraction of its total length. A docked window
   * keeps it at 1 and never uses it.
   */
  anchorFill: number;
  inst: { dispose?(): void; update?(): void; start?(): void; state?(): unknown } | void;
}

export interface WmEvents {
  /** Screen rect of a tile, for anchoring. */
  tileRect(agentId: string): { x: number; y: number; w: number; h: number; visible: boolean } | null;
  onTray(list: Win[]): void;
  onFocus(win: Win | null): void;
  /**
   * The stack changed: opened, closed, focused, folded or restored. The list
   * is the open windows, active first. Optional so the console can be wired
   * one piece at a time; the tray is redrawn through `onTray` either way.
   */
  onStack?(list: Win[]): void;
  /**
   * The operator asked to see a tile that wandered off screen — the edge
   * indicator, `v` on an anchored window, or cycling into one. The console
   * answers with `pushView()` and `field.frameAround(agentId)`, so Backspace
   * comes back.
   */
  onReveal?(agentId: string): void;
  /**
   * Right click on a window's chrome — header, footer, any part of the body
   * nothing else claimed. The console answers with the window's menu.
   */
  onContext?(win: Win, x: number, y: number): void;
}

const MOBILE = () => matchMedia('(max-width: 720px)').matches;
const KEY = 'orca.windows.v2';
/** A9: the comp's scrambling column re-randomises every 70ms. */
const TELE_MS = 70;
/** The dock — command line, hints, tray — owns the bottom band; windows stay above it. */
const DOCK_H = 100;

export class WindowManager {
  private layer: HTMLElement;
  private tether: SVGSVGElement;
  private wins = new Map<string, Win>();
  private byKey = new Map<string, Win>();
  private kinds = new Map<WinKind, KindMount>();
  private zTop = 10;
  private ev: WmEvents;
  /** One body-watcher per window, so a rewritten body gets its keycaps back. */
  private watchers = new Map<string, () => void>();
  /** The rotation `` ` `` is walking, frozen so raising z does not shuffle it. */
  private cycleSeq: string[] | null = null;
  private cycling = false;
  /** Tray mode: the row has the keyboard. */
  private inTray = false;
  /** The window the tray cursor sits on. */
  private cursor: string | null = null;
  /**
   * Windows that have left the stack but whose anchor pipe is still draining.
   * They are out of `wins` the instant they close — every count, every key and
   * every tray row is right immediately — and `reproject` keeps drawing their
   * pipe from their last geometry until the drain lands.
   */
  private ghosts = new Set<Win>();
  /** One telemetry ticker per window, cleared on close. */
  private teles = new Map<string, number>();
  /** True while `restoreSession` is rebuilding: a reload is not a gesture. */
  private reviving = false;

  constructor(host: HTMLElement, ev: WmEvents) {
    this.ev = ev;
    this.layer = document.createElement('div');
    this.layer.className = 'wm';
    this.tether = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.tether.setAttribute('class', 'tether');
    this.layer.appendChild(this.tether);
    host.appendChild(this.layer);
  }

  register(kind: WinKind, mount: KindMount) { this.kinds.set(kind, mount); }

  /** Open, or focus if a window with this key is already open. */
  open(spec: WinSpec): Win {
    const existing = this.byKey.get(spec.key);
    if (existing) {
      if (existing.minimized) this.restore(existing);
      this.focus(existing);
      return existing;
    }
    const mount = this.kinds.get(spec.kind);
    if (!mount) throw new Error(`no window kind ${spec.kind}`);

    const el = document.createElement('section');
    el.className = `win is-${spec.kind}`;
    el.dataset.kind = spec.kind;
    el.innerHTML = chrome(spec);
    const body = el.querySelector<HTMLElement>('.win__body')!;
    const id = `w${(this.zTop++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    const w = spec.w ?? defaultSize(spec.kind).w;
    const h = spec.h ?? defaultSize(spec.kind).h;
    const win: Win = {
      id, spec, el, body, w, h, x: 0, y: 0, ax: 18, ay: -8, z: ++this.zTop,
      minimized: false, focused: false, stateVar: null,
      // An anchored window draws its pipe as it arrives; a docked one has none.
      anchorFill: spec.anchor && !REDUCE.value ? 0 : 1,
      inst: undefined,
    };
    this.place(win);
    this.layer.appendChild(el);
    this.wins.set(id, win);
    this.byKey.set(spec.key, win);
    this.wire(win);

    const ctx: WinCtx = {
      win, body,
      setTitle: (t) => { const n = el.querySelector('.win__title'); if (n) n.textContent = t; },
      setCallsign: (cs, project) => {
        const c = el.querySelector<HTMLElement>('.win__cs');
        // A live rewrite outranks an assembly still in flight: the callsign a
        // kind just derived is the true one, and A2 is only the arrival.
        if (c) { stopAssemble(c); c.textContent = cs; }
        const p = el.querySelector('.win__pj'); if (p) p.textContent = project ?? '';
      },
      setState: (cls, stateVar) => {
        el.classList.toggle('is-blocked', cls === 'blocked');
        el.classList.toggle('is-dead', cls === 'dead');
        el.classList.toggle('is-breach', cls === 'breach');
        const was = win.stateVar;
        win.stateVar = stateVar ?? null;
        el.style.setProperty('--win-state', stateVar ?? 'var(--line)');
        if (was && stateVar && was !== stateVar) this.flashState(win, stateVar);
      },
      close: () => this.close(win),
    };
    win.inst = mount(ctx);
    this.watchBody(win);
    this.paintKeys(win);
    this.focus(win);
    this.arrive(win, spec.at);
    // A2: the header's identity — the callsign, or the kind when a window has
    // no callsign to carry — assembles out of scrambled glyphs.
    const cs = el.querySelector<HTMLElement>('.win__cs, .win__kind');
    if (cs) assemble(cs, cs.textContent ?? '');
    // A1: the sections of the interior the kind just built, on the comp's beat.
    // Only here — a body a live re-render rewrites must not cascade again.
    cascade(body);
    if (spec.anchor) this.anchorTo(win, 1);
    this.persist();
    return win;
  }

  /**
   * The pipe to the tile draws itself, or drains back into it. One scalar on
   * the window (`anchorFill`), tweened here and read by `reproject`, so the
   * trace and the drain are the same gesture in two directions.
   */
  private anchorTo(win: Win, to: 0 | 1): void {
    if (REDUCE.value) { win.anchorFill = to; return; }
    gsap.killTweensOf(win);
    gsap.to(win, { anchorFill: to, duration: dur(T.quick), ease: EASE.inout, overwrite: true });
  }

  /**
   * The tile's heartbeat, on the housing: the state channel jumps to
   * `--ink-bright` for a frame and falls to the new colour in `T.snap`.
   * A window turning red never flashes — red does not animate.
   */
  private flashState(win: Win, next: string): void {
    if (REDUCE.value || next === 'var(--st-dead)') return;
    const el = win.el;
    el.classList.add('is-flash');
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('is-flash')));
  }

  close(win: Win) {
    if (!this.wins.has(win.id)) return;
    // The bookkeeping is synchronous — the stack, the tray row and the key
    // dispatcher are right on the next line — and only the pixels linger.
    const gesture = !win.el.dataset.fxClosing;
    if (gesture) getSound()?.play('close');
    win.inst?.dispose?.();
    this.watchers.get(win.id)?.();
    this.watchers.delete(win.id);
    clearInterval(this.teles.get(win.id));
    this.teles.delete(win.id);
    if (gesture) this.leave(win); else win.el.remove();
    this.wins.delete(win.id);
    this.byKey.delete(win.spec.key);
    if (win.focused) this.ev.onFocus(null);
    this.persist();
    // The row cannot have a cursor with nothing under it, and an empty row is
    // not a mode: the last window out turns the lights off.
    if (this.inTray && this.cursor === win.id) this.cursor = this.trayRow()[0]?.id ?? null;
    if (!this.wins.size) this.exitTrayMode();
    // `emitStack` redraws the tray, so a folded window that closed leaves it.
    this.emitStack();
  }

  /**
   * Close a window through one of the comp's confirmations instead of dropping
   * it. The window stops taking input the moment the gesture starts, and a
   * second call while one is running is ignored — answering an interrupt twice
   * must not restart the sweep.
   *
   * `wipe` confirms (an interrupt answered), `check` congratulates (an agent
   * done), `collapse` is how any lime panel leaves.
   */
  async closeWith(win: Win, fx: 'wipe' | 'check' | 'collapse'): Promise<void> {
    getSound()?.play(fx === 'wipe' ? 'wipe' : fx === 'check' ? 'check' : 'close');
    if (!this.wins.has(win.id)) return;
    if (win.el.dataset.fxClosing) return;
    win.el.dataset.fxClosing = fx;
    win.el.style.pointerEvents = 'none';
    try {
      if (fx === 'wipe') await wipe(win.el);
      else if (fx === 'check') await check(win.el);
      else await collapse(win.el);
    } catch { /* a broken flourish must never strand a window on screen */ }
    this.close(win);
  }

  /**
   * The ordinary exit (§6.1): the short A12 collapse while the anchor pipe
   * drains back into the tile, then the housing is gone. The window stops
   * taking input the moment it starts — it has already left the stack.
   */
  private leave(win: Win): void {
    win.el.style.pointerEvents = 'none';
    // It is out of the stack, so it must not go on wearing the stack's marks.
    win.el.classList.remove('is-focus');
    // An arrival still in flight would clear the collapse's own transform when
    // it landed. Whatever was moving this housing, the exit outranks it.
    gsap.killTweensOf(win.el);
    if (REDUCE.value) { win.el.remove(); return; }
    if (win.spec.anchor) {
      // A ghost so the pipe can drain from a window that is already gone.
      this.ghosts.add(win);
      gsap.killTweensOf(win);
      gsap.to(win, {
        anchorFill: 0, duration: dur(T.quick), ease: EASE.inout, overwrite: true,
        onComplete: () => this.ghosts.delete(win),
      });
    }
    void collapseShort(win.el)
      .catch(() => { /* a broken flourish must never strand a window on screen */ })
      .then(() => { win.el.remove(); this.ghosts.delete(win); });
  }

  closeKey(key: string) { const w = this.byKey.get(key); if (w) this.close(w); }
  get(key: string): Win | undefined { return this.byKey.get(key); }
  all(): Win[] { return [...this.wins.values()]; }

  focus(win: Win) {
    // A window that has already gone is not a focus target: the tray and the
    // stack both hand out references that a close can outrun.
    if (!win || !this.wins.has(win.id)) return;
    // A hand reaching for a window ends whatever rotation `` ` `` was walking.
    if (!this.cycling) this.cycleSeq = null;
    for (const w of this.wins.values()) { w.focused = false; w.el.classList.remove('is-focus'); }
    win.focused = true;
    win.z = ++this.zTop;
    win.el.style.zIndex = String(win.z);
    win.el.classList.add('is-focus');
    this.ev.onFocus(win);
    this.emitStack();
  }

  focused(): Win | null { for (const w of this.wins.values()) if (w.focused && !w.minimized) return w; return null; }

  /**
   * Where a folded window lives on the glass: its own tile in the tray. The
   * tray has not been redrawn yet when a window folds, so the tile found here
   * is the open one it is about to become — the same place, either way. With
   * no tile at all (the first fold of the session) the housing goes to the
   * bottom-left corner, which is where the row will grow from.
   */
  private trayRect(win: Win): { x: number; y: number; w: number; h: number } {
    const tile = document.querySelector<HTMLElement>(`.tray [data-w="${CSS.escape(win.id)}"]`);
    if (tile) {
      const r = tile.getBoundingClientRect();
      if (r.width && r.height) return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    return { x: 24, y: window.innerHeight - 62, w: 58, h: 44 };
  }

  minimize(win: Win) {
    getSound()?.play('fold');
    const had = win.focused;
    win.minimized = true;
    win.el.classList.remove('is-focus');
    win.focused = false;
    // The housing flies into its tile and cuts. `is-min` — which is
    // `display: none` — waits for the flight, or the flight has nothing left
    // to move. A window that was folded when the session ended never unfolds
    // in the first place, so it has nothing to fly from.
    if (this.reviving || MOBILE()) win.el.classList.add('is-min');
    else {
      const to = this.trayRect(win);
      void foldTo(win.el, to).then(() => { if (win.minimized) win.el.classList.add('is-min'); });
    }
    // Folding the active one hands the keyboard down the stack, not back to
    // the field: `-` `-` `-` puts a stack away one window at a time.
    const next = had ? this.stack()[0] : null;
    if (next) this.focus(next);
    else if (had) this.ev.onFocus(null);
    this.persist();
    this.emitStack();
  }
  restore(win: Win) {
    getSound()?.play('unfold');
    // Read the tile before the stack moves it: it is where the window comes
    // from, and `focus` redraws the row underneath us.
    const from = this.trayRect(win);
    win.minimized = false;
    win.el.classList.remove('is-min');
    this.focus(win);
    if (!MOBILE()) unfoldFrom(win.el, from);
    this.persist();
  }
  trayList(): Win[] { return [...this.wins.values()].filter((w) => w.minimized); }

  /* ── One gesture, three answers ─────────────────────────────────── */

  /**
   * A window is a switch, and the tray tile, the mast button and `Enter` in
   * tray mode are all the same switch: folded unfolds, open-but-behind comes
   * forward, and the one already in front — the one you are looking at, with
   * the keyboard — closes. Pressing the same thing twice puts it away.
   */
  toggleWindow(win: Win): void {
    if (!this.wins.has(win.id)) return;
    if (win.minimized) this.restore(win);
    else if (win.focused) this.close(win);
    else this.focus(win);
  }

  /**
   * The same switch, for anything that knows a window only by its key — the
   * mast's instruments. Nothing open yet: `open()` is called, and it is the
   * caller's job to open with that same key.
   *
   *   mast: () => wm.toggleKey('ceo', () => c.openCeo())
   */
  toggleKey(key: string, open: () => void): void {
    const w = this.byKey.get(key);
    if (!w) { open(); return; }
    this.toggleWindow(w);
  }

  /* ── The stack ──────────────────────────────────────────────────── */

  /**
   * The open windows, active first and down by z. Folded ones are not in it —
   * they are the tray's other half, and `cycle` steps over them.
   */
  stack(): Win[] {
    return [...this.wins.values()].filter((w) => !w.minimized).sort((a, b) => b.z - a.z);
  }

  /**
   * Walk the stack. The order is frozen the moment the rotation starts, so
   * holding `` ` `` goes all the way round instead of flipping between the top
   * two; any other way of focusing a window ends the rotation.
   *
   * Landing on an anchored window whose tile is off screen reveals the tile:
   * arriving somewhere you cannot see is arriving nowhere.
   */
  cycle(dir: 1 | -1 = 1): Win | null {
    const list = this.stack();
    if (!list.length) return null;
    if (!this.cycleSeq) this.cycleSeq = list.map((w) => w.id);
    else {
      this.cycleSeq = this.cycleSeq.filter((id) => list.some((w) => w.id === id));
      for (const w of list) if (!this.cycleSeq.includes(w.id)) this.cycleSeq.push(w.id);
    }
    const seq = this.cycleSeq;
    if (!seq.length) return null;
    const cur = list.find((w) => w.focused);
    const i = Math.max(0, cur ? seq.indexOf(cur.id) : 0);
    const next = this.wins.get(seq[(i + (dir > 0 ? 1 : seq.length - 1)) % seq.length]!);
    if (!next) return null;
    this.cycling = true;
    try { this.focus(next); } finally { this.cycling = false; }
    if (next.spec.anchor && this.offView(next.spec.anchor)) this.ev.onReveal?.(next.spec.anchor);
    return next;
  }

  private emitStack() { this.ev.onStack?.(this.stack()); this.ev.onTray(this.trayList()); }

  /* ── Tray mode: the stack under the keyboard ────────────────────── */

  /**
   * The row the tray paints, left to right: the open windows active-first,
   * then the folded ones. The cursor of tray mode walks this, and the `1…9`
   * caps are its indices.
   */
  trayRow(): Win[] { return [...this.stack(), ...this.trayList()]; }

  trayMode(): boolean { return this.inTray; }
  /** The window the tray cursor is on, or null when the mode is off. */
  trayCursorId(): string | null { return this.inTray ? this.cursor : null; }

  /** Open the row for the keyboard. The cursor starts on the active window. */
  enterTrayMode(): void {
    const row = this.trayRow();
    if (!row.length || this.inTray) return;
    this.inTray = true;
    this.cursor = (row.find((w) => w.focused) ?? row[0]!).id;
    document.body.classList.add('tray-mode');
    this.blip();
    this.emitStack();
  }

  exitTrayMode(): void {
    if (!this.inTray) return;
    this.inTray = false;
    this.cursor = null;
    document.body.classList.remove('tray-mode');
    this.emitStack();
  }

  private cursorWin(): Win | null { return this.cursor ? this.wins.get(this.cursor) ?? null : null; }

  private setCursor(id: string | null) {
    if (id === null) { this.exitTrayMode(); return; }
    if (this.cursor === id) return;
    this.cursor = id;
    this.blip();
    this.emitStack();
  }

  /** Moving the cursor is one tick, not a burst: keys repeat faster than ears. */
  private blipAt = 0;
  private blip() {
    const now = performance.now();
    if (now - this.blipAt < 70) return;
    this.blipAt = now;
    getSound()?.play('select');
  }

  private moveCursor(delta: number) {
    const row = this.trayRow();
    if (!row.length) { this.exitTrayMode(); return; }
    const at = row.findIndex((w) => w.id === this.cursor);
    const i = at < 0 ? 0 : (at + delta + row.length) % row.length;
    this.setCursor(row[i]!.id);
  }

  /**
   * The row's own keys, while the mode is on. Everything listed is consumed —
   * `main.ts` must not also see it — and anything else falls through to the
   * active window, so `S` still says and `F` still flies.
   */
  private trayKey(e: KeyboardEvent, tok: string): boolean {
    const row = this.trayRow();
    if (!row.length) { this.exitTrayMode(); return false; }
    const win = this.cursorWin();
    const eat = () => { e.preventDefault(); return true; };

    if (/^[1-9]$/.test(tok)) {
      const w = row[Number(tok) - 1];
      if (w) this.setCursor(w.id);
      return eat();
    }
    switch (tok) {
      case 'escape': this.exitTrayMode(); return eat();
      case 'arrowleft': case 'h': this.moveCursor(-1); return eat();
      case 'arrowright': case 'l': this.moveCursor(1); return eat();
      case 'home': this.setCursor(row[0]!.id); return eat();
      case 'end': this.setCursor(row[row.length - 1]!.id); return eat();
      case '`': this.syncCursor(this.cycle(1)); return eat();
      case 'shift+`': case 'shift+~': case '~': this.syncCursor(this.cycle(-1)); return eat();
      case 'enter': {
        if (!win) { this.exitTrayMode(); return eat(); }
        // The same switch the tile is: the one already in front closes, and
        // there is nothing to leave the row for, so the row stays open.
        if (!win.minimized && win.focused) {
          const at = row.findIndex((w) => w.id === win.id);
          this.close(win);
          const left = this.trayRow();
          if (!left.length) { this.exitTrayMode(); return eat(); }
          this.cursor = left[Math.min(at, left.length - 1)]!.id;
          this.emitStack();
          return eat();
        }
        this.toggleWindow(win);
        this.exitTrayMode();
        return eat();
      }
      case '-': case 'shift+_': case '_':
        // Fold or unfold under the cursor and stay: putting a stack away is
        // one gesture, not one gesture per window.
        if (win) {
          if (win.minimized) this.restore(win); else this.minimize(win);
          this.cursor = win.id;
          this.emitStack();
        }
        return eat();
      case 'backspace': case 'delete': case 'x': {
        if (!win) return eat();
        const at = row.findIndex((w) => w.id === win.id);
        // Closing never flies the camera: the tile of an anchored window that
        // is off screen stays off screen, because you asked it to go away.
        this.close(win);
        const left = this.trayRow();
        if (!left.length) { this.exitTrayMode(); return eat(); }
        this.cursor = left[Math.min(at, left.length - 1)]!.id;
        this.emitStack();
        return eat();
      }
      case 'v':
        if (win?.spec.anchor) this.ev.onReveal?.(win.spec.anchor);
        return eat();
      default: return false;
    }
  }

  /** `` ` `` raises as it walks, so the cursor follows what it raised. */
  private syncCursor(w: Win | null) {
    if (!w) return;
    this.cursor = w.id;
    this.blip();
    this.emitStack();
  }

  /* ── The keyboard ───────────────────────────────────────────────── */

  /**
   * The console's answer to a key. `main.ts` calls this first; `true` means
   * a window — or the tray row — ate it and the field must not also act.
   *
   * A chord is matched whole: a bare letter does not fire while ⌘/⌥/⌃ are
   * down, and a chord does not fire without its modifier, so the console's
   * own ⌘K and ⌥-letters pass straight through to `main.ts`.
   */
  handleKey(e: KeyboardEvent): boolean {
    if (e.defaultPrevented) return false;
    const t = e.target as HTMLElement | null;
    // Enter is already "send" inside a field. Never send the same line twice.
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
    const tok = keyToken(e);
    if (!tok) return false;

    if (this.inTray && this.trayKey(e, tok)) return true;

    // `` ` `` opens the row even when the keyboard was on the field.
    if ((tok === '`' || tok === 'shift+`' || tok === '~' || tok === 'shift+~') && this.wins.size) {
      e.preventDefault();
      this.enterTrayMode();
      return true;
    }

    const win = this.focused();
    if (!win) return false;

    const hit = this.findKey(win, tok);
    if (hit) {
      e.preventDefault();
      // The keyboard echo: the cap of the chord that fired cuts to lime and
      // falls back, so a key proves it landed on the button it promised.
      echoKbd(hit.querySelector<HTMLElement>(':scope > kbd.key'));
      hit.click();
      return true;
    }

    switch (tok) {
      case 'escape': e.preventDefault(); this.close(win); return true;
      case '-': case 'shift+_': case '_': e.preventDefault(); this.minimize(win); return true;
      case 'v':
        if (win.spec.anchor) { e.preventDefault(); this.ev.onReveal?.(win.spec.anchor); return true; }
        return false;
      default: return false;
    }
  }

  /**
   * The button this key belongs to. When several answer the same key — the
   * gallery's PLACE, one per thumbnail — the one under the cursor or holding
   * the focus wins; otherwise the first in the document.
   */
  private findKey(win: Win, tok: string): HTMLElement | null {
    const hits: HTMLElement[] = [];
    for (const n of win.el.querySelectorAll<HTMLElement>('[data-key]')) {
      if ((n as HTMLButtonElement).disabled || n.hasAttribute('disabled')) continue;
      if (n.hidden || n.classList.contains('is-off') || !n.offsetParent) continue;
      if ((n.dataset.key ?? '').split(/\s+/).some((k) => normKey(k) === tok)) hits.push(n);
    }
    if (!hits.length) return null;
    return hits.find((n) => n.matches(':hover, :focus-within') || !!n.parentElement?.matches(':hover, :focus-within')) ?? hits[0]!;
  }

  /** Give every `data-key` button the keycap it promises. Idempotent. */
  private paintKeys(win: Win) {
    for (const n of win.el.querySelectorAll<HTMLElement>('button[data-key], .slab-btn[data-key]')) {
      const spec = n.dataset.key;
      if (!spec || n.querySelector(':scope > kbd.key')) continue;
      const cap = n.dataset.keyLabel ?? kbdLabel(spec);
      if (!cap) continue;
      const k = document.createElement('kbd');
      k.className = 'key';
      k.textContent = cap;
      n.appendChild(k);
    }
  }

  /**
   * A kind rewrites its body whenever the world moves; the keycaps have to
   * come back with it. Throttled to a frame, and idempotent, so the injection
   * the observer sees does not start another round.
   */
  private watchBody(win: Win) {
    let pending = 0;
    const obs = new MutationObserver(() => {
      if (pending) return;
      pending = requestAnimationFrame(() => { pending = 0; this.paintKeys(win); });
    });
    obs.observe(win.body, { childList: true, subtree: true });
    this.watchers.set(win.id, () => { obs.disconnect(); if (pending) cancelAnimationFrame(pending); });
  }

  private offView(agentId: string): boolean {
    const r = this.ev.tileRect(agentId);
    return !r || !r.visible || outsideViewport(r);
  }

  /** Called every frame: anchored windows follow their tiles. */
  reproject() {
    let paths = '';
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const win of this.wins.values()) {
      if (win.minimized || MOBILE()) continue;
      if (!win.spec.anchor) continue;
      const r = this.ev.tileRect(win.spec.anchor);
      if (!r) { this.showOff(win, null); continue; }
      win.x = r.x + r.w + win.ax;
      win.y = r.y + win.ay;
      // A window whose tile left the screen used to fade to 15% and take its
      // report with it. It stays legible instead: same size, clamped to the
      // edge nearest the tile, with an indicator that says which way to look.
      if (!r.visible || outsideViewport(r)) {
        win.el.style.opacity = '';
        win.x = Math.max(8, Math.min(vw - win.w - 8, win.x));
        win.y = Math.max(44, Math.min(vh - win.h - DOCK_H, win.y));
        this.apply(win);
        this.showOff(win, edgeToward(r, win));
        continue;
      }
      win.el.style.opacity = '';
      this.showOff(win, null);
      this.apply(win);
      paths += this.tetherPath(win, r);
    }
    // A window that has closed keeps its pipe on screen until it has drained
    // back into the tile. Geometry only — the housing is already collapsing.
    for (const g of this.ghosts) {
      const r = g.spec.anchor ? this.ev.tileRect(g.spec.anchor) : null;
      if (r && r.visible && !outsideViewport(r)) paths += this.tetherPath(g, r);
    }
    if (this.tether.innerHTML !== paths) this.tether.innerHTML = paths;
  }

  /**
   * The tether: an orthogonal pipe from the tile's bite to the window, drawn
   * from the tile outward and cut at `anchorFill` of its length. At 1 it is
   * the whole pipe; on the way in and on the way out it is the comp's core
   * filling and draining (§4.2), which is why the trace starts at the tile.
   */
  private tetherPath(win: Win, r: { x: number; y: number; w: number; h: number }): string {
    const fill = Math.max(0, Math.min(1, win.anchorFill));
    if (fill <= 0.001) return '';
    const left = win.x + win.w / 2 < r.x + r.w / 2;
    const x0 = left ? r.x : r.x + r.w, y0 = r.y + r.h / 2;
    const x1 = left ? win.x + win.w : win.x, y1 = win.y + 15;
    const mx = (x0 + x1) / 2;
    const pts = cutPolyline([[x0, y0], [mx, y0], [mx, y1], [x1, y1]], fill);
    const cls = win.el.classList.contains('is-blocked') ? 'is-blocked' : '';
    const stroke = win.stateVar ?? 'var(--line)';
    return `<g class="${cls}"><polyline fill="none" stroke="${stroke}" stroke-width="2" points="${pts}"/>`
      + `<rect x="${x0 - 3}" y="${y0 - 3}" width="6" height="6" fill="${stroke}"/></g>`;
  }

  /**
   * The edge indicator: a square port, a pixel arrow and the callsign, in the
   * window's state colour, stuck to the side the tile is on. Clicking it is
   * the same gesture as `v` — a temporary zoom-out that Backspace undoes.
   */
  private showOff(win: Win, dir: Edge | null) {
    let el = win.el.querySelector<HTMLButtonElement>('.win__off');
    if (!dir) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.title = 'Its tile is off screen · zoom out to it';
      el.innerHTML = '<i class="win__off-arr"></i><i class="win__off-port"></i><span class="win__off-cs"></span>';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (win.spec.anchor) this.ev.onReveal?.(win.spec.anchor);
      });
      win.el.appendChild(el);
    }
    const cls = `win__off is-${dir}`;
    if (el.className !== cls) el.className = cls;
    const cs = win.spec.callsign ?? win.spec.kind.toUpperCase();
    const label = el.querySelector<HTMLElement>('.win__off-cs')!;
    if (label.textContent !== cs) label.textContent = cs;
  }

  update() { for (const w of this.wins.values()) w.inst?.update?.(); }

  /** Reopen the docked windows the operator had last time. */
  restoreSession(open: (spec: WinSpec) => void) {
    this.reviving = true;
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const list = JSON.parse(raw) as Array<{ spec: WinSpec; x: number; y: number; w: number; h: number; minimized: boolean }>;
      for (const s of list) {
        if (!s?.spec?.kind || s.spec.anchor) continue;
        open({ ...s.spec, at: undefined, w: s.w, h: s.h });
        const w = this.byKey.get(s.spec.key);
        if (w) { w.x = s.x; w.y = s.y; this.apply(w); if (s.minimized) this.minimize(w); }
      }
    } catch { /* corrupt or private: start clean */ } finally { this.reviving = false; }
  }

  /* ── Internals ──────────────────────────────────────────────────── */

  private place(win: Win) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const at = win.spec.at;
    if (win.spec.anchor) {
      const r = this.ev.tileRect(win.spec.anchor);
      if (r) {
        // Open on whichever side of the tile has room; the tether adapts.
        if (r.x + r.w + 18 + win.w > vw - 8 && r.x - 18 - win.w > 8) win.ax = -win.w - 18;
        if (r.y + win.h > vh - 64) win.ay = Math.max(-r.y + 44, vh - 64 - win.h - r.y);
        win.x = r.x + r.w + win.ax; win.y = Math.min(r.y + win.ay, window.innerHeight - win.h - DOCK_H);
      } else { win.x = vw / 2 - win.w / 2; win.y = vh / 2 - win.h / 2; }
    } else if (at) {
      win.x = at.x + 14; win.y = at.y - 20;
    } else {
      // Each docked kind has a home, so CEO, QUEUE and FEED never sit on each other.
      const home = dockHome(win.spec.kind, win.w, win.h, vw, vh);
      const n = [...this.wins.values()].filter((w) => !w.spec.anchor && w.spec.kind === win.spec.kind).length;
      win.x = home.x - n * 24;
      win.y = home.y + n * 24;
    }
    this.clampToView(win);
    this.apply(win);
  }

  private clampToView(win: Win) {
    const vw = window.innerWidth, vh = window.innerHeight;
    win.w = Math.min(win.w, vw - 16);
    win.h = Math.min(win.h, vh - 90);
    win.x = Math.max(8, Math.min(vw - win.w - 8, win.x));
    win.y = Math.max(44, Math.min(vh - win.h - DOCK_H, win.y));
  }

  /** Position lives in left/top so GSAP can own `transform` for arrivals. */
  private apply(win: Win) {
    // The one place a position is written, so the dock band is honoured by
    // every path: docked, dragged, anchored, clamped to an edge.
    if (!MOBILE()) win.y = Math.max(44, Math.min(window.innerHeight - win.h - DOCK_H, win.y));
    win.el.style.left = `${Math.round(win.x)}px`;
    win.el.style.top = `${Math.round(win.y)}px`;
    win.el.style.width = `${Math.round(win.w)}px`;
    win.el.style.height = `${Math.round(win.h)}px`;
  }

  /**
   * The housing arrives from the point that opened it — a tile, a tray tile, a
   * command — with the comp's overshoot. No fade: an instrument is either on
   * the glass or it is not, and a palette that ramps is a palette apologising.
   */
  private arrive(win: Win, from?: { x: number; y: number }) {
    if (REDUCE.value) return;
    const ox = from ? from.x - win.x : win.w * 0.1;
    const oy = from ? from.y - win.y : win.h * 0.1;
    gsap.killTweensOf(win.el);
    gsap.fromTo(win.el,
      { scale: 0.86, x: ox * 0.3, y: oy * 0.3 },
      { scale: 1, x: 0, y: 0, duration: dur(T.quick), ease: EASE.arrive, clearProps: 'transform' });
  }

  private wire(win: Win) {
    const el = win.el;
    const head = el.querySelector<HTMLElement>('.win__head')!;
    const grip = el.querySelector<HTMLElement>('.win__grip')!;

    el.addEventListener('pointerdown', () => { if (!win.focused) this.focus(win); }, { capture: true });
    // The chrome's own menu. Text fields and embedded pages keep the browser's;
    // a row inside the body that has its own menu stops the event before here.
    el.addEventListener('contextmenu', (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, iframe, [contenteditable], a[href], pre')) return;
      e.preventDefault();
      this.ev.onContext?.(win, e.clientX, e.clientY);
    });

    el.querySelector('[data-w-close]')!.addEventListener('click', () => this.close(win));
    el.querySelector('[data-w-min]')!.addEventListener('click', () => this.minimize(win));
    const pin = el.querySelector<HTMLElement>('[data-w-pin]');
    if (pin) {
      pin.classList.toggle('is-on', !!win.spec.anchor);
      pin.addEventListener('click', () => {
        // Toggle between following the tile and staying on the glass.
        // The button cuts to lime; the pipe is what eases. Unpinning drains it
        // before the anchor goes, so the last frame of the pipe is the tile.
        if (win.spec.anchor) {
          const gone = win.spec.anchor;
          this.anchorTo(win, 0);
          window.setTimeout(() => {
            if (win.spec.anchor !== gone) return;
            win.spec = { ...win.spec, anchor: null, params: { ...win.spec.params, anchorWas: gone } };
            win.el.style.opacity = '';
            this.persist();
          }, dur(T.quick) * 1000);
          pin.classList.remove('is-on');
        } else if (win.spec.params?.anchorWas || win.spec.params?.agentId) {
          const a = win.spec.params.anchorWas || win.spec.params.agentId!;
          const r = this.ev.tileRect(a);
          if (r) { win.ax = win.x - (r.x + r.w); win.ay = win.y - r.y; }
          win.spec = { ...win.spec, anchor: a };
          pin.classList.add('is-on');
          win.anchorFill = REDUCE.value ? 1 : 0;
          this.anchorTo(win, 1);
        }
        this.persist();
      });
    }

    // Drag by the header.
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    head.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (MOBILE()) return;
      dragging = true;
      head.setPointerCapture(e.pointerId);
      sx = e.clientX; sy = e.clientY; ox = win.x; oy = win.y;
    });
    head.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      win.x = ox + (e.clientX - sx); win.y = oy + (e.clientY - sy);
      if (win.spec.anchor) {
        const r = this.ev.tileRect(win.spec.anchor);
        if (r) { win.ax = win.x - (r.x + r.w); win.ay = win.y - r.y; }
      }
      this.apply(win);
    });
    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      head.releasePointerCapture(e.pointerId);
      this.clampToView(win); this.apply(win); this.persist();
    };
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);
    // No dblclick-to-fold: a window arrives under the cursor that opened it,
    // and the second click of a double-click would fold what the first opened.

    // Resize by the corner.
    let rs = false, rw = 0, rh = 0;
    grip.addEventListener('pointerdown', (e) => {
      rs = true; grip.setPointerCapture(e.pointerId);
      sx = e.clientX; sy = e.clientY; rw = win.w; rh = win.h;
    });
    grip.addEventListener('pointermove', (e) => {
      if (!rs) return;
      win.w = Math.max(240, rw + (e.clientX - sx));
      win.h = Math.max(120, rh + (e.clientY - sy));
      this.apply(win);
    });
    const endRs = (e: PointerEvent) => { if (!rs) return; rs = false; grip.releasePointerCapture(e.pointerId); this.persist(); };
    grip.addEventListener('pointerup', endRs);
    grip.addEventListener('pointercancel', endRs);

    /*
     * A9, the scrambling column, at instrument scale: the hex re-randomises
     * every 70ms — and only while this window's agent is `working`. Frozen in
     * every other state, so the line is a fact and not a decoration: if it
     * moves, that agent has traffic. `stateVar` is the manager's own record of
     * what the kind last reported, which is exactly what the tray reads too.
     */
    const tele = el.querySelector<HTMLElement>('.win__tele');
    if (tele && !REDUCE.value) {
      const t = window.setInterval(() => {
        if (!document.body.contains(el)) { clearInterval(t); return; }
        if (win.stateVar !== 'var(--st-working)') return;
        tele.textContent = hexNoise(3);
      }, TELE_MS);
      this.teles.set(win.id, t);
    }
  }

  private persistTimer = 0;
  private persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      try {
        const list = [...this.wins.values()]
          .filter((w) => !w.spec.anchor && !w.spec.ephemeral)
          .map((w) => ({ spec: { ...w.spec, at: undefined }, x: w.x, y: w.y, w: w.w, h: w.h, minimized: w.minimized }));
        localStorage.setItem(KEY, JSON.stringify(list));
      } catch { /* nothing worth breaking over */ }
    }, 250);
  }
}

/* ── Keys and edges ─────────────────────────────────────────────────── */

type Edge = 'l' | 'r' | 't' | 'b';

/*
 * One alphabet for chords, spoken by `data-key`, by the dispatcher and by the
 * mast. A chord is modifiers then a base, in the canonical order
 * `ctrl+alt+meta+shift+base`, whatever order it was written in:
 *
 *   "s"  "x"  "1"  "enter"  "escape"  "arrowleft"  "-"  "`"
 *   "meta+k"  "alt+c"  "alt+shift+1"  "ctrl+x"
 *
 * Aliases are accepted so a kind can write what it means: cmd/command/super/
 * win → meta, option/opt → alt, control → ctrl, esc → escape, left/right/up/
 * down → arrow*. A space-separated list means any one of them.
 */

const MOD_ALIAS: Record<string, string> = {
  cmd: 'meta', command: 'meta', super: 'meta', win: 'meta', meta: 'meta',
  option: 'alt', opt: 'alt', alt: 'alt',
  control: 'ctrl', ctrl: 'ctrl',
  shift: 'shift',
};
/** Canonical order inside a token; only consistency matters here. */
const MOD_ORDER = ['ctrl', 'alt', 'meta', 'shift'];
/** The order a cap is read in: ⌃⌥⇧⌘ on a Mac, Ctrl+Alt+Shift elsewhere. */
const MOD_SHOW_MAC = ['ctrl', 'alt', 'shift', 'meta'];
const MOD_SHOW_PC = ['ctrl', 'meta', 'alt', 'shift'];
const BASE_ALIAS: Record<string, string> = {
  esc: 'escape', ret: 'enter', return: 'enter', del: 'backspace',
  left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown',
  space: ' ', spc: ' ',
};
const DEAD_KEYS = new Set(['shift', 'control', 'alt', 'meta', 'altgraph', 'capslock', 'os']);

/** `Cmd+K`, `meta+k` and `k+meta` are all one chord. A modifier alone is not. */
function normKey(spec: string): string {
  const raw = spec.trim().toLowerCase();
  if (!raw) return '';
  const parts = raw.split('+');
  const mods = new Set<string>();
  const bases: string[] = [];
  parts.forEach((p, i) => {
    // `+` written as the base survives: "shift++" ends in an empty part.
    if (p === '') { if (i === parts.length - 1) bases.push('+'); return; }
    const m = MOD_ALIAS[p];
    if (m) mods.add(m); else bases.push(p);
  });
  const base0 = bases[bases.length - 1];
  if (!base0) return '';
  const base = BASE_ALIAS[base0] ?? base0;
  return [...MOD_ORDER.filter((m) => mods.has(m)), base].join('+');
}

/**
 * What a keydown means, in that same alphabet.
 *
 * `e.key` is the character the layout produced, which ⌥ ruins on macOS — ⌥C
 * arrives as `ç` — and ⇧ ruins on the digit row. So a base that is not a plain
 * ASCII letter or digit is read off `e.code` instead, which is physical.
 */
function keyToken(e: KeyboardEvent): string {
  const k = e.key.toLowerCase();
  if (DEAD_KEYS.has(k)) return '';
  let base: string;
  if (/^[a-z0-9]$/.test(k)) base = k;
  else if (/^Key[A-Z]$/.test(e.code)) base = e.code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(e.code)) base = e.code.slice(5);
  else base = k;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.metaKey) mods.push('meta');
  if (e.shiftKey) mods.push('shift');
  return [...mods, base].join('+');
}

const CAPS: Record<string, string> = {
  enter: '↵', escape: 'Esc', backspace: '⌫', tab: '⇥', ' ': 'Space',
  arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓',
};
const MAC = () => /mac|iphone|ipad|ipod/i.test(
  (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform
  ?? navigator.platform ?? navigator.userAgent ?? '',
);
const MAC_GLYPH: Record<string, string> = { ctrl: '⌃', alt: '⌥', meta: '⌘', shift: '⇧' };
/*
 * Off the Mac, ⌘ is Ctrl: a console that binds ⌘K binds Ctrl+K over there, and
 * printing `Win+K` would name a chord nobody presses. Both spell Ctrl, and the
 * dispatcher still tells them apart — only the cap collapses.
 */
const PC_WORD: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', meta: 'Ctrl', shift: 'Shift' };

/**
 * The cap printed on a button, in the platform's own hand: `⌘K` `⌥C` `⇧1`
 * `⌃X` on a Mac, `Ctrl+K` `Alt+C` `Shift+1` elsewhere. The first chord of a
 * list is the one shown. Exported because the mast prints the console's own
 * chords with it, and two spellings of ⌘K would be two shortcuts.
 */
export function kbdLabel(spec: string): string {
  const first = normKey((spec ?? '').trim().split(/\s+/)[0] ?? '');
  if (!first) return '';
  const parts = first.split('+');
  const base = parts.pop()!;
  const cap = CAPS[base] ?? (base.length === 1 ? base.toUpperCase() : base.toUpperCase());
  // Printed in the order the platform prints it: ⌃⌥⇧⌘, or Ctrl+Alt+Shift+key.
  const mac = MAC();
  const mods = (mac ? MOD_SHOW_MAC : MOD_SHOW_PC).filter((m) => parts.includes(m));
  if (!mods.length) return cap;
  if (mac) return mods.map((m) => MAC_GLYPH[m]).join('') + cap;
  const words = [...new Set(mods.map((m) => PC_WORD[m]!))];
  return [...words, cap].join('+');
}

/**
 * The first `fill` of a polyline, as an SVG `points` string. The cut lands
 * inside whichever segment holds it, so a pipe that is a third drawn is a
 * third of its *length* and not a third of its corners.
 */
function cutPolyline(pts: [number, number][], fill: number): string {
  if (fill >= 1) return pts.map(([x, y]) => `${x},${y}`).join(' ');
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    seg.push(d);
    total += d;
  }
  let want = total * fill;
  const out = [`${pts[0]![0]},${pts[0]![1]}`];
  for (let i = 0; i < seg.length; i++) {
    const d = seg[i]!;
    if (want >= d) { out.push(`${pts[i + 1]![0]},${pts[i + 1]![1]}`); want -= d; continue; }
    const t = d > 0 ? want / d : 0;
    const x = pts[i]![0] + (pts[i + 1]![0] - pts[i]![0]) * t;
    const y = pts[i]![1] + (pts[i + 1]![1] - pts[i]![1]) * t;
    out.push(`${Math.round(x)},${Math.round(y)}`);
    break;
  }
  return out.join(' ');
}

function outsideViewport(r: { x: number; y: number; w: number; h: number }): boolean {
  return r.x + r.w < 0 || r.x > window.innerWidth || r.y + r.h < 0 || r.y > window.innerHeight;
}

/** Which side of the window the tile is on, once the window has been clamped. */
function edgeToward(r: { x: number; y: number; w: number; h: number }, win: Win): Edge {
  const dx = (r.x + r.w / 2) - (win.x + win.w / 2);
  const dy = (r.y + r.h / 2) - (win.y + win.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'l' : 'r';
  return dy < 0 ? 't' : 'b';
}

function dockHome(kind: WinKind, w: number, h: number, vw: number, vh: number): { x: number; y: number } {
  const M = 62, TOP = 64, BOTTOM = DOCK_H + 8;
  switch (kind) {
    case 'ceo': return { x: vw - w - M, y: TOP };
    case 'queue': return { x: vw - w - M - 428, y: TOP };
    case 'feed': return { x: M, y: vh - h - BOTTOM };
    case 'fleet': return { x: M, y: TOP };
    case 'breach': return { x: vw / 2 - w / 2, y: 90 };
    case 'gallery': return { x: vw / 2 - w / 2, y: TOP + 24 };
    case 'launch': return { x: vw / 2 - w / 2, y: vh / 2 - h / 2 };
    case 'timeline': return { x: M, y: vh - h - BOTTOM };
    case 'sfx': return { x: vw / 2 - w / 2, y: TOP + 24 };
    // Bottom-right, clear of the minimap: the record player sits where the
    // hand already is and covers nothing that reports.
    case 'music': return { x: vw - w - M, y: vh - h - 250 };
    default: return { x: vw / 2 - w / 2, y: vh / 2 - h / 2 };
  }
}

function defaultSize(kind: WinKind): { w: number; h: number } {
  switch (kind) {
    case 'agent': return { w: 420, h: 520 };
    case 'interrupt': return { w: 360, h: 260 };
    case 'queue': return { w: 340, h: 420 };
    case 'ceo': return { w: 420, h: 520 };
    case 'feed': return { w: 520, h: 260 };
    case 'fleet': return { w: 380, h: 440 };
    case 'spawn': return { w: 380, h: 400 };
    case 'artifact': return { w: 520, h: 420 };
    case 'breach': return { w: 520, h: 120 };
    case 'help': return { w: 380, h: 360 };
    case 'settings': return { w: 380, h: 400 };
    case 'gallery': return { w: 560, h: 460 };
    case 'launch': return { w: 480, h: 440 };
    case 'timeline': return { w: 620, h: 400 };
    case 'sfx': return { w: 480, h: 640 };
    case 'music': return { w: 420, h: 560 };
  }
}

function chrome(spec: WinSpec): string {
  const cs = spec.callsign ? `<span class="win__cs">${esc(spec.callsign)}</span>` : `<span class="win__kind">${esc(spec.kind)}</span>`;
  const pj = spec.project ? `<span class="win__pj">${esc(spec.project)}</span>` : '';
  const pinnable = spec.kind === 'agent' || spec.kind === 'interrupt' || spec.kind === 'artifact';
  return `
    <i class="win__xh win__xh--tl"></i>
    <header class="win__head">
      <div class="win__id">${cs}${pj}</div>
      <div class="win__title">${esc(spec.title ?? '')}</div>
      <div class="win__ctl">
        ${pinnable ? `<button class="win__btn" type="button" data-w-pin title="Follow the agent">PIN</button>` : ''}
        <button class="win__btn" type="button" data-w-min title="Fold into the tray">—</button>
        <button class="win__btn win__btn--x" type="button" data-w-close title="Close">×</button>
      </div>
    </header>
    <div class="win__body"></div>
    <footer class="win__foot">
      <span class="px win__stamp">${esc(spec.kind)}</span>
      <span class="px win__tele">${hexNoise(3)}</span>
    </footer>
    <i class="win__xh win__xh--br"></i>
    <i class="win__grip"></i>
  `;
}
