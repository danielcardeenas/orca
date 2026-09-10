/**
 * AUTOMEJORA, fotografiada contra la consola de verdad.
 *
 *   npx tsx test/hud-improve.shots.ts            reutiliza el hub y el vite que haya
 *   npx tsx test/hud-improve.shots.ts --headed   verlo pasar
 *
 * No se llama `*.visual.ts` a propósito: `visual.ts` corre su propia sesión
 * entera cuando el fichero de entrada acaba así, y montarla al lado sólo para
 * estas cinco fichas costaría el arranque completo. Mismo criterio que
 * `hud-missions.shots.ts`.
 *
 * Lo que se comprueba es exactamente lo que la sección promete y lo que un
 * `npm test` no puede ver:
 *
 *   - que se distinga a simple vista de la flota: color propio (`--auto`) y
 *     silueta propia, y que la barra del borde sea CONTINUA en una propuesta
 *     medida y DISCONTINUA en una hipótesis
 *   - que plegada quepa el resumen y abierta salgan evidencia, hipótesis,
 *     detalle, la pregunta al operador y la conversación
 *   - que el aviso cuente las novedades una vez y se apague al abrir la ficha
 *   - que la línea de estado diga por qué no toca revisar todavía
 *   - que no tape el reloj, ni el mástil, ni el panel de misiones, ni el radar
 *
 * El tablero se inyecta en el store de la consola por el gancho `__orca`, no
 * en el hub: una foto de cinco propuestas no puede dejar cinco propuestas en
 * el disco del operador.
 */

import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { ImproveState } from '../src/shared/improve.ts';
import { GPU_ARGS, ROOT, SHOTS, ensureServers, fontsReady, orcaToken, shutdown, trackSockets, uiPort } from './visual.ts';

const headed = process.argv.includes('--headed');
const keep = process.argv.includes('--keep');

async function main() {
  await ensureServers();
  const browser = await chromium.launch({ headless: !headed, args: GPU_ARGS });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.addInitScript('window.__name = (fn) => fn');
    // Los sockets de consola, apuntados: hace falta para cortar el enlace a
    // mano y ver qué hace la sección sin él.
    await trackSockets(page);
    /*
     * SHOW ALL antes del primer pintado. Los agentes de `test/fake-collector.ts`
     * no traen `origin`, así que la preferencia por defecto (`origin: 'orca'`)
     * los esconde a todos y el campo sale vacío. Aquí hace falta flota de
     * verdad: el revisor es un agente, y su fila enseña SU estado.
     */
    await page.addInitScript(`try { localStorage.setItem('orca.prefs.v1', JSON.stringify({ showAll: true })); } catch {}`);
    // Con `k`: el hub escucha en 0.0.0.0 y ahí exige token también a
    // localhost, y una consola sin él se queda en el handshake sin error.
    await page.goto(`http://127.0.0.1:${uiPort()}/?noboot=1&k=${encodeURIComponent(orcaToken())}`, { waitUntil: 'domcontentloaded' });
    /*
     * Se espera al ENLACE, no a la flota. La sección no dibuja un solo agente
     * —habla del instrumento, no de quién trabaja— así que atarla a que
     * aparezcan tiles la haría fallar por algo que no está mirando.
     */
    await page.waitForFunction(() => !!document.querySelector('.improve') && !!document.querySelector('.mast__link.is-up'), null, { timeout: 60_000 });
    await fontsReady(page);
    // El panel pide el tablero al hub al montarse; se inyecta después, para
    // que la respuesta vacía del hub no borre lo que se va a fotografiar.
    await page.waitForTimeout(1200);

    // Un agente de verdad de la flota hace de revisor: la fila tiene que
    // enseñar SU estado y su callsign, no un texto inventado.
    const crew = await page.evaluate(() => {
      const id = window.__orca!.agentIds()[0] ?? null;
      return {
        id,
        callsign: id ? (window.__orca!.callsignOf?.(id) ?? null) : null,
        machineId: id ? (window.__orca!.machineOf?.(id) ?? null) : null,
      };
    });
    await seed(page, crew);
    // Las fichas entran con el gesto de llegada; que termine antes del obturador.
    await page.waitForTimeout(900);

    /* ── Se distingue de la flota ─────────────────────────────────── */

    const look = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.improve')!;
      const cardOf = (id: string) => document.querySelector<HTMLElement>(`.imp[data-imp="${id}"]`)!;
      const bar = (c: HTMLElement) => getComputedStyle(c, '::before').backgroundImage;
      // El sigilo se pinta en lienzo: se comprueba que tiene píxeles, no que
      // existe el elemento. Un `<canvas>` vacío pasa cualquier prueba de DOM.
      const sig = el.querySelector<HTMLCanvasElement>('.improve__sigil')!;
      const px = sig.getContext('2d')!.getImageData(0, 0, sig.width, sig.height).data;
      let lit = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i]! > 0) lit++;
      return {
        sigilPixels: lit,
        accent: getComputedStyle(el.querySelector('.improve__t')!).color,
        lime: getComputedStyle(document.documentElement).getPropertyValue('--lime').trim(),
        auto: getComputedStyle(document.documentElement).getPropertyValue('--auto').trim(),
        observedBar: bar(cardOf('imp_shot_0')),
        hypothesisBar: bar(cardOf('imp_shot_1')),
        rowHeight: Math.round(cardOf('imp_shot_0').getBoundingClientRect().height),
        panelBg: getComputedStyle(el).backgroundColor,
        titleShare: Math.round(100
          * cardOf('imp_shot_0').querySelector('.imp__title')!.getBoundingClientRect().width
          / cardOf('imp_shot_0').getBoundingClientRect().width),
      };
    });
    assert.ok(look.sigilPixels > 40, `the section wears a sigil that actually paints (${look.sigilPixels}px)`);
    assert.equal(look.auto, '#b47cff', 'AUTOMEJORA has a colour of its own');
    assert.notEqual(look.auto, look.lime, 'and it is not the fleet\'s lime');
    assert.equal(look.accent, 'rgb(180, 124, 255)', 'the header wears it');
    assert.equal(look.observedBar, 'none', 'a measured proposal has a solid edge');
    assert.match(look.hypothesisBar, /repeating-linear-gradient/, 'a hypothesis has a dashed one');
    // La silueta ya no es un mordisco en la esquina: es una fila de una línea,
    // como una misión, y lo que la distingue son el color y esa barra. Lo que
    // sí tiene que seguir siendo cierto es que se lee en diagonal.
    assert.ok(look.rowHeight <= 30, `una propuesta cerrada es una sola línea (${look.rowHeight}px)`);
    // Fondo sólido: el campo pasaba por debajo y teñía el violeta con el
    // estado de un tile, que aquí significa otra cosa.
    assert.match(look.panelBg, /^rgb\(/, `el panel es opaco, no translúcido (${look.panelBg})`);
    // Y el titular se queda con el ancho: es lo único que se lee en diagonal.
    assert.ok(look.titleShare >= 33, `el título manda en la fila (${look.titleShare}% del ancho)`);

    /* ── Lo que dice plegada, y lo que cuenta ─────────────────────── */

    const rows = await page.locator('.imp').evaluateAll((els) => els.map((e) => ({
      id: (e as HTMLElement).dataset.imp ?? '',
      cls: e.className,
      title: e.querySelector('.imp__title')?.textContent ?? '',
      tags: e.querySelector('.imp__tags')?.textContent ?? '',
      meters: [...e.querySelectorAll('.imp__meter')].map((m) => m.textContent?.replace(/\s+/g, ' ').trim()),
      open: e.classList.contains('is-open'),
    })));
    const mine = rows.filter((r) => r.id.startsWith('imp_shot_'));
    const by = (id: string) => mine.find((r) => r.id === id)!;
    // Siete de ocho: la archivada se fue con su misión y no está ni plegada.
    assert.equal(mine.length, 6, 'every proposal on the board shows, and the archived one is not on it');
    assert.equal(mine.some((r) => r.id === 'imp_shot_7'), false, 'an archived proposal left with its mission');
    // Lo que espera decisión va delante de lo pospuesto, lo enviado y lo
    // terminado; lo descartado queda detrás del pliegue cuando ya no cabe.
    const closed = ['imp_shot_2', 'imp_shot_3', 'imp_shot_6'].map((id) => mine.findIndex((r) => r.id === id));
    const open = ['imp_shot_0', 'imp_shot_1', 'imp_shot_5'].map((id) => mine.findIndex((r) => r.id === id));
    assert.ok(Math.min(...closed) >= 0 && Math.max(...open) < Math.min(...closed), 'open proposals all come before the closed ones');
    assert.equal(mine.some((r) => r.id === 'imp_shot_4'), false, 'the dismissed one folded away, below the finished mission');
    assert.ok(by('imp_shot_5').cls.includes('is-new'), 'the unseen proposal is marked new');
    assert.ok(!by('imp_shot_0').cls.includes('is-new'), 'and one already read is not');
    // El área y cuándo se movió. De qué está hecha la idea lo dice la barra del
    // borde —continua o discontinua— y el detalle con todas las letras: en la
    // línea, «MEASURED» le robaba al título el sitio que necesita.
    assert.match(by('imp_shot_0').tags, /USABILITY · \d/);
    assert.doesNotMatch(by('imp_shot_0').tags, /MEASURED/, 'la palabra no le quita ancho al titular');
    assert.match(by('imp_shot_1').tags, /UI · \d/);
    assert.doesNotMatch(by('imp_shot_1').tags, /HYPOTHESIS/);
    assert.deepEqual(by('imp_shot_0').meters, ['IMP ▮▮▮', 'EFF ▮▯▯'], 'impact and effort read as meters');
    assert.deepEqual(by('imp_shot_6').meters, [], 'a proposal with no grounds shows no estimate at all');
    // Una misión terminada lo dice en la fila, y sigue llevando la marca de misión.
    assert.match(by('imp_shot_6').tags, /WORKFLOW · DONE · \d/, 'a finished mission says DONE on the row');
    assert.ok(by('imp_shot_6').cls.includes('is-completed') && by('imp_shot_6').cls.includes('is-mission'), 'and keeps the mission mark');
    assert.ok(by('imp_shot_3').cls.includes('is-mission') && !by('imp_shot_0').cls.includes('is-mission'), 'the mark is the link, not the status');
    assert.equal(await page.locator('.improve [data-n]').textContent(), '1 NEW', 'the unseen one is counted, once');
    // La línea de estado habla del reloj y de la ÚLTIMA CERRADA; la que está
    // en vuelo tiene su propia fila, y no se dice dos veces.
    const when = (await page.locator('.improve__when').textContent()) ?? '';
    assert.match(when, /A REVIEWER IS WORKING/, 'the clock says the slot is taken');
    assert.match(when, /LAST 1H · 4\+1/, 'and the last finished pass is summarised by its outcome');
    assert.doesNotMatch(when, /RUNNING/, 'without repeating the live one');

    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'hud-improve.png') });

    /* ── Abrir una ficha: motivación, hipótesis, detalle, pregunta ── */

    await page.locator('.imp[data-imp="imp_shot_1"] .imp__title').click();
    await page.waitForTimeout(400);
    const detail = await page.locator('.imp[data-imp="imp_shot_1"]').innerText();
    assert.match(detail, /HYPOTHESIS · NOT MEASURED/, 'a creative idea says what it is assuming');
    assert.match(detail, /ASKS YOU/, 'and the question it needs answered');
    assert.doesNotMatch(detail, /EVIDENCE · MEASURED/, 'a hypothesis invents no measurements');
    for (const label of ['IMPLEMENT', 'LATER · 3D', 'DISMISS', 'REPLY']) {
      assert.equal(await page.locator(`.imp[data-imp="imp_shot_1"] :text-is("${label}")`).count(), 1, `${label} is there`);
    }

    await page.locator('.imp[data-imp="imp_shot_0"] .imp__title').click();
    await page.waitForTimeout(400);
    const measured = await page.locator('.imp[data-imp="imp_shot_0"]').innerText();
    assert.match(measured, /EVIDENCE · MEASURED/);
    assert.match(measured, /avg wait 14m over 31 escalations/, 'the figures it rests on are quoted');

    const panelBox = (await page.locator('.improve').boundingBox())!;
    await page.screenshot({
      path: join(SHOTS, 'hud-improve-open.png'),
      clip: { x: Math.max(0, panelBox.x - 14), y: Math.max(0, panelBox.y - 74), width: panelBox.width + 28, height: Math.min(900 - panelBox.y + 74, panelBox.height + 88) },
    });

    /* ── Una propuesta ya enviada enseña su misión y no un SEND ───── */

    await page.locator('.imp[data-imp="imp_shot_3"] .imp__title').click();
    await page.waitForTimeout(300);
    const sent = page.locator('.imp[data-imp="imp_shot_3"]');
    assert.equal(await sent.locator(':text-is("OPEN MISSION")').count(), 1, 'it links the mission it became');
    assert.equal(await sent.locator(':text-is("IMPLEMENT")').count(), 0, 'and cannot be sent twice');
    assert.match(await sent.innerText(), /CONVERSATION[\s\S]*YOU[\s\S]*put the last report on the row/i);

    /* ── Una terminada sigue siendo misión, y lo dice en el hilo ────── */

    await page.locator('.imp[data-imp="imp_shot_6"] .imp__title').click();
    await page.waitForTimeout(300);
    const done = page.locator('.imp[data-imp="imp_shot_6"]');
    assert.equal(await done.locator(':text-is("OPEN MISSION")').count(), 1, 'a finished mission still links its mission');
    assert.equal(await done.locator(':text-is("IMPLEMENT")').count(), 0, 'and cannot be sent again');
    assert.equal(await done.locator(':text-is("REOPEN")').count(), 0, 'nor reopened from here');
    assert.match(await done.innerText(), /system[\s\S]*Mission completed/i, 'the closing is a line in its conversation');
    await page.locator('.imp[data-imp="imp_shot_6"] .imp__title').click();
    await page.waitForTimeout(300);
    // Detrás del pliegue está la descartada, y la archivada sigue sin estar.
    await page.locator('.improve__more').first().click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.imp[data-imp="imp_shot_4"]').count(), 1, 'unfolding brings the dismissed one back');
    assert.equal(await page.locator('.imp[data-imp="imp_shot_7"]').count(), 0, 'and never the archived one');
    await page.locator('.improve__more').first().click();
    await page.waitForTimeout(300);

    /* ── No tapa nada que reporte ─────────────────────────────────── */

    const geo = await page.evaluate(() => {
      const box = (s: string) => document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null;
      return { improve: box('.improve'), clock: box('.mast__clock'), mast: box('.mast'), missions: box('.missions'), map: box('.mmap') };
    }) as Record<string, DOMRect | null>;
    assert.ok(geo.improve && geo.mast, 'the panel and the mast are both up');
    assert.ok(geo.improve!.top >= geo.mast!.bottom, 'it starts below the mast');
    if (geo.clock) assert.ok(geo.improve!.top >= geo.clock!.bottom, 'the clock stays readable');
    if (geo.missions) {
      // Las dos comparten el carril de la izquierda, así que ya no se separan
      // por el eje X: se apilan. Lo que no puede pasar es que se pisen, y la
      // flota va arriba — se lee primero, y es lo que empuja al instrumento.
      assert.ok(geo.improve!.top >= geo.missions!.bottom,
        `AUTOMEJORA va debajo de MISIONES, sin pisarla (${geo.missions!.bottom} → ${geo.improve!.top})`);
      assert.ok(Math.abs(geo.improve!.left - geo.missions!.left) < 2,
        'y las dos arrancan en la misma columna');
      assert.ok(geo.improve!.left < 200, 'que es la de la izquierda');
    }
    // El radar es del campo y se queda con su rincón: el carril está al otro
    // lado, así que ni se rozan.
    if (geo.map) {
      assert.ok(geo.improve!.right <= geo.map!.left || geo.improve!.bottom <= geo.map!.top,
        'the radar keeps its corner');
    }
    assert.ok(geo.improve!.right <= 1440, 'the panel is on screen');

    /* ── El revisor en vuelo ──────────────────────────────────────── */

    const row = page.locator('.improve__agent');
    assert.equal(await row.isVisible(), true, 'a review in flight shows its agent');
    const agent = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.improve__agent')!;
      const go = el.querySelector<HTMLButtonElement>('.improve__agent-go')!;
      const dot = getComputedStyle(el, '::before').backgroundColor;
      return {
        go: go.textContent, disabled: go.disabled,
        meta: el.querySelector('.improve__agent-meta')?.textContent ?? '',
        stop: !!el.querySelector('.improve__agent-stop'),
        // El punto lleva el ESTADO real del agente, no el violeta de la sección.
        dot, frame: getComputedStyle(el).borderColor,
        metaColor: getComputedStyle(el.querySelector('.improve__agent-meta')!).color,
        auto: getComputedStyle(document.documentElement).getPropertyValue('--auto').trim(),
      };
    });
    assert.equal(agent.go, crew.callsign, 'the row names the reviewer by its callsign');
    assert.equal(agent.disabled, false, 'and it can be reached from here');
    assert.ok(agent.stop, 'the operator can stop it');
    assert.match(agent.meta, /7M IN/, 'how long it has been at it');
    assert.match(agent.meta, /[\d.]+[KM]?\/400K/, 'what it has spent, of what it may');
    assert.equal(agent.frame, 'rgb(110, 79, 160)', 'the frame is the section\'s violet: what it is');
    // Y el estado es del AGENTE, en los dos sitios que lo dicen. Si el violeta
    // se comiera el estado, un revisor bloqueado o muerto pasaría por sano.
    assert.equal(agent.dot, agent.metaColor, 'the dot and the reading agree on the state');
    assert.notEqual(agent.dot, 'rgb(180, 124, 255)', 'and neither of them is the section\'s violet');
    assert.notEqual(agent.dot, agent.frame, 'the state is not the frame');

    // Y una propuesta dice quién la escribió, con un camino hasta él.
    const credit = await page.locator('.imp[data-imp="imp_shot_1"] .imp__by').innerText();
    assert.match(credit, new RegExp(`PROPOSED BY\\s*${crew.callsign}`, 'i'), 'the card credits the reviewer');

    await page.screenshot({ path: join(SHOTS, 'hud-improve-reviewer.png'), clip: { x: 980, y: 0, width: 460, height: 330 } });

    /* ── El tile del revisor, en el campo ─────────────────────────── */

    const tile = await page.evaluate((id) => window.__orca!.screenOf(id), crew.id!);
    if (tile) {
      await page.screenshot({
        path: join(SHOTS, 'hud-improve-tile.png'),
        clip: {
          x: Math.max(0, tile.x - 40), y: Math.max(0, tile.y - 40),
          width: Math.min(1440 - Math.max(0, tile.x - 40), tile.w + 80),
          height: Math.min(900 - Math.max(0, tile.y - 40), tile.h + 80),
        },
      });
    }

    /* ── Sin enlace: lo último que se supo, y se dice ─────────────── */

    /*
     * Lo que dejó la sección clavada en «ASKING THE HUB…»: la petición del
     * tablero se perdía y nadie la repetía. Aquí se corta el socket, se
     * comprueba que el panel lo DICE en vez de fingir, y que al volver el
     * enlace vuelve a pedirlo solo.
     */
    await page.evaluate(() => { for (const ws of window.__sockets ?? []) ws.close(); });
    await page.waitForFunction(() => document.querySelector('.improve')?.classList.contains('is-offline') === true, null, { timeout: 15_000 });
    const offline = await page.evaluate(() => ({
      when: document.querySelector('.improve__when')?.textContent ?? '',
      run: document.querySelector<HTMLButtonElement>('[data-run]')?.disabled,
      rows: document.querySelectorAll('.imp').length,
    }));
    assert.match(offline.when, /NO LINK/, 'the panel says the link is gone');
    assert.equal(offline.run, true, 'and REVIEW NOW is not offered while it cannot reach the hub');
    assert.ok(offline.rows > 0, 'but the board that was already known stays on screen');
    await page.screenshot({ path: join(SHOTS, 'hud-improve-offline.png'), clip: { x: 980, y: 0, width: 460, height: 330 } });

    // Y vuelve sola: el cliente reconecta y la sección vuelve a pedir.
    await page.waitForFunction(() => document.querySelector('.improve')?.classList.contains('is-offline') === false, null, { timeout: 30_000 });
    assert.doesNotMatch((await page.locator('.improve__when').textContent()) ?? '', /NO LINK/, 'and it recovers without a reload');

    /* ── El pliegue se recuerda, y ⌥I la devuelve ─────────────────── */

    // El mismo gesto que el panel de misiones: el cuerpo se recoge y el
    // `display: none` llega al final, no al primer fotograma.
    const shut = await page.evaluate(async () => {
      const body = document.querySelector('.improve__body') as HTMLElement;
      const full = body.getBoundingClientRect().height;
      (document.querySelector('.improve__head') as HTMLElement).click();
      const seen: number[] = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 3000) {
        if (getComputedStyle(body).display === 'none') break;
        seen.push(body.getBoundingClientRect().height);
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { full, mid: seen.filter((h) => h > 1 && h < full - 1).length, gone: getComputedStyle(body).display };
    });
    assert.ok(shut.full > 100, `la sección se pliega desde abierta (${shut.full}px)`);
    assert.ok(shut.mid >= 3, `el cuerpo se recoge en vez de desaparecer de golpe (${shut.mid} alturas intermedias)`);
    assert.equal(shut.gone, 'none', 'y acaba plegado del todo');
    assert.equal(await page.locator('.improve__list').isVisible(), false);
    assert.match((await page.evaluate(() => localStorage.getItem('orca.prefs.v1'))) ?? '', /"improveFolded":true/);
    await page.screenshot({ path: join(SHOTS, 'hud-improve-folded.png'), clip: { x: 980, y: 0, width: 460, height: 200 } });

    // Y al devolverla, la caja crece al ritmo al que se llena y las piezas
    // entran en el compás — el mismo trato que el panel de misiones.
    const back = await page.evaluate(async () => {
      const body = document.querySelector('.improve__body') as HTMLElement;
      const parts = () => [...document.querySelectorAll<HTMLElement>('.imp')];
      window.__orca!.improveReveal();
      const heights = new Set<number>();
      let staggered = false;
      let seen: number[] = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 4000) {
        seen = parts().map((e) => Number(getComputedStyle(e).opacity));
        heights.add(Math.round(body.getBoundingClientRect().height));
        if (seen.some((o) => o > 0.9) && seen.some((o) => o < 0.1)) staggered = true;
        if (seen.length && seen.every((o) => o > 0.99)) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { staggered, heights: [...heights], lit: seen.filter((o) => o > 0.99).length, rows: seen.length };
    });
    assert.equal(await page.locator('.improve__list').isVisible(), true, '⌥I brings it back');
    assert.ok(back.heights.length >= 3,
      `la caja crece en vez de aparecer a su tamaño (${back.heights.length} alturas)`);
    assert.ok(back.rows > 1 && back.staggered, `y las filas entran en el compás (${back.rows} filas)`);
    assert.equal(back.lit, back.rows, 'y acaban todas a la vista');

    /* ── Los límites están a la vista y se pueden tocar ───────────── */

    await page.locator('.improve [data-setup]').click();
    await page.waitForTimeout(250);
    /*
     * Se vuelve a sembrar aquí: el panel repide el tablero al hub en cada
     * reconexión —que es lo correcto— y el hub de este arnés no tiene esta
     * elección, así que la sobrescribiría. Lo que se está fotografiando es el
     * panel, no el hub.
     */
    await seed(page, crew);
    // El catálogo lo sirve el collector falso; darle un momento a llegar.
    await page.waitForFunction(() => (document.querySelectorAll('.improve__pick .pick').length === 2), null, { timeout: 15_000 });
    await page.waitForTimeout(1200);
    // `innerText` mete un salto entre la etiqueta y su valor porque cada
    // ajuste es ahora una pieza propia; lo que se comprueba es el texto, no
    // dónde cae el salto.
    const setup = (await page.locator('.improve__setup').innerText()).replace(/\s+/g, ' ');
    assert.match(setup, /EVERY 6H/);
    assert.match(setup, /MAX PER DAY 4/);
    assert.match(setup, /MIN SIGNAL 40/);
    assert.match(setup, /REVIEWER BUDGET 400K/);

    /* ── Con qué nace el próximo revisor ──────────────────────────── */

    const choice = await page.evaluate(() => {
      const picks = [...document.querySelectorAll<HTMLElement>('.improve__pick')];
      const label = (el: HTMLElement) => el.querySelector('.pick button')?.textContent?.trim() ?? '';
      return {
        n: picks.length,
        runtime: picks[0] ? label(picks[0]) : '',
        model: picks[1] ? label(picks[1]) : '',
        note: document.querySelector('.improve__note')?.textContent ?? '',
        input: !!document.querySelector('.improve__num'),
      };
    });
    assert.equal(choice.n, 2, 'a runtime picker and a model picker');
    assert.match(choice.runtime, /CLAUDE/i, 'the chosen runtime is shown, not a blank box');
    assert.match(choice.model, /Opus/i, 'and so is the chosen model');
    assert.ok(choice.input, 'a budget can also be typed, not only stepped');
    // Lo que evita leer «400K» como una garantía.
    assert.match(choice.note, /NEXT REVIEWER · claude\/opus/i);
    assert.match(choice.note, /INPUT \+ OUTPUT \+ CACHE READ/i, 'what the budget counts is said');
    assert.match(choice.note, /BRAKE, NOT A HARD CEILING/i, 'and that it can overshoot');

    // Los modelos que ofrece son los de la máquina, con su runtime.
    await page.locator('.improve__pick .pick button').nth(1).click();
    await page.waitForTimeout(300);
    const models = await page.evaluate(() => [...document.querySelectorAll('.pick__menu [role="option"], .pick__menu button')].map((o) => o.textContent?.trim() ?? ''));
    assert.ok(models.some((m) => /INHERIT/i.test(m)), 'inheriting is an option with a name, not an empty box');
    assert.ok(models.some((m) => /Sonnet/i.test(m)), 'the machine\'s catalogue is what is offered');
    assert.ok(!models.some((m) => /GPT-5 Codex/i.test(m)), 'and only the models of the chosen runtime');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    // El panel entero: los cuatro límites, los dos selectores, la caja del
    // presupuesto y la línea que dice qué va a pasar de verdad.
    const setupBox = (await page.locator('.improve').boundingBox())!;
    await page.screenshot({
      path: join(SHOTS, 'hud-improve-setup.png'),
      clip: { x: Math.max(0, setupBox.x - 10), y: Math.max(0, setupBox.y - 10), width: setupBox.width + 20, height: Math.min(900 - setupBox.y + 10, setupBox.height + 20) },
    });

    /* ── En un teléfono ───────────────────────────────────────────── */

    /*
     * Contexto propio, con `hasTouch`. La adaptación móvil de Q8 y la mía
     * viven bajo `@media (pointer: coarse)`, y un viewport estrecho no cambia
     * el puntero: sin un contexto táctil de verdad, la foto diría que los
     * botones miden 21px cuando en un teléfono miden 40.
     */
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
      hasTouch: true, isMobile: true, reducedMotion: 'no-preference',
    });
    const small = await phone.newPage();
    const phoneErrors: string[] = [];
    small.on('pageerror', (e) => phoneErrors.push(e.message));
    small.on('console', (m) => { if (m.type() === 'error') phoneErrors.push(m.text()); });
    await small.addInitScript('window.__name = (fn) => fn');
    await small.addInitScript(`try { localStorage.setItem('orca.prefs.v1', JSON.stringify({ showAll: true })); } catch {}`);
    await small.goto(`http://127.0.0.1:${uiPort()}/?noboot=1&k=${encodeURIComponent(orcaToken())}`, { waitUntil: 'domcontentloaded' });
    await small.waitForFunction(() => !!document.querySelector('.secbar'), null, { timeout: 60_000 });
    await fontsReady(small);
    await small.waitForTimeout(800);
    await seed(small, crew);
    await small.waitForTimeout(500);

    /*
     * En un teléfono esta fila es el ÚNICO camino hasta el agente que está
     * revisando: no hay ⌥I, no hay ventana que abrir a mano y el campo a 390px
     * no se navega con el pulgar. Si no se puede tocar, el revisor deja de ser
     * visible en el móvil por mucho que exista.
     */
    assert.equal(await small.locator('.secbar__b--improve').count(), 1, 'the phone has a door to AUTOMEJORA');
    await small.locator('.secbar__b--improve').tap();
    await small.waitForTimeout(400);
    assert.equal(await small.evaluate(() => document.body.dataset.sheet), 'improve', 'the sheet opened');
    assert.equal(await small.locator('.improve__agent').isVisible(), true, 'the reviewer row is in the sheet');
    const touch = await small.evaluate(() => {
      const box = (s: string) => document.querySelector(s)?.getBoundingClientRect() ?? null;
      const go = box('.improve__agent-go'), stop = box('.improve__agent-stop'), sheet = box('.improve');
      return {
        go: go && { h: go.height, right: go.right }, stop: stop && { h: stop.height, right: stop.right },
        sheetRight: sheet?.right ?? 0,
        label: document.querySelector('.improve__agent-go')?.textContent ?? '',
      };
    });
    assert.equal(touch.label, crew.callsign, 'and it still names the reviewer');
    assert.ok((touch.go?.h ?? 0) >= 40, `the callsign is a touch target (${touch.go?.h}px)`);
    assert.ok((touch.stop?.h ?? 0) >= 40, `and so is STOP (${touch.stop?.h}px)`);
    assert.ok((touch.go?.right ?? 0) <= 390 && (touch.stop?.right ?? 0) <= 390, 'nothing runs off a 390px screen');
    await small.screenshot({ path: join(SHOTS, 'hud-improve-mobile.png') });

    // Y se llega al agente desde el teléfono.
    // La flota sintética se mueve mientras se mira: se trae la fila a la vista
    // antes de tocarla, en vez de confiar en que siga donde estaba.
    await small.locator('.improve__agent-go').scrollIntoViewIfNeeded();
    await small.locator('.improve__agent-go').tap();
    await small.waitForTimeout(800);
    assert.equal(await small.locator('.win.is-agent').count(), 1, 'the reviewer opens from the phone');
    await small.screenshot({ path: join(SHOTS, 'hud-improve-mobile-agent.png') });
    assert.deepEqual(phoneErrors, [], 'no page errors on the phone');
    await phone.close();

    assert.deepEqual(errors, []);
    console.log(`AUTOMEJORA: colour, silhouette, evidence vs hypothesis, actions, geometry, fold, reviewer row and phone passed.\n${join(SHOTS, 'hud-improve.png')}`);
  } finally {
    await browser.close();
    if (!keep) shutdown();
  }
}

void ROOT;
await main();

/**
 * El tablero de la foto, puesto en el store de la consola.
 *
 * Aparte porque se usa dos veces: una en el escritorio y otra en el contexto
 * táctil del teléfono, que es un navegador distinto y por tanto un store
 * distinto. Nada de esto llega al hub: una foto de seis propuestas no puede
 * dejar seis propuestas en el disco del operador.
 */
async function seed(page: Page, crew: { id: string | null; callsign: string | null; machineId: string | null }): Promise<void> {
  await page.evaluate(({ reviewerId, reviewerCallsign, machineId }) => {
      const now = Date.now();
      let n = 0;
      /*
       * Todo lo que se va a ABRIR nace ya visto. Abrir una ficha nueva la
       * marca leída contra el hub, y el hub de este arnés no tiene este
       * tablero: contestaría con el suyo, vacío, y se llevaría por delante lo
       * que se está fotografiando. La novedad se prueba con una ficha aparte
       * que sólo se mira.
       */
      const p = (over: Record<string, unknown>) => ({
        id: `imp_shot_${n++}`, key: `shot-${n}`, reviewId: 'rev_shot',
        at: now - 3_600_000, updatedAt: now - 3_600_000,
        area: 'usability', kind: 'observed', evidence: [], status: 'open',
        raised: 1, lastRaisedAt: now - 3_600_000, notes: [], seenAt: now - 3_000_000,
        // Toda propuesta sabe quién la escribió: es el enlace idea → trabajo.
        agentId: reviewerId, callsign: reviewerCallsign ?? 'R4',
        ...over,
      });
      const state = {
        config: { paused: false, everyMin: 360, perDay: 4, minSignal: 40 },
        usage: { since: now - 86_400_000, counts: { 'mcp:spawn_agent': 31, 'ui:ceo:say': 74 }, total: 105 },
        signal: { since: now - 3_600_000, counts: { 'ui:ceo:say': 12 }, total: 12 },
        pending: null,
        budgetTokens: 400_000,
        // Lo que el operador eligió en SETUP, persistido en el tablero.
        runtime: 'claude',
        model: 'opus',
        reviews: [
          // El revisor en vuelo: sin `endedAt`, que es lo que lo hace activo.
          {
            id: 'rev_live', at: now - 7 * 60_000, trigger: 'auto', status: 'running',
            reason: '6H SINCE THE LAST REVIEW · 128 NEW SIGNALS',
            agentId: reviewerId, callsign: reviewerCallsign, budgetTokens: 400_000,
            filed: 0, merged: 0,
          },
          {
            id: 'rev_shot', at: now - 3_600_000, endedAt: now - 3_500_000, trigger: 'auto', status: 'reported',
            reason: 'PREVIOUS PASS', reportedAt: now - 3_500_000, filed: 4, merged: 1,
            callsign: 'R4', costUSD: 0.31, tokens: 214_000,
          },
        ],
        proposals: {} as Record<string, unknown>,
      };
      for (const item of [
        p({
          title: 'The queue buries the oldest escalation',
          summary: 'Escalations are listed newest first, so the one that has waited longest is the one furthest from the eye. Sort by age and put the wait on the row.',
          evidence: ['avg wait 14m over 31 escalations in 24h', 'the oldest waited 47m while three newer ones were answered', 'queue opened 22 times, answered from it 9'],
          detail: 'The queue window sorts by arrival. Reversing it costs one comparator, and the row already has room for the wait next to the callsign. The alarm would then agree with the queue instead of pointing at different agents.',
          impact: 'high', effort: 'low', area: 'usability',
        }),
        p({
          title: 'A field that shows what an agent is about to do',
          summary: 'Tiles say what an agent is doing. They could say what it is about to do — the tool call it has queued — which is the difference between watching and supervising.',
          kind: 'hypothesis', area: 'ui',
          hypothesis: 'The operator interrupts late because intent only becomes visible after the tool ran. If the pending call showed on the tile, interruptions would land before the edit, not after.',
          detail: 'The transcript already carries the tool call before its result. The tile has a band free under the mission line at 190px and above.',
          question: 'Would you want that on every tile, or only on the ones you have selected?',
          impact: 'medium',
        }),
        p({
          title: 'CAPCOM rotates before it has to',
          summary: 'Three rotations in 24h, each one costing a cold start and a re-read of the brief.',
          evidence: ['3 rotations in 24h', 'context at rotation averaged 61% of the window'],
          impact: 'medium', effort: 'medium', area: 'performance',
          status: 'snoozed', snoozeUntil: now + 2 * 86_400_000, seenAt: now - 3_000_000,
        }),
        p({
          title: 'The mission panel should carry its results',
          summary: 'A finished mission is a row that says COMPLETED and nothing about what came out of it.',
          evidence: ['9 of 14 finished missions were reopened within an hour'],
          area: 'workflow', impact: 'high', effort: 'medium',
          status: 'sent', missionId: 'mission_shot_linked', seenAt: now - 3_000_000,
          notes: [
            { id: 'n1', role: 'human', text: 'Yes — put the last report on the row.', at: now - 2_900_000 },
            { id: 'n2', role: 'capcom', text: 'Filed. It will read the final report_mission.', at: now - 2_800_000 },
          ],
        }),
        p({
          title: 'Colour the field by cost',
          summary: 'Tint each tile by what it has spent so the expensive ones stand out.',
          kind: 'hypothesis', area: 'ui',
          hypothesis: 'Cost is the thing operators check last and regret first.',
          status: 'dismissed',
          notes: [{ id: 'n3', role: 'human', text: 'No. Colour means state here, and nothing else.', at: now - 2_700_000 }],
        }),
        // La novedad: sin `seenAt`, y no se abre en toda la sesión.
        p({
          title: 'Squad briefs repeat what the fleet already knows',
          summary: 'Every worker brief re-states the squad rules that the hub could hand it once.',
          evidence: ['briefs average 2.1k tokens, 0.9k of them identical across the squad'],
          area: 'cost', seenAt: undefined,
        }),
        // Una enviada cuya misión terminó: sigue siendo misión —barra, OPEN
        // MISSION— y lo dice con una palabra en la fila y una línea en el hilo.
        p({
          title: 'Reviewer briefs should name the counters they read',
          summary: 'The reviewer quotes figures without saying which counter they came from.',
          evidence: ['4 of 6 proposals cite a number with no counter name'],
          area: 'workflow',
          status: 'completed', missionId: 'mission_shot_done', seenAt: now - 3_000_000, updatedAt: now - 1_800_000,
          notes: [{ id: 'n4', role: 'system', text: 'Mission completed.', at: now - 1_800_000 }],
        }),
        // Una cuya misión se archivó: se fue con ella, y no está ni desplegando.
        p({
          title: 'Retire the legacy tasks.json reader',
          summary: 'Nobody has a tasks.json any more.',
          evidence: ['0 of 3 installs still carry tasks.json'],
          area: 'other',
          status: 'archived', missionId: 'mission_shot_gone', seenAt: now - 3_000_000, updatedAt: now - 1_700_000,
          notes: [{ id: 'n5', role: 'system', text: 'Mission archived: it leaves the board with it.', at: now - 1_700_000 }],
        }),
      ]) (state.proposals as Record<string, unknown>)[(item as { id: string }).id] = item;
      window.__orca!.improve(
        state as unknown as ImproveState,
        { due: false, reason: `A REVIEWER IS WORKING · ${reviewerCallsign ?? ''} · 7m IN` },
        {
          choice: { runtime: 'claude', model: 'opus', from: { runtime: 'operator', model: 'operator' } },
          // Una máquina de la flota sintética: es a quien el panel le pide el
          // catálogo, y el collector falso lo contesta.
          machineId,
        },
      );
    }, { reviewerId: crew.id, reviewerCallsign: crew.callsign, machineId: crew.machineId });
}

