/**
 * El estado de un NEW CAPCOM pedido mientras la sesión no está lista.
 *
 * Mismo mecanismo que `ModelControl` (src/shared/model-control.ts): la
 * petición se encola, un `tick()` del lado del collector la reintenta hasta
 * que CAPCOM esté idle con el prompt limpio, y sólo entonces sale el `/clear`
 * real. `phase` es lo único que la consola necesita para dejar de mostrar un
 * error duro por pescar mal el instante.
 */
export interface CapcomResetControl {
  sessionId: string;
  runtime: string;
  mode: 'clean' | 'continuity';
  /** Con qué modelo nace el relevo; vacío si es el que ya corre. */
  model: string;
  phase: 'ready' | 'queued' | 'applying' | 'failed';
  detail: string;
  requestedAt: number;
}

/** Bounded state shared by disk, authenticated collector frames and the UI. */
export function parseCapcomResetControl(raw: unknown): CapcomResetControl | undefined {
  if (!raw || typeof raw !== 'object') return;
  const r = raw as Record<string, unknown>;
  const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._-]{1,72}$/.test(v);
  if (!id(r.sessionId) || !['codex', 'claude'].includes(String(r.runtime))
    || !['clean', 'continuity'].includes(String(r.mode))
    || !['ready', 'queued', 'applying', 'failed'].includes(String(r.phase))
    || typeof r.model !== 'string' || !/^[a-zA-Z0-9._-]{0,64}$/.test(r.model)
    || typeof r.requestedAt !== 'number' || !Number.isFinite(r.requestedAt)) return;
  return {
    sessionId: r.sessionId, runtime: String(r.runtime), mode: r.mode as 'clean' | 'continuity', model: r.model,
    phase: r.phase as CapcomResetControl['phase'], requestedAt: r.requestedAt,
    detail: typeof r.detail === 'string' ? r.detail.slice(0, 500) : '',
  };
}
