/**
 * Hygiene, at the hub: the latest report from every machine, and the fleet
 * total that only the hub can compute.
 *
 * Deliberately in memory and deliberately not in `WorldState`. A hygiene
 * report is a few kilobytes of numbers per machine, it changes on its own
 * clock, and nobody's field tile depends on it — putting it in the world
 * would push it into every patch broadcast for the benefit of one window
 * nobody has open. It lives here, the console asks for it, and the MCP tools
 * read it.
 *
 * The registry keeps exactly one report per machine, the newest. There is no
 * history: a hygiene panel answers "what does this cost me now", and the
 * trend an operator actually wants — is it growing — is already inside each
 * report as `growth`, computed by the collector that owns the disk.
 *
 * **Staleness is a fact, not a gap.** A machine that went offline keeps its
 * last report, and `age` says how old it is. The alternative — dropping it —
 * turns "this VPS has 40 GB of transcripts" into a blank the moment the
 * collector reconnects, which is when the operator is most likely to look.
 */

import type { HygieneReport, Reading } from '../shared/hygiene.ts';
import type { Stray } from '../shared/strays.ts';

/** Lo que un collector puede declarar. Nada fuera de estas listas cruza. */
const STRAY_KINDS: readonly string[] = ['vite', 'orca', 'pane', 'agent'];
const STRAY_VERDICTS: readonly string[] = ['orphan', 'ambiguous', 'protected'];
const STRAY_ACTIONS: readonly string[] = ['terminate', 'retire', 'none'];
import { CATEGORIES, sumReadings, unavailable, type HygieneCategory } from '../shared/hygiene.ts';

/** Past this, the console shows the report as stale rather than current. */
export const STALE_MS = 15 * 60_000;

/** The fleet's hygiene, rolled up across machines. */
export interface FleetHygiene {
  at: number;
  machines: number;
  /** Machines whose newest report is older than `STALE_MS`. */
  stale: number;
  orcaBytes: Reading;
  reclaimableBytes: Reading;
  byCategory: Record<HygieneCategory, Reading>;
  /** Every machine's report, newest sample first. */
  reports: HygieneReport[];
}

export class HygieneRegistry {
  private byMachine = new Map<string, HygieneReport>();

  constructor(private now: () => number = () => Date.now()) {}

  /**
   * Take one machine's report. The `machineId` is the hub's, never the
   * frame's: a collector authenticated as one machine cannot file a report
   * about another.
   */
  put(machineId: string, report: HygieneReport): HygieneReport {
    const held = { ...report, machineId };
    this.byMachine.set(machineId, held);
    return held;
  }

  get(machineId: string): HygieneReport | undefined { return this.byMachine.get(machineId); }
  all(): HygieneReport[] {
    return [...this.byMachine.values()].sort((a, b) => b.at - a.at);
  }
  /** A machine that is gone for good takes its report with it. */
  drop(machineId: string): void { this.byMachine.delete(machineId); }

  /** How old a machine's newest report is, ms. Null when there is none. */
  age(machineId: string): number | null {
    const r = this.byMachine.get(machineId);
    return r ? this.now() - r.at : null;
  }

  /**
   * The fleet total.
   *
   * Sums keep a bound that is still true of the sum (`sumReadings`), so one
   * machine whose walk was truncated makes the fleet number an `atLeast`
   * floor rather than a total that quietly under-reports — and a fleet mixing
   * a floor with a ceiling comes back `approximate`, because nothing bounds it.
   */
  fleet(): FleetHygiene {
    const reports = this.all();
    const now = this.now();
    const byCategory = {} as Record<HygieneCategory, Reading>;
    for (const cat of CATEGORIES) {
      const parts = reports
        .map((r) => r.categories.find((c) => c.category === cat)?.bytes)
        .filter((r): r is Reading => !!r);
      byCategory[cat] = parts.length ? sumReadings(parts) : unavailable('no machine reported this category');
    }
    return {
      at: now,
      machines: reports.length,
      stale: reports.filter((r) => now - r.at > STALE_MS).length,
      orcaBytes: sumReadings(reports.flatMap((r) => r.categories.map((c) => c.bytes))),
      reclaimableBytes: sumReadings(reports.flatMap((r) => r.candidates.map((c) => c.bytes))),
      byCategory,
      reports,
    };
  }
}

/* ── Validation ───────────────────────────────────────────────────── */

const CONFIDENCES = new Set(['measured', 'atLeast', 'atMost', 'approximate', 'unavailable']);

function isReading(v: unknown): v is Reading {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (!CONFIDENCES.has(String(r['confidence']))) return false;
  if (r['confidence'] === 'unavailable') return r['value'] === null;
  return typeof r['value'] === 'number' && Number.isFinite(r['value']);
}

/**
 * Accept a report off the wire, or reject the whole thing.
 *
 * A collector is a program on someone's laptop, so this is a boundary and not
 * a formality: sizes are clamped to sane ranges, arrays are capped, and every
 * path is required to be home-relative already — a report carrying an
 * absolute path is a report carrying the operator's name, and it is refused
 * rather than quietly rewritten.
 */
export function sanitizeReport(v: unknown): HygieneReport | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  const str = (x: unknown, max: number): string => (typeof x === 'string' ? x.slice(0, max) : '');
  if (!Array.isArray(r['categories']) || !Array.isArray(r['volumes'])) return null;

  const categories = (r['categories'] as unknown[]).slice(0, CATEGORIES.length).flatMap((c) => {
    if (typeof c !== 'object' || c === null) return [];
    const x = c as Record<string, unknown>;
    if (!CATEGORIES.includes(x['category'] as HygieneCategory)) return [];
    if (!isReading(x['bytes']) || !isReading(x['files'])) return [];
    const cov = (typeof x['coverage'] === 'object' && x['coverage'] !== null ? x['coverage'] : {}) as Record<string, unknown>;
    return [{
      category: x['category'] as HygieneCategory,
      roots: (Array.isArray(x['roots']) ? x['roots'] : []).filter((p): p is string => typeof p === 'string').slice(0, 8),
      bytes: x['bytes'], files: x['files'],
      newestAt: typeof x['newestAt'] === 'number' ? x['newestAt'] : null,
      oldestAt: typeof x['oldestAt'] === 'number' ? x['oldestAt'] : null,
      coverage: {
        visited: num(cov['visited']), skipped: num(cov['skipped']),
        truncated: cov['truncated'] === true,
        maxDepth: num(cov['maxDepth']), maxEntries: num(cov['maxEntries']), tookMs: num(cov['tookMs']),
      },
    }];
  });
  if (categories.length === 0) return null;

  const volumes = (r['volumes'] as unknown[]).slice(0, 8).flatMap((v2) => {
    if (typeof v2 !== 'object' || v2 === null) return [];
    const x = v2 as Record<string, unknown>;
    if (!isReading(x['totalBytes']) || !isReading(x['freeBytes']) || !isReading(x['orcaBytes'])) return [];
    return [{
      path: str(x['path'], 200), totalBytes: x['totalBytes'], freeBytes: x['freeBytes'], orcaBytes: x['orcaBytes'],
    }];
  });

  const processes = (Array.isArray(r['processes']) ? r['processes'] : []).slice(0, 64).flatMap((p) => {
    if (typeof p !== 'object' || p === null) return [];
    const x = p as Record<string, unknown>;
    if (!isReading(x['cpuPct']) || !isReading(x['rssBytes'])) return [];
    const role = String(x['role']);
    return [{
      pid: Math.max(0, Math.round(num(x['pid']))),
      role: (['hub', 'collector', 'console', 'agent', 'other'].includes(role) ? role : 'other') as HygieneReport['processes'][number]['role'],
      // The command name only. An argv would carry paths, and sometimes a token.
      name: str(x['name'], 64),
      cpuPct: x['cpuPct'], rssBytes: x['rssBytes'],
      startedAt: typeof x['startedAt'] === 'number' ? x['startedAt'] : null,
    }];
  });

  const candidates = (Array.isArray(r['candidates']) ? r['candidates'] : []).slice(0, 64).flatMap((c) => {
    if (typeof c !== 'object' || c === null) return [];
    const x = c as Record<string, unknown>;
    if (!isReading(x['bytes'])) return [];
    const p = str(x['path'], 200);
    // Home-relative or nothing: an absolute path is the operator's name.
    if (!p || p.startsWith('/')) return [];
    if (!CATEGORIES.includes(x['category'] as HygieneCategory)) return [];
    return [{
      id: str(x['id'], 120), category: x['category'] as HygieneCategory, path: p,
      bytes: x['bytes'], files: Math.max(0, Math.round(num(x['files']))),
      newestAt: typeof x['newestAt'] === 'number' ? x['newestAt'] : null,
      reason: str(x['reason'], 200),
    }];
  });

  /*
   * Los restos, validados como todo lo demás que llega de un collector.
   *
   * Importa más que en las otras listas: cada fila de aquí acaba en un panel
   * con un botón que termina un proceso, así que lo que no encaja no se
   * recorta — se tira. Un `verdict` desconocido no puede convertirse en
   * `orphan` por descuido, y una ruta absoluta no cruza porque lleva el nombre
   * del operador. Ver shared/strays.ts.
   */
  const strays = (Array.isArray(r['strays']) ? r['strays'] : []).slice(0, 64).flatMap((v3) => {
    if (typeof v3 !== 'object' || v3 === null) return [];
    const x = v3 as Record<string, unknown>;
    const kind = String(x['kind']);
    const verdict = String(x['verdict']);
    const action = String(x['action']);
    if (!STRAY_KINDS.includes(kind) || !STRAY_VERDICTS.includes(verdict) || !STRAY_ACTIONS.includes(action)) return [];
    const cwd = str(x['cwd'], 200);
    if (cwd.startsWith('/')) return [];
    const pid = Math.max(0, Math.round(num(x['pid'])));
    return [{
      id: str(x['id'], 120),
      kind: kind as Stray['kind'], verdict: verdict as Stray['verdict'], action: action as Stray['action'],
      label: str(x['label'], 120),
      ...(pid > 0 ? { pid } : {}),
      ...(typeof x['ppid'] === 'number' ? { ppid: Math.max(0, Math.round(x['ppid'])) } : {}),
      ...(typeof x['startedAt'] === 'number' ? { startedAt: x['startedAt'] } : {}),
      ...(Array.isArray(x['ports'])
        ? { ports: x['ports'].filter((n): n is number => typeof n === 'number' && n > 0 && n < 65_536).slice(0, 8) }
        : {}),
      ...(cwd ? { cwd } : {}),
      ...(typeof x['agentId'] === 'string' ? { agentId: str(x['agentId'], 120) } : {}),
      ...(typeof x['pane'] === 'string' ? { pane: str(x['pane'], 120) } : {}),
      evidence: (Array.isArray(x['evidence']) ? x['evidence'] : [])
        .filter((e): e is string => typeof e === 'string').slice(0, 8).map((e) => e.slice(0, 200)),
      ...(typeof x['why'] === 'string' ? { why: str(x['why'], 200) } : {}),
    }];
  });

  const growthRaw = r['growth'];
  let growth: HygieneReport['growth'] = null;
  if (typeof growthRaw === 'object' && growthRaw !== null) {
    const g = growthRaw as Record<string, unknown>;
    if (isReading(g['netBytes']) && isReading(g['netBytesPerSec'])) {
      const per: HygieneReport['growth'] = {
        windowMs: num(g['windowMs']), netBytes: g['netBytes'], netBytesPerSec: g['netBytesPerSec'],
        byCategory: {},
      };
      const raw = (typeof g['byCategory'] === 'object' && g['byCategory'] !== null ? g['byCategory'] : {}) as Record<string, unknown>;
      for (const cat of CATEGORIES) if (isReading(raw[cat])) per.byCategory[cat] = raw[cat];
      growth = per;
    }
  }

  return {
    machineId: str(r['machineId'], 120),
    hostname: str(r['hostname'], 120),
    platform: str(r['platform'], 32),
    at: num(r['at']) || Date.now(),
    tookMs: num(r['tookMs']),
    // The home path itself never travels: the console only needs to know that
    // paths are already `~`-relative.
    home: '~',
    volumes, categories, processes, candidates, growth, strays,
    cpuPct: isReading(r['cpuPct']) ? r['cpuPct'] : unavailable('the collector sent no CPU reading'),
    memUsedBytes: isReading(r['memUsedBytes']) ? r['memUsedBytes'] : unavailable('the collector sent no memory reading'),
    memTotalBytes: isReading(r['memTotalBytes']) ? r['memTotalBytes'] : unavailable('the collector sent no memory reading'),
    // Absent from an older collector, and absent is not zero: the field stays
    // off the report entirely so the window can leave the row out rather than
    // draw an empty cache.
    ...(isReading(r['memCachedBytes']) ? { memCachedBytes: r['memCachedBytes'] } : {}),
    ...(isReading(r['swapUsedBytes']) ? { swapUsedBytes: r['swapUsedBytes'] } : {}),
    ...(isReading(r['swapTotalBytes']) ? { swapTotalBytes: r['swapTotalBytes'] } : {}),
    limits: (Array.isArray(r['limits']) ? r['limits'] : [])
      .filter((s): s is string => typeof s === 'string').slice(0, 12).map((s) => s.slice(0, 300)),
  };
}
