/**
 * La pestaña CREW de una misión, fotografiada contra la consola de verdad.
 *
 *   npx tsx test/mission-crew.shots.ts            reutiliza el hub y el vite que estén arriba
 *   npx tsx test/mission-crew.shots.ts --headed   verlo pasar
 *
 * No se llama `*.visual.ts` a propósito: `visual.ts` dispara su propia sesión
 * entera cuando el fichero de entrada acaba así, y aquí sólo hace falta una
 * ventana.
 *
 * Lo que comprueba es lo que la nómina promete y una lista plana no daba: que
 * la jerarquía se vea —isla, squad, líder arriba—, que quien ya terminó siga
 * en ella en vez de desaparecer, y que MUSTER lleve la misión al campo de
 * verdad (la cámara se mueve) en vez de dibujar un campo de mentira dentro de
 * la ventana.
 *
 * El escuadrón sale de `injectSquad()`, que es el mismo que retrata el campo:
 * seis agentes bajo una etiqueta, con líder, con runtimes distintos y con uno
 * ya terminado. La misión se mete en el store del navegador con `__orca`, no
 * en el hub: una foto no puede dejar una conversación en el disco del operador.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { CapcomMission } from '../src/shared/missions.ts';
import { GPU_ARGS, SHOTS, ensureServers, fontsReady, injectSquad, orcaToken, shutdown, uiPort } from './visual.ts';

const headed = process.argv.includes('--headed');
const keep = process.argv.includes('--keep');
const SQUAD_IDS = ['z1', 'z2', 'z3', 'z4', 'z5', 'z6'].map((c) => `sess_vsquad_${c}`);

async function main() {
  await ensureServers();
  const squad = await injectSquad();
  if (!squad) throw new Error('no se pudo levantar el escuadrón contra el hub');
  const browser = await chromium.launch({ headless: !headed, args: GPU_ARGS });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.addInitScript('window.__name = (fn) => fn');
    // La flota sintética no lleva procedencia verificada y la consola sólo
    // enseña las de ORCA por defecto: sin esto la nómina sale vacía.
    await page.addInitScript(`try { localStorage.setItem('orca.prefs.v1', JSON.stringify({ origin: 'all' })); } catch {}`);
    await page.goto(`http://127.0.0.1:${uiPort()}/?noboot=1&k=${encodeURIComponent(orcaToken())}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((ids) => ids.every((id) => (window.__orca?.callsignOf?.(id) ?? null) !== null),
      SQUAD_IDS, { timeout: 60_000 });
    await fontsReady(page);
    await page.waitForTimeout(1200);

    /* ── Una misión con dos islas: el escuadrón y alguien de fuera ── */

    const crew = await page.evaluate((squadIds) => {
      const o = window.__orca!;
      const outsider = o.agentIds().find((id) => !squadIds.includes(id)) ?? null;
      const now = Date.now();
      const agentIds = [...squadIds, ...(outsider ? [outsider] : [])];
      o.mission({
        id: 'mission_crew_shot', title: 'Close the March ledger', status: 'active',
        createdAt: now - 900_000, updatedAt: now - 60_000, agentIds, squads: ['ledger-close'],
        messages: [
          { id: 'msg_crew_0', role: 'human', text: 'Close the March ledger and tell me what does not balance.', at: now - 900_000 },
          { id: 'msg_crew_1', role: 'capcom', text: 'Launched the ledger-close squad; Z1 leads.', at: now - 600_000 },
        ],
      } as unknown as CapcomMission);
      return { outsider, agentIds };
    }, SQUAD_IDS);
    assert.ok(crew.outsider, 'hace falta un agente fuera del escuadrón para que haya dos islas');
    await page.waitForTimeout(600);

    /* ── La ventana, por la puerta del panel ──────────────────────── */

    await page.locator('.missions__row[data-mission="mission_crew_shot"] [data-open]').click();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.win.is-mission').count(), 1, 'la misión abrió en su ventana');
    const win = page.locator('.win.is-mission');
    await win.locator('.tab[data-tab="crew"]').click();
    await page.waitForTimeout(400);
    assert.equal(await win.locator('.tab.is-on').innerText(), 'CREW');

    /* ── Lo que la nómina dice ────────────────────────────────────── */

    const read = await win.evaluate((el) => {
      const txt = (e: Element | null) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return {
        count: txt(el.querySelector('.mission-win__count')),
        tot: txt(el.querySelector('.mission-win__tot')),
        regions: [...el.querySelectorAll('.mission-win__reg')].map((r) => ({
          project: txt(r.querySelector('.mission-win__proj')),
          squads: [...r.querySelectorAll('.mission-win__sq')].map((s) => txt(s.querySelector('.mission-win__sqh'))),
          rows: [...r.querySelectorAll('.mission-win__crew')].map((c) => ({
            cs: txt(c.querySelector('.mission-win__cs')),
            word: txt(c.querySelector('.mission-win__st')),
            runtime: txt(c.querySelector('.mission-win__rt')),
          })),
        })),
        muster: !(el.querySelector('[data-muster]') as HTMLButtonElement | null)?.disabled,
        sigils: el.querySelectorAll('.mission-win__crew .sigil').length,
        inverted: el.querySelectorAll('.mission-win__crew .sigil.is-inv').length,
        // Un glifo que existe en el marcado y no dibuja nada es el fallo que
        // tuvo este sigilo durante meses: se comprueba que pinta, no que está.
        painted: [...el.querySelectorAll('.sigil')]
          .filter((g) => getComputedStyle(g as HTMLElement).backgroundImage.includes('gradient')).length,
      };
    });

    const ledger = read.regions.find((r) => r.project === 'LEDGER');
    assert.ok(ledger, `la isla del escuadrón está rotulada con su proyecto (${read.regions.map((r) => r.project).join(', ')})`);
    assert.ok(read.regions.length >= 2, 'una misión repartida entre dos proyectos se lee como dos islas');
    assert.match(ledger.squads[0] ?? '', /LEDGER-CLOSE · 6 · LED BY Z1/,
      `la cabecera del squad dice cuántos son y quién manda (${ledger.squads[0]})`);
    assert.equal(ledger.rows[0]?.cs, 'Z1', 'el líder va arriba de su squad');
    assert.deepEqual(ledger.rows.map((r) => r.cs), ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6'],
      'los seis están, en orden de asignación detrás del líder');
    // Quien ya terminó no se cae de la nómina: eso es lo que la lista de
    // tripulación viva del panel no puede contestar.
    assert.ok(ledger.rows.some((r) => r.word === 'DONE'), `un agente terminado sigue en la nómina (${ledger.rows.map((r) => r.word).join(', ')})`);
    assert.ok(ledger.rows.some((r) => r.word === 'BLOCKED'), 'y el bloqueado se lee como bloqueado');
    assert.deepEqual([...new Set(ledger.rows.map((r) => r.runtime))].sort(), ['CLAUDE', 'CODEX', 'GROK'],
      'cada fila dice con qué CLI corre, como la textura de su baldosa');
    assert.match(read.count, /^\d+ LIVE · \d+ FLEW$/, `la cabecera cuenta vivos y totales (${read.count})`);
    assert.match(read.tot, /PROJECTS · 1 SQUAD/, `y la nómina resume islas y squads (${read.tot})`);
    assert.equal(read.inverted, 1, 'un solo sigilo invertido: el del líder, como en el campo');
    assert.ok(read.sigils >= 7, 'cada fila lleva el glifo de su baldosa');
    assert.equal(read.painted, read.sigils + 1, 'y cada glifo —las filas y el del squad— pinta de verdad, no sólo ocupa sitio');
    assert.ok(read.muster, 'con gente en el campo, MUSTER se puede pulsar');

    await mkdir(SHOTS, { recursive: true });
    const box = (await win.boundingBox())!;
    await page.screenshot({
      path: join(SHOTS, 'mission-crew.png'),
      clip: { x: Math.max(0, box.x - 10), y: Math.max(0, box.y - 10), width: box.width + 20, height: box.height + 20 },
    });

    // Y el bloque de cerca: el glifo de cada fila es del tamaño de la letra,
    // y a ese tamaño o se lee o no está.
    const rows = (await win.locator('.mission-win__reg').first().boundingBox())!;
    await page.screenshot({
      path: join(SHOTS, 'mission-crew-rows.png'),
      clip: { x: rows.x, y: rows.y, width: rows.width, height: Math.min(rows.height, 260) },
    });

    /* ── MUSTER: el campo, no un campo de juguete dentro ──────────── */

    const before = await page.evaluate(() => window.__orca!.view());
    await win.locator('[data-muster]').click();
    await page.waitForTimeout(1400);
    const after = await page.evaluate(() => window.__orca!.view());
    const moved = Math.abs(before.minX - after.minX) + Math.abs(before.maxX - after.maxX)
      + Math.abs(before.minY - after.minY) + Math.abs(before.maxY - after.maxY);
    assert.ok(moved > 0.5, `MUSTER encuadra la tripulación en el campo (${JSON.stringify({ before, after })})`);
    await page.screenshot({ path: join(SHOTS, 'mission-crew-muster.png') });

    assert.deepEqual(errors, [], `sin errores en consola (${errors.join(' · ')})`);
    console.log('[shots] mission-crew.png · mission-crew-rows.png · mission-crew-muster.png');
  } finally {
    squad.close();
    if (!keep) await browser.close();
  }
  if (!keep) await shutdown();
}

main().catch((err) => { console.error(err); process.exit(1); });
