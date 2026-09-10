/**
 * gfx/sigil.ts — el glifo de 5×5 que llevan la baldosa, el rótulo de un squad
 * y ahora cada fila de la nómina de una misión.
 *
 * Los bits ya los fijaba su propio uso; lo que no estaba guardado era el
 * pintado en DOM, y ahí hubo un fallo callado: las celdas iban como sombras
 * EXTERIORES de la caja del elemento, y una sombra exterior se recorta contra
 * esa misma caja. Las veinticinco caían dentro, así que el glifo existía en el
 * marcado, medía 1em, tenía el color correcto y no dibujaba un solo píxel. Por
 * eso esta suite mira dónde se pintan las celdas y no sólo cuántas hay: una
 * celda que cae dentro de la caja se ve, y una que se pinta por fuera no.
 */

import { CAPCOM_BITS, SIGIL_N, sigilBits, sigilHTML, sigilRows } from '../src/ui/gfx/sigil.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

/** Las capas de fondo que emite el glifo, con su posición en em. */
function cells(html: string): { layers: number; spots: [number, number][] } {
  const bg = /background-image:([^;"]*)/.exec(html)?.[1] ?? '';
  const pos = /background-position:([^;"]*)/.exec(html)?.[1] ?? '';
  const spots = pos ? pos.split(',').map((p) => {
    const [x, y] = p.trim().split(/\s+/).map((v) => parseFloat(v));
    return [x ?? NaN, y ?? NaN] as [number, number];
  }) : [];
  return { layers: bg ? bg.split('linear-gradient').length - 1 : 0, spots };
}

const lit = (bits: number) => sigilRows(bits).join('').split('').filter((c) => c === '#').length;

const mod: TestModule = {
  suite: 'sigil',
  tests: [
    test('el glifo pinta una capa por celda encendida, ni una más', () => {
      const bits = sigilBits('ledger-close');
      const { layers } = cells(sigilHTML(bits));
      return eq('layers', layers, lit(bits));
    }),

    test('el del líder es el complemento: las celdas que el glifo deja', () => {
      const bits = sigilBits('audit-01');
      const { layers } = cells(sigilHTML(bits, true));
      return eq('layers', layers, SIGIL_N * SIGIL_N - lit(bits));
    }),

    test('cada celda se pinta DENTRO de la caja, que es donde se ve', () => {
      // La regresión de las sombras exteriores: offsets de −0.4em a 0.4em, con
      // la celda centrada en la caja y recortada por ella. Una posición de
      // fondo va del borde, 0 a 0.8em, y ninguna es negativa.
      const { spots } = cells(sigilHTML(sigilBits('k9')));
      const bad = spots.filter(([x, y]) => !(x >= 0 && x <= 0.8 && y >= 0 && y <= 0.8));
      return ok('inside', spots.length > 0 && bad.length === 0, JSON.stringify(bad));
    }),

    test('y lo hace con fondos, no con sombras, que es lo que no dibujaba nada', () => {
      const html = sigilHTML(sigilBits('k9'));
      return ok('paint', html.includes('background-image:') && !html.includes('box-shadow'), html.slice(0, 120));
    }),

    test('las celdas caen en la rejilla de quintos, sin decimales sueltos', () => {
      const { spots } = cells(sigilHTML(sigilBits('orca')));
      const grid = [0, 0.2, 0.4, 0.6, 0.8];
      const off = spots.filter(([x, y]) => !grid.includes(x) || !grid.includes(y));
      return ok('grid', off.length === 0, JSON.stringify(off));
    }),

    test('un glifo sin ninguna celda no emite estilo, y sigue siendo un nodo', () => {
      // `sigilBits` nunca devuelve el bloque vacío, pero el pintado sí puede
      // recibirlo: el complemento de un glifo lleno lo es.
      const html = sigilHTML(0);
      return ok('empty', html === '<i class="sigil" aria-hidden="true"></i>', html);
    }),

    test('el espejo: la columna 0 y la 4 llevan la misma celda', () => {
      const rows = sigilRows(sigilBits('ledger-close'));
      const mirrored = rows.every((r) => r[0] === r[4] && r[1] === r[3]);
      return ok('mirror', mirrored, rows.join(' '));
    }),

    test('CAPCOM tiene su anillo para él solo: ninguna semilla lo produce', () => {
      const seeds = ['capcom', 'orca', 'k9', 'ledger-close', 'audit-01', 'z1', 'mission_1', ''];
      const clash = seeds.filter((s) => sigilBits(s) === CAPCOM_BITS);
      return ok('ring', clash.length === 0, clash.join(', '));
    }),
  ],
};

export default mod;
