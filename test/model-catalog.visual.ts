import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
// Servidor propio, como el arnés de New CAPCOM: sin depender de que `npm run
// dev` esté sirviendo en 4478, y sin fotografiar el árbol de otro.
const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(5000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/catalog-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/hud.css"><link rel="stylesheet" href="/src/ui/styles/window.css"></head><body style="background:#0b0a0d;margin:0"><main class="win__body" style="width:min(640px,calc(100vw - 24px));margin:100px auto"></main></body></html>' }));
  await page.addInitScript('window.__name = (fn) => fn');
  await page.goto(`http://127.0.0.1:${port}/catalog-fixture`);
  const setup = async (runtime: string, worker: boolean, mode = 'ready') => page.evaluate(async ({ runtime, worker, mode }) => (await import('/test/model-catalog.fixture.ts' as string)).setup(runtime, worker, mode), { runtime, worker, mode });
  const calls = () => page.evaluate(async () => (await import('/test/model-catalog.fixture.ts' as string)).calls);
  const open = () => page.locator('[data-load]').click();
  const groups = async () => { await page.getByRole('option').first().waitFor(); assert.deepEqual((await page.locator('.pick__group').allTextContents()).map(x => x.replace(' CODE', '')).sort(), ['CLAUDE', 'CODEX']); };
  await mkdir('test/shots', { recursive: true });
  for (const runtime of ['codex', 'claude']) for (const worker of [false, true]) {
    await setup(runtime, worker); await open(); await groups();
    const own = runtime === 'codex' ? 'gpt-5.6-terra' : 'sonnet';
    await page.getByRole('option', { name: own + ' same session', exact: true }).click();
    assert.equal((await calls()).at(-1).k, 'model:set');
    await setup(runtime, worker); await open();
    const other = runtime === 'codex' ? 'sonnet' : 'gpt-5.6-terra';
    await page.getByRole('option', { name: other + ' handoff · review first', exact: true }).click();
    await page.getByRole('button', { name: 'CONFIRM HANDOFF' }).waitFor();
    assert.equal((await calls()).at(-1).k, 'handoff:prepare');
    assert.equal((await calls()).some((c: any) => c.k === 'handoff:commit'), false);
    // Sesión sin catálogo nativo —ocupada, o nadie le tecleó `/model` aún—: los
    // modelos del mismo proveedor salen del catálogo instalado y se pueden
    // pedir igual. Antes iban deshabilitados con «retry», y como un CAPCOM al
    // mando casi nunca está ocioso con el prompt limpio, cambiar de modelo
    // dentro de Claude era en la práctica imposible mientras cruzar a Codex sí.
    await setup(runtime, worker, 'fresh'); await open(); await groups();
    const unverified = page.getByRole('option', { name: own + ' same session · CLI verifies when idle', exact: true });
    assert.equal(await unverified.getAttribute('aria-disabled'), null, 'offered for real, not as a disabled reference');
    assert.ok(!/session catalog is not ready/.test(await page.locator('[data-detail]').innerText()), 'no retry nag when the catalog has the runtime covered');
    await page.screenshot({ path: `test/shots/model-catalog-${runtime}-${worker ? 'worker' : 'capcom'}-fresh.png` });
    await unverified.click();
    const set = (await calls()).at(-1);
    assert.equal(set.k, 'model:set'); assert.equal(set.model, own);
    await setup(runtime, worker); await open(); await groups();
    assert.equal(await page.getByRole('option', { name: own + ' same session', exact: true }).getAttribute('aria-disabled'), null);
  }
  for (const mode of ['provider-error', 'native-error', 'malformed']) {
    await setup('codex', true, mode); await open();
    assert.match(await page.locator('[data-detail]').innerText(), /unavailable|invalid response/);
    assert.equal(await page.locator('[data-load]').innerText(), 'RETRY MODELS');
    await page.screenshot({ path: `test/shots/model-catalog-${mode}.png` });
    await page.keyboard.press('Escape');
    await page.evaluate(async () => (await import('/test/model-catalog.fixture.ts' as string)).recover());
    await open(); await groups(); assert.equal(await page.locator('[data-detail]').innerText(), '');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await setup('codex', false, 'fresh'); await open(); await groups();
  await page.screenshot({ path: 'test/shots/model-catalog-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('Catalog UI passed: both runtimes × CAPCOM/worker, fresh catalog, native set, explicit handoff review, partial failures, malformed response, retry, mobile.');
} finally { await browser.close(); await server.close(); }
