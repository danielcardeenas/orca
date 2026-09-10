import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { test, ok, type TestModule } from './harness.ts';
import type * as Fixture from './capcom-thinking-audio.fixture.ts';
type F = typeof Fixture;
export default {
  suite: 'CAPCOM thinking audio lifecycle',
  tests: [test('optional audio, delivery separation, bounded playback and cancellation', async () => {
    const server = await createServer({ configFile: false, server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('**/audio-fixture', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
      await page.route('**/api/**', r => r.abort());
      await page.routeWebSocket('**/*', s => s.close());
      await page.addInitScript('window.__name = fn => fn');
      await page.goto(`${server.resolvedUrls!.local[0]}audio-fixture`);
      await page.evaluate(async () => { (window as any).f = await import('/test/capcom-thinking-audio.fixture.ts' as string); });
      const change = async (fn: (f: F) => void) => { await page.evaluate(`(${fn.toString()})(window.f)`); await page.waitForTimeout(40); };
      const count = () => page.evaluate(() => (window as any).f.starts.length);
      assert.equal(await page.evaluate(() => (window as any).f.sound.thinkingVolume()), 0);
      await change(f => { f.reset(); f.request('silent'); f.state('thinking'); });
      assert.equal(await count(), 0, 'opt-in default');
      await change(f => { f.sound.setThinkingVolume(0.4); f.reset(); f.request('on'); f.state('thinking'); });
      assert.equal(await count(), 1);
      assert.deepEqual(await page.evaluate(() => (window as any).f.starts[0]), [0, 0, 0.18]);
      await change(f => { f.state('working'); f.delivery(); f.state('idle'); f.state('thinking'); });
      assert.equal(await count(), 1, 'no repeat and no receipt cue');
      await change(f => { f.reset(); f.request('receipt'); f.delivery(); });
      assert.equal(await count(), 0, 'receipt alone stays silent');
      await change(f => { f.link(false); f.state('thinking'); f.link(true); f.state('working'); });
      assert.equal(await count(), 0, 'reconnect does not replay');
      await change(f => { f.reset(false, false); f.request('gesture'); f.state('thinking'); });
      assert.equal(await count(), 0, 'no sound before a user gesture');
      await change(f => { window.dispatchEvent(new Event('pointerdown')); f.state('working'); });
      assert.equal(await count(), 0, 'gesture does not replay consumed activity');
      await change(f => { f.reset(); f.booting(true); f.request('boot'); f.state('thinking'); f.booting(false); f.state('working'); });
      assert.equal(await count(), 0, 'boot baseline is silent');
      await change(f => { f.reset(); f.request('snapshot'); f.snapshot(); f.state('thinking'); });
      assert.equal(await count(), 0, 'world snapshot consumes earlier outgoing messages');
      await change(f => { f.reset(true); f.request('expired'); f.state('thinking'); });
      await page.waitForFunction(() => !!(window as any).f.release);
      await page.waitForTimeout(1050);
      await change(f => f.release!());
      assert.equal(await count(), 0, 'slow decode expires instead of announcing late activity');
      for (const cancel of ['mute', 'volume', 'level', 'idle', 'error', 'disconnect', 'auth', 'dispose', 'hidden'] as const) {
        await change(f => { f.sound.setMuted(false); f.sound.setVolume(0.8); f.sound.setThinkingVolume(0.4); f.reset(true); f.request('slow'); f.state('thinking'); });
        await page.waitForFunction(() => !!(window as any).f.release);
        await page.evaluate(action => {
          const f = (window as any).f as F;
          if (action === 'mute') f.sound.setMuted(true);
          if (action === 'volume') f.sound.setVolume(0);
          if (action === 'level') f.sound.setThinkingVolume(0);
          if (action === 'idle') f.state('idle');
          if (action === 'error') f.state('blocked');
          if (action === 'disconnect') f.link(false);
          if (action === 'auth') f.auth(false);
          if (action === 'dispose') f.sound.dispose();
          if (action === 'hidden') { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }
          f.release!();
        }, cancel);
        await page.waitForTimeout(40);
        assert.equal(await count(), 0, `pending decode cancelled by ${cancel}`);
        await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); });
      }
      await change(f => { f.sound.setMuted(false); f.sound.setVolume(0.8); f.sound.setThinkingVolume(0.4); f.reset(); f.request('playing'); f.state('thinking'); });
      assert.equal(await count(), 1);
      await change(f => f.state('idle'));
      assert.equal(await page.evaluate(() => (window as any).f.stops > 0), true, 'ready stops playing cue');
      await change(f => { f.sound.setThinkingVolume(NaN); f.sound.dispose(); });
      assert.deepEqual(errors, []);
      return ok('isolated fake Web Audio and store lifecycle', true);
    } finally { await browser.close(); await server.close(); }
  })],
} satisfies TestModule;
