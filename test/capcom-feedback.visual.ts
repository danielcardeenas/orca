/** Isolated UI fixture: no hub, collector, websocket or real session. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/feedback-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/window.css"></head><body style="background:var(--bezel);margin:0"><main class="win__body" style="display:flex;flex-direction:column;width:min(640px,calc(100vw - 20px));height:calc(100dvh - 24px);margin:12px auto"></main></body></html>' }));
  await page.route('**/api/**', route => route.abort());
  await page.routeWebSocket('**/*', socket => socket.close());
  await page.addInitScript('window.__name = (fn) => fn');
  await page.goto(`${server.resolvedUrls!.local[0]}feedback-fixture`);
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(async () => { await import('/test/capcom-feedback.fixture.ts' as string); });
  const feedback = page.locator('[data-feedback]');
  const fixture = '/test/capcom-feedback.fixture.ts';
  const label = async (text: string) => { await page.waitForFunction(t => document.querySelector('[data-feedback] b')?.textContent === t, text); };
  await label('CONNECTING');
  assert.equal(await feedback.getAttribute('role'), 'status');
  assert.equal(await feedback.getAttribute('aria-atomic'), 'true');
  await page.locator('[data-in]').fill('Borrador que sobrevive');
  assert.equal(await page.locator('[data-send]').isDisabled(), true);
  await page.evaluate(async f => (await import(f)).link(true), fixture);
  await label('READY');
  await page.evaluate(async f => (await import(f)).update('thinking'), fixture);
  await label('THINKING');
  // Metrics/timer updates must not reannounce unchanged feedback.
  await feedback.evaluate(el => { (window as any).feedbackMutations = 0; new MutationObserver(() => (window as any).feedbackMutations++).observe(el, { childList: true, subtree: true, characterData: true }); });
  await page.waitForTimeout(1100);
  assert.equal(await page.evaluate(() => (window as any).feedbackMutations), 0);
  await page.evaluate(async f => (await import(f)).outgoing('sending'), fixture);
  assert.match(await page.locator('[data-delivery]').innerText(), /SENDING.*not a CAPCOM reply/);
  await page.evaluate(async f => (await import(f)).outgoing('accepted'), fixture);
  assert.match(await page.locator('[data-delivery]').innerText(), /ACCEPTED BY COMMAND/);
  await page.evaluate(async f => (await import(f)).outgoing('failed'), fixture);
  assert.match(await page.locator('[data-delivery]').innerText(), /may have arrived/);
  await page.evaluate(async f => (await import(f)).link(false), fixture);
  await label('RECONNECTING');
  assert.equal(await page.locator('.is-live').count(), 0);
  assert.equal(await page.locator('[data-band]').isVisible(), false);
  assert.equal(await page.locator('[data-in]').inputValue(), 'Borrador que sobrevive');
  await mkdir('test/shots', { recursive: true });
  for (const [name, width, height] of [['desktop', 1000, 900], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `test/shots/capcom-feedback-reconnecting-${name}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('[data-in]').isVisible(), true);
  }
  await page.evaluate(async f => { const m = await import(f); m.link(true); m.received(); m.update('idle'); }, fixture);
  await label('READY');
  assert.equal(await page.locator('[data-delivery]').isVisible(), false);
  assert.equal(await page.locator('[data-send]').isDisabled(), false);
  await page.evaluate(async f => (await import(f)).update('blocked', { kind: 'peer', summary: 'Worker is finishing', since: Date.now(), waitingOn: 'worker' }), fixture);
  await label('WAITING ON AGENT');
  assert.equal(await page.locator('.capcom__peer').count(), 1);
  await page.evaluate(async f => (await import(f)).update('blocked', { kind: 'question', summary: 'Choose an option', since: Date.now() }), fixture);
  await label('WAITING ON YOU');
  await page.evaluate(async f => (await import(f)).update('blocked', { kind: 'error', summary: 'Synthetic runtime error', since: Date.now() }), fixture);
  await label('CAPCOM ERROR');
  assert.equal(await page.locator('.capcom__peer').count(), 0);
  assert.match(await page.locator('.capcom__error').innerText(), /Synthetic runtime error/);
  await page.screenshot({ path: 'test/shots/capcom-feedback-error-mobile.png' });
  await page.evaluate(async f => { const m = await import(f); m.update('idle'); m.auth(false); }, fixture);
  await label('ACCESS ERROR');
  await page.evaluate(async f => { const m = await import(f); m.auth(true); m.hosted(); }, fixture);
  await label('READY');
  // A synthetic new-session acknowledgement; only the read status is retried.
  await page.getByRole('button', { name: 'New CAPCOM', exact: true }).click();
  await page.getByRole('button', { name: 'Clean context', exact: true }).click();
  await label('CHANGING SESSION');
  await page.evaluate(async f => (await import(f)).failStatus(1), fixture);
  await label('CHECKING SESSION');
  await page.evaluate(async f => (await import(f)).phase('complete'), fixture);
  await label('READY');
  assert.equal(await page.evaluate(async f => (await import(f)).commands.filter((k: string) => k === 'capcom:new').length, fixture), 1);
  assert.equal(await page.locator('[data-in]').inputValue(), 'Borrador que sobrevive');
  // Restoring a saved receipt survives a failed read, even with no live source.
  await page.evaluate(async f => {
    const m = await import(f); m.mounted.dispose();
    localStorage.setItem('orca.capcom.handoff', JSON.stringify({ id: m.plan.id, agentId: 'cap' }));
  }, fixture);
  await page.reload();
  await page.evaluate(async f => { const m = await import(f); m.update('done'); m.failStatus(1); m.phase('complete'); m.link(true); }, fixture);
  await label('CHECKING SESSION');
  await label('NO ACTIVE SESSION');
  assert.equal(await page.locator('[data-detail]').innerText().then(t => t.includes('Synthetic status outage')), false);
  assert.deepEqual(errors, []);
  console.log('CAPCOM feedback visual: connection, delivery, recovery, peer/human/error, handoff retry/restore, drafts, desktop/mobile and live region passed.');
} finally { await browser.close(); await server.close(); }
