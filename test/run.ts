/**
 * Unit test runner. Discovers test/*.test.ts, runs every suite, exits non-zero
 * on any failure.
 *
 *   npm test              everything
 *   npm test -- hub       only suites whose filename matches "hub"
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
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
const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));

async function main() {
  const files = (await readdir(DIR))
    .filter((f) => f.endsWith('.test.ts'))
    .filter((f) => !filter || f.includes(filter))
    .sort();

  if (!files.length) {
    console.log(filter ? `no test files matching "${filter}"` : 'no test files');
    return;
  }

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
