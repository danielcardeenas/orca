/**
 * Vigilancia incremental de los transcripts de Claude Code.
 *
 * El layout real en disco (verificado en Claude Code 2.1.260):
 *
 *   ~/.claude/projects/<slug>/<session-uuid>.jsonl               ← sesión raíz
 *   ~/.claude/projects/<slug>/<session-uuid>/subagents/
 *        agent-<agentId>.jsonl                                   ← subagente
 *        agent-<agentId>.meta.json                               ← su brief
 *
 * Un transcript raíz llega a 83MB en esta máquina. Releerlo entero en cada
 * cambio es inviable, así que este módulo mantiene un offset por archivo y sólo
 * lee bytes nuevos. Al arrancar tampoco reproduce la historia: lee la COLA del
 * archivo hacia atrás lo justo para reconstruir estado (título, último
 * cost-state, últimos turnos) y desde ahí sigue en vivo.
 *
 * fs.watch en macOS no es de fiar con archivos grandes que se reescriben por
 * append, así que hay dos motores en paralelo: el watch (baja latencia, poco
 * fiable) y un poll por stat cada 1500ms (alta latencia, siempre correcto).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { claudeProjectsDir, errText, guardAsync, log, safeJson } from './util.ts';

const SCOPE = 'watch';

/** Identidad de un transcript. `agentId` no nulo ⇒ es un subagente. */
export interface TranscriptRef {
  /** Ruta absoluta del .jsonl */
  path: string;
  /** Slug del proyecto, p.ej. "-Users-dan-projects-axolots" */
  slug: string;
  /** UUID de la sesión raíz (el nombre del archivo, o el del directorio padre). */
  sessionId: string;
  /** Id del subagente cuando aplica, p.ej. "a1a951f25ac6a8eb3". */
  agentId: string | null;
  /** Ruta del .meta.json que acompaña a un subagente. */
  metaPath: string | null;
  /** Id del workflow cuando el subagente vive bajo subagents/workflows/<wf>/. */
  workflowId: string | null;
  /** Id ORCA del agente: la sesión, o sesión#subagente. */
  key: string;
}

export interface LineBatch {
  ref: TranscriptRef;
  /** Líneas JSON completas y parseadas. Las corruptas se descartan en silencio. */
  lines: Record<string, unknown>[];
  /** true = lectura de cola al arrancar; no significa actividad en vivo. */
  bootstrap: boolean;
  /** mtime del archivo en el momento de la lectura. */
  mtimeMs: number;
  at: number;
}

export interface WatchOptions {
  root?: string;
  pollMs?: number;
  rescanMs?: number;
  /** Bytes de cola leídos al arrancar, de una sola lectura. */
  bootstrapBytes?: number;
  /** Tope de bytes leídos por archivo y por tick, para no bloquear el loop. */
  maxReadBytes?: number;
  /** Tope del rastreo hacia atrás de marcadores (cost-state, ai-title). */
  deepScanBytes?: number;
  /** Sólo se rastrea hacia atrás en archivos tocados dentro de esta ventana. */
  deepScanMaxAgeMs?: number;
  /**
   * Ventana de flota: un transcript sin tocar desde hace más de esto es
   * historial, no un agente. Sin este filtro la consola carga cada sesión que
   * la máquina haya tenido nunca —cientos— y deja de ser una consola de flota
   * para ser un archivo. 0 desactiva el filtro.
   */
  maxAgeMs?: number;
}

interface FileState {
  ref: TranscriptRef;
  offset: number;
  size: number;
  mtimeMs: number;
  /** Cola parcial: la última línea leída puede estar cortada a la mitad. */
  partial: string;
  reading: boolean;
  bootstrapped: boolean;
}

/**
 * Cola leída por archivo al arrancar. 1MB son ~1500 líneas de transcript real:
 * de sobra para título, últimos turnos y la tool en curso. Con 539 transcripts
 * en esta máquina, cada MB extra son 539MB de I/O antes de ver la flota.
 */
const DEFAULT_BOOTSTRAP_BYTES = 1024 * 1024;

export class TranscriptWatcher {
  private readonly root: string;
  private readonly pollMs: number;
  private readonly rescanMs: number;
  private readonly bootstrapBytes: number;
  private readonly maxRead: number;
  private readonly deepScanBytes: number;
  private readonly deepScanMaxAgeMs: number;
  private readonly maxAgeMs: number;

  private files = new Map<string, FileState>();
  private watchers: fs.FSWatcher[] = [];
  private timers: NodeJS.Timeout[] = [];
  private dirty = new Set<string>();
  private lineCbs: ((b: LineBatch) => void)[] = [];
  private goneCbs: ((r: TranscriptRef) => void)[] = [];
  private running = false;
  private draining = false;
  private deepQueue: { st: FileState; upTo: number; types: string[] }[] = [];
  private deepBusy = false;

  constructor(opts: WatchOptions = {}) {
    this.root = opts.root ?? claudeProjectsDir();
    this.pollMs = opts.pollMs ?? 1500;
    this.rescanMs = opts.rescanMs ?? 6000;
    this.bootstrapBytes = opts.bootstrapBytes ?? DEFAULT_BOOTSTRAP_BYTES;
    this.maxRead = opts.maxReadBytes ?? 4 * 1024 * 1024;
    this.deepScanBytes = opts.deepScanBytes ?? 16 * 1024 * 1024;
    this.deepScanMaxAgeMs = opts.deepScanMaxAgeMs ?? 14 * 24 * 3600_000;
    this.maxAgeMs = opts.maxAgeMs ?? Number(process.env['ORCA_FLEET_WINDOW_MS'] ?? 24 * 3600_000);
  }

  /** Cuántos transcripts descartó el último rescan por antigüedad. */
  skippedAsHistory = 0;

  onLines(cb: (b: LineBatch) => void): void { this.lineCbs.push(cb); }
  onGone(cb: (r: TranscriptRef) => void): void { this.goneCbs.push(cb); }

  /** Archivos conocidos ahora mismo. Lo usa lineage para resolver padres. */
  refs(): TranscriptRef[] {
    return [...this.files.values()].map((f) => f.ref);
  }

  /**
   * Busca transcripts nuevos AHORA, sin esperar al rescan periódico.
   *
   * Existe por un caso concreto: acabamos de lanzar una sesión y alguien está
   * esperando su id para poder lanzarle hijos (ver el ack de `spawn`). Esperar
   * los seis segundos del ciclo normal sería esperar por nada.
   */
  async refresh(): Promise<void> {
    if (!this.running) return;
    await this.rescan(false);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.rescan(true);
    this.attachWatch();
    this.timers.push(setInterval(() => { void this.poll(); }, this.pollMs));
    this.timers.push(setInterval(() => { void this.rescan(false); }, this.rescanMs));
    for (const t of this.timers) t.unref?.();
    log('info', SCOPE, `vigilando ${this.files.size} transcripts en ${this.root}`);
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const w of this.watchers) { try { w.close(); } catch { /* ya cerrado */ } }
    this.watchers = [];
  }

  /* ── descubrimiento ─────────────────────────────────────────────── */

  private attachWatch(): void {
    // recursive:true existe en macOS y Windows siempre, y en Linux desde Node 20.
    // Si no está, el poll ya cubre la corrección: sólo perdemos latencia.
    try {
      const w = fs.watch(this.root, { recursive: true }, (_e, name) => {
        if (typeof name !== 'string') { this.dirty.add('*'); return; }
        if (!name.endsWith('.jsonl')) { this.dirty.add('*'); return; }
        this.dirty.add(path.join(this.root, name));
        void this.drain();
      });
      w.on('error', (err) => log('warn', SCOPE, `fs.watch murió: ${errText(err)}`));
      this.watchers.push(w);
    } catch (err) {
      log('warn', SCOPE, `fs.watch recursivo no disponible, sólo poll: ${errText(err)}`);
    }
  }

  private async rescan(initial: boolean): Promise<void> {
    const found = await this.discover();
    const seen = new Set<string>();
    for (const ref of found) {
      seen.add(ref.path);
      if (this.files.has(ref.path)) continue;
      const st: FileState = {
        ref, offset: 0, size: 0, mtimeMs: 0, partial: '', reading: false, bootstrapped: false,
      };
      this.files.set(ref.path, st);
      // Un archivo que aparece después del arranque es una sesión nueva: también
      // se bootstrapea por la cola, porque puede nacer con historia (resume).
      void this.readFile(st);
    }
    for (const [p, st] of this.files) {
      if (seen.has(p)) continue;
      this.files.delete(p);
      for (const cb of this.goneCbs) { try { cb(st.ref); } catch { /* aislar */ } }
    }
    if (initial) log('debug', SCOPE, `descubiertos ${found.length} transcripts`);
  }

  private async discover(): Promise<TranscriptRef[]> {
    const out: TranscriptRef[] = [];
    const cutoff = this.maxAgeMs > 0 ? Date.now() - this.maxAgeMs : 0;
    let skipped = 0;

    /**
     * Un transcript ya conocido nunca se descarta por antigüedad: si el
     * collector lleva días arriba, el agente que abrió ayer sigue siendo suyo
     * y perderlo a medianoche sería peor que cargarlo de más.
     */
    const keep = async (ref: TranscriptRef): Promise<void> => {
      if (cutoff === 0 || this.files.has(ref.path)) { out.push(ref); return; }
      const stat = await guardAsync(SCOPE, `stat ${ref.key}`, () => fsp.stat(ref.path), null);
      if (!stat) return;
      if (stat.mtimeMs < cutoff) { skipped++; return; }
      out.push(ref);
    };
    for (const slugEnt of await readdirQuiet(this.root)) {
      if (!slugEnt.isDirectory()) continue;
      const slug = slugEnt.name;
      const slugDir = path.join(this.root, slug);
      for (const ent of await readdirQuiet(slugDir)) {
        if (ent.isFile() && ent.name.endsWith('.jsonl')) {
          const sessionId = ent.name.slice(0, -'.jsonl'.length);
          await keep({
            path: path.join(slugDir, ent.name),
            slug, sessionId, agentId: null, metaPath: null, workflowId: null,
            key: sessionId,
          });
          continue;
        }
        if (!ent.isDirectory()) continue;
        // La mayoría de las sesiones no tienen subagentes: que este directorio
        // no exista es lo normal, no un error, y por eso el readdir es silencioso.
        const subDir = path.join(slugDir, ent.name, 'subagents');
        for (const s of await readdirQuiet(subDir)) {
          if (s.isFile()) {
            const ref = subagentRef(subDir, s.name, slug, ent.name, null);
            if (ref) await keep(ref);
            continue;
          }
          if (!s.isDirectory() || s.name !== 'workflows') continue;
          // subagents/workflows/<wf_id>/agent-<id>.jsonl — agentes de workflow.
          const wfRoot = path.join(subDir, 'workflows');
          for (const wf of await readdirQuiet(wfRoot)) {
            if (!wf.isDirectory()) continue;
            const wfDir = path.join(wfRoot, wf.name);
            for (const f of await readdirQuiet(wfDir)) {
              if (!f.isFile()) continue;
              const ref = subagentRef(wfDir, f.name, slug, ent.name, wf.name);
              if (ref) await keep(ref);
            }
          }
        }
      }
    }
    this.skippedAsHistory = skipped;
    return out;
  }

  /* ── lectura ────────────────────────────────────────────────────── */

  private async poll(): Promise<void> {
    if (!this.running) return;
    for (const st of this.files.values()) {
      if (st.reading) continue;
      const stat = await guardAsync(SCOPE, `stat ${st.ref.key}`,
        () => fsp.stat(st.ref.path), null);
      if (!stat) continue;
      if (stat.size !== st.size || stat.mtimeMs !== st.mtimeMs) {
        void this.readFile(st);
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    // Coalescer: fs.watch dispara varias veces por append.
    await new Promise((r) => setTimeout(r, 40));
    const targets = [...this.dirty];
    this.dirty.clear();
    this.draining = false;
    if (targets.includes('*')) { void this.poll(); return; }
    for (const p of targets) {
      const st = this.files.get(p);
      if (st && !st.reading) void this.readFile(st);
    }
  }

  private async readFile(st: FileState): Promise<void> {
    if (st.reading) return;
    st.reading = true;
    try {
      const stat = await fsp.stat(st.ref.path);
      st.mtimeMs = stat.mtimeMs;
      if (stat.size < st.offset) {
        // Truncado o rotado bajo nuestros pies: el offset ya no significa nada.
        log('debug', SCOPE, `${st.ref.key} encogió, reiniciando offset`);
        st.offset = 0;
        st.partial = '';
        st.bootstrapped = false;
      }
      st.size = stat.size;
      if (!st.bootstrapped) {
        await this.bootstrap(st, stat.size);
        return;
      }
      if (stat.size <= st.offset) return;
      await this.readForward(st, stat.size);
    } catch (err) {
      // Archivo borrado en vuelo, permisos, disco lleno: nada de esto es fatal.
      log('debug', SCOPE, `lectura de ${st.ref.key} falló: ${errText(err)}`);
    } finally {
      st.reading = false;
    }
  }

  /**
   * Lee la cola del archivo en escalones crecientes hasta tener con qué
   * reconstruir estado, y deja el offset al final. Nunca reproduce la historia
   * completa: en un archivo de 83MB leemos como mucho 4MB.
   */
  private async bootstrap(st: FileState, size: number): Promise<void> {
    // UNA sola lectura. La versión anterior escalaba 256KB → 1MB → 4MB buscando
    // un cost-state, lo que en la práctica leía 5.25MB por archivo (2.8GB en
    // total aquí) y retrasaba minutos el primer cuadro de la flota. Ahora el
    // cost-state lo rescata el rastreo de fondo, y esta lectura sólo tiene que
    // dar el estado reciente.
    const want = Math.min(this.bootstrapBytes, size);
    const lines = await this.readTail(st.ref.path, size, want);
    st.offset = size;
    st.partial = '';
    st.bootstrapped = true;
    if (lines.length > 0) this.emit(st, lines, true);

    // El rescate del cost-state va DESPUÉS de emitir y sin await: leer decenas
    // de MB hacia atrás en los 132 archivos grandes de esta máquina no puede
    // retrasar el momento en que el collector empieza a ver la flota. Llega
    // como un segundo batch, y el deriver lo aplica igual.
    if (want < size && this.recent(st.mtimeMs)) {
      const missing = ['cost-state', 'ai-title']
        .filter((t) => !lines.some((l) => l['type'] === t));
      if (missing.length > 0) {
        this.deepQueue.push({ st, upTo: size - want, types: missing });
        void this.drainDeepQueue();
      }
    }
  }

  /**
   * En un transcript de 80MB la cola de 4MB puede no alcanzar al último
   * cost-state, y sin él el agente aparece costando $0. Rescatarlo parseando el
   * archivo entero sería inviable (2.8GB de corpus aquí), así que buscamos el
   * marcador hacia atrás a nivel de bytes: no parsea nada y para en el primer
   * acierto. En serie y cediendo el loop, porque es trabajo de fondo: el
   * tailing en vivo tiene prioridad absoluta sobre rellenar histórico.
   */
  private async drainDeepQueue(): Promise<void> {
    if (this.deepBusy) return;
    this.deepBusy = true;
    try {
      for (;;) {
        const job = this.deepQueue.shift();
        if (!job || !this.running) break;
        const found: Record<string, unknown>[] = [];
        for (const type of job.types) {
          const line = await this.findLastLine(
            job.st.ref.path, job.upTo, `"type":"${type}"`,
          ).catch(() => null);
          if (line) found.push(line);
        }
        if (found.length > 0) this.emit(job.st, found, true);
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      this.deepBusy = false;
    }
  }

  private recent(mtimeMs: number): boolean {
    return Date.now() - mtimeMs < this.deepScanMaxAgeMs;
  }

  /**
   * Busca hacia atrás la última línea que contenga `marker`, leyendo chunks de
   * 1MB desde `upTo` hacia el principio. Devuelve la línea parseada o null.
   */
  private async findLastLine(
    file: string, upTo: number, marker: string,
  ): Promise<Record<string, unknown> | null> {
    const CHUNK = 1024 * 1024;
    const floor = Math.max(0, upTo - this.deepScanBytes);
    const needle = Buffer.from(marker, 'utf8');
    const fh = await fsp.open(file, 'r');
    try {
      let end = upTo;
      while (end > floor) {
        const start = Math.max(floor, end - CHUNK);
        const len = end - start;
        if (len <= 0) break;
        const buf = Buffer.allocUnsafe(len);
        await fh.read(buf, 0, len, start);
        const hit = buf.lastIndexOf(needle);
        if (hit !== -1) {
          // Recortamos la línea completa alrededor del acierto. Si el salto de
          // línea anterior cayó fuera del chunk, damos el acierto por perdido:
          // habrá otro cost-state más adelante en el archivo.
          const nlBefore = buf.lastIndexOf(0x0a, hit);
          const nlAfter = buf.indexOf(0x0a, hit);
          if (nlBefore === -1 || nlAfter === -1) { end = start; continue; }
          const obj = safeJson<Record<string, unknown>>(
            buf.toString('utf8', nlBefore + 1, nlAfter),
          );
          if (obj) return obj;
        }
        // Retrocedemos dejando `needle.length - 1` bytes de solape, para que un
        // marcador partido justo en la frontera del chunk no se pierda.
        if (start === floor) break;
        end = start + needle.length - 1;
      }
      return null;
    } finally {
      await fh.close().catch(() => { /* ya cerrado */ });
    }
  }

  private async readTail(
    file: string, size: number, bytes: number,
  ): Promise<Record<string, unknown>[]> {
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return [];
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(len);
      await fh.read(buf, 0, len, start);
      let text = buf.toString('utf8');
      if (start > 0) {
        // La primera línea de la ventana casi seguro está cortada: tírala.
        const nl = text.indexOf('\n');
        text = nl === -1 ? '' : text.slice(nl + 1);
      }
      return parseLines(text).lines;
    } finally {
      await fh.close().catch(() => { /* ya cerrado */ });
    }
  }

  private async readForward(st: FileState, size: number): Promise<void> {
    const available = size - st.offset;
    const len = Math.min(available, this.maxRead);
    const fh = await fsp.open(st.ref.path, 'r');
    let text: string;
    try {
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, st.offset);
      text = buf.toString('utf8', 0, bytesRead);
      st.offset += bytesRead;
    } finally {
      await fh.close().catch(() => { /* ya cerrado */ });
    }
    const { lines, rest } = parseLines(st.partial + text);
    st.partial = rest;
    // Una cola parcial gigantesca sólo puede ser basura: no la arrastres.
    if (st.partial.length > 8 * 1024 * 1024) st.partial = '';
    if (lines.length > 0) this.emit(st, lines, false);
    if (available > len) void this.readFile(st); // seguimos en el próximo tick
  }

  private emit(st: FileState, lines: Record<string, unknown>[], bootstrap: boolean): void {
    const batch: LineBatch = {
      ref: st.ref, lines, bootstrap, mtimeMs: st.mtimeMs, at: Date.now(),
    };
    for (const cb of this.lineCbs) {
      try { cb(batch); } catch (err) {
        log('warn', SCOPE, `consumidor de líneas lanzó: ${errText(err)}`);
      }
    }
  }
}

/** readdir que trata "no existe" como lista vacía: es el caso mayoritario. */
async function readdirQuiet(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      log('debug', SCOPE, `readdir ${dir}: ${errText(err)}`);
    }
    return [];
  }
}

function subagentRef(
  dir: string, name: string, slug: string, sessionId: string, workflowId: string | null,
): TranscriptRef | null {
  if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) return null;
  const stem = name.slice(0, -'.jsonl'.length);
  const agentId = stem.slice('agent-'.length);
  if (!agentId) return null;
  return {
    path: path.join(dir, name),
    slug,
    sessionId,
    agentId,
    metaPath: path.join(dir, stem + '.meta.json'),
    workflowId,
    key: `${sessionId}#${agentId}`,
  };
}

/**
 * Parte un bloque de texto en líneas JSON completas y devuelve la cola sobrante.
 * Exportada porque el test la ejerce directamente.
 */
export function parseLines(text: string): {
  lines: Record<string, unknown>[]; rest: string;
} {
  const lines: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const nl = text.indexOf('\n', from);
    if (nl === -1) break;
    const raw = text.slice(from, nl);
    from = nl + 1;
    if (!raw) continue;
    const obj = safeJson<Record<string, unknown>>(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) lines.push(obj);
  }
  return { lines, rest: text.slice(from) };
}
