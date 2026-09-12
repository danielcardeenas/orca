/**
 * Tipos para `whoami.mjs`, que es JS suelto porque vive en `bin/` y lo ejecuta
 * node directamente, sin pasar por tsx. Esto existe para que la prueba —que sí
 * es TypeScript— pueda importarlo sin apagar `noImplicitAny` a su alrededor.
 */

export declare function sessionId(
  env?: Record<string, string | undefined>,
  opts?: { walk?: boolean },
): string | null;
