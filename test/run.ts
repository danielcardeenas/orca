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
 * grafo de imports (ver affected.ts), no de una lista que haya que mantener.
 */

// El collector loguea a nivel info por diseño: es un daemon desatendido. En una
// corrida de pruebas eso entierra los resultados bajo cientos de líneas que no
// se están comprobando. Se puede recuperar con ORCA_LOG=info.
process.env['ORCA_LOG'] ??= 'warn';

import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { affected } from './affected.ts';
import { runSuite, type TestFn, type TestModule, type TestResult } from './harness.ts';

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

  if (SINCE || ARGS.includes('--changed')) {
    const changed = changedFiles();
    const { suites, uncovered } = await affected(DIR, changed, ROOT);
    files = suites;
    why = `${changed.length} fichero(s) tocado(s) → ${suites.length} suite(s)`;
    // Correr menos tests solo es honesto si se ve qué se ha quedado fuera.
    if (uncovered.length) console.log(`\x1b[33msin suite que los cubra\x1b[0m (${uncovered.length}): ${uncovered.map((u) => u.slice(ROOT.length + 1)).join(', ')}`);
  }

  if (FILTERS.length) {
    files = files.filter((f) => FILTERS.some((x) => f.includes(x)));
    why += ` · filtro: ${FILTERS.join(', ')}`;
  }

  if (!files.length) {
    console.log(`no test files (${why})`);
    return;
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
