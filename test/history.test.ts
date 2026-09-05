/**
 * Pruebas de la línea de tiempo: el anillo del hub, sus tres techos, la
 * compactación al arrancar, las dos rutas de `/api/history`, y la función pura
 * que devuelve una instantánea al campo.
 *
 *   npx tsx test/run.ts history
 *
 * Lo que se está comprobando de verdad es que la historia no puede crecer: un
 * hub que se deja encendido una semana no puede acabar guardando el pasado a
 * costa del presente.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, AgentState, FeedItem, WorldState } from '../src/shared/types.ts';
import { emptyWorld } from '../src/shared/types.ts';
import { History, MAX_RANGE, subsample, snapshotOf } from '../src/hub/history.ts';
import type { HistoryRange, HistorySummary, Snapshot } from '../src/hub/history.ts';
import { startHub } from '../src/hub/server.ts';
import { createAuth } from '../src/hub/auth.ts';
import { HubStore } from '../src/hub/persist.ts';
import { worldFromSnapshot, nearestSnapshot } from '../src/ui/history.ts';

export interface TestResult { name: string; pass: boolean; detail: string }

const TOKEN = 'test-token-history-000';

function ok(name: string, detail = ''): TestResult { return { name, pass: true, detail }; }
function fail(name: string, detail: string): TestResult { return { name, pass: false, detail }; }
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

function tempDir(): string { return mkdtempSync(join(tmpdir(), 'orca-history-test-')); }

/* ── fixtures ─────────────────────────────────────────────────────── */

interface Spec {
  id: string;
  state: AgentState;
  cost?: number;
  project?: string;
  parent?: string | null;
  callsign?: string;
  tps?: number;
}

function agent(sp: Spec): Agent {
  const now = Date.now();
  return {
    id: sp.id, machineId: 'm1', projectId: sp.project ?? 'p1',
    title: 'prueba', callsign: sp.callsign ?? sp.id.toUpperCase().slice(0, 2),
    runtime: 'claude', state: sp.state, block: sp.state === 'blocked'
      ? { kind: 'question', summary: '¿sigo?', since: now } : null,
    parentId: sp.parent ?? null, depth: sp.parent ? 1 : 0, childIds: [], mission: null,
    squad: null, lead: false,
    model: 'claude-opus-5', tool: null, toolDetail: null,
    lastPrompt: null, lastSay: null, startedAt: now, updatedAt: now, uptimeMs: 0,
    metrics: {
      costUSD: sp.cost ?? 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      thinkingTokens: 0, tokensPerSec: sp.tps ?? 0, linesAdded: 0, linesRemoved: 0,
      toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    background: false, shortId: null,
  };
}

function worldOf(specs: Spec[], feed: FeedItem[] = []): WorldState {
  const w = emptyWorld();
  for (const sp of specs) w.agents[sp.id] = agent(sp);
  for (const sp of specs) {
    const p = sp.project ?? 'p1';
    if (!w.projects[p]) {
      w.projects[p] = {
        id: p, machineId: 'm1', slug: `-${p}`, name: p, path: `/tmp/${p}`,
        code: p.toUpperCase().slice(0, 2), gitBranch: 'main', gitDirty: false,
        keyNames: [], sessionIds: [], rollup: emptyWorld().fleet,
      };
    }
    w.projects[p]!.sessionIds.push(sp.id);
  }
  w.feed = feed;
  return w;
}

function feedLine(at: number, level: FeedItem['level'], text: string): FeedItem {
  return { id: `f${at}${level}`, at, level, source: 'P1/AA', text };
}

/* ── el anillo ────────────────────────────────────────────────────── */

export function testRingRespectsItsCeilings(): TestResult {
  const name = 'el anillo respeta retención, cuenta y entradas';
  try {
    // 1. Retención por tiempo.
    let t = 1_000_000;
    const byTime = new History({ ephemeral: true, retentionMs: 5_000, now: () => t });
    const w = worldOf([{ id: 'a', state: 'working' }]);
    for (let i = 0; i < 10; i += 1) { byTime.push(w, t); t += 1_000; }
    assert(byTime.size === 6, `retención: esperaba 6 instantáneas, hay ${byTime.size}`);
    assert(byTime.first!.at === 1_004_000, `la más vieja debería ser t+4s, es ${byTime.first!.at}`);

    // 2. Techo de cuenta.
    const byCount = new History({ ephemeral: true, maxSnapshots: 5 });
    for (let i = 0; i < 40; i += 1) byCount.push(w, 2_000_000 + i);
    assert(byCount.size === 5, `cuenta: esperaba 5, hay ${byCount.size}`);
    assert(byCount.last!.at === 2_000_039, 'el techo de cuenta debe tirar lo viejo, no lo nuevo');

    // 3. Techo de entradas: cuatro agentes por instantánea contra un techo de 10.
    const big = worldOf([
      { id: 'a', state: 'working' }, { id: 'b', state: 'blocked' },
      { id: 'c', state: 'idle' }, { id: 'd', state: 'dead' },
    ]);
    const byEntries = new History({ ephemeral: true, maxEntries: 10 });
    for (let i = 0; i < 20; i += 1) byEntries.push(big, 3_000_000 + i);
    assert(byEntries.entryCount <= 10, `entradas: ${byEntries.entryCount} > 10`);
    assert(byEntries.size === 2, `entradas: esperaba 2 instantáneas, hay ${byEntries.size}`);

    // 4. La marca coalesce.
    let m = 5_000_000;
    const marks = new History({ ephemeral: true, coalesceMs: 5_000, now: () => m });
    assert(marks.mark(w) !== null, 'la primera marca siempre entra');
    m += 1_000;
    assert(marks.mark(w) === null, 'una marca a 1s de la anterior debe coalescer');
    m += 5_000;
    assert(marks.mark(w) !== null, 'pasados 5s vuelve a entrar');
    assert(marks.size === 2, `esperaba 2 instantáneas de marca, hay ${marks.size}`);

    return ok(name, 'tiempo · cuenta · entradas · coalescencia');
  } catch (err) { return fail(name, String(err)); }
}

export async function testCompactionOnBoot(): Promise<TestResult> {
  const name = 'al arrancar se descarta lo de más de 24 h y se reescribe el archivo';
  const dir = tempDir();
  try {
    const file = join(dir, 'history.jsonl');
    const now = Date.now();
    const w = worldOf([{ id: 'a', state: 'working' }, { id: 'b', state: 'idle' }]);
    const lines: string[] = [];
    // Tres días de instantáneas, una por hora, más una línea corrupta.
    for (let h = 72; h >= 0; h -= 1) {
      lines.push(JSON.stringify(snapshotOf(w, now - h * 3_600_000, 0)));
    }
    lines.push('{esto no es json');
    lines.push(JSON.stringify({ at: 'ayer' }));      // forma inválida
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    // `now` fijo: si el reloj corre entre escribir el archivo y leerlo, la
    // instantánea del límite exacto de 24 h cae y la prueba parpadea.
    const h = new History({ file, retentionMs: 24 * 3_600_000, now: () => now });
    // 73 líneas escritas, 25 dentro de 24 h (h = 0..24).
    assert(h.size === 25, `esperaba 25 instantáneas vivas, hay ${h.size}`);
    assert(h.first!.at >= now - 24 * 3_600_000, 'sobrevivió algo de más de 24 h');
    assert(h.entryCount === 50, `2 agentes × 25 instantáneas = 50 entradas, hay ${h.entryCount}`);

    await h.compact();
    const rewritten = readFileSync(file, 'utf8').trim().split('\n').filter((l) => l.length);
    assert(rewritten.length === 25, `el archivo debería quedar en 25 líneas, tiene ${rewritten.length}`);
    assert(!rewritten.some((l) => l.startsWith('{esto')), 'la línea corrupta sobrevivió a la compactación');

    // Y lo que se escribe después del arranque se puede volver a leer.
    h.push(w, now);
    await h.flush();
    await h.close();
    const reopened = new History({ file, retentionMs: 24 * 3_600_000, now: () => now });
    assert(reopened.size === 26, `tras reabrir esperaba 26, hay ${reopened.size}`);
    await reopened.close();

    return ok(name, '73 líneas → 25 vivas, archivo reescrito, ida y vuelta a disco');
  } catch (err) {
    return fail(name, String(err));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function testSubsampleCapsAtSixHundred(): TestResult {
  const name = 'el submuestreo ensancha el paso en vez de truncar el rango';
  try {
    const w = worldOf([{ id: 'a', state: 'working' }]);
    const list: Snapshot[] = [];
    for (let i = 0; i < 4_000; i += 1) list.push(snapshotOf(w, 1_000_000 + i * 20_000, i));

    const wide = subsample(list, 0);
    assert(wide.snapshots.length <= MAX_RANGE, `sin paso: ${wide.snapshots.length} > ${MAX_RANGE}`);
    assert(wide.step > 0, 'debería haber elegido un paso para poder capar');
    assert(wide.snapshots[0]!.at === list[0]!.at, 'se perdió el extremo antiguo del rango');
    assert(wide.snapshots[wide.snapshots.length - 1]!.at === list[list.length - 1]!.at,
      'se perdió el presente: el botón LIVE no tendría dónde aterrizar');

    // Un paso que ya cabe se respeta tal cual.
    const short = list.slice(0, 100);
    const exact = subsample(short, 60_000);
    assert(exact.step === 60_000, `esperaba paso 60s, dio ${exact.step}`);
    assert(exact.snapshots.length === 34, `una cada 3 instantáneas de 100 → 34, dio ${exact.snapshots.length}`);

    return ok(name, `4.000 → ${wide.snapshots.length} con paso ${wide.step / 1000}s`);
  } catch (err) { return fail(name, String(err)); }
}

/* ── el resumen ───────────────────────────────────────────────────── */

export function testSummaryCountsTransitions(): TestResult {
  const name = 'el resumen cuenta nacimientos, finales, muertes y bloqueos';
  try {
    let t = 10_000_000;
    const h = new History({ ephemeral: true, now: () => t });

    // t0 — la línea base, antes del intervalo: dos agentes trabajando.
    h.push(worldOf([
      { id: 'a', state: 'working', cost: 1 },
      { id: 'b', state: 'working', cost: 2 },
    ]), t);

    const since = t + 1;
    t += 20_000;
    // t1 — nace c, a se bloquea.
    h.push(worldOf([
      { id: 'a', state: 'blocked', cost: 1.5 },
      { id: 'b', state: 'working', cost: 2.5 },
      { id: 'c', state: 'booting', cost: 0 },
    ]), t);

    t += 20_000;
    // t2 — a sigue bloqueado (no cuenta dos veces), b termina, c muere.
    const last = worldOf([
      { id: 'a', state: 'blocked', cost: 1.5 },
      { id: 'b', state: 'done', cost: 3 },
      { id: 'c', state: 'dead', cost: 0.25 },
    ], [
      feedLine(since - 5_000, 'alert', 'esto pasó antes y no cuenta'),
      feedLine(since + 1_000, 'trace', 'ruido'),
      feedLine(since + 2_000, 'warn', 'el disco va justo'),
      feedLine(since + 3_000, 'alert', 'c ha muerto'),
    ]);
    h.push(last, t);

    const s = h.summary(last, since, t);

    assert(s.snapshots === 2, `esperaba 2 instantáneas en el intervalo, hay ${s.snapshots}`);
    assert(s.born.length === 1 && s.born[0]!.id === 'c', `nacimientos: ${JSON.stringify(s.born)}`);
    assert(s.finished.length === 1 && s.finished[0]!.id === 'b', `finales: ${JSON.stringify(s.finished)}`);
    assert(s.died.length === 1 && s.died[0]!.id === 'c', `muertes: ${JSON.stringify(s.died)}`);
    assert(s.blocked.length === 1 && s.blocked[0]!.id === 'a',
      `bloqueos: un agente que se queda bloqueado se cuenta una vez, no una por instantánea (${s.blocked.length})`);
    assert(s.stillBlocked.length === 1 && s.stillBlocked[0]!.id === 'a',
      'a sigue bloqueado en el mundo vivo');
    // Gasto del intervalo: a 0.5 + b 1.0 + c 0.25 = 1.75, no el total de 4.75.
    assert(Math.abs(s.costUSD - 1.75) < 1e-6, `gasto del intervalo: esperaba 1.75, dio ${s.costUSD}`);
    assert(s.lines.length === 2 && s.lines.every((f) => f.level === 'warn' || f.level === 'alert'),
      `líneas: sólo warn/alert del intervalo (${JSON.stringify(s.lines.map((f) => f.text))})`);

    // Nada que contar cuando no hubo ausencia.
    const empty = h.summary(last, t, t);
    assert(empty.born.length === 0 && empty.died.length === 0, 'un intervalo vacío no inventa nada');

    return ok(name, '1 nacido · 1 terminado · 1 muerto · 1 bloqueado · $1.75');
  } catch (err) { return fail(name, String(err)); }
}

/* ── la función pura del cliente ──────────────────────────────────── */

export function testWorldFromSnapshot(): TestResult {
  const name = 'worldFromSnapshot produce agentes que el campo puede dibujar';
  try {
    const live = worldOf([
      { id: 'p', state: 'working', callsign: 'K9' },
      { id: 'k', state: 'idle', parent: 'p', callsign: 'T3' },
    ]);
    // Un agente que ya no existe en el mundo vivo: el campo tiene que poder
    // dibujarlo igual, o el replay se llena de huecos justo donde hubo trabajo.
    const past = snapshotOf(worldOf([
      { id: 'p', state: 'blocked', cost: 3, tps: 12, callsign: 'K9' },
      { id: 'k', state: 'working', cost: 1, tps: 40, parent: 'p', callsign: 'T3' },
      { id: 'gone', state: 'dead', cost: 0.5, project: 'p2', callsign: 'ZZ' },
    ]), 1_700_000_000_000, 0);

    const w = worldFromSnapshot(past, live);

    assert(w.at === past.at, 'el mundo reconstruido debe llevar el instante de la instantánea');
    assert(Object.keys(w.agents).length === 3, `esperaba 3 agentes, hay ${Object.keys(w.agents).length}`);

    for (const a of Object.values(w.agents)) {
      assert(typeof a.id === 'string' && a.id.length > 0, 'id vacío');
      assert(typeof a.callsign === 'string' && a.callsign.length > 0, `callsign vacío en ${a.id}`);
      assert(!!a.metrics && typeof a.metrics.tokensPerSec === 'number', `metrics incompletas en ${a.id}`);
      assert(Array.isArray(a.childIds), `childIds no es un array en ${a.id}`);
      assert(typeof a.runtime === 'string' && a.runtime.length > 0, `runtime vacío en ${a.id}`);
      assert(a.uptimeMs >= 0 && a.startedAt > 0, `tiempos inválidos en ${a.id}`);
    }

    const p = w.agents['p']!;
    const k = w.agents['k']!;
    assert(p.state === 'blocked' && p.block !== null,
      'un agente bloqueado en el pasado necesita un `block`, o la ventana dice que no pasa nada');
    assert(k.state === 'working' && k.block === null, 'un agente no bloqueado no puede llevar block');
    assert(p.childIds.includes('k'), 'el linaje se reconstruye desde parentId');
    assert(k.parentId === 'p', 'parentId perdido');
    assert(w.agents['gone']!.state === 'dead' && w.agents['gone']!.metrics.costUSD === 0.5,
      'un agente que ya no está en el mundo vivo debe reconstruirse igual');
    assert(p.metrics.tokensPerSec === 12 && p.metrics.costUSD === 3, 'métricas de la instantánea perdidas');

    // Los rollups son los del instante, no los de ahora.
    assert(w.fleet.total === 3 && w.fleet.blocked === 1,
      `rollup de flota: ${JSON.stringify(w.fleet)}`);
    assert(w.projects['p1']!.rollup.total === 2, 'el rollup del proyecto debería contar 2 agentes');
    assert(w.projects['p1']!.rollup.blocked === 1, 'el rollup del proyecto debería ver 1 bloqueado');

    // Nada de lo que no guardamos se inventa.
    assert(Object.keys(w.messages).length === 0 && Object.keys(w.escalations).length === 0,
      'el replay no puede dibujar tráfico ni escalaciones que nunca se guardaron');

    // Y el cursor encuentra la instantánea correcta.
    const list = [10, 20, 30, 40].map((n) => snapshotOf(live, n * 1000, 0));
    assert(nearestSnapshot(list, 21_000) === 1, 'nearestSnapshot debería redondear a la más cercana');
    assert(nearestSnapshot(list, 0) === 0 && nearestSnapshot(list, 99_000) === 3, 'extremos');
    assert(nearestSnapshot([], 1) === -1, 'una lista vacía no tiene cursor');

    return ok(name, '3 agentes válidos, linaje y rollups del instante');
  } catch (err) { return fail(name, String(err)); }
}

/* ── las rutas ────────────────────────────────────────────────────── */

export async function testHttpRoutes(): Promise<TestResult> {
  const name = '/api/history submuestrea, capa a 600 y pide token';
  const dir = tempDir();
  const history = new History({ ephemeral: true });
  try {
    const hub = await startHub({
      port: 0, host: '127.0.0.1', quiet: true,
      auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
      store: new HubStore({ dir, flushMs: 10_000 }),
      history,
    });
    try {
      const base = `http://127.0.0.1:${hub.port}`;
      const now = Date.now();
      const w = worldOf([
        { id: 'a', state: 'working' }, { id: 'b', state: 'blocked' }, { id: 'c', state: 'idle' },
      ], [feedLine(now - 60_000, 'alert', 'algo se rompió')]);
      // Casi 24 h a 20 s: lo que el hub tendrá tras un día encendido. Se deja
      // un margen sobre el borde de las 24 h para que el recorte por retención
      // —que corre con el reloj real— no haga parpadear la cuenta.
      for (let i = 4_300; i >= 0; i -= 1) history.push(w, now - i * 20_000);

      const unauth = await fetch(`${base}/api/history`);
      assert(unauth.status === 401, `sin token esperaba 401, dio ${unauth.status}`);

      const res = await fetch(`${base}/api/history?token=${TOKEN}`);
      assert(res.status === 200, `con token esperaba 200, dio ${res.status}`);
      const range = await res.json() as HistoryRange;
      assert(range.total === 4_301, `deberían existir 4.301 instantáneas, dice ${range.total}`);
      assert(range.snapshots.length <= MAX_RANGE,
        `la respuesta trae ${range.snapshots.length}, por encima del techo de ${MAX_RANGE}`);
      assert(range.step > 20_000, `el paso debería haberse ensanchado, es ${range.step}`);
      assert(range.snapshots[range.snapshots.length - 1]!.at === now,
        'la última instantánea debe ser el presente');

      const stepped = await (await fetch(`${base}/api/history?step=3600000&token=${TOKEN}`)).json() as HistoryRange;
      assert(stepped.snapshots.length <= 26,
        `una por hora en 24 h son ~25, no ${stepped.snapshots.length}`);
      assert(stepped.step === 3_600_000, `el paso pedido se respeta si cabe (${stepped.step})`);

      // Un rango vacío no es un error, es un rango vacío.
      const none = await (await fetch(`${base}/api/history?from=1&to=2&token=${TOKEN}`)).json() as HistoryRange;
      assert(none.snapshots.length === 0 && none.total === 0, 'un rango sin historia debe salir vacío');

      const sum = await (await fetch(`${base}/api/history/summary?since=${now - 3_600_000}&token=${TOKEN}`)).json() as HistorySummary;
      assert(sum.snapshots > 0, 'el resumen debería cubrir la última hora');
      assert(typeof sum.costUSD === 'number' && Array.isArray(sum.lines), 'forma del resumen');

      return ok(name, `4.301 instantáneas → ${range.snapshots.length} con paso ${range.step / 1000}s`);
    } finally {
      await hub.close();
    }
  } catch (err) {
    return fail(name, String(err));
  } finally {
    await history.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export default {
  suite: 'history — anillo · compactación · rutas · replay',
  tests: [
    testRingRespectsItsCeilings,
    testCompactionOnBoot,
    testSubsampleCapsAtSixHundred,
    testSummaryCountsTransitions,
    testWorldFromSnapshot,
    testHttpRoutes,
  ],
};
