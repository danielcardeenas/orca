export interface Continuation {
  fromId: string; at: number; archive: string; historyPath: string; checkpointPath: string;
}
export function parseContinuation(v: unknown): Continuation | undefined {
  if (!v || typeof v !== 'object') return;
  const o = v as Record<string, unknown>;
  if (!['fromId', 'archive', 'historyPath', 'checkpointPath'].every(k => typeof o[k] === 'string' && (o[k] as string).length > 0 && (o[k] as string).length < 4096) || typeof o.at !== 'number' || !Number.isFinite(o.at)) return;
  return { fromId: o.fromId as string, at: o.at, archive: o.archive as string, historyPath: o.historyPath as string, checkpointPath: o.checkpointPath as string };
}
