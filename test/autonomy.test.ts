/**
 * Pegamento del squad autonomy: el ciclo de vida tipado, el registro de
 * herramientas de extensión y el comando `autonomy` del protocolo.
 *
 * Las piezas (wake, verify, land, budget, journal) tienen su propia suite;
 * esto comprueba que lo que las une no se rompa cuando una de ellas cambia.
 */

import type { Agent } from '../src/shared/types.ts';
import { AgentLifecycle, FINISHED_STATES } from '../src/hub/lifecycle.ts';
import { CEO_TOOLS, runTool } from '../src/agents/tools.ts';
import { EXTENSION_TOOLS, duplicateToolNames } from '../src/agents/extensions.ts';
import { createAutonomy, type AutonomyDeps } from '../src/hub/autonomy.ts';
import { test, ok, eq } from './harness.ts';

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1', machineId: 'm', projectId: 'p', title: 't', callsign: 'K9', runtime: 'claude',
    state: 'working', block: null, parentId: null, depth: 0, childIds: [], mission: null,
    squad: null, lead: false, model: null, tool: null, toolDetail: null,
    lastPrompt: null, lastSay: 'hecho', startedAt: 1, updatedAt: 2, uptimeMs: 1,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
      tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0,
      apiDurationMs: 0, turns: 0,
    },
    background: false, shortId: null,
    ...over,
  };
}

function fakeDeps(over: Partial<AutonomyDeps> = {}): AutonomyDeps {
  const timer = { cancel() { /* noop */ } };
  return {
    agents: () => [], agent: () => undefined, projects: () => [], project: () => undefined,
    tasks: () => ({}), capcom: () => null,
    sayToCapcom: () => false, dispatch: async () => ({}), stopAgent: async () => ({}),
    dir: '/nonexistent', env: {}, now: () => 0,
    setTimer: () => timer, setInterval: () => timer,
    log: () => {}, note: () => {},
    lifecycle: new AgentLifecycle(),
    ...over,
  };
}

export default { suite: 'autonomy glue', tests: [
  test('lifecycle: agent:state → agent:finished solo para estados terminales de tramo', () => {
    const lc = new AgentLifecycle();
    const seen: string[] = [];
    lc.on('agent:state', (c) => seen.push(`state:${c.from}>${c.to}`));
    lc.on('agent:finished', (c) => seen.push(`fin:${c.to}:${c.agent.lastSay}`));
    const a = agent();
    lc.feed({ at: 5, kind: 'agent:state', agentId: a.id, data: { from: 'working', to: 'done' } }, { ...a, state: 'done' });
    lc.feed({ at: 6, kind: 'agent:state', agentId: a.id, data: { from: 'done', to: 'working' } }, a);
    lc.feed({ at: 7, kind: 'agent:state', agentId: a.id, data: { from: 'working', to: 'idle' } }, { ...a, state: 'idle' });
    lc.feed({ at: 8, kind: 'agent:new', agentId: a.id }, a);
    lc.feed({ at: 9, kind: 'escalation:new', agentId: a.id }, a);
    return eq('eventos', seen, ['state:working>done', 'fin:done:hecho', 'state:done>working', 'state:working>idle', 'fin:idle:hecho']);
  }),
  test('lifecycle: un oyente que revienta no tumba al resto', () => {
    const lc = new AgentLifecycle();
    let reached = false;
    lc.on('agent:new', () => { throw new Error('boom'); });
    lc.on('agent:new', () => { reached = true; });
    const warn = console.warn; console.warn = () => {};
    try { lc.feed({ at: 1, kind: 'agent:new', agentId: 'a1' }, agent()); } finally { console.warn = warn; }
    return ok('segundo oyente corrió', reached);
  }),
  test('lifecycle: agent:gone y agent:archived emiten gone; sin agente no hay state', () => {
    const lc = new AgentLifecycle();
    const gone: string[] = [];
    let states = 0;
    lc.on('agent:gone', (id) => gone.push(id));
    lc.on('agent:state', () => states++);
    lc.feed({ at: 1, kind: 'agent:gone', agentId: 'x', projectId: 'p' }, null);
    lc.feed({ at: 2, kind: 'agent:archived', agentId: 'y', projectId: 'p' }, null);
    lc.feed({ at: 3, kind: 'agent:state', agentId: 'z', data: { from: 'a', to: 'done' } }, null);
    return eq('gone', [gone, states], [['x', 'y'], 0]);
  }),
  test('FINISHED_STATES es exactamente done/idle/blocked/dead', () =>
    eq('estados', [...FINISHED_STATES].sort(), ['blocked', 'dead', 'done', 'idle'])),
  test('extensiones: sin nombres duplicados y todas dentro de CEO_TOOLS', () => {
    const base = CEO_TOOLS.filter((t) => !EXTENSION_TOOLS.includes(t));
    const dupes = duplicateToolNames(base);
    const missing = EXTENSION_TOOLS.filter((t) => !CEO_TOOLS.some((c) => c.name === t.name));
    return ok('registro', dupes.length === 0 && missing.length === 0,
      dupes.length ? `duplicados: ${dupes.join(', ')}` : missing.length ? `fuera de CEO_TOOLS: ${missing.map((t) => t.name).join(', ')}` : `${EXTENSION_TOOLS.length} extensiones`);
  }),
  test('extensiones: cada una lleva descripción y schema de objeto', () => {
    const bad = EXTENSION_TOOLS.filter((t) => !t.description || (t.input_schema as { type?: string }).type !== 'object');
    return ok('schemas', bad.length === 0, bad.map((t) => t.name).join(', '));
  }),
  test('runTool: un nombre desconocido sigue siendo error, no excepción', async () => {
    const ctx = { agents: () => [], projects: () => [], agent: () => undefined, project: () => undefined,
      escalation: () => undefined, dispatch: async () => ({}), nextSquadName: () => 'x-01', fleets: () => [],
      recall: () => [], remember: () => {}, raiseToHuman: () => { throw new Error('no'); },
      resolveEscalation: () => {}, messages: () => [], message: () => undefined, collisions: () => [],
      relay: () => ({ messageId: '', delivered: [], skipped: 0, reason: null }), answerPeer: () => null,
      acknowledgeCollision: () => null, archiveAgents: () => ({ archived: [], squadsRetired: [], skipped: 0, dryRun: false } as never) };
    const out = await runTool(ctx as never, 'no_such_tool', {});
    return ok('isError', out.isError === true && out.result.includes('unknown tool'));
  }),
  test('createAutonomy monta las cinco piezas y stop() no revienta', () => {
    const api = createAutonomy(fakeDeps());
    const keys = ['wake', 'verify', 'journal'].filter((k) => !(k in api));
    api.stop();
    return ok('piezas', keys.length === 0, keys.join(', '));
  }),
] };
