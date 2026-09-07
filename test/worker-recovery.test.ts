import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from '../src/shared/types.ts';
import type { Command } from '../src/shared/protocol.ts';
import { quotaIncident, canSupervise } from '../src/shared/recovery.ts';
import { RecoveryCoordinator } from '../src/hub/recovery.ts';
import { WorkerHandoffs } from '../src/collector/worker-handoff.ts';
import { ModelController, resumedPromptReady } from '../src/collector/model-control.ts';
import { LineageIndex } from '../src/collector/lineage.ts';
import type { AgentHandle, CommandDeps } from '../src/collector/commands.ts';
import { TaskStore } from '../src/hub/tasks.ts';
import { BudgetBook, budgetConfig } from '../src/hub/budgets.ts';
import { CodexDeriver } from '../src/collector/codex.ts';
import { test, ok } from './harness.ts';
const sourceId = '11111111-2222-4333-8444-555555555555';
const targetId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function agent(over: Partial<Agent> = {}): Agent {
  return { id: sourceId, callsign: '24', parentId: 'lead', projectId: 'project', runtime: 'claude', model: 'fable', pane: true,
    state: 'blocked', block: { kind: 'error', since: 100, summary: "rate_limit: You've reached your Fable limit" }, mission: 'Finish the pending test', squad: 'test-01', ...over } as Agent;
}
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-worker-recovery-')); let now = 1000;
  const a = agent(); const lead = agent({ id: 'lead', callsign: '89', state: 'idle', block: null, lead: true, parentId: 'cap' });
  const cap = agent({ id: 'cap', callsign: 'CC', state: 'idle', block: null, role: 'capcom', parentId: null });
  const agents = [a, lead, cap]; const calls: Command[] = []; const notices: string[] = [];
  const deps = { dir, now: () => now, agents: () => agents, automatic: true, note() {}, notify: async (s: Agent, text: string) => { notices.push(s.id + ':' + text); return true; }, dispatch: async (c: Command): Promise<unknown> => { calls.push(c); return { phase: 'queued' }; } };
  const service = new RecoveryCoordinator(deps);
  return { dir, a, lead, cap, agents, calls, notices, deps, service, advance: (ms: number) => now += ms, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
export default { suite: 'Worker recovery', tests: [
  test('clean CAPCOM notification cutoff keeps old quota incidents recorded and routes only new ones', async () => {
    const r = rig(); try {
      r.lead.state = 'working';
      const service = new RecoveryCoordinator({ ...r.deps, notifyAllowed: (supervisor, a) => supervisor.role !== 'capcom' || (quotaIncident(a)?.since ?? 0) > 500 });
      await service.tick(); assert.equal(r.notices.length, 0);
      assert.ok(quotaIncident(r.a)); // No incident or worker was erased.
      r.a.block!.since = 600; await service.tick();
      assert.equal(r.notices.length, 1); assert.ok(r.notices[0]!.startsWith('cap:'));
      return ok('clean context rejects quota backlog but new incidents still arrive', true);
    } finally { r.dispose(); }
  }),
  test('automatic recovery setting applies live and persisted false overrides the environment', async () => {
    const r = rig(); try {
      assert.equal(r.service.settings().automatic, true);
      r.service.setAutomatic(false); await r.service.tick(); assert.equal(r.notices.length, 0);
      const restored = new RecoveryCoordinator(r.deps);
      assert.equal(restored.settings().automatic, false);
      assert.throws(() => restored.setAutomatic('yes' as any), /boolean/);
      restored.setAutomatic(true); await restored.tick(); assert.equal(r.notices.length, 1);
      assert.equal(new RecoveryCoordinator({ ...r.deps, automatic: false }).settings().automatic, true);
      return ok('live fleet setting, validation and restart precedence', true);
    } finally { r.dispose(); }
  }),
  test('resumed Codex uses the current model banner rather than stale loading scrollback', () => {
    assert.equal(resumedPromptReady('model: loading\n› Ask Codex to do anything', 'codex'), false);
    assert.equal(resumedPromptReady('model: loading\nResuming session…\nmodel: gpt-6-astra medium\n› Ask Codex to do anything', 'codex'), true);
    assert.equal(resumedPromptReady('model: gpt-6-astra\n• Starting MCP servers (esc to interrupt)\n› Ask Codex to do anything', 'codex'), false);
    return ok('current native resume state', true);
  }),
  test('Codex API error stays blocked until actual assistant progress', () => {
    const d = new CodexDeriver({ key: sourceId, sessionId: sourceId } as any, 'm', 'p', 1000);
    const send = (payload: unknown, at: number) => d.ingest({ lines: [{ type: 'event_msg', timestamp: new Date(at).toISOString(), payload }], mtimeMs: at, bootstrap: false } as any);
    send({ type: 'error', message: 'Usage limit reached', codex_error_info: 'UsageLimitReached' }, 2000);
    assert.ok(quotaIncident(d.snapshot(2001))); send({ type: 'task_started' }, 3000); assert.equal(d.state(3001), 'blocked');
    send({ type: 'agent_message', message: 'Continuing the pending request.' }, 4000); assert.equal(d.blockOf(4001), null);
    return ok('Codex quota signal requires real recovery', true);
  }),
  test('handoff does not reset per-agent spend or time budgets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-recovery-budget-'));
    try {
      const budgets = new BudgetBook(dir, budgetConfig({})); budgets.set({ kind: 'agent', ref: sourceId }, { usd: 10, min: 60 });
      const original = agent({ startedAt: 1000, uptimeMs: 60000, metrics: { costUSD: 8 } as any });
      const next = agent({ id: targetId, startedAt: 61000, uptimeMs: 0, metrics: { costUSD: 3 } as any, continuation: { fromId: sourceId, at: 61000, archive: '/backup', historyPath: '/history', checkpointPath: '/checkpoint' } });
      const status = budgets.agentStatus(next, { [sourceId]: original, [targetId]: next }, {}, 121000);
      assert.equal(status.spent_usd, 11); assert.equal(status.elapsed_min, 2); assert.equal(status.level, 'over');
      return ok('budget follows both session segments', true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }),
  test('only explicit API quota evidence is a quota incident; supervisors follow lineage', () => {
    const r = rig(); try {
      assert.ok(quotaIncident(r.a)); assert.equal(quotaIncident(agent({ block: { kind: 'permission', summary: 'credits', since: 1 } })), null);
      assert.equal(quotaIncident(agent({ block: { kind: 'error', summary: 'disk full', since: 1 } })), null);
      assert.ok(canSupervise(r.lead, r.a, r.agents)); assert.ok(canSupervise(r.cap, r.a, r.agents)); assert.equal(canSupervise(agent({ id: 'stranger', parentId: null }), r.a, r.agents), false);
      return ok('quota evidence and supervisory scope', true);
    } finally { r.dispose(); }
  }),
  test('wait is durable and review wakes the available supervisor only once', async () => {
    const r = rig(); try {
      await r.service.decide(r.a.id, { incident: quotaIncident(r.a)!.id, action: 'wait', reason: 'Quota reset is expected soon; task can wait', reviewAt: 5000, supervisorId: 'lead' });
      await r.service.tick(); assert.equal(r.notices.length, 0); assert.equal(r.calls.length, 0);
      const restored = new RecoveryCoordinator(r.deps); r.advance(5000); await restored.tick(); await restored.tick();
      assert.equal(r.notices.length, 1); assert.match(r.notices[0]!, /^lead:/); assert.equal(restored.status(r.a.id).decision?.phase, 'waiting');
      const restoredAgain = new RecoveryCoordinator(r.deps); await restoredAgain.tick(); assert.equal(r.notices.length, 1);
      return ok('wait, restart and one review notification', true);
    } finally { r.dispose(); }
  }),
  test('shared failures coalesce to CAPCOM if the lead is also blocked', async () => {
    const r = rig(); try {
      r.lead.state = 'blocked'; r.lead.block = r.a.block;
      await r.service.tick(); assert.equal(r.notices.length, 1); assert.match(r.notices[0]!, /^cap:/); assert.match(r.notices[0]!, /24/); assert.match(r.notices[0]!, /89/);
      await r.service.tick(); assert.equal(r.notices.length, 1);
      return ok('one supervisor turn for shared quota', true);
    } finally { r.dispose(); }
  }),
  test('an unanswered recovery notice escalates to CAPCOM after five minutes', async () => {
    const r = rig(); try {
      await r.service.tick(); assert.match(r.notices[0]!, /^lead:/);
      r.advance(300001); await r.service.tick(); assert.equal(r.notices.length, 2); assert.match(r.notices[1]!, /^cap:/);
      return ok('unanswered recovery has an escalation path', true);
    } finally { r.dispose(); }
  }),
  test('stale incidents, unrelated supervisors and repeated retries are rejected', async () => {
    const r = rig(); try {
      const input = { incident: quotaIncident(r.a)!.id, action: 'retry' as const, reason: 'Single explicit retry', supervisorId: 'lead' };
      await assert.rejects(r.service.decide(r.a.id, { ...input, incident: 'stale' }), /Block changed/);
      r.agents.push(agent({ id: 'other', parentId: null, squad: null }));
      await assert.rejects(r.service.decide(r.a.id, { ...input, supervisorId: 'other' }), /supervisor/);
      await r.service.decide(r.a.id, input); await r.service.tick(); await r.service.tick();
      assert.equal(r.calls.filter(c => c.k === 'say').length, 1);
      await assert.rejects(r.service.decide(r.a.id, input), /already ran/);
      return ok('no stale or duplicate recovery action', true);
    } finally { r.dispose(); }
  }),
  test('model recovery waits for native confirmation and sends one continuation', async () => {
    const r = rig(); try {
      await r.service.decide(r.a.id, { incident: quotaIncident(r.a)!.id, action: 'model', model: 'sonnet', reason: 'Suitable for the pending implementation', supervisorId: 'lead' });
      await r.service.tick(); assert.equal(r.calls.filter(c => c.k === 'say').length, 0);
      r.a.modelControl = { sessionId: r.a.id, runtime: 'claude', phase: 'ready', active: 'sonnet', requested: null, choices: [], detail: '', events: [{ id: 'event', at: 1001, from: 'fable', to: 'sonnet', text: 'confirmed' }] };
      await r.service.tick(); await r.service.tick(); assert.equal(r.calls.filter(c => c.k === 'say').length, 1);
      assert.equal(r.service.status(r.a.id).decision?.phase, 'complete');
      return ok('confirmed model before continuation', true);
    } finally { r.dispose(); }
  }),
  test('quota failure in destination never resumes or repeats the failed handoff', async () => {
    const r = rig(); try {
      r.deps.dispatch = async c => { r.calls.push(c); if (c.k === 'handoff:prepare') return { id: 'plan', fromId: r.a.id, runtime: 'codex', model: 'gpt-6-astra', phase: 'review' }; if (c.k === 'handoff:status') return { phase: 'failed', detail: 'quota exhausted' }; return {}; };
      const input = { incident: quotaIncident(r.a)!.id, action: 'handoff' as const, runtime: 'codex', model: 'gpt-6-astra', reason: 'Alternate provider for a complex task', supervisorId: 'lead' };
      await r.service.decide(r.a.id, input); await r.service.tick();
      assert.equal(r.service.status(r.a.id).decision?.phase, 'failed'); assert.equal(r.calls.filter(c => c.k === 'say').length, 0);
      await assert.rejects(r.service.decide(r.a.id, input), /already ran/);
      assert.ok(fs.readFileSync(path.join(r.dir, 'recovery-decisions.jsonl'), 'utf8').includes('quota exhausted'));
      return ok('failed handoff retained as evidence', true);
    } finally { r.dispose(); }
  }),
  test('worker handoff preserves raw context, cwd, mission, lead, children and task bindings', async () => {
    const r = workerRig(); try {
      const p = r.workers.handoffs.review(sourceId, 'codex', 'gpt-6-astra', 'Pending task_a');
      assert.equal(p.cwd, r.dir); assert.match(fs.readFileSync(p.checkpointPath, 'utf8'), /mission-keep/);
      r.workers.handoffs.commit(sourceId, p.id); await r.settle();
      assert.equal(r.workers.handoffs.status(p.id).phase, 'complete');
      assert.deepEqual(r.kills, [`orca-${sourceId}`]); assert.equal(r.workers.continuation(targetId)?.fromId, sourceId);
      const tree = r.lineage.resolve([sourceId, targetId, 'child'].map(id => ({ key: id, sessionId: id, agentId: null, metaPath: null, shortId: id })));
      assert.equal(tree.get(targetId)?.lead, true); assert.equal(tree.get(sourceId)?.lead, false); assert.equal(tree.get('child')?.parentId, targetId); assert.equal(tree.get(targetId)?.worktree, r.dir);
      const tasks = new TaskStore(path.join(r.dir, 'hub')); tasks.create('task_a', 'Pending'); tasks.assign('task_a', [sourceId]);
      const destination = agent({ id: targetId, state: 'idle', block: null, continuation: r.workers.continuation(targetId) });
      tasks.observe({ [targetId]: destination }); assert.ok(tasks.get('task_a').agentIds.includes(targetId));
      assert.equal(fs.readFileSync(path.join(p.archive, 'source.jsonl'), 'utf8'), r.raw);
      return ok('worker cutover and work ownership', true);
    } finally { r.dispose(); }
  }),
  test('failed source stop keeps original ownership and removes only candidate', async () => {
    const r = workerRig(true); try {
      const p = r.workers.handoffs.review(sourceId, 'codex', 'gpt-6-astra'); r.workers.handoffs.commit(sourceId, p.id); await r.settle();
      assert.equal(r.workers.handoffs.status(p.id).phase, 'failed'); assert.equal(r.workers.continuation(targetId), undefined);
      assert.deepEqual(r.kills, [`orca-${sourceId}`, `orca-${targetId}`]);
      const tree = r.lineage.resolve([{ key: sourceId, sessionId: sourceId, agentId: null, metaPath: null, shortId: sourceId }]); assert.equal(tree.get(sourceId)?.lead, true);
      return ok('source retained when stop fails', true);
    } finally { r.dispose(); }
  }),
  test('restart during worker activation reconciles only the staged continuation', async () => {
    for (const sourceAlive of [true, false]) {
      const r = workerRig(); try {
        const dir = path.join(r.dir, 'recovery'); fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'continuations.json'), JSON.stringify({ [targetId]: { phase: 'staged', source: r.a, fromId: sourceId, at: Date.now(), archive: '/backup', historyPath: '/history', checkpointPath: '/checkpoint' } }));
        r.deps.tmux.capture = async name => ({ ok: name !== r.a.pane || sourceAlive, stdout: '› ', detail: '' });
        const restored = new WorkerHandoffs(r.deps, r.models, () => false, dir);
        assert.equal(restored.continuation(targetId), undefined);
        await restored.reconcile();
        if (sourceAlive) { assert.deepEqual(r.kills, [`orca-${targetId}`]); assert.equal(restored.continuation(targetId), undefined); }
        else { assert.equal(r.kills.length, 0); assert.equal(restored.continuation(targetId)?.fromId, sourceId); }
      } finally { r.dispose(); }
    }
    return ok('restart retains original or adopts surviving destination', true);
  }),
] };

function workerRig(failStop = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-worker-transfer-'));
  const raw = JSON.stringify({ type: 'user', timestamp: '2026-09-06T01:00:00Z', message: { content: 'Keep all pending obligations.' } }) + '\n';
  const source = path.join(dir, 'source.jsonl'); fs.writeFileSync(source, raw);
  const a: AgentHandle = { ...agent(), sessionId: sourceId, callsign: '24', background: false, shortId: null, alive: true, pane: `orca-${sourceId}`, blockKind: 'error', transcriptPath: source, cwd: dir, mission: 'mission-keep', lead: true, worktree: { path: dir, branch: 'task' } };
  const lineage = new LineageIndex(path.join(dir, 'lineage.json')); lineage.noteSpawn(sourceId, 'lead', a.mission!, 'test-01', true, 'agent', a.worktree); lineage.bind(sourceId, sourceId); lineage.noteSpawn('child', sourceId, 'child task');
  const kills: string[] = [];
  const deps = { agent: () => a, projects: { get: () => ({ path: dir }) }, keys: { materialize: () => ({}) }, lineage, onResync() {}, tmux: {
    spawn: async (p: any) => { assert.equal(p.cwd, dir); assert.ok(p.argv.includes('resume')); assert.ok(p.argv.includes(targetId)); return { ok: true }; },
    capture: async () => ({ ok: true, stdout: '› ', detail: '' }), kill: async (name: string) => { kills.push(name); return { ok: !(failStop && name === a.pane) }; },
  } } as unknown as CommandDeps;
  const models = new ModelController({ agent: () => a, dir: () => dir, owns: () => true, tmux: deps.tmux });
  const workers = new WorkerHandoffs(deps, models, () => false, path.join(dir, 'recovery'), { bin: () => '/fake/codex', wait: async () => {}, models: () => [{ id: 'gpt-6-astra', label: 'Astra', runtime: 'codex', installed: true }], prepare: async (p, prompt) => { assert.match(prompt, /Keep all pending obligations/); return { sessionId: targetId, receipt: `ORCA_HANDOFF_READY_${p.id}` }; } });
  return { dir, workers, lineage, raw, kills, a, deps, models, settle: async () => { for (let i = 0; i < 1000 && workers.handoffs.locked(sourceId); i++) await Promise.resolve(); }, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
