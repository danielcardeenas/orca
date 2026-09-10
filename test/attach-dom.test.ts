/**
 * ui/windows/attach.ts en Chromium — el gesto entero, no sólo la inserción.
 *
 * Lo que vale la pena guardar: un archivo sobre la caja la marca (`is-drop`,
 * y el CSS lo pinta a rayas); soltarlo sube y escribe la ruta donde estaba el
 * cursor y dispara `input` una vez; pegar un archivo hace lo mismo y pegar
 * texto no se toca; una caja deshabilitada avisa en vez de subir; un fallo
 * de subida es un aviso y las demás rutas llegan; y un archivo soltado fuera
 * de toda caja no se convierte en la página.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { test, ok, type TestModule } from './harness.ts';
// Keep the actual browser fixture in the affected-import graph.
import type * as Fixture from './attach.fixture.ts';
type F = typeof Fixture;

export default {
  suite: 'attach-dom',
  tests: [test('drag, drop, paste and the stray-drop guard, in a real DOM', async () => {
    const server = await createServer({ configFile: false, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/attach-fixture', (route) => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/window.css"><body style="margin:0;background:var(--bezel)"></body>' }));
      await page.goto(`${server.resolvedUrls!.local[0]}attach-fixture`);
      await page.evaluate(async () => { (window as any).fixture = await import('/test/attach.fixture.ts' as string); });
      const run = <T,>(fn: (f: F) => T | Promise<T>): Promise<T> => page.evaluate(`(${fn.toString()})(window.fixture)`) as Promise<T>;

      // Sobre la caja: marcada y a rayas. Fuera: limpia.
      const over = await run((f) => {
        f.fire(f.host, 'dragenter', ['a.pdf']);
        const claimed = f.fire(f.host, 'dragover', ['a.pdf']);
        return { claimed, marked: f.host.classList.contains('is-drop'), border: getComputedStyle(f.box).borderStyle };
      });
      assert.equal(over.claimed, true); assert.equal(over.marked, true); assert.equal(over.border, 'dashed');
      const left = await run((f) => { f.fire(f.host, 'dragleave', ['a.pdf']); return f.host.classList.contains('is-drop'); });
      assert.equal(left, false);

      // Soltar dos archivos con texto delante: rutas separadas, caret al final, un `input`.
      const dropped = await run(async (f) => {
        f.box.value = 'mira'; f.box.setSelectionRange(4, 4);
        f.fire(f.host, 'dragenter', ['a.pdf', 'b.png']);
        f.fire(f.host, 'drop', ['a.pdf', 'b.png']);
        await f.settle();
        return { value: f.box.value, caret: f.box.selectionStart, inputs: f.inputs, uploads: f.uploads.join(), marked: f.host.classList.contains('is-drop'), focused: document.activeElement === f.box };
      });
      assert.equal(dropped.value, 'mira /up/a.pdf /up/b.png');
      assert.equal(dropped.caret, dropped.value.length);
      assert.equal(dropped.inputs, 1);
      assert.equal(dropped.uploads, 'a.pdf,b.png');
      assert.equal(dropped.marked, false);
      assert.equal(dropped.focused, true);

      // Pegar un archivo: igual. Pegar texto: el navegador sigue a lo suyo.
      const pasted = await run(async (f) => {
        f.box.value = ''; f.box.setSelectionRange(0, 0);
        const claimed = f.paste(['shot.png']);
        await f.settle();
        const plain = f.paste([]);
        return { claimed, plain, value: f.box.value };
      });
      assert.equal(pasted.claimed, true); assert.equal(pasted.plain, false); assert.equal(pasted.value, '/up/shot.png');

      // Un fallo entre tres: dos rutas y un aviso.
      const partial = await run(async (f) => {
        f.box.value = ''; f.fire(f.host, 'drop', ['c.pdf', 'fail.bin', 'd.pdf']); await f.settle();
        return { value: f.box.value, notes: f.notes.join('|') };
      });
      assert.equal(partial.value, '/up/c.pdf /up/d.pdf');
      assert.match(partial.notes, /fail\.bin not uploaded/);

      // Caja deshabilitada: nada sube, se avisa.
      const disabled = await run(async (f) => {
        f.box.disabled = true; f.box.value = ''; const n = f.uploads.length;
        f.fire(f.host, 'drop', ['e.pdf']); await f.settle();
        f.box.disabled = false;
        return { value: f.box.value, uploaded: f.uploads.length - n, note: f.notes.at(-1) ?? '' };
      });
      assert.equal(disabled.value, ''); assert.equal(disabled.uploaded, 0); assert.match(disabled.note, /cannot take files/);

      // Fuera de toda caja: reclamado para que no navegue; sin la guarda, no.
      const stray = await run((f) => {
        const guarded = f.fire(document.body, 'drop', ['x.pdf']);
        f.unguard();
        const bare = f.fire(document.body, 'drop', ['x.pdf']);
        return { guarded, bare };
      });
      assert.equal(stray.guarded, true); assert.equal(stray.bare, false);

      // Soltado, la caja ya no escucha.
      const after = await run(async (f) => { f.unbind(); f.box.value = ''; f.fire(f.host, 'drop', ['z.pdf']); await f.settle(); return f.box.value; });
      assert.equal(after, '');
      assert.deepEqual(errors, []);
      return ok('attach in Chromium', true);
    } finally {
      await browser.close();
      await server.close();
    }
  })],
} satisfies TestModule;
