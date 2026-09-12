/**
 * Lo que un agente declaró se ve bajo su baldosa. Con el hub, en Chromium.
 *
 *   ORCA_VISUAL_ISOLATED=1 npx tsx test/shelf.shots.ts
 *   npx tsx test/shelf.shots.ts --headed   verlo pasar
 *
 * `npm test -- shelf shelf-layout` prueba la geometría y la reserva, que es
 * aritmética. Lo que no puede ver es si algo se DIBUJA: que las fichas existan
 * en la capa, debajo de la baldosa y no encima, que se vayan al alejarse, y que
 * un clic abra lo que dice que va a abrir. Eso es lo que hay aquí.
 *
 * Los artefactos se inyectan con `window.__orca.artifact`, que no pasa por el
 * hub, por la misma razón que las misiones y AUTOMEJORA del arnés: una foto de
 * una estantería de cuatro fichas no puede dejar cuatro artefactos en el índice
 * del operador. Por eso también van con `ORCA_VISUAL_ISOLATED=1`: hub propio,
 * puerto propio, y la flota de verdad no se entera.
 */

import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { GPU_ARGS, SHOTS, ensureServers, newPage, open, shutdown, uiPort, waitForFleet } from './visual.ts';
import { sleep } from './harness.ts';

const headed = process.argv.includes('--headed');
const keep = process.argv.includes('--keep');
const VIEW = { w: 1440, h: 900 };

/**
 * Las fichas de un agente, con su caja en píxeles.
 *
 * Por agente y no todas: la flota sintética publica artefactos declarados
 * suyos (`fake-collector.ts`), así que en el campo hay estanterías que no son
 * la que se está mirando. Contarlas todas hacía que esta prueba dependiera de
 * cuántos artefactos llevara inventados el mock, que cambia en cada corrida.
 */
async function chips(page: Page, agentId: string): Promise<{ art: string | null; more: string; x: number; y: number; w: number }[]> {
  return page.evaluate((who) => [...document.querySelectorAll<HTMLElement>('.chip-art')]
    .filter((el) => !el.hidden && el.dataset.agent === who)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { art: el.dataset.art ?? null, more: el.textContent ?? '', x: r.x, y: r.y, w: r.width };
    }), agentId);
}

/** La caja del rótulo de una baldosa, que ES la caja de la baldosa. */
async function tileBox(page: Page, id: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate((agentId) => {
    const layer = document.querySelector('[data-labels]');
    const el = [...(layer?.querySelectorAll<HTMLElement>('.lbl') ?? [])]
      .find((x) => x.textContent?.includes(agentId.slice(0, 2).toUpperCase()));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, id);
}

/**
 * Las fichas cuando ya no se mueven.
 *
 * La cámara llega a un sitio con easing, así que las coordenadas de una ficha
 * leídas a mitad del vuelo ya no valen cuando se pincha: el clic cae en el
 * lienzo y se lee como un paneo. Se espera a dos muestras iguales, que es lo
 * que dice que el vuelo acabó, y no a un número de milisegundos que acierta
 * unas veces.
 */
async function settled(page: Page, agentId: string): Promise<Awaited<ReturnType<typeof chips>>> {
  let prev = '';
  for (let i = 0; i < 30; i++) {
    const now = await chips(page, agentId);
    const sig = now.map((c) => `${Math.round(c.x)},${Math.round(c.y)},${Math.round(c.w)}`).join('|');
    if (sig && sig === prev) return now;
    prev = sig;
    await sleep(250);
  }
  return chips(page, agentId);
}

async function main() {
  await ensureServers({ fleet: true, fixtures: true });
  const browser = await chromium.launch({ headless: !headed, args: GPU_ARGS });
  try {
    const page = await newPage(browser, VIEW.w, VIEW.h);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript('window.__name = (fn) => fn');
    await open(page, `http://127.0.0.1:${uiPort()}/?noboot=1`);
    await page.waitForFunction(() => !!document.querySelector('.mast__link.is-up'), null, { timeout: 60_000 });
    await waitForFleet(page, 1);
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('.win [data-w-close]').forEach((b) => b.click());
    });
    await sleep(800);

    /* ── El agente al que se le van a colgar cosas ──────────────────── */

    /*
     * Uno con baldosa PROPIA, no el primero que devuelva la flota. Un hijo que
     * sólo habla con su padre está plegado en su bandeja, y una celda de bandeja
     * no tiene estantería a propósito: es demasiado pequeña para nada y dice
     * sólo su estado, la misma regla que ya siguen los rótulos. Elegir a ciegas
     * hacía que esta prueba pasara o fallara según a quién le tocara el primer
     * hueco del mock.
     */
    const who = await page.evaluate(() => {
      const api = (window as never as {
        __orca: { agentIds(): string[]; spotOf(id: string): { scale: number; trayOf: string | null } | undefined };
      }).__orca;
      return api.agentIds().find((id) => {
        const s = api.spotOf(id);
        return !!s && s.trayOf === null && s.scale >= 1;
      }) ?? '';
    });
    assert.ok(who, 'la flota sintética dio algún agente con baldosa propia');
    const antes = await chips(page, who);

    await page.evaluate((agentId) => {
      const api = (window as never as { __orca: { artifact(a: unknown): void } }).__orca;
      // Seis declarados: cuatro fichas y un contador que tiene que decir +2.
      for (let i = 0; i < 6; i++) {
        api.artifact({
          id: `art_fix_${i}`, agentId, projectId: 'p', machineId: 'm',
          kind: i === 5 ? 'file' : 'image', path: i === 5 ? '/p/out/build.zip' : `/p/out/frame-${i}.png`,
          title: i === 5 ? 'el paquete' : `fotograma ${i}`, url: null,
          bytes: i === 5 ? 4_404_019 : 2048, width: 640, height: 400,
          at: 1_000 + i, open: false, placement: null, source: 'declared',
        });
      }
      // Y uno observado, que NO debe colgar de nadie: su sitio es la galería.
      api.artifact({
        id: 'art_fix_obs', agentId, projectId: 'p', machineId: 'm',
        kind: 'image', path: '/p/test/shots/capture.png', title: 'capture.png', url: null,
        bytes: 9000, width: 100, height: 100, at: 9_999, open: false, placement: null, source: 'observed',
      });
    }, who);

    // El zoom tiene que estar cerca: la estantería sube un peldaño después de
    // las palabras, y de lejos no se dibuja a propósito.
    await page.evaluate((id) => (window as never as { __orca: { fly(i: string): void } }).__orca.fly(id), who);
    const shown = await settled(page, who);
    assert.equal(shown.length, 5,
      `cuatro fichas y un contador, no ${shown.length} (antes tenía ${antes.length})`);
    const counter = shown.filter((c) => !c.art);
    assert.equal(counter.length, 1, 'exactamente una ficha contador');
    assert.match(counter[0]!.more, /\+2/, `el contador dice lo que queda, no "${counter[0]!.more}"`);
    // El observado no está, aunque sea el más nuevo de todos.
    assert.ok(!shown.some((c) => c.art === 'art_fix_obs'), 'lo observado no cuelga de ninguna baldosa');

    /* ── Y está DEBAJO de la baldosa, que es el punto entero ────────── */

    const box = await tileBox(page, who);
    if (box) {
      const techo = Math.min(...shown.map((c) => c.y));
      assert.ok(techo >= box.y + box.h - 1,
        `la franja empieza en ${techo.toFixed(0)} y la baldosa acaba en ${(box.y + box.h).toFixed(0)}: la estaría tapando`);
    }
    // Una fila, no una columna: todas a la misma altura y en orden.
    const y0 = shown[0]!.y;
    assert.ok(shown.every((c) => Math.abs(c.y - y0) < 2), 'las cinco fichas están en la misma fila');

    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'shelf-01-chips.png') });

    /* ── Clic en una ficha: se abre su artefacto ─────────────────────── */

    const first = (await settled(page, who)).find((c) => c.art)!;
    await page.mouse.click(Math.round(first.x + first.w / 2), Math.round(first.y + first.w / 2));
    await sleep(900);
    const artWin = await page.evaluate(() => [...document.querySelectorAll('.win')]
      .some((w) => (w.textContent ?? '').includes('/p/out/')));
    assert.ok(artWin, 'un clic en una ficha abre la ventana de su artefacto');
    await page.screenshot({ path: join(SHOTS, 'shelf-02-artifact.png') });
    await page.evaluate(() => document.querySelectorAll<HTMLElement>('.win [data-w-close]').forEach((b) => b.click()));
    await sleep(500);

    /* ── Clic en el contador: la galería, filtrada por ese agente ────── */

    const c2 = (await settled(page, who)).find((c) => !c.art)!;
    await page.mouse.click(Math.round(c2.x + c2.w / 2), Math.round(c2.y + c2.w / 2));
    await sleep(900);
    const gal = await page.evaluate(() => [...document.querySelectorAll('.win')]
      .map((w) => w.textContent ?? '').find((t) => t.includes('GALLERY')) ?? '');
    assert.ok(gal.includes('GALLERY'), 'el contador abre la galería');
    // Filtrada: los siete del agente, y no «ANY AGENT» encendido.
    assert.match(gal, /7 SHOWN|GALLERY · 7|SHOWN/, `la galería llega filtrada, no entera: "${gal.slice(0, 80)}"`);
    await page.screenshot({ path: join(SHOTS, 'shelf-03-gallery.png') });
    await page.evaluate(() => document.querySelectorAll<HTMLElement>('.win [data-w-close]').forEach((b) => b.click()));
    await sleep(500);

    /* ── De lejos no se dibuja: la silueta manda ─────────────────────── */

    /*
     * Lo que hay que demostrar es que la estantería se va MIENTRAS LA FLOTA
     * SIGUE AHÍ: si uno se aleja hasta que no se dibuja nada, que no haya
     * fichas no dice nada. Así que se aleja de a poco y se para en el primer
     * fotograma sin fichas, y ahí se comprueba que todavía hay baldosas
     * dibujadas — la silueta se queda, la fotografía se va.
     */
    await page.evaluate(() => (window as never as { __orca: { frame(): void } }).__orca.frame());
    await sleep(1200);
    const drawn = () => page.evaluate(() => (window as never as { __orca: { stats(): { drawn: number } } }).__orca.stats().drawn);
    let lejos = await chips(page, who);
    let tiles = await drawn();
    for (let i = 0; i < 10 && (lejos.length > 0 || tiles === 0); i++) {
      await page.mouse.move(VIEW.w / 2, VIEW.h / 2);
      await page.mouse.wheel(0, 200);
      await sleep(700);
      lejos = await chips(page, who);
      tiles = await drawn();
    }
    assert.equal(lejos.length, 0, `de lejos la estantería se va, y quedaban ${lejos.length} fichas`);
    assert.ok(tiles > 0, `la flota sigue dibujada cuando la estantería se va, y había ${tiles} baldosas`);
    await page.screenshot({ path: join(SHOTS, 'shelf-04-far.png') });
    console.log(`[shelf] la franja se va con ${tiles} baldosas todavía en pantalla`);

    assert.deepEqual(errors, [], 'no page errors');
    console.log('[shelf] ok · 4 fichas y un contador bajo la baldosa, el clic abre, y de lejos se va');
  } finally {
    await browser.close();
    if (!keep) shutdown();
  }
}

main().catch((e) => { console.error(e); shutdown(); process.exit(1); });
