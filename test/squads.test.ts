/**
 * Escuadrones, y `orca-show --open`.
 *
 * Cinco cosas que, si se rompen, se rompen en silencio:
 *
 *  1. El ack de un `spawn` trae el `agentId`. Sin él, lanzar un líder y luego
 *     colgarle miembros es imposible: `parentId` es exactamente ese id, y nadie
 *     más lo sabe hasta que el agente aparece solo en la consola.
 *  2. El brief del escuadrón entra en el prompt. Un miembro que no sabe que
 *     tiene líder escala al humano, que es lo que un escuadrón existe para
 *     evitar — y eso no falla, simplemente molesta a alguien.
 *  3. `squad`/`lead` sobreviven al sanitizador y al snapshot. El hub copia
 *     campo por campo desde lista blanca: un campo nuevo que nadie añadió ahí
 *     se cae sin un solo error.
 *  4. `orca-tell --to squad:<name>` llega a los miembros, y sólo a ellos.
 *  5. `--open` viaja de la CLI al mundo del hub.
 *
 * Todo corre en directorios temporales: nada toca ~/.orca ni ~/.claude.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { squadsOf, squadName } from '../src/shared/squads.ts';
import type { Agent } from '../src/shared/types.ts';
import type { SpawnAck } from '../src/shared/protocol.ts';
import { leadBrief, memberBrief, squadBrief, withBrief } from '../src/collector/briefs.ts';
import { ArtifactIndex } from '../src/collector/artifacts.ts';
import { CommandRunner } from '../src/collector/commands.ts';
import type { AgentHandle, CommandDeps } from '../src/collector/commands.ts';
import { LineageIndex } from '../src/collector/lineage.ts';
import { diffAgent } from '../src/collector/index.ts';
import { World, sanitizeAgent, sanitizeAgentPatch, sanitizeArtifact, sanitizeMessage } from '../src/hub/world.ts';
import { startHub } from '../src/hub/server.ts';
import { createAuth } from '../src/hub/auth.ts';
import { HubStore } from '../src/hub/persist.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { makePng, startFakeFleet } from './fake-collector.ts';
import { eq, ok, test, until, type TestModule, type TestResult } from './harness.ts';

const TOKEN = 'test-token-orca-squads';
const MACHINE = 'm-squad';
const BIN = new URL('../bin/', import.meta.url).pathname;

function temp(): string { return mkdtempSync(join(tmpdir(), 'orca-squad-')); }

function agentFixture(over: Partial<Agent> = {}): Agent {
  const now = 1_700_000_000_000;
  return {
    id: 'a1', machineId: MACHINE, projectId: 'p1',
    title: 't', callsign: 'K1', runtime: 'claude',
    state: 'working', block: null,
    parentId: null, depth: 0, childIds: [], mission: null,
    squad: null, lead: false,
    model: null, tool: null, toolDetail: null, lastPrompt: null, lastSay: null,
    startedAt: now, updatedAt: now, uptimeMs: 0,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
      tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0,
      toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    background: false, shortId: null,
    ...over,
  };
}

/* ── 1 · squadsOf ─────────────────────────────────────────────────── */

const groupsBySquad = test('squadsOf agrupa, pone al líder primero y ordena por nombre', () => {
  const t = 1_700_000_000_000;
  const agents = [
    agentFixture({ id: 'm2', squad: 'audit-01', startedAt: t + 200 }),
    agentFixture({ id: 'lead', squad: 'audit-01', lead: true, startedAt: t + 500 }),
    agentFixture({ id: 'm1', squad: 'audit-01', startedAt: t + 100 }),
    agentFixture({ id: 'solo' }),
    agentFixture({ id: 'b1', squad: 'build-02', startedAt: t }),
  ];
  const squads = squadsOf(agents);
  return eq('squadsOf agrupa, pone al líder primero y ordena por nombre',
    squads, [
      { name: 'audit-01', leaderId: 'lead', memberIds: ['lead', 'm1', 'm2'] },
      { name: 'build-02', leaderId: null, memberIds: ['b1'] },
    ],
    'el que no tiene squad no aparece; el líder abre su lista');
});

const acceptsARecord = test('squadsOf acepta el Record del mundo igual que un array', () => {
  const a = agentFixture({ id: 'x', squad: 'audit-01', lead: true });
  const b = agentFixture({ id: 'y', squad: 'audit-01', startedAt: a.startedAt + 1 });
  const fromArray = squadsOf([a, b]);
  const fromRecord = squadsOf({ x: a, y: b });
  return eq('squadsOf acepta el Record del mundo igual que un array',
    fromRecord, fromArray);
});

const oldestLeaderWins = test('con dos líderes gana el más viejo, no el último visto', () => {
  const t = 1_700_000_000_000;
  const squads = squadsOf([
    agentFixture({ id: 'nuevo', squad: 'audit-01', lead: true, startedAt: t + 900 }),
    agentFixture({ id: 'viejo', squad: 'audit-01', lead: true, startedAt: t }),
  ]);
  return eq('con dos líderes gana el más viejo, no el último visto',
    squads[0]?.leaderId, 'viejo', 'un bug de arriba no puede vaciar la lista');
});

const rejectsJunkNames = test('un nombre de escuadrón inválido no es un escuadrón', () => {
  const bad = ['', ' ', 'con espacio', '-empieza-mal', 'x'.repeat(33), 'a/b'];
  const good = ['audit-01', 'A', 'payments_migration', '0'];
  const badOk = bad.every((v) => squadName(v) === null);
  const goodOk = good.every((v) => squadName(v) === v);
  // Un nombre con espacios alrededor es el caso real: viene de un argv.
  const trimmed = squadName('  audit-01  ') === 'audit-01';
  return ok('un nombre de escuadrón inválido no es un escuadrón',
    badOk && goodOk && trimmed, `${bad.length} rechazados, ${good.length} aceptados, trim ok`);
});

/* ── 2 · el sanitizador y el snapshot ─────────────────────────────── */

const sanitizeKeepsSquad = test('sanitizeAgent conserva squad y lead', () => {
  const a = sanitizeAgent({ ...agentFixture({ squad: 'audit-01', lead: true }) }, MACHINE);
  return ok('sanitizeAgent conserva squad y lead',
    a !== null && a.squad === 'audit-01' && a.lead === true,
    `squad=${a?.squad} lead=${a?.lead}`);
});

const sanitizeDropsJunkSquad = test('sanitizeAgent tira un squad que no es un nombre', () => {
  const bad = sanitizeAgent({ ...agentFixture(), squad: 'no vale', lead: true }, MACHINE);
  const noSquad = sanitizeAgent({ ...agentFixture(), squad: null, lead: true }, MACHINE);
  return ok('sanitizeAgent tira un squad que no es un nombre',
    bad?.squad === null && bad?.lead === false
    && noSquad?.squad === null && noSquad?.lead === false,
    'liderar un escuadrón que no existe no significa nada');
});

const patchCarriesSquad = test('sanitizeAgentPatch lleva squad y lead cuando vienen', () => {
  const p = sanitizeAgentPatch({ squad: 'audit-01', lead: true });
  const empty = sanitizeAgentPatch({ state: 'idle' });
  return ok('sanitizeAgentPatch lleva squad y lead cuando vienen',
    p.squad === 'audit-01' && p.lead === true
    && !('squad' in empty) && !('lead' in empty),
    'un patch que no los menciona no los borra');
});

const survivesTheSnapshot = test('squad y lead sobreviven agent:new y el snapshot', () => {
  const world = new World();
  world.upsertMachine({
    id: MACHINE, hostname: 'mac', platform: 'darwin', version: '0.1.0',
    online: true, lastSeen: Date.now(), connectedAt: Date.now(),
    load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null },
  });
  world.applyCollector({
    t: 'agent:new', machineId: MACHINE,
    agent: agentFixture({ id: 'lead1', squad: 'audit-01', lead: true }),
  }, MACHINE);
  world.applyCollector({
    t: 'agent:new', machineId: MACHINE,
    agent: agentFixture({ id: 'mem1', parentId: 'lead1', depth: 1, squad: 'audit-01' }),
  }, MACHINE);
  const snap = world.snapshot();
  const squads = squadsOf(snap.agents);
  return eq('squad y lead sobreviven agent:new y el snapshot',
    squads, [{ name: 'audit-01', leaderId: 'lead1', memberIds: ['lead1', 'mem1'] }]);
});

const diffCarriesSquad = test('un cambio de escuadrón viaja como patch', () => {
  const before = agentFixture({ id: 'a1' });
  const after = agentFixture({ id: 'a1', squad: 'audit-01', lead: true });
  const patch = diffAgent(before, after);
  const quiet = diffAgent(after, { ...after });
  return ok('un cambio de escuadrón viaja como patch',
    patch?.squad === 'audit-01' && patch?.lead === true && quiet === null,
    'alistarse es un hecho nuevo; no cambiar nada no genera tráfico');
});

const messageScopeSquad = test('sanitizeMessage acepta scope squad y exige toSquad', () => {
  const base = {
    id: 'msg_1', kind: 'handoff', fromAgentId: 'lead1', fromCallsign: 'K1',
    fromProjectId: 'p1', subject: 'Repartido', at: Date.now(),
  };
  const good = sanitizeMessage({ ...base, scope: 'squad', toSquad: 'audit-01' }, MACHINE);
  const naked = sanitizeMessage({ ...base, scope: 'squad' }, MACHINE);
  const junk = sanitizeMessage({ ...base, scope: 'squad', toSquad: 'no vale' }, MACHINE);
  return ok('sanitizeMessage acepta scope squad y exige toSquad',
    good?.scope === 'squad' && good?.toSquad === 'audit-01'
    && naked === null && junk === null,
    'un squad sin nombre no tiene a dónde ir');
});

/* ── 3 · briefs ───────────────────────────────────────────────────── */

const briefsSayTheRightThing = test('el brief nombra el escuadrón y usa comandos reales', () => {
  const lead = leadBrief('audit-01');
  const member = memberBrief('audit-01', 'K9');
  const orphan = memberBrief('audit-01', null);
  const leadOk = lead.includes('you lead audit-01')
    && lead.includes('--to squad:audit-01') && lead.includes('orca-ask');
  const memberOk = member.includes('you belong to audit-01')
    && member.includes('Your lead is K9') && member.includes('--to K9')
    && member.includes('Do not use orca-ask');
  const orphanOk = orphan.includes('squad:audit-01') && !orphan.includes('--to null');
  const noSquad = squadBrief(null, true, 'K9') === null;
  return ok('el brief nombra el escuadrón y usa comandos reales',
    leadOk && memberOk && orphanOk && noSquad,
    'líder: reparte y habla con el humano; miembro: reporta y no lo hace');
});

const briefRidesTheEnd = test('withBrief pega el pie al final, nunca al principio', () => {
  const out = withBrief('Audit the payments module.  ', '--- brief ---');
  return eq('withBrief pega el pie al final, nunca al principio',
    out, 'Audit the payments module.\n\n--- brief ---\n');
});

/* ── 4 · el ack del spawn ─────────────────────────────────────────── */

/**
 * Un `claude` de mentira que imprime un short id y guarda su argv.
 *
 * Es la única forma honesta de comprobar el ack: `run()` lanza un proceso de
 * verdad, sin shell, y lo que nos importa es exactamente lo que ese proceso
 * recibió — el prompt con el brief pegado — y lo que el runner hizo con su
 * salida.
 */
function fakeClaude(dir: string): { bin: string; argv: () => string[] } {
  const argvFile = join(dir, 'argv.json');
  const bin = join(dir, 'claude');
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
    "console.log('Started background session a1b2c3d4');",
    '',
  ].join('\n'));
  chmodSync(bin, 0o755);
  return {
    bin,
    argv: () => {
      try { return JSON.parse(readFileSync(argvFile, 'utf8')) as string[]; } catch { return []; }
    },
  };
}

/**
 * Sujeta el bucle de eventos mientras dura un spawn.
 *
 * `run()` lanza al hijo con `detached` y `unref()` a propósito: un agente en
 * background tiene que sobrevivir al collector. El efecto secundario es que,
 * durante la espera, no queda un solo handle con ref — y Node vacía el bucle y
 * sale con 0 en mitad de la suite, sin fallar nada y sin decir nada. En el
 * collector real siempre hay un socket o un intervalo sujetando el proceso;
 * aquí lo ponemos nosotros.
 */
async function heldOpen<T>(fn: () => Promise<T>): Promise<T> {
  const keep = setInterval(() => { /* sólo existe para tener ref */ }, 200);
  try { return await fn(); } finally { clearInterval(keep); }
}

function handle(over: Partial<AgentHandle> = {}): AgentHandle {
  return {
    id: 'sess-lead', projectId: 'p1', sessionId: 'sess-lead', shortId: 'a1b2c3d4',
    background: true, alive: true, callsign: 'K9', pane: null, runtime: 'claude', ...over,
  };
}

/** Deps mínimas: sólo lo que `spawn` toca. Todo lo demás explota si se usa. */
function spawnDeps(dir: string, over: Partial<CommandDeps> = {}): CommandDeps {
  const project = { id: 'p1', name: 'proyecto', path: dir };
  return {
    projects: { get: (id: string) => (id === 'p1' ? project : null) },
    keys: { materialize: () => ({}) },
    // Sin tmux: estas pruebas ejercen el camino `--bg`; el pane tiene las suyas.
    tmux: { available: () => false },
    lineage: new LineageIndex(join(dir, 'lineage.json')),
    escalations: {},
    messages: {},
    artifacts: {},
    agent: (id: string) => (id === 'sess-lead' ? handle() : null),
    awaitSpawn: async () => handle({ id: 'sess-child', callsign: 'T4' }),
    onResync: () => { /* no se usa */ },
    onKeysChanged: () => { /* no se usa */ },
    ...over,
  } as unknown as CommandDeps;
}

const spawnAckHasAgentId = test('el ack de spawn trae agentId, callsign y shortId', async () => {
  const dir = temp();
  const prev = process.env['ORCA_CLAUDE_BIN'];
  try {
    const fake = fakeClaude(dir);
    process.env['ORCA_CLAUDE_BIN'] = fake.bin;
    const runner = new CommandRunner(spawnDeps(dir));
    const res = await heldOpen(() => runner.execute({
      k: 'spawn', projectId: 'p1', prompt: 'Audit the payments module.',
      parentId: null, mission: 'audit', background: true,
      squad: 'audit-01', lead: true,
    }));
    const data = res.data as SpawnAck;
    return ok('el ack de spawn trae agentId, callsign y shortId',
      res.ok && data.agentId === 'sess-child' && data.callsign === 'T4'
      && data.shortId === 'a1b2c3d4',
      `agentId=${data?.agentId} callsign=${data?.callsign} shortId=${data?.shortId}`);
  } finally {
    if (prev === undefined) delete process.env['ORCA_CLAUDE_BIN'];
    else process.env['ORCA_CLAUDE_BIN'] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

const controlWorkspaceRefused = test('workers cannot inherit the CAPCOM control workspace', async () => {
  const dir = temp();
  const oldBin = process.env['ORCA_CLAUDE_BIN'];
  const oldControl = process.env['ORCA_CAPCOM_DIR'];
  try {
    process.env['ORCA_CLAUDE_BIN'] = fakeClaude(dir).bin;
    process.env['ORCA_CAPCOM_DIR'] = dir;
    let launched = false;
    const runner = new CommandRunner(spawnDeps(dir, {
      awaitSpawn: async () => { launched = true; return null; },
    }));
    const res = await runner.execute({ k: 'spawn', projectId: 'p1', prompt: 'Say hello to the other worker.', parentId: null, mission: 'hello', background: true });
    return ok('CAPCOM folder is rejected before process launch', !res.ok && !launched && (res.detail ?? '').includes('control workspace'));
  } finally {
    if (oldBin === undefined) delete process.env['ORCA_CLAUDE_BIN']; else process.env['ORCA_CLAUDE_BIN'] = oldBin;
    if (oldControl === undefined) delete process.env['ORCA_CAPCOM_DIR']; else process.env['ORCA_CAPCOM_DIR'] = oldControl;
    rmSync(dir, { recursive: true, force: true });
  }
});

const hostedAckDoesNotWait = test('hosted spawn acknowledges its stable id before a transcript exists', async () => {
  const dir = temp();
  const prev = process.env['ORCA_CLAUDE_BIN'];
  try {
    process.env['ORCA_CLAUDE_BIN'] = fakeClaude(dir).bin;
    let pane = '';
    let wait = -1;
    const runner = new CommandRunner(spawnDeps(dir, {
      tmux: {
        available: () => true,
        spawn: async (p: { name: string }) => { pane = p.name; return { ok: true, stdout: '', detail: '' }; },
      } as unknown as CommandDeps['tmux'],
      awaitSpawn: async (_want, ms) => { wait = ms; return null; },
    }));
    const res = await runner.execute({ k: 'spawn', projectId: 'p1', prompt: 'Audit the payments module.', parentId: null, mission: 'audit', background: true });
    const data = res.data as SpawnAck;
    return ok('stable identity without transcript wait', res.ok && wait === 0 && pane === `orca-${data.agentId}` && data.callsign === null);
  } finally {
    if (prev === undefined) delete process.env['ORCA_CLAUDE_BIN'];
    else process.env['ORCA_CLAUDE_BIN'] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

const spawnAckSurvivesNoSession = test('sin sesión a tiempo el ack sale ok con agentId null', async () => {
  const dir = temp();
  const prev = process.env['ORCA_CLAUDE_BIN'];
  try {
    const fake = fakeClaude(dir);
    process.env['ORCA_CLAUDE_BIN'] = fake.bin;
    const runner = new CommandRunner(spawnDeps(dir, { awaitSpawn: async () => null }));
    const res = await heldOpen(() => runner.execute({
      k: 'spawn', projectId: 'p1', prompt: 'algo', parentId: null,
      mission: 'x', background: true,
    }));
    const data = res.data as SpawnAck;
    return ok('sin sesión a tiempo el ack sale ok con agentId null',
      res.ok && data.agentId === null && data.shortId === 'a1b2c3d4'
      && (res.detail ?? '').includes('agent:new'),
      'el proceso arrancó: decir que falló sería mentir');
  } finally {
    if (prev === undefined) delete process.env['ORCA_CLAUDE_BIN'];
    else process.env['ORCA_CLAUDE_BIN'] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

const spawnPastesTheBrief = test('el prompt que recibe el CLI lleva el brief pegado', async () => {
  const dir = temp();
  const prev = process.env['ORCA_CLAUDE_BIN'];
  try {
    const fake = fakeClaude(dir);
    process.env['ORCA_CLAUDE_BIN'] = fake.bin;
    const runner = new CommandRunner(spawnDeps(dir));

    await heldOpen(() => runner.execute({
      k: 'spawn', projectId: 'p1', prompt: 'Lead the audit.', parentId: null,
      mission: 'audit', background: true, squad: 'audit-01', lead: true,
    }));
    const asLead = fake.argv().at(-1) ?? '';

    await heldOpen(() => runner.execute({
      k: 'spawn', projectId: 'p1', prompt: 'Audit the HTTP client.',
      parentId: 'sess-lead', mission: 'http', background: true, squad: 'audit-01',
    }));
    const asMember = fake.argv().at(-1) ?? '';

    await heldOpen(() => runner.execute({
      k: 'spawn', projectId: 'p1', prompt: 'Just work.', parentId: null,
      mission: 'solo', background: true,
    }));
    const alone = fake.argv().at(-1) ?? '';

    return ok('el prompt que recibe el CLI lleva el brief pegado',
      asLead.startsWith('Lead the audit.') && asLead.includes('you lead audit-01')
      && asMember.startsWith('Audit the HTTP client.')
      && asMember.includes('Your lead is K9')
      && alone === 'Just work.',
      'el líder sabe que lidera, el miembro a quién reporta, y un spawn suelto no cambia');
  } finally {
    if (prev === undefined) delete process.env['ORCA_CLAUDE_BIN'];
    else process.env['ORCA_CLAUDE_BIN'] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

const badSquadIsRefused = test('un nombre de escuadrón inválido no llega a lanzar nada', async () => {
  const dir = temp();
  const prev = process.env['ORCA_CLAUDE_BIN'];
  try {
    const fake = fakeClaude(dir);
    process.env['ORCA_CLAUDE_BIN'] = fake.bin;
    const runner = new CommandRunner(spawnDeps(dir));
    const res = await heldOpen(() => runner.execute({
      k: 'spawn', projectId: 'p1', prompt: 'x', parentId: null, mission: 'm',
      background: true, squad: 'no vale',
    }));
    return ok('un nombre de escuadrón inválido no llega a lanzar nada',
      !res.ok && (res.detail ?? '').includes('escuadrón') && fake.argv().length === 0,
      res.detail ?? '');
  } finally {
    if (prev === undefined) delete process.env['ORCA_CLAUDE_BIN'];
    else process.env['ORCA_CLAUDE_BIN'] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

const lineageRemembersTheSquad = test('lineage.json recuerda el escuadrón entre reinicios', () => {
  const dir = temp();
  try {
    const file = join(dir, 'lineage.json');
    const first = new LineageIndex(file);
    first.noteSpawn('a1b2c3d4', null, 'audit', 'audit-01', true);
    first.bind('a1b2c3d4', 'sess-lead');

    // Otro proceso, mismo disco: es lo que pasa cuando el collector reinicia.
    const second = new LineageIndex(file);
    const tree = second.resolve([
      { key: 'sess-lead', sessionId: 'sess-lead', agentId: null, metaPath: null, shortId: 'a1b2c3d4' },
    ]);
    const lin = tree.get('sess-lead');
    return ok('lineage.json recuerda el escuadrón entre reinicios',
      lin?.squad === 'audit-01' && lin?.lead === true && lin?.mission === 'audit',
      `squad=${lin?.squad} lead=${lin?.lead}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 5 · --open, de la CLI al mundo ───────────────────────────────── */

const openTravels = test('orca-show --open llega hasta el mundo del hub', async () => {
  const dir = temp();
  const home = join(dir, 'orca-home');
  const project = join(dir, 'project');
  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    const png = join(project, 'chart.png');
    writeFileSync(png, makePng(64, 5));

    // 1. La CLI escribe la declaración.
    execFileSync(process.execPath, [
      join(BIN, 'orca-show.mjs'), png, 'The chart', '--open', '--project', project,
      '--agent', 'sess-1', '--json',
    ], { env: { ...process.env, ORCA_HOME: home }, encoding: 'utf8' });

    const declDir = join(project, '.orca', 'artifacts');
    const decl = readdirSync(declDir).find((f) => f.endsWith('.json'));
    const payload = JSON.parse(readFileSync(join(declDir, decl ?? ''), 'utf8')) as Record<string, unknown>;
    if (payload['open'] !== true) {
      return { name: 'orca-show --open llega hasta el mundo del hub', pass: false, detail: 'el JSON no lleva open' };
    }

    // 2. El collector la recoge.
    const index = new ArtifactIndex({ machineId: MACHINE, resolveAgent: () => 'sess-1' });
    const seen: { open: boolean }[] = [];
    index.onArtifact((a) => seen.push(a));
    index.track('p1', project);
    index.start(20);
    const arrived = await until(() => seen.length > 0, 4000, 25);
    index.stop();
    if (!arrived) {
      return { name: 'orca-show --open llega hasta el mundo del hub', pass: false, detail: 'el collector no lo vio' };
    }

    // 3. El hub lo conserva al entrar por su lista blanca.
    const registered = index.list()[0]!;
    const clean = sanitizeArtifact(registered, MACHINE);
    return ok('orca-show --open llega hasta el mundo del hub',
      seen[0]?.open === true && clean?.open === true,
      'declaración → collector → sanitizador, sin perder la petición');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const openIsNotGuessed = test('la detección automática nunca pide abrir nada', async () => {
  const dir = temp();
  try {
    const png = join(dir, 'auto.png');
    writeFileSync(png, makePng(32, 2));
    const index = new ArtifactIndex({ machineId: MACHINE, resolveAgent: () => 'sess-1' });
    const a = index.note({ path: png, projectId: 'p1', agentId: 'sess-1', at: Date.now() });
    return ok('la detección automática nunca pide abrir nada',
      a !== null && a.open === false,
      'robarle la pantalla a alguien se pide, no se adivina');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── 6 · entrega a un escuadrón, con hub de verdad ────────────────── */

const squadTrafficReachesMembers = test('orca-tell --to squad: llega a los miembros y a nadie más', async () => {
  const dir = temp();
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    store: new HubStore({ dir }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
  });
  const fleet = startFakeFleet({
    hub: `ws://127.0.0.1:${hub.port}`, token: TOKEN, quiet: true, speed: 6,
    squad: 'audit-01', squadSize: 3,
  });
  try {
    const squadOf = (): { leaderId: string | null; memberIds: string[] } | undefined =>
      squadsOf(hub.world.state.agents).find((s) => s.name === 'audit-01');
    const arrived = await until(() => (squadOf()?.memberIds.length ?? 0) === 4, 8000, 50);
    const squad = squadOf();
    if (!arrived || !squad) {
      return {
        name: 'orca-tell --to squad: llega a los miembros y a nadie más',
        pass: false,
        detail: `el escuadrón no llegó al hub: ${JSON.stringify(squadsOf(hub.world.state.agents))}`,
      };
    }

    // El CEO manda al escuadrón lo mismo que `orca-tell --to squad:audit-01`
    // produce: un AgentMessage con scope 'squad'. El enrutado es el que se mide.
    const relayed = hub.relayMessage({
      kind: 'handoff', scope: 'squad', toSquad: 'audit-01',
      subject: 'Informe a las 18:00, una línea cada uno',
    });
    const delivered = [...relayed.delivered].sort();
    const expected = [...squad.memberIds].sort();

    // Y a un escuadrón que no existe no se le entrega a nadie: nunca degrada
    // a difusión, que sería despertar a la flota entera por un typo.
    const ghost = hub.relayMessage({
      kind: 'notice', scope: 'squad', toSquad: 'no-existe', subject: 'hola',
    });

    return ok('orca-tell --to squad: llega a los miembros y a nadie más',
      delivered.length === expected.length
      && delivered.every((id, i) => id === expected[i])
      && ghost.delivered.length === 0 && (ghost.reason ?? '').includes('no-existe'),
      `${delivered.length} entregas; escuadrón fantasma: ${ghost.reason ?? '(sin razón)'}`);
  } finally {
    fleet.stop();
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── suite ────────────────────────────────────────────────────────── */

const tests = [
  groupsBySquad,
  acceptsARecord,
  oldestLeaderWins,
  rejectsJunkNames,
  sanitizeKeepsSquad,
  sanitizeDropsJunkSquad,
  patchCarriesSquad,
  survivesTheSnapshot,
  diffCarriesSquad,
  messageScopeSquad,
  briefsSayTheRightThing,
  briefRidesTheEnd,
  spawnAckHasAgentId,
  hostedAckDoesNotWait,
  controlWorkspaceRefused,
  spawnAckSurvivesNoSession,
  spawnPastesTheBrief,
  badSquadIsRefused,
  lineageRemembersTheSquad,
  openTravels,
  openIsNotGuessed,
  squadTrafficReachesMembers,
];

const suite: TestModule = { suite: 'escuadrones · brief, ack, enrutado y --open', tests };
export default suite;

/** Sólo para que el runner no confunda un export suelto con una suite. */
export type { TestResult };
