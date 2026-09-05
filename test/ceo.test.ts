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
import type { CeoContext, PeerRelay } from '../src/agents/tools.ts';
import type { Preset } from '../src/shared/fleets.ts';
import { LAUNCH, runTool } from '../src/agents/tools.ts';
import { FakeCeo } from '../src/agents/fake.ts';
import type { CeoEvents } from '../src/agents/ceo.ts';
import { ok, eq, test, type TestModule } from './harness.ts';

/* ── A world in a box ─────────────────────────────────────────────── */

interface Recorded {
  raised: Parameters<CeoContext['raiseToHuman']>[0][];
  resolved: { id: string; answer: string; by: string }[];
  dispatched: { machineId: string; cmd: unknown }[];
  remembered: { question: string; answer: string }[];
  relayed: PeerRelay[];
  /** Squad names handed out so far; `nextSquadName` counts up from it. */
  squadSeq: number;
}

function makeCtx(opts: {
  memory?: { question: string; answer: string; score: number }[];
  agents?: Partial<Agent>[];
  fleets?: Preset[];
} = {}): { ctx: CeoContext; rec: Recorded } {
  const rec: Recorded = { raised: [], resolved: [], dispatched: [], remembered: [], relayed: [], squadSeq: 0 };

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
    callsign: 'K9', runtime: 'claude', state: 'working', block: null,
    parentId: null, depth: 0, childIds: [], mission: 'ship it',
    squad: null, lead: false,
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
      // A spawn answers the way a collector does: with the id of what it made.
      // The launch tests hang members off that id, so it has to be there.
      if ((cmd as { k?: string }).k === 'spawn') {
        const n = rec.dispatched.length;
        return { agentId: `spawned_${n}`, callsign: `S${n}`, shortId: `s${n}` };
      }
      return { ok: true };
    },
    nextSquadName: (base) => `${base}-0${++rec.squadSeq}`,
    fleets: () => opts.fleets ?? [],
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
    relay: (input) => {
      rec.relayed.push(input);
      // Deliver to whoever carries the label, the way the hub does — so a
      // relay to a squad can be checked for reaching its members and nobody else.
      const to = input.scope === 'squad'
        ? [...agents.values()].filter((a) => a.squad === input.toSquad).map((a) => a.id)
        : input.scope === 'agent' && input.toAgentId ? [input.toAgentId] : [];
      return { messageId: 'm_relayed', delivered: to, skipped: 0, reason: to.length ? null : 'fake ctx' };
    },
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

  /* ── squads, launched and driven from one tool each ─────────────── */

  test('launch_squad puts the lead up first and hangs every member off it', async () => {
    const { ctx, rec } = makeCtx();
    const out = await runTool(ctx, 'launch_squad', {
      project_id: 'p1', squad: 'audit', background: true, lead_model: null,
      lead_mission: 'Lead the audit: split the three areas below across your members, consolidate into one report with a risk per finding.',
      members: [
        { mission: 'Audit the dependency manifest for unused and outdated packages; report, do not upgrade.', model: null },
        { mission: 'Run the full test suite and fix what fails without changing any exported signature.', model: 'claude-sonnet-5' },
      ],
    });
    const spawns = rec.dispatched.map((d) => d.cmd as {
      k: string; squad?: string; lead?: boolean; parentId: string | null; model?: string;
    });
    const parsed = JSON.parse(out.result) as { squad: string; lead: { agent_id: string }; members: unknown[] };
    const leadFirst = spawns[0]?.lead === true && spawns[0]?.parentId === null;
    const membersHang = spawns.slice(1).every((s) => s.lead === false && s.parentId === parsed.lead.agent_id);
    const oneName = spawns.every((s) => s.k === 'spawn' && s.squad === parsed.squad);
    return ok(
      'launch_squad puts the lead up first and hangs every member off it',
      !out.isError && spawns.length === 3 && leadFirst && membersHang && oneName
        && parsed.squad === 'audit-01' && spawns[2]?.model === 'claude-sonnet-5',
      out.summary,
    );
  }),

  test('launching the same squad twice gives two squads, not one merged one', async () => {
    const { ctx } = makeCtx();
    const args = {
      project_id: 'p1', squad: 'audit', background: true, lead_model: null,
      lead_mission: 'Lead the audit and consolidate what the members find into one report.',
      members: [{ mission: 'Audit the dependency manifest and report, without upgrading anything.', model: null }],
    };
    const a = JSON.parse((await runTool(ctx, 'launch_squad', args)).result) as { squad: string };
    const b = JSON.parse((await runTool(ctx, 'launch_squad', args)).result) as { squad: string };
    return ok(
      'launching the same squad twice gives two squads',
      a.squad === 'audit-01' && b.squad === 'audit-02',
      `${a.squad}, ${b.squad}`,
    );
  }),

  test('launch_squad refuses a thin member before launching anybody', async () => {
    const { ctx, rec } = makeCtx();
    const out = await runTool(ctx, 'launch_squad', {
      project_id: 'p1', squad: 'audit', background: true, lead_model: null,
      lead_mission: 'Lead the audit and consolidate what the members find into one report.',
      members: [
        { mission: 'Audit the dependency manifest and report, without upgrading anything.', model: null },
        { mission: 'fix tests', model: null },
      ],
    });
    return ok(
      'launch_squad refuses a thin member before launching anybody',
      out.isError === true && rec.dispatched.length === 0 && out.result.includes('member 2'),
      out.summary,
    );
  }),

  test('one member failing to launch does not abort the rest of the squad', async () => {
    const { ctx, rec } = makeCtx();
    let n = 0;
    const flaky: CeoContext = {
      ...ctx,
      dispatch: async (machineId, cmd) => {
        n += 1;
        if (n === 2) throw new Error('collector refused: worktree busy');
        return ctx.dispatch(machineId, cmd);
      },
    };
    const out = await runTool(flaky, 'launch_squad', {
      project_id: 'p1', squad: 'audit', background: true, lead_model: null,
      lead_mission: 'Lead the audit and consolidate what the members find into one report.',
      members: [
        { mission: 'Audit the dependency manifest and report, without upgrading anything.', model: null },
        { mission: 'Read the docs against the source and list every claim that is no longer true.', model: null },
      ],
    });
    const parsed = JSON.parse(out.result) as { ok: boolean; members: unknown[]; failures: { member: number }[] };
    return ok(
      'one member failing to launch does not abort the rest',
      !out.isError && parsed.ok === false && parsed.members.length === 1
        && parsed.failures.length === 1 && parsed.failures[0]?.member === 1
        && rec.dispatched.length === 2,
      out.summary,
    );
  }),

  test('a lead that has not been named yet still gets its members, unparented and said so', async () => {
    const { ctx } = makeCtx();
    const slow: CeoContext = {
      ...ctx,
      // The collector gave up waiting for the session: the lead is running,
      // ORCA just cannot point at it yet.
      dispatch: async () => ({ agentId: null, callsign: null, shortId: 'zz' }),
    };
    const saved = { ...LAUNCH };
    LAUNCH.leadSettleMs = 0;
    try {
      const out = await runTool(slow, 'launch_squad', {
        project_id: 'p1', squad: 'audit', background: true, lead_model: null,
        lead_mission: 'Lead the audit and consolidate what the members find into one report.',
        members: [{ mission: 'Audit the dependency manifest and report, without upgrading anything.', model: null }],
      });
      const parsed = JSON.parse(out.result) as { lead: { agent_id: string | null }; members: unknown[]; note: string | null };
      return ok(
        'an unnamed lead still gets its members, unparented and said so',
        !out.isError && parsed.lead.agent_id === null && parsed.members.length === 1
          && (parsed.note ?? '').includes('unparented'),
        out.summary,
      );
    } finally {
      Object.assign(LAUNCH, saved);
    }
  }),

  test('inspect_squad reports the lead, the members, and who is stuck', async () => {
    const { ctx } = makeCtx({
      agents: [
        { id: 'a2', callsign: 'L1', squad: 'audit-01', lead: true, startedAt: Date.now() - 90_000 },
        { id: 'a3', callsign: 'M1', squad: 'audit-01', parentId: 'a2', state: 'blocked',
          block: { kind: 'question', summary: 'needs the staging key', since: Date.now() - 3000 } },
        { id: 'a4', callsign: 'M2', squad: 'audit-01', parentId: 'a2', state: 'done' },
      ],
    });
    const out = await runTool(ctx, 'inspect_squad', { squad: 'squad:audit-01' });
    const parsed = JSON.parse(out.result) as {
      lead: { callsign: string }; members: unknown[]; totals: { alive: number; blocked: number };
    };
    return ok(
      'inspect_squad reports the lead, the members, and who is stuck',
      !out.isError && parsed.lead.callsign === 'L1' && parsed.members.length === 3
        && parsed.totals.alive === 2 && parsed.totals.blocked === 1,
      out.summary,
    );
  }),

  test('inspect_squad on a squad that does not exist names the ones that do', async () => {
    const { ctx } = makeCtx({ agents: [{ id: 'a2', callsign: 'L1', squad: 'audit-01', lead: true }] });
    const out = await runTool(ctx, 'inspect_squad', { squad: 'audit-99' });
    return ok(
      'inspect_squad on a missing squad names the ones that exist',
      out.isError === true && out.result.includes('audit-01'),
      out.result,
    );
  }),

  test('stop_squad stops the living members first and the lead last', async () => {
    const { ctx, rec } = makeCtx({
      agents: [
        { id: 'a2', callsign: 'L1', squad: 'audit-01', lead: true, startedAt: Date.now() - 90_000 },
        { id: 'a3', callsign: 'M1', squad: 'audit-01', parentId: 'a2' },
        { id: 'a4', callsign: 'M2', squad: 'audit-01', parentId: 'a2', state: 'done' },
      ],
    });
    const out = await runTool(ctx, 'stop_squad', { squad: 'audit-01', reason: 'the migration was cancelled' });
    const stops = rec.dispatched.map((d) => d.cmd as { k: string; agentId: string });
    return ok(
      'stop_squad stops the living members first and the lead last',
      !out.isError && stops.length === 2 && stops.every((s) => s.k === 'stop')
        && stops[0]?.agentId === 'a3' && stops[1]?.agentId === 'a2',
      `${stops.map((s) => s.agentId).join(' → ')} · ${out.summary}`,
    );
  }),

  test('relay can address a whole squad, and reaches only its members', async () => {
    const { ctx, rec } = makeCtx({
      agents: [
        { id: 'a2', callsign: 'L1', squad: 'audit-01', lead: true },
        { id: 'a3', callsign: 'M1', squad: 'audit-01', parentId: 'a2' },
        { id: 'a5', callsign: 'X1', squad: 'other-01', lead: true },
      ],
    });
    const out = await runTool(ctx, 'relay', {
      kind: 'warning', agent_id: null, project_id: null, squad: 'audit-01',
      subject: 'Stop touching wrangler.jsonc, K9 is rewriting it', body: null,
    });
    const parsed = JSON.parse(out.result) as { delivered_to: string[] };
    const sent = rec.relayed[0];
    return ok(
      'relay can address a whole squad, and reaches only its members',
      !out.isError && sent?.scope === 'squad' && sent?.toSquad === 'audit-01'
        && parsed.delivered_to.length === 2 && !parsed.delivered_to.includes('X1'),
      out.summary,
    );
  }),

  test('relay refuses two recipients at once', async () => {
    const { ctx, rec } = makeCtx({ agents: [{ id: 'a2', callsign: 'L1', squad: 'audit-01', lead: true }] });
    const out = await runTool(ctx, 'relay', {
      kind: 'notice', agent_id: 'K9', project_id: null, squad: 'audit-01',
      subject: 'The sandbox rejects cards over $500', body: null,
    });
    return ok('relay refuses two recipients at once', out.isError === true && rec.relayed.length === 0, out.summary);
  }),

  /* ── presets: the squads you launch more than once ──────────────── */

  test('list_fleets shows the saved presets with their lead and one line per agent', async () => {
    const { ctx } = makeCtx({ fleets: [AUDIT_PRESET] });
    const out = await runTool(ctx, 'list_fleets', { full: false });
    const parsed = JSON.parse(out.result) as { presets: { name: string; lead: string | null; agents: unknown[]; squad: string }[] };
    const p = parsed.presets[0];
    return ok(
      'list_fleets shows the saved presets',
      !out.isError && parsed.presets.length === 1 && p?.name === 'audit' && p?.lead !== null
        && p?.agents.length === 3 && p?.squad === 'audit-NN',
      out.summary,
    );
  }),

  test('launch_squad by preset takes the briefs from disk and the project from the preset', async () => {
    const { ctx, rec } = makeCtx({ fleets: [{ ...AUDIT_PRESET, project: 'ax' }] });
    const out = await runTool(ctx, 'launch_squad', {
      project_id: null, preset: 'Audit', squad: null, lead_mission: null, members: null,
      lead_model: null, background: true,
    });
    const spawns = rec.dispatched.map((d) => d.cmd as { prompt: string; mission: string; lead?: boolean; parentId: string | null; squad?: string });
    const parsed = JSON.parse(out.result) as { squad: string; source: string; lead: { agent_id: string } };
    return ok(
      'launch_squad by preset takes the briefs from disk',
      !out.isError && spawns.length === 3 && spawns[0]?.lead === true
        && spawns[0]?.prompt === AUDIT_PRESET.agents[0]!.prompt
        && spawns[0]?.mission === AUDIT_PRESET.agents[0]!.mission
        && spawns.slice(1).every((c) => c.parentId === parsed.lead.agent_id && c.squad === parsed.squad)
        && parsed.squad === 'audit-01' && parsed.source === 'preset audit',
      out.summary,
    );
  }),

  test('a preset with a fixed squad name is not numbered', async () => {
    const { ctx } = makeCtx({ fleets: [{ ...AUDIT_PRESET, squad: 'nightly' }] });
    const out = await runTool(ctx, 'launch_squad', {
      project_id: 'p1', preset: 'audit', squad: null, lead_mission: null, members: null,
      lead_model: null, background: true,
    });
    const parsed = JSON.parse(out.result) as { squad: string };
    return eq('a preset with a fixed squad name is not numbered', parsed.squad, 'nightly');
  }),

  test('a preset without a lead launches peers and says nobody consolidates', async () => {
    const { ctx, rec } = makeCtx({
      fleets: [{ name: 'peers', agents: AUDIT_PRESET.agents.slice(1).map((a) => ({ ...a, lead: false })) }],
    });
    const out = await runTool(ctx, 'launch_squad', {
      project_id: 'p1', preset: 'peers', squad: null, lead_mission: null, members: null,
      lead_model: null, background: true,
    });
    const parsed = JSON.parse(out.result) as { lead: unknown; members: unknown[]; note: string | null };
    const spawns = rec.dispatched.map((d) => d.cmd as { lead?: boolean; parentId: string | null });
    return ok(
      'a preset without a lead launches peers and says so',
      !out.isError && parsed.lead === null && parsed.members.length === 2
        && spawns.every((c) => c.lead === false && c.parentId === null)
        && (parsed.note ?? '').includes('no lead'),
      out.summary,
    );
  }),

  test('an unknown preset is refused before anything launches, naming the ones that exist', async () => {
    const { ctx, rec } = makeCtx({ fleets: [AUDIT_PRESET] });
    const out = await runTool(ctx, 'launch_squad', {
      project_id: 'p1', preset: 'nightly', squad: null, lead_mission: null, members: null,
      lead_model: null, background: true,
    });
    return ok(
      'an unknown preset is refused, naming the ones that exist',
      out.isError === true && rec.dispatched.length === 0 && out.result.includes('audit'),
      out.result,
    );
  }),

  test('a preset whose project no machine reports asks for a project_id', async () => {
    const { ctx, rec } = makeCtx({ fleets: [{ ...AUDIT_PRESET, project: 'ZZ' }] });
    const out = await runTool(ctx, 'launch_squad', {
      project_id: null, preset: 'audit', squad: null, lead_mission: null, members: null,
      lead_model: null, background: true,
    });
    return ok(
      'a preset whose project is not reported asks for a project_id',
      out.isError === true && rec.dispatched.length === 0 && out.result.includes('ZZ'),
      out.result,
    );
  }),
];

const AUDIT_PRESET: Preset = {
  name: 'audit',
  agents: [
    { lead: true, mission: 'Lead the audit and keep the suite green.', prompt: 'You lead this audit. Run the suite, fix what fails, consolidate the members\' reports into one.' },
    { mission: 'Find dependencies that are unused, duplicated or behind.', prompt: 'Audit the manifest and lockfile. Report, do not upgrade.' },
    { mission: 'Make the docs describe what the code actually does.', prompt: 'Read the docs against the source and fix the unambiguous claims.' },
  ],
};

const suite: TestModule = { suite: 'ceo · agent → CEO → human', tests };
export default suite;
