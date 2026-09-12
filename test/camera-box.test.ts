/**
 * Ver por la caja, no por la esquina.
 *
 * `camera.project().visible` mira un punto, y una baldosa, una franja de
 * fichas o una superficie colocada con la esquina fuera del lienzo seguían
 * ocupando media pantalla: al acercarse mucho desaparecían justo cuando más
 * grandes eran. `boxOnScreen` responde por la caja entera, y esto mide dónde
 * cae la frontera: una caja que asoma por un borde se ve, una que se fue del
 * todo no, y el margen que cuelga de una baldosa cuenta.
 */

import { FieldCamera } from '../src/ui/field/camera.ts';
import { ok, test, type TestModule } from './harness.ts';

const cam = () => { const c = new FieldCamera(); c.resize(1440, 900); return c; };

export default {
  suite: 'camera-box',
  tests: [
    test('una caja con la esquina fuera del lienzo pero el cuerpo dentro se ve', () => {
      const c = cam();
      // La esquina superior izquierda a −2000, −2000: `project().visible` diría que no.
      const pass = c.boxOnScreen(-2000, -2000, 700, 450) && c.boxOnScreen(-50, -50, 10, 10);
      return ok('una caja con la esquina fuera del lienzo pero el cuerpo dentro se ve', pass);
    }),

    test('una caja que se fue del todo por cualquier borde no se ve', () => {
      const c = cam();
      const pass = !c.boxOnScreen(-300, 100, -10, 200)
        && !c.boxOnScreen(1450, 100, 1800, 200)
        && !c.boxOnScreen(100, -300, 200, -10)
        && !c.boxOnScreen(100, 910, 200, 1200);
      return ok('una caja que se fue del todo por cualquier borde no se ve', pass);
    }),

    test('el margen trae de vuelta lo que cuelga justo fuera del borde', () => {
      const c = cam();
      // Una baldosa cuyo pie está 30 px por encima del lienzo: su franja de
      // fichas cuelga por debajo y todavía asoma; con margen se dibuja.
      const pass = !c.boxOnScreen(100, -300, 400, -30) && c.boxOnScreen(100, -300, 400, -30, 40);
      return ok('el margen trae de vuelta lo que cuelga justo fuera del borde', pass);
    }),

    test('el orden de las esquinas da igual', () => {
      const c = cam();
      const pass = c.boxOnScreen(700, 450, -2000, -2000) === c.boxOnScreen(-2000, -2000, 700, 450);
      return ok('el orden de las esquinas da igual', pass);
    }),
  ],
} satisfies TestModule;
