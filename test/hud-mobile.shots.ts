/**
 * Las dos secciones del HUD en un teléfono, con el dedo.
 *
 *   npx tsx test/hud-mobile.shots.ts            reutiliza el hub y el vite que haya
 *   npx tsx test/hud-mobile.shots.ts --headed   verlo pasar
 *
 * No se llama `*.visual.ts` a propósito, por lo mismo que `hud-missions.shots.ts`
 * y `hud-improve.shots.ts`: `visual.ts` corre su sesión entera cuando el
 * fichero de entrada acaba así.
 *
 * Lo que se comprueba es lo que un `npm test` no puede ver y lo que una media
 * query no demuestra:
 *
 *   - que las dos secciones tengan **puerta visible** en móvil, sin atajos, sin
 *     hover y sin pasar por CAPCOM
 *   - que se abran como hoja **una a la vez**, sin taparse entre ellas ni tapar
 *     el dock, y que se cierren con el mismo botón, con la × y con Escape
 *   - que lo que se pulsa tenga tamaño de dedo (≥40px) y que el desplegable de
 *     una fila se abra **al tocarlo**
 *   - que una ventana de misión quepa en el viewport, deje el dock libre y
 *     **conserve el borrador** al cerrarla y volver a abrirla
 *   - que AUTOMEJORA se pueda leer y accionar: abrir una ficha, la caja de
 *     respuesta, IMPLEMENT, LATER, DISMISS, SETUP y PAUSE
 *   - apaisado, 360px de ancho, y que el **escritorio siga igual**
 *
 * Las misiones y el tablero se inyectan por el gancho `__orca`, en el store de
 * la consola y no en el hub: una foto no puede dejar rastro en el disco del
 * operador. Por eso mismo aquí no se pulsa nada que viaje al hub —SEND, LATER,
 * DISMISS y REPLY se comprueban como objetivos táctiles, no se disparan—: el
 * hub de este arnés no tiene este tablero y contestaría con el suyo, vacío,
 * llevándose por delante lo que se está midiendo.
 */

import { chromium, devices, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { CapcomMission } from '../src/shared/missions.ts';
import type { ImproveState } from '../src/shared/improve.ts';
import { GPU_ARGS, ROOT, SHOTS, ensureServers, fontsReady, orcaToken, shutdown, uiPort } from './visual.ts';

const headed = process.argv.includes('--headed');
const keep = process.argv.includes('--keep');

/** El teléfono de referencia y el más estrecho que se soporta. */
const PHONE = { width: 390, height: 844 };
const NARROW = { width: 360, height: 640 };
const LANDSCAPE = { width: 844, height: 390 };
const DESKTOP = { width: 1440, height: 900 };

interface Box { x: number; y: number; w: number; h: number; vis: boolean }

async function box(page: Page, sel: string): Promise<Box | null> {
  return page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      vis: getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0,
    };
  }, sel);
}

/** ¿Se pisan? Dos rectángulos que comparten un píxel es un panel tapando otro. */
function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Los controles de una ventana caben en su cabecera. En TODAS las ventanas.
 *
 * Se mide el rectángulo real de cada botón contra el de su `.win__head` y
 * contra el del título: la cabecera no recorta —`overflow` es visible—, así
 * que un botón que se sale no se ve en ninguna medida de altura y sólo lo
 * delata comparar cajas. Por eso esto compara cajas, y por eso se corre en
 * cada tamaño: el fallo que lo motivó sólo aparecía en apaisado, donde la
 * regla de la cabecera iba por ancho y la de los botones por puntero.
 */
async function chromeFits(page: Page, where: string) {
  const found = await page.evaluate(() => {
    const out: { kind: string; w: number; h: number; over: number; under: number; left: number; hits: boolean }[] = [];
    for (const win of document.querySelectorAll<HTMLElement>('.win')) {
      const head = win.querySelector<HTMLElement>('.win__head');
      if (!head || !head.getBoundingClientRect().height) continue;
      const h = head.getBoundingClientRect();
      const title = win.querySelector<HTMLElement>('.win__title')?.getBoundingClientRect();
      for (const b of win.querySelectorAll<HTMLElement>('.win__btn')) {
        const r = b.getBoundingClientRect();
        out.push({
          kind: win.dataset['kind'] ?? '?',
          w: Math.round(r.width), h: Math.round(r.height),
          over: Math.round(h.top - r.top), under: Math.round(r.bottom - h.bottom),
          left: Math.round(r.left - h.left),
          // ¿Pisa el título? Un solapamiento real de cajas, no un «casi».
          hits: !!title && r.left < title.right - 1 && title.left < r.right - 1,
        });
      }
    }
    return out;
  });
  assert.ok(found.length > 0, `${where}: there is a window with chrome to measure`);
  for (const b of found) {
    assert.ok(b.w >= 44 && b.h >= 44, `${where} · ${b.kind}: the control is 44x44 (${b.w}x${b.h})`);
    assert.ok(b.over <= 0, `${where} · ${b.kind}: it does not stick out above the header (${b.over})`);
    assert.ok(b.under <= 0, `${where} · ${b.kind}: it does not stick out below the header (${b.under})`);
    assert.ok(b.left > 0, `${where} · ${b.kind}: it stays inside the header's left edge (${b.left})`);
    assert.ok(!b.hits, `${where} · ${b.kind}: it does not sit on top of the title`);
  }
  return found.length;
}

/** Abre varias clases de ventana: el chrome es compartido y hay que probarlo así. */
async function openSome(page: Page) {
  // Un selector abierto de un paso anterior taparía lo que se va a medir.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.pick__x')?.click();
    document.querySelector<HTMLElement>('.pick__scrim')?.remove();
  });
  await page.evaluate(() => {
    window.__orca!.openKind('ceo');
    window.__orca!.openKind('fleet');
    window.__orca!.openKind('queue');
    const id = window.__orca!.agentIds()[0];
    if (id) window.__orca!.open(id);
  });
  await page.waitForTimeout(1400);
}

/**
 * Nada del cuerpo se pinta sobre la barra de título. Se pregunta al navegador.
 *
 * Comparar cajas no lo ve: los botones cabían en la cabecera y la cabecera
 * desbordaba su fila de la rejilla, así que era el CUERPO el que se pintaba
 * encima. Lo único que distingue «está debajo» de «se ve encima» es el
 * hit-testing: `elementFromPoint` sobre una malla de puntos de la banda de la
 * cabecera —incluidos los centros de los botones y las cuatro esquinas—
 * tiene que devolver siempre la cabecera o algo suyo, nunca nada de
 * `.win__body`.
 *
 * Se comprueba con la lista al principio y a media altura: un panel `sticky` o
 * un `transform` dentro del cuerpo puede subirse a la cabecera sólo cuando se
 * ha desplazado algo.
 */
async function headerClear(page: Page, where: string) {
  const bad = await page.evaluate(() => {
    const out: { kind: string; at: string; hit: string; scrolled: boolean }[] = [];
    const name = (e: Element | null) => e ? `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className || '').split(' ')[0]}` : 'null';
    for (const win of document.querySelectorAll<HTMLElement>('.win')) {
      const head = win.querySelector<HTMLElement>('.win__head');
      const body = win.querySelector<HTMLElement>('.win__body');
      if (!head || !body || !head.getBoundingClientRect().height) continue;
      const scroller = win.querySelector<HTMLElement>('.win__scroll, .scroll');
      for (const pass of [0, 1]) {
        if (pass === 1 && scroller) scroller.scrollTop = Math.round(scroller.scrollHeight / 2);
        const h = head.getBoundingClientRect();
        const xs = [h.left + 6, h.left + h.width * 0.35, h.left + h.width * 0.7, h.right - 8];
        const ys = [h.top + 2, h.top + h.height / 2, h.bottom - 2];
        for (const b of win.querySelectorAll<HTMLElement>('.win__btn')) {
          const r = b.getBoundingClientRect();
          xs.push(r.left + r.width / 2); ys.push(r.top + r.height / 2);
        }
        for (const x of xs) for (const y of ys) {
          const hit = document.elementFromPoint(Math.round(x), Math.round(y));
          // Vale la cabecera, algo dentro de ella, o el propio marco de la
          // ventana. No vale NADA que viva en el cuerpo.
          if (hit && body.contains(hit)) {
            out.push({ kind: win.dataset['kind'] ?? '?', at: `${Math.round(x)},${Math.round(y)}`, hit: name(hit), scrolled: pass === 1 });
          }
        }
      }
      if (scroller) scroller.scrollTop = 0;
    }
    return out;
  });
  assert.deepEqual(bad, [], `${where}: the body paints under the title bar, never over it`);
}

/**
 * Cada clase de ventana, ENTERA y a solas.
 *
 * A solas porque en móvil las ventanas van a pantalla completa y se tapan unas
 * a otras: una captura con cuatro abiertas no enseña si el cuerpo se pinta
 * sobre su cabecera, enseña cuál está delante. Y entera porque un recorte de la
 * cabecera es justo lo que escondió este fallo la vez anterior.
 */
async function shootEachWindow(page: Page, prefix: string, where: string) {
  for (const kind of ['ceo', 'fleet', 'queue', 'agent'] as const) {
    await closeAll(page);
    await page.evaluate((k) => {
      if (k === 'agent') { const id = window.__orca!.agentIds()[0]; if (id) window.__orca!.open(id); }
      else window.__orca!.openKind(k);
    }, kind);
    await page.waitForTimeout(1100);
    const b = await page.evaluate(() => {
      const w = document.querySelector<HTMLElement>('.win');
      if (!w) return null;
      const r = w.getBoundingClientRect();
      return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.width, height: r.height };
    });
    if (!b || b.width < 40) continue;
    await headerClear(page, `${where} · ${kind}`);
    await page.screenshot({ path: `${prefix}-${kind}.png`, clip: b });
  }
  await closeAll(page);
}

/**
 * Un dedo de verdad, por CDP: `Input.dispatchTouchEvent` produce eventos
 * confiables, que es lo que hace falta para probar un gesto. `page.touchscreen`
 * sólo sabe dar toques, y aquí lo que se mide es cuánto se aguanta y cuánto se
 * mueve.
 */
async function touch(page: Page, steps: { at: number; points: { x: number; y: number }[]; type?: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel' }[]) {
  const cdp = await page.context().newCDPSession(page);
  let last = 0;
  for (const s of steps) {
    if (s.at > last) await page.waitForTimeout(s.at - last);
    last = s.at;
    // Un dedo NUEVO es `touchStart` aunque ya hubiera otro abajo: mandarlo
    // como `touchMove` no produce el `pointerdown` del segundo, y entonces la
    // prueba de la pinza no estaría probando una pinza.
    const type = s.type ?? (s.points.length === 0 ? 'touchEnd' : last === 0 ? 'touchStart' : 'touchMove');
    await cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: s.points.map((p, i) => ({ x: Math.round(p.x), y: Math.round(p.y), id: i })),
    });
  }
  await cdp.detach();
}

/**
 * Una baldosa QUIETA en la banda utilizable, entre el mástil y el dock.
 *
 * Quieta importa: la flota sintética entra y sale, el campo se recoloca, y
 * apuntar a donde estaba hace un segundo es apuntar al vacío — que da el menú
 * del campo y parece un fallo del gesto sin serlo. Se muestrea dos veces con
 * medio segundo de por medio y se acepta la que no se ha movido.
 */
async function settledTile(page: Page): Promise<{ id: string; x: number; y: number } | null> {
  const sample = () => page.evaluate(() => {
    /*
     * Nada de bandas a ojo: el HUD tapa distinto en cada orientación —a 844 de
     * ancho el mástil envuelve en dos filas y vuelven el radar, la bandeja y
     * las pistas—, y una baldosa debajo de cualquiera de ellos no recibe el
     * dedo. Se descartan por su rectángulo real.
     */
    const over = ['.mast', '.mmap', '.tray', '.secbar', '.cmd', '.hints', '.bmarks', '.missions', '.improve', '.win']
      .flatMap((s) => [...document.querySelectorAll<HTMLElement>(s)])
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    const out: Record<string, { x: number; y: number }> = {};
    for (const id of window.__orca!.agentIds()) {
      const r = window.__orca!.screenOf(id);
      if (!r) continue;
      const x = Math.round(r.x + r.w / 2), y = Math.round(r.y + r.h / 2);
      if (x < 20 || x > innerWidth - 20 || y < 20 || y > innerHeight - 20) continue;
      if (over.some((o) => x > o.left - 8 && x < o.right + 8 && y > o.top - 8 && y < o.bottom + 8)) continue;
      out[id] = { x, y };
    }
    return out;
  });
  for (let n = 0; n < 4; n++) {
    if (n) { await page.evaluate(() => window.__orca!.frame()); await page.waitForTimeout(1200); }
    const a = await sample();
    await page.waitForTimeout(500);
    const b = await sample();
    const slop = n < 2 ? 4 : 10;
    for (const [id, p] of Object.entries(b)) {
      const q = a[id];
      if (q && Math.abs(q.x - p.x) < slop && Math.abs(q.y - p.y) < slop) return { id, ...p };
    }
  }
  return null;
}

/** Dónde está AHORA el centro de esa baldosa. */
async function tileAt(page: Page, id: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((i: string) => {
    const r = window.__orca!.screenOf(i);
    return r ? { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) } : null;
  }, id);
}

/** Mantener pulsado un punto `ms` y soltar. */
async function hold(page: Page, x: number, y: number, ms: number) {
  await touch(page, [{ at: 0, points: [{ x, y }] }, { at: ms, points: [] }]);
  await page.waitForTimeout(250);
}

/** La cabecera de la ventana de delante, recortada a su propia caja. */
async function shootHead(page: Page, path: string) {
  const r = await page.evaluate(() => {
    const heads = [...document.querySelectorAll<HTMLElement>('.win__head')];
    const head = heads[heads.length - 1];
    if (!head) return null;
    const b = head.getBoundingClientRect();
    return { x: Math.max(0, b.x - 6), y: Math.max(0, b.y - 6), width: b.width + 12, height: b.height + 12 };
  });
  if (r) await page.screenshot({ path, clip: r });
}

async function closeAll(page: Page) {
  await page.evaluate(() => document.querySelectorAll('.win [data-w-close]').forEach((b) => (b as HTMLElement).click()));
  await page.waitForTimeout(500);
}

async function seed(page: Page) {
  await page.evaluate(() => {
    const now = Date.now();
    let n = 0;
    const msg = (role: string, text: string, at: number) => ({ id: `msg_mob_${n++}`, role, text, at });
    const mission = (id: string, title: string, status: string, messages: unknown[], updatedAt: number) =>
      ({ id, title, status, createdAt: updatedAt - 600_000, updatedAt, agentIds: [], messages }) as unknown as CapcomMission;
    for (const m of [
      mission('mission_mob_open', 'Ship the checkout rewrite behind a flag', 'active', [
        msg('human', 'Ship the checkout rewrite behind a flag. Keep the old path behind ORCA_CHECKOUT_V1 so we can turn it back on from the console, and do not touch the refund flow in this pass.', now - 400_000),
        msg('capcom', 'Staging or production first?', now - 120_000),
      ], now - 120_000),
      mission('mission_mob_done', 'Clock in the HUD', 'completed', [
        msg('capcom', 'Done and verified. The report is in /tmp/mob/clock.md', now - 2_000_000),
      ], now - 2_000_000),
    ]) window.__orca!.mission(m);

    // El tablero de AUTOMEJORA. Todo nace visto: abrir una ficha nueva la
    // marcaría leída contra el hub, y este hub no tiene este tablero.
    const p = (over: Record<string, unknown>) => ({
      id: `imp_mob_${n++}`, key: `mob-${n}`, reviewId: 'rev_mob',
      at: now - 3_600_000, updatedAt: now - 3_600_000,
      area: 'usability', kind: 'observed', evidence: [], status: 'open',
      raised: 1, lastRaisedAt: now - 3_600_000, notes: [], seenAt: now - 3_000_000,
      ...over,
    });
    const state = {
      config: { paused: false, everyMin: 360, perDay: 4, minSignal: 40 },
      usage: { since: now - 86_400_000, counts: { 'ui:ceo:say': 74 }, total: 74 },
      signal: { since: now - 3_600_000, counts: { 'ui:ceo:say': 12 }, total: 12 },
      budgetTokens: 120_000,
      pending: null,
      reviews: [{
        id: 'rev_mob', at: now - 3_600_000, trigger: 'auto', reason: '6H SINCE THE LAST REVIEW',
        status: 'ended', callsign: 'RV', reportedAt: now - 3_500_000, endedAt: now - 3_400_000,
        filed: 2, merged: 0, costUSD: 0.31, tokens: 48_000, budgetTokens: 120_000,
      }],
      proposals: {} as Record<string, unknown>,
    };
    for (const item of [
      p({
        title: 'The queue buries the oldest escalation',
        summary: 'Escalations are listed newest first, so the one that has waited longest is furthest from the eye.',
        evidence: ['avg wait 14m over 31 escalations in 24h'],
        detail: 'The queue window sorts by arrival. Reversing it costs one comparator.',
        question: 'Sort by age everywhere, or only in the queue?',
        impact: 'high', effort: 'low',
      }),
      p({
        title: 'CAPCOM rotates before it has to',
        summary: 'Three rotations in 24h, each one a cold start and a re-read of the brief.',
        evidence: ['3 rotations in 24h'],
        impact: 'medium', effort: 'medium', area: 'performance',
      }),
      // Una ya enviada: es la que lleva OPEN MISSION, y con ella se comprueba
      // que desde AUTOMEJORA se llega a la ventana de su misión, también aquí.
      p({
        title: 'The mission panel should carry its results',
        summary: 'A finished mission is a row that says COMPLETED and nothing about what came out of it.',
        evidence: ['9 of 14 finished missions were reopened within an hour'],
        area: 'workflow', impact: 'high', effort: 'medium',
        status: 'sent', missionId: 'mission_mob_done',
      }),
    ]) (state.proposals as Record<string, unknown>)[(item as { id: string }).id] = item;
    window.__orca!.improve(state as unknown as ImproveState, { due: false, reason: 'NEXT IN 3H' });
  });
  await page.waitForTimeout(900);
}

async function main() {
  await ensureServers();
  const browser = await chromium.launch({ headless: !headed, args: GPU_ARGS });
  try {
    const ctx = await browser.newContext({
      ...PHONE && { viewport: PHONE },
      deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: devices['iPhone 13'].userAgent,
      reducedMotion: 'no-preference',
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.addInitScript('window.__name = (fn) => fn');
    // La flota sintética no lleva procedencia verificada y la consola sólo
    // enseña las de ORCA por defecto: sin esto no hay una sola fila con crew.
    await page.addInitScript(`try { localStorage.setItem('orca.prefs.v1', JSON.stringify({ origin: 'all' })); } catch {}`);
    await page.goto(`http://127.0.0.1:${uiPort()}/?noboot=1&k=${encodeURIComponent(orcaToken())}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('.secbar') && !!document.querySelector('.mast__link.is-up'), null, { timeout: 60_000 });
    await fontsReady(page);
    await page.waitForTimeout(1200);
    await seed(page);
    await mkdir(SHOTS, { recursive: true });

    /* ── 1. La puerta está a la vista, y sin hover ────────────────── */

    const bar = (await box(page, '.secbar'))!;
    assert.ok(bar.vis, 'the section bar is on screen without opening anything');
    assert.ok(bar.y + bar.h <= PHONE.height, 'and inside the viewport');
    const btns = await page.locator('.secbar__b:visible').evaluateAll((els) => els.map((e) => ({
      label: (e.querySelector('.secbar__t')?.textContent ?? '').trim(),
      h: Math.round(e.getBoundingClientRect().height),
      w: Math.round(e.getBoundingClientRect().width),
    })));
    assert.deepEqual(btns.map((b) => b.label), ['MISSIONS', 'SELF-IMPROVEMENT'], 'both sections have a door of their own');
    for (const b of btns) assert.ok(b.h >= 44, `a door is a finger target (${b.label} ${b.h}px)`);
    assert.equal((await box(page, '.missions'))?.vis, false, 'nothing occupies the canvas until it is asked for');
    assert.equal((await box(page, '.improve'))?.vis, false);
    await page.screenshot({ path: join(SHOTS, 'mobile-01-closed.png') });

    /* ── 2. Una hoja, y sólo una ──────────────────────────────────── */

    await page.locator('.secbar__b--missions').tap();
    await page.waitForTimeout(400);
    const sheetM = (await box(page, '.missions'))!;
    assert.ok(sheetM.vis, 'MISSIONS opens as a sheet');
    assert.equal(await page.locator('.secbar__b--missions').getAttribute('aria-expanded'), 'true');
    assert.ok(sheetM.x >= 0 && sheetM.x + sheetM.w <= PHONE.width, 'the sheet fits the width');
    assert.ok(!overlaps(sheetM, bar), 'and leaves the bar clear');
    assert.ok(!overlaps(sheetM, (await box(page, '.cmd'))!), 'and the command line clear');
    await page.screenshot({ path: join(SHOTS, 'mobile-02-missions.png') });

    await page.locator('.secbar__b--improve').tap();
    await page.waitForTimeout(400);
    assert.equal((await box(page, '.improve'))?.vis, true, 'AUTOMEJORA opens');
    assert.equal((await box(page, '.missions'))?.vis, false, 'and MISSIONS steps aside: two sheets can never cover each other');
    await page.screenshot({ path: join(SHOTS, 'mobile-03-improve.png') });

    /* ── 3. AUTOMEJORA se puede leer y accionar con el dedo ───────── */

    const cards = await page.locator('.imp').count();
    assert.ok(cards >= 2, `the board is readable in the sheet (${cards} cards)`);
    await page.locator('.imp [data-toggle]').first().tap();
    await page.waitForTimeout(300);
    const open = page.locator('.imp.is-open').first();
    assert.equal(await open.count(), 1, 'a card opens on a tap');
    assert.match(await open.innerText(), /Sort by age everywhere/i, 'the question to the operator is there');
    assert.equal(await open.locator('[data-reply]').count(), 1, 'and the box to answer it');
    const acts = await open.locator('.imp__act, .imp__mission').evaluateAll((els) => els.map((e) => ({
      label: (e.textContent ?? '').trim(), h: Math.round(e.getBoundingClientRect().height),
    })));
    const labels = acts.map((a) => a.label);
    for (const want of ['REPLY', 'IMPLEMENT', 'LATER · 3D', 'DISMISS']) {
      assert.ok(labels.includes(want), `${want} is reachable on the phone (got ${labels.join(', ')})`);
    }
    for (const a of acts) assert.ok(a.h >= 36, `${a.label} is a finger target (${a.h}px)`);
    // Los tres botones del reloj, que es lo que hace la sección controlable.
    for (const sel of ['[data-run]', '[data-pause]', '[data-setup]']) {
      const h = await page.locator(`.improve ${sel}`).evaluate((e) => Math.round(e.getBoundingClientRect().height));
      assert.ok(h >= 36, `${sel} is a finger target (${h}px)`);
    }
    await page.screenshot({ path: join(SHOTS, 'mobile-04-improve-card.png') });

    // Desde una propuesta ya enviada se llega a la ventana de su misión, sin
    // pasar por el panel de misiones ni por CAPCOM.
    // Las acciones sólo existen con la ficha abierta, así que se busca por su
    // título y se abre primero.
    const sent = page.locator('.imp', { hasText: 'The mission panel should carry its results' }).first();
    await sent.locator('[data-toggle]').first().tap();
    await page.waitForTimeout(300);
    const openMission = sent.locator('[data-do="mission"]');
    assert.ok(await openMission.evaluate((e) => Math.round(e.getBoundingClientRect().height)) >= 36,
      'OPEN MISSION is a finger target too');
    await openMission.tap();
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('.win.is-mission').count(), 1,
      'AUTOMEJORA opens the mission in its own window on a phone as well');
    await page.screenshot({ path: join(SHOTS, 'mobile-04b-from-improve.png') });
    await page.locator('.win.is-mission [data-w-close]').tap();
    await page.waitForTimeout(500);

    /* ── 4. Cerrar: el mismo botón, la ×, y Escape ────────────────── */

    await page.locator('.secbar__b--improve').tap();
    await page.waitForTimeout(300);
    assert.equal((await box(page, '.improve'))?.vis, false, 'the same door closes it');
    await page.locator('.secbar__b--missions').tap();
    await page.waitForTimeout(300);
    await page.locator('.secbar__x').tap();
    await page.waitForTimeout(300);
    assert.equal((await box(page, '.missions'))?.vis, false, 'and so does the × next to the doors');
    assert.equal(await page.evaluate(() => document.body.dataset['sheet'] ?? null), null, 'the canvas is free again');
    await page.locator('.secbar__b--missions').tap();
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert.equal((await box(page, '.missions'))?.vis, false, 'Escape closes it too');

    /* ── 5. La fila: su detalle se abre TOCÁNDOLO ─────────────────── */

    await page.locator('.secbar__b--missions').tap();
    await page.waitForTimeout(400);
    const row = page.locator('.missions__row[data-mission="mission_mob_open"]');
    const peekH = await row.locator('[data-peek]').evaluate((e) => Math.round(e.getBoundingClientRect().height));
    assert.ok(peekH >= 36, `the disclosure is a finger target (${peekH}px)`);
    await row.locator('[data-peek]').tap();
    await page.waitForTimeout(400);
    assert.equal(await row.locator('.missions__detail').isVisible(), true, 'a tap opens the detail — no hover, no keyboard');
    assert.match(await row.locator('.missions__full').innerText(), /Ship the checkout rewrite behind a flag/);
    assert.match(await row.locator('.missions__brief').innerText(), /ORCA_CHECKOUT_V1/, 'the whole brief, on a phone');
    // Ninguna fila en blanco: una barra negra sin texto es una fila que se
    // pinta y no dice nada, y en una lista corta se lee como un fallo.
    const blanks = await page.locator('.missions__list > *').evaluateAll((els) => els
      .filter((e) => (e as HTMLElement).offsetHeight > 0 && !((e as HTMLElement).innerText.trim()))
      .map((e) => e.className));
    assert.deepEqual(blanks, [], `every row on the sheet says something (${blanks.join(', ')})`);
    await page.screenshot({ path: join(SHOTS, 'mobile-05-detail.png') });

    /* ── 6. La ventana de misión: cabe, deja el dock y guarda ─────── */

    await row.locator('[data-act="talk"]').tap();
    await page.waitForTimeout(1200);
    const win = (await box(page, '.win.is-mission'))!;
    assert.ok(win.vis, 'the mission opens in its own window');
    assert.ok(win.w <= PHONE.width, 'the window fits the width');
    assert.ok(!overlaps(win, (await box(page, '.secbar'))!), 'and leaves the section bar reachable');
    assert.ok(!overlaps(win, (await box(page, '.cmd'))!), 'and the command line');
    const composer = (await box(page, '.win.is-mission .ceo__in'))!;
    assert.ok(composer.vis && composer.y + composer.h <= PHONE.height, 'the composer is on screen, not under the fold');
    await page.locator('.win.is-mission [data-say]').fill('media línea escrita en el móvil');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, 'mobile-06-window.png') });

    // Cerrar y volver a abrir: ni la misión ni lo escrito se pierden.
    await page.locator('.win.is-mission [data-w-close]').tap();
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.win.is-mission').count(), 0, 'the window closes');
    assert.equal(await page.locator('.missions__row[data-mission="mission_mob_open"]').count(), 1, 'closing it archived nothing');
    await page.locator('.missions__row[data-mission="mission_mob_open"] [data-act="talk"]').tap();
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('.win.is-mission [data-say]').inputValue(), 'media línea escrita en el móvil',
      'and the half-written line is still there');
    // Una terminada abre por sus resultados, también aquí.
    await page.locator('.win.is-mission [data-w-close]').tap();
    await page.waitForTimeout(500);
    await page.locator('.missions__row[data-mission="mission_mob_done"] [data-open]').tap();
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('.win.is-mission .tab.is-on').innerText(), 'MISSION');
    await page.screenshot({ path: join(SHOTS, 'mobile-07-results.png') });
    await page.locator('.win.is-mission [data-w-close]').tap();
    await page.waitForTimeout(500);

    /* ── 6b. El destinatario: sin elección falsa ──────────────────── */

    await page.locator('.missions__row[data-mission="mission_mob_open"] [data-act="talk"]').tap();
    await page.waitForTimeout(1000);
    const talk = page.locator('.win.is-mission .mission-win__talk');
    // Estas misiones no tienen líder: no hay nada que elegir, y no se finge.
    assert.equal(await talk.locator('[data-route]').count(), 0, 'no recipient picker when there is nothing to pick');
    assert.equal(await talk.locator('button:disabled').count(), 0, 'and no disabled button pretending to be an option');
    assert.match(await talk.locator('.mission-win__to').innerText(), /TO CAPCOM/,
      'it says who is listening');

    /* ── 6c. Enter salta línea; ⌘/⌃Enter manda ────────────────────── */

    const say = page.locator('.win.is-mission [data-say]');
    await say.fill('');
    await say.click();
    await page.keyboard.type('uno');
    await page.keyboard.press('Enter');
    await page.keyboard.type('dos');
    await page.waitForTimeout(200);
    assert.equal(await say.inputValue(), 'uno\ndos', 'Enter breaks the line and never sends');
    assert.equal(await page.locator('.win.is-mission .talk__g.is-echo').count(), 0, 'nothing left the console');

    // Un IME componiendo tampoco manda, aunque el evento traiga el modificador.
    await page.evaluate(() => {
      const box = document.querySelector<HTMLTextAreaElement>('.win.is-mission [data-say]')!;
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, isComposing: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.win.is-mission .talk__g.is-echo').count(), 0, 'an IME confirmation is not a send');
    assert.equal(await say.inputValue(), 'uno\ndos', 'and it leaves the text alone');

    // El acorde sí manda, y una sola vez.
    await say.click();
    await page.keyboard.press('ControlOrMeta+Enter');
    await page.waitForTimeout(900);
    assert.equal(await say.inputValue(), '', 'the chord sends and clears the box');
    assert.equal(await page.locator('.win.is-mission .talk__g.is-echo').count(), 1, 'exactly once');
    // Y el botón manda igual, que es lo único que hace falta con el dedo.
    await say.fill('con el dedo');
    await page.locator('.win.is-mission [data-send]').tap();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.win.is-mission .talk__g.is-echo').count(), 2, 'the button sends too');
    assert.equal(await page.locator('.win.is-mission [data-send] kbd').count(), 0, 'and it advertises no key it does not have');
    await page.screenshot({ path: join(SHOTS, 'mobile-06b-composer.png') });

    /* ── 6d. Cerrar y minimizar: 44x44 de verdad ──────────────────── */

    const ctl = await page.locator('.win.is-mission .win__btn').evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      const t = document.createRange();
      t.selectNodeContents(e);
      const g = t.getBoundingClientRect();
      return {
        k: (e as HTMLElement).dataset.wClose !== undefined ? 'close' : (e as HTMLElement).dataset.wMin !== undefined ? 'min' : 'other',
        w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x),
        // Cuánto se desvía el glifo del centro de su botón, en los dos ejes.
        dx: Math.round(Math.abs((g.x + g.width / 2) - (r.x + r.width / 2))),
        dy: Math.round(Math.abs((g.y + g.height / 2) - (r.y + r.height / 2))),
        font: Math.round(parseFloat(getComputedStyle(e).fontSize)),
      };
    }));
    assert.ok(ctl.length >= 2, 'the window has its close and minimize');
    for (const b of ctl) {
      assert.ok(b.w >= 44 && b.h >= 44, `${b.k} is 44x44 (${b.w}x${b.h})`);
      assert.ok(b.dy <= 2 && b.dx <= 2, `${b.k}'s glyph is centred (off by ${b.dx},${b.dy})`);
      assert.ok(b.font >= 16, `${b.k}'s glyph is legible (${b.font}px)`);
    }
    const gap = Math.min(...ctl.slice(1).map((b, i) => b.x - (ctl[i]!.x + ctl[i]!.w)));
    assert.ok(gap >= 4, `they are far enough apart to hit one at a time (${gap}px)`);
    // Y dentro de su cabecera: un botón que sobresale por arriba se toca fuera
    // de la ventana, y ahí el toque es del campo.
    const fit = await page.evaluate(() => {
      const head = document.querySelector('.win.is-mission .win__head')!.getBoundingClientRect();
      return [...document.querySelectorAll('.win.is-mission .win__btn')].map((e) => {
        const r = e.getBoundingClientRect();
        return { over: Math.round(head.top - r.top), under: Math.round(r.bottom - head.bottom) };
      });
    });
    for (const f of fit) {
      assert.ok(f.over <= 1 && f.under <= 1, `the control sits inside the header (over ${f.over}, under ${f.under})`);
    }

    // Y siguen haciendo lo suyo: minimizar deja la ventana en la bandeja y
    // volver a abrirla no pierde nada.
    await page.locator('.win.is-mission [data-w-min]').tap();
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.win.is-mission:not(.is-min)').count(), 0, 'minimize folds it into the tray');
    await page.locator('.tray .tile').first().tap();
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.win.is-mission:not(.is-min)').count(), 1, 'and the tray brings it back');

    /* ── 6e. Los botones táctiles llevan su texto centrado ────────── */

    const off = await page.evaluate(() => {
      const out: { sel: string; dy: number; h: number }[] = [];
      for (const sel of ['.mission-win__act', '.mission-win__routes .chip', '.tab', '.win__btn']) {
        for (const e of [...document.querySelectorAll<HTMLElement>(`.win.is-mission ${sel}`)]) {
          const r = e.getBoundingClientRect();
          if (!r.height) continue;
          const t = document.createRange();
          t.selectNodeContents(e);
          const g = t.getBoundingClientRect();
          if (!g.height) continue;
          out.push({ sel, dy: Math.round(Math.abs((g.y + g.height / 2) - (r.y + r.height / 2))), h: Math.round(r.height) });
        }
      }
      return out;
    });
    for (const b of off) assert.ok(b.dy <= 2, `${b.sel} keeps its label centred in a ${b.h}px box (off by ${b.dy}px)`);
    await page.locator('.win.is-mission [data-w-close]').tap();
    await page.waitForTimeout(500);

    /* ── 6f. Un selector es un diálogo centrado, no un desplegable ── */

    await page.evaluate(() => window.__orca!.openKind('ceo'));
    await page.waitForTimeout(1200);
    const more = page.locator('.win.is-ceo .pick__btn').first();
    if (await more.count()) {
      await more.tap();
      await page.waitForTimeout(500);
      const dlg = (await box(page, '.pick__menu.is-dialog'))!;
      assert.ok(dlg?.vis, 'the picker opens as a dialog');
      assert.equal((await box(page, '.pick__scrim'))?.vis, true, 'with a backdrop that swallows the gesture');
      assert.ok(dlg.x >= 0 && dlg.x + dlg.w <= PHONE.width && dlg.y >= 0 && dlg.y + dlg.h <= PHONE.height,
        'centred inside the viewport');
      assert.ok(Math.abs((dlg.x + dlg.w / 2) - PHONE.width / 2) <= 2, 'and actually centred');
      const items = await page.locator('.pick__menu.is-dialog .pick__item').evaluateAll((els) =>
        els.map((e) => Math.round(e.getBoundingClientRect().height)));
      assert.ok(items.length >= 1, 'with its options in it');
      for (const h of items) assert.ok(h >= 44, `each option is a finger target (${h}px)`);
      assert.equal(await page.locator('.pick__menu.is-dialog .pick__x').isVisible(), true, 'and a visible way out');
      const scrolls = await page.locator('.pick__menu.is-dialog .pick__list').evaluate((e) =>
        getComputedStyle(e).overflowY === 'auto' || getComputedStyle(e).overflowY === 'scroll');
      assert.ok(scrolls, 'the list scrolls inside the dialog');
      await page.screenshot({ path: join(SHOTS, 'mobile-06f-dialog.png') });
      // Escape cierra sin elegir.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      assert.equal(await page.locator('.pick__menu.is-dialog').count(), 0, 'Escape closes it without choosing');
      // Y tocar el fondo también.
      await more.tap();
      await page.waitForTimeout(400);
      await page.locator('.pick__scrim').tap({ position: { x: 10, y: 10 } });
      await page.waitForTimeout(400);
      assert.equal(await page.locator('.pick__scrim').count(), 0, 'and so does the backdrop');
      // Elegir conserva la semántica: commit y cierre.
      await more.tap();
      await page.waitForTimeout(400);
      const label = await page.locator('.pick__menu.is-dialog .pick__item b').first().innerText();
      await page.locator('.pick__menu.is-dialog .pick__item').first().tap();
      await page.waitForTimeout(900);
      assert.equal(await page.locator('.pick__menu.is-dialog').count(), 0, 'choosing closes it');
      assert.ok(label.length > 0, 'and the choice had a label to read');
    }
    await page.evaluate(() => document.querySelectorAll('.win [data-w-close]').forEach((b) => (b as HTMLElement).click()));
    await page.waitForTimeout(500);

    /* ── 6h. El chrome compartido: cerrar y minimizar caben ───────── */

    await openSome(page);
    const kinds = await page.locator('.win').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['kind']));
    assert.ok(kinds.length >= 3, `several window kinds share this chrome (${kinds.join(', ')})`);
    const measured = await chromeFits(page, '390x844');
    assert.ok(measured >= 6, `and every one of their controls is measured (${measured})`);
    await headerClear(page, '390x844');
    await shootHead(page, join(SHOTS, 'mobile-06h-chrome.png'));
    await shootEachWindow(page, join(SHOTS, 'mobile-06h-win-390'), '390x844 alone');
    // Y los controles siguen funcionando sobre CAPCOM, que es donde se veía.
    // A solas: en móvil las ventanas van a pantalla completa y la de encima
    // se come el toque de las de abajo, que es correcto y no lo que se mide.
    await closeAll(page);
    await page.evaluate(() => window.__orca!.openKind('ceo'));
    await page.waitForTimeout(1000);
    await headerClear(page, '390x844 · capcom alone');
    const before = await page.locator('.win').count();
    await page.locator('.win.is-ceo [data-w-min]').tap();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.win.is-ceo.is-min').count(), 1, 'CAPCOM folds from its own header');
    await page.locator('.tray .tile').first().tap();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.win.is-ceo:not(.is-min)').count(), 1, 'and comes back');
    await page.locator('.win.is-ceo [data-w-close]').tap();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.win').count(), before - 1, 'and closes');
    await closeAll(page);

    /* ── 6g. Un mensaje de una línea también es un mensaje ────────── */

    // Hablarle a una flota y contestar una escalación se escribían en un
    // `<input>`, donde Enter mandaba. Son mensajes, así que son cajas de varias
    // líneas con la misma regla que el resto.
    await page.evaluate(() => window.__orca!.openKind('fleet'));
    await page.waitForTimeout(900);
    const fleetSay = page.locator('.win.is-fleet [data-say]');
    if (await fleetSay.count()) {
      assert.equal(await fleetSay.evaluate((e) => e.tagName), 'TEXTAREA', 'the fleet box is a textarea now');
      await fleetSay.click();
      await page.keyboard.type('uno');
      await page.keyboard.press('Enter');
      await page.keyboard.type('dos');
      await page.waitForTimeout(200);
      assert.equal(await fleetSay.inputValue(), 'uno\ndos', 'Enter breaks the line and does not talk to the fleet');
      // SAY ALL conserva su `A`, que es un acorde de ventana como FRAME o STOP
      // y sólo dispara con el foco FUERA de la caja: lo que se retiró es el
      // atajo que competía con escribir, no la tecla de la ventana.
      assert.equal(await page.locator('.win.is-fleet [data-send]').getAttribute('data-key'), 'a',
        'SAY ALL keeps its window chord');
      await fleetSay.fill('');
    }
    await page.evaluate(() => document.querySelectorAll('.win [data-w-close]').forEach((b) => (b as HTMLElement).click()));
    await page.waitForTimeout(400);

    // La respuesta a una escalación, por la cola: misma regla.
    await page.evaluate(() => window.__orca!.openKind('queue'));
    await page.waitForTimeout(900);
    const rows = page.locator('.win.is-queue .qrow');
    for (let i = 0; i < Math.min(3, await rows.count()); i++) {
      await rows.nth(i).tap();
      await page.waitForTimeout(800);
      const ansBox = page.locator('.win.is-interrupt [data-ans]');
      if (await ansBox.count()) {
        assert.equal(await ansBox.evaluate((e) => e.tagName), 'TEXTAREA', 'the escalation answer is a textarea');
        await ansBox.click();
        await page.keyboard.type('a');
        await page.keyboard.press('Enter');
        await page.keyboard.type('b');
        await page.waitForTimeout(200);
        assert.equal(await ansBox.inputValue(), 'a\nb', 'Enter breaks the line and does not answer');
        assert.equal(await page.locator('.win.is-interrupt [data-send] kbd').count(), 0, 'and SEND advertises no key');
        await ansBox.fill('');
        await page.screenshot({ path: join(SHOTS, 'mobile-06g-answer.png') });
        break;
      }
      await page.evaluate(() => document.querySelectorAll('.win.is-interrupt [data-w-close]').forEach((b) => (b as HTMLElement).click()));
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => document.querySelectorAll('.win [data-w-close]').forEach((b) => (b as HTMLElement).click()));
    await page.waitForTimeout(400);

    /* ── 6i. El clic derecho con el dedo: mantener pulsado ────────── */

    await closeAll(page);
    await page.evaluate(() => { document.body.removeAttribute('data-sheet'); });
    await page.waitForTimeout(400);
    const tile = await settledTile(page);
    assert.ok(tile, 'there is a tile standing still to press');
    {
      // Un toque corto conserva lo que el toque hacía: abre el agente.
      let p = (await tileAt(page, tile.id)) ?? tile;
      await hold(page, p.x, p.y, 90);
      assert.equal(await page.locator('.ctx').count(), 0, 'a short tap opens no menu');
      assert.ok(await page.locator('.win.is-agent').count() >= 1, 'and still does what a tap did');
      await closeAll(page);

      // Medio segundo quieto: el menú, una vez, del sujeto correcto. El punto
      // se vuelve a leer aquí mismo: entre medir y pulsar, el campo se mueve.
      p = (await tileAt(page, tile.id)) ?? p;
      await hold(page, p.x, p.y, 620);
      assert.equal(await page.locator('.ctx').count(), 1, 'holding opens the menu, once');
      const menu = page.locator('.ctx');
      assert.equal(await menu.evaluate((e) => e.classList.contains('is-dialog')), true,
        'and it arrives dressed as the touch dialog');

      /*
       * IDENTIDAD, que es lo que de verdad hay que probar: no basta con que
       * salga un menú. Tiene que ser el DE ESE AGENTE, y se comprueba tres
       * veces: la cabecera lleva su callsign, las filas son las de un agente
       * —no las del campo— y abrir OPEN levanta la ventana de ese mismo
       * callsign. Un menú de campo pasaría las dos primeras a medias y la
       * tercera nunca.
       */
      const head = (await menu.locator('.ctx__head b').innerText()).trim();
      assert.match(head, /^[A-Z0-9]{1,4}$/, `the header carries a callsign, not a generic title (${head})`);
      const labels = await menu.locator('.ctx__item b').allInnerTexts();
      for (const want of ['OPEN', 'FLY TO', 'SPAWN CHILD', 'STOP']) {
        assert.ok(labels.includes(want), `an agent's own verbs are there (${want} · got ${labels.join(', ')})`);
      }
      assert.ok(!labels.includes('FRAME ALL'), 'and not the field\'s, which would mean it picked the canvas');
      const mbox = (await box(page, '.ctx'))!;
      assert.ok(mbox.x >= 0 && mbox.x + mbox.w <= PHONE.width && mbox.y >= 0 && mbox.y + mbox.h <= PHONE.height,
        'it fits the screen');
      const items = await page.locator('.ctx__item').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      for (const h of items) assert.ok(h >= 44, `every row is a finger target (${h}px)`);
      // El dedo ya se levantó: si hubiera un clic de cola, habría elegido una
      // fila y el menú estaría cerrado.
      assert.equal(await page.locator('.ctx').count(), 1, 'and the finger lifting chooses nothing');
      await page.screenshot({ path: join(SHOTS, 'mobile-06i-longpress-agent.png') });
      // La tercera comprobación de identidad: OPEN abre ESE agente.
      await page.locator('.ctx__item', { hasText: 'OPEN' }).first().tap();
      await page.waitForTimeout(900);
      assert.equal(await page.locator('.win.is-agent .win__cs').innerText(), head,
        'and OPEN opens the window of that very agent');
      await closeAll(page);
      assert.equal(await page.locator('.ctx').count(), 0, 'choosing closes the menu');

      // Moverse mientras se aguanta no es mantener pulsado: es arrastrar.
      p = (await tileAt(page, tile.id)) ?? p;
      await touch(page, [
        { at: 0, points: [{ x: p.x, y: p.y }] },
        { at: 200, points: [{ x: p.x + 60, y: p.y + 40 }] },
        { at: 700, points: [] },
      ]);
      await page.waitForTimeout(300);
      assert.equal(await page.locator('.ctx').count(), 0, 'a drag opens no menu');

      // Dos dedos es una pinza.
      p = (await tileAt(page, tile.id)) ?? p;
      await touch(page, [
        { at: 0, points: [{ x: p.x, y: p.y }] },
        { at: 80, type: 'touchStart', points: [{ x: p.x, y: p.y }, { x: p.x + 80, y: p.y }] },
        { at: 700, points: [] },
      ]);
      await page.waitForTimeout(300);
      const pinchHead = await page.locator('.ctx').count()
        ? (await page.locator('.ctx__head b').count() ? await page.locator('.ctx__head b').innerText() : '(sin cabecera)') : '';
      assert.equal(await page.locator('.ctx').count(), 0, `a pinch opens no menu (salió: ${pinchHead})`);

      // Y un toque cancelado por el sistema —una llamada, un gesto del borde—
      // tampoco: `pointercancel` deshace el gesto como lo deshace soltar.
      // El `touchCancel` cierra la secuencia por sí solo: mandar un `touchEnd`
      // detrás es un toque que nunca empezó, y el protocolo lo rechaza.
      p = (await tileAt(page, tile.id)) ?? p;
      await touch(page, [
        { at: 0, points: [{ x: p.x, y: p.y }] },
        { at: 200, type: 'touchCancel', points: [] },
      ]);
      await page.waitForTimeout(700);
      assert.equal(await page.locator('.ctx').count(), 0, 'a cancelled touch opens no menu');
      await closeAll(page);

      /*
       * El campo vacío tiene SU menú, y es otro. Buscar «vacío» por geometría
       * no vale —hay baldosas, bloques de squad, rótulos de región y todo se
       * mueve—, así que se prueban varios puntos y se acepta el primero que
       * dé el menú del campo. Que exista alguno es la afirmación.
       */
      const spots = [
        { x: 24, y: 180 }, { x: PHONE.width - 24, y: 180 },
        { x: 24, y: PHONE.height - 200 }, { x: PHONE.width - 24, y: PHONE.height - 200 },
        { x: PHONE.width / 2, y: 180 }, { x: 24, y: PHONE.height / 2 },
        { x: PHONE.width - 24, y: PHONE.height / 2 }, { x: PHONE.width / 2, y: PHONE.height - 200 },
      ];
      let onField = false;
      for (const p of spots) {
        await hold(page, Math.round(p.x), Math.round(p.y), 620);
        const title = await page.locator('.ctx__head b').count()
          ? (await page.locator('.ctx__head b').innerText()).trim() : '';
        if (title === 'FIELD') {
          const fieldLabels = await page.locator('.ctx__item b').allInnerTexts();
          assert.ok(fieldLabels.includes('FRAME ALL'), `the field's own verbs (${fieldLabels.join(', ')})`);
          assert.ok(!fieldLabels.includes('SPAWN CHILD'), 'and not an agent\'s');
          await page.screenshot({ path: join(SHOTS, 'mobile-06i-longpress-field.png') });
          onField = true;
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
        if (onField) break;
      }
      assert.ok(onField, 'empty canvas gives the field its own menu');
    }

    // Y donde se escribe, el gesto largo sigue siendo del sistema.
    await page.locator('.secbar__b--missions').tap();
    await page.waitForTimeout(400);
    await page.locator('.missions__row[data-mission="mission_mob_open"] [data-act="talk"]').tap();
    await page.waitForTimeout(1000);
    const boxAt = await page.locator('.win.is-mission [data-say]').evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    await hold(page, boxAt.x, boxAt.y, 650);
    assert.equal(await page.locator('.ctx').count(), 0, 'a long press in a text box is the system\'s, not ours');
    await closeAll(page);
    await page.evaluate(() => { document.body.removeAttribute('data-sheet'); });

    /* ── 7. Apaisado ──────────────────────────────────────────────── */

    await page.setViewportSize(LANDSCAPE);
    await page.waitForTimeout(600);
    assert.equal((await box(page, '.secbar'))?.vis, true, 'the doors survive the turn');
    // La hoja de MISIONES seguía abierta del paso anterior — que es el punto:
    // girar el teléfono no cierra nada. Se comprueba y se deja abierta.
    if (await page.evaluate(() => document.body.dataset['sheet'] ?? null) !== 'missions') {
      await page.locator('.secbar__b--missions').tap();
      await page.waitForTimeout(400);
    }
    assert.equal(await page.evaluate(() => document.body.dataset['sheet'] ?? null), 'missions',
      'what was open before the turn is still open after it');
    const land = (await box(page, '.missions'))!;
    assert.ok(land.vis && land.h > 120, `the sheet still has room to read in landscape (${land.h}px)`);
    assert.ok(land.y + land.h <= LANDSCAPE.height, 'and stays on screen');
    await page.screenshot({ path: join(SHOTS, 'mobile-08-landscape.png') });

    // 844x390: por ancho parecía un escritorio y el selector se quedaba en
    // desplegable, que es justo donde peor cae. Con el dedo y 390px de alto es
    // un diálogo igual que en vertical.
    await page.evaluate(() => window.__orca!.openKind('ceo'));
    await page.waitForTimeout(1000);
    const landMore = page.locator('.win.is-ceo .pick__btn').first();
    if (await landMore.count()) {
      await landMore.tap();
      await page.waitForTimeout(500);
      const dl = (await box(page, '.pick__menu.is-dialog'))!;
      assert.ok(dl?.vis, 'a phone on its side gets the dialog too');
      assert.ok(dl.y >= 0 && dl.y + dl.h <= LANDSCAPE.height, `and it fits the short viewport (${dl.h}px)`);
      const li = await page.locator('.pick__menu.is-dialog .pick__item').evaluateAll((els) =>
        els.map((e) => Math.round(e.getBoundingClientRect().height)));
      for (const h of li) assert.ok(h >= 44, `its options stay finger targets in landscape (${h}px)`);
      await page.screenshot({ path: join(SHOTS, 'mobile-08b-dialog-landscape.png') });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    /* ── 8d. El gesto largo, en apaisado ──────────────────────────── */

    await closeAll(page);
    await page.evaluate(() => { document.body.removeAttribute('data-sheet'); });
    await page.waitForTimeout(500);
    const lTile = await settledTile(page);
    assert.ok(lTile, 'there is a tile standing still in landscape too');
    {
      const lp = (await tileAt(page, lTile.id)) ?? lTile;
      await hold(page, lp.x, lp.y, 620);
      assert.equal(await page.locator('.ctx').count(), 1, 'landscape: holding opens the menu, once');
      const head = (await page.locator('.ctx__head b').innerText()).trim();
      assert.match(head, /^[A-Z0-9]{1,4}$/, `landscape: the header is that agent's callsign (${head})`);
      const labels = await page.locator('.ctx__item b').allInnerTexts();
      for (const want of ['OPEN', 'FLY TO', 'STOP']) {
        assert.ok(labels.includes(want), `landscape: an agent's verbs (${want} · got ${labels.join(', ')})`);
      }
      assert.ok(!labels.includes('FRAME ALL'), 'landscape: and not the field\'s');

      // La foto, con la cabecera a la vista: es la prueba de QUÉ menú es.
      await page.screenshot({ path: join(SHOTS, 'mobile-08d-longpress-landscape.png') });

      // Cabe, y lo que no cabe se desplaza dentro: 390px de alto es poco para
      // diez filas, y esconder filas no es una opción.
      const m = (await box(page, '.ctx'))!;
      assert.ok(m.y >= 0 && m.y + m.h <= LANDSCAPE.height, `landscape: it fits the short viewport (${m.h}px)`);
      const scrolls = await page.locator('.ctx').evaluate((e) => ({
        can: getComputedStyle(e).overflowY === 'auto' || getComputedStyle(e).overflowY === 'scroll',
        over: e.scrollHeight > e.clientHeight + 1,
      }));
      assert.ok(scrolls.can, 'landscape: the menu scrolls inside itself');
      if (scrolls.over) {
        const to = await page.locator('.ctx').evaluate((e) => { e.scrollTop = e.scrollHeight; return e.scrollTop; });
        assert.ok(to > 0, 'landscape: and the rows below the fold can be reached');
      }
      // El dedo ya se levantó y no ha elegido nada.
      assert.equal(await page.locator('.ctx').count(), 1, 'landscape: lifting the finger chooses nothing');

      // Y elegir funciona: FLY TO no abre ventanas, sólo mueve la cámara.
      await page.locator('.ctx').evaluate((e) => { e.scrollTop = 0; });
      const before = await page.evaluate(() => JSON.stringify(window.__orca!.view()));
      await page.locator('.ctx__item', { hasText: 'FLY TO' }).first().tap();
      await page.waitForTimeout(900);
      assert.equal(await page.locator('.ctx').count(), 0, 'landscape: choosing takes the row and closes');
      await page.waitForFunction((was) => JSON.stringify(window.__orca!.view()) !== was, before, { timeout: 8000 });
    }
    await closeAll(page);

    // 844x390 es donde los controles se salían de la cabecera: la regla de la
    // cabecera iba por ancho y la de los botones por puntero, y este tamaño
    // cumplía una sola. Se mide aquí a propósito.
    await openSome(page);
    await chromeFits(page, '844x390 landscape');
    await headerClear(page, '844x390 landscape');
    await shootHead(page, join(SHOTS, 'mobile-08c-chrome-landscape.png'));
    await shootEachWindow(page, join(SHOTS, 'mobile-08c-win-844'), '844x390 alone');
    await closeAll(page);

    /* ── 8. 360px, el más estrecho que se soporta ─────────────────── */

    await page.setViewportSize(NARROW);
    await page.waitForTimeout(600);
    const small = await page.locator('.secbar__b:visible, .secbar__x:visible').evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      return { right: Math.round(r.right), h: Math.round(r.height) };
    }));
    for (const s of small) {
      assert.ok(s.right <= NARROW.width, `nothing on the bar runs off a 360px screen (right ${s.right})`);
      assert.ok(s.h >= 40, `and it is still a finger target (${s.h}px)`);
    }
    if (await page.evaluate(() => document.body.dataset['sheet'] ?? null) !== 'missions') {
      await page.locator('.secbar__b--missions').tap();
      await page.waitForTimeout(400);
    }
    await openSome(page);
    await chromeFits(page, '360x640');
    await headerClear(page, '360x640');
    await closeAll(page);
    const narrowSheet = (await box(page, '.missions'))!;
    assert.ok(narrowSheet.vis && narrowSheet.x >= 0 && narrowSheet.x + narrowSheet.w <= NARROW.width, 'the sheet fits 360px');
    await page.screenshot({ path: join(SHOTS, 'mobile-09-narrow.png') });

    /* ── 9. El escritorio, igual que estaba ───────────────────────── */

    await page.setViewportSize(DESKTOP);
    await page.waitForTimeout(800);
    assert.equal((await box(page, '.secbar'))?.vis, false, 'no bar on a desktop');
    const deskM = (await box(page, '.missions'))!, deskI = (await box(page, '.improve'))!;
    assert.ok(deskM.vis && deskM.x < 200, 'the mission panel is back at the top left');
    assert.ok(deskI.vis && deskI.x + deskI.w > DESKTOP.width - 200, 'and AUTOMEJORA at the top right');
    assert.ok(!overlaps(deskM, deskI), 'the two float side by side, as they did');
    // Los controles del escritorio siguen siendo los de un ratón, y dentro.
    await openSome(page);
    const desk = await page.evaluate(() => {
      const out: { over: number; under: number; w: number; h: number }[] = [];
      for (const win of document.querySelectorAll<HTMLElement>('.win')) {
        const head = win.querySelector<HTMLElement>('.win__head');
        if (!head) continue;
        const h = head.getBoundingClientRect();
        for (const b of win.querySelectorAll<HTMLElement>('.win__btn')) {
          const r = b.getBoundingClientRect();
          out.push({ over: Math.round(h.top - r.top), under: Math.round(r.bottom - h.bottom), w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
      return out;
    });
    /*
     * Este contexto es táctil de principio a fin (`hasTouch`), así que a 1440
     * el puntero sigue siendo grueso y los controles siguen midiendo 44: es lo
     * correcto para una tableta o un portátil táctil, y es lo que significa
     * decidir por puntero y no por ancho. Lo que se comprueba aquí es que a
     * ese ancho **siguen dentro** de su cabecera. El caso de ratón fino —36×32
     * y hover— lo mide `hud-missions.shots.ts`, que corre sin táctil.
     */
    await headerClear(page, '1440 with a finger');
    for (const b of desk) {
      assert.ok(b.over <= 0 && b.under <= 0, `1440 with a finger: the control stays in the header (${b.over}, ${b.under})`);
      assert.ok(b.h >= 44, `and a coarse pointer keeps its target at any width (${b.w}x${b.h})`);
    }
    await closeAll(page);
    // Y el selector sigue siendo un desplegable anclado al botón, no un diálogo.
    await page.evaluate(() => window.__orca!.openKind('ceo'));
    await page.waitForTimeout(900);
    const deskMore = page.locator('.win.is-ceo .pick__btn').first();
    if (await deskMore.count()) {
      await deskMore.click();
      await page.waitForTimeout(400);
      assert.equal(await page.locator('.pick__menu.is-dialog').count(), 0, 'on a desktop the picker is still a dropdown');
      assert.equal(await page.locator('.pick__scrim').count(), 0, 'with no backdrop over the field');
      const menu = (await box(page, '.pick__menu'))!;
      const btnBox = (await deskMore.boundingBox())!;
      assert.ok(Math.abs(menu.x - Math.round(btnBox.x)) <= 2, 'and it still hangs off its own button');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: join(SHOTS, 'mobile-10-desktop.png') });

    assert.deepEqual(errors, []);
    console.log(`HUD mobile: doors, one sheet at a time, touch targets, mission window with its draft, landscape, 360px and the desktop regression passed.\n${join(SHOTS, 'mobile-02-missions.png')}`);
  } finally {
    await browser.close();
    if (!keep) shutdown();
  }
}

void ROOT;
await main();
