/**
 * MEMORIA, fotografiada en la ventana HYGIENE.
 *
 *   npx tsx test/hyg-memory.shots.ts            reutiliza el hub y el vite que haya
 *   npx tsx test/hyg-memory.shots.ts --headed   verlo pasar
 *
 * Este arnés existe por una captura de pantalla. La fila decía
 * `≤47G of 48G` con la barra casi llena en una máquina con nueve gigas
 * libres: un techo honesto, marcado como techo, y aun así la cifra que un
 * operador lee como una emergencia. El techo salía de `total - free`, y en
 * macOS eso cuenta como ocupada toda la caché de archivos.
 *
 * Lo que se comprueba aquí es lo que la ventana tiene que enseñar para que
 * esa lectura no vuelva: que MEMORY es lo comprometido y va sin marca porque
 * está medido, que la caché tiene su propia fila y dice que se devuelve a
 * demanda, que el swap está a la vista porque es lo que decide si la presión
 * es real, y que la barra dibuja lo comprometido — una barra casi llena con
 * nueve gigas libres es la foto del error.
 *
 * Los números son los de la máquina de la captura, leídos con vm_stat.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { HygieneReport } from '../src/shared/hygiene.ts';
import { GPU_ARGS, ROOT, SHOTS, ensureServers, fontsReady, orcaToken, shutdown, uiPort } from './visual.ts';

const headed = process.argv.includes('--headed');
const keep = process.argv.includes('--keep');

const GiB = 1024 ** 3;

function report(): HygieneReport {
  const now = Date.now();
  const r = (v: number, note?: string) => ({ value: v, confidence: 'measured' as const, ...(note ? { note } : {}) });
  return {
    machineId: 'm_shot', hostname: 'mac-cascabel', platform: 'darwin',
    at: now, tookMs: 180, home: '/Users/dan',
    volumes: [{ path: '~', totalBytes: r(1_000_000_000_000), freeBytes: r(220_000_000_000), orcaBytes: r(9_400_000_000) }],
    categories: [
      { category: 'transcripts', roots: ['~/.claude/projects'], bytes: r(7_100_000_000), files: r(41_200), newestAt: now, oldestAt: now - 90 * 86_400_000, coverage: { maxDepth: 6, maxEntries: 200_000, entries: 41_200, truncated: false, deadline: false } },
    ] as unknown as HygieneReport['categories'],
    processes: [],
    cpuPct: r(24),
    // vm_stat, en la máquina de la captura: comprometido 38.7G de 48G, con
    // 7.5G de caché que el sistema devuelve en cuanto alguien la pide.
    memUsedBytes: r(41_524_248_576, 'wired + app + compressed, as vm_stat reports them'),
    memTotalBytes: r(51_539_607_552),
    memCachedBytes: r(8_041_463_808, 'in use as cache and available at the same time'),
    swapUsedBytes: r(4_466_212_864),
    swapTotalBytes: r(5_368_709_120),
    growth: null, candidates: [], limits: [],
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
    await page.evaluate((rep) => window.__orca!.hygiene([rep as never]), report() as never);
    await page.waitForTimeout(500);

    /** Las filas de LOAD, por su clave. */
    const rows = await page.locator('.win.is-hygiene .hyg__row').evaluateAll((els) => els.map((e) => ({
      k: (e.querySelector('.hyg__k')?.textContent ?? '').trim(),
      v: (e.querySelector('.hyg__v')?.textContent ?? '').trim(),
      title: e.querySelector('.hyg__v .hyg__n')?.getAttribute('title') ?? '',
      barPct: Number((e.querySelector('.hyg__bar > i') as HTMLElement | null)?.style.width.replace('%', '') ?? -1),
      sub: e.className.includes('hyg__row--sub'),
    })));
    const row = (k: string) => rows.find((x) => x.k.startsWith(k));

    /* ── Lo comprometido, medido y sin marca ──────────────────────── */

    const mem = row('MEMORY')!;
    assert.ok(mem, 'the memory row is there');
    assert.equal(mem.v, '39G of 48G', 'what is committed, and what the machine has');
    assert.ok(!mem.v.includes('≤'), 'a measurement carries no ceiling mark');
    assert.match(mem.title, /wired \+ app \+ compressed/, 'and it says what it counted');

    // El error tenía esta forma: la barra al 97% con nueve gigas libres.
    assert.ok(mem.barPct > 75 && mem.barPct < 85, `the bar draws what is committed, not the page table (${mem.barPct}%)`);

    /* ── La caché, aparte y explicada ─────────────────────────────── */

    const cached = row('CACHED')!;
    assert.ok(cached?.sub, 'cache hangs off the memory row instead of competing with it');
    assert.equal(cached.v, '7.5G');
    assert.match(cached.k, /RETURNED ON DEMAND/, 'the row says why it is not counted as used');

    /* ── El swap, que es lo que dice si la presión es real ────────── */

    const swap = row('SWAP')!;
    assert.equal(swap.v, '4.2G of 5.0G');

    // Y las dos cifras siguen cabiendo en la máquina.
    assert.ok(41_524_248_576 + 8_041_463_808 < 48 * GiB, 'committed plus cache fits in 48G');

    await mkdir(SHOTS, { recursive: true });
    const box = (await page.locator('.win.is-hygiene').boundingBox())!;
    await page.screenshot({ path: join(SHOTS, 'hyg-memory.png'), clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: Math.min(900 - box.y + 8, box.height + 16) } });

    /* ── Y un informe de un collector viejo no inventa filas ──────── */

    await page.evaluate((rep) => {
      const old = JSON.parse(JSON.stringify(rep)) as Record<string, unknown>;
      delete old['memCachedBytes']; delete old['swapUsedBytes']; delete old['swapTotalBytes'];
      window.__orca!.hygiene([old as never]);
    }, report() as never);
    await page.waitForTimeout(300);
    const keys = await page.locator('.win.is-hygiene .hyg__row .hyg__k').allTextContents();
    assert.ok(!keys.some((k) => k.startsWith('CACHED') || k.startsWith('SWAP')),
      'no reading, no row: a zero there would say the machine has no cache');

    assert.deepEqual(errors, []);
    console.log(`MEMORY: committed, cache and swap read as three facts.\n${join(SHOTS, 'hyg-memory.png')}`);
  } finally {
    await browser.close();
    if (!keep) shutdown();
  }
}

void ROOT;
await main();
