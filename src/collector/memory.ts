/**
 * What the machine's memory is actually doing — not what `os.freemem()` says.
 *
 * `os.totalmem() - os.freemem()` is the obvious formula and it is wrong on
 * every machine ORCA runs on. On darwin `os.freemem()` counts only the pages
 * that are free *this instant*, and macOS deliberately keeps almost none:
 * everything spare is file cache or purgeable, handed back the moment anything
 * asks for it. The formula therefore reads "47G of 48G used" on a machine with
 * nine gigabytes to spare, which is true of the page table and useless — worse
 * than useless, because it reads as an emergency. Linux has the same shape of
 * bug for the same reason: `MemFree` is not `MemAvailable`.
 *
 * So we ask the platform what it means instead:
 *
 *  - **darwin**, `vm_stat`: used is `wired + app + compressed`, which is what
 *    Activity Monitor calls Memory Used. App memory is the anonymous pages
 *    minus the purgeable ones. Cache — file-backed plus purgeable — is
 *    reported as its own figure, because it is memory in use *and* memory
 *    available, and collapsing those two facts into one number is how the
 *    original bug happened.
 *  - **linux**, `/proc/meminfo`: used is `MemTotal - MemAvailable`, the
 *    kernel's own answer to "how much can a new process actually get", and
 *    cache is `Cached + Buffers + SReclaimable`.
 *
 * Swap travels with them because it is the figure that says whether the
 * pressure is real: a machine at 80% with no swap in use is comfortable, and
 * the same machine with four gigabytes swapped out is not.
 *
 * The parsers are pure and exported so the tests can hold real `vm_stat` and
 * `/proc/meminfo` output still and check the arithmetic on a machine of the
 * other kind. `read()` is the only part that touches the platform, and it
 * returns null rather than a guess when the tool is missing or unparseable —
 * the caller falls back to the honest ceiling and says why.
 */

import os from 'node:os';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';

/** One machine's memory, in the terms the platform itself uses. */
export interface MemoryFacts {
  totalBytes: number;
  /** Committed: what would have to be swapped or killed to get it back. */
  usedBytes: number;
  /** In use as cache, and available on demand. Null where it is not separable. */
  cachedBytes: number | null;
  swapUsedBytes: number | null;
  swapTotalBytes: number | null;
  /** Which tool answered, for the note that travels with the reading. */
  how: 'vm_stat' | 'meminfo';
}

/* ── darwin ───────────────────────────────────────────────────────── */

/**
 * `vm_stat` into bytes.
 *
 * Its header carries the page size (16K on Apple silicon, 4K on Intel), so
 * nothing here assumes one. Missing counters make the whole parse fail rather
 * than contributing a zero: a zero for "pages occupied by compressor" would
 * silently under-report by ten gigabytes on this machine.
 */
export function parseVmStat(text: string): Omit<MemoryFacts, 'totalBytes' | 'swapUsedBytes' | 'swapTotalBytes' | 'how'> | null {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? 0);
  if (!pageSize) return null;
  const pages = (label: string): number | null => {
    const m = text.match(new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const wired = pages('Pages wired down');
  const anonymous = pages('Anonymous pages');
  const purgeable = pages('Pages purgeable');
  const compressor = pages('Pages occupied by compressor');
  const fileBacked = pages('File-backed pages');
  if (wired === null || anonymous === null || purgeable === null || compressor === null || fileBacked === null) return null;
  // App memory is anonymous minus purgeable: a purgeable page is a cache the
  // process itself has told the kernel it may drop.
  const app = Math.max(0, anonymous - purgeable);
  return {
    usedBytes: (wired + app + compressor) * pageSize,
    cachedBytes: (fileBacked + purgeable) * pageSize,
  };
}

/** `sysctl -n vm.swapusage` → bytes. `total = 5120.00M  used = 4259.25M  …` */
export function parseSwapusage(text: string): { usedBytes: number; totalBytes: number } | null {
  const size = (label: string): number | null => {
    const m = text.match(new RegExp(`${label}\\s*=\\s*([\\d.]+)([KMGT])`));
    if (!m) return null;
    const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2] as 'K' | 'M' | 'G' | 'T'];
    return Number(m[1]) * mult;
  };
  const total = size('total'), used = size('used');
  return total === null || used === null ? null : { usedBytes: used, totalBytes: total };
}

/* ── linux ────────────────────────────────────────────────────────── */

/**
 * `/proc/meminfo` into bytes, using `MemAvailable` — the kernel's own estimate
 * of what a new process could get without swapping, which is the question a
 * memory row is really asking. Kernels old enough to lack it (pre-3.14) get
 * null rather than `MemFree`, which would reproduce the bug this file exists
 * to fix.
 */
export function parseMeminfo(text: string): Omit<MemoryFacts, 'how'> | null {
  const kb = (label: string): number | null => {
    const m = text.match(new RegExp(`^${label}:\\s+(\\d+) kB$`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal'), available = kb('MemAvailable');
  if (total === null || available === null) return null;
  const cached = kb('Cached'), buffers = kb('Buffers'), reclaimable = kb('SReclaimable');
  const swapTotal = kb('SwapTotal'), swapFree = kb('SwapFree');
  return {
    totalBytes: total,
    usedBytes: Math.max(0, total - available),
    cachedBytes: cached === null ? null : cached + (buffers ?? 0) + (reclaimable ?? 0),
    swapUsedBytes: swapTotal === null || swapFree === null ? null : swapTotal - swapFree,
    swapTotalBytes: swapTotal,
  };
}

/* ── Reading the machine ──────────────────────────────────────────── */

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

/**
 * This machine's memory, or null where the platform will not say.
 *
 * Two cheap processes on darwin (~5ms together) and one file read on linux.
 * Null is a real answer here — the caller reports the ceiling it can still
 * defend, with the reason attached, instead of a number nobody measured.
 */
export async function readMemory(): Promise<MemoryFacts | null> {
  if (process.platform === 'darwin') {
    const vm = parseVmStat(await run('vm_stat', []));
    if (!vm) return null;
    const swap = parseSwapusage(await run('sysctl', ['-n', 'vm.swapusage']));
    return {
      totalBytes: os.totalmem(),
      ...vm,
      swapUsedBytes: swap?.usedBytes ?? null,
      swapTotalBytes: swap?.totalBytes ?? null,
      how: 'vm_stat',
    };
  }
  if (process.platform === 'linux') {
    const text = await fs.readFile('/proc/meminfo', 'utf8').catch(() => '');
    const info = parseMeminfo(text);
    return info ? { ...info, how: 'meminfo' } : null;
  }
  return null;
}

/* ── The cheap synchronous view, for the heartbeat ────────────────── */

let last: MemoryFacts | null = null;
let inFlight = false;

/**
 * The last reading, refreshing in the background.
 *
 * The collector's heartbeat is synchronous and fires every few seconds; it
 * cannot await a subprocess, and it must not spawn one per beat either. So it
 * reads whatever the last sample said and asks for the next one. The first
 * beat gets null, exactly as CPU does — a percentage needs two samples there,
 * and a memory figure needs one to have finished here.
 */
export function memoryNow(): MemoryFacts | null {
  if (!inFlight) {
    inFlight = true;
    void readMemory().then((m) => { if (m) last = m; }).finally(() => { inFlight = false; });
  }
  return last;
}

/** Percent of memory committed, for the deck's machine strip. Null until the first sample lands. */
export function memoryPct(): number | null {
  const m = memoryNow();
  if (!m || m.totalBytes <= 0) return null;
  return Math.round((m.usedBytes / m.totalBytes) * 1000) / 10;
}
