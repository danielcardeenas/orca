/**
 * Proyectos: del slug de ~/.claude/projects a un `Project` con git real.
 *
 * El slug es la ruta con "/" → "-", lo que es una función NO inyectiva: el slug
 * `-Users-dan-projects-jk-detailing` puede ser `/Users/dan/projects/jk/detailing`
 * o `/Users/dan/projects/jk-detailing`, y en esta máquina existen los dos casos
 * (`jk-detailing` con guión y `dijosi-workers-guest-messages-consumer` con tres
 * niveles). Por eso hay dos estrategias, en este orden:
 *
 *   1. el `cwd` que el propio transcript declara en cada línea — autoritativo;
 *   2. si aún no hemos leído ninguna línea, una sonda con backtracking contra
 *      el filesystem que prefiere el segmento más largo que exista.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Project, SessionRollup } from '../shared/types.ts';
import { emptyRollup } from '../shared/types.ts';
import { excludedWorkspace, pathToSlug as slugOf, type ExcludedWorkspace } from '../shared/workspaces.ts';
import { errText, log, projectCode } from './util.ts';

const SCOPE = 'projects';
const GIT_TTL_MS = 15_000;

export interface ProjectRecord {
  project: Project;
  gitCheckedAt: number;
}


/**
 * Dobla el slug de un worktree sobre el de su proyecto.
 *
 * `claude --bg` corre la sesión dentro de un git worktree bajo
 * `<proyecto>/.claude/worktrees/<nombre>/`, y ese directorio produce su propio
 * slug. Sin esto, cada agente en background aparecía como un proyecto nuevo:
 * un operador con cinco agentes de fondo veía su flota partirse en
 * "axolots", "axolots--claude-worktrees-fix-a", "axolots--claude-worktrees-…".
 * Son el mismo repo y el mismo trabajo; pertenecen a la misma isla.
 *
 * El worktree sigue siendo visible como el `cwd` real del agente; lo que se
 * corrige es a qué proyecto se le atribuye.
 */
const WORKTREE_MARK = '--claude-worktrees-';

export function foldWorktreeSlug(slug: string): string {
  const at = slug.indexOf(WORKTREE_MARK);
  return at > 0 ? slug.slice(0, at) : slug;
}

export class ProjectRegistry {
  private readonly machineId: string;
  private byId = new Map<string, ProjectRecord>();
  private bySlug = new Map<string, string>();
  private codes = new Map<string, string>(); // code → projectId
  private slugPathCache = new Map<string, string | null>();
  private gitInFlight = new Set<string>();

  /**
   * Dónde vive CAPCOM. Se inyecta porque el collector ya lo sabe —es quien
   * arranca esa sesión— y dos resoluciones de la misma ruta es como se
   * consigue que una de las dos se quede corta.
   */
  private readonly capcomDir: string | undefined;

  /**
   * Dónde se recuerdan las carpetas dadas de alta a mano. Ver `adopt`.
   */
  private readonly registeredFile: string | null;

  constructor(machineId: string, capcomDir?: string, registeredFile?: string | null) {
    this.machineId = machineId;
    this.capcomDir = capcomDir;
    this.registeredFile = registeredFile ?? null;
  }

  /**
   * Una carpeta que alguien puso en el mapa por su ruta, y que hay que
   * recordar entre arranques.
   *
   * El resto de proyectos se redescubren solos: existen porque hay un
   * transcript bajo `~/.claude/projects` que los produce. Uno recién dado de
   * alta no tiene ninguno todavía —ése es exactamente su problema— así que sin
   * esto desaparecería en el siguiente reinicio del collector y el operador
   * tendría que darlo de alta otra vez. Que es la clase de ritual que este
   * alta existe para quitar.
   */
  register(dir: string): Project {
    const project = this.ensure(pathToSlug(dir), dir);
    this.remember(dir);
    return project;
  }

  /** Las carpetas recordadas, de vuelta al registro. Se llama al arrancar. */
  adopt(): string[] {
    const taken: string[] = [];
    for (const dir of this.readRegistered()) {
      if (!safeIsDir(dir)) continue;         // la borraron: no se resucita
      if (excludedWorkspace(dir, this.capcomDir)) continue;
      this.ensure(pathToSlug(dir), dir);
      taken.push(dir);
    }
    if (taken.length) log('info', SCOPE, `${taken.length} proyecto(s) dados de alta a mano, readoptados`);
    return taken;
  }

  private readRegistered(): string[] {
    if (!this.registeredFile) return [];
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.registeredFile, 'utf8'));
      if (!Array.isArray(raw)) return [];
      return raw.filter((v): v is string => typeof v === 'string' && path.isAbsolute(v));
    } catch { return []; }
  }

  private remember(dir: string): void {
    if (!this.registeredFile) return;
    const known = this.readRegistered();
    if (known.includes(dir)) return;
    try {
      fs.mkdirSync(path.dirname(this.registeredFile), { recursive: true });
      const tmp = `${this.registeredFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...known, dir], null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.registeredFile);
    } catch (err) {
      log('warn', SCOPE, `no pude recordar ${dir}: ${errText(err)}`);
    }
  }

  idForSlug(slug: string): string {
    return `${this.machineId}/${slug}`;
  }

  get(id: string): Project | null {
    return this.byId.get(id)?.project ?? null;
  }

  all(): Project[] {
    return [...this.byId.values()].map((r) => r.project);
  }

  /**
   * Como `ensure`, pero devuelve `null` cuando ese directorio no es un
   * proyecto: el propio de CAPCOM y los scratchpads de sesión (ver
   * `shared/workspaces.ts`). Es la puerta que usa el collector, para que la
   * regla se aplique en un sitio y no en los cuatro sitios que derivan un
   * proyecto de un transcript.
   *
   * Devolver null en vez de registrar un proyecto marcado es lo que menos toca:
   * un proyecto que no existe no viaja en el snapshot, no llega al hub, no sale
   * en `list_fleet` y no pinta una isla. El agente que vive ahí conserva su
   * `projectId` —el tipo `Agent` exige uno— apuntando a un proyecto que nadie
   * registró, que es exactamente lo que ya le pasa a un agente cuyo proyecto
   * aún no se ha resuelto, y todo el que lo lee lo trata como ausente.
   */
  ensureWork(rawSlug: string, cwdHint?: string | null): Project | null {
    return this.excludes(rawSlug, cwdHint) ? null : this.ensure(rawSlug, cwdHint);
  }

  /** Por qué este slug (o su cwd) no es un proyecto. null = lo es. */
  excludes(rawSlug: string, cwdHint?: string | null): ExcludedWorkspace | null {
    const slug = foldWorktreeSlug(rawSlug);
    return excludedWorkspace(slug, this.capcomDir)
      ?? (cwdHint ? excludedWorkspace(cwdHint, this.capcomDir) : null);
  }

  /**
   * Asegura que exista el proyecto del slug. `cwdHint` viene del transcript y
   * gana siempre sobre la sonda: si el agente dice dónde corre, ahí corre.
   *
   * No aplica la exclusión: quien deriva un proyecto de un transcript llama a
   * `ensureWork`. Esta sigue siendo directa para quien ya sabe lo que pide.
   */
  ensure(rawSlug: string, cwdHint?: string | null): Project {
    // Un worktree de una sesión background pertenece a su proyecto, no a uno
    // propio. Ver foldWorktreeSlug.
    const slug = foldWorktreeSlug(rawSlug);
    const id = this.idForSlug(slug);
    const hint = matchesSlug(cwdHint, slug) ? cwdHint : null;
    const existing = this.byId.get(id);
    if (existing) {
      if (hint && existing.project.path !== hint && safeIsDir(hint)) {
        existing.project.path = hint;
        existing.project.name = path.basename(hint) || slug;
        existing.gitCheckedAt = 0;
        this.slugPathCache.set(slug, hint);
      }
      return existing.project;
    }

    const resolved = hint && safeIsDir(hint) ? hint : this.resolveSlug(slug);
    const p = resolved ?? slugToNaivePath(slug);
    const name = path.basename(p) || slug;
    const project: Project = {
      id,
      machineId: this.machineId,
      slug,
      name,
      path: p,
      code: this.assignCode(id, name),
      gitBranch: null,
      gitDirty: false,
      keyNames: [],
      sessionIds: [],
      rollup: emptyRollup(),
    };
    this.byId.set(id, { project, gitCheckedAt: 0 });
    this.bySlug.set(slug, id);
    return project;
  }

  setSessions(id: string, sessionIds: string[], rollup: SessionRollup): boolean {
    const rec = this.byId.get(id);
    if (!rec) return false;
    const same = rec.project.sessionIds.length === sessionIds.length
      && rec.project.sessionIds.every((s, i) => s === sessionIds[i])
      && rec.project.rollup.total === rollup.total
      && rec.project.rollup.blocked === rollup.blocked
      && rec.project.rollup.tokens === rollup.tokens;
    rec.project.sessionIds = sessionIds;
    rec.project.rollup = rollup;
    return !same;
  }

  setKeyNames(id: string, names: string[]): boolean {
    const rec = this.byId.get(id);
    if (!rec) return false;
    const same = rec.project.keyNames.length === names.length
      && rec.project.keyNames.every((n, i) => n === names[i]);
    rec.project.keyNames = names;
    return !same;
  }

  /* ── git ──────────────────────────────────────────────────────── */

  /** Refresca rama y suciedad de los proyectos con TTL vencido. */
  async refreshGit(now = Date.now()): Promise<string[]> {
    const changed: string[] = [];
    await Promise.all([...this.byId.values()].map(async (rec) => {
      if (now - rec.gitCheckedAt < GIT_TTL_MS) return;
      if (this.gitInFlight.has(rec.project.id)) return;
      this.gitInFlight.add(rec.project.id);
      try {
        const info = await gitInfo(rec.project.path);
        rec.gitCheckedAt = Date.now();
        if (info.branch !== rec.project.gitBranch || info.dirty !== rec.project.gitDirty) {
          rec.project.gitBranch = info.branch;
          rec.project.gitDirty = info.dirty;
          changed.push(rec.project.id);
        }
      } finally {
        this.gitInFlight.delete(rec.project.id);
      }
    }));
    return changed;
  }

  /* ── códigos ──────────────────────────────────────────────────── */

  private assignCode(id: string, name: string): string {
    for (const [code, owner] of this.codes) if (owner === id) return code;
    for (let bump = 0; bump < 64; bump++) {
      const code = projectCode(name, bump);
      if (!this.codes.has(code)) { this.codes.set(code, id); return code; }
    }
    const fallback = projectCode(id, this.codes.size);
    this.codes.set(fallback, id);
    return fallback;
  }

  /* ── slug → ruta ──────────────────────────────────────────────── */

  resolveSlug(slug: string): string | null {
    const cached = this.slugPathCache.get(slug);
    if (cached !== undefined) return cached;
    const found = probeSlug(slug);
    this.slugPathCache.set(slug, found);
    if (!found) log('debug', SCOPE, `no pude resolver el slug ${slug} contra el disco`);
    return found;
  }
}

/* ── resolución de slug ───────────────────────────────────────────── */

function safeIsDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * El `cwd` de una línea sólo vale como pista si vuelve a producir ESTE slug.
 * Sin este filtro un agente que hizo `cd` a un subdirectorio movería la raíz del
 * proyecto entero — observado en samuhomes, cuyo cwd terminó apuntando a
 * apps/workers/samuhomes-core.
 */
export function matchesSlug(cwd: string | null | undefined, slug: string): string | null {
  if (!cwd) return null;
  return pathToSlug(cwd) === slug ? cwd : null;
}

/**
 * La transformación que Claude Code aplica para nombrar el directorio.
 *
 * Separadores Y puntos se vuelven guión: `/Users/dan/.orca/capcom` se guarda
 * como `-Users-dan--orca-capcom`. El punto importa: sin él, el cwd real de una
 * sesión en un directorio oculto nunca "coincide" con su slug (`matchesSlug`)
 * y la pista se descarta. Medido con CAPCOM, que vive en `~/.orca/capcom`.
 */
export function pathToSlug(p: string): string {
  return slugOf(p);
}

/** Interpretación ingenua: cada guión es un separador. Último recurso. */
export function slugToNaivePath(slug: string): string {
  return slug.replace(/-/g, '/');
}

/** Tope de tokens por segmento cuyas uniones se combinan (`-` o `.`). */
const MAX_DOTTED_JOIN = 8;

/**
 * Sonda con backtracking: en cada nivel prueba primero el segmento MÁS LARGO
 * que exista en disco, porque los nombres con guión (jk-detailing) son la razón
 * por la que el slug es ambiguo. Cae al camino corto si el largo no lleva a
 * ningún lado.
 *
 * El guión también puede ser un punto. Un token vacío —dos guiones seguidos—
 * es un nombre que empieza por punto (`--orca` → `.orca`), y dentro de un
 * segmento cada unión se prueba primero como guión y después como punto
 * (`next-config-js` → `next.config.js`). Sin esto un agente en un directorio
 * oculto no tiene cwd, y hablarle falla con "la ruta no existe".
 */
export function probeSlug(slug: string, exists: (p: string) => boolean = safeIsDir): string | null {
  // Se conservan los vacíos: son los puntos iniciales. Sólo cae el primero,
  // que es el guión con el que empieza todo slug absoluto.
  const tokens = slug.split('-');
  if (tokens[0] === '') tokens.shift();
  if (tokens.length === 0 || tokens.every((t) => t === '')) return null;

  const walk = (base: string, i: number): string | null => {
    if (i >= tokens.length) return base;
    let prefix = '';
    while (i < tokens.length && tokens[i] === '') { prefix += '.'; i++; }
    if (i >= tokens.length) return null;
    // Un segmento no cruza otro vacío: ése abre el siguiente nombre con punto.
    let span = 0;
    while (i + span < tokens.length && tokens[i + span] !== '') span++;
    // De más largo a más corto: "jk-detailing" antes que "jk".
    for (let take = span; take >= 1; take--) {
      for (const seg of joinVariants(tokens.slice(i, i + take))) {
        const next = path.join(base, prefix + seg);
        if (!exists(next)) continue;
        const done = walk(next, i + take);
        if (done) return done;
      }
    }
    return null;
  };
  return walk(path.sep, 0);
}

/**
 * Todas las formas de unir estos tokens con `-` o `.`, guión primero.
 *
 * 2^(n-1) variantes; con el tope, 128 como mucho. Más allá se prueba sólo el
 * guión: un nombre con nueve uniones y puntos es un caso que no vale la pena
 * pagar en cada nivel de cada slug.
 */
function joinVariants(tokens: string[]): string[] {
  const gaps = tokens.length - 1;
  if (gaps <= 0) return [tokens[0] ?? ''];
  if (gaps > MAX_DOTTED_JOIN) return [tokens.join('-')];
  const out: string[] = [];
  for (let mask = 0; mask < (1 << gaps); mask++) {
    let s = tokens[0] ?? '';
    for (let g = 0; g < gaps; g++) s += ((mask >> g) & 1 ? '.' : '-') + tokens[g + 1];
    out.push(s);
  }
  return out;
}

/* ── git sin shell ────────────────────────────────────────────────── */

function run(cmd: string, args: string[], cwd: string, timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    try {
      const child = execFile(cmd, args, {
        cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, shell: false,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      }, (err, stdout) => {
        if (done) return;
        done = true;
        resolve(err ? null : stdout);
      });
      child.on('error', () => { if (!done) { done = true; resolve(null); } });
    } catch (err) {
      log('debug', SCOPE, `no pude ejecutar ${cmd}: ${errText(err)}`);
      resolve(null);
    }
  });
}

export async function gitInfo(cwd: string): Promise<{ branch: string | null; dirty: boolean }> {
  if (!safeIsDir(cwd)) return { branch: null, dirty: false };
  const branchOut = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branchOut === null) return { branch: null, dirty: false };
  const branch = branchOut.trim() || null;
  const statusOut = await run('git', ['status', '--porcelain'], cwd);
  const dirty = statusOut !== null && statusOut.trim().length > 0;
  return { branch, dirty };
}
