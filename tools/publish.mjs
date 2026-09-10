#!/usr/bin/env node
/**
 * Publica la consola: comprueba tipos, construye, y barre lo que sobra.
 *
 *   node tools/publish.mjs            comprobar, construir, barrer
 *   node tools/publish.mjs --keep-all construir sin barrer
 *   node tools/publish.mjs --skip-typecheck   (para una emergencia, no para el día a día)
 *
 * ── Por qué existe, en vez de `npm run build` ──────────────────────
 *
 * Porque ORCA se mira mientras se construye. El hub sirve `dist/` (ver
 * `serveStatic` en src/hub/server.ts) y esa misma carpeta es la que un build
 * reescribe: si el build vacía dist, la consola que el operador tiene delante
 * pierde fuentes, sonidos, `/sw.js` y el index durante unos segundos, y si el
 * build falla los pierde para siempre. Por eso `emptyOutDir: false` en
 * vite.config.ts, y por eso hace falta alguien que limpie: este archivo.
 *
 * ── Qué se conserva, y por qué dos generaciones ────────────────────
 *
 * Los `/assets/*` llevan hash en el nombre, así que la generación nueva y la
 * vieja conviven sin pisarse. Se conservan las dos: la nueva es la que sirve
 * el index recién escrito, y la anterior es la que tiene cargada en memoria
 * la pestaña que aún no ha recargado. Esa pestaña ya no va a pedir su bundle
 * —lo tiene—, pero puede pedir su sourcemap si el operador abre las
 * herramientas, y si lo hace merece encontrarlo. Todo lo de antes de esas dos
 * generaciones no lo puede pedir nadie.
 *
 * Nada de esto recarga ninguna consola. Escribir el index nuevo es lo único
 * que cambia el build id, y de ahí en adelante manda la doctrina de siempre:
 * la píldora se enciende y el clic es la recarga (src/ui/hud/update.ts).
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const INDEX = join(DIST, 'index.html');
const ASSETS = join(DIST, 'assets');

/**
 * Los nombres bajo `/assets/` que un index referencia.
 *
 * Es la misma lectura que hace `buildFingerprint` en src/ui/hud/update.ts —el
 * conjunto de assets con hash ES el build id— y por eso test/publish.test.ts
 * las compara sobre el mismo html: si una de las dos deja de ver un asset, la
 * otra se entera.
 */
export function assetsIn(html) {
  const out = new Set();
  const re = /\b(?:src|href)=["']?\/assets\/([^"'\s>]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) out.add(m[1]);
  return out;
}

/**
 * Qué se borra de dist/assets.
 *
 * `have` es lo que hay en disco; `keep` son los nombres que las dos
 * generaciones vivas referencian. Un sourcemap se queda si se queda el
 * archivo del que es mapa: el index no lo nombra, lo nombra el `.js`.
 */
export function sweepable(have, keep) {
  const kept = new Set(keep);
  return have.filter((f) => !kept.has(f) && !(f.endsWith('.map') && kept.has(f.slice(0, -4))));
}

function run(what, cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    process.stderr.write(`\n[publish] ${what} falló: no se ha tocado el index, se sigue sirviendo el build anterior\n`);
    process.exit(r.status ?? 1);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);

  // Antes de nada, la generación que está en pie: después del build ya no hay
  // forma de saber cuál era.
  const previous = existsSync(INDEX) ? assetsIn(readFileSync(INDEX, 'utf8')) : new Set();

  if (!has('--skip-typecheck')) run('el typecheck', 'npx', ['tsc', '--noEmit']);
  else process.stderr.write('[publish] typecheck omitido a petición: vite no comprueba tipos, esto va sin red\n');

  run('el build', 'npx', ['vite', 'build']);

  if (!existsSync(INDEX)) {
    process.stderr.write('[publish] el build terminó sin dejar dist/index.html\n');
    process.exit(1);
  }
  const current = assetsIn(readFileSync(INDEX, 'utf8'));

  let swept = 0;
  if (!has('--keep-all') && existsSync(ASSETS)) {
    const have = readdirSync(ASSETS).filter((f) => statSync(join(ASSETS, f)).isFile());
    for (const f of sweepable(have, [...current, ...previous])) {
      try { unlinkSync(join(ASSETS, f)); swept++; } catch { /* otro publish se adelantó */ }
    }
  }

  const same = current.size === previous.size && [...current].every((a) => previous.has(a));
  console.log('');
  console.log(`[publish] build ${[...current].sort().join(' ') || '(sin assets con hash)'}`);
  console.log(`[publish] ${same ? 'idéntico al anterior: nadie verá la píldora' : 'nuevo: la consola encenderá UPDATE AVAILABLE en menos de un minuto'}`);
  console.log(`[publish] conservada la generación anterior (${previous.size} assets), barridos ${swept}`);
  console.log('[publish] el hub y el collector NO cambian con esto: siguen con el código que cargaron al arrancar');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
