/**
 * El tirante: la línea de un output del canvas hasta quien lo hizo.
 *
 * Lo que se prueba es lo que se equivoca en silencio. Un tirante que entra
 * por dentro de la baldosa no lanza nada: parece que sale de otro sitio. Uno
 * que cruza la superficie que dice unir tampoco: dibuja una raya sobre la
 * imagen. Así que las pruebas son medidas — el hilo mide el aire de la
 * estantería, el camino es ortogonal y no pisa ninguna de las dos cajas, N
 * superficies de un agente acaban en el mismo punto — y no comportamientos.
 */

import {
  SIDE_DROP, chipStem, originPortScale, tetherHot, tetherRoute, tetherWeight, type Rect,
} from '../src/ui/field/tether.ts';
import { SHELF_PAD, shelfChips, type ShelfTile } from '../src/ui/field/shelf.ts';
import { MEDIA_W } from '../src/ui/field/surface.ts';
import { TILE_H, TILE_W } from '../src/ui/field/layout.ts';
import type { Pt } from '../src/ui/field/pipes.ts';
import { ok, test, type TestModule } from './harness.ts';

const tile = (extra: Partial<ShelfTile> = {}): ShelfTile =>
  ({ x: 0, y: 0, z: 0, scale: 1, trayOf: null, ...extra });
const tileRect = (t: ShelfTile): Rect => ({ x: t.x, y: t.y, w: TILE_W * t.scale, h: TILE_H * t.scale });
/** Una superficie de media, como la coloca `placeNear`: 2,4 de ancho y 0,62 de proporción. */
const surface = (x: number, y: number): Rect => ({ x, y, w: MEDIA_W, h: MEDIA_W * 0.62 });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `art_${i}`);

/** ¿Está el punto estrictamente dentro de la caja? En el borde no cuenta. */
function inside(p: Pt, r: Rect): boolean {
  return Math.abs(p.x - r.x) < r.w / 2 - 1e-9 && Math.abs(p.y - r.y) < r.h / 2 - 1e-9;
}
/** ¿Toca el punto el borde de la caja? */
function onEdge(p: Pt, r: Rect): boolean {
  const onX = Math.abs(Math.abs(p.x - r.x) - r.w / 2) < 1e-9 && Math.abs(p.y - r.y) <= r.h / 2 + 1e-9;
  const onY = Math.abs(Math.abs(p.y - r.y) - r.h / 2) < 1e-9 && Math.abs(p.x - r.x) <= r.w / 2 + 1e-9;
  return onX || onY;
}
/** ¿Cambia cada tramo una sola coordenada? */
function orthogonal(pts: Pt[]): boolean {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    if (Math.abs(a.x - b.x) > 1e-9 && Math.abs(a.y - b.y) > 1e-9) return false;
  }
  return true;
}

export default {
  suite: 'tether',
  tests: [
    test('el hilo de una ficha mide justo el aire de la estantería', () => {
      const t = tile({ x: 3, y: -2 });
      const chips = shelfChips(ids(4), t);
      const stem = chipStem(chips[1]!, t);
      const len = Math.hypot(stem[1]!.x - stem[0]!.x, stem[1]!.y - stem[0]!.y);
      const vertical = Math.abs(stem[0]!.x - stem[1]!.x) < 1e-9;
      return ok('el hilo de una ficha mide justo el aire de la estantería', vertical && Math.abs(len - SHELF_PAD) < 1e-9,
        `mide ${len.toFixed(3)} contra SHELF_PAD ${SHELF_PAD}, ${vertical ? 'vertical' : 'torcido'}`);
    }),

    test('el hilo va del techo de la ficha al borde bajo de la baldosa, sin entrar en ninguna', () => {
      const t = tile({ x: 1, y: 5 });
      const chips = shelfChips(ids(40), t);
      for (const c of chips) {
        const [a, b] = chipStem(c, t) as [Pt, Pt];
        const chipRect: Rect = { x: c.x, y: c.y, w: c.w, h: c.h };
        if (Math.abs(a.y - (c.y + c.h / 2)) > 1e-9) return ok('techo', false, `el hilo no sale del techo de la ficha: ${a.y}`);
        if (Math.abs(b.y - (t.y - TILE_H / 2)) > 1e-9) return ok('borde', false, `el hilo no llega al borde de la baldosa: ${b.y}`);
        if (inside(a, tileRect(t)) || inside(b, chipRect)) return ok('dentro', false, 'un hilo entra en una caja');
      }
      return ok('el hilo va del techo de la ficha al borde bajo de la baldosa, sin entrar en ninguna', true,
        `${chips.length} hilos, uno por plaza, contador incluido`);
    }),

    test('el hilo sigue a la escala de la baldosa', () => {
      const capcom = tile({ scale: 1.4 });
      const c = shelfChips(ids(1), capcom)[0]!;
      const [a, b] = chipStem(c, capcom) as [Pt, Pt];
      const len = Math.abs(b.y - a.y);
      return ok('el hilo sigue a la escala de la baldosa', Math.abs(len - SHELF_PAD * 1.4) < 1e-9,
        `en CAPCOM mide ${len.toFixed(3)} contra ${(SHELF_PAD * 1.4).toFixed(3)}`);
    }),

    test('una superficie al lado de su baldosa va en un tramo, de borde a borde', () => {
      // Donde `placeNear` deja la primera: dos unidades a la derecha, misma fila.
      const t = tile();
      const s = surface(t.x + 2.0, t.y - TILE_H * SIDE_DROP);
      const pts = tetherRoute(s, tileRect(t));
      const a = pts[0]!, b = pts[pts.length - 1]!;
      const pass = pts.length === 2
        && Math.abs(a.x - (s.x - s.w / 2)) < 1e-9
        && Math.abs(b.x - (t.x + TILE_W / 2)) < 1e-9;
      return ok('una superficie al lado de su baldosa va en un tramo, de borde a borde', pass,
        `${pts.length} puntos: sale por x=${a.x.toFixed(2)} y entra por x=${b.x.toFixed(2)}`);
    }),

    test('una superficie debajo de su baldosa sube en vertical, de techo a suelo', () => {
      const t = tile();
      const s = surface(t.x, t.y - 3);
      const pts = tetherRoute(s, tileRect(t));
      const a = pts[0]!, b = pts[pts.length - 1]!;
      const pass = pts.length === 2
        && Math.abs(a.y - (s.y + s.h / 2)) < 1e-9
        && Math.abs(b.y - (t.y - TILE_H / 2)) < 1e-9
        && Math.abs(a.x - b.x) < 1e-9;
      return ok('una superficie debajo de su baldosa sube en vertical, de techo a suelo', pass,
        `${pts.length} puntos de y=${a.y.toFixed(2)} a y=${b.y.toFixed(2)}`);
    }),

    test('en diagonal el camino es ortogonal, con el codo a media distancia y sin pisar caja', () => {
      const t = tile({ x: -4, y: 3 });
      const casos = [surface(1, -2), surface(-9, -1), surface(2, 6), surface(-4.3, 9)];
      for (const s of casos) {
        const pts = tetherRoute(s, tileRect(t));
        if (!orthogonal(pts)) return ok('ortogonal', false, `un tramo va en diagonal desde ${s.x},${s.y}`);
        if (!onEdge(pts[0]!, s)) return ok('sale', false, `no sale por el borde de la superficie en ${s.x},${s.y}`);
        if (!onEdge(pts[pts.length - 1]!, tileRect(t))) return ok('entra', false, `no entra por el borde de la baldosa desde ${s.x},${s.y}`);
        for (const p of pts) {
          if (inside(p, s) || inside(p, tileRect(t))) return ok('pisa', false, `un punto del camino cae dentro de una caja desde ${s.x},${s.y}`);
        }
      }
      return ok('en diagonal el camino es ortogonal, con el codo a media distancia y sin pisar caja', true,
        `${casos.length} colocaciones alrededor de la baldosa, todas de borde a borde`);
    }),

    test('por el lado entra bajo la línea media, lejos del puerto de mensajes y dentro del borde', () => {
      const t = tile({ x: 2, y: 2 });
      const s = surface(t.x + 4, t.y + 0.9);
      const b = tetherRoute(s, tileRect(t)).at(-1)!;
      const drop = t.y - b.y;
      const pass = Math.abs(drop - TILE_H * SIDE_DROP) < 1e-9 && drop > 0 && drop < TILE_H / 2;
      // `routeMessage` entra a +0.12·TILE_H: dos puertas, dos alturas.
      return ok('por el lado entra bajo la línea media, lejos del puerto de mensajes y dentro del borde', pass,
        `entra ${drop.toFixed(3)} bajo el centro; el puerto de mensajes está ${(TILE_H * 0.12).toFixed(3)} por encima`);
    }),

    test('tres superficies de un agente acaban en el mismo punto: un haz, no tres líneas', () => {
      const t = tile();
      const finales = [surface(2.0, 0), surface(4.7, 0), surface(2.0, -2.0)]
        .map((s) => tetherRoute(s, tileRect(t)).at(-1)!);
      // Las dos de la derecha entran por el mismo lado y al mismo punto.
      const mismo = Math.abs(finales[0]!.x - finales[1]!.x) < 1e-9 && Math.abs(finales[0]!.y - finales[1]!.y) < 1e-9;
      return ok('tres superficies de un agente acaban en el mismo punto: un haz, no tres líneas', mismo,
        `las dos de la derecha entran por (${finales[0]!.x.toFixed(2)}, ${finales[0]!.y.toFixed(2)}) y (${finales[1]!.x.toFixed(2)}, ${finales[1]!.y.toFixed(2)})`);
    }),

    test('el tirante a una escuadra acaba en su puerto, que es un punto', () => {
      const port: Rect = { x: -3, y: 4, w: 0, h: 0 };
      const pts = tetherRoute(surface(2, 1), port);
      const b = pts.at(-1)!;
      const pass = orthogonal(pts) && Math.abs(b.x - port.x) < 1e-9 && Math.abs(b.y - port.y) < 1e-9;
      return ok('el tirante a una escuadra acaba en su puerto, que es un punto', pass,
        `acaba en (${b.x}, ${b.y}) contra el puerto (${port.x}, ${port.y})`);
    }),

    test('caliente con el puntero en el output o en su origen, y sólo entonces', () => {
      const a = { id: 'art_1' };
      const calientes = new Set(['agente_1']);
      const casos = [
        tetherHot(a, 'agente_1', null, new Set()) === false,
        tetherHot(a, 'agente_1', 'art_1', new Set()) === true,
        tetherHot(a, 'agente_1', 'art_2', new Set()) === false,
        tetherHot(a, 'agente_1', null, calientes) === true,
        tetherHot(a, 'agente_2', null, calientes) === false,
        // Sin origen en el campo, sólo el hover sobre el propio output lo enciende.
        tetherHot(a, null, null, calientes) === false,
        tetherHot(a, null, 'art_1', calientes) === true,
      ];
      return ok('caliente con el puntero en el output o en su origen, y sólo entonces', casos.every(Boolean),
        `${casos.filter(Boolean).length} de ${casos.length} casos`);
    }),

    test('caliente pesa más que en reposo, y en reposo menos que un bus de linaje', () => {
      const pass = tetherWeight(true) > tetherWeight(false)
        && tetherWeight(false) < 1
        && originPortScale(true) > originPortScale(false);
      return ok('caliente pesa más que en reposo, y en reposo menos que un bus de linaje', pass,
        `grosor ${tetherWeight(false)} → ${tetherWeight(true)}, puerto ${originPortScale(false)} → ${originPortScale(true)}`);
    }),
  ],
} satisfies TestModule;
