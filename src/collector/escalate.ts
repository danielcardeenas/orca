/**
 * El canal agente → humano.
 *
 * Un agente no puede hablar por el websocket de ORCA — no tiene socket, tiene
 * un filesystem. Así que el canal es un buzón en el propio repo:
 *
 *   <project>/.orca/ask/<id>.json           el agente pregunta
 *   <project>/.orca/ask/<id>.answer.json    ORCA responde; el agente hace polling
 *
 * El collector vigila la carpeta, convierte cada pregunta en `Escalation` y la
 * emite. Cuando llega la respuesta escribe el .answer.json y BORRA el pendiente,
 * en ese orden: si el proceso muere entre las dos operaciones el agente ya tiene
 * su respuesta y la pregunta se re-emitiría a lo sumo una vez, que es el fallo
 * benigno. Al revés perderíamos la respuesta.
 *
 * El contrato completo vive en docs/ESCALATION.md, porque el runtime del CEO y
 * la skill del agente dependen de él.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { Escalation } from '../shared/types.ts';
import { errText, guardAsync, isRecord, log, oneLine, safeJson, sha1, str } from './util.ts';

const SCOPE = 'escalate';
export const ASK_DIR = path.join('.orca', 'ask');

const URGENCIES = new Set(['low', 'normal', 'blocking']);

interface Tracked {
  projectId: string;
  projectPath: string;
  askDir: string;
}

interface Open {
  esc: Escalation;
  file: string;
  answerFile: string;
}

export interface EscalationDeps {
  machineId: string;
  /**
   * Atribuye la pregunta a un agente. El archivo puede declarar `agentId` o
   * `sessionId`; si no, el collector usa el agente más activo del proyecto.
   */
  resolveAgent(projectId: string, hint: string | null): string | null;
}

export class EscalationWatcher {
  private readonly deps: EscalationDeps;
  private tracked = new Map<string, Tracked>();
  private open = new Map<string, Open>();
  private watchers = new Map<string, fs.FSWatcher>();
  private timer: NodeJS.Timeout | null = null;
  private openCbs: ((e: Escalation) => void)[] = [];
  private withdrawCbs: ((id: string, reason: string) => void)[] = [];
  private scanning = false;

  constructor(deps: EscalationDeps) { this.deps = deps; }

  onOpen(cb: (e: Escalation) => void): void { this.openCbs.push(cb); }
  onWithdraw(cb: (id: string, reason: string) => void): void { this.withdrawCbs.push(cb); }

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
    const cur = this.tracked.get(projectId);
    if (cur && cur.projectPath === projectPath) return;
    this.untrack(projectId);
    this.tracked.set(projectId, {
      projectId, projectPath, askDir: path.join(projectPath, ASK_DIR),
    });
  }

  untrack(projectId: string): void {
    this.tracked.delete(projectId);
    const w = this.watchers.get(projectId);
    if (w) { try { w.close(); } catch { /* ya cerrado */ } this.watchers.delete(projectId); }
  }

  list(): Escalation[] {
    return [...this.open.values()].map((o) => o.esc);
  }

  get(id: string): Escalation | null {
    return this.open.get(id)?.esc ?? null;
  }

  /* ── escaneo ──────────────────────────────────────────────────── */

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const seen = new Set<string>();
      for (const t of this.tracked.values()) {
        this.attachWatch(t);
        // La inmensa mayoría de los proyectos nunca tendrán un .orca/ask: que
        // el directorio no exista es el caso normal y no merece ni una línea
        // de log (a 1Hz × N proyectos sería un DoS al propio operador).
        const names = await readdirQuiet(t.askDir);
        if (names === null) continue;
        for (const name of names) {
          if (!name.endsWith('.json') || name.endsWith('.answer.json')) continue;
          const file = path.join(t.askDir, name);
          const id = escalationId(file);
          seen.add(id);
          if (this.open.has(id)) continue;
          const esc = await this.read(t, file, id);
          if (esc) {
            this.open.set(id, {
              esc, file,
              answerFile: file.slice(0, -'.json'.length) + '.answer.json',
            });
            for (const cb of this.openCbs) { try { cb(esc); } catch { /* aislar */ } }
            log('info', SCOPE, `escalación abierta ${id}: ${oneLine(esc.question, 80)}`);
          }
        }
      }
      // El agente borró su propia pregunta: la resolvió solo o murió.
      for (const [id, o] of this.open) {
        if (seen.has(id)) continue;
        if (fs.existsSync(o.file)) continue;
        this.open.delete(id);
        for (const cb of this.withdrawCbs) {
          try { cb(id, 'el agente retiró la pregunta'); } catch { /* aislar */ }
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private attachWatch(t: Tracked): void {
    if (this.watchers.has(t.projectId)) return;
    if (!fs.existsSync(t.askDir)) return;
    try {
      const w = fs.watch(t.askDir, () => { void this.scan(); });
      w.on('error', () => {
        try { w.close(); } catch { /* ya cerrado */ }
        this.watchers.delete(t.projectId);
      });
      this.watchers.set(t.projectId, w);
    } catch {
      // Sin watch nos queda el poll de 1s, que para una pregunta a un humano
      // es latencia irrelevante.
    }
  }

  private async read(t: Tracked, file: string, id: string): Promise<Escalation | null> {
    const text = await guardAsync(SCOPE, `leer ${path.basename(file)}`,
      () => fsp.readFile(file, 'utf8'), '');
    const obj = safeJson<Record<string, unknown>>(text);
    if (!obj) return null; // escrito a medias; el próximo tick lo reintenta
    const question = str(obj['question']);
    if (!question) {
      log('warn', SCOPE, `${file} sin campo question, ignorado`);
      return null;
    }
    const hint = str(obj['agentId']) ?? str(obj['sessionId']);
    const agentId = this.deps.resolveAgent(t.projectId, hint) ?? hint ?? 'unknown';
    const urgencyRaw = str(obj['urgency']) ?? 'normal';
    const urgency = (URGENCIES.has(urgencyRaw) ? urgencyRaw : 'normal') as Escalation['urgency'];
    const options = Array.isArray(obj['options'])
      ? obj['options'].filter((o): o is string => typeof o === 'string').slice(0, 12)
      : [];
    let askedAt = Date.now();
    try { askedAt = fs.statSync(file).birthtimeMs || fs.statSync(file).mtimeMs; } catch { /* ok */ }
    const ttlMin = typeof obj['ttlMinutes'] === 'number' ? obj['ttlMinutes'] : null;

    return {
      id,
      agentId,
      projectId: t.projectId,
      machineId: this.deps.machineId,
      question: oneLine(question, 600),
      context: str(obj['context']),
      options,
      optionsOnly: obj['optionsOnly'] === true && options.length > 0,
      urgency,
      status: 'pending',
      ceoAttempt: null,
      answer: null,
      answeredBy: null,
      rememberAs: null,
      askedAt,
      answeredAt: null,
      expiresAt: ttlMin !== null ? askedAt + ttlMin * 60_000 : null,
    };
  }

  /* ── respuesta ────────────────────────────────────────────────── */

  /**
   * Escribe la respuesta y retira el pendiente. Devuelve false si la escalación
   * ya no existe — responder a algo desconocido nunca debe tocar disco.
   */
  async answer(
    id: string, answer: string, rememberAs: string | null, by: 'human' | 'ceo' = 'human',
  ): Promise<boolean> {
    const o = this.open.get(id);
    if (!o) { log('warn', SCOPE, `respuesta para escalación desconocida ${id}`); return false; }
    const at = Date.now();
    const payload = {
      answer, at,
      answeredBy: by,
      rememberAs,
      id: path.basename(o.file, '.json'),
    };
    try {
      // Escritura atómica: el agente hace polling y no debe leer un JSON a medias.
      const tmp = o.answerFile + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await fsp.rename(tmp, o.answerFile);
    } catch (err) {
      log('error', SCOPE, `no pude escribir la respuesta de ${id}: ${errText(err)}`);
      return false;
    }
    await fsp.unlink(o.file).catch(() => { /* el agente ya la borró */ });
    o.esc.status = 'answered';
    o.esc.answer = answer;
    o.esc.answeredBy = by;
    o.esc.answeredAt = at;
    o.esc.rememberAs = rememberAs;
    this.open.delete(id);
    log('info', SCOPE, `escalación ${id} respondida por ${by}`);
    return true;
  }

  /** Retira sin responder: el agente murió esperando, o expiró. */
  withdraw(id: string, reason: string): boolean {
    const o = this.open.get(id);
    if (!o) return false;
    this.open.delete(id);
    for (const cb of this.withdrawCbs) { try { cb(id, reason); } catch { /* aislar */ } }
    return true;
  }

  /** Barre las que pasaron su expiresAt. Lo llama el loop principal. */
  reapExpired(now = Date.now()): string[] {
    const out: string[] = [];
    for (const [id, o] of this.open) {
      if (o.esc.expiresAt !== null && o.esc.expiresAt < now) {
        this.open.delete(id);
        out.push(id);
        for (const cb of this.withdrawCbs) {
          try { cb(id, 'expiró'); } catch { /* aislar */ }
        }
      }
    }
    return out;
  }
}

/** readdir que devuelve null en "no existe" sin ensuciar el log. */
async function readdirQuiet(dir: string): Promise<string[] | null> {
  try {
    return await fsp.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      log('debug', SCOPE, `readdir ${dir}: ${errText(err)}`);
    }
    return null;
  }
}

/**
 * Id estable y global: el mismo archivo produce el mismo id tras un reinicio del
 * collector, y dos proyectos con un `ask/1.json` cada uno no colisionan.
 */
export function escalationId(file: string): string {
  return 'esc_' + sha1(path.resolve(file)).slice(0, 16);
}

/** Sólo para tests: valida la forma de un buzón sin tocar el watcher. */
export function isAskPayload(v: unknown): boolean {
  return isRecord(v) && typeof v['question'] === 'string' && v['question'].length > 0;
}
