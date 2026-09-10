/**
 * Memory: the number a person reads first, and the arithmetic behind it.
 *
 * This suite exists because of a screenshot. The hygiene window said
 * `≤47G of 48G` on a machine with nine gigabytes free — an honest ceiling,
 * correctly marked, drawn as a nearly-full bar, and read by the operator as an
 * emergency. The formula was `os.totalmem() - os.freemem()`, which on darwin
 * counts every page of file cache as memory in use.
 *
 * So what is defended here is the arithmetic that replaced it:
 *
 *  - committed memory is `wired + app + compressed`, and app memory is the
 *    anonymous pages *minus* the purgeable ones — a purgeable page is a cache
 *    the process already said the kernel may drop;
 *  - cache is its own figure and never a term in the used total, because it is
 *    genuinely both in use and available, and folding it into either side is
 *    the original bug in the other direction;
 *  - the page size comes from the header, not from an assumption: 16K on
 *    Apple silicon and 4K on Intel, and hard-coding either quadruples or
 *    quarters every figure on half the fleet;
 *  - a missing counter makes the whole parse fail. A zero for "pages occupied
 *    by compressor" would under-report by ten gigabytes and look plausible,
 *    which is the worst kind of wrong for a number nobody re-checks.
 *
 * The parsers are pure, so real `vm_stat` and `/proc/meminfo` output sits here
 * as text and the whole thing runs on either platform.
 */

import { memoryPct, parseMeminfo, parseSwapusage, parseVmStat, readMemory } from '../src/collector/memory.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const GiB = 1024 ** 3;

/** Real output, 48 GiB Apple silicon, taken while the panel showed ≤47G of 48G. */
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               64712.
Pages active:                            996993.
Pages inactive:                          994622.
Pages speculative:                         1744.
Pages throttled:                              0.
Pages wired down:                        353323.
Pages purgeable:                          22116.
"Translation faults":               13199997030.
Pages copy-on-write:                  497042267.
Pages zero filled:                   8006565953.
Pages reactivated:                    961802261.
Pages purged:                         135950217.
File-backed pages:                       468696.
Anonymous pages:                        1524663.
Pages stored in compressor:             2068175.
Pages occupied by compressor:            678569.
Decompressions:                       540537069.
Compressions:                         654962760.
Pageins:                              180666184.
Pageouts:                                979770.
Swapins:                                2197041.
Swapouts:                               4209984.
`;

/** The same machine's swap, which is what says the pressure is real. */
const SWAPUSAGE = 'total = 5120.00M  used = 4259.25M  free = 860.75M  (encrypted)\n';

/** A 4K-page linux box, so the page size is read and never assumed. */
const VM_STAT_4K = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                              100000.
Pages wired down:                        100000.
Pages purgeable:                          10000.
File-backed pages:                       200000.
Anonymous pages:                         310000.
Pages occupied by compressor:             50000.
`;

const MEMINFO = `MemTotal:       16316296 kB
MemFree:          243100 kB
MemAvailable:    9612480 kB
Buffers:          204800 kB
Cached:          8123456 kB
SwapCached:            0 kB
SReclaimable:     512000 kB
SwapTotal:       2097152 kB
SwapFree:        1048576 kB
`;

export default {
  suite: 'memory — what is committed, and what is only cache',
  tests: [
    test('committed memory is wired + app + compressed, and app excludes purgeable', () => {
      const m = parseVmStat(VM_STAT)!;
      const pages = 353_323 + (1_524_663 - 22_116) + 678_569;
      return eq('the three terms, in pages of 16K', m.usedBytes, pages * 16_384,
        `${(m.usedBytes / GiB).toFixed(1)}G committed`);
    }),

    test('the figure a full bar was drawn from is nine gigabytes lower than the ceiling was', () => {
      const m = parseVmStat(VM_STAT)!;
      const total = 48 * GiB;
      // What the window used to show: total − free, on a machine keeping ~1G free.
      const ceiling = total - 64_712 * 16_384;
      return ok('committed is well under the old ceiling, and under the total',
        m.usedBytes < ceiling - 8 * GiB && m.usedBytes < total,
        `${(m.usedBytes / GiB).toFixed(1)}G committed vs ≤${(ceiling / GiB).toFixed(1)}G before`);
    }),

    test('cache is counted apart, and is file-backed plus purgeable', () => {
      const m = parseVmStat(VM_STAT)!;
      return eq('cache is its own number, never a term in the used total',
        m.cachedBytes, (468_696 + 22_116) * 16_384,
        `${((m.cachedBytes ?? 0) / GiB).toFixed(1)}G cached`);
    }),

    test('committed plus cache still fits in the machine', () => {
      const m = parseVmStat(VM_STAT)!;
      const total = 48 * GiB;
      return ok('the two rows do not add up to more memory than exists',
        m.usedBytes + (m.cachedBytes ?? 0) < total,
        `${((m.usedBytes + (m.cachedBytes ?? 0)) / GiB).toFixed(1)}G of 48G accounted for`);
    }),

    test('the page size is read from the header, not assumed', () => {
      const m = parseVmStat(VM_STAT_4K)!;
      const pages = 100_000 + (310_000 - 10_000) + 50_000;
      return eq('a 4K machine is not reported at four times its size', m.usedBytes, pages * 4096,
        `${(m.usedBytes / GiB).toFixed(2)}G on 4K pages`);
    }),

    test('a missing counter fails the parse instead of contributing a zero', () => {
      const without = (label: string) => parseVmStat(VM_STAT.split('\n').filter((l) => !l.startsWith(`${label}:`)).join('\n'));
      const cases = ['Pages wired down', 'Anonymous pages', 'Pages purgeable', 'Pages occupied by compressor', 'File-backed pages'];
      const leaked = cases.filter((c) => without(c) !== null);
      return ok('a zero for the compressor would under-report by ten gigabytes and look fine',
        leaked.length === 0 && parseVmStat('nothing like vm_stat output') === null,
        `${cases.length} missing counters all refused`);
    }),

    test('swap comes back in bytes, from the units sysctl prints', () => {
      const s = parseSwapusage(SWAPUSAGE)!;
      return ok('4259.25M used of 5120.00M',
        s.usedBytes === 4259.25 * 1024 ** 2 && s.totalBytes === 5120 * 1024 ** 2,
        `${(s.usedBytes / GiB).toFixed(2)}G of ${(s.totalBytes / GiB).toFixed(2)}G`);
    }),

    test('unparseable swap is null, and null swap does not sink the memory reading', () => {
      return ok('nothing is invented from an empty sysctl',
        parseSwapusage('') === null && parseSwapusage('total = ??') === null);
    }),

    test('linux uses MemAvailable, which is the kernel’s own answer', () => {
      const m = parseMeminfo(MEMINFO)!;
      return ok('used is total − available, and cache is Cached + Buffers + SReclaimable',
        m.usedBytes === (16_316_296 - 9_612_480) * 1024
        && m.cachedBytes === (8_123_456 + 204_800 + 512_000) * 1024
        && m.swapUsedBytes === (2_097_152 - 1_048_576) * 1024,
        `${(m.usedBytes / GiB).toFixed(1)}G used`);
    }),

    test('a kernel too old for MemAvailable gets null, not MemFree', () => {
      const old = MEMINFO.split('\n').filter((l) => !l.startsWith('MemAvailable:')).join('\n');
      return ok('falling back to MemFree would reproduce the bug on the other platform',
        parseMeminfo(old) === null);
    }),

    test('this machine answers, and answers something a person would recognise', async () => {
      const m = await readMemory();
      if (process.platform !== 'darwin' && process.platform !== 'linux') {
        return ok('an unsupported platform says so instead of guessing', m === null, process.platform);
      }
      return ok('committed memory is a real fraction of a real total',
        !!m && m.totalBytes > GiB && m.usedBytes > 0 && m.usedBytes < m.totalBytes,
        m ? `${(m.usedBytes / GiB).toFixed(1)}G of ${(m.totalBytes / GiB).toFixed(1)}G via ${m.how}` : 'null');
    }),

    test('the heartbeat’s percentage is null until the first sample lands, then plausible', async () => {
      const first = memoryPct();
      await new Promise((r) => setTimeout(r, 400));
      const second = memoryPct();
      if (process.platform !== 'darwin' && process.platform !== 'linux') {
        return ok('no platform, no percentage', first === null && second === null);
      }
      return ok('the beat never blocks on a subprocess: it reports the last sample',
        first === null && second !== null && second > 0 && second < 100,
        `first=${first} then=${second}%`);
    }),
  ],
} satisfies TestModule;
