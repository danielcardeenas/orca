/**
 * ORCA — dónde encontrar el token del hub, para todo el que no es el hub.
 *
 * El hub lo genera y lo deja en `~/.orca/token` con chmod 600 (`hub/auth.ts`);
 * los demás tienen que saber encontrarlo. Hasta ahora cada uno resolvía lo
 * suyo: `bin/orca.mjs` leía el archivo, y el collector mandaba
 * `ORCA_TOKEN ?? ''` confiando en la puerta anónima de loopback.
 *
 * Esa puerta se cierra en cuanto el hub escucha en algo que no sea localhost,
 * y entonces un collector que no sabe leer el archivo se queda fuera de su
 * propia máquina: la flota sigue viva en tmux pero desaparece de la consola.
 * De ahí que la resolución viva en un solo sitio.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { orcaHome } from './workspaces.ts';

/** Longitud mínima para que una cadena en disco cuente como token, no como ruido. */
const MIN_TOKEN_LEN = 16;

/** El archivo donde el hub deja el token. `ORCA_HOME` lo mueve. */
export function tokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(orcaHome(env), 'token');
}

/**
 * El token compartido: la variable manda, el archivo la sustituye.
 *
 * Devuelve `''` cuando no hay ninguno; decidir si eso basta es del hub, no de
 * quien llama. Se lee en cada llamada a propósito —es un stat y un read de 49
 * bytes— para que rotar el token no exija reiniciar la flota entera.
 */
export function sharedToken(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env['ORCA_TOKEN'] ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(tokenFile(env), 'utf8').trim();
    return raw.length >= MIN_TOKEN_LEN ? raw : '';
  } catch {
    return '';
  }
}
