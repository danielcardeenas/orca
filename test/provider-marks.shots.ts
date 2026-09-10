/**
 * Las marcas de proveedor, fotografiadas en los dos selectores que las llevan.
 *
 *   npx tsx test/provider-marks.shots.ts            reutiliza el vite que haya
 *   npx tsx test/provider-marks.shots.ts --headed   verlo pasar
 *
 * Aislado a propósito: monta `capcom-model` solo, con su fixture, sobre una
 * página vacía. No hay flota, no hay hub de verdad y no se toca el disco del
 * operador — lo único que se mira es el componente.
 *
 * Lo que se comprueba, que es lo que la misión pide y lo que un `npm test` no
 * puede ver:
 *
 *   - que CHANGE MODEL y New CAPCOM enseñan una marca por proveedor
 *   - que las dos marcas son DISTINTAS: si Claude y OpenAI se dibujaran igual,
 *     la lista tendría un adorno en vez de una señal
 *   - que son dibujos de píxeles y no tipografía: `<svg>` con `crispEdges` y
 *     sus celdas contadas
 *   - que NO cambia nada de lo que ya funcionaba: los nombres de los grupos,
 *     las etiquetas y pistas de las opciones, el filtrado, el teclado y la
 *     selección
 *   - desktop y móvil, y en móvil el mismo selector abierto como diálogo
 */

import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const headed = process.argv.includes('--headed');
const SHOTS = new URL('shots/', import.meta.url).pathname;

/** La página desnuda donde vive el componente: sólo los estilos que usa. */
const FIXTURE = '<!doctype html><html><head>'
  + '<link rel="stylesheet" href="/src/ui/styles/tokens.css">'
  + '<link rel="stylesheet" href="/src/ui/styles/hud.css">'
  + '<link rel="stylesheet" href="/src/ui/styles/window.css">'
  + '</head><body style="background:#0b0a0d;margin:0">'
  + '<main class="win__body" style="display:flex;flex-direction:column;'
  + 'width:min(640px,calc(100vw - 20px));height:calc(100dvh - 24px);margin:12px auto"></main>'
  + '</body></html>';

/** Lo que hay dibujado en cada cabecera de grupo del menú abierto. */
interface Group { name: string; marks: number; cells: number; crisp: boolean; svg: string }

async function groups(page: Page): Promise<Group[]> {
  return page.$$eval('.pick__menu:not([hidden]) .pick__group', (heads) => heads.map((h) => {
    const svg = h.querySelector('svg.pmark');
    return {
      // El nombre sigue siendo TEXTO: si la marca se hubiera comido el nombre,
      // esto vendría vacío y el filtrado y el lector de pantalla con él.
      name: (h.textContent ?? '').trim(),
      marks: h.querySelectorAll('svg.pmark').length,
      cells: svg?.querySelectorAll('rect').length ?? 0,
      crisp: svg?.getAttribute('shape-rendering') === 'crispEdges',
      svg: svg?.innerHTML ?? '',
    };
  }));
}

async function openMenu(page: Page, button: string): Promise<void> {
  await page.getByRole('button', { name: button, exact: true }).click();
  await page.locator('.pick__menu:not([hidden])').first().waitFor();
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

async function main() {
  /*
   * Servidor propio y efímero, como `capcom-new.visual.ts`: sin la
   * configuración de vite del proyecto, sin proxy de websocket y sin hub. Lo
   * que se mira es el componente, así que nada más tiene por qué estar en pie
   * —y así esta prueba no depende de que el operador tenga la consola abierta.
   */
  const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const port = (server.httpServer!.address() as { port: number }).port;
  const browser = await chromium.launch({ headless: !headed });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 1050 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/marks-fixture', (route) => route.fulfill({ contentType: 'text/html', body: FIXTURE }));
    await page.addInitScript('window.__name = (fn) => fn');
    await page.goto(`http://127.0.0.1:${port}/marks-fixture`);
    // `capcom-new.fixture` monta encima de `capcom-model.fixture`, así que la
    // misma página tiene los DOS selectores: CHANGE MODEL y New CAPCOM.
    await page.evaluate(async () => { await import('/test/capcom-new.fixture.ts' as string); });
    await mkdir(SHOTS, { recursive: true });

    /* 1 · CHANGE MODEL: una marca por proveedor, y las dos distintas */

    await openMenu(page, 'CHANGE MODEL');
    const change = await groups(page);
    assert.ok(change.length >= 2, `CHANGE MODEL agrupa por proveedor (${change.length} grupos)`);
    assert.deepEqual(change.map((g) => g.name), ['CODEX', 'CLAUDE CODE'],
      'los nombres de los grupos siguen siendo los de antes');
    for (const g of change) {
      assert.equal(g.marks, 1, `${g.name} lleva una marca y sólo una`);
      assert.ok(g.cells > 8, `${g.name} dibuja una marca con celdas de verdad (${g.cells})`);
      assert.equal(g.crisp, true, `${g.name} dibuja píxeles, no una curva suavizada`);
    }
    /*
     * Una línea, no dos. La marca ocupa ancho y la primera versión a 18px
     * partía «CLAUDE CODE» en dos renglones, que se lee como dos grupos. Lo
     * que tiene que ceder es el ancho del menú, no el nombre.
     */
    const wrapped = await page.$$eval('.pick__menu:not([hidden]) .pick__group', (heads) => heads.map((h) => {
      // Cuántos renglones ocupa el NOMBRE: los rectángulos de un rango sobre su
      // nodo de texto. Medir la altura de la caja no vale, porque lleva relleno.
      const text = [...h.childNodes].find((n) => n.nodeType === 3);
      if (!text) return 0;
      const r = document.createRange();
      r.selectNodeContents(text);
      return r.getClientRects().length;
    }));
    assert.ok(wrapped.every((n) => n === 1), `cada cabecera de grupo cabe en una línea (${wrapped.join(',')})`);

    const codex = change.find((g) => g.name === 'CODEX')!;
    const claude = change.find((g) => g.name === 'CLAUDE CODE')!;
    assert.notEqual(codex.svg, claude.svg,
      'Claude y OpenAI se dibujan DISTINTO: una marca igual para los dos no diría nada');

    /* 2 · lo que ya funcionaba sigue funcionando */

    const opts = await page.$$eval('.pick__menu:not([hidden]) .pick__item',
      (rows) => rows.map((r) => ({
        label: r.querySelector('b')?.textContent ?? '', hint: r.querySelector('span')?.textContent ?? '',
      })));
    assert.ok(opts.some((o) => /^gpt-6-astra$/i.test(o.label) && o.hint === 'active'),
      `las etiquetas y las pistas de las opciones están intactas (${JSON.stringify(opts)})`);
    assert.ok(opts.some((o) => /^sonnet$/i.test(o.label) && /handoff/.test(o.hint)),
      'el modelo del otro proveedor sigue en la lista, con su aviso de traspaso');
    assert.ok(opts.some((o) => /^opus$/i.test(o.label) && /not installed/.test(o.hint)),
      'y lo que no se puede elegir sigue listado y legible, no escondido');
    assert.equal(await page.locator('.pick__menu:not([hidden]) svg.pmark').count(), 2,
      'la marca va en la cabecera del grupo, no repetida en cada fila');

    await page.screenshot({ path: join(SHOTS, 'provider-marks-change-model.png') });

    // Filtrado: sigue filtrando por el NOMBRE, que es lo que el operador teclea.
    await page.locator('.pick__menu:not([hidden]) .pick__search').fill('luna');
    await page.waitForTimeout(150);
    const filtered = await page.$$eval('.pick__menu:not([hidden]) .pick__item',
      (rows) => rows.map((r) => r.querySelector('b')?.textContent ?? ''));
    assert.deepEqual(filtered, ['gpt-5.6-luna'], `el filtro sigue filtrando (${filtered.join(', ')})`);

    // Teclado: bajar y elegir, sin ratón. Lo que se comprueba es el SELECTOR
    // —que la fila se marca y la elección se confirma—, no lo que el hub haga
    // después con ella: eso ya lo miran las pruebas del propio componente.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    // `innerText` viene en mayúsculas porque las pone el CSS, no el dato.
    assert.equal((await page.locator('[data-picker] .pick__btn b').innerText()).toLowerCase(), 'gpt-5.6-luna',
      'elegir con el teclado sigue eligiendo');
    await closeMenu(page);

    /* 3 · la línea de estado, con el menú cerrado, lleva su marca */

    const activeLine = page.locator('[data-active]');
    assert.equal(await activeLine.locator('svg.pmark').count(), 1,
      'con el menú cerrado también se ve de quién es el modelo activo');
    assert.match(await activeLine.innerText(), /CODEX · gpt-6-astra/,
      'y el nombre sigue escrito al lado: la marca acompaña, no sustituye');

    /* 4 · New CAPCOM: el mismo criterio en el otro selector */

    await page.getByRole('button', { name: 'New CAPCOM', exact: true }).click();
    await page.locator('[data-fresh-model] .pick__btn').waitFor();
    await page.locator('[data-fresh-model] .pick__btn').click();
    await page.locator('.pick__menu:not([hidden])').first().waitFor();
    const fresh = await groups(page);
    assert.deepEqual(fresh.map((g) => g.name), ['CODEX', 'CLAUDE CODE'],
      'New CAPCOM agrupa igual y con los mismos nombres');
    for (const g of fresh) assert.equal(g.marks, 1, `${g.name} lleva su marca en New CAPCOM`);
    assert.notEqual(fresh[0]!.svg, fresh[1]!.svg, 'y siguen siendo dos marcas distintas');
    await page.screenshot({ path: join(SHOTS, 'provider-marks-new-capcom.png') });

    /* 5 · el teléfono: el mismo selector, abierto como diálogo */

    await closeMenu(page);
    /*
     * Pestaña NUEVA y no un `setViewportSize` sobre la de escritorio: `pick`
     * decide desplegable o diálogo al ABRIR, y un menú que ya se abrió anclado
     * al botón conserva su posición. Encoger la ventana con esa posición puesta
     * es una secuencia que ningún teléfono vive —un teléfono nunca fue un
     * escritorio— y mediría un fallo que no existe.
     */
    const phonePage = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    phonePage.setDefaultTimeout(8000);
    phonePage.on('pageerror', (e) => errors.push(e.message));
    await phonePage.route('**/marks-fixture', (route) => route.fulfill({ contentType: 'text/html', body: FIXTURE }));
    await phonePage.addInitScript('window.__name = (fn) => fn');
    await phonePage.goto(`http://127.0.0.1:${port}/marks-fixture`);
    await phonePage.evaluate(async () => { await import('/test/capcom-new.fixture.ts' as string); });
    await phonePage.getByRole('button', { name: 'CHANGE MODEL', exact: true }).click();
    await phonePage.locator('.pick__menu.is-dialog:not([hidden])').waitFor();
    const phone = await groups(phonePage);
    for (const g of phone) {
      assert.equal(g.marks, 1, `${g.name} conserva su marca en el diálogo del teléfono`);
      assert.ok(g.cells > 8, `${g.name} no se queda en un hueco al reducir (${g.cells})`);
    }
    await phonePage.screenshot({ path: join(SHOTS, 'provider-marks-mobile.png') });
    assert.equal(await phonePage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
      'el teléfono no se desborda a lo ancho');
    /*
     * Y el diálogo entero cabe. La marca ENSANCHA la cabecera de grupo, que es
     * lo que decide el ancho del menú: si eso empujara el diálogo fuera de la
     * pantalla, el adorno habría roto el selector en el sitio donde menos
     * margen hay. Se mide, no se supone.
     */
    const box = await phonePage.evaluate(() => {
      const m = document.querySelector('.pick__menu.is-dialog:not([hidden])') as HTMLElement | null;
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth };
    });
    assert.ok(box && box.left >= 0 && box.right <= box.vw,
      `el diálogo cabe en la pantalla del teléfono (${JSON.stringify(box)})`);

    assert.deepEqual(errors, [], `la consola no tiró ningún error: ${errors.join(' · ')}`);
    console.log('Provider marks: CHANGE MODEL, New CAPCOM, two distinct pixel marks, '
      + 'labels/hints/search/keyboard/selection intact, desktop and phone passed.\n'
      + join(SHOTS, 'provider-marks-change-model.png'));
  } finally {
    await browser.close();
    await server.close();
  }
}

await main();
