/**
 * Los ganchos de gesto en Chromium: el gestor de ventanas y la barra de
 * secciones de verdad, con el contador de la consola detrás.
 *
 * Lo que vale la pena guardar: abrir una ventana cuenta su clase; volver a
 * una ya abierta no; lo que la sesión restaura sola no; abrir una hoja cuenta
 * y cerrarla no; todo sale en un solo lote, y un lote que el enlace no dejó
 * salir se queda y sale entero después.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { test, ok, type TestModule } from './harness.ts';
// Keep the actual browser fixture in the affected-import graph.
import type * as Fixture from './gestures.fixture.ts';
type F = typeof Fixture;

export default {
  suite: 'gestures-dom',
  tests: [test('windows, sheets and batches, in a real DOM', async () => {
    const server = await createServer({ configFile: false, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/gestures-fixture', (route) => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/window.css"><link rel="stylesheet" href="/src/ui/styles/hud.css"><body style="margin:0;background:var(--bezel)"></body>' }));
      await page.goto(`${server.resolvedUrls!.local[0]}gestures-fixture`);
      await page.evaluate(async () => { (window as any).fixture = await import('/test/gestures.fixture.ts' as string); });
      const run = <T,>(fn: (f: F) => T | Promise<T>): Promise<T> => page.evaluate(`(${fn.toString()})(window.fixture)`) as Promise<T>;

      // Abrir cuenta la clase; volver a la misma clave es un foco, no un gesto.
      const opened = await run((f) => {
        f.wm.open({ kind: 'help', key: 'help', callsign: 'HELP' });
        f.wm.open({ kind: 'help', key: 'help', callsign: 'HELP' });
        f.wm.open({ kind: 'terminal', key: 'term:a1', callsign: 'K9', params: { agentId: 'a1' } });
        f.wm.open({ kind: 'terminal', key: 'term:a2', callsign: 'K10', params: { agentId: 'a2' } });
        return { windows: f.wm.all().length };
      });
      assert.equal(opened.windows, 3);

      // Lo que la sesión restaura sola no lo tocó nadie.
      const restored = await run((f) => {
        f.saveSession(['gallery', 'gallery']);
        f.wm.restoreSession((spec) => f.wm.open(spec));
        return { windows: f.wm.all().length };
      });
      assert.equal(restored.windows, 5);

      // Una hoja: abrir cuenta, cerrar no, abrir la otra cuenta.
      await run((f) => {
        f.sections.open('improve');
        f.sections.toggle('improve');
        f.sections.open('missions');
        f.sections.close();
      });

      // Todo sale en un solo lote, con nombres y cuentas y nada más.
      const sent = await run((f) => { const out = f.flush(); return { out, batches: f.batches }; });
      assert.equal(sent.out, true);
      assert.deepEqual(sent.batches, [{
        'gesture:win:help': 1, 'gesture:win:terminal': 2,
        'gesture:hud:sheet-improve': 1, 'gesture:hud:sheet-missions': 1,
      }]);

      // Con el enlace caído el lote se queda; vuelve el enlace y sale entero.
      const held = await run((f) => {
        f.setLink(false);
        f.wm.open({ kind: 'gallery', key: 'gallery', callsign: 'GALLERY' });
        const refused = f.flush();
        f.wm.open({ kind: 'help', key: 'help:2', callsign: 'HELP' });
        f.setLink(true);
        const ok = f.flush();
        return { refused, ok, last: f.batches.at(-1), n: f.batches.length };
      });
      assert.equal(held.refused, false); assert.equal(held.ok, true); assert.equal(held.n, 2);
      assert.deepEqual(held.last, { 'gesture:win:gallery': 1, 'gesture:win:help': 1 });

      assert.deepEqual(errors, []);
      return ok('gestures in a real DOM', true);
    } finally {
      await browser.close();
      await server.close();
    }
  })],
} satisfies TestModule;
