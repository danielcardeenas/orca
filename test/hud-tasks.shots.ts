/**
 * The HUD task panel, photographed against the running console.
 *
 *   npx tsx test/hud-tasks.shots.ts            reuses the hub and vite that are up
 *   npx tsx test/hud-tasks.shots.ts --headed   watch it happen
 *
 * Not named `*.visual.ts`: `visual.ts` runs its own suite whenever the entry
 * file's name ends that way, and importing its helpers would fire the whole
 * boot shoot alongside this one.
 *
 * The panel's whole job is to read a fleet at a glance, so a frame with one
 * task in one state proves nothing. This puts a task in every phase in front
 * of it — waiting on you, in progress with real callsigns, queued, completed,
 * failed, and enough finished ones to fold — then checks what the rows
 * actually say, that the panel clears the clock instead of covering it, that
 * the head folds into prefs, and that a row opens its conversation.
 *
 * The tasks are pushed into the console's own store through the `__orca` test
 * hook rather than into the hub: a photograph of nine states must not leave
 * nine conversations in the operator's real task file.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { CapcomTask } from '../src/shared/tasks.ts';
import { GPU_ARGS, ROOT, SHOTS, ensureServers, fontsReady, shutdown, uiPort } from './visual.ts';

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
    await page.goto(`http://127.0.0.1:${uiPort()}/?noboot=1`, { waitUntil: 'domcontentloaded' });
    // A panel with no agents cannot show a crew; wait for a fleet, then for paint.
    await page.waitForFunction(() => (window.__orca?.agentIds().length ?? 0) > 2, null, { timeout: 60_000 });
    await fontsReady(page);
    await page.waitForTimeout(1200);

    const crew = await page.evaluate(() => {
      const o = window.__orca!;
      const ids = o.agentIds();
      const now = Date.now();
      let n = 0;
      const msg = (role: string, text: string, at: number) => ({ id: `msg_shot_${n++}`, role, text, at });
      const task = (id: string, title: string, status: string, agentIds: string[], messages: unknown[], updatedAt: number) =>
        ({ id, title, status, createdAt: updatedAt - 600_000, updatedAt, agentIds, messages }) as unknown as CapcomTask;
      const two = ids.slice(0, 2);
      const one = ids.slice(2, 3).length ? ids.slice(2, 3) : ids.slice(0, 1);
      for (const t of [
        task('task_shot_wait', 'Ship the checkout rewrite behind a flag', 'active', [],
          [msg('human', 'Ship the checkout rewrite behind a flag', now - 400_000), msg('capcom', 'Staging or production first?', now - 120_000)], now - 120_000),
        task('task_shot_prog', 'Fix the login flow on Safari', 'active', two,
          [msg('human', 'Fix the login flow on Safari', now - 900_000), msg('capcom', 'Launched two, will report back', now - 300_000)], now - 300_000),
        task('task_shot_prog2', 'Audit retention limits in the hub', 'active', one,
          [msg('human', 'Audit retention limits in the hub', now - 1_500_000)], now - 45_000),
        task('task_shot_queue', 'Write the storage retention doc', 'active', [],
          [msg('human', 'Write the storage retention doc', now - 30_000)], now - 30_000),
        task('task_shot_done1', 'Clock in the HUD', 'completed', [], [msg('capcom', 'Done and verified', now - 2_000_000)], now - 2_000_000),
        task('task_shot_fail', 'Land the k9 branch', 'failed', [], [msg('capcom', 'Tests red, not landing', now - 5_000_000)], now - 5_000_000),
        task('task_shot_done2', 'Rename /api routes', 'completed', [], [], now - 9_000_000),
        task('task_shot_done3', 'Drop the 3D scene', 'completed', [], [], now - 40_000_000),
        task('task_shot_done4', 'PWA install for the console', 'completed', [], [], now - 90_000_000),
      ]) o.task(t);
      return { two, one };
    });
    // The rows line up on arrival; let the staircase finish before the shutter.
    await page.waitForTimeout(2600);

    /* ── What the panel says ──────────────────────────────────────── */

    const phases = await page.locator('.tasks__row').evaluateAll((els) => els.map((e) => ({
      task: (e as HTMLElement).dataset.task ?? '',
      phase: e.querySelector('[data-phase]')?.textContent ?? '',
      crew: [...e.querySelectorAll('.tasks__cs')].map((b) => b.textContent),
      done: e.classList.contains('is-done'),
    })));
    // The hub this console is talking to has tasks of its own; only ours are
    // predictable, and the order among ours is what the panel is being asked.
    const mine = phases.filter((p) => p.task.startsWith('task_shot_'));
    const open = mine.filter((p) => !p.done), finished = mine.filter((p) => p.done);
    assert.equal(open.length, 4, 'every open task shows');
    assert.deepEqual(new Set(open.map((p) => p.phase)), new Set(['QUEUED', 'IN PROGRESS', 'WAITING ON YOU']));
    // A task whose agents are running moved when they last moved, so a live
    // crew carries it above a queued task nobody has touched in a while.
    assert.ok(open.findIndex((p) => p.phase === 'IN PROGRESS') < open.findIndex((p) => p.phase === 'WAITING ON YOU'),
      'a task with live agents outranks one that has been waiting longer');
    assert.deepEqual(finished.map((p) => `${p.task}=${p.phase}`),
      ['task_shot_done1=COMPLETED', 'task_shot_fail=FAILED', 'task_shot_done2=COMPLETED'],
      'the three newest finished stay, newest first');
    const lastOpen = phases.reduce((at, p, i) => (p.done ? at : i), -1);
    const firstDone = phases.findIndex((p) => p.done);
    assert.ok(firstDone > lastOpen, 'open rows all come before finished ones');
    assert.equal(phases.find((p) => p.task === 'task_shot_prog')!.crew.length, crew.two.length, 'both live agents are named');
    assert.equal(phases.find((p) => p.task === 'task_shot_wait')!.crew.length, 0, 'a task nobody is on names nobody');
    assert.match((await page.locator('.tasks__more').textContent()) ?? '', /…AND \d+ MORE/);
    assert.equal(await page.locator('[data-n]').textContent(), String(phases.filter((p) => !p.done).length),
      'the head counts the open tasks');

    /* ── It clears the clock instead of covering it ───────────────── */

    const geo = await page.evaluate(() => {
      const box = (s: string) => document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null;
      return { tasks: box('.tasks'), clock: box('.mast__clock'), mast: box('.mast') };
    }) as { tasks: DOMRect; clock: DOMRect; mast: DOMRect };
    assert.ok(geo.clock, 'the mast clock is there to clear');
    assert.ok(geo.tasks.top >= geo.clock.bottom, `panel top ${geo.tasks.top} must be below the clock's ${geo.clock.bottom}`);
    assert.ok(geo.tasks.top >= geo.mast.bottom, 'the panel starts below the mast');
    assert.ok(geo.tasks.right <= 1440, 'the panel is on screen');

    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, 'hud-tasks.png') });
    const box = (await page.locator('.tasks').boundingBox())!;
    await page.screenshot({
      path: join(SHOTS, 'hud-tasks-panel.png'),
      clip: { x: Math.max(0, box.x - 14), y: Math.max(0, box.y - 74), width: box.width + 28, height: box.height + 88 },
    });

    /* ── The head folds, and the fold is remembered ───────────────── */

    await page.locator('.tasks__head').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.tasks__list').isVisible(), false);
    assert.match((await page.evaluate(() => localStorage.getItem('orca.prefs.v1'))) ?? '', /"tasksFolded":true/);
    await page.screenshot({ path: join(SHOTS, 'hud-tasks-folded.png'), clip: { x: 980, y: 0, width: 460, height: 240 } });
    await page.locator('.tasks__head').click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.tasks__list').isVisible(), true);

    /* ── A row opens its conversation; a callsign flies the camera ── */

    await page.locator('.tasks__row[data-task="task_shot_prog"] .tasks__title').click();
    await page.waitForTimeout(900);
    assert.equal(await page.evaluate(() => localStorage.getItem('orca.capcom.task')), 'task_shot_prog');
    assert.equal(await page.locator('.win.is-ceo').count(), 1, 'the CAPCOM window opened on that task');
    assert.match(await page.locator('.win.is-ceo').innerText(), /Fix the login flow on Safari/i);
    assert.equal(await page.locator('.tasks__row[data-task="task_shot_prog"].is-current').count(), 1);
    await page.screenshot({ path: join(SHOTS, 'hud-tasks-open.png') });

    // A window outranks the HUD, so the CAPCOM window that just opened is over
    // the panel — as intended. Close it before asking the panel for a click.
    // Twice: the first Escape leaves the composer, the second closes the window.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.win.is-ceo').count(), 0);

    // The callsign is a button of its own: it flies, it does not open the task.
    const before = await page.evaluate(() => JSON.stringify(window.__orca!.view()));
    await page.locator('.tasks__row[data-task="task_shot_prog"] .tasks__cs').first().click();
    // The flight eases in; wait for the view to actually differ rather than
    // for a number of milliseconds that happens to be long enough today.
    await page.waitForFunction((was) => JSON.stringify(window.__orca!.view()) !== was, before, { timeout: 8000 });

    assert.deepEqual(errors, []);
    console.log(`HUD tasks: five phases, order, fold, row open and callsign flight passed.\n${join(SHOTS, 'hud-tasks.png')}`);
  } finally {
    await browser.close();
    if (!keep) shutdown();
  }
}

void ROOT;
await main();
