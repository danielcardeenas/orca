import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } }); page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/provider-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/hud.css"><link rel="stylesheet" href="/src/ui/styles/window.css"></head><body style="background:#0b0a0d;margin:0"><main class="win__body" style="display:flex;flex-direction:column;width:min(640px,calc(100vw - 20px));height:calc(100dvh - 24px);margin:12px auto"></main></body></html>' }));
  await page.addInitScript('window.__name = (fn) => fn');
  await page.goto('http://127.0.0.1:4478/provider-fixture');
  await page.evaluate(async () => { await import('/test/provider-handoff.fixture.ts' as string); });
  await page.locator('[data-in]').fill('Keep my draft');
  await page.getByRole('button', { name: 'LOAD PREVIOUS CONVERSATION', exact: true }).click();
  await page.getByRole('button', { name: 'LOAD EARLIER MESSAGES' }).click();
  assert.match(await page.locator('.capcom__archive').innerText(), /Original CAPCOM conversation/);
  assert.match(await page.locator('.capcom__archive').innerText(), /pending hygiene/);
  await page.getByRole('button', { name: 'CHANGE MODEL', exact: true }).click();
  await page.getByRole('option', { name: /Sonnet/ }).waitFor();
  assert.equal(await page.locator('.pick__group', { hasText: 'CLAUDE CODE' }).count(), 1);
  await page.getByRole('option', { name: /Sonnet/ }).click();
  await page.getByRole('button', { name: 'CONFIRM HANDOFF' }).waitFor();
  assert.equal(await page.evaluate(async () => (await import('/test/provider-handoff.fixture.ts' as string)).calls.includes('handoff:commit')), false);
  assert.match(await page.locator('[data-transfer-text]').innerText(), /codex\/gpt-6-astra → claude\/sonnet/);
  await page.getByRole('button', { name: 'REVIEW CONTEXT' }).click();
  assert.equal(await page.locator('[data-in]').inputValue(), 'Keep my draft');
  await mkdir('test/shots', { recursive: true });
  for (const [name, width, height] of [['desktop', 1000, 1000], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `test/shots/provider-handoff-${name}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('[data-in]').isVisible(), true);
  }
  await page.getByRole('button', { name: 'CONFIRM HANDOFF' }).click();
  assert.match(await page.locator('[data-detail]').innerText(), /HANDOFF IN PROGRESS/);
  await page.evaluate(async () => (await import('/test/provider-handoff.fixture.ts' as string)).fail());
  await page.getByRole('button', { name: 'CLOSE', exact: true }).waitFor();
  assert.match(await page.locator('[data-transfer-text]').innerText(), /Original CAPCOM retained/);
  assert.deepEqual(errors, []);
  console.log('Provider UI: grouped models, review before commit, history pages, draft, error, desktop/mobile passed.');
} finally { await browser.close(); }
