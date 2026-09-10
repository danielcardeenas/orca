/**
 * Hygiene: the numbers, and how honest they are about themselves.
 *
 * The sampler runs against a real directory tree in a temp home — real
 * `readdir`, real `lstat`, real sizes — because the bugs worth catching here
 * are arithmetic and boundary bugs, and a mocked filesystem would agree with
 * whatever the code believed. Nothing in this suite reads or writes the
 * operator's own `~/.claude` or `~/.orca`: every test sets `CLAUDE_CONFIG_DIR`
 * and `ORCA_HOME` at its own fixture and puts them back afterwards.
 *
 * What is actually being defended:
 *
 *  - a budget that runs out must produce a *floor* that says it is one, never
 *    a total that quietly under-reports;
 *  - a bound must point the way it actually points. A truncated walk is a
 *    floor (`≥`); memory-in-use on macOS is a ceiling (`≤`), because it counts
 *    cache the system hands straight back. Marking both with the same symbol
 *    told the reader the opposite of the truth about one of them, and the
 *    algebra tests exist so that cannot come back;
 *  - a derivation must refuse to invent a bound. Two floors do not subtract to
 *    a floor — `a ≥ 100` and `b ≥ 90` says nothing at all about `a − b` — so
 *    growth from a truncated sample comes back `unavailable` with the reason,
 *    never a plausible number wearing a mark it did not earn;
 *  - recovery, handoffs and history must never be offered for reclaiming,
 *    however old and however large;
 *  - growth must be growth, and it must not exist at all until there are two
 *    samples to derive it from;
 *  - a report crossing the wire must lose an absolute path rather than carry
 *    the operator's name into a console.
 */

import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HygieneSampler, candidatesFrom, etimeToStart, roots, type WalkResult } from '../src/collector/hygiene.ts';
import { HygieneRegistry, sanitizeReport } from '../src/hub/hygiene.ts';
import {
  approximate, atLeast, atMost, diffReadings, formatBytes, formatReading, isProtected,
  measured, orcaTotal, reclaimable, redactHome, scaleReading, sumReadings, unavailable,
  type Confidence, type HygieneReport, type Reading,
} from '../src/shared/hygiene.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const DAY = 86_400_000;

/* ── A machine in a box ───────────────────────────────────────────── */

interface Fixture { home: string; claude: string; orca: string; cleanup(): void }

/**
 * A temp home with the shape of a real one: transcripts, a cold project, a
 * cache nobody has touched, backups, and the recovery files that must survive
 * every rule this module has.
 */
function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'orca-hyg-'));
  const claude = join(home, '.claude');
  const orca = join(home, '.orca');
  const now = Date.now();

  const file = (p: string, bytes: number, ageDays = 0) => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, Buffer.alloc(bytes, 0x61));
    if (ageDays > 0) {
      const t = (now - ageDays * DAY) / 1000;
      utimesSync(p, t, t);
    }
  };

  // Transcripts: one project written today, one cold for 90 days and big.
  file(join(claude, 'projects', '-srv-live', 'a.jsonl'), 4096);
  file(join(claude, 'projects', '-srv-cold', 'a.jsonl'), 12 * 1024 * 1024, 90);
  file(join(claude, 'projects', '-srv-cold', 'b.jsonl'), 6 * 1024 * 1024, 91);
  // Small and cold: under the size floor, so never a candidate.
  file(join(claude, 'projects', '-srv-tiny', 'a.jsonl'), 900, 200);

  // Scratch: a cache nobody has touched in a fortnight.
  file(join(claude, 'paste-cache', 'old', 'x.bin'), 9 * 1024 * 1024, 14);
  // Backups, cold and big.
  file(join(claude, 'backups', '2026-06', 'b.tar'), 20 * 1024 * 1024, 120);

  // The insurance. Big, ancient, and never a candidate.
  file(join(orca, 'history.jsonl'), 25 * 1024 * 1024, 400);
  file(join(orca, 'recovery-images', 'old', 'img.bin'), 40 * 1024 * 1024, 400);
  file(join(orca, 'capcom', 'handoffs', 'h.json'), 10 * 1024 * 1024, 400);
  file(join(orca, 'worker-recovery', 'handoffs', 'w.json'), 10 * 1024 * 1024, 400);
  // Logs and artifacts.
  file(join(orca, 'hub', 'events', '2026-01-01.jsonl'), 3 * 1024 * 1024, 60);
  file(join(orca, 'artifacts', 'old', 'shot.png'), 11 * 1024 * 1024, 40);

  return {
    home, claude, orca,
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

/** Run `fn` with the environment pointed at a fixture, then put it all back. */
async function withFixture<T>(fn: (f: Fixture) => Promise<T> | T): Promise<T> {
  const f = fixture();
  const saved = {
    claude: process.env['CLAUDE_CONFIG_DIR'],
    orca: process.env['ORCA_HOME'],
    codex: process.env['ORCA_CODEX_SESSIONS'],
    home: process.env['HOME'],
  };
  process.env['CLAUDE_CONFIG_DIR'] = f.claude;
  process.env['ORCA_HOME'] = f.orca;
  process.env['ORCA_CODEX_SESSIONS'] = join(f.home, '.codex', 'sessions');
  process.env['HOME'] = f.home;
  try {
    return await fn(f);
  } finally {
    const put = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    put('CLAUDE_CONFIG_DIR', saved.claude);
    put('ORCA_HOME', saved.orca);
    put('ORCA_CODEX_SESSIONS', saved.codex);
    put('HOME', saved.home);
    f.cleanup();
  }
}

const sampler = (over: Record<string, unknown> = {}) => new HygieneSampler({
  machineId: 'm_test', hostname: 'fixture', ...over,
} as ConstructorParameters<typeof HygieneSampler>[0]);

function categoryBytes(r: HygieneReport, cat: string): number {
  return r.categories.find((c) => c.category === cat)?.bytes.value ?? 0;
}

/* ── A report built by hand, for the hub-side tests ───────────────── */

function report(over: Partial<HygieneReport> = {}): HygieneReport {
  return {
    machineId: 'm1', hostname: 'box', platform: 'darwin', at: 1000, tookMs: 12, home: '~',
    volumes: [{ path: '~/.orca', totalBytes: measured(1000), freeBytes: measured(400), orcaBytes: measured(300) }],
    categories: [
      { category: 'transcripts', roots: ['~/.claude/projects'], bytes: measured(200), files: measured(4), newestAt: 900, oldestAt: 100, coverage: { visited: 4, skipped: 0, truncated: false, maxDepth: 6, maxEntries: 100, tookMs: 1 } },
      { category: 'logs', roots: ['~/.orca/hub/events'], bytes: measured(100), files: measured(2), newestAt: 900, oldestAt: 100, coverage: { visited: 2, skipped: 0, truncated: false, maxDepth: 6, maxEntries: 100, tookMs: 1 } },
    ],
    processes: [], cpuPct: measured(12), memUsedBytes: measured(500), memTotalBytes: measured(2000),
    growth: null,
    candidates: [{ id: 'c1', category: 'transcripts', path: '~/.claude/projects/-srv-cold', bytes: measured(150), files: 2, newestAt: 100, reason: 'cold' }],
    limits: [],
    ...over,
  };
}

export default {
  suite: 'hygiene',
  tests: [
    /* ── The sampler, against a real tree ───────────────────────── */

    test('the sampler measures a real tree and puts every byte in a category', () => withFixture(async () => {
      const r = await sampler().sample();
      const transcripts = categoryBytes(r, 'transcripts');
      const recovery = categoryBytes(r, 'recovery');
      // 12M + 6M + 4096 + 900 of transcripts, 85M of recovery.
      const wantT = 18 * 1024 * 1024 + 4096 + 900;
      const wantR = 85 * 1024 * 1024;
      const total = orcaTotal(r).value ?? 0;
      return ok('every byte landed in a category',
        transcripts === wantT && recovery === wantR && total > wantT + wantR
        && r.categories.every((c) => c.bytes.confidence === 'measured'),
        `transcripts=${formatBytes(transcripts)} (want ${formatBytes(wantT)}) recovery=${formatBytes(recovery)} total=${formatBytes(total)}`);
    })),

    test('a walk that runs out of budget reports a floor, not a total', () => withFixture(async () => {
      const full = await sampler().sample();
      const cut = await sampler({ maxEntries: 3 }).sample();
      const cutTotal = orcaTotal(cut);
      const fullTotal = orcaTotal(full);
      const saysSo = cut.categories.some((c) => c.coverage.truncated)
        && cut.categories.every((c) => c.bytes.confidence === 'atLeast')
        && cut.limits.some((l) => l.includes('floor'));
      return ok('a truncated walk says it is a floor',
        saysSo && (cutTotal.value ?? 0) <= (fullTotal.value ?? 0) && formatReading(cutTotal).startsWith('≥'),
        `cut=${formatReading(cutTotal)} full=${formatReading(fullTotal)} truncated=${cut.categories.some((c) => c.coverage.truncated)}`);
    })),

    test('the sampler is cached, and force is the way past it', () => withFixture(async () => {
      const s = sampler({ cacheMs: 60_000 });
      const a = await s.sample();
      const b = await s.sample();
      const c = await s.sample({ force: true });
      return ok('cached until forced', a.at === b.at && c.at >= a.at && c !== b,
        `a.at=${a.at} b.at=${b.at} forced=${c.at}`);
    })),

    test('the whole sample is cheap enough to sit behind a panel refresh', () => withFixture(async () => {
      const r = await sampler().sample();
      const visited = r.categories.reduce((a, c) => Math.max(a, c.coverage.visited), 0);
      return ok('a bounded walk costs milliseconds', r.tookMs < 1500 && visited > 0,
        `${r.tookMs}ms over ${visited} entries`);
    })),

    /* ── Candidates ─────────────────────────────────────────────── */

    test('cold and big is a candidate; cold and small is not', () => withFixture(async () => {
      const r = await sampler().sample();
      const paths = r.candidates.map((c) => c.path);
      const cold = paths.some((p) => p.endsWith('-srv-cold'));
      const tiny = paths.some((p) => p.endsWith('-srv-tiny'));
      const live = paths.some((p) => p.endsWith('-srv-live'));
      return ok('both size and staleness are required', cold && !tiny && !live,
        `candidates: ${paths.join(', ') || 'none'}`);
    })),

    test('recovery, handoffs and history are never candidates', () => withFixture(async () => {
      const r = await sampler().sample();
      const leaked = r.candidates.filter((c) => c.category === 'recovery' || isProtected(c.path));
      // …and they are big and ancient in the fixture, so nothing but the rule saves them.
      const recoveryBytes = categoryBytes(r, 'recovery');
      return ok('the insurance is never offered',
        leaked.length === 0 && recoveryBytes > 80 * 1024 * 1024,
        `${formatBytes(recoveryBytes)} of recovery on disk, ${leaked.length} of it offered`);
    })),

    test('a candidate carries its size, its age and a reason a person can judge', () => withFixture(async () => {
      const r = await sampler().sample();
      const c = r.candidates.find((x) => x.path.endsWith('-srv-cold'));
      if (!c) return ok('the cold project is a candidate', false, 'it was not offered at all');
      const days = c.newestAt === null ? 0 : Math.floor((Date.now() - c.newestAt) / DAY);
      return ok('a candidate explains itself',
        (c.bytes.value ?? 0) === 18 * 1024 * 1024 && c.files === 2 && days >= 89 && /days/.test(c.reason)
        && !c.path.startsWith('/'),
        `${c.path} ${formatBytes(c.bytes.value)} ${c.files} files · ${c.reason}`);
    })),

    test('the protected list is prefix-matched, not substring-matched', () => {
      const cases: [string, boolean][] = [
        ['~/.orca/history.jsonl', true],
        ['~/.orca/recovery-images', true],
        ['~/.orca/recovery-images/2026-01', true],
        ['~/.orca/recovery-images-old', false],
        ['~/.orca/artifacts', false],
        ['~/.claude/projects/-srv-cold', false],
      ];
      const wrong = cases.filter(([p, want]) => isProtected(p) !== want).map(([p]) => p);
      return ok('protection covers the tree and nothing beside it', wrong.length === 0,
        wrong.length ? `wrong for ${wrong.join(', ')}` : `${cases.length} paths`);
    }),

    test('candidatesFrom refuses to offer anything under recovery', () => {
      const found: WalkResult = {
        bytes: 0, files: 0, newestAt: null, oldestAt: null,
        children: new Map([['old', { bytes: 500 * 1024 * 1024, files: 3, newestAt: 0 }]]),
      };
      const opts = { minCandidateBytes: 1, staleDays: 1, scratchStaleDays: 1 };
      const asRecovery = candidatesFrom('recovery', '/h/.orca/recovery-images', found, '/h', Date.now(), opts);
      const asScratch = candidatesFrom('scratch', '/h/.claude/cache', found, '/h', Date.now(), opts);
      return ok('the category is a gate, and so is the path',
        asRecovery.length === 0 && asScratch.length === 1 && asScratch[0]!.path === '~/.claude/cache/old',
        `recovery=${asRecovery.length} scratch=${asScratch.length}`);
    }),

    /* ── Growth ─────────────────────────────────────────────────── */

    test('growth needs two samples, and never claims to be writes', () => withFixture(async () => {
      let clock = 1_000_000;
      const s = sampler({ cacheMs: 0, now: () => clock });
      const first = await s.sample({ force: true });
      clock += 60_000;
      // Grow the tree between the samples, by a known amount.
      writeFileSync(join(process.env['CLAUDE_CONFIG_DIR']!, 'projects', '-srv-live', 'grew.jsonl'), Buffer.alloc(1024 * 1024));
      const second = await s.sample({ force: true });
      const g = second.growth;
      const named = second.limits.some((l) => l.includes('not measurable') && l.includes('net file growth'));
      // Both walks were whole, so the difference is exact — not a floor.
      return ok('the second sample knows what the first held',
        first.growth === null && !!g && g.windowMs === 60_000
        && (g.netBytes.value ?? 0) === 1024 * 1024 && g.netBytes.confidence === 'measured' && named,
        `first=${first.growth} net=${formatBytes(g?.netBytes.value ?? null)} (${g?.netBytes.confidence}) window=${g?.windowMs}ms`);
    })),

    /* ── Readings ───────────────────────────────────────────────── */

    /* ── The bound algebra ──────────────────────────────────────── */

    test('a sum keeps a bound that is still true of the sum', () => {
      const cases: [string, Reading, Confidence, number | null][] = [
        ['exact + exact', sumReadings([measured(10), measured(5)]), 'measured', 15],
        ['floor + exact', sumReadings([measured(10), atLeast(5, 'cut')]), 'atLeast', 15],
        ['ceiling + exact', sumReadings([measured(10), atMost(5, 'cache')]), 'atMost', 15],
        // A floor and a ceiling together bound the sum in neither direction.
        ['floor + ceiling', sumReadings([atLeast(10, 'cut'), atMost(5, 'cache')]), 'approximate', 15],
        ['floor + floor', sumReadings([atLeast(10, 'cut'), atLeast(5, 'cut')]), 'atLeast', 15],
        ['anything + approximate', sumReadings([measured(10), approximate(5, 'guess')]), 'approximate', 15],
        // A size we could not measure can only add, so what we have is a floor.
        ['exact + missing size', sumReadings([measured(10), unavailable('no statfs')]), 'atLeast', 10],
        // …but a signed term could go either way, so it bounds nothing.
        ['signed + missing', sumReadings([measured(10), unavailable('gone')], { nonNegative: false }), 'approximate', 10],
        ['nothing known', sumReadings([unavailable('a'), unavailable('b')]), 'unavailable', null],
      ];
      const wrong = cases.filter(([, r, want, val]) => r.confidence !== want || r.value !== val);
      return ok('addition never invents a bound it cannot keep', wrong.length === 0,
        wrong.length
          ? wrong.map(([n, r, want]) => `${n}: got ${r.confidence} want ${want}`).join(' · ')
          : cases.map(([n, r]) => `${n}=${r.confidence}`).join(' · '));
    }),

    test('subtraction refuses to turn two floors into a floor', () => {
      const note = 'cut short';
      // The case that started this: a ≥ 100 and b ≥ 90 says nothing about a − b.
      // It could be 10, or 900, or −80.
      const twoFloors = diffReadings(atLeast(100, note), atLeast(90, note), note);
      const cases: [string, Reading, Confidence, number | null][] = [
        ['exact − exact', diffReadings(measured(100), measured(90), note), 'measured', 10],
        ['floor − exact', diffReadings(atLeast(100, note), measured(90), note), 'atLeast', 10],
        // The subtrahend can only grow, so the difference can only shrink.
        ['exact − floor', diffReadings(measured(100), atLeast(90, note), note), 'atMost', 10],
        ['ceiling − exact', diffReadings(atMost(100, note), measured(90), note), 'atMost', 10],
        ['exact − ceiling', diffReadings(measured(100), atMost(90, note), note), 'atLeast', 10],
        ['floor − floor', twoFloors, 'unavailable', null],
        ['ceiling − ceiling', diffReadings(atMost(100, note), atMost(90, note), note), 'unavailable', null],
        // Same direction on opposite sides survives: a floor minus a ceiling is a floor.
        ['floor − ceiling', diffReadings(atLeast(100, note), atMost(90, note), note), 'atLeast', 10],
        ['ceiling − floor', diffReadings(atMost(100, note), atLeast(90, note), note), 'atMost', 10],
        ['approximate anywhere', diffReadings(measured(100), approximate(90, 'guess'), note), 'unavailable', null],
        ['missing anywhere', diffReadings(unavailable('gone'), measured(90), note), 'unavailable', null],
      ];
      const wrong = cases.filter(([, r, want, val]) => r.confidence !== want || r.value !== val);
      return ok('a difference keeps only a bound that survives the sign', wrong.length === 0,
        wrong.length
          ? wrong.map(([n, r, want]) => `${n}: got ${r.confidence} want ${want}`).join(' · ')
          : `${cases.length} combinations, and floor−floor is ${twoFloors.confidence}`);
    }),

    test('scaling by a negative factor flips which way the bound points', () => {
      const up = scaleReading(atLeast(10, 'cut'), 2);
      const flipped = scaleReading(atLeast(10, 'cut'), -1);
      const rate = scaleReading(measured(48), 1000 / 3000);
      return ok('a bound survives scaling, and knows when to turn around',
        up.confidence === 'atLeast' && up.value === 20
        && flipped.confidence === 'atMost' && flipped.value === -10
        && rate.confidence === 'measured' && rate.value === 16,
        `x2=${up.confidence} x-1=${flipped.confidence} rate=${rate.value}`);
    }),

    test('a truncated sample makes growth unavailable, not a floor', () => withFixture(async () => {
      let clock = 2_000_000;
      // A budget small enough that both walks stop early.
      const s = new HygieneSampler({
        machineId: 'm', hostname: 'cut', cacheMs: 0, maxEntries: 4, now: () => clock,
      } as ConstructorParameters<typeof HygieneSampler>[0]);
      await s.sample({ force: true });
      clock += 60_000;
      const second = await s.sample({ force: true });
      const g = second.growth;
      const perCategory = Object.values(g?.byCategory ?? {});
      return ok('the sampler will not subtract two floors',
        !!g && g.netBytes.confidence === 'unavailable' && g.netBytes.value === null
        && g.netBytesPerSec.confidence === 'unavailable'
        && perCategory.every((r) => r.confidence === 'unavailable')
        && (g.netBytes.note ?? '').includes('floors'),
        `net=${g?.netBytes.confidence} rate=${g?.netBytesPerSec.confidence} note=${g?.netBytes.note?.slice(0, 60)}`);
    })),

    /*
     * Memory used to be the panel's ceiling: `total - free`, marked `≤`, and
     * on darwin that counted every page of file cache as memory in use — a
     * machine with nine gigabytes free drew a nearly-full bar. The sampler now
     * asks vm_stat or /proc/meminfo what is committed, so the reading is a
     * measurement; the ceiling survives only as the fallback for a machine
     * whose tool would not answer. See collector/memory.ts and memory.test.ts.
     */
    test('memory in use is measured, and cache is not counted as used', () => withFixture(async () => {
      const r = await sampler().sample();
      const m = r.memUsedBytes;
      const supported = process.platform === 'darwin' || process.platform === 'linux';
      if (!supported) {
        return ok('an unsupported platform falls back to the ceiling and says so',
          m.confidence === 'atMost' && formatReading(m).startsWith('≤'), `${process.platform}: ${m.confidence}`);
      }
      const total = r.memTotalBytes.value ?? 0;
      return ok('what is committed, counted — not everything the machine has not handed back',
        m.confidence === 'measured' && (m.value ?? 0) > 0 && (m.value ?? 0) < total
        && (m.note ?? '').length > 0,
        `${formatReading(m)} of ${formatReading(r.memTotalBytes)} · ${m.note?.slice(0, 48)}`);
    })),

    test('cache and swap travel with the memory reading, and cache is separate from it', () => withFixture(async () => {
      const r = await sampler().sample();
      if (process.platform !== 'darwin' && process.platform !== 'linux') {
        return ok('nothing is invented where the platform will not say',
          r.memCachedBytes?.confidence === 'unavailable', process.platform);
      }
      const used = r.memUsedBytes.value ?? 0, cached = r.memCachedBytes?.value ?? 0;
      const total = r.memTotalBytes.value ?? 0;
      return ok('two rows, two facts, and they still fit in the machine',
        r.memCachedBytes?.confidence === 'measured' && cached > 0 && used + cached <= total
        && !!r.swapUsedBytes && !!r.swapTotalBytes,
        `${formatReading(r.memCachedBytes!)} cached · swap ${formatReading(r.swapUsedBytes!)}`);
    })),

    test('a candidate found by a truncated walk is a floor too', () => {
      const found: WalkResult = {
        bytes: 0, files: 0, newestAt: null, oldestAt: null,
        children: new Map([['old', { bytes: 500 * 1024 * 1024, files: 3, newestAt: 0 }]]),
      };
      const base = { minCandidateBytes: 1, staleDays: 1, scratchStaleDays: 1 };
      const whole = candidatesFrom('scratch', '/h/.claude/cache', found, '/h', Date.now(), base);
      const cut = candidatesFrom('scratch', '/h/.claude/cache', found, '/h', Date.now(), { ...base, truncated: true });
      return ok('a directory the walk did not finish holds that much or more',
        whole[0]!.bytes.confidence === 'measured' && cut[0]!.bytes.confidence === 'atLeast'
        && formatReading(cut[0]!.bytes).startsWith('≥'),
        `whole=${whole[0]!.bytes.confidence} cut=${formatReading(cut[0]!.bytes)}`);
    }),

    test('a reading prints which way it is wrong, in the text', () => {
      const cases: [string, string][] = [
        [formatReading(measured(1536)), '1.5K'],
        [formatReading(atLeast(1536, 'cut')), '≥1.5K'],
        [formatReading(atMost(1536, 'cache')), '≤1.5K'],
        [formatReading(approximate(1536, 'guess')), '~1.5K'],
        [formatReading(unavailable('no ps')), '—'],
        [formatReading(measured(12.34), 'pct'), '12.3%'],
        [formatReading(atMost(97.5, 'cache'), 'pct'), '≤97.5%'],
        [formatBytes(null), '—'],
        [formatBytes(-2048), '−2.0K'],
      ];
      const wrong = cases.filter(([got, want]) => got !== want);
      return ok('the mark is in the text, not only in the colour', wrong.length === 0,
        wrong.length ? wrong.map(([g, w]) => `${g}≠${w}`).join(' ') : cases.map(([g]) => g).join(' '));
    }),

    test('etime from ps becomes a start instant', () => {
      const now = 1_000_000_000;
      const cases: [string, number | null][] = [
        ['00:30', now - 30_000],
        ['02:00', now - 120_000],
        ['01:02:03', now - 3723_000],
        ['2-01:00:00', now - (2 * 86400 + 3600) * 1000],
        ['nonsense', null],
      ];
      const wrong = cases.filter(([s, want]) => etimeToStart(s, now) !== want);
      return ok('every ps time format', wrong.length === 0,
        wrong.length ? wrong.map(([s]) => s).join(' ') : `${cases.length} formats`);
    }),

    test('paths are made home-relative before they can leave', () => {
      const cases: [string, string][] = [
        [redactHome('/Users/someone/.orca/hub', '/Users/someone'), '~/.orca/hub'],
        [redactHome('/Users/someone', '/Users/someone'), '~'],
        [redactHome('/srv/other', '/Users/someone'), '/srv/other'],
        [redactHome('/Users/someone-else/x', '/Users/someone'), '/Users/someone-else/x'],
      ];
      const wrong = cases.filter(([got, want]) => got !== want);
      return ok('the operator’s name does not travel', wrong.length === 0,
        wrong.length ? wrong.map(([g, w]) => `${g}≠${w}`).join(' ') : cases.map(([g]) => g).join(' '));
    }),

    test('the roots are read through the environment, so a test measures its own fixture', () => withFixture(async (f) => {
      const rs = roots();
      const mine = rs.every((r) => r.path.startsWith(f.home));
      return ok('nothing points at the real home', mine,
        mine ? `${rs.length} roots, all under the fixture` : `escaped: ${rs.find((r) => !r.path.startsWith(f.home))?.path}`);
    })),

    /* ── The hub side ───────────────────────────────────────────── */

    test('the registry keeps the newest per machine and rolls the fleet up', () => {
      const reg = new HygieneRegistry(() => 5000);
      reg.put('m1', report({ at: 1000 }));
      reg.put('m1', report({ at: 2000, categories: [{ ...report().categories[0]!, bytes: measured(999) }] }));
      reg.put('m2', report({ machineId: 'm2', hostname: 'two', at: 4900 }));
      const fleet = reg.fleet();
      return ok('one report per machine, summed across them',
        reg.all().length === 2 && reg.get('m1')!.at === 2000
        && fleet.machines === 2 && (fleet.orcaBytes.value ?? 0) === 999 + 300
        && (fleet.reclaimableBytes.value ?? 0) === 300,
        `machines=${fleet.machines} orca=${fleet.orcaBytes.value} reclaimable=${fleet.reclaimableBytes.value}`);
    }),

    test('a report is filed against the connection’s machine, never the frame’s claim', () => {
      const reg = new HygieneRegistry();
      const held = reg.put('real-machine', report({ machineId: 'i-am-someone-else' }));
      return ok('a collector cannot report for another machine',
        held.machineId === 'real-machine' && reg.get('i-am-someone-else') === undefined,
        `filed as ${held.machineId}`);
    }),

    test('a stale report is kept and dated, not dropped', () => {
      const reg = new HygieneRegistry(() => 1000 + 60 * 60_000);
      reg.put('m1', report({ at: 1000 }));
      const fleet = reg.fleet();
      return ok('an offline machine keeps its last known cost',
        reg.all().length === 1 && fleet.stale === 1 && (reg.age('m1') ?? 0) === 60 * 60_000,
        `stale=${fleet.stale} age=${Math.round((reg.age('m1') ?? 0) / 60_000)}min`);
    }),

    test('sanitize drops a candidate carrying an absolute path', () => {
      const dirty = report({
        candidates: [
          { id: 'a', category: 'scratch', path: '/Users/someone/.claude/cache', bytes: measured(10), files: 1, newestAt: 1, reason: 'x' },
          { id: 'b', category: 'scratch', path: '~/.claude/cache', bytes: measured(10), files: 1, newestAt: 1, reason: 'x' },
        ],
      });
      const clean = sanitizeReport(JSON.parse(JSON.stringify(dirty)));
      return ok('an absolute path is refused, not rewritten',
        !!clean && clean.candidates.length === 1 && clean.candidates[0]!.path === '~/.claude/cache' && clean.home === '~',
        `kept ${clean?.candidates.map((c) => c.path).join(', ')}`);
    }),

    test('sanitize refuses a reading that says measured but carries no number', () => {
      const bad = JSON.parse(JSON.stringify(report())) as Record<string, unknown>;
      (bad['categories'] as { bytes: unknown }[])[0]!.bytes = { value: null, confidence: 'measured' };
      const clean = sanitizeReport(bad);
      // The bad category is dropped; the good one survives, so the report stands.
      return ok('a malformed reading loses its category, not the hub',
        !!clean && clean.categories.length === 1 && clean.categories[0]!.category === 'logs',
        `${clean?.categories.length} categories survived`);
    }),

    test('cache and swap survive the wire, and an older collector’s report still lands', () => {
      const withMem = JSON.parse(JSON.stringify(report())) as Record<string, unknown>;
      withMem['memCachedBytes'] = measured(7 * 1024 ** 3);
      withMem['swapUsedBytes'] = measured(4 * 1024 ** 3);
      withMem['swapTotalBytes'] = measured(5 * 1024 ** 3);
      const clean = sanitizeReport(withMem);
      // A collector from before this existed sends nothing; the field must be
      // absent, because a zero here would say the machine has no cache at all.
      const older = sanitizeReport(JSON.parse(JSON.stringify(report())));
      return ok('the three new readings cross, and their absence is absence',
        clean?.memCachedBytes?.value === 7 * 1024 ** 3 && clean?.swapUsedBytes?.value === 4 * 1024 ** 3
        && older !== null && older.memCachedBytes === undefined && older.swapUsedBytes === undefined,
        `cached=${clean?.memCachedBytes?.value} older=${older?.memCachedBytes === undefined ? 'absent' : 'present'}`);
    }),

    test('sanitize rejects a frame that is not a report at all', () => {
      const cases = [null, 42, {}, { categories: 'no', volumes: [] }, { categories: [], volumes: [] }];
      const wrong = cases.filter((v) => sanitizeReport(v) !== null);
      return ok('garbage is refused whole', wrong.length === 0, `${cases.length} shapes refused`);
    }),

    test('the fleet total is a floor when any one machine’s walk was cut short', () => {
      const reg = new HygieneRegistry();
      reg.put('m1', report());
      reg.put('m2', report({
        machineId: 'm2',
        categories: [{ ...report().categories[0]!, bytes: atLeast(50, 'cut short') }],
      }));
      const fleet = reg.fleet();
      return ok('one truncated machine makes the fleet number a floor',
        fleet.orcaBytes.confidence === 'atLeast' && formatReading(fleet.orcaBytes).startsWith('≥'),
        `${formatReading(fleet.orcaBytes)} (${fleet.orcaBytes.confidence})`);
    }),

    test('reclaimable counts the candidates and nothing else', () => {
      const r = report({
        candidates: [
          { id: 'a', category: 'scratch', path: '~/a', bytes: measured(100), files: 1, newestAt: 1, reason: 'x' },
          { id: 'b', category: 'backups', path: '~/b', bytes: measured(50), files: 1, newestAt: 1, reason: 'x' },
        ],
      });
      return ok('the reclaimable total is the candidate total',
        reclaimable(r).value === 150 && orcaTotal(r).value === 300,
        `reclaimable=${reclaimable(r).value} held=${orcaTotal(r).value}`);
    }),
  ],
} satisfies TestModule;
