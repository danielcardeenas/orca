/**
 * El contador de gestos de la consola: acumula aquí, manda al hub en lotes.
 *
 * Un gesto es una llamada a `gesture('win', 'agent')` desde donde ocurre —el
 * gestor de ventanas al abrir una, el HUD al desplegar una sección, el
 * teclado al atender un atajo, el campo al volar la cámara. Nada de eso
 * espera a la red: se suma a un mapa y sale cuando toca, en un solo frame
 * `gestures` con nombres y cuentas (ver `shared/gestures.ts`).
 *
 * Por qué lotes y no un frame por clic: una sesión de trabajo produce miles
 * de gestos, y un frame por cada uno sería la mitad del tráfico del socket
 * para decir «uno más». El hub no necesita saber CUÁNDO, sólo CUÁNTO en la
 * ventana de la revisión, así que cada `FLUSH_MS` —o antes, si se acumulan
 * `FLUSH_AT`— se manda lo que haya y se vacía.
 *
 * Si el enlace está caído el lote se queda: lo que se contó no se pierde por
 * una reconexión, sale con el primer envío que funcione. Con el enlace caído
 * mucho rato, el mapa deja de crecer en nombres a `MAX_GESTURE_BATCH` (lo que
 * el hub aceptaría de todos modos) y lo que llega nuevo se funde en `other`.
 */

import { GESTURE_OTHER, GESTURE_PREFIX, MAX_GESTURE_BATCH, gestureName, type GestureFamily } from '../shared/gestures.ts';

/** Cada cuánto sale un lote, si hay algo. */
export const FLUSH_MS = 15_000;
/** Con esto acumulado el lote sale sin esperar al reloj. */
export const FLUSH_AT = 50;

/** Manda un lote. Devuelve si salió; si no, el lote se conserva. */
export type GestureSink = (counts: Record<string, number>) => boolean;

export interface GestureMeter {
  hit(family: GestureFamily, detail: string): void;
  /** Manda lo acumulado ahora. `true` si salió (o no había nada). */
  flush(): boolean;
  /** Lo que aún no ha salido. Copia. */
  pending(): Record<string, number>;
  dispose(): void;
}

export interface MeterOptions {
  everyMs?: number;
  flushAt?: number;
  /** Los relojes, inyectables para poder probar sin esperar. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export function createGestureMeter(sink: GestureSink, opts: MeterOptions = {}): GestureMeter {
  const everyMs = opts.everyMs ?? FLUSH_MS;
  const flushAt = opts.flushAt ?? FLUSH_AT;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));

  const pending = new Map<string, number>();
  let total = 0;
  let timer: unknown = null;
  let disposed = false;

  function flush(): boolean {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (!pending.size) return true;
    const batch = Object.fromEntries(pending);
    if (!sink(batch)) return false;
    pending.clear();
    total = 0;
    return true;
  }

  function arm() {
    if (timer !== null || disposed) return;
    timer = setTimer(() => { timer = null; flush(); }, everyMs);
  }

  function hit(family: GestureFamily, detail: string) {
    if (disposed) return;
    let name = gestureName(family, detail);
    if (!name) return;
    // Sin sitio para un nombre nuevo: se funde en `other` aquí mismo, que es
    // lo que haría el hub y ahorra mandarle lo que va a tirar. El último
    // hueco del lote se reserva para `other`, que también es un nombre.
    if (!pending.has(name) && pending.size >= MAX_GESTURE_BATCH - 1) name = `${GESTURE_PREFIX}${family}:${GESTURE_OTHER}`;
    pending.set(name, (pending.get(name) ?? 0) + 1);
    total++;
    // Con bastante acumulado sale ya; si el enlace no lo dejó salir, el reloj
    // vuelve a intentarlo aunque no llegue ni un gesto más.
    if (total < flushAt || !flush()) arm();
  }

  return {
    hit, flush,
    pending: () => Object.fromEntries(pending),
    dispose() { disposed = true; if (timer !== null) { clearTimer(timer); timer = null; } pending.clear(); total = 0; },
  };
}

/* ── el contador de ESTA consola ──────────────────────────────────── */

/**
 * Antes de que `main.ts` conecte el enlace ya hay gestos (la sesión restaura
 * ventanas, el operador pulsa algo): se acumulan y salen con el primer lote.
 */
let sink: GestureSink = () => false;
const meter = createGestureMeter((counts) => sink(counts));

/** Un gesto más. Barato: un mapa y, a lo sumo, armar un reloj. */
export function gesture(family: GestureFamily, detail: string): void {
  meter.hit(family, detail);
}

/** Manda ahora lo acumulado. Lo usa la prueba en DOM real; la consola deja que decida el reloj. */
export function flushGestures(): boolean { return meter.flush(); }

/**
 * Conecta el contador con el enlace. Además manda lo pendiente cuando la
 * pestaña se esconde: es el último momento en el que un cierre de ventana
 * todavía deja salir un frame.
 */
export function mountGestures(send: GestureSink): () => void {
  sink = send;
  const onHide = () => { if (document.visibilityState === 'hidden') meter.flush(); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHide);
  return () => {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHide);
    sink = () => false;
  };
}
