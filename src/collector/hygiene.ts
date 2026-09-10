/**
 * The hygiene sampler — what ORCA costs this machine, measured cheaply.
 *
 * One collector, one sampler, one bounded pass over the handful of roots ORCA
 * actually owns. It never walks the disk: it walks `~/.claude/projects`,
 * `~/.orca` and their siblings, under three budgets at once — a deadline, a
 * depth and an entry count — and when any of them runs out it says so instead
 * of pretending the number is a total (`Coverage.truncated`, and the reading
 * becomes `atLeast`). On this machine that is about four thousand entries
 * and a few tens of milliseconds against 3.3 GB of transcripts; the report
 * carries its own `tookMs` so the claim is checkable rather than asserted.
 *
 * **Cached, because a panel refreshes and a disk does not.** A sample is good
 * for `cacheMs` (default two minutes). Anything asking sooner gets the last
 * one back, with its original `at`, so the operator always knows *when* the
 * numbers are from. `sample({ force: true })` is the escape hatch, and it is
 * what the `hygiene_sample` tool calls.
 *
 * **Growth, never writes.** Two consecutive samples give the net change in
 * ORCA's own bytes, which is the only write-ish quantity available without
 * privileges this collector must never ask for. `shared/hygiene.ts` explains
 * why that is not the same as writes; the field names say `net`, and the
 * limit is reported in `limits` on every platform.
 *
 * Growth is also the one figure that can *lose* its number. A size from a
 * truncated walk is a floor, and two floors do not subtract to a floor — the
 * difference between them is unbounded in both directions. So when either of
 * the two samples was cut short, growth comes back `unavailable` with the
 * reason rather than a plausible number wearing a `≥` it did not earn.
 *
 * **Memory is asked, not derived.** `total - free` is not memory in use on
 * either platform ORCA runs on — it counts the file cache the system hands
 * back on demand, and it called a machine with nine gigabytes free full. The
 * sampler reads `vm_stat` or `/proc/meminfo` instead (`collector/memory.ts`),
 * reports cache and swap as their own figures, and falls back to the old
 * ceiling — marked `≤`, with the reason — only when the tool will not answer.
 *
 * **Nothing leaves that isn't a size, a count or a time.** Paths are made
 * home-relative before they go on the wire, process arguments are dropped and
 * only the command name survives, and no file is ever opened — the whole
 * sampler is `readdir` + `lstat` + `statfs`.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import {
  atLeast, atMost, diffReadings, emptyCoverage, isProtected, measured, redactHome,
  scaleReading, sumReadings, unavailable,
  type Candidate, type CategorySample, type Coverage, type GrowthSample, type HygieneCategory,
  type HygieneReport, type ProcessSample, type Reading, type VolumeSample,
} from '../shared/hygiene.ts';
import { readMemory } from './memory.ts';
import {
  claudeDir, claudeProjectsDir, codexSessionsDir, home, log, orcaDir,
} from './util.ts';

const SCOPE = 'hygiene';

/* ── Budgets ──────────────────────────────────────────────────────── */

/**
 * Defaults chosen against this machine: ~3.3 GB of transcripts in ~540
 * session files, plus a `~/.claude` full of caches. The entry budget is what
 * actually binds — the deadline exists so a network filesystem or a spinning
 * disk cannot turn a refresh into a stall.
 */
export const DEFAULTS = {
  maxEntries: 20_000,
  maxDepth: 6,
  deadlineMs: 1_500,
  cacheMs: 120_000,
  /** A candidate directory must be at least this big to be worth naming. */
  minCandidateBytes: 8 * 1024 * 1024,
  /** …and untouched for at least this long. */
  staleDays: 30,
  /** Scratch and caches go stale faster: they are rebuilt on demand. */
  scratchStaleDays: 7,
} as const;

/* ── Roots ────────────────────────────────────────────────────────── */

interface Root { category: HygieneCategory; path: string }

/**
 * Where ORCA's footprint lives, by category.
 *
 * Read through the same env-aware helpers the rest of the collector uses
 * (`CLAUDE_CONFIG_DIR`, `ORCA_HOME`, `ORCA_CODEX_SESSIONS`), so a test with
 * its own home measures its own fixture and never the operator's disk.
 */
export function roots(): Root[] {
  const claude = claudeDir();
  const orca = orcaDir();
  return [
    { category: 'transcripts', path: claudeProjectsDir() },
    { category: 'transcripts', path: codexSessionsDir() },

    { category: 'logs', path: path.join(orca, 'hub', 'events') },
    { category: 'logs', path: path.join(orca, 'hub', 'overflow') },
    { category: 'logs', path: path.join(claude, 'daemon.log') },
    { category: 'logs', path: path.join(claude, 'logs') },

    // Never candidates (shared/hygiene.ts PROTECTED), listed so the operator
    // can see the size of their own insurance.
    { category: 'recovery', path: path.join(orca, 'history.jsonl') },
    { category: 'recovery', path: path.join(orca, 'recovery-images') },
    { category: 'recovery', path: path.join(orca, 'capcom') },
    { category: 'recovery', path: path.join(orca, 'worker-recovery') },
    { category: 'recovery', path: path.join(claude, 'history.jsonl') },

    { category: 'backups', path: path.join(claude, 'backups') },

    // Lo que el operador soltó en una conversación; su ruta ya está en el transcript.
    { category: 'scratch', path: path.join(orca, 'uploads') },
    { category: 'scratch', path: path.join(claude, 'cache') },
    { category: 'scratch', path: path.join(claude, 'paste-cache') },
    { category: 'scratch', path: path.join(claude, 'file-history') },
    { category: 'scratch', path: path.join(claude, 'debug') },
    { category: 'scratch', path: path.join(claude, 'shell-snapshots') },
    { category: 'scratch', path: path.join(claude, 'jobs') },

    { category: 'artifacts', path: path.join(orca, 'artifacts') },
  ];
}

/** The volumes worth reporting: one per distinct filesystem the roots sit on. */
function volumeRoots(): string[] {
  return [claudeDir(), orcaDir(), os.tmpdir()];
}

/* ── The bounded walk ─────────────────────────────────────────────── */

/** What one walk found, before it is turned into a sample. */
export interface WalkResult {
  bytes: number;
  files: number;
  newestAt: number | null;
  oldestAt: number | null;
  /** Immediate children of the root, so candidates need no second pass. */
  children: Map<string, { bytes: number; files: number; newestAt: number | null }>;
}

interface Budget {
  entries: number;
  deadline: number;
  maxDepth: number;
  coverage: Coverage;
}

/**
 * Walk one root, breadth-ish, under a shared budget.
 *
 * Symlinks are stat'd but never followed: a link into the operator's photos
 * would put their photos in ORCA's footprint and, worse, in the walk's path.
 * The size counted is the entry's own bytes, not its blocks — a hygiene panel
 * is answering "how much would I get back", and that is the apparent size.
 */
async function walk(root: string, b: Budget): Promise<WalkResult | null> {
  const out: WalkResult = { bytes: 0, files: 0, newestAt: null, oldestAt: null, children: new Map() };
  let head: { dir: string; depth: number; child: string | null }[];
  try {
    const st = await fs.lstat(root);
    if (st.isFile()) {
      // A root can be a single file (`history.jsonl`, `daemon.log`).
      b.coverage.visited++;
      out.bytes = st.size;
      out.files = 1;
      out.newestAt = st.mtimeMs;
      out.oldestAt = st.mtimeMs;
      return out;
    }
    if (!st.isDirectory()) return null;
    head = [{ dir: root, depth: 0, child: null }];
  } catch {
    return null;              // not on this machine: not a limit, just absent
  }

  while (head.length > 0) {
    if (b.entries <= 0 || Date.now() > b.deadline) {
      b.coverage.skipped += head.length;
      b.coverage.truncated = true;
      break;
    }
    const node = head.pop()!;
    let entries;
    try {
      entries = await fs.readdir(node.dir, { withFileTypes: true });
    } catch {
      b.coverage.skipped++;
      continue;               // unreadable is a fact about permissions, not a stall
    }
    for (const e of entries) {
      if (b.entries <= 0 || Date.now() > b.deadline) {
        b.coverage.truncated = true;
        b.coverage.skipped++;
        break;
      }
      b.entries--;
      b.coverage.visited++;
      const full = path.join(node.dir, e.name);
      // The child bucket this entry rolls up into: the root's own child.
      const child = node.child ?? (node.depth === 0 ? e.name : null);
      if (e.isDirectory()) {
        if (node.depth + 1 > b.maxDepth) { b.coverage.skipped++; b.coverage.truncated = true; continue; }
        head.push({ dir: full, depth: node.depth + 1, child });
        continue;
      }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      let st;
      try { st = await fs.lstat(full); } catch { continue; }
      out.bytes += st.size;
      out.files++;
      if (out.newestAt === null || st.mtimeMs > out.newestAt) out.newestAt = st.mtimeMs;
      if (out.oldestAt === null || st.mtimeMs < out.oldestAt) out.oldestAt = st.mtimeMs;
      if (child) {
        const bucket = out.children.get(child) ?? { bytes: 0, files: 0, newestAt: null };
        bucket.bytes += st.size;
        bucket.files++;
        if (bucket.newestAt === null || st.mtimeMs > bucket.newestAt) bucket.newestAt = st.mtimeMs;
        out.children.set(child, bucket);
      }
    }
  }
  return out;
}

/* ── Machine numbers ──────────────────────────────────────────────── */

/** CPU as a delta between samples: `os.cpus()` gives totals, not a percentage. */
function cpuFrom(prev: { idle: number; total: number } | null): { reading: Reading; now: { idle: number; total: number } | null } {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) {
    return { reading: unavailable('os.cpus() reported no processors'), now: null };
  }
  let idle = 0, total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
  }
  const now = { idle, total };
  if (!prev) return { reading: unavailable('first sample: a percentage needs two'), now };
  const dTotal = total - prev.total;
  if (dTotal <= 0) return { reading: unavailable('no CPU time elapsed between samples'), now };
  return { reading: measured(Math.round((1 - (idle - prev.idle) / dTotal) * 1000) / 10), now };
}

/** `statfs`, which is one syscall and exact — the opposite of walking a volume. */
async function volume(p: string): Promise<{ total: number; free: number } | null> {
  try {
    const st = await fs.statfs(p);
    return { total: Number(st.blocks) * Number(st.bsize), free: Number(st.bavail) * Number(st.bsize) };
  } catch {
    return null;
  }
}

/**
 * Per-process CPU and RSS through `ps`.
 *
 * There is no portable API for another process's memory, and `ps` is the one
 * tool present on both platforms ORCA runs on. Windows gets `unavailable`
 * with the reason attached rather than a wrong number. Only the command name
 * is read — `comm`, never `args`, which on this fleet carry repo paths and,
 * on a bad day, a token.
 */
async function psSample(pids: number[]): Promise<Map<number, { cpuPct: number; rssBytes: number; startedAt: number | null }>> {
  const out = new Map<number, { cpuPct: number; rssBytes: number; startedAt: number | null }>();
  if (pids.length === 0 || (process.platform !== 'darwin' && process.platform !== 'linux')) return out;
  const text = await new Promise<string>((resolve) => {
    execFile('ps', ['-o', 'pid=,pcpu=,rss=,etime=', '-p', pids.join(',')], { timeout: 2000 }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)$/);
    if (!m) continue;
    out.set(Number(m[1]), {
      cpuPct: Number(m[2]),
      rssBytes: Number(m[3]) * 1024,        // ps reports KiB
      startedAt: etimeToStart(m[4]!),
    });
  }
  return out;
}

/** `[[dd-]hh:]mm:ss` since start → the epoch ms it started at. */
export function etimeToStart(etime: string, now = Date.now()): number | null {
  const m = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = Number(m[1] ?? 0), hours = Number(m[2] ?? 0), mins = Number(m[3] ?? 0), secs = Number(m[4] ?? 0);
  return now - (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
}

/* ── Candidates ───────────────────────────────────────────────────── */

/**
 * What could be reclaimed, and why — a proposal the operator reads, never a
 * plan anything executes. This release deletes nothing and offers no button
 * that would.
 *
 * Three rules, all conservative, all requiring both size and staleness so a
 * busy directory is never named:
 *
 *  - **Transcripts** of a project nobody has touched in `staleDays`. The
 *    session is over and the record is cold; the operator may still want it,
 *    which is exactly why this is a list and not an action.
 *  - **Scratch and caches** untouched for `scratchStaleDays`. These are
 *    rebuilt on demand, so they are the cheapest space on the machine.
 *  - **Backups and old logs** past the same stale line.
 *
 * `isProtected` is checked last and unconditionally: history, recovery images
 * and handoffs never appear here however old or large they are.
 */
export function candidatesFrom(
  category: HygieneCategory,
  rootPath: string,
  found: WalkResult,
  homeDir: string,
  now: number,
  opts: { minCandidateBytes: number; staleDays: number; scratchStaleDays: number; truncated?: boolean },
): Candidate[] {
  if (category === 'recovery') return [];
  const staleMs = (category === 'scratch' || category === 'artifacts'
    ? opts.scratchStaleDays : opts.staleDays) * 86_400_000;
  const out: Candidate[] = [];
  for (const [name, c] of found.children) {
    if (c.bytes < opts.minCandidateBytes) continue;
    if (c.newestAt === null || now - c.newestAt < staleMs) continue;
    const rel = redactHome(path.join(rootPath, name), homeDir);
    if (isProtected(rel)) continue;
    const days = Math.floor((now - c.newestAt) / 86_400_000);
    out.push({
      id: `hyg_${category}_${name}`.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120),
      category,
      path: rel,
      bytes: opts.truncated
        ? atLeast(c.bytes, 'the walk hit its budget inside this directory: it holds this much or more')
        : measured(c.bytes),
      files: c.files,
      newestAt: c.newestAt,
      reason: category === 'transcripts'
        ? `no session activity in ${days} days`
        : category === 'scratch' || category === 'artifacts'
          ? `cache untouched for ${days} days; rebuilt on demand`
          : `nothing written in ${days} days`,
    });
  }
  // Biggest first: the operator is looking for the gigabyte, not the list.
  return out.sort((a, b) => (b.bytes.value ?? 0) - (a.bytes.value ?? 0)).slice(0, 24);
}

/* ── The sampler ──────────────────────────────────────────────────── */

export interface HygieneOptions {
  machineId: string;
  hostname: string;
  /** The processes this collector knows about. Called on every sample. */
  processes?: () => { pid: number; role: ProcessSample['role']; name: string }[];
  maxEntries?: number;
  maxDepth?: number;
  deadlineMs?: number;
  cacheMs?: number;
  minCandidateBytes?: number;
  staleDays?: number;
  scratchStaleDays?: number;
  now?: () => number;
}

export class HygieneSampler {
  private cached: HygieneReport | null = null;
  private cpuPrev: { idle: number; total: number } | null = null;
  /** The previous sample's per-category bytes, for growth. */
  /**
   * The previous sample's per-category sizes — as *readings*, not numbers, so
   * the next difference knows whether that side was a whole count or a floor.
   */
  private prevBytes: { at: number; byCategory: Map<HygieneCategory, Reading> } | null = null;
  private inFlight: Promise<HygieneReport> | null = null;
  private readonly o: Required<Omit<HygieneOptions, 'processes'>> & Pick<HygieneOptions, 'processes'>;

  constructor(opts: HygieneOptions) {
    this.o = {
      maxEntries: DEFAULTS.maxEntries,
      maxDepth: DEFAULTS.maxDepth,
      deadlineMs: DEFAULTS.deadlineMs,
      cacheMs: DEFAULTS.cacheMs,
      minCandidateBytes: DEFAULTS.minCandidateBytes,
      staleDays: DEFAULTS.staleDays,
      scratchStaleDays: DEFAULTS.scratchStaleDays,
      now: () => Date.now(),
      ...opts,
    };
  }

  /** The last report without sampling, or null before the first one. */
  last(): HygieneReport | null { return this.cached; }

  /**
   * A report. Returns the cached one while it is fresh, unless forced.
   *
   * Concurrent callers share one walk: a panel opening while the beat's own
   * sample is in flight must not double the disk work.
   */
  async sample(opts: { force?: boolean } = {}): Promise<HygieneReport> {
    const now = this.o.now();
    if (!opts.force && this.cached && now - this.cached.at < this.o.cacheMs) return this.cached;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async run(): Promise<HygieneReport> {
    const t0 = Date.now();
    const now = this.o.now();
    const homeDir = home();
    const limits: string[] = [];

    /* Categories, one shared budget across every root: the sampler's whole
       cost is bounded once, not once per directory. */
    const budget: Budget = {
      entries: this.o.maxEntries,
      deadline: t0 + this.o.deadlineMs,
      maxDepth: this.o.maxDepth,
      coverage: emptyCoverage(this.o.maxDepth, this.o.maxEntries),
    };
    const perCategory = new Map<HygieneCategory, { bytes: number; files: number; newestAt: number | null; oldestAt: number | null; roots: string[] }>();
    const candidates: Candidate[] = [];

    for (const r of roots()) {
      const found = await walk(r.path, budget);
      if (!found) continue;
      const acc = perCategory.get(r.category)
        ?? { bytes: 0, files: 0, newestAt: null as number | null, oldestAt: null as number | null, roots: [] as string[] };
      acc.bytes += found.bytes;
      acc.files += found.files;
      if (found.newestAt !== null && (acc.newestAt === null || found.newestAt > acc.newestAt)) acc.newestAt = found.newestAt;
      if (found.oldestAt !== null && (acc.oldestAt === null || found.oldestAt < acc.oldestAt)) acc.oldestAt = found.oldestAt;
      acc.roots.push(redactHome(r.path, homeDir));
      perCategory.set(r.category, acc);
      // The truncation flag is read after every root, so a directory walked
      // whole before the budget ran out keeps its exact size.
      candidates.push(...candidatesFrom(r.category, r.path, found, homeDir, now,
        { ...this.o, truncated: budget.coverage.truncated }));
    }
    budget.coverage.tookMs = Date.now() - t0;
    if (budget.coverage.truncated) {
      limits.push(`the walk stopped at ${budget.coverage.visited} entries (budget ${this.o.maxEntries}, depth ${this.o.maxDepth}): sizes are a floor, not a total`);
    }

    const categories: CategorySample[] = [];
    for (const category of perCategory.keys()) {
      const acc = perCategory.get(category)!;
      // A walk that ran out of budget counted a subset: everything it did not
      // reach can only add, so what it has is a floor and never a total.
      const note = 'the walk hit its budget: everything it did not reach can only add to this';
      categories.push({
        category,
        roots: acc.roots,
        bytes: budget.coverage.truncated ? atLeast(acc.bytes, note) : measured(acc.bytes),
        files: budget.coverage.truncated ? atLeast(acc.files, note) : measured(acc.files),
        newestAt: acc.newestAt,
        oldestAt: acc.oldestAt,
        coverage: { ...budget.coverage },
      });
    }

    /* Volumes: one statfs each, deduplicated by the filesystem they land on. */
    const volumes: VolumeSample[] = [];
    const seenFs = new Set<string>();
    for (const p of volumeRoots()) {
      const v = await volume(p);
      const key = v ? `${v.total}` : p;
      if (seenFs.has(key)) continue;
      seenFs.add(key);
      volumes.push({
        path: redactHome(p, homeDir),
        totalBytes: v ? measured(v.total) : unavailable('statfs is not available here'),
        freeBytes: v ? measured(v.free) : unavailable('statfs is not available here'),
        orcaBytes: sumReadings(categories.map((c) => c.bytes)),
      });
    }

    /* Machine load. Same shape as the deck's machine strip, same source. */
    const cpu = cpuFrom(this.cpuPrev);
    this.cpuPrev = cpu.now;
    /*
     * Memory, asked of the platform rather than derived from `os.freemem()`.
     *
     * The subtraction `total - free` is the obvious formula and it is a lie on
     * both platforms: macOS keeps almost no page free because everything spare
     * is cache it hands back on demand, and linux's `MemFree` is not
     * `MemAvailable`. It read as "≤47G of 48G" on a machine with nine
     * gigabytes to spare — a ceiling honestly marked, and still the number a
     * person saw first and read as an emergency.
     *
     * `readMemory()` asks `vm_stat` or `/proc/meminfo` what is actually
     * committed, which is a measurement and is marked as one. Cache is a
     * figure of its own instead of being folded into either side, and swap
     * comes along because it is what says whether the pressure is real.
     *
     * When the tool is missing or its output does not parse, the ceiling comes
     * back — with the reason, and never dressed up as a measurement.
     */
    const mem = await readMemory();
    const total = mem?.totalBytes ?? os.totalmem();
    const memUsed = mem
      ? measured(mem.usedBytes, mem.how === 'vm_stat'
        ? 'wired + app + compressed, as vm_stat reports them — what Activity Monitor calls memory used. File cache and purgeable pages are the CACHED row, not this one'
        : 'MemTotal − MemAvailable from /proc/meminfo: what the kernel says a new process could not have without swapping')
      : atMost(total - os.freemem(), process.platform === 'darwin'
        ? 'vm_stat could not be read, so this falls back to os.freemem(), which counts cache and purgeable pages as used: the memory really committed is this or less'
        : '/proc/meminfo could not be read, so this falls back to os.freemem(), which counts page cache as used: the memory really committed is this or less');
    const memCached = mem?.cachedBytes !== null && mem?.cachedBytes !== undefined
      ? measured(mem.cachedBytes, 'in use as cache and available at the same time: the system hands these back the moment anything asks')
      : unavailable(`cache is not separable from memory in use on ${process.platform}`);
    const swapUsed = mem?.swapUsedBytes !== null && mem?.swapUsedBytes !== undefined
      ? measured(mem.swapUsedBytes)
      : unavailable(`swap usage is not readable on ${process.platform}`);
    const swapTotal = mem?.swapTotalBytes !== null && mem?.swapTotalBytes !== undefined
      ? measured(mem.swapTotalBytes)
      : unavailable(`swap size is not readable on ${process.platform}`);

    /* Processes. */
    const wanted = this.o.processes?.() ?? [];
    let processes: ProcessSample[] = [];
    if (wanted.length === 0) {
      // Nothing to say is not a limit; nobody asked for any process.
    } else if (process.platform !== 'darwin' && process.platform !== 'linux') {
      limits.push(`per-process CPU and memory need \`ps\`, which ${process.platform} does not provide`);
      processes = wanted.map((w) => ({
        pid: w.pid, role: w.role, name: w.name,
        cpuPct: unavailable(`no \`ps\` on ${process.platform}`),
        rssBytes: unavailable(`no \`ps\` on ${process.platform}`),
        startedAt: null,
      }));
    } else {
      const got = await psSample(wanted.map((w) => w.pid));
      processes = wanted.map((w) => {
        const p = got.get(w.pid);
        return {
          pid: w.pid, role: w.role, name: w.name,
          cpuPct: p ? measured(p.cpuPct) : unavailable('the process was gone when ps ran'),
          rssBytes: p ? measured(p.rssBytes) : unavailable('the process was gone when ps ran'),
          startedAt: p?.startedAt ?? null,
        };
      });
    }

    /*
     * Growth. Never called writes (see shared/hygiene.ts), and never given a
     * bound it has not earned.
     *
     * Each category's growth is `diffReadings` over this sample's size and the
     * last one's, so the bound algebra decides: two whole walks give an exact
     * difference, and a truncated walk on either side gives `unavailable` with
     * the reason — a floor minus a floor bounds nothing. The total is the sum
     * of those, signed, so one unmeasurable category makes the total
     * unmeasurable too rather than quietly dropping a term.
     */
    const byCategory = new Map<HygieneCategory, Reading>();
    for (const c of categories) byCategory.set(c.category, c.bytes);
    let growth: GrowthSample | null = null;
    const prev = this.prevBytes;
    if (prev && now > prev.at) {
      const windowMs = now - prev.at;
      const note = 'one of the two samples was cut short by its budget, and the difference between two floors is bounded neither above nor below';
      const per: GrowthSample['byCategory'] = {};
      const parts: Reading[] = [];
      for (const [cat, size] of byCategory) {
        const was = prev.byCategory.get(cat);
        if (was === undefined) continue;      // a category that only just appeared
        const d = diffReadings(size, was, note);
        per[cat] = d;
        parts.push(d);
      }
      // Signed: a category can shrink, so a missing term is not a floor.
      const net = sumReadings(parts, { note, nonNegative: false });
      growth = {
        windowMs,
        netBytes: net,
        netBytesPerSec: scaleReading(net, 1000 / windowMs),
        byCategory: per,
      };
    }
    this.prevBytes = { at: now, byCategory };
    limits.push('write volume is not measurable without elevated privileges; the growth figures are net file growth between two samples, which rotation and in-place rewrites both break');

    const report: HygieneReport = {
      machineId: this.o.machineId,
      hostname: this.o.hostname,
      platform: process.platform,
      at: now,
      tookMs: Date.now() - t0,
      home: homeDir,
      volumes,
      categories,
      processes,
      cpuPct: cpu.reading,
      memUsedBytes: memUsed,
      memTotalBytes: measured(total),
      memCachedBytes: memCached,
      swapUsedBytes: swapUsed,
      swapTotalBytes: swapTotal,
      growth,
      candidates: candidates.sort((a, b) => (b.bytes.value ?? 0) - (a.bytes.value ?? 0)).slice(0, 40),
      limits,
    };
    this.cached = report;
    log('debug', SCOPE, `muestra en ${report.tookMs}ms · ${budget.coverage.visited} entradas${budget.coverage.truncated ? ' (truncada)' : ''}`);
    return report;
  }
}
