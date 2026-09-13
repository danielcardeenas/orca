/**
 * El bucle de dos collectors con el mismo id de máquina, pieza por pieza.
 *
 * El 10-09 la máquina real reconectó 4.912 veces en hora y media, a una por
 * segundo, y ninguna prueba lo miraba. Aquí se afirma lo que lo hizo posible
 * y lo que lo hacía invisible:
 *
 *   - el desplazado (close 4009) no vuelve al segundo: espera medio minuto y
 *     dobla hasta cinco, sin que abrir el socket le devuelva al principio;
 *   - una conexión que abre y muere en un segundo no resetea la escalera de
 *     red, una que dura un minuto sí;
 *   - el hub distingue el reemplazo repetido, y el ping-pong, de una
 *     reconexión normal, y lo deja en el log de eventos y en el feed.
 *
 *   npm test -- reconnect
 */

import { CLOSE_REPLACED } from '../src/shared/protocol.ts';
import type { CollectorInstance } from '../src/shared/protocol.ts';
import {
  ReconnectPolicy, RECONNECT_MIN_MS, RECONNECT_MAX_MS, REPLACED_MIN_MS, REPLACED_MAX_MS, STABLE_MS,
} from '../src/collector/reconnect.ts';
import { ReplacementWatch, REPLACEMENT_WINDOW_MS, replacementText } from '../src/hub/replacements.ts';
import { World } from '../src/hub/world.ts';
import type { WorldEvent } from '../src/hub/world.ts';

export interface TestResult { name: string; pass: boolean; detail: string }

function ok(name: string, detail = ''): TestResult { return { name, pass: true, detail }; }
function fail(name: string, detail: string): TestResult { return { name, pass: false, detail }; }
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

/** Sin jitter: las esperas salen exactas y se pueden afirmar. */
const flat = (): ReconnectPolicy => new ReconnectPolicy({ random: () => 0 });

const A: CollectorInstance = { pid: 111, cwd: '/a', startedAt: 1 };
const B: CollectorInstance = { pid: 222, cwd: '/b', startedAt: 2 };
const C: CollectorInstance = { pid: 333, cwd: '/c', startedAt: 3 };

/* ── collector: el desplazado ─────────────────────────────────────── */

export function testDisplacedDoesNotLoopEverySecond(): TestResult {
  const name = 'desplazado: abrir y ser echado al segundo no vuelve a 1 s';
  try {
    const p = flat();
    let now = 0;
    const waits: number[] = [];
    // El bucle del 10-09, tal cual: abre, el hub lo echa a los ~1.150 ms, vuelve.
    for (let i = 0; i < 12; i++) {
      p.opened(now);
      now += 1_150;
      const plan = p.closed(CLOSE_REPLACED, now);
      assert(plan.replaced, `vuelta ${i}: el plan sabe que fue un reemplazo`);
      assert(plan.streak === i + 1, `vuelta ${i}: racha ${plan.streak}`);
      waits.push(plan.waitMs);
      now += plan.waitMs;
    }
    assert(waits.every((w) => w >= REPLACED_MIN_MS), `ninguna espera baja de ${REPLACED_MIN_MS}: ${waits.join(',')}`);
    assert(waits[0] === REPLACED_MIN_MS && waits[1] === 2 * REPLACED_MIN_MS && waits[2] === 4 * REPLACED_MIN_MS, `dobla: ${waits.slice(0, 3).join(',')}`);
    assert(waits.slice(4).every((w) => w === REPLACED_MAX_MS), `se queda en ${REPLACED_MAX_MS}: ${waits.slice(4).join(',')}`);
    // Doce vueltas del bucle antiguo eran ~14 s; ahora son más de media hora.
    const total = waits.reduce((a, b) => a + b, 0);
    assert(total > 30 * 60_000, `doce vueltas tardan ${Math.round(total / 1000)} s`);
    return ok(name, `esperas ${waits.map((w) => w / 1000).join('/')} s; doce vueltas ≈ ${Math.round(total / 60_000)} min`);
  } catch (err) { return fail(name, String(err)); }
}

export function testDisplacedLadderResetsOnlyAfterHolding(): TestResult {
  const name = 'desplazado: la escalera baja sólo tras quedarse cinco minutos';
  try {
    const p = flat();
    let now = 0;
    for (let i = 0; i < 4; i++) { p.opened(now); now += 1_000; now += p.closed(CLOSE_REPLACED, now).waitMs; }
    assert(p.displacedStreak === 4, `racha 4, es ${p.displacedStreak}`);
    // Vuelve y aguanta justo menos del máximo: sigue siendo la misma pelea.
    p.opened(now); now += REPLACED_MAX_MS - 1;
    let plan = p.closed(CLOSE_REPLACED, now);
    assert(plan.streak === 5 && plan.waitMs === REPLACED_MAX_MS, `aguantar 4:59 no baja: racha ${plan.streak}, espera ${plan.waitMs}`);
    now += plan.waitMs;
    // Vuelve y aguanta cinco minutos: ganó; el siguiente empujón empieza abajo.
    p.opened(now); now += REPLACED_MAX_MS;
    plan = p.closed(CLOSE_REPLACED, now);
    assert(plan.streak === 1 && plan.waitMs === REPLACED_MIN_MS, `tras cinco minutos baja: racha ${plan.streak}, espera ${plan.waitMs}`);
    return ok(name);
  } catch (err) { return fail(name, String(err)); }
}

export function testNetworkBackoffResetsByLastingNotByOpening(): TestResult {
  const name = 'red: la espera se resetea por durar, no por abrir';
  try {
    const p = flat();
    let now = 0;
    // Tres caídas seguidas sin abrir: escalera 1 → 1,8 → 3,24 s.
    const w1 = p.failed().waitMs; const w2 = p.failed().waitMs; const w3 = p.failed().waitMs;
    assert(w1 === RECONNECT_MIN_MS && w2 === 1_800 && w3 === 3_240, `escalera ${w1},${w2},${w3}`);
    // Abre y muere en un segundo (código de red, 1006): NO vuelve a 1 s.
    p.opened(now); now += 1_000;
    const short = p.closed(1006, now);
    assert(!short.replaced && short.waitMs > w3, `un segundo abierto no resetea: ${short.waitMs} > ${w3}`);
    // Abre y dura un minuto: sí.
    p.opened(now); now += STABLE_MS;
    const long = p.closed(1006, now);
    assert(long.waitMs === RECONNECT_MIN_MS, `un minuto abierto resetea: ${long.waitMs}`);
    // Y nunca pasa del máximo.
    let last = 0;
    for (let i = 0; i < 20; i++) last = p.failed().waitMs;
    assert(last === RECONNECT_MAX_MS, `tope ${last}`);
    return ok(name, `1 s abierto → ${short.waitMs} ms; 60 s abierto → ${long.waitMs} ms`);
  } catch (err) { return fail(name, String(err)); }
}

export function testReplacedDoesNotTouchNetworkLadder(): TestResult {
  const name = 'las dos escaleras son independientes';
  try {
    const p = flat();
    let now = 0;
    p.opened(now); now += 500;
    p.closed(CLOSE_REPLACED, now);
    p.opened(now); now += 500;
    p.closed(CLOSE_REPLACED, now);
    // Después de dos reemplazos, una caída de red normal sigue en 1 s: no es la
    // misma pelea, y el hub caído no debe pagar la espera del reemplazo.
    const plan = p.failed();
    assert(plan.waitMs === RECONNECT_MIN_MS, `red tras reemplazos: ${plan.waitMs}`);
    return ok(name);
  } catch (err) { return fail(name, String(err)); }
}

/* ── hub: el vigilante ────────────────────────────────────────────── */

export function testOneReplacementIsARestart(): TestResult {
  const name = 'hub: un reemplazo es un reinicio, no un aviso';
  try {
    const w = new ReplacementWatch();
    const v = w.note('m1', A, B, 1_000);
    assert(v.count === 1 && !v.repeated && !v.pingPong, `primero: ${JSON.stringify(v)}`);
    // Otro reinicio, pasada la ventana: sigue sin ser aviso.
    const later = w.note('m1', B, C, 1_000 + REPLACEMENT_WINDOW_MS + 1);
    assert(later.count === 1 && !later.repeated, `fuera de ventana: ${JSON.stringify(later)}`);
    assert(w.recent('m1', 1_000 + REPLACEMENT_WINDOW_MS + 1).length === 1, 'olvida lo que salió de la ventana');
    return ok(name);
  } catch (err) { return fail(name, String(err)); }
}

export function testRepeatedReplacementIsASymptom(): TestResult {
  const name = 'hub: el segundo reemplazo en la ventana avisa, y el ping-pong se reconoce';
  try {
    const w = new ReplacementWatch();
    w.note('m1', A, B, 1_000);
    // B echa a A, y ahora A vuelve y echa a B: el que entra es uno al que echaron.
    const v = w.note('m1', B, A, 2_200);
    assert(v.count === 2 && v.repeated, `segundo cuenta: ${JSON.stringify(v)}`);
    assert(v.pingPong, 'A vuelve tras ser echado: ping-pong');
    const text = replacementText('mac-real', v);
    assert(/echando el uno al otro/.test(text), `texto: ${text}`);
    assert(/pid 111/.test(text) && /pid 222/.test(text), `nombra a los dos: ${text}`);
    // Dos reinicios distintos seguidos (A→B→C) también avisan, pero sin acusar ping-pong.
    const w2 = new ReplacementWatch();
    w2.note('m2', A, B, 0);
    const v2 = w2.note('m2', B, C, 5_000);
    assert(v2.repeated && !v2.pingPong, `A→B→C: ${JSON.stringify(v2)}`);
    assert(/sustituido 2 veces/.test(replacementText('otra', v2)), `texto: ${replacementText('otra', v2)}`);
    // Las máquinas no se mezclan.
    const v3 = w2.note('m3', A, B, 5_000);
    assert(v3.count === 1, 'otra máquina empieza de cero');
    // Collectors viejos, sin instancia: cuenta igual, sin poder acusar ping-pong.
    const w3 = new ReplacementWatch();
    w3.note('m4', null, null, 0);
    const v4 = w3.note('m4', null, null, 1_000);
    assert(v4.repeated && !v4.pingPong, `sin instancia: ${JSON.stringify(v4)}`);
    return ok(name, text);
  } catch (err) { return fail(name, String(err)); }
}

export function testWorldRecordsReplacementDistinctFromReconnect(): TestResult {
  const name = 'world: el reemplazo queda en el log aparte de machine:reconnect, y el repetido en el feed';
  try {
    const events: WorldEvent[] = [];
    const world = new World({ onEvent: (e) => events.push(e) });
    const hello = (): void => world.applyCollector({
      t: 'hello', v: 1, token: 't',
      machine: { id: 'm1', hostname: 'mac-real', platform: 'darwin', version: '1', online: true, lastSeen: 0, connectedAt: 0, load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null } },
    }, 'm1');
    hello();
    const w = new ReplacementWatch();
    hello(); world.noteMachineReplaced('m1', w.note('m1', A, B, 1_000));
    const feedBefore = world.state.feed.length;
    hello(); world.noteMachineReplaced('m1', w.note('m1', B, A, 2_000));
    const kinds = events.map((e) => e.kind);
    assert(kinds.filter((k) => k === 'machine:replaced').length === 2, `dos machine:replaced en ${kinds.join(',')}`);
    assert(kinds.filter((k) => k === 'machine:reconnect').length === 2, `y dos machine:reconnect en ${kinds.join(',')}`);
    const last = events.filter((e) => e.kind === 'machine:replaced').at(-1)!;
    const data = last.data as { count: number; pingPong: boolean; to: CollectorInstance };
    assert(data.count === 2 && data.pingPong && data.to.pid === A.pid, `data: ${JSON.stringify(data)}`);
    assert(/pid 111/.test(last.text ?? '') && /pid 222/.test(last.text ?? ''), `texto del evento: ${last.text}`);
    // El primero no avisa en el feed; el segundo sí, y como alerta.
    const alerts = world.state.feed.slice(feedBefore).filter((f) => f.level === 'alert');
    assert(alerts.length === 1, `una alerta nueva en el feed, hay ${alerts.length}`);
    assert(/echando el uno al otro/.test(alerts[0]!.text), `alerta: ${alerts[0]!.text}`);
    assert(kinds.includes('feed:alert'), 'y la alerta también queda como evento');
    return ok(name, alerts[0]!.text);
  } catch (err) { return fail(name, String(err)); }
}

export default {
  suite: 'reconnect — el bucle de dos collectors con el mismo id',
  tests: [
    testDisplacedDoesNotLoopEverySecond,
    testDisplacedLadderResetsOnlyAfterHolding,
    testNetworkBackoffResetsByLastingNotByOpening,
    testReplacedDoesNotTouchNetworkLadder,
    testOneReplacementIsARestart,
    testRepeatedReplacementIsASymptom,
    testWorldRecordsReplacementDistinctFromReconnect,
  ],
};
