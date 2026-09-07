/**
 * Field stress.
 *
 * The claim the field makes is that it holds a fleet nobody would want to see
 * on a deck: thousands of tiles, their lineage, their traffic. This measures
 * that claim instead of asserting it. For each size it scales the synthetic
 * fleet, opens the real console, frames everything, and reads the field's own
 * counters for three seconds flat and three seconds tilted.
 *
 *   npm run stress
 *   npx tsx test/field-stress.ts 24,600      just those sizes
 *   npx tsx test/field-stress.ts --headed    watch it happen
 *   npx tsx test/field-stress.ts --keep      leave the servers up afterwards
 *
 * It reuses a hub and a Vite already on their ports, which is almost always
 * the case while developing. That also means the hub may still be holding
 * agents from another collector, so the table reports the number the field is
 * really drawing, not the number we asked for.
 */

import type { ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { sleep, until } from './harness.ts';
import {
  ensureServers, GPU_ARGS, hubPort, newPage, open, SHOTS, shutdown, signalProc, spawnProc, uiPort, waitForFleet,
} from './visual.ts';

const SIZES = [24, 120, 600, 3000];
const MEASURE_MS = 3000;
const SAMPLE_MS = 250;

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const keep = args.includes('--keep');
const sizes = (args.find((a) => !a.startsWith('--')) ?? '')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

interface Row {
  target: number;
  agents: number;
  drawn: number;
  pipes: number;
  fpsFlat: number;
  fpsTilt: number;
  dom: number;
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const { hubWasUp } = await ensureServers({ fleet: false });
  if (hubWasUp) {
    console.log('[stress] the hub was already up: its existing agents count toward every row');
  }

  const browser = await chromium.launch({ headless: !headed, args: GPU_ARGS });
  const rows: Row[] = [];
  try {
    for (const n of (sizes.length ? sizes : SIZES)) {
      rows.push(await run(browser, n));
    }
  } finally {
    await browser.close();
  }

  table(rows);
  console.log(`\n[stress] frames in ${SHOTS}`);
  if (keep) {
    console.log('[stress] --keep: servers still up. Ctrl-C to stop.');
    await new Promise(() => { /* hold */ });
  }
}

async function run(browser: import('playwright').Browser, target: number): Promise<Row> {
  console.log(`\n[stress] ${target} agents`);
  const fleet = spawnProc('fleet', 'npx', [
    'tsx', 'test/fake-collector.ts',
    `--hub=ws://127.0.0.1:${hubPort()}`, `--agents=${target}`, '--quiet',
  ]);

  const page = await newPage(browser, 1600, 1000);
  try {
    await open(page, `http://127.0.0.1:${uiPort()}/?noboot=1`);
    await waitForFleet(page, 3, 30_000);

    const want = Math.floor(target * 0.8);
    const full = await until(
      async () => (await page.evaluate(() => window.__orca?.stats().agents ?? 0)) >= want,
      180_000, 500,
    );
    if (!full) console.warn(`  [warn] never reached ${want} agents; measuring what arrived`);

    // Windows the console reopens from a previous session are not part of the
    // measurement; the field is.
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('.win [data-w-close]').forEach((b) => b.click());
      window.__orca?.frame();
    });
    await sleep(2500);

    const fpsFlat = await measure(page);
    await page.screenshot({ path: join(SHOTS, `stress-${target}.png`) });

    await page.evaluate(() => window.__orca?.tilt(true));
    await sleep(1800);
    const fpsTilt = await measure(page);
    await page.evaluate(() => window.__orca?.tilt(false));

    const s = await page.evaluate(() => ({
      ...(window.__orca?.stats() ?? { agents: 0, drawn: 0, segments: 0, fps: 0 }),
      dom: document.querySelectorAll('*').length,
    }));
    const row: Row = {
      target, agents: s.agents, drawn: s.drawn, pipes: s.segments,
      fpsFlat, fpsTilt, dom: s.dom,
    };
    console.log(`  ${row.agents} agents · ${row.drawn} drawn · ${row.pipes} pipes · ${row.fpsFlat} fps flat · ${row.fpsTilt} fps tilt · ${row.dom} DOM`);
    return row;
  } finally {
    await page.context().close();
    await kill(fleet);
  }
}

/** Mean of the field's own fps counter, sampled while nothing else happens. */
async function measure(page: import('playwright').Page): Promise<number> {
  const samples: number[] = [];
  for (let t = 0; t < MEASURE_MS; t += SAMPLE_MS) {
    await sleep(SAMPLE_MS);
    samples.push(await page.evaluate(() => window.__orca?.stats().fps ?? 0));
  }
  if (!samples.length) return 0;
  return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
}

async function kill(p: ChildProcess): Promise<void> {
  if (p.exitCode !== null || p.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => { if (!settled) { settled = true; resolve(); } };
    p.once('exit', done);
    signalProc(p, 'SIGTERM');
    setTimeout(() => { signalProc(p, 'SIGKILL'); done(); }, 4000).unref?.();
  });
  // The hub needs a beat to notice the machines left before the next size lands.
  await sleep(1500);
}

function table(rows: Row[]) {
  const head = ['target', 'agents', 'drawn', 'pipes', 'fps flat', 'fps tilt', 'DOM nodes'];
  const body = rows.map((r) => [r.target, r.agents, r.drawn, r.pipes, r.fpsFlat, r.fpsTilt, r.dom].map(String));
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padStart(w[i]!)).join('  ');
  console.log('');
  console.log(line(head));
  console.log(w.map((n) => '─'.repeat(n)).join('  '));
  for (const b of body) console.log(line(b));
}

process.on('SIGINT', () => { shutdown(); process.exit(130); });
process.on('SIGTERM', () => { shutdown(); process.exit(143); });

main()
  .then(() => { if (!keep) { shutdown(); process.exit(0); } })
  .catch((err) => {
    console.error('[stress] failed:', err);
    shutdown();
    process.exit(1);
  });
