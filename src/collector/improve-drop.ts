/**
 * El canal revisor → sección: `<proyecto>/.orca/improve/<id>.json`.
 *
 * Hermano de `escalate.ts` y de `messages.ts`, con la misma forma y por la
 * misma razón: un agente no tiene socket ni token, tiene un sistema de
 * ficheros. Un revisor de AUTOMEJORA archiva sus propuestas dejando un fichero
 * y el collector lo recoge, lo valida y lo sube al hub.
 *
 *   <project>/.orca/improve/<id>.json         el revisor archiva
 *   <project>/.orca/improve/<id>.ack.json     lo que pasó con ello
 *
 * El `.ack.json` no es cortesía: `orca-improve` lo espera y lo imprime, así
 * que el revisor se entera de qué propuestas entraron y por qué se rechazó
 * cada una de las demás. Sin él, un informe mal formado desaparecería en
 * silencio y la revisión entera se perdería sin que nadie —ni el agente, ni el
 * operador— lo supiera.
 *
 * El fichero se borra en cuanto se sube. No hay reintento: una propuesta
 * repetida se funde sola en el tablero por su clave (ver
 * `shared/improve.ts`), así que el fallo benigno es subir dos veces, no
 * perderlo. Y quien decide si el informe vale es el hub, que es el único que
 * sabe qué revisión está en vuelo y de quién es.
 *
 * Nada de lo que llega por aquí es de fiar: lo escribe un modelo. Se valida
 * tamaño, forma y número antes de que salga de la máquina.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { errText, guardAsync, isRecord, log, safeJson, str } from './util.ts';

const SCOPE = 'improve';

export const IMPROVE_DROP_DIR = path.join('.orca', 'improve');

/** Un informe más grande que esto no es una revisión, es un accidente. */
export const MAX_DROP_BYTES = 512 * 1024;
/** Propuestas por informe. El hub recorta al suyo; esto sólo evita lo absurdo. */
export const MAX_DROP_PROPOSALS = 24;

/** Lo que el collector sube por cada fichero que encuentra. */
export interface ImproveDrop {
  projectId: string;
  /** El agente que lo escribió, según el fichero o el más activo del proyecto. */
  agentId: string | null;
  /** La revisión que dice estar contestando. El hub lo comprueba. */
  reviewId: string | null;
  proposals: unknown[];
  /** Dónde dejar la respuesta para el agente. */
  ackFile: string;
}

export interface ImproveDropDeps {
  /** Atribuye el informe a un agente, como hace `escalate.ts`. */
  resolveAgent(projectId: string, hint: string | null): string | null;
}

/** Lo que el hub contestó, tal cual se le escribe al revisor. */
export interface ImproveAck {
  ok: boolean;
  filed?: number;
  merged?: number;
  rejected?: string[];
  error?: string;
}

export class ImproveDropWatcher {
  private tracked = new Map<string, { projectId: string; dir: string }>();
  private watchers = new Map<string, fs.FSWatcher>();
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  /** En vuelo hacia el hub: no se vuelve a leer el mismo fichero. */
  private busy = new Set<string>();
  private cbs: ((d: ImproveDrop) => void)[] = [];

  constructor(private readonly deps: ImproveDropDeps) {}

  onDrop(cb: (d: ImproveDrop) => void): void { this.cbs.push(cb); }

  start(pollMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.scan(); }, pollMs);
    this.timer.unref?.();
    void this.scan();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of this.watchers.values()) { try { w.close(); } catch { /* ya cerrado */ } }
    this.watchers.clear();
  }

  track(projectId: string, projectPath: string): void {
    const dir = path.join(projectPath, IMPROVE_DROP_DIR);
    const cur = this.tracked.get(projectId);
    if (cur && cur.dir === dir) return;
    this.untrack(projectId);
    this.tracked.set(projectId, { projectId, dir });
  }

  untrack(projectId: string): void {
    this.tracked.delete(projectId);
    const w = this.watchers.get(projectId);
    if (w) { try { w.close(); } catch { /* ya cerrado */ } this.watchers.delete(projectId); }
  }

  /** Escribe la respuesta del hub donde `orca-improve` la está esperando. */
  async ack(file: string, body: ImproveAck): Promise<void> {
    await guardAsync(SCOPE, `ack ${path.basename(file)}`,
      () => fsp.writeFile(file, JSON.stringify(body), { mode: 0o600 }), undefined);
    this.busy.delete(file.replace(/\.ack\.json$/, '.json'));
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const t of this.tracked.values()) {
        this.attachWatch(t);
        // Que el directorio no exista es el caso normal en casi todos los
        // proyectos y no merece ni una línea de log.
        const names = await readdirQuiet(t.dir);
        if (names === null) continue;
        for (const name of names) {
          if (!name.endsWith('.json') || name.endsWith('.ack.json')) continue;
          const file = path.join(t.dir, name);
          if (this.busy.has(file)) continue;
          const drop = await this.read(t.projectId, file);
          if (!drop) continue;
          this.busy.add(file);
          // Se borra antes de subir: el fallo benigno es que el hub no lo
          // reciba (el revisor lo ve en el ack y lo repite), no que un fichero
          // que ya se subió se suba en bucle a cada tic.
          await guardAsync(SCOPE, `borrar ${name}`, () => fsp.rm(file, { force: true }), undefined);
          for (const cb of this.cbs) { try { cb(drop); } catch { /* aislar */ } }
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private attachWatch(t: { projectId: string; dir: string }): void {
    if (this.watchers.has(t.projectId)) return;
    if (!fs.existsSync(t.dir)) return;
    try {
      const w = fs.watch(t.dir, () => { void this.scan(); });
      w.on('error', () => {
        try { w.close(); } catch { /* ya cerrado */ }
        this.watchers.delete(t.projectId);
      });
      this.watchers.set(t.projectId, w);
    } catch { /* sin watch queda el poll de 1s */ }
  }

  private async read(projectId: string, file: string): Promise<ImproveDrop | null> {
    let size = 0;
    try { size = (await fsp.stat(file)).size; } catch { return null; }
    if (size > MAX_DROP_BYTES) {
      log('warn', SCOPE, `${path.basename(file)} pesa ${size} bytes, ignorado`);
      await this.ack(ackFileFor(file), { ok: false, error: `report too large (${size} bytes)` });
      await guardAsync(SCOPE, 'borrar informe grande', () => fsp.rm(file, { force: true }), undefined);
      return null;
    }
    const text = await guardAsync(SCOPE, `leer ${path.basename(file)}`,
      () => fsp.readFile(file, 'utf8'), '');
    // Escrito a medias: el próximo tic lo reintenta. Por eso no se borra aquí.
    const obj = safeJson<Record<string, unknown>>(text);
    if (!obj) return null;
    const proposals = obj['proposals'];
    if (!Array.isArray(proposals) || proposals.length === 0) {
      log('warn', SCOPE, `${path.basename(file)} sin propuestas, ignorado`);
      await this.ack(ackFileFor(file), { ok: false, error: 'the report has no `proposals` array' });
      await guardAsync(SCOPE, 'borrar informe vacío', () => fsp.rm(file, { force: true }), undefined);
      return null;
    }
    const hint = str(obj['agentId']) || str(obj['sessionId']) || null;
    return {
      projectId,
      agentId: this.deps.resolveAgent(projectId, hint),
      reviewId: str(obj['reviewId']) || null,
      proposals: proposals.filter(isRecord).slice(0, MAX_DROP_PROPOSALS),
      ackFile: ackFileFor(file),
    };
  }
}

export function ackFileFor(file: string): string {
  return file.slice(0, -'.json'.length) + '.ack.json';
}

async function readdirQuiet(dir: string): Promise<string[] | null> {
  try { return await fsp.readdir(dir); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    log('warn', SCOPE, `no pude leer ${dir}: ${errText(err)}`);
    return null;
  }
}
