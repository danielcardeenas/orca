import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CapcomSession } from '../src/collector/capcom.ts';
import { SessionDeriver } from '../src/collector/derive.ts';
import { test, ok } from './harness.ts';

const ID = '11111111-2222-4333-8444-555555555555';
export default { suite: 'CAPCOM recovery', tests: [
  test('Codex relaunch resumes the prepared thread with MCP and bounded retries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcom-recovery-'));
    try {
      fs.writeFileSync(path.join(dir, 'codex-recovery.json'), JSON.stringify({ sessionId: ID, model: 'gpt-6-astra' }));
      let now = 100000;
      const launches: string[][] = [];
      const cap = new CapcomSession({ dir, bin: '/fake/claude', codexBin: '/fake/codex',
        hubUrl: 'ws://localhost:4479', token: 'tok', trust: false, now: () => now,
        alive: () => false, note: () => {},
        lineage: { noteSpawn: () => {}, bind: () => {}, demote: () => {} },
        tmux: { available: () => true, spawn: async p => {
          launches.push(p.argv); assert.equal(p.name, `orca-${ID}`);
          return { ok: true, stdout: '', detail: '' };
        } },
      });
      assert.equal((await cap.ensure()).ok, true);
      assert.deepEqual(launches[0]?.slice(0, 3), ['/fake/codex', 'resume', ID]);
      assert.ok(launches[0]?.includes('gpt-6-astra'));
      assert.ok(launches[0]?.includes('--approve-for-me'));
      assert.ok(!launches[0]?.includes('-s')); // CLI rejects sandbox + approve-for-me.
      assert.ok(launches[0]?.includes('mcp_servers.orca.required=true'));
      assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes('briefing'));
      cap.check(); // Rollout/liveness grace: no duplicate session.
      assert.equal(launches.length, 1);
      for (let i = 0; i < 5; i++) { now += 100000; await cap.ensure(); }
      assert.equal(launches.length, 5);
      return ok('same Codex thread, MCP configuration, grace and restart cap', true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }),
  test('prepared Codex identity supersedes remembered Claude on restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcom-recovery-'));
    try {
      fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ shortId: 'old-claude' }));
      fs.writeFileSync(path.join(dir, 'codex-recovery.json'), JSON.stringify({ sessionId: ID, model: 'gpt-6-astra' }));
      let adopted = '';
      const cap = new CapcomSession({ dir, bin: null, hubUrl: 'ws://localhost:4479', token: '', trust: false,
        alive: () => true, note: () => {},
        lineage: { noteSpawn: id => { adopted = id; }, bind: () => {}, demote: () => {} },
      });
      assert.equal((await cap.ensure()).shortId, ID);
      assert.equal(adopted, ID);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).shortId, ID);
      assert.equal((await cap.rotate({ turns: 50, compactions: 4, contextTokens: 100000 })).ok, false);
      assert.equal(cap.current(), ID);
      return ok('Codex retained and never rotated into Claude', true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }),
  test('invalid handoff fails closed even when Claude is alive', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capcom-recovery-'));
    try {
      fs.writeFileSync(path.join(dir, 'codex-recovery.json'), JSON.stringify({ sessionId: 'claude-short', model: 'gpt-6-astra' }));
      const cap = new CapcomSession({ dir, bin: null, hubUrl: 'ws://localhost:4479', token: '', trust: false,
        alive: () => true, note: () => {},
        lineage: { noteSpawn: () => { throw Error('must not adopt'); }, bind: () => {}, demote: () => {} },
      });
      await assert.rejects(cap.ensure(), /invalid codex-recovery/);
      cap.check();
      assert.equal(cap.current(), null);
      return ok('invalid recovery does not fall back', true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }),
  test('real Claude quota error stays blocked until successful assistant output', () => {
    const ref = { path: '/tmp/fixture.jsonl', slug: '-tmp-fixture', sessionId: ID, key: ID, agentId: null, metaPath: null, workflowId: null };
    const d = new SessionDeriver(ref, 'm', 'p');
    let at = Date.now();
    const ingest = (line: Record<string, unknown>) => d.ingest({ ref, lines: [{ ...line, timestamp: new Date(++at).toISOString() }], bootstrap: false, mtimeMs: at, at });
    const message = { model: 'claude-fable-5-1', content: [{ type: 'text', text: 'ready' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 10 } };
    ingest({ type: 'assistant', message });
    ingest({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
      message: { ...message, model: '<synthetic>', content: [{ type: 'text', text: "You've reached your Fable limit." }], usage: { input_tokens: 0, output_tokens: 0 } } });
    assert.equal(d.state(at), 'blocked');
    assert.equal(d.blockOf(at)?.kind, 'error');
    assert.match(d.blockOf(at)?.summary ?? '', /rate_limit/);
    assert.equal(d.snapshot(at).model, 'claude-fable-5-1');
    assert.equal(d.metrics(at).contextTokens, 1000);
    ingest({ type: 'user', message: { content: 'retry' } });
    assert.equal(d.state(at), 'blocked');
    ingest({ type: 'assistant', message });
    assert.equal(d.blockOf(at), null);
    assert.equal(d.state(at), 'idle');
    return ok('quota classified and recovery requires real progress', true);
  }),
] };
