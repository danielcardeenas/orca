import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/settings-fixture', r => r.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/hud.css"><link rel="stylesheet" href="/src/ui/styles/window.css"></head><body style="background:#0b0a0d"><main class="win__body" style="width:min(380px,calc(100vw - 32px));height:500px;margin:16px auto"></main></body></html>' }));
  await page.addInitScript('window.__name = (fn) => fn');
  await page.goto('http://127.0.0.1:4478/settings-fixture');
  await page.evaluate(async () => {
    const { hub } = await import('/src/ui/net/client.ts' as string);
    const { store } = await import('/src/ui/store.ts' as string); store.linkUp = true;
    (window as any).settings = { automatic: false, fail: false, writes: 0 };
    hub.cmd = async (c: any) => { const s = (window as any).settings; if ('automatic' in c) { s.writes++; if (s.fail) throw new Error('Connection lost'); s.automatic = c.automatic; } return { automatic: s.automatic }; };
    const { mountSettings } = await import('/src/ui/windows/kinds/misc.ts' as string);
    mountSettings({ body: document.querySelector('main'), setTitle() {} }, { field: {}, note() {}, startMusic() {} });
  });
  const toggle = page.getByRole('switch', { name: 'AUTOMATIC REVIEW' });
  await toggle.waitFor(); await page.waitForFunction(() => !document.querySelector('[data-recovery-setting] button')?.hasAttribute('disabled'));
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await toggle.click(); await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent?.startsWith('On'));
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  for (const [label, width, height] of [['desktop', 1000, 800], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height }); await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `test/shots/recovery-settings-${label}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok(await page.locator('[data-settings-scroll]').evaluate(el => el.scrollHeight > el.clientHeight));
  }
  await page.evaluate(() => { (window as any).settings.fail = true; });
  await toggle.click(); await page.getByRole('button', { name: 'RETRY', exact: true }).waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), 'true'); assert.equal(await toggle.isDisabled(), true);
  await page.getByRole('button', { name: 'RETRY', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-recovery-setting] button')?.hasAttribute('disabled'));
  assert.equal(await toggle.getAttribute('aria-checked'), 'true'); assert.deepEqual(errors, []);
  console.log('Settings: read, save, failure reconciliation, scroll, desktop/mobile passed.');
} finally { await browser.close(); }
