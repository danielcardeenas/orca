/**
 * Worktrees: un worker en su copia del repo, y `land` / `discard` sobre ella.
 *
 * Lo que merece prueba, porque cada cosa falla en silencio:
 *
 *  1. Crear: el worktree aparece bajo .claude/worktrees/<nombre> en la rama
 *     orca/<nombre>, y pedirlo dos veces lo reutiliza.
 *  2. Land limpio: rebase, suite, un commit en la rama del proyecto con el
 *     callsign y la tarea, la rama del worker nivelada.
 *  3. Land con conflicto: la rama del proyecto no se toca, y se nombran los
 *     archivos.
 *  4. Land con la suite rota: ídem, con la salida de la suite.
 *  5. Discard: se niega con trabajo sin aterrizar, obedece con force, y
 *     quita rama y directorio cuando no hay nada que perder.
 *
 * Todo en repos git temporales. Ninguna suite real: la del repo de prueba es
 * un `node` que lee un archivo y sale con lo que diga.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  NAME_RE, WORKTREES_DIR, createWorktree, detectTestCommand, discard, land, worktreePath,
  worktreeStatus, worktreesEnabled,
} from '../src/collector/worktrees.ts';
import { runTool, type CeoContext } from '../src/agents/tools.ts';
import type { Command } from '../src/shared/protocol.ts';
import type { Agent } from '../src/shared/types.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Un repo con un commit, una suite que pasa mientras `suite.txt` diga "pass",
 * y la identidad git configurada en el propio repo (no en la máquina).
 */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-wt-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'ORCA Test');
  git(dir, 'config', 'user.email', 'orca@test.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'wt-fixture', scripts: { test: 'node test.js' } }));
  writeFileSync(join(dir, 'test.js'), 'process.exit(require("fs").readFileSync("suite.txt","utf8").trim()==="pass"?0:1)\n');
  writeFileSync(join(dir, 'suite.txt'), 'pass\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

function drop(dir: string): void { rmSync(dir, { recursive: true, force: true }); }

const create = [
  test('ORCA_WORKTREES is opt-in: off unless it says so', () =>
    ok('off by default, on with 1/true/on',
      !worktreesEnabled({}) && !worktreesEnabled({ ORCA_WORKTREES: '0' })
      && worktreesEnabled({ ORCA_WORKTREES: '1' }) && worktreesEnabled({ ORCA_WORKTREES: 'true' }))),

  test('a worktree name is a short id, a callsign or a squad — nothing that could be an argv', () =>
    ok('names', NAME_RE.test('k9') && NAME_RE.test('audit-01') && NAME_RE.test('3f2a9c10')
      && !NAME_RE.test('-rf') && !NAME_RE.test('a b') && !NAME_RE.test('../x') && !NAME_RE.test(''))),

  test('the worktree lands under .claude/worktrees/<name> on branch orca/<name>, and is reused on a second ask', async () => {
    const dir = repo();
    try {
      const r = await createWorktree(dir, 'k9');
      if (!r.ok) return ok('created', false, r.detail);
      const again = await createWorktree(dir, 'k9');
      const branch = git(r.worktree.path, 'symbolic-ref', '--short', 'HEAD');
      return ok('path, branch, reuse',
        r.worktree.path === worktreePath(dir, 'k9') && r.worktree.path.includes(WORKTREES_DIR)
        && branch === 'orca/k9' && !r.reused && again.ok && again.reused
        && existsSync(join(r.worktree.path, 'a.txt')),
        `${r.worktree.path} on ${branch}, reused=${again.ok && again.reused}`);
    } finally { drop(dir); }
  }),

  test('the worktrees directory is excluded from the project without touching .gitignore', async () => {
    const dir = repo();
    try {
      const r = await createWorktree(dir, 'k9');
      const status = git(dir, 'status', '--porcelain');
      const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
      return ok('clean status, exclude written', r.ok && status === '' && exclude.includes('.claude/worktrees/')
        && !existsSync(join(dir, '.gitignore')), `status="${status}"`);
    } finally { drop(dir); }
  }),

  test('a bad name or a repo without commits is refused, with the reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-wt-empty-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      const bad = await createWorktree(dir, '../evil');
      const empty = await createWorktree(dir, 'k9');
      return ok('refused', !bad.ok && !empty.ok && /commit/.test(empty.ok ? '' : empty.detail),
        `${bad.ok ? 'bad name accepted' : bad.detail} / ${empty.ok ? 'empty repo accepted' : empty.detail}`);
    } finally { drop(dir); }
  }),

  test('the suite command is detected from package.json, Makefile, or the project config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-wt-detect-'));
    try {
      const none = detectTestCommand(dir);
      writeFileSync(join(dir, 'Makefile'), 'build:\n\techo hi\ntest:\n\techo test\n');
      const make = detectTestCommand(dir);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
      const placeholder = detectTestCommand(dir);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'tsx test/run.ts' } }));
      const npm = detectTestCommand(dir);
      mkdirSync(join(dir, '.orca'));
      writeFileSync(join(dir, '.orca', 'land.json'), JSON.stringify({ test: 'npm run test:ci' }));
      const cfg = detectTestCommand(dir);
      writeFileSync(join(dir, '.orca', 'land.json'), JSON.stringify({ test: false }));
      const off = detectTestCommand(dir);
      return eq('detection order', [none, make, placeholder, npm, cfg, off],
        [null, ['make', 'test'], ['make', 'test'], ['npm', 'test'], ['npm', 'run', 'test:ci'], null]);
    } finally { drop(dir); }
  }),
];

const landing = [
  test('a clean land: rebase, suite, one commit on main naming the callsign and the mission, worker branch levelled', async () => {
    const dir = repo();
    try {
      const r = await createWorktree(dir, 'k9');
      if (!r.ok) return ok('created', false, r.detail);
      const wt = r.worktree;
      // The worker commits once and leaves something uncommitted; the project moves on meanwhile.
      writeFileSync(join(wt.path, 'b.txt'), 'two\n');
      git(wt.path, 'add', '-A'); git(wt.path, 'commit', '-q', '-m', 'add b');
      writeFileSync(join(wt.path, 'c.txt'), 'three\n');
      writeFileSync(join(dir, 'd.txt'), 'four\n');
      git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'project moved on');
      const before = git(dir, 'rev-parse', 'HEAD');

      const out = await land(dir, wt, { callsign: 'K9', mission: 'Add b and c to the repo without touching a' });
      if (!out.ok) return ok('landed', false, `${out.reason}: ${out.detail}\n${out.tests?.output ?? ''}`);
      const head = git(dir, 'rev-parse', 'HEAD');
      const msg = git(dir, 'log', '-1', '--format=%B');
      const parents = git(dir, 'log', '-1', '--format=%P').split(' ').length;
      const st = await worktreeStatus(dir, wt);
      return ok('one squash commit with callsign and task; worker levelled',
        head !== before && git(dir, 'rev-parse', 'HEAD^') === before && parents === 1
        && msg.includes('K9') && msg.includes('Add b and c') && msg.includes('add b')
        && existsSync(join(dir, 'b.txt')) && existsSync(join(dir, 'c.txt')) && existsSync(join(dir, 'd.txt'))
        && out.files.sort().join(',') === 'b.txt,c.txt' && out.tests?.ok === true
        && st.ahead === 0 && st.behind === 0 && !st.dirty
        && git(dir, 'status', '--porcelain') === '',
        `files=${out.files.join(',')} tests=${out.tests?.command.join(' ')} status=${JSON.stringify(st)}`);
    } finally { drop(dir); }
  }),

  test('a dirty project working tree is not an error when the worker touches other files', async () => {
    const dir = repo();
    try {
      const r = await createWorktree(dir, 'k9');
      if (!r.ok) return ok('created', false, r.detail);
      writeFileSync(join(r.worktree.path, 'b.txt'), 'two\n');
      writeFileSync(join(dir, 'a.txt'), 'operator edit, uncommitted\n');
      const out = await land(dir, r.worktree, { callsign: 'K9', mission: 'add b', runTests: false });
      const a = readFileSync(join(dir, 'a.txt'), 'utf8');
      return ok('landed around the operator\'s edit', out.ok && a.includes('operator edit')
        && /^ ?M a\.txt$/.test(git(dir, 'status', '--porcelain')), out.ok ? out.note ?? '' : out.detail);
    } finally { drop(dir); }
  }),

  test('a conflicting land leaves main untouched and names the files', async () => {
    const dir = repo();
    try {
      const r = await createWorktree(dir, 'k9');
      if (!r.ok) return ok('created', false, r.detail);
      writeFileSync(join(r.worktree.path, 'a.txt'), 'worker version\n');
      git(r.worktree.path, 'commit', '-q', '-am', 'worker edits a');
      writeFileSync(join(dir, 'a.txt'), 'project version\n');
      git(dir, 'commit', '-q', '-am', 'project edits a');
      const before = git(dir, 'rev-parse', 'HEAD');
      const out = await land(dir, r.worktree, { callsign: 'K9', mission: 'edit a' });
      const st = await worktreeStatus(dir, r.worktree);
      return ok('conflict reported, nothing landed, rebase aborted',
        !out.ok && out.reason === 'conflict' && out.conflicts.includes('a.txt')
        && git(dir, 'rev-parse', 'HEAD') === before
        && readFileSync(join(dir, 'a.txt'), 'utf8') === 'project version\n'
        && !existsSync(join(r.worktree.path, '.git', 'rebase-merge')) && st.ahead === 1 && !st.dirty,
        out.ok ? 'landed' : `${out.reason}: ${out.detail} [${out.conflicts.join(',')}]`);
    } finally { drop(dir); }
  }),

  test('a dirty project file the worker also changed is a conflict, not a clobber', async () => {
    const dir = repo();
    try {
      const r = await createWorktree(dir, 'k9');
      if (!r.ok) return ok('created', false, r.detail);
      writeFileSync(join(r.worktree.path, 'a.txt'), 'worker version\n');
      writeFileSync(join(dir, 'a.txt'), 'operator, uncommitted\n');
      const before = git(dir, 'rev-parse', 'HEAD');
      const out = await land(dir, r.worktree, { callsign: 'K9', mission: 'edit a', runTests: false });
      return ok('refused, operator edit intact',
        !out.ok && out.reason === 'conflict' && out.conflicts.includes('a.txt')
        && git(dir, 'rev-parse', 'HEAD') === before
        && readFileSync(join(dir, 'a.txt'), 'utf8') === 'operator, uncommitted\n'
        && git(dir, 'diff', '--cached', '--name-only') === '',
        out.ok ? 'landed' : `${out.reason}: ${out.detail} [${out.conflicts.join(',')}]`);
    } finally { drop(dir); }
  }),

  test('a failing suite leaves main untouched and returns the output', async () => {
    const dir = repo();
    try {
      const r = await createWorktree(dir, 'k9');
      if (!r.ok) return ok('created', false, r.detail);
      writeFileSync(join(r.worktree.path, 'suite.txt'), 'fail\n');
      writeFileSync(join(r.worktree.path, 'b.txt'), 'two\n');
      const before = git(dir, 'rev-parse', 'HEAD');
      const out = await land(dir, r.worktree, { callsign: 'K9', mission: 'break the suite' });
      return ok('tests failed → nothing landed',
        !out.ok && out.reason === 'tests' && out.tests?.ok === false && out.tests.code === 1
        && git(dir, 'rev-parse', 'HEAD') === before && !existsSync(join(dir, 'b.txt')),
        out.ok ? 'landed' : `${out.reason}: ${out.detail}`);
    } finally { drop(dir); }
  }),

  test('run_tests false lands without running the suite, and says so', async () => {
    const dir = repo();
    try {
      const r = await createWorktree(dir, 'k9');
      if (!r.ok) return ok('created', false, r.detail);
      writeFileSync(join(r.worktree.path, 'suite.txt'), 'fail\n');
      const out = await land(dir, r.worktree, { callsign: 'K9', mission: 'skip', runTests: false, message: 'custom title' });
      return ok('landed without tests', out.ok && out.tests === null && /omitida/.test(out.note ?? '')
        && git(dir, 'log', '-1', '--format=%s') === 'custom title', out.ok ? '' : out.detail);
    } finally { drop(dir); }
  }),

  test('nothing to land is said, not committed', async () => {
    const dir = repo();
    try {
      const r = await createWorktree(dir, 'k9');
      if (!r.ok) return ok('created', false, r.detail);
      const before = git(dir, 'rev-parse', 'HEAD');
      const out = await land(dir, r.worktree, { callsign: 'K9', mission: 'idle' });
      return ok('nothing', !out.ok && out.reason === 'nothing' && git(dir, 'rev-parse', 'HEAD') === before,
        out.ok ? 'landed' : out.detail);
    } finally { drop(dir); }
  }),

  test('staged changes in the project index block the land', async () => {
    const dir = repo();
    try {
      const r = await createWorktree(dir, 'k9');
      if (!r.ok) return ok('created', false, r.detail);
      writeFileSync(join(r.worktree.path, 'b.txt'), 'two\n');
      writeFileSync(join(dir, 'staged.txt'), 'half done\n');
      git(dir, 'add', 'staged.txt');
      const out = await land(dir, r.worktree, { callsign: 'K9', mission: 'add b', runTests: false });
      return ok('index refused, still staged', !out.ok && out.reason === 'index'
        && git(dir, 'diff', '--cached', '--name-only') === 'staged.txt', out.ok ? 'landed' : out.detail);
    } finally { drop(dir); }
  }),
];

const discarding = [
  test('discard refuses a worktree with unlanded work, and obeys force', async () => {
    const dir = repo();
    try {
      const r = await createWorktree(dir, 'k9');
      if (!r.ok) return ok('created', false, r.detail);
      writeFileSync(join(r.worktree.path, 'b.txt'), 'two\n');
      const refused = await discard(dir, r.worktree);
      git(r.worktree.path, 'add', '-A'); git(r.worktree.path, 'commit', '-q', '-m', 'add b');
      const refusedAhead = await discard(dir, r.worktree);
      const forced = await discard(dir, r.worktree, { force: true });
      const branches = git(dir, 'branch', '--list', 'orca/k9');
      return ok('refused twice, forced once',
        !refused.ok && /sin commitear/.test(refused.detail)
        && !refusedAhead.ok && /sin aterrizar/.test(refusedAhead.detail)
        && forced.ok && forced.removed && !existsSync(r.worktree.path) && branches === '',
        `${refused.ok ? 'ok?!' : refused.detail} / ${refusedAhead.ok ? 'ok?!' : refusedAhead.detail} / ${forced.ok ? forced.detail : forced.detail}`);
    } finally { drop(dir); }
  }),

  test('after a land, discard needs no force: worktree and branch go, twice is harmless', async () => {
    const dir = repo();
    try {
      const r = await createWorktree(dir, 'k9');
      if (!r.ok) return ok('created', false, r.detail);
      writeFileSync(join(r.worktree.path, 'b.txt'), 'two\n');
      const landed = await land(dir, r.worktree, { callsign: 'K9', mission: 'add b', runTests: false });
      const gone = await discard(dir, r.worktree);
      const again = await discard(dir, r.worktree);
      return ok('clean discard', landed.ok && gone.ok && gone.removed && !existsSync(r.worktree.path)
        && git(dir, 'branch', '--list', 'orca/k9') === '' && again.ok && !again.removed
        && existsSync(join(dir, 'b.txt')),
        `${landed.ok ? 'landed' : landed.detail} / ${gone.ok ? gone.detail : gone.detail}`);
    } finally { drop(dir); }
  }),
];

/* ── the tools: who gets dispatched what ──────────────────────────── */

function agent(over: Partial<Agent>): Agent {
  return {
    id: 'a', machineId: 'm1', projectId: 'p1', title: 't', callsign: 'K9', runtime: 'claude',
    state: 'idle', block: null, parentId: null, depth: 0, childIds: [], mission: 'do the thing',
    squad: null, lead: false, model: null, tool: null, toolDetail: null, lastPrompt: null, lastSay: null,
    startedAt: 0, updatedAt: 0, uptimeMs: 0,
    metrics: { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0 },
    background: true, shortId: null,
    ...over,
  };
}

/** The smallest CeoContext `land` and `discard` need: a fleet and a dispatch that records. */
function ctxOf(agents: Agent[], answer: (cmd: Command) => unknown): { ctx: CeoContext; sent: Command[] } {
  const sent: Command[] = [];
  const ctx = {
    agents: () => agents,
    agent: (id: string) => agents.find((a) => a.id === id),
    projects: () => [],
    project: () => undefined,
    dispatch: async (_m: string, cmd: Command) => { sent.push(cmd); return answer(cmd); },
  } as unknown as CeoContext;
  return { ctx, sent };
}

const tools = [
  test('land on an agent without a worktree is refused and says how to get one', async () => {
    const { ctx, sent } = ctxOf([agent({ id: 'a' })], () => ({}));
    const out = await runTool(ctx, 'land', { agent_id: 'K9', squad: null, run_tests: true, message: null });
    return ok('refused, nothing dispatched', out.isError === true && /ORCA_WORKTREES/.test(out.result) && sent.length === 0, out.result);
  }),

  test('a squad sharing one worktree is landed once, under its lead', async () => {
    const fleet = [
      agent({ id: 'm', callsign: 'M1', squad: 'pay-01', worktree: '/p/.claude/worktrees/pay-01', branch: 'orca/pay-01' }),
      agent({ id: 'l', callsign: 'L1', squad: 'pay-01', lead: true, worktree: '/p/.claude/worktrees/pay-01', branch: 'orca/pay-01' }),
      agent({ id: 'x', callsign: 'X1', squad: 'pay-01' }),
    ];
    const { ctx, sent } = ctxOf(fleet, () => ({ ok: true, commit: 'abcdef0123', branch: 'orca/pay-01', projectBranch: 'main', files: ['a'], tests: null, note: null }));
    const out = await runTool(ctx, 'land', { agent_id: null, squad: 'pay-01', run_tests: false, message: 'pay: land' });
    const r = JSON.parse(out.result) as { ok: boolean; landed: { callsign: string }[] };
    const cmd = sent[0] as Extract<Command, { k: 'land' }> | undefined;
    return ok('one land, for the lead, tests off, message through',
      !out.isError && r.ok && r.landed.length === 1 && r.landed[0]!.callsign === 'L1'
      && sent.length === 1 && cmd?.k === 'land' && cmd.agentId === 'l' && cmd.runTests === false && cmd.message === 'pay: land',
      `${out.summary} · sent=${JSON.stringify(sent)}`);
  }),

  test('a refused landing comes back readable: reason, files, and the suite output', async () => {
    const fleet = [agent({ id: 'a', worktree: '/p/.claude/worktrees/k9', branch: 'orca/k9' })];
    const { ctx } = ctxOf(fleet, () => ({ ok: false, reason: 'conflict', detail: 'rebase stopped', conflicts: ['src/a.ts'], tests: null }));
    const out = await runTool(ctx, 'land', { agent_id: 'a', squad: null, run_tests: true, message: null });
    const r = JSON.parse(out.result) as { ok: boolean; refused: { reason: string; conflicts: string[] }[]; next?: string };
    return ok('conflict surfaced with next step', out.isError === true && !r.ok && r.refused[0]?.reason === 'conflict'
      && r.refused[0].conflicts[0] === 'src/a.ts' && /send_to_agent|discard/.test(r.next ?? ''), out.summary);
  }),

  test('discard passes force through and reports what was kept', async () => {
    const fleet = [agent({ id: 'a', worktree: '/p/.claude/worktrees/k9', branch: 'orca/k9' })];
    const { ctx, sent } = ctxOf(fleet, (cmd) => (cmd.k === 'discard' && cmd.force
      ? { ok: true, removed: true, detail: 'gone' }
      : { ok: false, detail: 'orca/k9 has 2 unlanded commits', status: null }));
    const kept = await runTool(ctx, 'discard', { agent_id: 'K9', squad: null, force: false });
    const gone = await runTool(ctx, 'discard', { agent_id: 'K9', squad: null, force: true });
    const k = JSON.parse(kept.result) as { kept: { detail: string }[]; next?: string };
    return ok('kept without force, gone with it',
      kept.isError === true && /unlanded/.test(k.kept[0]?.detail ?? '') && /force/.test(k.next ?? '')
      && !gone.isError && sent.length === 2 && (sent[1] as { force?: boolean }).force === true,
      `${kept.summary} / ${gone.summary}`);
  }),
];

export default { suite: 'worktrees', tests: [...create, ...landing, ...discarding, ...tools] } satisfies TestModule;
