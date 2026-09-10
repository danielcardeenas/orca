/**
 * tools/publish.mjs — construir sin tumbar la consola que se está mirando.
 *
 * Lo que merece guarda: que el barrido y la píldora vean los mismos assets
 * —son la misma idea leída desde los dos lados, y si una deja de ver un
 * archivo la otra borra lo que la otra sirve—, y que lo que se borra sea
 * exactamente lo que ya no puede pedir nadie: ni el build nuevo, ni la
 * pestaña que aún no ha recargado, ni sus sourcemaps.
 */

import { assetsIn, sweepable } from '../tools/publish.mjs';
import { buildFingerprint } from '../src/ui/hud/update.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const INDEX = `<!doctype html><html><head><title>ORCA · Field</title>
    <script type="module" crossorigin src="/assets/index-Bua9IZKS.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-Ba9sScWB.css">
    <link rel="icon" href="/icon.svg" type="image/svg+xml">
    <link rel="manifest" href="/manifest.webmanifest">
  </head><body><div id="app"></div></body></html>`;

const mod: TestModule = {
  suite: 'tools/publish — el build no vacía dist',
  tests: [
    test('assetsIn ve lo mismo que la píldora de la consola', () => {
      const mine = [...assetsIn(INDEX)].map((f: string) => `/assets/${f}`).sort().join('\n');
      return eq('mismo build id', mine, buildFingerprint(INDEX));
    }),

    test('assetsIn: sólo /assets, no los de nombre fijo', () =>
      eq('dos', [...assetsIn(INDEX)].sort().join(' '), 'index-Ba9sScWB.css index-Bua9IZKS.js')),

    test('sweepable: se van las generaciones que ya no puede pedir nadie', () =>
      eq('viejo', sweepable(
        ['index-new.js', 'index-new.js.map', 'index-prev.js', 'index-prev.js.map', 'index-old.js', 'index-old.js.map'],
        ['index-new.js', 'index-prev.js'],
      ).sort().join(' '), 'index-old.js index-old.js.map')),

    test('sweepable: un sourcemap se queda con su archivo', () =>
      ok('mapa', sweepable(['a.js', 'a.js.map'], ['a.js']).length === 0)),

    test('sweepable: sin nada que conservar, se va todo', () =>
      eq('todo', sweepable(['a.js', 'b.css'], []).length, 2)),
  ],
};

export default mod;
