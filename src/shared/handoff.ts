/** A change of coordinator identity, separate from either CLI's transcript. */
export const HANDOFF_NOTICE_PREFIX = '[ORCA CONTEXT EVENT — information only]';

export interface CapcomHandoff {
  contextMode?: 'continuity' | 'clean';
  cutoffAt?: number;
  id: string;
  at: number;
  machineId: string;
  fromId: string;
  toId: string;
  fromRuntime: string;
  toRuntime: string;
  fromModel: string | null;
  toModel: string | null;
  reason: 'usage_limit' | 'manual' | 'context_rotation' | 'unknown';
  historyPath: string | null;
  checkpointPath: string | null;
}

const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_:#.-]{1,160}$/.test(v);
const label = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(v);
const file = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.startsWith('/') && v.length < 4096 && !/[\x00-\x1f]/.test(v));

export function parseHandoff(v: unknown): CapcomHandoff | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as CapcomHandoff;
  if (!id(r.fromId) || !id(r.toId) || r.fromId === r.toId || !id(r.machineId)
    || !Number.isFinite(r.at) || r.at <= 0 || !label(r.fromRuntime) || !label(r.toRuntime)
    || (r.fromModel !== null && !label(r.fromModel)) || (r.toModel !== null && !label(r.toModel))
    || !['usage_limit', 'manual', 'context_rotation', 'unknown'].includes(r.reason)
    || !file(r.historyPath) || !file(r.checkpointPath)) return null;
  if (r.contextMode !== undefined && !['continuity', 'clean'].includes(r.contextMode)) return null;
  if (r.contextMode && (!Number.isFinite(r.cutoffAt) || r.cutoffAt! <= 0)) return null;
  return { ...(r.contextMode ? { contextMode: r.contextMode, cutoffAt: r.cutoffAt } : {}), id: `handoff:${r.fromId}:${r.toId}`, at: r.at, machineId: r.machineId,
    fromId: r.fromId, toId: r.toId, fromRuntime: r.fromRuntime, toRuntime: r.toRuntime,
    fromModel: r.fromModel, toModel: r.toModel, reason: r.reason,
    historyPath: r.historyPath, checkpointPath: r.checkpointPath };
}

export function handoffReason(h: CapcomHandoff): string {
  return h.contextMode === 'clean' ? 'Operator requested clean context; files, history, rules and workers preserved'
    : h.contextMode === 'continuity' ? 'Fresh context with pending-work checkpoint'
    : h.reason === 'usage_limit' ? 'Usage limit reached'
    : h.reason === 'context_rotation' ? 'Context rotation'
    : h.reason === 'manual' ? 'Operator requested the handoff' : 'Reason not recorded';
}

export function handoffText(h: CapcomHandoff): string {
  return `CAPCOM HANDOFF · ${new Date(h.at).toISOString()} · ${h.fromRuntime}/${h.fromModel ?? 'model not recorded'} → ${h.toRuntime}/${h.toModel ?? 'model not recorded'}. ${handoffReason(h)}. `
    + (h.historyPath ? `Earlier messages are archived at ${h.historyPath}; TALK can load the archived conversation alongside the new session. ` : 'No earlier-history link was recorded. ')
    + (h.checkpointPath ? `Pending-work checkpoint: ${h.checkpointPath}. ` : '')
    + `This event does not complete pending work. Previous session: ${h.fromId}; new session: ${h.toId}.`;
}
