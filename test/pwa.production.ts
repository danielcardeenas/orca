/** npm run build && npx tsx test/pwa.production.ts — real production worker, local push injection. */
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const dir = mkdtempSync(join(tmpdir(), 'orca-pwa-production-'));
const child = fork(new URL('./push.fixture.ts', import.meta.url), [], {
  execArgv: ['--import', 'tsx'], silent: true,
  env: { ...process.env, ORCA_HOME: dir, ORCA_TOKEN: 'pwa-local-test', ORCA_HARNESS: '0' },
});
const context = await chromium.launchPersistentContext(join(dir, 'browser'), { permissions: ['notifications'] });
try {
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hub startup timeout')), 15000);
    child.once('message', m => { clearTimeout(timer); resolve((m as { port: number }).port); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('hub exited')); });
  });
  const origin = `http://127.0.0.1:${port}`;
  await context.grantPermissions(['notifications'], { origin });
  const page = await context.newPage();
  await page.goto(origin + '/?k=pwa-local-test&noboot=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const worker = context.serviceWorkers()[0]!;
  // Observe the real handler's call, forwarding to the native API. Headless
  // Chromium does not provide a reliable OS notification tray to inspect.
  const result = await worker.evaluate(`(async () => {
    const nativeShow = self.registration.showNotification.bind(self.registration);
    let shown = null;
    let pending;
    self.registration.showNotification = (title, options) => {
      shown = { title, body: options.body, url: options.data.url };
      pending = nativeShow(title, options);
      return pending;
    };
    self.dispatchEvent(new PushEvent('push', { data: JSON.stringify({ body: 'Local delivery check' }) }));
    let nativeError = null;
    try { await pending; } catch (error) { nativeError = error.message; }
    self.registration.showNotification = nativeShow;
    return { notice: shown, nativeError };
  })()`) as { notice: { title: string; body: string; url: string }; nativeError: string | null };
  if (result.nativeError) console.warn(`UNVERIFIED native notification display: ${result.nativeError}`);
  assert.deepEqual(result.notice, { title: 'ORCA · NEEDS YOU', body: 'Local delivery check', url: '/?queue=1' });
  const manifest = await (await page.request.get(origin + '/manifest.webmanifest')).json();
  assert.equal(manifest.orientation, 'any');
  for (const shot of manifest.screenshots) {
    const response = await page.request.get(origin + shot.src);
    assert.equal(response.status(), 200);
    const png = await response.body();
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, shot.sizes);
  }
  await context.setOffline(true);
  await page.goto(origin + '/offline-check', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__orca);
  assert.equal(await page.locator('.field').count(), 1);
  console.log('Production PWA: controlling worker, push handler payload, manifest/screenshots and offline deep navigation passed. No external push sent.');
} finally {
  await context.close();
  if (child.connected) child.send('close');
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  rmSync(dir, { recursive: true, force: true });
}
