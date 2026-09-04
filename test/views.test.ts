/**
 * Pruebas de las tres vistas: CEO, feed y cajón de agente.
 *
 * No hay jsdom en el proyecto y no vamos a añadir una dependencia sólo para
 * esto, así que el archivo trae su propio DOM mínimo: suficiente para lo que
 * las vistas realmente usan (innerHTML, querySelector, classList, dataset,
 * eventos que burbujean, rAF manual) y nada más. El reloj de animación es
 * manual a propósito: un test que depende de temporizadores reales miente.
 *
 * El runner es casero: cada prueba es una función exportada que devuelve
 * { name, pass, detail }.
 */

import type { Agent, CeoMessage, FeedItem, Machine, Project, WorldState } from '../src/shared/types.ts';
import { emptyWorld, emptyRollup } from '../src/shared/types.ts';

export interface TestResult { name: string; pass: boolean; detail: string }

/* ══════════════════════════════════════════════════════════════════
   DOM sintético
   ══════════════════════════════════════════════════════════════════ */

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);

type Listener = (ev: SEvent) => void;

class SEvent {
  type: string;
  target: SElement | null = null;
  currentTarget: SElement | null = null;
  defaultPrevented = false;
  detail: unknown = null;
  shiftKey = false;
  key = '';
  constructor(type: string, init?: { detail?: unknown; key?: string; shiftKey?: boolean }) {
    this.type = type;
    if (init?.detail !== undefined) this.detail = init.detail;
    if (init?.key !== undefined) this.key = init.key;
    if (init?.shiftKey !== undefined) this.shiftKey = init.shiftKey;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { /* no lo usan las vistas */ }
}

class SText {
  nodeType = 3;
  data: string;
  parentNode: SElement | null = null;
  constructor(data: string) { this.data = data; }
  get textContent() { return this.data; }
  remove() { this.parentNode?.removeChild(this as unknown as SElement); }
}

type SChild = SElement | SText;

class SElement {
  nodeType = 1;
  tagName: string;
  childNodes: SChild[] = [];
  parentNode: SElement | null = null;
  attributes = new Map<string, string>();
  style: Record<string, string> = {};
  listeners = new Map<string, Set<Listener>>();

  /* Propiedades que las vistas tratan como propiedades reales del DOM. */
  hidden = false;
  disabled = false;
  value = '';
  placeholder = '';
  type = '';
  title = '';
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  clientWidth = 0;
  offsetWidth = 0;

  dataset: Record<string, string | undefined>;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    const self = this;
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get(_t, k: string) { return self.attributes.get('data-' + kebab(k)); },
      set(_t, k: string, v: unknown) { self.attributes.set('data-' + kebab(String(k)), String(v)); return true; },
      deleteProperty(_t, k: string) { self.attributes.delete('data-' + kebab(String(k))); return true; },
      has(_t, k: string) { return self.attributes.has('data-' + kebab(String(k))); },
      ownKeys() {
        return [...self.attributes.keys()].filter((a) => a.startsWith('data-')).map((a) => camel(a.slice(5)));
      },
      getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
    });
  }

  /* ── atributos ─────────────────────────────────────────────────── */

  get className() { return this.attributes.get('class') ?? ''; }
  set className(v: string) { this.attributes.set('class', v); }

  setAttribute(k: string, v: string) { this.attributes.set(k, v); }
  getAttribute(k: string) { return this.attributes.get(k) ?? null; }
  hasAttribute(k: string) { return this.attributes.has(k); }
  removeAttribute(k: string) { this.attributes.delete(k); }

  get classList() {
    const self = this;
    const read = () => (self.className ? self.className.split(/\s+/).filter(Boolean) : []);
    const write = (list: string[]) => { self.className = list.join(' '); };
    return {
      add(...cs: string[]) { const l = read(); for (const c of cs) if (!l.includes(c)) l.push(c); write(l); },
      remove(...cs: string[]) { write(read().filter((c) => !cs.includes(c))); },
      contains(c: string) { return read().includes(c); },
      toggle(c: string, force?: boolean) {
        const has = read().includes(c);
        const want = force === undefined ? !has : force;
        if (want && !has) this.add(c);
        if (!want && has) this.remove(c);
        return want;
      },
    };
  }

  /* ── árbol ─────────────────────────────────────────────────────── */

  get children(): SElement[] { return this.childNodes.filter((c): c is SElement => c.nodeType === 1); }
  get firstChild(): SChild | null { return this.childNodes[0] ?? null; }
  get lastChild(): SChild | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): SChild | null {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.childNodes.indexOf(this as unknown as SChild);
    return i >= 0 ? p.childNodes[i + 1] ?? null : null;
  }

  appendChild<T extends SChild>(n: T): T {
    n.parentNode?.removeChild(n as unknown as SElement);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  insertBefore<T extends SChild>(n: T, ref: SChild | null): T {
    n.parentNode?.removeChild(n as unknown as SElement);
    n.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n);
    else this.childNodes.splice(i, 0, n);
    return n;
  }
  removeChild<T extends SChild>(n: T): T {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() { this.parentNode?.removeChild(this as unknown as SChild); }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v) this.appendChild(new SText(v));
  }

  set innerHTML(html: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    parseInto(this, html);
  }
  get innerHTML(): string { return serialize(this); }

  /* ── consultas ─────────────────────────────────────────────────── */

  querySelector<T = SElement>(sel: string): T | null {
    for (const el of walk(this)) if (matches(el, sel)) return el as unknown as T;
    return null;
  }
  querySelectorAll<T = SElement>(sel: string): T[] {
    const out: T[] = [];
    for (const el of walk(this)) if (matches(el, sel)) out.push(el as unknown as T);
    return out;
  }
  closest<T = SElement>(sel: string): T | null {
    let cur: SElement | null = this;
    while (cur) {
      if (matches(cur, sel)) return cur as unknown as T;
      cur = cur.parentNode;
    }
    return null;
  }
  matches(sel: string) { return matches(this, sel); }

  /* ── eventos y foco ────────────────────────────────────────────── */

  addEventListener(type: string, fn: Listener) {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    set.add(fn);
  }
  removeEventListener(type: string, fn: Listener) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent(ev: SEvent) {
    ev.target = this;
    let cur: SElement | null = this;
    while (cur) {
      ev.currentTarget = cur;
      for (const fn of [...(cur.listeners.get(ev.type) ?? [])]) fn(ev);
      cur = cur.parentNode;
    }
    for (const fn of [...(win.listeners.get(ev.type) ?? [])]) fn(ev);
    return !ev.defaultPrevented;
  }
  focus() { doc.activeElement = this; }
  blur() { if (doc.activeElement === this) doc.activeElement = null; }
  getBoundingClientRect() { return { width: this.offsetWidth, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
}

function kebab(s: string) { return s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()); }
function camel(s: string) { return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()); }

function* walk(root: SElement): Generator<SElement> {
  for (const c of root.childNodes) {
    if (c.nodeType !== 1) continue;
    const el = c as SElement;
    yield el;
    yield* walk(el);
  }
}

/** Selectores soportados: tag, .clase, #id, [attr], [attr="v"], descendencia y comas. */
function matches(el: SElement, sel: string): boolean {
  return sel.split(',').some((one) => matchChain(el, one.trim()));
}

function matchChain(el: SElement, sel: string): boolean {
  const parts = sel.split(/\s+/).filter(Boolean);
  const last = parts.pop();
  if (!last || !matchCompound(el, last)) return false;
  let cur: SElement | null = el.parentNode;
  for (let i = parts.length - 1; i >= 0; i--) {
    const want = parts[i]!;
    let found = false;
    while (cur) {
      if (matchCompound(cur, want)) { found = true; cur = cur.parentNode; break; }
      cur = cur.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

const TOKEN = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;

function matchCompound(el: SElement, sel: string): boolean {
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = TOKEN.exec(sel))) {
    any = true;
    if (m[1]) { if (el.tagName !== m[1].toUpperCase()) return false; }
    else if (m[2]) { if (!el.classList.contains(m[2])) return false; }
    else if (m[3]) { if (el.getAttribute('id') !== m[3]) return false; }
    else if (m[4]) {
      const v = m[5] ?? m[6] ?? m[7];
      if (v === undefined || v === '') { if (!el.hasAttribute(m[4])) return false; }
      else if (el.getAttribute(m[4]) !== v) return false;
    }
  }
  return any;
}

/* ── Parser de HTML, sólo lo que este proyecto escribe ───────────── */

const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseInto(root: SElement, html: string) {
  const stack: SElement[] = [root];
  let last = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html))) {
    const text = html.slice(last, m.index);
    if (text.trim()) stack[stack.length - 1]!.appendChild(new SText(text.trim()));
    last = m.index + m[0].length;
    if (m[0].startsWith('<!--')) continue;
    const closing = m[1] === '/';
    const tag = m[2]!;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = new SElement(tag);
    ATTR_RE.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR_RE.exec(m[3] ?? ''))) {
      const name = a[1]!;
      const val = a[2] ?? a[3] ?? a[4] ?? '';
      el.setAttribute(name, val);
      if (name === 'hidden') el.hidden = true;
      if (name === 'value') el.value = val;
      if (name === 'placeholder') el.placeholder = val;
      if (name === 'type') el.type = val;
    }
    stack[stack.length - 1]!.appendChild(el);
    if (!VOID_TAGS.has(tag.toLowerCase()) && m[4] !== '/') stack.push(el);
  }
  const tail = html.slice(last);
  if (tail.trim()) stack[stack.length - 1]!.appendChild(new SText(tail.trim()));
}

function serialize(el: SElement): string {
  return el.childNodes.map((c) => {
    if (c.nodeType === 3) return c.textContent;
    const e = c as SElement;
    const attrs = [...e.attributes].map(([k, v]) => ` ${k}="${v}"`).join('');
    return `<${e.tagName.toLowerCase()}${attrs}>${serialize(e)}</${e.tagName.toLowerCase()}>`;
  }).join('');
}

/* ── window / document ───────────────────────────────────────────── */

class SWindow {
  listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener) {
    let s = this.listeners.get(type);
    if (!s) { s = new Set(); this.listeners.set(type, s); }
    s.add(fn);
  }
  removeEventListener(type: string, fn: Listener) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent(ev: SEvent) {
    for (const fn of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
    return !ev.defaultPrevented;
  }
}

class SDocument extends SElement {
  body = new SElement('body');
  documentElement = new SElement('html');
  activeElement: SElement | null = null;
  visibilityState = 'visible';
  constructor() {
    super('#document');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag: string) { return new SElement(tag); }
  createTextNode(t: string) { return new SText(t); }
}

const win = new SWindow();
const doc = new SDocument();

/* Reloj de animación manual. */
let rafSeq = 1;
let rafNow = 0;
const rafQueue = new Map<number, (t: number) => void>();

/** Avanza N frames de `dt` ms cada uno. */
export function frames(n: number, dt = 16) {
  for (let i = 0; i < n; i++) {
    rafNow += dt;
    const batch = [...rafQueue];
    rafQueue.clear();
    for (const [, cb] of batch) cb(rafNow);
  }
}

/** Estado de `prefers-reduced-motion` que verá la próxima vista al montarse. */
export const env = { reduceMotion: false };

let installed = false;

export function installDom() {
  if (installed) return;
  installed = true;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = Object.assign(win, {
    document: doc,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms) as unknown as number,
    clearInterval: (id: number) => clearInterval(id),
    requestAnimationFrame: (cb: (t: number) => void) => { const id = rafSeq++; rafQueue.set(id, cb); return id; },
    cancelAnimationFrame: (id: number) => rafQueue.delete(id),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    navigator: { userAgent: 'node' },
    location: { href: 'http://localhost/', protocol: 'http:', host: 'localhost', search: '' },
    innerWidth: 1440,
    innerHeight: 900,
  });
  g.document = doc;
  g.CustomEvent = SEvent;
  g.Event = SEvent;
  g.KeyboardEvent = SEvent;
  g.matchMedia = (q: string) => ({
    matches: q.includes('reduced-motion') ? env.reduceMotion : false,
    media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  });
  g.requestAnimationFrame = (cb: (t: number) => void) => { const id = rafSeq++; rafQueue.set(id, cb); return id; };
  g.cancelAnimationFrame = (id: number) => rafQueue.delete(id);
  const bag = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => { bag.set(k, v); },
    removeItem: (k: string) => { bag.delete(k); },
    clear: () => bag.clear(),
  };
  g.location = (g.window as { location: unknown }).location;
}

/* ══════════════════════════════════════════════════════════════════
   Fixtures
   ══════════════════════════════════════════════════════════════════ */

function machine(id: string): Machine {
  return {
    id, hostname: 'nostromo', platform: 'darwin', version: '0.1.0', online: true,
    lastSeen: Date.now(), connectedAt: Date.now(),
    load: { sessions: 3, activeSessions: 2, cpuPct: 12, memPct: 40 },
  };
}

function project(id: string, machineId: string): Project {
  return {
    id, machineId, slug: '-Users-dan-axolots', name: 'axolots', path: '/Users/dan/axolots',
    code: 'AX', gitBranch: 'main', gitDirty: false, keyNames: [], sessionIds: [],
    rollup: emptyRollup(),
  };
}

function agent(id: string, over: Partial<Agent> = {}): Agent {
  const base: Agent = {
    id, machineId: 'm1', projectId: 'p1',
    title: 'refactor the collector', callsign: id.toUpperCase(),
    state: 'working', block: null,
    parentId: null, depth: 0, childIds: [], mission: 'keep the fleet honest',
    model: 'claude-opus-4', tool: 'Bash', toolDetail: 'npx tsc --noEmit',
    lastPrompt: 'check the types', lastSay: 'typecheck is green',
    startedAt: Date.now() - 60_000, updatedAt: Date.now(), uptimeMs: 12_240_000,
    metrics: {
      costUSD: 1.234, inputTokens: 128_400, outputTokens: 9_800, cacheReadTokens: 0,
      thinkingTokens: 0, tokensPerSec: 41.7, linesAdded: 128, linesRemoved: 44,
      toolCalls: 37, toolDurationMs: 9000, apiDurationMs: 4000, turns: 12,
    },
    background: false, shortId: null,
  };
  return { ...base, ...over };
}

function msg(over: Partial<CeoMessage> & { id: string; role: CeoMessage['role'] }): CeoMessage {
  return { text: '', at: Date.now(), actions: [], ...over };
}

function feedItem(i: number, over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'f' + i, at: Date.now(), level: 'info', source: 'AX/K9',
    text: `tool call ${i} finished in ${i * 3}ms`, ...over,
  };
}

function worldWith(mut: (w: WorldState) => void): WorldState {
  const w = emptyWorld();
  w.machines['m1'] = machine('m1');
  w.projects['p1'] = project('p1', 'm1');
  mut(w);
  return w;
}

/* ══════════════════════════════════════════════════════════════════
   Pruebas
   ══════════════════════════════════════════════════════════════════ */

function ok(name: string, detail = ''): TestResult { return { name, pass: true, detail }; }
function fail(name: string, detail: string): TestResult { return { name, pass: false, detail }; }

function host(): SElement {
  const el = new SElement('div');
  doc.body.appendChild(el);
  return el;
}

const asHost = (el: SElement) => el as unknown as HTMLElement;

export async function testCeoRendersRoles(): Promise<TestResult> {
  const name = 'ceo renders human, ceo and system messages';
  const { store } = await import('../src/ui/store.ts');
  const { mountCeo } = await import('../src/ui/views/ceo.ts');

  store.replaceWorld(worldWith((w) => {
    w.agents['a1'] = agent('a1');
    w.escalations['e1'] = {
      id: 'e1', agentId: 'a1', projectId: 'p1', machineId: 'm1',
      question: 'ship it?', context: null, options: [], optionsOnly: false,
      urgency: 'blocking', status: 'pending', ceoAttempt: null,
      answer: null, answeredBy: null, rememberAs: null,
      askedAt: Date.now(), answeredAt: null, expiresAt: null,
    };
    w.ceo.messages = [
      msg({ id: 'm1', role: 'human', text: 'status?' }),
      msg({
        id: 'm2', role: 'ceo', text: 'three agents working',
        actions: [
          { id: 'x1', name: 'FLEET_SCAN', summary: 'read 12 sessions', status: 'ok', at: Date.now() },
          { id: 'x2', name: 'SPAWN', summary: 'spawned 3 agents', status: 'running', at: Date.now() },
        ],
      }),
      msg({ id: 'm3', role: 'system', text: 'link restored' }),
      msg({ id: 'm4', role: 'ceo', text: 'K9 asks: ship it?', escalationId: 'e1', streaming: true }),
    ];
  }));

  const el = host();
  const view = mountCeo(asHost(el));
  try {
    const rows = el.querySelectorAll<SElement>('.msg');
    if (rows.length !== 4) return fail(name, `expected 4 message rows, got ${rows.length}`);

    const human = el.querySelector<SElement>('.msg--human');
    const ceo = el.querySelector<SElement>('.msg--ceo');
    const sys = el.querySelector<SElement>('.msg--system');
    if (!human || !ceo || !sys) return fail(name, 'a role class is missing');
    if (!human.textContent.includes('status?')) return fail(name, 'human text missing');
    if (!ceo.textContent.includes('three agents working')) return fail(name, 'ceo text missing');
    if (!sys.textContent.includes('link restored')) return fail(name, 'system text missing');

    const acts = el.querySelectorAll<SElement>('.act');
    if (acts.length !== 2) return fail(name, `expected 2 action rows, got ${acts.length}`);
    if (acts[1]!.getAttribute('data-st') !== 'running') return fail(name, 'running action not marked');

    const relay = el.querySelector<SElement>('.msg--ceo.is-relay .msg__relay');
    if (!relay || !relay.textContent.includes('RELAYED FROM A1')) {
      return fail(name, `relay label wrong: ${relay?.textContent ?? 'missing'}`);
    }
    if (!el.querySelector('.msg__caret')) return fail(name, 'streaming caret missing');

    return ok(name, '4 rows, 2 actions, relay + caret present');
  } finally {
    view.destroy();
    el.remove();
  }
}

export async function testCeoComposerSends(): Promise<TestResult> {
  const name = 'ceo composer calls hub.say and clears itself';
  const { store } = await import('../src/ui/store.ts');
  const { hub } = await import('../src/ui/net/client.ts');
  const { mountCeo } = await import('../src/ui/views/ceo.ts');

  store.replaceWorld(worldWith(() => {}));
  store.setLink(true);

  const said: string[] = [];
  const original = hub.say.bind(hub);
  (hub as unknown as { say: (t: string) => void }).say = (t: string) => { said.push(t); };

  const el = host();
  const view = mountCeo(asHost(el));
  try {
    const ta = el.querySelector<SElement>('[data-input]')!;
    if (ta.disabled) return fail(name, 'composer disabled while link is up');
    ta.value = '  spawn two agents on axolots  ';
    ta.dispatchEvent(new SEvent('keydown', { key: 'Enter' }));
    if (said.length !== 1) return fail(name, `hub.say called ${said.length} times`);
    if (said[0] !== 'spawn two agents on axolots') return fail(name, `sent wrong text: ${said[0]}`);
    if (ta.value !== '') return fail(name, 'composer not cleared after send');

    // Shift+Enter es salto de línea, no envío.
    ta.value = 'a';
    ta.dispatchEvent(new SEvent('keydown', { key: 'Enter', shiftKey: true }));
    if (said.length !== 1) return fail(name, 'shift+enter sent the message');

    // Sin link no se envía y el placeholder lo dice.
    store.setLink(false);
    ta.value = 'hola';
    ta.dispatchEvent(new SEvent('keydown', { key: 'Enter' }));
    if (said.length !== 1) return fail(name, 'sent while link was down');
    if (!ta.placeholder.includes('link down')) return fail(name, `placeholder not updated: ${ta.placeholder}`);

    return ok(name, 'enter sends, shift+enter does not, link down blocks');
  } finally {
    (hub as unknown as { say: (t: string) => void }).say = original;
    view.destroy();
    el.remove();
    store.setLink(false);
  }
}

export async function testDrawerOpensAndCloses(): Promise<TestResult> {
  const name = 'agent drawer opens on orca:open-agent and closes on Escape';
  env.reduceMotion = true; // sin GSAP: el DOM sintético no tiene layout que animar
  const { store } = await import('../src/ui/store.ts');
  const { mountAgentDrawer } = await import('../src/ui/views/agent.ts');

  store.replaceWorld(worldWith((w) => {
    const kid = agent('k2', { parentId: 'a1', depth: 1, title: 'write the tests', state: 'thinking' });
    const parent = agent('a1', {
      childIds: ['k2'], state: 'blocked',
      block: { kind: 'permission', summary: 'run `rm -rf dist`', since: Date.now() - 95_000 },
    });
    w.agents['a1'] = parent;
    w.agents['k2'] = kid;
    w.projects['p1']!.sessionIds = ['a1', 'k2'];
  }));

  const el = host();
  const view = mountAgentDrawer(asHost(el));
  try {
    const drw = el.querySelector<SElement>('[data-drw]')!;
    if (!drw.hidden) return fail(name, 'drawer visible before any event');

    win.dispatchEvent(new SEvent('orca:open-agent', { detail: { id: 'a1' } }));
    if (drw.hidden) return fail(name, 'drawer did not open on the event');
    if (view.current() !== 'a1') return fail(name, `current() is ${view.current()}`);

    const callsign = el.querySelector<SElement>('[data-callsign]')!;
    if (callsign.textContent !== 'A1') return fail(name, `callsign is ${callsign.textContent}`);

    const block = el.querySelector<SElement>('[data-block]')!;
    if (block.hidden) return fail(name, 'blocked section hidden for a blocked agent');
    if (!el.querySelector<SElement>('[data-blksum]')!.textContent.includes('rm -rf dist')) {
      return fail(name, 'block summary missing');
    }
    const perms = el.querySelectorAll<SElement>('[data-blkacts] .op');
    if (perms.length !== 3) return fail(name, `expected 3 permission buttons, got ${perms.length}`);
    if (!el.querySelector<SElement>('[data-blkage]')!.textContent.includes('1m')) {
      return fail(name, 'block age not counted');
    }

    const kids = el.querySelectorAll<SElement>('.kid');
    if (kids.length !== 1) return fail(name, `expected 1 child row, got ${kids.length}`);

    const cost = el.querySelectorAll<SElement>('.met__n')[0]!;
    if (cost.textContent !== '$1.23') return fail(name, `cost formatted as ${cost.textContent}`);
    const uptime = el.querySelectorAll<SElement>('.met__n')[7]!;
    if (uptime.textContent !== '3h 24m') return fail(name, `uptime formatted as ${uptime.textContent}`);

    doc.dispatchEvent(new SEvent('keydown', { key: 'Escape' }));
    if (!drw.hidden) return fail(name, 'Escape did not close the drawer');
    if (view.current() !== null) return fail(name, 'current() still set after close');

    return ok(name, 'opens by event, shows block + children + metrics, Escape closes');
  } finally {
    view.destroy();
    el.remove();
    env.reduceMotion = false;
  }
}

export async function testFeedRecyclesNodes(): Promise<TestResult> {
  const name = 'feed recycles DOM nodes instead of rebuilding the strip';
  env.reduceMotion = false;
  const { store } = await import('../src/ui/store.ts');
  const { mountFeed } = await import('../src/ui/views/feed.ts');

  store.replaceWorld(worldWith((w) => {
    w.feed = Array.from({ length: 40 }, (_, i) =>
      feedItem(i, i === 1 ? { level: 'alert', agentId: 'a1', text: 'agent K9 died' } : {}));
  }));

  const el = host();
  const view = mountFeed(asHost(el));
  try {
    frames(1, 16);
    const afterFirst = view.stats();
    if (afterFirst.placed === 0) return fail(name, 'nothing placed on the first frame');

    // El item 'alert' entra con su propio destello y, por llevar agentId, abre
    // el cajón al pulsarlo. Se comprueba mientras sigue vivo en la tira.
    const alert = el.querySelector<SElement>('.feed__item.is-flash');
    if (!alert) return fail(name, 'alert item did not flash');
    if (alert.getAttribute('data-agent') !== 'a1') return fail(name, 'alert item lost its agentId');

    let openedWith: string | null = null;
    const onOpen = (ev: SEvent) => { openedWith = (ev.detail as { id: string }).id; };
    win.addEventListener('orca:open-agent', onOpen);
    alert.dispatchEvent(new SEvent('click'));
    win.removeEventListener('orca:open-agent', onOpen);
    if (openedWith !== 'a1') return fail(name, `click dispatched ${String(openedWith)}`);

    frames(1500, 120);
    const s = view.stats();
    if (s.placed < 20) return fail(name, `only ${s.placed} items placed after scrolling`);
    if (s.created >= s.placed) return fail(name, `created ${s.created} nodes for ${s.placed} placements`);
    if (s.created > 24) return fail(name, `node count grew to ${s.created}`);

    const nodes = el.querySelectorAll<SElement>('.feed__item').length;
    if (nodes > 24) return fail(name, `${nodes} live nodes in the DOM`);
    if (s.pooled + s.live !== s.created) return fail(name, 'pool + live does not account for every node');

    const detail = `created=${s.created} placed=${s.placed} live=${s.live} pooled=${s.pooled}`;
    return ok(name, detail);
  } finally {
    view.destroy();
    el.remove();
  }
}

export async function testFeedScramblesWhenEmpty(): Promise<TestResult> {
  const name = 'feed shows a glyph scramble when there is no telemetry';
  env.reduceMotion = false;
  const { store } = await import('../src/ui/store.ts');
  const { mountFeed } = await import('../src/ui/views/feed.ts');

  store.replaceWorld(worldWith(() => {}));
  const el = host();
  const view = mountFeed(asHost(el));
  try {
    frames(2, 16);
    const scr = el.querySelector<SElement>('[data-scramble]')!;
    if (scr.hidden) return fail(name, 'scramble hidden with an empty feed');
    if (scr.textContent.replace(/\s/g, '').length < 24) return fail(name, 'scramble text too short');
    if (!/^[A-Z0-9\s]+$/.test(scr.textContent)) return fail(name, `unexpected glyphs: ${scr.textContent}`);

    // En cuanto llega telemetría, la pista toma el relevo.
    store.applyPatch(store.world.rev + 1, [{ o: 'feed', v: [feedItem(99)] }]);
    frames(2, 16);
    if (!scr.hidden) return fail(name, 'scramble still up after telemetry arrived');
    return ok(name, 'scramble up when idle, down when telemetry arrives');
  } finally {
    view.destroy();
    el.remove();
  }
}

export async function testDrawerStopNeedsConfirm(): Promise<TestResult> {
  const name = 'drawer STOP arms before it fires';
  env.reduceMotion = true;
  const { store } = await import('../src/ui/store.ts');
  const { hub } = await import('../src/ui/net/client.ts');
  const { mountAgentDrawer } = await import('../src/ui/views/agent.ts');

  store.replaceWorld(worldWith((w) => { w.agents['a1'] = agent('a1'); }));

  const sent: unknown[] = [];
  const original = hub.cmd.bind(hub);
  (hub as unknown as { cmd: (c: unknown) => Promise<unknown> }).cmd = (c: unknown) => {
    sent.push(c);
    return Promise.resolve(null);
  };

  const el = host();
  const view = mountAgentDrawer(asHost(el));
  try {
    view.open('a1');
    const stop = el.querySelector<SElement>('[data-stop]')!;
    stop.dispatchEvent(new SEvent('click'));
    if (sent.length !== 0) return fail(name, 'first click already stopped the agent');
    if (stop.textContent !== 'CONFIRM STOP') return fail(name, `button says ${stop.textContent}`);
    if (!stop.classList.contains('is-armed')) return fail(name, 'armed class missing');

    stop.dispatchEvent(new SEvent('click'));
    const cmd = sent[0] as { k: string; agentId: string } | undefined;
    if (!cmd || cmd.k !== 'stop' || cmd.agentId !== 'a1') return fail(name, `sent ${JSON.stringify(sent[0])}`);
    if (String(stop.textContent) !== 'STOP') return fail(name, 'button did not disarm after firing');
    return ok(name, 'two clicks to stop, disarms afterwards');
  } finally {
    (hub as unknown as { cmd: unknown }).cmd = original;
    view.destroy();
    el.remove();
    env.reduceMotion = false;
  }
}

/* ══════════════════════════════════════════════════════════════════
   Runner
   ══════════════════════════════════════════════════════════════════ */

export const TESTS: (() => Promise<TestResult>)[] = [
  testCeoRendersRoles,
  testCeoComposerSends,
  testDrawerOpensAndCloses,
  testDrawerStopNeedsConfirm,
  testFeedRecyclesNodes,
  testFeedScramblesWhenEmpty,
];

export async function runViewTests(): Promise<TestResult[]> {
  installDom();
  const out: TestResult[] = [];
  for (const t of TESTS) {
    try {
      out.push(await t());
    } catch (err) {
      out.push(fail(t.name, `threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
    }
  }
  return out;
}

const invokedDirectly = process.argv[1]?.includes('views.test');
if (invokedDirectly) {
  void runViewTests().then((results) => {
    let bad = 0;
    for (const r of results) {
      if (!r.pass) bad++;
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`);
    }
    console.log(`\n${results.length - bad}/${results.length} passed`);
    process.exitCode = bad ? 1 : 0;
  });
}
