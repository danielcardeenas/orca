import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test, ok, type TestModule } from './harness.ts';
// Keep the actual browser fixture in the affected-import graph.
import type * as Fixture from './minimap.fixture.ts';
type BrowserFixture = typeof Fixture;

/** The two inks the map draws a window with (hud/minimap.ts). */
const GREY = '#7a8078', INK = '#e6e9e2';

export default {
  suite: 'minimap',
  tests: [test('canvas windows on the radar: drawn, marked when out of view, and the map grows to hold them', async () => {
    const server = await createServer({ configFile: false, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 818 }, reducedMotion: 'reduce' });
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('**/minimap-fixture', route => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/hud.css"><link rel="stylesheet" href="/src/ui/styles/window.css"><body style="margin:0;background:#0b0a0d;overflow:hidden"></body>' }));
      await page.goto(`${server.resolvedUrls!.local[0]}minimap-fixture`);
      await page.evaluate(async () => { (window as any).fixture = await import('/test/minimap.fixture.ts' as string); });
      const change = async (fn: (f: BrowserFixture) => void) => {
        await page.evaluate(`(${fn.toString()})(window.fixture)`);
        // Two frames: the manager reprojects on one, the map redraws on the next.
        await page.evaluate(() => (window as any).fixture.tick());
        await page.waitForTimeout(60);
        await page.evaluate(() => (window as any).fixture.tick());
      };
      const ink = (hex: string) => page.evaluate((h) => (window as any).fixture.count(h), hex);

      await change(() => {});
      assert.equal(await ink(GREY), 0, 'Nothing open: the map draws no windows');

      // A window on the canvas is a place in the world, and the radar is where
      // an operator looks for places.
      await change(f => { f.seat('a', 0, 0); });
      const dashed = await ink(GREY);
      assert(dashed > 0, 'An open canvas window is on the map');

      // The same window, same seat, same map — only the camera has walked away
      // from it. On screen there is nothing left of it; on the map it goes
      // solid, which is the difference between a reminder and an answer.
      await change(f => { f.plane.origin.x -= 5000; });
      assert.equal(await page.evaluate(() => {
        const f = (window as any).fixture as BrowserFixture;
        return f.wm.seats()[0]!.off;
      }), true, 'It really is off the glass');
      const solid = await ink(GREY);
      assert(solid > dashed, `Out of view it is drawn solid, not dashed: ${solid} vs ${dashed}`);

      // The one holding the keyboard is picked out in ink; lime stays the
      // viewport's, so the two rectangles never argue.
      await change(f => { f.wm.focus(f.wm.all()[0]!); });
      assert(await ink(INK) > 0, 'The focused window is drawn in ink');
      assert.equal(await ink(GREY), 0, 'and stops being one of the grey ones');

      // A seat far outside the fleet is exactly the one worth finding, so the
      // map grows to hold it instead of cropping it away.
      await change(f => { f.plane.origin.x += 5000; f.seat('b', 60, 0); });
      const far = await page.evaluate(() => {
        const f = (window as any).fixture as BrowserFixture;
        const canvas = document.querySelector<HTMLCanvasElement>('.mmap [data-mm]')!;
        return { seats: f.wm.seats().length, w: canvas.width, drawn: f.count('#7a8078') };
      });
      assert.equal(far.seats, 2);
      assert(far.drawn > 0, 'The far window is drawn inside the map, not clipped off it');

      await mkdir('test/shots', { recursive: true });
      await page.locator('.mmap').screenshot({ path: 'test/shots/minimap-windows.png' });
      assert.deepEqual(errors, []);
      return ok('windows drawn, out-of-view solid, focused in ink, map grows to hold a far seat', true);
    } finally { await browser.close(); await server.close(); }
  })],
} satisfies TestModule;
