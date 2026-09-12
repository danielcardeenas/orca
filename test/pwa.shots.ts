/**
 * npm exec tsx test/pwa.shots.ts --isolated — real UI; push transport mocked.
 *
 *   npx tsx test/pwa.shots.ts             the run: frames land in test/shots/
 *   npx tsx test/pwa.shots.ts --assets    and also refresh the shipped ones
 *
 * Why the flag. `public/screenshots/{wide,narrow}.png` are product assets:
 * the manifest hands them to the install dialog and `pwa.production.ts`
 * checks their declared size. Writing them on every run left `git status`
 * dirty after `npm run shots` and someone had to check them back out by
 * hand — and a gate that asks for a cleanup afterwards is a gate people stop
 * running, which is the exact hole `npm run shots` was built to close.
 * So the run photographs into `test/shots/` (ignored, like every other
 * frame the harness takes) and refreshing what ships is a decision someone
 * makes, not something a test does behind their back.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ensureServers, shutdown, newPage, open, waitForFleet, uiPort, GPU_ARGS, ROOT, SHOTS } from './visual.ts';
await ensureServers();
const browser = await chromium.launch({ args: GPU_ARGS });
// Con `--assets`, las capturas de instalación se rehacen donde viven; sin él,
// donde van todas las fotos del arnés.
const assets = process.argv.includes('--assets');
const INSTALL_DIR = assets ? join(ROOT, 'public/screenshots') : SHOTS;
try {
  mkdirSync(INSTALL_DIR, { recursive: true });
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
    await page.screenshot({ path: join(INSTALL_DIR, assets ? `${name}.png` : `pwa-install-${name}.png`), scale: 'css' });
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
  console.log(`PWA: desktop/mobile settings, install screenshots and enable/disable flow passed (mock push transport). Install frames in ${INSTALL_DIR}${assets ? ' — shipped assets rewritten' : ''}.`);
} finally { await browser.close(); shutdown(); }
