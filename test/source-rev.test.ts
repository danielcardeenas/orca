/**
 * hub/source-rev.ts — «¿corre el hub el código que hay en disco?».
 *
 * Lo que merece guarda: la revisión no depende del orden en que se lea el
 * directorio, pero sí de que un archivo cambie de tamaño, de fecha, de nombre
 * o deje de estar; el escaneo real deja fuera `src/ui/` (que ya tiene su
 * propia señal) y coge lo demás; y el centinela avisa una sola vez, para su
 * reloj al hacerlo, y no confunde «no pude mirar» con «cambió».
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSourceSentinel, revOf, scanSource, sourceRev, type SourceIO, type SourceStat,
} from '../src/hub/source-rev.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

const FILES: SourceStat[] = [
  { path: 'hub/server.ts', mtimeMs: 1_700_000_000_000, size: 120_000 },
  { path: 'shared/protocol.ts', mtimeMs: 1_700_000_000_001, size: 30_000 },
  { path: 'collector/index.ts', mtimeMs: 1_700_000_000_002, size: 50_000 },
];

/** Un disco de mentira: contesta lo que se le diga, y timers que sólo disparan a mano. */
function fakeIO(answers: (string | Error)[]) {
  let next = 1;
  const pending = new Map<number, () => void>();
  const io: SourceIO = {
    rev: async () => {
      const a = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (a instanceof Error) throw a;
      return a;
    },
    set: (fn) => { const h = next++; pending.set(h, fn); return h; },
    clear: (h) => { pending.delete(h as number); },
  };
  const fire = async () => {
    for (const [h, fn] of [...pending]) { pending.delete(h); fn(); }
    await Promise.resolve(); await Promise.resolve();
  };
  return { io, pending, fire };
}

const mod: TestModule = {
  suite: 'hub/source-rev — el hub se vigila a sí mismo',
  tests: [
    test('revOf: el orden de lectura no cambia la revisión', () =>
      eq('estable', revOf([...FILES].reverse()), revOf(FILES))),

    test('revOf: cambia con el mtime, el tamaño, el nombre y con que falte uno', () => {
      const base = revOf(FILES);
      const touched = revOf(FILES.map((f, i) => (i === 0 ? { ...f, mtimeMs: f.mtimeMs + 1 } : f)));
      const grown = revOf(FILES.map((f, i) => (i === 0 ? { ...f, size: f.size + 1 } : f)));
      const renamed = revOf(FILES.map((f, i) => (i === 0 ? { ...f, path: 'hub/servidor.ts' } : f)));
      const gone = revOf(FILES.slice(1));
      const all = new Set([base, touched, grown, renamed, gone]);
      return eq('cinco revisiones distintas', all.size, 5, [...all].join(' '));
    }),

    test('scanSource: coge el servidor y deja fuera la consola', async () => {
      const files = await scanSource(SRC);
      const paths = files.map((f) => f.path.replace(/\\/g, '/'));
      const ui = paths.filter((p) => p.startsWith('ui/'));
      const noTs = paths.filter((p) => !p.endsWith('.ts'));
      return ok('sólo servidor',
        ui.length === 0
        && noTs.length === 0
        && paths.includes('hub/server.ts')
        && paths.includes('shared/protocol.ts')
        && paths.includes('collector/index.ts'),
        `n=${paths.length} ui=${ui.length} noTs=${noTs.length}`);
    }),

    test('check(): la misma revisión no dice nada', async () => {
      const f = fakeIO(['aaa']);
      const s = createSourceSentinel('aaa', f.io);
      const stale = await s.check();
      return ok('callado', stale === false && s.stale() === false);
    }),

    test('check(): otra revisión avisa una vez y para el reloj', async () => {
      const f = fakeIO(['bbb']);
      const s = createSourceSentinel('aaa', f.io);
      let avisos = 0;
      s.onStale(() => { avisos++; });
      s.start();
      await s.check();
      await s.check();
      return ok('una vez', avisos === 1 && s.stale() && f.pending.size === 0,
        `avisos=${avisos} pending=${f.pending.size}`);
    }),

    test('check(): un escaneo vacío o un error no son un cambio', async () => {
      const roto = createSourceSentinel('aaa', fakeIO([new Error('sin permisos')]).io);
      const vacio = createSourceSentinel('aaa', fakeIO(['']).io);
      const a = await roto.check();
      const b = await vacio.check();
      return ok('nada que decir', a === false && b === false);
    }),

    test('con un árbol de verdad: escribir el servidor avisa, escribir la consola no', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-src-'));
      try {
        mkdirSync(join(dir, 'hub'));
        mkdirSync(join(dir, 'ui'));
        writeFileSync(join(dir, 'hub', 'server.ts'), 'export const a = 1;');
        writeFileSync(join(dir, 'ui', 'main.ts'), 'export const b = 1;');

        const s = createSourceSentinel(await sourceRev(dir), {
          rev: () => sourceRev(dir),
          set: (fn, ms) => setTimeout(fn, ms),
          clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        });

        // La consola tiene su propio aviso: tocarla aquí no puede encender éste.
        writeFileSync(join(dir, 'ui', 'main.ts'), 'export const b = 222222;');
        const callado = await s.check();

        writeFileSync(join(dir, 'hub', 'server.ts'), 'export const a = 222222;');
        const salta = await s.check();

        return ok('sólo el servidor', callado === false && salta === true, `ui=${callado} hub=${salta}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),

    test('start(): un solo reloj, y sigue latiendo mientras no haya cambio', async () => {
      const f = fakeIO(['aaa']);
      const s = createSourceSentinel('aaa', f.io);
      s.start(); s.start();
      const uno = f.pending.size;
      await f.fire();
      const sigue = f.pending.size;
      s.stop();
      return ok('reloj', uno === 1 && sigue === 1 && f.pending.size === 0, `${uno} ${sigue}`);
    }),
  ],
};

export default mod;
