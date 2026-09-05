/**
 * Pruebas del hub. Runner casero: cada test es una función exportada que
 * devuelve `{ name, pass, detail }`. Sin framework, sin dependencias nuevas.
 *
 *   npx tsx test/run.ts
 *
 * Hay dos capas: pruebas de unidad sobre world/bus/memory/auth/persist, y
 * pruebas de integración que levantan un hub de verdad en un puerto efímero y
 * le conectan el collector falso. Estas últimas son las que importan: el
 * collector real todavía no existe y esto es lo que demuestra que el contrato
 * funciona de punta a punta.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import type { Agent, CeoMessage, Escalation, FeedItem } from '../src/shared/types.ts';
import type { ServerFrame } from '../src/shared/protocol.ts';
import { PATHS, PROTOCOL_VERSION, newId } from '../src/shared/protocol.ts';
import { BEAT_TIMEOUT_MS } from '../src/shared/protocol.ts';

import { World, looksLikeSecret } from '../src/hub/world.ts';
import { PatchBus } from '../src/hub/bus.ts';
import { AnswerMemory, similarity } from '../src/hub/memory.ts';
import { HubStore } from '../src/hub/persist.ts';
import { createAuth, isLoopback, CLOSE_UNAUTHORIZED } from '../src/hub/auth.ts';
import { startHub } from '../src/hub/server.ts';
import type { Hub } from '../src/hub/server.ts';
import { startFakeFleet } from './fake-collector.ts';

export interface TestResult { name: string; pass: boolean; detail: string }

const TOKEN = 'test-token-orca-0000';

/* ── utilidades ───────────────────────────────────────────────────── */

function ok(name: string, detail = ''): TestResult { return { name, pass: true, detail }; }
function fail(name: string, detail: string): TestResult { return { name, pass: false, detail }; }

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timeout esperando: ${what}`);
}

function tempDir(): string { return mkdtempSync(join(tmpdir(), 'orca-hub-test-')); }

function agentFixture(over: Partial<Agent> = {}): Agent {
  const now = Date.now();
  return {
    id: over.id ?? newId('sess'), machineId: 'm1', projectId: 'p1',
    title: 'prueba', callsign: 'K1', runtime: 'claude', state: 'working', block: null,
    parentId: null, depth: 0, childIds: [], mission: null,
    squad: null, lead: false,
    model: 'claude-opus-4-6', tool: 'Bash', toolDetail: 'npm run build',
    lastPrompt: null, lastSay: null, startedAt: now, updatedAt: now, uptimeMs: 0,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
      tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0,
      toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    background: false, shortId: null,
    ...over,
  };
}

/** Cliente de consola con buffer de frames, para las pruebas de integración. */
class TestConsole {
  ws: WebSocket;
  frames: ServerFrame[] = [];
  closedWith: number | null = null;

  constructor(port: number, token: string | null) {
    const q = token === null ? '' : `?token=${encodeURIComponent(token)}`;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${PATHS.console}${q}`);
    this.ws.on('message', (d) => {
      try { this.frames.push(JSON.parse(d.toString()) as ServerFrame); } catch { /* ignora */ }
    });
    this.ws.on('close', (code) => { this.closedWith = code; });
    this.ws.on('error', () => { /* esperado en las pruebas de auth */ });
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('close', (code) => reject(new Error(`cerró con ${code}`)));
    });
  }
  send(frame: unknown): void { this.ws.send(JSON.stringify(frame)); }
  of<T extends ServerFrame['t']>(t: T): Extract<ServerFrame, { t: T }>[] {
    return this.frames.filter((f) => f.t === t) as Extract<ServerFrame, { t: T }>[];
  }
  close(): void { try { this.ws.close(); } catch { /* ya */ } }
}

/* ── world ────────────────────────────────────────────────────────── */

export function testRevIncrementsExactlyOne(): TestResult {
  const name = 'world: cada mutación sube rev exactamente 1';
  try {
    const ops: number[] = [];
    const world = new World({ onOps: (o) => ops.push(o.length) });
    assert(world.state.rev === 0, 'arranca en 0');

    world.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agentFixture({ id: 'a1' }) }, 'm1');
    const afterNew = world.state.rev;
    assert(afterNew === 1, `agent:new debía dejar rev=1, dejó ${afterNew}`);

    world.applyCollector({ t: 'agent', machineId: 'm1', id: 'a1', patch: { state: 'idle' } }, 'm1');
    assert(world.state.rev === 2, `agent patch debía dejar rev=2, dejó ${world.state.rev}`);

    // Un patch que no cambia nada útil no debe inventar revisiones.
    world.applyCollector({ t: 'agent', machineId: 'm1', id: 'a1', patch: {} }, 'm1');
    assert(world.state.rev === 2, `patch vacío no debe subir rev (${world.state.rev})`);

    // Un frame de un agente desconocido tampoco.
    world.applyCollector({ t: 'agent', machineId: 'm1', id: 'noexiste', patch: { state: 'done' } }, 'm1');
    assert(world.state.rev === 2, 'patch huérfano no debe subir rev');

    assert(ops.length >= 2, 'debía emitir ops');
    return ok(name, `rev=${world.state.rev}, ${ops.length} lotes de ops`);
  } catch (err) { return fail(name, String(err)); }
}

export function testRollupsAreIncrementalAndCorrect(): TestResult {
  const name = 'world: rollups por proyecto y de flota';
  try {
    const world = new World();
    world.applyCollector({
      t: 'snapshot', machineId: 'm1',
      projects: [
        { id: 'p1', machineId: 'm1', slug: 'p1', name: 'uno', path: '/p1', code: 'P1', gitBranch: 'main', gitDirty: false, keyNames: [], sessionIds: [], rollup: { total: 0, byState: { booting: 0, thinking: 0, working: 0, blocked: 0, idle: 0, done: 0, dead: 0 }, costUSD: 0, tokensPerSec: 0, blocked: 0 } },
        { id: 'p2', machineId: 'm1', slug: 'p2', name: 'dos', path: '/p2', code: 'P2', gitBranch: 'main', gitDirty: true, keyNames: [], sessionIds: [], rollup: { total: 0, byState: { booting: 0, thinking: 0, working: 0, blocked: 0, idle: 0, done: 0, dead: 0 }, costUSD: 0, tokensPerSec: 0, blocked: 0 } },
      ],
      agents: [
        agentFixture({ id: 'a1', projectId: 'p1', state: 'working' }),
        agentFixture({ id: 'a2', projectId: 'p1', state: 'blocked' }),
        agentFixture({ id: 'a3', projectId: 'p2', state: 'idle' }),
      ],
      keys: [],
    }, 'm1');

    world.settle();
    const p1 = world.state.projects['p1'];
    const p2 = world.state.projects['p2'];
    assert(p1 && p1.rollup.total === 2, `p1 debía tener 2 agentes, tiene ${p1?.rollup.total}`);
    assert(p1 && p1.rollup.blocked === 1, 'p1 debía tener 1 bloqueado');
    assert(p2 && p2.rollup.total === 1, 'p2 debía tener 1 agente');
    assert(world.state.fleet.total === 3, `flota=3, es ${world.state.fleet.total}`);
    assert(world.state.fleet.blocked === 1, 'flota con 1 bloqueado');

    // Métricas: el patch de métricas debe fundirse, no reemplazar.
    world.applyCollector({
      t: 'agent', machineId: 'm1', id: 'a1',
      patch: { metrics: { costUSD: 2.5, tokensPerSec: 40 } as Agent['metrics'] },
    }, 'm1');
    world.settle();
    const a1 = world.state.agents['a1'];
    assert(a1 && a1.metrics.costUSD === 2.5, 'costo fundido');
    assert(a1 && a1.metrics.turns === 0, 'los contadores no presentes en el patch sobreviven');
    assert(Math.abs(world.state.fleet.costUSD - 2.5) < 1e-9, `costo de flota ${world.state.fleet.costUSD}`);
    assert(world.state.fleet.tokensPerSec === 40, 'tokens/seg de flota');

    // Cambio de estado → se refleja en el rollup del proyecto.
    world.applyCollector({ t: 'agent', machineId: 'm1', id: 'a2', patch: { state: 'done' } }, 'm1');
    world.settle();
    assert(world.state.fleet.blocked === 0, 'ya no hay bloqueados');
    assert(world.state.projects['p1']?.rollup.byState.done === 1, 'p1 con 1 done');
    return ok(name, `flota total=${world.state.fleet.total} costo=$${world.state.fleet.costUSD.toFixed(2)}`);
  } catch (err) { return fail(name, String(err)); }
}

export function testOfflineMachineKillsAgentsButKeepsRecords(): TestResult {
  const name = 'world: máquina sin latido → agentes dead, registros intactos';
  try {
    let clock = 1_000_000;
    const world = new World({ now: () => clock });
    world.applyCollector({
      t: 'hello', v: PROTOCOL_VERSION, token: 'x',
      machine: {
        id: 'm1', hostname: 'host', platform: 'linux', version: '1', online: true,
        lastSeen: clock, connectedAt: clock,
        load: { sessions: 2, activeSessions: 2, cpuPct: 10, memPct: 20 },
      },
    }, 'm1');
    world.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agentFixture({ id: 'a1', state: 'working' }) }, 'm1');
    world.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agentFixture({ id: 'a2', state: 'done' }) }, 'm1');

    clock += BEAT_TIMEOUT_MS - 1;
    world.sweep(clock);
    assert(world.state.machines['m1']?.online === true, 'todavía online justo antes del timeout');

    clock += 2;
    world.sweep(clock);
    assert(world.state.machines['m1']?.online === false, 'debía quedar offline');
    assert(world.state.agents['a1']?.state === 'dead', 'el agente vivo pasa a dead');
    assert(world.state.agents['a2']?.state === 'done', 'el que ya había terminado no se toca');
    assert(Object.keys(world.state.agents).length === 2, 'no se borra ningún registro');
    return ok(name, 'offline + dead sin perder historial');
  } catch (err) { return fail(name, String(err)); }
}

export function testFeedAndCeoAreTrimmed(): TestResult {
  const name = 'world: feed a 500 y CEO a 100, el resto al overflow';
  try {
    const overflow: Record<string, number> = { feed: 0, ceo: 0 };
    const world = new World({
      onOverflow: (kind, items) => { overflow[kind] = (overflow[kind] ?? 0) + items.length; },
    });
    for (let i = 0; i < 7; i++) {
      const items: FeedItem[] = Array.from({ length: 100 }, (_, j) => ({
        id: `f${i}_${j}`, at: Date.now(), level: 'trace', source: 'T', text: `linea ${i}-${j}`,
      }));
      world.applyCollector({ t: 'feed', machineId: 'm1', items }, 'm1');
    }
    assert(world.state.feed.length === 500, `feed debía quedar en 500, quedó en ${world.state.feed.length}`);
    assert(overflow['feed'] === 200, `200 al overflow, hubo ${overflow['feed']}`);
    assert(world.state.feed[499]?.id === 'f6_99', 'se conservan los últimos, no los primeros');

    for (let i = 0; i < 130; i++) {
      const msg: CeoMessage = { id: `m${i}`, role: 'human', text: `hola ${i}`, at: Date.now(), actions: [] };
      world.addCeoMessage(msg);
    }
    assert(world.state.ceo.messages.length === 100, `ceo en 100, hay ${world.state.ceo.messages.length}`);
    assert(overflow['ceo'] === 30, `30 mensajes al overflow, hubo ${overflow['ceo']}`);
    return ok(name, `feed=500 (+${overflow['feed']} archivados), ceo=100 (+${overflow['ceo']})`);
  } catch (err) { return fail(name, String(err)); }
}

export function testSecretsNeverEnterTheWorld(): TestResult {
  const name = 'world: secretos tachados y KeyDescriptor con valor descartado';
  try {
    const world = new World();
    assert(looksLikeSecret('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA'), 'debía reconocer una clave de Anthropic');
    assert(!looksLikeSecret('src/hub/world.ts línea 42'), 'no debe ver secretos donde no los hay');

    world.applyCollector({
      t: 'feed', machineId: 'm1',
      items: [{
        id: 'f1', at: Date.now(), level: 'info', source: 'AX/K9',
        text: 'exporté ANTHROPIC_API_KEY=sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZ y ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }],
    }, 'm1');
    const line = world.state.feed[0]?.text ?? '';
    assert(!line.includes('sk-ant-api03-ZZZZ'), `el secreto sigue ahí: ${line}`);
    assert(!line.includes('ghp_aaaa'), `el token de GitHub sigue ahí: ${line}`);
    assert(line.includes('[REDACTED]'), 'debía dejar la marca de tachado');

    world.applyCollector({
      t: 'snapshot', machineId: 'm1', projects: [], agents: [],
      keys: [
        { name: 'GOOD', projectId: 'p1', hint: 'ab12', addedAt: 1, lastUsedAt: null, usedBy: [] },
        // Un collector defectuoso que manda el valor: se tira entero.
        { name: 'BAD', projectId: 'p1', hint: 'cd34', addedAt: 1, lastUsedAt: null, usedBy: [], value: 'sk-ant-secret' } as never,
      ],
    }, 'm1');
    const keys = Object.values(world.state.keys);
    assert(keys.length === 1, `debía guardar 1 clave, guardó ${keys.length}`);
    assert(keys[0]?.name === 'GOOD', 'la que sobrevive es la buena');
    assert(JSON.stringify(world.state).includes('sk-ant-secret') === false, 'el valor no puede estar en el mundo');

    // Ids venenosos para un Record plano.
    world.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agentFixture({ id: '__proto__' }) }, 'm1');
    // Ojo: `agents['__proto__']` devuelve el prototipo, no undefined. Lo que
    // importa es que no exista como propiedad propia.
    assert(!Object.prototype.hasOwnProperty.call(world.state.agents, '__proto__'),
      'no se acepta __proto__ como id');
    return ok(name, `${world.stats.keysRejected} descriptor(es) rechazado(s)`);
  } catch (err) { return fail(name, String(err)); }
}

export function testLineageIsMaintained(): TestResult {
  const name = 'world: linaje padre → hijo';
  try {
    const world = new World();
    world.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agentFixture({ id: 'padre' }) }, 'm1');
    world.applyCollector({
      t: 'agent:new', machineId: 'm1',
      agent: agentFixture({ id: 'hijo', parentId: 'padre', depth: 1 }),
    }, 'm1');
    assert(world.state.agents['padre']?.childIds.includes('hijo'), 'el padre debía adoptar al hijo');
    world.applyCollector({ t: 'agent:gone', machineId: 'm1', id: 'hijo' }, 'm1');
    assert(world.state.agents['padre']?.childIds.length === 0, 'el hijo se desengancha al desaparecer');
    return ok(name, 'childIds se mantiene en ambos sentidos');
  } catch (err) { return fail(name, String(err)); }
}

/* ── bus ──────────────────────────────────────────────────────────── */

export async function testBusCoalescesAndPacesAt10Hz(): Promise<TestResult> {
  const name = 'bus: colapsa ops repetidas y no pasa de 10 Hz';
  try {
    const frames: { rev: number; ops: number }[] = [];
    const bus = new PatchBus({ hz: 10, onFlush: (f) => frames.push({ rev: f.rev, ops: f.ops.length }) });
    // El bus emite el primer op tras un periodo de calma al instante (flanco de
    // subida), así que abrimos la ventana antes de medir la ráfaga.
    bus.flush();

    // Ráfaga: 60 patches sobre 3 agentes en la misma ventana.
    for (let i = 0; i < 60; i++) {
      bus.push({ o: 'agent:patch', id: `a${i % 3}`, v: { uptimeMs: i } });
    }
    await sleep(250);

    const total = frames.reduce((n, f) => n + f.ops, 0);
    assert(frames.length <= 3, `demasiados frames: ${frames.length}`);
    assert(total <= 6, `debía colapsar a ~3 ops, salieron ${total}`);
    assert(frames.every((f, i) => i === 0 || f.rev === (frames[i - 1]?.rev ?? 0) + 1), 'revs consecutivos');

    // La fusión conserva el último valor.
    const merged = new PatchBus({ hz: 10, onFlush: () => {} });
    merged.flush();
    merged.push({ o: 'agent:patch', id: 'x', v: { state: 'working', uptimeMs: 1 } });
    merged.push({ o: 'agent:patch', id: 'x', v: { uptimeMs: 99 } });
    const frame = merged.flush();
    assert(frame !== null && frame.ops.length === 1, 'dos parches del mismo agente son uno');
    const op = frame?.ops[0];
    assert(op?.o === 'agent:patch' && op.v.uptimeMs === 99 && op.v.state === 'working',
      'el último gana pero no borra lo anterior');
    merged.stop();
    bus.stop();
    return ok(name, `${frames.length} frame(s), ${total} op(s) tras 60 mutaciones`);
  } catch (err) { return fail(name, String(err)); }
}

export function testBusMergesFullRecordWithPatch(): TestResult {
  const name = 'bus: registro completo + parche = registro completo';
  try {
    const bus = new PatchBus({ hz: 10, onFlush: () => {} });
    bus.flush();
    const full = agentFixture({ id: 'a1', state: 'working' });
    bus.push({ o: 'agent', id: 'a1', v: full });
    bus.push({ o: 'agent:patch', id: 'a1', v: { state: 'blocked' } });
    const frame = bus.flush();
    const op = frame?.ops[0];
    assert(frame?.ops.length === 1, 'debía quedar un solo op');
    assert(op?.o === 'agent', `debía seguir siendo registro completo, es ${op?.o}`);
    assert(op?.o === 'agent' && op.v?.state === 'blocked', 'con el parche ya aplicado');
    bus.stop();
    return ok(name, 'la consola que llega tarde recibe el registro entero');
  } catch (err) { return fail(name, String(err)); }
}

/* ── memoria ──────────────────────────────────────────────────────── */

export async function testMemoryRecall(): Promise<TestResult> {
  const name = 'memory: recuerda respuestas y las encuentra por parecido';
  try {
    const dir = tempDir();
    const mem = new AnswerMemory(join(dir, 'memory.jsonl'));
    mem.remember({
      question: '¿Puedo borrar la rama legacy/hero-v1 del remoto?',
      answer: 'Sí, pero archívala en un tag antes.',
      rememberAs: 'Ramas viejas: archivar en tag y luego borrar',
      projectId: 'p_axolots',
    });
    mem.remember({
      question: 'Which database should the migration target?',
      answer: 'Always staging first, prod only after a green run.',
      rememberAs: 'Migrations go to staging first',
      projectId: 'p_orca',
    });
    mem.remember({
      question: '¿Despliego a producción ahora?',
      answer: 'No sin PR revisado.',
      rememberAs: null, projectId: 'p_orca',
    });

    const hits = mem.recall('¿puedo borrar la rama legacy/foo del remoto?');
    assert(hits.length > 0, 'debía encontrar algo');
    assert(hits[0]?.entry.answer.startsWith('Sí, pero archívala'), `encontró la equivocada: ${hits[0]?.entry.question}`);
    assert((hits[0]?.score ?? 0) > 0.34, `score bajo: ${hits[0]?.score}`);

    const en = mem.recall('which database should this migration target?');
    assert(en[0]?.entry.projectId === 'p_orca', 'el match en inglés también funciona');

    const nada = mem.recall('cómo se llama el perro del vecino');
    assert(nada.length === 0, `no debía encontrar nada, encontró ${nada.length}`);

    // Persistencia: otra instancia sobre el mismo archivo ve lo mismo.
    await mem.flush();
    const reloaded = new AnswerMemory(join(dir, 'memory.jsonl'));
    assert(reloaded.size === 3, `debía releer 3 entradas, leyó ${reloaded.size}`);
    assert(reloaded.recall('borrar rama legacy').length > 0, 'y seguir encontrándolas');

    assert(similarity('borrar la rama vieja', 'borrar la rama vieja') > 0.99, 'idénticas ≈ 1');
    assert(similarity('borrar la rama', 'desplegar a producción') < 0.2, 'distintas ≈ 0');

    rmSync(dir, { recursive: true, force: true });
    return ok(name, `3 recuerdos, top score ${hits[0]?.score}`);
  } catch (err) { return fail(name, String(err)); }
}

/* ── auth ─────────────────────────────────────────────────────────── */

export function testAuth(): TestResult {
  const name = 'auth: token exigido fuera de loopback';
  try {
    const strict = createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv);
    assert(strict.check(TOKEN, '10.0.0.5').ok, 'el token correcto pasa');
    assert(!strict.check('otro', '127.0.0.1').ok, 'un token incorrecto no pasa ni en local');
    assert(!strict.check(null, '127.0.0.1').ok, 'con ORCA_TOKEN definido no hay puerta trasera');
    assert(strict.allowLoopbackAnonymous === false, 'sin modo dev cuando el humano fijó el token');

    const dev = createAuth({ ORCA_HOME: tempDir() } as NodeJS.ProcessEnv);
    assert(dev.token.length >= 16, 'genera un token usable');
    assert(dev.check(null, '127.0.0.1').anonymous === true, 'en dev, loopback sin token pasa');
    assert(!dev.check(null, '203.0.113.9').ok, 'pero de fuera no');
    assert(dev.banner().some((l) => l.includes('MODO DEV')), 'y lo grita en el arranque');

    assert(isLoopback('::ffff:127.0.0.1') && isLoopback('::1') && !isLoopback('8.8.8.8'), 'detección de loopback');
    return ok(name, `token de ${strict.token.length} chars, modo dev detectado`);
  } catch (err) { return fail(name, String(err)); }
}

/* ── persistencia ─────────────────────────────────────────────────── */

export async function testPersistCeoRoundTrip(): Promise<TestResult> {
  const name = 'persist: la conversación del CEO sobrevive un reinicio';
  try {
    const dir = tempDir();
    const store = new HubStore({ dir });
    const msgs: CeoMessage[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, role: i % 2 ? 'ceo' : 'human', text: `mensaje ${i}`, at: Date.now(), actions: [],
      ...(i === 4 ? { streaming: true } : {}),
    }));
    for (const m of msgs) store.appendCeo(m);
    store.logEvent({ at: Date.now(), kind: 'agent:state', machineId: 'm1', text: 'working → blocked' });
    const esc: Escalation = {
      id: 'e1', agentId: 'a1', projectId: 'p1', machineId: 'm1',
      question: '¿borro la rama?', context: null, options: [], optionsOnly: false,
      urgency: 'normal', status: 'answered', ceoAttempt: null, answer: 'sí',
      answeredBy: 'human', rememberAs: 'ramas viejas se borran', askedAt: 1, answeredAt: 2, expiresAt: null,
    };
    store.saveAnswered(esc);
    await store.flush();
    await store.close();

    const again = new HubStore({ dir });
    const loaded = again.loadCeo();
    assert(loaded.length === 5, `debía recuperar 5 mensajes, recuperó ${loaded.length}`);
    assert(loaded[4]?.streaming === false, 'un mensaje a medio streaming deja de estarlo tras reiniciar');
    const answered = again.loadAnswered();
    assert(answered[0]?.rememberAs === 'ramas viejas se borran', 'la escalación resuelta se relee entera');
    await again.close();
    rmSync(dir, { recursive: true, force: true });
    return ok(name, `${loaded.length} mensajes y ${answered.length} escalación(es) recuperadas`);
  } catch (err) { return fail(name, String(err)); }
}

/* ── integración ──────────────────────────────────────────────────── */

async function withHub<T>(fn: (hub: Hub) => Promise<T>): Promise<T> {
  const dir = tempDir();
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    store: new HubStore({ dir }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
  });
  try {
    return await fn(hub);
  } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function testEndToEndWithFakeFleet(): Promise<TestResult> {
  const name = 'integración: flota falsa → hub → consola';
  try {
    return await withHub(async (hub) => {
      const fleet = startFakeFleet({
        hub: `ws://127.0.0.1:${hub.port}`, token: TOKEN, quiet: true, speed: 6,
      });
      try {
        await until(() => Object.keys(hub.world.state.machines).length === 3, 8_000, '3 máquinas');
        await until(() => hub.world.state.fleet.total >= 18, 8_000, '18+ agentes');
        await until(() => Object.keys(hub.world.state.projects).length === 6, 8_000, '6 proyectos');

        const console1 = new TestConsole(hub.port, TOKEN);
        await console1.open();
        await until(() => console1.of('world').length === 1, 4_000, 'frame de mundo');
        const world = console1.of('world')[0]?.state;
        assert(world !== undefined, 'la consola recibe el mundo al conectar');
        assert(Object.keys(world?.machines ?? {}).length === 3, 'con las 3 máquinas dentro');

        await until(() => console1.of('patch').length >= 3, 6_000, 'patches incrementales');
        const patches = console1.of('patch');
        const start = world?.rev ?? 0;
        const first = patches[0]?.rev ?? 0;
        assert(first === start + 1, `el primer patch debía ser rev ${start + 1}, fue ${first}`);
        for (let i = 1; i < patches.length; i++) {
          const prev = patches[i - 1]?.rev ?? 0;
          const cur = patches[i]?.rev ?? 0;
          assert(cur === prev + 1, `hueco de rev: ${prev} → ${cur}`);
        }

        // Los rollups tienen sentido y hay actividad real.
        const health = await (await fetch(`http://127.0.0.1:${hub.port}/api/health`)).json() as Record<string, unknown>;
        const agents = health['agents'] as { total: number; byState: Record<string, number> };
        assert(agents.total >= 18, `salud reporta ${agents.total} agentes`);
        const live = (agents.byState['working'] ?? 0) + (agents.byState['thinking'] ?? 0);
        assert(live > 0, 'debería haber agentes trabajando');

        const detail = `${agents.total} agentes, ${Object.keys(hub.world.state.projects).length} proyectos, `
          + `${patches.length} patches, rev ${start}→${patches[patches.length - 1]?.rev}`;
        console1.close();
        return ok(name, detail);
      } finally {
        fleet.stop();
      }
    });
  } catch (err) { return fail(name, String(err)); }
}

export async function testCommandRoundTrip(): Promise<TestResult> {
  const name = 'integración: comando de consola → collector → ack';
  try {
    return await withHub(async (hub) => {
      const fleet = startFakeFleet({ hub: `ws://127.0.0.1:${hub.port}`, token: TOKEN, quiet: true, speed: 6 });
      try {
        await until(() => hub.world.state.fleet.total >= 10, 8_000, 'agentes');
        const console1 = new TestConsole(hub.port, TOKEN);
        await console1.open();
        await until(() => console1.of('world').length === 1, 4_000, 'mundo');

        const agent = Object.values(hub.world.state.agents)[0];
        assert(agent !== undefined, 'hay al menos un agente');
        const cmdId = newId('cmd');
        console1.send({ t: 'cmd', id: cmdId, cmd: { k: 'say', agentId: agent?.id, text: 'para y explícame' } });
        await until(() => console1.of('ack').some((a) => a.cmdId === cmdId), 5_000, 'ack del comando');
        const ack = console1.of('ack').find((a) => a.cmdId === cmdId);
        assert(ack?.ok === true, `el ack vino en falso: ${ack?.detail}`);

        // Un comando a un agente inexistente se rechaza sin tocar a nadie.
        const badId = newId('cmd');
        console1.send({ t: 'cmd', id: badId, cmd: { k: 'stop', agentId: 'no-existe' } });
        await until(() => console1.of('ack').some((a) => a.cmdId === badId), 3_000, 'ack del comando malo');
        const bad = console1.of('ack').find((a) => a.cmdId === badId);
        assert(bad?.ok === false, 'debía fallar');

        // Spawn: aparece un agente nuevo en el mundo.
        const before = hub.world.state.fleet.total;
        const project = Object.values(hub.world.state.projects)[0];
        const spawnId = newId('cmd');
        console1.send({
          t: 'cmd', id: spawnId,
          cmd: {
            k: 'spawn', projectId: project?.id, prompt: 'arregla el build', parentId: null,
            mission: 'build verde', background: true,
          },
        });
        await until(() => console1.of('ack').some((a) => a.cmdId === spawnId), 5_000, 'ack del spawn');
        await until(() => hub.world.state.fleet.total > before, 5_000, 'el agente nuevo llega al mundo');

        console1.close();
        return ok(name, `say ok, comando inválido rechazado ("${bad?.detail}"), spawn creó un agente`);
      } finally { fleet.stop(); }
    });
  } catch (err) { return fail(name, String(err)); }
}

export async function testEscalationAnswerIsRemembered(): Promise<TestResult> {
  const name = 'integración: responder una escalación la recuerda para siempre';
  try {
    return await withHub(async (hub) => {
      const fleet = startFakeFleet({ hub: `ws://127.0.0.1:${hub.port}`, token: TOKEN, quiet: true, speed: 10 });
      try {
        await until(
          () => Object.values(hub.world.state.escalations).some((e) => e.status === 'pending'),
          20_000, 'una escalación pendiente',
        );
        const esc = Object.values(hub.world.state.escalations).find((e) => e.status === 'pending');
        assert(esc !== undefined, 'hay escalación');

        const console1 = new TestConsole(hub.port, TOKEN);
        await console1.open();
        await until(() => console1.of('world').length === 1, 4_000, 'mundo');

        console1.send({
          t: 'escalation:answer', id: esc?.id, answer: 'Sí, adelante, pero avísame antes de tocar prod.',
          rememberAs: 'Cambios en prod: siempre avisar antes',
        });

        await until(() => hub.world.state.escalations[esc?.id ?? '']?.status === 'answered', 5_000, 'escalación respondida');
        const after = hub.world.state.escalations[esc?.id ?? ''];
        assert(after?.answeredBy === 'human', 'queda marcada como respondida por el humano');

        const recalled = hub.memory.recall(esc?.question ?? '');
        assert(recalled.length > 0, 'la respuesta quedó en memoria');
        assert(recalled[0]?.entry.rememberAs === 'Cambios en prod: siempre avisar antes', 'con la regla del humano');

        // El agente que preguntó ya no está bloqueado.
        const agent = hub.world.state.agents[esc?.agentId ?? ''];
        assert(agent === undefined || agent.state !== 'blocked' || agent.block?.escalationId !== esc?.id,
          'el agente se desbloquea');

        console1.close();
        return ok(name, `escalación "${(esc?.question ?? '').slice(0, 40)}…" respondida y recordada (score ${recalled[0]?.score})`);
      } finally { fleet.stop(); }
    });
  } catch (err) { return fail(name, String(err)); }
}

export async function testCollectorDropMarksMachineOffline(): Promise<TestResult> {
  const name = 'integración: caída de collector → máquina offline, agentes dead';
  try {
    return await withHub(async (hub) => {
      const fleet = startFakeFleet({ hub: `ws://127.0.0.1:${hub.port}`, token: TOKEN, quiet: true, speed: 6 });
      try {
        await until(() => Object.keys(hub.world.state.machines).length === 3, 8_000, '3 máquinas');
        await until(() => hub.world.state.fleet.total >= 15, 8_000, 'agentes');

        const victim = fleet.machines[0];
        assert(victim !== undefined, 'hay víctima');
        const id = victim?.spec.id ?? '';
        const before = Object.values(hub.world.state.agents).filter((a) => a.machineId === id).length;
        assert(before > 0, 'la víctima tenía agentes');

        victim?.drop();
        await until(() => hub.world.state.machines[id]?.online === false, 6_000, 'máquina offline');

        const mine = Object.values(hub.world.state.agents).filter((a) => a.machineId === id);
        assert(mine.length === before, `no se borró ningún registro (${before} → ${mine.length})`);
        assert(mine.every((a) => a.state === 'dead' || a.state === 'done'), 'todos los vivos pasan a dead');
        assert((hub.world.state.machines[id]?.hostname ?? '').length > 0, 'la máquina sigue listada');

        // Y vuelve sola.
        victim?.reconnect();
        await until(() => hub.world.state.machines[id]?.online === true, 8_000, 'máquina de vuelta');
        await until(
          () => Object.values(hub.world.state.agents).some((a) => a.machineId === id && a.state !== 'dead'),
          8_000, 'agentes vivos otra vez',
        );
        return ok(name, `${before} agentes marcados dead y recuperados al reconectar`);
      } finally { fleet.stop(); }
    });
  } catch (err) { return fail(name, String(err)); }
}

export async function testBadTokenIsRejected(): Promise<TestResult> {
  const name = 'integración: token inválido → close 4001';
  try {
    return await withHub(async (hub) => {
      const bad = new TestConsole(hub.port, 'token-equivocado');
      await until(() => bad.closedWith !== null, 10_000, 'cierre');
      assert(bad.closedWith === CLOSE_UNAUTHORIZED, `esperaba 4001, fue ${bad.closedWith}`);

      // Un collector sin token tampoco entra.
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}${PATHS.collector}`);
      let code: number | null = null;
      ws.on('close', (c) => { code = c; });
      ws.on('error', () => { /* esperado */ });
      await new Promise<void>((resolve) => { ws.once('open', () => resolve()); ws.once('close', () => resolve()); });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          t: 'hello', v: PROTOCOL_VERSION, token: 'nope',
          machine: { id: 'x', hostname: 'x', platform: 'linux', version: '1', online: true, lastSeen: 0, connectedAt: 0, load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null } },
        }));
      }
      await until(() => code !== null, 5_000, 'cierre del collector');
      assert(code === CLOSE_UNAUTHORIZED, `esperaba 4001 en el collector, fue ${String(code)}`);
      return ok(name, 'consolas y collectors sin token quedan fuera');
    });
  } catch (err) { return fail(name, String(err)); }
}

export async function testGarbageIsIsolated(): Promise<TestResult> {
  const name = 'integración: una consola con basura no tumba a las demás';
  try {
    return await withHub(async (hub) => {
      const good = new TestConsole(hub.port, TOKEN);
      const bad = new TestConsole(hub.port, TOKEN);
      await good.open();
      await bad.open();
      await until(() => good.of('world').length === 1 && bad.of('world').length === 1, 4_000, 'mundos');

      bad.ws.send('{esto no es json');
      bad.ws.send(JSON.stringify({ t: 'cmd', id: 42, cmd: 'hazme un café' }));
      bad.ws.send(JSON.stringify({ t: 'inventado', payload: { a: [1, 2, 3] } }));
      bad.ws.send(JSON.stringify(null));
      await until(() => bad.of('error').length >= 3, 4_000, 'errores devueltos');

      // El hub sigue vivo y la otra consola intacta.
      const health = await (await fetch(`http://127.0.0.1:${hub.port}/api/health`)).json() as { ok: boolean };
      assert(health.ok === true, 'el hub sigue respondiendo');
      assert(good.ws.readyState === WebSocket.OPEN, 'la consola sana sigue conectada');

      good.send({ t: 'resync' });
      await until(() => good.of('world').length === 2, 4_000, 'resync atendido');

      good.close(); bad.close();
      return ok(name, `${bad.of('error').length} errores aislados, resync funcionando`);
    });
  } catch (err) { return fail(name, String(err)); }
}

export async function testHttpEndpoints(): Promise<TestResult> {
  const name = 'integración: /api/health y /api/world';
  try {
    return await withHub(async (hub) => {
      const fleet = startFakeFleet({ hub: `ws://127.0.0.1:${hub.port}`, token: TOKEN, quiet: true, speed: 6 });
      try {
        await until(() => hub.world.state.fleet.total >= 15, 8_000, 'agentes');
        const health = await (await fetch(`http://127.0.0.1:${hub.port}/api/health`)).json() as Record<string, unknown>;
        for (const key of ['ok', 'rev', 'uptimeMs', 'machines', 'agents', 'escalations', 'connections']) {
          assert(key in health, `falta ${key} en /api/health`);
        }
        const world = await (await fetch(`http://127.0.0.1:${hub.port}/api/world`)).json() as Record<string, unknown>;
        for (const key of ['rev', 'machines', 'projects', 'agents', 'escalations', 'keys', 'ceo', 'feed', 'fleet']) {
          assert(key in world, `falta ${key} en /api/world`);
        }
        assert(JSON.stringify(world).length > 5_000, 'el mundo debería tener contenido');
        // /api/* desconocido sigue siendo 404: ahí no hay consola que servir,
        // y devolver el index para una llamada de API escondería el error.
        const missing = await fetch(`http://127.0.0.1:${hub.port}/api/nope`);
        assert(missing.status === 404, 'ruta de api desconocida devuelve 404');
        return ok(name, `world de ${(JSON.stringify(world).length / 1024).toFixed(0)} KB, health completo`);
      } finally { fleet.stop(); }
    });
  } catch (err) { return fail(name, String(err)); }
}

/* ── suite ────────────────────────────────────────────────────────── */

/**
 * Cada prueba es también una función exportada suelta, para poder llamarla a
 * mano desde un REPL. Esto es sólo el índice que consume `test/run.ts`.
 */
export default {
  suite: 'hub — world · bus · memory · auth · persist · server',
  tests: [
    testRevIncrementsExactlyOne,
    testRollupsAreIncrementalAndCorrect,
    testOfflineMachineKillsAgentsButKeepsRecords,
    testFeedAndCeoAreTrimmed,
    testSecretsNeverEnterTheWorld,
    testLineageIsMaintained,
    testBusCoalescesAndPacesAt10Hz,
    testBusMergesFullRecordWithPatch,
    testMemoryRecall,
    testAuth,
    testPersistCeoRoundTrip,
    testEndToEndWithFakeFleet,
    testCommandRoundTrip,
    testEscalationAnswerIsRemembered,
    testCollectorDropMarksMachineOffline,
    testBadTokenIsRejected,
    testGarbageIsIsolated,
    testHttpEndpoints,
  ],
};
