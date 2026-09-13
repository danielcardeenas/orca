/**
 * Unit test runner. Discovers test/*.test.ts, runs every suite, exits non-zero
 * on any failure.
 *
 *   npm test                          everything
 *   npm test -- hub                   suites whose filename matches "hub"
 *   npm test -- capcom wake handoff   varios filtros, en una corrida
 *   npm test -- --changed             solo las suites que alcanzan lo que has tocado
 *   npm test -- --since=HEAD~1        idem, contra una referencia de git
 *
 * `--changed` existe porque la suite completa tarda minutos y un agente que
 * verifica un cambio de dos ficheros no necesita las 62. La selección sale del
 * grafo de imports y de las rutas que las pruebas leen del disco (ver
 * affected.ts), no de una lista que haya que mantener.
 *
 * Una corrida que no ejecuta ninguna suite no sale en verde. «No ejecuté
 * nada» y «ejecuté y pasó» son cosas distintas, y durante semanas el código de
 * salida dijo lo segundo cuando pasaba lo primero: se tocó sólo `hud.css`,
 * ninguna suite la alcanzaba por imports, y la verificación fue verde sin
 * mirar nada. Ahora sale con NOTHING_RAN, distinto del 1 de los fallos, para
 * que quien lea el código sepa cuál de las dos cosas pasó. La única corrida
 * vacía que es verde de verdad es `--changed` con el árbol limpio: no hay
 * nada tocado, luego nada sin verificar.
 */

// El collector loguea a nivel info por diseño: es un daemon desatendido. En una
// corrida de pruebas eso entierra los resultados bajo cientos de líneas que no
// se están comprobando. Se puede recuperar con ORCA_LOG=info.
process.env['ORCA_LOG'] ??= 'warn';

/*
 * Esta corrida ES el arnés, y lo dice en voz alta.
 *
 * Los hubs que las suites levantan —en proceso o como hijos— son de pruebas, y
 * sólo un hub que se declara de pruebas admite máquinas sintéticas: la puerta
 * está en `src/hub/server.ts`, no en el mock. Sin esto, la mitad de las suites
 * que usan `test/fake-collector.ts` se quedarían sin flota. Ver
 * `src/shared/synthetic.ts`; la prueba de la frontera pide explícitamente un
 * hub sin la marca (`startHub({ harness: false })`) para comprobar que rechaza.
 */
process.env['ORCA_HARNESS'] ??= '1';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isRealOrcaHome } from '../src/hub/harness.ts';
import { affected } from './affected.ts';
import { runSuite, type TestFn, type TestModule, type TestResult } from './harness.ts';

/*
 * Y lo dice desde su propio ORCA_HOME.
 *
 * Un hub de pruebas no arranca sobre el directorio del operador (ver
 * `harnessHomeRefusal` en src/hub/harness.ts), y aquí es donde deja de
 * hacerlo: una suite que levantaba un hub sin darle almacén —serve, term,
 * files— escribía su diario y sus misiones en ~/.orca/hub, y el collector de
 * las suites reescribía los shims de ~/.orca/shims apuntando a este checkout.
 * Una corrida entera comparte uno temporal, que se tira al salir. Un
 * ORCA_HOME que alguien fijó a propósito en otro sitio se respeta.
 *
 * Va después de los imports y basta: ninguno de los de arriba lee ORCA_HOME
 * al cargarse, y las suites se importan más abajo, ya con él puesto.
 */
if (!process.env['ORCA_HOME'] || isRealOrcaHome(process.env['ORCA_HOME'])) {
  const home = mkdtempSync(join(tmpdir(), 'orca-test-home-'));
  process.env['ORCA_HOME'] = home;
  process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* ya no estaba */ } });
}

/**
 * Acepta las tres formas que han aparecido en este repo:
 *   export default { suite, tests }        el contrato
 *   export const TESTS = [fn, ...]         una lista suelta
 *   export async function runX(): TestResult[]   una suite autoejecutable
 * Adaptarlas aquí es más barato que reescribir suites que ya pasan.
 */
function adapt(file: string, mod: Record<string, unknown>): TestModule | null {
  const direct = (mod.default ?? mod.tests) as TestModule | undefined;
  if (direct?.tests) return direct;

  const name = file.replace(/\.test\.ts$/, '');

  // Una función que devuelve todos los resultados de golpe: se envuelve en un
  // único "test" que los reemite, para que el reporte salga igual. Va antes que
  // la lista suelta porque suele encargarse del montaje (DOM sintético, etc.).
  const runner = Object.entries(mod).find(([k, v]) =>
    /^(run|collector)/.test(k) && typeof v === 'function') as
    [string, () => Promise<TestResult[]>] | undefined;
  if (runner) {
    return {
      suite: name,
      tests: [async () => {
        const results = await runner[1]();
        const failed = results.filter((r) => !r.pass);
        for (const r of results) {
          const mark = r.pass ? '\x1b[32mOK\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m';
          console.log(`  ${mark} ${r.name}${r.detail ? `  \x1b[2m${r.detail}\x1b[0m` : ''}`);
        }
        return {
          name: `${results.length} checks`,
          pass: failed.length === 0,
          detail: failed.length ? `${failed.length} failed` : 'all green',
        };
      }],
    };
  }

  const list = mod.TESTS as TestFn[] | undefined;
  if (Array.isArray(list) && list.length) return { suite: name, tests: list };

  return null;
}

const DIR = new URL('.', import.meta.url).pathname;
const ROOT = dirname(DIR.replace(/\/$/, ''));
const ARGS = process.argv.slice(2);
/** Código de salida cuando no se ejecutó ninguna suite: ni verde ni el rojo de un fallo. */
export const NOTHING_RAN = 3;
const FILTERS = ARGS.filter((a) => !a.startsWith('--'));
const SINCE = ARGS.find((a) => a.startsWith('--since='))?.slice('--since='.length);

/** Rutas tocadas: el árbol de trabajo por defecto, o un rango de git con --since. */
function changedFiles(): string[] {
  const git = (args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (SINCE) return git(['diff', '--name-only', SINCE]).split('\n').filter(Boolean);
  // --porcelain para no depender del idioma ni del formato de `git status`.
  return git(['status', '--porcelain'])
    .split('\n').filter(Boolean)
    // Un rename se declara `R  antes -> despues`; lo que importa es el destino.
    .map((l) => { const p = l.slice(3); return p.includes(' -> ') ? p.slice(p.indexOf(' -> ') + 4) : p; })
    .map((p) => p.replace(/^"|"$/g, ''));
}

async function main() {
  let files = (await readdir(DIR)).filter((f) => f.endsWith('.test.ts')).sort();
  let why = 'todas las suites';
  let touched: number | undefined;

  if (SINCE || ARGS.includes('--changed')) {
    const changed = changedFiles();
    touched = changed.length;
    const { suites, uncovered } = await affected(DIR, changed, ROOT);
    files = suites;
    why = `${changed.length} fichero(s) tocado(s) → ${suites.length} suite(s)`;
    // Correr menos tests solo es honesto si se ve qué se ha quedado fuera.
    if (uncovered.length) {
      const rel = (u: string) => u.slice(ROOT.length + 1);
      console.log(`\x1b[33msin suite que los cubra\x1b[0m (${uncovered.length}): ${uncovered.map(rel).join(', ')}`);
      // Y si lo que queda fuera lo mira un shot o una escena visual, decirlo:
      // esta corrida no los ejecuta, pero «nadie lo mira» sería mentira.
      for (const [suffix, how] of [['.shots.ts', 'npm run shots -- <nombre>'], ['.visual.ts', 'npm run visual']] as const) {
        const others = await affected(DIR, uncovered.map(rel), ROOT, suffix);
        if (others.suites.length) console.log(`  lo miran fuera de esta corrida: ${others.suites.join(' ')}  (${how})`);
      }
    }
  }

  if (FILTERS.length) {
    files = files.filter((f) => FILTERS.some((x) => f.includes(x)));
    why += ` · filtro: ${FILTERS.join(', ')}`;
  }

  if (!files.length) {
    if (touched === 0) { console.log(`nada tocado, nada que verificar (${why})`); return; }
    console.log(`\x1b[33mninguna suite ejecutada\x1b[0m (${why}): no se ha verificado nada`);
    process.exit(NOTHING_RAN);
  }
  if (files.length !== (await readdir(DIR)).filter((f) => f.endsWith('.test.ts')).length) console.log(`${why}: ${files.join(' ')}\n`);

  let pass = 0, fail = 0;
  const broken: string[] = [];

  for (const f of files) {
    let mod: { default?: TestModule; tests?: TestModule };
    try {
      mod = await import(join(DIR, f));
    } catch (err) {
      // A suite that will not even import is a failure, not a skip.
      broken.push(f);
      console.error(`\n\x1b[31mCOULD NOT LOAD\x1b[0m ${f}\n  ${err instanceof Error ? err.message : String(err)}`);
      fail++;
      continue;
    }
    const suite = adapt(f, mod as Record<string, unknown>);
    if (!suite) {
      broken.push(f);
      console.error(`\n\x1b[33mNO SUITE\x1b[0m ${f} — export default { suite, tests }, or a TESTS array, or a run*() returning TestResult[]`);
      continue;
    }
    const r = await runSuite(suite);
    pass += r.pass;
    fail += r.fail;
  }

  const total = pass + fail;
  const colour = fail ? '\x1b[31m' : '\x1b[32m';
  console.log(`\n${colour}${pass}/${total} passed\x1b[0m${fail ? `, ${fail} failed` : ''}`);
  if (broken.length) console.log(`broken suites: ${broken.join(', ')}`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('runner crashed:', err);
  process.exit(1);
});
