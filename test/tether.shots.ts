/**
 * El tirante de un output hasta quien lo hizo, dibujado. Con el hub, en Chromium.
 *
 *   ORCA_VISUAL_ISOLATED=1 npx tsx test/tether.shots.ts
 *   npx tsx test/tether.shots.ts --headed   verlo pasar
 *
 * `npm test -- tether` prueba la geometría: que el hilo mida el aire de la
 * estantería, que el camino de una superficie sea ortogonal y no pise caja.
 * Lo que no puede ver es lo que el operador ve: que la línea ESTÁ, tenue, y
 * que se enciende al pasar el puntero por la ficha, por la baldosa o por la
 * superficie. Eso es lo que hay aquí — con la misma flota sintética y el
 * mismo hub aislado que `shelf.shots.ts`, y por las mismas razones.
 *
 * Los píxeles del hilo se comparan como firma: un parche entre la ficha y la
 * baldosa antes y después del hover. Un parche que no cambia es un hover que
 * no enciende nada, sea cual sea el color exacto que el compositor deje.
 */

import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { GPU_ARGS, SHOTS, ensureServers, injectSquad, newPage, open, shutdown, uiPort, waitForFleet } from './visual.ts';
import { sleep } from './harness.ts';

const headed = process.argv.includes('--headed');
const keep = process.argv.includes('--keep');
const VIEW = { w: 1440, h: 900 };

interface Chip { art: string | null; x: number; y: number; w: number; h: number }

/** Las fichas de un agente, con su caja en píxeles. */
async function chips(page: Page, agentId: string): Promise<Chip[]> {
  return page.evaluate((who) => [...document.querySelectorAll<HTMLElement>('.chip-art')]
    .filter((el) => !el.hidden && el.dataset.agent === who)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { art: el.dataset.art ?? null, x: r.x, y: r.y, w: r.width, h: r.height };
    }), agentId);
}

/** Las cinco fichas de un agente, cuando estén y cuando ya no se muevan (ver shelf.shots.ts). */
async function shelfOf(page: Page, agentId: string): Promise<Chip[]> {
  const esperar = (ms: number) => page.waitForFunction((id) => [...document.querySelectorAll<HTMLElement>('.chip-art')]
    .filter((el) => !el.hidden && el.dataset.agent === id).length === 5, agentId, { timeout: ms });
  /*
   * Y si no están, un vuelo antes de rendirse.
   *
   * Que no haya `.chip-art` no significa que el agente se haya ido: entre 44 y
   * 190 px de baldosa la franja es una TARJETA (`.chip-badge`), y por debajo
   * sólo la marca del shader, así que una cámara que quedó en otro peldaño
   * —tras un zoom cercano, tras un reencuadre— deja al mismo agente sin una
   * sola ficha que contar. Volar a él lo devuelve a su escala de lectura. Si
   * ni así aparecen, entonces sí se plegó en la bandeja de su padre o se
   * murió, y eso se dice con su nombre en vez de morir veinte líneas más
   * abajo con un «undefined no tiene x».
   */
  const cinco = async () => {
    try {
      await esperar(10_000);
    } catch {
      await page.evaluate((id) => (window as never as { __orca: { fly(i: string): void } }).__orca.fly(id), agentId);
      await sleep(1500);
      await esperar(10_000).catch(() => { throw new Error(`${agentId} se quedó sin estantería a mitad de la prueba`); });
    }
  };
  await cinco();
  let prev = '';
  for (let i = 0; i < 30; i++) {
    const now = await chips(page, agentId);
    /*
     * Sin fichas no hay nada que estabilizar: el agente perdió su baldosa
     * entre dos lecturas —se plegó en la bandeja de su padre, se murió, la
     * flota sintética está viva— y la firma vacía nunca va a igualar a la
     * anterior. Devolver la lista vacía era salir por la puerta de atrás:
     * el que llama hace `.find(...)!` y revienta veinte líneas más abajo con
     * un «undefined no tiene x» que no nombra a nadie. Se vuelve a esperar,
     * y si no vuelven se dice qué pasó.
     */
    if (!now.length) { await cinco(); continue; }
    const sig = now.map((c) => `${Math.round(c.x)},${Math.round(c.y)}`).join('|');
    if (sig === prev) return now;
    prev = sig;
    await sleep(250);
  }
  return chips(page, agentId);
}

/** Una caja en pantalla: la baldosa de un agente, una superficie, un rótulo. */
interface Box { x: number; y: number; w: number; h: number }

/**
 * La misma caja leída dos veces seguidas igual.
 *
 * El campo no está quieto cuando se le hace una foto: la cámara llega con
 * easing, la flota sintética relayoutea y un vecino que nace empuja la
 * baldosa medio segundo después de haberla medido. Es el mismo motivo por el
 * que `shelfOf` estabiliza la franja antes de devolverla, aplicado a una
 * caja sola.
 */
async function still(read: () => Promise<Box | null>, tries = 20): Promise<Box | null> {
  let prev = '';
  let now = await read();
  for (let i = 0; i < tries; i++) {
    const sig = now ? `${Math.round(now.x)},${Math.round(now.y)},${Math.round(now.w)},${Math.round(now.h)}` : '';
    if (sig && sig === prev) return now;
    prev = sig;
    await sleep(200);
    now = await read();
  }
  return now;
}

/**
 * ¿Se enciende el puerto de `anchor` al poner el puntero sobre `target`?
 *
 * Afirmarlo a la primera culpaba al tirante de lo que hacía la flota. El
 * parche se calcula sobre coordenadas leídas antes, y si la baldosa se
 * desplaza entre la foto fría y la caliente las dos son del suelo: salen
 * iguales aunque el puerto se encendiera entero, y la prueba dice que el
 * hover no hace nada cuando lo que pasó es que miró a otro sitio. De los
 * cinco fallos de este shot en un mismo día, tres eran esto.
 *
 * Así que se espera a que todo esté quieto, se comprueba que lo siguió
 * estando entre las dos fotos, y sólo se da por muerto el tirante cuando
 * cuatro intentos con el campo parado dan la misma foto.
 */
async function lightsUp(
  page: Page,
  anchor: () => Promise<Box | null>,
  port: (b: Box) => Box,
  target: () => Promise<Box | null>,
  traer?: () => Promise<void>,
): Promise<string> {
  let why = 'no se llegó a medir';
  for (let intento = 0; intento < 4; intento++) {
    await page.mouse.move(VIEW.w - 20, VIEW.h - 20);
    await sleep(250);
    const a = await still(anchor);
    const t = await still(target);
    if (!a || !t) { why = 'la baldosa o la superficie se fueron de la pantalla'; continue; }
    const p = port(a);
    // Un parche entero fuera del lienzo no es una foto: `patch` recorta, y de
    // un recorte vacío Playwright no saca imagen ninguna. La baldosa se fue de
    // cuadro entre medias; se vuelve a mirar.
    if (p.x + p.w <= 0 || p.y + p.h <= 0 || p.x >= VIEW.w || p.y >= VIEW.h) {
      why = 'el puerto quedó fuera del lienzo';
      // Traerlo de vuelta a cuadro, si quien llama sabe cómo: un encuadre que
      // se fue no dice nada del tirante.
      if (traer) { await traer(); await sleep(1500); }
      continue;
    }
    const rest = await patch(page, p.x, p.y, p.w, p.h);
    await page.mouse.move(t.x + t.w / 2, t.y + t.h / 2);
    await sleep(450);
    const a2 = await anchor();
    if (!a2 || Math.abs(a2.x - a.x) > 1 || Math.abs(a2.y - a.y) > 1) { why = 'se movió entre foto y foto'; continue; }
    if (await patch(page, p.x, p.y, p.w, p.h) !== rest) return '';
    why = `cuatro veces con el campo quieto y el parche no cambió · puerto ${Math.round(p.x)},${Math.round(p.y)} · puntero ${Math.round(t.x + t.w / 2)},${Math.round(t.y + t.h / 2)}`;
    // Con el puntero todavía encima: la foto de lo que se estaba mirando es la
    // única forma de saber si el tirante no se encendió o si el parche miraba
    // a otro sitio, y sin ella hay que volver a provocar el fallo para verlo.
    await page.screenshot({ path: join(SHOTS, 'tether-XX-nolight.png') });
  }
  return why;
}

/** Los píxeles de un parche, como firma comparable. */
async function patch(page: Page, x: number, y: number, w: number, h: number): Promise<string> {
  // Recortado al viewport: un parche que asoma por el borde es un error de Playwright, no una foto.
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(VIEW.w, Math.round(x + w)), y1 = Math.min(VIEW.h, Math.round(y + h));
  const buf = await page.screenshot({ clip: { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) } });
  return buf.toString('base64');
}

async function declare(page: Page, agentId: string): Promise<void> {
  await page.evaluate((who) => {
    const api = (window as never as { __orca: { artifact(a: unknown): void } }).__orca;
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      api.artifact({
        id: `art_tether_${who}_${i}`, agentId: who, projectId: 'p', machineId: 'm',
        kind: i === 5 ? 'file' : 'image', path: i === 5 ? '/p/out/build.zip' : `/p/out/frame-${i}.png`,
        title: i === 5 ? 'el paquete' : `fotograma ${i}`, url: null,
        bytes: i === 5 ? 4_404_019 : 2048, width: 640, height: 400,
        at: now + i, open: false, placement: null, source: 'declared',
      });
    }
  }, agentId);
}

async function main() {
  await ensureServers({ fleet: true, fixtures: true });
  const browser = await chromium.launch({ headless: !headed, args: GPU_ARGS });
  let squad: { close(): void } | null = null;
  try {
    const page = await newPage(browser, VIEW.w, VIEW.h);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript('window.__name = (fn) => fn');
    await open(page, `http://127.0.0.1:${uiPort()}/?noboot=1`);
    await page.waitForFunction(() => !!document.querySelector('.mast__link.is-up'), null, { timeout: 60_000 });
    await waitForFleet(page, 1);
    await page.evaluate(() => { document.querySelectorAll<HTMLElement>('.win [data-w-close]').forEach((b) => b.click()); });
    await sleep(800);

    /* ── Un agente con baldosa propia, como en shelf.shots.ts ───────── */
    const candidatos = await page.evaluate(() => {
      const api = (window as never as {
        __orca: { agentIds(): string[]; spotOf(id: string): { scale: number; trayOf: string | null } | undefined };
      }).__orca;
      return api.agentIds().filter((id) => { const s = api.spotOf(id); return !!s && s.trayOf === null && s.scale >= 1; });
    });
    assert.ok(candidatos.length, 'la flota sintética dio algún agente con baldosa propia');
    let who = '';
    for (const cand of candidatos.slice(0, 4)) {
      await declare(page, cand);
      await page.evaluate((id) => (window as never as { __orca: { fly(i: string): void } }).__orca.fly(id), cand);
      try {
        await page.waitForFunction((id) => [...document.querySelectorAll<HTMLElement>('.chip-art')]
          .filter((el) => !el.hidden && el.dataset.agent === id).length === 5, cand, { timeout: 10_000 });
        who = cand;
        break;
      } catch { /* se plegó, se fue de cuadro o se murió: el siguiente */ }
    }
    assert.ok(who, 'ninguno de los candidatos mantuvo su baldosa el tiempo de colgarle nada');

    /* ── Una superficie colocada, con su pie y su tirante ───────────── */
    await page.evaluate((id) => (window as never as { __orca: { place(i: string): void } }).__orca.place(id), `art_tether_${who}_0`);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.srf')]
      .some((el) => el.style.display !== 'none' && (el.textContent ?? '').includes('fotograma 0')), null, { timeout: 15_000 })
      .catch(() => { throw new Error('PLACE no puso la superficie en el campo'); });
    // El pie dice quién: el indicativo del agente, al lado del título.
    const callsign = await page.evaluate((id) => (window as never as { __orca: { callsignOf(i: string): string | null } }).__orca.callsignOf(id), who);
    assert.ok(callsign, 'el agente tiene indicativo');
    const who2 = await page.evaluate(() => document.querySelector('.srf__who')?.textContent ?? '');
    assert.ok(who2.includes(callsign), `el pie de la superficie dice de quién es: "${who2}" no lleva ${callsign}`);

    /* ── El asa: tirar del rincón la ensancha, y el ancho se queda ──── */

    /*
     * La superficie recién colocada lleva su asa en el rincón inferior
     * derecho (`.srf-grip`). Se tira de ella 120 px a la derecha y la caja de
     * la superficie tiene que ser más ancha; y el ancho tiene que sobrevivir
     * a un feed, porque viaja con la colocación (`placement.w`).
     */
    const srfBox = () => page.evaluate(() => {
      const el = [...document.querySelectorAll<HTMLElement>('.srf')].find((x) => (x.textContent ?? '').includes('fotograma 0'));
      if (!el || el.style.display === 'none') return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const antes = await srfBox();
    assert.ok(antes, 'la superficie colocada está en pantalla');
    const grip = await page.evaluate(() => {
      const g = [...document.querySelectorAll<HTMLElement>('.srf-grip')].find((x) => !x.hidden);
      if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    assert.ok(grip, 'la superficie lleva su asa de redimensionar');
    await page.mouse.move(grip.x, grip.y);
    /*
     * Que el puntero esté de verdad sobre el asa antes de apretar. El rojo
     * «tirar del asa ensancha la superficie: 541 → 541 px» salió tres veces
     * en doce corridas de hoy y no dice nada: un asa que no responde y un
     * asa que no recibió el `pointerdown` —porque otra superficie, una
     * ficha o el HUD están encima— acaban en el mismo número. Se pregunta al
     * DOM, que es quien reparte el puntero, y si no es el asa se dice qué es.
     */
    const bajoElAsa = await page.evaluate(({ x, y }) => {
      const e = document.elementFromPoint(x, y) as HTMLElement | null;
      return e ? (e.closest('.srf-grip') ? 'asa' : `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`) : 'nada';
    }, grip);
    assert.equal(bajoElAsa, 'asa', `el puntero cae sobre el asa y no sobre ${bajoElAsa}`);
    await page.mouse.down();
    await page.mouse.move(grip.x + 60, grip.y + 30, { steps: 6 });
    await page.mouse.move(grip.x + 120, grip.y + 60, { steps: 6 });
    await page.mouse.up();
    await sleep(500);
    const despues = await srfBox();
    assert.ok(despues && despues.w > antes.w + 40, `tirar del asa ensancha la superficie: ${antes.w.toFixed(0)} → ${despues?.w.toFixed(0)} px`);
    await page.evaluate(() => (window as never as { __orca: { frame(): void } }).__orca);
    await page.screenshot({ path: join(SHOTS, 'tether-08-resize.png') });

    /* ── Arrastrar una ficha al campo la coloca donde se suelta ─────── */

    /*
     * Una ficha es origen de arrastre HTML5 con la carga de la galería. Se
     * arrastra la segunda ficha del agente a un punto de suelo abierto y tiene
     * que aparecer una segunda superficie con su título.
     */
    const chipSelDrag = `.chip-art[data-agent="${who}"][data-art]`;
    const chipTitles = await page.evaluate((sel) => [...document.querySelectorAll<HTMLElement>(sel)].map((el) => el.title.split(' · ')[0] ?? ''), chipSelDrag);
    const dragged = chipTitles[1] ?? '';
    const antesN = await page.evaluate(() => document.querySelectorAll('.srf').length);
    await page.locator(chipSelDrag).nth(1).dragTo(page.locator('[data-field]'), { targetPosition: { x: 200, y: VIEW.h - 120 } });
    await sleep(800);
    const arrastrada = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.srf')].filter((x) => x.style.display !== 'none').length);
    assert.ok(arrastrada > antesN, `arrastrar una ficha coloca su superficie: había ${antesN} y hay ${arrastrada} ("${dragged}")`);
    await page.screenshot({ path: join(SHOTS, 'tether-09-drag.png') });

    await page.mouse.move(VIEW.w - 20, VIEW.h - 20);
    const shown = await shelfOf(page, who);
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'tether-01-rest.png') });

    /* ── Hover en una ficha: su hilo se enciende, y el pie dice qué es ── */
    /*
     * Por selector y no por coordenadas leídas antes: la flota sintética está
     * viva y una baldosa que gana un vecino desplaza su franja entre que se
     * mide y se mueve el puntero, y entonces el puntero cae en el lienzo. El
     * parche del hilo sí necesita coordenadas, así que se lee antes y después
     * y se repite si la ficha se movió entre medias.
     */
    const chipSel = `.chip-art[data-agent="${who}"][data-art]`;
    let cap = '';
    let stemChanged = false;
    for (let intento = 0; intento < 4 && !stemChanged; intento++) {
      await page.mouse.move(VIEW.w - 20, VIEW.h - 20);
      await sleep(200);
      const c = (await shelfOf(page, who)).find((x) => x.art)!;
      // El hilo va del techo de la ficha al borde bajo de la baldosa: un parche
      // ahí, estrecho, es la firma del hilo y de nada más.
      const stem = { x: c.x + c.w / 2 - 3, y: c.y - 14, w: 6, h: 13 };
      const rest = await patch(page, stem.x, stem.y, stem.w, stem.h);
      await page.hover(chipSel);
      await page.waitForFunction(() => { const el = document.querySelector<HTMLElement>('.chip-cap'); return !!el && !el.hidden; }, null, { timeout: 5_000 })
        .catch(() => { throw new Error('el hover sobre una ficha no sacó su pie'); });
      cap = await page.evaluate(() => document.querySelector('.chip-cap')?.textContent ?? '');
      await sleep(300);
      const again = (await chips(page, who)).find((x) => x.art)!;
      if (Math.abs(again.x - c.x) > 1 || Math.abs(again.y - c.y) > 1) continue; // se movió: otra vez
      const hot = await patch(page, stem.x, stem.y, stem.w, stem.h);
      stemChanged = hot !== rest;
    }
    // Qué (un título: el mock también declara cosas suyas, y la ficha más
    // nueva puede ser una de ellas) y de cuándo.
    assert.ok(/^.+ · \d+[SMHD]$/.test(cap), `el pie dice qué es y de cuándo, no "${cap}"`);
    assert.ok(stemChanged, 'el hilo de la ficha cambia con el puntero encima');
    await page.screenshot({ path: join(SHOTS, 'tether-02-hover-chip.png') });

    /* ── Hover en la baldosa: la franja entera se enciende (sentido inverso) ── */
    const tile = await page.evaluate((id) => (window as never as {
      __orca: { screenOf(i: string): { x: number; y: number; w: number; h: number } | null };
    }).__orca.screenOf(id), who);
    assert.ok(tile, 'la baldosa está en pantalla');
    await page.mouse.move(tile.x + tile.w * 0.5, tile.y + tile.h * 0.3);
    await page.waitForFunction((id) => {
      const mine = [...document.querySelectorAll<HTMLElement>('.chip-art')].filter((el) => !el.hidden && el.dataset.agent === id);
      return mine.length === 5 && mine.every((el) => el.classList.contains('is-hot'));
    }, who, { timeout: 5_000 }).catch(() => { throw new Error('el hover sobre la baldosa no encendió su franja'); });
    await sleep(300);
    await page.screenshot({ path: join(SHOTS, 'tether-03-hover-tile.png') });
    await page.mouse.move(VIEW.w - 20, VIEW.h - 20);
    await page.waitForFunction((id) => [...document.querySelectorAll<HTMLElement>('.chip-art')]
      .filter((el) => !el.hidden && el.dataset.agent === id).every((el) => !el.classList.contains('is-hot')), who, { timeout: 5_000 });

    /* ── Hover en la superficie: su tirante se enciende ─────────────── */
    const srfOf = (texto: string) => page.evaluate((txt) => {
      const el = [...document.querySelectorAll<HTMLElement>('.srf')].find((x) => (x.textContent ?? '').includes(txt));
      if (!el || el.style.display === 'none') return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, texto);
    const tileOf = (id: string) => page.evaluate((quien) => (window as never as {
      __orca: { screenOf(i: string): { x: number; y: number; w: number; h: number } | null };
    }).__orca.screenOf(quien), id);
    const srf = await still(() => srfOf('fotograma 0'));
    assert.ok(srf, 'la superficie colocada sigue en pantalla');
    const tile2 = await still(() => tileOf(who));
    assert.ok(tile2, 'la baldosa sigue en pantalla');
    /*
     * El puerto de origen: en el borde de la baldosa que mira a la superficie,
     * a −0.12 del centro (`SIDE_DROP`). Apagado y pequeño en reposo, lima y
     * entero caliente — un parche ahí cambia con el hover aunque el resto del
     * tirante pase por debajo de un vecino.
     *
     * De qué lado se lee una vez, con la baldosa quieta: un relayout la
     * desplaza unos píxeles, no la cambia de lado de la superficie.
     */
    const derecha = srf.x > tile2.x;
    const puerto = (t: Box): Box => ({ x: (derecha ? t.x + t.w : t.x) - 8, y: t.y + t.h * (0.5 + 0.12) - 8, w: 16, h: 16 });
    const volarA = async () => { await page.evaluate((id) => (window as never as { __orca: { fly(i: string): void } }).__orca.fly(id), who); };
    const mudo = await lightsUp(page, () => tileOf(who), puerto, () => srfOf('fotograma 0'), volarA);
    assert.equal(mudo, '', `el puerto de origen cambia con el puntero sobre la superficie (${mudo})`);
    await page.mouse.move(srf.x + srf.w / 2, srf.y + srf.h / 2);
    await sleep(300);
    await page.screenshot({ path: join(SHOTS, 'tether-04-hover-surface.png') });
    await page.mouse.move(VIEW.w - 20, VIEW.h - 20);

    /* ── Origen en la escuadra: el autor ya no tiene baldosa, el bloque sigue ── */

    /*
     * La escuadra del arnés (`injectSquad`, seis bajo `ledger-close`). Un
     * miembro declara y coloca una superficie mientras tiene baldosa; luego
     * se le descarta del campo —`store.dismiss`, lo que hace DISMISS en la
     * ventana de flota— y el almacén lo sigue recordando con su escuadra.
     * El tirante tiene que ir entonces al puerto del bloque, no a la nada.
     */
    /*
     * Las superficies de `who` se retiran antes: ya están medidas y aquí
     * estorban. Una superficie colocada es DOM sobre el lienzo, y `fotograma
     * 0` —ensanchada 120 px en el paso del asa— quedaba encima de la esquina
     * del bloque `ledger-close` cuando la flota ponía a `who` pegado al
     * recinto del arnés. El parche del puerto fotografiaba entonces una
     * superficie, no el puerto, y la prueba decía que el tirante no se
     * enciende cuando lo que pasaba es que no se veía: «cuatro veces con el
     * campo quieto y el parche no cambió · puerto 626,353». Es el mismo
     * estorbo que `file-viewer` se hacía a sí mismo con su ventana del paso 1.
     */
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>('.srf')) {
        if ((el.textContent ?? '').includes('fotograma')) el.querySelector<HTMLElement>('[data-close]')?.click();
      }
    });
    await sleep(400);
    squad = await injectSquad();
    assert.ok(squad, 'el hub aceptó la escuadra del arnés');
    const member = 'sess_vsquad_z2';
    await page.waitForFunction(() => !!document.querySelector('.squad[data-squad="ledger-close"]'), null, { timeout: 30_000 })
      .catch(() => { throw new Error('la escuadra nunca apareció en el campo'); });
    await page.evaluate((id) => (window as never as { __orca: { fly(i: string): void } }).__orca.fly(id), member);
    await sleep(1200);
    await page.evaluate((who3) => {
      const api = (window as never as { __orca: { artifact(a: unknown): void; place(id: string): void } }).__orca;
      api.artifact({
        id: `art_tether_${who3}_sq`, agentId: who3, projectId: 'p_vsquad', machineId: 'orca-visual-squad',
        kind: 'file', path: '/srv/ledger/out/march-close.zip', title: 'el cierre de marzo', url: null,
        bytes: 1_204_019, width: null, height: null, at: Date.now(), open: false, placement: null, source: 'declared',
      });
      api.place(`art_tether_${who3}_sq`);
    }, member);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.srf')]
      .some((el) => el.style.display !== 'none' && (el.textContent ?? '').includes('el cierre de marzo')), null, { timeout: 15_000 })
      .catch(() => { throw new Error('PLACE no puso la superficie del miembro de la escuadra'); });
    await page.evaluate((id) => (window as never as { __orca: { dismiss(ids: string[]): void } }).__orca.dismiss([id]), member);
    await page.waitForFunction((id) => !(window as never as { __orca: { spotOf(i: string): unknown } }).__orca.spotOf(id), member, { timeout: 10_000 })
      .catch(() => { throw new Error('el miembro descartado sigue teniendo baldosa'); });
    // El almacén lo recuerda, con indicativo: el pie de la superficie lo sigue diciendo.
    const known = await page.evaluate((id) => (window as never as { __orca: { callsignOf(i: string): string | null } }).__orca.callsignOf(id), member);
    assert.equal(known, 'Z2', 'el almacén recuerda al miembro descartado');
    // Con el bloque entero en cuadro: el puerto está en su esquina superior
    // izquierda, y un vuelo al miembro de la derecha lo dejaba fuera de pantalla.
    await page.evaluate((id) => (window as never as { __orca: { fly(i: string): void } }).__orca.fly(id), 'sess_vsquad_z1');
    await sleep(1500);
    /*
     * El vuelo aterriza en el peldaño 5 y deja la superficie fuera de cuadro,
     * así que se abre el zoom hasta que el rótulo del bloque y la superficie
     * estén los dos dentro del viewport. Si no lo están, el hover de abajo no
     * prueba nada.
     */
    const rect = (sel: string, text?: string) => page.evaluate(({ s, t }) => {
      const el = [...document.querySelectorAll<HTMLElement>(s)].find((x) => !t || (x.textContent ?? '').includes(t));
      if (!el || el.style.display === 'none') return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, { s: sel, t: text });
    const dentro = (r: { x: number; y: number; w: number; h: number } | null) =>
      !!r && r.x >= 48 && r.y >= 0 && r.x + r.w <= VIEW.w && r.y + r.h <= VIEW.h;
    let rot: Awaited<ReturnType<typeof rect>> = null;
    let srf2: Awaited<ReturnType<typeof rect>> = null;
    await page.mouse.move(VIEW.w / 2, VIEW.h / 2);
    for (let i = 0; i < 10; i++) {
      rot = await rect('.squad[data-squad="ledger-close"]');
      srf2 = await rect('.srf', 'el cierre de marzo');
      if (dentro(rot) && dentro(srf2)) break;
      await page.keyboard.down('Control'); await page.mouse.wheel(0, 160); await page.keyboard.up('Control');
      await sleep(400);
    }
    assert.ok(dentro(rot), 'el rótulo de la escuadra está en pantalla');
    assert.ok(dentro(srf2), 'la superficie del miembro está en pantalla');
    await page.mouse.move(VIEW.w - 20, VIEW.h - 20);
    await sleep(400);
    await page.screenshot({ path: join(SHOTS, 'tether-05-squad-rest.png') });

    /*
     * El puerto de la escuadra está en su borde superior, 0.15 a la derecha de
     * la esquina izquierda; el rótulo empieza a 0.30 e interrumpe la línea. Un
     * parche justo a la izquierda del rótulo, centrado en su altura, es el
     * puerto — apagado en reposo, lima con el puntero sobre la superficie.
     */
    // Y que el parche esté a la vista: el puerto es WebGL y cualquier DOM
    // encima —una superficie, una ventana, el HUD— lo tapa sin que el tirante
    // tenga nada que ver. Si lo tapa algo, que el rojo lo nombre.
    const sobreElPuerto = await page.evaluate(({ x, y }) => {
      const e = document.elementFromPoint(x, y) as HTMLElement | null;
      return !e || e.closest('[data-field]') === e || e.tagName === 'CANVAS' ? '' : `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`;
    }, { x: rot!.x - 20, y: rot!.y + rot!.h / 2 });
    assert.equal(sobreElPuerto, '', `el parche del puerto de la escuadra está a la vista y no bajo ${sobreElPuerto}`);
    const sqMudo = await lightsUp(page,
      () => rect('.squad[data-squad="ledger-close"]'),
      (r) => ({ x: r.x - 40, y: r.y + r.h / 2 - 14, w: 40, h: 28 }),
      () => rect('.srf', 'el cierre de marzo'));
    assert.equal(sqMudo, '', `el puerto de la escuadra cambia con el puntero sobre la superficie de su miembro (${sqMudo})`);
    await page.mouse.move(srf2!.x + srf2!.w / 2, srf2!.y + srf2!.h / 2);
    await sleep(300);
    await page.screenshot({ path: join(SHOTS, 'tether-06-squad-hover.png') });
    await page.mouse.move(VIEW.w - 20, VIEW.h - 20);

    /* ── Muchos outputs a la vez: que no sea una maraña ─────────────── */

    /*
     * Seis agentes con estantería y tres superficies colocadas de dos de
     * ellos, en un solo encuadre. La foto es la prueba: los hilos van en la
     * columna de cada baldosa, los tirantes de un mismo agente convergen en
     * su puerto y en reposo todo está a 0.4 — la única línea entera es la que
     * el puntero pide.
     */
    const otros = candidatos.filter((id) => id !== who).slice(0, 5);
    for (const id of otros) await declare(page, id);
    const placed = [`art_tether_${who}_1`, `art_tether_${who}_2`, ...(otros[0] ? [`art_tether_${otros[0]}_0`] : [])];
    await page.evaluate((ids) => {
      const api = (window as never as { __orca: { place(id: string): void } }).__orca;
      for (const id of ids) api.place(id);
    }, placed);
    await page.evaluate(() => (window as never as { __orca: { frame(): void } }).__orca.frame());
    await sleep(1500);
    /*
     * Un encuadre donde las fichas se dibujen —la flota entera está lejos de
     * eso— pero lo más ancho posible: desde el vuelo a la baldosa se abre el
     * zoom paso a paso hasta el último en que la estantería sigue dibujada
     * (peldaño 3, 190 px), que es donde más outputs caben en una foto.
     */
    // A uno que tenga baldosa AHORA: han pasado dos minutos de flota viva y el
    // primero puede haberse plegado o muerto entre medias.
    const conBaldosa = await page.evaluate((ids) => {
      const api = (window as never as { __orca: { spotOf(id: string): { scale: number; trayOf: string | null } | undefined } }).__orca;
      return ids.filter((id) => { const s = api.spotOf(id); return !!s && s.trayOf === null && s.scale >= 1; });
    }, [who, ...otros]);
    assert.ok(conBaldosa.length, 'alguno de los agentes con estantería sigue teniendo baldosa');
    await page.evaluate((id) => (window as never as { __orca: { fly(i: string): void } }).__orca.fly(id), conBaldosa[0]!);
    await sleep(1500);
    const cuenta = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.chip-art')].filter((el) => !el.hidden).length);
    let visibles = await cuenta();
    await page.mouse.move(VIEW.w / 2, VIEW.h / 2);
    for (let i = 0; i < 8; i++) {
      await page.keyboard.down('Control'); await page.mouse.wheel(0, 120); await page.keyboard.up('Control');
      await sleep(400);
      const n = await cuenta();
      if (n < 10) {
        await page.keyboard.down('Control'); await page.mouse.wheel(0, -120); await page.keyboard.up('Control');
        await sleep(400);
        break;
      }
      visibles = n;
    }
    await page.mouse.move(VIEW.w - 20, VIEW.h - 20);
    await sleep(400);
    visibles = await cuenta();
    // La foto antes que la aserción: si falla, que quede lo que se vio.
    await page.screenshot({ path: join(SHOTS, 'tether-07-many.png') });
    assert.ok(visibles >= 10, `varias estanterías a la vez en el encuadre, no ${visibles} fichas`);

    assert.deepEqual(errors, [], 'sin errores de página');
    console.log(`[tether] ok · ${who} (${callsign}) · escuadra ${known} · ${visibles} fichas en el encuadre final · fotos en ${SHOTS}/tether-0{1..7}.png`);
  } finally {
    await browser.close();
    squad?.close();
    if (!keep) shutdown();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
