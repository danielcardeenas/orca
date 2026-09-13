/**
 * Dónde está el buzón: la raíz del proyecto, vista desde un worktree.
 *
 * Todo el canal de ficheros de ORCA —`orca-tell`, `orca-spawn`, `orca-ask`,
 * `orca-read`, `orca-show`, `orca-improve`— escribe y lee bajo
 * `<proyecto>/.orca/`. Cada uno de los seis resolvía ese `<proyecto>` por su
 * cuenta, con la misma línea copiada seis veces:
 *
 *     git rev-parse --show-toplevel
 *
 * Y dentro de un git worktree esa línea devuelve EL WORKTREE. El collector
 * hace justo lo contrario: `foldWorktreeSlug` (collector/projects.ts) PLIEGA
 * el worktree a su repo padre, y vigila `<repo padre>/.orca/{out,in,spawn}`.
 * Dos lados resolviendo lo mismo por su cuenta, y discrepando.
 *
 * El resultado, medido el 2026-09-13: un agente que hace `cd` a un worktree
 * deja de existir para la flota sin enterarse. Sus mensajes se quedan en un
 * directorio que nadie vigila; los `ask` de sus compañeros no le llegan; sus
 * `orca-spawn` no reciben respuesta. Ese día se contaron 15 mensajes huérfanos
 * en dos worktrees, y entre ellos TRES respuestas de un líder a preguntas
 * bloqueantes de sus miembros: los tres llevaban cuarenta minutos esperando
 * una respuesta que ya estaba escrita en disco. Ni un error, ni un reintento.
 *
 * Así que la regla no es nueva y este archivo no la inventa: es la MISMA que
 * el collector ya aplica, puesta donde los seis comandos la comparten. Un
 * fallo así nace de que dos lados resuelven lo mismo por separado; el arreglo
 * es que haya un solo sitio donde se resuelva.
 */

import { execFileSync } from 'node:child_process';
import { resolve, sep, basename, dirname } from 'node:path';

/**
 * El marcador de `foldWorktreeSlug`, en forma de ruta.
 *
 * El collector lo busca sobre el slug (`--claude-worktrees-`) porque es lo
 * único que tiene cuando aparece un transcript. Aquí hay una ruta de verdad,
 * así que se busca sobre la ruta — y las dos formas reconocen exactamente el
 * mismo directorio, que es lo que importa: `WORKTREES_DIR` del collector.
 */
const WORKTREE_MARK = `${sep}.claude${sep}worktrees${sep}`;

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Pliega un worktree a la raíz del repo que lo contiene.
 *
 * Dos reglas, y el orden importa:
 *
 *  1. La del collector, literal: lo que cuelga de `.claude/worktrees/` es del
 *     proyecto padre. Se aplica primero porque es la que GARANTIZA coincidir
 *     con `foldWorktreeSlug` — es la misma comprobación sobre la misma ruta—
 *     y porque no necesita preguntarle nada a git.
 *
 *  2. Cualquier otro worktree, que el collector no pliega pero que tampoco
 *     registra como proyecto propio salvo que se lanzara un agente ahí: su
 *     `--git-common-dir` apunta al `.git` del repo principal, y ése es el
 *     directorio que sí se vigila.
 *
 * Un submódulo NO es un worktree y no se pliega: ahí `--git-dir` y
 * `--git-common-dir` son el mismo directorio, y esa igualdad es justamente lo
 * que los distingue. Sin esa comprobación, un submódulo acabaría escribiendo
 * su buzón dentro de `.git/modules`, que no es la raíz de nada.
 */
export function foldWorktree(dir) {
  const at = dir.indexOf(WORKTREE_MARK);
  if (at > 0) return dir.slice(0, at);

  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir);
  const own = git(['rev-parse', '--path-format=absolute', '--git-dir'], dir);
  if (!common || !own || common === own) return dir;
  // `<repo principal>/.git` → `<repo principal>`. Cualquier otra forma (un
  // repo bare, un layout que no reconocemos) se deja como está: plegar a
  // ciegas es peor que no plegar, porque el fallo sería el mismo de siempre y
  // encima en un directorio inesperado.
  return basename(common) === '.git' ? dirname(common) : dir;
}

/**
 * La raíz del proyecto para este comando.
 *
 * `explicit` es lo que el agente pasó en `--project`, y gana siempre: quien lo
 * escribe sabe dónde quiere el buzón y no hay nada que adivinar.
 */
export function projectRoot(explicit, cwd = process.cwd()) {
  if (explicit) return resolve(explicit);
  return foldWorktree(git(['rev-parse', '--show-toplevel'], cwd) ?? cwd);
}
