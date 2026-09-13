/**
 * Cuánto espera el collector antes de volver a llamar al hub.
 *
 * Es un módulo aparte, sin socket, porque la política es lo que falló el
 * 10-09 y tiene que poder probarse sin levantar nada: 4.912 reconexiones en
 * hora y media, a una por segundo, y ninguna prueba que lo mirara.
 *
 * Dos reglas, y las dos son la corrección de un supuesto que resultó falso:
 *
 * 1. Abrir el socket no es haber conectado. La espera antes se reseteaba en
 *    `open`, y en el bucle de dos collectors con el mismo id el socket abre
 *    siempre: el hub echa al anterior DESPUÉS de aceptar al nuevo. Así que la
 *    escalera volvía al primer peldaño cada segundo. Ahora sólo se resetea si
 *    la conexión DURÓ: una que abre y muere en un segundo cuenta como fallo.
 *
 * 2. Que te echen no es que se caiga la red. El hub lo dice con
 *    `CLOSE_REPLACED`, y el que lo recibe no puede volver sin echar al otro.
 *    Reintentar al segundo es insistir en una pelea que no se gana: lleva su
 *    propia escalera, que empieza en medio minuto, dobla hasta cinco y sólo
 *    baja cuando el collector ha vuelto y se ha quedado cinco minutos sin
 *    que nadie lo eche. Dos procesos peleando pasan de turnarse cada segundo
 *    a hacerlo cada cinco minutos, y cada vuelta queda escrita.
 *
 * No se rinde del todo: el otro puede ser un zombi que muere a los diez
 * minutos, y un collector que hubiera dejado de llamar dejaría la máquina
 * offline con un collector vivo dentro. Cinco minutos es lo bastante lento
 * para que no sea un bucle y lo bastante rápido para que la máquina vuelva.
 */

import { CLOSE_REPLACED } from '../shared/protocol.ts';

/** Escalera de red: 1 s ×1,8 hasta 30 s. La de siempre. */
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
/** Escalera de reemplazo: 30 s ×2 hasta 5 min. */
export const REPLACED_MIN_MS = 30_000;
export const REPLACED_MAX_MS = 300_000;
/** Una conexión más corta que esto no es una conexión: no resetea nada. */
export const STABLE_MS = 60_000;

export interface ReconnectPlan {
  /** Cuánto esperar antes de llamar otra vez. */
  waitMs: number;
  /** true cuando el cierre fue `CLOSE_REPLACED`. */
  replaced: boolean;
  /** Reemplazos seguidos sin haberse quedado REPLACED_MAX_MS. 0 si no fue reemplazo. */
  streak: number;
  /** Cuánto duró la conexión que acaba de cerrar; null si nunca llegó a abrir. */
  lastedMs: number | null;
}

export interface ReconnectOptions {
  minMs?: number;
  maxMs?: number;
  replacedMinMs?: number;
  replacedMaxMs?: number;
  stableMs?: number;
  /** Para las pruebas: sin jitter. */
  random?: () => number;
}

export class ReconnectPolicy {
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly replacedMinMs: number;
  private readonly replacedMaxMs: number;
  private readonly stableMs: number;
  private readonly random: () => number;

  private backoff: number;
  private displaced = 0;
  private openedAt: number | null = null;

  constructor(opts: ReconnectOptions = {}) {
    this.minMs = opts.minMs ?? RECONNECT_MIN_MS;
    this.maxMs = opts.maxMs ?? RECONNECT_MAX_MS;
    this.replacedMinMs = opts.replacedMinMs ?? REPLACED_MIN_MS;
    this.replacedMaxMs = opts.replacedMaxMs ?? REPLACED_MAX_MS;
    this.stableMs = opts.stableMs ?? STABLE_MS;
    this.random = opts.random ?? Math.random;
    this.backoff = this.minMs;
  }

  /** El socket abrió. No resetea nada: eso se decide al cerrar, por lo que duró. */
  opened(now: number): void {
    this.openedAt = now;
  }

  /** No se pudo ni construir el socket. Escalera de red. */
  failed(): ReconnectPlan {
    this.openedAt = null;
    return this.network(null);
  }

  /** El socket cerró con ese código. Decide la espera por el código y la duración. */
  closed(code: number | undefined, now: number): ReconnectPlan {
    const lasted = this.openedAt === null ? null : Math.max(0, now - this.openedAt);
    this.openedAt = null;
    if (code === CLOSE_REPLACED) return this.replaced(lasted);
    return this.network(lasted);
  }

  /** Reemplazos seguidos hasta ahora. Para el log y las pruebas. */
  get displacedStreak(): number { return this.displaced; }

  private network(lasted: number | null): ReconnectPlan {
    // Durar es lo único que devuelve la escalera al primer peldaño.
    if (lasted !== null && lasted >= this.stableMs) this.backoff = this.minMs;
    const base = Math.min(this.maxMs, this.backoff);
    const wait = base + this.random() * base * 0.3;
    this.backoff = Math.min(this.maxMs, Math.round(this.backoff * 1.8));
    return { waitMs: Math.round(wait), replaced: false, streak: 0, lastedMs: lasted };
  }

  private replaced(lasted: number | null): ReconnectPlan {
    // Volver y quedarse cinco minutos es haber ganado; que te echen antes es
    // la misma pelea, un peldaño más arriba.
    if (lasted !== null && lasted >= this.replacedMaxMs) this.displaced = 0;
    this.displaced += 1;
    const base = Math.min(this.replacedMaxMs, this.replacedMinMs * 2 ** (this.displaced - 1));
    const wait = base + this.random() * base * 0.3;
    return { waitMs: Math.round(wait), replaced: true, streak: this.displaced, lastedMs: lasted };
  }
}
