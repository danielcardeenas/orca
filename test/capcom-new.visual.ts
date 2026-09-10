import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
// Isolated fixture server: no project vite config, websocket proxy or real hub.
const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1050 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/fresh-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/hud.css"><link rel="stylesheet" href="/src/ui/styles/window.css"></head><body style="background:#0b0a0d;margin:0"><main class="win__body" style="display:flex;flex-direction:column;width:min(640px,calc(100vw - 20px));height:calc(100dvh - 95px);margin:12px auto"></main></body></html>' }));
  await page.addInitScript('window.__name = (fn) => fn');
  await page.goto(`http://127.0.0.1:${port}/fresh-fixture`);
  await page.evaluate(async () => { await import('/test/capcom-new.fixture.ts' as string); });
  await page.locator('textarea[data-in]').fill('Preserve this operator draft');
  await page.getByRole('button', { name: 'New CAPCOM', exact: true }).click();
  assert.match(await page.getByRole('region', { name: 'New CAPCOM', exact: true }).innerText(), /no summary, history, automatic briefing or recall/);
  await mkdir('test/shots', { recursive: true });
  for (const [name, width, height] of [['desktop', 1000, 1050], ['mobile', 390, 960]] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `test/shots/capcom-new-${name}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok(await page.getByRole('button', { name: 'Clean context', exact: true }).isVisible());
  }
  // Con qué modelo nace. Un CAPCOM al que nadie ha preguntado por sus modelos
  // no tiene catálogo, y la elección lo pide ella misma en vez de quedarse sin
  // nada que ofrecer — que es lo que la escondía a quien no supiera pulsar
  // CHANGE MODEL primero.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).forgetModels());
  await page.getByRole('button', { name: 'New CAPCOM', exact: true }).click();
  await page.locator('[data-fresh-model] button').waitFor();
  assert.ok(await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).calls.some((c: {k: string}) => c.k === 'model:list')),
    'the choice asks the CLI for its catalog instead of offering nothing');
  await page.locator('[data-fresh-model] button').click();
  // Los dos caminos en la misma lista, cada uno diciendo lo que es.
  await page.getByRole('option', { name: /Sonnet/ }).waitFor();
  assert.match(await page.getByRole('option', { name: /gpt-5\.6-luna/ }).innerText(), /clears in place/);
  assert.match(await page.getByRole('option', { name: /Sonnet/ }).innerText(), /prepares and verifies/);
  assert.match(await page.getByRole('option', { name: /Opus/ }).innerText(), /CLI not installed/);
  // Cruzar de proveedor dice lo que cuesta ANTES de pulsar nada.
  await page.getByRole('option', { name: /Sonnet/ }).click();
  await page.getByRole('button', { name: 'Clean context · prepare', exact: true }).waitFor();
  assert.match(await page.locator('[data-fresh-note]').innerText(), /prepared and verified before the current CAPCOM is retired/);
  // Y volver al proveedor actual devuelve el botón a lo que de verdad hace.
  await page.locator('[data-fresh-model] button').click();
  await page.getByRole('option', { name: /gpt-5\.6-luna/ }).click();
  await page.getByRole('button', { name: 'Clean context', exact: true }).waitFor();
  assert.equal(await page.locator('[data-fresh-note]').isVisible(), false);
  // Con el vaciado retenido se ve lo que la ventana dice MIENTRAS pasa: la
  // sesión que se va está ociosa, y anunciar IDLE durante el relevo es lo que
  // hacía pensar que no estaba pasando nada.
  await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).hold());
  await page.getByRole('button', { name: 'Clean context', exact: true }).click();
  assert.equal(await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).calls.filter((c: {k: string}) => c.k === 'capcom:new').at(-1)?.model), 'gpt-5.6-luna');
  await page.locator('.capcom__feedback', { hasText: 'CHANGING' }).waitFor();
  assert.match(await page.locator('.capcom__feedback').innerText(), /clearing context/);
  assert.equal(await page.locator('.band').isVisible(), false);
  await page.locator('[data-detail]', { hasText: /clearing context…/ }).waitFor();
  await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).release());
  // Quedarse en el proveedor vacía en el sitio: hay recibo, no traspaso. Darlo
  // por plan pintaba `undefined/undefined`, `NaN KB` y un «Invalid handoff id».
  await page.locator('[data-detail]', { hasText: /clean context active · 99999999/ }).waitFor();
  await page.locator('.capcom__feedback', { hasText: 'READY' }).waitFor();
  assert.equal(await page.locator('[data-transfer-details]').isVisible(), false);
  assert.equal(await page.locator('textarea[data-in]').inputValue(), 'Preserve this operator draft');
  assert.equal(await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).calls.filter((c: {k: string}) => c.k === 'capcom:new').length), 1);
  // Cruzar de proveedor sí prepara una sesión aparte, y eso se sigue por fases.
  await page.getByRole('button', { name: 'New CAPCOM', exact: true }).click();
  await page.locator('[data-fresh-model] button').click();
  await page.getByRole('option', { name: /Sonnet/ }).click();
  await page.getByRole('button', { name: 'Clean context · prepare', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'New CAPCOM', exact: true }).isDisabled(), true);
  assert.match(await page.locator('[data-transfer-text]').innerText(), /codex\/gpt-6-astra → claude\/sonnet/);
  // Preparar tarda hasta dos minutos: la ventana entera lo dice, no sólo el panel.
  await page.locator('.capcom__feedback', { hasText: 'CHANGING' }).waitFor();
  assert.match(await page.locator('.capcom__feedback').innerText(), /preparing claude\/sonnet · clean context/);
  await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).fail());
  await page.getByRole('button', { name: 'CLOSE', exact: true }).waitFor();
  assert.match(await page.locator('[data-transfer-text]').innerText(), /Original CAPCOM retained/);
  await page.getByRole('button', { name: 'CLOSE', exact: true }).click();
  // Y el mismo camino en continuidad, hasta el final.
  await page.getByRole('button', { name: 'New CAPCOM', exact: true }).click();
  await page.locator('[data-fresh-model] button').click();
  await page.getByRole('option', { name: /Sonnet/ }).click();
  await page.getByRole('button', { name: 'With continuity · prepare', exact: true }).click();
  await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).complete());
  // Un recibo de algo que salió bien se pliega solo: no hay nada que decidir y
  // el alto es de la conversación. El titular y la fase siguen en la línea.
  await page.locator('[data-transfer-sum]').getByText('complete').waitFor();
  assert.equal(await page.locator('[data-transfer-details]').evaluate((d) => (d as HTMLDetailsElement).open), false);
  assert.equal(await page.locator('[data-transfer-text]').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'CLOSE', exact: true }).isVisible(), false);
  await page.getByText('CAPCOM · CONTINUITY', { exact: true }).waitFor();
  // Y se abre con un clic, con su CLOSE dentro.
  await page.locator('[data-transfer-details] summary').click();
  await page.getByRole('button', { name: 'CLOSE', exact: true }).waitFor();
  assert.match(await page.locator('[data-transfer-text]').innerText(), /Backup:/);
  await page.getByRole('button', { name: 'CLOSE', exact: true }).click();
  const input = page.locator('.cmd__in');
  await input.fill('/capcom-new invalid'); await input.press('Enter');
  assert.match(await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).notes.at(-1)), /clean.*continuity/);
  // El slash promete «mismo proveedor y modelo»: la elección que quedó en el
  // panel —Sonnet, de otro runtime— no puede cruzar de proveedor a su espalda.
  await input.fill('/capcom-new continuity'); await input.press('Enter');
  await page.locator('[data-detail]', { hasText: /continuity active · 99999999/ }).waitFor();
  assert.equal(await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).calls.filter((c: {k: string, mode?: string}) => c.k === 'capcom:new').at(-1)?.mode), 'continuity');
  assert.equal(await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).calls.filter((c: {k: string, model?: string}) => c.k === 'capcom:new').at(-1)?.model), undefined);
  await input.fill('/capcom-new clean'); await input.press('Enter');
  await page.locator('[data-detail]', { hasText: /clean context active · 99999999/ }).waitFor();
  assert.equal(await page.locator('[data-transfer-details]').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('Fresh UI passed: visible modes, scope, chosen model, CHANGING status without invented throughput while the relay lasts, in-place clear receipt without a fake plan, cross-provider plan phases, draft, failure/retry, folded receipt, slash commands that keep the provider, desktop/mobile.');
} finally { await browser.close(); await server.close(); }
