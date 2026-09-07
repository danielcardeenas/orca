/** Run against Vite: npx tsx test/agent-window.visual.ts. No live agent commands. */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/agent-window-fixture', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/window.css"></head><body style="background:#090a0b;margin:0"><main class="win__body" style="width:min(640px,calc(100vw - 18px));height: min(780px,calc(100dvh - 20px));margin:10px auto"></main></body></html>` }));
  await page.addInitScript('window.__name = (fn) => fn');
  await page.goto('http://127.0.0.1:4478/agent-window-fixture');
  await page.evaluate(async () => { await import('/test/agent-window.fixture.ts' as string); });
  await page.locator('[data-thread] article').first().waitFor({timeout:5000});
  assert.deepEqual(await page.locator('[data-thread] .talk__who').allTextContents().then((x) => x.map((v) => v.startsWith('YOU') ? 'human' : 'agent')), ['human', 'agent']);
  assert.equal(await page.locator('details[open]').count(), 0);
  assert.equal(await page.locator('[data-thread] a[href="https://example.com/docs"]').count(), 1);
  assert.equal(await page.locator('[data-thread] .talk__table th').count(), 2);
  assert.equal(await page.locator('[data-thread] .talk__table td').count(), 4);
  assert.equal(await page.locator('[data-thread] .hljs-keyword').count() > 0, true);

  await page.locator('[data-step="r"] summary').click();
  const composer = page.locator('[data-say]');
  await composer.fill('First line');
  await composer.press('Shift+Enter');
  await composer.press('a');
  assert.equal(await composer.inputValue(), 'First line\na');
  await composer.press('Enter');
  assert.equal(await composer.inputValue(), '');
  assert.equal(await page.locator('details[open]').count(), 1);
  assert.match(await page.locator('[data-thread]').innerText(), /Sent · waiting for transcript/i);
  const terminalTab = page.getByRole('tab', { name: /^Terminal$/i });
  assert.equal(await terminalTab.isDisabled(), true);
  assert.equal(await page.locator('[data-term]').isDisabled(), true);
  await page.getByRole('tab', { name: /^Conversation$/i }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: /^Details$/i }).getAttribute('aria-selected'), 'true');
  await page.evaluate(async () => { (await import('/test/agent-window.fixture.ts' as string)).setHosted(true); });
  assert.equal(await terminalTab.isEnabled(), true);
  await terminalTab.click();
  await page.getByRole('button', { name: 'DETACH', exact: true }).waitFor();
  await page.locator('.xterm-helper-textarea').fill('hello');
  await page.getByRole('button', { name: 'DETACH', exact: true }).click();
  await page.getByRole('button', { name: 'REATTACH', exact: true }).click();
  assert.equal(await page.evaluate(async () => (await import('/test/agent-window.fixture.ts' as string)).terminalState.opens), 2);
  await page.evaluate(() => document.fonts.ready);
  await mkdir('test/shots', { recursive: true });
  for (const [label, width, height] of [['desktop', 1000, 900], ['mobile', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => {
      const screen = document.querySelector('.xterm-screen')!.getBoundingClientRect();
      const note = document.querySelector('.term__note')!.getBoundingClientRect();
      return screen.height > 100 && screen.bottom <= note.top + 1 && screen.right <= note.right;
    });
    await page.screenshot({ path: `test/shots/agent-terminal-${label}.png` });
  }
  await page.setViewportSize({ width: 1000, height: 900 });
  assert.equal(await composer.isVisible(), false);
  await page.getByRole('tab', { name: /^Details$/i }).click();
  await page.locator('[data-scroll] .grid4').waitFor();
  await page.getByRole('tab', { name: /^Conversation$/i }).click();
  await page.locator('[data-step="r"] summary').click();
  await page.evaluate(() => document.fonts.ready);
  await mkdir('test/shots', { recursive: true });
  await page.screenshot({ path: 'test/shots/agent-conversation-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test/shots/agent-conversation-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(async () => { (await import('/test/agent-window.fixture.ts' as string)).appendMessages(30); });
  const thread = page.locator('[data-thread]');
  await thread.evaluate((el) => { el.scrollTop = 0; });
  await page.evaluate(async () => { (await import('/test/agent-window.fixture.ts' as string)).appendMessages(1); });
  assert.equal(await thread.evaluate((el) => el.scrollTop), 0);
  await page.getByRole('button', { name: 'Latest messages', exact: true }).click();
  assert.equal(await thread.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop < 2), true);
  await terminalTab.click();
  await page.evaluate(async () => { (await import('/test/agent-window.fixture.ts' as string)).setHosted(false); });
  assert.equal(await terminalTab.isDisabled(), true);
  assert.equal(await page.getByRole('tab', { name: /^Conversation$/i }).getAttribute('aria-selected'), 'true');
  assert.deepEqual(errors, []);
  console.log('Agent window: chronology, collapsed reasoning, multiline send, echo, tab navigation, terminal fallback and mobile layout passed.');
} finally { await browser.close(); }
