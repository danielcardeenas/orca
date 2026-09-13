/**
 * The window manager.
 *
 * Windows occupy world coordinates on the canvas. FRONT temporarily brings
 * one to screen coordinates; CANVAS returns it; PIN keeps it on screen.
 * Kinds keep their mounted content through these moves. The tray retrieves
 * any window, including off-screen ones, and reports its placement mode.
 * Hosts without camera callbacks retain the legacy anchored/docked behavior.
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
 *   toggleWindow(win)           folded → unfold · distant → fly to · active visible → fold
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
 * and leaves, `-` folds or unfolds under the cursor, `+` brings it to the
 * front and leaves, `Backspace`/`Delete`/`x`
 * closes it, `v` reveals an anchored one, `Escape` leaves. `` ` `` again
 * inside the mode is the fast path: it raises as it walks. While the mode is
 * on, every one of those keys is consumed — `main.ts` never sees them.
 *
 * `Enter` uses the same retrieval/return action as clicking a tray tile.
 * Backspace/Delete closes explicitly; Escape leaves tray mode.
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
 *   agent      F fly · L logs · C spawn child · X stop (armed, twice)
 *   interrupt  1…9 options · Enter send · O open agent · D dismiss
 *   fleet      A say all · L say lead · F frame · N spawn here · X stop all
 *   capcom     —
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
 * **Sending a message is not in this table, on purpose.** A composer of more
 * than one line —CAPCOM, a mission, an agent— sends with ⌘/⌃Enter from inside
 * the box, and Enter there is a line break; a `data-key` would be a second
 * spelling of the same thing, and one that only works while the box does NOT
 * have the focus, which is never when you are writing. See
 * `windows/composer.ts`. A one-line `<input>` —an escalation answer, a word to
 * a fleet— keeps Enter as its send: there is no line to break.
 *
 * Universal, with a window active: `Esc` returns from front, otherwise closes,
 * `-` folds (and hands the keyboard down the stack), `+` is its pair and
 * brings a canvas window up to the front, `v` reveals an anchored window's
 * tile when it is off screen, and `` ` `` opens tray mode.
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
import { typing } from '../keys.ts';
import { dur, EASE, REDUCE, T } from '../motion.ts';
import { getSound } from '../hud/sound.ts';
import { longPress } from '../hud/longpress.ts';
import { share, spend, wheelPixels } from './chain.ts';
import {
  assemble, cascade, check, collapse, collapseShort, echoKbd, foldTo, sendToCanvas, stopAssemble,
  unfoldFrom, wipe,
} from './fx.ts';
import { WIN_KINDS } from '../../shared/gestures.ts';
import { gesture } from '../gestures.ts';
import { isPhone } from '../phone.ts';

/**
 * La lista vive en `shared/gestures.ts` porque el hub, que no tiene ventanas,
 * es quien escribe «estas clases no se abrieron ni una vez» en el informe
 * de AUTOMEJORA. Aquí sólo se deriva el tipo.
 */
export type WinKind = typeof WIN_KINDS[number];

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
  mode: 'canvas' | 'front' | 'pinned';
  canvas?: { x: number; y: number; ppu: number };
  scale: number;
  /**
   * The last answer `offView` gave for this window, so `reproject` can tell
   * the tray the moment it changes instead of on every frame. Nothing reads
   * it: ask `offView(win)`, which is always current.
   */
  away?: boolean;
  inst: { dispose?(): void; update?(): void; start?(): void; state?(): unknown } | void;
}

/** One canvas window's place in the world, for whoever draws the world. */
export interface Seat {
  id: string;
  /** Top-left corner in world units; `y` grows upward, so the seat is `y` down to `y - h`. */
  x: number; y: number; w: number; h: number;
  focused: boolean;
  /** Not touching the screen right now. */
  off: boolean;
}

export interface WmEvents {
  /** Flat working plane, shared with the field camera. */
  project?(x: number, y: number): { x: number; y: number };
  unproject?(x: number, y: number): { x: number; y: number };
  onZoom?(e: WheelEvent): void;
  /**
   * What a canvas window could not scroll, in pixels, at the point the
   * gesture is over. The field takes it as its own wheel, so one unbroken
   * movement runs a conversation out and then pans the canvas.
   */
  onPan?(dx: number, dy: number, clientX: number, clientY: number): void;
  agentOrigin?(id: string): { x: number; y: number } | null;
  onLocateWindow?(bounds: { minX: number; minY: number; maxX: number; maxY: number }): void;
  plane?(): { origin: { x: number; y: number }; ppu: number };
  /**
   * Screen rect of a tile, for anchoring. `visible` is on screen or near it;
   * `ahead` (absent means yes) is in front of the camera, so the rect is a
   * real place on the glass however far off it — a pipe can be drawn to it.
   */
  tileRect(agentId: string): { x: number; y: number; w: number; h: number; visible: boolean; ahead?: boolean } | null;
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

// A phone, standing or on its side: one answer for the wm and the sheets, see `phone.ts`.
const KEY = 'orca.windows.v2';
/** A standard agent tile is one world unit wide; a 640px window occupies two. */
const AGENT_WINDOW_PPU = 320;
/** A9: the comp's scrambling column re-randomises every 70ms. */
const TELE_MS = 70;
/** The dock — command line, hints, tray — owns the bottom band; windows stay above it. */
const DOCK_H = 100;
/**
 * The camera scale under which a canvas window is too small to read or to
 * work in. Below it a tray retrieval flies to it, a click on its title no
 * longer means "bring to front", and a press anywhere on it — body included —
 * is a drag: from that far the only thing to do with a window is move it.
 */
const READING_SCALE = 0.55;
/**
 * Where a window opens. In front: screen-fixed and at reading size, because a
 * window that arrives at the camera's scale arrives unreadable — clicking a
 * tile from any ordinary zoom used to hand back a housing the size of a stamp,
 * and the operator had to fly in to read what they had just asked for. The
 * canvas is still where windows live; it is now somewhere you send them
 * (`CANVAS`), not where they land.
 */
const OPEN_MODE: Win['mode'] = 'front';

export class WindowManager {
  private layer: HTMLElement;
  private tether: SVGSVGElement;
  private canvasLayer: HTMLElement;
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
  /** See `stamp()`: one number that says "a window may have moved". */
  private placeRev = 0;

  constructor(host: HTMLElement, ev: WmEvents) {
    this.ev = ev;
    this.layer = document.createElement('div');
    this.layer.className = 'wm';
    this.canvasLayer = document.createElement('div');
    this.canvasLayer.className = 'wm wm--canvas';
    host.appendChild(this.canvasLayer);
    this.tether = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.tether.setAttribute('class', 'tether');
    this.canvasLayer.appendChild(this.tether);
    host.appendChild(this.layer);
  }

  register(kind: WinKind, mount: KindMount) { this.kinds.set(kind, mount); }

  /** Open, or focus if a window with this key is already open. */
  open(spec: WinSpec): Win {
    const existing = this.byKey.get(spec.key);
    if (existing) {
      this.activate(existing);
      return existing;
    }
    const mount = this.kinds.get(spec.kind);
    if (!mount) throw new Error(`no window kind ${spec.kind}`);
    // Un gesto para AUTOMEJORA: qué clase de ventana se abre, y cuántas veces.
    // La restauración de la sesión no cuenta — lo que se reabre solo al cargar
    // no lo tocó nadie. Y volver a una ya abierta tampoco: es un foco.
    if (!this.reviving) gesture('win', spec.kind);

    const el = document.createElement('section');
    el.className = `win is-${spec.kind}`;
    el.dataset.kind = spec.kind;
    el.innerHTML = chrome(spec);
    const body = el.querySelector<HTMLElement>('.win__body')!;
    const id = `w${(this.zTop++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    el.dataset.windowId = id;
    if (spec.anchor) el.dataset.windowSource = spec.anchor;
    const w = spec.w ?? defaultSize(spec.kind).w;
    const h = spec.h ?? defaultSize(spec.kind).h;
    const win: Win = {
      id, spec, el, body, w, h, x: 0, y: 0, ax: 18, ay: -8, z: ++this.zTop,
      minimized: false, focused: false, stateVar: null,
      // An anchored window draws its pipe as it arrives; a docked one has none.
      anchorFill: spec.anchor && !REDUCE.value ? 0 : 1,
      mode: OPEN_MODE, scale: 1,
      inst: undefined,
    };
    this.place(win);
    // Even a window that opens in front learns its place on the canvas now, so
    // `CANVAS` later drops it beside its tile at reading scale instead of
    // wherever the glass happened to hold it. Nobody chose that seat, so it
    // gets out of the way of the seats somebody did choose.
    this.captureCanvas(win, true);
    ((this.ev.plane && !isPhone() && win.mode === 'canvas') ? this.canvasLayer : this.layer).appendChild(el);
    this.wins.set(id, win);
    this.byKey.set(spec.key, win);
    this.reproject();
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
    win.el.style.zIndex = String(win.z + (win.mode !== 'canvas' ? 100000 : 0));
    win.el.classList.add('is-focus');
    this.ev.onFocus(win);
    this.emitStack();
  }

  /**
   * `free`: the manager chose this seat, so it may be pushed off the ones
   * already taken (`clearOf`). A seat that came from the operator's hand
   * never is.
   */
  private captureCanvas(win: Win, free = false) {
    // Every window gets world coordinates, whatever mode it is wearing: they
    // are what `CANVAS` returns to, and `reproject` needs them to tell a
    // screen-fixed window from one that follows its tile.
    const p = this.ev.plane?.();
    if (!p || isPhone()) return;
    if (!win.canvas && win.spec.anchor) {
      const r = this.ev.tileRect(win.spec.anchor);
      const origin = this.ev.agentOrigin?.(win.spec.anchor) ?? (r
        ? this.ev.unproject?.(r.x + r.w, r.y) ?? { x: (r.x + r.w - p.origin.x) / p.ppu, y: (p.origin.y - r.y) / p.ppu }
        : null);
      if (origin) {
        win.canvas = { x: origin.x + 18 / AGENT_WINDOW_PPU, y: origin.y - 8 / AGENT_WINDOW_PPU, ppu: AGENT_WINDOW_PPU };
        return;
      }
    }
    win.canvas = { ...(this.ev.unproject?.(win.x, win.y) ?? { x: (win.x - p.origin.x) / p.ppu, y: (p.origin.y - win.y) / p.ppu }),
      ppu: win.canvas?.ppu ?? p.ppu };
    if (free) this.clearOf(win);
  }

  /**
   * Push a seat off the ones already taken.
   *
   * Only for a seat the manager chose — a window opening, or one dropped here
   * because its old seat had gone out of view. A seat the operator chose with
   * their hand is never moved: dropping a window exactly on top of another is
   * a thing people do on purpose, and a canvas that rearranges itself under a
   * drag is a canvas fighting the hand.
   *
   * The push is to the right of whatever it lands on, one window at a time.
   * The world has no edges to run out of, so there is always somewhere to go;
   * the cap on tries is only there because a cycle of seats that keep pushing
   * each other must not become a frame that never ends.
   */
  private clearOf(win: Win): void {
    if (!win.canvas) return;
    const gap = 12 / win.canvas.ppu;
    const w = win.w / win.canvas.ppu, h = win.h / win.canvas.ppu;
    const others = [...this.wins.values()].filter((o) =>
      o !== win && !o.minimized && o.mode === 'canvas' && o.canvas);
    for (let tries = 0; tries < 8; tries++) {
      const hit = others.find((o) => {
        const c = o.canvas!;
        const ow = o.w / c.ppu, oh = o.h / c.ppu;
        return win.canvas!.x < c.x + ow && win.canvas!.x + w > c.x
          && win.canvas!.y > c.y - oh && win.canvas!.y - h < c.y;
      });
      if (!hit) return;
      win.canvas.x = hit.canvas!.x + hit.w / hit.canvas!.ppu + gap;
    }
  }

  /**
   * Is the seat this window would return to still somewhere the operator can
   * see? Same reading as `offView`, asked of the world coordinates rather
   * than of where the housing is right now.
   */
  private seatOffView(win: Win): boolean {
    const p = this.ev.plane?.();
    if (!p || !win.canvas || isPhone()) return false;
    const at = this.ev.project?.(win.canvas.x, win.canvas.y)
      ?? { x: p.origin.x + win.canvas.x * p.ppu, y: p.origin.y - win.canvas.y * p.ppu };
    const s = p.ppu / win.canvas.ppu;
    return outsideViewport({ x: at.x, y: at.y, w: win.w * s, h: win.h * s });
  }

  /** On the canvas and below reading scale: too small to read, only to move. */
  private far(win: Win): boolean {
    return !!this.ev.plane && !isPhone() && win.mode === 'canvas' && win.scale < READING_SCALE;
  }

  private needsLocate(win: Win): boolean {
    return !!this.ev.plane && !isPhone() && win.mode === 'canvas' && !!win.canvas &&
      (this.far(win) || win.x < 8 || win.y < 112 ||
       win.x + win.w * win.scale > window.innerWidth - 8 ||
       win.y + win.h * win.scale > window.innerHeight - DOCK_H);
  }

  /**
   * Out of view: the housing does not touch the screen at all.
   *
   * Three different things get confused here, so they have three names.
   * `far` is visible and too small to work in; `needsLocate` is visible but
   * badly placed, and is what decides whether retrieving one flies the
   * camera; this is the hard case — nothing on the glass, and the window's
   * tile in the tray is the only evidence it exists. That is why the tray
   * says it (`hud/tray.ts`) and why the minimap draws it (`hud/minimap.ts`).
   */
  offView(win: Win): boolean {
    if (!this.ev.plane || isPhone() || win.minimized || win.mode !== 'canvas') return false;
    return outsideViewport({ x: win.x, y: win.y, w: win.w * win.scale, h: win.h * win.scale });
  }

  /**
   * Where the canvas windows sit, in world units, for whoever draws the
   * world. The minimap is the caller: a window sent out of view leaves no
   * mark on the field itself, and the radar is where an operator looks to
   * find out where something is.
   */
  seats(): Seat[] {
    const out: Seat[] = [];
    for (const w of this.wins.values()) {
      if (w.minimized || w.mode !== 'canvas' || !w.canvas) continue;
      out.push({ id: w.id, x: w.canvas.x, y: w.canvas.y,
        w: w.w / w.canvas.ppu, h: w.h / w.canvas.ppu, focused: w.focused, off: this.offView(w) });
    }
    return out;
  }

  /**
   * Bumped whenever a window's placement can have changed. A drawing that is
   * not on the console's own redraw path — the minimap throttles itself on
   * the camera and the world's revision — reads this to know it is stale.
   */
  stamp(): number { return this.placeRev; }

  /** Retrieve in the existing mode; the camera travels to canvas windows. */
  activate(win: Win) {
    if (!this.wins.has(win.id)) return;
    if (win.minimized) { this.restore(win); return; }
    this.reproject(); this.focus(win);
    if (this.needsLocate(win)) {
      const p = win.canvas!;
      this.ev.onLocateWindow?.({ minX: p.x, maxX: p.x + win.w / p.ppu,
        minY: p.y - win.h / p.ppu, maxY: p.y });
    }
  }

  /** A source tile opens, then closes its window on the next activation. */
  toggleSource(key: string, open: () => void) {
    const win = this.byKey.get(key);
    if (!win) open();
    else if (win.minimized) this.restore(win);
    else this.close(win);
  }

  bringForward(win: Win) {
    if (!this.wins.has(win.id)) return;
    if (win.minimized) this.restore(win, false);
    if (!this.ev.plane || isPhone()) { this.focus(win); return; }
    if (win.mode === 'canvas') {
      win.mode = 'front'; win.scale = 1;
      win.x = (window.innerWidth - win.w) / 2;
      win.y = (window.innerHeight - DOCK_H - win.h) / 2;
      this.clampToView(win);
    }
    this.apply(win); this.focus(win); this.persist();
  }

  returnToCanvas(win: Win) {
    const hadFocus = win.focused;
    // Where it is on the glass, read before the mode moves it: the housing
    // lands on the canvas in the same frame, and the flight is drawn from
    // here to there so the operator sees which way it went.
    const from = win.el.getBoundingClientRect();
    win.mode = 'canvas';
    /*
     * A window keeps the seat it had, which is the whole point of the canvas:
     * things stay where they were put. But the operator can travel a long way
     * with a window held in front, and a seat left behind three regions ago
     * is not a place any more — sending the window there is sending it
     * nowhere, and the tray becomes the only way back. So a seat that has
     * gone out of view is given up and the window lands here, in the view the
     * operator chose, clear of whatever is already sitting in it.
     */
    if (!win.canvas || this.seatOffView(win)) this.captureCanvas(win, true);
    win.focused = false; win.el.classList.remove('is-focus');
    if (win.el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    if (hadFocus) this.ev.onFocus(null);
    this.reproject(); this.apply(win);
    if (!isPhone() && from.width && from.height) {
      sendToCanvas(win.el, { x: from.left, y: from.top, w: from.width, h: from.height });
    }
    this.persist(); this.emitStack();
  }

  pinToScreen(win: Win) {
    this.bringForward(win);
    win.mode = win.mode === 'pinned' ? 'front' : 'pinned';
    this.apply(win); this.persist(); this.emitStack();
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
    if (this.reviving || isPhone()) win.el.classList.add('is-min');
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
  restore(win: Win, locate = true) {
    getSound()?.play('unfold');
    // Read the tile before the stack moves it: it is where the window comes
    // from, and `focus` redraws the row underneath us.
    const from = this.trayRect(win);
    win.minimized = false;
    win.el.classList.remove('is-min');
    if (locate) this.activate(win); else this.focus(win);
    if (!isPhone() && win.mode !== 'canvas') unfoldFrom(win.el, from);
    this.persist();
  }
  trayList(): Win[] { return [...this.wins.values()].filter((w) => w.minimized); }

  /* ── One gesture, three answers ─────────────────────────────────── */

  /** Tray/mast: retrieve a distant or inactive window; minimize the visible active one. */
  toggleWindow(win: Win): void {
    if (!this.wins.has(win.id)) return;
    this.reproject();
    if (win.minimized) this.restore(win);
    else if (win.focused && !this.needsLocate(win)) this.minimize(win);
    else this.activate(win);
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
    try { this.activate(next); } finally { this.cycling = false; }
    if (!this.ev.plane && next.spec.anchor && this.tileOffView(next.spec.anchor)) this.ev.onReveal?.(next.spec.anchor);
    return next;
  }

  private emitStack() { this.placeRev++; this.ev.onStack?.(this.stack()); this.ev.onTray(this.trayList()); }

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
      case '=': case '+': case 'shift+=': case 'shift++':
        // The other direction, and it leaves: bringing one to the front is
        // asking to work in it, and the row has nothing left to say.
        if (win) {
          if (win.minimized) this.restore(win, false);
          this.bringForward(win);
          this.exitTrayMode();
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
    // Enter is already "send" inside a field. Never send the same line twice.
    if (typing(e)) return false;
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
      case 'escape': e.preventDefault(); if (win.mode === 'front') this.returnToCanvas(win); else this.close(win); return true;
      case '-': case 'shift+_': case '_': e.preventDefault(); this.minimize(win); return true;
      // The pair `-` had been missing: one puts the window away, the other
      // brings it up to reading size. `Esc` is the way back out to the canvas.
      case '=': case '+': case 'shift+=': case 'shift++':
        // Only from the canvas: a window already on the glass has nowhere to
        // be brought to, and swallowing the key there would be a key that
        // does nothing. `PIN` is its own button.
        if (win.mode !== 'canvas' || !this.ev.plane || isPhone()) return false;
        e.preventDefault(); this.bringForward(win); return true;
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

  /** Its tile: gone from the field, or past the edge of the viewport. */
  private tileOffView(agentId: string): boolean {
    const r = this.ev.tileRect(agentId);
    return !r || !r.visible || outsideViewport(r);
  }

  /** Called every frame: anchored windows follow their tiles. */
  reproject() {
    let paths = '';
    // A window crossing the edge of the screen is news for the tray, and it
    // happens under a camera that moves, not under a click. Only the crossing
    // is reported: this runs every frame.
    let crossed = false;
    for (const win of this.wins.values()) {
      if (win.minimized) continue;
      if (this.ev.plane && !win.canvas && !isPhone()) this.captureCanvas(win);
      if (this.ev.plane && win.canvas) {
        if (win.mode === 'canvas' && !isPhone()) {
          const p = this.ev.plane();
          const at = this.ev.project?.(win.canvas.x, win.canvas.y) ?? { x: p.origin.x + win.canvas.x * p.ppu, y: p.origin.y - win.canvas.y * p.ppu };
          win.x = at.x; win.y = at.y;
          win.scale = p.ppu / win.canvas.ppu;
        } else { win.scale = 1; if (!isPhone()) this.clampToView(win); }
        this.apply(win);
        const away = this.offView(win);
        if (away !== (win.away ?? false)) { win.away = away; crossed = true; }
        // The pipe belongs to the pair, not to the mode: a window in front is
        // still that agent's window, and the line is how the operator reads
        // whose. It runs from the tile to the housing's edge in screen space,
        // so it works the same whether the housing moves with the camera or
        // stays on the glass. A tile that has left the screen still gets its
        // line: the window is on the canvas because the operator put it there,
        // and the pipe running off the edge is what says where it came from
        // once the zoom or a pan has lost the tile. Only a tile behind the
        // camera has no line — its projection is a mirror, not a place.
        if (win.spec.anchor) {
          const r = this.ev.tileRect(win.spec.anchor);
          if (r && r.ahead !== false) paths += this.tetherPath(win, r);
        }
        continue;
      }
      if (isPhone()) continue;
      if (!win.spec.anchor) continue;
      const r = this.ev.tileRect(win.spec.anchor);
      if (!r) { this.showOff(win, null); continue; }
      win.x = r.x + r.w + win.ax;
      win.y = r.y + win.ay;
      // A visible tile can still project its window beyond the viewport.
      // Clamp the housing, not the anchor offsets: panning back restores the
      // intended placement. Size only changes when the viewport cannot fit it.
      this.clampToView(win);
      // A window whose tile left the screen used to fade to 15% and take its
      // report with it. It stays legible instead: same size, clamped to the
      // edge nearest the tile, with an indicator that says which way to look.
      if (!r.visible || outsideViewport(r)) {
        win.el.style.opacity = '';
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
    if (crossed) this.emitStack();
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
    const left = win.x + win.w * win.scale / 2 < r.x + r.w / 2;
    const x0 = left ? r.x : r.x + r.w, y0 = r.y + r.h / 2;
    const x1 = left ? win.x + win.w * win.scale : win.x, y1 = win.y + 15 * win.scale;
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
      const list = JSON.parse(raw) as Array<{ spec: WinSpec; x: number; y: number; w: number; h: number; minimized: boolean; canvas?: Win['canvas']; mode?: Win['mode'] }>;
      for (const s of list) {
        if (!s?.spec?.kind || s.spec.anchor) continue;
        open({ ...s.spec, at: undefined, w: s.w, h: s.h });
        const w = this.byKey.get(s.spec.key);
        if (w) { w.x = s.x; w.y = s.y; w.canvas = s.canvas ?? w.canvas; w.mode = s.mode ?? OPEN_MODE; this.reproject(); this.apply(w); if (s.minimized) this.minimize(w); }
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
        const to = this.beside(win, r);
        win.x = to.x; win.y = to.y;
        // The offsets the tile-following path reads, so a housing placed here
        // keeps the side it was given when the camera moves the tile.
        win.ax = win.x - (r.x + r.w); win.ay = win.y - r.y;
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

  /**
   * Where a window opens next to its tile: the first side with room, tried
   * right, left, below, above, and the roomiest of the four when none has
   * enough. Landing on top of its own tile is not just untidy — the tile is
   * the switch that closes the window again, and a covered switch cannot be
   * pressed. It used to be enough to try right and then left, back when a
   * housing arrived at the camera's scale and was too small to cover anything.
   */
  private beside(win: Win, r: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
    const gap = 18;
    const vw = window.innerWidth;
    const top = this.ev.plane ? 112 : 44, bottom = window.innerHeight - DOCK_H;
    const alignY = Math.max(top, Math.min(bottom - win.h, r.y - 8));
    const alignX = Math.max(8, Math.min(vw - win.w - 8, r.x));
    const sides = [
      { x: r.x + r.w + gap, y: alignY, free: vw - 8 - (r.x + r.w + gap), need: win.w },
      { x: r.x - gap - win.w, y: alignY, free: (r.x - gap) - 8, need: win.w },
      { x: alignX, y: r.y + r.h + gap, free: bottom - (r.y + r.h + gap), need: win.h },
      { x: alignX, y: r.y - gap - win.h, free: (r.y - gap) - top, need: win.h },
    ];
    // Nowhere fits: take the side that gives the most and let the clamp do the
    // rest. Some of the tile will go under the housing, and that is the least
    // bad answer a viewport this small has.
    const pick = sides.find((s) => s.free >= s.need) ?? sides.reduce((a, b) => (b.free > a.free ? b : a));
    return {
      x: Math.max(8, Math.min(vw - win.w - 8, pick.x)),
      y: Math.max(top, Math.min(bottom - win.h, pick.y)),
    };
  }

  private clampToView(win: Win) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const top = this.ev.plane ? 112 : 44;
    win.w = Math.min(win.w, vw - 16);
    win.h = Math.min(win.h, Math.max(120, vh - top - DOCK_H));
    win.x = Math.max(8, Math.min(vw - win.w - 8, win.x));
    win.y = Math.max(top, Math.min(vh - win.h - DOCK_H, win.y));
  }

  /** Position lives in left/top so GSAP can own `transform` for arrivals. */
  private apply(win: Win) {
    // The one place a position is written, so the dock band is honoured by
    // every path: docked, dragged, anchored, clamped to an edge.
    if (!isPhone() && !(this.ev.plane && win.mode === 'canvas')) win.y = Math.max(44, Math.min(window.innerHeight - win.h - DOCK_H, win.y));
    const spatial = !!this.ev.plane && !isPhone();
    const parent = spatial && win.mode === 'canvas' ? this.canvasLayer : this.layer;
    if (win.el.isConnected && win.el.parentElement !== parent) {
      // Atomic moves preserve iframe documents, terminal state and selection.
      const target = parent as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
      if (target.moveBefore) target.moveBefore(win.el, null);
      // Older engines retain their original layer rather than reload embedded work.
    }
    win.el.style.setProperty('--canvas-scale', String(win.scale));
    // A canvas window is the window, at the camera's scale, at every distance.
    // There is no far rendering — no card, no fade, no threshold: what you see
    // from afar is the housing small, and zooming in makes it bigger. The tray
    // owns finding one.
    win.el.style.scale = spatial ? String(win.scale) : '';
    win.el.style.transformOrigin = 'top left';
    win.el.classList.toggle('is-canvas', spatial && win.mode === 'canvas');
    // Too small to work in: the body stops taking the pointer, so a press
    // anywhere on the housing is the drag. See `READING_SCALE`.
    win.el.classList.toggle('is-far', this.far(win));
    win.el.style.zIndex = String(win.z + (win.mode !== 'canvas' ? 100000 : 0));
    const front = win.el.querySelector<HTMLButtonElement>('[data-w-front]');
    if (front) {
      front.hidden = !spatial;
      front.textContent = win.mode === 'canvas' ? 'FRONT' : 'CANVAS';
      front.title = win.mode === 'canvas' ? 'Bring to front' : 'Return to canvas';
      front.setAttribute('aria-label', front.title);
    }
    const pinButton = win.el.querySelector<HTMLButtonElement>('[data-w-pin]');
    if (pinButton && !spatial && this.ev.plane) pinButton.hidden = true;
    if (pinButton && spatial) {
      pinButton.hidden = win.mode === 'canvas';
      pinButton.classList.toggle('is-on', win.mode === 'pinned');
      pinButton.title = win.mode === 'pinned' ? 'Unfix from screen' : 'Fix to screen';
      pinButton.setAttribute('aria-label', pinButton.title);
      pinButton.setAttribute('aria-pressed', String(win.mode === 'pinned'));
    }
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
    // A housing still in flight is not a target yet. It starts a third of the
    // way toward the point that opened it, which at reading size can be over
    // the tile that opened it — and the tile is the switch that closes the
    // window again. A double click on a tile has to reach the tile twice.
    // The timer, not the tween's `onComplete`: a fold or a close in the first
    // frames kills the arrival, and a housing left unclickable forever is a
    // far worse bug than one that eats a click it should not have had.
    win.el.style.pointerEvents = 'none';
    window.setTimeout(() => { if (this.wins.has(win.id)) win.el.style.pointerEvents = ''; }, dur(T.quick) * 1000);
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
    // Con el dedo, la barra de título: mantenerla pulsada abre el mismo menú.
    // Sólo la barra — en el cuerpo hay texto que se selecciona con ese gesto.
    longPress(head);
    el.addEventListener('contextmenu', (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, iframe, [contenteditable], a[href], pre')) return;
      e.preventDefault();
      this.ev.onContext?.(win, e.clientX, e.clientY);
    });

    el.querySelector('[data-w-close]')!.addEventListener('click', () => this.close(win));
    el.querySelector('[data-w-min]')!.addEventListener('click', () => this.minimize(win));
    el.addEventListener('wheel', e => {
      // On the canvas the window stands in the space, so the space answers
      // for what the window cannot spend. In front it is a page over the
      // glass: running a list out there must not drag the field underneath.
      if (win.mode !== 'canvas') return;
      if (e.ctrlKey || e.metaKey) {
        if (!this.ev.onZoom) return;
        e.preventDefault(); this.ev.onZoom(e);
        return;
      }
      if (!this.ev.onPan) return;
      const px = wheelPixels(e);
      const rest = share(e.target as Element | null, el, px.dx, px.dy);
      // The window takes the whole gesture: leave it to the browser. Doing it
      // by hand here would trade the wheel's own smoothing for jumps on every
      // ordinary scroll, to fix a frame that is not happening.
      if (Math.abs(rest.dx) < 1 && Math.abs(rest.dy) < 1) return;
      // Something is left: now we own the event, both halves of it, so the
      // window's last pixels and the field's first arrive in the same frame.
      e.preventDefault();
      spend(rest.take);
      this.ev.onPan(rest.dx, rest.dy, e.clientX, e.clientY);
    }, { passive: false });
    el.querySelector('[data-w-front]')!.addEventListener('click', () => win.mode === 'canvas' ? this.bringForward(win) : this.returnToCanvas(win));
    const pin = el.querySelector<HTMLElement>('[data-w-pin]');
    if (pin) {
      pin.classList.toggle('is-on', !!win.spec.anchor);
      pin.addEventListener('click', () => {
        if (this.ev.plane && !isPhone()) { this.pinToScreen(win); return; }
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

    // Drag by the header — or, from far enough that the window is a stamp,
    // by any part of the housing: too small to read, it is only something to
    // move, and a press-and-drag on it should not have to find the title bar.
    // `is-far` takes the pointer away from the body so the press lands here.
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    el.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('button, .win__grip, .win__off')) return;
      if (!t.closest('.win__head') && !this.far(win)) return;
      if (isPhone()) return;
      dragging = true;
      el.setPointerCapture(e.pointerId);
      sx = e.clientX; sy = e.clientY; ox = win.x; oy = win.y;
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      win.x = ox + (e.clientX - sx); win.y = oy + (e.clientY - sy);
      if (win.spec.anchor && !this.ev.plane) {
        const r = this.ev.tileRect(win.spec.anchor);
        if (r) { win.ax = win.x - (r.x + r.w); win.ay = win.y - r.y; }
      }
      this.captureCanvas(win); this.apply(win);
    });
    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      el.releasePointerCapture(e.pointerId);
      // A press on the header that did not move is a click, and a click on a
      // canvas window's title means "this one, in front of everything": the
      // same as its FRONT button. At reading scale a click used to raise it
      // only among the canvas windows, under whatever was in front. A drag
      // still arranges. From afar a still press is nothing: the tray, or the
      // zoom, is how a stamp comes up to reading size.
      const moved = Math.hypot(e.clientX - sx, e.clientY - sy) > 4;
      if (!moved && win.mode === 'canvas' && this.ev.plane && !this.far(win)) { this.bringForward(win); return; }
      if (!this.ev.plane || win.mode !== 'canvas') this.clampToView(win);
      this.captureCanvas(win); this.apply(win); this.persist();
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
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
      win.w = Math.max(240, rw + (e.clientX - sx) / win.scale);
      win.h = Math.max(120, rh + (e.clientY - sy) / win.scale);
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
    this.placeRev++;
    clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      try {
        const list = [...this.wins.values()]
          .filter((w) => !w.spec.anchor && !w.spec.ephemeral)
          .map((w) => ({ spec: { ...w.spec, at: undefined }, x: w.x, y: w.y, w: w.w, h: w.h, minimized: w.minimized, canvas: w.canvas, mode: w.mode }));
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
export function keyToken(e: KeyboardEvent): string {
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
    case 'agent': return { w: 640, h: 720 };
    case 'interrupt': return { w: 360, h: 260 };
    case 'queue': return { w: 340, h: 420 };
    case 'ceo': return { w: 500, h: 680 };
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
    case 'terminal': return { w: 760, h: 480 };
    case 'file': return { w: 680, h: 540 };
    // Una columna de nombres: estrecha, y alta para que quepa una carpeta de
    // un repo sin desplazar a la tercera fila.
    case 'files': return { w: 460, h: 560 };
    // Tall and narrow: it is a column of rows read top to bottom, one machine
    // after another, and every row is a label and a number.
    case 'hygiene': return { w: 460, h: 620 };
    // Una misión: ancho para que una línea de resultado no se parta cada tres
    // palabras, y alto porque debajo va la línea al líder.
    case 'mission': return { w: 560, h: 640 };
  }
}

function chrome(spec: WinSpec): string {
  const cs = spec.callsign ? `<span class="win__cs">${esc(spec.callsign)}</span>` : `<span class="win__kind">${esc(spec.kind)}</span>`;
  const pj = spec.project ? `<span class="win__pj">${esc(spec.project)}</span>` : '';
  return `
    <i class="win__xh win__xh--tl"></i>
    <header class="win__head">
      <div class="win__id">${cs}${pj}</div>
      <div class="win__title">${esc(spec.title ?? '')}</div>
      <div class="win__ctl">
        <button class="win__btn" type="button" data-w-front hidden>FRONT</button>
        <button class="win__btn" type="button" data-w-pin title="Follow the agent">PIN</button>
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
