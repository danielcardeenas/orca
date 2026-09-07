/**
 * The command line: one input, always there.
 *
 *   anything              → the CEO
 *   @K9 fix the tests     → that agent
 *   @LZ stop and report   → every live agent in that project
 *   /spawn /find /frame /queue /ceo /feed /fleet /tilt /help /stop /clear
 *
 * A lasso selection becomes the target chip, and Enter sends to all of it.
 * `@` and `/` open a menu; Tab completes; ↑↓ walk history.
 *
 * ── Motion (IDENTITY §6.3) ───────────────────────────────────────────
 *
 *   - **The chip changing target.** `CAPCOM` → `@K9` cuts to the new colour
 *     with one frame of ink in front of it. `UNKNOWN` is red, and red does
 *     not animate: the chip going bad is a cut and nothing else.
 *   - **Sending.** A5 at line scale: a lime bar wipes the typed text left to
 *     right in `T.quick`, the ink inverting to `#1a0000` as it passes, and
 *     the line clears by cut when it lands. The wipe is an overlay `<i>` over
 *     the input, never the input itself — a native caret is the one place the
 *     world lets the machine through, and a tween on it would be felt. The
 *     input is read-only for those 280 ms so the text the wipe is eating is
 *     still the text that is there, and `run()` fires in the same frame, so
 *     the pulse in the field leaves at the moment the wipe starts.
 *   - **The `/` menu.** Rows cascade by cut at 30 ms (A1); moving the
 *     selection is a cut, so the list only re-deals when the items change.
 */

import gsap from 'gsap';
import type { Agent, Project } from '../../shared/types.ts';
import { store } from '../store.ts';
import { hub } from '../net/client.ts';
import type { Console } from '../console.ts';
import { esc } from '../util.ts';
import { squadsOf } from '../../shared/squads.ts';
import { getSound } from './sound.ts';
import { EASE, REDUCE, T, dur } from '../motion.ts';
import { toggleFullscreen } from './fullscreen.ts';
import { drafts, draftKey } from '../drafts.ts';

interface Target {
  kind: 'ceo' | 'agent' | 'project' | 'squad' | 'group' | 'bad' | 'cmd';
  label: string;
  ids: string[];
}

const COMMANDS: { name: string; help: string }[] = [
  { name: 'spawn', help: 'launch an agent · /spawn [project]' },
  { name: 'find', help: 'fly to an agent · /find K9' },
  { name: 'term', help: 'open an agent’s terminal · /term K9' },
  { name: 'frame', help: 'frame the fleet, or a project · /frame [LZ]' },
  { name: 'queue', help: 'what is waiting on you' },
  { name: 'ceo', help: 'talk to CAPCOM, the command session' },
  { name: 'capcom-new', help: 'New CAPCOM · /capcom-new clean|continuity · same provider/model' },
  { name: 'capcom', help: 'talk to CAPCOM, the command session' },
  { name: 'feed', help: 'telemetry' },
  { name: 'fleet', help: 'machines, projects, everyone' },
  { name: 'tilt', help: 'tilt the field to see depth' },
  { name: 'full', help: 'take the whole screen · Z' },
  { name: 'deck', help: 'sort every tile into one grid · /deck state|project|cost|age' },
  { name: 'gallery', help: 'everything the fleet has made' },
  { name: 'launch', help: 'launch a saved fleet · /launch audit' },
  { name: 'timeline', help: 'the last 24 h, and what happened while you were away' },
  { name: 'sfx', help: 'the sound board · audition and assign clips' },
  { name: 'music', help: 'background music · bandcamp or spotify' },
  { name: 'stop', help: 'stop an agent · /stop K9 sure' },
  { name: 'dismiss', help: 'hide from the field · /dismiss K9 · /dismiss finished · /dismiss clear' },
  { name: 'clear', help: 'drop the selection' },
  { name: 'settings', help: 'the console’s knobs · panel brightness' },
  { name: 'hygiene', help: 'what ORCA costs this machine · disk, load, what could be reclaimed' },
  { name: 'help', help: 'keys and commands' },
];

export interface CommandHandle {
  focus(): void;
  blur(): void;
  setSelection(ids: string[]): void;
  isFocused(): boolean;
}

export function mountCommand(host: HTMLElement, c: Console): CommandHandle {
  const el = document.createElement('div');
  el.className = 'cmd';
  el.innerHTML = `
    <span class="cmd__prompt">&gt;</span>
    <input class="cmd__in mono" data-in autocomplete="off" spellcheck="false" placeholder="talk to capcom · @K9 to an agent · @LZ to a project · @audit-01 to a squad · / for commands · ⌘K" />
    <span class="cmd__target is-ceo" data-target>CAPCOM</span>
    <i class="cmd__wipe mono" data-wipe aria-hidden="true"></i>
    <div class="cmd__menu" data-menu></div>
  `;
  host.appendChild(el);
  const input = el.querySelector<HTMLInputElement>('[data-in]')!;
  const chip = el.querySelector<HTMLElement>('[data-target]')!;
  const menu = el.querySelector<HTMLElement>('[data-menu]')!;
  const wipe = el.querySelector<HTMLElement>('[data-wipe]')!;
  // The unsent line survives a reload (drafts.ts); paintTarget() below reads it.
  const draft = drafts.bind(input, draftKey('command'));
  draft.restore();
  let selection: string[] = [];
  const history: string[] = [];
  let hIdx = -1;
  let menuItems: { insert: string; label: string; help: string }[] = [];
  let menuSel = 0;
  /** What the chip last said, so a repaint that changes nothing flashes nothing. */
  let chipWas = '';
  /** The items the menu is currently showing, so moving the cursor is a cut. */
  let menuWas = '';
  let wiping: gsap.core.Tween | null = null;

  function agents(): Agent[] { return Object.values(store.world.agents); }
  function projects(): Project[] { return Object.values(store.world.projects); }
  function live(a: Agent) { return a.state !== 'done' && a.state !== 'dead'; }

  function resolve(token: string): Target {
    const t = token.toUpperCase();
    const a = agents().find((x) => x.callsign.toUpperCase() === t);
    if (a) return { kind: 'agent', label: `@${a.callsign} ${a.state === 'blocked' ? '· BLOCKED' : ''}`, ids: [a.id] };
    const p = projects().find((x) => x.code.toUpperCase() === t || x.name.toUpperCase() === t);
    if (p) {
      const ids = agents().filter((x) => x.projectId === p.id && live(x)).map((x) => x.id);
      return { kind: 'project', label: `@${p.code} · ${ids.length} LIVE`, ids };
    }
    const sq = squadsOf(store.world.agents).find((x) => x.name.toUpperCase() === t);
    if (sq) {
      const ids = sq.memberIds.filter((id) => { const x = store.world.agents[id]; return !!x && live(x); });
      const lead = sq.leaderId ? store.world.agents[sq.leaderId]?.callsign : null;
      return { kind: 'squad', label: `@${sq.name} · ${ids.length}${lead ? ` · LEAD ${lead}` : ''}`, ids };
    }
    return { kind: 'bad', label: `@${token} · UNKNOWN`, ids: [] };
  }

  function parse(text: string): { target: Target; body: string } {
    const s = text.trimStart();
    if (s.startsWith('/')) return { target: { kind: 'cmd', label: `/${s.slice(1).split(' ')[0] ?? ''}`.toUpperCase(), ids: [] }, body: s.slice(1) };
    if (s.startsWith('@')) {
      const sp = s.indexOf(' ');
      const token = sp < 0 ? s.slice(1) : s.slice(1, sp);
      return { target: resolve(token), body: sp < 0 ? '' : s.slice(sp + 1) };
    }
    if (selection.length === 1) { const a = store.world.agents[selection[0]!]; if (a) return { target: { kind: 'agent', label: `@${a.callsign}`, ids: selection }, body: s }; }
    if (selection.length) return { target: { kind: 'group', label: `${selection.length} SELECTED`, ids: selection }, body: s };
    return { target: { kind: 'ceo', label: 'CAPCOM', ids: [] }, body: s };
  }

  function paintTarget() {
    const { target } = parse(input.value);
    const kind = target.kind === 'cmd' ? 'ceo' : target.kind;
    const now = `${kind}\u0000${target.label}`;
    if (now === chipWas) return;
    const had = chipWas !== '';
    chipWas = now;
    chip.textContent = target.label;
    chip.className = `cmd__target is-${kind}`;
    // The cut is the class above. The flash is the frame in front of it — and
    // never for red: a target the console cannot find sits still, so it reads.
    if (!had || kind === 'bad' || REDUCE.value) return;
    chip.classList.add('is-flash');
    requestAnimationFrame(() => chip.classList.remove('is-flash'));
  }

  /**
   * A5 at line scale. The overlay carries the same text in the same face at
   * the same place, on lime, and a clip reveals it left to right; the input
   * underneath still holds what has not been eaten yet. When the bar lands,
   * the line clears by cut and the overlay goes with it.
   */
  function sendWipe(text: string, done: () => void) {
    wiping?.kill();
    wiping = null;
    if (REDUCE.value || !text) { done(); return; }
    wipe.textContent = text;
    wipe.style.left = `${input.offsetLeft}px`;
    wipe.style.top = `${input.offsetTop}px`;
    wipe.style.width = `${input.offsetWidth}px`;
    wipe.style.height = `${input.offsetHeight}px`;
    wipe.style.clipPath = 'inset(0 100% 0 0)';
    wipe.classList.add('is-on');
    // Read-only, not disabled: the caret stays, and so does the text the bar
    // is eating. Anything else and the operator watches a wipe over nothing.
    input.readOnly = true;
    const p = { v: 0 };
    const land = () => {
      wiping = null;
      input.readOnly = false;
      wipe.classList.remove('is-on');
      wipe.textContent = '';
      done();
    };
    wiping = gsap.to(p, {
      v: 1,
      duration: dur(T.quick),
      ease: EASE.inout,
      onUpdate: () => { wipe.style.clipPath = `inset(0 ${(1 - p.v) * 100}% 0 0)`; },
      onComplete: land,
      onInterrupt: land,
    });
  }

  function paintMenu() {
    const s = input.value.trimStart();
    menuItems = [];
    if (s.startsWith('/') && !s.includes(' ')) {
      const q = s.slice(1).toLowerCase();
      menuItems = COMMANDS.filter((x) => x.name.startsWith(q)).map((x) => ({ insert: `/${x.name} `, label: `/${x.name}`, help: x.help }));
    } else if (s.startsWith('@') && !s.includes(' ')) {
      const q = s.slice(1).toUpperCase();
      const as = agents().filter((a) => live(a) && a.callsign.toUpperCase().startsWith(q)).slice(0, 8)
        .map((a) => ({ insert: `@${a.callsign} `, label: `@${a.callsign}`, help: `${store.world.projects[a.projectId]?.code ?? ''} · ${a.state} · ${a.title}` }));
      const ps = projects().filter((p) => p.code.toUpperCase().startsWith(q) || p.name.toUpperCase().startsWith(q)).slice(0, 6)
        .map((p) => ({ insert: `@${p.code} `, label: `@${p.code}`, help: `${p.name} · ${p.rollup.total} agents` }));
      const ss = squadsOf(store.world.agents).filter((x) => x.name.toUpperCase().startsWith(q)).slice(0, 6)
        .map((x) => ({ insert: `@${x.name} `, label: `@${x.name}`, help: `squad · ${x.memberIds.length} · lead ${x.leaderId ? store.world.agents[x.leaderId]?.callsign ?? '?' : '—'}` }));
      menuItems = [...as, ...ps, ...ss];
    }
    menuSel = Math.min(menuSel, Math.max(0, menuItems.length - 1));
    menu.classList.toggle('is-on', menuItems.length > 0);
    // Walking the list is a cut, not a re-deal: only rebuild when the items
    // themselves changed, and let the cascade belong to a list that is new.
    const key = menuItems.map((m) => m.label).join('\u0000');
    if (key === menuWas) {
      menu.querySelectorAll<HTMLElement>('[data-i]').forEach((d, i) => d.classList.toggle('is-sel', i === menuSel));
      return;
    }
    menuWas = key;
    menu.innerHTML = menuItems.map((m, i) => `<div class="cmd__item ${i === menuSel ? 'is-sel' : ''}" style="--i:${i}" data-i="${i}"><b>${esc(m.label)}</b><span class="mono">${esc(m.help)}</span></div>`).join('');
    menu.classList.remove('is-cascade');
    void menu.offsetWidth;
    if (!REDUCE.value && menuItems.length) menu.classList.add('is-cascade');
    menu.querySelectorAll<HTMLElement>('[data-i]').forEach((d) => d.addEventListener('mousedown', (e) => { e.preventDefault(); accept(Number(d.dataset.i)); }));
  }

  function accept(i: number) {
    const m = menuItems[i];
    if (!m) return;
    input.value = m.insert;
    draft.save();
    menuItems = [];
    menu.classList.remove('is-on');
    menuWas = '';
    paintTarget();
    input.focus();
  }

  async function run(text: string) {
    const { target, body } = parse(text);
    if (target.kind === 'cmd') { await command(body); return; }
    if (!body.trim()) {
      // A bare target opens it.
      if (target.kind === 'agent' && target.ids[0]) { c.go(target.ids[0]); c.openAgent(target.ids[0]); }
      else if (target.kind === 'project') { const tok = text.trim().slice(1); const p = projects().find((x) => x.code.toUpperCase() === tok.toUpperCase() || x.name.toUpperCase() === tok.toUpperCase()); if (p) c.openProject(p.id); }
      else if (target.kind === 'squad') { const tok = text.trim().slice(1); const sq = squadsOf(store.world.agents).find((x) => x.name.toUpperCase() === tok.toUpperCase()); if (sq) c.openSquad(sq.name); }
      else if (target.kind === 'ceo') c.openCeo();
      return;
    }
    if (target.kind === 'bad') { c.note(`no agent or project called ${text.trim().split(' ')[0]}`, 'warn'); return; }
    if (target.kind === 'ceo') { if (!store.linkUp) { c.note('link down · capcom cannot hear you', 'warn'); return; } hub.say(body.trim()); c.openCeo(); return; }
    if (!target.ids.length) { c.note('nobody live to say it to', 'warn'); return; }
    await c.say(target.ids, body.trim());
  }

  async function command(s: string) {
    const [name = '', ...rest] = s.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (name.toLowerCase()) {
      case 'spawn': { const p = arg ? projects().find((x) => x.code.toUpperCase() === arg.toUpperCase()) : undefined; c.openSpawn(p?.id); break; }
      case 'find': { const t = resolve(arg); if (t.kind === 'agent' && t.ids[0]) { c.go(t.ids[0]); c.openAgent(t.ids[0]); } else c.note(`no agent called ${arg}`, 'warn'); break; }
      case 'frame': { c.pushView(); const p = arg ? projects().find((x) => x.code.toUpperCase() === arg.toUpperCase()) : undefined; if (p) c.field.frameProject(p.id); else c.field.frameAll(); break; }
      case 'term': case 'terminal': {
        const t = resolve(arg);
        if (t.kind !== 'agent' || !t.ids[0]) { c.note(`no agent called ${arg}`, 'warn'); break; }
        const a = store.world.agents[t.ids[0]];
        if (!a?.pane) { c.note(`${a?.callsign ?? arg} has no pane to attach to`, 'warn'); break; }
        c.openTerminal(t.ids[0]);
        break;
      }
      case 'queue': c.openQueue(); break;
      case 'ceo': case 'capcom': c.openCeo(); break;
      case 'capcom-new':
        if (arg && !['clean', 'continuity'].includes(arg)) { c.note('Use /capcom-new clean or /capcom-new continuity', 'warn'); break; }
        c.openCeo();
        window.dispatchEvent(new CustomEvent('orca:capcom-new', { detail: arg }));
        break;
      case 'feed': c.openFeed(); break;
      case 'fleet': c.openFleet(); break;
      case 'tilt': c.field.setTilt(!c.field.tilted()); break;
      case 'full': case 'fullscreen': void toggleFullscreen(); break;
      case 'deck': { const s = arg.toLowerCase(); c.deck((['state', 'project', 'cost', 'age'] as const).find((x) => x === s)); break; }
      case 'help': c.openHelp(); break;
      case 'settings': c.openSettings(); break;
      case 'hygiene': c.openHygiene(); break;
      case 'gallery': c.openGallery(); break;
      case 'timeline': c.openTimeline(); break;
      case 'launch': if (arg) getSound()?.play('launch'); c.openLaunch(arg || undefined, !!arg); break;
      case 'sfx': c.openSfx(); break;
      case 'music': c.openMusic(); break;
      case 'clear': c.field.select([]); setSelection([]); break;
      case 'dismiss': {
        const [what = ''] = rest;
        if (what.toLowerCase() === 'clear') { const n = store.undismissAll(); c.note(`${n} agent${n === 1 ? '' : 's'} back on the field`); break; }
        if (what.toLowerCase() === 'finished' || what.toLowerCase() === 'done') {
          const ids = agents().filter((a) => !live(a)).map((a) => a.id);
          const n = store.dismiss(ids);
          c.note(`dismissed ${n} finished agent${n === 1 ? '' : 's'}`);
          break;
        }
        const t = resolve(what);
        if (!t.ids.length) { c.note(`nothing called ${what} · /dismiss K9 · /dismiss finished · /dismiss clear`, 'warn'); break; }
        const n = store.dismiss(t.ids);
        c.field.select([]);
        c.note(`dismissed ${n} agent${n === 1 ? '' : 's'} · SETTINGS shows them again`);
        break;
      }
      case 'stop': {
        const [who = '', sure] = rest;
        const t = resolve(who);
        if (t.kind !== 'agent' || !t.ids[0]) { c.note(`no agent called ${who}`, 'warn'); break; }
        if (sure !== 'sure') { c.note(`/stop ${who} sure — to actually stop it`, 'warn'); break; }
        await c.stop(t.ids[0]);
        break;
      }
      default: c.note(`unknown command /${name}`, 'warn');
    }
  }

  function setSelection(ids: string[]) { selection = ids; paintTarget(); }

  input.addEventListener('input', () => { menuSel = 0; paintTarget(); paintMenu(); });
  input.addEventListener('focus', () => { el.classList.add('is-focus'); paintMenu(); });
  input.addEventListener('blur', () => { el.classList.remove('is-focus'); menu.classList.remove('is-on'); menuWas = ''; });
  input.addEventListener('keydown', (e) => {
    if (menuItems.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      menuSel = (menuSel + (e.key === 'ArrowDown' ? 1 : menuItems.length - 1)) % menuItems.length;
      paintMenu();
      return;
    }
    if (menuItems.length && (e.key === 'Tab' || (e.key === 'Enter' && !input.value.includes(' ')))) { e.preventDefault(); accept(menuSel); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (input.readOnly) return;
      const v = input.value;
      if (!v.trim()) return;
      history.unshift(v); if (history.length > 50) history.pop(); hIdx = -1;
      draft.clear();
      menuItems = [];
      menu.classList.remove('is-on');
      menuWas = '';
      // The bar starts and the message leaves in the same frame; the line
      // clears by cut when the bar lands.
      sendWipe(v, () => { input.value = ''; paintTarget(); paintMenu(); });
      void run(v);
      return;
    }
    if (e.key === 'ArrowUp' && !menuItems.length) { e.preventDefault(); hIdx = Math.min(history.length - 1, hIdx + 1); input.value = history[hIdx] ?? ''; draft.save(); paintTarget(); return; }
    if (e.key === 'ArrowDown' && !menuItems.length) { e.preventDefault(); hIdx = Math.max(-1, hIdx - 1); input.value = hIdx < 0 ? '' : history[hIdx] ?? ''; draft.save(); paintTarget(); return; }
    if (e.key === 'Escape') { input.value = ''; draft.clear(); paintTarget(); input.blur(); }
    e.stopPropagation();
  });
  chip.addEventListener('click', () => { if (selection.length) { c.field.select([]); setSelection([]); } });
  store.on((e) => { if (e.k === 'agents' || e.k === 'world') paintTarget(); });
  paintTarget();

  return {
    focus() { input.focus(); },
    blur() { input.blur(); },
    setSelection,
    isFocused: () => document.activeElement === input,
  };
}
