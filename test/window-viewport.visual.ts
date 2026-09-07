/** Existing Vite server; isolated page, synthetic terminal, no agent commands. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const shots = '/private/tmp/orca-task08-window';
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 818 }, reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', route => route.abort());
  await page.route('**/window-viewport-fixture', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/window.css"><body style="margin:0;background:var(--bezel)"></body>' }));
  await page.addInitScript('window.__name = fn => fn');
  await page.goto('http://127.0.0.1:4478/window-viewport-fixture');
  await page.evaluate(async () => { (window as any).fixture = await import('/test/window-viewport.fixture.ts' as string); });
  await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
  await page.waitForTimeout(500);
  const state = () => page.evaluate(() => {
    const { win: w, transport } = (window as any).fixture;
    const r = w.el.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height,
      ax: w.ax, ay: w.ay, anchor: w.spec.anchor, ...transport };
  });
  const fits = async (mobile = false) => {
    const s = await state(), v = page.viewportSize()!;
    assert(s.x >= (mobile ? 0 : 8) && s.right <= v.width - (mobile ? 0 : 8), JSON.stringify(s));
    assert(s.y >= 44 && s.bottom <= v.height - (mobile ? 60 : 100), JSON.stringify(s));
    for (const selector of ['[data-w-close]', '[data-w-min]', '[data-w-pin]', '[data-view="terminal"]', '[data-act] button', '[data-stop]']) {
      const b = await page.locator(selector).boundingBox();
      assert(b && b.x >= 0 && b.x + b.width <= v.width && b.y + b.height <= v.height);
      await page.locator(selector).click({ trial: true });
    }
    return s;
  };
  if (process.argv.includes('--before')) {
    const s = await state();
    assert(s.right > 1200, 'Fixture must reproduce the original clipping');
    await page.screenshot({ path: `${shots}/before-1200.png` });
    console.log('Reproduced:', s);
  } else {
    const initial = await fits();
    await page.screenshot({ path: `${shots}/after-1200.png` });
    for (const x of [0, -200, 900, 1300, -600, 426]) {
      await page.evaluate(x => { (window as any).fixture.tile.x = x; }, x);
      await page.waitForTimeout(80);
      const s = await fits();
      assert.equal(s.ax, initial.ax); assert.equal(s.ay, initial.ay);
      assert.equal(s.w, initial.w); assert.equal(s.h, initial.h);
      assert.equal(s.resizes, initial.resizes, 'Panning must not resize the terminal');
      if (x === -200) assert.equal(s.x, 166, 'Returns to the original anchor offset when space permits');
    }
    await page.waitForTimeout(150);
    assert.deepEqual(await state(), initial, 'Repeated projections must be stable');
    // Drag the actual header: the next projection must retain the new offset.
    await page.mouse.move(initial.x + 100, initial.y + 15);
    await page.mouse.down(); await page.mouse.move(initial.x + 20, initial.y + 30); await page.mouse.up();
    const dragged = await fits();
    assert.notEqual(dragged.ax, initial.ax);
    await page.waitForTimeout(100); assert.deepEqual(await state(), dragged);
    // Docking freezes screen position; pinning resumes following the tile.
    await page.locator('[data-w-pin]').click();
    await page.waitForTimeout(100);
    const docked = await state(); assert.equal(docked.anchor, null);
    await page.evaluate(() => { (window as any).fixture.tile.x -= 100; });
    await page.waitForTimeout(80); assert.deepEqual(await state(), docked);
    await page.locator('[data-w-pin]').click();
    await page.waitForTimeout(80); assert.equal((await state()).anchor, 'viewport-fixture');
    await page.locator('[data-w-min]').click();
    await page.evaluate(() => { const f = (window as any).fixture; f.wm.restore(f.win); });
    await fits();
    const grip = await page.locator('.win__grip').boundingBox();
    assert(grip);
    const beforeResize = await state();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down(); await page.mouse.move(grip.x + grip.width / 2 - 40, grip.y + grip.height / 2 - 40); await page.mouse.up();
    await page.waitForTimeout(200);
    const resized = await fits();
    assert.equal(resized.w, beforeResize.w - 40); assert.equal(resized.h, beforeResize.h - 40);
    for (const viewport of [{ width: 760, height: 650 }, { width: 390, height: 700 }, { width: 1200, height: 818 }]) {
      await page.setViewportSize(viewport); await page.waitForTimeout(300);
      await fits(viewport.width <= 720);
      await page.screenshot({ path: `${shots}/after-${viewport.width === 1200 ? 'return-1200' : viewport.width}.png` });
      const stable = await state(); await page.waitForTimeout(150);
      assert.deepEqual(await state(), stable, 'Resize must settle without oscillation');
    }
    assert.equal((await state()).inputs, 0);
    assert.equal((await state()).opens, 1);
    assert.deepEqual(errors, []);
    await page.locator('[data-w-close]').click();
    assert.equal(await page.locator('.win').count(), 0);
    console.log('PASS: containment, controls, anchor return, pan without terminal resize, drag, dock/pin, fold, resize, mobile, close; zero terminal input');
  }
} finally { await browser.close(); }
