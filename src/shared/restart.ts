/**
 * El relevo de un proceso de ORCA, pedido desde dentro.
 *
 * Recargar la consola no actualiza el hub: hub y collector cargan su código al
 * arrancar (docs/PRODUCCION.md). Para que la píldora `SERVER CODE CHANGED`
 * pueda ser un botón y no un cartel, el proceso tiene que poder pedir el
 * relevo y que alguien se lo dé — ese alguien es `tools/supervise.mjs`, que
 * `npm run prod` pone delante de los dos.
 *
 * El contrato es de dos piezas y nada más: una marca en el entorno que dice
 * «aquí hay quien te relance», y un código de salida que significa «relánzame»
 * en vez de «me he caído». Sin supervisor, la marca no está, la consola no
 * ofrece el botón, y el aviso sigue diciendo lo de siempre: reinicia a mano.
 */

/**
 * `EX_TEMPFAIL` de sysexits: «vuelve a intentarlo». Cualquier otro código es
 * del proceso y se respeta — un fallo no es una petición de relevo, y un
 * supervisor que relanza lo que se cae solo esconde el error en un bucle.
 *
 * Duplicado en `tools/supervise.mjs`, que es JS suelto y no puede importarlo;
 * test/restart.test.ts sostiene que las dos copias dicen lo mismo.
 */
export const RESTART_EXIT_CODE = 75;

/** La marca que pone el supervisor en el entorno del hijo. */
export const SUPERVISED_ENV = 'ORCA_SUPERVISED';

/** ¿Hay alguien ahí fuera que vaya a relanzar este proceso? */
export function isSupervised(env: Record<string, string | undefined> = process.env): boolean {
  return env[SUPERVISED_ENV] === '1';
}

/**
 * Sale pidiendo el relevo, dejando un respiro para que salga lo último que se
 * escribió por el cable.
 *
 * El temporizador NO lleva `unref()`, y eso es el punto entero de esta
 * función. Quien pide el relevo acaba de cerrar lo suyo —sockets, watchers,
 * timers— así que el bucle de eventos se queda vacío; con un temporizador
 * `unref`'d Node no lo espera, sale por su cuenta con código 0, y un 0 es
 * precisamente lo que el supervisor entiende como «terminó bien, no lo
 * relances». El proceso no vuelve.
 *
 * Pasó el 2026-09-09 con el collector: el hub se reinició, el collector se
 * apagó para siempre, y la consola volvió a un mundo vacío — el canvas en
 * blanco de una flota que seguía trabajando y ya no tenía quien la mirara.
 * test/restart.test.ts lo sostiene desde un proceso de verdad, porque esto
 * sólo se ve en el código de salida.
 */
export function exitForRestart(delayMs = 100): void {
  setTimeout(() => process.exit(RESTART_EXIT_CODE), delayMs);
}
