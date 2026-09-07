import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, ok } from './harness.ts';
const exec = promisify(execFile);
const TARGET = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export default { suite: 'Fresh CAPCOM runtime process boundary', tests: ['codex', 'claude'].map(runtime => test(`${runtime} preparation executes isolated CLI with fresh identity and no ORCA environment`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-new-runtime-'));
  try {
    const bin = path.join(dir, runtime); const archive = path.join(dir, 'archive'); const cwd = path.join(dir, 'context');
    fs.mkdirSync(archive); fs.mkdirSync(cwd);
    const probe = path.join(dir, 'probe.json');
    fs.writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs'); let prompt = ''; process.stdin.on('data', c => prompt += c); process.stdin.on('end', () => { const args = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({args, prompt, cwd: process.cwd(), home: process.env.HOME, orca: Object.keys(process.env).filter(k => k.startsWith('ORCA_'))})); const receipt = 'ORCA_HANDOFF_READY_fixture'; if (${JSON.stringify(runtime)} === 'codex') { console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(TARGET)}})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:receipt}})); console.log(JSON.stringify({type:'turn.completed'})); } else console.log(JSON.stringify({session_id:args[args.indexOf('--session-id')+1],result:receipt})); });\n`, { mode: 0o700 });
    const p = { id: 'fixture', runtime, model: runtime === 'codex' ? 'gpt-6-astra' : 'sonnet', cwd, archive };
    const out = await exec(process.execPath, ['--import', 'tsx', 'test/capcom-new-runtime.fixture.ts', JSON.stringify(p)], {
      cwd: process.cwd(), timeout: 15000,
      env: { ...process.env, HOME: dir, CODEX_HOME: dir, CLAUDE_CONFIG_DIR: dir, ORCA_CODEX_BIN: bin, ORCA_CLAUDE_BIN: bin, ORCA_TOKEN: 'MUST_NOT_REACH_PREPARATION' },
    });
    const result = JSON.parse(out.stdout); const seen = JSON.parse(fs.readFileSync(probe, 'utf8'));
    assert.deepEqual(seen.orca, []); assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(cwd)); assert.equal(seen.home, dir);
    assert.ok(seen.args.includes(p.model)); assert.ok(!seen.args.some((a: string) => ['resume', '--resume', '--continue'].includes(a)));
    assert.equal(result.receipt, 'ORCA_HANDOFF_READY_fixture');
    if (runtime === 'codex') { assert.equal(result.sessionId, TARGET); assert.ok(seen.args.includes('--ignore-user-config')); assert.ok(seen.args.includes('read-only')); }
    else { assert.match(result.sessionId, /^[a-f0-9-]{36}$/); assert.equal(seen.args[seen.args.indexOf('--tools') + 1], ''); assert.ok(seen.args.includes('{"mcpServers":{}}')); }
    assert.ok(fs.existsSync(path.join(archive, 'preparation.jsonl')));
    return ok(`${runtime}: real subprocess transport with isolated fake CLI, fresh ID, model and environment boundaries`, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})) };
