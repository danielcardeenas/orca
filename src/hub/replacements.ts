/**
 * Quién echó a quién, por máquina, en los últimos minutos.
 *
 * Un `hello` con el `machine.id` de una conexión viva sustituye a esa
 * conexión. Eso es lo normal cuando el collector reinicia: el viejo está
 * muriendo y el nuevo ocupa su plaza, una vez. Lo que no es normal es que
 * ocurra otra vez enseguida, y menos que el echado vuelva a echar al que lo
 * echó: eso son dos collectors vivos con la misma identidad turnándose, y el
 * 10-09 pasó 4.912 veces sin que ninguna línea lo distinguiera de una
 * reconexión.
 *
 * El hub no puede saber cuál de los dos es el legítimo, así que no elige:
 * cuenta, y a partir del segundo reemplazo en la ventana lo dice alto. El
 * ping-pong se reconoce por la señal, no por la frecuencia: el que entra es
 * uno al que echaron hace poco.
 */

import type { CollectorInstance } from '../shared/protocol.ts';

/** Ventana en la que dos reemplazos son un síntoma y no dos reinicios. */
export const REPLACEMENT_WINDOW_MS = 10 * 60_000;

export interface Replacement {
  at: number;
  /** Quién estaba y fue echado. null si el `hello` no traía instancia (collector viejo). */
  from: CollectorInstance | null;
  /** Quién entró. */
  to: CollectorInstance | null;
}

export interface ReplacementVerdict {
  /** Reemplazos de esta máquina en la ventana, incluido éste. */
  count: number;
  windowMs: number;
  /** El que entra es uno al que echaron dentro de la ventana: se están echando el uno al otro. */
  pingPong: boolean;
  /** Desde el segundo de la ventana. Es lo que se avisa. */
  repeated: boolean;
  from: CollectorInstance | null;
  to: CollectorInstance | null;
}

/** Etiqueta corta de una instancia, para logs y motivos de cierre. */
export function instanceLabel(i: CollectorInstance | null | undefined): string {
  if (!i) return 'collector sin instancia';
  return `pid ${i.pid} en ${i.cwd}`;
}

function sameInstance(a: CollectorInstance | null, b: CollectorInstance | null): boolean {
  return a !== null && b !== null && a.pid === b.pid && a.startedAt === b.startedAt && a.cwd === b.cwd;
}

export class ReplacementWatch {
  private readonly byMachine = new Map<string, Replacement[]>();

  constructor(private readonly windowMs = REPLACEMENT_WINDOW_MS) {}

  note(machineId: string, from: CollectorInstance | null, to: CollectorInstance | null, now: number): ReplacementVerdict {
    const kept = (this.byMachine.get(machineId) ?? []).filter((r) => now - r.at < this.windowMs);
    const pingPong = kept.some((r) => sameInstance(r.from, to));
    kept.push({ at: now, from, to });
    this.byMachine.set(machineId, kept);
    return {
      count: kept.length, windowMs: this.windowMs, pingPong, repeated: kept.length >= 2, from, to,
    };
  }

  /** Reemplazos recordados de una máquina, ya sin los que salieron de la ventana. */
  recent(machineId: string, now: number): Replacement[] {
    return (this.byMachine.get(machineId) ?? []).filter((r) => now - r.at < this.windowMs);
  }

  forget(machineId: string): void {
    this.byMachine.delete(machineId);
  }
}

/** Texto del aviso. Una frase, con lo que el operador necesita para actuar. */
export function replacementText(hostname: string, v: ReplacementVerdict): string {
  const minutes = Math.round(v.windowMs / 60_000);
  if (v.pingPong) {
    return `dos collectors con la identidad de ${hostname} se están echando el uno al otro: ${v.count} sustituciones en ${minutes} min, la última ${instanceLabel(v.to)} echa a ${instanceLabel(v.from)}`;
  }
  return `el collector de ${hostname} ha sido sustituido ${v.count} veces en ${minutes} min, la última por ${instanceLabel(v.to)}`;
}
