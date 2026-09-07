/**
 * Archivar agentes terminados.
 *
 * Lo que se prueba es la promesa entera, no la función: que un `done` se va
 * y no vuelve con el siguiente snapshot, que un vivo no se va aunque el filtro
 * lo nombre, que una sesión reanudada levanta su lápida sola, y que las tres
 * puertas —el mundo, la herramienta MCP y el frame de consola— responden lo
 * mismo. La mitad de estos fallos serían silenciosos: un agente resucitado se
 * parece a uno que nunca se archivó.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import type { Agent, Project } from '../src/shared/types.ts';
import type { ServerFrame } from '../src/shared/protocol.ts';
import { PATHS, PROTOCOL_VERSION } from '../src/shared/protocol.ts';
import { archiveCandidates, parseAge, type ArchivedAgent } from '../src/shared/archive.ts';
import { World, type WorldEvent } from '../src/hub/world.ts';
import { HubStore } from '../src/hub/persist.ts';
import { startHub, type Hub } from '../src/hub/server.ts';
import { createAuth } from '../src/hub/auth.ts';
import { FleetStore } from '../src/hub/fleets.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { hubContext } from '../src/agents/context.ts';
import { runTool } from '../src/agents/tools.ts';
import { eq, ok, test, until, type TestModule } from './harness.ts';

const H = 3_600_000;
const TOKEN = 'test-token-archive-00';

function agent(over: Partial<Agent> & { id: string }, now = Date.now()): Agent {
  return {
    machineId: 'm1', projectId: 'p1', title: `title ${over.id}`, callsign: over.id.toUpperCase(),
    runtime: 'claude', state: 'working', block: null, parentId: null, depth: 0, childIds: [],
    mission: null, squad: null, lead: false, model: null, tool: null, toolDetail: null,
    lastPrompt: null, lastSay: null, startedAt: now - 4 * H, updatedAt: now, uptimeMs: 0,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
      tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0,
      apiDurationMs: 0, turns: 0,
    },
    background: false, shortId: null,
    ...over,
  };
}

function project(id: string, code: string, machineId = 'm1'): Project {
  return {
    id, machineId, slug: `-${id}`, name: id, path: `/${id}`, code,
    gitBranch: 'main', gitDirty: false, keyNames: [], sessionIds: [],
    rollup: {
      total: 0, byState: { booting: 0, thinking: 0, working: 0, blocked: 0, idle: 0, done: 0, dead: 0 },
      costUSD: 0, tokensPerSec: 0, blocked: 0,
    },
  };
}

/** Una flota con de todo: vivos, terminados, un padre con hijo vivo, dos squads. */
function fleet(now: number): Agent[] {
  return [
    agent({ id: 'a1', state: 'working', squad: 's2' }, now),
    agent({ id: 'a2', state: 'done', squad: 's1', lead: true, updatedAt: now - 2 * H }, now),
    agent({ id: 'a3', state: 'dead', projectId: 'p2', updatedAt: now - 10 * 60_000 }, now),
    agent({ id: 'a4', state: 'done', childIds: ['a5'], updatedAt: now - 3 * H }, now),
    agent({ id: 'a5', state: 'working', parentId: 'a4', depth: 1 }, now),
    agent({ id: 'a6', state: 'idle', updatedAt: now - 30 * H }, now),
    agent({ id: 'a7', state: 'done', squad: 's1', updatedAt: now - 5 * H }, now),
    agent({ id: 'a8', state: 'done', squad: 's2', updatedAt: now - 5 * H }, now),
  ];
}

const machine = {
  id: 'm1', hostname: 'host', platform: 'linux', version: '1', online: true,
  lastSeen: 0, connectedAt: 0, load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null },
};

function withDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function hubIn(dir: string): Promise<Hub> {
  return startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    store: new HubStore({ dir: join(dir, 'hub'), flushMs: 20 }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
    fleets: new FleetStore(join(dir, 'fleets')),
  });
}

/** Un collector de mentira: abre, saluda, y manda lo que se le diga. */
async function collector(hub: Hub): Promise<{ send(frame: unknown): void; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}${PATHS.collector}`);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token: TOKEN, machine }));
  await until(() => !!hub.world.state.machines['m1'], 3000);
  return { send: (f) => ws.send(JSON.stringify(f)), close: () => ws.close() };
}

/* ── 1 · la decisión ──────────────────────────────────────────────── */

const decides = test('archiveCandidates: terminados sí, vivos nunca, el padre con hijo vivo se queda', () => {
  const now = Date.now();
  const plan = archiveCandidates(fleet(now), {}, now);
  return eq('sin filtro: los terminados sin hijos vivos, y s1 entero se retira',
    {
      archive: plan.archive.map((a) => a.id),
      kept: plan.kept.map((k) => `${k.id}:${k.reason}`),
      squads: plan.squadsRetired,
    },
    { archive: ['a2', 'a3', 'a7', 'a8'], kept: ['a4:live-children'], squads: ['s1'] });
});

const filters = test('archiveCandidates: proyecto, squad, edad, estado e ids se combinan con AND', () => {
  const now = Date.now();
  const all = fleet(now);
  const ids = (f: Parameters<typeof archiveCandidates>[1]) => archiveCandidates(all, f, now).archive.map((a) => a.id);
  return eq('cada filtro recorta lo que dice',
    {
      project: ids({ projectId: 'p2' }),
      squad: ids({ squad: 's2' }),
      older: ids({ olderThanMs: 1 * H }),
      dead: ids({ state: 'dead' }),
      ids: ids({ ids: ['a1', 'a2', 'a5'] }),
      combined: ids({ squad: 's1', olderThanMs: 3 * H }),
      s2NotRetired: archiveCandidates(all, { squad: 's2' }, now).squadsRetired,
    },
    {
      project: ['a3'], squad: ['a8'], older: ['a2', 'a7', 'a8'], dead: ['a3'],
      ids: ['a2'], combined: ['a7'], s2NotRetired: [],
    });
});

const ages = test('parseAge: horas, días, minutos y basura', () => eq('lo que escribe un humano o un modelo',
  [parseAge(24), parseAge('24'), parseAge('2d'), parseAge('90m'), parseAge(null), Number.isNaN(parseAge('ayer') as number)],
  [24 * H, 24 * H, 48 * H, 90 * 60_000, null, true]));

/* ── 2 · el mundo ─────────────────────────────────────────────────── */

function worldWith(now: () => number) {
  const ops: unknown[] = [];
  const events: WorldEvent[] = [];
  const archived: ArchivedAgent[][] = [];
  const unarchived: string[] = [];
  const world = new World({
    now, onOps: (o) => ops.push(...o), onEvent: (e) => events.push(e),
    onArchived: (e) => archived.push(e), onUnarchived: (id) => unarchived.push(id),
  });
  world.applyCollector({ t: 'hello', v: PROTOCOL_VERSION, token: 'x', machine } as never, 'm1');
  world.applyCollector({ t: 'project:new', machineId: 'm1', project: project('p1', 'P1') } as never, 'm1');
  world.applyCollector({ t: 'project:new', machineId: 'm1', project: project('p2', 'P2') } as never, 'm1');
  for (const a of fleet(now())) world.applyCollector({ t: 'agent:new', machineId: 'm1', agent: a } as never, 'm1');
  world.settle();
  return { world, ops, events, archived, unarchived };
}

const dryRunTouchesNothing = test('world: el dry run cuenta lo mismo que la operación y no toca nada', () => {
  let clock = Date.now();
  const { world, archived } = worldWith(() => clock);
  const before = Object.keys(world.state.agents).length;
  const dry = world.archiveAgents({ olderThanMs: 1 * H }, { dryRun: true, by: 'test' });
  const after = Object.keys(world.state.agents).length;
  const real = world.archiveAgents({ olderThanMs: 1 * H }, { by: 'test' });
  return eq('mismo plan, cero efectos en seco',
    {
      dryIds: dry.archived.map((t) => t.id), dryFlag: dry.dryRun, untouched: after === before,
      hooksAfterDry: 0, realIds: real.archived.map((t) => t.id), hooksAfterReal: archived.length,
      left: Object.keys(world.state.agents).length,
    },
    { dryIds: ['a2', 'a7', 'a8'], dryFlag: true, untouched: true, hooksAfterDry: 0, realIds: ['a2', 'a7', 'a8'], hooksAfterReal: 1, left: before - 3 });
});

const leavesTheWorld = test('world: archivar desaloja, retira el squad, avisa a la consola y al log', () => {
  const clock = Date.now();
  const { world, ops, events } = worldWith(() => clock);
  ops.length = 0;
  const out = world.archiveAgents({}, { by: 'console' });
  world.settle();
  const gone = ops.filter((o) => (o as { o: string; v: unknown }).o === 'agent' && (o as { v: unknown }).v === null)
    .map((o) => (o as { id: string }).id);
  const p1 = world.state.projects['p1']!;
  return eq('cuatro fuera, a4 se queda por a5, s1 retirado, s2 sigue por a1',
    {
      archived: out.archived.map((t) => `${t.id}/${t.state}/${t.by}`),
      kept: out.kept.map((k) => k.id),
      squads: out.squadsRetired,
      gone,
      remaining: Object.keys(world.state.agents).sort(),
      sessions: p1.sessionIds.sort(),
      done: p1.rollup.byState.done,
      events: events.filter((e) => e.kind === 'agent:archived').length,
      squadEvent: events.find((e) => e.kind === 'squad:retired')?.text,
      isArchived: world.isArchived('a2') && !world.isArchived('a1'),
    },
    {
      archived: ['a2/done/console', 'a3/dead/console', 'a7/done/console', 'a8/done/console'],
      kept: ['a4'], squads: ['s1'], gone: ['a2', 'a3', 'a7', 'a8'],
      remaining: ['a1', 'a4', 'a5', 'a6'], sessions: ['a1', 'a4', 'a5', 'a6'], done: 1,
      events: 4, squadEvent: 's1', isArchived: true,
    });
});

const neverLive = test('world: un vivo no se archiva ni nombrándolo por id', () => {
  const clock = Date.now();
  const { world } = worldWith(() => clock);
  const out = world.archiveAgents({ ids: ['a1', 'a5', 'a6'] }, { by: 'test' });
  return eq('cero archivados, cero efectos', [out.archived.length, Object.keys(world.state.agents).length], [0, 8]);
});

const snapshotCannotResurrect = test('world: el siguiente snapshot no devuelve lo archivado; un vivo reanudado sí entra', () => {
  const clock = Date.now();
  const { world, unarchived, events } = worldWith(() => clock);
  world.archiveAgents({ squad: 's1' }, { by: 'test' });
  // El collector reenvía todo lo que tiene en disco, terminados incluidos.
  world.applyCollector({ t: 'snapshot', machineId: 'm1', projects: [project('p1', 'P1'), project('p2', 'P2')], agents: fleet(clock), keys: [] } as never, 'm1');
  const afterSnapshot = Object.keys(world.state.agents).sort();
  // agent:new terminado: tampoco.
  world.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agent({ id: 'a7', state: 'done' }, clock) } as never, 'm1');
  const afterNewDone = world.state.agents['a7'] === undefined;
  // Alguien reanuda a2: vuelve como un agente cualquiera y su lápida se levanta.
  world.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agent({ id: 'a2', state: 'working', squad: 's1', lead: true }, clock) } as never, 'm1');
  // a7 cambia a vivo pero llega como patch: la lápida se levanta y se pide resync.
  world.applyCollector({ t: 'agent', machineId: 'm1', id: 'a7', patch: { state: 'thinking' } } as never, 'm1');
  const resync = events.find((e) => e.kind === 'agent:unarchived' && e.agentId === 'a7');
  world.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agent({ id: 'a7', state: 'thinking', squad: 's1' }, clock) } as never, 'm1');
  return eq('la lápida vale para terminados y se levanta para vivos',
    {
      afterSnapshot, afterNewDone,
      a2Back: world.state.agents['a2']?.state, a2Tomb: world.isArchived('a2'),
      resync: (resync?.data as { resync?: boolean } | undefined)?.resync,
      a7Back: world.state.agents['a7']?.state,
      unarchived,
    },
    {
      afterSnapshot: ['a1', 'a3', 'a4', 'a5', 'a6', 'a8'], afterNewDone: true,
      a2Back: 'working', a2Tomb: false, resync: true, a7Back: 'thinking', unarchived: ['a2', 'a7'],
    });
});

/* ── 3 · el disco ─────────────────────────────────────────────────── */

const survivesRestart = test('persist: las lápidas se reproducen en orden y un undo las levanta', () => withDir('orca-archive-store-', async (dir) => {
  const store = new HubStore({ dir, flushMs: 10 });
  const now = Date.now();
  const tomb = (id: string): ArchivedAgent => ({
    id, machineId: 'm1', projectId: 'p1', callsign: id.toUpperCase(), squad: null, lead: false,
    state: 'done', title: id, mission: null, parentId: null, startedAt: now - H, finishedAt: now, archivedAt: now, by: 'test',
  });
  store.appendArchived([tomb('x1'), tomb('x2')]);
  store.appendUnarchived('x1', now + 1);
  await store.flush();
  await store.close();
  const again = new HubStore({ dir, flushMs: 10 });
  const loaded = again.loadArchived().map((t) => t.id);
  await again.close();
  return eq('x2 sigue, x1 se levantó', loaded, ['x2']);
}));

/* ── 4 · de punta a punta ─────────────────────────────────────────── */

const endToEnd = test('hub: MCP y consola archivan lo mismo, el collector no lo resucita, y el reinicio lo recuerda', () => withDir('orca-archive-hub-', async (dir) => {
  const now = Date.now();
  const snapshot = () => ({
    t: 'snapshot', machineId: 'm1', projects: [project('p1', 'AX'), project('p2', 'BX')], agents: fleet(now), keys: [],
  });
  let hub = await hubIn(dir);
  const col = await collector(hub);
  try {
    col.send(snapshot());
    await until(() => Object.keys(hub.world.state.agents).length === 8, 3000);

    // MCP, resolviendo el proyecto por su código, en seco y de verdad.
    const dry = await runTool(hubContext(hub), 'archive_agents', { project_id: 'BX', squad: null, older_than_hours: null, state: null, dry_run: true });
    const dryOut = JSON.parse(dry.result) as { dry_run: boolean; count: number; archived: { callsign: string }[] };
    const real = await runTool(hubContext(hub), 'archive_agents', { project_id: 'BX', squad: null, older_than_hours: null, state: null, dry_run: false });
    const realOut = JSON.parse(real.result) as { count: number; archived: { id: string; state: string; project: string }[] };
    const bad = await runTool(hubContext(hub), 'archive_agents', { project_id: 'ZZ', squad: null, older_than_hours: null, state: null, dry_run: true });

    // La consola: un dry run por el frame, y luego el resto por edad.
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}${PATHS.console}?token=${TOKEN}`);
    const frames: ServerFrame[] = [];
    ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString()) as ServerFrame); } catch { /* nada */ } });
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    await until(() => frames.some((f) => f.t === 'world'), 3000);
    ws.send(JSON.stringify({ t: 'agents:archive', id: 'cmd_dry', filter: { olderThanMs: H }, dryRun: true }));
    ws.send(JSON.stringify({ t: 'agents:archive', id: 'cmd_go', filter: { olderThanMs: H } }));
    await until(() => frames.filter((f) => f.t === 'ack').length === 2, 3000);
    const acks = frames.filter((f): f is Extract<ServerFrame, { t: 'ack' }> => f.t === 'ack');
    const ackDry = acks.find((a) => a.cmdId === 'cmd_dry')?.data as { dryRun: boolean; archived: unknown[] } | undefined;
    const ackGo = acks.find((a) => a.cmdId === 'cmd_go')?.data as { archived: { id: string }[]; squadsRetired: string[] } | undefined;
    ws.close();

    // El collector vuelve a mandar todo: lo archivado no vuelve, lo vivo sigue.
    col.send(snapshot());
    col.send({ t: 'agent:new', machineId: 'm1', agent: agent({ id: 'a3', state: 'dead', projectId: 'p2' }, now) });
    await new Promise((r) => setTimeout(r, 300));
    const afterResend = Object.keys(hub.world.state.agents).sort();
    const listed = JSON.parse((await runTool(hubContext(hub), 'list_agents', { project_id: null, squad: null, state: null, include_finished: true, limit: 50 })).result) as { total: number };
    const health = hub.world.health() as { archived: number };

    // Reinicio: las lápidas vienen del disco antes del primer snapshot.
    await hub.store.flush();
    col.close();
    await hub.close();
    hub = await hubIn(dir);
    const col2 = await collector(hub);
    col2.send(snapshot());
    await until(() => Object.keys(hub.world.state.agents).length >= 4, 3000);
    await new Promise((r) => setTimeout(r, 200));
    const afterRestart = Object.keys(hub.world.state.agents).sort();
    col2.close();

    return eq('las tres puertas y la memoria del hub',
      {
        dry: { flag: dryOut.dry_run, count: dryOut.count, who: dryOut.archived.map((a) => a.callsign), summary: dry.summary },
        real: { count: realOut.count, rows: realOut.archived.map((a) => `${a.id}/${a.state}/${a.project}`), summary: real.summary },
        badProject: bad.isError,
        ackDry: { flag: ackDry?.dryRun, n: ackDry?.archived.length },
        ackGo: { ids: ackGo?.archived.map((a) => a.id), squads: ackGo?.squadsRetired },
        afterResend, listedTotal: listed.total, archivedInHealth: health.archived,
        afterRestart,
      },
      {
        dry: { flag: true, count: 1, who: ['A3'], summary: 'dry run: would archive 1 agent(s) on BX' },
        real: { count: 1, rows: ['a3/dead/BX'], summary: 'archived 1 agent(s) on BX' },
        badProject: true,
        ackDry: { flag: true, n: 3 },
        ackGo: { ids: ['a2', 'a7', 'a8'], squads: ['s1'] },
        afterResend: ['a1', 'a4', 'a5', 'a6'], listedTotal: 4, archivedInHealth: 4,
        afterRestart: ['a1', 'a4', 'a5', 'a6'],
      });
  } finally {
    col.close();
    await hub.close();
  }
}));

/*
 * La lápida se retira cuando su transcript se borra, y por ninguna otra razón.
 *
 * El intento anterior fue purgarla cuando el collector dejaba de nombrar al
 * agente, y es falso: recicla lo terminado a los pocos segundos y deja de
 * reportarlo con el archivo intacto. Se probó contra la instalación real y
 * tiró lápidas buenas — ZG reapareció con su transcript en disco. Aquí se
 * comprueban las dos mitades: que dejar de nombrarlo NO la retira, y que
 * borrar el archivo sí.
 */
const tombstoneOutlivesSilence = test('world: callar sobre un archivado no retira su lápida; borrar su transcript sí', () => {
  const clock = Date.now();
  const { world, events } = worldWith(() => clock);
  world.archiveAgents({ squad: 's1' }, { by: 'test' });
  const archivedIds = world.archivedAgents().map((t) => t.id).sort();

  // Un snapshot que ya no lo nombra: es lo que hace el collector al reciclar.
  world.applyCollector({ t: 'snapshot', machineId: 'm1', projects: [project('p1', 'P1'), project('p2', 'P2')], agents: [], keys: [] } as never, 'm1');
  const afterSilence = world.archivedAgents().map((t) => t.id).sort();

  // Y el borrado, que sí es una razón: lo pide quien borró el archivo.
  const target = archivedIds[0]!;
  const dropped = world.dropTombstone(target);
  const twice = world.dropTombstone(target);
  const why = events.find((e) => e.kind === 'agent:unarchived' && e.agentId === target);
  return eq('el silencio no retira la lápida; el borrado sí, y una sola vez',
    { afterSilence, stillArchived: world.isArchived(target), dropped, twice, why: String(why?.text ?? '') },
    { afterSilence: archivedIds, stillArchived: false, dropped: true, twice: false, why: 'transcript borrado: la lápida ya no rechaza nada' },
    `${archivedIds.length} lápidas sobreviven al silencio; ${target.slice(0, 4)} se retira al borrarse`);
});

export default {
  suite: 'Archivar agentes terminados',
  tests: [decides, filters, ages, dryRunTouchesNothing, leavesTheWorld, neverLive, snapshotCannotResurrect, survivesRestart, tombstoneOutlivesSilence, endToEnd],
} satisfies TestModule;
