/**
 * `orca-spawn`: an agent asking for another agent, from the file up.
 *
 * What is worth proving, because each of these fails in silence:
 *
 *  1. The policy. The child's parent and squad come from the ASKER, never the
 *     file; the caps refuse with a reason; a squad named by an agent already
 *     in one is ignored.
 *  2. The watcher. A request file is validated, emitted, answered, and
 *     removed; junk is answered with a refusal and removed; a request whose
 *     ack already exists is not launched twice.
 *  3. The CLI. `orca-spawn` writes what the watcher reads, and reads what the
 *     collector writes, with the exit code the ack implies.
 *
 * All in temporary directories. Nothing here launches a real CLI.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  MAX_CHILDREN, MAX_SQUAD, SpawnWatcher, planChild, writeAck, type SpawnRequest,
} from '../src/collector/spawns.ts';
import { ok, eq, test, until, type TestModule } from './harness.ts';

const BIN = resolve(import.meta.dirname, '..', 'bin', 'orca-spawn.mjs');

function temp(): string { return mkdtempSync(join(tmpdir(), 'orca-spawns-')); }

function request(over: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    id: 'spawn_1', projectId: 'p1', requesterId: 'lead',
    mission: 'Migrate the charges table to the new schema without changing the public API.',
    squad: null, model: null, at: Date.now(), ackFile: '/dev/null',
    ...over,
  };
}

const lead = { id: 'lead', callsign: 'K9', squad: 'audit-01', liveChildren: 2 };

/* ── 1 · policy ───────────────────────────────────────────────────── */

const policy = [
  test('the child is parented to the asker and joins the asker\'s squad, never a lead', () => {
    const plan = planChild(request({ squad: 'other-01' }), lead, () => 3);
    const cmd = plan.ok ? plan.cmd as { parentId: string; squad?: string; lead?: boolean; background: boolean } : null;
    return ok(
      'the child is the asker\'s, in the asker\'s squad',
      plan.ok && cmd?.parentId === 'lead' && cmd?.squad === 'audit-01' && cmd?.lead === false && cmd?.background === true,
      plan.ok ? JSON.stringify(cmd) : plan.reason,
    );
  }),

  test('an asker in no squad may name one; the child carries it', () => {
    const plan = planChild(request({ squad: 'fresh-01' }), { ...lead, squad: null }, () => 0);
    const cmd = plan.ok ? plan.cmd as { squad?: string } : null;
    return eq('a squad named by a squadless asker is honoured', plan.ok ? cmd?.squad : 'refused', 'fresh-01');
  }),

  test('too many live children is refused, with the cap in the reason', () => {
    const plan = planChild(request(), { ...lead, liveChildren: MAX_CHILDREN }, () => 0);
    return ok('too many children is refused', !plan.ok && plan.reason.includes(String(MAX_CHILDREN)), plan.ok ? 'launched' : plan.reason);
  }),

  test('a full squad is refused, with the cap in the reason', () => {
    const plan = planChild(request(), lead, () => MAX_SQUAD);
    return ok('a full squad is refused', !plan.ok && plan.reason.includes(String(MAX_SQUAD)), plan.ok ? 'launched' : plan.reason);
  }),

  test('an asker nobody can identify is refused and told how to fix it', () => {
    const plan = planChild(request({ requesterId: null }), null, () => 0);
    return ok('an unknown asker is refused', !plan.ok && plan.reason.includes('--agent'), plan.ok ? 'launched' : plan.reason);
  }),
];

/* ── 2 · watcher ──────────────────────────────────────────────────── */

function watcherIn(dir: string, resolveTo: string | null = 'lead') {
  const w = new SpawnWatcher({ resolveAgent: () => resolveTo });
  w.track('p1', dir);
  return w;
}

const watcher = [
  test('a request file is emitted once, answered, and removed', async () => {
    const dir = temp();
    try {
      const spawnDir = join(dir, '.orca', 'spawn');
      mkdirSync(spawnDir, { recursive: true });
      writeFileSync(join(spawnDir, 'spawn_a.json'), JSON.stringify({
        mission: 'Audit the sandbox endpoints for the 402 regression and report which cards trip it.',
        agentId: 'lead', at: Date.now(),
      }));
      const w = watcherIn(dir);
      const seen: SpawnRequest[] = [];
      w.onRequest(async (r) => {
        seen.push(r);
        await writeAck(r.ackFile, { ok: true, agentId: 'child', callsign: 'T4', shortId: 'ab12', squad: 'audit-01', parentId: 'lead', at: Date.now() });
      });
      await w.scan();
      await w.scan();
      const left = readdirSync(spawnDir);
      return ok(
        'a request file is emitted once, answered, and removed',
        seen.length === 1 && seen[0]?.requesterId === 'lead' && seen[0]?.mission.startsWith('Audit the sandbox')
          && left.length === 1 && left[0] === 'spawn_a.ack.json',
        `${seen.length} emitted · left: ${left.join(', ')}`,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('junk is answered with a refusal and removed, and never reaches the handler', async () => {
    const dir = temp();
    try {
      const spawnDir = join(dir, '.orca', 'spawn');
      mkdirSync(spawnDir, { recursive: true });
      writeFileSync(join(spawnDir, 'spawn_thin.json'), JSON.stringify({ mission: 'fix it', agentId: 'lead' }));
      writeFileSync(join(spawnDir, 'spawn_squad.json'), JSON.stringify({ mission: 'A brief long enough to be taken seriously.', squad: 'not ok!' }));
      const w = watcherIn(dir);
      let handled = 0;
      w.onRequest(() => { handled++; });
      await w.scan();
      const left = readdirSync(spawnDir).sort();
      return ok(
        'junk is refused in the ack and removed',
        handled === 0 && left.length === 2 && left.every((f) => f.endsWith('.ack.json')),
        left.join(', '),
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('a request whose ack already exists is not launched a second time', async () => {
    const dir = temp();
    try {
      const spawnDir = join(dir, '.orca', 'spawn');
      mkdirSync(spawnDir, { recursive: true });
      writeFileSync(join(spawnDir, 'spawn_b.json'), JSON.stringify({ mission: 'A brief long enough to be taken seriously by the watcher.' }));
      writeFileSync(join(spawnDir, 'spawn_b.ack.json'), JSON.stringify({ ok: true, at: Date.now() }));
      const w = watcherIn(dir);
      let handled = 0;
      w.onRequest(() => { handled++; });
      await w.scan();
      return ok(
        'an already-acked request is not launched twice',
        handled === 0 && !existsSync(join(spawnDir, 'spawn_b.json')) && existsSync(join(spawnDir, 'spawn_b.ack.json')),
        `handled ${handled}`,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),
];

/* ── 3 · the CLI ──────────────────────────────────────────────────── */

interface Run { code: number; stdout: string; stderr: string }

function run(args: string[], cwd: string, home: string): Promise<Run> {
  return new Promise((done) => {
    execFile('node', [BIN, ...args], {
      cwd, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, ORCA_HOME: home, CLAUDE_SESSION_ID: 'sess-lead' },
    }, (err, stdout, stderr) => {
      const code = err ? (err as { code?: number }).code ?? -1 : 0;
      done({ code: typeof code === 'number' ? code : -1, stdout, stderr });
    });
  });
}

const cli = [
  test('orca-spawn writes what the watcher reads and reads what the collector writes', async () => {
    const dir = temp();
    try {
      const home = join(dir, 'home');
      mkdirSync(home, { recursive: true });
      const project = join(dir, 'repo');
      mkdirSync(project, { recursive: true });
      const spawnDir = join(project, '.orca', 'spawn');

      // Play the collector: answer the first request that appears.
      const collector = (async () => {
        const arrived = await until(() => existsSync(spawnDir) && readdirSync(spawnDir).some((f) => f.endsWith('.json') && !f.endsWith('.ack.json')), 10_000, 50);
        if (!arrived) return null;
        const file = readdirSync(spawnDir).find((f) => f.endsWith('.json') && !f.endsWith('.ack.json'))!;
        const w = new SpawnWatcher({ resolveAgent: (_p, hint) => hint });
        w.track('p1', project);
        let got: SpawnRequest | null = null;
        w.onRequest(async (r) => {
          got = r;
          await writeAck(r.ackFile, { ok: true, agentId: 'child', callsign: 'T4', shortId: 'ab12', squad: 'audit-01', parentId: r.requesterId, at: Date.now() });
        });
        await w.scan();
        return { file, got: got as SpawnRequest | null };
      })();

      const r = await run(['Migrate the charges table to the new schema without changing the public API.', '--project', project, '--timeout', '15', '--json'], project, home);
      const c = await collector;
      const ack = JSON.parse(r.stdout || '{}') as { ok?: boolean; callsign?: string };
      return ok(
        'orca-spawn round-trips through the watcher',
        r.code === 0 && ack.ok === true && ack.callsign === 'T4'
          && c?.got?.requesterId === 'sess-lead' && c?.got?.mission.startsWith('Migrate the charges'),
        `exit ${r.code} · ${r.stdout.trim().slice(0, 80)}${r.stderr ? ` · ${r.stderr.trim().slice(0, 60)}` : ''}`,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('a refusal in the ack is exit 4 with the reason on stderr; no ORCA is exit 2; a thin brief is exit 1', async () => {
    const dir = temp();
    try {
      const home = join(dir, 'home');
      mkdirSync(home, { recursive: true });
      const project = join(dir, 'repo');
      const spawnDir = join(project, '.orca', 'spawn');
      mkdirSync(spawnDir, { recursive: true });

      const refuser = (async () => {
        await until(() => readdirSync(spawnDir).some((f) => f.endsWith('.json') && !f.endsWith('.ack.json')), 10_000, 50);
        const file = readdirSync(spawnDir).find((f) => f.endsWith('.json') && !f.endsWith('.ack.json'))!;
        await writeAck(join(spawnDir, file.replace(/\.json$/, '.ack.json')), { ok: false, reason: 'K9 already has 8 live children (max 8)', at: Date.now() });
      })();
      const refused = await run(['A brief long enough to be taken seriously by the watcher.', '--project', project, '--timeout', '15'], project, home);
      await refuser;

      const thin = await run(['fix it', '--project', project], project, home);
      const noOrca = await run(['A brief long enough to be taken seriously by the watcher.', '--project', project], project, join(dir, 'nowhere'));
      return ok(
        'exit codes mean what the help says',
        refused.code === 4 && refused.stderr.includes('8 live children')
          && thin.code === 1 && noOrca.code === 2,
        `refused ${refused.code} · thin ${thin.code} · no orca ${noOrca.code}`,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),
];

const suite: TestModule = { suite: 'collector · orca-spawn', tests: [...policy, ...watcher, ...cli] };
export default suite;
