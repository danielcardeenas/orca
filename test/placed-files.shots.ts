/**
 * Una imagen soltada en el lienzo se ve en el lienzo. Con el hub, en Chromium.
 *
 *   ORCA_VISUAL_ISOLATED=1 npx tsx test/placed-files.shots.ts
 *   npx tsx test/placed-files.shots.ts --headed   verlo pasar
 *
 * No se llama `*.visual.ts` por lo mismo que `hud-mobile.shots.ts`: `visual.ts`
 * corre su sesión entera cuando el fichero de entrada acaba así.
 *
 * Lo que se comprueba es lo que `npm test -- placed-files` no puede ver:
 *
 *   - que un `drop` con un PNG sobre el campo lo suba al hub de verdad
 *     (`POST /api/uploads`) y `/api/file` lo devuelva con 200
 *   - que la colocación quede en `localStorage` con la ruta que contestó el hub
 *   - que el campo lo DIBUJE: se compara la foto de antes y la de después en
 *     el punto donde se soltó, y tienen que ser distintas
 *   - que un reload lo traiga de vuelta
 *
 * El drop se sintetiza con un `DataTransfer` con el archivo dentro; Chromium
 * no deja arrastrar desde el escritorio en headless, y lo que importa es lo
 * que pasa después del gesto, no el gesto.
 */

import { chromium, type Page } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { PLACED_FILES_KEY } from '../src/ui/placed-files.ts';
import { GPU_ARGS, ROOT, SHOTS, ensureServers, newPage, open, orcaToken, shutdown, uiPort, waitForFleet } from './visual.ts';
import { sleep } from './harness.ts';

const headed = process.argv.includes('--headed');
const keep = process.argv.includes('--keep');
const VIEW = { w: 1440, h: 900 };

/** Los píxeles de un cuadrado alrededor de un punto, como una firma comparable. */
async function patch(page: Page, x: number, y: number, r = 60): Promise<string> {
  const buf = await page.screenshot({ clip: { x: x - r, y: y - r, width: r * 2, height: r * 2 } });
  return buf.toString('base64');
}

async function main() {
  await ensureServers();
  const png = await readFile(join(ROOT, 'public', 'screenshots', 'wide.png'));
  const browser = await chromium.launch({ headless: !headed, args: GPU_ARGS });
  try {
    const page = await newPage(browser, VIEW.w, VIEW.h);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript('window.__name = (fn) => fn');
    await open(page, `http://127.0.0.1:${uiPort()}/?noboot=1`);
    await page.waitForFunction(() => !!document.querySelector('.mast__link.is-up'), null, { timeout: 60_000 });
    await waitForFleet(page, 1);
    await page.evaluate(() => { document.querySelectorAll<HTMLElement>('.win [data-w-close]').forEach((b) => b.click()); window.__orca?.frame(); });
    await sleep(1500);

    // Un punto del campo sin baldosa debajo: el drop va al campo, no a un agente.
    const at = { x: Math.round(VIEW.w * 0.62), y: Math.round(VIEW.h * 0.28) };
    const before = await patch(page, at.x, at.y);

    await page.evaluate(async ({ b64, x, y }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'wide.png', { type: 'image/png' }));
      const field = document.querySelector('[data-field]')!;
      field.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
      field.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }, { b64: png.toString('base64'), x: at.x, y: at.y });

    // La subida contesta y la colocación se apunta.
    await page.waitForFunction((key) => {
      try { return JSON.parse(localStorage.getItem(key) ?? '[]').length === 1; } catch { return false; }
    }, PLACED_FILES_KEY, { timeout: 20_000 });
    const placed = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]') as { path: string; kind: string }[], PLACED_FILES_KEY);
    assert.equal(placed[0]!.kind, 'image');
    assert.match(placed[0]!.path, /\/uploads\/[0-9a-f]{8}-wide\.png$/, 'the hub named the file');
    const served = await page.evaluate(async ({ path, token }) => (await fetch(`/api/file?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`, { method: 'HEAD' })).status, { path: placed[0]!.path, token: orcaToken() });
    assert.equal(served, 200, '/api/file serves the upload');

    // Y se ve: la textura tarda un instante en llegar al cuadro.
    await sleep(2500);
    const after = await patch(page, at.x, at.y);
    assert.notEqual(after, before, 'the field draws something new where the image was dropped');
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'placed-file-01-dropped.png') });

    // Un reload la trae de vuelta, del mismo storage.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('.mast__link.is-up'), null, { timeout: 60_000 });
    await waitForFleet(page, 1);
    await sleep(2500);
    const again = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]').length, PLACED_FILES_KEY);
    assert.equal(again, 1, 'the placement survives a reload');
    await page.screenshot({ path: join(SHOTS, 'placed-file-02-reloaded.png') });

    assert.deepEqual(errors, [], 'no page errors');
    console.log(`[placed-files] ok · ${placed[0]!.path}`);
  } finally {
    await browser.close();
    if (!keep) shutdown();
  }
}

main().catch((e) => { console.error(e); shutdown(); process.exit(1); });
