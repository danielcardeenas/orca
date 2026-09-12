/**
 * El tirante: la línea que une un output del canvas con quien lo hizo.
 *
 * Un artefacto en el campo sin línea a su origen es una foto en el suelo: se
 * ve, pero no se sabe de quién es ni por qué está ahí. Así que **todo output
 * dibujado lleva un tirante** hasta su origen —la baldosa de su agente, o el
 * puerto de su escuadra cuando el agente ya no tiene baldosa— y el tirante es
 * lo que responde *quién* sin abrir nada.
 *
 * Dos formas, una sola regla:
 *
 * - **La ficha de la estantería** (`shelf.ts`) cuelga de la baldosa que tiene
 *   encima: un tirante vertical desde el borde superior de la ficha hasta el
 *   borde inferior de la baldosa, uno por ficha. Cinco fichas son cinco
 *   hilos cortos, y así cada una dice de quién es sin que haya que deducirlo
 *   de la vecindad. No cruzan nada: el hueco que atraviesan lo reservó la
 *   rejilla para la estantería.
 * - **La superficie colocada** (`media.ts`) puede estar en cualquier sitio,
 *   porque la puso el operador. Su tirante es un camino ortogonal, como los
 *   demás del campo (`pipes.ts`): sale por el lado de la superficie que mira
 *   al origen, cruza a media distancia y entra por el lado del origen que
 *   mira a la superficie. Varias superficies de un mismo agente convergen en
 *   el mismo punto de su baldosa, así que N outputs son un haz y no N líneas
 *   sueltas.
 *
 * En reposo el tirante es tenue —está, pero no compite con los pipes de
 * linaje ni con las baldosas—; con el puntero sobre el output, o sobre su
 * origen, se vuelve lima, más grueso y con el puerto de origen encendido
 * (`tetherWeight`). Cuánto se atenúa lo decide el shader de `pipes.ts`; aquí
 * sólo vive la geometría y la regla de qué está caliente, que es la parte que
 * se equivoca en silencio: un tirante que entra por la mordida de la baldosa
 * no falla, sólo parece que sale de otro sitio.
 *
 * Sin `three` y sin DOM, como `shelf.ts`. Ver `docs/CANVAS-CONEXIONES-2026-09-12.md`.
 */

import type { ChipSpec } from './shelf.ts';
import { TILE_H } from './grid.ts';
import type { Pt } from './pipes.ts';

/** Una caja en el plano, por su centro y sus lados. Un punto es una caja de lado 0. */
export interface Rect { x: number; y: number; w: number; h: number }

/** Un tirante listo para `pipes.add`: su camino, y si está caliente. */
export interface Tether {
  /** El artefacto al que pertenece. */
  id: string;
  pts: Pt[];
  z: number;
  /** 1 con el puntero encima del output o de su origen, 0 en reposo. */
  hot: number;
  /** 1 cuando el origen está seleccionado: el modo foco lo mantiene. */
  sel: number;
}

/**
 * A qué altura entra un tirante por el LADO de una baldosa, en fracción de su
 * alto y por debajo de la línea media. La mordida está en el borde derecho y
 * el puerto de mensajes (`routeMessage`) entra a +0.12: un tirante a −0.12 no
 * pisa ni la una ni el otro, y dos líneas que llegan a una baldosa por lados
 * distintos siguen leyéndose como dos cosas distintas.
 */
export const SIDE_DROP = 0.12;

/** Donde dos puntos difieren tan poco que un tramo entre ellos es un error de redondeo. */
const EPS = 1e-4;

/**
 * El camino de un tirante, del output a su origen.
 *
 * Ortogonal, como todo lo que une cosas en el campo: sale por el lado de
 * `from` que mira a `to`, y entra por el lado de `to` que mira a `from`. Qué
 * eje manda lo decide el aire entre las dos cajas: si el hueco horizontal es
 * mayor que el vertical se sale por un costado, si no por arriba o por abajo.
 * Con las dos en línea, un solo tramo; si no, tres, con el codo a media
 * distancia. Un tramo por dentro de una caja sería una línea que atraviesa lo
 * que dice unir.
 *
 * `to` puede ser un punto (lado 0): el puerto de una escuadra. Entonces el
 * tirante acaba en el puerto mismo.
 */
export function tetherRoute(from: Rect, to: Rect): Pt[] {
  const dx = to.x - from.x, dy = to.y - from.y;
  const gapX = Math.abs(dx) - (from.w + to.w) / 2;
  const gapY = Math.abs(dy) - (from.h + to.h) / 2;
  if (gapX >= gapY) {
    const sx = dx >= 0 ? 1 : -1;
    const ax = from.x + sx * from.w / 2;
    const bx = to.x - sx * to.w / 2;
    const ay = from.y;
    const by = to.y - to.h * SIDE_DROP;
    if (Math.abs(ay - by) < EPS) return [{ x: ax, y: ay }, { x: bx, y: by }];
    const mx = (ax + bx) / 2;
    return [{ x: ax, y: ay }, { x: mx, y: ay }, { x: mx, y: by }, { x: bx, y: by }];
  }
  const sy = dy >= 0 ? 1 : -1;
  const ay = from.y + sy * from.h / 2;
  const by = to.y - sy * to.h / 2;
  const ax = from.x;
  const bx = to.x;
  if (Math.abs(ax - bx) < EPS) return [{ x: ax, y: ay }, { x: bx, y: by }];
  const my = (ay + by) / 2;
  return [{ x: ax, y: ay }, { x: ax, y: my }, { x: bx, y: my }, { x: bx, y: by }];
}

/**
 * El hilo del que cuelga una ficha: del centro de su borde superior al borde
 * inferior de la baldosa, en vertical. Mide exactamente `SHELF_PAD` a la
 * escala de la baldosa, que es el aire que `shelf.ts` dejó entre las dos, y
 * por eso no hay nada que pueda quedar debajo.
 */
export function chipStem(chip: Pick<ChipSpec, 'x' | 'y' | 'h'>, tile: { y: number; scale: number }): Pt[] {
  return [
    { x: chip.x, y: chip.y + chip.h / 2 },
    { x: chip.x, y: tile.y - (TILE_H * tile.scale) / 2 },
  ];
}

/**
 * ¿Está caliente el tirante de este output?
 *
 * Sí con el puntero sobre el output mismo, o sobre su origen —la baldosa o la
 * escuadra—: el hover funciona en los dos sentidos, y al pasar por una
 * baldosa se encienden todos sus tirantes a la vez, que es la forma barata de
 * responder «¿qué ha hecho éste?». `hotOrigins` trae los orígenes calientes
 * ya resueltos por el campo, que es quien sabe qué hay bajo el puntero.
 */
export function tetherHot(art: { id: string }, originId: string | null, hoverArt: string | null, hotOrigins: ReadonlySet<string>): boolean {
  if (hoverArt === art.id) return true;
  return originId !== null && hotOrigins.has(originId);
}

/**
 * Grosor del tirante, como multiplicador del ancho base de `pipes.ts`.
 *
 * En reposo la mitad del bus de linaje: presente, sin competir. Empezó en un
 * tercio y en la foto con trescientos pipes en cuadro no se distinguía del
 * suelo; a la mitad es una hairline que se ve y sigue por debajo de todo lo
 * que trabaja. Caliente, siete décimas: se ve de un vistazo cuál es, sin
 * llegar al peso de un pipe de estructura — un tirante no es una relación de
 * trabajo, es una etiqueta. Lo que lo separa del tráfico no es sólo el peso:
 * es la forma — continuo, cuando todo lo que se mueve va a rachas.
 */
export function tetherWeight(hot: boolean): number {
  return hot ? 0.7 : 0.5;
}

/**
 * Escala del puerto que marca el extremo de origen. Pequeño y apagado en
 * reposo —una marca de dónde muere la línea—, entero cuando el tirante está
 * caliente: es el «realce del extremo de origen» que pide el operador.
 */
export function originPortScale(hot: boolean): number {
  return hot ? 1 : 0.6;
}
