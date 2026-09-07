/**
 * Pieza B del squad autonomy: `verify`. Lado collector.
 *
 * Verificar el trabajo de un agente sin fiarse de su reporte. Dos `op` del
 * comando `autonomy`, y ninguna de las dos escucha al agente:
 *
 *   verify:work   qué archivos tocó y la última suite de tests que corrió,
 *                 leídos del transcript en disco: los `tool_use` de
 *                 Edit/Write/MultiEdit/NotebookEdit (más las líneas
 *                 `file-history-delta` que Claude Code escribe antes de cada
 *                 escritura), y el último Bash con pinta de test con su
 *                 `tool_result` — la cola de la salida y si terminó bien.
 *   verify:diff   `git diff --stat` y el patch del working tree del agente
 *                 (su worktree, si corre en uno), acotado en bytes y, si se
 *                 pide, sólo de los archivos que tocó.
 *
 * ── Postura de seguridad ──────────────────────────────────────────
 *
 *   1. git corre SÓLO en lectura — `rev-parse`, `diff`, `status` — y SÓLO con
 *      cwd dentro de una raíz de proyecto que este collector ya descubrió
 *      (ProjectRegistry). El cwd del transcript vale si cae dentro de una de
 *      esas raíces (un worktree bajo `<proyecto>/.claude/worktrees/` lo hace);
 *      si no, se usa la raíz del proyecto. La raíz del árbol que git declara
 *      (`--show-toplevel`) se vuelve a comprobar contra las mismas raíces.
 *   2. Las rutas de `files` van detrás de `--` y se descartan las que salgan
 *      del árbol: ni una opción colada, ni una ruta de sistema.
 *   3. Nunca hay shell: argv como array, `spawn(..., { shell: false })`.
 *   4. El transcript se lee en streaming, línea a línea, nunca entero en
 *      memoria: una sesión larga pesa decenas de megas.
 *
 * Lo que sale por el cable está acotado (`maxBytes`, MAX_TOUCHED,
 * MAX_TAIL_BYTES): un patch de un refactor de mil archivos no es algo que
 * CAPCOM vaya a leer, y no debe poder tumbar el socket.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import type { AutonomyCommand } from '../shared/protocol.ts';
import type { Project } from '../shared/types.ts';
import type { AgentHandle, CommandDeps, CommandResult } from './commands.ts';
import { findBin } from './runtime.ts';
import { claudeProjectsDir, errText, isInside, isRecord, launchable, log, str, tsMs } from './util.ts';

const SCOPE = 'verify';

/* ── límites ──────────────────────────────────────────────────────── */

export const DEFAULT_MAX_BYTES = 64 * 1024;
export const MIN_MAX_BYTES = 1024;
export const MAX_MAX_BYTES = 1024 * 1024;
/** `--stat` de un refactor grande: pasado esto ya no informa, sólo pesa. */
const STAT_MAX_BYTES = 16 * 1024;
/** Archivos tocados por agente que viajan. Los más recientes ganan. */
export const MAX_TOUCHED = 500;
const MAX_UNTRACKED = 200;
export const DEFAULT_TAIL_LINES = 40;
export const MAX_TAIL_LINES = 200;
export const MAX_TAIL_BYTES = 8 * 1024;
const GIT_TIMEOUT_MS = 20_000;
/** Un patch más grande que esto ni se termina de leer: el `git` se mata. */
const HARD_STOP_FACTOR = 16;

/**
 * Mismo marcador que projects.ts (no exportado allí): el slug de un worktree
 * de `claude --bg` es el del proyecto más `--claude-worktrees-<nombre>`.
 */
const WORKTREE_MARK = '--claude-worktrees-';

/* ── qué tocó ─────────────────────────────────────────────────────── */

/** Tools de Claude Code que escriben un archivo. `Task`/`Bash` no cuentan: no dicen qué. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface TouchedFile {
  /** Ruta absoluta cuando el transcript permite anclarla; tal cual si no. */
  path: string;
  /** Con qué se escribió: Edit, Write, … o `file-history` si sólo lo vio el respaldo. */
  tools: string[];
  writes: number;
  firstAt: number;
  lastAt: number;
}

export interface TestRun {
  command: string;
  /** null = el Bash sigue sin `tool_result`: está corriendo, o murió sin cerrar. */
  ok: boolean | null;
  /** Últimas líneas de la salida, recortadas. Vacío mientras corre. */
  tail: string;
  /** Cuándo se lanzó. */
  at: number;
  finishedAt: number | null;
  /** Exit code cuando Claude Code lo escribió en la salida. */
  exitCode: number | null;
}

export interface WorkScan {
  cwd: string | null;
  touched: TouchedFile[];
  lastTestRun: TestRun | null;
  /** Líneas de transcript leídas. Para saber que se leyó algo. */
  lines: number;
}

export interface ScanOptions {
  /** Líneas de cola que se guardan de la salida del test. */
  tailLines?: number;
}

/**
 * El escáner, línea a línea. Es una clase y no una función sobre un array para
 * poder alimentarlo desde un stream; `scanTranscript` es la forma cómoda.
 */
export class WorkScanner {
  cwd: string | null = null;
  lines = 0;
  private readonly tailLines: number;
  private readonly touched = new Map<string, TouchedFile>();
  /** tool_use_id → el Bash de test que espera resultado. */
  private pendingTest: { id: string; run: TestRun } | null = null;
  private last: TestRun | null = null;

  constructor(opts: ScanOptions = {}) {
    this.tailLines = clampInt(opts.tailLines, DEFAULT_TAIL_LINES, 1, MAX_TAIL_LINES);
  }

  line(l: Record<string, unknown>): void {
    this.lines++;
    const cwd = str(l['cwd']);
    if (cwd && path.isAbsolute(cwd)) this.cwd = cwd;
    const type = l['type'];
    const at = tsMs(l['timestamp'], 0);
    if (type === 'assistant') this.assistant(l, at);
    else if (type === 'user') this.user(l, at);
    else if (type === 'file-history-delta') this.delta(l, at);
  }

  result(): WorkScan {
    const touched = [...this.touched.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_TOUCHED);
    // Una suite lanzada y sin cerrar es más reciente que la anterior cerrada:
    // es la que CAPCOM quiere ver ("está corriendo"), no la de hace una hora.
    const pending = this.pendingTest?.run ?? null;
    const last = pending && (!this.last || pending.at >= this.last.at) ? pending : this.last;
    return { cwd: this.cwd, touched, lastTestRun: last, lines: this.lines };
  }

  private assistant(l: Record<string, unknown>, at: number): void {
    const msg = isRecord(l['message']) ? l['message'] : null;
    const content = msg && Array.isArray(msg['content']) ? msg['content'] : [];
    for (const raw of content) {
      if (!isRecord(raw) || raw['type'] !== 'tool_use') continue;
      const name = str(raw['name']) ?? '';
      const input = isRecord(raw['input']) ? raw['input'] : null;
      if (WRITE_TOOLS.has(name)) {
        const file = input ? (str(input['file_path']) ?? str(input['notebook_path'])) : null;
        if (file) this.note(this.anchor(file), name, at);
      } else if (name === 'Bash' && input) {
        const command = str(input['command']);
        if (command && isTestCommand(command)) {
          const id = str(raw['id']) ?? `bash:${at}`;
          this.pendingTest = {
            id,
            run: { command: command.trim().slice(0, 400), ok: null, tail: '', at, finishedAt: null, exitCode: null },
          };
        }
      }
    }
  }

  private user(l: Record<string, unknown>, at: number): void {
    const pending = this.pendingTest;
    if (!pending) return;
    const msg = isRecord(l['message']) ? l['message'] : null;
    const content = msg && Array.isArray(msg['content']) ? msg['content'] : [];
    for (const raw of content) {
      if (!isRecord(raw) || raw['type'] !== 'tool_result') continue;
      if (str(raw['tool_use_id']) !== pending.id) continue;
      const text = resultText(raw['content']);
      const exitCode = exitCodeOf(text);
      const errored = raw['is_error'] === true;
      pending.run.tail = tailOf(text, this.tailLines);
      pending.run.finishedAt = at || null;
      pending.run.exitCode = exitCode;
      pending.run.ok = !errored && (exitCode === null || exitCode === 0);
      this.last = pending.run;
      this.pendingTest = null;
      return;
    }
  }

  private delta(l: Record<string, unknown>, at: number): void {
    const tracking = str(l['trackingPath']);
    if (!tracking) return;
    const backup = isRecord(l['backup']) ? l['backup'] : null;
    const parent = backup ? str(backup['realParentDir']) : null;
    const base = path.basename(tracking);
    if (!base || base === '.' || base === '..') return;
    const abs = parent && path.isAbsolute(parent) ? path.join(parent, base) : this.anchor(tracking);
    const when = tsMs(backup?.['backupTime'], 0) || at;
    this.note(abs, 'file-history', when);
  }

  private anchor(file: string): string {
    if (path.isAbsolute(file)) return path.resolve(file);
    return this.cwd ? path.resolve(this.cwd, file) : file;
  }

  private note(file: string, tool: string, at: number): void {
    const prev = this.touched.get(file);
    if (prev) {
      prev.writes++;
      if (!prev.tools.includes(tool)) prev.tools.push(tool);
      if (at > prev.lastAt) prev.lastAt = at;
      if (at > 0 && (prev.firstAt === 0 || at < prev.firstAt)) prev.firstAt = at;
      return;
    }
    this.touched.set(file, { path: file, tools: [tool], writes: 1, firstAt: at, lastAt: at });
    // Acotado en memoria también: una sesión de días no puede crecer sin fin.
    if (this.touched.size > MAX_TOUCHED * 2) {
      const keep = [...this.touched.entries()].sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, MAX_TOUCHED);
      this.touched.clear();
      for (const [k, v] of keep) this.touched.set(k, v);
    }
  }
}

/** La forma cómoda para tests y fixtures: líneas ya parseadas. */
export function scanTranscript(lines: Iterable<Record<string, unknown>>, opts?: ScanOptions): WorkScan {
  const s = new WorkScanner(opts);
  for (const l of lines) s.line(l);
  return s.result();
}

/** Lee un .jsonl en streaming. Las líneas corruptas se saltan, como hace watch.ts. */
export async function scanTranscriptFile(file: string, opts?: ScanOptions): Promise<WorkScan> {
  const s = new WorkScanner(opts);
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const raw of rl) {
    const t = raw.trim();
    if (!t) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { continue; }
    if (isRecord(parsed)) s.line(parsed);
  }
  return s.result();
}

/* ── ¿es un test? ─────────────────────────────────────────────────── */

/**
 * Comandos que ejecutan una suite. Se busca como subcadena porque el Bash real
 * viene envuelto: `cd x && npm test 2>&1 | tail -50`. La lista es la de los
 * ecosistemas que aparecen en los transcripts de esta máquina más los obvios;
 * un runner que no esté aquí no rompe nada, sólo no se detecta.
 */
const TEST_PATTERNS: RegExp[] = [
  /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)(?::[\w-]+)?(?=\s|$)/,
  /(?:^|[\s;&|(])(?:npx|pnpm|yarn|bunx?)\s+(?:vitest|jest|mocha|ava|uvu|tap|playwright\s+test)(?=\s|$)/,
  /(?:^|[\s;&|(])(?:vitest|jest|mocha|ava)(?=\s|$)/,
  /(?:^|[\s;&|(])(?:npx\s+)?tsx\s+(?:watch\s+)?test\/\S+/,
  /(?:^|[\s;&|(])node\s+(?:--test(?=\s|$)|\S*test\/run\.[cm]?js)/,
  /(?:^|[\s;&|(])(?:python3?\s+-m\s+)?pytest(?=\s|$)/,
  /(?:^|[\s;&|(])python3?\s+-m\s+unittest(?=\s|$)/,
  /(?:^|[\s;&|(])go\s+test(?=\s|$)/,
  /(?:^|[\s;&|(])cargo\s+(?:nextest\s+run|test)(?=\s|$)/,
  /(?:^|[\s;&|(])deno\s+test(?=\s|$)/,
  /(?:^|[\s;&|(])mix\s+test(?=\s|$)/,
  /(?:^|[\s;&|(])(?:bundle\s+exec\s+)?rspec(?=\s|$)/,
  /(?:^|[\s;&|(])(?:vendor\/bin\/)?phpunit(?=\s|$)/,
  /(?:^|[\s;&|(])dotnet\s+test(?=\s|$)/,
  /(?:^|[\s;&|(])(?:\.\/)?gradlew?\s+\S*test(?=\s|$)/,
  /(?:^|[\s;&|(])mvn\s+\S*test(?=\s|$)/,
  /(?:^|[\s;&|(])make\s+(?:check|test)(?=\s|$)/,
  /(?:^|[\s;&|(])swift\s+test(?=\s|$)/,
  /(?:^|[\s;&|(])ctest(?=\s|$)/,
];

export function isTestCommand(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  return TEST_PATTERNS.some((re) => re.test(c));
}

/* ── helpers del escáner ──────────────────────────────────────────── */

function resultText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .map((b) => (isRecord(b) && b['type'] === 'text' ? str(b['text']) ?? '' : ''))
    .filter(Boolean)
    .join('\n');
}

/** `Exit code 1` es lo primero que Claude Code escribe cuando un Bash falla. */
export function exitCodeOf(text: string): number | null {
  const m = /(?:^|\n)\s*Exit code[: ]+(\d+)/i.exec(text);
  return m ? Number(m[1]) : null;
}

export function tailOf(text: string, lines: number): string {
  const all = text.replace(/\r/g, '').replace(/\s+$/, '').split('\n');
  let out = all.slice(-Math.max(1, lines)).join('\n');
  if (Buffer.byteLength(out) > MAX_TAIL_BYTES) {
    const buf = Buffer.from(out);
    out = '…' + buf.subarray(buf.length - MAX_TAIL_BYTES).toString('utf8').replace(/^[^\n]*\n/, '');
  }
  return out;
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/* ── truncado ─────────────────────────────────────────────────────── */

export interface Truncated {
  text: string;
  truncated: boolean;
  bytes: number;
  totalBytes: number;
}

/**
 * Corta a `maxBytes` en un límite de línea y lo dice al final del texto, para
 * que quien lo lea no tome un patch a medias por el patch entero.
 */
export function truncate(text: string, maxBytes: number, what = 'patch'): Truncated {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false, bytes: buf.length, totalBytes: buf.length };
  let cut = buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
  const nl = cut.lastIndexOf('\n');
  if (nl > 0) cut = cut.slice(0, nl);
  const kept = Buffer.byteLength(cut);
  const out = `${cut}\n[orca: ${what} truncated to ${kept} of ${buf.length} bytes — narrow with files, or raise max_bytes]`;
  return { text: out, truncated: true, bytes: kept, totalBytes: buf.length };
}

/* ── git, en lectura ──────────────────────────────────────────────── */

export interface DiffOptions {
  /** Rutas relativas a la raíz del árbol (o absolutas dentro de él). null = todo. */
  files: string[] | null;
  maxBytes: number;
  /** false = sólo `--stat`; el patch no se genera. */
  patch: boolean;
  /** Restringe a lo que el transcript dice que el agente escribió. */
  onlyTouched: boolean;
}

export interface DiffResult {
  /** Dónde corrió git: el cwd del agente cuando cae en un proyecto conocido. */
  cwd: string;
  /** La raíz del proyecto al que se atribuye. */
  root: string;
  /** La raíz del árbol git (el worktree, si es uno). */
  top: string;
  branch: string | null;
  stat: string;
  untracked: string[];
  patch: string | null;
  truncated: boolean;
  bytes: number;
  totalBytes: number;
  /** Los archivos por los que se filtró, relativos a `top`; null = sin filtro. */
  files: string[] | null;
  /** Rutas pedidas y descartadas por salir del árbol. */
  ignored: string[];
  /** Qué se leyó del transcript para `onlyTouched`, si aplicó. */
  touched: number | null;
}

let gitBin: string | null | undefined;

function git(): string | null {
  if (gitBin === undefined) {
    gitBin = findBin('git', 'ORCA_GIT_BIN');
    if (!gitBin) log('warn', SCOPE, 'no encontré `git` en PATH: verify:diff no funcionará');
  }
  return gitBin;
}

interface GitOut { code: number | null; stdout: string; stderr: string; truncated: boolean; totalBytes: number }

/**
 * Un git, sin shell, con la salida acotada. Pasado `cap` bytes se deja de
 * guardar pero se sigue contando; pasado `cap × HARD_STOP_FACTOR` se mata,
 * porque a esas alturas el total ya no le importa a nadie.
 */
function runGit(bin: string, args: string[], cwd: string, cap: number): Promise<GitOut> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let kept = 0;
    let total = 0;
    let stderr = '';
    let settled = false;
    const done = (r: GitOut): void => { if (!settled) { settled = true; resolve(r); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ['--no-pager', ...args], {
        cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      });
    } catch (err) {
      done({ code: null, stdout: '', stderr: errText(err), truncated: false, totalBytes: 0 });
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ya murió */ } }, GIT_TIMEOUT_MS);
    child.stdout?.on('data', (c: Buffer) => {
      total += c.length;
      if (kept < cap) { chunks.push(c); kept += c.length; }
      if (total > cap * HARD_STOP_FACTOR) { try { child.kill('SIGTERM'); } catch { /* ya */ } }
    });
    child.stderr?.on('data', (c: Buffer) => { if (stderr.length < 4096) stderr += c.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); done({ code: null, stdout: '', stderr: errText(err), truncated: false, totalBytes: total }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout: Buffer.concat(chunks).toString('utf8'), stderr, truncated: total > kept, totalBytes: total });
    });
  });
}

function realpathQuiet(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Las raíces en las que git tiene permiso para correr: los proyectos conocidos, y nada más. */
function knownRoots(projects: Project[]): string[] {
  const out: string[] = [];
  for (const p of projects) {
    const resolved = path.resolve(p.path);
    if (!launchable(resolved).ok) continue;
    const real = realpathQuiet(resolved);
    if (real && isDir(real)) out.push(real);
  }
  return out;
}

function rootOf(roots: string[], p: string): string | null {
  const real = realpathQuiet(p);
  if (!real) return null;
  // La raíz más larga gana: un proyecto anidado en otro es su propia raíz.
  // Las raíces también pasan por realpath: en macOS /var es /private/var, y
  // una raíz escrita de una forma y un cwd resuelto de la otra son el mismo
  // sitio.
  let best: string | null = null;
  for (const raw of roots) {
    const r = realpathQuiet(raw) ?? path.resolve(raw);
    if (isInside(r, real) && (!best || r.length > best.length)) best = r;
  }
  return best;
}

/**
 * Dónde correr git para este agente. El primer candidato que sea un
 * directorio dentro de una raíz conocida —la pista del hub (el worktree que
 * el Agent anota), luego el cwd del transcript—; si ninguno, la raíz de su
 * proyecto.
 */
export function pickDir(
  roots: string[], projectPath: string | null, ...candidates: (string | null | undefined)[]
): { dir: string; root: string } | { error: string } {
  for (const cwd of candidates) {
    if (!cwd || !isDir(cwd)) continue;
    const r = rootOf(roots, cwd);
    if (r) return { dir: realpathQuiet(cwd) ?? cwd, root: r };
  }
  if (!projectPath) return { error: 'proyecto desconocido' };
  const r = rootOf(roots, projectPath);
  if (!r) return { error: `la raíz del proyecto no es un directorio conocido: ${projectPath}` };
  return { dir: r, root: r };
}

/**
 * Rutas que git puede recibir: relativas a `top` y dentro de él. Devuelve las
 * buenas y las descartadas. Ninguna puede empezar por `-`: el `--` ya lo
 * impide, pero mejor que ni lleguen.
 */
export function cleanFiles(files: string[], top: string): { ok: string[]; ignored: string[] } {
  const ok: string[] = [];
  const ignored: string[] = [];
  const tops = unique([top, realpathQuiet(top)]);
  for (const raw of files) {
    const f = String(raw ?? '').trim();
    if (!f) continue;
    const abs = path.isAbsolute(f) ? path.resolve(f) : path.resolve(top, f);
    // Un archivo borrado ya no tiene realpath; el resuelto a secas sirve.
    const rel = relativeInside(tops, unique([abs, realpathQuiet(abs)]));
    if (!rel) {
      ignored.push(f);
      continue;
    }
    const posix = rel.split(path.sep).join('/');
    if (!ok.includes(posix)) ok.push(posix);
  }
  return { ok, ignored };
}

function unique(list: (string | null)[]): string[] {
  return [...new Set(list.filter((x): x is string => !!x))];
}

/** La primera combinación (raíz, ruta) en la que la ruta cae dentro, como relativa. */
function relativeInside(tops: string[], candidates: string[]): string | null {
  for (const t of tops) {
    for (const c of candidates) {
      const rel = path.relative(t, c);
      if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel) || rel.startsWith('-')) continue;
      return rel;
    }
  }
  return null;
}

/** El transcript de esta sesión en disco, o null. Sólo Claude Code por ahora. */
export function transcriptFor(a: AgentHandle, project: Project | null, base = claudeProjectsDir()): string | null {
  if (a.runtime !== 'claude' || !project) return null;
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(base).filter((n) => n === project.slug || n.startsWith(project.slug + WORKTREE_MARK));
  } catch {
    return null;
  }
  for (const d of dirs) {
    const root = path.join(base, d, `${a.sessionId}.jsonl`);
    if (a.id === a.sessionId && fs.existsSync(root)) return root;
    if (a.id !== a.sessionId) {
      const sub = path.join(base, d, a.sessionId, 'subagents', `agent-${a.id}.jsonl`);
      if (fs.existsSync(sub)) return sub;
    }
  }
  return null;
}

async function branchOf(bin: string, dir: string): Promise<string | null> {
  const r = await runGit(bin, ['rev-parse', '--abbrev-ref', 'HEAD'], dir, 512);
  return r.code === 0 ? (r.stdout.trim() || null) : null;
}

/** `git diff HEAD` cuando hay HEAD; en un repo recién creado, contra el índice. */
async function diffArgs(bin: string, dir: string): Promise<string[]> {
  const head = await runGit(bin, ['rev-parse', '--verify', '-q', 'HEAD'], dir, 256);
  return head.code === 0 ? ['diff', '--no-color', '--no-ext-diff', 'HEAD'] : ['diff', '--no-color', '--no-ext-diff'];
}

export async function gitDiff(dir: string, root: string, roots: string[], opts: DiffOptions, touchedAbs: string[] | null): Promise<DiffResult | { error: string }> {
  const bin = git();
  if (!bin) return { error: '`git` no está en PATH (o ORCA_GIT_BIN no apunta a un ejecutable)' };
  const topOut = await runGit(bin, ['rev-parse', '--show-toplevel'], dir, 4096);
  if (topOut.code !== 0) return { error: `no es un repositorio git: ${dir} (${topOut.stderr.trim() || 'sin detalle'})` };
  const top = realpathQuiet(topOut.stdout.trim()) ?? topOut.stdout.trim();
  if (!rootOf(roots, top)) return { error: `la raíz del árbol git (${top}) sale de los proyectos conocidos; no se ejecuta nada ahí` };

  let files: string[] | null = null;
  let ignored: string[] = [];
  let touched: number | null = null;
  if (opts.onlyTouched) {
    touched = touchedAbs?.length ?? 0;
    const cleaned = cleanFiles(touchedAbs ?? [], top);
    files = cleaned.ok;
    ignored = cleaned.ignored;
  }
  if (opts.files && opts.files.length) {
    const cleaned = cleanFiles(opts.files, top);
    ignored = [...ignored, ...cleaned.ignored];
    files = files ? files.filter((f) => cleaned.ok.includes(f)) : cleaned.ok;
  }
  const scope = files && files.length ? ['--', ...files] : [];
  const nothing = files !== null && files.length === 0;

  const base = await diffArgs(bin, top);
  const branch = await branchOf(bin, top);

  let stat = '';
  let untracked: string[] = [];
  if (!nothing) {
    const s = await runGit(bin, [...base, '--stat=110', ...scope], top, STAT_MAX_BYTES);
    if (s.code !== 0 && s.code !== null) return { error: `git diff --stat falló: ${s.stderr.trim() || `código ${s.code}`}` };
    stat = truncate(s.stdout.replace(/\s+$/, ''), STAT_MAX_BYTES, 'stat').text;
    const u = await runGit(bin, ['status', '--porcelain=v1', '--untracked-files=all', '--no-renames', ...scope], top, STAT_MAX_BYTES);
    if (u.code === 0) {
      untracked = u.stdout.split('\n').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim()).slice(0, MAX_UNTRACKED);
    }
  }

  let patch: string | null = null;
  let truncated = false;
  let bytes = 0;
  let totalBytes = 0;
  if (opts.patch && !nothing) {
    const p = await runGit(bin, [...base, ...scope], top, opts.maxBytes);
    if (p.code !== 0 && p.code !== null) return { error: `git diff falló: ${p.stderr.trim() || `código ${p.code}`}` };
    const t = truncate(p.stdout, opts.maxBytes);
    patch = t.text;
    truncated = t.truncated || p.truncated;
    bytes = t.bytes;
    totalBytes = Math.max(t.totalBytes, p.totalBytes);
    if (p.truncated && !t.truncated) {
      patch += `\n[orca: patch truncated to ${bytes} of ${totalBytes} bytes — narrow with files, or raise max_bytes]`;
    }
  }

  return { cwd: dir, root, top, branch, stat, untracked, patch, truncated, bytes, totalBytes, files, ignored, touched };
}

/* ── el handler ───────────────────────────────────────────────────── */

function diffOptions(args: Record<string, unknown>): DiffOptions {
  const files = Array.isArray(args['files'])
    ? args['files'].filter((f): f is string => typeof f === 'string' && f.trim().length > 0).slice(0, 200)
    : null;
  return {
    files: files && files.length ? files : null,
    maxBytes: clampInt(args['maxBytes'], DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES),
    patch: args['patch'] !== false,
    onlyTouched: args['onlyTouched'] === true,
  };
}

async function workOf(a: AgentHandle, project: Project | null, args: Record<string, unknown>): Promise<
  { scan: WorkScan; transcript: string | null; note: string | null }
> {
  const transcript = transcriptFor(a, project);
  if (!transcript) {
    const note = a.runtime !== 'claude'
      ? `${a.runtime}: el escaneo de transcript sólo está hecho para Claude Code`
      : 'no encontré el transcript de esta sesión en disco';
    return { scan: { cwd: null, touched: [], lastTestRun: null, lines: 0 }, transcript: null, note };
  }
  try {
    const scan = await scanTranscriptFile(transcript, { tailLines: clampInt(args['tail'], DEFAULT_TAIL_LINES, 1, MAX_TAIL_LINES) });
    return { scan, transcript, note: null };
  } catch (err) {
    return { scan: { cwd: null, touched: [], lastTestRun: null, lines: 0 }, transcript, note: `no pude leer el transcript: ${errText(err)}` };
  }
}

export async function runVerify(cmd: AutonomyCommand, deps: CommandDeps): Promise<CommandResult | null> {
  if (!cmd.op.startsWith('verify:')) return null;
  const a = deps.agent(cmd.agentId);
  if (!a) return { ok: false, detail: `agente desconocido: ${cmd.agentId}` };
  const project = deps.projects.get(a.projectId);
  const args = isRecord(cmd.args) ? cmd.args : {};

  switch (cmd.op) {
    case 'verify:work': {
      const { scan, transcript, note } = await workOf(a, project, args);
      return {
        ok: true,
        data: {
          agentId: a.id, callsign: a.callsign, runtime: a.runtime,
          cwd: scan.cwd, transcript, lines: scan.lines,
          touched: scan.touched, lastTestRun: scan.lastTestRun,
          ...(note ? { note } : {}),
        },
      };
    }
    case 'verify:diff': {
      const opts = diffOptions(args);
      const roots = knownRoots(deps.projects.all());
      // El cwd sale del transcript: es el único sitio donde el agente dice
      // dónde corre, y es también lo que hace falta para `onlyTouched`.
      const { scan, note } = await workOf(a, project, args);
      // La pista del hub (Agent.worktree) va primero; luego el worktree que
      // este collector creó al lanzarlo (ORCA_WORKTREES=1); luego el transcript.
      const picked = pickDir(roots, project?.path ?? null, str(args['cwd']), a.worktree?.path ?? null, scan.cwd);
      if ('error' in picked) return { ok: false, detail: picked.error };
      const out = await gitDiff(picked.dir, picked.root, roots, opts, opts.onlyTouched ? scan.touched.map((t) => t.path) : null);
      if ('error' in out) return { ok: false, detail: out.error };
      log('info', SCOPE, `diff de ${a.callsign} en ${out.top}: ${out.bytes}/${out.totalBytes} bytes${out.truncated ? ' (truncado)' : ''}`);
      return { ok: true, data: { agentId: a.id, callsign: a.callsign, ...out, ...(note ? { note } : {}) } };
    }
    default:
      return { ok: false, detail: `verify: op desconocida: ${cmd.op}` };
  }
}
