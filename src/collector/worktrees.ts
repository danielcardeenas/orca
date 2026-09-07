/**
 * Worktrees: cada worker en su propia copia del repo, y una forma de aterrizar
 * lo que hizo.
 *
 * Hoy todos los workers que lanza CAPCOM corren sobre el working tree del
 * proyecto, sin commit, y se pisan. Con `ORCA_WORKTREES=1` en el collector,
 * cada spawn va a un git worktree propio:
 *
 *   <proyecto>/.claude/worktrees/<nombre>/     el directorio
 *   orca/<nombre>                              la rama, creada desde HEAD
 *
 * El nombre es el short id de la sesión (o el del escuadrón, cuando el líder
 * pidió `shared_worktree`). La ruta es la misma que usa `claude --bg`, así que
 * projects.ts ya la atribuye al proyecto en vez de inventar uno (ver
 * foldWorktreeSlug).
 *
 * `land` integra la rama del worker en la rama del proyecto. La decisión:
 *
 *   1. lo que el worker dejó sin commitear se commitea en SU rama (nada se
 *      pierde, y un rebase no arranca sobre un tree sucio);
 *   2. la rama del worker se REBASEA sobre la del proyecto, dentro del
 *      worktree — un conflicto aparece ahí, se aborta, y la rama del proyecto
 *      no se ha tocado;
 *   3. se corre la suite del proyecto EN EL WORKTREE ya rebaseado, que es
 *      exactamente lo que la rama del proyecto va a ser;
 *   4. si pasa, un solo commit en la rama del proyecto (`merge --squash`) con
 *      el callsign y la tarea en el mensaje, y la rama del worker se deja al
 *      nivel del proyecto para que pueda seguir trabajando.
 *
 * Rebase y no merge porque la historia queda lineal y el conflicto se resuelve
 * donde el worker puede verlo. Squash y no fast-forward porque el mensaje del
 * commit tiene que decir quién y para qué, y un worker deja diez "wip".
 *
 * El working tree del proyecto puede estar sucio —el operador trabaja ahí— y
 * eso NO es un error: `merge --squash` sólo se niega si un archivo sucio es de
 * los que trae la rama, y entonces se devuelve como conflicto. Lo que sí se
 * exige es un índice limpio: `git commit` commitea lo que hay en el índice, y
 * llevarse lo que el operador tenía a medio preparar sería mentir en el log.
 *
 * Todo git corre sin shell, argv como array. Ningún nombre llega aquí sin
 * pasar por NAME_RE.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { errText, log, oneLine, safeJson } from './util.ts';

const SCOPE = 'worktrees';

export const WORKTREES_DIR = path.join('.claude', 'worktrees');
export const BRANCH_PREFIX = 'orca/';
/** Un nombre de worktree: short id, callsign o escuadrón. Nada más entra en un argv. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Config por proyecto: `<proyecto>/.orca/land.json`. */
export const LAND_CONFIG = path.join('.orca', 'land.json');
/** Cuánto se espera a la suite antes de darla por colgada. */
export const DEFAULT_TEST_TIMEOUT_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL = 4000;

/** `ORCA_WORKTREES=1` (o true/on) en el collector. Sin eso, nada de esto se toca. */
export function worktreesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['ORCA_WORKTREES'] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

export function branchFor(name: string): string { return `${BRANCH_PREFIX}${name}`; }
export function worktreePath(projectPath: string, name: string): string {
  return path.join(path.resolve(projectPath), WORKTREES_DIR, name);
}

export interface WorktreeInfo {
  /** Ruta absoluta del worktree. */
  path: string;
  /** La rama del worker, `orca/<nombre>`. */
  branch: string;
}

export interface WorktreeStatus {
  exists: boolean;
  /** Cambios sin commitear en el worktree. */
  dirty: boolean;
  /** Commits de la rama del worker que la del proyecto no tiene. */
  ahead: number;
  /** Commits del proyecto que el worker aún no tiene. */
  behind: number;
  /** La rama del proyecto, o null si está en HEAD suelto. */
  projectBranch: string | null;
}

export interface TestRun {
  command: string[];
  ok: boolean;
  code: number | null;
  /** Las últimas líneas de la salida, para leer el porqué sin abrir nada. */
  output: string;
  durationMs: number;
}

export interface LandOptions {
  /** Quién aterriza, para el mensaje del commit. */
  callsign: string;
  mission: string | null;
  /** Título del commit. Sin él: "land <callsign>: <misión>". */
  message?: string | null;
  /** Default true. */
  runTests?: boolean;
  /** Fuerza el comando de la suite, por encima de la detección y la config. */
  testCommand?: string[] | null;
  testTimeoutMs?: number;
}

export type LandResult =
  | {
      ok: true;
      commit: string;
      branch: string;
      projectBranch: string;
      /** Archivos que tocó el commit. */
      files: string[];
      tests: TestRun | null;
      /** Por qué no hubo suite, cuando no la hubo. */
      note: string | null;
    }
  | {
      ok: false;
      reason: 'nothing' | 'conflict' | 'tests' | 'index' | 'error';
      detail: string;
      /** Archivos en conflicto, cuando `reason` es conflict. */
      conflicts: string[];
      tests: TestRun | null;
    };

export type DiscardResult =
  | { ok: true; removed: boolean; detail: string }
  | { ok: false; detail: string; status: WorktreeStatus | null };

/* ── git sin shell ────────────────────────────────────────────────── */

interface Exec { ok: boolean; code: number | null; stdout: string; stderr: string; }

function exec(cmd: string, args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS, env?: NodeJS.ProcessEnv): Promise<Exec> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: Exec): void => { if (!settled) { settled = true; resolve(r); } };
    try {
      const child = execFile(cmd, args, {
        cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false, windowsHide: true,
        env: env ?? { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      }, (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number | string }).code as number | undefined ?? null) : 0;
        done({ ok: !err, code: typeof code === 'number' ? code : null, stdout: String(stdout), stderr: String(stderr) });
      });
      child.on('error', (err) => done({ ok: false, code: null, stdout: '', stderr: errText(err) }));
    } catch (err) {
      done({ ok: false, code: null, stdout: '', stderr: errText(err) });
    }
  });
}

const git = (args: string[], cwd: string): Promise<Exec> => exec('git', args, cwd);

function why(r: Exec): string { return oneLine(r.stderr || r.stdout, 300) || `salió con ${r.code}`; }

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  return r.ok ? r.stdout.trim() || null : null;
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd)).ok;
}

/** Las rutas que `git worktree list` conoce, resueltas. */
async function registeredWorktrees(projectPath: string): Promise<Set<string>> {
  const r = await git(['worktree', 'list', '--porcelain'], projectPath);
  const out = new Set<string>();
  if (!r.ok) return out;
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const p = line.slice('worktree '.length).trim();
    try { out.add(fs.realpathSync(p)); } catch { out.add(path.resolve(p)); }
  }
  return out;
}

function real(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * Que el directorio de worktrees no aparezca como untracked en el proyecto.
 *
 * Va a `.git/info/exclude` y no a `.gitignore`: lo segundo es un archivo del
 * proyecto y tocarlo sería un cambio que el operador no pidió.
 */
async function excludeWorktreesDir(projectPath: string): Promise<void> {
  const r = await git(['rev-parse', '--git-common-dir'], projectPath);
  if (!r.ok) return;
  const common = path.resolve(projectPath, r.stdout.trim());
  const file = path.join(common, 'info', 'exclude');
  const line = '.claude/worktrees/';
  try {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur.split('\n').some((l) => l.trim() === line)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${cur.endsWith('\n') || cur === '' ? '' : '\n'}${line}\n`);
  } catch (err) {
    log('debug', SCOPE, `no pude excluir ${line}: ${errText(err)}`);
  }
}

/* ── crear ────────────────────────────────────────────────────────── */

/**
 * El worktree de un worker, creado o reutilizado.
 *
 * Reutilizado cuando ya existe y git lo conoce: así un escuadrón comparte uno
 * (cada miembro pide el mismo nombre) y un collector que se reinicia no crea
 * un segundo worktree para la misma rama.
 */
export async function createWorktree(
  projectPath: string, name: string,
): Promise<{ ok: true; worktree: WorktreeInfo; reused: boolean } | { ok: false; detail: string }> {
  if (!NAME_RE.test(name)) return { ok: false, detail: `nombre de worktree inválido: ${oneLine(name, 40)}` };
  const root = path.resolve(projectPath);
  if (!isDir(root)) return { ok: false, detail: `el proyecto no existe: ${root}` };
  const inside = await git(['rev-parse', '--is-inside-work-tree'], root);
  if (!inside.ok || inside.stdout.trim() !== 'true') return { ok: false, detail: `${root} no es un repositorio git` };
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
  if (!head.ok) return { ok: false, detail: 'el proyecto no tiene ningún commit: haz el primero antes de lanzar workers en worktrees' };

  const wt = worktreePath(root, name);
  const branch = branchFor(name);
  const known = await registeredWorktrees(root);
  if (known.has(real(wt)) && isDir(wt)) {
    return { ok: true, worktree: { path: wt, branch }, reused: true };
  }
  if (fs.existsSync(wt)) {
    return { ok: false, detail: `${wt} existe y git no lo conoce como worktree; bórralo o elige otro nombre` };
  }
  await excludeWorktreesDir(root);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const args = (await branchExists(root, branch))
    ? ['worktree', 'add', wt, branch]
    : ['worktree', 'add', '-b', branch, wt, 'HEAD'];
  const r = await git(args, root);
  if (!r.ok) return { ok: false, detail: `git worktree add: ${why(r)}` };
  await shareNodeModules(root, wt);
  log('info', SCOPE, `worktree ${name} → ${wt} (${branch})`);
  return { ok: true, worktree: { path: wt, branch }, reused: false };
}

/**
 * Un worktree recién creado no tiene node_modules, y una suite que arranca con
 * "tsx: not found" no está probando nada. Si el proyecto los tiene y git los
 * ignora, se enlazan. Sólo si los ignora: un symlink que `git add -A` fuera a
 * commitear sería peor que la suite fallando.
 */
async function shareNodeModules(root: string, wt: string): Promise<void> {
  const src = path.join(root, 'node_modules');
  const dst = path.join(wt, 'node_modules');
  if (!isDir(src) || fs.existsSync(dst)) return;
  const ignored = await git(['check-ignore', '-q', 'node_modules'], wt);
  if (!ignored.ok) return;
  try { fs.symlinkSync(src, dst, 'dir'); } catch (err) {
    log('debug', SCOPE, `no pude enlazar node_modules: ${errText(err)}`);
  }
}

/* ── estado ───────────────────────────────────────────────────────── */

export async function worktreeStatus(projectPath: string, wt: WorktreeInfo): Promise<WorktreeStatus> {
  const root = path.resolve(projectPath);
  const projectBranch = await currentBranch(root);
  const exists = isDir(wt.path) && (await registeredWorktrees(root)).has(real(wt.path));
  let dirty = false;
  if (exists) {
    const st = await git(['status', '--porcelain'], wt.path);
    dirty = st.ok && st.stdout.trim().length > 0;
  }
  let ahead = 0, behind = 0;
  if (projectBranch && await branchExists(root, wt.branch)) {
    const r = await git(['rev-list', '--left-right', '--count', `${projectBranch}...${wt.branch}`], root);
    if (r.ok) {
      const [b, a] = r.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
      behind = Number.isFinite(b) ? b! : 0;
      ahead = Number.isFinite(a) ? a! : 0;
    }
  }
  return { exists, dirty, ahead, behind, projectBranch };
}

/* ── la suite ─────────────────────────────────────────────────────── */

export interface LandConfig {
  /** El comando de la suite, o `false` para no correr ninguna. */
  test?: string[] | false | null;
  timeoutMs?: number;
}

/** `<proyecto>/.orca/land.json`, si existe y es legible. */
export function readLandConfig(dir: string): LandConfig {
  const file = path.join(dir, LAND_CONFIG);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const obj = safeJson<Record<string, unknown>>(text);
  if (!obj) { log('warn', SCOPE, `${file} no es JSON válido; se ignora`); return {}; }
  const out: LandConfig = {};
  const t = obj['test'];
  if (t === false || t === null) out.test = false;
  else if (typeof t === 'string' && t.trim()) out.test = t.trim().split(/\s+/);
  else if (Array.isArray(t) && t.length && t.every((x) => typeof x === 'string' && x.length)) out.test = t as string[];
  if (typeof obj['timeoutMs'] === 'number' && obj['timeoutMs'] > 0) out.timeoutMs = obj['timeoutMs'];
  return out;
}

/**
 * Qué corre la suite de este proyecto, sin que nadie lo diga.
 *
 * En orden: la config del proyecto; `scripts.test` de package.json (si no es
 * el placeholder que npm pone por defecto); un target `test` en el Makefile;
 * Cargo, Go, pytest. null si nada de eso: `land` aterriza igual y lo dice.
 */
export function detectTestCommand(dir: string): string[] | null {
  const cfg = readLandConfig(dir);
  if (cfg.test === false) return null;
  if (cfg.test) return cfg.test;
  try {
    const pkg = safeJson<{ scripts?: Record<string, unknown> }>(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const t = pkg?.scripts?.['test'];
    if (typeof t === 'string' && t.trim() && !/no test specified/.test(t)) return ['npm', 'test'];
  } catch { /* sin package.json */ }
  try {
    const mk = fs.readFileSync(path.join(dir, 'Makefile'), 'utf8');
    if (/^test\s*:/m.test(mk)) return ['make', 'test'];
  } catch { /* sin Makefile */ }
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) return ['cargo', 'test'];
  if (fs.existsSync(path.join(dir, 'go.mod'))) return ['go', 'test', './...'];
  if (['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'].some((f) => fs.existsSync(path.join(dir, f)))) return ['pytest'];
  return null;
}

async function runTests(dir: string, command: string[], timeoutMs: number): Promise<TestRun> {
  const t0 = Date.now();
  const [bin, ...args] = command;
  const r = await exec(bin!, args, dir, timeoutMs, { ...process.env, CI: '1', ORCA_LAND: '1' });
  const raw = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
  return {
    command, ok: r.ok, code: r.code,
    output: raw.length > OUTPUT_TAIL ? `…${raw.slice(-OUTPUT_TAIL)}` : raw,
    durationMs: Date.now() - t0,
  };
}

/* ── aterrizar ────────────────────────────────────────────────────── */

export async function land(projectPath: string, wt: WorktreeInfo, opts: LandOptions): Promise<LandResult> {
  const root = path.resolve(projectPath);
  const refuse = (reason: Exclude<LandResult, { ok: true }>['reason'], detail: string, conflicts: string[] = [], tests: TestRun | null = null): LandResult =>
    ({ ok: false, reason, detail, conflicts, tests });

  const status = await worktreeStatus(root, wt);
  if (!status.exists) return refuse('error', `el worktree no existe: ${wt.path}`);
  if (!status.projectBranch) return refuse('error', 'el proyecto está en HEAD suelto; ponlo en una rama antes de aterrizar');
  const projectBranch = status.projectBranch;
  const wtBranch = await currentBranch(wt.path);
  if (wtBranch !== wt.branch) return refuse('error', `el worktree está en ${wtBranch ?? 'HEAD suelto'}, no en ${wt.branch}`);

  // 1. Lo que el worker dejó a medias va a SU rama. Un rebase no arranca sobre
  //    un tree sucio, y perder trabajo por eso sería absurdo.
  if (status.dirty) {
    const add = await git(['add', '-A'], wt.path);
    if (!add.ok) return refuse('error', `git add en el worktree: ${why(add)}`);
    const wip = await git(['commit', '-q', '--no-verify', '-m', `wip(${opts.callsign}): cambios sin commitear al aterrizar`], wt.path);
    if (!wip.ok) return refuse('error', `commit de trabajo en curso: ${why(wip)}`);
  }
  const after = await worktreeStatus(root, wt);
  if (after.ahead === 0) return refuse('nothing', `${wt.branch} no tiene nada que ${projectBranch} no tenga ya`);

  // Los títulos de lo que trae, para el cuerpo del commit. Antes del rebase:
  // después son los mismos, pero da igual, y así están aunque falle.
  const subjects = await git(['log', '--format=%s', `${projectBranch}..${wt.branch}`], root);
  const brought = subjects.ok ? subjects.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];

  // 2. Rebase en el worktree. Un conflicto se aborta ahí y se cuenta con los
  //    archivos; la rama del proyecto no se ha tocado todavía.
  const rebase = await git(['rebase', projectBranch], wt.path);
  if (!rebase.ok) {
    const un = await git(['diff', '--name-only', '--diff-filter=U'], wt.path);
    const conflicts = un.ok ? un.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    await git(['rebase', '--abort'], wt.path);
    return refuse('conflict', `rebase de ${wt.branch} sobre ${projectBranch} tiene conflictos${conflicts.length ? ` en ${conflicts.length} archivo(s)` : ''}: ${why(rebase)}`, conflicts);
  }

  // 3. La suite, en el worktree rebaseado: es lo que el proyecto va a ser.
  let tests: TestRun | null = null;
  let note: string | null = null;
  if (opts.runTests !== false) {
    const cfg = readLandConfig(root);
    const command = opts.testCommand ?? detectTestCommand(wt.path);
    if (!command) {
      note = 'no encontré cómo correr la suite (package.json scripts.test, Makefile, Cargo, Go, pytest, ni .orca/land.json); aterrizado sin probar';
    } else {
      tests = await runTests(wt.path, command, opts.testTimeoutMs ?? cfg.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS);
      if (!tests.ok) {
        return refuse('tests', `la suite (${command.join(' ')}) falló con ${tests.code ?? 'timeout'} en el worktree rebaseado; la rama del proyecto no se tocó`, [], tests);
      }
    }
  } else {
    note = 'suite omitida a petición';
  }

  // 4. Un commit en la rama del proyecto. El índice tiene que estar limpio:
  //    lo que el operador tuviera preparado NO es parte de este aterrizaje.
  const staged = await git(['diff', '--cached', '--quiet'], root);
  if (!staged.ok) return refuse('index', 'el índice del proyecto tiene cambios preparados (staged); commitéalos o quítalos del índice antes de aterrizar', [], tests);
  const squash = await git(['merge', '--squash', wt.branch], root);
  if (!squash.ok) {
    // Un archivo sucio del operador que la rama también trae. Git no ha
    // tocado nada; se deshace lo poco que pudo quedar preparado.
    await git(['reset', '-q'], root);
    const files = [...`${squash.stderr}\n${squash.stdout}`.matchAll(/^\t(.+)$/gm)].map((m) => m[1]!.trim());
    return refuse('conflict', `no se pudo aplicar ${wt.branch} sobre el working tree del proyecto: ${why(squash)}`, files, tests);
  }
  const anything = await git(['diff', '--cached', '--quiet'], root);
  if (anything.ok) return refuse('nothing', `${wt.branch} no cambia nada respecto a ${projectBranch}`, [], tests);

  const title = (opts.message && opts.message.trim()) ? oneLine(opts.message, 120) : `land ${opts.callsign}: ${oneLine(opts.mission ?? wt.branch, 80)}`;
  const body = [
    `Aterrizado por ORCA desde ${wt.branch} (worker ${opts.callsign}).`,
    ...(opts.mission ? ['', `Tarea: ${oneLine(opts.mission, 400)}`] : []),
    ...(brought.length ? ['', 'Commits del worker:', ...brought.slice(0, 40).map((s) => `  - ${s}`)] : []),
    '', tests ? `Suite: ${tests.command.join(' ')} → ok en ${Math.round(tests.durationMs / 1000)}s` : `Suite: ${note ?? 'no corrida'}`,
  ].join('\n');
  const commit = await git(['commit', '-q', '-m', title, '-m', body], root);
  if (!commit.ok) {
    await git(['reset', '-q'], root);
    return refuse('error', `git commit en ${projectBranch}: ${why(commit)}`, [], tests);
  }
  const sha = (await git(['rev-parse', 'HEAD'], root)).stdout.trim();
  const shown = await git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], root);
  const files = shown.ok ? shown.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];

  // 5. El worker sigue desde donde quedó el proyecto: su rama al nivel de la
  //    del proyecto, sin los commits que acaban de fundirse en uno.
  const level = await git(['reset', '-q', '--hard', projectBranch], wt.path);
  if (!level.ok) log('warn', SCOPE, `no pude nivelar ${wt.branch} con ${projectBranch}: ${why(level)}`);

  log('info', SCOPE, `land ${opts.callsign}: ${wt.branch} → ${projectBranch} @ ${sha.slice(0, 8)} (${files.length} archivos)`);
  return { ok: true, commit: sha, branch: wt.branch, projectBranch, files, tests, note };
}

/* ── tirar ────────────────────────────────────────────────────────── */

/**
 * Quitar el worktree y la rama de un worker.
 *
 * Sin `force` sólo si no hay nada que perder: ni cambios sin commitear ni
 * commits que el proyecto no tenga. Es lo que se llama al archivar un worker
 * ya aterrizado, y es lo que se niega cuando no lo está.
 */
export async function discard(projectPath: string, wt: WorktreeInfo, opts: { force?: boolean } = {}): Promise<DiscardResult> {
  const root = path.resolve(projectPath);
  const status = await worktreeStatus(root, wt);
  const hasBranch = await branchExists(root, wt.branch);
  if (!status.exists && !hasBranch) return { ok: true, removed: false, detail: 'ya no existía' };
  if (!opts.force && (status.dirty || status.ahead > 0)) {
    const what = [status.dirty ? 'cambios sin commitear' : '', status.ahead > 0 ? `${status.ahead} commit(s) sin aterrizar` : ''].filter(Boolean).join(' y ');
    return { ok: false, detail: `${wt.branch} tiene ${what}; aterriza con land o pasa force para tirarlo`, status };
  }
  if (status.exists) {
    const rm = await git(['worktree', 'remove', '--force', wt.path], root);
    if (!rm.ok) return { ok: false, detail: `git worktree remove: ${why(rm)}`, status };
  } else if (isDir(wt.path)) {
    // Git ya no lo conoce pero el directorio quedó: se limpia a mano.
    try { fs.rmSync(wt.path, { recursive: true, force: true }); } catch (err) { return { ok: false, detail: `rm ${wt.path}: ${errText(err)}`, status }; }
  }
  await git(['worktree', 'prune'], root);
  if (hasBranch) {
    const br = await git(['branch', '-D', wt.branch], root);
    if (!br.ok) return { ok: false, detail: `worktree quitado, pero git branch -D ${wt.branch}: ${why(br)}`, status };
  }
  log('info', SCOPE, `discard ${wt.branch} (${wt.path})${opts.force ? ' [force]' : ''}`);
  return { ok: true, removed: true, detail: `quitado ${wt.path} y ${wt.branch}` };
}
