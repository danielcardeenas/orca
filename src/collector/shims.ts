/**
 * Los comandos `orca-*`, puestos en el PATH del worker que ORCA lanza.
 *
 * El pie que el collector pega al brief de todo miembro de escuadrón promete
 * `orca-tell`, `orca-read`, `orca-spawn` y `orca-recover`. Hasta hoy ninguno
 * existía en el PATH del agente: viven como ficheros en `bin/*.mjs` de este
 * repo y `orca-install` los enlaza en `<proyecto>/.claude/bin/`, que NO es un
 * directorio que Claude Code ponga en el PATH de nadie. Medido el 2026-09-08
 * sobre catorce agentes en dos escuadrones: al menos seis gastaron turnos
 * enteros buscándolos (`which orca-tell`, `find ~/.orca`, `npm ls -g`), uno
 * murió sin entregar tras quince minutos investigando, y varios cerraron su
 * trabajo pidiendo perdón por no haber podido avisar a su líder.
 *
 * ── Por qué un shim en el PATH y no otra cosa ─────────────────────────
 *
 * Había tres salidas y sólo una deja el pie del brief siendo verdad:
 *
 *  1. **Quitar la promesa del brief.** Barato, y deja al agente sin el canal
 *     hacia su líder. Es renunciar a lo que el escuadrón es.
 *  2. **Escribir la ruta absoluta en el brief.** Funciona y se lee fatal:
 *     `/Users/x/projects/orca/bin/orca-tell.mjs` en cada línea del pie, y
 *     distinta en cada instalación. Además no ayuda al agente que escribe un
 *     script, ni al operador que copia una línea de la documentación.
 *  3. **Ponerlos en el PATH de la sesión.** El pie sigue diciendo
 *     `orca-tell …`, que es lo que dice la documentación, lo que el modelo ya
 *     sabe teclear, y lo que funciona desde cualquier subproceso del agente.
 *
 * Se hace en el lanzamiento y no con un instalador porque el instalador es un
 * paso manual, por proyecto, que ORCA nunca ejecuta: una herramienta que hay
 * que acordarse de instalar es exactamente la que faltaba hoy.
 *
 * Cada shim es un `sh` de dos líneas con la ruta absoluta del `.mjs` y el
 * `node` con el que corre este collector (`process.execPath`), para que el
 * worker no dependa de que `node` esté en SU PATH ni de que el enlace resuelva
 * su propio `./lib`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { errText, log, orcaDir } from './util.ts';

const SCOPE = 'shims';

/** El `bin/` de este repositorio: `src/collector/` → `../../bin`. */
const REPO_BIN = fileURLToPath(new URL('../../bin', import.meta.url));

/**
 * Lo que un worker puede necesitar.
 *
 * `orca-ask` va aparte: interrumpe a la persona, y un miembro de escuadrón
 * tiene un líder para eso. Ver `shimDir`.
 */
export const WORKER_COMMANDS = ['orca-tell', 'orca-read', 'orca-show', 'orca-spawn', 'orca-recover'] as const;

/** El que sólo reciben los que pueden hablarle al humano. */
export const HUMAN_COMMAND = 'orca-ask';

/**
 * El que sólo recibe un agente revisor de AUTOMEJORA.
 *
 * Es su único canal para archivar lo que propone, y no lo lleva nadie más: un
 * comando que puede llenar el tablero de la sección en manos de cualquier
 * worker es ruido esperando a ocurrir. El hub además comprueba que quien
 * reporta ES el revisor de la revisión en vuelo, así que son dos puertas.
 */
export const REVIEW_COMMAND = 'orca-improve';

/** Qué juego de comandos lleva una sesión. Tres, y no dos: ver `shimsFor`. */
export interface ShimSet { human: boolean; review?: boolean }

/**
 * El directorio de shims que corresponde, ya escrito, o null si no se pudo.
 *
 * Dos directorios y no uno: al miembro de un escuadrón no se le da `orca-ask`.
 * El pie de su brief ya le dice que no lo use, y quitar la herramienta es más
 * fiable que pedir que no se use — un modelo atascado busca la salida que ve.
 * El líder y el agente suelto sí lo tienen: son la puerta al operador.
 *
 * Se reescribe sólo lo que cambió, así que llamarlo en cada spawn cuesta un
 * `readFileSync` por comando.
 */
export function shimDir(opts: ShimSet = { human: true }): string | null {
  const commands: string[] = [...WORKER_COMMANDS];
  if (opts.human) commands.push(HUMAN_COMMAND);
  if (opts.review) commands.push(REVIEW_COMMAND);
  const dir = path.join(orcaDir(), 'shims', opts.review ? 'review' : opts.human ? 'full' : 'squad');
  try {
    fs.mkdirSync(dir, { recursive: true });
    let written = 0;
    for (const cmd of commands) {
      const target = path.join(REPO_BIN, `${cmd}.mjs`);
      if (!fs.existsSync(target)) continue;
      const file = path.join(dir, cmd);
      const body = shimBody(target);
      let current: string | null = null;
      try { current = fs.readFileSync(file, 'utf8'); } catch { /* no estaba */ }
      if (current === body) continue;
      fs.writeFileSync(file, body, { mode: 0o755 });
      fs.chmodSync(file, 0o755);   // writeFileSync no cambia el modo de uno existente
      written++;
    }
    // Un comando que sobra de una versión anterior se retira: el brief no lo
    // nombra y dejarlo es prometer otra cosa que nadie mantiene.
    for (const name of fs.readdirSync(dir)) {
      if (!commands.includes(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
    if (written) log('info', SCOPE, `${written} comando(s) orca-* preparados en ${dir}`);
    return dir;
  } catch (err) {
    log('warn', SCOPE, `no pude preparar los comandos orca-* en ${dir}: ${errText(err)}`);
    return null;
  }
}

function shimBody(target: string): string {
  return `#!/bin/sh\n# generado por ORCA (src/collector/shims.ts); se reescribe solo\nexec ${quote(process.execPath)} ${quote(target)} "$@"\n`;
}

/** Comillas de shell para una ruta. Nadie teclea esto, pero un HOME con espacios existe. */
function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Qué juego de comandos le toca a este lanzamiento.
 *
 * Miembro de escuadrón (tiene squad y no lo lidera) = sin `orca-ask`: su
 * puerta al humano es su líder. Todo lo demás lo lleva.
 */
export function shimsFor(squad: string | null, lead: boolean, review = false): ShimSet {
  // Un revisor no habla con el humano: lo que quiera preguntarle va en el
  // campo `question` de una propuesta y le llega en el panel. Y no habla con
  // un líder, porque no tiene.
  if (review) return { human: false, review: true };
  return { human: !(squad !== null && !lead) };
}

/**
 * `PATH` con los shims delante, para el entorno de una sesión lanzada.
 *
 * Delante y no detrás: si el operador tiene una copia vieja instalada a mano,
 * la que ORCA acaba de escribir es la que corresponde a ESTE collector.
 */
export function pathWithShims(currentPath: string | undefined, opts: ShimSet): string {
  const dir = shimDir(opts);
  if (!dir) return currentPath ?? '';
  return currentPath ? `${dir}${path.delimiter}${currentPath}` : dir;
}
