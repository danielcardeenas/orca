/**
 * Lo que un agente declaró se ve bajo su baldosa. Con el hub, en Chromium.
 *
 *   ORCA_VISUAL_ISOLATED=1 npx tsx test/shelf.shots.ts
 *   npx tsx test/shelf.shots.ts --headed   verlo pasar
 *
 * `npm test -- shelf shelf-layout` prueba la geometría y la reserva, que es
 * aritmética. Lo que no puede ver es si algo se DIBUJA: que las fichas existan
 * en la capa, debajo de la baldosa y no encima, que se vayan al alejarse, y que
 * un clic abra lo que dice que va a abrir. Eso es lo que hay aquí.
 *
 * Los artefactos se inyectan con `window.__orca.artifact`, que no pasa por el
 * hub, por la misma razón que las misiones y AUTOMEJORA del arnés: una foto de
 * una estantería de cuatro fichas no puede dejar cuatro artefactos en el índice
 * del operador. Por eso también van con `ORCA_VISUAL_ISOLATED=1`: hub propio,
 * puerto propio, y la flota de verdad no se entera.
 */

import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { GPU_ARGS, SHOTS, ensureServers, newPage, open, shutdown, uiPort, waitForFleet } from './visual.ts';
import { sleep } from './harness.ts';

const headed = process.argv.includes('--headed');
const keep = process.argv.includes('--keep');
const VIEW = { w: 1440, h: 900 };

/**
 * Las fichas de un agente, con su caja en píxeles.
 *
 * Por agente y no todas: la flota sintética publica artefactos declarados
 * suyos (`fake-collector.ts`), así que en el campo hay estanterías que no son
 * la que se está mirando. Contarlas todas hacía que esta prueba dependiera de
 * cuántos artefactos llevara inventados el mock, que cambia en cada corrida.
 */
async function chips(page: Page, agentId: string): Promise<{ art: string | null; more: string; x: number; y: number; w: number }[]> {
  return page.evaluate((who) => [...document.querySelectorAll<HTMLElement>('.chip-art')]
    .filter((el) => !el.hidden && el.dataset.agent === who)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { art: el.dataset.art ?? null, more: el.textContent ?? '', x: r.x, y: r.y, w: r.width };
    }), agentId);
}

/** La caja del rótulo de una baldosa, que ES la caja de la baldosa. */
async function tileBox(page: Page, id: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate((agentId) => {
    const layer = document.querySelector('[data-labels]');
    const el = [...(layer?.querySelectorAll<HTMLElement>('.lbl') ?? [])]
      .find((x) => x.textContent?.includes(agentId.slice(0, 2).toUpperCase()));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, id);
}

/**
 * Las cinco fichas de un agente, cuando estén y cuando ya no se muevan.
 *
 * Dos esperas en una, y las dos hacen falta contra una flota viva. Que ESTÉN:
 * un hijo que sólo habla con su padre se pliega en su bandeja, y una celda de
 * bandeja no tiene estantería a propósito, así que la franja de ese agente
 * desaparece hasta que hable con alguien más — es el precio de la regla, y en
 * el mock pasa cada pocos segundos. Y que NO SE MUEVAN: la cámara llega con
 * easing y una ventana que se abre la desplaza, así que unas coordenadas leídas
 * hace medio segundo pinchan el lienzo en vez de la ficha.
 */
async function shelfOf(page: Page, agentId: string, n = 5): Promise<Awaited<ReturnType<typeof chips>>> {
  await page.waitForFunction(({ id, want }) => [...document.querySelectorAll<HTMLElement>('.chip-art')]
    .filter((el) => !el.hidden && el.dataset.agent === id).length === want,
  { id: agentId, want: n }, { timeout: 20_000 });
  let prev = '';
  for (let i = 0; i < 30; i++) {
    const now = await chips(page, agentId);
    const sig = now.map((c) => `${Math.round(c.x)},${Math.round(c.y)},${Math.round(c.w)}`).join('|');
    if (sig && sig === prev) return now;
    prev = sig;
    await sleep(250);
  }
  return chips(page, agentId);
}

/**
 * Seis declarados y uno observado a nombre de un agente, sin pasar por el hub.
 *
 * Seis para que salga el contador: cuatro fichas y un «+2». Y el observado para
 * comprobar lo contrario de todo esto — que apareciendo sin que nadie lo elija
 * no cuelga de ninguna baldosa, aunque sea el más nuevo de los siete.
 */
async function declare(page: Page, agentId: string): Promise<void> {
  await page.evaluate((who) => {
    const api = (window as never as { __orca: { artifact(a: unknown): void } }).__orca;
    /*
     * Los más nuevos de ese agente, a propósito. El mock también publica cosas
     * declaradas suyas, y la estantería cuelga lo más nuevo: con un `at` viejo
     * las cuatro fichas visibles eran las del mock y las de la prueba quedaban
     * detrás del contador — la prueba miraba entonces algo que no había puesto.
     */
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      api.artifact({
        id: `art_fix_${who}_${i}`, agentId: who, projectId: 'p', machineId: 'm',
        kind: i === 5 ? 'file' : 'image', path: i === 5 ? '/p/out/build.zip' : `/p/out/frame-${i}.png`,
        title: i === 5 ? 'el paquete' : `fotograma ${i}`, url: null,
        bytes: i === 5 ? 4_404_019 : 2048, width: 640, height: 400,
        at: now + i, open: false, placement: null, source: 'declared',
      });
    }
    api.artifact({
      id: `art_fix_${who}_obs`, agentId: who, projectId: 'p', machineId: 'm',
      kind: 'image', path: '/p/test/shots/capture.png', title: 'capture.png', url: null,
      bytes: 9000, width: 100, height: 100, at: now + 99, open: false, placement: null, source: 'observed',
    });
  }, agentId);
}

/** Cuántos declarados tiene un agente según el mundo de la consola. */
async function declaredCount(page: Page, agentId: string): Promise<number> {
  return page.evaluate((who) => (window as never as {
    __orca: { artifactsSeen(): { agentId: string; source: string }[] };
  }).__orca.artifactsSeen().filter((a) => a.agentId === who && a.source === 'declared').length, agentId);
}

async function main() {
  await ensureServers({ fleet: true, fixtures: true });
  const browser = await chromium.launch({ headless: !headed, args: GPU_ARGS });
  try {
    const page = await newPage(browser, VIEW.w, VIEW.h);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript('window.__name = (fn) => fn');
    await open(page, `http://127.0.0.1:${uiPort()}/?noboot=1`);
    await page.waitForFunction(() => !!document.querySelector('.mast__link.is-up'), null, { timeout: 60_000 });
    await waitForFleet(page, 1);
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('.win [data-w-close]').forEach((b) => b.click());
    });
    await sleep(800);

    /* ── El agente al que se le van a colgar cosas ──────────────────── */

    /*
     * Uno con baldosa PROPIA, y probando hasta que uno aguante.
     *
     * La flota sintética está viva mientras corre esto: un hijo que sólo habla
     * con su padre se pliega en su bandeja entre que se elige y se vuela, y una
     * celda de bandeja no tiene estantería a propósito — es demasiado pequeña
     * para nada y dice sólo su estado, la misma regla que siguen los rótulos.
     * Elegir uno a ciegas hacía que esta prueba pasara o fallara según lo que
     * el mock decidiera en ese segundo, que es una prueba que no dice nada.
     */
    const candidatos = await page.evaluate(() => {
      const api = (window as never as {
        __orca: { agentIds(): string[]; spotOf(id: string): { scale: number; trayOf: string | null } | undefined };
      }).__orca;
      return api.agentIds().filter((id) => {
        const s = api.spotOf(id);
        return !!s && s.trayOf === null && s.scale >= 1;
      });
    });
    assert.ok(candidatos.length, 'la flota sintética dio algún agente con baldosa propia');

    let who = '';
    for (const cand of candidatos.slice(0, 4)) {
      await declare(page, cand);
      await page.evaluate((id) => (window as never as { __orca: { fly(i: string): void } }).__orca.fly(id), cand);
      try {
        await page.waitForFunction(
          (id) => [...document.querySelectorAll<HTMLElement>('.chip-art')]
            .filter((el) => !el.hidden && el.dataset.agent === id).length === 5,
          cand, { timeout: 10_000 });
        who = cand;
        break;
      } catch { /* se plegó, se fue de cuadro o se murió: el siguiente */ }
    }
    assert.ok(who, `ninguno de los ${Math.min(4, candidatos.length)} candidatos mantuvo su baldosa el tiempo de colgarle nada`);

    const shown = await shelfOf(page, who);
    assert.equal(shown.length, 5, `cuatro fichas y un contador, no ${shown.length}`);
    const counter = shown.filter((c) => !c.art);
    assert.equal(counter.length, 1, 'exactamente una ficha contador');
    /*
     * Lo que queda, exacto y contado contra el mundo — no «+2» a pelo: el mock
     * puede haberle publicado cosas declaradas a este agente antes de que la
     * prueba llegara, y un número escrito a mano aquí falla según el segundo.
     */
    const declarados = await declaredCount(page, who);
    assert.match(counter[0]!.more, new RegExp(`\\+${declarados - 4}(?!\\d)`),
      `el contador dice lo que queda de ${declarados} declarados, no "${counter[0]!.more}"`);
    // El observado no está, aunque sea el más nuevo de todos.
    assert.ok(!shown.some((c) => c.art?.endsWith('_obs')), 'lo observado no cuelga de ninguna baldosa');

    /* ── Y está DEBAJO de la baldosa, que es el punto entero ────────── */

    const box = await tileBox(page, who);
    if (box) {
      const techo = Math.min(...shown.map((c) => c.y));
      assert.ok(techo >= box.y + box.h - 1,
        `la franja empieza en ${techo.toFixed(0)} y la baldosa acaba en ${(box.y + box.h).toFixed(0)}: la estaría tapando`);
    }
    // Una fila, no una columna: todas a la misma altura y en orden.
    const y0 = shown[0]!.y;
    assert.ok(shown.every((c) => Math.abs(c.y - y0) < 2), 'las cinco fichas están en la misma fila');

    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'shelf-01-chips.png') });

    /* ── Clic en una ficha: se abre su artefacto ─────────────────────── */

    /*
     * Por selector y no por coordenadas que calcule la prueba: la cámara llega
     * con easing y una ventana que se abre la mueve, así que un par de píxeles
     * leídos hace medio segundo aciertan unas veces. Playwright pincha el
     * centro del elemento en el momento de pinchar, que es lo que hace una
     * persona.
     */
    await shelfOf(page, who);
    await page.click(`.chip-art[data-agent="${who}"][data-art]`);
    /*
     * Se espera a que la ventana esté, no un número de milisegundos. Un `sleep`
     * aquí es una prueba que falla cuando la máquina está ocupada y pasa cuando
     * no, que es lo mismo que no probar nada. La ficha que se pincha es la
     * primera, que es la más nueva, que es una de las que puso esta prueba: de
     * ahí que la ruta se pueda afirmar.
     */
    await page.waitForFunction(() => [...document.querySelectorAll('.win')]
      .some((w) => (w.textContent ?? '').includes('/p/out/')), null, { timeout: 15_000 })
      .catch(() => { throw new Error('un clic en una ficha no abrió la ventana de su artefacto'); });
    await page.screenshot({ path: join(SHOTS, 'shelf-02-artifact.png') });
    await page.evaluate(() => document.querySelectorAll<HTMLElement>('.win [data-w-close]').forEach((b) => b.click()));
    await sleep(500);

    /* ── Clic en el contador: la galería, filtrada por ese agente ────── */

    await shelfOf(page, who);
    await page.click(`.chip-art[data-agent="${who}"]:not([data-art])`);
    await page.waitForFunction(() => [...document.querySelectorAll('.win')]
      .some((w) => (w.textContent ?? '').includes('GALLERY')), null, { timeout: 15_000 })
      .catch(() => { throw new Error('el contador no abrió la galería'); });
    const gal = await page.evaluate(() => [...document.querySelectorAll('.win')]
      .map((w) => w.textContent ?? '').find((t) => t.includes('GALLERY')) ?? '');
    /*
     * Y llega FILTRADA, que es el punto: la galería entera no responde a «qué
     * hizo éste». Lo dice su propio subtítulo, «N SHOWN», que sólo aparece
     * cuando lo que se ve es menos que el total.
     */
    assert.match(gal, /SHOWN/, `la galería llega filtrada, no entera: "${gal.slice(0, 80)}"`);
    await page.screenshot({ path: join(SHOTS, 'shelf-03-gallery.png') });
    await page.evaluate(() => document.querySelectorAll<HTMLElement>('.win [data-w-close]').forEach((b) => b.click()));
    await sleep(500);

    /* ── Y una ficha con imagen de verdad, no un glifo ───────────────── */

    /*
     * Los artefactos de arriba los inventa la prueba, así que no tienen bytes y
     * su ficha es la de glifo. Eso deja sin probar justo el camino que el
     * operador va a ver: una imagen que el hub sirve de verdad. Para eso valen
     * los artefactos que la flota sintética publica ella misma — el hub les pone
     * url y va a buscar los bytes al collector — y lo que se comprueba es lo
     * único que importa: que el <img> de la ficha CARGÓ (`naturalWidth`), no que
     * exista la etiqueta.
     */
    // El mock publica sus artefactos con el tiempo: se espera a que haya uno con
    // bytes detrás en vez de mirar si ya lo había, que es una carrera.
    await page.waitForFunction(() => (window as never as {
      __orca: { artifactsSeen(): { kind: string; source: string; hasUrl: boolean; id: string }[] };
    }).__orca.artifactsSeen()
      .some((a) => a.kind === 'image' && a.source === 'declared' && a.hasUrl && !a.id.startsWith('art_fix_')),
    null, { timeout: 90_000 });

    const real = await page.evaluate(() => {
      const api = (window as never as {
        __orca: {
          artifactsSeen(): { id: string; agentId: string; kind: string; source: string; hasUrl: boolean }[];
          spotOf(id: string): { scale: number; trayOf: string | null } | undefined;
        };
      }).__orca;
      return api.artifactsSeen().find((a) => a.kind === 'image' && a.source === 'declared' && a.hasUrl
        && !a.id.startsWith('art_fix_')
        && (() => { const s = api.spotOf(a.agentId); return !!s && s.trayOf === null && s.scale >= 1; })()) ?? null;
    });
    assert.ok(real, 'la flota sintética publicó alguna imagen declarada con bytes detrás');
    await page.evaluate((id) => (window as never as { __orca: { fly(i: string): void } }).__orca.fly(id), real.agentId);
    await page.waitForFunction((id) => [...document.querySelectorAll<HTMLElement>('.chip-art')]
      .some((el) => !el.hidden && el.dataset.agent === id && !!el.querySelector('img')),
    real.agentId, { timeout: 20_000 });

    const conImagen = await page.evaluate(async (who2) => {
      const chipsEls = [...document.querySelectorAll<HTMLElement>('.chip-art')]
        .filter((el) => !el.hidden && el.dataset.agent === who2);
      for (const el of chipsEls) {
        const img = el.querySelector('img');
        if (!img) continue;
        if (img.complete && img.naturalWidth > 0) return { src: img.getAttribute('src') ?? '', w: img.naturalWidth };
        try {
          await new Promise<void>((res, rej) => {
            img.addEventListener('load', () => res(), { once: true });
            img.addEventListener('error', () => rej(new Error('error')), { once: true });
            setTimeout(() => rej(new Error('timeout')), 4000);
          });
          return { src: img.getAttribute('src') ?? '', w: img.naturalWidth };
        } catch { /* la siguiente */ }
      }
      return null;
    }, real.agentId);
    assert.ok(conImagen && conImagen.w > 0,
      'alguna ficha de la flota sintética lleva una imagen que el hub sirvió de verdad');
    console.log(`[shelf] una ficha con imagen real: ${conImagen!.w}px de ancho natural`);
    await page.screenshot({ path: join(SHOTS, 'shelf-05-real.png') });

    /* ── De lejos no se dibuja: la silueta manda ─────────────────────── */

    /*
     * Lo que hay que demostrar es que la estantería se va MIENTRAS LA FLOTA
     * SIGUE AHÍ: si uno se aleja hasta que no se dibuja nada, que no haya
     * fichas no dice nada. Así que se aleja de a poco y se para en el primer
     * fotograma sin fichas, y ahí se comprueba que todavía hay baldosas
     * dibujadas — la silueta se queda, la fotografía se va.
     */
    await page.evaluate(() => (window as never as { __orca: { frame(): void } }).__orca.frame());
    await sleep(1200);
    const drawn = () => page.evaluate(() => (window as never as { __orca: { stats(): { drawn: number } } }).__orca.stats().drawn);
    let lejos = await chips(page, who);
    let tiles = await drawn();
    for (let i = 0; i < 10 && (lejos.length > 0 || tiles === 0); i++) {
      await page.mouse.move(VIEW.w / 2, VIEW.h / 2);
      await page.mouse.wheel(0, 200);
      await sleep(700);
      lejos = await chips(page, who);
      tiles = await drawn();
    }
    assert.equal(lejos.length, 0, `de lejos la estantería se va, y quedaban ${lejos.length} fichas`);
    assert.ok(tiles > 0, `la flota sigue dibujada cuando la estantería se va, y había ${tiles} baldosas`);
    await page.screenshot({ path: join(SHOTS, 'shelf-04-far.png') });
    console.log(`[shelf] la franja se va con ${tiles} baldosas todavía en pantalla`);

    /* ── Y en su lugar queda la tarjeta: que hay resultados, y cuántos ── */

    /*
     * El primer fotograma sin fichas es el peldaño de en medio (`shelf.ts`,
     * entre 44 y 190 px de baldosa): ahí la baldosa cuelga la tarjeta con el
     * más nuevo y la cuenta, a píxeles fijos, así que de lejos se sigue viendo
     * que este agente produjo algo sin acercarse. Con cuatro o más declarados
     * la cuenta va escrita; se comprueba contra el mundo, como el contador.
     */
    const badge = await page.evaluate((id) => {
      const el = document.querySelector<HTMLElement>(`.chip-badge[data-agent="${id}"]`);
      if (!el || el.hidden) return null;
      const r = el.getBoundingClientRect();
      return { text: el.textContent ?? '', h: r.height, art: el.dataset.art ?? null };
    }, who);
    assert.ok(badge, 'sin fichas, la baldosa cuelga la tarjeta');
    const total = await declaredCount(page, who);
    assert.match(badge.text, new RegExp(`×${total}(?!\\d)`), `la tarjeta dice cuántos hay (${total}), no "${badge.text}"`);
    assert.ok(badge.h >= 18 && badge.h <= 30, `la tarjeta mide en píxeles fijos, no ${badge.h.toFixed(0)}`);
    assert.equal(badge.art, null, 'con varios outputs la tarjeta es la puerta a la galería, no un artefacto');
    await page.screenshot({ path: join(SHOTS, 'shelf-06-badge.png') });
    /*
     * Más lejos aún, por debajo del rótulo, la tarjeta también se va y la
     * marca la lleva el shader. Se encuadra la flota entera antes de alejarse
     * —la rueda hace zoom hacia el puntero, y desde un rincón la flota se iba
     * de cuadro— y se para en el primer fotograma sin tarjeta, con la flota
     * dibujada. La marca es WebGL y no se puede afirmar desde el DOM: queda
     * la foto, y un recorte de la baldosa para verla de cerca.
     */
    await page.evaluate(() => (window as never as { __orca: { frame(): void } }).__orca.frame());
    await sleep(1200);
    // Ctrl+rueda es zoom; la rueda a secas panea y se llevaba la flota de cuadro.
    let conTarjeta = true;
    for (let i = 0; i < 12 && conTarjeta; i++) {
      await page.mouse.move(VIEW.w / 2, VIEW.h / 2);
      await page.keyboard.down('Control'); await page.mouse.wheel(0, 160); await page.keyboard.up('Control');
      await sleep(600);
      conTarjeta = await page.evaluate((id) => { const el = document.querySelector<HTMLElement>(`.chip-badge[data-agent="${id}"]`); return !!el && !el.hidden; }, who);
    }
    await page.mouse.move(VIEW.w - 20, VIEW.h - 20);
    await sleep(300);
    tiles = await drawn();
    assert.ok(!conTarjeta, 'de muy lejos la tarjeta también se va');
    assert.ok(tiles > 0, `la flota sigue dibujada sin tarjeta, y había ${tiles} baldosas`);
    await page.screenshot({ path: join(SHOTS, 'shelf-07-mark.png') });
    const marked = await page.evaluate((id) => (window as never as {
      __orca: { screenOf(i: string): { x: number; y: number; w: number; h: number } | null };
    }).__orca.screenOf(id), who);
    if (marked && marked.w > 4) {
      const x = Math.max(0, marked.x - marked.w), y = Math.max(0, marked.y - marked.h);
      await page.screenshot({ path: join(SHOTS, 'shelf-08-mark-close.png'), clip: { x, y, width: Math.min(VIEW.w - x, marked.w * 3), height: Math.min(VIEW.h - y, marked.h * 3) } });
    }
    console.log(`[shelf] la tarjeta dice ×${total} en el peldaño de en medio y se va con ${tiles} baldosas en pantalla`);

    assert.deepEqual(errors, [], 'no page errors');
    console.log('[shelf] ok · 4 fichas y un contador bajo la baldosa, el clic abre, y de lejos se va');
  } finally {
    await browser.close();
    if (!keep) shutdown();
  }
}

main().catch((e) => { console.error(e); shutdown(); process.exit(1); });
