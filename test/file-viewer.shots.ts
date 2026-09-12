/**
 * El visor de archivos y el apilado de ventanas, con el hub, en Chromium.
 *
 *   ORCA_VISUAL_ISOLATED=1 npx tsx test/file-viewer.shots.ts
 *   npx tsx test/file-viewer.shots.ts --headed   verlo pasar
 *
 * No se llama `*.visual.ts` por lo mismo que `hud-mobile.shots.ts`: `visual.ts`
 * corre su sesión entera cuando el fichero de entrada acaba así.
 *
 * Lo que se comprueba es lo que `npm test` no puede ver:
 *
 *   - una ventana de archivo abierta desde otra queda DELANTE de ella, venga
 *     la otra en front o en el canvas
 *   - pulsar el título de una ventana en el canvas, a tamaño de lectura, la
 *     trae delante de todo y la activa (antes sólo subía entre las del canvas)
 *   - una imagen se abre a lo ANCHO de la ventana y lo que sobra se desplaza,
 *     sin hacer zoom ni estirar la ventana
 *
 * La imagen alta sale de `public/screenshots/narrow.png`, soltada en el campo
 * (así la sirve el hub de este arnés desde su `uploads`) y abierta en el visor
 * por el gancho `__orca.openFile`, que es lo mismo que pinchar una ruta.
 */

import { chromium, type Page } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { GPU_ARGS, ROOT, SHOTS, ensureServers, newPage, open, shutdown, uiPort, waitForFleet } from './visual.ts';
import { sleep } from './harness.ts';

const headed = process.argv.includes('--headed');
const keep = process.argv.includes('--keep');

interface WinState { kind: string; canvas: boolean; focus: boolean; scale: number; x: number; y: number; w: number; h: number; top: string }

function state(page: Page): Promise<WinState[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.win')].map((w) => {
    /*
     * `style.scale` es una propiedad de dos ejes: el navegador la devuelve
     * unas veces como «0.2» y otras como «0.2 0.2», según quién la escribiera
     * por última vez. `Number('0.2 0.2')` es NaN, y un NaN aquí no se nota
     * hasta el `mouse.move` de más abajo, que lo rechaza con un «Invalid
     * parameters» que no nombra a nadie. Se lee el primer eje, que es el que
     * la consola escribe.
     */
    const scaleOf = (el: HTMLElement) => {
      const n = Number(String(el.style.scale || '1').trim().split(/\s+/)[0]);
      return Number.isFinite(n) && n > 0 ? n : 1;
    };
    const r = w.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.win') as HTMLElement | null;
    return { kind: w.dataset['kind'] ?? '?', canvas: w.classList.contains('is-canvas'), focus: w.classList.contains('is-focus'), scale: scaleOf(w), x: r.x, y: r.y, w: r.width, h: r.height, top: top?.dataset['kind'] ?? 'none' };
  }));
}

const closeAll = (page: Page) => page.evaluate(() => { document.querySelectorAll<HTMLElement>('.win [data-w-close]').forEach((b) => b.click()); });

async function main() {
  await ensureServers();
  const png = await readFile(join(ROOT, 'public', 'screenshots', 'narrow.png'));
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

    /* 1 · a file opened from a front window lands in front of it */
    await page.evaluate(() => { window.__orca!.open(window.__orca!.agentIds()[0]!); });
    await sleep(900);
    const agent = (await state(page))[0]!;
    await page.evaluate(({ x, y }) => window.__orca!.openFile!('/Users/nobody/x/readme.md', { x, y }), { x: agent.x + 80, y: agent.y + 120 });
    await sleep(900);
    let s = await state(page);
    assert.equal(s.find((w) => w.kind === 'file')?.top, 'file', 'the file window is on top of the window it came from (front)');
    assert.equal(s.find((w) => w.kind === 'file')?.focus, true, 'and it is the active one');

    /* 2 · the origin on the canvas: the new file still lands in front */
    await page.evaluate(() => { document.querySelector<HTMLElement>('.win.is-agent [data-w-front]')?.click(); });
    /*
     * Hasta que ESTÉ en el plano, no seiscientos milisegundos. Mientras la
     * ventana viaja del cristal al canvas su escala no responde al zoom, y
     * cuarenta ruedas contra una ventana en tránsito la dejan donde estaba:
     * el fallo se leía como «no llega a escala de lectura» y lo que pasaba
     * era que el zoom empezó antes de tiempo.
     */
    await page.waitForFunction(() => !!document.querySelector('.win.is-agent.is-canvas'), null, { timeout: 10_000 })
      .catch(() => { throw new Error('la ventana del agente no volvió al canvas'); });
    // Zoom anchored on the header, so it stays under the mouse while it grows to reading scale.
    const from = (await state(page)).find((w) => w.kind === 'agent')!.scale;
    // Sesenta pasos y no cuarenta: de dónde parte la ventana lo decide la
    // cámara del reencuadre anterior, y desde el peldaño más lejano cuarenta
    // ruedas se quedaban a mitad de camino de la escala de lectura.
    for (let i = 0; i < 60; i++) {
      const a = (await state(page)).find((w) => w.kind === 'agent')!;
      /*
       * `a.canvas` y no sólo la escala: una ventana en el cristal no lleva
       * `style.scale`, y eso se lee como 1 — que ya cumple el listón. El
       * bucle salía sin dar una sola vuelta creyendo que estaba a escala de
       * lectura, y cuatrocientos milisegundos después la ventana aterrizaba
       * en el plano a 0.28 y la aserción culpaba al zoom de no llegar.
       */
      if (a.canvas && a.scale >= 0.6) break;
      await page.mouse.move(a.x + a.w - 60 * a.scale, a.y + 12 * a.scale);
      await page.keyboard.down('Meta'); await page.mouse.wheel(0, -60); await page.keyboard.up('Meta');
      await sleep(120);
    }
    await sleep(400);
    const onCanvas = (await state(page)).find((w) => w.kind === 'agent')!;
    assert.ok(onCanvas.canvas && onCanvas.scale >= 0.55,
      `the agent window reads on the canvas (scale ${onCanvas.scale}, desde ${from.toFixed(3)})`);
    await page.evaluate(() => window.__orca!.openFile!('/Users/nobody/x/other.md', { x: 20, y: 600 }));
    await sleep(900);
    s = await state(page);
    const files = s.filter((w) => w.kind === 'file');
    assert.equal(files.at(-1)?.top, 'file', 'a file opened from a canvas window lands in front');
    await page.screenshot({ path: join(SHOTS, 'file-viewer-01-stack.png') });

    /* 3 · click the canvas window's title: in front of everything, active */
    /*
     * Se barre la cabecera entera, no sólo su línea media: la ventana de
     * archivo que acaba de abrirse delante puede cruzarla por el medio y
     * dejar libres el borde de arriba o el de abajo. Antes bastaba con eso
     * para que la prueba dijera que no hay dónde agarrar la ventana, cuando
     * lo que pasaba es que sólo miraba una línea de las veinte que tiene.
     */
    const pt = await page.evaluate(() => {
      const w = document.querySelector<HTMLElement>('.win.is-agent')!; const head = w.querySelector<HTMLElement>('.win__head')!;
      const r = head.getBoundingClientRect();
      for (const fy of [0.5, 0.25, 0.75, 0.12, 0.88]) {
        const y = r.y + r.height * fy;
        for (let x = r.x + 6; x < r.right; x += 8) {
          const e = document.elementFromPoint(x, y) as HTMLElement | null;
          if (e && e.closest('.win') === w && !e.closest('button')) return { x, y };
        }
      }
      return null;
    });
    assert.ok(pt, 'some bare stretch of the canvas window\'s header is reachable');
    await page.mouse.click(pt.x, pt.y);
    await sleep(600);
    const raised = (await state(page)).find((w) => w.kind === 'agent')!;
    assert.ok(!raised.canvas && raised.focus && raised.top === 'agent', `a click on the title brought it in front and active (${JSON.stringify(raised)})`);
    await page.screenshot({ path: join(SHOTS, 'file-viewer-02-raised.png') });

    /* 4 · an image opens at the window's width and scrolls */
    await closeAll(page);
    await sleep(500);
    await page.evaluate(({ b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bytes], 'narrow.png', { type: 'image/png' }));
      document.querySelector('[data-field]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 900, clientY: 300 }));
    }, { b64: png.toString('base64') });
    await page.waitForFunction(() => { try { return JSON.parse(localStorage.getItem('orca.files.placed.v1') ?? '[]').length === 1; } catch { return false; } }, null, { timeout: 20_000 });
    const path = await page.evaluate(() => (JSON.parse(localStorage.getItem('orca.files.placed.v1')!) as { path: string }[])[0]!.path);
    await page.evaluate((p) => window.__orca!.openFile!(p, { x: 700, y: 300 }), path);
    await page.waitForSelector('.file__img.is-width img', { timeout: 15_000 });
    await sleep(1200);
    const img = await page.evaluate(() => {
      const pan = document.querySelector<HTMLElement>('.file__img')!; const i = pan.querySelector('img')!;
      return { client: pan.clientHeight, scroll: pan.scrollHeight, imgW: i.clientWidth, panW: pan.clientWidth, meta: document.querySelector('[data-meta]')?.textContent ?? '' };
    });
    assert.equal(img.imgW, img.panW, 'the image takes the window\'s width');
    assert.ok(img.scroll > img.client, `the rest scrolls (${img.scroll} > ${img.client})`);
    assert.match(img.meta, /WIDTH$/);
    await page.evaluate(() => { document.querySelector<HTMLElement>('.file__img')!.scrollTop = 400; });
    await sleep(300);
    await page.screenshot({ path: join(SHOTS, 'file-viewer-03-image-scrolled.png') });

    assert.deepEqual(errors, [], 'no page errors');
    console.log('[file-viewer] ok');
  } finally {
    await browser.close();
    if (!keep) shutdown();
  }
}

main().catch((e) => { console.error(e); shutdown(); process.exit(1); });
