export interface ModelChoice { id: string; label: string }
export interface ModelChangeEvent { id: string; at: number; from: string | null; to: string; text: string }
export interface ModelControl {
  sessionId: string;
  runtime: string;
  active: string | null;
  choices: ModelChoice[];
  phase: 'ready' | 'queued' | 'applying' | 'failed';
  requested: string | null;
  detail: string;
  events: ModelChangeEvent[];
}

/** Bounded state shared by disk, authenticated collector frames and the UI. */
export function parseModelControl(raw: unknown): ModelControl | undefined {
  if (!raw || typeof raw !== 'object') return;
  const r = raw as Record<string, unknown>;
  const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._-]{1,72}$/.test(v);
  if (!id(r.sessionId) || !['codex', 'claude'].includes(String(r.runtime))
    || !['ready', 'queued', 'applying', 'failed'].includes(String(r.phase))
    || !(r.active === null || id(r.active)) || !(r.requested === null || id(r.requested))
    || !Array.isArray(r.choices) || !Array.isArray(r.events)) return;
  const choices: ModelChoice[] = r.choices.slice(0, 100).flatMap(c => c && id(c.id) && typeof c.label === 'string' ? [{ id: c.id, label: c.label.slice(0, 120) }] : []);
  const events: ModelChangeEvent[] = r.events.slice(-50).flatMap(e => e && id(e.id) && id(e.to)
    && (e.from === null || id(e.from)) && typeof e.at === 'number' && Number.isFinite(e.at) && e.at > 0
    ? [{ id: e.id, at: e.at, from: e.from, to: e.to, text: `Model changed: ${e.from ?? 'unknown'} → ${e.to} · Same conversation. Applies to subsequent turns.` }] : []);
  return { sessionId: r.sessionId, runtime: String(r.runtime), active: r.active as string | null,
    requested: r.requested as string | null, phase: r.phase as ModelControl['phase'], choices, events,
    detail: typeof r.detail === 'string' ? r.detail.slice(0, 500) : '' };
}
