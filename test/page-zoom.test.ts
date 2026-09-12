/**
 * El único zoom es la cámara del campo.
 *
 * Cuatro canales de zoom nativo y un solo sitio donde se cierran. Lo que vale
 * la pena guardar: que ninguno de los cuatro escala la página, que la barrera
 * cancela sin tragarse el evento — el visor de imágenes sigue recibiendo su
 * pellizco — y que el reparto de la rueda entre ventana y campo suma el gesto
 * y no el doble.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { test, ok, type TestModule } from './harness.ts';
// Keep the actual browser fixture in the affected-import graph.
import type * as Fixture from './page-zoom.fixture.ts';
type F = typeof Fixture;

/** Lo justo de una rueda y de un acorde; ver el comentario en `wheel`. */
type Roll = { deltaX?: number; deltaY?: number; ctrlKey?: boolean; metaKey?: boolean };
type Chord = { key: string; code: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean };

export default {
  suite: 'page-zoom',
  tests: [test('native page zoom is shut on every channel, ours are not', async () => {
    const server = await createServer({ configFile: false, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('**/page-zoom-fixture', route => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><body></body>' }));
      await page.goto(`${server.resolvedUrls!.local[0]}page-zoom-fixture`);
      await page.evaluate(async () => { (window as any).fixture = await import('/test/page-zoom.fixture.ts' as string); });
      const run = <T,>(fn: (f: F) => T | Promise<T>): Promise<T> => page.evaluate(`(${fn.toString()})(window.fixture)`) as Promise<T>;

      /* ── Dedos y doble toque: `touch-action`, en toda la página ──── */
      // `pan-x pan-y` y no `none`: las listas siguen scrolleando con el dedo,
      // pero ni el pellizco ni el doble toque escalan nada.
      const declared = await page.evaluate(() => ({
        html: getComputedStyle(document.documentElement).touchAction,
        body: getComputedStyle(document.body).touchAction,
        field: getComputedStyle(document.querySelector('.field')!).touchAction,
      }));
      assert.deepEqual(declared, { html: 'pan-x pan-y', body: 'pan-x pan-y', field: 'none' },
        'El campo sigue siendo más estricto, y la intersección es lo que se aplica');
      /*
       * Mirar el valor computado de un descendiente no dice nada:
       * `touch-action` no se hereda, y el computado del HUD sigue siendo
       * `auto`. Lo que decide es la cadena — el navegador sube por los
       * ancestros y sólo concede el gesto si todos lo conceden. Eso es lo que
       * se comprueba aquí, elemento por elemento, como lo haría él.
       */
      const pinchable = (sel: string) => page.evaluate((s) => {
        for (let n: Element | null = document.querySelector(s as string); n; n = n.parentElement) {
          const ta = getComputedStyle(n).touchAction;
          if (ta !== 'auto' && ta !== 'manipulation' && !ta.includes('pinch-zoom')) return false;
        }
        return true;
      }, sel);
      for (const sel of ['.tool', '.field', '[data-strays]', '[data-img]', 'body']) {
        assert.equal(await pinchable(sel), false, `Dos dedos sobre ${sel} no escalan la página`);
      }
      // Y el scroll con el dedo, que es lo que `none` en todo se habría llevado.
      assert.equal(await page.evaluate(() => {
        const ta = getComputedStyle(document.querySelector('[data-strays]')!.parentElement!).touchAction;
        return ta.includes('pan-y') || ta === 'auto';
      }), true, 'Una lista sigue scrolleándose con el dedo');

      /* ── Trackpad: el pellizco llega como rueda con ctrl ─────────── */
      // Los `…EventInit` del DOM llevan `view?: Window` colgando, y pasarlos
      // por `evaluate` hace que el tipo de la serialización no termine nunca.
      // Aquí sólo hacen falta estos campos.
      const wheel = (sel: string, init: Roll) => page.evaluate((a: { sel: string; init: Roll }) => {
        const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...a.init });
        document.querySelector(a.sel)!.dispatchEvent(e);
        return e.defaultPrevented;
      }, { sel, init });
      for (const sel of ['.field', '.tool', '[data-strays]', 'body']) {
        assert.equal(await wheel(sel, { deltaY: -40, ctrlKey: true }), true, `Un pellizco sobre ${sel} no escala la página`);
      }
      assert.equal(await wheel('.tool', { deltaY: -40, metaKey: true }), true, '⌘+rueda tampoco');
      // Una rueda a secas es un paneo, aquí y en el campo: intacta.
      assert.equal(await wheel('.tool', { deltaY: -40 }), false, 'Una rueda normal se deja pasar entera');

      /* ── Safari/WebKit: el gesto nativo ignora `touch-action` ────── */
      const gesture = (type: string) => page.evaluate((t) => {
        const e = new Event(t as string, { bubbles: true, cancelable: true });
        document.querySelector('.tool')!.dispatchEvent(e);
        return e.defaultPrevented;
      }, type);
      for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
        assert.equal(await gesture(t), true, `${t} cancelado`);
      }

      /* ── Teclado ─────────────────────────────────────────────────── */
      const key = (init: Chord) => page.evaluate((i: Chord) => {
        const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i });
        document.body.dispatchEvent(e);
        return e.defaultPrevented;
      }, init);
      for (const i of [
        { key: '+', code: 'Equal', metaKey: true }, { key: '=', code: 'Equal', metaKey: true },
        { key: '-', code: 'Minus', metaKey: true }, { key: '0', code: 'Digit0', metaKey: true },
        { key: '+', code: 'NumpadAdd', ctrlKey: true }, { key: '0', code: 'Numpad0', ctrlKey: true },
      ]) assert.equal(await key(i), true, `${JSON.stringify(i)} no escala la página`);
      // Lo que no es el zoom del navegador sigue siendo de quien lo pidió.
      assert.equal(await key({ key: 'k', code: 'KeyK', metaKey: true }), false, '⌘K es de la línea de órdenes');
      assert.equal(await key({ key: '0', code: 'Digit0' }), false, 'Un 0 a secas es un 0');
      assert.equal(await key({ key: '0', code: 'Digit0', metaKey: true, altKey: true }), false, '⌘⌥0 es otro acorde');

      /* ── Y el zoom propio del visor, intacto ─────────────────────── */
      // La barrera cancela la acción por defecto y no se traga el evento: por
      // eso va en captura y sin `stopPropagation`. El visor para el pellizco
      // en su propio panel y sigue zoomando la imagen y sólo la imagen.
      assert.equal(await wheel('[data-img]', { deltaY: -40, ctrlKey: true }), true, 'Cancelado para el navegador');
      assert.equal(await run(f => f.pinched.pane), 1, 'y entregado al visor igualmente');

      /* ── El reparto de la rueda ──────────────────────────────────── */
      const px = await run(f => f.wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }));
      assert.deepEqual(px, { dx: 0, dy: 54 }, 'Líneas a píxeles con el paso del campo');

      const chained = await run((f) => {
        const box = document.querySelector<HTMLElement>('[data-box]')!;
        const out: Array<{ top: number; rest: number }> = [];
        // Dónde se pone el scroll antes de cada rueda (`null` = donde quedó).
        const plan: Array<[number | null, number]> = [
          [0, 120],     // cabe entero
          [280, 120],   // quedan 20 de 300: se lleva 20 y sobran 100
          [null, 120],  // agotado: sobra todo
          [0, -120],    // arriba del todo: sobra todo, hacia el otro lado
        ];
        for (const [set, dy] of plan) {
          if (set !== null) box.scrollTop = set;
          const s = f.share(box.firstElementChild, document.body, 0, dy);
          f.spend(s.take);
          out.push({ top: box.scrollTop, rest: Math.round(s.dy) });
        }
        return out;
      });
      assert.deepEqual(chained, [
        { top: 120, rest: 0 },
        { top: 300, rest: 100 },
        { top: 300, rest: 120 },
        { top: 0, rest: -120 },
      ], 'La ventana se lleva lo que puede y el resto sale entero, una sola vez');

      // La lista de restos vive en una ventana, así que cede: `contain` ahí
      // dejaba el gesto muerto, porque su padre en el DOM tampoco scrollea.
      const strays = await run((f) => {
        const list = document.querySelector<HTMLElement>('[data-strays]')!;
        list.scrollTop = list.scrollHeight;
        return {
          behavior: getComputedStyle(list).overscrollBehaviorY,
          rest: f.share(list.firstElementChild, document.body, 0, 90).dy,
        };
      });
      assert.equal(strays.behavior, 'auto');
      assert.equal(strays.rest, 90, 'Agotada, la lista de restos pasa el gesto adelante');

      assert.deepEqual(errors, []);
      return ok('touch, trackpad, WebKit gestures and ⌘+/-/0 shut; viewer zoom and wheel sharing intact', true);
    } finally { await browser.close(); await server.close(); }
  })],
} satisfies TestModule;
