/**
 * Pieza B del squad autonomy: verificar sin fiarse del reporte.
 *
 * Lo que se prueba, de abajo arriba: el escáner de transcript (archivos
 * tocados, último test run), la detección de comandos de test, el truncado
 * del patch, el saneado de rutas, la elección del directorio en el que git
 * puede correr, un `git diff` de verdad sobre un repo temporal, el handler
 * del collector con deps falsas, y las tres herramientas MCP con un contexto
 * falso. La captura de pantalla no se dispara aquí —sería un Chromium por
 * test— pero sí el cableado: la cámara se mueve con la página ya conectada.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cleanFiles, exitCodeOf, gitDiff, isTestCommand, pickDir, runVerify, scanTranscript, scanTranscriptFile,
  tailOf, transcriptFor, truncate, DEFAULT_MAX_BYTES, MAX_TAIL_BYTES,
} from '../src/collector/verify.ts';
import type { AgentHandle, CommandDeps } from '../src/collector/commands.ts';
import type { Project, Agent } from '../src/shared/types.ts';
import { emptyRollup } from '../src/shared/types.ts';
import { createVerify, type AgentDiff, type AgentWork, type VerifyApi } from '../src/hub/verify.ts';
import type { AutonomyDeps } from '../src/hub/autonomy.ts';
import { TOOLS, run } from '../src/agents/tools-verify.ts';
import { CEO_TOOLS, type CeoContext } from '../src/agents/tools.ts';
import { duplicateToolNames, EXTENSION_TOOLS } from '../src/agents/extensions.ts';
import type { CameraDirective } from '../src/shared/camera.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

/* ── fixtures de transcript ───────────────────────────────────────── */

const T0 = Date.parse('2026-09-06T10:00:00.000Z');
const iso = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

function toolUse(id: string, name: string, input: Record<string, unknown>, at: number, cwd = '/Users/dan/proj') {
  return {
    type: 'assistant', cwd, timestamp: iso(at),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  };
}
function toolResult(id: string, text: string, at: number, isError = false) {
  return {
    type: 'user', timestamp: iso(at),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] },
  };
}

/** Una sesión corta: edita, escribe, corre tests bien, luego mal, y deja uno corriendo. */
function fixture(): Record<string, unknown>[] {
  return [
    { type: 'user', cwd: '/Users/dan/proj', timestamp: iso(0), message: { role: 'user', content: 'fix the thing' } },
    toolUse('t1', 'Read', { file_path: '/Users/dan/proj/src/a.ts' }, 1),
    toolResult('t1', 'contents', 2),
    toolUse('t2', 'Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }, 3),
    {
      type: 'file-history-delta', timestamp: iso(3), trackingPath: 'src/a.ts',
      backup: { backupFileName: 'ab@v1', version: 1, backupTime: iso(3), realParentDir: '/Users/dan/proj/src' },
    },
    toolResult('t2', 'ok', 4),
    toolUse('t3', 'Write', { file_path: '/Users/dan/proj/src/b.ts', content: 'export {}' }, 5),
    toolResult('t3', 'ok', 6),
    toolUse('t4', 'Bash', { command: 'cd /Users/dan/proj && npm test 2>&1 | tail -20' }, 7),
    toolResult('t4', 'suite\n  OK one\n  OK two\n\n2/2 passed', 9),
    toolUse('t5', 'Bash', { command: 'ls -la' }, 10),
    toolResult('t5', 'total 0', 11),
    toolUse('t6', 'Bash', { command: 'pytest -q tests/' }, 12),
    toolResult('t6', 'Exit code 1\nFAILED tests/test_x.py::test_a\n1 failed', 14, true),
    toolUse('t7', 'Edit', { file_path: 'src/a.ts', old_string: 'y', new_string: 'z' }, 15),
    toolResult('t7', 'ok', 16),
  ];
}

function temporary<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'orca-verify-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function temporaryAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-verify-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'orca', GIT_AUTHOR_EMAIL: 'orca@test', GIT_COMMITTER_NAME: 'orca', GIT_COMMITTER_EMAIL: 'orca@test' },
  });
}

/** Un repo con un commit, un archivo modificado, uno nuevo sin seguir. */
function seedRepo(dir: string): void {
  gitIn(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\n');
  writeFileSync(join(dir, 'README.md'), '# hi\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 2;\nconst b = 3;\n');
  writeFileSync(join(dir, 'src', 'new.ts'), 'export {}\n');
}

/* ── fakes ────────────────────────────────────────────────────────── */

function project(id: string, dir: string, slug = 'slug-proj'): Project {
  return {
    id, machineId: 'm1', slug, name: 'proj', path: dir, code: 'PJ',
    gitBranch: null, gitDirty: false, keyNames: [], sessionIds: [], rollup: emptyRollup(),
  };
}

function handle(over: Partial<AgentHandle> = {}): AgentHandle {
  return {
    id: 'sess-1', projectId: 'm1/slug-proj', sessionId: 'sess-1', shortId: null, background: false,
    alive: true, callsign: 'K9', pane: null, runtime: 'claude', worktree: null, mission: null, ...over,
  };
}

function deps(projects: Project[], agents: AgentHandle[]): CommandDeps {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return {
    projects: { get: (id: string) => byId.get(id) ?? null, all: () => projects } as unknown as CommandDeps['projects'],
    agent: (id: string) => agents.find((a) => a.id === id) ?? null,
  } as unknown as CommandDeps;
}

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'sess-1', machineId: 'm1', projectId: 'm1/slug-proj', title: 't', callsign: 'K9', runtime: 'claude',
    state: 'working', block: null, parentId: null, depth: 0, childIds: [], mission: null, squad: null, lead: false,
    model: null, tool: null, toolDetail: null, lastPrompt: null, lastSay: null,
    startedAt: T0, updatedAt: T0, uptimeMs: 0,
    metrics: { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0 },
    background: false, shortId: null, ...over,
  };
}

function autonomyDeps(dispatch: AutonomyDeps['dispatch'], agents: Agent[] = [agent()]): AutonomyDeps {
  return {
    agents: () => agents,
    agent: (id) => agents.find((a) => a.id === id),
    projects: () => [], project: () => undefined, missions: () => ({}), capcom: () => null,
    sayToCapcom: () => false, dispatch, stopAgent: async () => undefined,
    dir: '/tmp/orca-verify-none', env: {}, now: () => T0,
    setTimer: () => ({ cancel() {} }), setInterval: () => ({ cancel() {} }),
    log: () => undefined, note: () => undefined,
    lifecycle: { on: () => () => undefined } as unknown as AutonomyDeps['lifecycle'],
  };
}

function ctxWith(verify: Partial<VerifyApi>, agents: Agent[] = [agent()], show?: (d: CameraDirective) => number): CeoContext {
  return {
    agents: () => agents,
    agent: (id: string) => agents.find((a) => a.id === id),
    projects: () => [], project: (_id: string) => undefined,
    autonomy: { verify } as unknown as CeoContext['autonomy'],
    ...(show ? { show } : {}),
  } as unknown as CeoContext;
}

const WORK: AgentWork = {
  agentId: 'sess-1', callsign: 'K9', runtime: 'claude', cwd: '/x', transcript: '/x/t.jsonl', lines: 10,
  touched: [{ path: '/x/src/a.ts', tools: ['Edit'], writes: 2, firstAt: T0, lastAt: T0 }],
  lastTestRun: { command: 'npm test', ok: true, tail: '2/2 passed', at: T0, finishedAt: T0 + 1000, exitCode: null },
};
const DIFF: AgentDiff = {
  agentId: 'sess-1', callsign: 'K9', cwd: '/x', root: '/x', top: '/x', branch: 'main',
  stat: ' src/a.ts | 2 +-\n 1 file changed', untracked: ['src/new.ts'], patch: 'diff --git a/src/a.ts b/src/a.ts\n+x',
  truncated: false, bytes: 40, totalBytes: 40, files: null, ignored: [], touched: null,
};

/* ── tests ────────────────────────────────────────────────────────── */

const suite: TestModule = {
  suite: 'verify: work, diff, screenshot',
  tests: [
    test('scanTranscript: touched files come from Edit/Write, anchored on the cwd', () => {
      const s = scanTranscript(fixture());
      const paths = s.touched.map((t) => t.path).sort();
      const a = s.touched.find((t) => t.path === '/Users/dan/proj/src/a.ts');
      return ok('touched', paths.join(',') === '/Users/dan/proj/src/a.ts,/Users/dan/proj/src/b.ts'
        && a?.writes === 3 && a.tools.includes('Edit') && a.tools.includes('file-history')
        && s.cwd === '/Users/dan/proj' && s.lines === fixture().length,
        `paths=${paths.join(',')} writes=${a?.writes} tools=${a?.tools.join('/')}`);
    }),
    test('scanTranscript: a Read is not a touch', () => {
      const s = scanTranscript(fixture());
      return ok('read ignored', !s.touched.some((t) => t.tools.includes('Read')));
    }),
    test('scanTranscript: the last test run is the failed pytest, with its tail and exit code', () => {
      const s = scanTranscript(fixture());
      const t = s.lastTestRun;
      return ok('last test run', !!t && t.command === 'pytest -q tests/' && t.ok === false && t.exitCode === 1
        && t.tail.includes('1 failed') && t.at === T0 + 12_000 && t.finishedAt === T0 + 14_000,
        JSON.stringify(t));
    }),
    test('scanTranscript: a passing npm test is ok, and `ls` never counts', () => {
      const lines = fixture().slice(0, 12);
      const s = scanTranscript(lines);
      const t = s.lastTestRun;
      return ok('npm test ok', !!t && t.ok === true && t.command.startsWith('cd /Users/dan/proj && npm test')
        && t.tail.endsWith('2/2 passed') && t.exitCode === null, JSON.stringify(t));
    }),
    test('scanTranscript: a suite still running shows ok=null and wins over an older one', () => {
      const lines = [...fixture(), toolUse('t8', 'Bash', { command: 'npx tsx test/run.ts verify' }, 20)];
      const t = scanTranscript(lines).lastTestRun;
      return ok('running', !!t && t.ok === null && t.command === 'npx tsx test/run.ts verify' && t.tail === '' && t.finishedAt === null, JSON.stringify(t));
    }),
    test('scanTranscript: the tail is capped in lines', () => {
      const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
      const lines = [toolUse('t1', 'Bash', { command: 'go test ./...' }, 1), toolResult('t1', long, 2)];
      const t = scanTranscript(lines, { tailLines: 5 }).lastTestRun;
      return eq('five lines', t?.tail, 'line 95\nline 96\nline 97\nline 98\nline 99');
    }),
    test('tailOf: never more than MAX_TAIL_BYTES', () => {
      const big = 'x'.repeat(MAX_TAIL_BYTES * 3);
      const out = tailOf(big, 5);
      return ok('capped', Buffer.byteLength(out) <= MAX_TAIL_BYTES + 3, `${Buffer.byteLength(out)} bytes`);
    }),
    test('exitCodeOf reads Claude Code\'s "Exit code N" header', () => {
      return ok('exit codes', exitCodeOf('Exit code 2\nboom') === 2 && exitCodeOf('all good') === null && exitCodeOf('x\n  Exit code: 127') === 127);
    }),
    test('isTestCommand: the runners we know, and not the shell noise around them', () => {
      const yes = [
        'npm test', 'npm run test:unit', 'cd x && npm test -- hub 2>&1 | tail -50', 'pnpm test', 'yarn test', 'bun test',
        'npx vitest run', 'npx jest src/', 'vitest', 'npx tsx test/run.ts', 'node --test', 'pytest -q', 'python -m pytest tests',
        'python3 -m unittest', 'go test ./...', 'cargo test --all', 'cargo nextest run', 'deno test', 'mix test', 'bundle exec rspec',
        'dotnet test', './gradlew test', 'mvn test', 'make test', 'swift test', 'ctest',
      ];
      const no = [
        'ls -la', 'npm install', 'npm run build', 'git status', 'cat test/run.ts', 'echo "npm test"',
        'npx tsc --noEmit', 'pytest.ini', 'node test.js', 'cargo build', 'go build ./...', 'grep -rn test src/',
      ];
      const missed = yes.filter((c) => !isTestCommand(c));
      const wrong = no.filter((c) => isTestCommand(c));
      return ok('detection', missed.length === 0 && wrong.length === 0, `missed=${JSON.stringify(missed)} wrong=${JSON.stringify(wrong)}`);
    }),
    test('truncate: under the cap nothing changes', () => {
      const t = truncate('a\nb\nc', DEFAULT_MAX_BYTES);
      return ok('untouched', t.text === 'a\nb\nc' && !t.truncated && t.bytes === 5 && t.totalBytes === 5);
    }),
    test('truncate: over the cap cuts at a line and says so', () => {
      const body = Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(3, '0')} ${'x'.repeat(20)}`).join('\n');
      const t = truncate(body, 1024);
      const lines = t.text.split('\n');
      const last = lines[lines.length - 1] ?? '';
      return ok('truncated', t.truncated && t.bytes <= 1024 && t.totalBytes === Buffer.byteLength(body)
        && last.startsWith('[orca: patch truncated to ') && last.includes(`of ${t.totalBytes} bytes`)
        && lines.slice(0, -1).every((l) => /^line \d{3} x{20}$/.test(l)),
        `bytes=${t.bytes} last=${last}`);
    }),
    test('truncate: a multibyte character on the cut is dropped, not split', () => {
      const t = truncate('é'.repeat(600), 1001);
      return ok('no replacement char', !t.text.includes('�') && t.truncated);
    }),
    test('cleanFiles: relative inside, absolute inside; never out, never an option', () => {
      const top = '/repo';
      const r = cleanFiles(['src/a.ts', '/repo/src/b.ts', '../etc/passwd', '/etc/passwd', '--output=x', '-n', 'src/a.ts', '', '.'], top);
      return ok('cleaned', r.ok.join(',') === 'src/a.ts,src/b.ts' && r.ignored.join(',') === '../etc/passwd,/etc/passwd,--output=x,-n,.',
        `ok=${r.ok.join(',')} ignored=${r.ignored.join(',')}`);
    }),
    test('pickDir: the agent cwd wins when it sits inside a known root, else the root', () => temporary((dir) => {
      const root = join(dir, 'proj');
      const wt = join(root, '.claude', 'worktrees', 'fix-a');
      mkdirSync(wt, { recursive: true });
      const elsewhere = join(dir, 'other');
      mkdirSync(elsewhere);
      const roots = [root];
      const inWt = pickDir(roots, root, wt);
      const outside = pickDir(roots, root, elsewhere);
      const unknown = pickDir(roots, elsewhere, null);
      const none = pickDir(roots, null, null);
      return ok('picked',
        'dir' in inWt && inWt.dir.endsWith('fix-a') && inWt.root.endsWith('proj')
        && 'dir' in outside && outside.dir === outside.root && outside.root.endsWith('proj')
        && 'error' in unknown && 'error' in none,
        JSON.stringify({ inWt, outside, unknown, none }));
    })),
    test('pickDir: the hub hint goes first, but only inside a known root', () => temporary((dir) => {
      const root = join(dir, 'proj');
      const wt = join(root, '.claude', 'worktrees', 'fix-a');
      mkdirSync(wt, { recursive: true });
      const elsewhere = join(dir, 'other');
      mkdirSync(elsewhere);
      const hinted = pickDir([root], root, wt, root);
      const badHint = pickDir([root], root, elsewhere, wt);
      const noHint = pickDir([root], root, null, undefined);
      return ok('hint', 'dir' in hinted && hinted.dir.endsWith('fix-a') && 'dir' in badHint && badHint.dir.endsWith('fix-a')
        && 'dir' in noHint && noHint.dir === noHint.root, JSON.stringify({ hinted, badHint, noHint }));
    })),
    test('pickDir: a system root is never a place to run git', () => {
      const r = pickDir([], '/', null);
      return ok('refused', 'error' in r);
    }),
    test('gitDiff: stat, untracked and patch of a real working tree', () => temporaryAsync(async (dir) => {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      seedRepo(repo);
      const out = await gitDiff(repo, repo, [repo], { files: null, maxBytes: DEFAULT_MAX_BYTES, patch: true, onlyTouched: false }, null);
      if ('error' in out) return ok('diff', false, out.error);
      return ok('diff', out.branch === 'main' && out.stat.includes('src/a.ts') && out.untracked.join(',') === 'src/new.ts'
        && !!out.patch && out.patch.includes('+const b = 3;') && !out.truncated && out.files === null && out.bytes === out.totalBytes,
        JSON.stringify({ branch: out.branch, stat: out.stat, untracked: out.untracked, bytes: out.bytes }));
    })),
    test('gitDiff: max_bytes truncates the patch and says so', () => temporaryAsync(async (dir) => {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      seedRepo(repo);
      writeFileSync(join(repo, 'README.md'), Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\n');
      const out = await gitDiff(repo, repo, [repo], { files: null, maxBytes: 1024, patch: true, onlyTouched: false }, null);
      if ('error' in out) return ok('diff', false, out.error);
      return ok('truncated', out.truncated && out.bytes <= 1024 && out.totalBytes > 1024 && !!out.patch && out.patch.includes('[orca: patch truncated to '),
        `bytes=${out.bytes} total=${out.totalBytes}`);
    })),
    test('gitDiff: files narrows the patch; paths outside the tree are ignored', () => temporaryAsync(async (dir) => {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      seedRepo(repo);
      writeFileSync(join(repo, 'README.md'), '# changed\n');
      const out = await gitDiff(repo, repo, [repo], { files: ['README.md', '../outside.txt', '/etc/hosts'], maxBytes: DEFAULT_MAX_BYTES, patch: true, onlyTouched: false }, null);
      if ('error' in out) return ok('diff', false, out.error);
      return ok('narrowed', out.files?.join(',') === 'README.md' && out.ignored.length === 2
        && !!out.patch && out.patch.includes('README.md') && !out.patch.includes('src/a.ts') && !out.stat.includes('src/a.ts'),
        JSON.stringify({ files: out.files, ignored: out.ignored, stat: out.stat }));
    })),
    test('gitDiff: only_touched uses the transcript\'s paths and reports an empty set honestly', () => temporaryAsync(async (dir) => {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      seedRepo(repo);
      writeFileSync(join(repo, 'README.md'), '# changed\n');
      const some = await gitDiff(repo, repo, [repo], { files: null, maxBytes: DEFAULT_MAX_BYTES, patch: true, onlyTouched: true }, [join(repo, 'src', 'a.ts'), '/elsewhere/x.ts']);
      const none = await gitDiff(repo, repo, [repo], { files: null, maxBytes: DEFAULT_MAX_BYTES, patch: true, onlyTouched: true }, []);
      if ('error' in some || 'error' in none) return ok('diff', false, 'error');
      return ok('touched only', some.files?.join(',') === 'src/a.ts' && some.touched === 2 && some.ignored.join(',') === '/elsewhere/x.ts'
        && !!some.patch && !some.patch.includes('README') && none.patch === null && none.stat === '' && none.files?.length === 0,
        JSON.stringify({ some: { files: some.files, touched: some.touched, ignored: some.ignored }, none: { patch: none.patch, stat: none.stat } }));
    })),
    test('gitDiff: patch=false is stat only', () => temporaryAsync(async (dir) => {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      seedRepo(repo);
      const out = await gitDiff(repo, repo, [repo], { files: null, maxBytes: DEFAULT_MAX_BYTES, patch: false, onlyTouched: false }, null);
      if ('error' in out) return ok('diff', false, out.error);
      return ok('stat only', out.patch === null && out.stat.includes('src/a.ts') && out.bytes === 0);
    })),
    test('gitDiff: refuses a tree whose root is not a known project', () => temporaryAsync(async (dir) => {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      seedRepo(repo);
      const other = join(dir, 'other');
      mkdirSync(other);
      const out = await gitDiff(repo, repo, [other], { files: null, maxBytes: DEFAULT_MAX_BYTES, patch: true, onlyTouched: false }, null);
      return ok('refused', 'error' in out && out.error.includes('proyectos conocidos'), JSON.stringify(out));
    })),
    test('gitDiff: a directory that is not a repo is an error, not a crash', () => temporaryAsync(async (dir) => {
      const out = await gitDiff(dir, dir, [dir], { files: null, maxBytes: DEFAULT_MAX_BYTES, patch: true, onlyTouched: false }, null);
      return ok('not a repo', 'error' in out && out.error.includes('no es un repositorio git'), JSON.stringify(out));
    })),
    test('transcriptFor: the slug dir, the worktree slug dir, and a subagent', () => temporary((base) => {
      mkdirSync(join(base, 'slug-proj'), { recursive: true });
      mkdirSync(join(base, 'slug-proj--claude-worktrees-fix', 'root-2', 'subagents'), { recursive: true });
      mkdirSync(join(base, 'slug-projx'), { recursive: true });
      writeFileSync(join(base, 'slug-proj', 'sess-1.jsonl'), '');
      writeFileSync(join(base, 'slug-proj--claude-worktrees-fix', 'root-2.jsonl'), '');
      writeFileSync(join(base, 'slug-proj--claude-worktrees-fix', 'root-2', 'subagents', 'agent-sub-3.jsonl'), '');
      writeFileSync(join(base, 'slug-projx', 'sess-9.jsonl'), '');
      const p = project('m1/slug-proj', '/nowhere');
      const root = transcriptFor(handle(), p, base);
      const wt = transcriptFor(handle({ id: 'root-2', sessionId: 'root-2' }), p, base);
      const sub = transcriptFor(handle({ id: 'sub-3', sessionId: 'root-2' }), p, base);
      const foreign = transcriptFor(handle({ id: 'sess-9', sessionId: 'sess-9' }), p, base);
      const codex = transcriptFor(handle({ runtime: 'codex' }), p, base);
      return ok('located', root?.endsWith('/slug-proj/sess-1.jsonl') === true && wt?.endsWith('worktrees-fix/root-2.jsonl') === true
        && sub?.endsWith('subagents/agent-sub-3.jsonl') === true && foreign === null && codex === null,
        JSON.stringify({ root, wt, sub, foreign, codex }));
    })),
    test('scanTranscriptFile: streams a .jsonl and skips corrupt lines', () => temporaryAsync(async (dir) => {
      const file = join(dir, 't.jsonl');
      writeFileSync(file, fixture().map((l) => JSON.stringify(l)).join('\n') + '\n{not json\n\n');
      const s = await scanTranscriptFile(file);
      return ok('streamed', s.touched.length === 2 && s.lastTestRun?.ok === false && s.lines === fixture().length);
    })),
    test('runVerify: not its op → null; unknown agent → refused', async () => {
      const d = deps([], []);
      const other = await runVerify({ k: 'autonomy', op: 'land:merge', agentId: 'x' }, d);
      const missing = await runVerify({ k: 'autonomy', op: 'verify:work', agentId: 'ghost' }, d);
      const bad = await runVerify({ k: 'autonomy', op: 'verify:nope', agentId: 'sess-1' }, deps([project('m1/slug-proj', '/x')], [handle()]));
      return ok('routing', other === null && missing?.ok === false && bad?.ok === false && (bad?.detail ?? '').includes('desconocida'));
    }),
    test('runVerify verify:work + verify:diff end to end, worktree cwd and only_touched', () => temporaryAsync(async (dir) => {
      const repo = join(dir, 'proj');
      mkdirSync(repo);
      seedRepo(repo);
      // El agente corre en un worktree bajo el proyecto: git debe correr ahí.
      const wt = join(repo, '.claude', 'worktrees', 'fix-a');
      mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
      gitIn(repo, 'worktree', 'add', '-q', '-b', 'fix-a', wt);
      writeFileSync(join(wt, 'src', 'a.ts'), 'const a = 42;\n');
      writeFileSync(join(wt, 'README.md'), '# in the worktree\n');
      const base = join(dir, 'claude', 'projects');
      const slugDir = join(base, 'slug-proj--claude-worktrees-fix-a');
      mkdirSync(slugDir, { recursive: true });
      const lines = [
        { type: 'user', cwd: wt, timestamp: iso(0), message: { role: 'user', content: 'go' } },
        toolUse('t1', 'Edit', { file_path: 'src/a.ts', old_string: '1', new_string: '42' }, 1, wt),
        toolResult('t1', 'ok', 2),
        toolUse('t2', 'Bash', { command: 'npm test' }, 3, wt),
        toolResult('t2', 'all green', 4),
      ];
      writeFileSync(join(slugDir, 'sess-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const prev = process.env['CLAUDE_CONFIG_DIR'];
      process.env['CLAUDE_CONFIG_DIR'] = join(dir, 'claude');
      try {
        const d = deps([project('m1/slug-proj', repo)], [handle()]);
        const work = await runVerify({ k: 'autonomy', op: 'verify:work', agentId: 'sess-1' }, d);
        const w = work?.data as AgentWork;
        const diff = await runVerify({ k: 'autonomy', op: 'verify:diff', agentId: 'sess-1', args: { onlyTouched: true, maxBytes: 4096 } }, d);
        const x = diff?.data as AgentDiff;
        return ok('end to end',
          work?.ok === true && w.cwd === wt && w.touched.length === 1 && w.touched[0]?.path === join(wt, 'src', 'a.ts')
          && w.lastTestRun?.ok === true && w.lastTestRun.command === 'npm test'
          && diff?.ok === true && x.branch === 'fix-a' && x.top === realpathSync(wt) && x.files?.join(',') === 'src/a.ts'
          && !!x.patch && x.patch.includes('+const a = 42;') && !x.patch.includes('README') && x.stat.includes('src/a.ts') && x.touched === 1,
          JSON.stringify({ work: work?.detail ?? { cwd: w?.cwd, touched: w?.touched, test: w?.lastTestRun }, diff: diff?.detail ?? { branch: x?.branch, top: x?.top, files: x?.files, stat: x?.stat } }));
      } finally {
        if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = prev;
      }
    })),
    test('runVerify verify:diff: the hub\'s cwd hint (Agent.worktree) wins over a transcript with no cwd', () => temporaryAsync(async (dir) => {
      const repo = join(dir, 'proj');
      mkdirSync(repo);
      seedRepo(repo);
      const wt = join(repo, '.claude', 'worktrees', 'fix-b');
      mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
      gitIn(repo, 'worktree', 'add', '-q', '-b', 'fix-b', wt);
      writeFileSync(join(wt, 'README.md'), '# from the worktree\n');
      const prev = process.env['CLAUDE_CONFIG_DIR'];
      process.env['CLAUDE_CONFIG_DIR'] = join(dir, 'claude-none');
      try {
        const d = deps([project('m1/slug-proj', repo)], [handle()]);
        const inWt = await runVerify({ k: 'autonomy', op: 'verify:diff', agentId: 'sess-1', args: { cwd: wt } }, d);
        const x = inWt?.data as AgentDiff;
        const outside = await runVerify({ k: 'autonomy', op: 'verify:diff', agentId: 'sess-1', args: { cwd: '/etc' } }, d);
        const y = outside?.data as AgentDiff;
        return ok('hint', inWt?.ok === true && x.branch === 'fix-b' && x.top === realpathSync(wt) && !!x.patch && x.patch.includes('from the worktree')
          && outside?.ok === true && y.branch === 'main' && y.top === realpathSync(repo) && (x.note ?? '').includes('transcript'),
          JSON.stringify({ inWt: inWt?.detail ?? { branch: x?.branch, top: x?.top, note: x?.note }, outside: outside?.detail ?? { branch: y?.branch, top: y?.top } }));
      } finally {
        if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = prev;
      }
    })),
    test('runVerify verify:work on a codex agent says why there is nothing', async () => {
      const d = deps([project('m1/slug-proj', '/x')], [handle({ runtime: 'codex' })]);
      const r = await runVerify({ k: 'autonomy', op: 'verify:work', agentId: 'sess-1' }, d);
      const w = r?.data as AgentWork;
      return ok('codex note', r?.ok === true && w.touched.length === 0 && w.lastTestRun === null && (w.note ?? '').includes('codex'));
    }),

    /* ── hub ──────────────────────────────────────────────────────── */

    test('hub verify.diff dispatches an autonomy command to the agent\'s machine', async () => {
      const sent: unknown[] = [];
      const v = createVerify(autonomyDeps(async (cmd) => { sent.push(cmd); return DIFF; }));
      const out = await v.diff('sess-1', { files: ['a'], maxBytes: 2048.7, onlyTouched: true });
      const cmd = sent[0] as { k: string; op: string; agentId: string; args: Record<string, unknown> };
      return ok('dispatched', out === DIFF && cmd.k === 'autonomy' && cmd.op === 'verify:diff' && cmd.agentId === 'sess-1'
        && cmd.args['maxBytes'] === 2048 && cmd.args['onlyTouched'] === true && cmd.args['patch'] === true && (cmd.args['files'] as string[]).join() === 'a'
        && !('cwd' in cmd.args),
        JSON.stringify(cmd));
    }),
    test('hub verify.diff passes the agent\'s worktree as the cwd hint', async () => {
      const sent: unknown[] = [];
      const wtAgent = { ...agent(), worktree: '/x/.claude/worktrees/w1', branch: 'orca/w1' } as Agent;
      const v = createVerify(autonomyDeps(async (cmd) => { sent.push(cmd); return DIFF; }, [wtAgent]));
      await v.diff('sess-1');
      await v.diff('sess-1', { cwd: '/elsewhere' });
      const a = (sent[0] as { args: Record<string, unknown> }).args;
      const b = (sent[1] as { args: Record<string, unknown> }).args;
      return ok('worktree hint', a['cwd'] === '/x/.claude/worktrees/w1' && b['cwd'] === '/elsewhere', JSON.stringify([a, b]));
    }),
    test('hub verify.summary survives a collector that is down, and says so', async () => {
      const v = createVerify(autonomyDeps(async (cmd) => {
        const c = cmd as { op: string };
        if (c.op === 'verify:work') return WORK;
        throw new Error('máquina no conectada: m1');
      }));
      const s = await v.summary('sess-1');
      return ok('partial', s.touched.join() === '/x/src/a.ts' && s.touchedCount === 1 && s.lastTestRun?.ok === true
        && s.stat === null && s.errors.length === 1 && s.errors[0]!.startsWith('diff: máquina no conectada'), JSON.stringify(s));
    }),
    test('hub verify.summary: a clean tree reads as (clean)', async () => {
      const v = createVerify(autonomyDeps(async (cmd) => ((cmd as { op: string }).op === 'verify:work' ? { ...WORK, touched: [] } : { ...DIFF, stat: '' })));
      const s = await v.summary('sess-1');
      return ok('clean', s.stat === '(clean)' && s.untracked === 1 && s.branch === 'main' && s.errors.length === 0);
    }),
    test('hub verify: an unknown agent is refused before any dispatch', async () => {
      let calls = 0;
      const v = createVerify(autonomyDeps(async () => { calls++; return DIFF; }));
      let err = '';
      try { await v.diff('ghost'); } catch (e) { err = String(e); }
      return ok('refused', calls === 0 && err.includes('ghost'));
    }),
    test('hub verify.consoleUrl: ORCA_CONSOLE_URL wins, else hub or Vite', () => {
      const a = createVerify({ ...autonomyDeps(async () => DIFF), env: { ORCA_CONSOLE_URL: 'https://orca.example/' } }).consoleUrl();
      const b = createVerify({ ...autonomyDeps(async () => DIFF), env: {} }).consoleUrl();
      return ok('urls', a === 'https://orca.example/' && /^http:\/\/127\.0\.0\.1:447[89]\/$/.test(b), `${a} ${b}`);
    }),

    /* ── MCP tools ────────────────────────────────────────────────── */

    test('tools: three verbs, each advertised exactly once and not colliding with a base tool', () => {
      const names = TOOLS.map((t) => t.name).sort().join(',');
      // Sólo lo nuestro: otra pieza con un nombre repetido es su fallo, no éste.
      const counts = TOOLS.map((t) => CEO_TOOLS.filter((c) => c.name === t.name).length);
      const dupes = duplicateToolNames(CEO_TOOLS.filter((t) => !EXTENSION_TOOLS.some((e) => e.name === t.name)))
        .filter((n) => TOOLS.some((t) => t.name === n));
      return ok('names', names === 'agent_diff,screenshot,verify_agent' && counts.every((c) => c === 1) && dupes.length === 0,
        `${names} counts=${counts.join(',')} dupes=${dupes.join(',')}`);
    }),
    test('tools: run returns null for a name that is not ours', async () => {
      return ok('null', (await run(ctxWith({}), 'inspect_agent', {})) === null);
    }),
    test('verify_agent: the summary, with touched files, stat and the last test run', async () => {
      const ctx = ctxWith({ summary: async () => ({ touched: ['/x/src/a.ts'], touchedCount: 1, lastTestRun: WORK.lastTestRun, stat: DIFF.stat, untracked: 1, branch: 'main', top: '/x', errors: [] }) });
      const out = await run(ctx, 'verify_agent', { agent_id: 'k9' });
      const r = JSON.parse(out?.result ?? '{}');
      return ok('summary', !!out && !out.isError && r.touched[0] === '/x/src/a.ts' && r.last_test_run.ok === true && r.stat.includes('src/a.ts')
        && r.untracked === 1 && out.summary.includes('tests passed'), out?.summary);
    }),
    test('verify_agent: nothing reachable is an error with the reasons', async () => {
      const ctx = ctxWith({ summary: async () => ({ touched: [], touchedCount: 0, lastTestRun: null, stat: null, untracked: null, branch: null, top: null, errors: ['work: down', 'diff: down'] }) });
      const out = await run(ctx, 'verify_agent', { agent_id: 'sess-1' });
      return ok('error', out?.isError === true && out.result.includes('work: down'));
    }),
    test('verify_agent / agent_diff: an unknown agent is refused', async () => {
      const ctx = ctxWith({});
      const a = await run(ctx, 'verify_agent', { agent_id: 'zz' });
      const b = await run(ctx, 'agent_diff', { agent_id: 'zz', files: null, max_bytes: null, only_touched: false });
      return ok('refused', a?.isError === true && b?.isError === true);
    }),
    test('agent_diff: passes files, max_bytes and only_touched through and reports truncation', async () => {
      let got: unknown = null;
      const ctx = ctxWith({ diff: async (_id, req) => { got = req; return { ...DIFF, truncated: true, bytes: 100, totalBytes: 5000 }; } });
      const out = await run(ctx, 'agent_diff', { agent_id: 'K9', files: ['src/a.ts', ''], max_bytes: 100, only_touched: true });
      const r = JSON.parse(out?.result ?? '{}');
      const req = got as { files: string[] | null; maxBytes: number | null; onlyTouched: boolean; patch: boolean };
      return ok('diff tool', req.files?.join() === 'src/a.ts' && req.maxBytes === 100 && req.onlyTouched && req.patch
        && r.truncated === true && r.total_bytes === 5000 && r.patch.startsWith('diff --git') && out!.summary.includes('truncated'), out?.summary);
    }),
    test('screenshot: with no target it just shoots; with an agent it moves the camera once the page is up', async () => {
      const seen: CameraDirective[] = [];
      let readyBeforeShot = false;
      const verify: Partial<VerifyApi> = {
        screenshot: async (req) => {
          await req?.onReady?.();
          readyBeforeShot = seen.length === 1;
          return { path: '/tmp/shot.png', url: 'http://127.0.0.1:4479/', bytes: 10, width: 1600, height: 1000, agents: 1 };
        },
      };
      const show = (d: CameraDirective) => { seen.push(d); return 1; };
      const plain = await run(ctxWith(verify, [agent()], show), 'screenshot', { what: null, refs: null, open: false, wait_ms: null });
      const focused = await run(ctxWith(verify, [agent()], show), 'screenshot', { what: 'agent', refs: ['k9'], open: true, wait_ms: 500 });
      const pr = JSON.parse(plain?.result ?? '{}');
      const fr = JSON.parse(focused?.result ?? '{}');
      return ok('camera', pr.path === '/tmp/shot.png' && pr.focused === null && seen.length === 1
        && seen[0]!.what === 'agent' && seen[0]!.refs[0] === 'sess-1' && seen[0]!.open === true
        && fr.focused === 'K9' && fr.consoles_moved === 1 && readyBeforeShot, JSON.stringify({ pr, fr, seen }));
    }),
    test('screenshot: squad, project and fleet targets resolve; a bad target is refused before any browser', async () => {
      const seen: CameraDirective[] = [];
      let shots = 0;
      const verify: Partial<VerifyApi> = { screenshot: async (req) => { shots++; await req?.onReady?.(); return { path: '/tmp/s.png', url: '', bytes: 1, width: 1, height: 1, agents: 0 }; } };
      const agents = [agent({ squad: 'audit-01', lead: true }), agent({ id: 'sess-2', callsign: 'B2', squad: 'audit-01' })];
      const ctx = { ...ctxWith(verify, agents, (d) => { seen.push(d); return 1; }), projects: () => [project('m1/slug-proj', '/x')], project: (id: string) => (id === 'm1/slug-proj' ? project('m1/slug-proj', '/x') : undefined) } as unknown as CeoContext;
      const sq = await run(ctx, 'screenshot', { what: 'squad', refs: ['audit-01'], open: false, wait_ms: null });
      const pj = await run(ctx, 'screenshot', { what: 'project', refs: ['pj'], open: false, wait_ms: null });
      const fl = await run(ctx, 'screenshot', { what: 'fleet', refs: null, open: false, wait_ms: null });
      const bad = await run(ctx, 'screenshot', { what: 'moon', refs: null, open: false, wait_ms: null });
      const noSquad = await run(ctx, 'screenshot', { what: 'squad', refs: ['nope-99'], open: false, wait_ms: null });
      return ok('targets', !sq?.isError && !pj?.isError && !fl?.isError && bad?.isError === true && noSquad?.isError === true && shots === 3
        && seen.map((d) => d.what).join() === 'squad,project,fleet' && seen[0]!.projectId === 'm1/slug-proj' && seen[1]!.refs[0] === 'm1/slug-proj',
        JSON.stringify({ shots, seen: seen.map((d) => [d.what, d.refs, d.projectId]), bad: bad?.result, noSquad: noSquad?.result }));
    }),
    test('screenshot: a hub without Playwright answers with what to install, not a crash', async () => {
      const ctx = ctxWith({ screenshot: async () => { throw new Error('screenshot needs Playwright on the hub machine: `npm i -D playwright && npx playwright install chromium`'); } });
      let err = '';
      try { await run(ctx, 'screenshot', { what: null, refs: null, open: false, wait_ms: null }); } catch (e) { err = String(e); }
      // El throw lo captura runTool en tools.ts y lo convierte en isError; aquí basta con que salga el mensaje.
      return ok('explains', err.includes('playwright install chromium'));
    }),
  ],
};

export default suite;
