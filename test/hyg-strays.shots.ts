/**
 * STRAYS, fotografiado dentro de la ventana HYGIENE.
 *
 *   npx tsx test/hyg-strays.shots.ts            reutiliza el hub y el vite que haya
 *   npx tsx test/hyg-strays.shots.ts --headed   verlo pasar
 *
 * Lo que se comprueba es lo que un panel que termina procesos tiene que
 * cumplir para poder confiarse: que la lista distingue las tres clases con su
 * marca, que **sólo lo huérfano lleva botón**, que la evidencia de cada fila se
 * puede abrir y leer, y que lo protegido dice por qué se le dejó en paz. Una
 * foto en la que todo tuviera botón sería una foto de un panel peligroso.
 *
 * El informe se inyecta en el store por el gancho `__orca`: una máquina de
 * pruebas no tiene por qué tener restos, y menos los cinco que hacen falta
 * para ver las tres clases a la vez.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { HygieneReport } from '../src/shared/hygiene.ts';
import { GPU_ARGS, ROOT, SHOTS, ensureServers, fontsReady, orcaToken, shutdown, uiPort } from './visual.ts';

const headed = process.argv.includes('--headed');
const keep = process.argv.includes('--keep');

function report(): HygieneReport {
  const now = Date.now();
  const r = (v: number) => ({ value: v, confidence: 'measured' as const });
  return {
    machineId: 'm_shot', hostname: 'mac-cascabel', platform: 'darwin',
    at: now, tookMs: 180, home: '/Users/dan',
    volumes: [{ path: '~', totalBytes: r(1_000_000_000_000), freeBytes: r(220_000_000_000), orcaBytes: r(9_400_000_000) }],
    categories: [
      { category: 'transcripts', roots: ['~/.claude/projects'], bytes: r(7_100_000_000), files: r(41_200), newestAt: now, oldestAt: now - 90 * 86_400_000, coverage: { maxDepth: 6, maxEntries: 200_000, entries: 41_200, truncated: false, deadline: false } },
      { category: 'logs', roots: ['~/.orca/logs'], bytes: r(1_200_000_000), files: r(380), newestAt: now, oldestAt: now - 30 * 86_400_000, coverage: { maxDepth: 6, maxEntries: 200_000, entries: 380, truncated: false, deadline: false } },
    ] as unknown as HygieneReport['categories'],
    processes: [], cpuPct: r(24), memUsedBytes: r(19_000_000_000), memTotalBytes: r(36_000_000_000),
    growth: null, candidates: [], limits: [],
    strays: [
      {
        id: 'stray_vite_4321', kind: 'vite', verdict: 'orphan', action: 'terminate',
        label: 'vite · :4478', pid: 4321, ppid: 1, startedAt: now - 5 * 3_600_000,
        ports: [4478], cwd: '~/projects/orca',
        evidence: [
          'working directory is this repository (~/projects/orca)',
          'ORCA launched it from npm run dev (pid 900), which is gone, and its lease has not been renewed for 14m',
        ],
      },
      {
        id: 'stray_orca_777', kind: 'orca', verdict: 'orphan', action: 'terminate',
        label: 'orca · src/hub/server.ts', pid: 777, ppid: 1, startedAt: now - 2 * 3_600_000,
        cwd: '~/projects/orca',
        evidence: ["runs ORCA's src/hub/server.ts", 'ORCA launched it from npm run dev (pid 900), which is gone, and its lease has not been renewed for 31m'],
      },
      {
        // Sesión detenida, proceso vivo: el resto que faltaba el 2026-09-13. Ver shared/reap.ts.
        id: 'stray_session_208fd608', kind: 'session', verdict: 'orphan', action: 'terminate',
        label: 'K9 · done · 612M retained', agentId: '208fd608', pid: 36_570, startedAt: now - 3 * 3_600_000,
        rssBytes: 612 * 1024 * 1024,
        evidence: [
          'ORCA launched K9 (verified by the spawn record)',
          'pid 36570 runs claude, observed as the pid of its own ORCA pane',
          'its pane orca-208fd608 is gone and the CLI no longer lists the session',
          'pid 36570 still has the start time and command line ORCA recorded',
        ],
      },
      {
        id: 'stray_agent_a9', kind: 'agent', verdict: 'orphan', action: 'retire',
        label: 'Z2 · working', agentId: 'sess_a9', pid: 51_200,
        evidence: [
          'its transcript is frozen at "working"',
          'the CLI does not list the session any more',
          'pid 51200 is not running',
          'it has no tmux pane',
        ],
      },
      {
        id: 'stray_vite_62458', kind: 'vite', verdict: 'ambiguous', action: 'none',
        label: 'vite · :5173', pid: 62_458, ppid: 62_392, startedAt: now - 900_000,
        ports: [5173], cwd: '~/projects/orca',
        evidence: ['working directory is this repository (~/projects/orca)', 'parent 62392 is alive (concurrently)'],
        why: 'something launched it and is still there: it is somebody\'s dev server, not a leftover',
      },
      {
        id: 'stray_vite_5150', kind: 'vite', verdict: 'ambiguous', action: 'none',
        label: 'vite · :5199', pid: 5_150, ppid: 1, startedAt: now - 4 * 3_600_000,
        ports: [5199], cwd: '~/projects/orca',
        evidence: ['working directory is this repository (~/projects/orca)', 'no parent, and no ORCA lease naming it'],
        why: 'ORCA did not start this, so it cannot tell whether it is wanted.'
          + ' Running with no parent is what nohup, setsid and disown all leave behind',
      },
      {
        id: 'stray_vite_19478', kind: 'vite', verdict: 'protected', action: 'none',
        label: 'vite · :4003', pid: 19_478, ppid: 1, startedAt: now - 22 * 3_600_000,
        ports: [4003], cwd: '~/projects/dijosi',
        evidence: ['working directory is ~/projects/dijosi'],
        why: 'a dev server for another project: never ORCA\'s to stop',
      },
    ],
  };
}

async function main() {
  await ensureServers();
  const browser = await chromium.launch({ headless: !headed, args: GPU_ARGS });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.addInitScript('window.__name = (fn) => fn');
    await page.goto(`http://127.0.0.1:${uiPort()}/?noboot=1&k=${encodeURIComponent(orcaToken())}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__orca, null, { timeout: 60_000 });
    await fontsReady(page);

    await page.evaluate(() => window.__orca!.openHygiene());
    await page.waitForSelector('.win.is-hygiene', { timeout: 10_000 });
    await page.evaluate((r) => window.__orca!.hygiene([r as never]), report() as never);
    await page.waitForTimeout(500);

    /* ── Las tres clases, y sólo una con botón ────────────────────── */

    const rows = await page.locator('.hyg__stray').evaluateAll((els) => els.map((e) => ({
      id: (e as HTMLElement).dataset.stray ?? '',
      cls: e.className,
      mark: e.querySelector('.hyg__stray-mark')?.textContent ?? '',
      name: e.querySelector('.hyg__stray-name')?.textContent ?? '',
      where: e.querySelector('.hyg__stray-where')?.textContent ?? '',
      act: e.querySelector('.hyg__stray-act')?.textContent ?? null,
    })));
    assert.equal(rows.length, 7, 'every stray is shown, including the ones it will not touch');
    const by = (id: string) => rows.find((r) => r.id === id)!;

    assert.equal(by('stray_vite_4321').mark, '!', 'an orphan is marked');
    assert.equal(by('stray_vite_4321').act, 'STOP IT');
    assert.equal(by('stray_agent_a9').act, 'RETIRE', 'a registry ghost is retired, never "killed"');
    assert.equal(by('stray_vite_62458').mark, '?');
    assert.equal(by('stray_vite_62458').act, null, 'an ambiguous one is shown and never offered');
    assert.equal(by('stray_vite_19478').mark, '·');
    assert.equal(by('stray_vite_19478').act, null, 'another project is never offered either');
    assert.match(by('stray_vite_19478').where, /dijosi/, 'and the panel says whose it is');
    assert.match((await page.locator('.hyg__stray-all').textContent()) ?? '', /CLEAN 4/, 'the bulk action counts only the orphans');

    // La cifra que habría hecho innecesaria la investigación: cuánto retienen las sesiones detenidas.
    assert.equal(by('stray_session_208fd608').mark, '!');
    assert.equal(by('stray_session_208fd608').act, 'STOP IT', 'a stopped session with a live process is offered like any orphan');
    assert.match(by('stray_session_208fd608').name, /612M retained/, 'and its cost is on the label');
    assert.match((await page.locator('[data-retained]').innerText()), /1 STOPPED SESSION RETAIN 612M/, 'the header sums what stopped sessions retain');

    // El caso que cerró el agujero: sin padre y sin lease, se enseña y no se toca.
    assert.equal(by('stray_vite_5150').mark, '?');
    assert.equal(by('stray_vite_5150').act, null, 'a nohup dev server of this repo is never offered');

    // El orden: primero lo que se decide.
    assert.deepEqual(rows.map((r) => r.cls.includes('is-orphan') ? 'o' : r.cls.includes('is-ambiguous') ? 'a' : 'p'),
      ['o', 'o', 'o', 'o', 'a', 'a', 'p'], 'orphans first: the list is read from the top');

    await mkdir(SHOTS, { recursive: true });
    const box = (await page.locator('.win.is-hygiene').boundingBox())!;
    await page.screenshot({ path: join(SHOTS, 'hyg-strays.png'), clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: Math.min(900 - box.y + 8, box.height + 16) } });

    /* ── La evidencia se puede leer, y lo protegido dice por qué ──── */

    await page.locator('.hyg__stray[data-stray="stray_vite_4321"] .hyg__stray-head').click();
    await page.waitForTimeout(250);
    const why = await page.locator('.hyg__stray[data-stray="stray_vite_4321"] .hyg__stray-why').innerText();
    assert.match(why, /working directory is this repository/);
    assert.match(why, /ORCA launched it from npm run dev/, 'the licence to stop it is named');

    await page.locator('.hyg__stray[data-stray="stray_vite_19478"] .hyg__stray-head').click();
    await page.locator('.hyg__stray[data-stray="stray_vite_5150"] .hyg__stray-head').click();
    await page.waitForTimeout(250);
    const kept = await page.locator('.hyg__stray[data-stray="stray_vite_19478"] .hyg__stray-kept').innerText();
    const unsure = await page.locator('.hyg__stray[data-stray="stray_vite_5150"] .hyg__stray-kept').innerText();
    assert.match(kept, /another project/, 'a decision not to act is auditable too');
    assert.match(unsure, /nohup/, 'and so is a decision that ORCA cannot make at all');

    await page.screenshot({ path: join(SHOTS, 'hyg-strays-why.png'), clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: Math.min(900 - box.y + 8, box.height + 16) } });

    /* ── Y no tapa el informe de disco ────────────────────────────── */

    const geo = await page.evaluate(() => {
      const b = (s: string) => document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null;
      return { strays: b('.hyg__strays'), list: b('.win__scroll') };
    }) as Record<string, DOMRect | null>;
    assert.ok(geo.strays && geo.list && geo.strays.bottom <= geo.list.top + 1, 'the disk report keeps its place below');

    assert.deepEqual(errors, []);
    console.log(`STRAYS: three verdicts, one action, evidence and geometry passed.\n${join(SHOTS, 'hyg-strays.png')}`);
  } finally {
    await browser.close();
    if (!keep) shutdown();
  }
}

void ROOT;
await main();
