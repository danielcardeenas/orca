import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from '../src/hub/world.ts';
import { runTool, type CeoContext } from '../src/agents/tools.ts';
import type { Escalation } from '../src/shared/types.ts';
import { promptOn, permissionClosed } from '../src/collector/screen.ts';
import { answerPermission, type PermissionRequest } from '../src/collector/permissions.ts';
import { TmuxHost } from '../src/collector/tmux.ts';
import { test, ok, sleep, type TestModule } from './harness.ts';

// Codex 0.153.4 dialog wording reported by the operator; argument values are synthetic.
const SHELL = `Would you like to run the following command?

  Reason: isolated fixture
  $ printf fixture-a

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with printf
  3. No, and tell Codex what to do differently (esc)

  enter to submit | esc to cancel`;
const MCP = `Allow the playwright MCP server to run tool "browser_tabs"?
  action: new
  url: https://example.invalid/?token=secret-canary
  local: false
  1.Allow
  2.Allow for this session
› 3.Always allow
  4.Cancel
enter to submit | esc to cancel`;
const CLAUDE = `Bash command
│ printf fixture-a
Contains shell syntax (string) that cannot be statically analyzed
Do you want to proceed?
  1. Yes
❯ 2. Yes, and don’t ask again for: printf *
  3. No
Esc to cancel · Tab to amend`;
const request = (screen: string): PermissionRequest => ({ agentId: 'agent', sessionId: 'session', pane: 'orca-fixture', identity: 'identity', fingerprint: promptOn(screen)!.fingerprint, claimed: false });

const tests = [
  test('native captured Claude/Codex screens detect permissions and observable closure', () => {
    for (const [before, after] of [['claude-bash-2.1.263', 'claude-bash-confirmed-2.1.263'], ['codex-shell-0.153.4', 'codex-shell-confirmed-0.153.4'], ['codex-mcp-0.153.4', 'codex-mcp-confirmed-0.153.4']]) {
      const read = (name: string) => readFileSync(new URL(`./fixtures/permissions/${name}.txt`, import.meta.url), 'utf8');
      assert.equal(promptOn(read(before!))?.onceKey, '1', before);
      assert.equal(promptOn(read(after!)), null, after);
      assert.equal(permissionClosed(read(after!)), true, after);
    }
    for (const name of ['claude-bash-denied-2.1.263', 'codex-shell-denied-0.153.4', 'codex-mcp-denied-0.153.4']) {
      const screen = readFileSync(new URL(`./fixtures/permissions/${name}.txt`, import.meta.url), 'utf8');
      assert.equal(promptOn(screen), null); assert.equal(permissionClosed(screen), true);
    }
    return ok('native dialogs and returned CLI inputs recognized', true);
  }),
  test('real dialog wordings: Claude, Codex shell and MCP; once ignores selection', () => {
    for (const s of [SHELL, MCP, CLAUDE]) {
      const p = promptOn(s); assert.equal(p?.kind, 'permission'); assert.equal(p.onceKey, '1');
    }
    assert(!promptOn(MCP)!.summary.includes('secret-canary'));
    assert.notEqual(promptOn(CLAUDE)!.fingerprint, promptOn(CLAUDE.replace('fixture-a', 'fixture-b'))!.fingerprint);
    assert.equal(promptOn(MCP)!.fingerprint, promptOn(MCP.replace('› 3.', '  3.').replace('  1.', '› 1.'))!.fingerprint);
    return ok('three formats, secrets omitted, selection-independent fingerprint', true);
  }),
  test('reject truncated, unknown, historical and ordinary screens', () => {
    for (const s of [SHELL.replace('enter to submit | esc to cancel', ''), SHELL.replace('$ printf fixture-a', ''), MCP.replace('  4.Cancel', ''), MCP.replace('1.Allow', '1.Do it forever'), '› ordinary prompt', `${MCP}\n› What next?`, `${CLAUDE}\n⏺ Done\n❯`]) assert.equal(promptOn(s), null, s);
    return ok('fail closed', true);
  }),
  test('human first, changed request, wrong pane/agent and double answer send no extra keys', async () => {
    for (const screen of ['› ', MCP.replace('action: new', 'action: close')]) {
      let keys = 0; let retired = false;
      const result = await answerPermission(request(MCP), 'allow', { current: () => true, view: async () => ({ identity: 'identity', screen }), key: async () => { keys++; return { ok: true, detail: '' }; }, retire: () => { retired = true; }, pending() {} });
      assert.equal(result.ok, false); assert.equal(keys, 0); assert(retired);
    }
    for (const mismatch of ['pane', 'agent']) {
      let keys = 0;
      await answerPermission(request(MCP), 'allow', { current: () => mismatch !== 'agent', view: async () => ({ identity: 'other', screen: MCP }), key: async () => { keys++; return { ok: true, detail: '' }; }, retire() {}, pending() {} });
      assert.equal(keys, 0);
    }
    const r = request(MCP); const keys: string[] = [];
    const io = { current: () => true, view: async () => ({ identity: 'identity', screen: MCP }), key: async (_: string, key: string) => { keys.push(key); return { ok: true, detail: '' }; }, retire() {}, pending() {} };
    const replies = await Promise.all([answerPermission(r, 'allow', io), answerPermission(r, 'deny', io)]);
    assert.deepEqual(keys, ['1']); assert.equal(replies[1]!.ok, false); assert.match(replies[0]!.detail, /pending/);
    return ok('stale and duplicate requests never act', true);
  }),
  test('once/deny use exactly one digit or Escape, never Enter; invalid answer does not consume', async () => {
    for (const s of [SHELL, MCP, CLAUDE]) for (const answer of ['allow', 'deny']) {
      const keys: string[] = []; const r = request(s);
      const io = { current: () => true, view: async () => ({ identity: 'identity', screen: s }), key: async (_: string, key: string) => { keys.push(key); return { ok: true, detail: '' }; }, retire() {}, pending() {} };
      assert.equal((await answerPermission(r, 'always', io)).ok, false);
      await answerPermission(r, answer, io); assert.deepEqual(keys, [answer === 'allow' ? '1' : 'Escape']);
    }
    return ok('bounded keys', true);
  }),
  test('hub keeps response pending, retires A for B and rejects stale reconnect snapshots', async () => {
    const world = new World();
    const escalation: Escalation = { id: 'esc_permission_a', agentId: 'agent', machineId: 'machine', projectId: 'project', question: 'Permission', context: null, options: ['allow', 'deny'], optionsOnly: true, urgency: 'blocking', status: 'pending', ceoAttempt: null, answer: null, answeredBy: null, rememberAs: null, askedAt: Date.now(), answeredAt: null, expiresAt: null, permission: { phase: 'requested', fingerprint: request(MCP).fingerprint } };
    const receive = (e: Escalation) => world.applyCollector({ t: 'escalation', machineId: 'machine', escalation: e }, 'machine');
    receive(escalation);
    let calls = 0;
    const ctx = { escalation: (id: string) => world.state.escalations[id], resolveEscalation: (id: string) => { calls++; world.requestPermissionAnswer(id); } } as unknown as CeoContext;
    const first = await runTool(ctx, 'answer_agent', { escalation_id: escalation.id, answer: 'allow', basis: 'isolated mission' });
    assert.equal(JSON.parse(first.result).confirmed, false);
    assert.equal(world.state.escalations[escalation.id]!.status, 'pending');
    assert.equal(world.state.escalations[escalation.id]!.answeredAt, null);
    assert.equal((await runTool(ctx, 'answer_agent', { escalation_id: escalation.id, answer: 'allow' })).isError, true);
    assert.equal(calls, 1);
    receive(escalation); // delayed requested frame cannot make it actionable again
    assert.equal(world.state.escalations[escalation.id]!.permission?.phase, 'pending');
    receive({ ...escalation, id: 'esc_permission_b' });
    assert.equal(world.state.escalations[escalation.id]!.status, 'withdrawn');
    receive(escalation);
    assert.equal(world.state.escalations[escalation.id]!.status, 'withdrawn');
    receive({ ...escalation, id: 'esc_permission_b', status: 'answered', permission: { ...escalation.permission!, phase: 'confirmed' } });
    assert.equal(world.state.escalations['esc_permission_b']!.permission?.phase, 'confirmed');
    assert(permissionClosed('Work complete\n› '));
    assert(!permissionClosed(MCP)); assert(!permissionClosed('partial redraw'));
    return ok('pending is not answered; replaced/closed requests cannot replay', true);
  }),
  test('isolated real tmux: exact pane, raw bytes, durable no replay across host reconnect', async () => {
    const host = new TmuxHost(`orca-permission-test-${process.pid}`);
    assert(host.available(), 'tmux required for this integration test');
    try {
      for (const [n, screen] of [SHELL, MCP, CLAUDE].entries()) for (const answer of ['allow', 'deny']) {
        const name = `orca-permission-${n}-${answer}`;
        const program = `process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write(${JSON.stringify(screen)});process.stdin.on('data',b=>process.stdout.write('\\r\\nBYTES:'+b.toString('hex')+'\\r\\n'));`;
        assert((await host.spawn({ name, cwd: '/tmp', env: {}, argv: [process.execPath, '-e', program], cols: 160, rows: 45 })).ok);
        let view = await host.permissionView(name);
        for (let i = 0; i < 30 && !promptOn(view?.screen ?? ''); i++) { await sleep(50); view = await host.permissionView(name); }
        assert(view); const p = promptOn(view.screen); assert(p, view.screen);
        const r = { ...request(screen), pane: name, identity: view.identity, fingerprint: p.fingerprint };
        const response = await answerPermission(r, answer, { current: () => true, view: () => host.permissionView(name), key: async (id, key) => {
          const competing = new TmuxHost(host.socket);
          const sends = await Promise.all([host.permissionKey(id, key, r.fingerprint), competing.permissionKey(id, key, r.fingerprint)]);
          assert.equal(sends.filter(s => s.ok).length, 1, 'only one collector may deliver');
          return sends.find(s => s.ok)!;
        }, retire() {}, pending() {} });
        assert(response.ok, response.detail);
        await sleep(120);
        const after = await host.permissionView(name); assert(after);
        assert(after.screen.includes(`BYTES:${answer === 'allow' ? '31' : '1b'}`), after.screen);
        assert(!after.screen.includes('BYTES:0d')); assert(!after.screen.includes('BYTES:0a'));
        const reconnected = new TmuxHost(host.socket);
        assert.equal((await reconnected.permissionView(name))?.claimedFingerprint, r.fingerprint);
        assert.equal((await reconnected.permissionKey(r.identity, '1', r.fingerprint)).ok, false);
      }
      return ok('isolated tmux verified six deliveries and six replay rejections', true);
    } finally { await host.killServer(); }
  }),
];
export default { suite: 'permission lifecycle', tests } satisfies TestModule;
