/**
 * La estantería: lo que un agente ha hecho, bajo su baldosa.
 *
 * El canvas dice la forma de la flota, y esa forma está hecha de baldosas de un
 * tamaño conocido a un paso conocido (`grid.ts`: TILE_W 1.0, paso 1.24). Una
 * superficie de media mide 2,4 unidades —dos baldosas y media— así que un
 * artefacto anclado a un agente por su cuenta entierra a sus vecinos. Lo que
 * aparece solo tiene que medir lo que mide una baldosa.
 *
 * De ahí la estantería: una franja estrecha bajo la baldosa con fichas
 * cuadradas, una por artefacto, y una última ficha que es un contador. Cuarenta
 * imágenes son cuatro fichas y un `+36`; las cuarenta están en la galería, que
 * es el sitio de un índice. El lienzo dice quién hizo cosas y da la puerta.
 *
 * Este módulo es sólo la geometría y la cuenta, sin `three` y sin DOM, porque es
 * la parte que se puede equivocar en silencio: una ficha media unidad más ancha
 * no falla, tapa. `shelfHeight` es lo que el layout tiene que reservar para que
 * nada quede debajo; ver `docs/CANVAS-ARTEFACTOS-2026-09-12.md`.
 */

import type { Artifact } from '../../shared/types.ts';
import { TILE_H, TILE_W } from './grid.ts';
import { TIER_PX } from './labels.ts';

/** Fichas de artefacto visibles. La quinta plaza es siempre el contador. */
export const CHIP_MAX = 4;
/** Plazas en la fila: las fichas más el contador. */
const SLOTS = CHIP_MAX + 1;
/** Aire entre dos fichas. */
export const CHIP_GAP = 0.035;
/**
 * Una ficha es cuadrada y la fila entera mide exactamente una baldosa: cinco
 * plazas y cuatro huecos dentro de `TILE_W`. Una fila más ancha que su baldosa
 * es el mismo error que la superficie de media, sólo más pequeño.
 */
export const CHIP_W = (TILE_W - (SLOTS - 1) * CHIP_GAP) / SLOTS;
/** Aire entre el borde de abajo de la baldosa y la fila. */
export const SHELF_PAD = 0.06;
/** Lo que la estantería le pide a la celda: el aire más la fila. */
export const SHELF_H = SHELF_PAD + CHIP_W;
/**
 * La franja se levanta una pizca sobre la baldosa para que el buffer de
 * profundidad las distinga sin pelearse, igual que hace el marco de `media.ts`.
 */
export const SHELF_Z = 0.01;

/**
 * A partir de qué tamaño de baldosa, en píxeles, se dibuja la estantería: el
 * peldaño 3 de los rótulos (`labels.ts`), donde la baldosa ya dice lo que está
 * haciendo. Ahí una ficha son 33 px, que es una imagen. En el peldaño de abajo
 * serían 19 px, que es un color, y un color no es una miniatura: es ruido
 * fotográfico encima de la silueta. Por debajo la estantería no se encoge,
 * desaparece — pero el hueco sigue reservado, así que la flota no se recoloca
 * al alejarse, que sería mucho peor que una franja vacía.
 */
export const SHELF_PX = TIER_PX[2];

/** Una ficha de la fila. El contador es la que trae `more > 0`. */
export interface ChipSpec {
  /** El artefacto, o null en la ficha contador. */
  id: string | null;
  /** Cuántos artefactos quedan detrás del contador. 0 en una ficha normal. */
  more: number;
  /** Centro de la ficha, en unidades de mundo. */
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
}

/**
 * Lo que un agente cuelga de su baldosa: lo que declaró, lo más nuevo primero.
 *
 * Sólo lo **declarado**. Ésa es la decisión del miembro 1 sobre la captura
 * (`docs/ENTREGA-CAPTURA-ARTEFACTOS-2026-09-12.md`), y es también la mejor
 * respuesta que hay al caso difícil del operador: un agente que genera cuarenta
 * png no tiene cuarenta resultados, tiene uno, y sólo él sabe cuál. Lo observado
 * apareció sin que nadie lo eligiera y su título es un nombre de archivo; su
 * sitio es la galería, que es un índice, y no el campo, que es un mapa.
 *
 * Un agente que declara de verdad muchas cosas sigue cabiendo: son cuatro
 * fichas y un contador.
 */
export function shelfIds(artifacts: Iterable<Artifact>, agentId: string): string[] {
  const mine: Artifact[] = [];
  for (const a of artifacts) {
    if (a.agentId !== agentId || a.source !== 'declared') continue;
    mine.push(a);
  }
  mine.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return mine.map((a) => a.id);
}

/** La baldosa bajo la que cuelga la estantería. Sale de `layout.ts`. */
export interface ShelfTile {
  x: number;
  y: number;
  z: number;
  /** 1 en una baldosa, `CELL_SCALE` en una celda de bandeja, 1.4 en CAPCOM. */
  scale: number;
  /** El padre en cuya bandeja está esta celda, o null si es una baldosa. */
  trayOf: string | null;
}

/**
 * Alto que la estantería le pide a la celda del agente, en unidades de mundo.
 *
 * Cuantizado a un solo escalón a propósito: el mismo alto para un artefacto que
 * para cuarenta. Reservar por cuenta recolocaría la flota cada vez que un agente
 * escribe un archivo; así se recoloca una vez por agente, cuando llega el
 * primero, y no vuelve a moverse.
 *
 * Una celda de bandeja no tiene estantería: es demasiado pequeña para nada y
 * dice sólo su estado, la misma regla que ya siguen los rótulos.
 */
export function shelfHeight(count: number, tile: Pick<ShelfTile, 'scale' | 'trayOf'>): number {
  if (count <= 0) return 0;
  if (tile.trayOf !== null || tile.scale < 1) return 0;
  return SHELF_H * tile.scale;
}

/** ¿Se dibuja la estantería con la baldosa a este ancho en píxeles? */
export function shelfVisible(tilePx: number): boolean {
  return tilePx >= SHELF_PX;
}

/**
 * Las fichas, de izquierda a derecha y las más nuevas primero.
 *
 * `ids` llega ya ordenado por quien lo llama —el mundo ordena por `at`— y esta
 * función no reordena: la recencia es la única ordenación que un operador ha
 * pedido nunca (ver `gallery.ts`).
 */
export function shelfChips(ids: string[], tile: ShelfTile): ChipSpec[] {
  if (!ids.length) return [];
  if (shelfHeight(ids.length, tile) === 0) return [];

  const s = tile.scale;
  const w = CHIP_W * s;
  const gap = CHIP_GAP * s;
  /*
   * Cuando caben todas y sobra la plaza del contador, la fila se centra sobre lo
   * que hay en vez de dejar un hueco a la derecha: una fila de dos fichas
   * pegadas al borde izquierdo lee como si faltara algo.
   */
  const shown = Math.min(ids.length, CHIP_MAX);
  const more = ids.length - shown;
  const slots = shown + (more > 0 ? 1 : 0);
  const rowW = slots * w + (slots - 1) * gap;
  const left = tile.x - rowW / 2 + w / 2;
  const y = tile.y - (TILE_H * s) / 2 - SHELF_PAD * s - w / 2;
  const z = tile.z + SHELF_Z;

  const out: ChipSpec[] = [];
  for (let i = 0; i < shown; i++) {
    out.push({ id: ids[i]!, more: 0, x: left + i * (w + gap), y, z, w, h: w });
  }
  if (more > 0) out.push({ id: null, more, x: left + shown * (w + gap), y, z, w, h: w });
  return out;
}
