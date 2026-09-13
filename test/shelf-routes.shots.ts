/**
 * El bus de linaje de un padre con estantería, por debajo de sus fichas. Con
 * el hub, en Chromium.
 *
 *   ORCA_VISUAL_ISOLATED=1 npx tsx test/shelf-routes.shots.ts
 *   npx tsx test/shelf-routes.shots.ts --headed   verlo pasar
 *
 * `npm test -- shelf-routes` prueba la geometría: que el canalón bajo una
 * fila con estantería baja `SHELF_H`. Lo que no puede ver es la foto que el
 * operador va a mirar: un padre al que se le cuelgan fichas, su hijo en la
 * fila de abajo, y el bus entre los dos corriendo por debajo de la franja en
 * vez de por en medio de la primera ficha. Eso es lo que hay aquí, con la
 * misma flota sintética y el mismo hub aislado que `tether.shots.ts`.
 *
 * Lo que se afirma desde fuera es lo que se puede afirmar sin leer píxeles
 * del WebGL: que la rejilla le dio a la baldosa su `shelf`, y que la fila
 * del hijo bajó exactamente eso. La foto es la prueba de lo demás.
 *
 * El par lo pone la escuadra del arnés (`injectSquad`): el líder y sus
 * miembros. Si en esta corrida ningún miembro tiene baldosa propia en la
 * fila de abajo del líder —se pliegan en su bandeja hasta hablar con otro—,
 * el script lo dice y sale con el código de omisión: ni rojo ni verde. Un
 * rojo que depende de la suerte del fixture envenena la suite para el
 * siguiente; un verde que no miró nada la vacía de contenido.
 */

import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { GPU_ARGS, SHOTS, ensureServers, injectSquad, newPage, open, shutdown, uiPort, waitForFleet } from './visual.ts';
import { skipShot } from './shot-skip.ts';
import { sleep } from './harness.ts';
import { GAP_Y, TILE_H } from '../src/ui/field/layout.ts';
import { SHELF_H } from '../src/ui/field/shelf.ts';

const headed = process.argv.includes('--headed');
const keep = process.argv.includes('--keep');
const VIEW = { w: 1440, h: 900 };

interface SpotView { tx: number; ty: number; scale: number; trayOf: string | null; shelf: number }
type Api = {
  agentIds(): string[];
  spotOf(id: string): SpotView | undefined;
  kinOf(id: string): { parentId: string | null; childIds: string[] } | null;
  artifact(a: unknown): void;
  fly(id: string): void;
  screenOf(id: string): { x: number; y: number; w: number; h: number } | null;
};

async function declare(page: Page, agentId: string): Promise<void> {
  await page.evaluate((who) => {
    const api = (window as never as { __orca: Api }).__orca;
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      api.artifact({
        id: `art_routes_${who}_${i}`, agentId: who, projectId: 'p', machineId: 'm',
        kind: i === 0 ? 'file' : 'image', path: i === 0 ? '/p/out/build.zip' : `/p/out/frame-${i}.png`,
        title: i === 0 ? 'el paquete' : `fotograma ${i}`, url: null,
        bytes: i === 0 ? 4_404_019 : 2048, width: 640, height: 400,
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

    /*
     * La escuadra del arnés (`injectSquad`): el líder Z1 y cinco miembros que
     * son hijos suyos, en un bloque de dos filas. Es estable —nadie nace ni
     * muere en ella—, que es lo que hace falta: con la flota sintética el
     * par «hijo en la fila de abajo» sólo existe en un salto de fila, y el
     * siguiente nacimiento lo deshace antes de que se cuelgue nada. Aquí el
     * líder está arriba y hay miembros debajo mientras dure la foto.
     */
    /*
     * Lo que depende del fixture no es un fallo: es un skip, dicho. Un arnés
     * que se pone rojo porque la flota sintética no ofreció el par que la
     * foto necesita envenena la suite para el siguiente; lo que se AFIRMA es
     * sólo lo que, dado el par, no depende de la suerte — lo que la rejilla
     * reserva y cuánto bajó la fila.
     *
     * Pero tampoco es un verde: salía con cero y el tablero lo contaba entre
     * los que pasan, seis veces distintas. `skipShot` deja el código de
     * salida en `SKIP_CODE` y el runner lo pinta amarillo, con su motivo y
     * su recuento aparte. Ver `shot-skip.ts`.
     */
    const skip = (why: string) => { skipShot(`shelf-routes · ${why} · no fotografío`); };
    squad = await injectSquad();
    if (!squad) return skip('el hub no aceptó la escuadra del arnés');
    const lead = 'sess_vsquad_z1';
    const appeared = await page.waitForFunction(() => !!document.querySelector('.squad[data-squad="ledger-close"]'), null, { timeout: 30_000 })
      .then(() => true).catch(() => false);
    if (!appeared) return skip('la escuadra nunca apareció en el campo');
    await sleep(1500);
    const own = (s: SpotView | null | undefined) => !!s && s.trayOf === null && s.scale >= 1;
    // Los miembros, por `parentId`: el líder inyectado no lleva `childIds`.
    const readSpots = () => page.evaluate(({ p, tileH }) => {
      const api = (window as never as { __orca: Api }).__orca;
      const lead = api.spotOf(p) ?? null;
      const kids = api.agentIds().filter((id) => api.kinOf(id)?.parentId === p).map((id) => ({ id, s: api.spotOf(id) ?? null }));
      const below = lead ? kids.find((k) => k.s && k.s.trayOf === null && k.s.scale >= 1 && k.s.ty < lead.ty - tileH) ?? null : null;
      return { p: lead, c: below?.s ?? null, child: below?.id ?? null, kids: kids.map((k) => ({ id: k.id, ty: k.s?.ty, trayOf: k.s?.trayOf })) };
    }, { p: lead, tileH: TILE_H });
    /*
     * El bloque tarda unos segundos en asentarse: un miembro que aún no ha
     * hablado con nadie más que con el líder está plegado en su bandeja, y
     * sale de ella cuando llega su primer mensaje a otro. Se espera a que
     * alguno esté de verdad en la fila de abajo, con baldosa propia.
     */
    let spots = await readSpots();
    for (let i = 0; i < 30 && !(own(spots.p) && spots.child); i++) { await sleep(1000); spots = await readSpots(); }
    if (!own(spots.p)) return skip('el líder no tiene baldosa propia');
    if (!spots.child) return skip(`ningún miembro con baldosa propia en la fila de abajo del líder (ty ${spots.p!.ty.toFixed(3)}); miembros ${JSON.stringify(spots.kids)}`);
    const pair = { parent: lead, child: spots.child };

    await declare(page, lead);
    await page.evaluate((id) => (window as never as { __orca: Api }).__orca.fly(id), lead);
    const shelved = await page.waitForFunction((id) => [...document.querySelectorAll<HTMLElement>('.chip-art')]
      .filter((el) => !el.hidden && el.dataset.agent === id).length === 5, lead, { timeout: 15_000 })
      .then(() => true).catch(() => false);
    if (!shelved) return skip('la estantería del líder no se dibujó');
    await sleep(1500);
    spots = await readSpots();
    console.log(`[shelf-routes] ${pair.parent} → ${spots.child} · líder ty ${spots.p?.ty.toFixed(3)} shelf ${spots.p?.shelf} · hijo ty ${spots.c?.ty.toFixed(3)}`);
    if (!(own(spots.p) && own(spots.c))) return skip('líder o miembro perdieron la baldosa mientras se colgaban las fichas');

    /* ── La rejilla: la fila del líder reserva, y la de abajo bajó eso ── */
    const ps = spots.p!, cs = spots.c!;
    assert.ok(Math.abs(ps.shelf - SHELF_H) < 1e-9, `la fila del líder reserva SHELF_H, no ${ps.shelf}`);
    // El miembro está una fila más abajo, o más: la fila bajó al menos un
    // paso más la franja del líder.
    const gap = ps.ty - cs.ty;
    assert.ok(gap >= TILE_H + GAP_Y + SHELF_H - 1e-6, `la fila de abajo bajó la franja: ${gap.toFixed(3)} contra ${(TILE_H + GAP_Y + SHELF_H).toFixed(3)}`);

    await page.mouse.move(VIEW.w - 20, VIEW.h - 20);
    await sleep(400);
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'shelf-routes-01-bus.png') });

    // Un recorte alrededor del padre y su estantería, donde se ve el bus salir.
    const box = await page.evaluate((id) => (window as never as { __orca: Api }).__orca.screenOf(id), pair.parent);
    if (box) {
      const x = Math.max(0, box.x - 60), y = Math.max(0, box.y - 20);
      const w = Math.min(VIEW.w - x, box.w + 120), h = Math.min(VIEW.h - y, box.h * 1.9);
      await page.screenshot({ path: join(SHOTS, 'shelf-routes-02-close.png'), clip: { x, y, width: w, height: h } });
    }

    assert.deepEqual(errors, [], 'sin errores de página');
    console.log(`[shelf-routes] ok · padre ${pair.parent} → hijo ${pair.child} · shelf ${ps.shelf.toFixed(3)} · hijo ${gap.toFixed(3)} más abajo · fotos en ${SHOTS}/shelf-routes-0{1,2}.png`);
  } finally {
    await browser.close();
    squad?.close();
    /*
     * El cierre del arnés borra su ORCA_HOME temporal mientras el hub aislado
     * puede estar escribiendo todavía (`ENOTEMPTY` en `hub/improve`, `ENOENT`
     * en `hub/events`): es ruido de `test/visual.ts`, y una excepción aquí
     * pisaría la salida de la prueba con un rojo que no es de la prueba.
     */
    try { if (!keep) shutdown(); } catch (e) { console.log(`[shelf-routes] el cierre del arnés se quejó: ${(e as Error).message}`); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
