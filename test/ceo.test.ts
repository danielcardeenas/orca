/**
 * The agent → CEO → human loop.
 *
 * These are the tests that matter most in ORCA, because the failure modes they
 * cover are silent ones. A question that reaches nobody looks exactly like a
 * quiet fleet. An answer that never gets back to the agent looks exactly like
 * an agent that is thinking hard. Neither shows up as an error anywhere.
 *
 * Everything here runs against a fake CeoContext — no hub, no network, no
 * model, no spend.
 */

import type { Agent, Escalation, Project } from '../src/shared/types.ts';
import type { CeoContext } from '../src/agents/tools.ts';
import { runTool } from '../src/agents/tools.ts';
import { FakeCeo } from '../src/agents/fake.ts';
import type { CeoEvents } from '../src/agents/ceo.ts';
import { ok, eq, test, type TestModule } from './harness.ts';

/* ── A world in a box ─────────────────────────────────────────────── */

interface Recorded {
  raised: Parameters<CeoContext['raiseToHuman']>[0][];
  resolved: { id: string; answer: string; by: string }[];
  dispatched: { machineId: string; cmd: unknown }[];
  remembered: { question: string; answer: string }[];
}

function makeCtx(opts: {
  memory?: { question: string; answer: string; score: number }[];
  agents?: Partial<Agent>[];
} = {}): { ctx: CeoContext; rec: Recorded } {
  const rec: Recorded = { raised: [], resolved: [], dispatched: [], remembered: [] };

  const project: Project = {
    id: 'p1', machineId: 'm1', slug: '-x', name: 'axolots', path: '/x', code: 'AX',
    gitBranch: 'main', gitDirty: false, keyNames: ['FAL_KEY'], sessionIds: ['a1'],
    rollup: {
      total: 1,
      byState: { booting: 0, thinking: 0, working: 1, blocked: 0, idle: 0, done: 0, dead: 0 },
      costUSD: 1.5, tokensPerSec: 20, blocked: 0,
    },
  };

  const base: Agent = {
    id: 'a1', machineId: 'm1', projectId: 'p1', title: 'Ship the deploy',
    callsign: 'K9', state: 'working', block: null,
    parentId: null, depth: 0, childIds: [], mission: 'ship it',
    model: 'claude-opus-5', tool: 'Bash', toolDetail: 'npm test',
    lastPrompt: null, lastSay: null,
    startedAt: Date.now() - 60_000, updatedAt: Date.now(), uptimeMs: 60_000,
    metrics: {
      costUSD: 1.5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0,
      thinkingTokens: 0, tokensPerSec: 20, linesAdded: 10, linesRemoved: 2,
      toolCalls: 5, toolDurationMs: 100, apiDurationMs: 200, turns: 3,
    },
    background: true, shortId: 'k9',
  };

  const agents = new Map<string, Agent>([['a1', base]]);
  for (const patch of opts.agents ?? []) {
    const a = { ...base, ...patch } as Agent;
    agents.set(a.id, a);
  }

  const escalations = new Map<string, Escalation>();

  const ctx: CeoContext = {
    agents: () => [...agents.values()],
    projects: () => [project],
    agent: (id) => agents.get(id),
    project: (id) => (id === 'p1' ? project : undefined),
    escalation: (id) => escalations.get(id),
    dispatch: async (machineId, cmd) => {
      rec.dispatched.push({ machineId, cmd });
      return { ok: true };
    },
    recall: (q) => (opts.memory ?? []).filter((m) =>
      // A crude stand-in for the hub's similarity search: enough to prove the
      // CEO consults memory before it interrupts anyone.
      m.question.toLowerCase().split(/\W+/).some((w) => w.length > 3 && q.toLowerCase().includes(w))),
    remember: (question, answer) => { rec.remembered.push({ question, answer }); },
    raiseToHuman: (input) => {
      rec.raised.push(input);
      const esc: Escalation = {
        id: 'esc_raised', agentId: input.agentId ?? '', projectId: input.projectId ?? '',
        machineId: 'm1', question: input.question, context: input.context,
        options: input.options, optionsOnly: false, urgency: input.urgency,
        status: 'pending', ceoAttempt: input.ceoAttempt, answer: null, answeredBy: null,
        rememberAs: null, askedAt: Date.now(), answeredAt: null, expiresAt: null,
      };
      escalations.set(esc.id, esc);
      return esc;
    },
    resolveEscalation: (id, answer, by) => { rec.resolved.push({ id, answer, by }); },

    // El canal agente↔agente no lo ejercita esta suite (ver traffic.test.ts);
    // aquí sólo tiene que existir para que el contexto esté completo.
    messages: () => [],
    message: () => undefined,
    collisions: () => [],
    relay: () => ({ messageId: 'm_none', delivered: [], skipped: 0, reason: 'fake ctx' }),
    answerPeer: () => null,
    acknowledgeCollision: () => null,
  };

  const incoming: Escalation = {
    id: 'esc_in', agentId: 'a1', projectId: 'p1', machineId: 'm1',
    question: 'Should the staging deploy use the production Stripe key?',
    context: 'Both are in the env file.',
    options: ['Test key', 'Production key'], optionsOnly: false,
    urgency: 'blocking', status: 'pending', ceoAttempt: null,
    answer: null, answeredBy: null, rememberAs: null,
    askedAt: Date.now(), answeredAt: null, expiresAt: null,
  };
  escalations.set(incoming.id, incoming);

  return { ctx, rec };
}

function silentEvents(): CeoEvents {
  return {
    onStart() { }, onDelta() { }, onAction() { }, onDone() { }, onThinking() { },
  };
}

function incomingOf(ctx: CeoContext): Escalation {
  return ctx.escalation('esc_in')!;
}

/* ── Tests ────────────────────────────────────────────────────────── */

const tests = [
  test('a question with no memory reaches the human', async () => {
    const { ctx, rec } = makeCtx();
    const ceo = new FakeCeo(ctx, silentEvents());
    await ceo.considerEscalation(incomingOf(ctx));
    return ok(
      'a question with no memory reaches the human',
      rec.raised.length === 1 && rec.resolved.length === 0,
      `raised=${rec.raised.length} answered=${rec.resolved.length}`,
    );
  }),

  test('a question the human already answered never reaches them again', async () => {
    const { ctx, rec } = makeCtx({
      memory: [{
        question: 'Which Stripe key for staging deploys?',
        answer: 'Always the test key on staging.',
        score: 0.91,
      }],
    });
    const ceo = new FakeCeo(ctx, silentEvents());
    await ceo.considerEscalation(incomingOf(ctx));
    return ok(
      'a question the human already answered never reaches them again',
      rec.resolved.length === 1 && rec.raised.length === 0,
      rec.resolved[0]?.answer ?? 'nothing answered',
    );
  }),

  test('an answer the CEO gives is attributed to the CEO, not the human', async () => {
    const { ctx, rec } = makeCtx({
      memory: [{ question: 'Which Stripe key for staging?', answer: 'Test key.', score: 0.9 }],
    });
    await new FakeCeo(ctx, silentEvents()).considerEscalation(incomingOf(ctx));
    return eq('an answer the CEO gives is attributed to the CEO', rec.resolved[0]?.by, 'ceo');
  }),

  test('escalating carries the CEO attempt so the human sees the gap', async () => {
    const { ctx, rec } = makeCtx();
    await new FakeCeo(ctx, silentEvents()).considerEscalation(incomingOf(ctx));
    const attempt = rec.raised[0]?.ceoAttempt;
    return ok(
      'escalating carries the CEO attempt so the human sees the gap',
      !!attempt && typeof attempt.reason === 'string' && attempt.reason.length > 0,
      attempt?.reason,
    );
  }),

  test('escalating preserves urgency and the tappable options', async () => {
    const { ctx, rec } = makeCtx();
    await new FakeCeo(ctx, silentEvents()).considerEscalation(incomingOf(ctx));
    const r = rec.raised[0];
    return ok(
      'escalating preserves urgency and the tappable options',
      r?.urgency === 'blocking' && r?.options.length === 2,
      `urgency=${r?.urgency} options=${r?.options.join('|')}`,
    );
  }),

  /* ── Tools ──────────────────────────────────────────────────────── */

  test('spawn refuses a mission too thin to act on', async () => {
    const { ctx, rec } = makeCtx();
    const out = await runTool(ctx, 'spawn_agent', {
      project_id: 'p1', mission: 'fix it', parent_agent_id: null, background: true,
    });
    return ok(
      'spawn refuses a mission too thin to act on',
      out.isError === true && rec.dispatched.length === 0,
      out.summary,
    );
  }),

  test('spawn with a real brief reaches the owning machine', async () => {
    const { ctx, rec } = makeCtx();
    const out = await runTool(ctx, 'spawn_agent', {
      project_id: 'p1',
      mission: 'Migrate the DNS for axolots.com to Cloudflare. Done when the zone resolves and the 301 to .ai still works. Do not touch MX records.',
      parent_agent_id: null, background: true,
    });
    const cmd = rec.dispatched[0]?.cmd as { k?: string } | undefined;
    return ok(
      'spawn with a real brief reaches the owning machine',
      !out.isError && cmd?.k === 'spawn' && rec.dispatched[0]?.machineId === 'm1',
      out.summary,
    );
  }),

  test('agents can be addressed by callsign, the way a human types', async () => {
    const { ctx } = makeCtx();
    const out = await runTool(ctx, 'inspect_agent', { agent_id: 'k9' });
    return ok(
      'agents can be addressed by callsign',
      !out.isError && out.result.includes('"callsign": "K9"'),
      out.summary,
    );
  }),

  test('ask_human ends the triage loop', async () => {
    const { ctx } = makeCtx();
    const out = await runTool(ctx, 'ask_human', {
      question: 'Which region?', context: null, options: ['fra1', 'nue2'],
      urgency: 'normal', agent_id: 'a1', project_id: 'p1',
    });
    return eq('ask_human ends the triage loop', out.terminal, 'escalated');
  }),

  test('answer_agent ends the triage loop', async () => {
    const { ctx } = makeCtx();
    const out = await runTool(ctx, 'answer_agent', {
      escalation_id: 'esc_in', answer: 'Test key.', basis: 'recall',
    });
    return eq('answer_agent ends the triage loop', out.terminal, 'answered');
  }),

  test('a tool that throws returns an error the model can read, not a crash', async () => {
    const { ctx } = makeCtx();
    const broken: CeoContext = {
      ...ctx,
      dispatch: async () => { throw new Error('collector offline'); },
    };
    const out = await runTool(broken, 'stop_agent', { agent_id: 'a1', reason: 'test' });
    return ok(
      'a tool that throws returns an error the model can read',
      out.isError === true && out.result.includes('collector offline'),
      out.summary,
    );
  }),

  test('an unknown tool name does not throw', async () => {
    const { ctx } = makeCtx();
    const out = await runTool(ctx, 'delete_everything', {});
    return ok('an unknown tool name does not throw', out.isError === true, out.summary);
  }),

  test('list_fleet reports blocked agents separately from the rollup', async () => {
    const { ctx } = makeCtx({
      agents: [{
        id: 'a2', callsign: 'B7', state: 'blocked',
        block: { kind: 'question', summary: 'needs a key', since: Date.now() - 5000 },
      }],
    });
    const out = await runTool(ctx, 'list_fleet', {});
    const parsed = JSON.parse(out.result) as { blocked: unknown[] };
    return eq('list_fleet reports blocked agents separately', parsed.blocked.length, 1);
  }),
];

const suite: TestModule = { suite: 'ceo · agent → CEO → human', tests };
export default suite;
