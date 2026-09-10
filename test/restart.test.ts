/**
 * El relevo de un proceso: `shared/restart.ts` + `tools/supervise.mjs`.
 *
 * Lo que merece guarda es la diferencia entre «relánzame» y «me he caído».
 * Un supervisor que confunde las dos convierte un error de arranque en un
 * bucle infinito que además esconde el error, y uno que no distingue el Ctrl-C
 * del operador de una petición de relevo no se deja apagar. Y el freno: tres
 * relevos que no llegan a vivir es un árbol roto pidiendo reiniciarse contra
 * código que no compila.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RESTART_EXIT_CODE, SUPERVISED_ENV, isSupervised } from '../src/shared/restart.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const SUPERVISE = fileURLToPath(new URL('../tools/supervise.mjs', import.meta.url));

/**
 * Corre el supervisor sobre un hijo que cuenta sus propios arranques en un
 * archivo y sale con el código que le toque según la vuelta.
 *
 * `codes` es lo que devuelve en cada arranque; agotada la lista, repite el
 * último. Devuelve cuántas veces arrancó el hijo y con qué salió el supervisor.
 */
function supervised(codes: number[], extra: string[] = []): Promise<{ runs: number; code: number | null; env: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-sup-'));
  const counter = join(dir, 'runs');
  const envFile = join(dir, 'env');
  const child = [
    'node', '-e',
    `const fs=require('fs');`
    + `const n=(()=>{try{return fs.readFileSync(${JSON.stringify(counter)},'utf8').length}catch{return 0}})();`
    + `fs.appendFileSync(${JSON.stringify(counter)},'x');`
    + `fs.appendFileSync(${JSON.stringify(envFile)},(process.env['${SUPERVISED_ENV}']??'-')+'\\n');`
    + `const codes=${JSON.stringify(codes)};`
    + `process.exit(codes[Math.min(n,codes.length-1)]);`,
  ];
  return new Promise((done) => {
    const sup = spawn(process.execPath, [SUPERVISE, ...extra, '--', ...child], { stdio: 'ignore' });
    sup.on('exit', (code) => {
      let runs = 0;
      let env: string[] = [];
      try { runs = readFileSync(counter, 'utf8').length; } catch { /* nunca arrancó */ }
      try { env = readFileSync(envFile, 'utf8').trim().split('\n'); } catch { /* idem */ }
      rmSync(dir, { recursive: true, force: true });
      done({ runs, code, env });
    });
  });
}

/**
 * Corre `exitForRestart()` en un proceso de verdad cuyo bucle de eventos está
 * vacío —lo que le pasa a quien acaba de cerrar sus sockets y sus timers— y
 * devuelve con qué salió.
 */
function exitCodeWithEmptyLoop(): Promise<number | null> {
  const restart = fileURLToPath(new URL('../src/shared/restart.ts', import.meta.url));
  const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
  const src = `import { exitForRestart } from ${JSON.stringify(restart)}; exitForRestart(50);`;
  return new Promise((done) => {
    const child = spawn(tsx, ['--eval', src], { stdio: 'ignore' });
    child.on('exit', (code) => done(code));
    child.on('error', () => done(null));
  });
}

const mod: TestModule = {
  suite: 'relevo — el proceso pide volver a arrancar',
  tests: [
    test('el supervisor y el contrato dicen el mismo número', () => {
      // `tools/supervise.mjs` es JS suelto y no puede importar el contrato, así
      // que duplica el código de salida. Dos copias de un número es como se
      // consigue que un día el hub pida relevo y nadie lo relance.
      const src = readFileSync(SUPERVISE, 'utf8');
      const m = /const RESTART_CODE = (\d+);/.exec(src);
      return eq('un solo código, escrito dos veces', Number(m?.[1]), RESTART_EXIT_CODE);
    }),

    test('isSupervised: sólo la marca exacta cuenta', () => {
      const si = isSupervised({ [SUPERVISED_ENV]: '1' });
      const no = isSupervised({});
      const cero = isSupervised({ [SUPERVISED_ENV]: '0' });
      const raro = isSupervised({ [SUPERVISED_ENV]: 'true' });
      return ok('sólo "1"', si && !no && !cero && !raro, `1=${si} vacío=${no} 0=${cero} true=${raro}`);
    }),

    test('un hijo que pide relevo vuelve a arrancar; el que termina, no', async () => {
      const r = await supervised([RESTART_EXIT_CODE, 0]);
      return ok('dos arranques y salida limpia', r.runs === 2 && r.code === 0, `runs=${r.runs} code=${r.code}`);
    }),

    test('una caída no es una petición de relevo: se propaga tal cual', async () => {
      const r = await supervised([1]);
      return ok('un arranque, código suyo', r.runs === 1 && r.code === 1, `runs=${r.runs} code=${r.code}`);
    }),

    test('el hijo sabe que hay quien lo relance', async () => {
      const r = await supervised([0]);
      return eq('marca puesta', r.env.join(), '1');
    }),

    /*
     * La regresión del 2026-09-09, y por qué se prueba lanzando un proceso.
     *
     * El collector pedía el relevo con un temporizador `unref`'d justo después
     * de cerrar lo suyo. Con el bucle de eventos ya vacío, Node no espera a un
     * temporizador así: salía con 0, el supervisor leía «terminó bien» y no lo
     * relanzaba. El hub volvía, el collector no, y la consola se recargaba
     * sobre un mundo sin nadie que lo llenara. Nada de eso se ve leyendo el
     * código ni llamando a la función: sólo se ve en el código de salida de un
     * proceso que se queda sin nada que hacer.
     */
    test('pedir el relevo con el bucle vacío sale con el código de relevo, no con 0', async () => {
      const code = await exitCodeWithEmptyLoop();
      return eq('75, no 0', code, RESTART_EXIT_CODE);
    }),

    test('pedir relevo sin llegar a vivir para el ciclo en vez de repetirlo para siempre', async () => {
      const r = await supervised([RESTART_EXIT_CODE]);
      return ok('freno', r.runs === 3 && r.code === 1, `runs=${r.runs} code=${r.code}`);
    }),
  ],
};

export default mod;
