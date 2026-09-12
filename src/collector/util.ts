/**
 * Utilidades compartidas del collector.
 *
 * Regla de oro de este daemon: nada aquí puede lanzar. El collector corre
 * desatendido durante días sobre un árbol de archivos que Claude Code reescribe
 * constantemente; un throw no capturado sería una pérdida de observabilidad
 * silenciosa. Por eso todo lo que toca disco o JSON devuelve `null` en vez de
 * fallar.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { MAX_REPORT } from '../shared/types.ts';

export const COLLECTOR_VERSION = '0.1.0';

/* ── logging ──────────────────────────────────────────────────────── */

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 } as const;
export type LogLevel = keyof typeof LEVELS;

function envLevel(): number {
  const raw = (process.env['ORCA_LOG'] ?? 'info').toLowerCase();
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}
const threshold = envLevel();

export function log(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const at = new Date().toISOString().slice(11, 23);
  const line = `${at} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) sink(line);
  else sink(line, extra);
}

/** Envuelve trabajo que puede fallar sin que el proceso se caiga. */
export function guard<T>(scope: string, what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    log('warn', scope, `${what} falló: ${errText(err)}`);
    return fallback;
  }
}

export async function guardAsync<T>(
  scope: string, what: string, fn: () => Promise<T>, fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log('warn', scope, `${what} falló: ${errText(err)}`);
    return fallback;
  }
}

export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/* ── JSON ─────────────────────────────────────────────────────────── */

/**
 * Los transcripts se escriben en vivo, así que una línea leída en el borde del
 * archivo puede estar truncada a medias. Nunca es un error, sólo "todavía no".
 */
export function safeJson<T = unknown>(text: string): T | null {
  const t = text.trim();
  if (!t || t[0] !== '{' && t[0] !== '[') return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

/* ── rutas ────────────────────────────────────────────────────────── */

export function home(): string {
  return process.env['HOME'] ?? process.env['USERPROFILE'] ?? homedir();
}

export function claudeDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] ?? path.join(home(), '.claude');
}

export function claudeProjectsDir(): string {
  return path.join(claudeDir(), 'projects');
}

export function codexSessionsDir(): string {
  return process.env['ORCA_CODEX_SESSIONS'] ?? path.join(home(), '.codex', 'sessions');
}

export function claudeJobsDir(): string {
  return path.join(claudeDir(), 'jobs');
}

export function orcaDir(): string {
  return process.env['ORCA_HOME'] ?? path.join(home(), '.orca');
}

/** True si `child` está dentro de `parent`. Base de la validación de rutas. */
export function isInside(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/* ── rutas donde nunca se lanza ni se escribe nada ────────────────── */

/**
 * Raíces del sistema vetadas, pase lo que pase. El resto de la defensa es que
 * la ruta tiene que venir de un proyecto que el collector DESCUBRIÓ en
 * ~/.claude/projects — es decir, un sitio donde el propio usuario ya corrió
 * Claude Code. Esa procedencia es mejor garantía que un prefijo de $HOME:
 * exigir el home dejaba fuera los repos de un VPS en /srv o /opt sin añadir
 * seguridad real, porque un hub comprometido sólo puede nombrar rutas que ya
 * tienen sesiones.
 *
 * Vive en util.ts y no en commands.ts porque el buzón de mensajes escribe en
 * las mismas rutas que el spawn lanza, y dos copias de esta lista es como se
 * consigue que una de las dos se quede corta.
 */
export const FORBIDDEN_ROOTS = [
  '/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/var/log',
];

export function launchable(cwd: string): { ok: true } | { ok: false; why: string } {
  const resolved = path.resolve(cwd);
  if (resolved === '/') return { ok: false, why: 'la raíz del sistema no es un proyecto' };
  for (const root of FORBIDDEN_ROOTS) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return { ok: false, why: `ruta de sistema, no se toca nada ahí: ${resolved}` };
    }
  }
  return { ok: true };
}

/* ── hashing / códigos estables ───────────────────────────────────── */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Dos caracteres estables derivados de un id. Estable entre reinicios porque
 * sólo depende del sha256 del seed — nada de contadores en memoria.
 * `bump` desplaza determinísticamente para resolver colisiones.
 */
export function stableCallsign(seed: string, bump = 0): string {
  const h = createHash('sha256').update(seed).digest();
  const n = ((h[0]! << 8) | h[1]!) + bump * 7919; // primo: dispersa las colisiones
  const a = ALPHABET[Math.floor(n / ALPHABET.length) % ALPHABET.length]!;
  const b = ALPHABET[n % ALPHABET.length]!;
  return a + b;
}

/**
 * Código de proyecto: prioriza letras reales del nombre para que sea legible
 * ("axolots" → "AX"), y sólo cae al hash cuando el nombre no da para dos letras.
 */
export function projectCode(name: string, bump = 0): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (bump === 0 && letters.length >= 2) return letters.slice(0, 2);
  if (bump > 0 && letters.length >= 2) {
    // Segundo intento: primera letra + n-ésima letra distinta del nombre.
    const first = letters[0]!;
    const idx = 1 + (bump - 1);
    if (idx < letters.length) return first + letters[idx]!;
  }
  return stableCallsign(name, bump);
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/* ── texto ────────────────────────────────────────────────────────── */

/** Aplana a una línea y recorta. Todo lo que va al HUD pasa por aquí. */
export function oneLine(text: unknown, max = 160): string {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * Lo que el agente dijo, entero: sin aplanar y con el tope del informe.
 *
 * El complemento de `oneLine`. Un tile quiere una línea; el registro de la
 * misión quiere el informe, con sus saltos de línea y su markdown, porque es
 * lo único que queda cuando el transcript del agente ya no se mira.
 */
export function fullText(text: unknown, max = MAX_REPORT): string {
  if (typeof text !== 'string') return '';
  const t = text.trim();
  return t.length > max ? t.slice(0, max) : t;
}

export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** epoch ms desde el `timestamp` ISO de un transcript. */
export function tsMs(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return fallback;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : fallback;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
