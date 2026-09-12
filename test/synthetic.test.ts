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

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import type { Agent, Escalation, Machine, Project } from '../src/shared/types.ts';
import { emptyRollup } from '../src/shared/types.ts';
import { PATHS, PROTOCOL_VERSION, newId } from '../src/shared/protocol.ts';
import type { Command } from '../src/shared/protocol.ts';
import { isSynthetic, sameWorld } from '../src/shared/synthetic.ts';
import { World, sanitizeMachine } from '../src/hub/world.ts';
import { createAuth } from '../src/hub/auth.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { HubStore } from '../src/hub/persist.ts';
import { FleetStore } from '../src/hub/fleets.ts';
import { startHub, type Hub } from '../src/hub/server.ts';
import { doorVerdict, isFixtureMachineId, startFakeFleet } from './fake-collector.ts';
import { CLOSE_NOT_HARNESS } from '../src/hub/auth.ts';
import { harnessHomeRefusal, harnessInvocation, harnessProcs, realOrcaHome, stopHarnessProcs } from '../src/hub/harness.ts';
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

function project(id: string, machineId: string): Project {
  return {
    id, machineId, slug: `-tmp-${id}`, name: id, path: `/tmp/${id}`, code: id.slice(-2).toUpperCase(),
    gitBranch: null, gitDirty: false, keyNames: [], sessionIds: [], rollup: emptyRollup(),
  };
}

function tempDir(): string { return mkdtempSync(join(tmpdir(), 'orca-synthetic-')); }

/**
 * Un hub de usar y tirar. `harness` es la postura de la frontera: sin decir
 * nada sale la de esta corrida —`test/run.ts` la marca de pruebas entera— y
 * `false` pide explícitamente un hub como el del operador.
 */
async function withHub<T>(fn: (hub: Hub) => Promise<T>, opts: { harness?: boolean } = {}): Promise<T> {
  const dir = tempDir();
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    ...(opts.harness === undefined ? {} : { harness: opts.harness }),
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

/**
 * Un collector que se anuncia y espera respuesta: o entra, o le cierran.
 *
 * `code` es el del cierre — 4004 es «este hub no admite fixtures», ver
 * `hub/auth.ts` — y `null` mientras siga conectado.
 */
async function knock(port: number, m: Machine): Promise<{ code: number | null; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${PATHS.collector}?token=${TOKEN}`);
  let code: number | null = null;
  ws.on('close', (c) => { code = c; });
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token: TOKEN, machine: m }));
  await until(() => code !== null, 2000);
  return { get code() { return code; }, close: () => ws.close() };
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

  test('de dónde salió el arnés lo dice el arnés, y sólo el arnés', () => {
    const home = '-Users-dan-projects-orca';
    const fake = sanitizeMachine({ ...machine('m1'), synthetic: true, harnessOf: home });
    // Una máquina de verdad no puede colgarse de la isla de un proyecto ajeno:
    // el origen sólo se cree sobre una marca que ya quita permisos.
    const real = sanitizeMachine({ ...machine('m2'), harnessOf: home });
    const world = new World();
    world.upsertMachine(fake!);
    // Y se conserva: una reconexión sin él no vacía el recinto en el que la
    // consola ya había plantado sus teselas.
    world.upsertMachine(sanitizeMachine({ ...machine('m1'), synthetic: true })!);
    const kept = world.state.machines['m1']?.harnessOf;
    return ok(
      'el origen del arnés se sanea y se conserva',
      fake?.harnessOf === home && real?.harnessOf === undefined && kept === home,
      `arnés: ${String(fake?.harnessOf)} · real: ${String(real?.harnessOf)} · tras reconectar: ${String(kept)}`,
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

/* ── la frontera: quién puede siquiera entrar ─────────────────────── */

const border = [
  test('un hub que no se declara de pruebas rechaza a la máquina sintética; uno que sí, la acepta', async () => {
    // El mismo `hello`, la misma máquina, dos hubs. Lo único que cambia es la
    // postura del hub, que es exactamente donde el operador quiso la decisión.
    const real = await withHub(async (hub) => {
      const knocked = await knock(hub.port, machine('m-fake', true));
      const inside = Object.keys(hub.world.state.machines).length;
      knocked.close();
      return { code: knocked.code, inside };
    }, { harness: false });

    const test0 = await withHub(async (hub) => {
      const knocked = await knock(hub.port, machine('m-fake', true));
      const inside = await until(() => hub.world.state.machines['m-fake'] !== undefined, 2000);
      knocked.close();
      return { code: knocked.code, inside };
    }, { harness: true });

    return ok(
      'la puerta la abre el hub, no el cliente',
      real.code === CLOSE_NOT_HARNESS && real.inside === 0
      && test0.code === null && test0.inside,
      `hub real: cierre ${String(real.code)}, ${real.inside} máquinas dentro · `
      + `hub de pruebas: cierre ${String(test0.code)}, entró ${String(test0.inside)}`,
    );
  }),

  test('un collector de verdad entra en el hub real: la puerta filtra fixtures, no collectors', async () => {
    // Sin esto, un hub que rechazara TODO pasaría la prueba de arriba.
    return await withHub(async (hub) => {
      const knocked = await knock(hub.port, machine('m-real'));
      const inside = await until(() => hub.world.state.machines['m-real'] !== undefined, 2000);
      knocked.close();
      return ok(
        'lo real sigue entrando',
        knocked.code === null && inside,
        `cierre ${String(knocked.code)} · dentro: ${String(inside)}`,
      );
    }, { harness: false });
  }),

  test('el arnés entero se estrella contra un hub real, con --anyway o sin él', async () => {
    // Lo que ocurrió el 2026-09-07, ahora del lado que no puede fallar: aunque
    // alguien salte la puerta del mock, sus tres máquinas no entran.
    return await withHub(async (hub) => {
      const fleet = startFakeFleet({ hub: `ws://127.0.0.1:${hub.port}`, token: TOKEN, quiet: true, speed: 6 });
      try {
        const got = await until(() => Object.keys(hub.world.state.machines).length > 0, 2500);
        return ok(
          'ni una máquina, ni un agente, ni un dólar',
          !got && Object.keys(hub.world.state.agents).length === 0,
          `${Object.keys(hub.world.state.machines).length} máquinas · `
          + `${Object.keys(hub.world.state.agents).length} agentes`,
        );
      } finally { fleet.stop(); }
    }, { harness: false });
  }),

  test('--anyway sigue sirviendo para un hub de pruebas con mando, y para nada más', () => {
    const real = doorVerdict({ reachable: true, harness: false, capcom: null, anyway: true });
    const realConMando = doorVerdict({ reachable: true, harness: false, capcom: { callsign: 'CC' }, anyway: true });
    const pruebasConMando = doorVerdict({ reachable: true, harness: true, capcom: { callsign: 'CC' }, anyway: false });
    const pruebasAnyway = doorVerdict({ reachable: true, harness: true, capcom: { callsign: 'CC' }, anyway: true });
    const mudo = doorVerdict({ reachable: false, harness: false, capcom: null, anyway: true });
    return ok(
      '--anyway dejó de ser una llave maestra',
      !real.go && !realConMando.go && !pruebasConMando.go && pruebasAnyway.go && !mudo.go
      // Y el mensaje dice qué hacer: sin eso, quien lo intente vuelve a probar flags.
      && !real.go && real.why.some((l) => l.includes('--isolated')),
      `hub real: ${real.go ? 'ABRE' : 'no'} · real+mando: ${realConMando.go ? 'ABRE' : 'no'} · `
      + `pruebas+mando: ${pruebasConMando.go ? 'abre' : 'NO'} · con --anyway: ${pruebasAnyway.go ? 'abre' : 'NO'} · `
      + `hub mudo: ${mudo.go ? 'ABRE' : 'no'}`,
    );
  }),
];

/* ── el diario y el directorio: lo que un hub de pruebas deja en disco ── */

/** `tsx src/hub/server.ts` como proceso hijo, con el entorno que se le dé. */
function hubProcess(env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; listening: boolean }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/hub/server.ts'], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let listening = false;
    const read = (b: Buffer): void => {
      out += b.toString();
      // Arrancó: con eso basta, y se para aquí mismo. Es nuestro hijo, por pid.
      if (!listening && out.includes('escuchando en')) { listening = true; child.kill('SIGTERM'); }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    const cut = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.once('exit', (code) => { clearTimeout(cut); done({ code, out, listening }); });
  });
}

const ROOT = new URL('..', import.meta.url).pathname;

const disk = [
  test('el diario no anota al arnés, y al collector real de al lado sí', async () => {
    return await withHub(async (hub) => {
      // El fixture de verdad, el de test/fake-collector.ts: lanza por snapshot,
      // que es lo que el barrido convierte en entradas.
      const fleet = startFakeFleet({ hub: `ws://127.0.0.1:${hub.port}`, token: TOKEN, quiet: true, speed: 6 });
      // Y dos collectors a mano, para que la pregunta y el final no dependan del azar.
      const real = await collector(hub.port, machine('m-real'));
      const fake = await collector(hub.port, machine('m-fake', true));
      try {
        for (const [c, m, id] of [[real, 'm-real', 'r1'], [fake, 'm-fake', 'f1']] as const) {
          c.ws.send(JSON.stringify({ t: 'agent:new', machineId: m, agent: agent({ id, machineId: m, callsign: id.toUpperCase() }) }));
        }
        await until(() => hub.world.state.agents['r1'] !== undefined && hub.world.state.agents['f1'] !== undefined, 4000);
        for (const [c, m, id] of [[real, 'm-real', 'r1'], [fake, 'm-fake', 'f1']] as const) {
          c.ws.send(JSON.stringify({ t: 'escalation', machineId: m, escalation: escalation({ agentId: id, machineId: m }) }));
          c.ws.send(JSON.stringify({ t: 'agent', machineId: m, id, patch: { state: 'done' } }));
        }
        const fleetIn = await until(() => Object.values(hub.world.state.agents)
          .filter((a) => isFixtureMachineId(a.machineId)).length > 5, 8000);
        await until(() => hub.world.state.agents['f1']?.state === 'done' && hub.world.state.agents['r1']?.state === 'done', 4000);
        const swept = hub.autonomy.journal.sweep() + hub.autonomy.journal.sweep();
        await hub.autonomy.journal.flush();

        const all = hub.autonomy.journal.query({ limit: 500 });
        const leaked = all.filter((e) => e.machineId === 'm-fake' || (e.machineId !== null && isFixtureMachineId(e.machineId)));
        const kinds = all.filter((e) => e.machineId === 'm-real').map((e) => e.kind).sort().join(',');
        return ok(
          'sólo lo real llega al diario',
          fleetIn && leaked.length === 0 && swept === 0 && kinds === 'end,escalation,launch',
          `${all.length} entradas · del arnés: ${leaked.length} · barrido escribió ${swept} · reales: ${kinds}`,
        );
      } finally { real.close(); fake.close(); fleet.stop(); }
    });
  }),

  test('un hub de pruebas se niega a arrancar sobre el ORCA_HOME del operador', () => {
    const home = tempDir();
    try {
      const real = realOrcaHome(home);
      mkdirSync(real, { recursive: true });
      const link = join(home, 'enlace-a-orca');
      symlinkSync(real, link);
      const own = join(home, 'otro');
      const cases = {
        porOmision: harnessHomeRefusal({ harness: true, orcaDir: real, home }) !== null,
        porEnlace: harnessHomeRefusal({ harness: true, orcaDir: link, home }) !== null,
        conBarra: harnessHomeRefusal({ harness: true, orcaDir: `${real}/`, home }) !== null,
        propio: harnessHomeRefusal({ harness: true, orcaDir: own, home }) === null,
        hubReal: harnessHomeRefusal({ harness: false, orcaDir: real, home }) === null,
      };
      return ok('la guarda mira el directorio, no el nombre', Object.values(cases).every(Boolean), JSON.stringify(cases));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }),

  test('arrancado de verdad: sin ORCA_HOME propio no arranca ni toca el disco; con él, sí', async () => {
    // Un HOME de mentira: el ~/.orca que se protege es el suyo, no el del operador.
    const home = tempDir();
    const own = tempDir();
    const base: NodeJS.ProcessEnv = {
      ...process.env, HOME: home, ORCA_HARNESS: '1', ORCA_PORT: '0', ORCA_HOST: '127.0.0.1',
      ORCA_TOKEN: 'test-token-harness-home',
    };
    delete base['ORCA_HOME'];
    try {
      const refused = await hubProcess(base);
      const wrote = existsSync(join(realOrcaHome(home), 'hub'));
      const started = await hubProcess({ ...base, ORCA_HOME: own });
      return ok(
        'la guarda está en el hub, y sólo salta donde debe',
        !refused.listening && refused.code !== 0 && refused.out.includes('no arranca') && !wrote
        && started.listening && existsSync(join(own, 'hub')),
        `sin propio: code ${String(refused.code)}, escribió hub/: ${String(wrote)} · con propio: escuchó ${String(started.listening)}`
        + ` · ${refused.out.split('\n').find((l) => l.includes('ORCA_HOME')) ?? refused.out.slice(-300)}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(own, { recursive: true, force: true });
    }
  }),
];

/* ── contención: purgar un mundo ya contaminado ───────────────────── */

const containment = [
  test('la purga se lleva lo del arnés y no roza lo real', async () => {
    const world = new World();
    world.upsertMachine(machine('m-real'));
    world.upsertMachine(machine('m-fake', true));
    world.applyCollector({ t: 'project:new', machineId: 'm-real', project: project('p-real', 'm-real') }, 'm-real');
    world.applyCollector({ t: 'project:new', machineId: 'm-fake', project: project('p-fake', 'm-fake') }, 'm-fake');
    world.applyCollector({
      t: 'agent:new', machineId: 'm-real',
      agent: agent({ id: 'r1', machineId: 'm-real', projectId: 'p-real' }),
    }, 'm-real');
    world.applyCollector({
      t: 'agent:new', machineId: 'm-fake',
      agent: agent({ id: 'f1', machineId: 'm-fake', projectId: 'p-fake' }),
    }, 'm-fake');
    const esc = escalation({ agentId: 'f1', machineId: 'm-fake', projectId: 'p-fake' });
    world.applyCollector({ t: 'escalation', machineId: 'm-fake', escalation: esc }, 'm-fake');

    const removed = world.purgeSynthetic();
    const st = world.state;
    return ok(
      'un golpe deja el mundo real intacto',
      removed.machines === 1 && removed.agents === 1 && removed.projects === 1 && removed.escalations === 1
      && st.machines['m-fake'] === undefined && st.agents['f1'] === undefined
      && st.projects['p-fake'] === undefined && st.escalations[esc.id] === undefined
      && st.machines['m-real'] !== undefined && st.agents['r1'] !== undefined
      && st.projects['p-real'] !== undefined,
      `quitado ${JSON.stringify(removed)} · quedan ${Object.keys(st.machines).length} máquinas, `
      + `${Object.keys(st.agents).length} agentes, ${Object.keys(st.projects).length} proyectos`,
    );
  }),

  test('el gasto del arnés no suma en el total de la flota, y el real sí', async () => {
    // Los mil dólares ficticios del incidente entraron por este contador: es el
    // que enseña el HUD y el que publica /api/health.
    const world = new World();
    world.upsertMachine(machine('m-real'));
    world.upsertMachine(machine('m-fake', true));
    const use = (id: string, machineId: string, projectId: string, toks: number): void => {
      const a = agent({ id, machineId, projectId });
      a.metrics.inputTokens = toks;
      world.applyCollector({ t: 'agent:new', machineId, agent: a }, machineId);
    };
    use('r1', 'm-real', 'p-real', 12_000);
    use('f1', 'm-fake', 'p-fake', 1_000_000);
    world.settle();
    // Con los dos dentro: el arnés cuenta como agente y no cuenta como consumo.
    const before = world.state.fleet.tokens;
    const agentsBefore = world.state.fleet.total;
    world.purgeSynthetic();
    world.settle();
    return ok(
      'el total de la flota es trabajo de verdad',
      before === 12_000 && agentsBefore === 2
      && world.state.fleet.tokens === 12_000 && world.state.fleet.total === 1,
      `con el arnés dentro: ${before} tokens sobre ${agentsBefore} agentes · tras purgarlo: `
      + `${world.state.fleet.tokens} tokens sobre ${world.state.fleet.total} agentes`,
    );
  }),

  test('sólo se señala a un programa del arnés que apunte a ESTE hub', () => {
    const ps = [
      '  501 node /usr/bin/tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479 --speed=3 --anyway',
      '  502 node /usr/bin/tsx test/fake-collector.ts --hub=ws://127.0.0.1:5599 --speed=3',
      '  503 node /usr/bin/tsx test/fake-collector.ts --isolated',
      '  504 node /usr/bin/tsx test/visual.ts',
      '  505 node /usr/bin/tsx src/hub/server.ts',
      '  506 node /usr/bin/tsx src/collector/index.ts',
      '  507 node /usr/bin/tsx test/run.ts',
      '  508 claude --mcp-config /Users/x/.orca/capcom/.mcp.json',
      // La forma real del mock: tsx no aparece como ejecutable sino como par
      // de loaders de node. Sin reconocerla no se pararía al que sí molesta.
      '  509 node --require /r/node_modules/tsx/dist/preflight.cjs --import file:///r/node_modules/tsx/dist/loader.mjs test/fake-collector.ts --hub=ws://127.0.0.1:4479 --anyway',
      '  510 npm exec tsx test/field-stress.ts',
    ].join('\n');
    const hit = harnessProcs(ps, { hubPort: 4479 }).map((p) => p.pid).sort((a, b) => a - b);
    return eq(
      'la lista de a quién se puede matar es corta a propósito',
      hit.join(','),
      // 501: el mock contra nosotros. 504: el arnés visual, que arranca uno.
      // 509 es el mismo mock en su forma real, y 510 el de rendimiento.
      // 502 apunta a otro puerto, 503 tiene su propio mundo, y del 505 al 508
      // no son del arnés: el hub, el collector, `npm test` y el propio CAPCOM.
      '501,504,509,510',
    );
  }),

  /*
   * El incidente del 2026-09-09, en una prueba.
   *
   * CAPCOM llamó a `purge_harness` en un latido y la operación mató a un agente
   * de la flota: el que estaba trabajando en el arnés. Su brief citaba el
   * comando del mock —`tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479
   * --speed=3 --anyway`— y ese texto viaja en su línea de comandos, así que la
   * regla de entonces, un `includes` sobre la línea entera, encontró el script
   * y encontró el puerto. Los dos leídos de un PROMPT.
   *
   * Cada línea de aquí abajo nombra el script y nombra el hub real. Ninguna lo
   * está ejecutando, y ésa es toda la diferencia que hay que ver.
   */
  test('nombrar el arnés no es ejecutarlo: prompts, editores y shells no se señalan', () => {
    const ps = [
      // El agente que murió, tal y como `ps` lo enseñaba.
      '  68523 /Users/d/.local/bin/claude --session-id 8ecbcf65-dcb8-4b91-88d1-43261cdaef92 --permission-mode auto --name EL HARNESS NO DEBE PODER ENTRAR EN EL HUB REAL Alguien arrancó tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479 --speed=3 --anyway',
      '  601 codex exec arregla test/fake-collector.ts --hub=ws://127.0.0.1:4479',
      '  602 /bin/zsh -lc npx tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479',
      '  603 vim test/fake-collector.ts',
      '  604 grep -rn --hub=ws://127.0.0.1:4479 test/fake-collector.ts',
      '  605 node /usr/bin/tsx scripts/mirror/test/fake-collector.ts.bak --hub=ws://127.0.0.1:4479',
      '  606 node /usr/bin/tsx test/fake-collector-notes.ts --hub=ws://127.0.0.1:4479',
      // Y uno de verdad en la misma foto: si nada se señalara, la prueba
      // pasaría por no hacer nada, que es la forma barata de estar en verde.
      '  607 node /usr/bin/tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479',
    ].join('\n');
    const hit = harnessProcs(ps, { hubPort: 4479 }).map((p) => p.pid).sort((a, b) => a - b);
    return eq('sólo el que ejecuta el script', hit.join(','), '607');
  }),

  /*
   * El mismo incidente por la otra puerta, la que quedó abierta al arreglarlo.
   *
   * La regla estructural mira quién es el ejecutable y qué hay entre él y el
   * script. Entre medias se admitía cualquier módulo —`.js`, `.mjs`, `.cjs`, o
   * cualquier ruta con `node_modules`— porque la forma real del mock carga dos
   * (`--require preflight.cjs`, `--import loader.mjs`). Pero un módulo suelto no
   * es un cargador: es EL PROGRAMA, y lo que sigue son sus argumentos.
   *
   * Con eso, un agente lanzado como `node .../cli.js` cuyo prompt cite el script
   * volvía a encajar entero —ejecutable de la lista blanca, `cli.js` colado como
   * preámbulo, `--print` como opción, y el prompt aportando script y puerto—, que
   * es exactamente cómo murió el agente del 2026-09-09. Medido contra el código
   * anterior a esta prueba: los pid 901 y 902 salían señalados.
   */
  test('un módulo suelto es el programa, no un preámbulo: cli.js y report.js no se señalan', () => {
    const ps = [
      // Un agente de la flota al que le hablan del arnés, lanzado por node.
      '  901 node /Users/d/.local/share/claude/versions/2.1.266/cli.js --print arregla test/fake-collector.ts --hub=ws://127.0.0.1:4479',
      // El mismo caso con el prompt empezando por el script, que es el peor.
      '  902 node /opt/agents/cli.mjs --name test/fake-collector.ts --hub=ws://127.0.0.1:4479 se cuela en el hub',
      // Cualquier herramienta que reciba la ruta como argumento.
      '  903 node tools/report.js test/fake-collector.ts --hub=ws://127.0.0.1:4479',
      // Y las formas reales del mock, que tienen que seguir reconociéndose: un
      // arreglo que las pierda deja el problema original sin resolver.
      '  904 node /usr/bin/tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479',
      '  905 node --require /r/node_modules/tsx/dist/preflight.cjs --import file:///r/node_modules/tsx/dist/loader.mjs test/fake-collector.ts --hub=ws://127.0.0.1:4479',
      '  906 node /r/node_modules/.bin/tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479',
    ].join('\n');
    const hit = harnessProcs(ps, { hubPort: 4479 }).map((p) => p.pid).sort((a, b) => a - b);
    return eq('el programa no es el script que nombra', hit.join(','), '904,905,906');
  }),

  /*
   * El contrato entero, en una matriz.
   *
   * Las dos correcciones anteriores quitaban formas de la lista de lo señalable
   * —primero los módulos sueltos, después las opciones que no ejecutan— y las
   * dos veces se quedó algo fuera. La línea de node no es una lista de palabras
   * con excepciones: `--eval=0` y `-e0` llevan el valor pegado, `--title` es una
   * opción con valor que nadie había enumerado, y detrás de cada una volvía a
   * caber el mismo falso positivo. La lista de lo que node acepta no se puede
   * completar desde aquí.
   *
   * Así que la regla dejó de descartar y pasó a RECONOCER: cinco formas, todas
   * sacadas de `ps` o de `package.json`, y lo que no encaje entero no se toca.
   * Esta prueba es ese contrato escrito al derecho y al revés — lo que tiene que
   * seguir reconociéndose, y todo lo que se probó a colar por el borde: las
   * cuatro escrituras de `--eval`, `--print` y `--check`, las opciones con valor
   * que nadie enumeró, el script puesto como módulo de carga, los programas que
   * sólo lo nombran, los vecinos del nombre, el delimitador y los runtimes que
   * ORCA no usa.
   *
   * Medida contra la versión anterior a este cambio: catorce de estas líneas
   * salían señaladas.
   */
  test('el contrato de invocaciones: cinco formas reconocidas, y lo demás no se toca', () => {
    const S = 'test/fake-collector.ts';
    const matriz: [string, boolean][] = [
      // Las formas reales, que son las que no se pueden perder.
      [`tsx ${S} --hub=ws://127.0.0.1:4479`, true],
      ['tsx test/visual.ts', true],
      [`node /Users/d/p/orca/node_modules/.bin/tsx ${S}`, true],
      [`node /usr/bin/tsx ${S} --speed=3`, true],
      [`node --require /r/node_modules/tsx/dist/preflight.cjs --import file:///r/node_modules/tsx/dist/loader.mjs ${S} --hub=ws://127.0.0.1:4479`, true],
      [`node --require=/r/node_modules/tsx/dist/preflight.cjs --import=file:///r/node_modules/tsx/dist/loader.mjs ${S}`, true],
      [`node -r /r/x/preflight.cjs /r/node_modules/.bin/tsx ${S}`, true],
      [`npx tsx ${S}`, true],
      ['npm exec tsx test/field-stress.ts', true],
      [`npm exec -- tsx ${S}`, true],
      ['npm x -- tsx test/visual.ts', true],
      // La misma opción escrita de las cuatro maneras: separada, pegada con `=`,
      // corta, y corta con el valor pegado. Ninguna ejecuta el archivo.
      [`node --eval ${S}`, false], [`node --eval=0 ${S}`, false], [`node -e ${S}`, false], [`node -e0 ${S}`, false],
      [`node --print ${S}`, false], [`node --print=0 ${S}`, false], [`node -p ${S}`, false], [`node -p0 ${S}`, false],
      [`node --check ${S}`, false], [`node -c ${S}`, false], [`node --check=1 ${S}`, false],
      [`node --version ${S}`, false], [`node -v ${S}`, false],
      // Opciones con valor que nadie enumeró: es la clase entera, no tres casos.
      [`node --title ${S} tools/report.js`, false],
      [`node --conditions ${S} tools/report.js`, false],
      [`node --stack-size ${S} tools/report.js`, false],
      [`node --max-old-space-size=4096 ${S}`, false],
      [`node --inspect-brk=9229 ${S}`, false],
      // El script puesto como módulo de carga: un `.ts` no es un cargador.
      [`node --require ${S} tools/report.js`, false],
      [`node --require=${S} tools/report.js`, false],
      [`node --import ${S} tools/report.js`, false],
      [`node --loader ${S} tools/report.js`, false],
      [`node -r ${S} /r/node_modules/.bin/tsx tools/report.js`, false],
      // Programas que sólo lo NOMBRAN: el incidente, y sus parientes.
      [`/Users/d/.local/bin/claude --session-id 8ecbcf65 --name arregla tsx ${S} --hub=ws://127.0.0.1:4479`, false],
      [`node /Users/d/.local/share/claude/versions/2.1.266/cli.js --print arregla ${S}`, false],
      [`node /Users/d/.local/share/claude/versions/2.1.266/cli.js -p tsx ${S}`, false],
      [`node /opt/agents/cli.mjs --name ${S} se cuela`, false],
      [`node tools/report.js ${S}`, false],
      [`node /r/node_modules/@x/grok/cli.js exec tsx ${S}`, false],
      [`codex exec arregla ${S}`, false],
      [`/bin/zsh -lc npx tsx ${S}`, false],
      [`vim ${S}`, false],
      [`grep -rn --hub=ws://127.0.0.1:4479 ${S}`, false],
      // Vecinos del nombre: parecerse no es serlo.
      [`node /usr/bin/tsx scripts/mirror/${S}.bak`, false],
      ['node /usr/bin/tsx test/fake-collector-notes.ts', false],
      ['node /usr/bin/tsx test/run.ts', false],
      ['node /usr/bin/tsx src/hub/server.ts', false],
      // Delimitador y subcomandos que no llevan el script en la línea.
      ['npm run mock', false],
      [`npm exec ${S}`, false],
      [`npx ${S}`, false],
      [`node -- ${S}`, false],
      // Runtimes que ORCA no arranca: fuera del contrato a propósito.
      [`bun ${S}`, false],
      [`deno run -A ${S}`, false],
    ];
    const fallos = matriz
      .filter(([linea, debe]) => (harnessInvocation(linea) !== null) !== debe)
      .map(([linea]) => linea);
    return eq(
      `las ${matriz.length} formas de la matriz caen del lado que les toca`,
      fallos.join(' · ') || 'ninguno',
      'ninguno',
    );
  }),

  test('la señal se vuelve a mirar antes de mandarla, y no se le da al grupo ajeno', async () => {
    const ps = [
      '  701 node /usr/bin/tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479',
      '  702 node /usr/bin/tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479',
      '  703 node /usr/bin/tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479',
    ].join('\n');
    const sent: string[] = [];
    const stopped = await stopHarnessProcs({
      hubPort: 4479,
      ps,
      graceMs: 0,
      deps: {
        identify: (pid) => {
          // 701 sigue siendo él y lidera su grupo: se le puede dar al grupo.
          if (pid === 701) return { pgid: 701, command: 'node /usr/bin/tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479' };
          // 702 sigue siendo él pero cuelga del grupo de otro: sólo a él.
          if (pid === 702) return { pgid: 4242, command: 'node /usr/bin/tsx test/fake-collector.ts --hub=ws://127.0.0.1:4479' };
          // 703 se fue y su número lo heredó un agente. Ni una señal.
          if (pid === 703) return { pgid: 703, command: '/Users/d/.local/bin/claude --session-id x --name arregla test/fake-collector.ts --hub=ws://127.0.0.1:4479' };
          return null;
        },
        send: (target, sig) => { sent.push(`${target}:${sig}`); },
      },
    });
    const how = stopped.map((x) => `${x.pid}:${x.how}`).sort().join(' ');
    // `term` sale de `alive()`, que sobre pids inventados dice que no están:
    // lo que se comprueba aquí es a QUIÉN se le manda, no quién muere.
    return ok(
      'la señal se vuelve a mirar antes de mandarla, y no se le da al grupo ajeno',
      sent.join(' ') === '-701:SIGTERM 702:SIGTERM' && how.includes('703:changed'),
      `señales: [${sent.join(', ')}] · resultado: ${how}`,
    );
  }),
];

export default {
  suite: 'El arnés en cuarentena',
  tests: [...marking, ...routing, ...harness, ...border, ...disk, ...containment],
} satisfies TestModule;
