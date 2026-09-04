/**
 * Dos agentes escribiendo el mismo archivo.
 *
 * Es la señal más valiosa que produce el collector, por una razón muy concreta:
 * **no necesita la cooperación de nadie**. Un mensaje entre agentes exige que
 * el agente se acuerde de mandarlo; una colisión ya está en el transcript, la
 * escribió Claude Code, y el agente que la está causando por definición no sabe
 * que la está causando. También es el fallo que nadie nota hasta que el trabajo
 * del segundo agente ya se sobrescribió.
 *
 * ── De dónde sale (verificado contra transcripts reales, CC 2.1.260) ──
 *
 * Antes de tocar un archivo, Claude Code lo respalda y escribe una línea:
 *
 *   {"type":"file-history-delta","messageId":"…","snapshotMessageId":"…",
 *    "trackingPath":"src/api/charges.ts",
 *    "backup":{"backupFileName":"ac4e…@v2","version":2,
 *              "backupTime":"2026-08-25T03:31:19.878Z",
 *              "realParentDir":"/Users/dan/proj/src/api"},
 *    "timestamp":"…"}
 *
 *   {"type":"file-history-snapshot","messageId":"…","isSnapshotUpdate":false,
 *    "snapshot":{"messageId":"…","timestamp":"…",
 *                "trackedFileBackups":{ "<path>": {<mismo backup>}, … }}}
 *
 * Dos cosas medidas, no supuestas, que mandan sobre el diseño de este módulo:
 *
 * 1. `trackingPath` es RELATIVO al cwd cuando el archivo está dentro del
 *    proyecto, y absoluto cuando está fuera (un scratchpad en /private/tmp).
 *    `backup.realParentDir` en cambio es SIEMPRE absoluto, así que la ruta
 *    canónica es `realParentDir + basename(trackingPath)`.
 *
 * 2. El `backupTime` de un snapshot NO es la hora en que se escribió cada
 *    archivo: al añadirse un archivo nuevo, el snapshot re-respalda todo el
 *    conjunto con una sola marca de tiempo. En una sesión real: 18 archivos,
 *    3 marcas distintas. Tomar eso como "escribió los 18 ahora" fabricaría
 *    colisiones falsas.
 *
 * Por eso el delta es la señal FUERTE (una escritura, con su hora) y el
 * snapshot sólo es una señal DÉBIL (este archivo está en el conjunto que el
 * agente edita). Una colisión exige una señal fuerte de CADA participante.
 * Además, `file-history-*` sólo se emite antes de una ESCRITURA: un `Read` no
 * deja rastro aquí, que es exactamente lo que queremos — dos agentes leyendo el
 * mismo archivo es normal y sano.
 */

import path from 'node:path';

import type { Collision } from '../shared/types.ts';
import type { LineBatch } from './watch.ts';
import { isRecord, log, sha1, str, tsMs } from './util.ts';

const SCOPE = 'collisions';

/** Dos escrituras separadas por más que esto ya no se estorban. */
export const DEFAULT_WINDOW_MS = 15 * 60_000;
/**
 * Una colisión viva no se re-emite en cada tick: sólo cuando cambia el conjunto
 * de agentes o cuando `lastSeen` se movió de forma perceptible.
 */
const REEMIT_MS = 60_000;
/** Tope de rutas por agente. Una sesión larga toca cientos, no cientos de miles. */
const MAX_PATHS_PER_AGENT = 4_000;

/* ── ruido ────────────────────────────────────────────────────────── */

/**
 * Directorios que dos agentes comparten sin que signifique nada: artefactos de
 * build, dependencias, el propio buzón de ORCA. Avisar de estos entrena al
 * operador a ignorar el aviso, que es la única forma de que una alerta muera.
 */
const NOISE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage',
  '.git', '.orca', '.next', '.nuxt', '.turbo', '.cache', '.venv', '.svelte-kit',
  '__pycache__', '.pytest_cache', '.gradle', '.terraform', '.wrangler',
]);

/**
 * Lockfiles. Los reescribe el gestor de paquetes, no el agente; dos `npm i`
 * simultáneos son un problema real pero no es ESTE problema, y el ruido que
 * generan sepultaría las colisiones de código de verdad.
 */
const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
  'Cargo.lock', 'poetry.lock', 'uv.lock', 'composer.lock', 'Gemfile.lock',
  'go.sum', 'go.work.sum', 'flake.lock', '.terraform.lock.hcl', 'deno.lock',
]);

export function isNoise(abs: string): boolean {
  const base = path.basename(abs);
  if (LOCKFILES.has(base)) return true;
  if (base.endsWith('.log') || base.endsWith('.lock')) return true;
  for (const seg of abs.split(path.sep)) {
    if (NOISE_DIRS.has(seg)) return true;
  }
  return false;
}

/* ── entrada ──────────────────────────────────────────────────────── */

/** Lo que el detector necesita saber de cada agente para decidir. */
export interface CollisionAgent {
  id: string;
  projectId: string;
  machineId: string;
  /**
   * false = `done` o `dead`. Dos sesiones muertas que tocaron el mismo archivo
   * la semana pasada no son nada.
   */
  live: boolean;
  parentId: string | null;
}

interface Write {
  at: number;
  /** true = vino de un delta (una escritura con su hora real). */
  strong: boolean;
}

interface Emitted {
  col: Collision;
  /** Firma de lo último emitido, para no repetirnos en cada tick. */
  agentKey: string;
  lastSeen: number;
}

export class CollisionIndex {
  private readonly windowMs: number;
  /** agentId → ruta absoluta → última escritura observada. */
  private writes = new Map<string, Map<string, Write>>();
  private emitted = new Map<string, Emitted>();

  constructor(windowMs?: number) {
    const env = Number(process.env['ORCA_COLLISION_WINDOW_MS']);
    this.windowMs = windowMs ?? (Number.isFinite(env) && env > 0 ? env : DEFAULT_WINDOW_MS);
  }

  /**
   * Extrae las escrituras de un lote de líneas. Barato a propósito: se llama en
   * el mismo camino que el deriver, sobre cada línea que entra.
   *
   * `cwd` es el que el propio transcript declara, y sólo hace falta cuando un
   * `trackingPath` relativo viene sin `realParentDir`.
   */
  ingest(batch: LineBatch, cwd: string | null): void {
    let mine: Map<string, Write> | undefined;
    for (const line of batch.lines) {
      const type = line['type'];
      if (type !== 'file-history-delta' && type !== 'file-history-snapshot') continue;
      if (!mine) {
        mine = this.writes.get(batch.ref.key);
        if (!mine) { mine = new Map(); this.writes.set(batch.ref.key, mine); }
      }
      if (type === 'file-history-delta') {
        const abs = absPathOf(str(line['trackingPath']), line['backup'], cwd);
        if (!abs) continue;
        const backup = isRecord(line['backup']) ? line['backup'] : null;
        const at = tsMs(backup?.['backupTime'], 0) || tsMs(line['timestamp'], 0);
        if (at > 0) note(mine, abs, at, true);
        continue;
      }
      const snap = isRecord(line['snapshot']) ? line['snapshot'] : null;
      const tracked = snap && isRecord(snap['trackedFileBackups'])
        ? snap['trackedFileBackups'] : null;
      if (!tracked) continue;
      const snapAt = tsMs(snap?.['timestamp'], 0);
      for (const [key, raw] of Object.entries(tracked)) {
        const abs = absPathOf(key, raw, cwd);
        if (!abs) continue;
        const backup = isRecord(raw) ? raw : null;
        const at = tsMs(backup?.['backupTime'], 0) || snapAt;
        if (at > 0) note(mine, abs, at, false);
      }
    }
    if (mine && mine.size > MAX_PATHS_PER_AGENT) trim(mine);
  }

  /** El agente desapareció del disco: su historial de escrituras sobra. */
  forget(agentId: string): void {
    this.writes.delete(agentId);
  }

  /** Sólo para diagnóstico y tests. */
  pathsOf(agentId: string): string[] {
    return [...(this.writes.get(agentId)?.keys() ?? [])].sort();
  }

  /**
   * Recalcula. Devuelve sólo lo que hay que mandar por el cable: las colisiones
   * nuevas o cambiadas, y los ids de las que dejaron de ser ciertas.
   */
  detect(agents: CollisionAgent[], now = Date.now()): {
    open: Collision[]; cleared: string[];
  } {
    const byId = new Map(agents.map((a) => [a.id, a]));
    const live = agents.filter((a) => a.live);
    const cutoff = now - this.windowMs;

    // ruta absoluta → participantes candidatos
    const byPath = new Map<string, { agent: CollisionAgent; at: number }[]>();
    for (const a of live) {
      const mine = this.writes.get(a.id);
      if (!mine) continue;
      for (const [abs, w] of mine) {
        // Un snapshot re-sella todo el conjunto con una sola hora, así que sólo
        // una escritura fuerte (un delta) puede abrir una colisión.
        if (!w.strong) continue;
        if (w.at < cutoff) continue;
        if (isNoise(abs)) continue;
        const list = byPath.get(abs);
        if (list) list.push({ agent: a, at: w.at });
        else byPath.set(abs, [{ agent: a, at: w.at }]);
      }
    }

    const seen = new Set<string>();
    const open: Collision[] = [];

    for (const [abs, entries] of byPath) {
      if (entries.length < 2) continue;
      const participants = unrelated(entries, byId);
      if (participants.length < 2) continue;

      const id = collisionId(participants[0]!.agent.machineId, abs);
      seen.add(id);
      const agentIds = participants.map((p) => p.agent.id).sort();
      const lastSeen = Math.max(...participants.map((p) => p.at));
      const firstSeen = Math.min(...participants.map((p) => p.at));
      const agentKey = agentIds.join(',');

      const prev = this.emitted.get(id);
      const col: Collision = {
        id,
        path: abs,
        // Los worktrees se doblan sobre su proyecto, así que dos agentes del
        // mismo repo comparten projectId aunque corran en directorios distintos.
        projectId: participants[0]!.agent.projectId,
        machineId: participants[0]!.agent.machineId,
        agentIds,
        firstSeen: prev ? Math.min(prev.col.firstSeen, firstSeen) : firstSeen,
        lastSeen,
        acknowledged: false,
      };

      if (prev && prev.agentKey === agentKey && lastSeen - prev.lastSeen < REEMIT_MS) {
        // Nada nuevo que contar: ni el conjunto de agentes ni el reloj se
        // movieron lo bastante. Re-emitir aquí sería un frame por tick.
        prev.col.lastSeen = lastSeen;
        continue;
      }
      this.emitted.set(id, { col, agentKey, lastSeen });
      open.push(col);
      if (!prev) {
        log('warn', SCOPE, `colisión en ${abs}: ${agentIds.join(' + ')}`);
      }
    }

    const cleared: string[] = [];
    for (const id of [...this.emitted.keys()]) {
      if (seen.has(id)) continue;
      this.emitted.delete(id);
      cleared.push(id);
    }
    return { open, cleared };
  }

  /** Las colisiones vivas, para el snapshot que se manda al reconectar. */
  list(): Collision[] {
    return [...this.emitted.values()].map((e) => e.col);
  }
}

/* ── helpers ──────────────────────────────────────────────────────── */

function note(mine: Map<string, Write>, abs: string, at: number, strong: boolean): void {
  const prev = mine.get(abs);
  if (!prev) { mine.set(abs, { at, strong }); return; }
  // Una escritura fuerte nunca se degrada a débil, aunque llegue un snapshot
  // posterior: lo que sabemos con certeza no se olvida por una pista más floja.
  if (at > prev.at) prev.at = at;
  if (strong) prev.strong = true;
}

/** Descarta las rutas más viejas. El historial acotado sigue siendo correcto. */
function trim(mine: Map<string, Write>): void {
  const keep = [...mine.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, Math.floor(MAX_PATHS_PER_AGENT / 2));
  mine.clear();
  for (const [k, v] of keep) mine.set(k, v);
}

/**
 * Ruta canónica y absoluta.
 *
 * `realParentDir` gana siempre: es absoluto en todos los transcripts que hemos
 * mirado, y es lo único que resuelve un `trackingPath` relativo sin depender de
 * que el agente no haya hecho `cd`.
 */
export function absPathOf(
  trackingPath: string | null, backup: unknown, cwd: string | null,
): string | null {
  if (!trackingPath) return null;
  const base = path.basename(trackingPath);
  if (!base || base === '.' || base === '..') return null;
  const parent = isRecord(backup) ? str(backup['realParentDir']) : null;
  if (parent && path.isAbsolute(parent)) return path.join(parent, base);
  if (path.isAbsolute(trackingPath)) return path.resolve(trackingPath);
  if (cwd && path.isAbsolute(cwd)) return path.resolve(cwd, trackingPath);
  return null; // sin ancla no inventamos una ruta
}

/** Id estable por (máquina, ruta): el conjunto de agentes puede cambiar dentro. */
export function collisionId(machineId: string, abs: string): string {
  return 'col_' + sha1(`${machineId} ${abs}`).slice(0, 16);
}

/**
 * Quita a los que sólo "colisionan" con su propio linaje.
 *
 * Un agente y su subagente comparten worktree por diseño: el subagente está
 * editando POR el padre, y avisar de eso sería avisar de que el producto
 * funciona. Dos hermanos, en cambio, sí colisionan de verdad — son dos escritores
 * independientes en el mismo árbol, que es el caso clásico que este módulo
 * existe para cazar.
 */
function unrelated(
  entries: { agent: CollisionAgent; at: number }[],
  byId: Map<string, CollisionAgent>,
): { agent: CollisionAgent; at: number }[] {
  const out: typeof entries = [];
  for (const e of entries) {
    const hasStranger = entries.some(
      (o) => o.agent.id !== e.agent.id && !related(e.agent.id, o.agent.id, byId),
    );
    if (hasStranger) out.push(e);
  }
  return out;
}

/** true si uno desciende del otro. Corta ciclos: un linaje corrupto no cuelga. */
export function related(a: string, b: string, byId: Map<string, CollisionAgent>): boolean {
  if (a === b) return true;
  return isAncestor(a, b, byId) || isAncestor(b, a, byId);
}

function isAncestor(anc: string, of: string, byId: Map<string, CollisionAgent>): boolean {
  const seen = new Set<string>();
  let cur: string | null = byId.get(of)?.parentId ?? null;
  while (cur) {
    if (cur === anc) return true;
    if (seen.has(cur)) break;
    seen.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}
