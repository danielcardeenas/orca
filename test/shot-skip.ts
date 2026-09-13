/**
 * El tercer estado de un shot: ni verde ni rojo.
 *
 * Un shot que necesita algo del fixture —que la escuadra del arnés aparezca,
 * que un miembro tenga baldosa propia— y no lo consigue, no ha probado nada.
 * Ponerlo rojo envenena la puerta para el siguiente; dejarlo salir con cero
 * lo cuenta como éxito y convierte «16/16 shots pasan» en una frase sin
 * contenido: `shelf-routes.shots.ts` tenía SEIS salidas así y en el tablero
 * se leían como verde.
 *
 * El patrón que se copia es el amarillo de `sin suite que los cubra`
 * (`test/run.ts`): correr menos sólo es honesto si se ve qué se quedó fuera.
 *
 * El aviso viaja por el CÓDIGO DE SALIDA, no por lo que diga el log: el
 * runner corre cada shot en su propio proceso y leer su estado de una cadena
 * en cuatrocientas líneas es justo la clase de detección que se rompe cuando
 * alguien cambia un mensaje. El motivo sí va por stdout, marcado, porque es
 * texto para un humano y no una señal.
 */

/**
 * Con qué sale un shot que se omitió. 77 es `EX_NOPERM` de sysexits y aquí
 * no significa nada más que «ni 0 ni 1»: lo que importa es que no colisione
 * con el 1 de una aserción rota ni con el 0 del éxito.
 */
export const SKIP_CODE = 77;

/** La marca que lleva la línea del motivo. */
export const SKIP_MARK = '[shot:skip]';

/**
 * Omitir el shot: decir por qué y dejar el código de salida puesto.
 *
 * No corta la ejecución —el `finally` del shot tiene que cerrar su navegador
 * y su arnés igual—, así que quien la llama sale de su `main` con un
 * `return`, como se venía haciendo.
 */
export function skipShot(why: string): void {
  console.log(`${SKIP_MARK} ${why}`);
  process.exitCode = SKIP_CODE;
}

/**
 * El motivo que dejó un shot omitido, para el resumen del runner. El último,
 * si hubo varios: es el que decidió la salida.
 */
export function skipReasonOf(out: string): string {
  const lines = out.split('\n').filter((l) => l.includes(SKIP_MARK));
  const last = lines[lines.length - 1];
  return last ? last.slice(last.indexOf(SKIP_MARK) + SKIP_MARK.length).trim() : '';
}
