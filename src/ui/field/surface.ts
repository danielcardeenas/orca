/**
 * Las reglas de una superficie de media en el campo: cuándo se mira, cuándo se
 * reproduce, y qué pone cuando no hay nada que mirar.
 *
 * Las tres son decisiones, no dibujo, y las tres se equivocan en silencio: un
 * cuadro de diez píxeles no falla, ensucia la silueta de la flota; un vídeo
 * fuera de pantalla no falla, se come un decodificador y sube un fotograma a la
 * GPU por frame para siempre; y un binario pintado como texto no falla, pone
 * caracteres de reemplazo sobre el lienzo. Así que viven aquí, puras, con sus
 * pruebas.
 *
 * Ver `media.ts`, que las aplica.
 */

import type { ArtifactKind } from '../../shared/types.ts';

/**
 * Ancho de una superficie colocada, en unidades de mundo.
 *
 * Son 2,4 baldosas (`TILE_W` 1.0) sobre un paso de rejilla de 1,24, o sea que
 * un cuadro cubre a dos vecinos de ancho y a dos de alto. Eso lo aguanta una
 * colocación que hizo el operador —él decidió tapar lo que hay debajo—, y no lo
 * aguanta nada que aparezca solo. Lo que aparece solo es la estantería
 * (`shelf.ts`), que mide lo que mide una baldosa.
 */
export const MEDIA_W = 2.4;

/**
 * Ancho dibujado, en píxeles, por debajo del cual una superficie deja de
 * decir nada y se retira.
 *
 * Cuarenta píxeles es como un favicon: lo más pequeño en que una imagen sigue
 * siendo una imagen. Por debajo es un rectángulo de color compitiendo con la
 * silueta de la flota, y la flota gana — de lejos el trabajo del canvas es la
 * forma y el color de los estados, que es también por lo que los rótulos se van
 * a los 44 px de baldosa (`labels.ts`).
 *
 * Con la cámara en su tope (`Z_MAX` 420) y un lienzo de 900 px de alto, una
 * baldosa son 4 px y un cuadro de media 10: exactamente lo que hay que retirar.
 * En el zoom de trabajo (z 24) el mismo cuadro son 168 px y no se le toca.
 */
export const SURFACE_MIN_PX = 40;

/** ¿Sigue diciendo algo una superficie dibujada a este ancho en píxeles? */
export function surfaceShows(pxWide: number): boolean {
  return pxWide >= SURFACE_MIN_PX;
}

/**
 * ¿Tiene que estar decodificando este vídeo?
 *
 * Sólo si se está mirando. Un vídeo fuera de cuadro, o tan lejos que ya no es
 * una imagen, no es un vídeo: es un decodificador ocupado. Y los decodificadores
 * de hardware se cuentan con los dedos de una mano, así que el cuarto vídeo
 * colocado degrada a los tres primeros.
 */
export function surfacePlays(onScreen: boolean, pxWide: number): boolean {
  return onScreen && surfaceShows(pxWide);
}

/**
 * ¿Se puede pintar el contenido de este artefacto, o hay que nombrarlo?
 *
 * `file` es todo lo que no entra en las otras cuatro cajas: un `.zip`, un
 * binario, un modelo. No tiene miniatura posible y tampoco es texto — bajarlo y
 * pintarlo como texto es lo que pone `���` sobre el canvas.
 */
export function surfaceIsOpaque(kind: ArtifactKind): boolean {
  return kind === 'file';
}

/** El peso de un archivo, como lo lee una persona. */
export function weight(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Lo que pone una ficha que no puede enseñar lo que hay dentro: la extensión y
 * el peso, que es todo lo que se puede decir con verdad de un `.zip`.
 *
 * Sin extensión, la palabra. Un archivo sin nombre de tipo sigue siendo un
 * archivo, y decir `FILE` es más honesto que dejar el hueco en blanco.
 */
export function opaqueLabel(path: string, bytes: number): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toUpperCase() : 'FILE';
  const w = weight(bytes);
  return w ? `${ext} · ${w}` : ext;
}
