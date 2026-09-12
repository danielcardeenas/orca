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
 * la carpeta que se navega es este mismo repo —o el checkout principal, si
 * este es un worktree bajo `.claude`, que el hub no sirve: ver
 * `repoQueElHubSirve`—. El hub del arnés la abre por `ORCA_FILE_ROOTS` y la
 * ventana se levanta por el gancho `__orca.openFiles`, que es lo mismo que
 * BROWSE FILES en el menú de un proyecto con esa ruta.
 *
 * Lo que se comprueba es lo que `npm test` ya prueba contra un DOM suelto,
 * pero aquí con main.ts delante del teclado: que `j`, `G`, `gg`, `l`, `h`,
 * `/` y `q` llegan a la ventana y no al campo ni a la línea de mando, y que
 * abrir un archivo pone el visor delante del navegador.
 */

import { chromium, type Page } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

// Antes de importar el arnés: sus servidores nacen con este entorno.
process.env['ORCA_VISUAL_ISOLATED'] = '1';

/**
 * La carpeta que se navega: este repo, y si este repo no se puede servir, el
 * checkout principal.
 *
 * El hub no sirve NADA que lleve un segmento `.claude` (`privatePath`, en
 * `src/hub/files.ts`): ahí viven la configuración y las credenciales de los
 * agentes, y esa puerta está cerrada a propósito. Los worktrees con los que
 * trabaja un agente de FORGE viven justo ahí, en `.claude/worktrees/<x>`, así
 * que corrido desde uno de ellos este shot pedía una carpeta que el hub
 * devuelve con un 403 y se quedaba quince segundos esperando una fila que no
 * iba a llegar. No es un fallo del navegador de archivos ni de la regla: es
 * que la carpeta elegida era imposible. `--git-common-dir` da el `.git` del
 * checkout principal, cuyo padre sí se sirve y tiene los mismos `src/` y
 * `package.json` que esta prueba nombra.
 */
function repoQueElHubSirve(): string {
  const aqui = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const privada = (p: string) => p.split('/').some((seg) => seg === '.claude');
  if (!privada(aqui)) return aqui;
  try {
    const comun = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: aqui, encoding: 'utf8' }).trim();
    const principal = dirname(comun.replace(/\/$/, ''));
    if (principal && !privada(principal)) return principal;
  } catch { /* sin git, o un worktree que ya no cuelga de nadie */ }
  return aqui;
}

const REPO = repoQueElHubSirve();
process.env['ORCA_FILE_ROOTS'] = REPO;

const { GPU_ARGS, SHOTS, ensureServers, newPage, open, shutdown, uiPort, waitForFleet } = await import('./visual.ts');
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

    assert.deepEqual(errors, [], 'no page errors');
    console.log('[file-browser] ok');
  } finally {
    await browser.close();
    if (!keep) shutdown();
  }
}

main().catch((e) => { console.error(e); shutdown(); process.exit(1); });
