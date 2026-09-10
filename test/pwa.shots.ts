/** npm exec tsx test/pwa.shots.ts --isolated — real UI; push transport mocked. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ensureServers, shutdown, newPage, open, waitForFleet, uiPort, GPU_ARGS, ROOT, SHOTS } from './visual.ts';
await ensureServers();
const browser = await chromium.launch({ args: GPU_ARGS });
try {
  mkdirSync(join(ROOT, 'public/screenshots'), { recursive: true });
  for (const [name, width, height] of [['wide', 1280, 800], ['narrow', 432, 864]] as const) {
    const page = await newPage(browser, width, height);
    await open(page, `http://127.0.0.1:${uiPort()}/?noboot=1`);
    const ready = await waitForFleet(page, 4, 10000);
    if (!ready) {
      await page.screenshot({ path: join(SHOTS, 'pwa-debug.png') });
      console.log(await page.evaluate(() => ({ stats: window.__orca?.stats(), text: document.body.innerText.slice(-1800) })));
    }
    assert.equal(ready, true);
    await page.evaluate(() => window.__orca?.frame());
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(ROOT, 'public/screenshots', `${name}.png`), scale: 'css' });
    // Open existing settings using its existing global shortcut.
    await page.keyboard.press('Alt+,');
    await page.locator('[data-device-settings]').waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(SHOTS, `pwa-settings-${name}.png`) });
    assert.equal(await page.locator('[data-push]').textContent(), 'ENABLE PUSH');
    assert.equal(await page.locator('[data-push]').isDisabled(), true);
    await page.close();
  }
  const page = await newPage(browser, 800, 900);
  await page.addInitScript({ content: `(() => {
    let current = null;
    Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} });
    Object.defineProperty(Notification, 'requestPermission', { configurable: true, value: async () => 'granted' });
    navigator.serviceWorker.getRegistration = async () => ({
      active: {}, pushManager: {
        getSubscription: async () => current,
        subscribe: async () => current = { endpoint: 'https://fcm.googleapis.com/test', toJSON: () => ({ endpoint: 'test', keys: {} }), unsubscribe: async () => { current = null; return true; } },
      },
    });
  })();` });
  const methods: string[] = [];
  await page.route('**/api/push*', route => {
    methods.push(route.request().method());
    return route.fulfill({ json: { publicKey: 'B' + 'A'.repeat(86), ok: true } });
  });
  await open(page, `http://127.0.0.1:${uiPort()}/?noboot=1`);
  await page.keyboard.press('Alt+,');
  const button = page.locator('[data-push]');
  await button.waitFor();
  await button.click();
  await page.getByText('Notifications enabled on this device.', { exact: true }).waitFor();
  await button.click();
  await page.getByText('Notifications disabled on this device.', { exact: true }).waitFor();
  assert.deepEqual(methods, ['GET', 'POST', 'DELETE']);
  console.log('PWA: desktop/mobile settings, install screenshots and enable/disable flow passed (mock push transport).');
} finally { await browser.close(); shutdown(); }
