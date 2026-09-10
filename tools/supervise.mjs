#!/usr/bin/env node
/**
 * Relanza un proceso que pide reiniciarse.
 *
 *   node tools/supervise.mjs -- npx tsx src/orca.ts
 *
 * Existe por un motivo concreto: recargar la consola no actualiza el hub. El
 * hub y el collector cargan su código al arrancar, así que después de publicar
 * queda un proceso viejo hablando con un bundle nuevo, y la única salida era
 * que el operador fuese a la terminal a matarlo y relanzarlo (docs/PRODUCCION.md).
 * Con un supervisor delante, el propio proceso puede pedir el relevo: sale con
 * un código convenido, y aquí se le vuelve a lanzar en la misma terminal, con
 * los mismos logs y el mismo árbol de procesos. La píldora `SERVER CODE
 * CHANGED` deja de ser un cartel y pasa a ser un botón.
 *
 * Lo que NO hace: reiniciar cuando el proceso muere por su cuenta. Un fallo no
 * es una petición de relevo, y un supervisor que relanza lo que se cae solo
 * convierte un error de arranque en un bucle infinito que además esconde el
 * error. Sólo el código 75 (EX_TEMPFAIL, «vuelve a intentarlo») relanza;
 * cualquier otro se propaga tal cual, incluido el Ctrl-C del operador.
 *
 * Y aun con eso, un proceso que pide relevo y se cae al arrancar antes de
 * `MIN_ALIVE_MS` tres veces seguidas para el ciclo: es un árbol roto pidiendo
 * reiniciarse contra un código que no compila, y lo útil es ver el error.
 */

import { spawn } from 'node:child_process';

/**
 * El proceso pide ser relanzado. Los demás códigos son suyos y se respetan.
 *
 * Duplicado desde `src/shared/restart.ts` porque este archivo es JS suelto y
 * no puede importar TypeScript; test/restart.test.ts sostiene las dos copias
 * juntas. Dos números que deben coincidir es como se consigue que un día el
 * hub pida relevo y el supervisor lo entienda como una caída.
 */
const RESTART_CODE = 75;
/** Vivir menos que esto y volver a pedir relevo cuenta como intento fallido. */
const MIN_ALIVE_MS = 5_000;
const MAX_FAST_RESTARTS = 3;

const argv = process.argv.slice(2);
const cut = argv.indexOf('--');
if (cut < 0 || cut === argv.length - 1) {
  process.stderr.write('uso: node tools/supervise.mjs [--name X] -- <comando…>\n');
  process.exit(2);
}
const flags = argv.slice(0, cut);
const cmd = argv.slice(cut + 1);
const nameAt = flags.indexOf('--name');
const name = nameAt >= 0 ? (flags[nameAt + 1] ?? cmd[0]) : cmd[0];

let child = null;
let fast = 0;
let bye = false;

function launch() {
  const startedAt = Date.now();
  child = spawn(cmd[0], cmd.slice(1), {
    stdio: 'inherit',
    // La marca que el proceso lee para saber que aquí hay quien lo relance:
    // sin ella, la consola no ofrece el botón y sigue diciendo «reinicia a mano».
    env: { ...process.env, ORCA_SUPERVISED: '1' },   // SUPERVISED_ENV en shared/restart.ts
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (bye) return;
    if (signal) { process.kill(process.pid, signal); return; }
    if (code !== RESTART_CODE) { process.exit(code ?? 0); return; }

    const alive = Date.now() - startedAt;
    fast = alive < MIN_ALIVE_MS ? fast + 1 : 0;
    if (fast >= MAX_FAST_RESTARTS) {
      process.stderr.write(
        `[supervise] ${name} pidió reiniciarse ${fast} veces sin llegar a vivir ${MIN_ALIVE_MS / 1000}s. `
        + 'Se para aquí: lo que hay que ver es el error de arriba, no otro intento.\n',
      );
      process.exit(1);
    }
    process.stderr.write(`[supervise] ${name} pidió relevo; relanzando\n`);
    launch();
  });

  child.on('error', (err) => {
    process.stderr.write(`[supervise] no se pudo lanzar ${name}: ${String(err)}\n`);
    process.exit(1);
  });
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    bye = true;
    // El hijo tiene su propio apagado limpio; se le deja hacerlo.
    if (child) { try { child.kill(sig); } catch { /* ya se fue */ } }
    else process.exit(0);
  });
}

launch();
