/**
 * ORCA hub — tokens.
 *
 * Un único token compartido entre collectors y consolas. Es a propósito lo más
 * simple que puede funcionar: el hub no tiene usuarios, tiene un dueño.
 *
 *   ORCA_TOKEN definido        → ese es el token.
 *   ~/.orca/token existe       → se reutiliza (sobrevive reinicios).
 *   nada                       → se genera, se escribe con chmod 600 y se
 *                                imprime en el arranque.
 *
 * Concesión al bucle de desarrollo: si no hay ORCA_TOKEN en el entorno y la
 * conexión viene de loopback, se acepta sin token — pero se grita en el log.
 * En cuanto defines ORCA_TOKEN, esa puerta se cierra.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const ORCA_DIR = process.env['ORCA_HOME'] ?? join(homedir(), '.orca');
export const TOKEN_FILE = join(ORCA_DIR, 'token');

/** Código de cierre para un token inválido. Acordado con la consola. */
export const CLOSE_UNAUTHORIZED = 4001;
/** Versión de protocolo incompatible. */
export const CLOSE_BAD_VERSION = 4002;
/** Hello ausente o malformado. */
export const CLOSE_BAD_HELLO = 4003;

export interface Auth {
  token: string;
  /** De dónde salió: útil para el mensaje de arranque. */
  source: 'env' | 'file' | 'generated';
  /** true cuando se tolera conexión local sin token. */
  allowLoopbackAnonymous: boolean;
  check(provided: string | null | undefined, remote: string | null | undefined): AuthResult;
  banner(): string[];
}

export interface AuthResult {
  ok: boolean;
  reason?: string;
  anonymous?: boolean;
}

function eq(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual exige misma longitud; comparamos longitudes por separado.
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** ::1, 127.0.0.0/8, ::ffff:127.x. Nada más cuenta como local. */
export function isLoopback(remote: string | null | undefined): boolean {
  if (!remote) return false;
  const addr = remote.replace(/^::ffff:/, '');
  if (addr === '::1' || addr === 'localhost') return true;
  return /^127\./.test(addr);
}

/** El archivo de token depende del entorno que se pase, no del global: así una
 *  prueba puede darse su propio ORCA_HOME sin tocar el del humano. */
function tokenFileFor(env: NodeJS.ProcessEnv): string {
  const home = env['ORCA_HOME'];
  return home ? join(home, 'token') : TOKEN_FILE;
}

function readExisting(file: string): string | null {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    return raw.length >= 16 ? raw : null;
  } catch {
    return null;
  }
}

function persist(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);   // por si el archivo ya existía con otro modo
}

export function createAuth(env: NodeJS.ProcessEnv = process.env): Auth {
  const file = tokenFileFor(env);
  const fromEnv = (env['ORCA_TOKEN'] ?? '').trim();
  let token = fromEnv;
  let source: Auth['source'] = 'env';

  if (!token) {
    const existing = readExisting(file);
    if (existing) {
      token = existing;
      source = 'file';
    } else {
      token = randomBytes(24).toString('hex');
      source = 'generated';
      try {
        persist(file, token);
      } catch (err) {
        console.warn('[auth] no pude escribir', file, err);
      }
    }
  }

  // Sólo hay puerta trasera local cuando el humano no ha fijado ORCA_TOKEN.
  const allowLoopbackAnonymous = fromEnv.length === 0 && env['ORCA_STRICT_AUTH'] !== '1';

  return {
    token,
    source,
    allowLoopbackAnonymous,
    check(provided, remote) {
      if (typeof provided === 'string' && provided.length > 0) {
        return eq(provided, token) ? { ok: true } : { ok: false, reason: 'token inválido' };
      }
      if (allowLoopbackAnonymous && isLoopback(remote)) {
        return { ok: true, anonymous: true };
      }
      return { ok: false, reason: 'falta token' };
    },
    banner() {
      const lines: string[] = [];
      if (source === 'env') {
        lines.push('[auth] token tomado de ORCA_TOKEN');
      } else if (source === 'file') {
        lines.push(`[auth] token reutilizado de ${file}`);
        lines.push(`[auth] ORCA_TOKEN=${token}`);
      } else {
        lines.push(`[auth] token nuevo generado y guardado en ${file} (chmod 600)`);
        lines.push(`[auth] ORCA_TOKEN=${token}`);
      }
      if (allowLoopbackAnonymous) {
        lines.push('[auth] ⚠ MODO DEV: se aceptan conexiones de localhost SIN token.');
        lines.push('[auth] ⚠ Define ORCA_TOKEN (o ORCA_STRICT_AUTH=1) antes de exponer este puerto.');
      }
      return lines;
    },
  };
}
