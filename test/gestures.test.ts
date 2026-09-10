/**
 * GESTOS DE LA CONSOLA: qué toca el operador, contado sin contenido.
 *
 * Lo que se comprueba es lo que hace que estos contadores digan algo y no
 * inflen el tablero:
 *
 *   - un gesto es una familia de la lista y un detalle limpio; lo demás no entra
 *   - un lote que escribe un navegador se valida como lo que escribe un modelo
 *   - cada familia tiene techo de nombres, y lo que pasa se funde en `other`
 *     — en el almacén y en el propio contador de la consola
 *   - el informe del revisor puede decir qué clase de ventana no se abrió
 *   - el contador de la consola acumula, sale en lotes y no pierde lo que el
 *     enlace no dejó salir
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JournalStats } from '../src/hub/journal.ts';
import { ImproveStore, buildDigest } from '../src/hub/improve.ts';
import { MAX_COUNTERS } from '../src/shared/improve.ts';
import {
  GESTURE_FAMILIES, MAX_GESTURE_BATCH, MAX_GESTURE_N, MAX_GESTURE_NAMES, WIN_KINDS,
  foldGesture, gestureDetail, gestureName, gesturesByFamily, normalizeGestures, parseGesture,
  windowKindsNeverOpened,
} from '../src/shared/gestures.ts';
import { createGestureMeter } from '../src/ui/gestures.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const T0 = 1_700_000_000_000;

function stats(): JournalStats {
  return {
    since: null, until: null, entries: 0, launches: 500,
    byLauncher: { human: 290, capcom: 0, agent: 210 },
    ends: { done: 2, dead: 1 }, doneRate: 2 / 3,
    cost: { totalUSD: 1.5, avgUSD: 0.5 }, duration: { avgMs: 600_000 },
    byProject: [],
    escalations: { asked: 4, answeredByCapcom: 2, answeredByHuman: 1, unanswered: 1, avgWaitMs: 840_000 },
    escalatedBriefs: [], rotations: 1, landings: { ok: 2, failed: 0 },
  };
}

function withStore<T>(fn: (store: ImproveStore) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'orca-gestures-'));
  try { return fn(new ImproveStore(dir, () => T0)); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Relojes falsos para el contador de la consola: nada espera de verdad. */
function fakeTimers() {
  const armed: { fn: () => void; ms: number }[] = [];
  return {
    armed,
    setTimer: (fn: () => void, ms: number) => { const t = { fn, ms }; armed.push(t); return t; },
    clearTimer: (id: unknown) => { const i = armed.indexOf(id as { fn: () => void; ms: number }); if (i >= 0) armed.splice(i, 1); },
    fire() { const list = armed.splice(0); for (const t of list) t.fn(); },
  };
}

const mod: TestModule = {
  suite: 'gestures',
  tests: [
    test('a gesture is a listed family and a clean detail; anything else is not a gesture', () => {
      const names = [
        gestureName('win', 'agent'), gestureName('key', 'KeyC'), gestureName('hud', 'sheet improve'),
        gestureName('fly', 'Agent!'), gestureName('cmd', 'say'), gestureName('win', '???'), gestureName('win', ''),
      ];
      return eq('names', names, [
        'gesture:win:agent', 'gesture:key:keyc', 'gesture:hud:sheet-improve', 'gesture:fly:agent', null, null, null,
      ]);
    }),

    test('a detail is bounded, lowercase and free of anything that is not a name', () => {
      const long = gestureDetail('A'.repeat(80));
      return ok('bounded',
        long !== null && long.length === 40
        && gestureDetail('/Users/someone/secret.txt') === 'users-someone-secret.txt'
        && gestureDetail('---') === null,
        String(long?.length));
    }),

    test('parse is the inverse of name, and refuses a family off the list', () => {
      const back = parseGesture('gesture:win:terminal');
      return ok('parse',
        back?.family === 'win' && back.detail === 'terminal'
        && parseGesture('gesture:nope:x') === null && parseGesture('ui:cmd') === null
        && parseGesture('gesture:win:') === null && parseGesture('gesture:win') === null
        && GESTURE_FAMILIES.length === 4);
    }),

    test('a batch off the wire keeps only real gestures with positive integer counts', () => {
      const out = normalizeGestures({
        'gesture:win:agent': 3.9, 'gesture:key:f': 0, 'gesture:fly:point': -2, 'gesture:hud:x': 'many',
        'ui:cmd': 5, 'mcp:spawn_agent': 1, 'gesture:win:/etc/passwd': 1, 'gesture:key:z': MAX_GESTURE_N * 10,
      });
      return eq('kept', out, { 'gesture:win:agent': 3, 'gesture:key:z': MAX_GESTURE_N });
    }),

    test('a batch that is not an object, or too long, does not get through whole', () => {
      const big: Record<string, number> = {};
      for (let i = 0; i < MAX_GESTURE_BATCH + 20; i++) big[`gesture:key:k${i}`] = 1;
      return ok('bounded',
        Object.keys(normalizeGestures(big)).length === MAX_GESTURE_BATCH
        && Object.keys(normalizeGestures(null)).length === 0
        && Object.keys(normalizeGestures([1, 2])).length === 0
        && Object.keys(normalizeGestures('gesture:win:agent')).length === 0);
    }),

    test('past the family ceiling a new name folds into other, and other never counts against it', () => {
      const counts: Record<string, number> = {};
      for (let i = 0; i < MAX_GESTURE_NAMES; i++) counts[`gesture:key:k${i}`] = 1;
      counts['gesture:key:other'] = 9;
      return ok('folds',
        foldGesture('gesture:key:new', counts) === 'gesture:key:other'
        && foldGesture('gesture:key:k3', counts) === 'gesture:key:k3'
        && foldGesture('gesture:win:agent', counts) === 'gesture:win:agent'
        && foldGesture('gesture:bad:x', counts) === null);
    }),

    test('the store applies the ceiling, drops junk gestures, and gestures count as signal', () => withStore((store) => {
      for (let i = 0; i < MAX_GESTURE_NAMES + 5; i++) store.record(`gesture:win:w${i}`);
      store.record('gesture:win:w0', 4);
      store.record('gesture:nope:x');
      store.record('gesture:win:agent', 0);
      store.record('gesture:win:agent', -3);
      const usage = store.usage();
      const winNames = Object.keys(usage.counts).filter((k) => k.startsWith('gesture:win:'));
      return ok('ceiling and signal',
        winNames.length === MAX_GESTURE_NAMES + 1
        && usage.counts['gesture:win:other'] === 5
        && usage.counts['gesture:win:w0'] === 5
        && usage.counts['gesture:nope:x'] === undefined
        && usage.counts['gesture:win:agent'] === undefined
        && store.signal().total === MAX_GESTURE_NAMES + 5 + 4
        && MAX_GESTURE_NAMES * GESTURE_FAMILIES.length < MAX_COUNTERS,
        `${winNames.length} names, other=${usage.counts['gesture:win:other']}`);
    })),

    test('by family, every family is listed, zeros included, names most-used first', () => {
      const fam = gesturesByFamily({ 'gesture:win:agent': 5, 'gesture:win:file': 9, 'gesture:key:f': 2, 'ui:cmd': 7 });
      const win = fam.find((f) => f.family === 'win')!;
      return ok('families',
        fam.map((f) => f.family).join(',') === 'win,hud,key,fly'
        && win.n === 14 && win.names[0]?.detail === 'file'
        && fam.find((f) => f.family === 'fly')!.n === 0 && fam.find((f) => f.family === 'hud')!.names.length === 0,
        JSON.stringify(fam.map((f) => [f.family, f.n])));
    }),

    test('the digest says which window kinds nobody opened, and what was touched, in three lines', () => {
      const digest = buildDigest({
        stats: stats(),
        usage: {
          since: T0, total: 60,
          counts: { 'ui:improve:get': 3, 'ui:hello': 3, 'gesture:win:agent': 30, 'gesture:win:terminal': 4, 'gesture:key:alt-c': 12, 'gesture:hud:sheet-improve': 1, 'mcp:spawn_agent': 7 },
        },
        fleet: { agents: 4, blocked: 1, missionsOpen: 2, missionsOwed: 1 },
        windowMs: 86_400_000,
      });
      const text = digest.lines.join('\n');
      const never = windowKindsNeverOpened({ 'gesture:win:agent': 30, 'gesture:win:terminal': 4 });
      return ok('three answers',
        text.includes('console gestures (47): win:agent 30 · key:alt-c 12 · win:terminal 4 · hud:sheet-improve 1')
        && text.includes('gestures by family: win 34 (windows opened, by kind) · hud 1 (HUD sections unfolded or opened) · key 12 (keyboard shortcuts used) · fly 0 (camera flights)')
        && text.includes('window kinds never opened in this window: interrupt, queue, ceo')
        && text.includes('gallery, launch, timeline')
        && text.includes('console requests to the hub (6)')
        && never.length === WIN_KINDS.length - 2 && !never.includes('agent') && !never.includes('terminal'),
        text.split('\n').filter((l) => l.includes('gesture') || l.includes('window kinds')).join(' | '));
    }),

    test('with every kind opened the digest says so instead of listing nothing', () => {
      const counts: Record<string, number> = {};
      for (const k of WIN_KINDS) counts[`gesture:win:${k}`] = 1;
      const digest = buildDigest({ stats: stats(), usage: { since: T0, counts, total: WIN_KINDS.length }, fleet: { agents: 0, blocked: 0, missionsOpen: 0, missionsOwed: 0 }, windowMs: 86_400_000 });
      return ok('all opened', digest.lines.some((l) => l === 'every window kind was opened at least once') && windowKindsNeverOpened(counts).length === 0);
    }),

    test('the console meter accumulates, sends one batch on the clock, and starts clean', () => {
      const sent: Record<string, number>[] = [];
      const t = fakeTimers();
      const m = createGestureMeter((c) => { sent.push(c); return true; }, { everyMs: 100, ...t });
      m.hit('win', 'agent'); m.hit('win', 'agent'); m.hit('key', 'alt-c'); m.hit('win', '???');
      const before = sent.length;
      const armed = t.armed.length;
      t.fire();
      return ok('one batch',
        before === 0 && armed === 1
        && sent.length === 1 && sent[0]!['gesture:win:agent'] === 2 && sent[0]!['gesture:key:alt-c'] === 1
        && Object.keys(sent[0]!).length === 2
        && Object.keys(m.pending()).length === 0 && t.armed.length === 0,
        JSON.stringify(sent));
    }),

    test('what the link refused stays in the meter and goes out with the next batch', () => {
      let up = false;
      const sent: Record<string, number>[] = [];
      const t = fakeTimers();
      const m = createGestureMeter((c) => { if (!up) return false; sent.push(c); return true; }, { everyMs: 100, ...t });
      m.hit('fly', 'agent');
      t.fire();
      const kept = m.pending()['gesture:fly:agent'];
      m.hit('fly', 'agent');
      up = true;
      const flushed = m.flush();
      return ok('kept then sent', kept === 1 && flushed && sent.length === 1 && sent[0]!['gesture:fly:agent'] === 2 && Object.keys(m.pending()).length === 0);
    }),

    test('enough gestures go out before the clock, and a runaway console folds into other', () => {
      const sent: Record<string, number>[] = [];
      const t = fakeTimers();
      const m = createGestureMeter((c) => { sent.push(c); return true; }, { everyMs: 100, flushAt: 5, ...t });
      for (let i = 0; i < 5; i++) m.hit('key', 'f');
      const early = sent.length === 1 && sent[0]!['gesture:key:f'] === 5;
      // Con el enlace caído, nombres nuevos sin límite: se funden en `other`.
      const down = createGestureMeter(() => false, { everyMs: 100, ...t });
      for (let i = 0; i < MAX_GESTURE_BATCH + 10; i++) down.hit('key', `k${i}`);
      const p = down.pending();
      return ok('early and bounded',
        early && Object.keys(p).length === MAX_GESTURE_BATCH && p['gesture:key:other'] === 10 + 1,
        `${Object.keys(p).length} names, other=${p['gesture:key:other']}`);
    }),

    test('a disposed meter counts nothing and arms nothing', () => {
      const t = fakeTimers();
      const m = createGestureMeter(() => true, { everyMs: 100, ...t });
      m.hit('win', 'help');
      m.dispose();
      m.hit('win', 'help');
      return ok('quiet', Object.keys(m.pending()).length === 0 && t.armed.length === 0);
    }),
  ],
};

export default mod;
