/**
 * Visual harness.
 *
 * Brings up the hub, a synthetic fleet and Vite — or reuses the ones already
 * running, because `npm run dev` is usually up, unless this run has to keep to
 * itself (see the ports block below) — then drives the real console in a real
 * browser and writes frames to test/shots/. Every state the console
 * can be in gets a PNG, including the boot sequence sampled along its timeline
 * so the beats can be compared against the /system comp side by side.
 *
 *   npx tsx test/visual.ts              everything
 *   npx tsx test/visual.ts boot         just the boot beats
 *   npx tsx test/visual.ts console      just the field and its windows
 *   npx tsx test/visual.ts mobile       just the phone
 *   npx tsx test/visual.ts --headed     watch it happen
 *   npx tsx test/visual.ts --keep       leave the servers up afterwards
 *   npx tsx test/visual.ts --isolated   own hub, Vite and ORCA_HOME, shared with nobody
 *
 * The console frames all load with `?noboot=1`: the boot is photographed on
 * its own, and nine seconds of it in front of every other frame would be nine
 * seconds of nothing.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { WebSocket } from 'ws';
import type { Agent, Escalation, Machine, Project } from '../src/shared/types.ts';
import { emptyRollup } from '../src/shared/types.ts';
import { PATHS, PORTS, PROTOCOL_VERSION, newId } from '../src/shared/protocol.ts';
import { freePort, sleep, until } from './harness.ts';

export const ROOT = new URL('..', import.meta.url).pathname;
export const SHOTS = join(ROOT, 'test', 'shots');

/**
 * Ports, resolved per run rather than fixed.
 *
 * 4478/4479 are the machine's, not the tree's. Two runs shooting frames at
 * once used to fight over them, and the fight was quiet: the second run found
 * the first one's servers, decided they were `npm run dev` and photographed
 * them — another worktree's code, under another worktree's hub — and then the
 * first run finished and took the servers down underneath it. Frames came out
 * looking fine. That is worse than a crash.
 *
 * So: the canonical pair is reused only when it is already serving, which is
 * the case this harness was built around (a developer with `npm run dev` up
 * wants frames without a port fight). A cold run takes free ports instead of
 * racing for 4478 with `--strictPort`. And a run that must not share anything
 * — see `isolated()` — takes its own ports, its own `ORCA_HOME` and therefore
 * its own hub state, touching neither the human's nor another agent's.
 *
 * `ensureServers()` decides. Read the ports through these, never before it.
 */
let PORTS_RESOLVED: { hub: number; ui: number } | null = null;

export function hubPort(): number { return resolvedPorts().hub; }
export function uiPort(): number { return resolvedPorts().ui; }

function resolvedPorts(): { hub: number; ui: number } {
  if (!PORTS_RESOLVED) throw new Error('ports are not resolved yet: call ensureServers() first');
  return PORTS_RESOLVED;
}

/**
 * Does this run have to keep to itself?
 *
 * Explicitly, with `--isolated` or `ORCA_VISUAL_ISOLATED=1`. Or because we are
 * in a linked git worktree, which is where ORCA puts a spawned agent: its
 * frames have to come from its own tree, and reusing whatever is on 4478 would
 * photograph somebody else's. Nobody has to remember the flag for that to hold.
 */
export function isolatedRun(
  argv: readonly string[] = args,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = ROOT,
): boolean {
  if (argv.includes('--isolated') || env['ORCA_VISUAL_ISOLATED'] === '1') return true;
  return inLinkedWorktree(cwd);
}

/** A linked worktree keeps its own git dir; the main checkout's is the common one. */
function inLinkedWorktree(cwd: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-dir', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const [dir, common] = out.trim().split('\n');
    return dir !== undefined && common !== undefined && dir !== common;
  } catch { return false; }
}

/**
 * What this run may share, given what is already serving.
 *
 * Pure, and separate from `ensureServers`, because the interesting rule is not
 * obvious and fails quietly: a canonical Vite is only reusable when we are also
 * on the canonical hub. Vite proxies /api and /ws to one hub, fixed when it
 * started. Borrowing someone's Vite while running our own hub gives a console
 * that renders our tree and talks to their fleet, and it photographs fine.
 */
export function sharing(o: { alone: boolean; hubUp: boolean; uiUp: boolean }): { hub: 'reuse' | 'own'; ui: 'reuse' | 'own' } {
  if (o.alone) return { hub: 'own', ui: 'own' };
  const hub = o.hubUp ? 'reuse' : 'own';
  return { hub, ui: hub === 'reuse' && o.uiUp ? 'reuse' : 'own' };
}

/** The throwaway `ORCA_HOME` an isolated run gives its hub, or null. */
let TEMP_HOME: string | null = null;

/**
 * Headless Chromium falls back to SwiftShader, which renders the field in
 * software and pins it at ~20fps no matter how much is on screen — useless for
 * a frame rate, and not what anyone's browser does. These put it on the real
 * GPU through ANGLE, whichever backend the platform has.
 */
export const GPU_ARGS = ['--use-gl=angle', '--enable-gpu', '--ignore-gpu-blocklist'];

/* ── The hooks the console exposes for us ─────────────────────────── */

export interface OrcaHook {
  frame(): void;
  open(id: string): void;
  openKind(k: string): void;
  tilt(on: boolean): void;
  stats(): { agents: number; drawn: number; segments: number; fps: number };
  /** The world rectangle the viewport covers. The harness reads zoom off it. */
  view(): { minX: number; minY: number; maxX: number; maxY: number };
  select(ids: string[]): void;
  note(t: string): void;
  /** Put a task in the console's store without giving the hub one. See hud-tasks.shots.ts. */
  task(t: import('../src/shared/tasks.ts').CapcomTask): void;
  /** Live, non-CAPCOM agents on the field: the ones a click can actually fly to. */
  agentIds(): string[];
}

declare global {
  interface Window {
    __orca?: OrcaHook;
    /** Console sockets, recorded by our init script. Test-only, see `trackSockets`. */
    __sockets?: WebSocket[];
    /** While true, a new console socket refuses to open. */
    __wsBlocked?: boolean;
  }
}

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const keep = args.includes('--keep');
const only = args.find((a) => !a.startsWith('--'));

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

const missing: string[] = [];

async function main() {
  await mkdir(SHOTS, { recursive: true });
  // Only wipe what this run is about to replace. `stress-*.png` belongs to
  // test/field-stress.ts and outliving a visual run is the whole point of it.
  const prefixes = only === 'boot' ? ['boot-'] : only === 'mobile' ? ['mobile-'] : only === 'console' ? ['field-'] : ['boot-', 'field-', 'mobile-'];
  for (const f of await readdir(SHOTS)) {
    if (prefixes.some((p) => f.startsWith(p))) await unlink(join(SHOTS, f)).catch(() => { /* gone already */ });
  }

  await ensureServers();

  const browser = await chromium.launch({ headless: !headed, args: GPU_ARGS });
  try {
    if (!only || only === 'boot') await shootBoot(browser);
    if (!only || only === 'console') await shootConsole(browser);
    if (!only || only === 'console') await shootIdentity(browser);
    if (!only || only === 'mobile') await shootMobile(browser);
  } finally {
    await browser.close();
  }

  const files = (await readdir(SHOTS)).filter((f) => prefixes.some((p) => f.startsWith(p))).sort();
  console.log(`\n[visual] ${files.length} frames in ${SHOTS}`);
  for (const f of files) console.log(`    ${f}`);
  if (missing.length) {
    console.log('\n[visual] frames this run could not take:');
    for (const m of missing) console.log(`    ${m}`);
  }
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
  await page.goto(`http://127.0.0.1:${uiPort()}/`, { waitUntil: 'domcontentloaded' });
  await fontsReady(page);

  for (const beat of BOOT_BEATS) {
    const wait = beat.at - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    await page.screenshot({ path: join(SHOTS, `boot-${beat.name}.png`) });
    console.log(`  ${beat.name}`);
  }
  await page.close();
}

/* ── The field and its windows ────────────────────────────────────── */

async function shootConsole(browser: Browser) {
  console.log('[visual] console');
  const page = await newPage(browser, 1600, 1000);
  await open(page, `http://127.0.0.1:${uiPort()}/?noboot=1`);

  const ready = await waitForFleet(page, 4);
  if (!ready) console.warn('  [warn] the fleet never populated the field');

  /* 01 · the whole fleet, framed. */
  await closeAllWindows(page);
  await page.evaluate(() => window.__orca?.frame());
  await sleep(1500);
  await shot(page, 'field-01-overview');

  /* 02 · a project, framed by double-clicking its region label. */
  const rgn = page.locator('.rgn:visible').first();
  if (await rgn.count()) {
    await rgn.dblclick();
    await sleep(1500);
    // The first click of the pair also opens the project's fleet window; this
    // frame is about the camera, so put the glass back the way it was.
    await closeAllWindows(page);
    await sleep(500);
    await shot(page, 'field-02-project');
  } else {
    miss('field-02-project', 'no region label was on screen');
  }

  /* 03 · an agent's window, from double-clicking its tile. */
  const at = await firstTilePoint(page);
  if (at) {
    await page.mouse.dblclick(at.x, at.y);
    const got = await until(async () => (await page.locator('.win.is-agent').count()) > 0, 6000, 200);
    await sleep(900);
    if (got) await shot(page, 'field-03-agent');
    else miss('field-03-agent', 'the double click did not open an agent window');
  } else {
    miss('field-03-agent', 'no tile was large enough to carry a label');
  }

  /* 04 · the docked windows: CEO, QUEUE, FEED. */
  await closeAllWindows(page);
  for (const k of ['c', 'q', 'l']) await pressBare(page, k);
  await sleep(900);
  await shot(page, 'field-04-windows');

  /* 05 · the tilt, which makes depth literal. */
  await pressBare(page, 'o');
  await sleep(1600);
  await shot(page, 'field-05-tilt');
  await pressBare(page, 'o');
  await sleep(1200);

  /* 06 · an interrupt, from a question raised over the real protocol. */
  await closeAllWindows(page);
  const raised = await injectEscalation();
  await pressBare(page, 'q');
  await sleep(1200);
  const row = raised
    ? page.locator(`.qrow[data-esc="${raised.escalationId}"]`)
    : page.locator('.qrow[data-esc]').first();
  const hasRow = await until(async () => (await row.count()) > 0, 30_000, 500);
  if (hasRow) {
    await row.click();
    const got = await until(async () => (await page.locator('.win.is-interrupt').count()) > 0, 6000, 200);
    // The queue flies the camera right onto the tile, which is too close to see
    // the window anchored beside it. Pull back to a working distance, the way
    // an operator would, so the frame shows the tile, the window and its tether.
    await sleep(1600);
    await page.mouse.move(800, 520);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 420); await sleep(160); }
    await sleep(900);
    if (got) await shot(page, 'field-06-interrupt');
    else miss('field-06-interrupt', 'the queue row did not open an interrupt window');
  } else {
    miss('field-06-interrupt', raised ? 'the question never reached the queue' : 'could not reach the hub to raise one');
  }
  raised?.close();

  /* 07 · a lasso selection and its toolbar. */
  await closeAllWindows(page);
  await pressBare(page, 'f');
  await sleep(1600);
  if (await lasso(page, 0.12, 0.18, 0.55, 0.62) || await lasso(page, 0.9, 0.85, 0.5, 0.5)) {
    await sleep(500);
    await shot(page, 'field-07-lasso');
  } else {
    miss('field-07-lasso', 'the shift-drag never selected more than one tile');
  }

  /* 08 · two windows folded into the tray. */
  await page.locator('.selbar [data-s="clear"]').click().catch(() => { /* nothing selected */ });
  await pressBare(page, 'c');
  await pressBare(page, 'q');
  await sleep(700);
  const mins = page.locator('.win:not(.is-min) [data-w-min]');
  for (let i = 0; i < 2 && await mins.count(); i++) {
    await mins.first().click();
    await sleep(400);
  }
  await sleep(600);
  if (await page.locator('.tray .tile').count() >= 2) await shot(page, 'field-08-tray');
  else miss('field-08-tray', 'the folded windows never reached the tray');

  /* 09 · the breach. The console socket is cut and kept cut, from the test
     side: the page never learns, it just loses the wire like it would. */
  await closeAllWindows(page);
  await page.evaluate(() => {
    window.__wsBlocked = true;
    for (const ws of window.__sockets ?? []) { try { ws.close(); } catch { /* already gone */ } }
  });
  const down = await until(async () => (await page.locator('.field.is-breach').count()) > 0, 8000, 200);
  await sleep(1500);
  if (down) await shot(page, 'field-09-breach');
  else miss('field-09-breach', 'the console never reported the link as down');

  await page.close();
}

/* ── Identity: the squadron and the tile at full size ─────────────── */

/**
 * Two frames the identity work of docs/IDENTITY.md is judged on, and neither
 * can be left to chance in the synthetic fleet: a squadron of six with one
 * member waiting on a person, and a single tile zoomed past the last rung of
 * the ladder.
 *
 * Both come off one injected collector (§3, §2.2), so the console cannot tell
 * them from any other machine, and both are shot by driving the real camera —
 * ⌘-wheel onto the block, then onto the tile — rather than by reaching into
 * the field, because what is being photographed is what the operator sees.
 */
async function shootIdentity(browser: Browser) {
  console.log('[visual] identity');
  const squad = await injectSquad();
  if (!squad) {
    miss('field-10-squad', 'could not reach the hub to raise a squadron');
    miss('field-11-tile-tier5', 'could not reach the hub to raise a squadron');
    return;
  }
  const page = await newPage(browser, 1600, 1000);
  try {
    await open(page, `http://127.0.0.1:${uiPort()}/?noboot=1`);
    await waitForFleet(page, 4);
    await closeAllWindows(page);
    await page.evaluate(() => window.__orca?.frame());
    await sleep(1800);

    /* 10 · the squadron, at the three rungs of its rótulo (§3.2): the roster
       alone, the roster with a name, and the whole thing with the lead's
       mission and the amber count of what is waiting on a person. */
    const find = () => squadPoint(page, SQUAD_NAME);
    if (!await find()) {
      miss('field-10-squad', 'the squad rótulo never appeared on the field');
    } else {
      const rungs: [string, number][] = [['far', 30], ['mid', 70], ['near', 170]];
      const mid = centre(page);
      for (const [name, ppu] of rungs) {
        // Centre the block *before* zooming: the camera holds whatever is
        // under the cursor, so zooming at wherever the rótulo happened to be
        // pins the squad against an edge and cuts it in half.
        const put = await centreOn(page, find);
        const got = put && mid && await zoomTo(page, mid, ppu);
        await sleep(700);
        if (got) await shot(page, `field-10-squad-${name}`);
        else miss(`field-10-squad-${name}`, `the camera would not reach ${ppu}px per unit`);
      }
    }

    /* 11 · one tile past TIER_PX[4]: the rung where the runtime line and the
       pill appear, the title is dropped for echoing the project's name, and
       the emoji in NOW has to be gone rather than a box. */
    // Come back out first: the squad zoom left Z9 off the screen entirely, and
    // a tile with no label is a tile the harness cannot find. Framing the
    // fleet and then the project puts it back on the glass.
    await page.evaluate(() => window.__orca?.frame());
    await sleep(1400);
    const rgn = page.locator(`.rgn[data-project="${SQUAD_PROJECT}"]:visible`).first();
    if (await rgn.count()) { await rgn.click(); await sleep(1500); }
    await closeAllWindows(page);
    // The rótulo is on screen at any zoom; the label is not. Ride it in until
    // the tiles are legible, then hand over to Z9's own label.
    const mid2 = centre(page);
    if (await centreOn(page, () => squadPoint(page, SQUAD_NAME)) && mid2) {
      await zoomTo(page, mid2, 150);
      await sleep(600);
    }
    const tile = await labelPoint(page, SHOWCASE_CALLSIGN);
    if (!tile) {
      miss('field-11-tile-tier5', 'the showcase tile never carried a label');
    } else {
      const put = await centreOn(page, () => labelPoint(page, SHOWCASE_CALLSIGN));
      const got = put && mid2 && await zoomTo(page, mid2, 560);
      await sleep(900);
      const wide = await page.evaluate((cs) => {
        for (const el of document.querySelectorAll<HTMLElement>('.lbl')) {
          if (el.hidden || !el.textContent?.toUpperCase().includes(cs)) continue;
          return el.getBoundingClientRect().width;
        }
        return 0;
      }, SHOWCASE_CALLSIGN);
      if (got && wide >= 520) await shot(page, 'field-11-tile-tier5');
      else miss('field-11-tile-tier5', `the tile only reached ${Math.round(wide)}px wide`);
    }
  } finally {
    await page.close();
    squad.close();
  }
}

/** Where a squad's rótulo stands, in viewport pixels. */
async function squadPoint(page: Page, name: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((n) => {
    const el = document.querySelector<HTMLElement>(`.squad[data-squad="${n}"]`);
    if (!el || el.style.display === 'none') return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, name);
}

/** The centre of the label carrying a callsign, in viewport pixels. */
async function labelPoint(page: Page, callsign: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((cs) => {
    for (const el of document.querySelectorAll<HTMLElement>('.lbl')) {
      if (el.hidden || !el.textContent?.toUpperCase().includes(cs)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8) continue;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    return null;
  }, callsign);
}

/** The middle of the viewport, which is where anything worth a frame belongs. */
function centre(page: Page): { x: number; y: number } | null {
  const vp = page.viewportSize();
  return vp ? { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) } : null;
}

/**
 * Pan until whatever `find` points at sits in the middle of the viewport.
 *
 * Scrolling pans in this console and never zooms, so this is a wheel, not a
 * drag — a drag that starts over a tile moves the tile instead of the field.
 * One nudge calibrates sign and scale (panning is linear), and the rest is
 * three or four corrections onto the centre.
 */
async function centreOn(page: Page, find: () => Promise<{ x: number; y: number } | null>): Promise<boolean> {
  const mid = centre(page);
  const a0 = await find();
  if (!mid || !a0) return false;
  await page.mouse.move(mid.x, mid.y);

  const probe = 100;
  await page.mouse.wheel(probe, probe);
  await settle(page);
  const a1 = await find();
  if (!a1) return false;
  const kx = (a1.x - a0.x) / probe, ky = (a1.y - a0.y) / probe;
  if (Math.abs(kx) < 0.2 || Math.abs(ky) < 0.2) return false;

  for (let i = 0; i < 8; i++) {
    const at = await find();
    if (!at) return false;
    const dx = mid.x - at.x, dy = mid.y - at.y;
    if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return true;
    await page.mouse.wheel(Math.round(dx / kx), Math.round(dy / ky));
    await settle(page);
  }
  return !!(await find());
}

/** Pixels one world unit covers right now — a tile is exactly one wide. */
async function pxPerUnit(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = window.__orca?.view();
    if (!v) return 0;
    return innerWidth / Math.max(0.0001, v.maxX - v.minX);
  });
}

/**
 * Wait for the camera to stop moving. It eases toward whatever it was asked
 * for, so a measurement taken right after a wheel is a measurement of the
 * journey; two identical readings mean it has arrived.
 */
async function settle(page: Page, ms = 2000) {
  const read = () => page.evaluate(() => {
    const v = window.__orca?.view();
    return v ? `${v.minX.toFixed(3)}|${v.minY.toFixed(3)}|${v.maxX.toFixed(3)}|${v.maxY.toFixed(3)}` : '';
  });
  let prev = '';
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    const now = await read();
    if (now && now === prev) return;
    prev = now;
    await sleep(90);
  }
}

/**
 * Drive the real camera until a world unit covers `target` pixels, holding the
 * given point under the cursor so whatever is there stays there.
 *
 * Zoom is ⌘-wheel, and the console maps one tick to `exp(deltaY · K)` on the
 * camera's distance — so the tick that lands *on* the target is arithmetic,
 * not a search. A fixed tick is not: at K = 0.012 a wheel notch is eleven
 * times closer, which is how `field-10-squad-near` ended up at 310px per unit
 * with the block shoved off the left edge. Which sign of `deltaY` moves in is
 * settled by trying one, because that is not worth asserting from here.
 */
const ZOOM_K = 0.012;
async function zoomTo(page: Page, at: { x: number; y: number }, target: number): Promise<boolean> {
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down('Control');
  try {
    let sign = 1;
    for (let i = 0; i < 24; i++) {
      const now = await pxPerUnit(page);
      if (!now) return false;
      const off = Math.log(now / target);
      if (Math.abs(off) < 0.05) return true;
      await page.mouse.wheel(0, Math.round(Math.max(-120, Math.min(120, off / ZOOM_K)) * sign));
      await settle(page);
      // One probe: if the first tick went the wrong way, the wheel is inverted.
      if (i === 0 && Math.abs(Math.log((await pxPerUnit(page)) / target)) > Math.abs(off)) sign = -sign;
    }
    const end = await pxPerUnit(page);
    return end > target * 0.85 && end < target * 1.18;
  } finally {
    await page.keyboard.up('Control');
  }
}

/* ── A squadron, on demand ────────────────────────────────────────── */

/*
 * Fixed ids, all three of them. A hub keeps an offline machine's agents for an
 * hour, so a harness that invented a new id every run stacked another six
 * tiles onto the same block each time — the reason `field-10-squad` once
 * photographed eighteen members and a rótulo cut off at the edge. Everything
 * this injects is named after what it is, so a re-run replaces it.
 */
const SQUAD_MACHINE = 'orca-visual-squad';
const SQUAD_PROJECT = 'p_vsquad';
const SQUAD_NAME = 'ledger-close';
const SHOWCASE_CALLSIGN = 'Z9';

/**
 * Six agents under one squad label, one of them blocked on a question only a
 * person can answer, plus a seventh standing alone for the tier-5 tile.
 *
 * The seventh is built to trip two of the rules in §2.2 on purpose: its title
 * opens with the project's own name, so the label has to drop it and let the
 * mission take the line, and its `lastSay` carries an emoji, so the filter has
 * to remove it rather than leave a box on the tile.
 */
export async function injectSquad(): Promise<{ close(): void } | null> {
  const token = orcaToken();
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort()}${PATHS.collector}?token=${encodeURIComponent(token)}`);
  const opened = await new Promise<boolean>((resolve) => {
    ws.once('open', () => resolve(true));
    ws.once('error', () => resolve(false));
    setTimeout(() => resolve(false), 6000);
  });
  if (!opened) return null;

  const now = Date.now();
  const load = { sessions: 7, activeSessions: 5, cpuPct: 61, memPct: 48 };
  const machine: Machine = {
    id: SQUAD_MACHINE, hostname: 'visual-squad', platform: 'linux',
    version: '0.1.0-visual', online: true, lastSeen: now, connectedAt: now, load,
  };
  const project: Project = {
    id: SQUAD_PROJECT, machineId: SQUAD_MACHINE, slug: '-srv-ledger', name: 'ledger',
    path: '/srv/ledger', code: 'LG', gitBranch: 'main', gitDirty: false,
    keyNames: [], sessionIds: [], rollup: emptyRollup(),
  };

  const metrics = {
    costUSD: 0.21, inputTokens: 61_000, outputTokens: 8_100, cacheReadTokens: 120_000,
    thinkingTokens: 1_400, tokensPerSec: 34, linesAdded: 61, linesRemoved: 12,
    toolCalls: 19, toolDurationMs: 91_000, apiDurationMs: 52_000, turns: 7,
  };
  // Ids derived from the callsign, not `newId`: the harness is run again and
  // again against a hub that keeps a machine's agents after it goes offline,
  // and a fresh id every run would stack six more tiles onto the block each
  // time instead of replacing the six that are there.
  const idOf = (callsign: string) => `sess_vsquad_${callsign.toLowerCase()}`;
  const base = (over: Partial<Agent> & { callsign: string }): Agent => ({
    id: idOf(over.callsign), machineId: SQUAD_MACHINE, projectId: project.id,
    title: 'Reconcile the March ledger', runtime: 'claude',
    state: 'working', block: null, parentId: null, depth: 0, childIds: [],
    mission: 'Find every entry that does not balance and say why.',
    squad: SQUAD_NAME, lead: false,
    model: 'claude-sonnet-4-5-20250929', tool: null, toolDetail: null,
    lastPrompt: 'Start with the March exports.',
    lastSay: 'Working through the March exports.',
    startedAt: now - 900_000, updatedAt: now, uptimeMs: 900_000,
    metrics: { ...metrics },
    background: false, shortId: null,
    ...over,
  });

  const lead = base({
    callsign: 'Z1', lead: true, runtime: 'claude', state: 'working',
    mission: 'Own the March close and hand back one number.',
  });
  const members = [
    base({ callsign: 'Z2', runtime: 'codex', state: 'working', parentId: lead.id }),
    base({ callsign: 'Z3', runtime: 'grok', state: 'thinking', parentId: lead.id, metrics: { ...metrics, tokensPerSec: 0 } }),
    base({ callsign: 'Z4', runtime: 'claude', state: 'blocked', parentId: lead.id }),
    base({ callsign: 'Z5', runtime: 'claude', state: 'idle', parentId: lead.id }),
    base({ callsign: 'Z6', runtime: 'codex', state: 'done', parentId: lead.id }),
  ];
  const blocked = members[2]!;
  const esc: Escalation = {
    id: 'esc_vsquad_1', agentId: blocked.id, projectId: project.id, machineId: SQUAD_MACHINE,
    question: 'The February adjustment has no counter-entry. Write one off, or hold the close?',
    context: 'It is 412.60 against a supplier that no longer exists.',
    options: ['Write it off', 'Hold the close'],
    optionsOnly: false, urgency: 'blocking', status: 'pending',
    ceoAttempt: null, answer: null, answeredBy: null, rememberAs: null,
    askedAt: now - 60_000, answeredAt: null, expiresAt: null,
  };
  blocked.block = { kind: 'question', summary: esc.question, escalationId: esc.id, since: esc.askedAt };

  // §2.2: the title is the project's own name, so the label must drop it, and
  // the emoji in NOW must be filtered rather than drawn as a box.
  const showcase = base({
    callsign: SHOWCASE_CALLSIGN, squad: null, lead: false, runtime: 'codex', state: 'working',
    title: 'ledger-25 — reconcile March',
    mission: 'Reconcile March against the bank statement and explain every gap in one line.',
    lastSay: '✅ Twelve of fourteen gaps are timing, not error. 🧾',
    // No tool on purpose: NOW falls through to the agent's own words, which is
    // the only way this frame photographs the emoji filter rather than a path.
    model: 'claude-opus-4-6', tool: null, toolDetail: null,
  });

  const agents = [lead, ...members, showcase];
  project.sessionIds = agents.map((a) => a.id);

  const send = (frame: unknown): void => { try { ws.send(JSON.stringify(frame)); } catch { /* the hub went away */ } };
  send({ t: 'hello', v: PROTOCOL_VERSION, machine, token });
  send({ t: 'snapshot', machineId: SQUAD_MACHINE, projects: [project], agents, keys: [] });
  send({ t: 'escalation', machineId: SQUAD_MACHINE, escalation: esc });
  const beat = setInterval(() => send({ t: 'beat', machineId: SQUAD_MACHINE, at: Date.now(), load }), 5000);
  beat.unref?.();

  await sleep(1200);
  return { close() { clearInterval(beat); try { ws.close(1000, 'done'); } catch { /* already gone */ } } };
}

/* ── Phone ────────────────────────────────────────────────────────── */

async function shootMobile(browser: Browser) {
  console.log('[visual] mobile');
  const page = await newPage(browser, 402, 874);
  await open(page, `http://127.0.0.1:${uiPort()}/?noboot=1`);
  await waitForFleet(page, 4);
  await closeAllWindows(page);
  await page.evaluate(() => window.__orca?.frame());
  await sleep(1600);
  await shot(page, 'mobile-01-field');

  const at = await firstTilePoint(page);
  if (at) await page.mouse.dblclick(at.x, at.y);
  if (!await until(async () => (await page.locator('.win').count()) > 0, 4000, 200)) {
    await pressBare(page, 'q');
  }
  await sleep(1000);
  if (await page.locator('.win').count()) await shot(page, 'mobile-02-window');
  else miss('mobile-02-window', 'no window would open at 402px');
  await page.close();
}

/* ── Page helpers ─────────────────────────────────────────────────── */

export async function newPage(browser: Browser, w: number, h: number): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    // Tiny5 is a pixel face; at 1x the screenshot resamples it into mush.
    deviceScaleFactor: 2,
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  await trackSockets(page);
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [browser]', m.text());
  });
  page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
  return page;
}

/**
 * Record the console's WebSocket so a test can cut it, and let a test refuse
 * the reconnect. Vite's own HMR socket is left alone: block that one and the
 * dev server reloads the page out from under the shot.
 */
async function trackSockets(page: Page) {
  // Handed over as source, not as a function: tsx compiles this file with
  // esbuild's keepNames, and the `__name` helper it injects does not exist in
  // the page, so a serialised closure would throw before it patched anything.
  await page.addInitScript({
    content: `(() => {
      const isHub = (u) => String(u).indexOf('/ws/console') >= 0;
      const Native = window.WebSocket;
      const Tracked = function (url, protocols) {
        if (window.__wsBlocked && isHub(url)) throw new Error('link is down');
        const ws = new Native(url, protocols);
        if (isHub(url)) { (window.__sockets = window.__sockets || []).push(ws); }
        return ws;
      };
      Tracked.prototype = Native.prototype;
      for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Tracked[k] = Native[k];
      window.WebSocket = Tracked;
    })();`,
  });
}

export async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await fontsReady(page);
}

/** The pixel grid is wrong until the faces are in. Wait for them, every frame. */
export async function fontsReady(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => false);
}

export async function waitForFleet(page: Page, min: number, timeoutMs = 40_000): Promise<boolean> {
  return until(async () => (await page.evaluate(() => window.__orca?.stats().agents ?? 0)) > min, timeoutMs, 300);
}

async function shot(page: Page, name: string) {
  await fontsReady(page);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  console.log(`  ${name}`);
}

function miss(name: string, why: string) {
  console.warn(`  [skip] ${name}: ${why}`);
  missing.push(`${name} — ${why}`);
}

/** A bare key press: the console ignores keys while an input has the focus. */
/**
 * Window openers are ⌥ chords now (single letters would saturate the keyboard);
 * the field's own keys stay bare. `pressBare('q')` therefore sends ⌥Q, while
 * `'o'`/`'f'` go through as they are.
 */
const OPENER_CHORD: Record<string, string> = { c: 'Alt+KeyC', q: 'Alt+KeyQ', l: 'Alt+KeyF', n: 'Alt+KeyN', g: 'Alt+KeyG', t: 'Alt+KeyT', m: 'Alt+KeyM' };
async function pressBare(page: Page, key: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(OPENER_CHORD[key] ?? key);
  await sleep(250);
}

async function closeAllWindows(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('.win [data-w-close]').forEach((b) => b.click());
  });
  await sleep(300);
}

/**
 * A point low in the first tile that carries a label, in viewport pixels.
 *
 * Low on purpose. The label sits in the tile's top-left, and the window the
 * click opens arrives from the cursor with its header along the tile's top
 * edge — click up there and the second half of the double click lands on that
 * header, which folds the window into the tray instead of showing it. The
 * tile's geometry is recovered from the label: the field sizes a label to
 * two-thirds of its tile and insets it by the same pads every time.
 */
async function firstTilePoint(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const ASPECT = 0.78; // TILE_H / TILE_W, from src/ui/field/layout.ts
    for (const el of document.querySelectorAll<HTMLElement>('.lbl')) {
      if (el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 24) continue;
      const tw = r.width / 0.66;
      const th = tw * ASPECT;
      const x = r.left - Math.max(5, tw * 0.07) + tw * 0.5;
      const y = r.top - Math.max(4, th * 0.09) + th * 0.78;
      if (x < 40 || x > innerWidth - 40 || y < 70 || y > innerHeight - 100) continue;
      return { x: Math.round(x), y: Math.round(y) };
    }
    return null;
  });
}

/**
 * Shift-drag across the field. Starts wherever the caller says, in fractions
 * of the viewport, because the drag has to begin on empty ground: a shift-drag
 * that lands on a tile moves the tile instead of selecting anything.
 */
async function lasso(page: Page, fx0: number, fy0: number, fx1: number, fy1: number): Promise<boolean> {
  const vp = page.viewportSize();
  if (!vp) return false;
  const x0 = Math.round(vp.width * fx0), y0 = Math.round(vp.height * fy0);
  const x1 = Math.round(vp.width * fx1), y1 = Math.round(vp.height * fy1);

  await page.keyboard.down('Shift');
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12);
    await sleep(16);
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await sleep(400);
  return page.locator('.selbar:not([hidden])').count().then((n) => n > 0);
}

/* ── A question that needs a person, on demand ────────────────────── */

const VISUAL_MACHINE = 'orca-visual';

export interface Injected { escalationId: string; agentId: string; close(): void }

/**
 * Raise a real escalation by joining the hub as a one-agent collector.
 *
 * The alternative is waiting for the synthetic fleet to happen to ask
 * something, which turns a frame the amber treatment depends on into a
 * coin flip. This speaks the published collector protocol — no back door into
 * the console, and the console cannot tell it from any other machine.
 */
export async function injectEscalation(): Promise<Injected | null> {
  const token = orcaToken();
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort()}${PATHS.collector}?token=${encodeURIComponent(token)}`);
  const opened = await new Promise<boolean>((resolve) => {
    const done = (v: boolean): void => resolve(v);
    ws.once('open', () => done(true));
    ws.once('error', () => done(false));
    setTimeout(() => done(false), 6000);
  });
  if (!opened) return null;

  const now = Date.now();
  const load = { sessions: 1, activeSessions: 1, cpuPct: 24, memPct: 41 };
  const machine: Machine = {
    id: VISUAL_MACHINE, hostname: 'visual-harness', platform: 'darwin',
    version: '0.1.0-visual', online: true, lastSeen: now, connectedAt: now, load,
  };
  const project: Project = {
    id: 'p_visual', machineId: VISUAL_MACHINE, slug: '-srv-checkout', name: 'checkout',
    path: '/srv/checkout', code: 'CK', gitBranch: 'deploy/staging', gitDirty: true,
    keyNames: ['STRIPE_TEST_KEY'], sessionIds: [], rollup: emptyRollup(),
  };
  const agent: Agent = {
    id: newId('sess'), machineId: VISUAL_MACHINE, projectId: project.id,
    title: 'Deploy the checkout rewrite to staging',
    callsign: 'V1', runtime: 'claude', state: 'blocked', block: null, parentId: null, depth: 0, childIds: [],
    mission: 'Ship the rewrite behind a flag without charging anyone.',
    squad: null, lead: false,
    model: 'claude-opus-4-6', tool: null, toolDetail: null,
    lastPrompt: 'Deploy to staging when the suite is green.',
    lastSay: 'The suite is green. One thing before I deploy.',
    startedAt: now - 2_400_000, updatedAt: now, uptimeMs: 2_400_000,
    metrics: {
      costUSD: 0.84, inputTokens: 182_000, outputTokens: 21_400, cacheReadTokens: 410_000,
      thinkingTokens: 5_200, tokensPerSec: 0, linesAdded: 318, linesRemoved: 96,
      toolCalls: 74, toolDurationMs: 412_000, apiDurationMs: 205_000, turns: 22,
    },
    background: false, shortId: null,
  };
  const esc: Escalation = {
    id: newId('esc'), agentId: agent.id, projectId: project.id, machineId: VISUAL_MACHINE,
    question: 'Should the staging deploy use the production Stripe key or the test key?',
    context: 'The env file carries both. The target is staging.axolots.ai, which real users can reach.',
    options: ['Test key', 'Production key', 'Ask me again at deploy time'],
    optionsOnly: false, urgency: 'blocking', status: 'pending',
    ceoAttempt: {
      answer: 'Probably the test key.',
      confidence: 0.42,
      reason: 'nothing in memory about staging credentials, and getting this wrong charges real cards',
    },
    answer: null, answeredBy: null, rememberAs: null,
    askedAt: now - 45_000, answeredAt: null, expiresAt: null,
  };
  agent.block = { kind: 'question', summary: esc.question, escalationId: esc.id, since: esc.askedAt };
  project.sessionIds = [agent.id];

  const send = (frame: unknown): void => { try { ws.send(JSON.stringify(frame)); } catch { /* the hub went away */ } };
  send({ t: 'hello', v: PROTOCOL_VERSION, machine, token });
  send({ t: 'snapshot', machineId: VISUAL_MACHINE, projects: [project], agents: [agent], keys: [] });
  send({ t: 'escalation', machineId: VISUAL_MACHINE, escalation: esc });
  // Keep beating: a machine that goes quiet is marked offline, and that would
  // expire the question halfway through the shot.
  const beat = setInterval(() => send({ t: 'beat', machineId: VISUAL_MACHINE, at: Date.now(), load }), 5000);
  beat.unref?.();

  return {
    escalationId: esc.id,
    agentId: agent.id,
    close() { clearInterval(beat); try { ws.close(1000, 'done'); } catch { /* already gone */ } },
  };
}

function orcaToken(): string {
  const env = process.env['ORCA_TOKEN'];
  if (env) return env;
  try {
    return readFileSync(join(process.env['ORCA_HOME'] ?? join(homedir(), '.orca'), 'token'), 'utf8').trim();
  } catch { return ''; }
}

/* ── Process plumbing ─────────────────────────────────────────────── */

const procs: ChildProcess[] = [];

/**
 * Bring up whatever is not already up. A developer with `npm run dev` running
 * should be able to shoot frames without a port fight, and a cold checkout
 * should not need one.
 */
export async function ensureServers(opts: { fleet?: boolean } = {}): Promise<{ hubWasUp: boolean; uiWasUp: boolean }> {
  const alone = isolatedRun();
  if (alone && !TEMP_HOME) {
    // Its own ORCA_HOME, so this run's hub writes its token and state where
    // nothing else reads them. Setting it on our own env is enough: every
    // server we start inherits it (see spawnProc), and orcaToken() below
    // already looks there.
    TEMP_HOME = mkdtempSync(join(tmpdir(), 'orca-visual-'));
    process.env['ORCA_HOME'] = TEMP_HOME;
    console.log(`[visual] isolated run: own ports and ORCA_HOME (${TEMP_HOME})`);
  }

  // Probe only what we could actually share; `sharing` holds the rule.
  const hubUp = !alone && await httpOk(`http://127.0.0.1:${PORTS.hub}/api/health`, 1500);
  const uiUp = hubUp && await httpOk(`http://127.0.0.1:${PORTS.ui}/`, 1500);
  const plan = sharing({ alone, hubUp, uiUp });

  const hubWasUp = plan.hub === 'reuse';
  const hub = hubWasUp ? PORTS.hub : await freePort();
  PORTS_RESOLVED = { hub, ui: PORTS.ui };
  if (hubWasUp) {
    console.log(`[visual] hub already on ${hub}, reusing it`);
  } else {
    console.log(`[visual] starting hub on ${hub}`);
    spawnProc('hub', 'npx', ['tsx', 'src/hub/server.ts'], { ORCA_PORT: String(hub) });
    if (!await waitForHttp(`http://127.0.0.1:${hub}/api/health`, 20_000)) throw new Error('hub never came up');
  }

  // The synthetic fleet is not optional scenery: several frames need agents
  // that block, escalate and talk to each other on demand. A reused hub may be
  // carrying only a real collector, which does none of that to order.
  let fleetStarted = false;
  if (opts.fleet !== false && !await hasSyntheticFleet()) {
    console.log('[visual] starting synthetic fleet');
    spawnProc('fleet', 'npx', ['tsx', 'test/fake-collector.ts', `--hub=ws://127.0.0.1:${hub}`, '--speed=3']);
    fleetStarted = true;
  }

  const uiWasUp = plan.ui === 'reuse';
  const ui = uiWasUp ? PORTS.ui : await freePort();
  PORTS_RESOLVED = { hub, ui };
  if (uiWasUp) {
    console.log(`[visual] vite already on ${ui}, reusing it`);
  } else {
    console.log(`[visual] starting vite on ${ui}`);
    spawnProc('vite', 'npx', ['vite', '--port', String(ui), '--strictPort'],
      { ORCA_PORT: String(hub), ORCA_UI_PORT: String(ui) });
    if (!await waitForHttp(`http://127.0.0.1:${ui}/`, 30_000)) throw new Error('vite never came up');
  }

  // A fleet that just connected needs a moment before it is worth photographing.
  if (fleetStarted) await sleep(6000);
  return { hubWasUp, uiWasUp };
}

/** Is one of `test/fake-collector.ts`'s machines already reporting to the hub? */
async function hasSyntheticFleet(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${hubPort()}/api/health`, { signal: AbortSignal.timeout(2000) });
    const h = await r.json() as { machines?: { list?: { id: string; online: boolean }[] } };
    return (h.machines?.list ?? []).some((m) => m.online && /^(mac-cascabel|vps-fra1|vps-nue2)/.test(m.id));
  } catch { return false; }
}

export function spawnProc(label: string, cmd: string, argv: string[], env: Record<string, string> = {}): ChildProcess {
  const p = spawn(cmd, argv, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group. `npx` forks the real process, and signalling only
    // the wrapper leaves a synthetic fleet running against the hub forever.
    detached: true,
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
  return p;
}

export async function httpOk(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok || r.status === 404;
  } catch { return false; }
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  return until(() => httpOk(url, 1500), timeoutMs, 300);
}

/** Signal the whole process group, so `npx`'s child goes too. */
export function signalProc(p: ChildProcess, sig: NodeJS.Signals = 'SIGTERM') {
  if (p.exitCode !== null || p.signalCode !== null) return;
  try { if (p.pid) process.kill(-p.pid, sig); } catch { /* group already gone */ }
  try { p.kill(sig); } catch { /* already gone */ }
}

export function shutdown() {
  for (const p of procs) signalProc(p);
  procs.length = 0;
  // An isolated run's ORCA_HOME held nothing but that run's hub state.
  if (TEMP_HOME && !keep) {
    rmSync(TEMP_HOME, { recursive: true, force: true });
    TEMP_HOME = null;
  }
}

/* ── Entry ────────────────────────────────────────────────────────── */

const runDirectly = (process.argv[1] ?? '').endsWith('visual.ts');
if (runDirectly) {
  process.on('SIGINT', () => { shutdown(); process.exit(130); });
  process.on('SIGTERM', () => { shutdown(); process.exit(143); });
  main()
    .then(() => { if (!keep) { shutdown(); process.exit(0); } })
    .catch((err) => {
      console.error('[visual] failed:', err);
      shutdown();
      process.exit(1);
    });
}
