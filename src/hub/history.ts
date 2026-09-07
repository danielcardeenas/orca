/**
 * ORCA hub — la línea de tiempo de la flota.
 *
 * Un anillo de instantáneas compactas del mundo. No es un log de eventos: eso
 * ya existe (`~/.orca/hub/events/*.jsonl`) y sirve para auditar, no para
 * rebobinar. Para rebobinar el campo hace falta *el estado completo en un
 * instante*, y hace falta poder saltar a cualquier instante sin reproducir
 * medio día de eventos. Eso es una instantánea cada 20 s.
 *
 * Compacta a propósito: seis campos por agente, en una tupla, sin títulos ni
 * texto. El campo dibuja estado, color, velocidad, región y linaje — nada más.
 * Guardar `title`, `toolDetail` y `lastSay` multiplicaría por veinte el coste
 * de 24 h de historia para pintar un texto que en modo replay nadie lee.
 *
 *   agents[id] = [state, costUSD, tokensPerSec, projectId, parentId|'', callsign]
 *
 * Además de la cadencia fija hay una instantánea inmediata cuando un agente
 * cruza a `blocked` o a `dead`, coalescida a una cada 5 s. Son los dos únicos
 * instantes que el operador va a querer encontrar exactamente, y una rejilla de
 * 20 s los pierde la mitad de las veces.
 *
 * Persistencia: `~/.orca/history.jsonl`, append-only, con el patrón de
 * persist.ts (buffer en memoria, volcado cada 500 ms, volcado síncrono a la
 * salida). Se compacta al arrancar y cada hora reescribiendo el archivo desde el
 * anillo, así el disco nunca puede crecer por encima de lo que cabe en memoria.
 *
 * ── QUÉ HAY QUE CABLEAR ────────────────────────────────────────────────
 * Ya está cableado en `src/hub/server.ts` (startHub), y consiste en esto:
 *
 *   const history = options.history ?? new History();
 *   history.start(() => world.state);                       // tras crear world
 *   // en WorldHooks.onEvent:
 *   //   ev.kind === 'agent:state' && data.to === 'blocked'|'dead' → history.mark(world.state)
 *   // en el switch de HTTP:
 *   //   '/api/history'          → history.range(from, to, step)
 *   //   '/api/history/summary'  → history.summary(world.state, since)
 *   // en hub.close():           await history.close();
 */

import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AgentState, FeedItem, WorldState } from '../shared/types.ts';
import { AGENT_STATES } from '../shared/types.ts';
import { readJsonlTail } from './jsonl.ts';
import { ORCA_DIR } from './auth.ts';

export const HISTORY_FILE = join(ORCA_DIR, 'history.jsonl');

/** Cadencia normal. Veinte segundos es la resolución que el scrubber puede
 *  dibujar en 24 h sin que dos instantáneas caigan en el mismo píxel. */
export const SNAPSHOT_INTERVAL_MS = 20_000;
/** Cuánta historia se guarda. */
export const HISTORY_RETENTION_MS = 24 * 60 * 60_000;
/** Techo duro de instantáneas, para una flota que dispare marcas. */
export const MAX_SNAPSHOTS = 6_000;
/**
 * Techo de entradas agente×instantánea en todo el anillo.
 *
 * Los dos bounds de arriba acotan el *número* de instantáneas, no su tamaño: a
 * 300 agentes cada una pesa ~70 KB en memoria y 6.000 serían 400 MB, o sea el
 * hub muerto por guardar el pasado. Con este tercer techo una flota de decenas
 * conserva las 24 h enteras y una flota de cientos conserva menos horas, que es
 * la degradación correcta: nadie prefiere un día de historia y ningún hub.
 */
export const MAX_ENTRIES = 250_000;
/** Dos marcas seguidas dentro de esta ventana son una sola instantánea. */
export const MARK_COALESCE_MS = 5_000;
/** Techo de instantáneas por respuesta de `/api/history`. */
export const MAX_RANGE = 600;
/** Techo de filas por lista del resumen, y de líneas de feed que lleva. */
export const MAX_SUMMARY_ROWS = 50;
export const MAX_SUMMARY_LINES = 20;

const FLUSH_MS = 500;
const COMPACT_EVERY_MS = 60 * 60_000;
export const MAX_HISTORY_BYTES = 32 * 1024 * 1024;

/* ── forma ────────────────────────────────────────────────────────── */

/** `[state, costUSD, tokensPerSec, projectId, parentId|'', callsign]` */
export type SnapAgent = [AgentState, number, number, string, string, string];

export interface Snapshot {
  at: number;
  agents: Record<string, SnapAgent>;
  /** Agentes en `blocked` en este instante. Es lo que dibuja el histograma. */
  blocked: number;
  /** Gasto acumulado de la flota en este instante. */
  costUSD: number;
  /** Líneas de telemetría emitidas por el hub hasta aquí, monótono. */
  feedCursor: number;
}

export interface SummaryRow {
  id: string;
  callsign: string;
  projectId: string;
  /** Instante de la instantánea en la que se vio el cambio. */
  at: number;
}

export interface HistorySummary {
  since: number;
  at: number;
  spanMs: number;
  /** Cuántas instantáneas cubren el intervalo. 0 = no hay historia de eso. */
  snapshots: number;
  born: SummaryRow[];
  finished: SummaryRow[];
  died: SummaryRow[];
  blocked: SummaryRow[];
  /** De los que se bloquearon, los que siguen bloqueados *ahora*. */
  stillBlocked: SummaryRow[];
  /** Gasto del intervalo, no gasto total. Por agente y sumado. */
  costUSD: number;
  /** Cuántas líneas de telemetría pasaron, aunque ya no quepan en el frame. */
  feedLines: number;
  /** Las últimas `warn`/`alert` del intervalo que el frame todavía conserva. */
  lines: FeedItem[];
  /** true cuando el frame ya perdió parte de esas líneas por el techo de 500. */
  linesTruncated: boolean;
}

export interface HistoryRange {
  from: number;
  to: number;
  /** Paso efectivo, que puede ser mayor que el pedido si había que capar. */
  step: number;
  /** Instantáneas que existen en el rango antes de submuestrear. */
  total: number;
  snapshots: Snapshot[];
}

export interface HistoryOptions {
  /** Por defecto `~/.orca/history.jsonl`. */
  file?: string;
  intervalMs?: number;
  retentionMs?: number;
  maxSnapshots?: number;
  maxEntries?: number;
  maxFileBytes?: number;
  coalesceMs?: number;
  flushMs?: number;
  now?: () => number;
  /** Sin disco: para pruebas que sólo miran el anillo. */
  ephemeral?: boolean;
}

/* ── captura ──────────────────────────────────────────────────────── */

/** Redondeo: el céntimo y la décima de token/s son toda la precisión que el
 *  scrubber puede dibujar, y bajar de ahí engorda el archivo sin decir nada. */
function r4(n: number): number { return Math.round(n * 10_000) / 10_000; }
function r1(n: number): number { return Math.round(n * 10) / 10; }

/**
 * El mundo vivo, comprimido a lo que el campo necesita para dibujarlo.
 * Pura: dos llamadas con el mismo mundo dan la misma instantánea.
 */
export function snapshotOf(w: WorldState, at: number, feedCursor: number): Snapshot {
  const agents: Record<string, SnapAgent> = Object.create(null) as Record<string, SnapAgent>;
  let blocked = 0;
  let costUSD = 0;
  for (const a of Object.values(w.agents)) {
    agents[a.id] = [
      a.state,
      r4(a.metrics.costUSD),
      r1(a.metrics.tokensPerSec),
      a.projectId,
      a.parentId ?? '',
      a.callsign,
    ];
    if (a.state === 'blocked') blocked += 1;
    costUSD += a.metrics.costUSD;
  }
  return { at, agents, blocked, costUSD: r4(costUSD), feedCursor };
}

/* ── validación de lo que vuelve del disco ────────────────────────── */

const STATE_SET = new Set<string>(AGENT_STATES);

function isSnapAgent(v: unknown): v is SnapAgent {
  if (!Array.isArray(v) || v.length !== 6) return false;
  return typeof v[0] === 'string' && STATE_SET.has(v[0])
    && typeof v[1] === 'number' && Number.isFinite(v[1])
    && typeof v[2] === 'number' && Number.isFinite(v[2])
    && typeof v[3] === 'string' && typeof v[4] === 'string' && typeof v[5] === 'string';
}

/** Una línea del archivo no es de fiar: puede venir de otra versión, de un
 *  corte de luz a media escritura, o de alguien editándolo a mano. */
export function parseSnapshot(v: unknown): Snapshot | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const at = o['at'];
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const raw = o['agents'];
  if (typeof raw !== 'object' || raw === null) return null;
  const agents: Record<string, SnapAgent> = Object.create(null) as Record<string, SnapAgent>;
  let blocked = 0;
  for (const [id, t] of Object.entries(raw as Record<string, unknown>)) {
    if (id === '__proto__' || id === 'prototype' || id === 'constructor') continue;
    if (!isSnapAgent(t)) continue;
    agents[id] = t;
    if (t[0] === 'blocked') blocked += 1;
  }
  const cost = o['costUSD'];
  const cursor = o['feedCursor'];
  return {
    at,
    agents,
    blocked: typeof o['blocked'] === 'number' ? o['blocked'] : blocked,
    costUSD: typeof cost === 'number' && Number.isFinite(cost) ? cost : 0,
    feedCursor: typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : 0,
  };
}

export function entryCount(s: Snapshot): number {
  return Object.keys(s.agents).length;
}

/* ── submuestreo ──────────────────────────────────────────────────── */

/** Una por bucket de `step` ms, y siempre la última: el cursor tiene que poder
 *  aterrizar en el presente o el botón LIVE miente. */
function pick(list: Snapshot[], step: number): Snapshot[] {
  if (list.length === 0 || !(step > 0)) return list.slice();
  const out: Snapshot[] = [];
  let next = -Infinity;
  for (const s of list) {
    if (s.at >= next) { out.push(s); next = s.at + step; }
  }
  const last = list[list.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Submuestrea a `step` y, si aun así no cabe, ensancha el paso hasta que quepa.
 * Ensanchar en vez de truncar es deliberado: truncar tiraría un extremo del
 * rango, y el operador que pide 24 h quiere 24 h con menos detalle, no 4 h.
 */
export function subsample(list: Snapshot[], step: number, max = MAX_RANGE): { step: number; snapshots: Snapshot[] } {
  let used = step > 0 ? step : 0;
  let out = pick(list, used);
  if (out.length > max && list.length > 1) {
    const span = list[list.length - 1]!.at - list[0]!.at;
    used = Math.max(used, Math.ceil(span / max) || 1);
    out = pick(list, used);
  }
  if (out.length > max) out = out.slice(out.length - max);
  return { step: used, snapshots: out };
}

/* ── el anillo ────────────────────────────────────────────────────── */

export class History {
  private snaps: Snapshot[] = [];
  private entries = 0;

  private readonly file: string | null;
  private readonly intervalMs: number;
  private readonly retentionMs: number;
  private readonly maxSnapshots: number;
  private readonly maxEntries: number;
  private readonly coalesceMs: number;
  private readonly now: () => number;

  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private compactTimer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;
  private maxFileBytes: number;
  private diskBytes = 0;

  private lastMarkAt = 0;
  private lastFeedId = '';
  private feedCursor = 0;

  constructor(opts: HistoryOptions = {}) {
    this.file = opts.ephemeral ? null : (opts.file ?? HISTORY_FILE);
    this.maxFileBytes = opts.maxFileBytes ?? MAX_HISTORY_BYTES;
    this.intervalMs = opts.intervalMs ?? SNAPSHOT_INTERVAL_MS;
    this.retentionMs = opts.retentionMs ?? HISTORY_RETENTION_MS;
    this.maxSnapshots = opts.maxSnapshots ?? MAX_SNAPSHOTS;
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES;
    this.coalesceMs = opts.coalesceMs ?? MARK_COALESCE_MS;
    this.now = opts.now ?? (() => Date.now());

    if (this.file) {
      try { mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); }
      catch { /* si no hay dónde escribir, el anillo vive sólo en memoria */ }
      this.load();
      this.flushTimer = setInterval(() => { void this.flush(); }, opts.flushMs ?? FLUSH_MS);
      this.flushTimer.unref?.();
      this.compactTimer = setInterval(() => { void this.compact(); }, COMPACT_EVERY_MS);
      this.compactTimer.unref?.();
    }
  }

  get size(): number { return this.snaps.length; }
  /** Entradas agente×instantánea vivas. Lo que /api/health querría saber. */
  get entryCount(): number { return this.entries; }
  get first(): Snapshot | null { return this.snaps[0] ?? null; }
  get last(): Snapshot | null { return this.snaps[this.snaps.length - 1] ?? null; }

  /** Arranca la cadencia fija. `read` es la fuente del mundo vivo. */
  start(read: () => WorldState): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      try { this.push(read()); }
      catch (err) { console.warn('[history] instantánea fallida', err); }
    }, this.intervalMs);
    this.tickTimer.unref?.();
  }

  stop(): void {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  /** Instantánea incondicional. */
  push(w: WorldState, at = this.now()): Snapshot {
    const snap = snapshotOf(w, at, this.advanceFeed(w));
    this.snaps.push(snap);
    this.entries += entryCount(snap);
    this.trim(at);
    if (this.file && !this.closed) this.buffer.push(JSON.stringify(snap));
    return snap;
  }

  /**
   * Un agente acaba de cruzar a `blocked` o a `dead`. Instantánea inmediata,
   * pero como mucho una cada `coalesceMs`: una máquina que muere tumba veinte
   * agentes en el mismo tick y eso no son veinte instantáneas idénticas.
   */
  mark(w: WorldState, at = this.now()): Snapshot | null {
    if (at - this.lastMarkAt < this.coalesceMs) return null;
    this.lastMarkAt = at;
    return this.push(w, at);
  }

  /** Aplica los tres techos, del más viejo al más nuevo. */
  private trim(now: number): void {
    const cutoff = now - this.retentionMs;
    let drop = 0;
    while (drop < this.snaps.length && this.snaps[drop]!.at < cutoff) drop += 1;
    while (this.snaps.length - drop > this.maxSnapshots) drop += 1;
    let entries = this.entries;
    for (let i = 0; i < drop; i += 1) entries -= entryCount(this.snaps[i]!);
    while (entries > this.maxEntries && drop < this.snaps.length - 1) {
      entries -= entryCount(this.snaps[drop]!);
      drop += 1;
    }
    if (drop === 0) return;
    this.snaps.splice(0, drop);
    this.entries = entries;
  }

  /**
   * Cuántas líneas de feed lleva emitidas el hub.
   *
   * El feed del mundo está acotado a 500 líneas, así que no se puede contar
   * "cuántas hay": hay que contar cuántas han pasado. Se lleva el id de la
   * última vista y se cuenta la cola nueva. Si el feed dio la vuelta entera
   * entre dos instantáneas el id ya no está, y entonces se cuenta lo que hay —
   * subestima, que es el error correcto para un contador de "te perdiste esto".
   */
  private advanceFeed(w: WorldState): number {
    const feed = w.feed;
    if (feed.length === 0) return this.feedCursor;
    let start = 0;
    if (this.lastFeedId) {
      const i = feed.findIndex((f) => f.id === this.lastFeedId);
      start = i >= 0 ? i + 1 : 0;
    }
    this.feedCursor += feed.length - start;
    this.lastFeedId = feed[feed.length - 1]!.id;
    return this.feedCursor;
  }

  /* ── lecturas ─────────────────────────────────────────────────── */

  /** Instantáneas de `[from, to]`, submuestreadas a `step` ms y capadas a 600. */
  range(from: number, to: number, step = 0): HistoryRange {
    const lo = Number.isFinite(from) ? from : -Infinity;
    const hi = Number.isFinite(to) ? to : Infinity;
    const inRange = this.snaps.filter((s) => s.at >= lo && s.at <= hi);
    const { step: used, snapshots } = subsample(inRange, step);
    return { from: lo, to: hi, step: used, total: inRange.length, snapshots };
  }

  /**
   * "Qué pasó mientras no estabas."
   *
   * Se lee sobre la secuencia de instantáneas, no sobre el log de eventos,
   * porque lo que hace falta no son los hechos sino la *diferencia*: quién no
   * estaba y ahora está, quién estaba vivo y ya no. Un log te obliga a
   * reconstruir eso; una secuencia de estados lo tiene ya.
   *
   * La instantánea inmediatamente anterior a `since` es la línea base. Si no la
   * hay —la ausencia es más larga que la historia— se toma la primera del rango
   * y no se cuentan nacimientos antes de ella: no sabemos qué había, y un
   * resumen que se inventa veinte nacimientos es peor que uno que dice menos.
   */
  summary(w: WorldState, since: number, now = this.now()): HistorySummary {
    // Estrictamente posterior a `since`, y la línea base es la instantánea de
    // `since` o anterior: así una ausencia de cero segundos no encuentra nada
    // que contar, en vez de volver a contar la última transición.
    const range = this.snaps.filter((s) => s.at > since && s.at <= now);
    let base: Snapshot | null = null;
    for (const s of this.snaps) { if (s.at <= since) base = s; else break; }
    const seed = base ?? range[0] ?? null;
    const walk = seed && !base ? range.filter((s) => s.at > seed.at) : range;

    const prev = new Map<string, SnapAgent>();
    const firstCost = new Map<string, number>();
    const lastCost = new Map<string, number>();
    if (seed) {
      for (const [id, t] of Object.entries(seed.agents)) {
        prev.set(id, t);
        firstCost.set(id, t[1]);
        lastCost.set(id, t[1]);
      }
    }

    const born: SummaryRow[] = [];
    const finished: SummaryRow[] = [];
    const died: SummaryRow[] = [];
    const blocked: SummaryRow[] = [];

    for (const s of walk) {
      for (const [id, t] of Object.entries(s.agents)) {
        const p = prev.get(id);
        if (!p) {
          born.push(row(id, t, s.at));
          firstCost.set(id, t[1]);
        }
        if (t[0] === 'done' && p?.[0] !== 'done') finished.push(row(id, t, s.at));
        if (t[0] === 'dead' && p?.[0] !== 'dead') died.push(row(id, t, s.at));
        if (t[0] === 'blocked' && p?.[0] !== 'blocked') blocked.push(row(id, t, s.at));
        prev.set(id, t);
        lastCost.set(id, t[1]);
      }
    }

    let costUSD = 0;
    for (const [id, last] of lastCost) costUSD += Math.max(0, last - (firstCost.get(id) ?? 0));

    // Quién sigue bloqueado se lee del mundo vivo, no de la última instantánea:
    // es la lista sobre la que el operador va a actuar ahora mismo.
    const stillBlocked: SummaryRow[] = [];
    for (const b of blocked) {
      const a = w.agents[b.id];
      if (a && a.state === 'blocked') {
        stillBlocked.push({ id: a.id, callsign: a.callsign, projectId: a.projectId, at: a.block?.since ?? b.at });
      }
    }

    const feedFrom = seed?.feedCursor ?? 0;
    const feedTo = range[range.length - 1]?.feedCursor ?? feedFrom;
    const loud = w.feed.filter((f) => f.at >= since && f.at <= now && (f.level === 'warn' || f.level === 'alert'));
    const oldest = w.feed[0];

    return {
      since,
      at: now,
      spanMs: Math.max(0, now - since),
      snapshots: range.length,
      born: born.slice(-MAX_SUMMARY_ROWS),
      finished: finished.slice(-MAX_SUMMARY_ROWS),
      died: died.slice(-MAX_SUMMARY_ROWS),
      blocked: blocked.slice(-MAX_SUMMARY_ROWS),
      stillBlocked: stillBlocked.slice(-MAX_SUMMARY_ROWS),
      costUSD: r4(costUSD),
      feedLines: Math.max(0, feedTo - feedFrom),
      lines: loud.slice(-MAX_SUMMARY_LINES),
      // El frame guarda 500 líneas: si la más vieja que queda es posterior a
      // `since`, lo que había antes ya se cayó y decirlo es más honesto que
      // presentar una lista incompleta como si fuera completa.
      linesTruncated: !!oldest && oldest.at > since,
    };
  }

  /* ── disco ────────────────────────────────────────────────────── */

  /** Lee el archivo, aplica los techos y reescribe lo que sobrevive. */
  private load(): void {
    const file = this.file;
    if (!file || !existsSync(file)) return;
    let text = '';
    try { this.diskBytes = statSync(file).size; text = readJsonlTail(file, this.maxFileBytes).join('\n'); }
    catch (err) { console.warn('[history] no pude leer', file, err); return; }

    const kept: Snapshot[] = [];
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      let v: unknown;
      try { v = JSON.parse(line); } catch { continue; }
      const s = parseSnapshot(v);
      if (s) kept.push(s);
    }
    kept.sort((a, b) => a.at - b.at);
    this.snaps = kept;
    this.entries = 0;
    for (const s of kept) this.entries += entryCount(s);
    this.trim(this.now());
    const dropped = kept.length - this.snaps.length;
    this.feedCursor = this.last?.feedCursor ?? 0;
    // Se reescribe siempre que se haya tirado algo: si no, el archivo crecería
    // para siempre y sólo la memoria estaría acotada.
    if (dropped > 0 || this.diskBytes > this.maxFileBytes) void this.compact();
  }

  /**
   * Reescribe el archivo desde el anillo, atómicamente.
   *
   * El anillo es la verdad después de arrancar, así que compactar es volcarlo.
   * Efecto secundario deliberado: el disco hereda los tres techos de memoria y
   * no puede crecer por encima de ellos.
   */
  private diskBody(snaps = this.snaps): string {
    const lines: string[] = [];
    let bytes = 0;
    // Leave headroom so a full file is not rewritten on every snapshot.
    const budget = Math.floor(this.maxFileBytes * 0.75);
    for (let i = snaps.length - 1; i >= 0; i--) {
      const line = JSON.stringify(snaps[i]) + '\n';
      const size = Buffer.byteLength(line);
      if (bytes + size > budget) break;
      lines.unshift(line); bytes += size;
    }
    return lines.join('');
  }

  private async rewrite(body: string): Promise<void> {
    const file = this.file!;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, file);
      this.diskBytes = Buffer.byteLength(body);
    } catch (err) {
      console.warn('[history] compactación fallida', err);
      try { rmSync(tmp, { force: true }); } catch {}
    }
  }

  compact(): Promise<void> {
    if (!this.file || this.closed) return this.flushing;
    void this.flush();
    this.trim(this.now());
    const body = this.diskBody();
    // The replacement is queued behind prior appends; future appends queue
    // behind it. Capturing the body here prevents double-appending new samples.
    this.flushing = this.flushing.then(() => this.rewrite(body));
    return this.flushing;
  }

  flush(): Promise<void> {
    if (!this.file || this.buffer.length === 0) return this.flushing;
    const lines = this.buffer.join('\n') + '\n';
    this.buffer = [];
    const file = this.file;
    const bytes = Buffer.byteLength(lines);
    // Snapshot the ring before yielding, while it matches this batch.
    this.trim(this.now());
    const snapshots = this.snaps.slice();
    this.flushing = this.flushing.then(async () => {
      if (this.diskBytes + bytes > this.maxFileBytes) { await this.rewrite(this.diskBody(snapshots)); return; }
      try { await appendFile(file, lines, 'utf8'); this.diskBytes += bytes; }
      catch (err) { console.warn('[history] no pude escribir', file, err); }
    });
    return this.flushing;
  }

  /** Volcado síncrono para el camino de salida del proceso. */
  flushSync(): void {
    if (!this.file || this.buffer.length === 0) return;
    try { appendFileSync(this.file, `${this.buffer.join('\n')}\n`, 'utf8'); }
    catch { /* de salida, ya no hay a quién quejarse */ }
    this.buffer = [];
  }

  async close(): Promise<void> {
    this.stop();
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    if (this.compactTimer) { clearInterval(this.compactTimer); this.compactTimer = null; }
    await this.flush();
    this.closed = true;
  }
}

function row(id: string, t: SnapAgent, at: number): SummaryRow {
  return { id, callsign: t[5], projectId: t[3], at };
}
