/**
 * El canal agente↔agente, visto desde el hub.
 *
 * Los agentes no tienen socket entre ellos: dejan un mensaje, su collector lo
 * sube, y el hub lo enruta. Eso convierte al hub en el único que ve las dos
 * máquinas de una conversación, y también en el único sitio donde este canal
 * puede fallar en silencio:
 *
 *  - un mensaje que no llega a nadie parece un mensaje entregado;
 *  - un `ask` desalojado por viejo deja a alguien bloqueado para siempre;
 *  - una difusión sin techo interrumpe a cien agentes a la vez;
 *  - un mensaje devuelto a su emisor lo hace esperarse a sí mismo.
 *
 * Cada prueba de aquí fija una de esas. Las de ruteo levantan un hub de verdad
 * con dos collectors conectados, porque el ruteo entre máquinas no se puede
 * demostrar con un World suelto; las de retención y saneo construyen el World
 * directamente, como en retention.test.ts.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import type { Agent, AgentMessage, Collision, Project } from '../src/shared/types.ts';
import { emptyRollup } from '../src/shared/types.ts';
import type { Command, CommandFrame } from '../src/shared/protocol.ts';
import { PATHS, PROTOCOL_VERSION } from '../src/shared/protocol.ts';

import {
  World, sanitizeMessage, looksLikeSecret,
  MAX_MESSAGES, MESSAGE_RETENTION_MS,
} from '../src/hub/world.ts';
import { startHub, MAX_BROADCAST } from '../src/hub/server.ts';
import type { Hub } from '../src/hub/server.ts';
import { createAuth } from '../src/hub/auth.ts';
import { HubStore } from '../src/hub/persist.ts';
import { AnswerMemory } from '../src/hub/memory.ts';

import { ok, eq, test, sleep, until, type TestModule, type TestResult } from './harness.ts';

const NOW = 1_800_000_000_000;
const TOKEN = 'test-token-traffic-000';

/* ── fixtures ─────────────────────────────────────────────────────── */

function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return {
    id, machineId: 'm1', projectId: 'p1',
    title: id, callsign: id.slice(0, 2).toUpperCase(),
    state: 'working', block: null,
    parentId: null, depth: 0, childIds: [], mission: null,
    model: 'claude-opus-5', tool: null, toolDetail: null,
    lastPrompt: null, lastSay: null,
    startedAt: NOW - 60_000, updatedAt: NOW, uptimeMs: 60_000,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      thinkingTokens: 0, tokensPerSec: 0, linesAdded: 0, linesRemoved: 0,
      toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    background: false, shortId: null,
    ...patch,
  };
}

function project(id: string, machineId: string): Project {
  return {
    id, machineId, slug: `-${id}`, name: id, path: `/${id}`, code: id.slice(0, 2).toUpperCase(),
    gitBranch: 'main', gitDirty: false, keyNames: [], sessionIds: [], rollup: emptyRollup(),
  };
}

function message(id: string, patch: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id, kind: 'notice', scope: 'agent',
    fromAgentId: 'k9', fromCallsign: 'K9', fromProjectId: 'p1',
    toAgentId: 't1', toProjectId: null,
    subject: `asunto ${id}`, body: null, files: [],
    at: NOW, readBy: [], expiresAt: null,
    answer: null, answeredAt: null, answeredBy: null,
    ...patch,
  };
}

function collision(id: string, agentIds: string[], patch: Partial<Collision> = {}): Collision {
  return {
    id, path: '/p1/src/index.ts', projectId: 'p1', machineId: 'm1',
    agentIds, firstSeen: NOW - 30_000, lastSeen: NOW, acknowledged: false,
    ...patch,
  };
}

/** Un mundo poblado a mano, sin sockets. Mismo patrón que retention.test.ts. */
function seed(agents: Agent[], messages: AgentMessage[] = [], collisions: Collision[] = []): World {
  const w = new World({ now: () => NOW });
  w.upsertMachine({
    id: 'm1', hostname: 'test', platform: 'darwin', version: '0',
    online: true, lastSeen: NOW, connectedAt: NOW,
    load: { sessions: agents.length, activeSessions: 0, cpuPct: null, memPct: null },
  });
  w.state.projects['p1'] = project('p1', 'm1');
  for (const a of agents) w.state.agents[a.id] = a;
  for (const m of messages) w.state.messages[m.id] = m;
  for (const c of collisions) w.state.collisions[c.id] = c;
  return w;
}

/* ── un collector de mentira, hablado a mano ──────────────────────── */

/**
 * Deliberadamente crudo: manda frames y guarda los comandos que le llegan. Lo
 * que se quiere observar es exactamente eso — a qué collector le llegó el
 * `{k:'deliver'}` y a cuál no.
 */
class TestCollector {
  ws: WebSocket;
  received: Command[] = [];

  constructor(port: number, readonly machineId: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${PATHS.collector}?token=${TOKEN}`);
    this.ws.on('message', (d) => {
      try {
        const frame = JSON.parse(d.toString()) as CommandFrame;
        if (frame.t === 'cmd') this.received.push(frame.cmd);
      } catch { /* basura del hub: no la hay, pero no revienta la prueba */ }
    });
    this.ws.on('error', () => { /* el cierre del hub llega como error */ });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('close', (code) => reject(new Error(`collector cerró con ${code}`)));
    });
    this.send({
      t: 'hello', v: PROTOCOL_VERSION, token: TOKEN,
      machine: {
        id: this.machineId, hostname: this.machineId, platform: 'darwin', version: '0',
        online: true, lastSeen: Date.now(), connectedAt: Date.now(),
        load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null },
      },
    });
  }

  send(frame: unknown): void { this.ws.send(JSON.stringify(frame)); }

  snapshot(projects: Project[], agents: Agent[]): void {
    this.send({ t: 'snapshot', machineId: this.machineId, projects, agents, keys: [] });
  }

  /** A qué agentes se le pidió entregar un mensaje. */
  delivered(): string[] {
    return this.received
      .filter((c): c is Extract<Command, { k: 'deliver' }> => c.k === 'deliver')
      .map((c) => c.agentId);
  }

  replies(): Extract<Command, { k: 'reply' }>[] {
    return this.received.filter((c): c is Extract<Command, { k: 'reply' }> => c.k === 'reply');
  }

  close(): void { try { this.ws.close(); } catch { /* ya estaba */ } }
}

interface Fleet {
  hub: Hub;
  a: TestCollector;   // m1 · proyecto p1 · K9 + T2 + T3
  b: TestCollector;   // m2 · proyecto p2 · T1 (+ los extra que pida la prueba)
}

/**
 * Dos máquinas con un proyecto cada una. La gracia de tener dos es que un
 * mensaje de K9 (m1) a T1 (m2) sólo puede llegar si el hub hace su trabajo:
 * ninguno de los dos collectors ve al otro.
 */
async function withFleet(
  extraOnB: Agent[],
  fn: (f: Fleet) => Promise<TestResult>,
): Promise<TestResult> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-traffic-'));
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    store: new HubStore({ dir }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
  });
  const a = new TestCollector(hub.port, 'm1');
  const b = new TestCollector(hub.port, 'm2');
  try {
    await a.open();
    await b.open();
    a.snapshot([project('p1', 'm1')], [
      agent('k9', { machineId: 'm1', projectId: 'p1', callsign: 'K9' }),
      agent('t2', { machineId: 'm1', projectId: 'p1', callsign: 'T2' }),
      agent('t3', { machineId: 'm1', projectId: 'p1', callsign: 'T3' }),
    ]);
    b.snapshot([project('p2', 'm2')], [
      agent('t1', { machineId: 'm2', projectId: 'p2', callsign: 'T1' }),
      ...extraOnB,
    ]);
    await until(() => Object.keys(hub.world.state.agents).length === 4 + extraOnB.length, 5_000);
    return await fn({ hub, a, b });
  } finally {
    a.close();
    b.close();
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Un mensaje tal y como lo subiría el collector de K9. */
function fromK9(id: string, patch: Partial<AgentMessage> = {}): AgentMessage {
  return message(id, { fromAgentId: 'k9', fromCallsign: 'K9', fromProjectId: 'p1', ...patch });
}

/* ── pruebas ──────────────────────────────────────────────────────── */

const tests = [

  /* ── ruteo ──────────────────────────────────────────────────────── */

  test('scope agent: el mensaje cruza de máquina y sólo lo recibe el destinatario', () =>
    withFleet([], async ({ hub, a, b }) => {
      a.send({
        t: 'message', machineId: 'm1',
        message: fromK9('m_ask', { kind: 'ask', scope: 'agent', toAgentId: 't1' }),
      });
      const landed = await until(() => b.delivered().includes('t1'), 5_000);
      return ok('scope agent cruza de máquina',
        landed && a.delivered().length === 0 && hub.world.state.messages['m_ask'] !== undefined,
        `m1 entregó ${a.delivered().length}, m2 entregó a [${b.delivered().join(', ')}]`);
    })),

  test('scope project: llega a los del proyecto y a nadie más', () =>
    withFleet([], async ({ a, b }) => {
      a.send({
        t: 'message', machineId: 'm1',
        message: fromK9('m_proj', { scope: 'project', toAgentId: null, toProjectId: 'p1' }),
      });
      await until(() => a.delivered().length >= 2, 5_000);
      const got = [...a.delivered()].sort();
      return eq('scope project llega a los del proyecto',
        { m1: got, m2: b.delivered() },
        { m1: ['t2', 't3'], m2: [] },
        'K9 no se lo manda a sí mismo y m2 no se entera');
    })),

  test('scope fleet: llega a todos los vivos de las dos máquinas', () =>
    withFleet([], async ({ a, b }) => {
      a.send({
        t: 'message', machineId: 'm1',
        message: fromK9('m_fleet', { scope: 'fleet', toAgentId: null }),
      });
      await until(() => a.delivered().length + b.delivered().length >= 3, 5_000);
      const got = [...a.delivered(), ...b.delivered()].sort();
      return eq('scope fleet llega a toda la flota', got, ['t1', 't2', 't3']);
    })),

  test('un mensaje nunca vuelve a quien lo mandó', () =>
    withFleet([], async ({ a, b }) => {
      a.send({
        t: 'message', machineId: 'm1',
        message: fromK9('m_self', { scope: 'fleet', toAgentId: null }),
      });
      await until(() => a.delivered().length >= 2, 5_000);
      const everyone = [...a.delivered(), ...b.delivered()];
      return ok('un mensaje nunca vuelve a quien lo mandó',
        !everyone.includes('k9'),
        `entregado a [${everyone.sort().join(', ')}]`);
    })),

  test('el techo de difusión corta la tormenta y deja fuera a los bloqueados', () => {
    // Cuarenta agentes más en m2, y uno de ellos bloqueado esperando a una
    // persona: el correo no lo desbloquea, así que es el primero que sobra.
    const crowd = Array.from({ length: 40 }, (_, i) => agent(`x${i}`, {
      machineId: 'm2', projectId: 'p2', callsign: `X${i}`,
      updatedAt: NOW - i,
    }));
    crowd[0] = agent('bloqueado', {
      machineId: 'm2', projectId: 'p2', callsign: 'BL', state: 'blocked',
      block: { kind: 'question', summary: 'necesito a una persona', since: NOW },
    });
    return withFleet(crowd, async ({ a, b }) => {
      a.send({
        t: 'message', machineId: 'm1',
        message: fromK9('m_storm', { scope: 'fleet', toAgentId: null }),
      });
      // Da tiempo a que entregue todo lo que fuera a entregar.
      await until(() => a.delivered().length + b.delivered().length >= MAX_BROADCAST, 5_000);
      await sleep(200);
      const everyone = [...a.delivered(), ...b.delivered()];
      return ok('el techo de difusión corta la tormenta',
        everyone.length <= MAX_BROADCAST && !everyone.includes('bloqueado'),
        `42 candidatos → ${everyone.length} entregas (techo ${MAX_BROADCAST}), sin el bloqueado`);
    });
  }),

  test('un reply de la consola desbloquea al que preguntó y baja a su máquina', () =>
    withFleet([], async ({ hub, a, b }) => {
      // K9 pregunta a T1 y se queda esperando.
      a.send({
        t: 'message', machineId: 'm1',
        message: fromK9('m_wait', { kind: 'ask', scope: 'agent', toAgentId: 't1' }),
      });
      await until(() => b.delivered().includes('t1'), 5_000);
      a.send({
        t: 'agent', machineId: 'm1', id: 'k9',
        patch: {
          state: 'blocked',
          block: { kind: 'peer', summary: 'espero a T1', messageId: 'm_wait', waitingOn: 't1', since: Date.now() },
        },
      });
      await until(() => hub.world.state.agents['k9']?.state === 'blocked', 3_000);

      hub.replyToMessageLocal('m_wait', 'usa el esquema viejo, ya está migrado', 'ceo');
      await until(() => a.replies().length > 0, 5_000);

      const k9 = hub.world.state.agents['k9'];
      const msg = hub.world.state.messages['m_wait'];
      return ok('un reply desbloquea al que preguntó',
        k9?.state === 'working' && k9.block === null && msg?.answeredBy === 'ceo'
        && a.replies()[0]?.messageId === 'm_wait',
        `K9 quedó ${k9?.state}, respondido por ${msg?.answeredBy}, reply bajó a m1`);
    })),

  test('un relay del CEO llega al collector del destinatario', () =>
    withFleet([], async ({ hub, a, b }) => {
      // El CEO no es un agente y no tiene collector: si esto llega, es porque
      // el hub lo metió en el tráfico y lo enrutó como cualquier otro mensaje.
      const out = hub.relayMessage({
        kind: 'warning', scope: 'agent', toAgentId: 't1',
        subject: 'no toques el esquema, K9 lo está migrando',
      });
      await until(() => b.delivered().includes('t1'), 5_000);
      const stored = hub.world.state.messages[out.message.id];
      return ok('un relay del CEO llega a su destinatario',
        out.delivered.includes('t1') && a.delivered().length === 0
        && stored?.fromCallsign === 'CEO' && stored.kind === 'warning',
        `entregado a [${out.delivered.join(', ')}] como ${stored?.fromCallsign}`);
    })),

  test('una consola que manda basura no rompe el hub ni el tráfico', () =>
    withFleet([], async ({ hub, a, b }) => {
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}${PATHS.console}?token=${TOKEN}`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      // Todo lo que se le ocurriría mandar a un cliente roto o malintencionado.
      ws.send('{esto no es json');
      ws.send(JSON.stringify({ t: 'cmd', id: 7, cmd: { k: 'reply' } }));
      ws.send(JSON.stringify({ t: 'cmd', id: 'x', cmd: { k: 'reply', messageId: 'no-existe', answer: 'hola', fromAgentId: null } }));
      ws.send(JSON.stringify({ t: 'collision:ack', id: { __proto__: 'x' } }));
      ws.send(JSON.stringify({ t: 'collision:ack' }));
      ws.send(JSON.stringify({ t: 'frame-que-no-existe' }));
      ws.send(JSON.stringify(null));
      await sleep(300);

      // Y después de todo eso el canal sigue funcionando.
      a.send({
        t: 'message', machineId: 'm1',
        message: fromK9('m_after', { kind: 'notice', scope: 'agent', toAgentId: 't1' }),
      });
      const alive = await until(() => b.delivered().includes('t1'), 5_000);
      ws.close();
      return ok('la basura de una consola no rompe nada',
        alive && hub.counts().consoles >= 0,
        'el hub sigue enrutando después de siete frames inválidos');
    })),

  test('un mensaje que no llega a nadie se dice en voz alta', () =>
    withFleet([], async ({ hub, a, b }) => {
      // El fallo silencioso de este canal: K9 cree que preguntó, y nadie tiene
      // la pregunta. Si no sale en el feed, no sale en ninguna parte.
      a.send({
        t: 'message', machineId: 'm1',
        message: fromK9('m_perdido', { kind: 'ask', scope: 'agent', toAgentId: 'no-existe' }),
      });
      const shouted = await until(
        () => hub.world.state.feed.some((f) => f.text.includes('sin entregar')), 5_000);
      const line = hub.world.state.feed.find((f) => f.text.includes('sin entregar'));
      return ok('un mensaje sin entregar se anota en el feed',
        shouted && line?.level === 'alert' && b.delivered().length === 0,
        `"${line?.text ?? ''}"`);
    })),

  test('un collector no puede mandar un mensaje en nombre de un agente ajeno', () =>
    withFleet([], async ({ hub, a, b }) => {
      // m1 dice ser T1, que vive en m2. Es el frame que forjaría un collector
      // comprometido para hablar por la máquina de al lado.
      const before = hub.world.stats.framesRejected;
      a.send({
        t: 'message', machineId: 'm1',
        message: message('m_forjado', {
          fromAgentId: 't1', fromCallsign: 'T1', fromProjectId: 'p2',
          scope: 'agent', toAgentId: 'k9',
        }),
      });
      await until(() => hub.world.stats.framesRejected > before, 3_000);
      return ok('un collector no habla por agentes de otra máquina',
        hub.world.state.messages['m_forjado'] === undefined && a.delivered().length === 0
        && b.delivered().length === 0,
        'el frame se rechaza y no se entrega a nadie');
    })),

  /* ── saneo ──────────────────────────────────────────────────────── */

  test('un mensaje con un secreto dentro entra tachado y recortado', () => {
    const m = sanitizeMessage({
      id: 'm_secreto', kind: 'ask', scope: 'agent',
      fromAgentId: 'k9', fromCallsign: 'K9', fromProjectId: 'p1', toAgentId: 't1',
      subject: 'S'.repeat(900),
      body: 'despliega con sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA y avísame',
      files: Array.from({ length: 60 }, (_, i) => `/p1/f${i}.ts`),
      readBy: ['__proto__', 't2'],
      at: NOW,
    }, 'm1');
    if (!m) return ok('un mensaje con un secreto entra tachado', false, 'se rechazó entero');
    return ok('un mensaje con un secreto entra tachado y recortado',
      !looksLikeSecret(m.body ?? '') && (m.body ?? '').includes('[REDACTED]')
      && m.subject.length === 300 && m.files.length === 20
      && m.readBy.length === 1 && m.readBy[0] === 't2',
      `body="${(m.body ?? '').slice(0, 44)}…", subject ${m.subject.length}, ${m.files.length} archivos`);
  }),

  test('un mensaje sin emisor, sin destinatario o con id peligroso se rechaza', () => {
    const base = {
      kind: 'ask', scope: 'agent', fromAgentId: 'k9', toAgentId: 't1', subject: 'hola',
    };
    const cases: [string, unknown][] = [
      ['sin id', { ...base }],
      ['id peligroso', { ...base, id: '__proto__' }],
      ['sin emisor', { ...base, id: 'm1', fromAgentId: null }],
      ['dirigido a nadie', { ...base, id: 'm1', toAgentId: null }],
      ['sin asunto', { ...base, id: 'm1', subject: '   ' }],
      ['no es un objeto', 'buenas tardes'],
    ];
    const bad = cases.filter(([, raw]) => sanitizeMessage(raw, 'm1') !== null).map(([why]) => why);
    return eq('los mensajes imposibles se rechazan', bad, [], 'ninguno debería colarse');
  }),

  /* ── retención ──────────────────────────────────────────────────── */

  test('un ask sin responder no se desaloja: hay alguien parado detrás', () => {
    const old = message('m_esperando', {
      kind: 'ask', at: NOW - MESSAGE_RETENTION_MS * 10, readBy: ['t1'],
    });
    const noise = Array.from({ length: MAX_MESSAGES + 80 }, (_, i) =>
      message(`n${i}`, { kind: 'notice', at: NOW - i * 1000, readBy: ['t1'] }));
    const w = seed([agent('k9'), agent('t1')], [old, ...noise]);
    w.sweep(NOW);
    const left = Object.keys(w.state.messages).length;
    return ok('un ask sin responder nunca se desaloja',
      w.state.messages['m_esperando'] !== undefined && left <= MAX_MESSAGES + 1,
      `lleva 10 horas esperando y sigue ahí; ${noise.length + 1} → ${left} (techo ${MAX_MESSAGES})`);
  }),

  test('un notice leído y viejo se va; uno reciente se queda', () => {
    const w = seed([agent('k9'), agent('t1')], [
      message('m_reciente', { kind: 'notice', at: NOW - 60_000, readBy: ['t1'] }),
      message('m_rancio', { kind: 'notice', at: NOW - MESSAGE_RETENTION_MS - 60_000, readBy: ['t1'] }),
      message('m_contestado', {
        kind: 'ask', at: NOW - MESSAGE_RETENTION_MS * 3,
        answer: 'ya está', answeredAt: NOW - MESSAGE_RETENTION_MS - 1000, answeredBy: 't1',
      }),
    ]);
    w.sweep(NOW);
    return ok('el tráfico gastado se va y el reciente se queda',
      w.state.messages['m_reciente'] !== undefined
      && w.state.messages['m_rancio'] === undefined
      && w.state.messages['m_contestado'] === undefined,
      'un ask ya contestado envejece como cualquier otro mensaje');
  }),

  test('desalojar un agente se lleva su correo y deshace su colisión', () => {
    const dead = agent('viejo', {
      state: 'done', updatedAt: NOW - 60 * 60_000 - 5000,
    });
    const w = seed([dead, agent('k9')], [
      // Una pregunta suya sin responder: no bloquea a nadie, porque el que
      // preguntaba se va con ella.
      message('m_suyo', { kind: 'ask', fromAgentId: 'viejo', toAgentId: 'k9' }),
      message('m_para_el', { kind: 'notice', fromAgentId: 'k9', toAgentId: 'viejo' }),
      message('m_ajeno', { kind: 'notice', fromAgentId: 'k9', toAgentId: 't1', readBy: ['viejo', 't1'] }),
    ], [
      collision('c1', ['viejo', 'k9']),
      collision('c2', ['k9', 't1', 'viejo']),
    ]);
    w.sweep(NOW);
    const ajeno = w.state.messages['m_ajeno'];
    return ok('desalojar un agente se lleva su correo',
      w.state.agents['viejo'] === undefined
      && w.state.messages['m_suyo'] === undefined
      && w.state.messages['m_para_el'] === undefined
      && ajeno !== undefined && !ajeno.readBy.includes('viejo')
      && w.state.collisions['c1'] === undefined
      && w.state.collisions['c2']?.agentIds.join(',') === 'k9,t1',
      'los suyos se borran, en los ajenos sólo desaparece él, y la colisión de dos se deshace');
  }),

  test('responder un mensaje desbloquea al que preguntaba', () => {
    const asker = agent('k9', {
      state: 'blocked',
      block: { kind: 'peer', summary: 'espero a T1', messageId: 'm_q', waitingOn: 't1', since: NOW },
    });
    const w = seed([asker, agent('t1')], [message('m_q', { kind: 'ask' })]);
    w.answerMessage('m_q', 'sí, bórralo', 't1');
    const after = w.state.agents['k9'];
    return ok('responder desbloquea al que preguntaba',
      after?.state === 'working' && after.block === null
      && w.state.messages['m_q']?.answeredBy === 't1',
      'el mensaje contestado y el agente en marcha son la misma mutación');
  }),

  test('una colisión reconocida no vuelve a gritar por un frame nuevo', () => {
    const w = seed([agent('k9'), agent('t1')]);
    w.upsertCollision('m1', collision('c1', ['k9', 't1']));
    w.ackCollision('c1');
    w.upsertCollision('m1', collision('c1', ['k9', 't1'], { lastSeen: NOW + 5_000 }));
    return ok('reconocer una colisión es una decisión, no un estado del collector',
      w.state.collisions['c1']?.acknowledged === true,
      'el collector la reabriría cada dos segundos');
  }),
];

const suite: TestModule = { suite: 'hub · tráfico entre agentes', tests };
export default suite;
