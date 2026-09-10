/**
 * Máquinas sintéticas: el arnés, marcado en el protocolo.
 *
 * `test/fake-collector.ts` habla el protocolo entero —levanta proyectos,
 * agentes que trabajan y agentes que ESCALAN preguntas— y el hub no tenía
 * forma de distinguir una pregunta de mentira de una de verdad. Arrancado
 * contra el hub real, sus agentes de fixture le pasaron al CAPCOM real nueve
 * minutos de preguntas inventadas ("¿subimos three.js a 0.185?") y se llevaron
 * su contexto por delante. El arnés cuesta lo que cuesta desarrollar; no puede
 * costar además el mando de la flota.
 *
 * La marca la pone la propia máquina en su `hello`. Que sea una declaración
 * del collector y no una deducción del hub es lo que la hace segura: sólo
 * quita permisos —nadie gana nada declarándose falso— y sigue en pie aunque
 * alguien arranque el mock a mano contra el puerto que sea, que es
 * exactamente cómo ocurrió.
 *
 * La regla es una cuarentena simétrica, no un filtro sobre CAPCOM: lo
 * sintético y lo real no se hablan en ninguna dirección. Un `say` que sale del
 * hub acaba pegado en un pane de tmux de verdad, y da igual si lo disparó una
 * escalación o un mensaje de un escuadrón que por casualidad se llama igual.
 * Dentro de su mundo el arnés conserva todo: sus escalaciones siguen llegando
 * a la consola —que es lo que hay que poder mirar y fotografiar— y llegarían
 * a un CAPCOM sintético si algún día el mock levanta uno.
 */

import type { Machine } from './types.ts';

/** ¿Es esta máquina parte del arnés? Sin máquina, no: el mundo real es el defecto. */
export function isSynthetic(m: Pick<Machine, 'synthetic'> | undefined | null): boolean {
  return m?.synthetic === true;
}

/**
 * ¿Viven las dos en el mismo mundo? Es la única pregunta que hace falta para
 * enrutar: dos sintéticas sí, dos reales sí, una de cada no.
 */
export function sameWorld(
  a: Pick<Machine, 'synthetic'> | undefined | null,
  b: Pick<Machine, 'synthetic'> | undefined | null,
): boolean {
  return isSynthetic(a) === isSynthetic(b);
}

/* ── El recinto: dónde se dibuja lo que no ocurrió ────────────────── */

/**
 * Dónde vive el arnés que levantó esta máquina, si es que lo dijo.
 *
 * `''` cuando es del arnés y no declaró de dónde salió —un mock viejo, uno
 * arrancado desde cualquier parte—; `null` cuando la máquina es de verdad. La
 * marca sólo vale sobre una máquina ya declarada fixture: `synthetic` es lo
 * que quita permisos, y ésta no puede ser una puerta para que una máquina real
 * se cuelgue de la isla de un proyecto ajeno.
 */
export function harnessHome(m: Pick<Machine, 'synthetic' | 'harnessOf'> | undefined | null): string | null {
  if (!isSynthetic(m)) return null;
  return m?.harnessOf ?? '';
}

/**
 * El recinto del arnés es una isla que no es un proyecto, como la de fuera de
 * la flota (`shared/workspaces.ts`): agrupa a TODAS las máquinas de fixture
 * que salieron del mismo sitio —el mock levanta tres— para que el campo
 * dibuje un recinto y no tres islas sueltas repartidas por la espiral.
 *
 * El prefijo empieza por `~`, que ningún `machineId` puede llevar, así que un
 * id de recinto nunca colisiona con un `projectId` de verdad.
 */
export const HARNESS_ISLAND = '~harness/';

/** El recinto de lo que salió de este directorio. Sin directorio, uno común. */
export function harnessIsland(hostSlug: string): string {
  return `${HARNESS_ISLAND}${hostSlug}`;
}

/** ¿Es este id el de un recinto del arnés? */
export function isHarnessIsland(id: string): boolean {
  return id.startsWith(HARNESS_ISLAND);
}

/** El slug del directorio anfitrión que hay dentro de un id de recinto. */
export function harnessHostSlug(islandId: string): string {
  return isHarnessIsland(islandId) ? islandId.slice(HARNESS_ISLAND.length) : '';
}

/**
 * Cómo se rotula el recinto. El código no son dos letras —no es un proyecto—
 * y la palabra dice en una lo que es todo lo de dentro: nada de esto ocurrió.
 * El nombre del anfitrión se le añade en el campo, que es quien lo conoce.
 */
export const HARNESS_LABEL = { code: '~~', name: 'harness' } as const;

/** Lo que se anota en el feed la primera vez que una máquina del arnés pregunta. */
export function syntheticNote(machineId: string): string {
  return `máquina sintética ${machineId}: sus preguntas se quedan en la cola del humano, no van al mando`;
}

/* ── La frontera: qué hub admite fixtures ─────────────────────────── */

/**
 * La variable con la que un hub se declara DE PRUEBAS.
 *
 * Existe porque la cuarentena no bastó. La marca `synthetic` quita permisos a
 * una máquina ya dentro —sus preguntas no llegan al mando, sus mensajes no
 * cruzan— pero no impedía que entrara: el 2026-09-07 alguien arrancó el mock
 * contra el puerto 4479 con `--anyway` y metió ~1.330 agentes y siete
 * proyectos inventados en la consola del operador, con más de mil dólares de
 * gasto ficticio. `list_fleet` pasó de 2 KB a 121 KB y dejó de servirle a
 * CAPCOM. El guardarraíl estaba en el cliente: era una pregunta que se
 * respondía con un flag.
 *
 * Así que la decisión se muda al hub y se invierte. El arnés ya no pide
 * permiso: es el hub el que tiene que declararse de pruebas, y el hub real
 * nunca lo hace. Un hub de pruebas nace con esto en su entorno —lo ponen
 * `test/run.ts`, `test/visual.ts --isolated` y el `--isolated` del propio
 * mock—; el que arranca `npm start`, `npm run dev` o el servicio del operador
 * no lo tiene y no hay flag que se lo dé.
 */
export const HARNESS_ENV = 'ORCA_HARNESS';

/**
 * ¿Es este hub de pruebas? Sólo si lo dice su propio entorno.
 *
 * El defecto es "no": un entorno sin la variable, uno recortado, uno de un
 * servicio de arranque, todos son el mundo real. Es la dirección segura del
 * error — equivocarse dice que no se admiten fixtures, nunca que sí.
 */
export function isHarnessHub(env: Record<string, string | undefined>): boolean {
  const v = env[HARNESS_ENV];
  return v === '1' || v === 'true' || v === 'yes';
}

/** Lo que se cierra la conexión de un fixture que llamó a la puerta equivocada. */
export const HARNESS_REFUSED = 'hub real: no admite máquinas sintéticas';

/** Lo que se le dice a quien lo intentó, con la salida incluida. */
export function harnessRefusedWhy(machineId: string): string {
  return `máquina sintética ${machineId} rechazada: este hub no se declara de pruebas `
    + `(${HARNESS_ENV} sin definir). Levanta el tuyo con --isolated.`;
}
