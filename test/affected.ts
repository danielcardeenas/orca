/**
 * Qué suites cubren un conjunto de ficheros cambiados.
 *
 * Un mapa tarea→suites escrito a mano se pudre en cuanto un import se mueve, y
 * el que lo mueve no es quien mantiene el mapa. Aquí se recorre el grafo real:
 * todos los imports relativos de este repo llevan extensión `.ts` explícita, así
 * que resolverlos es un `resolve`, sin heurística ni resolutor de módulos.
 *
 * Y no sólo los imports. Una prueba llega a un fichero de tres maneras más, y
 * las tres son rutas escritas en su propio código, así que se leen igual:
 *
 *   new URL(«../public/sw.js», import.meta.url)     un fichero leído del disco
 *   new URL(«../src/ui/styles/», import.meta.url)   un directorio: todo lo de dentro
 *   <link rel=stylesheet href=/src/ui/styles/hud.css>   una hoja que Vite sirve
 *                                                   a un fixture de Playwright
 *
 * Antes sólo contaban los `import`, y tocar `hud.css` seleccionaba cero suites
 * con siete que la miran (una la lee del disco, seis la cargan por `<link>`): la
 * verificación salía en verde sin ejecutar nada. La ruta con la que una prueba
 * lee el fichero ES su declaración de qué vigila; no hay lista que mantener.
 *
 * Esas tres señales sólo se leen bajo `test/`: son las pruebas las que
 * declaran. En `src/` una ruta al disco es comportamiento del producto (el
 * collector resuelve `bin/`, el hub sirve `dist/`), y seguirla haría que
 * cualquier suite que alcance el collector cubriera todos los binarios.
 * (Los ejemplos de arriba van entre comillas latinas por eso mismo: este
 * fichero está bajo `test/` y se lee a sí mismo.)
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// `from './x.ts'`, `export * from '../y.ts'` y `await import('../z.ts')`. Solo
// interesan los relativos: un paquete de node_modules no es código nuestro.
const SPEC = /(?:from|import)\s*\(?\s*'(\.[^']+)'/g;

// Cualquier otro literal relativo, o el prefijo de una plantilla hasta su
// primer `${` (un directorio, normalmente). Lo que no existe en disco no
// cuenta: una ruta de escape en una prueba de saneado no selecciona nada.
const REL = /['"`](\.\.?\/[^'"`\s$]*)/g;

// href o src absolutos desde la raíz del repo, que es como Vite sirve los
// fuentes a los fixtures HTML de Playwright.
const ABS = /(?:href|src)=["'](\/[^"'\s]+)["']/g;

// Sólo se entra a leer lo que puede contener rutas. Un PNG o un fixture de
// pantalla no, aunque una suite los alcance.
const READABLE = /\.(m?[tj]s|css|html)$/;

type Kind = 'file' | 'dir' | null;

/**
 * Lo que ya se ha mirado en esta llamada. Sesenta suites alcanzan los mismos
 * cien ficheros de `src/`; leerlos una vez por suite multiplicaba el coste
 * por sesenta.
 */
export interface Memo { kind: Map<string, Kind>; refs: Map<string, string[]> }
export const memo = (): Memo => ({ kind: new Map(), refs: new Map() });

async function kindOf(path: string, m: Memo): Promise<Kind> {
  const hit = m.kind.get(path);
  if (hit !== undefined) return hit;
  let kind: Kind = null;
  try { const s = await stat(path); kind = s.isDirectory() ? 'dir' : 'file'; } catch { /* no existe */ }
  m.kind.set(path, kind);
  return kind;
}

/** Rutas que `file` nombra: imports siempre; el resto sólo si está bajo `dir`. */
async function refs(file: string, dir: string, root: string, m: Memo): Promise<string[]> {
  const hit = m.refs.get(file);
  if (hit) return hit;
  const out: string[] = [];
  m.refs.set(file, out);
  if (!READABLE.test(file)) return out;
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return out; }
  const declares = file.startsWith(dir + '/');
  for (const re of declares ? [SPEC, REL] : [SPEC]) {
    for (const x of text.matchAll(re)) out.push(resolve(dirname(file), x[1]!));
  }
  if (declares) for (const x of text.matchAll(ABS)) out.push(join(root, x[1]!));
  return out;
}

export interface Reach {
  /** Ficheros del repo que la suite alcanza, transitivamente. */
  files: Set<string>;
  /** Directorios que lee enteros: cualquier fichero debajo cuenta como alcanzado. */
  dirs: Set<string>;
}

/**
 * Todo lo que una suite alcanza, transitivamente. `dir` es el directorio de
 * las suites (donde las rutas al disco cuentan como declaración) y `root` la
 * raíz del repo.
 */
export async function reach(entry: string, dir: string, root: string, m = memo()): Promise<Reach> {
  // `run.ts` pasa el directorio con barra final (`new URL('.', …).pathname`);
  // con ella, `startsWith(dir + '/')` no reconocía ninguna suite como suya y
  // las tres señales se apagaban en silencio. Lo cazó la corrida real, no la
  // unitaria, que construía el directorio sin barra.
  dir = resolve(dir); root = resolve(root);
  const files = new Set([entry]);
  const dirs = new Set<string>();
  // Un directorio que contenga a las propias suites —`test/`, o la raíz del
  // repo— no declara nada: es desde donde se resuelve todo lo demás.
  const home = dir + '/';
  const queue = [entry];
  while (queue.length) {
    for (const dep of await refs(queue.pop()!, dir, root, m)) {
      if (files.has(dep) || dirs.has(dep)) continue;
      const kind = await kindOf(dep, m);
      if (kind === 'file') { files.add(dep); queue.push(dep); }
      else if (kind === 'dir' && !home.startsWith(dep + '/')) dirs.add(dep);
    }
  }
  return { files, dirs };
}

export function reaches(r: Reach, file: string): boolean {
  if (r.files.has(file)) return true;
  for (const d of r.dirs) if (file.startsWith(d + '/')) return true;
  return false;
}

/**
 * Suites que alcanzan alguno de `changed`, más las suites cambiadas ellas
 * mismas. Devuelve también lo que ninguna suite cubre: correr menos tests solo
 * es seguro si se ve qué se ha quedado sin mirar.
 *
 * `suffix` elige qué se considera suite: `.test.ts` para `npm test`; con
 * `.shots.ts` o `.visual.ts` responde quién más mira un fichero fuera de esta
 * corrida.
 */
export async function affected(dir: string, changed: string[], root: string, suffix = '.test.ts', m = memo()) {
  const want = changed.map((c) => resolve(root, c));
  const files = (await readdir(dir)).filter((f) => f.endsWith(suffix)).sort();
  const suites: string[] = [];
  const covered = new Set<string>();
  for (const f of files) {
    const r = await reach(join(dir, f), dir, root, m);
    const hits = want.filter((w) => reaches(r, w));
    if (!hits.length) continue;
    suites.push(f);
    for (const h of hits) covered.add(h);
  }
  return { suites, uncovered: want.filter((w) => !covered.has(w)) };
}
