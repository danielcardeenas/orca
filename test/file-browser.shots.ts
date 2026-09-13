/**
 * El navegador de archivos, con el hub y la consola de verdad, en Chromium.
 *
 *   npx tsx test/file-browser.shots.ts             (siempre aislado: su hub, su Vite)
 *   npx tsx test/file-browser.shots.ts --headed    verlo pasar
 *
 * No se llama `*.visual.ts` por lo mismo que `file-viewer.shots.ts`: `visual.ts`
 * corre su sesión entera cuando el fichero de entrada acaba así.
 *
 * La flota sintética declara proyectos que no existen en este disco, así que
 * la carpeta que se navega es este mismo repo, sea el checkout principal o un
 * worktree de agente bajo `.claude/worktrees`: desde que `privatePath` abre
 * ese subdirectorio (`src/hub/files.ts`), las dos cosas se sirven igual. El
 * hub del arnés la abre por `ORCA_FILE_ROOTS` y la ventana se levanta por el
 * gancho `__orca.openFiles`, que es lo mismo que BROWSE FILES en el menú de
 * un proyecto con esa ruta.
 *
 * Lo que se comprueba es lo que `npm test` ya prueba contra un DOM suelto,
 * pero aquí con main.ts delante del teclado: que `j`, `G`, `gg`, `l`, `h`,
 * `/` y `q` llegan a la ventana y no al campo ni a la línea de mando, y que
 * abrir un archivo pone el visor delante del navegador.
 *
 * Y dos cosas que sólo se ven con el hub de verdad delante, sobre un proyecto
 * de mentira que este fichero fabrica en un temporal (`arbolDeMentira`):
 *
 *   · que el worktree de un agente **sí** se lista, y que dentro de ese mismo
 *     worktree un `.env` o un `.claude/settings.json` anidados **siguen sin**
 *     servirse. Esa asimetría es todo el cambio: el permiso es posicional, no
 *     una subcadena, y si un refactor lo convierte en subcadena este shot se
 *     entera.
 *   · que el 403 dice cuál de los cuatro motivos fue, y que el botón ALLOW
 *     sólo aparece cuando puede funcionar. Antes el visor pintaba una frase
 *     fija —«fuera de las raíces»— para una ruta vetada por política, que es
 *     falsa, y ofrecía debajo un ALLOW que `files:allow` iba a negar con la
 *     misma comprobación. Aquí se atan las dos mitades: el vocabulario del
 *     hub (`REFUSAL`) se importa y se compara con lo que sale en pantalla.
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { REFUSAL } from '../src/hub/files.ts';

// Antes de importar el arnés: sus servidores nacen con este entorno.
process.env['ORCA_VISUAL_ISOLATED'] = '1';

/** Este repo, sea checkout principal o worktree: el hub sirve los dos. */
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Un proyecto de mentira con un worktree dentro, para probar la regla sin
 * depender de dónde se corra este fichero.
 *
 * Tiene lo justo para que la asimetría se vea: código dentro del worktree, y
 * al lado —dentro del mismo worktree— las dos cosas que no se sirven nunca.
 * En un temporal con suficiente profundidad, que `acceptableRoot` rechaza los
 * contenedores de `/var/folders` pero no lo que cuelga de ellos.
 */
function arbolDeMentira(): { raiz: string; proyecto: string; worktree: string } {
  const raiz = mkdtempSync(join(tmpdir(), 'orca-fb-'));
  const proyecto = join(raiz, 'proyecto');
  const worktree = join(proyecto, '.claude', 'worktrees', 'k9');
  mkdirSync(join(proyecto, 'src'), { recursive: true });
  mkdirSync(join(worktree, 'src'), { recursive: true });
  mkdirSync(join(worktree, '.claude'), { recursive: true });
  writeFileSync(join(proyecto, 'src', 'main.ts'), 'export const donde = "el proyecto";\n');
  writeFileSync(join(proyecto, '.claude', 'settings.json'), '{ "no": "se sirve" }\n');
  writeFileSync(join(worktree, 'src', 'dentro.ts'), 'export const donde = "el worktree";\n');
  writeFileSync(join(worktree, '.env'), 'SECRETO=no\n');
  writeFileSync(join(worktree, '.claude', 'settings.json'), '{ "tampoco": true }\n');
  writeFileSync(join(raiz, 'fuera.txt'), 'ni siquiera es un proyecto\n');
  return { raiz, proyecto, worktree };
}

const FAKE = arbolDeMentira();
process.env['ORCA_FILE_ROOTS'] = `${REPO}:${FAKE.proyecto}`;

const { GPU_ARGS, SHOTS, ensureServers, hubPort, newPage, open, orcaToken, shutdown, uiPort, waitForFleet } = await import('./visual.ts');
const { sleep } = await import('./harness.ts');

const headed = process.argv.includes('--headed');
const keep = process.argv.includes('--keep');

interface FbState { windows: string[]; focus: string | null; dir: string; rows: string[]; cur: string | null; path: string; finding: boolean; cmdFocused: boolean }

function state(page: Page): Promise<FbState> {
  return page.evaluate(() => {
    const wins = [...document.querySelectorAll<HTMLElement>('.win')];
    const fb = document.querySelector<HTMLElement>('.win.is-files');
    return {
      windows: wins.map((w) => w.dataset['kind'] ?? '?'),
      focus: wins.find((w) => w.classList.contains('is-focus'))?.dataset['kind'] ?? null,
      dir: fb?.querySelector<HTMLElement>('[data-path]')?.title ?? '',
      rows: [...(fb?.querySelectorAll<HTMLElement>('.fb__row .fb__name') ?? [])].map((n) => n.textContent ?? ''),
      cur: fb?.querySelector<HTMLElement>('.fb__row.is-cur .fb__name')?.textContent ?? null,
      path: fb?.querySelector<HTMLElement>('[data-path]')?.textContent ?? '',
      finding: !!document.activeElement?.matches('[data-filter]'),
      cmdFocused: !!document.activeElement?.closest('.cmd'),
    };
  });
}

const closeAll = (page: Page) => page.evaluate(() => { document.querySelectorAll<HTMLElement>('.win [data-w-close]').forEach((b) => b.click()); });

/** Lo que enseña el visor cuando el hub dice que no: la línea, y si hay botón. */
function visor(page: Page): Promise<{ msg: string; allow: string | null }> {
  return page.evaluate(() => {
    const win = document.querySelector<HTMLElement>('.win.is-file');
    const btn = [...(win?.querySelectorAll<HTMLElement>('.slab-btn') ?? [])].find((b) => b.textContent?.startsWith('ALLOW'));
    return { msg: win?.querySelector<HTMLElement>('.file__msg')?.textContent ?? '', allow: btn?.textContent ?? null };
  });
}

/** El hub por delante de la consola, para ver el motivo tal cual sale por el cable. */
async function alHub(ruta: '/api/file' | '/api/dir', path: string): Promise<{ status: number; body: string }> {
  const url = `http://127.0.0.1:${hubPort()}${ruta}?path=${encodeURIComponent(path)}&token=${encodeURIComponent(orcaToken())}`;
  const res = await fetch(url);
  return { status: res.status, body: (await res.text()).slice(0, 200).trim() };
}

async function main() {
  await ensureServers();
  const browser = await chromium.launch({ headless: !headed, args: GPU_ARGS });
  try {
    const page = await newPage(browser, 1440, 900);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript('window.__name = (fn) => fn');
    await open(page, `http://127.0.0.1:${uiPort()}/?noboot=1`);
    await page.waitForFunction(() => !!document.querySelector('.mast__link.is-up'), null, { timeout: 60_000 });
    await waitForFleet(page, 1);
    await closeAll(page);
    await sleep(800);
    await mkdir(SHOTS, { recursive: true });

    /* 1 · the window opens on the repo's root, dirs first */
    await page.evaluate((root) => (window.__orca as unknown as { openFiles(r: string, at: { x: number; y: number }): void }).openFiles(root, { x: 420, y: 160 }), REPO);
    await page.waitForSelector('.win.is-files .fb__row', { timeout: 15_000 });
    await sleep(900);
    let s = await state(page);
    assert.equal(s.focus, 'files', 'the browser has the keyboard');
    assert.ok(s.rows.includes('src/') && s.rows.includes('package.json'), `the repo's root is listed: ${s.rows.slice(0, 8).join(' ')}`);
    assert.ok(s.rows.indexOf('src/') < s.rows.indexOf('package.json'), 'folders first');
    assert.ok(!s.rows.some((r) => r === '.git/' || r === '.env'), 'what the hub does not serve (.git, .env) is not listed');
    await page.screenshot({ path: join(SHOTS, 'file-browser-01-root.png') });

    /* 2 · j, G, gg reach the window, not the field */
    await page.keyboard.press('j'); await page.keyboard.press('j');
    s = await state(page);
    assert.equal(s.cur, s.rows[2], 'j moved the cursor twice');
    await page.keyboard.press('Shift+G');
    assert.equal((await state(page)).cur, s.rows[s.rows.length - 1], 'G is the last row');
    await page.keyboard.press('g'); await page.keyboard.press('g');
    assert.equal((await state(page)).cur, s.rows[0], 'gg is the first');

    /* 3 · / filters without stealing the command line; ↵ keeps it; l enters src */
    await page.keyboard.press('/');
    await sleep(100);
    s = await state(page);
    assert.ok(s.finding && !s.cmdFocused, '/ went to the browser\'s filter, not the command line');
    await page.keyboard.type('src');
    await page.keyboard.press('Enter');
    await sleep(100);
    await page.keyboard.press('l');
    await page.waitForFunction((root) => document.querySelector<HTMLElement>('.win.is-files [data-path]')?.title === `${root}/src`, REPO, { timeout: 10_000 });
    await sleep(500);
    s = await state(page);
    assert.equal(s.dir, `${REPO}/src`);
    assert.ok(s.rows.includes('ui/'), `inside src: ${s.rows.join(' ')}`);
    await page.screenshot({ path: join(SHOTS, 'file-browser-02-src.png') });

    /* 4 · h goes back up with the cursor on src; at the root it stays */
    await page.keyboard.press('h');
    await page.waitForFunction((root) => document.querySelector<HTMLElement>('.win.is-files [data-path]')?.title === root, REPO, { timeout: 10_000 });
    await sleep(300);
    s = await state(page);
    assert.equal(s.cur, 'src/', 'back at the root, on the folder we left');
    await page.keyboard.press('h');
    await sleep(300);
    assert.equal((await state(page)).dir, REPO, 'h at the root is a wall');

    /* 5 · l on a file opens the viewer in front of the browser */
    await page.keyboard.press('/');
    await page.keyboard.type('package.json');
    await page.keyboard.press('Enter');
    await sleep(100);
    await page.keyboard.press('l');
    await page.waitForSelector('.win.is-file .file__code', { timeout: 15_000 });
    await sleep(900);
    s = await state(page);
    assert.deepEqual([...s.windows].sort(), ['file', 'files'], 'the viewer opened beside the browser');
    assert.equal(s.focus, 'file', 'and it is the active one');
    await page.screenshot({ path: join(SHOTS, 'file-browser-03-open.png') });

    /* 6 · back to the browser (a click on it, as always), q closes it */
    await page.evaluate(() => { document.querySelector<HTMLElement>('.win.is-file [data-w-close]')?.click(); });
    await sleep(700);
    await page.click('.win.is-files .fb__list');
    await sleep(300);
    s = await state(page);
    assert.equal(s.focus, 'files', 'a click on the browser gives it the keyboard back');
    await page.keyboard.press('q');
    await sleep(700);
    s = await state(page);
    assert.ok(!s.windows.includes('files'), 'q closed the browser');

    /* 7 · el worktree de un agente se sirve; lo sensible de dentro, no */
    // El permiso es posicional: `.claude` deja de vetar sólo cuando lo sigue
    // `worktrees`. Por el cable, para ver el motivo exacto y no una frase.
    const dentro = join(FAKE.worktree, 'src', 'dentro.ts');
    assert.equal((await alHub('/api/dir', FAKE.worktree)).status, 200, 'el worktree se lista');
    assert.equal((await alHub('/api/file', dentro)).status, 200, 'un fichero del worktree se sirve');
    for (const prohibido of [join(FAKE.worktree, '.env'), join(FAKE.worktree, '.claude', 'settings.json'), join(FAKE.proyecto, '.claude', 'settings.json')]) {
      const r = await alHub('/api/file', prohibido);
      assert.equal(r.status, 403, `sigue vetado: ${prohibido}`);
      assert.equal(r.body, REFUSAL.private, `y por política, no por raíces: ${prohibido}`);
    }
    assert.equal((await alHub('/api/file', join(FAKE.raiz, 'fuera.txt'))).body, REFUSAL.roots, 'fuera de la raíz sigue siendo el otro motivo');

    /* 8 · y el navegador lo enseña así: el worktree entra, sin lo vetado */
    await page.evaluate((root) => (window.__orca as unknown as { openFiles(r: string, at: { x: number; y: number }): void }).openFiles(root, { x: 420, y: 160 }), FAKE.worktree);
    await page.waitForSelector('.win.is-files .fb__row', { timeout: 15_000 });
    await sleep(700);
    s = await state(page);
    assert.equal(s.dir, FAKE.worktree, 'el navegador abrió en el worktree');
    assert.ok(s.rows.includes('src/'), `el código del worktree se lista: ${s.rows.join(' ')}`);
    assert.ok(!s.rows.some((r) => r === '.env' || r === '.claude/'), `y lo privado de dentro no: ${s.rows.join(' ')}`);
    await page.screenshot({ path: join(SHOTS, 'file-browser-04-worktree.png') });
    await closeAll(page);
    await sleep(500);

    /* 9 · el 403 dice cuál de los motivos fue, y ALLOW sólo cuando sirve */
    // La laguna que dejó la entrega de raíces permitidas: esto nunca se había
    // mirado en la consola viva. Las dos mitades, atadas aquí.
    await page.evaluate((p) => (window.__orca as unknown as { openFile(p: string): void }).openFile(p), join(FAKE.worktree, '.env'));
    await page.waitForFunction(() => !!document.querySelector('.win.is-file .file__msg.is-warn'), null, { timeout: 15_000 });
    await sleep(500);
    let v = await visor(page);
    assert.ok(v.msg.includes('POLICY'), `la política se dice como tal: ${v.msg}`);
    assert.ok(!v.msg.includes('OUTSIDE THE PROJECT ROOTS'), `y no como lo que no es: ${v.msg}`);
    assert.equal(v.allow, null, 'sin ALLOW: files:allow pasa por la misma comprobación que acaba de negarla');
    await page.screenshot({ path: join(SHOTS, 'file-browser-05-policy.png') });
    await closeAll(page);
    await sleep(500);

    await page.evaluate((p) => (window.__orca as unknown as { openFile(p: string): void }).openFile(p), join(FAKE.raiz, 'fuera.txt'));
    await page.waitForFunction(() => !!document.querySelector('.win.is-file .file__msg.is-warn'), null, { timeout: 15_000 });
    await sleep(500);
    v = await visor(page);
    assert.ok(v.msg.includes('OUTSIDE THE PROJECT ROOTS'), `fuera de las raíces sigue diciéndolo: ${v.msg}`);
    assert.ok(v.allow?.startsWith('ALLOW'), 'y ahí el botón sigue, porque ahí sí puede funcionar');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('[file-browser] ok');
  } finally {
    await browser.close();
    rmSync(FAKE.raiz, { recursive: true, force: true });
    if (!keep) shutdown();
  }
}

main().catch((e) => { console.error(e); shutdown(); process.exit(1); });
