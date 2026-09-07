/**
 * Qué suites cubren un conjunto de ficheros cambiados.
 *
 * Un mapa tarea→suites escrito a mano se pudre en cuanto un import se mueve, y
 * el que lo mueve no es quien mantiene el mapa. Aquí se recorre el grafo real:
 * todos los imports relativos de este repo llevan extensión `.ts` explícita, así
 * que resolverlos es un `resolve`, sin heurística ni resolutor de módulos.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// `from './x.ts'`, `export * from '../y.ts'` y `await import('../z.ts')`. Solo
// interesan los relativos: un paquete de node_modules no es código nuestro.
const SPEC = /(?:from|import)\s*\(?\s*'(\.[^']+)'/g;

async function imports(file: string): Promise<string[]> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return []; }
  return [...text.matchAll(SPEC)].map((m) => resolve(dirname(file), m[1]!));
}

/** Todo fichero del repo que una suite alcanza, transitivamente. */
export async function reach(entry: string): Promise<Set<string>> {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    for (const dep of await imports(queue.pop()!)) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }
  return seen;
}

/**
 * Suites que alcanzan alguno de `changed`, más las suites cambiadas ellas
 * mismas. Devuelve también lo que ninguna suite cubre: correr menos tests solo
 * es seguro si se ve qué se ha quedado sin mirar.
 */
export async function affected(dir: string, changed: string[], root: string) {
  const want = changed.map((c) => resolve(root, c));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.test.ts')).sort();
  const suites: string[] = [];
  const covered = new Set<string>();
  for (const f of files) {
    const r = await reach(join(dir, f));
    const hits = want.filter((w) => r.has(w));
    if (!hits.length) continue;
    suites.push(f);
    for (const h of hits) covered.add(h);
  }
  return { suites, uncovered: want.filter((w) => !covered.has(w)) };
}
