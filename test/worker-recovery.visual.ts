import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } }); page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/worker-recovery-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/hud.css"><link rel="stylesheet" href="/src/ui/styles/window.css"></head><body style="background:#0b0a0d;margin:0"><main class="win__body" style="width:min(640px,calc(100vw - 20px));height:calc(100dvh - 24px);margin:12px auto"></main></body></html>' }));
  await page.addInitScript('window.__name = (fn) => fn');
  await page.goto('http://127.0.0.1:4478/worker-recovery-fixture');
  await page.evaluate(async () => { await import('/test/worker-recovery.fixture.ts' as string); });
  await page.locator('[data-say]').fill('Preserve this draft');
  await page.getByLabel('Recovery review time').fill('2026-09-07T12:00');
  await page.getByLabel('Reason for waiting').fill('Wait for Fable quota; no urgent dependency.');
  await page.getByRole('button', { name: 'WAIT', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-recovery-status]')?.textContent?.includes('waiting'));
  assert.match(await page.locator('[data-recovery-status]').innerText(), /Wait for Fable quota/);
  await page.getByRole('button', { name: 'CHANGE MODEL', exact: true }).click();
  await page.getByRole('option', { name: /GPT-6 Astra/ }).click();
  await page.getByRole('button', { name: 'CONFIRM HANDOFF' }).waitFor();
  assert.equal(await page.evaluate(async () => (await import('/test/worker-recovery.fixture.ts' as string)).calls.filter((c: any) => c.k === 'recovery:decide' && c.decision.action === 'handoff').length), 0);
  await mkdir('test/shots', { recursive: true });
  for (const [label, width, height] of [['desktop', 1000, 1000], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height }); await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `test/shots/worker-recovery-${label}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('[data-say]').inputValue(), 'Preserve this draft');
    assert.equal(await page.getByLabel('Reason for waiting').inputValue(), 'Wait for Fable quota; no urgent dependency.');
  }
  await page.getByRole('button', { name: 'CONFIRM HANDOFF' }).click();
  await page.evaluate(async () => (await import('/test/worker-recovery.fixture.ts' as string)).complete());
  await page.getByRole('button', { name: 'OPEN CONTINUED AGENT', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Worker UI: wait reason/date, reviewed handoff, stable draft, continuation link, desktop/mobile passed.');
} finally { await browser.close(); }
