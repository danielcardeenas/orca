/**
 * NOT MOVING, fotografiada contra la consola de verdad.
 *
 *   npx tsx test/mission-stall.shots.ts --isolated   hub y vite propios
 *   npx tsx test/mission-stall.shots.ts --headed     verlo pasar
 *
 * `--isolated` no es opcional por comodidad: `ensureServers()` sin ella
 * comparte ORCA_HOME con el operador, y esto planta misiones. Con ella, hub,
 * puertos y ORCA_HOME son propios y se tiran al terminar.
 *
 * Qué se está comprobando, y por qué hace falta una foto y no otro test: la
 * fase `stalled` existe porque `alive()` cuenta un idle, así que una misión
 * cuyo agente nunca recibió su encargo decía IN PROGRESS en verde mientras el
 * operador la miraba. Lo que hay que ver es que ahora dice otra cosa, que lo
 * dice en el ámbar que la consola reserva para «esto necesita a una persona»,
 * que la cremallera se queda vacía —el zip es el estado, y una misión parada
 * no está asentada— y que la fila no se cae del grupo de abiertas por decirlo.
 * Nada de eso se lee en un assert de string: son la paleta y el sitio.
 *
 * Las misiones se meten por el hook `__orca` de la consola, no por el hub: una
 * foto de tres estados no debe dejar tres conversaciones en el fichero de
 * misiones de nadie.
 *
 * Frame: test/shots/mission-stall-panel.png (los frames no se versionan; se
 * regeneran con este comando).
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { CapcomMission } from '../src/shared/missions.ts';
import { GPU_ARGS, SHOTS, ensureServers, fontsReady, orcaToken, shutdown, uiPort } from './visual.ts';

const headed = process.argv.includes('--headed');

/** El ámbar de la consola (`--amber`, tokens.css), como lo devuelve el navegador. */
const AMBER = 'rgb(245, 165, 36)';
/** El lima de «vivo», para que la comparación sea contra algo y no contra nada. */
const LIME = 'rgb(192, 249, 74)';

async function main(): Promise<void> {
  await ensureServers();
  const browser = await chromium.launch({ headless: !headed, args: GPU_ARGS });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // tsx compila este archivo con keepNames; el helper `__name` que inyecta en
    // un closure serializado no existe dentro de la página.
    await page.addInitScript('window.__name = (fn) => fn');
    // La flota sintética no trae procedencia verificada y la pref de fábrica
    // (`origin: 'orca'`) la esconde entera: sin esto no hay tripulación viva
    // con la que comparar, y la fila IN PROGRESS no existiría.
    await page.addInitScript(`try { localStorage.setItem('orca.prefs.v1', JSON.stringify({ origin: 'all' })); } catch {}`);
    // El hub exige token también en localhost; sin él la consola se queda en
    // HANDSHAKE con el mundo vacío y sin un solo error.
    await page.goto(`http://127.0.0.1:${uiPort()}/?noboot=1&k=${encodeURIComponent(orcaToken())}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window.__orca?.agentIds().length ?? 0) > 2, null, { timeout: 60_000 });
    await fontsReady(page);
    await page.waitForTimeout(1200);

    /* ── Tres misiones: parada, viva, y esperando al operador ─────── */

    await page.evaluate(() => {
      const o = window.__orca!;
      const now = Date.now();
      const HOUR = 3_600_000;
      let n = 0;
      const msg = (role: string, text: string, at: number) => ({ id: `msg_stall_${n++}`, role, text, at });
      /*
       * El agente al que se le mandó ya no está en la flota, que es el caso
       * real —máquina desconectada— y además el único estable: la flota
       * sintética se mueve mientras el obturador está abierto, así que un
       * agente prestado de `agentIds()` puede estar `working` para cuando se
       * hace la aserción, y entonces la misión no está parada de verdad.
       */
      const gone = 'sess_stall_gone';
      const missions: CapcomMission[] = [
        {
          id: 'mission_shot_stalled', title: 'Rehacer los iconos de CAPCOM', status: 'active',
          createdAt: now - 3 * HOUR, updatedAt: now - HOUR, agentIds: [gone], squads: [],
          messages: [
            msg('human', 'Rehaz los iconos de CAPCOM', now - 3 * HOUR),
            msg('capcom', 'Mandado a WO', now - 2 * HOUR),
            msg('system', 'Send to WO failed: máquina no conectada: mac-2', now - HOUR),
          ],
          dispatches: { [gone]: { agentId: gone, callsign: 'WO', at: now - HOUR, delivered: false, detail: 'máquina no conectada: mac-2' } },
        } as unknown as CapcomMission,
        {
          id: 'mission_shot_live', title: 'Fix the login flow on Safari', status: 'active',
          createdAt: now - HOUR, updatedAt: now - 60_000, agentIds: o.agentIds().slice(0, 2), squads: [],
          messages: [msg('human', 'Fix the login flow on Safari', now - HOUR), msg('capcom', 'Launched two, will report back', now - 60_000)],
        } as unknown as CapcomMission,
        {
          id: 'mission_shot_wait', title: 'Ship the checkout rewrite behind a flag', status: 'active',
          createdAt: now - 40 * 60_000, updatedAt: now - 20 * 60_000, agentIds: [], squads: [],
          messages: [msg('human', 'Ship the checkout rewrite behind a flag', now - 40 * 60_000), msg('capcom', 'Staging or production first?', now - 20 * 60_000)],
        } as unknown as CapcomMission,
      ];
      for (const m of missions) o.mission(m);
    });
    // La onda de alineación dura ALGN_HOLD + ALGN_SEAT para la primera fila:
    // fotografiar antes es fotografiar la escalera de la onda.
    await page.waitForTimeout(2600);

    /* ── Lo que dice la fila ──────────────────────────────────────── */

    const rows = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.missions__row')].map((r, i) => ({
      at: i,
      mission: r.dataset['mission'] ?? '?',
      phase: (r.querySelector('[data-phase]') as HTMLElement | null)?.innerText.trim() ?? '',
      colour: getComputedStyle(r.querySelector('.missions__title') as HTMLElement).color,
      // El zip es el estado: `scaleX` 1 asentado, 0 vacío.
      zip: Math.round(new DOMMatrix(getComputedStyle(r.querySelector('[data-zip]') as HTMLElement).transform).a),
      done: r.classList.contains('is-done'),
      stalled: r.classList.contains('is-stalled'),
    })));
    const mine = rows.filter((r) => r.mission.startsWith('mission_shot_'));
    const by = (id: string) => mine.find((r) => r.mission === id)!;
    console.log('[mission-stall]', JSON.stringify(mine, null, 1));

    const stalled = by('mission_shot_stalled');
    const live = by('mission_shot_live');
    const wait = by('mission_shot_wait');

    assert.equal(stalled.phase, 'NOT MOVING', 'una misión parada lo dice');
    assert.equal(live.phase, 'IN PROGRESS', 'y una con tripulación viva sigue diciendo lo suyo');
    assert.equal(stalled.colour, AMBER, 'en el ámbar de «esto necesita a una persona»');
    assert.equal(wait.colour, AMBER, 'el mismo que WAITING ON YOU, que es el mismo hecho');
    assert.equal(live.colour, LIME, 'y no en el lima de vivo');
    assert.equal(stalled.zip, 0, 'con la cremallera vacía: una misión parada no está asentada');
    assert.equal(live.zip, 1, 'la que avanza sí');
    assert.ok(stalled.stalled && !stalled.done, 'sigue abierta: no se pliega con las terminadas');
    // El orden del panel: primero las abiertas, y entre ellas la que tiene
    // tripulación viva por delante. Una misión parada no salta al final por
    // estar parada, ni se cuela por delante de la que trabaja.
    assert.ok(live.at < stalled.at, 'la que trabaja va por delante de la parada');
    assert.ok(mine.every((r) => !r.done), 'las tres siguen en el grupo de abiertas');

    /* ── La foto, antes de tocar nada ─────────────────────────────── */

    // Antes de abrir la ventana a propósito: una fila abierta lleva el marco
    // de `is-current`, y la foto es del panel en reposo, no de una selección.
    await mkdir(SHOTS, { recursive: true });
    await page.locator('.missions').screenshot({ path: join(SHOTS, 'mission-stall-panel.png') });
    await page.screenshot({ path: join(SHOTS, 'mission-stall-console.png') });

    /* ── Y la ventana dice lo mismo que el panel ──────────────────── */

    await page.locator('[data-mission="mission_shot_stalled"]').click();
    await page.waitForTimeout(900);
    const win = await page.evaluate(() => {
      const el = document.querySelector('.mission-win__phase') as HTMLElement | null;
      return el ? { word: el.innerText.trim(), colour: getComputedStyle(el).color } : null;
    });
    assert.deepEqual(win, { word: 'NOT MOVING', colour: AMBER },
      'la ventana no puede decir IN PROGRESS sobre lo que el panel llama parado');

    assert.deepEqual(errors, [], 'sin errores en consola');
    console.log(`[mission-stall] ok · ${join(SHOTS, 'mission-stall-panel.png')}`);
  } finally {
    await browser.close();
    await shutdown();
  }
}

await main();
