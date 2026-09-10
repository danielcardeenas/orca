/**
 * The tools that let CAPCOM command without memory.
 *
 * `list_missions`, `inspect_mission` and `briefing` exist so that a session that has
 * just booted — or just compacted — can read what it owes off the hub instead
 * of off its own context. What is tested is the one rule they all share: in a
 * mission, everything after the last CAPCOM message is unanswered. And that the
 * briefing is short, capped, and names things by the id the next tool takes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, Escalation, Project } from '../src/shared/types.ts';
import { MissionStore } from '../src/hub/missions.ts';
import { MISSION_ID, visibleMissions } from '../src/shared/missions.ts';
import { CEO_TOOLS, runTool, type CeoContext } from '../src/agents/tools.ts';
import { mcpTools } from '../src/hub/mcp.ts';
import { ok, test, type TestModule } from './harness.ts';

const NOW = Date.now();
const H = 3600_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: over.id ?? 'a1', machineId: 'm1', projectId: 'p1',
    title: 'test', callsign: 'K1', runtime: 'claude', state: 'working', block: null,
    parentId: null, depth: 0, childIds: [], mission: null,
    squad: null, lead: false,
    model: null, tool: null, toolDetail: null,
    lastPrompt: null, lastSay: null, startedAt: NOW - H, updatedAt: NOW, uptimeMs: 0,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
      tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0,
      toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    background: false, shortId: null,
    ...over,
  };
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1', machineId: 'm1', slug: '-tmp-ax', name: 'axolots', path: '/tmp/ax', code: 'AX',
    gitBranch: 'main', gitDirty: false, keyNames: [], sessionIds: [],
    rollup: {
      total: 2, blocked: 1, costUSD: 1.5, tokensPerSec: 0,
      byState: { booting: 0, thinking: 0, working: 1, blocked: 1, idle: 0, done: 0, dead: 0 },
    },
    ...over,
  };
}

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    id: 'esc_1', agentId: 'a1', projectId: 'p1', machineId: 'm1',
    question: 'Which Stripe key on staging?',
    context: null, options: ['test', 'production'], optionsOnly: false,
    urgency: 'blocking', status: 'pending', ceoAttempt: null,
    answer: null, answeredBy: null, rememberAs: null,
    askedAt: NOW - 4 * 60_000, answeredAt: null, expiresAt: null,
    ...over,
  };
}

/** A world in a box: only what these three tools read. Everything else refuses. */
function ctx(o: {
  agents?: Agent[]; projects?: Project[]; escalations?: Escalation[]; missions?: MissionStore;
  rules?: { question: string; answer: string; projectId: string | null; at: number }[];
}): CeoContext {
  const agents = o.agents ?? [];
  const projects = o.projects ?? [];
  const refuse = (): never => { throw new Error('not in this test'); };
  return {
    missions: o.missions,
    agents: () => agents,
    projects: () => projects,
    agent: (id) => agents.find((a) => a.id === id),
    project: (id) => projects.find((p) => p.id === id),
    escalation: (id) => (o.escalations ?? []).find((e) => e.id === id),
    escalations: () => o.escalations ?? [],
    rules: (limit) => (o.rules ?? []).slice(0, limit),
    dispatch: refuse, nextSquadName: refuse, fleets: () => [],
    recall: () => [], remember: refuse, raiseToHuman: refuse, resolveEscalation: refuse,
    messages: () => [], message: () => undefined, collisions: () => [],
    relay: refuse, answerPeer: refuse, acknowledgeCollision: refuse, archiveAgents: refuse,
  };
}

/**
 * Un store de misiones en un directorio que se borra al terminar.
 *
 * Espera a la promesa antes de borrar: un `fn` async con un `await` en medio
 * seguía escribiendo cuando el `finally` ya se había llevado el directorio, y
 * la escritura siguiente moría con ENOENT dentro del propio test.
 */
async function withStore<T>(fn: (store: MissionStore) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-briefing-'));
  try { return await fn(new MissionStore(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function parse<T>(out: { result: string }): T { return JSON.parse(out.result) as T; }

const tests = [
  test('model changes remain available on repeated briefings', async () => {
    const c = ctx({ agents: [agent({ role: 'capcom', modelControl: {
      sessionId: 'same-session', runtime: 'codex', active: 'new', choices: [], phase: 'ready', requested: null, detail: '',
      events: [{ id: 'change', at: NOW, from: 'old', to: 'new', text: 'Model changed: old → new · Same conversation.' }],
    } })] });
    const first = await runTool(c, 'briefing', {});
    const second = await runTool(c, 'briefing', {});
    return ok('model change knowledge is not consumed by reading', [first, second].every(r => r.result.includes('CAPCOM MODEL CHANGES') && r.result.includes('Same conversation')));
  }),
  test('the mission tools are advertised over MCP with strict, complete schemas', () => {
    const names = mcpTools().map((t) => t.name);
    const wanted = ['open_mission', 'list_missions', 'inspect_mission', 'briefing'];
    const specs = CEO_TOOLS.filter((t) => wanted.includes(t.name));
    const complete = specs.every((t) => {
      const schema = t.input_schema as { properties: Record<string, unknown>; required: string[] };
      return t.strict === true && Object.keys(schema.properties).every((k) => schema.required.includes(k));
    });
    // Los nombres viejos siguen despachando mientras haya un CAPCOM en vuelo
    // con el esquema anterior en su contexto, pero no se anuncian: quien llega
    // nuevo sólo ve el vocabulario de hoy.
    const legacyHidden = !names.some((n) => ['report_task', 'list_tasks', 'inspect_task'].includes(n));
    return ok(
      'open_mission, list_missions, inspect_mission and briefing are advertised over MCP',
      wanted.every((n) => names.includes(n)) && specs.length === wanted.length && complete && legacyHidden,
      names.filter((n) => n.includes('mission') || n === 'briefing').join(', '),
    );
  }),

  /*
   * Parte 2: CAPCOM abre sus propias misiones.
   *
   * Lo que se comprueba no es que la herramienta devuelva algo, sino que lo
   * que devuelve sea indistinguible de lo que crea el botón NEW MISSION: el
   * mismo store, un id con el prefijo de hoy, y una fila que el panel puede
   * pintar. Si esto se separa, CAPCOM acaba abriendo hilos de segunda que la
   * consola no sabe enseñar.
   */
  test('open_mission creates a mission the console cannot tell from the operator\'s own', async () => {
    return withStore(async (store) => {
      const c = ctx({
        missions: store,
        agents: [agent({ id: 'a9', callsign: 'K9', state: 'working' })],
        projects: [project()],
      });
      const out = await runTool(c, 'open_mission', {
        title: 'Migrate the payment webhook', first_message: 'El operador quiere el webhook migrado hoy',
        project_id: 'p1', agent_ids: ['a9'],
      });
      const created = parse<{ mission_id: string; title: string; status: string; project: string | null; agents: { callsign: string | null }[] }>(out);
      const stored = store.get(created.mission_id);
      // Un id con el prefijo nuevo, no uno inventado ni uno `task_`.
      const freshId = created.mission_id.startsWith('mission_') && MISSION_ID.test(created.mission_id);
      // La conversación arranca legible y el proyecto va en su primera línea.
      const opening = stored.messages.length === 1 && stored.messages[0]?.role === 'capcom'
        && stored.messages[0].text === '[AX] El operador quiere el webhook migrado hoy';
      // Y el agente ya vivo quedó adoptado, que es el caso "esto que ya lancé".
      const adopted = stored.agentIds.includes('a9') && created.agents[0]?.callsign === 'K9';
      // La misma forma que ve el panel: sale en visibleMissions, activa y sin archivar.
      const onPanel = visibleMissions(store.all()).some((m) => m.id === created.mission_id && m.status === 'active' && !m.archivedAt);

      const noTitle = await runTool(c, 'open_mission', { title: '  ', first_message: null, project_id: null, agent_ids: null });
      const badProject = await runTool(c, 'open_mission', { title: 'x', first_message: null, project_id: 'p_nope', agent_ids: null });
      const badAgent = await runTool(c, 'open_mission', { title: 'x', first_message: null, project_id: null, agent_ids: ['ghost'] });

      // Y lo que devuelve sirve para lo siguiente: report_mission sobre ese id.
      const reported = await runTool(c, 'report_mission', { mission_id: created.mission_id, text: 'K9 lanzado', status: 'active', agent_ids: [] });

      return ok(
        'open_mission opens a real mission, adopts live agents and refuses bad input',
        !out.isError && freshId && created.title === 'Migrate the payment webhook' && created.status === 'active'
        && created.project === 'AX' && opening && adopted && onPanel
        && noTitle.isError === true && badProject.isError === true && badAgent.isError === true
        && !reported.isError && store.get(created.mission_id).messages.length === 2,
        `${created.mission_id} · ${store.get(created.mission_id).messages.length} msg · agents=${stored.agentIds.join(',')}`,
      );
    });
  }),

  test('list_missions says which missions are waiting on CAPCOM, and only_pending keeps those', async () => {
    return withStore(async (store) => {
      // answered: human, then CAPCOM replied.
      store.create('task_answered', 'New task');
      store.message('task_answered', 'human', 'Review the delivery flow');
      store.message('task_answered', 'capcom', 'On it: K1 is reviewing', 'active');
      // owed: CAPCOM replied once, then the human asked again.
      store.create('task_owed', 'New task');
      store.message('task_owed', 'human', 'Migrate payments');
      store.message('task_owed', 'capcom', 'Launched K2', 'active');
      store.assign('task_owed', ['a2']);
      store.message('task_owed', 'human', 'Also add the webhook');
      // results: a worker reported after CAPCOM's last word.
      store.create('task_results', 'New task');
      store.message('task_results', 'human', 'Run the audit');
      store.message('task_results', 'capcom', 'Launched K3', 'active');
      store.assign('task_results', ['a3']);
      store.message('task_results', 'agent', 'Audit finished: 3 findings', undefined, 'a3');
      // closed: nothing owed even with a human line last.
      store.create('task_done', 'New task');
      store.message('task_done', 'human', 'Ship it');
      store.message('task_done', 'capcom', 'Shipped', 'completed');
      store.message('task_done', 'human', 'thanks');

      const c = ctx({
        missions: store,
        agents: [agent({ id: 'a2', callsign: 'K2', state: 'working' }), agent({ id: 'a3', callsign: 'K3', state: 'done' })],
      });
      const all = parse<{ missions: { id: string; awaiting_reply: boolean; unreported_results: number; agents: { callsign: string | null; state: string }[]; pending_human: { text: string } | null }[]; total: number }>(
        await runTool(c, 'list_missions', { status: null, only_pending: false, limit: 20 }));
      const pending = parse<{ missions: { id: string }[]; total: number }>(
        await runTool(c, 'list_missions', { status: null, only_pending: true, limit: 20 }));
      const active = parse<{ total: number }>(await runTool(c, 'list_missions', { status: 'active', only_pending: false, limit: 20 }));
      const by = Object.fromEntries(all.missions.map((t) => [t.id, t]));
      const owed = by['task_owed'];
      const results = by['task_results'];
      return ok(
        'list_missions says which missions are waiting on CAPCOM',
        all.total === 4
        && by['task_answered']?.awaiting_reply === false && by['task_answered']?.unreported_results === 0
        && owed?.awaiting_reply === true && owed.pending_human?.text === 'Also add the webhook'
        && owed.agents[0]?.callsign === 'K2' && owed.agents[0]?.state === 'working'
        && results?.awaiting_reply === false && results.unreported_results === 1
        && by['task_done']?.awaiting_reply === false
        && pending.total === 2 && pending.missions.map((t) => t.id).sort().join(',') === 'task_owed,task_results'
        && active.total === 3,
        `pending: ${pending.missions.map((t) => t.id).join(', ')}`,
      );
    });
  }),

  /*
   * El caso que trajo todo esto: una misión activa cuyo encargo no salió no
   * debe ni un mensaje, así que `awaiting_reply` es false y
   * `unreported_results` es 0 — y antes de esto eso bastaba para que
   * `only_pending`, `inspect_mission` y el briefing la dieran por sana.
   */
  test('una misión activa cuyo envío falló sale en only_pending, con motivo, y deja de decir «owed: nothing»', async () => {
    return withStore(async (store) => {
      store.create('mission_stuck', 'New mission');
      store.message('mission_stuck', 'human', 'Rehaz los iconos de CAPCOM');
      store.message('mission_stuck', 'capcom', 'Mandado a WO', 'active');
      store.assign('mission_stuck', ['aw']);
      store.dispatched('mission_stuck', {
        agentId: 'aw', callsign: 'WO', at: Date.now(), delivered: false,
        detail: 'máquina no conectada: mac-2',
      });
      // Y una sana al lado, para que se vea que no marca todo lo que se mueve.
      store.create('mission_fine', 'New mission');
      store.message('mission_fine', 'human', 'Y esto otro');
      store.message('mission_fine', 'capcom', 'K3 en ello', 'active');
      store.assign('mission_fine', ['ak']);

      const c = ctx({
        missions: store,
        agents: [
          agent({ id: 'aw', callsign: 'WO', state: 'idle', updatedAt: NOW - H }),
          agent({ id: 'ak', callsign: 'K3', state: 'working' }),
        ],
      });
      type Row = { id: string; awaiting_reply: boolean; unreported_results: number; stalled: { reason: string; detail: string } | null };
      const all = parse<{ missions: Row[] }>(await runTool(c, 'list_missions', { status: null, only_pending: false, limit: 20 }));
      const pending = parse<{ missions: { id: string }[]; total: number }>(
        await runTool(c, 'list_missions', { status: null, only_pending: true, limit: 20 }));
      const stuck = all.missions.find((m) => m.id === 'mission_stuck');
      const fine = all.missions.find((m) => m.id === 'mission_fine');
      const deep = parse<{ owed: string; stalled: { reason: string } | null; last_orders: { agent: string; delivery: string }[] }>(
        await runTool(c, 'inspect_mission', { mission_id: 'mission_stuck' }));
      const brief = (await runTool(c, 'briefing', {})).result;
      return ok(
        'sin deber un mensaje y aun así pendiente, con el motivo del hub y el último encargo',
        stuck?.awaiting_reply === false && stuck.unreported_results === 0
        && stuck.stalled?.reason === 'send-failed' && stuck.stalled.detail.includes('mac-2')
        && fine?.stalled === null
        && pending.total === 1 && pending.missions[0]?.id === 'mission_stuck'
        && deep.owed.includes('unstick it (send-failed)') && deep.stalled?.reason === 'send-failed'
        && deep.last_orders[0]?.agent === 'WO' && deep.last_orders[0].delivery === 'failed'
        && brief.includes('MISSIONS ACTIVE WITH NO PROGRESS')
        && brief.includes('mission_stuck') && !brief.includes('mission_fine'),
        `${JSON.stringify(stuck?.stalled)} · ${deep.owed}`,
      );
    });
  }),

  test('inspect_mission returns the conversation, the agents with their last result, and what is owed', async () => {
    return withStore(async (store) => {
      store.create('task_x', 'New task');
      store.message('task_x', 'human', 'Fix the flaky test');
      store.message('task_x', 'capcom', 'K9 is on it', 'active');
      store.assign('task_x', ['a9']);
      store.message('task_x', 'agent', 'Found the race in retention.test.ts', undefined, 'a9');
      store.message('task_x', 'human', 'Is it fixed yet?');
      const c = ctx({
        missions: store,
        agents: [agent({ id: 'a9', callsign: 'K9', state: 'done', lastSay: 'Fixed and green' })],
        projects: [project()],
      });
      const out = await runTool(c, 'inspect_mission', { mission_id: 'task_x' });
      const t = parse<{
        conversation: { role: string; agent: string | null; text: string }[];
        agents: { callsign: string | null; state: string; last_say: string | null; last_result_in_mission: string | null }[];
        pending_human: { text: string }[]; unreported_results: { agent: string | null; text: string }[]; owed: string;
      }>(out);
      const missing = await runTool(c, 'inspect_mission', { mission_id: 'task_nope' });
      return ok(
        'inspect_mission returns the conversation, the agents and what is owed',
        !out.isError && t.conversation.length === 4 && t.conversation[2]?.agent === 'K9'
        && t.agents[0]?.callsign === 'K9' && t.agents[0].state === 'done' && t.agents[0].last_say === 'Fixed and green'
        && t.agents[0].last_result_in_mission === 'Found the race in retention.test.ts'
        && t.pending_human.length === 1 && t.pending_human[0]?.text === 'Is it fixed yet?'
        && t.unreported_results.length === 1 && t.unreported_results[0]?.agent === 'K9'
        && t.owed === 'reply to 1 human message(s); report 1 worker result(s)'
        && missing.isError === true,
        t.owed,
      );
    });
  }),

  test('briefing is one dense screen: blocked, owed, finished-unreported, dead squads, projects, rules', async () => {
    return withStore(async (store) => {
      store.create('task_pay', 'New task');
      store.message('task_pay', 'human', 'Migrate payments to the new API');
      store.message('task_pay', 'capcom', 'Launched K2 and K3', 'active');
      store.assign('task_pay', ['a2', 'a3']);
      store.message('task_pay', 'agent', 'Migration done, tests green', undefined, 'a3');
      store.message('task_pay', 'human', 'How is it going?');
      // a4 finished in a mission CAPCOM already reported on: not unreported.
      store.create('task_old', 'New task');
      store.message('task_old', 'human', 'Lint everything');
      store.assign('task_old', ['a4']);
      store.message('task_old', 'agent', 'Lint clean', undefined, 'a4');
      store.message('task_old', 'capcom', 'Done, lint is clean', 'completed');

      const agents = [
        agent({ id: 'a1', callsign: 'K1', state: 'blocked', block: { kind: 'question', summary: 'Which Stripe key on staging?', since: NOW - 4 * 60_000, escalationId: 'esc_1' } }),
        agent({ id: 'a2', callsign: 'K2', state: 'working', squad: 'pay-01', lead: true }),
        agent({ id: 'a3', callsign: 'K3', state: 'done', squad: 'pay-01', updatedAt: NOW - 20 * 60_000, lastSay: 'Migration done, tests green' }),
        agent({ id: 'a4', callsign: 'K4', state: 'done', updatedAt: NOW - 30 * 60_000, lastSay: 'Lint clean' }),
        agent({ id: 'a5', callsign: 'K5', state: 'dead', updatedAt: NOW - 10 * 60_000, lastSay: 'segfault', squad: 'audit-01' }),
        agent({ id: 'a6', callsign: 'K6', state: 'done', updatedAt: NOW - 2 * 24 * H, squad: 'audit-01' }),
        agent({ id: 'a7', callsign: 'K7', state: 'blocked', block: { kind: 'permission', summary: 'Bash esperando permiso: rm -rf dist', since: NOW - 90_000 } }),
        agent({ id: 'cap', callsign: 'CC', role: 'capcom', projectId: 'pc', state: 'idle' }),
      ];
      const c = ctx({
        missions: store, agents,
        projects: [project(), project({ id: 'pc', code: 'CP', name: 'capcom', rollup: { ...project().rollup, total: 1 } }), project({ id: 'p0', code: 'ZZ', name: 'empty', rollup: { ...project().rollup, total: 0 } })],
        escalations: [escalation(), escalation({ id: 'esc_old', status: 'answered' })],
        rules: [{ question: 'Which key on staging?', answer: 'always the test key', projectId: 'p1', at: NOW }],
      });
      const out = await runTool(c, 'briefing', { hours: null });
      const text = out.result;
      const has = (s: string) => text.includes(s);
      const section = (title: string): string => {
        const i = text.indexOf(title);
        const j = text.indexOf('\n', text.indexOf('\n', i) + 1);
        return text.slice(i, j < 0 ? undefined : text.indexOf('\n\n', i) < 0 ? undefined : text.indexOf('\n\n', i));
      };
      void section;
      const lines = text.split('\n');
      const blockedHead = lines.find((l) => l.startsWith('BLOCKED')) ?? '';
      const finishedHead = lines.find((l) => l.startsWith('FINISHED')) ?? '';
      return ok(
        'briefing is one dense screen',
        !out.isError
        && text.startsWith('BRIEFING ')
        && blockedHead.includes('(2)') && has('K1 [AX] waiting 4m BLOCKING: "Which Stripe key on staging?" · options: test | production (esc_1)')
        && has('K7 [AX] permission')
        && has('task_pay "Migrate payments to the new API" — human waiting') && has('1 unreported result(s) from K3')
        && finishedHead.includes('(2)') && has('K3 [AX] done 20m ago · task_pay') && has('K5 [AX] dead 10m ago · no mission: "segfault"')
        && !has('K4 [AX]') && !has('K6 [AX]')
        && has('audit-01 (2 members: 1 done, 1 dead)') && !has('pay-01 (')
        && has('AX axolots @main · 1 working, 1 blocked · $1.50') && !has('CP capcom') && !has('ZZ empty')
        && has('[AX] always the test key (re: Which key on staging?)')
        && text.length < 2500,
        `${text.length} chars · ${out.summary}`,
      );
    });
  }),

  test('briefing caps every section and says how many more there are', async () => {
    const agents = Array.from({ length: 12 }, (_, i) => agent({
      id: `b${i}`, callsign: `B${i}`, state: 'blocked',
      block: { kind: 'question', summary: `question ${i}`, since: NOW - i * 1000 },
    }));
    const out = await runTool(ctx({ agents, projects: [project()] }), 'briefing', { hours: 1 });
    const lines = out.result.split('\n');
    const head = lines.find((l) => l.startsWith('BLOCKED')) ?? '';
    const shown = lines.filter((l) => /^  B\d+ \[AX\]/.test(l)).length;
    return ok(
      'briefing caps every section',
      head.includes('(12)') && shown === 8 && out.result.includes('…and 4 more')
      && out.result.includes('MISSIONS WAITING ON YOU — inspect_mission, then report_mission: none'),
      `${shown} shown of 12`,
    );
  }),
];

const suite: TestModule = { suite: 'briefing · list_missions · inspect_mission', tests };
export default suite;
