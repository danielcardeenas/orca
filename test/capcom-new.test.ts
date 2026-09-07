import { TerminalRelay } from '../src/collector/term.ts';
import type { TmuxHost } from '../src/collector/tmux.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderHandoffs } from '../src/collector/provider-handoff.ts';
import { CapcomSession } from '../src/collector/capcom.ts';
import { CapcomRouter } from '../src/hub/capcom.ts';
import { cleanCapcomBrief } from '../src/collector/briefs.ts';
import { freshCapcomCheckpoint } from '../src/hub/capcom-checkpoint.ts';
import type { ProviderHandoffPlan } from '../src/shared/provider-handoff.ts';
import type { AgentHandle } from '../src/collector/commands.ts';
import type { Agent, Escalation, WorldState } from '../src/shared/types.ts';
import { test, ok } from './harness.ts';

const OLD = '11111111-2222-4333-8444-555555555555';
const NEW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function rig(runtime = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-fresh-isolated-'));
  const source = path.join(dir, 'source.jsonl');
  const line = runtime === 'codex' ? { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'HISTORICAL_CONVERSATION_SENTINEL' }] } }
    : { type: 'user', message: { content: 'HISTORICAL_CONVERSATION_SENTINEL' } };
  fs.writeFileSync(source, JSON.stringify(line) + '\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'PERSISTED_RULE_SENTINEL');
  const a = { id: OLD, sessionId: OLD, runtime, model: runtime === 'codex' ? 'gpt-6-astra' : 'opus', pane: `orca-${OLD}`, alive: true, state: 'idle', transcriptPath: source } as AgentHandle;
  let effective = a.model ?? null;
  const prompts: string[] = []; const holds: boolean[] = []; const activated: string[] = [];
  const deps = { dir: () => dir, agent: (id: string) => id === OLD ? a : null, owns: () => true, busy: () => false,
    model: () => effective, models: () => [], context: () => 'OLD_FLEET_CONTEXT_SENTINEL',
    hold: (_id: string, on: boolean) => { holds.push(on); },
    prepare: async (p: ProviderHandoffPlan, prompt: string) => { prompts.push(prompt); return { sessionId: NEW, receipt: `ORCA_HANDOFF_READY_${p.id}` }; },
    activate: async (_p: ProviderHandoffPlan, id: string) => { activated.push(id); },
  };
  const service = new ProviderHandoffs(deps);
  const settle = async () => { for (let i = 0; i < 100 && service.locked(OLD); i++) await Promise.resolve(); assert.equal(service.locked(OLD), false); };
  return { dir, source, a, deps, service, settle, prompts, holds, activated, model: (m: string) => { effective = m; }, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
export default { suite: 'Fresh CAPCOM', tests: [
  ...['codex', 'claude'].flatMap(runtime => (['clean', 'continuity'] as const).map(mode => test(`${runtime} ${mode} keeps effective model, exact archive, and excludes historical conversation`, async () => {
    const r = rig(runtime); try {
      r.model(runtime === 'codex' ? 'gpt-5.6-terra' : 'sonnet');
      const before = fs.readFileSync(r.source);
      const p = r.service.fresh(OLD, mode, 'PENDING_HUB_SENTINEL');
      await r.settle();
      assert.equal(r.service.status(p.id).phase, 'complete'); assert.equal(p.runtime, runtime);
      assert.equal(p.model, runtime === 'codex' ? 'gpt-5.6-terra' : 'sonnet');
      assert.deepEqual(r.activated, [NEW]); assert.deepEqual(r.holds, [true, false]);
      assert.deepEqual(fs.readFileSync(path.join(p.archive, 'source.jsonl')), before);
      assert.deepEqual(fs.readFileSync(r.source), before);
      assert.match(fs.readFileSync(p.historyPath, 'utf8'), /HISTORICAL_CONVERSATION_SENTINEL/);
      assert.equal(fs.readFileSync(path.join(r.dir, 'AGENTS.md'), 'utf8'), 'PERSISTED_RULE_SENTINEL');
      assert.ok(!r.prompts[0]!.includes('HISTORICAL_CONVERSATION_SENTINEL'));
      assert.ok(!r.prompts[0]!.includes('OLD_FLEET_CONTEXT_SENTINEL'));
      assert.ok(!r.prompts[0]!.includes('PERSISTED_RULE_SENTINEL'));
      assert.equal(r.prompts[0]!.includes('PENDING_HUB_SENTINEL'), mode === 'continuity');
      if (mode === 'clean') {
        assert.ok(!r.prompts[0]!.includes(OLD)); assert.ok(!r.prompts[0]!.includes(p.historyPath));
        assert.equal(fs.readFileSync(path.join(p.cwd!, 'AGENTS.md'), 'utf8'), cleanCapcomBrief());
      }
      return ok(`${runtime}/${p.model} ${mode}: new UUID, bounded context and intact archives`, true);
    } finally { r.dispose(); }
  }))),
  test('duplicate clicks share one preparation; conflicting mode and commit are rejected', async () => {
    const r = rig(); try {
      let release!: () => void;
      r.deps.prepare = async p => { await new Promise<void>(resolve => { release = resolve; }); return { sessionId: NEW, receipt: `ORCA_HANDOFF_READY_${p.id}` }; };
      const p = r.service.fresh(OLD, 'clean');
      assert.equal(r.service.fresh(OLD, 'clean').id, p.id);
      assert.throws(() => r.service.fresh(OLD, 'continuity'));
      assert.throws(() => r.service.commit(OLD, p.id));
      release(); await r.settle(); assert.deepEqual(r.activated, [NEW]);
      assert.throws(() => r.service.commit(OLD, p.id));
      return ok('one preparation and one activation despite duplicates', true);
    } finally { r.dispose(); }
  }),
  ...['quota', 'old UUID', 'bad receipt', 'source changed', 'model changed'].map(failure => test(`${failure} retains source and releases held messages`, async () => {
    const r = rig(); try {
      r.deps.prepare = async p => {
        if (failure === 'quota') throw Error('quota exhausted');
        if (failure === 'source changed') fs.appendFileSync(r.source, '\n');
        if (failure === 'model changed') r.model('different-model');
        return { sessionId: failure === 'old UUID' ? OLD : NEW, receipt: failure === 'bad receipt' ? 'ready maybe' : `ORCA_HANDOFF_READY_${p.id}` };
      };
      const p = r.service.fresh(OLD, 'clean'); await r.settle();
      assert.equal(r.service.status(p.id).phase, 'failed'); assert.deepEqual(r.activated, []);
      assert.deepEqual(r.holds, [true, false]); assert.ok(fs.existsSync(p.historyPath));
      return ok(`${failure}: no new authority, source retained`, true);
    } finally { r.dispose(); }
  })),
  test('busy or unknown model fails before preparing a runtime', () => {
    const r = rig(); try {
      r.a.state = 'working'; assert.throws(() => r.service.fresh(OLD, 'clean'), /Finish/);
      r.a.state = 'idle'; r.a.model = null; r.model('');
      assert.throws(() => r.service.fresh(OLD, 'clean'), /unknown/);
      assert.deepEqual(r.prompts, []); return ok('no fallback model or interruption', true);
    } finally { r.dispose(); }
  }),
  test('Codex activation verifies ready pane before cutover and clean watchdog resumes without briefing', async () => {
    const r = rig(); try {
      const calls: string[] = []; const argv: string[][] = [];
      const cap = new CapcomSession({ dir: r.dir, bin: '/fake/claude', codexBin: '/fake/codex', hubUrl: 'ws://127.0.0.1:1', token: '', trust: false,
        alive: () => false, note() {}, lineage: { noteSpawn() {}, bind() {}, demote() {} },
        tmux: { available: () => true,
          spawn: async p => { calls.push('spawn'); argv.push(p.argv); assert.equal(p.cwd, plan.cwd); return { ok: true, stdout: '', detail: '' }; },
          capture: async () => { calls.push('ready'); return { ok: true, stdout: '› Ask Codex to do anything\n  ? for shortcuts', detail: '' }; },
          kill: async name => { calls.push(`kill:${name}`); assert.equal(fs.existsSync(path.join(r.dir, 'codex-recovery.json')), false); return { ok: true, stdout: '', detail: '' }; },
        },
      });
      cap.adopt(OLD); const plan = r.service.review(OLD, 'codex', 'gpt-6-astra', '', 'clean');
      await cap.activateHandoff(plan, NEW);
      assert.equal(cap.current(), NEW); assert.equal(calls.at(-1), `kill:orca-${OLD}`);
      assert.deepEqual(argv[0]!.slice(0, 3), ['/fake/codex', 'resume', NEW]);
      assert.ok(argv[0]!.includes('gpt-6-astra'));
      assert.equal(cap.recovery()?.contextMode, 'clean'); assert.equal(cap.handoff('m')?.contextMode, 'clean');
      assert.equal(fs.readFileSync(path.join(plan.cwd!, 'CLAUDE.md'), 'utf8'), cleanCapcomBrief());
      assert.equal((await cap.ensure()).ok, true);
      assert.ok(!argv[1]!.some(arg => /briefing|reconcile|quota-blocked/.test(arg)));
      return ok('Codex isolated readiness, atomic UUID publication and clean resume policy', true);
    } finally { r.dispose(); }
  }),
  test('the archived transcript is not a second copy, and a superseded archive keeps its evidence without its bulk', () => {
    const r = rig();
    try {
      const live = r.service.review(OLD, 'codex', 'gpt-6-astra', '', 'clean');
      fs.writeFileSync(path.join(r.dir, 'codex-recovery.json'),
        JSON.stringify({ handoffId: live.id, archive: live.archive, sessionId: NEW, model: 'gpt-6-astra', runtime: 'codex' }));
      const stale = r.service.review(OLD, 'codex', 'gpt-6-astra', '', 'clean');
      const source = path.join(stale.archive, 'source.jsonl');
      const shared = fs.statSync(source).ino === fs.statSync(r.source).ino;
      assert.equal(fs.readFileSync(source, 'utf8'), fs.readFileSync(r.source, 'utf8'));
      const next = r.service.review(OLD, 'codex', 'gpt-6-astra', '', 'clean');
      assert.equal(fs.existsSync(source), false);
      assert.equal(fs.existsSync(stale.historyPath), false);
      assert.ok(fs.existsSync(path.join(stale.archive, 'plan.json')) && fs.existsSync(stale.checkpointPath)
        && fs.existsSync(path.join(stale.archive, 'manifest.json')));
      assert.match(fs.readFileSync(path.join(stale.archive, 'PRUNED.md'), 'utf8'), /source\.jsonl, conversation\.md/);
      assert.equal(r.service.status(stale.id).id, stale.id);
      // The activated handoff and the one being prepared are never touched.
      assert.ok(fs.existsSync(live.historyPath) && fs.existsSync(path.join(live.archive, 'source.jsonl')));
      assert.ok(fs.existsSync(next.historyPath) && fs.existsSync(path.join(next.archive, 'source.jsonl')));
      return ok('transcript archived by link; superseded bulk dropped, evidence and live archive intact',
        true, shared ? 'source.jsonl shares the transcript inode' : 'links refused here: fell back to a copy');
    } finally { r.dispose(); }
  }),
  test('the new destination directory is trusted before its pane opens, and a stuck resume keeps its screen', async () => {
    const r = rig(); const home = process.env['CODEX_HOME'];
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-codex-home-'));
    try {
      process.env['CODEX_HOME'] = codexHome;
      let atSpawn = '';
      const cap = new CapcomSession({ dir: r.dir, bin: '/fake/claude', codexBin: '/fake/codex', hubUrl: 'ws://127.0.0.1:1', token: '',
        alive: () => true, wait: async () => {}, note() {}, lineage: { noteSpawn() {}, bind() {}, demote() {} },
        tmux: { available: () => true,
          spawn: async () => { atSpawn = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'); return { ok: true, stdout: '', detail: '' }; },
          // The dialog an unwatched pane can never answer.
          capture: async () => ({ ok: true, stdout: 'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit', detail: '' }),
          kill: async () => ({ ok: true, stdout: '', detail: '' }),
        },
      });
      cap.adopt(OLD); const plan = r.service.review(OLD, 'codex', 'gpt-6-astra', '', 'clean');
      await assert.rejects(cap.activateHandoff(plan, NEW), /resume-screen\.txt/);
      assert.ok(atSpawn.includes(`[projects."${plan.cwd}"]`) && atSpawn.includes('trust_level = "trusted"'));
      assert.match(fs.readFileSync(path.join(plan.archive, 'resume-screen.txt'), 'utf8'), /Do you trust/);
      assert.equal(cap.current(), OLD);
      return ok('destination trusted before resume; its last screen survives the failure', true);
    } finally {
      if (home === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = home;
      fs.rmSync(codexHome, { recursive: true, force: true }); r.dispose();
    }
  }),
  ...['spawn', 'capture', 'stop', 'timeout'].map(failure => test(`activation ${failure} failure does not retire the old CAPCOM`, async () => {
    const r = rig(); try {
      const killed: string[] = []; const prior = JSON.stringify({ runtime: 'codex', sessionId: OLD, model: 'gpt-6-astra' });
      fs.writeFileSync(path.join(r.dir, 'codex-recovery.json'), prior);
      const cap = new CapcomSession({ dir: r.dir, bin: '/fake/claude', codexBin: '/fake/codex', hubUrl: 'ws://127.0.0.1:1', token: '', trust: false, alive: () => true, wait: async () => {}, note() {}, lineage: { noteSpawn() {}, bind() {}, demote() {} },
        tmux: { available: () => true, spawn: async () => ({ ok: failure !== 'spawn', stdout: '', detail: 'injected spawn' }),
          capture: async () => ({ ok: failure !== 'capture', stdout: failure === 'timeout' ? 'model: loading' : '› Ask Codex to do anything\n ? for shortcuts', detail: 'injected capture' }),
          kill: async name => { killed.push(name); return { ok: !(failure === 'stop' && name === `orca-${OLD}`), stdout: '', detail: 'injected stop' }; },
        },
      });
      cap.adopt(OLD); const plan = r.service.review(OLD, 'codex', 'gpt-6-astra', '', 'clean');
      await assert.rejects(cap.activateHandoff(plan, NEW));
      assert.equal(cap.current(), OLD); assert.equal(fs.readFileSync(path.join(r.dir, 'codex-recovery.json'), 'utf8'), prior);
      if (failure !== 'spawn') assert.equal(killed.at(-1), `orca-${NEW}`);
      if (failure === 'capture' || failure === 'timeout') assert.ok(!killed.includes(`orca-${OLD}`));
      return ok(`${failure}: old identity/config retained; destination cleaned up`, true);
    } finally { r.dispose(); }
  })),
  test('mail waits through destination visibility, drains once to new UUID; old backlog stays in hub', () => {
    let cap = { id: OLD, callsign: 'CAP' } as Agent;
    const sent: [string, string][] = []; const timers: (() => void)[] = [];
    const escalations = { old: { id: 'old', status: 'pending', askedAt: 9, agentId: 'worker', options: [], question: 'old' }, new: { id: 'new', status: 'pending', askedAt: 11, agentId: 'worker', options: [], question: 'new' } } as unknown as Record<string, Escalation>;
    const router = new CapcomRouter({ capcom: () => cap, say: (id, text) => { sent.push([id, text]); }, escalation: id => escalations[id], markWithCeo() {}, giveUp() {}, setTimer: fn => { timers.push(fn); return { cancel() {} }; } });
    router.beginTransfer(OLD, 'clean', 10);
    assert.equal(router.humanSays('new operator message'), 'queued');
    timers[0]!(); assert.equal(router.queued(), 1); // Slow startup never drops mail.
    cap = { id: NEW, callsign: 'CAP' } as Agent;
    assert.equal(router.flush(), 0); assert.equal(router.humanSays('new worker message'), 'queued');
    router.releaseTransfer(NEW); router.releaseTransfer(NEW); router.flush();
    assert.deepEqual(sent, [[NEW, 'new operator message'], [NEW, 'new worker message']]);
    assert.equal(router.offer('old'), false); assert.equal(router.offer('new'), true);
    assert.equal(escalations.old!.status, 'pending'); assert.equal(router.contextCutoff(), 10);
    return ok('FIFO exactly once, no premature dispatch, old questions retained without injection', true);
  }),
  test('failed clean transfer restores prior routing policy and delivers to original; late discovery holds mail', () => {
    let cap = { id: OLD, callsign: 'CAP' } as Agent; const sent: string[] = [];
    const router = new CapcomRouter({ capcom: () => cap, say: id => { sent.push(id); }, escalation: () => undefined, markWithCeo() {}, giveUp() {}, setTimer: () => ({ cancel() {} }) });
    router.beginTransfer(OLD, 'clean', 10); router.humanSays('retained'); router.releaseTransfer();
    assert.deepEqual(sent, [OLD]); assert.equal(router.contextCutoff(), null);
    router.beginTransfer(OLD, 'clean', 20); router.humanSays('new'); router.releaseTransfer(NEW);
    assert.equal(router.queued(), 1); assert.deepEqual(sent, [OLD]);
    cap = { id: NEW, callsign: 'CAP' } as Agent; router.flush();
    assert.deepEqual(sent, [OLD, NEW]); return ok('rollback and delayed target discovery retain mail', true);
  }),
  test('terminal input pauses during transfer and resumes on rollback', () => {
    const writes: string[] = []; const frames: unknown[] = []; let locked = false;
    const relay = new TerminalRelay({ agent: () => ({ id: OLD, pane: `orca-${OLD}`, callsign: 'CP' } as AgentHandle), inputBlocked: () => locked,
      send: f => { frames.push(f); }, tmux: { available: () => true, attach: () => ({ ok: true, tty: { write: (s: string) => writes.push(s), resize() {}, kill() {}, onData() {}, onExit() {} } }) } as unknown as TmuxHost,
    });
    const termId = 'term_fresh_fixture';
    relay.handle({ t: 'term:open', termId, agentId: OLD, cols: 80, rows: 24 });
    relay.handle({ t: 'term:input', termId, data: 'before' }); locked = true;
    relay.handle({ t: 'term:input', termId, data: 'must not dispatch' }); locked = false;
    relay.handle({ t: 'term:input', termId, data: 'after' });
    assert.deepEqual(writes, ['before', 'after']); assert.match(JSON.stringify(frames), /Send new messages through TALK/);
    relay.close(termId, 'fixture complete'); return ok('attached terminal cannot race fresh CAPCOM activation', true);
  }),
  test('interrupted preparation releases hold using the durable activated UUID', () => {
    const r = rig(); try {
      const p = r.service.review(OLD, 'codex', 'gpt-6-astra', '', 'clean');
      fs.writeFileSync(path.join(p.archive, 'plan.json'), JSON.stringify({ ...p, phase: 'preparing' }));
      fs.writeFileSync(path.join(r.dir, 'codex-recovery.json'), JSON.stringify({ handoffId: p.id, sessionId: NEW }));
      const resumed = new ProviderHandoffs(r.deps).status(p.id);
      assert.equal(resumed.phase, 'complete'); assert.equal(resumed.toId, NEW); assert.deepEqual(r.holds, [false]);
      return ok('status reconciles a persisted cutover without starting another runtime', true);
    } finally { r.dispose(); }
  }),
  test('continuity checkpoint is bounded metadata; histories and complete rules remain externally retrievable', () => {
    const world = { tasks: { task_a: { id: 'task_a', title: 'Pending title', status: 'active', agentIds: ['worker'], messages: [{ id: 'message_a', text: 'CONVERSATION_MUST_NOT_LEAK' }] } }, agents: {}, escalations: {} } as unknown as WorldState;
    const checkpoint = freshCapcomCheckpoint(world, []);
    assert.match(checkpoint, /task_a/); assert.match(checkpoint, /message_a/); assert.ok(!checkpoint.includes('CONVERSATION_MUST_NOT_LEAK'));
    assert.match(checkpoint, /recall/); assert.ok(checkpoint.length < 48 * 1024);
    return ok('pending references without full conversation', true);
  }),
] };
