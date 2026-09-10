/**
 * Publicar la consola cuando el trabajo sobre ORCA termina.
 *
 * El ciclo de producción tiene dos mitades (docs/PRODUCCION.md): `npm run
 * publish` produce un build nuevo, y la píldora de la consola lo ofrece al
 * operador, que decide cuándo aplicarlo con un clic. La segunda mitad ya
 * funcionaba sola; la primera exigía que alguien se acordara de teclearlo, y
 * un paso manual entre «el agente terminó» y «el operador puede verlo» es un
 * paso que no se da: el trabajo se queda en el disco, terminado y sin llegar.
 *
 * Esto cierra ese hueco. Cuando un agente que trabajaba SOBRE EL REPO DE ORCA
 * termina —o cuando su rama aterriza— se publica, y a partir de ahí manda la
 * doctrina de siempre: nadie recarga nada, se enciende la píldora, y el clic
 * es del operador. Automático hasta la oferta; nunca más allá.
 *
 * ── Las tres cosas que hacen que esto no moleste ───────────────────
 *
 * **Sólo el repo propio.** ORCA gobierna muchos proyectos y publicar sólo
 * tiene sentido para el suyo. La comparación es de rutas resueltas contra el
 * árbol desde el que corre este mismo proceso, no por el nombre del proyecto.
 *
 * **Se espera y se agrupa.** Un escuadrón termina en racimo. La primera
 * petición abre una ventana; lo que llegue dentro viaja con ella. Y nunca hay
 * dos builds a la vez: si algo pide publicar mientras se publica, se apunta y
 * se hace una sola vez al acabar, porque construir dos veces a la vez sobre
 * el mismo `dist/` es exactamente la carrera que `emptyOutDir: false` evita.
 *
 * **Un fallo no se repite.** El árbol es compartido y está sucio a propósito:
 * el typecheck se pone rojo a menudo y por trabajo de otro. Cuando falla no se
 * toca nada —la consola en pie sigue con su build bueno, que es justo lo que
 * `tools/publish.mjs` garantiza al no vaciar `dist/`— y se avisa a CAPCOM. Al
 * operador no se le interrumpe: sólo ve la píldora cuando hay algo que de
 * verdad se puede aplicar. Y el mismo error no se cuenta dos veces: avisar en
 * cada intento del mismo fallo convierte el aviso en ruido y el ruido en
 * silencio.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** La raíz del árbol desde el que corre este hub: el repo de ORCA. */
export const REPO_ROOT: string = fileURLToPath(new URL('../..', import.meta.url));

/** Cuánto se espera para agrupar fines que llegan en racimo. */
export const PUBLISH_DEBOUNCE_MS = 30_000;
/** Un build que no termina en cinco minutos no va a terminar. */
export const PUBLISH_TIMEOUT_MS = 300_000;

/**
 * ¿Es este proyecto el repo desde el que corre ORCA?
 *
 * Por ruta resuelta, no por nombre: un proyecto puede llamarse `orca` sin
 * serlo, y el de verdad puede estar detrás de un enlace simbólico. Un worker
 * en un worktree (`<repo>/.claude/worktrees/k9`) cuenta, porque el proyecto
 * al que pertenece sigue siendo éste.
 */
export function isOwnRepo(projectPath: string | null | undefined, root = REPO_ROOT): boolean {
  if (!projectPath) return false;
  const real = (p: string): string => {
    try { return realpathSync(resolve(p)); } catch { return resolve(p); }
  };
  return real(projectPath) === real(root);
}

/**
 * ¿Merece este fin de agente un build?
 *
 * Sólo `done`: un agente muerto no terminó nada, y publicar su árbol a medias
 * es publicar un accidente. Sólo trabajadores: el fin de un CAPCOM es el fin
 * de una sesión de mando, no de una tanda de trabajo. Y sólo sobre el repo
 * propio, que es la regla que gobierna todo esto.
 */
export function finishedOwnWork(
  change: { to: string; agent: { role?: string | null; projectId?: string | null } },
  projectPath: string | null | undefined,
  root = REPO_ROOT,
): boolean {
  if (change.to !== 'done') return false;
  if (change.agent.role === 'capcom') return false;
  return isOwnRepo(projectPath, root);
}

/** Lo que hace falta del mundo exterior; todo inyectable para poder probarlo. */
export interface PublisherDeps {
  /** Corre el publish. Resuelve al resultado; no lanza. */
  run(): Promise<{ ok: boolean; output: string }>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Al log del hub. */
  note(line: string): void;
  /** A CAPCOM, que es quien puede arreglarlo. */
  tellCapcom(text: string): void;
}

export interface Publisher {
  /** Algo terminó y merece un build. Idempotente dentro de la ventana. */
  request(reason: string): void;
  /** ¿Hay un build en marcha? */
  busy(): boolean;
  /** Las razones que esperan a la ventana actual. */
  pending(): string[];
  /** Publica ya, sin esperar la ventana. Devuelve si el build salió bien. */
  flush(): Promise<boolean>;
  stop(): void;
}

/** Cuántos caracteres del error viajan a CAPCOM: lo que se lee, no el volcado. */
const ERROR_CHARS = 1_200;

export function createPublisher(deps: PublisherDeps, debounceMs = PUBLISH_DEBOUNCE_MS): Publisher {
  let timer: unknown = null;
  let reasons: string[] = [];
  let running: Promise<boolean> | null = null;
  /** Alguien pidió publicar mientras se publicaba: hay que repetirlo al acabar. */
  let again = false;
  let stopped = false;
  /** El último fallo ya contado, para no repetir el mismo aviso. */
  let lastFailure: string | null = null;

  async function publish(): Promise<boolean> {
    const why = reasons.length ? reasons.join('; ') : 'a petición';
    reasons = [];
    deps.note(`publicando la consola (${why})`);

    const { ok, output } = await deps.run();
    if (ok) {
      lastFailure = null;
      deps.note('consola publicada: la píldora de actualización se encenderá sola');
      return true;
    }

    /*
     * El fallo se resume por su cola, que es donde el compilador pone el
     * error. Dos intentos con la misma cola son el mismo problema y sólo se
     * cuentan una vez, aunque los separe media hora.
     */
    const tail = output.trim().slice(-ERROR_CHARS);
    if (tail !== lastFailure) {
      lastFailure = tail;
      deps.tellCapcom(
        `[PUBLISH FAILED] The console could not be built from the working tree, so the operator cannot see any of it yet. `
        + `Nothing was touched: the running console still serves the previous build. `
        + `Fix the tree (typecheck first) and it will publish itself when the next agent finishes, or ask for it.\n\n${tail}`,
      );
    } else {
      deps.note('publicación fallida otra vez por lo mismo: no se repite el aviso');
    }
    return false;
  }

  async function runOnce(): Promise<boolean> {
    let ok = await publish();
    // Lo que llegó mientras construíamos entra en un único build más.
    while (again && !stopped) {
      again = false;
      ok = await publish();
    }
    return ok;
  }

  const publisher: Publisher = {
    request(reason) {
      if (stopped) return;
      if (!reasons.includes(reason)) reasons.push(reason);
      if (running) { again = true; return; }
      if (timer !== null) return;      // ya hay ventana abierta
      timer = deps.setTimer(() => { timer = null; void publisher.flush(); }, debounceMs);
    },
    busy: () => running !== null,
    pending: () => [...reasons],
    flush() {
      if (stopped) return Promise.resolve(false);
      if (running) { again = true; return running; }
      if (timer !== null) { deps.clearTimer(timer); timer = null; }
      running = runOnce().finally(() => { running = null; });
      return running;
    },
    stop() {
      stopped = true;
      if (timer !== null) { deps.clearTimer(timer); timer = null; }
      reasons = [];
    },
  };
  return publisher;
}

/** El publish de verdad: `node tools/publish.mjs` en la raíz del repo. */
export function spawnPublish(root = REPO_ROOT, timeoutMs = PUBLISH_TIMEOUT_MS): Promise<{ ok: boolean; output: string }> {
  return new Promise((done) => {
    let out = '';
    const child = spawn(process.execPath, ['tools/publish.mjs'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Sin heredar el entorno del hub a medias: el build necesita el PATH y
      // poco más, y ORCA_* dentro de un build no significa nada.
      env: { ...process.env },
    });
    const cut = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
    child.on('error', (err) => { clearTimeout(cut); done({ ok: false, output: `${out}\n${String(err)}` }); });
    child.on('close', (code) => { clearTimeout(cut); done({ ok: code === 0, output: out }); });
  });
}

/** `ORCA_AUTOPUBLISH=0` lo apaga; un hub de pruebas nunca construye nada. */
export function autopublishEnabled(env: Record<string, string | undefined>, harness: boolean): boolean {
  return !harness && env['ORCA_AUTOPUBLISH'] !== '0';
}
