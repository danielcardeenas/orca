import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test, ok, type TestModule } from './harness.ts';
// Keep the actual browser fixture in the affected-import graph.
import type * as Fixture from './window-canvas.fixture.ts';
type BrowserFixture = typeof Fixture;
export default {
  suite: 'window-canvas',
  tests: [test('canvas navigation, foreground, tray, content preservation, resize and mobile', async () => {
    const server = await createServer({ configFile: false, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 818 }, reducedMotion: 'reduce' });
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      // A 1×1 PNG stands in for the hub: the file viewer asks HEAD first, then the browser fetches the bytes.
      await page.route('**/api/file**', route => route.fulfill({ status: 200, contentType: 'image/png', headers: { 'x-orca-file-size': '68' },
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') }));
      await page.route('**/canvas-fixture', route => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/window.css"><link rel="stylesheet" href="/src/ui/styles/hud.css"><body style="margin:0;background:var(--bezel);overflow:hidden"></body>' }));
      await page.goto(`${server.resolvedUrls!.local[0]}canvas-fixture`);
      await page.evaluate(async () => { (window as any).fixture = await import('/test/window-canvas.fixture.ts' as string); });
      const change = async (fn: (f: BrowserFixture) => void) => {
        await page.evaluate(`(${fn.toString()})(window.fixture)`); await page.waitForTimeout(80);
      };
      const state = () => page.evaluate(() => {
        const f = (window as any).fixture as BrowserFixture, w = f.win, r = w.el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, mode: w.mode, canvas: w.canvas, w: w.w, h: w.h, mounts: f.mounts, count: f.wm.all().length, minimized: w.minimized, located: f.located.length };
      });
      // A window opens in front, at reading size: at the camera's scale it
      // would arrive too small to read from any ordinary zoom.
      assert.equal(await page.evaluate(() => (window as any).fixture.openedMode), 'front');
      await page.getByRole('textbox', { name: 'Draft' }).fill('Unsent work');
      await page.frameLocator('iframe').locator('input').fill('Iframe work');
      await change(f => { f.win.body.querySelector('.win__scroll')!.scrollTop = 150; });
      const initial = await state();
      await change(f => { f.plane.origin.x -= 220; f.plane.origin.y += 90; });
      const panned = await state(); assert.equal(panned.x, initial.x - 220); assert.equal(panned.y, initial.y + 90);
      // From afar the window is the window, small. No card stands in for it,
      // nothing fades, nothing hides: the body stays laid out and visible.
      const look = () => page.locator('.win').first().evaluate(e => {
        const cs = getComputedStyle(e);
        // `is-far` is allowed: it changes what a press does, not what is drawn.
        return { opacity: cs.opacity, clicks: cs.pointerEvents, classes: [...e.classList].filter(c => /overview|ghost|stamp|summary/.test(c)),
          body: getComputedStyle(e.querySelector('.win__body')!).visibility, summary: !!e.querySelector('[data-w-summary]') };
      });
      await change(f => { f.plane.ppu /= 4; });
      assert.equal((await state()).width, initial.width / 4);
      const far = await look();
      assert.deepEqual(far, { opacity: '1', clicks: 'auto', classes: [], body: 'visible', summary: false }, 'No far rendering: the housing itself, small');
      await change(f => { f.plane.ppu /= 2; });
      assert.equal((await state()).width, initial.width / 8, 'Farther is only smaller');
      assert.deepEqual(await look(), far, 'Farther changes nothing but size');
      assert.equal((await state()).w, initial.w, 'Zoom preserves the window layout size');
      // From this far the window is a stamp: a press-and-drag anywhere on it,
      // body included, moves it, and the body does not take the pointer.
      const stamp = await state();
      const r8 = await page.locator('.win').first().boundingBox(); assert(r8);
      assert.equal(await page.locator('.win').first().evaluate(e => getComputedStyle(e.querySelector('.win__body')!).pointerEvents), 'none');
      await page.mouse.move(r8.x + r8.width / 2, r8.y + r8.height * 0.6); await page.mouse.down();
      await page.mouse.move(r8.x + r8.width / 2 + 50, r8.y + r8.height * 0.6 + 30, { steps: 3 }); await page.mouse.up();
      await page.waitForTimeout(100);
      const carried = await state();
      assert.equal(carried.x, stamp.x + 50, 'A far window drags from its body'); assert.equal(carried.y, stamp.y + 30);
      assert.equal(carried.mode, 'canvas', 'Dragging a stamp does not bring it forward');
      await page.evaluate((c) => { const f = (window as any).fixture as BrowserFixture; f.win.canvas = c!; f.wm.reproject(); }, stamp.canvas);
      await page.waitForTimeout(80);
      assert.equal((await state()).x, stamp.x, 'Put back where it was for the rest of the suite');
      await mkdir('test/shots', { recursive: true });
      await page.screenshot({ path: 'test/shots/window-canvas-overview.png' });
      // A pinch on a canvas window's housing zooms the field; the same pinch
      // over an image in a file window zooms the image and nothing else.
      const pinches = () => page.evaluate(() => (window as any).fixture.zooms as number);
      await change(f => { f.wm.returnToCanvas(f.wm.open({ kind: 'file', key: 'shot', params: { path: '/tmp/shot.png' }, w: 300, h: 300 })); });
      const pinch = (sel: string) => page.locator(sel).evaluate(el => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true })));
      await page.locator('.win[data-kind="file"] .file__img').waitFor();
      await pinch('.win[data-kind="file"] .win__head');
      assert.equal(await pinches(), 1, 'A pinch on the housing reaches the field');
      await pinch('.win[data-kind="file"] .file__img');
      assert.equal(await pinches(), 1, 'A pinch on the image stays in the image');
      assert.match(await page.locator('.win[data-kind="file"] [data-meta]').textContent() ?? '', /%$/, 'The image itself zoomed');
      await change(f => { f.wm.close(f.wm.all().find(w => w.spec.kind === 'file')!); });
      await page.locator('.tray [data-w]').click(); await page.waitForTimeout(100);
      assert.equal((await state()).mode, 'canvas'); assert.equal((await state()).located, 1);
      assert((await state()).width >= initial.width * 0.75);
      await page.getByRole('button', { name: 'Bring to front', exact: true }).click();
      assert.equal((await state()).mode, 'front'); assert.equal((await state()).width, initial.width);
      await change(f => { f.plane.origin.x -= 3000; });
      const front = await state(); assert(front.x >= 8);
      await page.screenshot({ path: 'test/shots/window-canvas-front.png' });
      await page.getByRole('button', { name: 'Fix to screen', exact: true }).click();
      assert.equal((await state()).mode, 'pinned');
      await page.locator('.tray [data-w]').click(); await page.waitForTimeout(100); assert.equal((await state()).minimized, true);
      await page.locator('.tray [data-w]').click(); await page.waitForTimeout(100); assert.equal((await state()).mode, 'pinned');
      assert.equal((await state()).minimized, false);
      await page.getByRole('button', { name: 'Return to canvas', exact: true }).click();
      // Three thousand units of panning ago that seat was somewhere the
      // operator could see. It is not any more, and a window sent to a place
      // nobody is looking at is a window the tray has to rescue. So the stale
      // seat is given up and the window lands in the view they chose.
      const dropped = await state();
      assert.equal(dropped.mode, 'canvas');
      assert(dropped.x > 0 && dropped.x < 1200, `A stale seat is given up, not flown to: ${dropped.x}`);
      assert.notDeepEqual(dropped.canvas, initial.canvas, 'and taking the current view means taking a new seat');
      await page.locator('.tray [data-w]').click(); await page.waitForTimeout(100);
      assert.equal(await page.getByRole('textbox', { name: 'Draft' }).inputValue(), 'Unsent work');
      assert.equal(await page.frameLocator('iframe').locator('input').inputValue(), 'Iframe work');
      assert.equal(await page.locator('.win__scroll').evaluate(e => e.scrollTop), 150);
      assert.equal((await state()).mounts, 1, 'Retrieval never remounts a body');
      assert.equal((await state()).mode, 'canvas');
      const locatedBefore = (await state()).located;
      await page.locator('.tray [data-w]').click(); await page.waitForTimeout(100);
      assert.equal((await state()).minimized, true); assert.equal((await state()).mode, 'canvas');
      await page.locator('.tray [data-w]').click(); await page.waitForTimeout(100);
      assert.equal((await state()).minimized, false); assert.equal((await state()).mode, 'canvas');
      assert.equal((await state()).located, locatedBefore, 'A visible restored window does not move the camera');
      await change(f => { f.wm.minimize(f.win); f.wm.bringForward(f.win); });
      assert.equal((await state()).mode, 'front'); assert.equal((await state()).minimized, false);
      await page.getByRole('button', { name: 'Return to canvas', exact: true }).click();
      // Camera and seat both back to where the suite started; the seat by
      // hand, because the window gave up the original one two steps ago.
      await page.evaluate((c) => {
        const f = (window as any).fixture as BrowserFixture;
        f.plane.origin.x = 600; f.plane.origin.y = 400; f.plane.ppu = 40;
        f.win.canvas = c!; f.wm.reproject();
      }, initial.canvas);
      await page.waitForTimeout(80);
      assert.equal((await state()).x, initial.x); assert.deepEqual((await state()).canvas, initial.canvas);
      const head = await page.locator('.win__head').boundingBox(); assert(head);
      await page.mouse.move(head.x + 70, head.y + 14); await page.mouse.down(); await page.mouse.move(head.x + 130, head.y + 44); await page.mouse.up();
      const dragged = await state(); assert.equal(dragged.x, initial.x + 60);
      await page.waitForTimeout(100); assert.equal((await state()).x, dragged.x);
      // At reading scale the body is for working in: a press-and-drag on it is
      // the body's, and the window stays where it is.
      const body = await page.locator('.win__scroll').boundingBox(); assert(body);
      await page.mouse.move(body.x + 40, body.y + 40); await page.mouse.down();
      await page.mouse.move(body.x + 100, body.y + 80, { steps: 3 }); await page.mouse.up();
      assert.equal((await state()).x, dragged.x, 'A readable window does not drag from its body');
      // Resize at 75% scale: a 30 px hand movement adds 40 layout pixels.
      await change(f => { f.plane.ppu = 30; });
      const grip = await page.locator('.win__grip').boundingBox(); assert(grip);
      const beforeResize = await state();
      await page.mouse.move(grip.x + 3, grip.y + 3); await page.mouse.down();
      await page.mouse.move(grip.x + 33, grip.y + 18); await page.mouse.up();
      assert.equal((await state()).w, beforeResize.w + 40);
      assert.equal((await state()).h, beforeResize.h + 20);
      await change(f => { f.plane.ppu = 40; });
      await page.waitForTimeout(350);
      const saved = (await state()).canvas;
      await page.reload();
      await page.evaluate(async () => { (window as any).fixture = await import('/test/window-canvas.fixture.ts' as string); });
      assert.deepEqual((await state()).canvas, saved, 'World placement survives reload');
      await page.screenshot({ path: 'test/shots/window-canvas-workspace.png' });
      await page.setViewportSize({ width: 390, height: 700 }); await page.waitForTimeout(150);
      assert.equal(await page.locator('[data-w-pin]').isVisible(), false);
      const mobile = await state(); assert(mobile.x >= 0 && mobile.x + mobile.width <= 390);
      await page.screenshot({ path: 'test/shots/window-canvas-mobile.png' });
      await change(f => { f.wm.open({ kind: 'help', key: 'opened-on-mobile' }); });
      await page.setViewportSize({ width: 1200, height: 818 }); await page.waitForTimeout(100);
      assert.equal((await state()).x, dragged.x);
      assert.equal(await page.evaluate(() => (window as any).fixture.wm.all().every((w: any) => !!w.canvas)), true, 'Mobile-created windows join the canvas on desktop');
      await change(f => {
        for (const w of f.wm.all()) f.wm.close(w);
        f.plane.ppu = 16;
        f.wm.toggleSource('source-agent', () => f.wm.open({ kind: 'help', key: 'source-agent', anchor: 'agent', w: 640, h: 500 }));
      });
      const agentSize = () => page.evaluate(() => {
        const f = (window as any).fixture as BrowserFixture, w = f.wm.all()[0]!;
        return { canvas: w.canvas, worldWidth: w.w / w.canvas!.ppu, scale: w.scale };
      });
      const farAgent = await agentSize(); assert.equal(farAgent.worldWidth, 2);
      await change(f => { f.plane.ppu = 320; });
      assert.equal((await agentSize()).worldWidth, farAgent.worldWidth);
      assert.equal((await agentSize()).scale, 1);
      await change(f => { f.wm.toggleSource('source-agent', () => { throw new Error('Must close existing'); }); });
      assert.equal(await page.evaluate(() => (window as any).fixture.wm.all().length), 0);
      await change(f => { f.wm.toggleSource('source-agent', () => f.wm.open({ kind: 'help', key: 'source-agent', anchor: 'agent', w: 640, h: 500 })); });
      assert.deepEqual((await agentSize()).canvas, farAgent.canvas, 'Opening near or far uses the same world placement and size');
      // The pipe to the tile survives the tile leaving the screen: it runs off
      // the edge and says where the window came from. Only a tile behind the
      // camera, whose projection is a mirror, gets no line.
      const tether = () => page.evaluate(() => document.querySelector('.tether polyline')?.getAttribute('points') ?? null);
      assert((await tether())?.startsWith('250,') || (await tether())?.startsWith('430,'), `Pipe starts at the tile on screen: ${await tether()}`);
      await change(f => { f.tile.x = -900; f.tile.visible = false; });
      assert((await tether())?.startsWith('-720,'), `Pipe still drawn to a tile off screen, from its right edge: ${await tether()}`);
      await change(f => { f.tile.ahead = false; });
      assert.equal(await tether(), null, 'No pipe to a tile behind the camera');
      await change(f => { f.tile.x = 250; f.tile.visible = true; f.tile.ahead = true; });

      /* ── Out of view: the tray is the only witness ───────────────────
         A window on the canvas leaves the screen the moment the camera walks
         away from it, and nothing on the glass says where it went. Its tile
         does — and it notices on its own, under a pan, with nothing clicked. */
      await change(f => {
        for (const w of f.wm.all()) f.wm.close(w);
        f.plane.origin.x = 600; f.plane.origin.y = 400; f.plane.ppu = 40;
        f.wm.returnToCanvas(f.wm.open({ kind: 'help', key: 'away-1', callsign: 'AWAY', w: 320, h: 240 }));
      });
      const placed = () => page.locator('.tray [data-w] small').first().textContent();
      const isAway = () => page.locator('.tray [data-w]').first().evaluate(e => e.classList.contains('is-away'));
      assert.equal(await placed(), 'canvas'); assert.equal(await isAway(), false);
      await change(f => { f.plane.origin.x -= 4000; });
      assert.equal(await placed(), 'off view', 'The tray says it, without being asked');
      assert.equal(await isAway(), true);
      await change(f => { f.plane.origin.x += 4000; });
      assert.equal(await placed(), 'canvas', 'and takes it back when the camera returns');

      /* ── The scroll chains to the field ─────────────────────────────
         A window on the canvas stands *in* the space, so running its list out
         and pushing on has to move the field — the same gesture, without
         lifting off. The split happens inside one event, so neither the
         window nor the field ever moves by the whole delta. */
      await change(f => {
        for (const w of f.wm.all()) f.wm.close(w);
        f.panned.length = 0;
        f.plane.origin.x = 600; f.plane.origin.y = 400; f.plane.ppu = 40;
        f.wm.returnToCanvas(f.wm.open({ kind: 'help', key: 'chain', callsign: 'CHAIN', w: 380, h: 560 }));
      });
      const over = await page.locator('.win__scroll').first().boundingBox(); assert(over);
      assert(over.height > 40, `The list is worth aiming at: ${over.height}`);
      await page.mouse.move(over.x + over.width / 2, over.y + over.height / 2);
      const chain = () => page.evaluate(() => {
        const f = (window as any).fixture as BrowserFixture;
        const el = document.querySelector('.win__scroll') as HTMLElement;
        return { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight),
          panned: f.panned.map(p => ({ dx: Math.round(p.dx), dy: Math.round(p.dy) })) };
      });
      const start = await chain();
      assert(start.max > 200, `The list has somewhere to go: ${start.max}`);
      // With room left the browser does the scrolling, as it always has: the
      // field hears nothing, and the wheel keeps its own smoothing.
      await page.mouse.wheel(0, 60); await page.waitForTimeout(250);
      const inside = await chain();
      assert(inside.top > 0, `The list scrolled: ${inside.top}`);
      assert.deepEqual(inside.panned, [], 'and the field stayed still');
      // Twenty pixels from the end, a sixty-pixel wheel spends twenty and
      // hands forty on: one frame, one movement, nothing counted twice.
      await page.evaluate(() => { const e = document.querySelector('.win__scroll') as HTMLElement; e.scrollTop = e.scrollHeight - e.clientHeight - 20; });
      await page.mouse.wheel(0, 60); await page.waitForTimeout(150);
      const edge = await chain();
      assert.equal(edge.top, edge.max, 'The list finishes its last twenty');
      assert.deepEqual(edge.panned, [{ dx: 0, dy: 40 }], 'and the field takes exactly the rest');
      // Exhausted, the whole gesture is the field's.
      await page.mouse.wheel(0, 60); await page.waitForTimeout(150);
      const spent = await chain();
      assert.deepEqual(spent.panned.at(-1), { dx: 0, dy: 60 });
      assert.equal(spent.top, edge.max, 'and the list does not move again');
      // Upwards, and sideways: the list has no horizontal scroll, so a
      // sideways wheel belongs to the field from the first pixel.
      await page.evaluate(() => { (document.querySelector('.win__scroll') as HTMLElement).scrollTop = 0; });
      await page.mouse.wheel(0, -60); await page.waitForTimeout(150);
      assert.deepEqual((await chain()).panned.at(-1), { dx: 0, dy: -60 }, 'Upwards too');
      await page.mouse.wheel(50, 0); await page.waitForTimeout(150);
      assert.deepEqual((await chain()).panned.at(-1), { dx: 50, dy: 0 }, 'and sideways');
      // In front the window is a page over the glass: running a list out
      // there must not drag the field along underneath it.
      await change(f => { f.wm.bringForward(f.wm.all()[0]!); f.panned.length = 0; });
      const up = await page.locator('.win__scroll').first().boundingBox(); assert(up);
      await page.mouse.move(up.x + up.width / 2, up.y + up.height / 2);
      await page.evaluate(() => { const e = document.querySelector('.win__scroll') as HTMLElement; e.scrollTop = e.scrollHeight; });
      await page.mouse.wheel(0, 60); await page.waitForTimeout(150);
      assert.deepEqual((await chain()).panned, [], 'A window in front keeps the field still');
      await change(f => { f.wm.returnToCanvas(f.wm.all()[0]!); });

      /* ── `+` is the pair of `-` ──────────────────────────────────── */
      const first = () => page.evaluate(() => {
        const f = (window as any).fixture as BrowserFixture, w = f.wm.all()[0]!;
        return { mode: w.mode, minimized: w.minimized, seats: f.wm.seats() };
      });
      await change(f => {
        const w = f.wm.all()[0]!;
        f.wm.focus(w);
        f.wm.handleKey(new KeyboardEvent('keydown', { key: '=' }));
      });
      assert.equal((await first()).mode, 'front', '`+` brings a canvas window up to reading size');
      await change(f => { f.wm.handleKey(new KeyboardEvent('keydown', { key: 'Escape' })); });
      assert.equal((await first()).mode, 'canvas', 'and `Esc` is still the way back out');
      // In the tray row it does the same and leaves the row, unlike `-`.
      await change(f => {
        f.wm.enterTrayMode();
        f.wm.handleKey(new KeyboardEvent('keydown', { key: '+', shiftKey: true }));
      });
      assert.equal((await first()).mode, 'front');
      assert.equal(await page.evaluate(() => (window as any).fixture.wm.trayMode()), false);

      /* ── Two windows dropped home do not land on each other ───────── */
      await change(f => {
        for (const w of f.wm.all()) f.wm.close(w);
        const a = f.wm.open({ kind: 'help', key: 'seat-1', callsign: 'ONE', w: 320, h: 240 });
        const b = f.wm.open({ kind: 'help', key: 'seat-2', callsign: 'TWO', w: 320, h: 240 });
        f.wm.bringForward(a); f.wm.bringForward(b);
        // Both are centred on the glass now, and both seats are stale, so both
        // are about to be dropped in the same place.
        f.plane.origin.x -= 4000;
        f.wm.returnToCanvas(a); f.wm.returnToCanvas(b);
      });
      const overlap = (s: { x: number; y: number; w: number; h: number }[]) =>
        s[0]!.x < s[1]!.x + s[1]!.w && s[0]!.x + s[0]!.w > s[1]!.x
        && s[0]!.y > s[1]!.y - s[1]!.h && s[0]!.y - s[0]!.h < s[1]!.y;
      const dropped2 = (await first()).seats;
      assert.equal(dropped2.length, 2);
      assert.equal(overlap(dropped2), false, `A seat the manager chose gets out of the way: ${JSON.stringify(dropped2)}`);
      // A seat the operator chooses is never moved: dropping one window on
      // top of another is something people do on purpose.
      const boxes = await page.locator('.win').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
      assert.equal(boxes.length, 2);
      const head2 = await page.locator('.win').nth(1).locator('.win__head').boundingBox(); assert(head2);
      await page.mouse.move(head2.x + 40, head2.y + 10); await page.mouse.down();
      await page.mouse.move(boxes[0]!.x + 40 + (head2.x - boxes[1]!.x), boxes[0]!.y + 10 + (head2.y - boxes[1]!.y), { steps: 4 });
      await page.mouse.up(); await page.waitForTimeout(120);
      assert.equal(overlap((await first()).seats), true, 'Dragged onto another window, it stays where the hand left it');
      await change(f => { for (const w of f.wm.all()) f.wm.close(w); });
      // The flight out to the canvas, on a page that allows motion — this
      // suite's own page asks for none. Sending a window to the world moves it
      // to a world coordinate that may be nowhere near the glass, and the
      // gesture is the whole answer to "where did it go": the housing leaves
      // where it stood, shrinks to the camera's scale and is drawn all the way
      // out, off the edge when that is where its seat is. Reduced motion gets
      // the cut instead, and no transform at all.
      const flight = async (reducedMotion: 'reduce' | 'no-preference') => {
        const p2 = await browser.newPage({ viewport: { width: 1200, height: 818 }, reducedMotion });
        p2.on('pageerror', e => errors.push(e.message));
        await p2.route('**/canvas-fixture', route => route.fulfill({ contentType: 'text/html', body:
          '<!doctype html><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/window.css"><link rel="stylesheet" href="/src/ui/styles/hud.css"><body style="margin:0;background:var(--bezel);overflow:hidden"></body>' }));
        await p2.goto(`${server.resolvedUrls!.local[0]}canvas-fixture`);
        await p2.evaluate(async () => { (window as any).fixture = await import('/test/window-canvas.fixture.ts' as string); });
        await p2.waitForTimeout(120);
        await p2.evaluate(() => { const f = (window as any).fixture as BrowserFixture; f.wm.bringForward(f.win); });
        await p2.waitForTimeout(120);
        const from = await p2.evaluate(() => Math.round((window as any).fixture.win.el.getBoundingClientRect().x));
        // Give it a seat in the bottom-left corner at half the camera's scale,
        // so the trip is long, diagonal and entirely on screen — a seat out of
        // view would be given up rather than flown to, which is the previous
        // test. The mid-flight sample is taken by the page itself: the tween
        // is `T.quick` and a round trip through the driver could easily land
        // after it, which would read as "it never flew".
        const flying = await p2.evaluate(() => new Promise<{ x: number; w: number; seat: number; seatW: number }>((resolve) => {
          const f = (window as any).fixture as BrowserFixture;
          const p = f.plane;
          f.win.canvas = { x: (40 - p.origin.x) / p.ppu, y: (p.origin.y - 520) / p.ppu, ppu: p.ppu * 2 };
          f.wm.returnToCanvas(f.win);
          setTimeout(() => {
            const r = f.win.el.getBoundingClientRect();
            resolve({ x: Math.round(r.x), w: Math.round(r.width), seat: Math.round(f.win.x), seatW: Math.round(f.win.w * f.win.scale) });
          }, 90);
        }));
        await p2.waitForTimeout(700);
        const landed = await p2.evaluate(() => {
          const f = (window as any).fixture as BrowserFixture;
          return { x: Math.round(f.win.el.getBoundingClientRect().x), transform: f.win.el.style.transform, seat: Math.round(f.win.x) };
        });
        await p2.close();
        return { from, flying, landed };
      };
      const flown = await flight('no-preference');
      assert(flown.flying.x < flown.from && flown.flying.x > flown.flying.seat,
        `Mid-flight the housing is between the glass and its seat: ${JSON.stringify(flown)}`);
      assert(flown.flying.w > flown.flying.seatW, 'and still larger than what the camera will leave it');
      assert.equal(flown.landed.x, flown.landed.seat, 'It lands on its seat');
      assert.equal(flown.landed.transform, '', 'and gives `transform` back: left/top stay the one truth');
      const cut = await flight('reduce');
      assert.equal(cut.flying.x, cut.flying.seat, 'Reduced motion: no flight, the window is already there');
      assert.deepEqual(errors, []);
      return ok('pan, zoom, overview, tray, front/fixed, draft + iframe + scroll retained, fold, drag, mobile', true);
    } finally { await browser.close(); await server.close(); }
  })],
} satisfies TestModule;
