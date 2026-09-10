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

/*
 * Los códigos de cierre viven en el protocolo (`shared/protocol.ts`): los
 * acuerda el hub con la consola, y la consola no puede importar nada de aquí.
 * Se reexportan para que quien ya los pedía a este módulo los siga teniendo.
 */
export {
  CLOSE_UNAUTHORIZED, CLOSE_BAD_VERSION, CLOSE_BAD_HELLO, CLOSE_NOT_HARNESS,
} from '../shared/protocol.ts';

export interface AuthOptions {
  /** Dónde va a escuchar el hub. Sin esto se asume expuesto. */
  host?: string;
}

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

/**
 * Si el hub sólo es alcanzable desde su propia máquina.
 *
 * De esto depende que la puerta anónima exista. En cuanto el hub escucha en
 * algo más ancho —0.0.0.0, la IP de la tailnet— "viene de loopback" deja de
 * significar "lo escribió el dueño", porque cualquier proxy en la misma
 * máquina reescribe esa dirección sin querer.
 *
 * Sin dato se asume lo peor. Quien no dice dónde escucha no puede pedir que se
 * le suponga a salvo.
 */
export function bindsLocalOnly(host: string | null | undefined): boolean {
  if (!host) return false;
  return isLoopback(host);
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

export function createAuth(env: NodeJS.ProcessEnv = process.env, opts: AuthOptions = {}): Auth {
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

  /*
   * La puerta trasera local pide tres cosas a la vez, y basta que falle una:
   * que el humano no haya fijado ORCA_TOKEN, que no haya pedido rigor, y que
   * el hub sólo escuche en local. La tercera es la que importa al exponerlo:
   * detrás de un túnel todo el tráfico de internet llega como 127.0.0.1, y sin
   * ella la puerta se abriría al mundo en silencio, sin un error que lo diga.
   */
  const localOnly = bindsLocalOnly(opts.host);
  const allowLoopbackAnonymous =
    fromEnv.length === 0 && env['ORCA_STRICT_AUTH'] !== '1' && localOnly;

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
        lines.push('[auth] ⚠ Existe sólo porque el hub escucha en local; expuesto, esta puerta no está.');
      } else if (!localOnly) {
        // El caso del hub alcanzable desde la tailnet o desde un túnel. Aquí
        // se le exige token hasta a localhost, y lo primero que hace falta
        // saber es cómo entra la consola desde el móvil.
        lines.push(`[auth] escuchando en ${opts.host ?? '?'}: se exige token a todo el mundo, también a localhost.`);
        lines.push(`[auth] consola: abre la url con ?k=${token} la primera vez (se guarda en el navegador).`);
      }
      return lines;
    },
  };
}
