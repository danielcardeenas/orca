import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { affected, isProse, reach } from './affected.ts';
import { test, ok } from './harness.ts';

/**
 * Un repo de mentira: suites, una cadena de imports, una rama muerta, y las
 * tres formas de llegar a un fichero sin importarlo: leerlo del disco por
 * `import.meta.url`, leer un directorio entero, y cargarlo por `<link>` en un
 * fixture de Playwright.
 *
 * Las rutas del rig (`src/ui/sheets`, `static/sw.js`, `test/samples`) no
 * existen en este repo a propósito: el selector lee los literales de ESTA
 * suite igual que los de cualquier otra, y con las rutas reales se
 * seleccionaba a sí misma al tocar cualquier hoja de estilos.
 */
function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-affected-'));
  const dir = path.join(root, 'test');
  for (const d of ['src', 'src/ui/sheets', 'static', 'test/samples/menus']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const w = (p: string, s: string) => fs.writeFileSync(path.join(root, p), s);
  w('src/deep.ts', 'export const deep = 1;\n');
  w('src/mid.ts', "import { deep } from './deep.ts';\nexport const mid = deep;\n");
  w('src/lonely.ts', 'export const lonely = 1;\n');
  w('src/ui/sheets/hud.css', '.hud{}\n');
  w('src/ui/sheets/window.css', '.win{}\n');
  w('static/sw.js', 'self.x = 1;\n');
  w('test/samples/menus/a.txt', 'MENU\n');
  w('test/util.ts', "export * from '../src/mid.ts';\n");
  w('test/a.test.ts', "import './util.ts';\nexport default { suite: 'a', tests: [] };\n");
  w('test/b.test.ts', "export default { suite: 'b', tests: [] };\n");
  // Lee un fichero del disco, no lo importa.
  w('test/disk.test.ts', "const SW = new URL('../static/sw.js', import.meta.url);\nexport default { suite: 'disk', tests: [] };\n");
  // Lee todas las hojas de un directorio.
  w('test/sheets.test.ts', "const STYLES = new URL('../src/ui/sheets/', import.meta.url);\nexport default { suite: 'sheets', tests: [] };\n");
  // Carga una hoja por <link> en el HTML de un fixture servido por Vite.
  w('test/link.test.ts', "const HTML = '<!doctype html><link rel=\"stylesheet\" href=\"/src/ui/sheets/hud.css\"><body></body>';\nexport default { suite: 'link', tests: [] };\n");
  // Una plantilla: el prefijo es el directorio de fixtures.
  w('test/menu.test.ts', "const real = (n: string) => new URL(`./samples/${n}.txt`, import.meta.url);\nexport default { suite: 'menu', tests: [] };\n");
  // Rutas que no existen (una prueba de saneado) y la raíz del repo: no declaran nada.
  w('test/noise.test.ts', "const evil = '../../etc/passwd'; const up = new URL('..', import.meta.url); const here = new URL('.', import.meta.url);\nexport default { suite: 'noise', tests: [] };\n");
  return { root, dir, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const RUN = fileURLToPath(new URL('./run.ts', import.meta.url));

export default { suite: 'Affected suites', tests: [
  test('a transitive dependency selects the suite that reaches it', async () => {
    const r = rig(); try {
      // a.test.ts -> util.ts -> src/mid.ts -> src/deep.ts: tres saltos, ninguno directo.
      const { suites, uncovered } = await affected(r.dir, ['src/deep.ts'], r.root);
      assert.deepEqual(suites, ['a.test.ts']);
      assert.deepEqual(uncovered, []);
      return ok('reaches through re-export and two hops, and excludes b', true);
    } finally { r.dispose(); }
  }),
  test('a file no suite imports is reported, not silently skipped', async () => {
    const r = rig(); try {
      const { suites, uncovered } = await affected(r.dir, ['src/lonely.ts'], r.root);
      assert.deepEqual(suites, []);
      assert.deepEqual(uncovered.map(u => path.basename(u)), ['lonely.ts']);
      return ok('running fewer tests stays honest about the gap', true);
    } finally { r.dispose(); }
  }),
  test('a changed suite selects itself and the walk terminates on cycles', async () => {
    const r = rig(); try {
      // Un ciclo mid <-> deep colgaría un recorrido ingenuo.
      fs.appendFileSync(path.join(r.root, 'src/deep.ts'), "import '../src/mid.ts';\n");
      assert.ok((await reach(path.join(r.dir, 'a.test.ts'), r.dir, r.root)).files.size >= 4);
      const { suites } = await affected(r.dir, ['test/b.test.ts'], r.root);
      assert.deepEqual(suites, ['b.test.ts']);
      return ok('self-selection works and cycles do not hang', true);
    } finally { r.dispose(); }
  }),
  test('una hoja de estilos selecciona a quien la lee del disco y a quien la carga por <link>', async () => {
    const r = rig(); try {
      const hud = await affected(r.dir, ['src/ui/sheets/hud.css'], r.root);
      assert.deepEqual(hud.suites, ['link.test.ts', 'sheets.test.ts']);
      assert.deepEqual(hud.uncovered, []);
      // window.css sólo la lee el directorio: el <link> es de hud.css.
      const win = await affected(r.dir, ['src/ui/sheets/window.css'], r.root);
      assert.deepEqual(win.suites, ['sheets.test.ts']);
      // run.ts pasa el directorio con barra final; con ella la selección
      // volvía a cero en silencio y la corrida real lo cazó.
      const slash = await affected(r.dir + '/', ['src/ui/sheets/hud.css'], r.root + '/');
      assert.deepEqual(slash.suites, ['link.test.ts', 'sheets.test.ts']);
      return ok('tocar una hoja ya no selecciona cero suites', true);
    } finally { r.dispose(); }
  }),
  test('un fichero leído por import.meta.url cuenta como dependencia, y una plantilla cubre su directorio', async () => {
    const r = rig(); try {
      const sw = await affected(r.dir, ['static/sw.js'], r.root);
      assert.deepEqual(sw.suites, ['disk.test.ts']);
      const menu = await affected(r.dir, ['test/samples/menus/a.txt'], r.root);
      assert.deepEqual(menu.suites, ['menu.test.ts']);
      return ok('la ruta con la que la prueba lee el fichero es su declaración', true);
    } finally { r.dispose(); }
  }),
  test('rutas inexistentes, la raíz del repo y el propio test/ no declaran nada', async () => {
    const r = rig(); try {
      const n = await reach(path.join(r.dir, 'noise.test.ts'), r.dir, r.root);
      assert.deepEqual([...n.dirs], []);
      // Si `..` contara, noise cubriría todo el repo; si `.` contara, todas las suites.
      const { suites } = await affected(r.dir, ['src/lonely.ts', 'test/b.test.ts'], r.root);
      assert.deepEqual(suites, ['b.test.ts']);
      return ok('el ruido no selecciona', true);
    } finally { r.dispose(); }
  }),
  test('una ruta al disco en src/ no es una declaración: sólo cuentan los imports', async () => {
    const r = rig(); try {
      // src/mid.ts resuelve el directorio de hojas en tiempo de ejecución; eso
      // no convierte a a.test.ts en vigilante de todas las hojas.
      fs.appendFileSync(path.join(r.root, 'src/mid.ts'), "export const STYLES = new URL('./ui/styles/', import.meta.url);\n");
      const { suites } = await affected(r.dir, ['src/ui/sheets/window.css'], r.root);
      assert.deepEqual(suites, ['sheets.test.ts']);
      return ok('las pruebas declaran; el producto no', true);
    } finally { r.dispose(); }
  }),
  test('la documentación se reconoce por forma: Markdown en docs/ o en la raíz, y nada más', () => {
    for (const p of ['docs/ENTREGA-X-2026-09-13.md', 'docs/sub/nota.md', 'README.md', 'AGENTS.md']) assert.ok(isProse(p), `${p} es documentación`);
    // Un .md dentro de src/ o bin/ puede ser algo que un fixture lee; y una hoja, un script o una imagen nunca son prosa.
    for (const p of ['src/shared/brief.md', 'bin/README.md', 'src/ui/styles/hud.css', 'public/sw.js', 'docs/foto.png', 'docs/plan.txt']) assert.ok(!isProse(p), `${p} no es documentación`);
    return ok('lista permitida por forma, no excepciones', true);
  }),
  test('un doc tocado junto a una hoja: la hoja selecciona sus suites y el doc queda aparte, sin contar como sin verificar', async () => {
    const r = rig(); try {
      fs.mkdirSync(path.join(r.root, 'docs'));
      fs.writeFileSync(path.join(r.root, 'docs/ENTREGA.md'), '# x\n');
      const { suites, uncovered } = await affected(r.dir, ['docs/ENTREGA.md', 'src/ui/sheets/hud.css'], r.root);
      assert.deepEqual(suites, ['link.test.ts', 'sheets.test.ts']);
      const rel = uncovered.map((u) => path.relative(r.root, u));
      assert.deepEqual(rel, ['docs/ENTREGA.md']);
      assert.deepEqual(rel.filter((u) => !isProse(u)), [], 'nada de código sin cubrir');
      return ok('lo que run.ts enseña en amarillo es sólo lo que es código', true);
    } finally { r.dispose(); }
  }),
  test('una corrida que no ejecuta ninguna suite no sale en verde', () => {
    // Un filtro que no coincide con nada: antes «no test files» y código 0.
    const r = spawnSync(process.execPath, ['--import', 'tsx', RUN, 'ninguna-suite-se-llama-asi'], {
      encoding: 'utf8', env: { ...process.env, ORCA_HOME: os.tmpdir() }, timeout: 60_000,
    });
    assert.equal(r.status, 3, `código ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /ninguna suite ejecutada/);
    return ok('«no ejecuté nada» no es «ejecuté y pasó»', true);
  }),
] };
