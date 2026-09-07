import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderHandoffs, transcriptMarkdown } from '../src/collector/provider-handoff.ts';
import type { AgentHandle } from '../src/collector/commands.ts';
import { CapcomSession } from '../src/collector/capcom.ts';
import { test, ok } from './harness.ts';
const sourceId = '11111111-2222-4333-8444-555555555555';
const targetId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-provider-'));
  const source = path.join(dir, 'source.jsonl');
  fs.writeFileSync(source, JSON.stringify({ type: 'response_item', timestamp: '2026-09-06T01:00:00Z', payload: { type: 'message', role: 'user', content: [{ text: 'Do not lose the hygiene task.' }] } }) + '\n');
  const a = { id: sourceId, sessionId: sourceId, runtime: 'codex', model: 'gpt-6-astra', pane: 'orca-source', alive: true, state: 'idle', transcriptPath: source } as AgentHandle;
  const holds: boolean[] = []; const activations: string[] = [];
  const deps = { dir: () => dir, agent: () => a, owns: () => true, context: () => 'Pending: hygiene', busy: () => false,
    models: () => [{ runtime: 'claude' as const, id: 'sonnet', label: 'Sonnet', installed: true }],
    hold: (_id: string, on: boolean) => { holds.push(on); },
    activate: async (_p: unknown, id: string) => { activations.push(id); },
    prepare: async (p: { id: string }, prompt: string) => { assert.match(prompt, /Do not lose the hygiene task/); return { sessionId: targetId, receipt: `Pending hygiene. ORCA_HANDOFF_READY_${p.id}` }; },
  };
  const service = new ProviderHandoffs(deps);
  async function settle() { for (let i = 0; i < 100 && service.locked(a.id); i++) await Promise.resolve(); }
  return { dir, source, a, deps, service, settle, holds, activations, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
export default { suite: 'Provider handoff', tests: [
  test('review archives exact bytes and requires confirmation before destination preparation', async () => {
    const r = rig(); try {
      const plan = r.service.review(r.a.id, 'claude', 'sonnet', 'task-123 remains pending');
      assert.deepEqual(fs.readFileSync(path.join(plan.archive, 'source.jsonl')), fs.readFileSync(r.source));
      assert.match(fs.readFileSync(plan.checkpointPath, 'utf8'), /task-123/);
      assert.equal(r.activations.length, 0); assert.equal(r.holds.length, 0);
      r.service.commit(r.a.id, plan.id); await r.settle();
      assert.equal(r.service.status(plan.id).phase, 'complete'); assert.deepEqual(r.activations, [targetId]); assert.deepEqual(r.holds, [true, false]);
      return ok('backup, explicit commit, receipt, activation', true);
    } finally { r.dispose(); }
  }),
  test('a recovery record pointing at a deleted archive prepares from the transcript instead of failing', () => {
    const r = rig(); try {
      const gone = path.join(r.dir, 'pruned', 'conversation.md');
      fs.writeFileSync(path.join(r.dir, 'codex-recovery.json'), JSON.stringify({ sessionId: sourceId, historyPath: gone, checkpointPath: path.join(r.dir, 'pruned', 'HANDOFF.md') }));
      assert.equal(fs.existsSync(gone), false);
      const plan = r.service.review(r.a.id, 'claude', 'sonnet');
      assert.match(fs.readFileSync(plan.historyPath, 'utf8'), /Do not lose the hygiene task/);
      return ok('missing earlier history degrades to empty, transcript still archived', true);
    } finally { r.dispose(); }
  }),
  test('changed source, changed backup and same-provider requests fail closed', () => {
    const r = rig(); try {
      assert.throws(() => r.service.review(r.a.id, 'codex', 'gpt-6-astra'), /same-session/);
      const p = r.service.review(r.a.id, 'claude', 'sonnet');
      fs.appendFileSync(p.historyPath, 'tampered'); assert.throws(() => r.service.commit(r.a.id, p.id), /integrity/);
      const p2 = r.service.review(r.a.id, 'claude', 'sonnet'); fs.appendFileSync(r.source, '\n');
      assert.throws(() => r.service.commit(r.a.id, p2.id), /conversation changed/);
      assert.equal(r.activations.length, 0); return ok('no stale or altered context activated', true);
    } finally { r.dispose(); }
  }),
  test('quota failure retains old session, releases held mail and persists failure', async () => {
    const r = rig(); try {
      r.deps.prepare = async () => { throw new Error('quota exhausted'); };
      const p = r.service.review(r.a.id, 'claude', 'sonnet'); r.service.commit(r.a.id, p.id); await r.settle();
      assert.equal(r.service.status(p.id).phase, 'failed'); assert.equal(r.activations.length, 0); assert.deepEqual(r.holds, [true, false]);
      assert.equal(new ProviderHandoffs(r.deps).status(p.id).phase, 'failed');
      assert.ok(fs.existsSync(p.historyPath)); return ok('quota failure preserves coordinator and archive', true);
    } finally { r.dispose(); }
  }),
  test('archive history pagination joins prior and current messages without dropping text', () => {
    const r = rig(); try {
      const prior = path.join(r.dir, 'prior.md');
      fs.writeFileSync(prior, Array.from({ length: 30 }, (_, i) => `## 2026-09-05T01:00:00Z · user · old\n\nMessage ${i}\n\n`).join(''));
      fs.writeFileSync(path.join(r.dir, 'codex-recovery.json'), JSON.stringify({ historyPath: prior }));
      let offset: number | null = 0; let text = ''; let pages = 0;
      while (offset !== null) { const p = r.service.history(r.a.id, offset, Date.now()); text = p.text + text; offset = p.next; pages++; }
      assert.equal(pages, 3); assert.match(text, /Message 0/); assert.match(text, /Message 29/); assert.match(text, /hygiene task/);
      assert.throws(() => transcriptMarkdown('{incomplete', 'claude', sourceId));
      return ok('all archived pages are retrievable', true);
    } finally { r.dispose(); }
  }),
  test('activation resumes the prepared Claude id and stops old pane only after destination readiness', async () => {
    const r = rig(); try {
      const calls: string[] = [];
      const cap = new CapcomSession({ dir: r.dir, bin: '/fake/claude', hubUrl: 'ws://localhost:4479', token: '', alive: () => true, note() {},
        lineage: { noteSpawn() {}, demote() {}, bind() {} }, tmux: { available: () => true,
          spawn: async p => { calls.push('spawn'); assert.ok(p.argv.includes('--resume')); assert.ok(p.argv.includes(targetId)); return { ok: true, stdout: '', detail: '' }; },
          capture: async () => { calls.push('ready'); return { ok: true, stdout: '❯ ', detail: '' }; },
          kill: async name => { calls.push(`kill:${name}`); return { ok: true, stdout: '', detail: '' }; },
        },
      });
      cap.adopt(sourceId); const p = r.service.review(r.a.id, 'claude', 'sonnet');
      await cap.activateHandoff(p, targetId);
      assert.equal(cap.current(), targetId); assert.equal(calls[0], 'spawn'); assert.ok(calls.slice(1, -1).every(c => c === 'ready')); assert.equal(calls.at(-1), `kill:orca-${sourceId}`);
      assert.equal(cap.recovery()?.runtime, 'claude'); assert.equal(cap.handoff('machine')?.toRuntime, 'claude');
      return ok('verified destination before cutover, runtime-aware resume', true);
    } finally { r.dispose(); }
  }),
  test('destination startup failure leaves original coordinator and recovery configuration intact', async () => {
    const r = rig(); try {
      const killed: string[] = [];
      const config = JSON.stringify({ sessionId: sourceId, model: 'gpt-6-astra' });
      fs.writeFileSync(path.join(r.dir, 'codex-recovery.json'), config);
      const cap = new CapcomSession({ dir: r.dir, bin: '/fake/claude', hubUrl: 'ws://localhost:4479', token: '', alive: () => true, note() {},
        lineage: { noteSpawn() {}, demote() {}, bind() {} }, tmux: { available: () => true,
          spawn: async () => ({ ok: true, stdout: '', detail: '' }),
          capture: async () => ({ ok: false, stdout: '', detail: 'CLI exited' }),
          kill: async name => { killed.push(name); return { ok: true, stdout: '', detail: '' }; },
        },
      });
      cap.adopt(sourceId); const p = r.service.review(r.a.id, 'claude', 'sonnet');
      await assert.rejects(cap.activateHandoff(p, targetId), /Destination terminal unavailable/);
      assert.equal(cap.current(), sourceId); assert.deepEqual(killed, [`orca-${targetId}`]);
      assert.equal(fs.readFileSync(path.join(r.dir, 'codex-recovery.json'), 'utf8'), config);
      return ok('failed destination never stops the original', true);
    } finally { r.dispose(); }
  }),
] };
