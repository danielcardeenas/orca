/**
 * Visual harness.
 *
 * Brings up the hub, a synthetic fleet, and Vite, then drives the real console
 * in a real browser and writes frames to test/shots/. Every state the console
 * can be in gets a PNG, including the boot sequence sampled along its timeline
 * so the beats can be compared against the /system comp side by side.
 *
 *   npx tsx test/visual.ts              everything
 *   npx tsx test/visual.ts boot         just the boot beats
 *   npx tsx test/visual.ts --headed     watch it happen
 *   npx tsx test/visual.ts --keep       leave the servers up afterwards
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { sleep, until } from './harness.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SHOTS = join(ROOT, 'test', 'shots');
const HUB_PORT = 4479;
const UI_PORT = 4478;

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const keep = args.includes('--keep');
const only = args.find((a) => !a.startsWith('--'));

const procs: ChildProcess[] = [];

/** Boot beats worth a frame. These are the moments the comp is judged on. */
const BOOT_BEATS: { at: number; name: string }[] = [
  { at: 700, name: '01-post' },
  { at: 1900, name: '02-wordmark-loadbar' },
  { at: 3200, name: '03-handshake-glyphs' },
  { at: 4100, name: '04-handshake-wipe' },
  { at: 4700, name: '05-check' },
  { at: 5800, name: '06-align-deck' },
  { at: 6900, name: '07-align-tiles-lit' },
  { at: 7700, name: '08-algn-staircase' },
  { at: 8600, name: '09-algn-zipper' },
  { at: 9600, name: '10-radar' },
  { at: 11000, name: '11-fleet-online' },
];

async function main() {
  await rm(SHOTS, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });

  console.log('[visual] starting hub');
  spawnProc('hub', 'npx', ['tsx', 'src/hub/server.ts'], { ORCA_PORT: String(HUB_PORT) });
  if (!await waitForHttp(`http://127.0.0.1:${HUB_PORT}/api/health`, 20_000)) {
    throw new Error('hub never came up');
  }

  console.log('[visual] starting synthetic fleet');
  spawnProc('fleet', 'npx', ['tsx', 'test/fake-collector.ts', `--hub=ws://127.0.0.1:${HUB_PORT}`, '--speed=3']);

  console.log('[visual] starting vite');
  spawnProc('vite', 'npx', ['vite', '--port', String(UI_PORT), '--strictPort']);
  if (!await waitForHttp(`http://127.0.0.1:${UI_PORT}/`, 30_000)) {
    throw new Error('vite never came up');
  }

  // Let the fleet populate before we photograph it.
  await sleep(4000);

  const browser = await chromium.launch({ headless: !headed });
  try {
    if (!only || only === 'boot') await shootBoot(browser);
    if (!only || only === 'console') await shootConsole(browser);
    if (!only || only === 'mobile') await shootMobile(browser);
  } finally {
    await browser.close();
  }

  console.log(`\n[visual] frames in ${SHOTS}`);
  if (keep) {
    console.log('[visual] --keep: servers still up. Ctrl-C to stop.');
    await new Promise(() => { /* hold */ });
  }
}

/* ── Boot beats ───────────────────────────────────────────────────── */

async function shootBoot(browser: Browser) {
  console.log('[visual] boot sequence');
  const page = await newPage(browser, 1600, 1000);
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${UI_PORT}/`, { waitUntil: 'domcontentloaded' });
  // Fonts must be in before the first frame or the pixel grid is wrong.
  await page.evaluate(() => document.fonts.ready);

  for (const beat of BOOT_BEATS) {
    const wait = beat.at - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    await page.screenshot({ path: join(SHOTS, `boot-${beat.name}.png`) });
    console.log(`  ${beat.name}`);
  }
  await page.close();
}

/* ── Console states ───────────────────────────────────────────────── */

async function shootConsole(browser: Browser) {
  console.log('[visual] console');
  const page = await newPage(browser, 1600, 1000);
  await page.goto(`http://127.0.0.1:${UI_PORT}/?noboot=1`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);

  const ready = await until(async () =>
    await page.locator('.atile').count() > 3, 25_000, 300);
  if (!ready) console.warn('  [warn] fleet never populated the deck');
  await sleep(1200);

  await shot(page, 'console-01-deck');

  // Filters
  await page.locator('[data-filter="all"]').click().catch(() => {});
  await sleep(500);
  await shot(page, 'console-02-deck-all');
  await page.locator('[data-filter="blocked"]').click().catch(() => {});
  await sleep(500);
  await shot(page, 'console-03-deck-blocked');
  await page.locator('[data-filter="live"]').click().catch(() => {});
  await sleep(400);

  // A project selected in the rail
  const proj = page.locator('.proj').first();
  if (await proj.count()) {
    await proj.click();
    await sleep(600);
    await shot(page, 'console-04-project-selected');
    await proj.click();
    await sleep(300);
  }

  // Agent drawer
  const tile = page.locator('.atile').first();
  if (await tile.count()) {
    await tile.click();
    await sleep(900);
    await shot(page, 'console-05-agent-drawer');
    await page.keyboard.press('Escape');
    await sleep(500);
  }

  // The 3D fleet view, given a moment to settle its eases
  await page.locator('[data-view="scene"]').click().catch(() => {});
  await sleep(2500);
  await shot(page, 'console-06-fleet-3d');
  await dragScene(page, 220, -60);
  await sleep(1500);
  await shot(page, 'console-07-fleet-3d-orbit');
  await page.mouse.wheel(0, -400);
  await sleep(1200);
  await shot(page, 'console-08-fleet-3d-close');
  await page.locator('[data-view="deck"]').click().catch(() => {});
  await sleep(600);

  // Interrupts: force one so the amber treatment is always captured, even if
  // the synthetic fleet happens to be quiet right now.
  await injectEscalation(page, 'blocking');
  await sleep(900);
  await shot(page, 'console-09-interrupt');

  // And the breach takeover, by backdating the question past its threshold.
  await agePendingEscalations(page, 120_000);
  await sleep(1600);
  await shot(page, 'console-10-breach');

  await page.close();
}

/* ── Phone ────────────────────────────────────────────────────────── */

async function shootMobile(browser: Browser) {
  console.log('[visual] mobile');
  const page = await newPage(browser, 402, 874);
  await page.goto(`http://127.0.0.1:${UI_PORT}/?noboot=1`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
  await sleep(3000);
  await shot(page, 'mobile-01-deck');

  await page.evaluate(() => document.querySelector('.console')?.classList.add('show-side'));
  await injectEscalation(page, 'blocking');
  await sleep(900);
  await shot(page, 'mobile-02-interrupts');
  await page.close();
}

/* ── Page helpers ─────────────────────────────────────────────────── */

async function newPage(browser: Browser, w: number, h: number): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 2,
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [browser]', m.text());
  });
  page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
  return page;
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  console.log(`  ${name}`);
}

async function dragScene(page: Page, dx: number, dy: number) {
  const box = await page.locator('.scene__canvas').boundingBox();
  if (!box) return;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(cx + (dx * i) / 12, cy + (dy * i) / 12);
    await sleep(16);
  }
  await page.mouse.up();
}

/**
 * Push a synthetic escalation straight into the client store. This bypasses
 * the hub on purpose: the point of the frame is the amber treatment, and it
 * must be capturable on demand rather than whenever the fleet feels like it.
 */
async function injectEscalation(page: Page, urgency: 'low' | 'normal' | 'blocking') {
  await page.evaluate((u) => {
    const w = window as unknown as { __orca?: { store: any } };
    const store = w.__orca?.store;
    if (!store) return;
    const agent = Object.values(store.world.agents)[0] as any;
    const id = 'esc_visual_' + Math.random().toString(36).slice(2, 8);
    store.world.escalations[id] = {
      id,
      agentId: agent?.id ?? 'unknown',
      projectId: agent?.projectId ?? 'unknown',
      machineId: agent?.machineId ?? 'unknown',
      question: 'Should the staging deploy use the production Stripe key or the test key?',
      context: 'The env file has both. The deploy target is staging.axolots.ai, which real users can reach.',
      options: ['Test key', 'Production key', 'Ask me again at deploy time'],
      optionsOnly: false,
      urgency: u,
      status: 'pending',
      ceoAttempt: {
        answer: 'Probably the test key.',
        confidence: 0.42,
        reason: 'nothing in memory about staging credentials, and getting this wrong charges real cards',
      },
      answer: null, answeredBy: null, rememberAs: null,
      askedAt: Date.now(), answeredAt: null, expiresAt: null,
    };
    store.emitAll?.();
    store.on && store.applyPatch(store.world.rev + 1, []);
  }, urgency);
}

/** Backdate pending questions so the breach threshold trips on demand. */
async function agePendingEscalations(page: Page, byMs: number) {
  await page.evaluate((ms) => {
    const w = window as unknown as { __orca?: { store: any } };
    const store = w.__orca?.store;
    if (!store) return;
    for (const e of Object.values(store.world.escalations) as any[]) {
      if (e.status === 'pending' || e.status === 'with_ceo') e.askedAt -= ms;
    }
  }, byMs);
}

/* ── Process plumbing ─────────────────────────────────────────────── */

function spawnProc(label: string, cmd: string, argv: string[], env: Record<string, string> = {}) {
  const p = spawn(cmd, argv, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `  [${label}]`;
  p.stdout?.on('data', (b: Buffer) => {
    const s = b.toString().trim();
    if (s && process.env['ORCA_VERBOSE']) console.log(tag, s);
  });
  p.stderr?.on('data', (b: Buffer) => {
    const s = b.toString().trim();
    // Vite writes its banner to stderr; only surface real trouble.
    if (s && /error|Error|EADDR/.test(s)) console.error(tag, s);
  });
  procs.push(p);
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  return until(async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return r.ok || r.status === 404;
    } catch { return false; }
  }, timeoutMs, 300);
}

function shutdown() {
  for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* already gone */ } }
}
process.on('SIGINT', () => { shutdown(); process.exit(130); });
process.on('SIGTERM', () => { shutdown(); process.exit(143); });

main()
  .then(() => { if (!keep) { shutdown(); process.exit(0); } })
  .catch((err) => {
    console.error('[visual] failed:', err);
    shutdown();
    process.exit(1);
  });
