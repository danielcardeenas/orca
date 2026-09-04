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

  constructor(machineId: string) {
    this.machineId = machineId;
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
   * Asegura que exista el proyecto del slug. `cwdHint` viene del transcript y
   * gana siempre sobre la sonda: si el agente dice dónde corre, ahí corre.
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
      && rec.project.rollup.costUSD === rollup.costUSD;
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

/** La transformación que Claude Code aplica para nombrar el directorio. */
export function pathToSlug(p: string): string {
  return p.replace(/[/\\]/g, '-');
}

/** Interpretación ingenua: cada guión es un separador. Último recurso. */
export function slugToNaivePath(slug: string): string {
  return slug.replace(/-/g, '/');
}

/**
 * Sonda con backtracking: en cada nivel prueba primero el segmento MÁS LARGO
 * que exista en disco, porque los nombres con guión (jk-detailing) son la razón
 * por la que el slug es ambiguo. Cae al camino corto si el largo no lleva a
 * ningún lado.
 */
export function probeSlug(slug: string, exists: (p: string) => boolean = safeIsDir): string | null {
  const tokens = slug.split('-').filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  const walk = (base: string, i: number): string | null => {
    if (i >= tokens.length) return base;
    // De más largo a más corto: "jk-detailing" antes que "jk".
    for (let take = tokens.length - i; take >= 1; take--) {
      const seg = tokens.slice(i, i + take).join('-');
      const next = path.join(base, seg);
      if (!exists(next)) continue;
      const done = walk(next, i + take);
      if (done) return done;
    }
    return null;
  };
  return walk(path.sep, 0);
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
