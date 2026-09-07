import { originLabel } from '../../shared/origin.ts';
/**
 * Labels: real text, for tiles large enough to read.
 *
 * DOM on purpose. Text in WebGL is a permanent fight; in DOM it is crisp,
 * pixel-aligned, and Tiny5 stays on its grid.
 *
 * **The label is the tile's interior, not a caption stuck to its corner.**
 * It is laid over the whole tile rectangle and its type scales with it, so a
 * tile the operator zoomed to half the screen reads like the comp's
 * DEEP-SPACE RADAR ARRAY card — small meta above, a big title, a status pill —
 * instead of the same 12px line floating in an empty box.
 *
 * Three rules govern everything here:
 *
 * 1. **One unit.** `unit = clamp(floor(w / 100 · 2) / 2, 1, 4)` — Tiny5 is a
 *    pixel face and only scales cleanly by halves, so the unit steps in
 *    halves and every size in the CSS is `calc(<n>px * var(--u))`. Nothing
 *    sets a font size per node.
 * 2. **The shader owns three regions of the tile, and the text keeps out of
 *    all three.** The state stripe takes the left 4.5 %, so the bands start
 *    at `left: 7%`. The bite cuts x 70–100 %, y 30–70 % out of the right
 *    edge, so the middle band is narrow — until tier 4 (320 px), where the
 *    shader has slid the bite out of the tile and the band takes the full
 *    width. The travelling speed band runs the bottom ~10 %, so the column
 *    stops at `bottom: 11%`. And the sigil — the agent's 5×5 mark — owns
 *    x 80–95.5 % of the top ~22 %, so the top band never reaches past 78 %.
 *
 *      ┌───────────────────────────────────────┐
 *      │▌ top  auto     x 7–78 %   K9 AX ·CX │▒│  ← sigil, x 80–95.5 %
 *      │▌ mid  flex 1   x 7–66 %        ▐█████│  ← bite, x 70–100 %, < 320 px
 *      │▌               (x 7–96 % from 320 px)│
 *      │▌ bot  auto     x 7–96 %  NOW ────────│
 *      │▌                $ TOK/S UP TURNS [P] │
 *      │▌ (shader's speed band, 0–10 %)       │
 *      └───────────────────────────────────────┘
 *
 *    The three bands are a flex column, not three boxes at fixed heights.
 *    The bottom band is sized by what it holds, so NOW and the numbers are
 *    never cut by a percentage that was right at one zoom and wrong at the
 *    next; the middle takes what is left and clamps its lines.
 *
 * 3. **NOW lives at the bottom.** It is the line that changes most and the
 *    one the bite used to cut to eleven characters. Downstairs it gets the
 *    full 89 % and one clean line; the mission gets the two lines it needs
 *    upstairs. The status pill left the top-right corner — that corner is
 *    the sigil's now — and rides the right end of the metrics row, the way
 *    the comp puts `OFFLINE` under a card's title rather than over it.
 *
 * What appears is a ladder against the tile's width in pixels: callsign,
 * then the title or the mission, then what it is doing right now, then its
 * numbers, then the status pill and the machine it runs on.
 */

import type { Agent } from '../../shared/types.ts';
import { islandOf } from '../../shared/workspaces.ts';
import { esc, money, nameOf, plain, runtimeCode, tokens } from '../util.ts';

export interface LabelItem {
  agent: Agent;
  /** Top-left of the tile on screen, and its screen size. */
  sx: number; sy: number; w: number; h: number;
  /** True when focus mode must spare this label: selected, or a neighbour. */
  sel?: boolean;
  /**
   * True when this tile is *in the selection* — not merely next to it. Focus
   * spares a neighbour (`sel`); only the real selection wears the four corner
   * ticks, or a selection of one would light up half the region.
   */
  selected?: boolean;
  /**
   * True when the shader inverted this tile to full amber — a block with a
   * pending escalation. Only then does the ink go black: a blocked tile the
   * console cannot clear keeps a dark body, and black text on it is a label
   * nobody can read. The field decides this, because the field decides amber.
   */
  amber?: boolean;
}

export interface LabelsHandle {
  update(items: LabelItem[]): void;
  /**
   * Focus mode dims the whole layer with one class, not one label at a time:
   * at a thousand labels, per-node opacity is a layout thrash.
   */
  setFocus(on: boolean): void;
  dispose(): void;
}

const MAX = 480;

/**
 * The ladder, in tile pixels. Each rung buys one more thing to read:
 *
 *   1 ·  44  callsign + project code
 *   2 · 112  + runtime chip, and the title or the mission in two lines
 *   3 · 190  + what it is doing right now, one line along the bottom
 *   4 · 320  + the mission under the title, and the four numbers
 *   5 · 520  + status pill and the runtime · model · machine line
 */
export const TIER_PX = [44, 112, 190, 320, 520] as const;

function tierOf(w: number): number {
  let t = 1;
  for (let i = 1; i < TIER_PX.length; i++) if (w >= TIER_PX[i]!) t = i + 1;
  return t;
}

/**
 * The type unit. Tiny5 is a 5px pixel face: it is sharp at integer and half
 * multiples and mud in between, so the unit steps in halves and rounds *down*
 * — a tile is allowed to leave a little air, never to overflow.
 */
function unitOf(w: number): number {
  return Math.min(4, Math.max(1, Math.floor((w / 100) * 2) / 2));
}

/**
 * Emoji, variation selectors and joiners, out. Neither Tiny5 nor Geist Mono
 * has them, so every one an agent writes lands as a `□` under the NOW line.
 * A missing glyph is not decoration: it is a hole that reads as data.
 */
const TOFU = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200D\uFE0E\uFE0F]/gu;
/**
 * Markdown goes with them (`plain`): `**No he podido escribir**` on a tile is
 * two asterisks the operator has to read past before the word.
 */
function clean(s: string | null | undefined): string {
  const t = plain(s);
  if (!t) return '';
  TOFU.lastIndex = 0;
  if (!TOFU.test(t)) return t;
  TOFU.lastIndex = 0;
  return t.replace(TOFU, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Uptime in one token. `dur()` writes `2H 56M`, which is right in a window and
 * two words too many in a cell a quarter of a tile wide.
 */
function uptime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}S`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}M`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}H`;
  return `${Math.round(h / 24)}D`;
}

/** `claude-sonnet-4-5-20250929` → `SONNET-4-5`. The date is not information. */
function shortModel(m: string | null): string {
  if (!m) return '';
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-latest$/, '').toUpperCase();
}

/**
 * The pill's word. `stateWord` writes `WAITING ON K9`, which is right in a
 * window header and too long for the end of the metrics row; a peer wait says
 * `WAITING` and the pipe says who.
 */
function pillWord(a: Agent): string {
  if (a.state !== 'blocked') return a.state.toUpperCase();
  return a.block?.kind === 'peer' ? 'WAITING' : 'NEEDS YOU';
}

/** Which `.status` variant the pill wears. The amber discipline decides. */
function pillClass(a: Agent): string {
  if (a.state === 'dead') return ' is-dead';
  if (a.state === 'blocked') return a.block?.kind === 'peer' ? '' : ' is-alert';
  if (a.state === 'working') return ' is-on';
  return '';
}

/**
 * Claude Code names a session after the directory it started in, so the title
 * of half the fleet is the project again — `axolots-25` on a tile that already
 * says `AX`. A title that opens with the project's name or code says nothing
 * the top band did not, so it goes and the mission takes its place. With no
 * mission it is painted anyway: a redundant fact beats a hole.
 */
function echoesProject(a: Agent, title: string): boolean {
  const t = title.toLowerCase();
  const n = (names.get(islandOf(a)) ?? '').toLowerCase();
  if (n && t.startsWith(n)) return true;
  const c = (codes.get(islandOf(a)) ?? '').toLowerCase();
  return c.length > 0 && t.startsWith(c);
}

/**
 * What the middle band says. `head` is the big line — the agent's name
 * (`nameOf`: the title, or the mission when the title is the brief or a bare
 * id), or the mission when the title only echoed the project; `sub` is the
 * mission under it, and exists only once the tile is wide enough to carry
 * both and the mission is not already the head.
 */
interface MidText { head: string; sub: string }
function midText(a: Agent, tier: number): MidText {
  if (tier < 2) return { head: '', sub: '' };
  const raw = clean(nameOf(a));
  const mission = clean(a.mission);
  const title = raw && echoesProject(a, raw) ? '' : raw;
  const head = title || mission || raw;
  const sub = tier >= 4 && head && mission && mission !== head ? mission : '';
  return { head, sub };
}

/**
 * The rung cascade (§6.4). Crossing a `TIER_PX` upward makes the interior
 * elements *that rung just added* appear one after another, 30 ms apart, by
 * cut. The stepper hands each of them its index; the CSS does the timing with
 * `steps(1)` and `animation-delay`, so nothing here runs a frame loop.
 * Going down is a cut: `from` is `Infinity` and every element comes back bare.
 */
type Step = (appearsAt: number) => string;
function stepper(from: number): Step {
  let i = 0;
  return (appearsAt) => (appearsAt > from ? ` data-rung style="--i:${i++}"` : '');
}

export function createLabels(layer: HTMLElement): LabelsHandle {
  interface Rec { el: HTMLElement; sig: string; tier: number; base: string; sel: boolean }
  const live = new Map<string, Rec>();
  const pool: HTMLElement[] = [];

  function take(): HTMLElement {
    const el = pool.pop();
    if (el) { el.hidden = false; return el; }
    const d = document.createElement('div');
    d.className = 'lbl';
    layer.appendChild(d);
    return d;
  }

  /** The NOW line: the tool it is in, the question it is stuck on, or its last word. */
  function nowLine(a: Agent): string {
    if (a.state === 'working' && a.tool) return `<b>${esc(a.tool)}</b>${esc(clean(a.toolDetail))}`;
    if (a.state === 'blocked' && a.block) return `<b>${esc(a.block.kind)}</b>${esc(clean(a.block.summary))}`;
    if (a.lastSay) return esc(clean(a.lastSay));
    return '';
  }

  /**
   * Four columns that never move, so the eye finds a number where it left it.
   * A column with nothing honest to say in the current state — tokens/sec on
   * an agent that is not working — paints an em dash in `--ink-faint`. A `0`
   * there is a lie: it reads as "measured, and it is zero".
   */
  function metrics(a: Agent, s: Step): string {
    const m = a.metrics;
    const cell = (v: string, k: string, nil = false) =>
      `<div class="lbl__m"${s(4)}>`
      + `<span class="lbl__mv${nil ? ' is-nil' : ''}">${esc(v)}</span>`
      + `<span class="lbl__mk">${k}</span></div>`;
    const rate = a.state === 'working';
    return `<div class="lbl__grid">`
      + cell(money(m.costUSD), 'COST')
      + cell(rate ? tokens(Math.round(m.tokensPerSec)) : '—', 'TOK/S', !rate)
      + cell(uptime(a.uptimeMs), 'UPTIME')
      + cell(String(m.turns), 'TURNS')
      + `</div>`;
  }

  /**
   * Three bands and the selection ticks, always in this order in the DOM so
   * the browser never reflows one into another: the bands are absolutely
   * placed against the tile rectangle, and the selection's four corner ticks
   * cost two `<i>` nodes (the other two are pseudo-elements) that sit hidden
   * until the tile is selected — far cheaper than rewriting five hundred
   * interiors every time the selection moves.
   */
  function content(a: Agent, tier: number, from: number, m: MidText): string {
    const rt = runtimeCode(a);
    const s = stepper(from);

    /* ── Top band: 0–30 %, x 7–78 % — the sigil owns the corner. ────── */
    let top = '';
    if (tier >= 5) {
      const meta = [rt === 'CL' ? 'CLAUDE' : rt, shortModel(a.model), machineName(a)]
        .filter(Boolean).join(' · ');
      if (meta) top += `<div class="lbl__meta"${s(5)}>${esc(meta)}</div>`;
    }
    // CAPCOM belongs to no project and is named by what it is: CAPCOM, then
    // its callsign and COMMAND where a worker shows its project and origin.
    const cap = a.role === 'capcom';
    const where = cap ? `${esc(a.callsign)} · COMMAND` : `${esc(projectCode(a))} · ${originLabel(a)}`;
    top += `<div class="lbl__row"${s(1)}><span class="lbl__cs">${cap ? 'CAPCOM' : esc(a.callsign)}</span>`
      + `<span class="lbl__pj">${where}</span>`
      + (tier >= 2 && tier < 5 && rt !== 'CL' ? `<span class="lbl__rt"${s(2)}>${rt}</span>` : '')
      + `</div>`;

    /* ── Middle band: 31–68 %, x 7–66 % — the bite lives here. ─────── */
    let mid = '';
    if (m.head) mid += `<div class="lbl__title"${s(2)}>${esc(m.head)}</div>`;
    if (m.sub) mid += `<div class="lbl__mission"${s(4)}>${esc(m.sub)}</div>`;

    /* ── Bottom band: 69–89 %, x 7–96 % — NOW, then the numbers. ───── */
    let bot = '';
    if (tier >= 3) {
      const now = nowLine(a);
      if (now) bot += `<div class="lbl__now"${s(3)}>${now}</div>`;
    }
    if (tier >= 4) {
      bot += `<div class="lbl__foot">` + metrics(a, s)
        + (tier >= 5 ? `<span class="lbl__pill status${pillClass(a)}"${s(5)}>${esc(pillWord(a))}</span>` : '')
        + `</div>`;
    }

    return `<div class="lbl__col"><div class="lbl__top">${top}</div>`
      + (mid ? `<div class="lbl__mid">${mid}</div>` : '')
      + (bot ? `<div class="lbl__bot">${bot}</div>` : '')
      + `</div><i class="lbl__c"></i><i class="lbl__c"></i>`;
  }

  return {
    update(items) {
      const want = new Set<string>();
      let shown = 0;
      for (const it of items) {
        if (shown >= MAX) break;
        const a = it.agent;
        const tier = tierOf(it.w);
        const unit = unitOf(it.w);
        const amber = it.amber === true;
        const selected = it.selected === true;
        want.add(a.id);
        shown++;
        let rec = live.get(a.id);
        if (!rec) { rec = { el: take(), sig: '', tier: 0, base: 'lbl', sel: false }; live.set(a.id, rec); }
        // The tier and the unit are part of the signature: crossing a rung or
        // a half-step is the only thing that may rewrite the interior. The
        // transform and the box run every frame; this does not. The project's
        // name and code are in it too — they decide whether the title is an
        // echo, and they can land after the label already exists.
        const sig = `${a.origin}|${a.role}|${tier}|${unit}|${amber ? 'A' : ''}|${a.state}|${a.block?.kind ?? ''}|${a.title}|${a.mission}|${a.tool}|${a.toolDetail}|${a.lastSay}|${a.callsign}|${projectCode(a)}|${names.get(islandOf(a)) ?? ''}`
          + (tier >= 4 ? `|${a.metrics.costUSD.toFixed(2)}|${Math.round(a.metrics.tokensPerSec)}|${Math.round(a.uptimeMs / 1000)}|${a.metrics.turns}` : '')
          + (tier >= 5 ? `|${a.model}|${a.machineId}` : '');
        if (sig !== rec.sig) {
          // A label that did not exist a frame ago is not climbing a rung: it
          // arrives whole. Only a live label that gained a tier cascades.
          const from = rec.sig ? rec.tier : Infinity;
          const climbed = tier > from;
          const mid = midText(a, tier);
          rec.sig = sig;
          rec.tier = tier;
          rec.el.innerHTML = content(a, tier, from, mid);
          rec.base = 'lbl'
            + ` t-${tier}`
            + (a.role === 'capcom' ? ' is-capcom' : '')
            + (mid.sub ? ' has-mission' : '')
            + (amber ? ' is-blocked' : '')
            + (a.state === 'dead' ? ' is-dead' : '')
            + (a.state === 'done' ? ' is-done' : '')
            // The command at rest is not dim: it is waiting for you.
            + (a.state === 'idle' && a.role !== 'capcom' ? ' is-dim' : '')
            + (climbed ? ' is-rung' : '');
          rec.el.className = rec.base + (selected ? ' is-sel' : '');
          rec.sel = selected;
          rec.el.style.setProperty('--u', String(unit));
        } else if (selected !== rec.sel) {
          // The corners appear by cut, and the interior is not touched: a
          // selection sweeping the field must not rewrite five hundred nodes.
          rec.sel = selected;
          rec.el.className = rec.base + (selected ? ' is-sel' : '');
        }
        const el = rec.el;
        // `data-sel` is the exception the focus class reads; see field.css.
        if (it.sel) el.dataset.sel = '1'; else delete el.dataset.sel;
        // The label *is* the tile: same origin, same box. Everything inside
        // is placed against those two numbers.
        el.style.transform = `translate3d(${Math.round(it.sx)}px, ${Math.round(it.sy)}px, 0)`;
        el.style.width = `${Math.round(it.w)}px`;
        el.style.height = `${Math.round(it.h)}px`;
      }
      for (const [id, rec] of live) {
        if (want.has(id)) continue;
        rec.el.hidden = true;
        pool.push(rec.el);
        live.delete(id);
      }
    },
    setFocus(on) { layer.classList.toggle('is-focus', on); },

    dispose() {
      layer.innerHTML = '';
      live.clear();
      pool.length = 0;
    },
  };
}

/* ── What the label layer is allowed to know ──────────────────────── */

/**
 * The label layer sees agents, not the world. The field hands it the lookups
 * an agent cannot answer for itself, once per feed, so a label never costs a
 * store round-trip.
 */
const codes = new Map<string, string>();
export function rememberProjectCode(projectId: string, code: string) { codes.set(projectId, code); }
function projectCode(a: Agent): string { return codes.get(islandOf(a)) ?? '??'; }

/**
 * The project's full name, for the echo test only — it is never painted. If
 * the field never calls this, the test falls back to the code alone, which
 * catches `axolots-25` under `AX` and lets a stranger title through.
 */
const names = new Map<string, string>();
export function rememberProjectName(projectId: string, name: string) { names.set(projectId, name); }

const machines = new Map<string, string>();
export function rememberMachine(machineId: string, hostname: string) { machines.set(machineId, hostname); }
function machineName(a: Agent): string {
  const h = machines.get(a.machineId) ?? '';
  // A hostname is a name, not a domain: `air.local` reads as `AIR`.
  return h.split('.')[0]?.toUpperCase() ?? '';
}
