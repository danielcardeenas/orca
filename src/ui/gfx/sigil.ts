/**
 * Sigils — the mark that says *who*, at any zoom.
 *
 * A sigil is a 5×5 pixel glyph, mirrored about its vertical axis, drawn from
 * fifteen bits. It rides the top-right corner of every tile (clear of the
 * bite), and it repeats — same bits, same glyph — in the window header and in
 * the squad label. A lone agent hashes its `agent.id`; a squad member hashes
 * the *squad name*, so five members wear the same shoulder patch and the block
 * reads as one body before you see its outline. The lead wears the same glyph
 * inverted: a block of ink with the glyph cut out.
 *
 * The bit layout is shared with `field/swarm.ts`'s fragment shader, so it is
 * fixed here and nowhere else: for cell `(cx, cy)` with `cx, cy` in `0..4` and
 * `cx' = min(cx, 4 − cx)`, the bit index is `cy * 3 + cx'`, and a set bit is a
 * filled cell. Row 0 is the top row. Five rows by three independent columns is
 * fifteen bits — an exact fit in a float mantissa, which is how the shader
 * carries it (`iSigil`).
 *
 * Colour is never state: the sigil says who, the left stripe says how it is.
 */

import { C } from './logo.ts';

/** Cells per side. */
export const SIGIL_N = 5;
/** Independent columns: 0, 1, 2 — columns 3 and 4 mirror 1 and 0. */
const COLS = 3;
/** Bits in a sigil: 5 rows × 3 independent columns. */
const NBITS = SIGIL_N * COLS;
const MASK = (1 << NBITS) - 1; // 0x7fff

/**
 * Encode five 5-character rows ('#' is a filled cell, anything else empty)
 * into the 15-bit scheme. Only the left half of each row (cx 0..2) is read;
 * the right half is the mirror and is not stored.
 */
function encode(rows: string[]): number {
  let bits = 0;
  for (let cy = 0; cy < SIGIL_N; cy++) {
    const row = rows[cy] ?? '';
    for (let cx = 0; cx < COLS; cx++) {
      if (row[cx] === '#') bits |= 1 << (cy * COLS + cx);
    }
  }
  return bits;
}

/**
 * CAPCOM's sigil: the wordmark's `C` (gfx/logo.ts), which is 6×7, brought
 * down to the 5×5 grid.
 *
 * The choice, since §7 leaves it open. Rows: the C is a top bar, five
 * identical stem rows and a bottom bar, so four of the stem rows would be
 * waste — keep `[0, 2, 3, 4, 6]`, dropping the two rows next to the bars so
 * the trim stays symmetric. Columns: `[0, 2, 3, 4, 5]`, which halves the 2px
 * stem to 1px and leaves the bars at three cells. The result is
 *
 *     .###.        .###.
 *     #....        #...#
 *     #....   →    #...#   (as the mirror draws it)
 *     #....        #...#
 *     .###.        .###.
 *
 * The mirror closes the C's open side: an open right side implies an open left
 * side under this bit layout, so a literal C is not expressible and the
 * silhouette — bars plus stem — is what survives. CAPCOM does not lean on the
 * glyph alone to be findable: its tile carries the permanent lime outline
 * (§1.3), which nothing else has.
 */
export const CAPCOM_BITS: number = encode(
  [0, 2, 3, 4, 6].map((r) => [0, 2, 3, 4, 5].map((c) => C[r]![c]!).join('')),
);

/**
 * Fifteen bits from a seed, deterministic: FNV-1a, folded onto 15.
 *
 * The fold (`h ^ h>>>15 ^ h>>>30`) is there so every byte of the 32-bit hash
 * gets a vote instead of only the low half. Three of the 32768 patterns are
 * not glyphs and are nudged off: the empty block (nothing to see), the solid
 * block (which would read as a lead's inverted mark) and CAPCOM's ring, which
 * belongs to exactly one agent in the fleet.
 */
export function sigilBits(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;
  let bits = (h ^ (h >>> 15) ^ (h >>> 30)) & MASK;
  if (bits === 0 || bits === MASK) bits ^= 0x2492;
  if (bits === CAPCOM_BITS) bits ^= 0x0041;
  return bits;
}

/**
 * El mismo glifo como cinco filas de `#` y `.`, que es lo que come `drawBits`
 * (`gfx/logo.ts`) y con él `paintBits` (`gfx/algn.ts`).
 *
 * Existe porque hay dos formas de pintar un sigilo y las dos hacen falta: el
 * DOM para lo que va dentro de una línea de texto, y el lienzo para lo que
 * tiene que salir nítido a un tamaño fijo junto a una insignia — que es como
 * el arranque pinta el suyo. Los bits son los mismos, y son de aquí, así que
 * las dos formas no pueden dibujar cosas distintas.
 */
export function sigilRows(bits: number): string[] {
  const b = bits & MASK;
  const rows: string[] = [];
  for (let cy = 0; cy < SIGIL_N; cy++) {
    let row = '';
    for (let cx = 0; cx < SIGIL_N; cx++) {
      const cxm = Math.min(cx, SIGIL_N - 1 - cx);
      row += ((b >> (cy * COLS + cxm)) & 1) === 1 ? '#' : '.';
    }
    rows.push(row);
  }
  return rows;
}

/** One cell is a fifth of the box; a cell's top-left runs 0 … 0.8em from the box's. */
const STEP = 1 / SIGIL_N;
const cell = (i: number) => `${(i * STEP).toFixed(1)}em`;

/**
 * The same glyph as DOM, for the window header, the squad label and the
 * mission's crew list.
 *
 * One `<i class="sigil">` of 1em, painted by up to 25 background layers of its
 * own box: every layer is a flat `linear-gradient` of `currentColor` sized to
 * one 0.2em cell and positioned onto its place in the 5×5 grid, so the caller
 * still decides the ink and the element still costs one node.
 *
 * It used to be 25 box-shadows, and it drew **nothing**: an outer shadow is
 * clipped against the element's own border-box, and every cell of this glyph
 * falls inside that box, so all 25 were cut away. The bug was quiet — the
 * markup was there, the geometry was right, and the squad label and the window
 * header just had a 1em hole where their mark should be. `hud/improve.ts` went
 * to canvas over exactly this. Backgrounds paint inside the box, which is
 * where the glyph lives.
 *
 * `inverted` (the squad lead) emits the **complement** of the glyph rather
 * than a filled box with holes: the same picture — a block of ink with the
 * glyph cut out — through one code path, and the cut-outs show the real
 * surface underneath instead of a hard-coded body colour.
 */
export function sigilHTML(bits: number, inverted = false): string {
  const b = bits & MASK;
  const layers: string[] = [];
  const spots: string[] = [];
  for (let cy = 0; cy < SIGIL_N; cy++) {
    for (let cx = 0; cx < SIGIL_N; cx++) {
      const cxm = Math.min(cx, SIGIL_N - 1 - cx);
      const on = ((b >> (cy * COLS + cxm)) & 1) === 1;
      if (on === inverted) continue; // inverted paints the cells the glyph leaves
      layers.push('linear-gradient(currentColor,currentColor)');
      spots.push(`${cell(cx)} ${cell(cy)}`);
    }
  }
  const cls = inverted ? 'sigil is-inv' : 'sigil';
  const style = layers.length
    ? ` style="background-image:${layers.join(',')};background-position:${spots.join(',')};background-size:${STEP}em ${STEP}em;background-repeat:no-repeat"`
    : '';
  return `<i class="${cls}"${style} aria-hidden="true"></i>`;
}
