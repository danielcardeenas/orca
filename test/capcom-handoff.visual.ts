import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/handoff-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/window.css"></head><body style="background:#0b0a0d;margin:0"><main class="win__body" style="display:flex;flex-direction:column;width:min(640px,calc(100vw - 20px));height:calc(100dvh - 24px);margin:12px auto"></main></body></html>' }));
  await page.addInitScript('window.__name = (fn) => fn');
  await page.goto('http://127.0.0.1:4478/handoff-fixture');
  // Sólo aquí: lo que se pliega y lo que se descarta se recuerda entre recargas,
  // y eso es justo lo que este recorrido comprueba más abajo.
  await page.evaluate(() => localStorage.removeItem('orca.capcom.notices'));
  await page.evaluate(async () => { await import('/test/capcom-handoff.fixture.ts' as string); });
  await page.getByRole('complementary', { name: 'CAPCOM session handoff' }).waitFor();
  // Plegado: una línea con su título y su hora, y el cuerpo fuera de la vista.
  assert.equal(await page.locator('.capcom__handoff details').evaluate((d) => (d as HTMLDetailsElement).open), false);
  assert.equal(await page.getByRole('button', { name: 'OPEN PREVIOUS CONVERSATION' }).isVisible(), false);
  const folded = (await page.locator('.capcom__handoff').boundingBox())!.height;
  assert.match(await page.locator('.capcom__handoff').innerText(), /SESSION CHANGED/);
  await page.locator('.capcom__handoff summary').click();
  assert.match(await page.locator('[data-handoff]').innerText(), /Earlier messages are archived/);
  assert.ok((await page.locator('.capcom__handoff').boundingBox())!.height > folded * 2, 'unfolding is what costs the room');
  await page.getByRole('button', { name: 'OPEN PREVIOUS CONVERSATION' }).click();
  await page.getByRole('button', { name: 'HANDOFF NOTES' }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(async () => (await import('/test/capcom-handoff.fixture.ts' as string)).openedFiles), ['/tmp/recovery/conversation.md', '/tmp/recovery/HANDOFF.md']);
  await page.locator('[data-in]').fill('Mi borrador sigue aquí');
  await page.evaluate(async () => (await import('/test/capcom-handoff.fixture.ts' as string)).update());
  assert.equal(await page.locator('.capcom__handoff').count(), 1);
  assert.equal(await page.locator('[data-in]').inputValue(), 'Mi borrador sigue aquí');
  await page.getByRole('tab', { name: /^EVENTS/ }).click();
  assert.equal(await page.locator('[data-handoff]').isVisible(), false);
  assert.match(await page.locator('[data-log]').innerText(), /CAPCOM HANDOFF/);
  await page.getByRole('tab', { name: 'TALK', exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  await mkdir('test/shots', { recursive: true });
  for (const [name, width, height] of [['desktop', 1000, 900], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `test/shots/capcom-handoff-${name}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('[data-in]').isVisible(), true);
  }
  await page.reload();
  await page.evaluate(async () => { await import('/test/capcom-handoff.fixture.ts' as string); });
  await page.locator('.capcom__handoff').waitFor();
  assert.equal(await page.locator('.capcom__handoff').count(), 1);
  // Abrirlo fue una decisión: sigue abierto tras recargar.
  assert.equal(await page.locator('.capcom__handoff details').evaluate((d) => (d as HTMLDetailsElement).open), true);
  // Y descartarlo devuelve el alto entero a la conversación, también al volver.
  await page.getByRole('button', { name: 'Dismiss this notice' }).click();
  assert.equal(await page.locator('.capcom__handoff').count(), 0);
  await page.reload();
  await page.evaluate(async () => { await import('/test/capcom-handoff.fixture.ts' as string); });
  await page.locator('[data-in]').waitFor();
  assert.equal(await page.locator('.capcom__handoff').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Handoff UI: folded by default, unfolds, history buttons, keyboard, draft, replay, dismiss and reload passed.');
} finally { await browser.close(); }
