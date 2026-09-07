import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/model-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/hud.css"><link rel="stylesheet" href="/src/ui/styles/window.css"></head><body style="background:#0b0a0d;margin:0"><main class="win__body" style="display:flex;flex-direction:column;width:min(640px,calc(100vw - 20px));height:calc(100dvh - 24px);margin:12px auto"></main></body></html>' }));
  await page.addInitScript('window.__name = (fn) => fn');
  await page.goto('http://127.0.0.1:4478/model-fixture');
  await page.evaluate(async () => { await import('/test/capcom-model.fixture.ts' as string); });
  await page.locator('[data-in]').fill('Conserva mi borrador');
  await page.getByRole('button', { name: 'CHANGE MODEL', exact: true }).click();
  await page.getByRole('option', { name: /GPT-5.6 Terra/i }).click();
  await page.getByRole('button', { name: 'CANCEL CHANGE' }).waitFor();
  assert.match(await page.locator('[data-detail]').innerText(), /Waiting for the current turn/);
  await page.getByRole('button', { name: 'CANCEL CHANGE' }).click();
  await page.getByRole('button', { name: 'CHANGE MODEL', exact: true }).click();
  await page.getByRole('option', { name: /GPT-5.6 Terra/i }).click();
  await page.evaluate(async () => (await import('/test/capcom-model.fixture.ts' as string)).confirm());
  assert.match(await page.locator('[data-active]').innerText(), /gpt-5.6-terra/);
  assert.match(await page.locator('[data-log]').innerText(), /Model changed:.*Same conversation/);
  assert.equal(await page.locator('[data-in]').inputValue(), 'Conserva mi borrador');
  await page.getByRole('tab', { name: /^EVENTS/ }).click();
  assert.match(await page.locator('[data-log]').innerText(), /Model changed:/);
  await page.getByRole('tab', { name: 'TALK', exact: true }).click();
  await mkdir('test/shots', { recursive: true });
  for (const [name, width, height] of [['desktop', 1000, 1000], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `test/shots/capcom-model-${name}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('[data-in]').isVisible(), true);
  }
  await page.evaluate(async () => (await import('/test/capcom-model.fixture.ts' as string)).fail());
  await page.getByRole('button', { name: 'OPEN TERMINAL' }).waitFor();
  assert.match(await page.locator('[data-detail]').innerText(), /unconfirmed/);
  assert.deepEqual(errors, []);
  console.log('Model UI: selection, pending/cancel, confirmation, TALK/EVENTS, draft, error and desktop/mobile passed.');
} finally { await browser.close(); }
