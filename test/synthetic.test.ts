/**
 * La cuarentena del arnés.
 *
 * El fallo concreto que esto impide volver a tener: alguien arrancó
 * `npm run mock` contra el hub real para poder fotografiar una isla de la
 * consola, sus agentes de fixture escalaron preguntas inventadas —"¿subimos
 * three.js a 0.185?"— y el hub, que no sabía distinguirlas de las de verdad,
 * se las enrutó todas al CAPCOM real: nueve minutos contestando, el contexto
 * del 100% al 10%, y una compactación por el camino. El bucle es lo peor de
 * todo: la tarea de fotografiar esa isla EXIGE arrancar el mock, así que
 * trabajar en el arnés era lo que quemaba al mando que trabajaba en el arnés.
 *
 * Lo que se prueba aquí, de fuera adentro:
 *
 *  - una escalación nacida en una máquina sintética NO llega al mando, y una
 *    nacida en una real SÍ (si no, la prueba se pasaría sola con un hub roto);
 *  - la pregunta sintética sigue en el mundo, `pending`, porque lo que el
 *    arnés necesita es exactamente eso: consola poblada para poder mirarla;
 *  - un mensaje de escuadrón tampoco cruza, que es el otro camino por el que
 *    algo inventado acaba pegado en un pane de verdad;
 *  - la marca sobrevive al saneamiento y a una reconexión sin marca;
 *  - el mock se declara sintético, y al morir se lleva lo suyo.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import type { Agent, Escalation, Machine } from '../src/shared/types.ts';
import { PATHS, PROTOCOL_VERSION, newId } from '../src/shared/protocol.ts';
import type { Command } from '../src/shared/protocol.ts';
import { isSynthetic, sameWorld } from '../src/shared/synthetic.ts';
import { World, sanitizeMachine } from '../src/hub/world.ts';
import { createAuth } from '../src/hub/auth.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { HubStore } from '../src/hub/persist.ts';
import { FleetStore } from '../src/hub/fleets.ts';
import { startHub, type Hub } from '../src/hub/server.ts';
import { startFakeFleet } from './fake-collector.ts';
import { ok, eq, test, until, type TestModule } from './harness.ts';

const TOKEN = 'test-token-synthetic-0';

/* ── fixtures ─────────────────────────────────────────────────────── */

function machine(id: string, synthetic = false): Machine {
  return {
    id, hostname: id, platform: 'darwin', version: '0.1.0', online: true,
    lastSeen: Date.now(), connectedAt: Date.now(),
    load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null },
    ...(synthetic ? { synthetic: true } : {}),
  };
}

function agent(over: Partial<Agent> = {}): Agent {
  const now = Date.now();
  return {
    id: over.id ?? newId('sess'), machineId: 'm1', projectId: 'p1',
    title: 'test', callsign: 'K1', runtime: 'claude', state: 'working', block: null,
    parentId: null, depth: 0, childIds: [], mission: null,
    squad: null, lead: false,
    model: null, tool: null, toolDetail: null,
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

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    id: newId('esc'), agentId: 'a1', projectId: 'p1', machineId: 'm1',
    question: 'Should I upgrade three.js to 0.185?',
    context: null, options: ['yes', 'no'], optionsOnly: false,
    urgency: 'blocking', status: 'pending', ceoAttempt: null,
    answer: null, answeredBy: null, rememberAs: null,
    askedAt: Date.now(), answeredAt: null, expiresAt: null,
    ...over,
  };
}

function tempDir(): string { return mkdtempSync(join(tmpdir(), 'orca-synthetic-')); }

async function withHub<T>(fn: (hub: Hub) => Promise<T>): Promise<T> {
  const dir = tempDir();
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    store: new HubStore({ dir }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
    fleets: new FleetStore(join(dir, 'fleets')),
  });
  try { return await fn(hub); } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Un collector conectado de verdad: el hub sólo enruta a lo que tiene socket. */
async function collector(port: number, m: Machine): Promise<{
  ws: WebSocket; says: { agentId: string; text: string }[]; close(): void;
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${PATHS.collector}?token=${TOKEN}`);
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  const says: { agentId: string; text: string }[] = [];
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString()) as { t: string; cmd?: Command };
    if (f.t === 'cmd' && f.cmd?.k === 'say') says.push({ agentId: f.cmd.agentId, text: f.cmd.text });
  });
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token: TOKEN, machine: m }));
  return { ws, says, close: () => ws.close() };
}

/* ── la marca ─────────────────────────────────────────────────────── */

const marking = [
  test('sameWorld separa el arnés de la flota, en las dos direcciones', () => {
    const real = machine('m-real');
    const fake = machine('m-fake', true);
    return ok(
      'sameWorld separa el arnés de la flota',
      sameWorld(real, real) && sameWorld(fake, fake)
      && !sameWorld(real, fake) && !sameWorld(fake, real)
      && isSynthetic(fake) && !isSynthetic(real)
      // Sin máquina el defecto es el mundo real: una marca que no llegó no
      // puede convertir a nadie en fixture.
      && !isSynthetic(undefined) && sameWorld(undefined, real),
      'real↔real sí, falso↔falso sí, cruzado no',
    );
  }),

  test('la marca entra sólo si es un true de verdad, y ya no se cae', () => {
    const m = sanitizeMachine({ ...machine('m1'), synthetic: true });
    const lying = sanitizeMachine({ ...machine('m2'), synthetic: 'sí' });
    const world = new World();
    world.upsertMachine(sanitizeMachine({ ...machine('m3'), synthetic: true })!);
    // Una reconexión con un mock más viejo —o con la marca quitada a mano— no
    // saca a nadie de la cuarentena.
    world.upsertMachine(sanitizeMachine(machine('m3'))!);
    return ok(
      'la marca se sanea y es pegajosa',
      m?.synthetic === true && lying?.synthetic === undefined
      && world.state.machines['m3']?.synthetic === true,
      `hello: ${String(m?.synthetic)} · inventado: ${String(lying?.synthetic)} · tras reconectar: ${String(world.state.machines['m3']?.synthetic)}`,
    );
  }),
];

/* ── el fallo concreto ────────────────────────────────────────────── */

const routing = [
  test('una escalación de una máquina sintética no llega al CAPCOM, y una real sí', async () => {
    return await withHub(async (hub) => {
      // Dos mundos sobre el mismo hub: la máquina del mando, y el arnés.
      const real = await collector(hub.port, machine('m-real'));
      const fake = await collector(hub.port, machine('m-fake', true));
      try {
        const cap = agent({ id: 'cap1', machineId: 'm-real', callsign: 'CC', role: 'capcom', state: 'idle' });
        const worker = agent({ id: 'w1', machineId: 'm-real', callsign: 'K9' });
        real.ws.send(JSON.stringify({ t: 'agent:new', machineId: 'm-real', agent: cap }));
        real.ws.send(JSON.stringify({ t: 'agent:new', machineId: 'm-real', agent: worker }));
        fake.ws.send(JSON.stringify({
          t: 'agent:new', machineId: 'm-fake',
          agent: agent({ id: 'f1', machineId: 'm-fake', callsign: 'T4' }),
        }));
        await until(() => hub.world.state.agents['f1'] !== undefined, 4000);

        // El arnés pregunta. Nueve minutos de esto es lo que costó la última vez.
        const fromFake = escalation({ agentId: 'f1', machineId: 'm-fake' });
        fake.ws.send(JSON.stringify({ t: 'escalation', machineId: 'm-fake', escalation: fromFake }));
        await until(() => hub.world.state.escalations[fromFake.id] !== undefined, 4000);
        // Tiempo de sobra para que el triaje —que va en un microtask— pase.
        const leaked = await until(() => real.says.some((s) => s.text.includes('[ESCALATION')), 1200);

        // Y ahora una de verdad, por el mismo camino: sin esto, un hub que no
        // enrutase nada en absoluto pasaría esta prueba.
        const fromReal = escalation({ agentId: 'w1', machineId: 'm-real', question: 'Deploy to prod?' });
        real.ws.send(JSON.stringify({ t: 'escalation', machineId: 'm-real', escalation: fromReal }));
        const delivered = await until(() => real.says.some((s) => s.text.includes(fromReal.id)), 4000);

        // La sintética no se pierde: sigue en la cola del humano, que es lo que
        // el arnés necesita poder mirar y fotografiar.
        const stillThere = hub.world.state.escalations[fromFake.id]?.status;
        const toCapcom = real.says.filter((s) => s.agentId === 'cap1' && s.text.includes('[ESCALATION'));
        return ok(
          'la escalación sintética no llega al mando; la real sí',
          !leaked && delivered && stillThere === 'pending'
          && toCapcom.length === 1 && toCapcom[0]!.text.includes(fromReal.id),
          `al mando: ${toCapcom.length} (${toCapcom.map((s) => s.text.slice(0, 40)).join(' | ')}) · la sintética sigue ${String(stillThere)}`,
        );
      } finally { real.close(); fake.close(); }
    });
  }),

  test('un mensaje de escuadrón sintético no despierta a un agente de verdad', async () => {
    return await withHub(async (hub) => {
      const real = await collector(hub.port, machine('m-real'));
      const fake = await collector(hub.port, machine('m-fake', true));
      try {
        // El mismo nombre de escuadrón a los dos lados: el hub enruta por la
        // etiqueta y por nada más, así que sin cuarentena esto cruza.
        real.ws.send(JSON.stringify({
          t: 'agent:new', machineId: 'm-real',
          agent: agent({ id: 'r1', machineId: 'm-real', callsign: 'R1', squad: 'audit-01' }),
        }));
        fake.ws.send(JSON.stringify({
          t: 'agent:new', machineId: 'm-fake',
          agent: agent({ id: 'f2', machineId: 'm-fake', callsign: 'F2', squad: 'audit-01' }),
        }));
        fake.ws.send(JSON.stringify({
          t: 'agent:new', machineId: 'm-fake',
          agent: agent({ id: 'f3', machineId: 'm-fake', callsign: 'F3', squad: 'audit-01' }),
        }));
        await until(() => hub.world.state.agents['r1'] !== undefined && hub.world.state.agents['f3'] !== undefined, 4000);

        const delivers: string[] = [];
        real.ws.on('message', (raw) => {
          const f = JSON.parse(raw.toString()) as { t: string; cmd?: Command };
          if (f.t === 'cmd' && f.cmd?.k === 'deliver') delivers.push(f.cmd.agentId);
        });
        fake.ws.send(JSON.stringify({
          t: 'message', machineId: 'm-fake',
          message: {
            id: newId('msg'), kind: 'notice', scope: 'squad',
            fromAgentId: 'f2', fromCallsign: 'F2', fromProjectId: 'p1',
            toAgentId: null, toProjectId: null, toSquad: 'audit-01',
            subject: 'parad lo que estéis haciendo', body: null, files: [],
            at: Date.now(), readBy: [], expiresAt: null,
            answer: null, answeredAt: null, answeredBy: null,
          },
        }));
        const crossed = await until(() => delivers.includes('r1'), 1200);
        return ok(
          'el mensaje sintético se queda en su mundo',
          !crossed,
          crossed ? 'le llegó a un agente real' : 'ningún destinatario real',
        );
      } finally { real.close(); fake.close(); }
    });
  }),
];

/* ── el mock: cómo se presenta y cómo se va ───────────────────────── */

const harness = [
  test('el collector falso se declara sintético en el hello', async () => {
    return await withHub(async (hub) => {
      const fleet = startFakeFleet({ hub: `ws://127.0.0.1:${hub.port}`, token: TOKEN, quiet: true, speed: 6 });
      try {
        const up = await until(() => Object.keys(hub.world.state.machines).length > 0, 8000);
        const machines = Object.values(hub.world.state.machines);
        return ok(
          'toda máquina del arnés llega marcada',
          up && machines.length > 0 && machines.every(isSynthetic),
          machines.map((m) => `${m.id}:${m.synthetic === true ? 'synthetic' : 'REAL'}`).join(' '),
        );
      } finally { fleet.stop(); }
    });
  }),

  test('al retirarse, el arnés se lleva sus agentes y sus preguntas', async () => {
    return await withHub(async (hub) => {
      const fleet = startFakeFleet({ hub: `ws://127.0.0.1:${hub.port}`, token: TOKEN, quiet: true, speed: 8 });
      let before = 0;
      try {
        await until(() => Object.keys(hub.world.state.agents).length > 5, 8000);
        before = Object.keys(hub.world.state.agents).length;
        await fleet.standDown();
      } finally { fleet.stop(); }
      const left = await until(() => Object.keys(hub.world.state.agents).length === 0, 5000);
      const pending = Object.values(hub.world.state.escalations)
        .filter((e) => e.status === 'pending' || e.status === 'with_ceo');
      return ok(
        'una retirada no deja restos',
        left && pending.length === 0,
        `${before} agentes antes, ${Object.keys(hub.world.state.agents).length} después · ${pending.length} preguntas abiertas`,
      );
    });
  }),

  test('la pregunta de un agente que ya no está se retira sola', () => {
    // Los 298 muertos del incidente vinieron con 130 preguntas `pending` que
    // nadie podía contestar ya: el mundo las ofrecía al mando en cada barrido.
    const world = new World();
    world.upsertMachine(machine('m1'));
    world.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agent({ id: 'a1' }) }, 'm1');
    const esc = escalation({ agentId: 'a1', machineId: 'm1' });
    world.applyCollector({ t: 'escalation', machineId: 'm1', escalation: esc }, 'm1');
    const asked = world.state.escalations[esc.id]?.status;
    world.applyCollector({ t: 'agent:gone', machineId: 'm1', id: 'a1' }, 'm1');
    return eq(
      'la pregunta se va con el agente',
      `${String(asked)} → ${String(world.state.escalations[esc.id]?.status)}`,
      'pending → withdrawn',
    );
  }),
];

export default {
  suite: 'El arnés en cuarentena',
  tests: [...marking, ...routing, ...harness],
} satisfies TestModule;
