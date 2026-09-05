/**
 * ORCA hub — coalescing de patches.
 *
 * El problema: un agente escribiendo código produce decenas de eventos por
 * segundo, y veinte agentes producen cientos. Si cada mutación viajara al
 * navegador, la escena 3D se ahogaría antes de dibujar el primer fotograma.
 *
 * La solución: una ventana de 100 ms (10 Hz). Dentro de la ventana los ops se
 * colapsan por clave — dos `agent:patch` del mismo agente se funden en uno, y
 * un registro completo posterior gana sobre cualquier parcial anterior. Al
 * cerrar la ventana sale un único `{t:'patch'}`.
 *
 * Detalle importante: el primer op tras un periodo de calma sale de inmediato
 * (flanco de subida). Pulsar un botón y ver la respuesta en 100 ms se siente
 * lento; verla en 0 ms se siente correcto. Sólo las ráfagas pagan la espera.
 */

import type { Agent, FeedItem } from '../shared/types.ts';
import type { PatchOp } from '../shared/protocol.ts';

export interface PatchFrame {
  rev: number;
  ops: PatchOp[];
}

export interface BusOptions {
  /** Frecuencia máxima de emisión. 10 Hz por defecto. */
  hz?: number;
  /** Se llama justo antes de coalescer, para que el mundo asiente sus rollups. */
  onBeforeFlush?: () => void;
  /** Publica el frame ya coalescido. */
  onFlush: (frame: PatchFrame) => void;
  /** Tope defensivo: si algo se desboca, tiramos lo viejo antes que la RAM. */
  maxOps?: number;
  now?: () => number;
  /** Inyectable para tests deterministas. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/** Clave de coalescencia. Ops sin id colapsan sobre una clave global. */
function keyOf(op: PatchOp): string {
  switch (op.o) {
    case 'agent':
    case 'agent:patch':
      // Deliberadamente la misma clave: un parcial y un registro completo del
      // mismo agente son el mismo hecho contado dos veces.
      return `agent:${op.id}`;
    case 'machine': return `machine:${op.id}`;
    case 'project': return `project:${op.id}`;
    case 'escalation': return `escalation:${op.id}`;
    // Un mensaje y una colisión son registros completos: dos ops del mismo id
    // en la misma ventana son el mismo hecho contado dos veces y gana el último
    // (una entrega que añade un lector, un clear que la borra).
    case 'message': return `message:${op.id}`;
    case 'collision': return `collision:${op.id}`;
    case 'artifact': return `artifact:${op.id}`;
    case 'key': return `key:${op.id}`;
    case 'feed': return 'feed';
    case 'fleet': return 'fleet';
    case 'ceo:thinking': return 'ceo:thinking';
  }
}

/** Funde `next` sobre `prev` respetando la semántica de cada op. */
function merge(prev: PatchOp, next: PatchOp): PatchOp {
  if (prev.o === 'feed' && next.o === 'feed') {
    const items: FeedItem[] = [...prev.v, ...next.v];
    // Un solo frame nunca lleva más feed del que la consola muestra.
    return { o: 'feed', v: items.length > 500 ? items.slice(-500) : items };
  }
  if (next.o === 'agent:patch') {
    if (prev.o === 'agent:patch') {
      return { o: 'agent:patch', id: next.id, v: mergeAgent(prev.v, next.v) };
    }
    if (prev.o === 'agent') {
      // El registro completo ya está en el mundo; aplicar el parcial encima
      // mantiene el op autocontenido para una consola que llega tarde.
      if (prev.v === null) return next;      // borrado seguido de parche: raro, gana el parche
      return { o: 'agent', id: next.id, v: { ...prev.v, ...mergeAgent(prev.v, next.v) } as Agent };
    }
  }
  // Para todo lo demás: el último gana. Son registros completos.
  return next;
}

function mergeAgent(a: Partial<Agent>, b: Partial<Agent>): Partial<Agent> {
  const out: Partial<Agent> = { ...a, ...b };
  if (a.metrics && b.metrics) out.metrics = { ...a.metrics, ...b.metrics };
  return out;
}

export class PatchBus {
  private opts: Required<Omit<BusOptions, 'onBeforeFlush'>> & Pick<BusOptions, 'onBeforeFlush'>;
  private windowMs: number;
  /** Map preserva el orden de primera aparición; el valor es el último ganador. */
  private pending = new Map<string, PatchOp>();
  private timer: unknown = null;
  private lastFlush = 0;
  private stopped = false;
  /** Reentrada: onBeforeFlush empuja ops y no debe re-disparar el flush. */
  private flushing = false;
  /**
   * Secuencia de publicación. El protocolo exige que dos patches consecutivos
   * difieran en exactamente 1, y una ráfaga de 30 mutaciones (rev +30) sale en
   * un solo frame, así que el número del cable es este contador, no world.rev.
   */
  private pubRev = 0;

  readonly stats = { opsIn: 0, opsOut: 0, frames: 0, coalesced: 0 };

  constructor(options: BusOptions) {
    const hz = options.hz ?? 10;
    this.opts = {
      hz,
      onFlush: options.onFlush,
      onBeforeFlush: options.onBeforeFlush,
      maxOps: options.maxOps ?? 5_000,
      now: options.now ?? (() => Date.now()),
      schedule: options.schedule ?? ((fn, ms) => setTimeout(fn, ms)),
      cancel: options.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
    this.windowMs = Math.max(1, Math.round(1000 / hz));
  }

  /** Rev que verá la próxima consola que se conecte. */
  get rev(): number { return this.pubRev; }

  push(ops: PatchOp[] | PatchOp): void {
    if (this.stopped) return;
    const list = Array.isArray(ops) ? ops : [ops];
    for (const op of list) {
      this.stats.opsIn += 1;
      const k = keyOf(op);
      const prev = this.pending.get(k);
      if (prev) {
        this.stats.coalesced += 1;
        this.pending.set(k, merge(prev, op));
      } else {
        this.pending.set(k, op);
      }
    }
    if (this.pending.size > this.opts.maxOps) {
      // Presión imposible: preferimos perder lo más viejo y seguir vivos. La
      // consola se recupera pidiendo resync al detectar el hueco.
      const excess = this.pending.size - this.opts.maxOps;
      let i = 0;
      for (const k of this.pending.keys()) {
        if (i++ >= excess) break;
        this.pending.delete(k);
      }
    }
    this.arm();
  }

  private arm(): void {
    if (this.timer !== null || this.stopped || this.flushing) return;
    const since = this.opts.now() - this.lastFlush;
    if (since >= this.windowMs) { this.flush(); return; }
    this.timer = this.opts.schedule(() => { this.timer = null; this.flush(); }, this.windowMs - since);
  }

  /** Emite ya lo que haya. Devuelve el frame publicado, o null si no había nada. */
  flush(): PatchFrame | null {
    if (this.timer !== null) { this.opts.cancel(this.timer); this.timer = null; }
    this.lastFlush = this.opts.now();
    this.flushing = true;
    try {
      this.opts.onBeforeFlush?.();        // el mundo puede añadir ops (rollups)
    } catch (err) {
      console.error('[bus] onBeforeFlush falló:', err);
    } finally {
      this.flushing = false;
    }
    if (this.pending.size === 0) return null;
    const ops = [...this.pending.values()];
    this.pending.clear();
    this.pubRev += 1;
    this.stats.frames += 1;
    this.stats.opsOut += ops.length;
    const frame: PatchFrame = { rev: this.pubRev, ops };
    try {
      this.opts.onFlush(frame);
    } catch (err) {
      // Un consumidor que revienta no puede detener el bus.
      console.error('[bus] onFlush falló:', err);
    }
    return frame;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) { this.opts.cancel(this.timer); this.timer = null; }
    this.pending.clear();
  }
}
