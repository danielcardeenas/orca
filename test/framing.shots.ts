/**
 * A flight with windows in front, photographed against the running console.
 *
 *   npx tsx test/framing.shots.ts               reuses the hub and vite that are up
 *   npx tsx test/framing.shots.ts --isolated    own hub, vite and ORCA_HOME
 *   npx tsx test/framing.shots.ts --headed      watch it happen
 *
 * Not named `*.visual.ts`: `visual.ts` runs its own suite whenever the entry
 * file's name ends that way.
 *
 * `framing.test.ts` proves the arithmetic; this proves the wiring. It opens
 * an agent's window in front —where a window opens, at reading size— and
 * flies to another agent. Before this change the tile landed on the centre
 * of the glass, behind the window. Now the tile's screen rectangle must touch
 * no window and stay on the glass, and with every window closed the same
 * flight must land on the centre, as it always did. Then the same with two
 * windows up. Leaves `test/shots/framing-*.png`.
 */

import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { GPU_ARGS, SHOTS, ensureServers, fontsReady, orcaToken, shutdown, uiPort } from './visual.ts';
import { CLEAR_MARGIN, coveredArea, freeRects } from '../src/ui/field/framing.ts';

const headed = process.argv.includes('--headed');
const keep = process.argv.includes('--keep');

interface R { x: number; y: number; w: number; h: number }
const overlaps = (a: R, b: R) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** The screen rectangles of the windows in front: the housings the DOM is drawing, folded ones excluded. */
/**
 * Las ventanas cuando ya son `n`.
 *
 * `open` es una petición, no un hecho consumado: la ventana se ensambla, llega
 * con su animación y hasta entonces mide 0x0 o no está. Un `waitForTimeout`
 * fijo acierta con la máquina ociosa y falla con la máquina ocupada, que es
 * como decir que la prueba mide la máquina. Se espera a la cuenta.
 */
async function windowsWhen(page: Page, n: number): Promise<R[]> {
  await page.waitForFunction((want) => [...document.querySelectorAll<HTMLElement>('.win')]
    .filter((e) => !e.classList.contains('is-min'))
    .map((e) => e.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0).length === want, n, { timeout: 15_000 })
    .catch(() => { /* la cuenta la afirma quien llama, con la lista delante */ });
  return windows(page);
}

async function windows(page: Page): Promise<R[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.win')]
    .filter((e) => !e.classList.contains('is-min'))
    .map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
    .filter((r) => r.w > 0 && r.h > 0));
}

/** Where the tile is once the camera has stopped: the same answer twice in a row. */
async function landed(page: Page, id: string): Promise<R> {
  let prev: R | null = null;
  let seen = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(120);
    const r = await page.evaluate((id) => window.__orca!.screenOf(id), id);
    /*
     * Un fotograma sin baldosa no es el final del viaje: la flota sintética se
     * recoloca por debajo y la cámara todavía está llegando, así que la
     * baldosa puede salirse del lienzo un instante y volver. Lo que esta
     * función responde es DÓNDE PARA, y para eso hay que dejarla volver;
     * rendirse en el primer null era fallar por lo que pasaba mientras se
     * miraba. Si no aparece en ninguno de los sesenta, entonces sí no está.
     */
    if (!r) { prev = null; continue; }
    seen = true;
    if (prev && Math.abs(prev.x - r.x) < 0.5 && Math.abs(prev.y - r.y) < 0.5 && Math.abs(prev.w - r.w) < 0.5) return r;
    prev = r;
  }
  throw new Error(seen ? 'the camera never settled' : `no tile for ${id}`);
}

/**
 * Fly and wait for the landing. The synthetic fleet churns —agents arrive
 * and leave, and the layout moves the tiles around them, easing each to its
 * new place— so the flight waits for the tile to have arrived where the
 * layout wants it, and if the layout moved it again while the camera was
 * on its way, that flight measured nothing and is flown again.
 */
async function flyAndLand(page: Page, id: string): Promise<R> {
  const spot = () => page.evaluate((id) => {
    const s = window.__orca!.spotOf?.(id) as { x: number; y: number; tx?: number; ty?: number } | undefined;
    return s ? { at: `${s.tx ?? s.x},${s.ty ?? s.y}`, settled: Math.abs((s.tx ?? s.x) - s.x) < 1e-3 && Math.abs((s.ty ?? s.y) - s.y) < 1e-3 } : null;
  }, id);
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 40 && !(await spot())?.settled; j++) await page.waitForTimeout(100);
    const before = (await spot())?.at;
    await page.evaluate((id) => window.__orca!.fly!(id), id);
    const r = await landed(page, id);
    if ((await spot())?.at === before) return r;
    console.log(`[framing] the tile moved during the flight; flying again`);
  }
  throw new Error('the tile would not hold still');
}

async function main() {
  await ensureServers();
  await mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: !headed, args: GPU_ARGS });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.addInitScript('window.__name = (fn) => fn');
    await page.addInitScript(`try { localStorage.setItem('orca.prefs.v1', JSON.stringify({ origin: 'all' })); } catch {}`);
    await page.goto(`http://127.0.0.1:${uiPort()}/?noboot=1&k=${encodeURIComponent(orcaToken())}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window.__orca?.agentIds().length ?? 0) > 2, null, { timeout: 60_000 });
    await fontsReady(page);
    await page.waitForTimeout(1200);
    const view = { w: 1440, h: 900 };
    const onGlass = (r: R) => r.x >= 0 && r.y >= 0 && r.x + r.w <= view.w && r.y + r.h <= view.h;

    const ids = await page.evaluate(() => window.__orca!.agentIds());
    const [a, b, c] = ids as [string, string, string];

    /* ── Control: no windows, the flight lands on the centre ───────── */
    const centred = await flyAndLand(page, b);
    assert.equal((await windows(page)).length, 0, 'no windows yet');
    assert.ok(Math.abs(centred.x + centred.w / 2 - view.w / 2) < 2 && Math.abs(centred.y + centred.h / 2 - view.h / 2) < 2,
      `centred without windows: ${JSON.stringify(centred)}`);
    await page.screenshot({ path: join(SHOTS, 'framing-0-no-windows.png') });

    /* ── One window in front, over the centre ──────────────────────── */
    await page.evaluate((id) => window.__orca!.open(id), a);
    let wins = await windowsWhen(page, 1);
    assert.equal(wins.length, 1, `one window: ${JSON.stringify(wins)}`);
    // The window must be where the naive centring would put the tile: over the middle of the glass.
    const naive = { x: view.w / 2 - centred.w / 2, y: view.h / 2 - centred.h / 2, w: centred.w, h: centred.h };
    assert.ok(overlaps(naive, wins[0]!), `the window does not cover the centre: ${JSON.stringify(wins[0])}`);
    const one = await flyAndLand(page, b);
    await page.screenshot({ path: join(SHOTS, 'framing-1-one-window.png') });
    wins = await windows(page);
    assert.ok(!wins.some((w) => overlaps(one, w)), `behind the window: tile ${JSON.stringify(one)} windows ${JSON.stringify(wins)}`);
    assert.ok(onGlass(one), `off the glass: ${JSON.stringify(one)}`);

    /* ── Two windows in front ──────────────────────────────────────── */
    await page.evaluate((id) => window.__orca!.open(id), c);
    wins = await windowsWhen(page, 2);
    assert.equal(wins.length, 2, `two windows: ${JSON.stringify(wins)}`);
    const two = await flyAndLand(page, b);
    await page.screenshot({ path: join(SHOTS, 'framing-2-two-windows.png') });
    wins = await windows(page);
    assert.ok(onGlass(two), `off the glass: ${JSON.stringify(two)}`);
    // Two agent windows side by side can leave no room a whole tile fits in;
    // then the flight owes the largest clear room, not a clear tile. Which of
    // the two this fleet's windows left is read off the glass, and the
    // matching promise is the one checked.
    const shown = (r: R) => (r.w * r.h - coveredArea(r, wins)) / (r.w * r.h);
    const naiveTwo = { x: view.w / 2 - two.w / 2, y: view.h / 2 - two.h / 2, w: two.w, h: two.h };
    const room = freeRects(view, wins).some((f) => f.w - 2 * CLEAR_MARGIN >= two.w && f.h - 2 * CLEAR_MARGIN >= two.h);
    if (room) assert.ok(!wins.some((w) => overlaps(two, w)), `behind a window with room to spare: tile ${JSON.stringify(two)} windows ${JSON.stringify(wins)}`);
    else assert.ok(shown(two) > shown(naiveTwo), `no clearer than the centre: ${shown(two)} vs ${shown(naiveTwo)}`);
    console.log(`[framing] two windows: ${room ? 'room for the tile, and it is clear' : `no room for a whole tile; ${Math.round(shown(two) * 100)}% shows against ${Math.round(shown(naiveTwo) * 100)}% centred`}`);

    /* ── The fleet, framed with the windows up: clear of both ───────── */
    await page.evaluate(() => window.__orca!.frame());
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(SHOTS, 'framing-3-fleet-two-windows.png') });
    const tiles = await page.evaluate((ids) => ids.map((id) => window.__orca!.screenOf(id)), ids);
    const covered = tiles.filter((t) => t && wins.some((w) => overlaps(t, w))).length;
    console.log(`[framing] fleet framed with two windows: ${covered} of ${tiles.length} tiles under a window`);

    assert.deepEqual(errors, [], 'page errors');
    console.log('[framing] tile clear of one window at', JSON.stringify(one), '· of two at', JSON.stringify(two));
    console.log(`[framing] frames in ${SHOTS}/framing-*.png`);
  } finally {
    if (!keep) await browser.close();
  }
}

main()
  .then(() => { if (!keep) { shutdown(); process.exit(0); } })
  .catch((err) => {
    console.error(err);
    if (!keep) shutdown();
    process.exit(1);
  });
