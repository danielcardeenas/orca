/**
 * hub/publisher.ts — publicar solo cuando el trabajo sobre ORCA termina.
 *
 * Lo que merece guarda es todo lo que evita que esto moleste: que sólo cuente
 * el repo propio y sólo un fin de trabajador; que un racimo de agentes que
 * acaban a la vez produzca UN build y no cinco; que nunca haya dos builds
 * pisándose el mismo `dist/`, y que lo pedido mientras se construye no se
 * pierda; y que un árbol roto —lo normal con varios agentes escribiendo—
 * avise a CAPCOM una vez y no en cada intento.
 */

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { createPublisher, finishedOwnWork, isOwnRepo, REPO_ROOT, type PublisherDeps } from '../src/hub/publisher.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Un publish de mentira: contesta lo que se le diga, y timers a mano. */
function fakeDeps(answers: { ok: boolean; output: string }[]) {
  let next = 1;
  const pending = new Map<number, () => void>();
  const runs: number[] = [];
  const notes: string[] = [];
  const toCapcom: string[] = [];
  /** Builds que no terminan hasta que la prueba los suelta. */
  const held: (() => void)[] = [];
  const hold = answers.length === 0;

  const deps: PublisherDeps = {
    run: async () => {
      runs.push(Date.now());
      if (hold) await new Promise<void>((r) => held.push(r));
      return answers.length > 1 ? answers.shift()! : (answers[0] ?? { ok: true, output: '' });
    },
    setTimer: (fn) => { const h = next++; pending.set(h, fn); return h; },
    clearTimer: (h) => { pending.delete(h as number); },
    note: (l) => { notes.push(l); },
    tellCapcom: (t) => { toCapcom.push(t); },
  };
  const fire = async () => {
    for (const [h, fn] of [...pending]) { pending.delete(h); fn(); }
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  /** Suelta el build que está colgado y deja correr lo que esperaba detrás. */
  const releaseOne = async () => {
    held.shift()?.();
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  return { deps, pending, fire, runs, notes, toCapcom, releaseOne };
}

const mod: TestModule = {
  suite: 'hub/publisher — el build lo dispara el trabajo terminado',
  tests: [
    test('isOwnRepo: el repo propio sí, lo de al lado no', () => {
      const dentro = isOwnRepo(join(ROOT, 'src'));
      const raiz = isOwnRepo(ROOT);
      const rodeo = isOwnRepo(join(ROOT, 'src', '..'));
      const otro = isOwnRepo('/tmp');
      const nada = isOwnRepo(null);
      return ok('sólo la raíz', raiz && rodeo && !dentro && !otro && !nada,
        `raiz=${raiz} rodeo=${rodeo} dentro=${dentro} otro=${otro} nada=${nada}`);
    }),

    test('isOwnRepo: REPO_ROOT es de verdad la raíz de este árbol', () =>
      ok('raíz', isOwnRepo(ROOT, REPO_ROOT), `${REPO_ROOT} vs ${ROOT}`)),

    test('finishedOwnWork: sólo done, sólo trabajador, sólo el repo propio', () => {
      const w = { role: 'worker', projectId: 'p_orca' };
      const hecho = finishedOwnWork({ to: 'done', agent: w }, ROOT);
      const muerto = finishedOwnWork({ to: 'dead', agent: w }, ROOT);
      const trabajando = finishedOwnWork({ to: 'working', agent: w }, ROOT);
      const capcom = finishedOwnWork({ to: 'done', agent: { role: 'capcom', projectId: 'p_orca' } }, ROOT);
      const ajeno = finishedOwnWork({ to: 'done', agent: w }, '/tmp/otro-proyecto');
      return ok('una sola combinación', hecho && !muerto && !trabajando && !capcom && !ajeno,
        `done=${hecho} dead=${muerto} working=${trabajando} capcom=${capcom} ajeno=${ajeno}`);
    }),

    test('un racimo de fines es un solo build', async () => {
      const f = fakeDeps([{ ok: true, output: '' }]);
      const p = createPublisher(f.deps);
      p.request('K9 terminó');
      p.request('LZ terminó');
      p.request('K9 terminó');            // repetida: no cuenta dos veces
      const razones = p.pending().length;
      const relojes = f.pending.size;
      await f.fire();
      return ok('uno', razones === 2 && relojes === 1 && f.runs.length === 1,
        `razones=${razones} relojes=${relojes} builds=${f.runs.length}`);
    }),

    test('nunca dos builds a la vez, y lo pedido mientras se construye no se pierde', async () => {
      const f = fakeDeps([]);              // los builds se quedan colgados hasta soltarlos
      const p = createPublisher(f.deps);
      const primero = p.flush();
      await Promise.resolve();
      const ocupado = p.busy();
      p.request('llegó tarde');            // mientras se construye
      const otro = p.flush();              // no puede abrir un segundo build
      const durante = f.runs.length;

      await f.releaseOne();                // termina el primero: ahora sí toca el segundo
      const despues = f.runs.length;
      await f.releaseOne();
      await primero;

      return ok('en serie',
        ocupado && primero === otro && durante === 1 && despues === 2,
        `busy=${ocupado} mismaPromesa=${primero === otro} durante=${durante} despues=${despues}`);
    }),

    test('un árbol roto avisa a CAPCOM una vez, no en cada intento', async () => {
      const roto = { ok: false, output: 'src/ui/main.ts(10,3): error TS2304: Cannot find name X' };
      const f = fakeDeps([roto, roto, { ok: false, output: 'otro error distinto' }]);
      const p = createPublisher(f.deps);
      await p.flush();
      await p.flush();
      const trasRepetido = f.toCapcom.length;
      await p.flush();
      return ok('sin ruido', trasRepetido === 1 && f.toCapcom.length === 2,
        `avisos tras repetir=${trasRepetido}, tras uno nuevo=${f.toCapcom.length}`);
    }),

    test('el aviso dice que lo que está en pie no se ha tocado', async () => {
      const f = fakeDeps([{ ok: false, output: 'error TS1005' }]);
      const p = createPublisher(f.deps);
      await p.flush();
      const aviso = f.toCapcom[0] ?? '';
      return ok('legible',
        aviso.startsWith('[PUBLISH FAILED]') && aviso.includes('previous build') && aviso.includes('TS1005'),
        aviso.slice(0, 120));
    }),

    test('un build bueno tras uno roto vuelve a dejar contar ese error', async () => {
      const roto = { ok: false, output: 'error TS2304' };
      const f = fakeDeps([roto, { ok: true, output: '' }, roto]);
      const p = createPublisher(f.deps);
      await p.flush();
      await p.flush();
      await p.flush();
      return eq('dos avisos', f.toCapcom.length, 2);
    }),

    test('stop(): ni reloj pendiente ni peticiones que reanudar', async () => {
      const f = fakeDeps([{ ok: true, output: '' }]);
      const p = createPublisher(f.deps);
      p.request('algo');
      p.stop();
      p.request('otra cosa');
      const hecho = await p.flush();
      return ok('parado', f.pending.size === 0 && p.pending().length === 0 && hecho === false && f.runs.length === 0,
        `relojes=${f.pending.size} razones=${p.pending().length} builds=${f.runs.length}`);
    }),
  ],
};

export default mod;
