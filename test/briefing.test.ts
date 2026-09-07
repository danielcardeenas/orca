/**
 * The tools that let CAPCOM command without memory.
 *
 * `list_tasks`, `inspect_task` and `briefing` exist so that a session that has
 * just booted — or just compacted — can read what it owes off the hub instead
 * of off its own context. What is tested is the one rule they all share: in a
 * task, everything after the last CAPCOM message is unanswered. And that the
 * briefing is short, capped, and names things by the id the next tool takes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, Escalation, Project } from '../src/shared/types.ts';
import { TaskStore } from '../src/hub/tasks.ts';
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
  agents?: Agent[]; projects?: Project[]; escalations?: Escalation[]; tasks?: TaskStore;
  rules?: { question: string; answer: string; projectId: string | null; at: number }[];
}): CeoContext {
  const agents = o.agents ?? [];
  const projects = o.projects ?? [];
  const refuse = (): never => { throw new Error('not in this test'); };
  return {
    tasks: o.tasks,
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

function withStore<T>(fn: (store: TaskStore) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'orca-briefing-'));
  try { return fn(new TaskStore(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
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
  test('the three tools are advertised over MCP with strict, complete schemas', () => {
    const names = mcpTools().map((t) => t.name);
    const specs = CEO_TOOLS.filter((t) => ['list_tasks', 'inspect_task', 'briefing'].includes(t.name));
    const complete = specs.every((t) => {
      const schema = t.input_schema as { properties: Record<string, unknown>; required: string[] };
      return t.strict === true && Object.keys(schema.properties).every((k) => schema.required.includes(k));
    });
    return ok(
      'list_tasks, inspect_task and briefing are advertised over MCP',
      names.includes('list_tasks') && names.includes('inspect_task') && names.includes('briefing') && specs.length === 3 && complete,
      names.filter((n) => n.includes('task') || n === 'briefing').join(', '),
    );
  }),

  test('list_tasks says which tasks are waiting on CAPCOM, and only_pending keeps those', async () => {
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
        tasks: store,
        agents: [agent({ id: 'a2', callsign: 'K2', state: 'working' }), agent({ id: 'a3', callsign: 'K3', state: 'done' })],
      });
      const all = parse<{ tasks: { id: string; awaiting_reply: boolean; unreported_results: number; agents: { callsign: string | null; state: string }[]; pending_human: { text: string } | null }[]; total: number }>(
        await runTool(c, 'list_tasks', { status: null, only_pending: false, limit: 20 }));
      const pending = parse<{ tasks: { id: string }[]; total: number }>(
        await runTool(c, 'list_tasks', { status: null, only_pending: true, limit: 20 }));
      const active = parse<{ total: number }>(await runTool(c, 'list_tasks', { status: 'active', only_pending: false, limit: 20 }));
      const by = Object.fromEntries(all.tasks.map((t) => [t.id, t]));
      const owed = by['task_owed'];
      const results = by['task_results'];
      return ok(
        'list_tasks says which tasks are waiting on CAPCOM',
        all.total === 4
        && by['task_answered']?.awaiting_reply === false && by['task_answered']?.unreported_results === 0
        && owed?.awaiting_reply === true && owed.pending_human?.text === 'Also add the webhook'
        && owed.agents[0]?.callsign === 'K2' && owed.agents[0]?.state === 'working'
        && results?.awaiting_reply === false && results.unreported_results === 1
        && by['task_done']?.awaiting_reply === false
        && pending.total === 2 && pending.tasks.map((t) => t.id).sort().join(',') === 'task_owed,task_results'
        && active.total === 3,
        `pending: ${pending.tasks.map((t) => t.id).join(', ')}`,
      );
    });
  }),

  test('inspect_task returns the conversation, the agents with their last result, and what is owed', async () => {
    return withStore(async (store) => {
      store.create('task_x', 'New task');
      store.message('task_x', 'human', 'Fix the flaky test');
      store.message('task_x', 'capcom', 'K9 is on it', 'active');
      store.assign('task_x', ['a9']);
      store.message('task_x', 'agent', 'Found the race in retention.test.ts', undefined, 'a9');
      store.message('task_x', 'human', 'Is it fixed yet?');
      const c = ctx({
        tasks: store,
        agents: [agent({ id: 'a9', callsign: 'K9', state: 'done', lastSay: 'Fixed and green' })],
        projects: [project()],
      });
      const out = await runTool(c, 'inspect_task', { task_id: 'task_x' });
      const t = parse<{
        conversation: { role: string; agent: string | null; text: string }[];
        agents: { callsign: string | null; state: string; last_say: string | null; last_result_in_task: string | null }[];
        pending_human: { text: string }[]; unreported_results: { agent: string | null; text: string }[]; owed: string;
      }>(out);
      const missing = await runTool(c, 'inspect_task', { task_id: 'task_nope' });
      return ok(
        'inspect_task returns the conversation, the agents and what is owed',
        !out.isError && t.conversation.length === 4 && t.conversation[2]?.agent === 'K9'
        && t.agents[0]?.callsign === 'K9' && t.agents[0].state === 'done' && t.agents[0].last_say === 'Fixed and green'
        && t.agents[0].last_result_in_task === 'Found the race in retention.test.ts'
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
      // a4 finished in a task CAPCOM already reported on: not unreported.
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
        tasks: store, agents,
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
        && finishedHead.includes('(2)') && has('K3 [AX] done 20m ago · task_pay') && has('K5 [AX] dead 10m ago · no task: "segfault"')
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
      && out.result.includes('TASKS WAITING ON YOU — inspect_task, then report_task: none'),
      `${shown} shown of 12`,
    );
  }),
];

const suite: TestModule = { suite: 'briefing · list_tasks · inspect_task', tests };
export default suite;
