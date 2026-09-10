import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test, ok, type TestModule } from './harness.ts';
import type * as Fixture from './forge-field.fixture.ts';
type BrowserFixture = typeof Fixture;

export default {
  suite: 'forge-field',
  tests: [test('FORGE renders on the real field with lifecycle, squad ties and existing interaction', async () => {
    const server = await createServer({ configFile: false, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 818 }, reducedMotion: 'reduce' });
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await page.route('**/forge-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/field.css"><link rel="stylesheet" href="/src/ui/styles/sigil.css"><link rel="stylesheet" href="/src/ui/styles/squad.css"><body style="margin:0;background:#0b0a0d"><div class="field is-live"></div></body>' }));
      await page.goto(`${server.resolvedUrls!.local[0]}forge-fixture`);
      await page.evaluate(async () => { (window as any).fixture = await import('/test/forge-field.fixture.ts' as string); });
      const act = async <T,>(fn: (f: BrowserFixture) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.fixture)`);
      await page.waitForFunction(() => (window as any).fixture.field.stats().drawn === 5);
      await act(f => f.field.frameAll());
      const label = page.locator('.lbl').filter({ has: page.locator('.lbl__cs', { hasText: 'FORGE' }) });
      await label.waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await act(f => f.field.layout().spots.size), 5, 'No synthetic lead or duplicate node');
      assert.equal(await act(f => f.field.layout().spots.get('F1')!.scale), await act(f => f.field.layout().spots.get('C1')!.scale), 'FORGE has CAPCOM visual rank');
      assert(await act(f => {
        const lay = f.field.layout(), lead = lay.spots.get('F1')!;
        return lay.regions.every(r => Math.abs(lead.tx - r.cx) > r.hw + .5 * lead.scale || Math.abs(lead.ty - r.cy) > r.hh + .39 * lead.scale);
      }), 'FORGE stands outside project outlines');
      const forgeControl = page.locator('.rgn--forge');
      await forgeControl.waitFor();
      assert.equal(await forgeControl.count(), 1);
      await forgeControl.click();
      assert.deepEqual(await act(f => f.opened), ['F1'], 'Overview label opens the real lead');
      await act(f => { f.opened.length = 0; });
      assert((await act(f => f.field.stats().segments)) > 0, 'Squad and lineage pipes are drawn');
      await mkdir('test/shots', { recursive: true });
      for (const phase of ['WORKING', 'BLOCKED', 'VERIFYING', 'WAITING CAPCOM', 'WAITING', 'INACTIVE']) {
        await page.evaluate(p => (window as any).fixture.phase(p), phase);
        await page.waitForFunction(p => [...document.querySelectorAll('.squad__k')].some(e => e.textContent === `FORGE · ${p}`), phase);
        if (phase === 'VERIFYING' || phase === 'INACTIVE') await page.screenshot({ path: `test/shots/forge-${phase.toLowerCase()}.png` });
      }
      const rect = await act(f => f.field.screenOf('F1'));
      assert(rect);
      await page.mouse.click(rect.x + rect.w * .4, rect.y + rect.h * .5);
      assert.deepEqual(await act(f => f.opened), ['F1'], 'FORGE activation targets the real lead');
      await act(f => { f.field.select(['F1']); f.field.setFocus(true); });
      assert.deepEqual(await act(f => f.field.selection()), ['F1']);
      await page.mouse.move(600, 400);
      await page.keyboard.down('Control'); await page.mouse.wheel(0, 220); await page.keyboard.up('Control');
      await page.waitForTimeout(150);
      const zoomed = await act(f => f.field.screenOf('F1'));
      assert(zoomed);
      assert.notEqual(zoomed.w, rect.w, 'Existing wheel zoom still changes tile size');
      await forgeControl.waitFor({ state: 'visible' });
      await page.setViewportSize({ width: 390, height: 844 });
      await act(f => { f.field.setFocus(false); f.field.frameAll(); });
      await page.waitForTimeout(200);
      await page.screenshot({ path: 'test/shots/forge-mobile.png' });
      const mobileLabel = await forgeControl.boundingBox();
      assert(mobileLabel && mobileLabel.x >= 0 && mobileLabel.x + mobileLabel.width <= 390, 'Overview label stays inside mobile viewport');
      await forgeControl.focus();
      await page.keyboard.press('Enter');
      assert.deepEqual(await act(f => f.opened), ['F1', 'F1'], 'Overview label supports keyboard activation');
      await act(f => { f.lead.squad = null; f.field.feed(); });
      await forgeControl.waitFor({ state: 'detached' });
      assert.equal(await act(f => f.field.layout().spots.size), 5, 'Removing FORGE identity leaves the original agent');
      assert.deepEqual(errors, []);
      await act(f => f.field.dispose());
      return ok('six phases, real lead, pipes, click, focus, zoom and mobile; no hub or live sessions', true);
    } finally { await browser.close(); await server.close(); }
  })],
} satisfies TestModule;
