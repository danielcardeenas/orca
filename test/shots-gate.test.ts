/**
 * La puerta de los shots: que exista, que los vea a todos y que un rojo pese.
 *
 * `test/shots.ts` es lo que hacía falta el día que se descubrió que
 * `hud-improve.shots.ts` llevaba semanas fallando con `npm test` en verde:
 * dieciséis pruebas de navegador que no corría nadie porque el runner de la
 * suite sólo descubre `test/*.test.ts`. Lo que se guarda aquí son las tres
 * cosas que harían que la puerta volviera a no servir de nada, y las tres se
 * rompen en silencio:
 *
 *   se descubren    Un shot entra en la puerta por EXISTIR. El día que haya
 *                   que apuntarlo en una lista, el primero que se olvide
 *                   volverá a pudrirse solo.
 *   el filtro       `npm run shots -- hud` escoge; un filtro que no case con
 *   escoge          nada tiene que dar cero y decirlo, no dar los dieciséis.
 *   el rojo pesa    Un shot que falla sale distinto de cero y su aserción se
 *                   nombra en el resumen. Una puerta que cuenta el fallo en la
 *                   línea 300 de un log es otra vez una puerta que nadie mira.
 *
 * No se corre ningún shot desde aquí: levantan hub, Vite, flota y navegador, y
 * eso es `npm run shots`, no `npm test`. Importar el runner tampoco corre nada
 * —su `main()` está tras la guarda del entry— y ese es justo el contrato que
 * esta suite necesita, así que importarlo ya lo comprueba.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ok, eq, test, type TestModule } from './harness.ts';
import { assertionOf, pickShots } from './shots.ts';

const DIR = fileURLToPath(new URL('.', import.meta.url));

export default {
  suite: 'Shots · la puerta',
  tests: [
    test('los descubre por existir, y están todos los del directorio', () => {
      const onDisk = readdirSync(DIR).filter((f) => f.endsWith('.shots.ts')).sort();
      const picked = pickShots(readdirSync(DIR), []);
      return ok('descubrimiento',
        picked.length === onDisk.length && picked.every((f, i) => f === onDisk[i]) && picked.length > 0,
        `${picked.length} de ${onDisk.length} en disco`);
    }),

    test('un filtro escoge por nombre, y uno que no casa no cuela los demás', () => {
      const files = ['hud-improve.shots.ts', 'hud-missions.shots.ts', 'shelf.shots.ts', 'visual.ts', 'run.ts'];
      return ok('filtros',
        pickShots(files, ['hud']).length === 2
        && pickShots(files, ['shelf']).join() === 'shelf.shots.ts'
        && pickShots(files, ['hud', 'shelf']).length === 3
        && pickShots(files, ['no-existe']).length === 0
        // Y nunca cuela lo que no es un shot, con filtro o sin él.
        && !pickShots(files, []).includes('visual.ts'),
        pickShots(files, ['hud']).join(' '));
    }),

    test('el resumen nombra la aserción que falló, no las cuatrocientas líneas', () => {
      const salida = [
        '[visual] starting hub on 51474',
        'node:internal/modules/run_main:123',
        "AssertionError [ERR_ASSERTION]: y las filas entran en el compás (0 filas)",
        '    at main (/repo/test/hud-improve.shots.ts:376:12)',
      ].join('\n');
      return eq('aserción',
        assertionOf(salida),
        'AssertionError [ERR_ASSERTION]: y las filas entran en el compás (0 filas)');
    }),

    test('de una salida sin fallo no se inventa ninguno', () => {
      return eq('verde', assertionOf('AUTOMEJORA: … passed.\n/repo/test/shots/hud-improve.png'), '');
    }),

    test('la puerta está enchufada: npm run shots existe y llama al runner', () => {
      const pkg = JSON.parse(
        readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
      ) as { scripts: Record<string, string> };
      return ok('script', /shots\.ts/.test(pkg.scripts['shots'] ?? ''), pkg.scripts['shots'] ?? 'no está');
    }),
  ],
} satisfies TestModule;
