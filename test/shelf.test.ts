/**
 * La estantería: la geometría de lo que un agente ha hecho, bajo su baldosa.
 *
 * Lo que se comprueba es lo que se rompe en silencio. Una ficha de más, o media
 * unidad más ancha, no lanza ningún error: tapa a la baldosa vecina, que es
 * exactamente lo que este trabajo tenía que no hacer. Así que las pruebas son
 * medidas — la fila cabe en su baldosa, la franja cae debajo y no encima, el
 * alto reservado no depende de cuántos haya — y no comportamientos.
 */

import {
  BADGE_PX, CHIP_MAX, SHELF_H, SHELF_PAD, SHELF_PX, badgeVisible, shelfBadge, shelfChips, shelfHeight, shelfIds, shelfVisible, type ShelfTile,
} from '../src/ui/field/shelf.ts';
import { CELL_SCALE, TILE_H, TILE_W } from '../src/ui/field/layout.ts';
import { TIER_PX } from '../src/ui/field/labels.ts';
import type { Artifact, ArtifactSource } from '../src/shared/types.ts';
import { ok, test, type TestModule } from './harness.ts';

const art = (id: string, agentId: string, source: ArtifactSource, at: number): Artifact =>
  ({ id, agentId, source, at, kind: 'image', path: `/p/${id}.png`, title: id } as unknown as Artifact);

const tile = (extra: Partial<ShelfTile> = {}): ShelfTile =>
  ({ x: 0, y: 0, z: 0, scale: 1, trayOf: null, ...extra });

const ids = (n: number) => Array.from({ length: n }, (_, i) => `art_${i}`);

/** Ancho de la fila, de borde izquierdo de la primera a derecho de la última. */
function rowWidth(chips: { x: number; w: number }[]): number {
  const l = Math.min(...chips.map((c) => c.x - c.w / 2));
  const r = Math.max(...chips.map((c) => c.x + c.w / 2));
  return r - l;
}

export default {
  suite: 'shelf',
  tests: [
    test('un agente que no ha hecho nada no reserva nada', () => {
      const h = shelfHeight(0, tile());
      const chips = shelfChips([], tile());
      return ok('un agente que no ha hecho nada no reserva nada', h === 0 && chips.length === 0,
        `alto ${h}, ${chips.length} fichas`);
    }),

    test('cuarenta imágenes son cuatro fichas y un contador de 36', () => {
      const chips = shelfChips(ids(40), tile());
      const last = chips.at(-1)!;
      const reales = chips.filter((c) => c.id !== null);
      const pass = chips.length === CHIP_MAX + 1
        && reales.length === CHIP_MAX
        && last.id === null && last.more === 36
        && reales.every((c) => c.more === 0);
      return ok('cuarenta imágenes son cuatro fichas y un contador de 36', pass,
        `${chips.length} plazas: ${reales.length} fichas y el contador dice +${last.more}`);
    }),

    test('cuatro artefactos o menos no gastan la plaza del contador', () => {
      for (const n of [1, 2, 3, 4]) {
        const chips = shelfChips(ids(n), tile());
        if (chips.length !== n || chips.some((c) => c.id === null)) {
          return ok('contador', false, `${n} artefactos dieron ${chips.length} plazas`);
        }
      }
      // El quinto es el que estrena el contador, y dice que queda uno.
      const cinco = shelfChips(ids(5), tile());
      const pass = cinco.length === CHIP_MAX + 1 && cinco.at(-1)!.more === 1;
      return ok('cuatro artefactos o menos no gastan la plaza del contador', pass,
        `5 artefactos: ${cinco.length} plazas, el contador dice +${cinco.at(-1)!.more}`);
    }),

    test('las más nuevas primero, en el orden en que llegan', () => {
      const chips = shelfChips(['a', 'b', 'c', 'd', 'e', 'f'], tile());
      const orden = chips.filter((c) => c.id).map((c) => c.id).join('');
      return ok('las más nuevas primero, en el orden en que llegan', orden === 'abcd',
        `la fila dice ${orden}`);
    }),

    test('la fila entera cabe en su baldosa, llena o a medias', () => {
      for (const n of [1, 2, 4, 5, 40]) {
        const chips = shelfChips(ids(n), tile());
        const w = rowWidth(chips);
        if (w > TILE_W + 1e-9) return ok('cabe', false, `${n} artefactos miden ${w.toFixed(3)} sobre TILE_W ${TILE_W}`);
      }
      const lleno = rowWidth(shelfChips(ids(40), tile()));
      return ok('la fila entera cabe en su baldosa, llena o a medias', true,
        `la fila llena mide ${lleno.toFixed(3)} de las ${TILE_W} de la baldosa`);
    }),

    test('la fila está centrada bajo la baldosa y no la pisa', () => {
      const t = tile({ x: 7, y: -3 });
      const chips = shelfChips(ids(40), t);
      const cx = (Math.min(...chips.map((c) => c.x - c.w / 2)) + Math.max(...chips.map((c) => c.x + c.w / 2))) / 2;
      const alto = Math.max(...chips.map((c) => c.y + c.h / 2));
      const bordeBajo = t.y - TILE_H / 2;
      const pass = Math.abs(cx - t.x) < 1e-9 && alto <= bordeBajo + 1e-9;
      return ok('la fila está centrada bajo la baldosa y no la pisa', pass,
        `centro ${cx.toFixed(3)} contra ${t.x}; techo de la franja ${alto.toFixed(3)} bajo el borde ${bordeBajo.toFixed(3)}`);
    }),

    test('con dos fichas la fila sigue centrada, sin hueco a la derecha', () => {
      const t = tile({ x: 4 });
      const chips = shelfChips(ids(2), t);
      const cx = (chips[0]!.x + chips[1]!.x) / 2;
      return ok('con dos fichas la fila sigue centrada, sin hueco a la derecha', Math.abs(cx - t.x) < 1e-9,
        `centro ${cx.toFixed(3)} contra ${t.x}`);
    }),

    test('las fichas no se solapan entre ellas', () => {
      const chips = shelfChips(ids(40), tile());
      for (let i = 1; i < chips.length; i++) {
        const izq = chips[i - 1]!, der = chips[i]!;
        if (der.x - der.w / 2 < izq.x + izq.w / 2 - 1e-9) {
          return ok('solape', false, `la ficha ${i} empieza antes de que acabe la ${i - 1}`);
        }
      }
      return ok('las fichas no se solapan entre ellas', true, `${chips.length} plazas con aire entre todas`);
    }),

    test('el alto reservado no depende de cuántos artefactos haya', () => {
      const alturas = [1, 2, 5, 40, 200].map((n) => shelfHeight(n, tile()));
      const iguales = alturas.every((h) => Math.abs(h - SHELF_H) < 1e-9);
      return ok('el alto reservado no depende de cuántos artefactos haya', iguales,
        `1 y 200 artefactos reservan ${alturas[0]!.toFixed(3)} y ${alturas.at(-1)!.toFixed(3)}`);
    }),

    test('el alto reservado sigue a la escala de la baldosa', () => {
      const capcom = shelfHeight(3, tile({ scale: 1.4 }));
      const pass = Math.abs(capcom - SHELF_H * 1.4) < 1e-9;
      return ok('el alto reservado sigue a la escala de la baldosa', pass,
        `CAPCOM reserva ${capcom.toFixed(3)} contra ${SHELF_H.toFixed(3)} de una baldosa`);
    }),

    test('una celda de bandeja no tiene estantería', () => {
      const celda = tile({ scale: CELL_SCALE, trayOf: 'padre' });
      const pass = shelfHeight(9, celda) === 0 && shelfChips(ids(9), celda).length === 0;
      return ok('una celda de bandeja no tiene estantería', pass,
        `una celda a escala ${CELL_SCALE} con 9 artefactos no reserva ni dibuja nada`);
    }),

    test('la baldosa cuelga lo que su agente declaró, y sólo eso', () => {
      /*
       * La decisión del miembro 1: declarar manda. Un agente que genera cuarenta
       * png no tiene cuarenta resultados, y lo observado —que apareció sin que
       * nadie lo eligiera, con un nombre de archivo por título— espera en la
       * galería. Ésta es la prueba de que el campo no se llena de eso.
       */
      const mundo = [
        art('d2', 'a1', 'declared', 200),
        art('o1', 'a1', 'observed', 900),
        art('d1', 'a1', 'declared', 100),
        art('ajeno', 'a2', 'declared', 999),
      ];
      const suyos = shelfIds(mundo, 'a1');
      // Lo más nuevo primero, y el observado de las 900 no está aunque sea el más nuevo.
      const pass = suyos.join(',') === 'd2,d1';
      return ok('la baldosa cuelga lo que su agente declaró, y sólo eso', pass,
        `de 4 artefactos del mundo la estantería de a1 cuelga [${suyos.join(', ')}]`);
    }),

    test('cuarenta observados no ponen nada en el campo', () => {
      const mundo = Array.from({ length: 40 }, (_, i) => art(`o${i}`, 'a1', 'observed', i));
      const suyos = shelfIds(mundo, 'a1');
      const pass = suyos.length === 0 && shelfHeight(suyos.length, tile()) === 0;
      return ok('cuarenta observados no ponen nada en el campo', pass,
        `40 observados dan ${suyos.length} fichas y reservan ${shelfHeight(suyos.length, tile())}`);
    }),

    test('dos artefactos del mismo instante no cambian de orden entre dibujos', () => {
      // Empate en `at`: el id rompe la igualdad, o la fila baila sola entre frames.
      const mundo = [art('b', 'a1', 'declared', 5), art('a', 'a1', 'declared', 5)];
      const uno = shelfIds(mundo, 'a1').join(',');
      const otro = shelfIds([...mundo].reverse(), 'a1').join(',');
      return ok('dos artefactos del mismo instante no cambian de orden entre dibujos',
        uno === otro && uno === 'a,b', `${uno} y ${otro}`);
    }),

    test('de lejos la estantería desaparece, y lo hace en un peldaño de los rótulos', () => {
      const enLaEscalera = (TIER_PX as readonly number[]).includes(SHELF_PX);
      const pass = enLaEscalera
        && !shelfVisible(TIER_PX[0]!)
        && !shelfVisible(TIER_PX[1]!)
        && shelfVisible(SHELF_PX)
        && shelfVisible(TIER_PX[4]!);
      return ok('de lejos la estantería desaparece, y lo hace en un peldaño de los rótulos', pass,
        `umbral ${SHELF_PX} px, un peldaño de [${TIER_PX.join(', ')}]`);
    }),

    test('la escalera: tarjeta entre el primer rótulo y la fila, nada de las dos por debajo', () => {
      /*
       * Tres peldaños y sin huecos ni solapes: por debajo de 44 px sólo la
       * marca del shader; de 44 a 190 la tarjeta; de 190 en adelante la fila.
       * Un zoom en que hubiera tarjeta Y fila dibujaría dos veces lo mismo, y
       * uno sin ninguna de las dos dejaría al operador sin saber que hay algo.
       */
      const pass = BADGE_PX === TIER_PX[0]
        && !badgeVisible(BADGE_PX - 1) && !shelfVisible(BADGE_PX - 1)
        && badgeVisible(BADGE_PX) && !shelfVisible(BADGE_PX)
        && badgeVisible(SHELF_PX - 1) && !shelfVisible(SHELF_PX - 1)
        && !badgeVisible(SHELF_PX) && shelfVisible(SHELF_PX);
      return ok('la escalera: tarjeta entre el primer rótulo y la fila, nada de las dos por debajo', pass,
        `tarjeta de ${BADGE_PX} a ${SHELF_PX - 1} px, fila desde ${SHELF_PX}`);
    }),

    test('la tarjeta enseña el más nuevo, cuenta todos y cuelga del borde izquierdo, en la franja', () => {
      const t = tile({ x: 3, y: -1 });
      const b = shelfBadge(['nuevo', 'b', 'c', 'd', 'e', 'f'], t)!;
      const izquierda = t.x - TILE_W / 2;
      const techo = b.y + b.h / 2;
      const pass = !!b && b.id === 'nuevo' && b.count === 6
        && Math.abs((b.x - b.w / 2) - izquierda) < 1e-9
        && techo <= t.y - TILE_H / 2 - SHELF_PAD + 1e-9
        && b.y - b.h / 2 >= t.y - TILE_H / 2 - SHELF_H - 1e-9;
      return ok('la tarjeta enseña el más nuevo, cuenta todos y cuelga del borde izquierdo, en la franja', pass,
        `enseña ${b.id}, cuenta ${b.count}, borde izquierdo en ${(b.x - b.w / 2).toFixed(3)} contra ${izquierda.toFixed(3)}, techo ${techo.toFixed(3)}`);
    }),

    test('sin outputs, o en una celda de bandeja, no hay tarjeta', () => {
      const pass = shelfBadge([], tile()) === null
        && shelfBadge(['a'], tile({ scale: CELL_SCALE, trayOf: 'padre' })) === null;
      return ok('sin outputs, o en una celda de bandeja, no hay tarjeta', pass);
    }),
  ],
} satisfies TestModule;
