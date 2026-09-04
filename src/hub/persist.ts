/**
 * ORCA hub — persistencia ligera.
 *
 * Archivos, no base de datos. Todo vive bajo ~/.orca/hub/:
 *
 *   ceo.jsonl                 la conversación con el CEO (append-only)
 *   escalations.jsonl         escalaciones resueltas, con su respuesta
 *   events/YYYY-MM-DD.jsonl   log append-only de eventos, rotado por día
 *   overflow/YYYY-MM-DD.jsonl lo que se cayó del frame por recorte
 *
 * Las escrituras se acumulan en memoria y se vuelcan cada 500 ms: el hub recibe
 * ráfagas y no queremos un fsync por evento. Las lecturas de arranque sí son
 * síncronas — pasan una vez y simplifican el orden de inicio.
 */

import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CeoMessage, Escalation } from '../shared/types.ts';
import type { WorldEvent } from './world.ts';
import { ORCA_DIR } from './auth.ts';

export const HUB_DIR = join(ORCA_DIR, 'hub');

const FLUSH_MS = 500;
/** Un archivo de conversación no debería crecer sin fin; leemos sólo la cola. */
const CEO_TAIL_BYTES = 512 * 1024;
const DEFAULT_EVENT_RETENTION_DAYS = 14;

export interface StoreOptions {
  dir?: string;
  flushMs?: number;
  retentionDays?: number;
}

function dayStamp(at = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Lee las últimas líneas de un JSONL sin cargar el archivo entero. */
function readTailLines(file: string, maxBytes: number): string[] {
  try {
    if (!existsSync(file)) return [];
    const size = statSync(file).size;
    const buf = readFileSync(file);
    const slice = size > maxBytes ? buf.subarray(size - maxBytes) : buf;
    const text = slice.toString('utf8');
    const lines = text.split('\n');
    // Si cortamos por bytes, la primera línea puede estar mutilada.
    if (size > maxBytes) lines.shift();
    return lines.filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function parseLines<T>(lines: string[], guard: (v: unknown) => v is T): T[] {
  const out: T[] = [];
  for (const line of lines) {
    try {
      const v: unknown = JSON.parse(line);
      if (guard(v)) out.push(v);
    } catch {
      // Una línea corrupta (corte de luz a media escritura) no invalida el resto.
    }
  }
  return out;
}

function isCeoMessage(v: unknown): v is CeoMessage {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['id'] === 'string' && typeof o['text'] === 'string'
    && (o['role'] === 'human' || o['role'] === 'ceo' || o['role'] === 'system');
}

function isEscalation(v: unknown): v is Escalation {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['id'] === 'string' && typeof o['question'] === 'string';
}

export class HubStore {
  readonly dir: string;
  private buffers = new Map<string, string[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;
  private retentionDays: number;

  constructor(opts: StoreOptions = {}) {
    this.dir = opts.dir ?? HUB_DIR;
    this.retentionDays = opts.retentionDays ?? DEFAULT_EVENT_RETENTION_DAYS;
    mkdirSync(join(this.dir, 'events'), { recursive: true });
    mkdirSync(join(this.dir, 'overflow'), { recursive: true });
    this.timer = setInterval(() => { void this.flush(); }, opts.flushMs ?? FLUSH_MS);
    this.timer.unref?.();
  }

  private queue(file: string, record: unknown): void {
    if (this.closed) return;
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      return;   // referencias circulares: se descarta la línea, no el hub
    }
    const buf = this.buffers.get(file);
    if (buf) buf.push(line);
    else this.buffers.set(file, [line]);
  }

  /* ── escrituras ─────────────────────────────────────────────────── */

  logEvent(ev: WorldEvent): void {
    this.queue(join(this.dir, 'events', `${dayStamp(ev.at)}.jsonl`), ev);
  }

  appendCeo(msg: CeoMessage): void {
    this.queue(join(this.dir, 'ceo.jsonl'), msg);
  }

  /** Escalación resuelta. Se guarda entera para poder reusar la respuesta. */
  saveAnswered(e: Escalation): void {
    this.queue(join(this.dir, 'escalations.jsonl'), e);
  }

  /** Lo que se cayó del frame por recorte: sale del mundo, no de la historia. */
  overflow(kind: string, items: unknown[]): void {
    const file = join(this.dir, 'overflow', `${dayStamp()}.jsonl`);
    for (const item of items) this.queue(file, { kind, item });
  }

  /* ── lecturas de arranque ───────────────────────────────────────── */

  loadCeo(limit = 200): CeoMessage[] {
    const lines = readTailLines(join(this.dir, 'ceo.jsonl'), CEO_TAIL_BYTES);
    const msgs = parseLines(lines, isCeoMessage);
    // Un mensaje en streaming que quedó a medias por un reinicio ya no lo está.
    for (const m of msgs) if (m.streaming) m.streaming = false;
    return msgs.slice(-limit);
  }

  loadAnswered(limit = 500): Escalation[] {
    const lines = readTailLines(join(this.dir, 'escalations.jsonl'), CEO_TAIL_BYTES);
    return parseLines(lines, isEscalation).slice(-limit);
  }

  /* ── volcado ────────────────────────────────────────────────────── */

  flush(): Promise<void> {
    if (this.buffers.size === 0) return this.flushing;
    const batch = [...this.buffers.entries()];
    this.buffers.clear();
    // Encadenamos para que dos flushes no se pisen dentro del mismo archivo.
    this.flushing = this.flushing.then(async () => {
      for (const [file, lines] of batch) {
        try {
          await appendFile(file, `${lines.join('\n')}\n`, 'utf8');
        } catch (err) {
          console.warn('[persist] no pude escribir', file, err);
        }
      }
    });
    return this.flushing;
  }

  /** Volcado síncrono para el camino de salida del proceso. */
  flushSync(): void {
    for (const [file, lines] of this.buffers) {
      try {
        appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
      } catch { /* de salida, ya no hay a quién quejarse */ }
    }
    this.buffers.clear();
  }

  /** Borra logs de eventos más viejos que la retención. Best-effort. */
  async prune(now = Date.now()): Promise<void> {
    const cutoff = dayStamp(now - this.retentionDays * 86_400_000);
    for (const sub of ['events', 'overflow']) {
      try {
        const dir = join(this.dir, sub);
        for (const name of await readdir(dir)) {
          if (!name.endsWith('.jsonl')) continue;
          if (name.slice(0, 10) >= cutoff) continue;
          await rm(join(dir, name), { force: true });
        }
      } catch { /* sin logs viejos no pasa nada */ }
    }
  }

  async close(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.flush();
    this.closed = true;
  }
}

export async function ensureHubDir(dir = HUB_DIR): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}
