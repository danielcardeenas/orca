/**
 * Las reglas de una superficie de media: cuándo se mira, cuándo se reproduce, y
 * qué pone cuando no hay nada que mirar.
 *
 * Las tres se rompían en silencio en el campo, y las tres se prueban contra
 * números de la cámara de verdad (FOV 30, un lienzo de 900 px de alto,
 * `Z_MIN` 1.4 a `Z_MAX` 420): a los topes del zoom, y en el zoom de trabajo.
 * Un umbral que sólo se prueba con 0 y 1000 no dice nada sobre lo único que
 * importa, que es dónde cae la frontera.
 */

import {
  MEDIA_W, SURFACE_MIN_PX, opaqueLabel, surfaceIsOpaque, surfacePlays, surfaceShows, weight,
} from '../src/ui/field/surface.ts';
import { ok, test, type TestModule } from './harness.ts';

/** Píxeles por unidad de mundo, como los calcula `camera.pxPerUnit`. */
const FOV = 30;
const VIEW_H = 900;
const ppu = (z: number) => VIEW_H / (2 * Math.tan((FOV * Math.PI) / 360) * Math.max(0.05, z));

/** Ancho dibujado de un cuadro de media, en píxeles, desde esta distancia. */
const px = (z: number) => MEDIA_W * ppu(z);

export default {
  suite: 'surface',
  tests: [
    test('en el zoom de trabajo el cuadro se queda, y en el tope se va', () => {
      const trabajo = px(24);
      const tope = px(420);
      const pass = surfaceShows(trabajo) && !surfaceShows(tope);
      return ok('en el zoom de trabajo el cuadro se queda, y en el tope se va', pass,
        `z 24 → ${trabajo.toFixed(0)} px se mira; z 420 → ${tope.toFixed(0)} px se retira`);
    }),

    test('el cuadro sobrevive al zoom en que ya no hay rótulos', () => {
      /*
       * Los rótulos se van a los 44 px de baldosa (TILE_W = 1.0, o sea ppu 44),
       * que son unos 38 de distancia. Una superficie que el operador colocó a
       * mano tiene que seguir ahí cuando las palabras ya se han ido: es su
       * decisión, no una etiqueta.
       */
      const sinRotulos = px(38);
      return ok('el cuadro sobrevive al zoom en que ya no hay rótulos', surfaceShows(sinRotulos),
        `sin rótulos el cuadro son ${sinRotulos.toFixed(0)} px, sobre el umbral de ${SURFACE_MIN_PX}`);
    }),

    test('la frontera está donde dice, ni un píxel antes', () => {
      const pass = surfaceShows(SURFACE_MIN_PX)
        && !surfaceShows(SURFACE_MIN_PX - 1)
        && !surfaceShows(0);
      return ok('la frontera está donde dice, ni un píxel antes', pass,
        `${SURFACE_MIN_PX} px se mira, ${SURFACE_MIN_PX - 1} no`);
    }),

    test('un vídeo fuera de cuadro no decodifica, esté cerca o lejos', () => {
      const cerca = px(7.5);
      const pass = !surfacePlays(false, cerca)
        && !surfacePlays(false, px(420))
        && surfacePlays(true, cerca);
      return ok('un vídeo fuera de cuadro no decodifica, esté cerca o lejos', pass,
        `a ${cerca.toFixed(0)} px: en cuadro reproduce, fuera no`);
    }),

    test('un vídeo demasiado lejos tampoco decodifica aunque esté en cuadro', () => {
      const lejos = px(420);
      return ok('un vídeo demasiado lejos tampoco decodifica aunque esté en cuadro',
        !surfacePlays(true, lejos),
        `${lejos.toFixed(0)} px en cuadro: nada que mirar, nada que decodificar`);
    }),

    test('sólo un archivo opaco es opaco', () => {
      const pass = surfaceIsOpaque('file')
        && !surfaceIsOpaque('image') && !surfaceIsOpaque('video')
        && !surfaceIsOpaque('html') && !surfaceIsOpaque('text');
      return ok('sólo un archivo opaco es opaco', pass, 'file sí; image, video, html y text no');
    }),

    test('un binario dice qué es y cuánto pesa', () => {
      const casos: [string, number, string][] = [
        ['/p/out/build.zip', 4_404_019, 'ZIP · 4.2 MB'],
        ['/p/model.safetensors', 1536, 'SAFETENSORS · 1.5 KB'],
        ['/p/a.bin', 512, 'BIN · 512 B'],
      ];
      for (const [path, bytes, want] of casos) {
        const got = opaqueLabel(path, bytes);
        if (got !== want) return ok('etiqueta', false, `${path} dio "${got}" en vez de "${want}"`);
      }
      return ok('un binario dice qué es y cuánto pesa', true, casos.map((c) => c[2]).join(' · '));
    }),

    test('un archivo sin extensión sigue siendo un archivo', () => {
      const got = opaqueLabel('/p/bin/orca', 2048);
      // Un punto al principio es un archivo oculto, no una extensión.
      const oculto = opaqueLabel('/p/.envrc', 0);
      const pass = got === 'FILE · 2.0 KB' && oculto === 'FILE · 0 B';
      return ok('un archivo sin extensión sigue siendo un archivo', pass, `"${got}" y "${oculto}"`);
    }),

    test('el peso no inventa nada cuando no lo sabe', () => {
      const pass = weight(-1) === '' && weight(Number.NaN) === '' && weight(0) === '0 B';
      return ok('el peso no inventa nada cuando no lo sabe', pass,
        `negativo y NaN dan cadena vacía; cero dice "${weight(0)}"`);
    }),
  ],
} satisfies TestModule;
