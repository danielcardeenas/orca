/**
 * The HUD mission panel, photographed against the running console.
 *
 *   npx tsx test/hud-missions.shots.ts            reuses the hub and vite that are up
 *   npx tsx test/hud-missions.shots.ts --headed   watch it happen
 *
 * Not named `*.visual.ts`: `visual.ts` runs its own suite whenever the entry
 * file's name ends that way, and importing its helpers would fire the whole
 * boot shoot alongside this one.
 *
 * The panel's whole job is to read a fleet at a glance, so a frame with one
 * mission in one state proves nothing. This puts a mission in every phase in
 * front of it — waiting on you, in progress with real callsigns, queued,
 * completed, failed, and a handful more finished ones — then checks what the
 * rows actually say, that the panel clears the clock instead of covering it,
 * that the head is the only fold there is —se recuerda en prefs, recoge la
 * lista al plegar y devuelve las filas en el compás del comp— and that a row
 * opens its conversation.
 *
 * The missions are pushed into the console's own store through the `__orca` test
 * hook rather than into the hub: a photograph of nine states must not leave
 * nine conversations in the operator's real mission file.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { CapcomMission } from '../src/shared/missions.ts';
import { GPU_ARGS, SHOTS, ensureServers, fontsReady, orcaToken, shutdown, uiPort } from './visual.ts';

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

    // tsx compiles this file with esbuild's keepNames; the `__name` helper it
    // injects into a serialised closure does not exist in the page.
    await page.addInitScript('window.__name = (fn) => fn');
    // La flota sintética no lleva procedencia verificada, y la consola sólo
    // enseña las de ORCA por defecto (`prefs.origin`): sin esto el panel se
    // fotografía contra un campo vacío y ninguna fila tiene tripulación.
    await page.addInitScript(`try { localStorage.setItem('orca.prefs.v1', JSON.stringify({ origin: 'all' })); } catch {}`);
    // Con el token: el hub lo exige también en localhost, y sin él la consola
    // se queda en HANDSHAKE con el mundo vacío y sin un solo error (visual.ts).
    await page.goto(`http://127.0.0.1:${uiPort()}/?noboot=1&k=${encodeURIComponent(orcaToken())}`, { waitUntil: 'domcontentloaded' });
    // A panel with no agents cannot show a crew; wait for a fleet, then for paint.
    try {
      await page.waitForFunction(() => (window.__orca?.agentIds().length ?? 0) > 2, null, { timeout: 60_000 });
    } catch (err) {
      console.error('[shots] no fleet:', { errors, diag: await page.evaluate(() => ({ hook: !!window.__orca, stats: window.__orca?.stats(), agents: window.__orca?.agentIds().length, handshake: !!document.querySelector('.hs, .handshake'), body: document.body.innerText.slice(0, 300) })) });
      throw err;
    }
    await fontsReady(page);
    await page.waitForTimeout(1200);

    /* ── Nueve misiones, una por estado ───────────────────────────── */

    const crew = await page.evaluate(async () => {
      const o = window.__orca!;
      const ids = o.agentIds();
      const now = Date.now();
      let n = 0;
      const msg = (role: string, text: string, at: number) => ({ id: `msg_shot_${n++}`, role, text, at });
      const mission = (id: string, title: string, status: string, agentIds: string[], messages: unknown[], updatedAt: number) =>
        ({ id, title, status, createdAt: updatedAt - 600_000, updatedAt, agentIds, messages, squads: [] }) as unknown as CapcomMission;
      const two = ids.slice(0, 2);
      const one = ids.slice(2, 3).length ? ids.slice(2, 3) : ids.slice(0, 1);
      for (const t of [
        // WAITING ON YOU: lo último lo dijo CAPCOM y nadie está encima.
        mission('mission_shot_wait', 'Ship the checkout rewrite behind a flag', 'active', [],
          [msg('human', 'Ship the checkout rewrite behind a flag. Keep the old path behind ORCA_CHECKOUT_V1 so we can turn it back on from the console, and do not touch the refund flow in this pass.', now - 400_000),
            msg('capcom', 'Staging or production first?', now - 120_000)], now - 120_000),
        // IN PROGRESS: hay tripulación viva, con callsigns de verdad.
        mission('mission_shot_prog', 'Fix the login flow on Safari', 'active', two,
          [msg('human', 'Fix the login flow on Safari', now - 900_000), msg('capcom', 'Launched two, will report back', now - 300_000)], now - 300_000),
        mission('mission_shot_prog2', 'Audit retention limits in the hub', 'active', one,
          [msg('human', 'Audit retention limits in the hub', now - 1_500_000)], now - 45_000),
        // QUEUED: lo último lo dijo el humano y todavía no hay nadie en ello.
        mission('mission_shot_queued', 'Write the storage retention note', 'active', [],
          [msg('human', 'Write the storage retention note', now - 36_000)], now - 36_000),
        mission('mission_shot_done1', 'Clock in the HUD', 'completed', [], [msg('capcom', 'Done and verified', now - 2_000_000)], now - 2_000_000),
        mission('mission_shot_fail', 'Land the k9 branch', 'failed', [], [msg('capcom', 'Tests red, not landing', now - 5_000_000)], now - 5_000_000),
        mission('mission_shot_done2', 'Rename /api routes', 'completed', [], [], now - 9_000_000),
        mission('mission_shot_done3', 'Drop the 3D scene', 'completed', [], [], now - 11_000_000),
        mission('mission_shot_done4', 'PWA install for the console', 'completed', [], [], now - 14_000_000),
      ]) o.mission(t);
      return { two, one };
    });
    // La onda de alineación dura ALGN_HOLD + ALGN_SEAT para la primera fila:
    // fotografiarla antes sería fotografiar la escalera de la onda.
    await page.waitForTimeout(2600);

    /* ── Lo que dicen las filas ───────────────────────────────────── */

    const phases = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.missions__row')].map((r) => ({
      mission: r.dataset['mission'] ?? '?',
      phase: (r.querySelector('[data-phase]') as HTMLElement).innerText.trim(),
      done: r.classList.contains('is-done'),
      crew: Number((r.querySelector('[data-crewn]') as HTMLElement)?.textContent ?? '0'),
      lines: Math.round(r.getBoundingClientRect().height),
    })));

    // The hub this console is talking to has missions of its own; only ours are
    // predictable, and the order among ours is what the panel is being asked.
    const mine = phases.filter((p) => p.mission.startsWith('mission_shot_'));
    const open = mine.filter((p) => !p.done), finished = mine.filter((p) => p.done);
    assert.equal(open.length, 4, 'every open mission shows');
    assert.deepEqual(new Set(open.map((p) => p.phase)), new Set(['QUEUED', 'IN PROGRESS', 'WAITING ON YOU']));
    // A mission whose agents are running moved when they last moved, so a live
    // crew carries it above a queued mission nobody has touched in a while.
    assert.ok(open.findIndex((p) => p.phase === 'IN PROGRESS') < open.findIndex((p) => p.phase === 'WAITING ON YOU'),
      'a mission with live agents outranks one that has been waiting longer');
    // Nada se pliega solo: las cinco terminadas se ven, en orden de movimiento.
    // (El hub de este arnés comparte ORCA_HOME con el operador, así que puede
    // haber más terminadas que las nuestras entre medias; el orden se comprueba
    // sobre las nuestras.)
    const order = ['mission_shot_done1', 'mission_shot_fail', 'mission_shot_done2', 'mission_shot_done3', 'mission_shot_done4'];
    const mineFinished = finished.map((p) => p.mission);
    assert.deepEqual(mineFinished, order,
      `every finished mission shows, newest first (${mineFinished.join(', ')})`);
    assert.deepEqual(finished.filter((p) => p.mission === 'mission_shot_fail').map((p) => p.phase),
      finished.some((p) => p.mission === 'mission_shot_fail') ? ['FAILED'] : [],
      'a failed mission says so');
    const lastOpen = phases.reduce((at, p, i) => (p.done ? at : i), -1);
    const firstDone = phases.findIndex((p) => p.done);
    assert.ok(firstDone > lastOpen, 'open rows all come before finished ones');
    // The synthetic fleet moves while the shutter is open: an agent assigned a
    // second ago can be `done` by now. What the row must not do is invent one.
    const progCrew = phases.find((p) => p.mission === 'mission_shot_prog')!.crew;
    assert.ok(progCrew >= 1 && progCrew <= crew.two.length, `the crew is counted (${progCrew} of ${crew.two.length})`);
    assert.equal(phases.find((p) => p.mission === 'mission_shot_wait')!.crew, 0, 'a mission nobody is on counts nobody');
    // Un solo pliegue, el del título: el pie no lleva botón que esconda trabajo.
    assert.equal(await page.locator('.missions__more').count(), 0,
      'no hay segundo plegado al pie: el título es el único');
    assert.equal(await page.locator('.missions [data-n]').textContent(), String(phases.filter((p) => !p.done).length),
      'the head counts the open missions');

    // A collapsed row is ONE line. A crew of six used to wrap it into a
    // paragraph, which is the whole reason the detail exists.
    const tallest = Math.max(...mine.map((p) => p.lines));
    assert.ok(tallest <= 30, `every collapsed row is one line (tallest ${tallest}px)`);
    assert.equal(await page.locator('.missions__row .missions__detail:visible').count(), 0,
      'nothing is expanded until it is asked for');

    /* ── Una fila que cambia de fase nada más llegar se asienta ───── */

    // El paso de `algnRowPulse` mataba todos los tweens de la fila, la entrada
    // incluida: una misión que llegaba y cambiaba de fase mientras se alineaba
    // se quedaba para siempre a media opacidad y estrecha — un blanco del alto
    // de una fila con su fantasma dentro. Esto lo reproduce.
    const seat = await page.evaluate(async () => {
      const o = window.__orca!;
      const now = Date.now();
      const m = (msgs: unknown[]) => ({
        id: 'mission_shot_pulse', title: 'Rebuild the seat', status: 'active',
        createdAt: now, updatedAt: now, agentIds: [], messages: msgs, squads: [],
      }) as unknown as CapcomMission;
      o.mission(m([{ id: 'msg_seat_0', role: 'human', text: 'Rebuild the seat', at: now }]));
      await new Promise((r) => setTimeout(r, 80));
      o.mission(m([
        { id: 'msg_seat_0', role: 'human', text: 'Rebuild the seat', at: now },
        { id: 'msg_seat_1', role: 'capcom', text: 'Which one?', at: now + 1 },
      ]));
      // La alineación del comp dura ALGN_HOLD + ALGN_SEAT para la primera fila.
      await new Promise((r) => setTimeout(r, 2200));
      const row = document.querySelector('[data-mission="mission_shot_pulse"]') as HTMLElement;
      const cs = getComputedStyle(row);
      const seen = {
        opacity: Number(cs.opacity), visibility: cs.visibility,
        y: new DOMMatrix(cs.transform).m42,
        // A ras: los márgenes son lo que la alineación mueve.
        inset: `${cs.marginLeft}/${cs.marginRight}`,
      };
      // Archivada en cuanto se ha mirado: las fotos de más abajo son de las
      // nueve misiones del arnés, no de diez.
      o.mission({ ...m([]), archivedAt: Date.now() } as unknown as CapcomMission);
      return seen;
    });
    assert.deepEqual(seat, { opacity: 1, visibility: 'visible', y: 0, inset: '0px/0px' },
      `a row that changed phase on arrival is seated, not a gap with a ghost in it (${JSON.stringify(seat)})`);

    /* ── Top left, clear of the mast ──────────────────────────────── */

    const geo = await page.evaluate(() => {
      const box = (s: string) => document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null;
      return { missions: box('.missions'), clock: box('.mast__clock'), mast: box('.mast'), marks: box('.bmarks') };
    }) as { missions: DOMRect; clock: DOMRect; mast: DOMRect; marks: DOMRect | null };
    assert.ok(geo.clock, 'the mast clock is there');
    assert.ok(geo.missions.left < 200, `the panel is on the left, not the right (left ${geo.missions.left})`);
    assert.ok(geo.missions.top >= geo.mast.bottom, 'the panel starts below the mast');
    assert.ok(geo.missions.top >= geo.clock.bottom, 'and clears the clock, which is part of the mast');
    if (geo.marks) assert.ok(geo.missions.top >= geo.marks.bottom, 'and clears the bookmarks under the mast');

    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'hud-missions.png') });
    const box = (await page.locator('.missions').boundingBox())!;
    await page.screenshot({
      path: join(SHOTS, 'hud-missions-panel.png'),
      clip: { x: Math.max(0, box.x - 14), y: Math.max(0, box.y - 74), width: box.width + 28, height: box.height + 88 },
    });

    /* ── The detail opens with the keyboard, not only the hand ────── */

    const row = page.locator('.missions__row[data-mission="mission_shot_wait"]');
    await row.locator('[data-peek]').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    assert.equal(await row.locator('[data-peek]').getAttribute('aria-expanded'), 'true');
    assert.equal(await row.locator('.missions__detail').isVisible(), true, 'Enter on the disclosure opens it');
    // The whole title and the whole brief, not a cut and a tooltip.
    assert.equal(await row.locator('.missions__full').innerText(),
      'Ship the checkout rewrite behind a flag');
    // El título entero arriba y el encargo entero debajo: lo que antes sólo
    // estaba en un `title=` que ni el teclado ni un dedo alcanzan.
    assert.match(await row.locator('.missions__brief').innerText(), /ORCA_CHECKOUT_V1/,
      'the whole brief is in the detail, not cut and left to a tooltip');
    await page.screenshot({
      path: join(SHOTS, 'hud-missions-detail.png'),
      clip: { x: Math.max(0, box.x - 14), y: Math.max(0, box.y - 20), width: box.width + 28, height: 420 },
    });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    assert.equal(await row.locator('.missions__detail').isVisible(), false, 'and Enter again closes it');

    // El detalle de una misión con gente encima: los callsigns son botones, y
    // es la única foto en la que se ve a quién se puede volar desde el panel.
    const live = page.locator('.missions__row[data-mission="mission_shot_prog"]');
    await live.locator('[data-peek]').click();
    await page.waitForTimeout(300);
    assert.equal(await live.locator('.missions__detail').isVisible(), true, 'a click opens it too');
    await page.screenshot({
      path: join(SHOTS, 'hud-missions-detail-live.png'),
      clip: { x: Math.max(0, box.x - 14), y: Math.max(0, box.y - 20), width: box.width + 28, height: 420 },
    });
    await live.locator('[data-peek]').click();
    await page.waitForTimeout(250);

    /* ── El título pliega, se recuerda, y devuelve las filas en compás ── */

    // Plegar no es un corte: la lista se recoge hasta la cabecera, y el
    // `display: none` llega al final del gesto, no al principio.
    const shut = await page.evaluate(async () => {
      const list = document.querySelector('.missions__list') as HTMLElement;
      const full = list.getBoundingClientRect().height;
      (document.querySelector('.missions__head') as HTMLElement).click();
      const seen: number[] = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 3000) {
        if (getComputedStyle(list).display === 'none') break;
        seen.push(list.getBoundingClientRect().height);
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { full, mid: seen.filter((h) => h > 1 && h < full - 1).length, gone: getComputedStyle(list).display };
    });
    assert.ok(shut.full > 100, `el panel se fotografía con la lista abierta (${shut.full}px)`);
    assert.ok(shut.mid >= 3, `la lista se recoge en vez de desaparecer de golpe (${shut.mid} alturas intermedias)`);
    assert.equal(shut.gone, 'none', 'y acaba plegada del todo');
    assert.equal(await page.locator('.missions__list').isVisible(), false);
    assert.match((await page.evaluate(() => localStorage.getItem('orca.prefs.v1'))) ?? '', /"missionsFolded":true/);
    await page.screenshot({ path: join(SHOTS, 'hud-missions-folded.png'), clip: { x: 0, y: 0, width: 460, height: 240 } });

    // Y al devolverlo la caja CRECE —eso es lo que empuja a la sección de
    // debajo en vez de saltársela— mientras las filas entran en el compás del
    // comp: ni todas de golpe —que no dice en qué orden están— ni la onda
    // entera, que es la alineación del panel y se juega una vez, así que
    // ninguna fila se vuelve a estrechar. Y la persiana va por delante del
    // compás: una fila ya encendida nunca asoma fuera de la caja.
    const back = await page.evaluate(async () => {
      const list = document.querySelector('.missions__list') as HTMLElement;
      const rows = () => [...document.querySelectorAll<HTMLElement>('.missions__row')];
      (document.querySelector('.missions__head') as HTMLElement).click();
      const insets = new Set<string>();
      const heights: number[] = [];
      let staggered = false;
      let seen: number[] = [];
      let grew = 0;      // cuándo la caja llegó a su alto
      let filled = 0;    // cuándo se encendió la última fila
      const t0 = performance.now();
      while (performance.now() - t0 < 4000) {
        seen = [];
        for (const r of rows()) {
          const cs = getComputedStyle(r);
          seen.push(Number(cs.opacity));
          insets.add(`${cs.marginLeft}/${cs.marginRight}`);
        }
        const h = Math.round(list.getBoundingClientRect().height);
        if (!heights.length || h !== heights[heights.length - 1]) {
          heights.push(h);
          grew = performance.now() - t0;
        }
        if (seen.some((o) => o > 0.9) && seen.some((o) => o < 0.1)) staggered = true;
        if (seen.length && seen.every((o) => o > 0.99)) { filled = performance.now() - t0; break; }
        await new Promise((r) => requestAnimationFrame(r));
      }
      return {
        staggered, insets: [...insets], heights,
        grew: Math.round(grew), filled: Math.round(filled),
        lit: seen.filter((o) => o > 0.99).length, rows: seen.length,
      };
    });
    assert.equal(await page.locator('.missions__list').isVisible(), true);
    assert.ok(back.rows > 1 && back.staggered,
      `las filas vuelven en el compás, no todas de golpe (${back.rows} filas)`);
    assert.deepEqual(back.insets, ['0px/0px'],
      `una fila que vuelve del pliegue no se estrecha otra vez (${back.insets.join(', ')})`);
    assert.ok(back.heights.length >= 3,
      `la caja crece en vez de aparecer a su tamaño (${back.heights.length} alturas)`);
    assert.deepEqual(back.heights, [...back.heights].sort((a, b) => a - b),
      `y crece siempre hacia arriba, sin rebotes (${back.heights.join(' → ')})`);
    assert.ok(Math.max(...back.heights) > 100, `hasta abrirse del todo (${Math.max(...back.heights)}px)`);
    // Y termina antes que el compás: lo que se llena es un hueco que ya existe,
    // no media lista asomando de una caja a medio abrir.
    assert.ok(back.grew <= back.filled,
      `la caja acaba de abrirse antes que la última fila (caja ${back.grew}ms, filas ${back.filled}ms)`);
    assert.equal(back.lit, back.rows, 'y acaban todas a la vista');

    // La cremallera de una terminada sigue asentada después del pliegue: no
    // barre desde cero otra vez, porque barrer es la onda.
    assert.equal(await page.locator('.missions__row[data-mission="mission_shot_done4"] [data-zip]')
      .evaluate((z) => new DOMMatrix(getComputedStyle(z).transform).a), 1,
      'and its zipper is seated, not sweeping from zero all over again');

    /* ── A row opens the mission's own window ─────────────────────── */

    await page.locator('.missions__row[data-mission="mission_shot_prog"] [data-open]').click();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.win.is-mission').count(), 1, 'the mission opened in a window of its own');
    assert.match(await page.locator('.win.is-mission .win__title').innerText(), /Fix the login flow on Safari/i);
    // Viva o terminada, abre por la misión: qué es, qué se pidió, qué salió.
    assert.equal(await page.locator('.win.is-mission .tab.is-on').innerText(), 'MISSION',
      'a mission opens on the mission itself, not on its conversation');
    assert.match(await page.locator('.win.is-mission .mission-win__sec').first().innerText(), /Fix the login flow on Safari/i,
      'the brief is the first thing on it');
    assert.match(await page.locator('.win.is-mission').innerText(), /Launched two, will report back/i);
    // Sin caja de texto fuera de CONVERSATION: el pie dice a quién iría la
    // línea y ofrece WRITE, que es lo que lleva a la conversación.
    assert.equal(await page.locator('.win.is-mission [data-say]').count(), 0, 'no composer outside the conversation');
    assert.match(await page.locator('.win.is-mission .mission-win__to').innerText(), /TO CAPCOM/);
    await page.locator('.win.is-mission [data-write]').click();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.win.is-mission .tab.is-on').innerText(), 'CONVERSATION', 'WRITE opens the conversation');
    assert.equal(await page.locator('.win.is-mission [data-say]').count(), 1, 'and the composer is there');
    assert.match(await page.locator('.win.is-mission .talk__who').first().innerText(), /YOU → CAPCOM/,
      'a line of yours says who it went to');
    assert.equal(await page.locator('.missions__row[data-mission="mission_shot_prog"].is-current').count(), 1,
      'the panel marks the mission whose window is in front');
    await page.screenshot({ path: join(SHOTS, 'hud-missions-open.png') });

    // The same row again raises the window it already has; it never makes a second.
    await page.locator('.missions__row[data-mission="mission_shot_prog"] [data-open]').click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.win.is-mission').count(), 1, 'opening it again focuses, it does not duplicate');

    // A finished mission opens on its results, in its own window, and says
    // plainly what it does not know instead of showing zeros.
    await page.locator('.missions__row[data-mission="mission_shot_done1"] [data-open]').click();
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('.win.is-mission').count(), 2, 'two missions, two windows, side by side');
    // Por su título y no por ser la última del DOM: una ventana que se abre no
    // siempre se inserta al final —quien manda delante es la z, y el gestor la
    // reordena al enfocar—, así que `.last()` señalaba a veces a la otra.
    const debrief = page.locator('.win.is-mission')
      .filter({ has: page.locator('.win__title', { hasText: 'Clock in the HUD' }) });
    assert.equal(await debrief.count(), 1, 'la ventana de la misión terminada está abierta');
    assert.equal(await debrief.locator('.tab.is-on').innerText(), 'MISSION', 'a finished mission opens on the mission too');
    assert.deepEqual(await debrief.locator('.mission-win__sec h3').allInnerTexts(),
      ['BRIEF', 'RESULT', 'WHAT CHANGED', 'FILES REPORTED', 'MEDIA', 'REPORTS ALONG THE WAY']);
    assert.match(await debrief.locator('.mission-win__result').innerText(), /Done and verified/i);
    // These missions live only in this console's store, so the hub has no
    // journal for them: the section has to say so, not invent a total.
    assert.match(await debrief.locator('.mission-win__sec').nth(2).innerText(), /NO CHANGE RECORD|NO AGENT EVER RAN/i);
    assert.match(await debrief.locator('.mission-win__sec').nth(3).innerText(), /NO FILE PATHS/i);
    // Nada que elegir: una sola línea de salida, y se dice a quién va. Lo que
    // no puede haber nunca es un botón desactivado haciendo de opción.
    assert.match(await debrief.locator('.mission-win__to').innerText(), /TO CAPCOM · NO LEAD/);
    assert.equal(await debrief.locator('.mission-win__talk [data-route]').count(), 0, 'no recipient picker');
    assert.equal(await debrief.locator('.mission-win__talk button:disabled').count(), 0,
      'no disabled button pretending to be a choice');
    await page.screenshot({ path: join(SHOTS, 'hud-missions-results.png') });

    // Closing a mission window archives nothing: the row is still there.
    await debrief.locator('[data-w-close]').first().click({ trial: false }).catch(async () => {
      await page.keyboard.press('Escape');
    });
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.missions__row[data-mission="mission_shot_done1"]').count(), 1,
      'closing the window left the mission where it was');

    // Y la mesa queda limpia: la otra ventana sigue delante, y lo siguiente
    // que se mira es la cinta de CAPCOM, que no se puede pulsar por debajo de
    // una ventana de misión.
    await page.evaluate(() => {
      for (const x of document.querySelectorAll<HTMLElement>('.win.is-mission [data-w-close]')) x.click();
    });
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.win.is-mission').count(), 0,
      'ninguna ventana de misión se queda tapando lo que viene');

    /* ── The other door: CAPCOM's rail ────────────────────────────── */

    await page.evaluate(() => window.__orca!.openKind('ceo'));
    await page.waitForTimeout(600);
    if (await page.locator('.win.is-ceo .rail__c').count()) {
      await page.locator('.win.is-ceo .rail__c').first().click();
      await page.waitForTimeout(700);
      assert.ok(await page.locator('.win.is-mission').count() >= 1, 'CAPCOM\'s rail opens the mission window too');
      await page.screenshot({ path: join(SHOTS, 'hud-missions-from-capcom.png') });
    }
    await page.evaluate(() => {
      for (const x of document.querySelectorAll<HTMLElement>('.win [data-w-close]')) x.click();
    });
    await page.waitForTimeout(400);

    /* ── A callsign in the detail still flies the camera ──────────── */

    // El detalle nombra a la tripulación con botones, y un botón que dice un
    // callsign tiene que llevar hasta él: es la única forma de pasar del panel
    // al campo sin buscar a mano.
    const flyRow = page.locator('.missions__row[data-mission="mission_shot_prog"]');
    await flyRow.locator('[data-peek]').click();
    await page.waitForTimeout(300);
    if (await flyRow.locator('.missions__cs').count()) {
      const before = await page.evaluate(() => window.__orca!.view());
      await flyRow.locator('.missions__cs').first().click();
      await page.waitForTimeout(1400);
      const after = await page.evaluate(() => window.__orca!.view());
      assert.notDeepEqual(after, before, 'a callsign in the detail flies the camera');
    } else {
      console.log('[shots] la tripulación de mission_shot_prog ya había terminado: no hay callsign que volar');
    }

    /* ── El chrome con ratón: dentro, y a tamaño de ratón ─────────── */

    // Este contexto no es táctil, así que aquí el puntero es fino: los
    // controles se quedan en su tamaño de ratón y —como en táctil— dentro de
    // su cabecera. Las medidas de dedo las mide `hud-mobile.shots.ts`.
    await page.evaluate(() => { window.__orca!.openKind('ceo'); window.__orca!.openKind('fleet'); });
    await page.waitForTimeout(1000);
    const chrome = await page.evaluate(() => {
      const out: { kind: string; over: number; under: number; w: number; h: number }[] = [];
      for (const win of document.querySelectorAll<HTMLElement>('.win')) {
        const head = win.querySelector<HTMLElement>('.win__head');
        if (!head) continue;
        for (const b of win.querySelectorAll<HTMLElement>('.win__btn')) {
          // En píxeles de caja y no de pantalla: una ventana vive en el plano
          // del campo y viaja con la cámara —que este arnés acaba de volar—,
          // así que su rect en pantalla habla del zoom y de la inclinación, no
          // del objetivo que el diseño pide ni de dónde cae dentro de su
          // cabecera. `offsetTop` es del mismo padre para los dos.
          out.push({
            kind: win.dataset['kind'] ?? '?',
            over: Math.round(head.offsetTop - b.offsetTop),
            under: Math.round((b.offsetTop + b.offsetHeight) - (head.offsetTop + head.offsetHeight)),
            w: b.offsetWidth, h: b.offsetHeight,
          });
        }
      }
      return out;
    });
    assert.ok(chrome.length > 0, 'there is window chrome to measure');
    for (const b of chrome) {
      assert.ok(b.over <= 0 && b.under <= 0, `${b.kind}: the control stays inside the header (${b.over}, ${b.under})`);
      assert.ok(b.h < 44, `${b.kind}: with a mouse it stays a mouse target (${b.w}x${b.h})`);
    }
    await page.evaluate(() => document.querySelectorAll('.win [data-w-close]').forEach((b) => (b as HTMLElement).click()));
    await page.waitForTimeout(400);

    /* ── Narrow: the panel steps aside, and the door stays ────────── */

    // En 390 px el panel flotante no cabe sobre el campo: se convierte en una
    // hoja que se abre desde la barra de secciones. Lo que no puede pasar es
    // que desaparezca sin puerta — el detalle de las hojas lo mide
    // `hud-mobile.shots.ts`; aquí basta con que la puerta esté y abra.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(700);
    assert.equal(await page.locator('.missions').isVisible(), false,
      'the floating panel steps aside on a narrow screen');
    const door = page.locator('.secbar__b--missions');
    assert.equal(await door.count(), 1, 'and the door to it is in the section bar');
    await door.click();
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.missions').isVisible(), true, 'the door opens the panel as a sheet');
    assert.equal(await page.locator('.missions__row[data-mission="mission_shot_prog"]').count(), 1,
      'with the same rows it had on the canvas');
    await page.screenshot({ path: join(SHOTS, 'hud-missions-narrow.png') });

    console.log('HUD missions: phases, order, one-line rows, keyboard detail, the fold, both doors, results and the narrow view passed.');
    console.log(join(SHOTS, 'hud-missions.png'));
  } finally {
    if (!keep) await browser.close();
  }
}

main()
  .then(() => { if (!keep) { shutdown(); process.exit(0); } })
  .catch((err) => {
    console.error('[shots] failed:', err);
    if (!keep) shutdown();
    process.exit(1);
  });
