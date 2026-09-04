/**
 * Retención: los límites que impiden que el hub se coma su propia memoria.
 *
 * El diseño original decía "marca muerto pero no borres: el humano necesita
 * ver qué murió". Es cierto durante minutos y falso para siempre. Un soak test
 * con una flota activa llevó al hub de 50 a 1.289 agentes en dos minutos y
 * terminó en `FATAL ERROR: Reached heap limit`. La consola del navegador seguía
 * el mismo camino: 1.541 nodos del DOM a 169.705 en tres minutos.
 *
 * Estas pruebas fijan las cuatro reglas que salieron de ahí. Cada una protege
 * algo que ya falló de verdad.
 */

import {
  World, AGENT_RETENTION_MS, MAX_TERMINAL_AGENTS,
  MAX_AGENTS_PER_MACHINE, MAX_OPEN_ESCALATIONS,
} from '../src/hub/world.ts';
import type { Agent, Escalation } from '../src/shared/types.ts';
import { emptyRollup } from '../src/shared/types.ts';
import { ok, eq, test, type TestModule } from './harness.ts';

const NOW = 1_800_000_000_000;

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

function escalation(id: string, patch: Partial<Escalation> = {}): Escalation {
  return {
    id, agentId: 'a1', projectId: 'p1', machineId: 'm1',
    question: `pregunta ${id}`, context: null, options: [], optionsOnly: false,
    urgency: 'normal', status: 'pending', ceoAttempt: null,
    answer: null, answeredBy: null, rememberAs: null,
    askedAt: NOW, answeredAt: null, expiresAt: null,
    ...patch,
  };
}

/** Un mundo poblado directamente, sin pasar por el socket. */
function seed(agents: Agent[], escalations: Escalation[] = []): World {
  const w = new World({ now: () => NOW });
  w.upsertMachine({
    id: 'm1', hostname: 'test', platform: 'darwin', version: '0',
    online: true, lastSeen: NOW, connectedAt: NOW,
    load: { sessions: agents.length, activeSessions: 0, cpuPct: null, memPct: null },
  });
  w.state.projects['p1'] = {
    id: 'p1', machineId: 'm1', slug: '-p', name: 'p', path: '/p', code: 'PP',
    gitBranch: null, gitDirty: false, keyNames: [],
    sessionIds: agents.map((a) => a.id), rollup: emptyRollup(),
  };
  for (const a of agents) w.state.agents[a.id] = a;
  for (const e of escalations) w.state.escalations[e.id] = e;
  return w;
}

const tests = [
  test('un agente vivo nunca se desaloja, por viejo que sea', () => {
    const old = agent('viejo', { state: 'working', updatedAt: NOW - AGENT_RETENTION_MS * 10 });
    const w = seed([old]);
    w.sweep(NOW);
    return ok('un agente vivo nunca se desaloja',
      w.state.agents['viejo'] !== undefined, 'lleva 10 horas trabajando y sigue ahí');
  }),

  test('un agente terminado y viejo se desaloja', () => {
    const w = seed([
      agent('reciente', { state: 'done', updatedAt: NOW - 1000 }),
      agent('rancio', { state: 'done', updatedAt: NOW - AGENT_RETENTION_MS - 1000 }),
    ]);
    w.sweep(NOW);
    return ok('un agente terminado y viejo se desaloja',
      w.state.agents['reciente'] !== undefined && w.state.agents['rancio'] === undefined,
      'se conserva la última hora de muertos');
  }),

  test('el tope duro de terminales corta aunque nada haya caducado', () => {
    const many = Array.from({ length: MAX_TERMINAL_AGENTS + 60 }, (_, i) =>
      agent(`d${i}`, { state: 'dead', updatedAt: NOW - i }));
    const w = seed(many);
    w.sweep(NOW);
    const left = Object.values(w.state.agents).filter((a) => a.state === 'dead').length;
    return ok('el tope duro de terminales corta',
      left <= MAX_TERMINAL_AGENTS,
      `${many.length} → ${left} (tope ${MAX_TERMINAL_AGENTS})`);
  }),

  test('un padre muerto con un hijo vivo se queda, para no romper el linaje', () => {
    const parent = agent('padre', {
      state: 'done', updatedAt: NOW - AGENT_RETENTION_MS - 5000, childIds: ['hijo'],
    });
    const child = agent('hijo', { state: 'working', parentId: 'padre', depth: 1 });
    const w = seed([parent, child]);
    w.sweep(NOW);
    return ok('un padre muerto con un hijo vivo se queda',
      w.state.agents['padre'] !== undefined,
      'un subagente huérfano no tendría a quién volver');
  }),

  test('desalojar a un hijo lo desengancha del childIds del padre', () => {
    const parent = agent('padre', { state: 'working', childIds: ['hijo'] });
    const child = agent('hijo', {
      state: 'done', parentId: 'padre', depth: 1,
      updatedAt: NOW - AGENT_RETENTION_MS - 5000,
    });
    const w = seed([parent, child]);
    w.sweep(NOW);
    return eq('desalojar a un hijo lo desengancha del padre',
      w.state.agents['padre']?.childIds ?? ['?'], []);
  }),

  test('el techo por máquina protege al hub de un collector desbocado', () => {
    const flood = Array.from({ length: MAX_AGENTS_PER_MACHINE + 250 }, (_, i) =>
      agent(`x${i}`, { state: 'working', updatedAt: NOW - i }));
    const w = seed(flood);
    w.sweep(NOW);
    const left = Object.keys(w.state.agents).length;
    return ok('el techo por máquina protege al hub',
      left <= MAX_AGENTS_PER_MACHINE,
      `${flood.length} → ${left} (tope ${MAX_AGENTS_PER_MACHINE})`);
  }),

  test('el techo por máquina nunca tira un agente bloqueado', () => {
    const flood = Array.from({ length: MAX_AGENTS_PER_MACHINE + 100 }, (_, i) =>
      agent(`x${i}`, { state: 'working', updatedAt: NOW - 1000 - i }));
    // El bloqueado es el MÁS viejo: sin la excepción sería el primero en caer.
    const blocked = agent('necesita-humano', {
      state: 'blocked', updatedAt: NOW - 999_999,
      block: { kind: 'question', summary: 'una persona, por favor', since: NOW - 999_999 },
    });
    const w = seed([blocked, ...flood]);
    w.sweep(NOW);
    return ok('el techo nunca tira un agente bloqueado',
      w.state.agents['necesita-humano'] !== undefined,
      'es el más viejo de todos y sobrevive');
  }),

  test('la cola abierta se acota caducando las más viejas no bloqueantes', () => {
    const open = Array.from({ length: MAX_OPEN_ESCALATIONS + 80 }, (_, i) =>
      escalation(`e${i}`, { askedAt: NOW - i * 1000 }));
    const w = seed([], open);
    w.sweep(NOW);
    const still = Object.values(w.state.escalations)
      .filter((e) => e.status === 'pending' || e.status === 'with_ceo').length;
    return ok('la cola abierta se acota',
      still <= MAX_OPEN_ESCALATIONS,
      `${open.length} → ${still} abiertas (tope ${MAX_OPEN_ESCALATIONS})`);
  }),

  test('una pregunta bloqueante nunca caduca por desbordamiento', () => {
    const open = Array.from({ length: MAX_OPEN_ESCALATIONS + 50 }, (_, i) =>
      escalation(`e${i}`, { askedAt: NOW - i * 1000 }));
    // La bloqueante es la más vieja de la cola.
    const blocking = escalation('parada', {
      urgency: 'blocking', askedAt: NOW - 9_999_999,
    });
    const w = seed([], [blocking, ...open]);
    w.sweep(NOW);
    return eq('una pregunta bloqueante nunca caduca por desbordamiento',
      w.state.escalations['parada']?.status, 'pending');
  }),

  test('las respondidas viejas se tiran; las recientes se quedan', () => {
    const w = seed([], [
      escalation('nueva', { status: 'answered', answeredAt: NOW - 1000 }),
      escalation('vieja', { status: 'answered', answeredAt: NOW - 60 * 60_000 - 5000 }),
    ]);
    w.sweep(NOW);
    return ok('las respondidas viejas se tiran',
      w.state.escalations['nueva'] !== undefined && w.state.escalations['vieja'] === undefined,
      'la historia vive en el log de ~/.orca/hub, no en el frame');
  }),
];

const suite: TestModule = { suite: 'hub · retención y techos', tests };
export default suite;
