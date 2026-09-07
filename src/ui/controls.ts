/**
 * Instruments — the console's own controls.
 *
 * A native `<select>` opens the operating system's menu: rounded, animated,
 * antialiased, with its own blue highlight and its own cursor. One of those
 * over the field breaks the world harder than any colour ever could. So the
 * console draws its own, out of the same three parts everything else here is
 * made of: Tiny5 labels, mono for what a machine wrote, lime for the one that
 * is chosen.
 *
 * Three of them, and nothing more:
 *
 *   - `pick`   — a dropdown, the `.cmd__menu` of the command line at
 *                instrument scale: a fixed-position menu that opens down or up
 *                depending on where the window is, full keyboard, and a hidden
 *                input so `FormData` still sees a field.
 *   - `toggle` — a switch, the notched tile shrunk to 11 px, lit lime.
 *   - `fold`   — a `<details>` without the browser's triangle: a pixel `+`
 *                that becomes a `−`, and a body that cuts in. Heights do not
 *                animate; palettes cut, shapes ease, and this is neither.
 *
 * Text inputs and textareas stay native — `.input` already dresses them and a
 * caret is the one place the world lets the machine through.
 *
 * ── The gestures (IDENTITY §6.2) ─────────────────────────────────────
 *
 * Every one of them is from the comp, and none of them is a fade:
 *
 *   - `pick` opening: the menu still arrives with `back.out`, and the rows
 *     now **cascade by cut** at 20 ms a row (A1, the POST log). A `--i` on
 *     each row and one `steps(1)` keyframe in hud.css; no JS timeline, so a
 *     list of two hundred options costs nothing.
 *   - `pick` choosing: the chosen row jumps to ink for one frame, falls to
 *     lime, and only then does the menu cut away. The operator sees what
 *     they picked before it disappears.
 *   - `toggle`: the cut is already right; a thin band now runs once across
 *     the 11 px tile in `--t-snap` (A5 at tile scale), clipped by the
 *     notch itself.
 *
 * `prefers-reduced-motion` lands every one of them at its end state: the
 * JS through `dur()` and `REDUCE`, the CSS through its own media query.
 */

import gsap from 'gsap';
import { EASE, REDUCE, T, dur } from './motion.ts';

/* ── pick ───────────────────────────────────────────────────────────── */

export interface PickOption {
  group?: string;
  value: string;
  /** Tiny5, uppercased by CSS. What the operator picks by. */
  label: string;
  /** Mono, to the right. What a machine would have written. */
  hint?: string;
  /** Listed, readable, unselectable. The console never hides what it cannot do. */
  disabled?: boolean;
}

export interface PickOpts {
  /** Name of the hidden input, so a surrounding `<form>` keeps working. */
  name: string;
  options: PickOption[];
  /** Preselected value. Defaults to the first enabled option, or nothing if
   *  `placeholder` is given. */
  value?: string;
  placeholder?: string;
  onChange?(v: string): void;
  /** Show a mono filter line above the menu instead of first-letter jumping. */
  search?: boolean;
}

export interface PickHandle {
  el: HTMLElement;
  value(): string;
  set(v: string): void;
  /** True while the menu is down — a live view must not rebuild under it. */
  isOpen(): boolean;
  dispose(): void;
}

/** How far the menu may grow before it scrolls, and its gap to the button. */
const MENU_MAX = 240;
const MENU_GAP = 4;
/** A type-ahead buffer this old is a new word. */
const TYPE_RESET = 700;

/** `CLAUDE-SONNET-5` → claude, sonnet, 5. What a first letter may mean. */
function words(label: string): string[] {
  return label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function pick(opts: PickOpts): PickHandle {
  const options = opts.options;
  const firstEnabled = options.find((o) => !o.disabled);
  let current = opts.value !== undefined && options.some((o) => o.value === opts.value)
    ? opts.value
    : opts.placeholder
      ? ''
      : firstEnabled?.value ?? '';

  const el = document.createElement('div');
  el.className = 'pick';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pick__btn';
  btn.setAttribute('role', 'combobox');
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  // The visible text is the value, so the field's own name is what a screen
  // reader needs to know which control this is.
  btn.setAttribute('aria-label', opts.name);

  const bLabel = document.createElement('b');
  const bHint = document.createElement('span');
  bHint.className = 'mono';
  const caret = document.createElement('i');
  caret.className = 'pick__caret';
  caret.setAttribute('aria-hidden', 'true');
  btn.append(bLabel, bHint, caret);

  const hidden = document.createElement('input');
  hidden.type = 'hidden';
  hidden.name = opts.name;
  hidden.value = current;

  el.append(btn, hidden);

  /* The menu lives on <body>: a window's glass is `overflow: hidden`, and a
     menu that opens past the last row must not be cut in half by it. */
  const menu = document.createElement('div');
  menu.className = 'pick__menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  let search: HTMLInputElement | null = null;
  if (opts.search) {
    search = document.createElement('input');
    search.type = 'text';
    search.className = 'pick__search mono';
    search.placeholder = 'filter';
    search.autocomplete = 'off';
    search.spellcheck = false;
    menu.appendChild(search);
  }
  const list = document.createElement('div');
  list.className = 'pick__list scroll';
  menu.appendChild(list);

  let open = false;
  let active = 0;
  let shown: PickOption[] = options;
  let typed = '';
  let typedAt = 0;
  let rows: HTMLElement[] = [];
  /** Set for the one paint that follows an open, so a filter does not replay. */
  let cascade = false;
  /** The delayed cut after a choice, so a click elsewhere never leaves it armed. */
  let closing: gsap.core.Tween | null = null;

  function labelOf(v: string): PickOption | undefined {
    return options.find((o) => o.value === v);
  }

  function paintButton() {
    const o = labelOf(current);
    bLabel.textContent = o ? o.label : opts.placeholder ?? '—';
    bHint.textContent = o?.hint ?? '';
    el.classList.toggle('is-empty', !o);
  }

  function paintList() {
    list.textContent = '';
    let lastGroup: string | undefined;
    rows = shown.map((o, i) => {
      if (o.group && o.group !== lastGroup) {
        const group = document.createElement('div'); group.className = 'pick__group px'; group.setAttribute('role', 'presentation'); group.textContent = o.group; list.appendChild(group); lastGroup = o.group;
      }
      const row = document.createElement('div');
      row.className = 'pick__item';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(o.value === current));
      if (o.disabled) {
        row.classList.add('is-off');
        row.setAttribute('aria-disabled', 'true');
      }
      if (o.value === current) row.classList.add('is-cur');
      if (i === active) row.classList.add('is-sel');
      // The cascade reads its step from here: one custom property, no timeline.
      row.style.setProperty('--i', String(i));
      const b = document.createElement('b');
      b.textContent = o.label;
      const s = document.createElement('span');
      s.className = 'mono';
      s.textContent = o.hint ?? '';
      row.append(b, s);
      // mousedown, not click: the button must not lose focus before we commit.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (o.disabled) return;
        choose(o, row);
      });
      row.addEventListener('mousemove', () => {
        if (o.disabled || active === i) return;
        active = i;
        paintActive();
      });
      list.appendChild(row);
      return row;
    });
    if (!shown.length) {
      const none = document.createElement('div');
      none.className = 'pick__none px px--tiny';
      none.textContent = 'NOTHING MATCHES';
      list.appendChild(none);
    }
    // Only the paint that follows an open cascades; filtering is a cut, because
    // rows that re-deal themselves on every keystroke read as a slot machine.
    menu.classList.toggle('is-cascade', cascade);
    cascade = false;
  }

  /**
   * A choice, with the comp's local flash: ink for one frame, lime for the
   * length of a snap, and then the menu cuts away — never a fade, and never
   * so fast that the operator cannot see which row answered.
   */
  function choose(o: PickOption, row?: HTMLElement, after?: () => void) {
    commit(o.value);
    const done = () => { close(); after?.(); };
    if (!row || REDUCE.value) { done(); return; }
    row.classList.add('is-hit');
    requestAnimationFrame(() => {
      row.classList.remove('is-hit');
      row.classList.add('is-took');
      closing = gsap.delayedCall(dur(T.snap), done);
    });
  }

  function paintActive() {
    rows.forEach((r, i) => r.classList.toggle('is-sel', i === active));
    rows[active]?.scrollIntoView({ block: 'nearest' });
  }

  function place() {
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.width = `${Math.round(r.width)}px`;
    menu.style.top = '0px';
    menu.style.bottom = 'auto';
    const h = Math.min(menu.offsetHeight, MENU_MAX + 40);
    const below = window.innerHeight - r.bottom - MENU_GAP;
    const up = below < h && r.top > below;
    if (up) {
      menu.style.top = 'auto';
      menu.style.bottom = `${Math.round(window.innerHeight - r.top + MENU_GAP)}px`;
    } else {
      menu.style.top = `${Math.round(r.bottom + MENU_GAP)}px`;
    }
    return up;
  }

  function filter(q: string) {
    const s = q.trim().toLowerCase();
    shown = s
      ? options.filter((o) => o.label.toLowerCase().includes(s) || (o.hint ?? '').toLowerCase().includes(s))
      : options;
    active = Math.max(0, shown.findIndex((o) => o.value === current && !o.disabled));
    if (shown[active]?.disabled) active = Math.max(0, shown.findIndex((o) => !o.disabled));
    cascade = false;
    paintList();
  }

  function openMenu() {
    if (open || !options.length) return;
    open = true;
    btn.setAttribute('aria-expanded', 'true');
    el.classList.add('is-open');
    shown = options;
    active = options.findIndex((o) => o.value === current);
    if (active < 0 || options[active]?.disabled) active = Math.max(0, options.findIndex((o) => !o.disabled));
    if (search) search.value = '';
    cascade = true;
    paintList();
    document.body.appendChild(menu);
    menu.hidden = false;
    const up = place();
    paintActive();
    // Arrival, the console's: it grows into place and does not fade in.
    gsap.fromTo(menu,
      { scale: 0.96 },
      { scale: 1, duration: dur(T.snap), ease: EASE.arrive, transformOrigin: up ? 'left bottom' : 'left top' });
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('focusin', onOutside, true);
    window.addEventListener('resize', close);
    window.addEventListener('wheel', onWheel, { passive: true });
    if (search) search.focus();
  }

  function close() {
    if (!open) return;
    open = false;
    btn.setAttribute('aria-expanded', 'false');
    el.classList.remove('is-open');
    closing?.kill();
    closing = null;
    gsap.killTweensOf(menu);
    menu.hidden = true;
    menu.remove();
    typed = '';
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('focusin', onOutside, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('wheel', onWheel);
  }

  /** The field pans on wheel; a menu that stayed open would float over it.
   *  Scrolling the menu's own list is not that. */
  function onWheel(e: Event) {
    const t = e.target as Node | null;
    if (t && menu.contains(t)) return;
    close();
  }

  function onOutside(e: Event) {
    const t = e.target as Node | null;
    if (t && (el.contains(t) || menu.contains(t))) return;
    close();
  }

  function commit(v: string) {
    if (v === current) return;
    current = v;
    hidden.value = v;
    paintButton();
    // A real `change`, so a form or an outside listener never learns our API.
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
    opts.onChange?.(v);
  }

  function step(d: number) {
    if (!shown.length) return;
    let i = active;
    for (let n = 0; n < shown.length; n++) {
      i = (i + d + shown.length) % shown.length;
      if (!shown[i]!.disabled) { active = i; paintActive(); return; }
    }
  }

  function jump(ch: string) {
    const now = Date.now();
    typed = now - typedAt > TYPE_RESET ? ch : typed + ch;
    typedAt = now;
    // The label first; then any word inside it, because in a list where every
    // row begins with `claude-` the first letter would otherwise answer nothing
    // — and what the operator means by `s` there is `sonnet`.
    let i = shown.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed));
    if (i < 0) i = shown.findIndex((o) => !o.disabled && words(o.label).some((w) => w.startsWith(typed)));
    if (i >= 0) { active = i; paintActive(); }
  }

  function onKey(e: KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        openMenu();
        return;
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); e.stopPropagation();
        openMenu();
        if (search) { search.value = e.key; filter(search.value); } else jump(e.key.toLowerCase());
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      step(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter' || (e.key === ' ' && !search)) {
      e.preventDefault(); e.stopPropagation();
      const o = shown[active];
      if (o && !o.disabled) choose(o, rows[active], () => btn.focus());
      else { close(); btn.focus(); }
      return;
    }
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.stopPropagation();
      if (e.key === 'Escape') e.preventDefault();
      close();
      if (e.key === 'Escape') btn.focus();
      return;
    }
    if (!search && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      jump(e.key.toLowerCase());
    }
  }

  btn.addEventListener('click', (e) => { e.preventDefault(); if (open) { close(); } else openMenu(); });
  btn.addEventListener('keydown', onKey);
  menu.addEventListener('keydown', onKey);
  search?.addEventListener('input', () => filter(search!.value));
  btn.addEventListener('blur', () => { if (open && !search) window.setTimeout(() => { if (!menu.contains(document.activeElement)) close(); }, 0); });

  paintButton();

  return {
    el,
    value: () => current,
    isOpen: () => open,
    set(v: string) {
      if (!options.some((o) => o.value === v)) return;
      current = v;
      hidden.value = v;
      paintButton();
      if (open) paintList();
    },
    dispose() { close(); el.remove(); },
  };
}

/* ── toggle ─────────────────────────────────────────────────────────── */

export interface ToggleOpts {
  name: string;
  label: string;
  checked?: boolean;
  onChange?(on: boolean): void;
}

export interface ToggleHandle {
  el: HTMLElement;
  checked(): boolean;
  set(on: boolean): void;
  dispose(): void;
}

/**
 * A switch drawn as the world's tile: 11 px with the bite out of its right
 * edge, dark when off, lime when on. The hidden input carries `on` so
 * `FormData` reads it exactly the way it read a checkbox.
 *
 * The flip is a cut, as it always was. What is new is the band: a hairline
 * that runs once across the tile in `--t-snap` (A5 at 11 px), clipped by the
 * notch itself, so a switch reports the same way the field does. Only the
 * operator's own click runs it; `set()` is somebody else's decision.
 */
export function toggle(opts: ToggleOpts): ToggleHandle {
  let on = !!opts.checked;

  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'tgl';
  el.setAttribute('role', 'switch');
  el.setAttribute('aria-checked', String(on));

  const box = document.createElement('i');
  box.className = 'tgl__box';
  box.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'px';
  text.textContent = opts.label;
  const hidden = document.createElement('input');
  hidden.type = 'hidden';
  hidden.name = opts.name;
  hidden.value = on ? 'on' : '';
  el.append(box, text, hidden);

  function paint() {
    el.classList.toggle('is-on', on);
    el.setAttribute('aria-checked', String(on));
    hidden.value = on ? 'on' : '';
  }

  /** Restart the band: an animation only replays if the class actually left. */
  function band() {
    if (REDUCE.value) return;
    box.classList.remove('is-band');
    void box.offsetWidth;
    box.classList.add('is-band');
  }
  box.addEventListener('animationend', () => box.classList.remove('is-band'));

  el.addEventListener('click', () => {
    on = !on;
    paint();
    band();
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
    opts.onChange?.(on);
  });
  // Space scrolls a page by default; here it is the switch.
  el.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); el.click(); }
  });

  paint();

  return {
    el,
    checked: () => on,
    set(v: boolean) { on = v; paint(); },
    dispose() { el.remove(); },
  };
}

/* ── fold ───────────────────────────────────────────────────────────── */

export interface FoldOpts {
  label: string;
  open?: boolean;
  /** An element, or HTML the caller has already escaped. */
  body: HTMLElement | string;
  /** So a view that rebuilds itself can put the fold back the way it was. */
  onToggle?(open: boolean): void;
}

/**
 * `<details>` without the browser's triangle. The body cuts in and out: a
 * height that animates is a transition, and the contract says a state flip is
 * one frame.
 */
export function fold(opts: FoldOpts): HTMLElement {
  const el = document.createElement('div');
  el.className = 'fold';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'fold__k px px--tiny';
  head.setAttribute('aria-expanded', String(!!opts.open));
  const sign = document.createElement('i');
  sign.className = 'fold__sign';
  sign.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = opts.label;
  head.append(sign, text);

  const body = document.createElement('div');
  body.className = 'fold__body';
  if (typeof opts.body === 'string') body.innerHTML = opts.body;
  else body.appendChild(opts.body);
  body.hidden = !opts.open;

  el.classList.toggle('is-open', !!opts.open);
  head.addEventListener('click', () => {
    const now = body.hidden;
    body.hidden = !now;
    el.classList.toggle('is-open', now);
    head.setAttribute('aria-expanded', String(now));
    opts.onToggle?.(now);
  });
  head.addEventListener('keydown', (e) => { if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); head.click(); } });

  el.append(head, body);
  return el;
}

/* ── level ──────────────────────────────────────────────────────────── */

export interface LevelOpts {
  /** Cells in the bar. Ten, like the sound board's master. */
  steps?: number;
  /** 0 … 1. */
  value: number;
  /** For the screen reader. */
  label: string;
  /** What the number beside the bar says for a value. */
  format?(v: number): string;
  onChange?(v: number): void;
}

export interface LevelHandle {
  el: HTMLElement;
  get(): number;
  /** Somebody else moved it; repaint without firing `onChange`. */
  set(v: number): void;
}

/**
 * A level: the sound board's master, generalised. Ten cells lit from the
 * left, a number beside them, pointer to set, arrows to nudge. It reports by
 * cut, like every instrument here — a cell is lit or it is not.
 */
export function level(opts: LevelOpts): LevelHandle {
  const steps = opts.steps ?? 10;
  const wrap = document.createElement('div');
  wrap.className = 'lvl';
  const bar = document.createElement('div');
  bar.className = 'vol';
  bar.setAttribute('role', 'slider');
  bar.tabIndex = 0;
  bar.setAttribute('aria-label', opts.label);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(steps));
  const cells: HTMLElement[] = [];
  for (let i = 0; i < steps; i++) {
    const cell = document.createElement('i');
    cell.className = 'vol__cell';
    cell.setAttribute('aria-hidden', 'true');
    bar.appendChild(cell);
    cells.push(cell);
  }
  const n = document.createElement('span');
  n.className = 'mono vol__n';
  wrap.append(bar, n);

  let value = clamp01(opts.value);
  const fmt = opts.format ?? ((v: number) => `${Math.round(v * 100)}%`);

  function paint() {
    const step = Math.round(value * steps);
    cells.forEach((cell, i) => cell.classList.toggle('is-lit', i < step));
    bar.setAttribute('aria-valuenow', String(step));
    n.textContent = fmt(value);
  }
  function stepAt(clientX: number): number {
    const r = bar.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return Math.min(steps, Math.max(0, Math.ceil(((clientX - r.left) / r.width) * steps)));
  }
  function setStep(k: number) {
    const v = Math.min(steps, Math.max(0, k)) / steps;
    if (v === value) return;
    value = v;
    paint();
    opts.onChange?.(value);
  }
  bar.addEventListener('pointerdown', (e) => { bar.setPointerCapture(e.pointerId); setStep(stepAt(e.clientX)); });
  bar.addEventListener('pointermove', (e) => { if (bar.hasPointerCapture(e.pointerId)) setStep(stepAt(e.clientX)); });
  bar.addEventListener('keydown', (e) => {
    const at = Math.round(value * steps);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setStep(at + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setStep(at - 1); }
    else if (e.key === 'Home') { e.preventDefault(); setStep(0); }
    else if (e.key === 'End') { e.preventDefault(); setStep(steps); }
  });
  paint();

  return {
    el: wrap,
    get: () => value,
    set(v) { value = clamp01(v); paint(); },
  };
}

function clamp01(v: number): number { return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)); }
