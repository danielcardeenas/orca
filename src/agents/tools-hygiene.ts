/**
 * Hygiene, as three tools CAPCOM can call.
 *
 * The operator's question is never "how many bytes"; it is "am I about to run
 * out, and what can I get back". These answer that, and they are careful about
 * one thing above all: they never let a number be read as more certain — or as
 * wrong in the wrong direction — than it is. Every figure carries a
 * `confidence` of `measured`, `atLeast`, `atMost`, `approximate` or
 * `unavailable`, and the JSON says `net_growth_bytes` where a lazier design
 * would have said `writes`.
 *
 * They observe. Nothing here deletes a file, stops a process or schedules
 * either — `hygiene_candidates` returns a list a person reads, and the tool
 * description says so, because a model that thinks a tool might delete will
 * eventually try to use it to delete.
 */

import type { CeoContext, ToolOutcome, ToolSpec } from './tools.ts';
import {
  CATEGORY_LABEL, formatBytes, formatReading, isPartial, reclaimable, orcaTotal,
  type HygieneReport, type Reading,
} from '../shared/hygiene.ts';

/** Milliseconds past which a report is old news rather than the current picture. */
const STALE_MS = 15 * 60_000;

export const HYGIENE_TOOLS: ToolSpec[] = [
  {
    name: 'hygiene_report',
    description:
      'What ORCA costs the machines it runs on: disk by category (transcripts, logs, recovery, backups, scratch, artifacts), free space per volume, CPU and memory, and how fast ORCA\'s own files are growing. Call this when the operator asks about disk, memory, load or "what is ORCA using", and before you propose any cleanup. Every number carries a confidence, and the direction is part of it: `measured` was counted exactly; `atLeast` is a floor, the truth is that much OR MORE (a directory walk that hit its budget); `atMost` is a ceiling, the truth is that much OR LESS (memory in use on macOS, which counts reclaimable cache); `approximate` bounds nothing either way; `unavailable` means it could not be measured and the reason is attached. Repeat the direction when you report a number — saying "at least 40G" of a ceiling, or "40G" flat of a floor, tells the operator the opposite of the truth. Never round an `unavailable` down to zero. The growth figures are NET FILE GROWTH between two samples, not disk writes: a log that rotates writes megabytes and grows by nothing. Say "grew by" and never "wrote". Growth comes back `unavailable` whenever either sample was cut short, because the difference between two floors is bounded in neither direction; report that as "cannot be derived yet", not as no growth.',
    input_schema: {
      type: 'object',
      properties: {
        machine_id: {
          type: 'string',
          description: 'One machine. Omit for the whole fleet.',
        },
        include_processes: {
          type: 'boolean',
          description: 'Include per-process CPU and memory for ORCA\'s own processes.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'hygiene_candidates',
    description:
      'Preview what could be reclaimed: stale transcript directories, cold caches, old backups and logs, each with its size, age and the reason it qualifies. THIS TOOL DELETES NOTHING and there is no tool in this release that does — it exists so a person can see where the space went before anyone decides. Recovery files, handoffs and history are never listed, whatever their size: they are how a lost fleet is rebuilt. When you report these, give the total and the two or three biggest, say how old they are, and leave the decision with the operator.',
    input_schema: {
      type: 'object',
      properties: {
        machine_id: { type: 'string', description: 'One machine. Omit for the whole fleet.' },
        min_bytes: { type: 'number', description: 'Ignore anything smaller than this many bytes.' },
        limit: { type: 'number', description: 'How many to return, biggest first. Default 10.' },
      },
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'hygiene_sample',
    description:
      'Ask every connected collector for a fresh hygiene sample. Reports are taken on a ten-minute clock and cached, so the numbers you get from hygiene_report are usually a few minutes old — which is fine, disks move slowly. Use this only when the operator has just changed something and wants to see the effect, or when hygiene_report came back stale. The sample is a bounded directory walk on each machine; it returns as soon as the request is sent, and the new reports arrive on their own. Read them with hygiene_report a few seconds later.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
];

/** A reading, in the shape the model reads best: the number and how good it is. */
function wire(r: Reading, unit: 'bytes' | 'count' | 'pct' = 'bytes'): Record<string, unknown> {
  return {
    value: r.value,
    display: formatReading(r, unit),
    confidence: r.confidence,
    ...(r.note ? { note: r.note } : {}),
  };
}

function ageLine(report: HygieneReport, now: number): string {
  const mins = Math.round((now - report.at) / 60_000);
  return mins <= 0 ? 'just now' : `${mins} min ago`;
}

function pick(ctx: CeoContext, machineId: unknown): HygieneReport[] {
  const all = ctx.hygiene?.all() ?? [];
  if (typeof machineId === 'string' && machineId) {
    return all.filter((r) => r.machineId === machineId || r.hostname === machineId);
  }
  return all;
}

export async function runHygieneTool(
  ctx: CeoContext, name: string, input: Record<string, unknown>,
): Promise<ToolOutcome | null> {
  if (!name.startsWith('hygiene_')) return null;
  if (!ctx.hygiene) {
    return {
      result: 'Hygiene reporting is not available on this hub.',
      summary: `${name} unavailable`, isError: true,
    };
  }
  const now = Date.now();

  if (name === 'hygiene_sample') {
    const asked = ctx.hygiene.refresh(true);
    return {
      result: JSON.stringify({
        asked_machines: asked,
        note: asked === 0
          ? 'No collector is connected, so nobody was asked. The last reports still stand; check their age.'
          : 'Each machine walks its own directories and files a report when it finishes, usually within a second or two. Call hygiene_report again to read them.',
      }),
      summary: `asked ${asked} machine${asked === 1 ? '' : 's'} for a fresh sample`,
    };
  }

  const reports = pick(ctx, input.machine_id);
  if (reports.length === 0) {
    const any = (ctx.hygiene.all() ?? []).length;
    return {
      result: typeof input.machine_id === 'string' && input.machine_id
        ? `No hygiene report from "${input.machine_id}". ${any} machine(s) have reported. Collectors file one on connect and every ten minutes.`
        : 'No machine has filed a hygiene report yet. Collectors file one about twenty seconds after they connect, then every ten minutes. Call hygiene_sample to ask now.',
      summary: `${name}: nothing reported yet`,
    };
  }

  if (name === 'hygiene_candidates') {
    const minBytes = typeof input.min_bytes === 'number' ? input.min_bytes : 0;
    const limit = Math.max(1, Math.min(50, typeof input.limit === 'number' ? input.limit : 10));
    const rows = reports.flatMap((r) => r.candidates
      .filter((c) => (c.bytes.value ?? 0) >= minBytes)
      .map((c) => ({
        machine: r.hostname,
        path: c.path,
        category: CATEGORY_LABEL[c.category],
        bytes: wire(c.bytes),
        files: c.files,
        idle_days: c.newestAt === null ? null : Math.floor((now - c.newestAt) / 86_400_000),
        reason: c.reason,
      })))
      .sort((a, b) => ((b.bytes.value as number) ?? 0) - ((a.bytes.value as number) ?? 0));
    const total = reclaimable(reports.length === 1 ? reports[0]! : {
      ...reports[0]!, candidates: reports.flatMap((r) => r.candidates),
    });
    return {
      result: JSON.stringify({
        deletes_nothing: 'This is a preview. No tool in this release removes files or stops processes.',
        never_listed: 'History, recovery images and handoffs are excluded by rule, whatever their size.',
        reclaimable_total: wire(total),
        shown: rows.slice(0, limit),
        omitted: Math.max(0, rows.length - limit),
      }),
      summary: `${rows.length} candidate${rows.length === 1 ? '' : 's'}, ${formatReading(total)} reclaimable`,
    };
  }

  // hygiene_report
  const withProcesses = input.include_processes === true;
  const machines = reports.map((r) => ({
    machine_id: r.machineId,
    hostname: r.hostname,
    platform: r.platform,
    sampled: ageLine(r, now),
    sample_took_ms: r.tookMs,
    partial: isPartial(r),
    ...(isPartial(r)
      ? { partial_note: 'the directory walk hit its budget: every size here is a floor, not a total' }
      : {}),
    orca_total: wire(orcaTotal(r)),
    cpu_pct: wire(r.cpuPct, 'pct'),
    memory_used: wire(r.memUsedBytes),
    memory_total: wire(r.memTotalBytes),
    volumes: r.volumes.map((v) => ({
      path: v.path, total: wire(v.totalBytes), free: wire(v.freeBytes),
    })),
    categories: r.categories.map((c) => ({
      category: CATEGORY_LABEL[c.category],
      bytes: wire(c.bytes),
      files: wire(c.files, 'count'),
      newest: c.newestAt,
      coverage: {
        visited: c.coverage.visited, skipped: c.coverage.skipped,
        truncated: c.coverage.truncated, took_ms: c.coverage.tookMs,
      },
    })),
    growth: r.growth === null ? null : {
      what_this_is: 'net growth of ORCA’s own files between two samples — NOT disk writes',
      window_minutes: Math.round(r.growth.windowMs / 60_000),
      net_growth_bytes: wire(r.growth.netBytes),
      net_growth_bytes_per_sec: wire(r.growth.netBytesPerSec),
    },
    ...(withProcesses ? {
      processes: r.processes.map((p) => ({
        pid: p.pid, role: p.role, name: p.name,
        cpu_pct: wire(p.cpuPct, 'pct'), rss: wire(p.rssBytes),
      })),
    } : {}),
    limits: r.limits,
    reclaimable: wire(reclaimable(r)),
  }));

  const stale = reports.filter((r) => now - r.at > STALE_MS).length;
  const fleetTotal = ctx.hygiene.fleet();
  return {
    result: JSON.stringify({
      machines,
      ...(reports.length > 1 ? {
        fleet: {
          machines: fleetTotal.machines,
          orca_total: wire(fleetTotal.orcaBytes),
          reclaimable: wire(fleetTotal.reclaimableBytes),
        },
      } : {}),
      ...(stale > 0 ? {
        stale_warning: `${stale} report(s) are older than 15 minutes. Call hygiene_sample for fresh numbers.`,
      } : {}),
    }),
    summary: reports.length === 1
      ? `${reports[0]!.hostname}: ${formatBytes(orcaTotal(reports[0]!).value)} of ORCA files, ${formatReading(reclaimable(reports[0]!))} reclaimable`
      : `${reports.length} machines, ${formatReading(fleetTotal.orcaBytes)} of ORCA files`,
  };
}
