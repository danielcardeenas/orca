/**
 * Qué se lee en la isla de fuera de la flota.
 *
 * Ahí caen el directorio del mando, los runtimes de cada traspaso y los
 * scratchpads, y todo llega con el mismo aspecto de sesión terminada. Lo que
 * se busca al abrirla es cuál de todas llevaba el mando, así que eso tiene que
 * estar escrito en su fila y no deducirse del id.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/off-fleet-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/window.css"></head><body style="background:#0b0a0d;margin:0"><main class="win__body" style="display:flex;flex-direction:column;width:min(640px,calc(100vw - 20px));height:calc(100dvh - 40px);margin:12px auto"></main></body></html>' }));
  await page.addInitScript('window.__name = (fn) => fn');
  await page.goto(`http://127.0.0.1:${port}/off-fleet-fixture`);
  await page.evaluate(async () => { await import('/test/fleet-offfleet.fixture.ts' as string); });
  const retired = page.locator('[data-agent="f0183205-0000-4000-8000-000000000001"]');
  await retired.waitFor();
  // La hora es local, como todo reloj de la consola: se compara con la misma
  // conversión, no con una cadena fija que sólo valdría en un huso.
  const when = await page.evaluate(async () => {
    const { RETIRED_AT } = await import('/test/fleet-offfleet.fixture.ts' as string);
    const d = new Date(RETIRED_AT); const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  });
  assert.match(await retired.innerText(), new RegExp(`WAS CAPCOM UNTIL ${when}`));
  // Y sólo el que lo fue: la sonda que alguien lanzó en el mismo directorio no.
  const probe = page.locator('[data-agent="aaaa1111-0000-4000-8000-000000000002"]');
  assert.equal((await probe.innerText()).includes('WAS CAPCOM'), false);
  await mkdir('test/shots', { recursive: true });
  await page.screenshot({ path: 'test/shots/fleet-off-fleet.png' });
  // Sin EVERYONE la isla no enseña nada de esto: es la puerta, no el sitio.
  await page.evaluate(async () => (await import('/test/fleet-offfleet.fixture.ts' as string)).hideRetired());
  await retired.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('Off-fleet UI passed: a retired CAPCOM says so and when, a probe in the same directory does not, and EVERYONE is what shows either.');
} finally { await browser.close(); await server.close(); }
