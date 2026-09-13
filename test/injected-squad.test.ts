/**
 * La escuadra que inyecta el arnés: marcada, y en su propia isla.
 *
 * Por qué esto merece una suite y no sólo una línea.
 *
 * `injectSquad` (`test/visual.ts`) no es decorado: abre un socket de collector
 * contra el hub, declara una máquina y le cuelga una escalación **`blocking`**
 * inventada —«The February adjustment has no counter-entry. Write one off, or
 * hold the close?»—. La marca de sintética es lo único que mantiene esa
 * pregunta del lado de mentira de la cuarentena, y la pone quien se presenta,
 * nunca el hub (`src/shared/synthetic.ts`). Sin ella, el arnés puede mandarle
 * a un CAPCOM de verdad preguntas que nadie hizo: es exactamente el accidente
 * que cuenta la cabecera de ese fichero —nueve minutos de preguntas falsas y
 * el contexto del mando por delante— y del que esta escuadra era la última
 * pieza del arnés capaz de repetirlo.
 *
 * `isFixtureMachineId` no la salva: sólo reconoce las máquinas del preset del
 * mock. Y es un campo de un objeto literal, de los que se caen en un refactor
 * sin que nada se ponga rojo — el síntoma aparecería lejos de aquí y con otra
 * cara, en forma de mando contestando lo que no existe.
 *
 * La segunda mitad es la otra cara de la misma decisión: el recinto donde cae
 * una máquina del arnés sale de su `harnessOf`, así que compartir el del mock
 * la metería dentro de la rejilla que se recompone en cada nacimiento y le
 * quitaría lo único por lo que sirve —ser un sujeto quieto mientras todo lo
 * demás se mueve—. Aquí se afirma sobre la función de reparto de islas, que es
 * donde se decide; en la pantalla lo comprueba `shelf-routes.shots.ts`.
 *
 * Sin red y sin navegador: `squadMachine()` es la misma máquina que sale por
 * el cable, y `main()` de `visual.ts` no corre por importarlo.
 */

import { ok, test, type TestModule } from './harness.ts';
import { squadMachine } from './visual.ts';
import { HARNESS_HOME } from './fake-collector.ts';
import { harnessHome, isSynthetic } from '../src/shared/synthetic.ts';
import { islandIn } from '../src/ui/field/layout.ts';

/** Cómo ve la consola a las dos: el mapa que le pasa a `islandIn`. */
const MOCK_MACHINE = 'fake-mac-1';

function harnessMap(): Map<string, string> {
  const squad = squadMachine();
  return new Map([
    [squad.id, harnessHome(squad) ?? ''],
    [MOCK_MACHINE, HARNESS_HOME],
  ]);
}

export default {
  suite: 'La escuadra inyectada · marca y recinto',
  tests: [
    test('se declara sintética: su pregunta inventada no puede llegar a un mando de verdad', () => {
      const m = squadMachine();
      return ok('la marca', isSynthetic(m), `synthetic=${String(m.synthetic)} · ${m.id}`);
    }),

    test('y dice de qué arnés viene, que no es el del mock', () => {
      const home = harnessHome(squadMachine());
      return ok('arnés propio',
        typeof home === 'string' && home.length > 0 && home !== HARNESS_HOME,
        `escuadra "${home}" · mock "${HARNESS_HOME}"`);
    }),

    test('así cae en su isla y no dentro de la rejilla que se mueve', () => {
      const harness = harnessMap();
      const squad = squadMachine();
      const suya = islandIn(harness, { machineId: squad.id, projectId: 'p_vsquad' });
      const delMock = islandIn(harness, { machineId: MOCK_MACHINE, projectId: 'p_cualquiera' });
      // Recinto del arnés las dos —lo son—, pero no el mismo: el número de
      // columnas del recinto del mock es función de una población que crece,
      // y el de la escuadra son siete fichas que no se mueven nunca.
      return ok('islas distintas',
        suya !== delMock && suya.startsWith('~harness/') && delMock.startsWith('~harness/'),
        `${suya} · ${delMock}`);
    }),

    test('una máquina sin la marca no hereda el recinto por parecerse', () => {
      // La otra mitad de la regla, la que impide que esto sea una puerta: la
      // marca sólo QUITA permisos, así que `harnessOf` en una máquina que no
      // se declaró fixture no vale nada. Si esto dejara de ser cierto,
      // cualquiera podría colgarse de la isla de un proyecto ajeno.
      const impostora = { ...squadMachine(), synthetic: false };
      return ok('sin marca, sin recinto', harnessHome(impostora) === null,
        `harnessOf=${String(impostora.harnessOf)} → ${String(harnessHome(impostora))}`);
    }),
  ],
} satisfies TestModule;
