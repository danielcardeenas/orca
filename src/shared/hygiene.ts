/**
 * Hygiene — what ORCA is costing the machine it runs on.
 *
 * A fleet that watches agents all day leaves a trail: transcripts that only
 * grow, logs, backups, recovery images, scratch directories and caches. This
 * is the shape of that trail on the wire, and the rules that decide what is a
 * *candidate* for reclaiming. Nothing here deletes anything, and nothing in
 * this delivery does: the first hygiene release observes and previews.
 *
 * **Every number says how good it is, and which way it is wrong.** A
 * `Reading` is `measured`, a lower bound (`atLeast`, `≥`), an upper bound
 * (`atMost`, `≤`), an `approximate` that bounds nothing (`~`), or
 * `unavailable` with the reason. The direction is not decoration: a truncated
 * walk is a floor and `total - free` memory is a ceiling, and showing both
 * with the same mark tells the reader the opposite of the truth about one of
 * them. A dash is a fact about the sampler, not a zero — conflating those is
 * how a hygiene panel starts lying, and the lie is always in the reassuring
 * direction.
 *
 * **A bound is the second-best answer.** Marking a number honestly is not the
 * same as measuring it, and a correctly-marked ceiling can still be the figure
 * that misleads: `≤47G of 48G` was true of this machine while nine gigabytes
 * sat free, because the only source anyone had asked was `os.freemem()`. The
 * fix was to ask a better source (`collector/memory.ts`), not to re-mark the
 * bad one. Reach for `atMost` when the platform will not say — not instead of
 * asking it.
 *
 * **Growth is not writes.** The one number an operator will misread is
 * "writes". We cannot see the block writes a process makes without privileges
 * we do not have and do not want, so what a `GrowthSample` reports is exactly
 * what its name says: how much bigger ORCA's own files got between two
 * samples. A log that rotates writes megabytes and grows by nothing; a
 * transcript rewritten in place writes twice what it grows. The field is
 * `netBytes`, never `writtenBytes`, and the UI must never round the
 * distinction off.
 *
 * **Coverage travels with the number.** Every walk is bounded — a deadline, a
 * depth, an entry budget — because a hygiene panel that stats three million
 * files on every refresh is itself the hygiene problem. When a walk stops
 * early the total is a *floor*, `Coverage.truncated` says so, and the reading
 * becomes `atLeast`. What that floor does *not* survive is subtraction: see
 * `diffReadings`, and `GrowthSample` below.
 *
 * **Nothing recoverable is ever a candidate.** History, recovery images and
 * handoffs are how a lost fleet comes back; `PROTECTED` names them and
 * `isProtected` is checked before anything is offered for reclaiming, however
 * old or large it is.
 *
 * No file content and no secrets cross this wire: paths, sizes, counts and
 * times only. A transcript's *name* is already the operator's own path, and
 * `redactHome` keeps even that to `~/…` when it leaves the machine.
 */

/* ── Readings ─────────────────────────────────────────────────────── */

/**
 * How much a number is worth, and — when it is not exact — *which way* it is
 * wrong.
 *
 * The first version of this had one grade for "not exact" and printed `≥` in
 * front of all of it. That was a bug with a mark on it: a truncated directory
 * walk really is a floor, but macOS memory-in-use is a *ceiling*, and the two
 * were being shown with the same symbol pointing the same way. A reader who
 * trusts the mark would have concluded the machine had less memory than it
 * does, which is the precise failure a confidence system exists to prevent.
 *
 * So the direction is part of the grade:
 *
 *  - `measured` — counted. The number is the number.
 *  - `atLeast` — a lower bound (`≥`). The truth is this or more. A walk that
 *    ran out of budget produced this: everything it did not reach can only add.
 *  - `atMost` — an upper bound (`≤`). The truth is this or less. `total -
 *    free` memory is this: it counts cache and purgeable pages, which are
 *    handed back the moment anything asks. It is now only the fallback for a
 *    machine whose `vm_stat` or `/proc/meminfo` could not be read — the
 *    measurement replaced it — and the grade stayed because the fallback is
 *    still reachable and still a ceiling.
 *  - `approximate` — a real estimate with no valid bound in either direction
 *    (`~`). Rare on purpose, and never a resting place for laziness.
 *  - `unavailable` — could not be measured, and the reason travels (`—`).
 *
 * The last grade is load-bearing. When a derivation cannot produce a *valid*
 * bound — subtracting two floors is the case that started this — the answer is
 * `unavailable` with the reason, not a number wearing a mark it has not
 * earned.
 */
export type Confidence = 'measured' | 'atLeast' | 'atMost' | 'approximate' | 'unavailable';

export interface Reading {
  /** Null exactly when `confidence` is `unavailable`. */
  value: number | null;
  confidence: Confidence;
  /**
   * Why it is bounded, approximate or missing — and, on a `measured` reading,
   * any caveat about what the number *means* rather than how exact it is.
   * Growth is the example: the figure is exact and still is not disk writes.
   */
  note?: string;
}

export function measured(value: number, note?: string): Reading {
  return note ? { value, confidence: 'measured', note } : { value, confidence: 'measured' };
}
/** The truth is `value` or more. A walk that hit its budget makes these. */
export function atLeast(value: number, note: string): Reading {
  return { value, confidence: 'atLeast', note };
}
/** The truth is `value` or less. `total - free` memory makes these. */
export function atMost(value: number, note: string): Reading {
  return { value, confidence: 'atMost', note };
}
/** A real estimate that bounds nothing. Use only when neither bound is valid. */
export function approximate(value: number, note: string): Reading {
  return { value, confidence: 'approximate', note };
}
export function unavailable(note: string): Reading {
  return { value: null, confidence: 'unavailable', note };
}

/** True when the reading carries a number at all. */
export function known(r: Reading): r is Reading & { value: number } {
  return r.confidence !== 'unavailable' && r.value !== null;
}

/**
 * Add readings, keeping a bound that is still true of the sum.
 *
 * The algebra, and it is the whole point of the function:
 *
 *  - floors add to a floor, ceilings add to a ceiling;
 *  - a floor plus a ceiling bounds nothing, so the sum is `approximate`;
 *  - an `unavailable` term is a quantity we do not know. For a sum of sizes
 *    (`nonNegative`, the default and every current caller) the missing term
 *    can only add, so dropping it leaves a floor. Where terms may be negative
 *    it leaves an estimate that bounds nothing;
 *  - nothing known at all is `unavailable`, never zero.
 */
export function sumReadings(
  readings: Reading[],
  opts: { note?: string; nonNegative?: boolean } = {},
): Reading {
  const nonNegative = opts.nonNegative !== false;
  if (readings.length === 0) return measured(0);
  let total = 0;
  let anyKnown = false;
  let low = false, high = false, vague = false;
  const notes: string[] = [];
  const remember = (r: Reading) => { if (r.note && !notes.includes(r.note)) notes.push(r.note); };
  for (const r of readings) {
    if (r.confidence === 'unavailable' || r.value === null) {
      remember(r);
      // A term we could not measure: it can only add (sizes), or it could go
      // either way (anything signed).
      if (nonNegative) low = true; else vague = true;
      continue;
    }
    anyKnown = true;
    total += r.value;
    if (r.confidence === 'atLeast') { low = true; remember(r); }
    else if (r.confidence === 'atMost') { high = true; remember(r); }
    else if (r.confidence === 'approximate') { vague = true; remember(r); }
  }
  const note = opts.note ?? notes[0] ?? 'part of this could not be counted';
  if (!anyKnown) return unavailable(notes[0] ?? note);
  if (vague || (low && high)) return approximate(total, note);
  if (low) return atLeast(total, note);
  if (high) return atMost(total, note);
  return measured(total);
}

/**
 * `a − b`, with a bound that survives the subtraction.
 *
 * This is where the original design was wrong and it is worth being explicit,
 * because the mistake is natural: two floors do **not** subtract to a floor.
 * If `a ≥ 100` and `b ≥ 90`, then `a − b` could be 10, or 900, or −80. The
 * only honest answer is that nothing is bounded, so this returns
 * `unavailable` with the reason rather than a number that looks careful.
 *
 * What does survive:
 *
 *  - exact − exact = exact;
 *  - floor − exact = floor (the minuend can only grow);
 *  - exact − floor = ceiling (the subtrahend can only grow);
 *  - ceiling − exact = ceiling, exact − ceiling = floor;
 *  - anything involving two same-direction bounds on opposite sides, or an
 *    approximate, or an unavailable → `unavailable`.
 */
export function diffReadings(a: Reading, b: Reading, note: string): Reading {
  if (!known(a) || !known(b)) {
    return unavailable(a.note ?? b.note ?? note);
  }
  if (a.confidence === 'approximate' || b.confidence === 'approximate') {
    return unavailable(note);
  }
  const value = a.value - b.value;
  const A = a.confidence, B = b.confidence;
  if (A === 'measured' && B === 'measured') return measured(value);
  // Flipping sign flips the direction of the subtrahend's bound.
  const bFlipped = B === 'measured' ? 'measured' : B === 'atLeast' ? 'atMost' : 'atLeast';
  if (A === 'measured') return bFlipped === 'atMost' ? atMost(value, note) : atLeast(value, note);
  if (bFlipped === 'measured') return A === 'atLeast' ? atLeast(value, note) : atMost(value, note);
  if (A === bFlipped) return A === 'atLeast' ? atLeast(value, note) : atMost(value, note);
  // Bounds pointing opposite ways: the difference is unbounded both ends.
  return unavailable(note);
}

/** Scale a reading by a positive factor. Direction is preserved; sign is not flipped. */
export function scaleReading(r: Reading, factor: number, note?: string): Reading {
  if (!known(r)) return r;
  if (factor === 0) return measured(0);
  const value = r.value * factor;
  const n = note ?? r.note ?? '';
  if (factor > 0) {
    return r.confidence === 'measured' ? measured(value, r.note)
      : r.confidence === 'atLeast' ? atLeast(value, n)
        : r.confidence === 'atMost' ? atMost(value, n) : approximate(value, n);
  }
  // A negative factor turns a floor into a ceiling and back.
  return r.confidence === 'measured' ? measured(value, r.note)
    : r.confidence === 'atLeast' ? atMost(value, n)
      : r.confidence === 'atMost' ? atLeast(value, n) : approximate(value, n);
}

/* ── Coverage ─────────────────────────────────────────────────────── */

/**
 * What a bounded walk actually managed to look at.
 *
 * `truncated` is the field that matters: it turns a total into a floor. The
 * budgets that produced it travel too, so an operator reading a suspiciously
 * small number can see it was the sampler being polite and not the disk being
 * empty.
 */
export interface Coverage {
  /** Directory entries the walk visited. */
  visited: number;
  /** Directories it did not descend into, because a budget ran out. */
  skipped: number;
  /** True when a budget stopped the walk: every total here is a floor. */
  truncated: boolean;
  maxDepth: number;
  maxEntries: number;
  /** Wall time the walk took, ms. */
  tookMs: number;
}

export function emptyCoverage(maxDepth: number, maxEntries: number): Coverage {
  return { visited: 0, skipped: 0, truncated: false, maxDepth, maxEntries, tookMs: 0 };
}

/* ── Categories ───────────────────────────────────────────────────── */

/**
 * The four buckets the operator asked for, plus the two that would otherwise
 * hide inside "other" and are worth their own line.
 *
 * `recovery` is listed because it is often the second largest thing on disk
 * and the operator should see it — *and* because seeing it next to a rule
 * that says it is never a candidate is how the rule stays believed.
 */
export type HygieneCategory =
  | 'transcripts'   // ~/.claude/projects, ~/.codex/sessions: the sessions themselves
  | 'logs'          // hub events, daemon logs, jsonl trails
  | 'recovery'      // history, recovery images, handoffs — never a candidate
  | 'backups'       // ~/.claude/backups and friends
  | 'scratch'       // caches, paste-cache, file-history, scratchpads
  | 'artifacts';    // what agents produced and the hub cached

export const CATEGORIES: HygieneCategory[] = [
  'transcripts', 'logs', 'recovery', 'backups', 'scratch', 'artifacts',
];

export const CATEGORY_LABEL: Record<HygieneCategory, string> = {
  transcripts: 'TRANSCRIPTS',
  logs: 'LOGS',
  recovery: 'RECOVERY',
  backups: 'BACKUPS',
  scratch: 'SCRATCH & CACHE',
  artifacts: 'ARTIFACTS',
};

/** One bucket of ORCA's footprint on one machine. */
export interface CategorySample {
  category: HygieneCategory;
  /** The roots that were walked, home-relative (`~/.claude/projects`). */
  roots: string[];
  bytes: Reading;
  files: Reading;
  /** Newest and oldest mtime seen in the walk, epoch ms. Null when nothing was. */
  newestAt: number | null;
  oldestAt: number | null;
  coverage: Coverage;
}

/* ── Volumes, processes, growth ───────────────────────────────────── */

/** The filesystem a root lives on. `statfs`, not a walk: this one is cheap and exact. */
export interface VolumeSample {
  /** Home-relative path whose filesystem this is. */
  path: string;
  totalBytes: Reading;
  freeBytes: Reading;
  /** What ORCA's own categories account for on this volume, when known. */
  orcaBytes: Reading;
}

/** One process ORCA owns, or is. */
export interface ProcessSample {
  pid: number;
  role: 'hub' | 'collector' | 'console' | 'agent' | 'other';
  /** Command name only — never the arguments, which carry paths and tokens. */
  name: string;
  cpuPct: Reading;
  rssBytes: Reading;
  startedAt: number | null;
}

/**
 * How much bigger ORCA's own files got between two samples.
 *
 * NOT the writes the disk saw. See the file header: rotation and in-place
 * rewrites both break the equivalence, in opposite directions. The name of
 * every field says growth, and the UI is expected to say it too.
 */
export interface GrowthSample {
  /** Time between the two samples this was derived from, ms. */
  windowMs: number;
  /**
   * The change in bytes. `measured` when both samples walked their trees
   * whole; `unavailable` when either was truncated, because subtracting two
   * floors bounds nothing (`diffReadings`). It is never silently marked as a
   * floor — that was the bug this comment exists to prevent coming back.
   */
  netBytes: Reading;
  /** `netBytes / windowMs`, bytes per second. Negative after a cleanup. */
  netBytesPerSec: Reading;
  /** Per category, so "the transcripts are what is growing" is one glance. */
  byCategory: Partial<Record<HygieneCategory, Reading>>;
}

/* ── Candidates ───────────────────────────────────────────────────── */

/**
 * Something that *could* be reclaimed, and why.
 *
 * A candidate is a proposal, not a plan: this release neither deletes nor
 * offers to. It exists so the operator can see where the gigabytes are before
 * anyone writes the code that removes them.
 */
export interface Candidate {
  id: string;
  category: HygieneCategory;
  /** Home-relative path. */
  path: string;
  bytes: Reading;
  files: number;
  /** Newest mtime under it, epoch ms — how stale the whole thing is. */
  newestAt: number | null;
  /** One line the operator can judge: what this is and why it is offered. */
  reason: string;
}

/**
 * Paths that are never candidates, whatever their age or size.
 *
 * These are the files a lost fleet is rebuilt from. Home-relative, matched as
 * prefixes by `isProtected`. Recovery and history are the operator's
 * insurance; deleting them to save a gigabyte is the one hygiene action that
 * can cost more than it saves.
 */
export const PROTECTED: string[] = [
  '~/.orca/history.jsonl',
  '~/.orca/recovery-images',
  '~/.orca/capcom/handoffs',
  '~/.orca/worker-recovery',
  '~/.orca/token',
  '~/.orca/machine-id',
  '~/.orca/hub/missions.json',
  '~/.orca/hub/tasks.json',
  '~/.orca/hub/file-roots.json',
  '~/.orca/hub/memory.json',
  '~/.claude/history.jsonl',
];

/** True when a home-relative path is one of the files a fleet is rebuilt from. */
export function isProtected(path: string): boolean {
  return PROTECTED.some((p) => path === p || path.startsWith(`${p}/`));
}

/* ── The report ───────────────────────────────────────────────────── */

/** One machine's whole hygiene picture, as one frame on the wire. */
export interface HygieneReport {
  machineId: string;
  hostname: string;
  platform: string;
  /** When the sample was taken, epoch ms. */
  at: number;
  /** How long the whole sample cost, ms. The panel shows it: cheap is a claim. */
  tookMs: number;
  /** Home directory, so the console can say `~/…` and never the operator's name. */
  home: string;
  volumes: VolumeSample[];
  categories: CategorySample[];
  processes: ProcessSample[];
  /** Whole machine, not ORCA's share: the same numbers the machine strip shows. */
  cpuPct: Reading;
  /**
   * Memory actually committed — `wired + app + compressed` on darwin,
   * `MemTotal - MemAvailable` on linux. Not `total - free`: see
   * `collector/memory.ts`, which exists because that subtraction called a
   * machine with nine gigabytes to spare full.
   */
  memUsedBytes: Reading;
  memTotalBytes: Reading;
  /**
   * Memory in use as cache — file-backed and purgeable pages — which the
   * system hands back on demand. It is *not* part of `memUsedBytes`, and it is
   * its own field rather than a term in either total because it is genuinely
   * both: in use, and available. Absent in a report from an older collector.
   */
  memCachedBytes?: Reading;
  /**
   * Swap in use, and how much there is. The figure that says whether pressure
   * is real: 80% committed with no swap out is a comfortable machine, and the
   * same 80% with gigabytes swapped is not. Absent from an older collector.
   */
  swapUsedBytes?: Reading;
  swapTotalBytes?: Reading;
  /** Null on the very first sample: growth needs two. */
  growth: GrowthSample | null;
  candidates: Candidate[];
  /**
   * Lo que ORCA dejó atrás en PROCESOS y puertos, no en disco: un Vite de este
   * repositorio sin dueño, un entrypoint reparentado a init, un pane cuyo
   * programa salió, un agente que sigue en el registro sin nada detrás.
   *
   * Viaja con la higiene y no por su cuenta porque es la misma pregunta —qué
   * está costando ORCA en esta máquina— medida en la otra unidad, y porque el
   * informe ya tiene su reloj lento y su panel. Ausente en un informe de una
   * versión anterior. Ver shared/strays.ts.
   */
  strays?: import('./strays.ts').Stray[];
  /** What the sampler could not do here, one line each. Shown, not swallowed. */
  limits: string[];
}

/* ── Reading a report ─────────────────────────────────────────────── */

/** What ORCA's own files add up to on one machine. */
export function orcaTotal(report: HygieneReport): Reading {
  return sumReadings(report.categories.map((c) => c.bytes));
}

/** What the candidates add up to — the space a future cleanup could reclaim. */
export function reclaimable(report: HygieneReport): Reading {
  return sumReadings(report.candidates.map((c) => c.bytes));
}

/** True when any size in the report is a bound rather than a total. */
export function isPartial(report: HygieneReport): boolean {
  return report.categories.some((c) => c.coverage.truncated);
}

/**
 * Bytes, in the fewest characters that still say the size.
 *
 * Powers of 1024 with the unit attached, because a hygiene panel is read at a
 * glance and "3.3G" is one token where "3,543,348,224 bytes" is six.
 */
export function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const neg = value < 0;
  let n = Math.abs(value);
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const digits = n < 10 && i > 0 ? 1 : 0;
  return `${neg ? '−' : ''}${n.toFixed(digits)}${units[i]}`;
}

/**
 * A reading as the panel prints it, with the mark that says which way it is
 * wrong: bare when exact, `≥` for a floor, `≤` for a ceiling, `~` for an
 * estimate that bounds nothing, and `—` when there is no number at all.
 *
 * The mark is in the text and not only in the colour, so the meaning survives
 * a greyscale screen, a screenshot and a reader who cannot tell the two greys
 * apart.
 */
export const MARK: Record<Confidence, string> = {
  measured: '', atLeast: '≥', atMost: '≤', approximate: '~', unavailable: '—',
};

export function formatReading(r: Reading, unit: 'bytes' | 'count' | 'pct' = 'bytes'): string {
  if (r.confidence === 'unavailable' || r.value === null) return MARK.unavailable;
  const body = unit === 'bytes' ? formatBytes(r.value)
    : unit === 'pct' ? `${Math.round(r.value * 10) / 10}%`
      : String(Math.round(r.value));
  return `${MARK[r.confidence]}${body}`;
}

/** Home-relative form of a path, so no report carries the operator's name. */
export function redactHome(path: string, home: string): string {
  if (!home) return path;
  const h = home.endsWith('/') ? home.slice(0, -1) : home;
  if (path === h) return '~';
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}
