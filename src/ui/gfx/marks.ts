/**
 * Provider marks — quién firma un modelo, en píxeles.
 *
 * Un catálogo de modelos mezcla dos proveedores en la misma lista, y sus
 * nombres no siempre lo dicen: `opus` y `gpt-5.6-sol` se distinguen porque el
 * operador ya lo sabe, no porque la lista lo enseñe. La marca lo enseña.
 *
 * Están aquí y no en `logo.ts` porque no son ORCA: son de fuera. Comparten su
 * rejilla —filas de `#` y `.`, como las letras del wordmark— para que un mismo
 * ojo lea las dos cosas sin cambiar de idioma.
 *
 * ── De dónde salen estas matrices ──────────────────────────────────
 *
 * **No están dibujadas a mano.** Son el logotipo OFICIAL de cada proveedor,
 * bajado en SVG (los paquetes de marca que publica simple-icons), rasterizado
 * y reducido a la rejilla: se dibuja a 18×12 píxeles por celda, se mide la
 * COBERTURA media de cada celda y se enciende la que pasa del 40%. Nada de
 * interpretar la forma: la forma la pone el proveedor.
 *
 * Dos intentos anteriores fallaron y merece la pena que quede escrito, porque
 * el siguiente que toque esto los repetirá:
 *
 *   - **Deducir la geometría** (tres lazos cruzándose para OpenAI, rayos para
 *     Claude) daba una figura plausible que NO era el logotipo: a 11px el nudo
 *     parecía una tuerca. Un icono que hay que explicar no es un icono.
 *   - **Reducir el logotipo a 11 celdas o menos** daba ruido: el trazo del
 *     nudo y los rayos de la ráfaga son más finos que una celda a ese tamaño,
 *     así que la mitad se perdía y la otra mitad se convertía en manchas.
 *     Engordar el trazo antes de reducir tampoco: rellena los huecos y sale un
 *     borrón.
 *
 * **Dieciocho celdas es donde empieza a reconocerse**, y por eso son 18 y no
 * las 11 de antes. A 18px es una celda por píxel: exacto, sin medias tintas y
 * sin suavizado. Sigue siendo pequeño —cinco píxeles más alto que el texto que
 * acompaña— y sigue siendo un dibujo de píxeles, que era la condición.
 *
 * ── Por qué SVG y no lienzo ────────────────────────────────────────
 *
 * `paintBits` pinta en `<canvas>` porque el wordmark y el sigilo viven en
 * sitios donde ya hay un elemento al que agarrarse y un repintado propio. Una
 * marca de proveedor vive dentro de `pick`, que reconstruye su lista entera en
 * cada filtrado: un lienzo por fila obligaría a repintar a mano después de
 * cada `innerHTML`, y a llevar el DPR a cuestas. Un `<svg>` con
 * `shape-rendering: crispEdges` es una cadena, entra en el HTML que `pick` ya
 * escribe, hereda el color con `currentColor` y sale exacto a cualquier zoom.
 */

/** La ráfaga de Claude, reducida de su SVG oficial. */
export const CLAUDE_MARK: string[] = [
  '....##....#.......',
  '....###...#.......',
  '.....##..##...#...',
  '..#..###.##..###..',
  '.###..##.##.###...',
  '..############....',
  '....#########.....',
  '.....########.####',
  '####..###########.',
  '.#############....',
  '......############',
  '....#########...#.',
  '...##..#######....',
  '..##..#.##.####...',
  '.....##.##.##..#..',
  '....##..##..##....',
  '....#...##...#....',
  '........#.........',
];

/** El nudo de OpenAI, reducido de su SVG oficial. */
export const OPENAI_MARK: string[] = [
  '......####........',
  '.....##..#####....',
  '....##...######...',
  '..###..###.....#..',
  '.####.##...#...##.',
  '.#.##.#..#####..#.',
  '##.##.#.##...####.',
  '#..##.##..##...##.',
  '##.##.#....###..##',
  '##..###....#.##.##',
  '.##...##..##.##..#',
  '.####...##.#.##.##',
  '.#..#####..#.##.#.',
  '.##...#...##.####.',
  '..#.....###..##...',
  '...######...##....',
  '....#####..##.....',
  '........####......',
];

/**
 * Las marcas por clave.
 *
 * La clave es del proveedor, no del CLI: `claude` la firma Anthropic y la
 * llevan los alias de Claude Code; `openai` la firma OpenAI y la llevan los
 * modelos que sirve Codex. Si mañana Codex sirviera un modelo de otra casa, su
 * marca sería otra y el runtime seguiría siendo `codex`.
 */
export const MARKS: Readonly<Record<string, string[]>> = {
  claude: CLAUDE_MARK,
  openai: OPENAI_MARK,
};

/** Qué marca le toca a un runtime de ORCA, si le toca alguna. */
export function markForRuntime(runtime: string): string | undefined {
  if (runtime === 'claude') return 'claude';
  if (runtime === 'codex') return 'openai';
  return undefined;
}

/**
 * La marca como `<svg>`, del tamaño que se le pida.
 *
 * Devuelve cadena vacía para una clave que no existe: una marca desconocida no
 * es un hueco raro ni un error en consola, es simplemente una lista sin marca,
 * que es exactamente como estaba la lista antes de que esto existiera.
 */
export function markSVG(key: string | undefined, px = 18): string {
  const rows = key ? MARKS[key] : undefined;
  if (!rows?.length) return '';
  const h = rows.length;
  const w = rows[0]!.length;
  let cells = '';
  for (let y = 0; y < h; y++) {
    const row = rows[y]!;
    for (let x = 0; x < w; x++) {
      if (row[x] === '#') cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  }
  // `currentColor` y no un color fijo: la marca es del color del texto que
  // acompaña, así que hereda el estado —apagada en una fila deshabilitada,
  // lima en la seleccionada— sin que `pick` tenga que saber que existe.
  return `<svg class="pmark" viewBox="0 0 ${w} ${h}" width="${px}" height="${px}"`
    + ` aria-hidden="true" focusable="false" fill="currentColor"`
    + ` shape-rendering="crispEdges">${cells}</svg>`;
}
