/**
 * Los tipos de tools/publish.mjs, que es JS suelto a propósito —se ejecuta con
 * `node` sin pasar por tsx, igual que tools/lease.mjs— pero cuyas dos
 * decisiones sí se prueban (test/publish.test.ts). Sin esto el test lo
 * importaría como `any` y dejaría de sostener nada.
 */

/** Los nombres bajo `/assets/` que un index referencia. */
export function assetsIn(html: string): Set<string>;

/** De lo que hay en disco, lo que ya no puede pedir nadie. */
export function sweepable(have: string[], keep: Iterable<string>): string[];
