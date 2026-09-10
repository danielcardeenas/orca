/**
 * The CAPCOM thinking level in the SOUND window, isolated: no hub, no
 * collector, no session. It drives the real `mountSfx` over a real
 * `mountSound()` in a headless browser and checks the one thing the row must
 * be — an accessible level that starts silent, speaks its value, moves by
 * pointer and by key, follows the handle when somebody else turns it, never
 * touches the master, and explains itself as activity rather than a reply.
 *
 * Frames land in test/shots/sfx-thinking-*.png for the eye.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test, ok, type TestModule } from './harness.ts';
// Keep the browser fixture in the affected-import graph, the way window-canvas does.
import type * as Fixture from './sfx-thinking.fixture.ts';
type BrowserFixture = typeof Fixture;

const FIXTURE = '/test/sfx-thinking.fixture.ts';
const KEY = 'orca.sfx.capcom-thinking.vol.v1';

export default {
  suite: 'sfx-thinking',
  tests: [test('CAPCOM thinking level: silent by default, accessible, follows the handle, leaves the master alone', async () => {
    const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, reducedMotion: 'reduce' });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/sfx-fixture', (route) => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><html><head><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/window.css"></head>'
        + '<body style="background:var(--bezel);margin:0"><main class="win__body" style="display:flex;flex-direction:column;width:min(640px,calc(100vw - 20px));height:calc(100dvh - 24px);margin:12px auto"></main></body></html>' }));
      await page.route('**/api/**', (route) => route.abort());
      await page.routeWebSocket('**/*', (socket) => socket.close());
      await page.goto(`${server.resolvedUrls!.local[0]}sfx-fixture`);
      await page.evaluate(() => localStorage.clear());
      await page.evaluate(async (f) => { (window as any).fixture = await import(f); }, FIXTURE);

      const withFixture = <T>(fn: (f: BrowserFixture) => T) => page.evaluate(`(${fn.toString()})(window.fixture)`) as Promise<T>;
      const think = page.getByRole('slider', { name: 'CAPCOM' });
      const master = page.getByRole('slider', { name: 'master level' });
      const thinkN = page.locator('[data-c="think"] .vol__n');
      const said = () => think.getAttribute('aria-valuetext');
      const stored = () => page.evaluate((k) => localStorage.getItem(k), KEY);

      // Off until the operator says so, and it says so in words.
      assert.equal(await think.count(), 1, 'one CAPCOM thinking level on the deck');
      assert.equal(await think.getAttribute('aria-valuenow'), '0');
      assert.equal(await said(), 'silent');
      assert.equal(await thinkN.innerText(), 'OFF');
      assert.equal(await withFixture((f) => f.sound.thinkingVolume()), 0);
      const what = await page.locator('#sfx-think-what').innerText();
      assert.match(what, /NO REPLY CONFIRMED/, 'the copy says what the tick is not');
      assert.match(what, /STARTS PROCESSING/, 'and what it is: activity');
      assert.doesNotMatch(what, /DELIVER|RECEIVED|ANSWER|ARRIVED|TOOK YOUR LINE/, 'never a receipt');
      assert.equal(await think.getAttribute('aria-describedby'), 'sfx-think-what');
      assert.equal(await page.locator('.sfx__row:has-text("capcom.thinking") .sfx__what').innerText(), 'OBSERVED CAPCOM ACTIVITY');

      // Keys: End, arrows, Home — the same grammar as the master.
      await think.focus();
      await page.keyboard.press('End');
      assert.equal(await think.getAttribute('aria-valuenow'), '10');
      assert.equal(await thinkN.innerText(), '100%');
      assert.equal(await said(), '100 percent activity level');
      assert.equal(await withFixture((f) => f.sound.thinkingVolume()), 1);
      assert.equal(await stored(), '1');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await thinkN.innerText(), '90%');
      assert.equal(await withFixture((f) => f.sound.thinkingVolume()), 0.9);
      await page.keyboard.press('Home');
      assert.equal(await thinkN.innerText(), 'OFF');
      assert.equal(await said(), 'silent');
      assert.equal(await withFixture((f) => f.sound.thinkingVolume()), 0);
      assert.equal(await stored(), '0');

      // Pointer: the middle of the bar is the fifth cell.
      const box = (await think.boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.45, box.y + box.height / 2);
      assert.equal(await think.getAttribute('aria-valuenow'), '5');
      assert.equal(await thinkN.innerText(), '50%');
      assert.equal(await withFixture((f) => f.sound.thinkingVolume()), 0.5);
      assert.equal(await page.locator('[data-c="think"] .vol__cell.is-lit').count(), 5);

      // The master is its own knob: untouched by all of the above.
      assert.equal(await master.getAttribute('aria-valuenow'), '8');
      assert.equal(await withFixture((f) => f.sound.volume()), 0.8);
      assert.equal(await page.evaluate(() => localStorage.getItem('orca.sfx.vol.v1')), null);

      // Somebody else turned it: the row agrees within a beat.
      await withFixture((f) => f.sound.setThinkingVolume(0.3));
      await page.waitForFunction(() => document.querySelector('[data-c="think"] .vol__n')?.textContent === '30%');
      assert.equal(await said(), '30 percent activity level');

      await mkdir('test/shots', { recursive: true });
      for (const [name, width, height] of [['desktop', 1000, 900], ['mobile', 390, 844]] as const) {
        await page.setViewportSize({ width, height });
        await page.screenshot({ path: `test/shots/sfx-thinking-${name}.png` });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no sideways scroll`);
        assert.equal(await think.isVisible(), true, `${name}: the row is on the glass`);
      }

      // A level survives the window: the next mount shows what was stored.
      await withFixture((f) => f.mounted?.dispose());
      await page.reload();
      await page.evaluate(async (f) => { (window as any).fixture = await import(f); }, FIXTURE);
      assert.equal(await thinkN.innerText(), '30%');
      assert.equal(await think.getAttribute('aria-valuenow'), '3');

      assert.deepEqual(errors, []);
      return ok('silent default, aria value/text, keys, pointer, external sync, master untouched, copy, desktop/mobile, persistence', true);
    } finally { await browser.close(); await server.close(); }
  })],
} satisfies TestModule;
