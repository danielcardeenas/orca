/**
 * Qué directorio NO es un proyecto de la flota.
 *
 * El collector deriva proyectos de los slugs de ~/.claude/projects: cualquier
 * directorio donde alguien haya corrido Claude Code se convierte en una isla
 * con su código de dos letras y sus agentes. Eso es lo correcto para un repo
 * y es ruido para dos clases de directorio:
 *
 *   control     el propio directorio de CAPCOM (~/.orca/capcom, o
 *               ORCA_CAPCOM_DIR). Ahí vive el mando, no el trabajo: tiene el
 *               transcript de la sesión CAPCOM viva, los de todos los CAPCOM
 *               anteriores —cada mensaje al mando pasa por `--bg --resume`,
 *               que deja una sesión nueva y la vieja listada— y los de las
 *               pruebas que se lanzaron ahí por error. Medido: 39 agentes en
 *               una isla "capcom" que no era ningún proyecto. Y peor que
 *               feo: un worker lanzado ahí lee el CLAUDE.md del mando y se
 *               despierta creyendo que él es el comandante.
 *
 *   scratchpad  el directorio temporal por sesión de Claude Code
 *               (/private/tmp/claude-<uid>/… y /tmp/claude-<uid>/…). Un
 *               agente que escribe ahí un script de sonda produce un
 *               proyecto entero — así aparecieron "probe-a" y "probe-b".
 *
 * La decisión se toma sobre el SLUG y no sobre la ruta, porque el slug es lo
 * único que hay cuando aparece un transcript y todavía no se ha leído ninguna
 * línea que declare su `cwd`. Una ruta se convierte a slug y se compara igual,
 * así que las dos entradas dan la misma respuesta.
 *
 * Vive en `shared/` porque los tres lados preguntan lo mismo: el collector
 * para no registrar el proyecto, el hub para rechazar un spawn ahí, y la
 * consola para no pintar lo que quedó dentro.
 */

/**
 * La transformación que Claude Code aplica para nombrar el directorio de un
 * proyecto: separadores Y puntos se vuelven guión, de modo que
 * `/Users/dan/.orca/capcom` se guarda como `-Users-dan--orca-capcom`.
 *
 * El punto importa: sin él, el slug de un directorio oculto —y el de CAPCOM lo
 * es— nunca coincide con el que produce su propia ruta.
 */
export function pathToSlug(p: string): string {
  return p.replace(/[/\\.]/g, '-');
}

/**
 * El home de ORCA, tal y como lo resuelven el collector (`orcaDir()`) y el hub
 * (`ORCA_DIR`). Se lee del entorno para que un test pueda mover los dos.
 */
export function orcaHome(env: Record<string, string | undefined> = process.env): string {
  const home = env['ORCA_HOME'];
  if (home) return home;
  const base = env['HOME'] ?? env['USERPROFILE'] ?? '';
  return `${base}/.orca`;
}

/**
 * Dónde vive CAPCOM. `ORCA_CAPCOM_DIR` lo mueve; `ORCA_HOME` lo mueve también.
 * Es la misma resolución que `capcomDir()` en el collector, que sigue siendo
 * quien la aplica al arrancar la sesión; aquí está para los dos lados que sólo
 * necesitan la RUTA y no pueden importar el collector.
 */
export function capcomHome(env: Record<string, string | undefined> = process.env): string {
  return env['ORCA_CAPCOM_DIR'] ?? `${orcaHome(env)}/capcom`;
}

/**
 * Dónde se archivan los relevos de CAPCOM, y dónde corre un CAPCOM relevado:
 * `<capcomHome>-handoffs`, HERMANO del directorio del mando y no hijo, para
 * que el brief de ahí no sea ancestro del cwd del destino. La misma
 * resolución que `capcomHandoffsDir()` en el collector.
 */
export function capcomHandoffsHome(env: Record<string, string | undefined> = process.env): string {
  return `${capcomHome(env)}-handoffs`;
}

/**
 * El scratchpad de Claude Code: `/tmp/claude-<uid>/…` y su forma resuelta en
 * macOS, `/private/tmp/claude-<uid>/…`. Se reconoce sobre el slug para que
 * valga igual con ruta o con slug.
 */
const SCRATCHPAD_SLUG = /^-(?:private-)?tmp-claude-\d+(?:-|$)/;

/** Por qué este directorio no es un proyecto. `null` = sí lo es. */
export type ExcludedWorkspace = 'capcom' | 'scratchpad';

/**
 * ¿Es este slug —o esta ruta— un directorio que no debe ser proyecto?
 *
 * Acepta las dos formas porque el collector tiene una u otra según el momento:
 * el slug siempre, el `cwd` sólo después de leer una línea del transcript.
 * Un subdirectorio cuenta como el directorio: `~/.orca/capcom/notes` es CAPCOM.
 *
 * Y el directorio de los relevos también, aunque sea hermano y no hijo: el
 * slug no distingue `/` de `-`, así que `~/.orca/capcom-handoffs/<id>/runtime`
 * empieza igual que el del mando y cae en la misma regla. No es un accidente
 * que se tolere: el nombre se eligió así (`capcomHandoffsHome`), y la prueba
 * de workspaces lo afirma para que renombrarlo no deje al CAPCOM relevado
 * pintado como un proyecto.
 *
 * `capcomDir` se pasa cuando quien pregunta ya sabe dónde vive el mando —el
 * collector lo sabe, es él quien lo arranca— y así no hay dos resoluciones que
 * puedan discrepar.
 */
export function excludedWorkspace(
  slugOrPath: string,
  capcomDir: string = capcomHome(),
): ExcludedWorkspace | null {
  if (!slugOrPath) return null;
  const slug = slugOrPath.startsWith('-') ? slugOrPath : pathToSlug(slugOrPath);
  if (SCRATCHPAD_SLUG.test(slug)) return 'scratchpad';
  const control = pathToSlug(capcomDir);
  if (control && (slug === control || slug.startsWith(`${control}-`))) return 'capcom';
  return null;
}

/** Atajo legible: ¿está esto dentro del directorio de CAPCOM? */
export function isCapcomWorkspace(slugOrPath: string, capcomDir?: string): boolean {
  return excludedWorkspace(slugOrPath, capcomDir) === 'capcom';
}

/**
 * Lo que se le contesta a quien intenta lanzar trabajo en el directorio de
 * CAPCOM. Uno solo, compartido por el hub, las herramientas del mando y el
 * collector, porque el que lo lee suele ser un modelo y va a reintentar: el
 * texto tiene que decirle qué hacer en vez de esto.
 */
export const CAPCOM_DIR_REFUSAL =
  'CAPCOM\'s own directory is not a project; pick a work project. '
  + 'It is the command workspace: an agent launched there reads CAPCOM\'s CLAUDE.md '
  + 'and wakes up believing it is the commander. Do not retry here.';

/** Lo mismo para el scratchpad de una sesión: no es de nadie y se borra. */
export const SCRATCHPAD_REFUSAL =
  'that path is a Claude Code scratchpad, not a project: it belongs to one session '
  + 'and is deleted with it. Pick a work project.';

/** El rechazo que corresponde, ya escrito. */
export function refusalFor(why: ExcludedWorkspace): string {
  return why === 'capcom' ? CAPCOM_DIR_REFUSAL : SCRATCHPAD_REFUSAL;
}

/**
 * ¿Se esconde este agente de la flota?
 *
 * Todo lo que vive en un directorio excluido, MENOS el mando: la sesión con
 * `role:'capcom'` es lo único que ese directorio produce y que la consola
 * quiere ver — y lo dibuja aparte, con su propio rótulo, sin isla ni proyecto.
 * Los CAPCOM anteriores ya terminados y los workers que alguien lanzó ahí por
 * error salen marcados y nadie los pinta.
 */
export function hiddenInWorkspace(
  where: ExcludedWorkspace | null, role: string | undefined,
): boolean {
  return where !== null && role !== 'capcom';
}

/* ── la isla de lo que no es un proyecto ──────────────────────────── */

/**
 * El slug sintético de la única isla que no es un proyecto.
 *
 * Un directorio excluido no se registra como proyecto —esa es la decisión de
 * arriba— pero el agente que vive ahí conserva un `projectId` derivado de su
 * slug, porque el tipo `Agent` exige uno. La consola, que agrupa por ese campo,
 * dibujaba entonces una isla por DIRECTORIO, rotulada con el id crudo
 * (`a303…d07a/-Users-dan--orca-capcom-handoffs-2a9f…-runtime`) porque no hay
 * proyecto del que sacar código ni nombre.
 *
 * Y crecía sin techo: cada relevo de CAPCOM estrena `handoffs/<planId>/runtime`,
 * un slug nuevo y una isla más. Medido: cuatro islas con el mismo aspecto.
 *
 * Ahora son UNA, la misma para el directorio del mando y para los scratchpads.
 * No se parte por clase porque la distinción que importa al mirar el campo no
 * es capcom-o-scratchpad: es que nada de eso es trabajo. La clase sigue en el
 * agente (`workspace`) para quien la necesite en una lista.
 */
export const OFF_FLEET_SLUG = '~off';

/** Su `projectId`. Lleva `machineId` delante, como cualquier proyecto. */
export function offFleetProjectId(machineId: string): string {
  return `${machineId}/${OFF_FLEET_SLUG}`;
}

/**
 * A qué isla pertenece este agente: su proyecto, o la de fuera de la flota.
 *
 * La clase viaja en el propio agente (`workspace`, que pone el collector) y no
 * se vuelve a deducir aquí: reconocerla exige saber dónde vive CAPCOM, que se
 * lee del entorno, y en la consola no hay entorno que leer.
 */
export function islandOf(
  a: { machineId: string; projectId: string; workspace?: ExcludedWorkspace },
): string {
  return a.workspace ? offFleetProjectId(a.machineId) : a.projectId;
}

/** ¿Es este `projectId` el de la isla de fuera de la flota? */
export function isOffFleet(projectId: string): boolean {
  return projectId.slice(projectId.indexOf('/') + 1) === OFF_FLEET_SLUG;
}

/**
 * Cómo se rotula. El código no son dos letras como el de un proyecto —no lo
 * es— y el nombre dice en inglés lo mismo que la isla entera: esto no está en
 * la flota.
 */
export const OFF_FLEET_LABEL = { code: '··', name: 'off-fleet' } as const;

/**
 * Lo que se le contesta a quien intenta lanzar trabajo sobre la isla.
 *
 * No es un proyecto y además no es UN directorio: agrupa varios. Sin este
 * texto el hub contestaría "proyecto desconocido", que invita a reintentar con
 * otro id en vez de decir que ahí no se lanza.
 */
export const OFF_FLEET_REFUSAL =
  'that island is not a project: it groups CAPCOM\'s own directory, its handoff '
  + 'runtimes and the session scratchpads. Pick a work project.';
