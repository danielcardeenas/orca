/**
 * Las medidas de la rejilla del campo.
 *
 * Una baldosa y el aire entre dos, y nada más. Están aparte de `layout.ts`
 * porque el layout no es el único que las necesita: la estantería mide sus
 * fichas contra el ancho de una baldosa (`shelf.ts`) y el layout le reserva
 * hueco a la estantería, y con las constantes dentro del layout eso era un
 * ciclo de importación — dos módulos que se necesitan antes de existir.
 *
 * `layout.ts` las reexporta, así que quien las pedía allí sigue pidiéndolas
 * allí: son las medidas del campo, y el campo es el layout.
 */

export const TILE_W = 1.0;
export const TILE_H = 0.78;
export const GAP_X = 0.24;
export const GAP_Y = 0.26;
/** The deck breathes a little more than a region, the way the comp's does. */
export const DECK_GAP_X = 0.3;
export const DECK_GAP_Y = 0.32;
