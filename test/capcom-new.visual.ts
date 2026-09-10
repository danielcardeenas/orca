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
  // Un modelo del mismo proveedor que el menú no enseñó pero el catálogo sí
  // conoce va en el mismo bloque, y dice que lo verifica el CLI.
  assert.match(await page.getByRole('option', { name: /gpt-5\.6-terra/ }).innerText(), /clears in place · CLI verifies/);
  // Cruzar de proveedor dice lo que cuesta ANTES de pulsar nada.
  await page.getByRole('option', { name: /Sonnet/ }).click();
  await page.getByRole('button', { name: 'Clean context · prepare', exact: true }).waitFor();
  assert.match(await page.locator('[data-fresh-note]').innerText(), /prepared and verified before the current CAPCOM is retired/);
  // Y volver al proveedor actual devuelve el botón a lo que de verdad hace.
  await page.locator('[data-fresh-model] button').click();
  await page.getByRole('option', { name: /gpt-5\.6-luna/ }).click();
  await page.getByRole('button', { name: 'Clean context', exact: true }).waitFor();
  assert.equal(await page.locator('[data-fresh-note]').isVisible(), false);
  // Con el vaciado ENCOLADO se ve lo que la ventana dice mientras pasa. A
  // diferencia del `/clear` que hoy corre en el sitio, este click ya no
  // espera a que CAPCOM esté idle: contesta YA con la cola, y de ahí en más
  // el estado se sigue por el snapshot, igual que CHANGE MODEL.
  await page.getByRole('button', { name: 'Clean context', exact: true }).click();
  assert.equal(await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).calls.filter((c: {k: string}) => c.k === 'capcom:new').at(-1)?.model), 'gpt-5.6-luna');
  await page.locator('.capcom__feedback', { hasText: 'NEW CAPCOM QUEUED' }).waitFor();
  assert.match(await page.locator('.capcom__feedback').innerText(), /Waiting for CAPCOM to be idle/);
  assert.equal(await page.locator('.band').isVisible(), false);
  await page.locator('[data-detail]', { hasText: /NEW CAPCOM QUEUED/ }).waitFor();
  // Encolado, se cancela limpio: nada se tocó todavía, así que no hay ningún
  // `/clear` pendiente que dejar flotando.
  await page.getByRole('button', { name: 'CANCEL NEW CAPCOM', exact: true }).click();
  await page.locator('.capcom__feedback', { hasText: 'READY' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'CANCEL NEW CAPCOM', exact: true }).isVisible(), false);
  assert.equal(await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).calls.filter((c: {k: string}) => c.k === 'capcom:new:cancel').length), 1);
  // Pedido otra vez y esta vez se deja aplicar — lo que en la máquina real
  // hace el `tick()` del collector en cuanto CAPCOM queda idle, aquí lo
  // dispara la prueba a mano.
  await page.getByRole('button', { name: 'New CAPCOM', exact: true }).click();
  await page.getByRole('button', { name: 'Clean context', exact: true }).click();
  await page.locator('[data-detail]', { hasText: /NEW CAPCOM QUEUED/ }).waitFor();
  await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).applyQueuedReset());
  // Quedarse en el proveedor vacía en el sitio: hay recibo, no traspaso. Darlo
  // por plan pintaba `undefined/undefined`, `NaN KB` y un «Invalid handoff id».
  await page.locator('[data-detail]', { hasText: /Context cleared; now 99999999/ }).waitFor();
  await page.locator('.capcom__feedback', { hasText: 'READY' }).waitFor();
  assert.equal(await page.locator('[data-transfer-details]').isVisible(), false);
  assert.equal(await page.locator('textarea[data-in]').inputValue(), 'Preserve this operator draft');
  assert.equal(await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).calls.filter((c: {k: string}) => c.k === 'capcom:new').length), 2);
  // Un pedido que nunca ve a CAPCOM idle falla con un motivo claro, no en
  // silencio ni reintentando para siempre.
  await page.getByRole('button', { name: 'New CAPCOM', exact: true }).click();
  await page.getByRole('button', { name: 'Clean context', exact: true }).click();
  await page.locator('[data-detail]', { hasText: /NEW CAPCOM QUEUED/ }).waitFor();
  await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).failQueuedReset());
  await page.locator('.capcom__feedback', { hasText: 'NEW CAPCOM ERROR' }).waitFor();
  assert.match(await page.locator('.capcom__feedback').innerText(), /did not go idle within 10 minutes/);
  await page.locator('[data-detail]', { hasText: /NEW CAPCOM ERROR/ }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'OPEN TERMINAL', exact: true }).isVisible());
  // Lo que fallaba de verdad: la sesión está ocupada cuando se abre la
  // elección, así que el CLI no tiene menú que dar y `choices` viene vacío.
  // Antes eso dejaba sin ningún modelo del mismo proveedor —cambiar de Opus a
  // Sonnet no existía— mientras cruzar a Codex sí salía. Ahora el catálogo del
  // proveedor los ofrece como opción real, sin esperar a pescar el instante
  // ocioso, y el relevo se pide con ese modelo, encolado hasta que esté idle.
  await page.evaluate(async () => { const f = await import('/test/capcom-new.fixture.ts' as string); f.forgetModels(); f.busySession(true); });
  await page.getByRole('button', { name: 'New CAPCOM', exact: true }).click();
  await page.locator('[data-fresh-model] button').waitFor();
  await page.locator('[data-fresh-model] button').click();
  await page.getByRole('option', { name: /gpt-5\.6-terra/ }).waitFor();
  assert.equal(await page.getByRole('option', { name: /gpt-5\.6-luna/ }).count(), 0, 'the busy session listed nothing');
  assert.match(await page.getByRole('option', { name: /gpt-6-astra/ }).innerText(), /current · clears in place/);
  assert.match(await page.getByRole('option', { name: /gpt-5\.6-terra/ }).innerText(), /clears in place · CLI verifies/);
  assert.equal(await page.getByRole('option', { name: /gpt-5\.6-terra/ }).getAttribute('aria-disabled'), null, 'offered for real, not as a disabled reference');
  await page.getByRole('option', { name: /gpt-5\.6-terra/ }).click();
  // Mismo proveedor: sigue siendo un vaciado en el sitio, sin «prepare» ni aviso de segundo CLI.
  await page.getByRole('button', { name: 'Clean context', exact: true }).waitFor();
  assert.equal(await page.locator('[data-fresh-note]').isVisible(), false);
  await page.getByRole('button', { name: 'Clean context', exact: true }).click();
  await page.locator('[data-detail]', { hasText: /NEW CAPCOM QUEUED/ }).waitFor();
  assert.equal(await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).calls.filter((c: {k: string}) => c.k === 'capcom:new').at(-1)?.model), 'gpt-5.6-terra');
  await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).applyQueuedReset());
  await page.locator('[data-detail]', { hasText: /Context cleared; now 99999999/ }).waitFor();
  await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).busySession(false));
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
  await page.locator('[data-detail]', { hasText: /NEW CAPCOM QUEUED/ }).waitFor();
  assert.equal(await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).calls.filter((c: {k: string, mode?: string}) => c.k === 'capcom:new').at(-1)?.mode), 'continuity');
  assert.equal(await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).calls.filter((c: {k: string, model?: string}) => c.k === 'capcom:new').at(-1)?.model), undefined);
  await page.evaluate(async () => (await import('/test/capcom-new.fixture.ts' as string)).applyQueuedReset());
  await page.locator('[data-detail]', { hasText: /Context cleared; now 99999999/ }).waitFor();
  await input.fill('/capcom-new clean'); await input.press('Enter');
  await page.locator('[data-detail]', { hasText: /NEW CAPCOM QUEUED/ }).waitFor();
  assert.equal(await page.locator('[data-transfer-details]').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('Fresh UI passed: visible modes, scope, chosen model, same-runtime models offered from the provider catalog while the session is busy, NEW CAPCOM QUEUED status without invented throughput while it waits for idle, clean cancellation, a clear timeout failure, in-place clear receipt without a fake plan, cross-provider plan phases, draft, failure/retry, folded receipt, slash commands that keep the provider, desktop/mobile.');
} finally { await browser.close(); await server.close(); }
