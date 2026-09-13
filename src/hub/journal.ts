/**
 * Pieza E del squad autonomy: journal. Lado hub.
 *
 * El diario de la flota: un registro persistente y consultable de lo que los
 * agentes han hecho, para que una sesión CAPCOM nueva aprenda de las
 * anteriores y para que el operador pueda auditar. `remember`/`recall`
 * guardan reglas del humano; esto guarda RESULTADOS.
 *
 * ── Qué se anota ───────────────────────────────────────────────────
 *
 *   launch     un agente entró al mundo: quién lo lanzó (humano / CAPCOM /
 *              agente), proyecto, squad, tarea, brief completo, runtime, modelo
 *   end        pasó a done o dead: uso (tokens), duración, líneas, último
 *              mensaje recortado. `costUSD` se sigue anotando y ya no lo lee
 *              nadie: ver `JournalEntry.costUSD`
 *   escalation un agente preguntó (ask_human o pregunta al mando)
 *   answer     quién contestó esa escalación (CAPCOM o humano) y qué dijo
 *   withdraw   esa escalación dejó de existir sin respuesta, y por qué causa
 *              (`WithdrawCause`, shared/types.ts): el agente siguió, el diálogo de
 *              permisos cambió, el agente se fue, la sustituyó otra, caducó,
 *              alguien la descartó. Sin esta entrada toda retirada contaba
 *              como «sin respuesta», que es la cifra con la que se juzga si
 *              el mando atiende a la flota
 *   rotation   CAPCOM se recicló: de qué sesión a cuál, y con qué cifras
 *   landing    un worktree aterrizó en la rama del proyecto (pieza C, si existe)
 *
 * ── Dónde ──────────────────────────────────────────────────────────
 *
 *   ~/.orca/hub/journal/journal.jsonl              el fichero vivo, append-only
 *   ~/.orca/hub/journal/journal.<stamp>.jsonl      rotados por tamaño
 *   ~/.orca/hub/journal/state.json                 cuándo fue el último briefing
 *
 * Append-only como todo en ~/.orca/hub: una entrada por hecho, nunca se
 * reescribe una línea. Cuando el fichero vivo supera `ORCA_JOURNAL_MAX_BYTES`
 * (8 MiB) se renombra con la fecha y se abre otro; se conservan los últimos
 * `ORCA_JOURNAL_KEEP` (6) rotados. Las consultas leen todos los ficheros, del
 * más viejo al más nuevo, y filtran línea a línea: no hay índice en memoria
 * más allá de "qué agentes ya tienen launch/end", que es lo único que hace
 * falta para no anotar dos veces lo mismo cuando un collector reenvía su
 * snapshot tras un reinicio del hub.
 *
 * ── De dónde salen los hechos ──────────────────────────────────────
 *
 * Del ciclo de vida tipado (lifecycle.ts): agent:new, agent:state,
 * escalation:new, escalation:answered, escalation:withdrawn. Más un barrido cada
 * `ORCA_JOURNAL_SWEEP_MS` (5 s) sobre la flota entera, porque un snapshot de
 * collector (arranque del hub, reconexión) mete agentes en el mundo sin
 * evento alguno, y los da por muertos igual de en silencio: el barrido anota
 * el launch que falta y el end que nadie vio pasar, marcado `late`. Y de dos
 * ganchos que server.ts puede llamar si los tiene cableados: `rotated` (el
 * frame capcom:rotated, con sus cifras) y `spawnRequested` (quién pidió el
 * spawn).
 * Sin ellos el diario sigue funcionando con lo que se puede deducir del
 * agente: una rotación es un CAPCOM nuevo cuando había otro, y el que lanza
 * es el padre (CAPCOM si el padre es CAPCOM, un agente si no, el humano si no
 * hay padre).
 */

import { appendFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Agent, WithdrawCause } from '../shared/types.ts';
import { TERMINAL_STATES, WITHDRAW_CAUSES } from '../shared/types.ts';
import { isSynthetic } from '../shared/synthetic.ts';
import { ceilingTokens } from '../shared/tokens.ts';
import { fmtTokens } from './budgets.ts';
import type { AutonomyDeps } from './autonomy.ts';
import type { EscalationAnswered, EscalationRaised, EscalationWithdrawn } from './lifecycle.ts';
import { normalize } from './memory.ts';

/* ── el registro ──────────────────────────────────────────────────── */

export type JournalKind = 'launch' | 'end' | 'escalation' | 'answer' | 'withdraw' | 'rotation' | 'landing';
export const JOURNAL_KINDS: readonly JournalKind[] = ['launch', 'end', 'escalation', 'answer', 'withdraw', 'rotation', 'landing'];

export type LaunchedBy = 'human' | 'capcom' | 'agent';
export type AnsweredBy = 'human' | 'capcom';
export type FinalState = 'done' | 'dead';

/**
 * Una línea del diario. Plana a propósito: un registro con cinco formas
 * distintas anidadas es cinco lectores; uno plano con campos opcionales se
 * filtra, se imprime y se agrega con el mismo código.
 */
export interface JournalEntry {
  id: string;
  at: number;
  kind: JournalKind;

  agentId: string | null;
  callsign: string | null;
  machineId: string | null;
  projectId: string | null;
  /** El código del proyecto (AX), que es como lo nombra una persona. */
  project: string | null;
  squad: string | null;
  missionId: string | null;

  /* launch */
  by?: LaunchedBy;
  parentId?: string | null;
  lead?: boolean;
  /** El brief completo, sin recortar: es lo que una sesión nueva quiere releer. */
  brief?: string | null;
  title?: string | null;
  runtime?: string | null;
  model?: string | null;
  origin?: 'orca' | 'external' | null;
  startedAt?: number;

  /* end */
  state?: FinalState;
  /**
   * Lo que el CLI dijo que costó, en dólares. **Histórico.** Se sigue
   * escribiendo porque el transcript lo trae y borrarlo del modelo no haría
   * más cierto lo ya escrito, pero desde el 2026-09-12 NADA lo suma ni lo
   * presenta: esta flota va con plan plano y la cifra no corresponde a ningún
   * cobro. Lo que se mide es `tokens`. Ver docs/INVENTARIO-DINERO-2026-09-12.md.
   */
  costUSD?: number;
  durationMs?: number;
  /**
   * `cacheWrite` falta en toda entrada anterior al 2026-09-12: el journal no lo
   * guardaba. `entryTokens` cae entonces al mismo fallback que `ceilingTokens`.
   */
  tokens?: { input: number; output: number; cacheRead: number; thinking: number; cacheWrite?: number };
  lines?: { added: number; removed: number };
  toolCalls?: number;
  turns?: number | null;
  /** Lo último que dijo, recortado a MAX_SAY. */
  lastSay?: string | null;
  /** True cuando el fin se anotó al reaparecer el agente ya terminado (el hub no lo vio pasar). */
  late?: boolean;

  /* escalation / answer */
  escalationId?: string | null;
  question?: string | null;
  urgency?: string | null;
  options?: string[];
  answer?: string | null;
  answeredBy?: AnsweredBy;
  rememberAs?: string | null;
  /** answer / withdraw: cuánto estuvo abierta la pregunta. */
  waitedMs?: number | null;
  /* withdraw */
  cause?: WithdrawCause;
  /** withdraw: la prosa de quien la retiró. */
  reason?: string | null;

  /* rotation */
  fromId?: string | null;
  toId?: string | null;
  compactions?: number | null;
  contextTokens?: number | null;

  /* landing */
  branch?: string | null;
  target?: string | null;
  commit?: string | null;
  ok?: boolean;
  detail?: string | null;

  note?: string | null;

  /**
   * La escribió una máquina del arnés (`shared/synthetic.ts`).
   *
   * Se anota y NO se descarta. Descartar era lo de antes, y descartar es
   * borrar: dejaba el diario limpio pero sin forma de contestar «¿cuánto de
   * aquello era de pruebas?» ni de enseñar la serie completa a quien la
   * pidiera. Con la marca, toda lectura agregada la excluye por defecto —que
   * es lo único que importa para que una cifra sea uso real— y además puede
   * decir cuánto excluyó. Ausente significa real, como en toda la frontera.
   */
  synthetic?: true;
}

export type JournalInput = Omit<JournalEntry, 'id' | 'at'> & { at?: number };

/** Lo último que dijo un agente se guarda recortado: el diario no es el transcript. */
export const MAX_SAY = 600;
export const MAX_QUESTION = 1200;
export const MAX_BRIEF = 12_000;

export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_KEEP = 6;
export const JOURNAL_FILE = 'journal.jsonl';
const STATE_FILE = 'state.json';
/**
 * `journal.<fecha>.<n>.jsonl`: la fecha para que una persona sepa de cuándo es,
 * el contador para que el orden no dependa de ella (dos rotaciones en el mismo
 * segundo, un reloj que se atrasa).
 */
const ROTATED = /^journal\.(\d{8}-\d{6})\.(\d+)\.jsonl$/;
function rotatedSeq(name: string): number { return Number(ROTATED.exec(name)?.[2] ?? -1); }
function sortRotated(names: string[]): string[] {
  return names.filter((n) => ROTATED.test(n)).sort((a, b) => rotatedSeq(a) - rotatedSeq(b));
}

function isEntry(v: unknown): v is JournalEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['id'] === 'string' && typeof o['at'] === 'number'
    && typeof o['kind'] === 'string' && (JOURNAL_KINDS as readonly string[]).includes(o['kind']);
}

/**
 * Una entrada escrita antes del renombrado, leída con el vocabulario de hoy.
 *
 * El journal es un jsonl que se acumula durante meses y el campo se llamaba
 * `taskId`. Sin esto, un filtro por `mission_id` no encontraría nada anterior
 * al renombrado y `endLine` dejaría de nombrar la misión de las entradas
 * viejas: el dato sigue ahí, sólo cambió de nombre. Se traduce al leer y se
 * escribe siempre con el nombre nuevo, así que el fichero migra al rotar.
 */
function migrate(e: JournalEntry): JournalEntry {
  const legacy = (e as { taskId?: string | null }).taskId;
  if (e.missionId != null || legacy == null) return e;
  const { taskId: _drop, ...rest } = e as JournalEntry & { taskId?: string | null };
  return { ...rest, missionId: legacy } as JournalEntry;
}

/**
 * Los tokens de una entrada `end`, con la MISMA regla que los techos
 * (`ceilingTokens`): entrada + salida + escritura de caché. Una entrada
 * anterior al 2026-09-12 no guardó la escritura, y entonces cae al fallback de
 * la propia regla — entrada + salida + lectura de caché —, que mide de más y
 * nunca de menos. Null cuando la entrada no anotó tokens en absoluto: un cero
 * ahí diría "no consumió", que es distinto de "no se midió".
 */
export function entryTokens(e: JournalEntry): number | null {
  const t = e.tokens;
  if (!t) return null;
  return ceilingTokens({
    inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead,
    ...(typeof t.cacheWrite === 'number' ? { cacheWriteTokens: t.cacheWrite } : {}),
  });
}

function clip(s: string | null | undefined, n: number): string | null {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/* ── consultas ────────────────────────────────────────────────────── */

export interface JournalQuery {
  /** Id o código del proyecto, sin distinguir mayúsculas. */
  project?: string | null;
  squad?: string | null;
  missionId?: string | null;
  /** Id o callsign. */
  agent?: string | null;
  kind?: JournalKind | JournalKind[] | null;
  /** Epoch ms, inclusive. */
  since?: number | null;
  until?: number | null;
  /** Sólo entradas `end` con ese estado final. */
  state?: FinalState | null;
  by?: LaunchedBy | null;
  /** Texto libre sobre brief, último mensaje, pregunta, respuesta, título y nota. */
  text?: string | null;
  /** Por defecto 50; tope 500. */
  limit?: number | null;
  /** Por defecto las más nuevas primero. */
  order?: 'asc' | 'desc' | null;
  /**
   * Incluir lo que escribió el arnés. Por defecto NO: una cifra agregada es
   * uso real o no es nada. Quien quiera la serie completa lo pide, y entonces
   * cada entrada dice de cuál de los dos mundos viene.
   */
  includeSynthetic?: boolean | null;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export interface ProjectStats {
  project: string | null;
  projectId: string | null;
  launches: number;
  done: number;
  dead: number;
  /** done / (done + dead), null sin fines. */
  doneRate: number | null;
  /** Tokens de techo (`ceilingTokens`) sumados sobre los fines del proyecto. */
  totalTokens: number;
  avgTokens: number | null;
  avgDurationMs: number | null;
  escalations: number;
}

export interface EscalatedBrief {
  agentId: string | null;
  callsign: string | null;
  project: string | null;
  squad: string | null;
  missionId: string | null;
  brief: string | null;
  question: string | null;
  answeredBy: AnsweredBy | null;
  /** Si nadie la contestó porque dejó de existir: la causa. Null si sigue abierta o se contestó. */
  withdrawn: WithdrawCause | null;
  /** Cómo acabó ese agente, si ya acabó. */
  state: FinalState | null;
}

/**
 * El recuento de preguntas de una ventana. Tres destinos que suman `asked`
 * (salvo lo que se cerró fuera de la ventana): contestada, retirada, o
 * abierta todavía. `unanswered` es SÓLO lo tercero. Las retiradas no se
 * callan: van aparte y por causa, porque muchas retiradas de una misma clase
 * son un síntoma (un detector que minta una pregunta por cada cambio de
 * pantalla, por ejemplo), y sólo se ve si se cuenta.
 */
export interface EscalationStats {
  asked: number;
  answeredByCapcom: number;
  answeredByHuman: number;
  /** Retiradas en la ventana, todas las causas. */
  withdrawn: number;
  withdrawnBy: Record<WithdrawCause, number>;
  /** Preguntadas en la ventana y ni contestadas ni retiradas dentro de ella. */
  unanswered: number;
  avgWaitMs: number | null;
}

export interface JournalStats {
  since: number | null;
  until: number | null;
  entries: number;
  /**
   * Entradas del arnés que NO están contadas arriba.
   *
   * Va en la misma estructura que los totales y no en un log, porque el sitio
   * donde hay que poder leer «esto excluye 12.647 entradas de pruebas» es el
   * mismo donde se lee el total. Un total que cae a la mitad sin explicación
   * escrita al lado deja a quien lo mira sin saber cuál de las dos cifras
   * creer, y la respuesta que se aprende es ninguna.
   */
  excluded: number;
  launches: number;
  byLauncher: Record<LaunchedBy, number>;
  ends: { done: number; dead: number };
  doneRate: number | null;
  /**
   * Uso, que es lo que sustituyó al dinero el 2026-09-12. `measured` dice
   * sobre cuántas sesiones se midió: un `0` con `measured: 0` es un journal que
   * no anotó tokens, no una flota que no consumió.
   */
  usage: { tokens: number; avgTokens: number | null; measured: number };
  duration: { avgMs: number | null };
  byProject: ProjectStats[];
  escalations: EscalationStats;
  /** Briefs que acabaron en escalación: lo que una sesión nueva debería escribir mejor. */
  escalatedBriefs: EscalatedBrief[];
  rotations: number;
  landings: { ok: number; failed: number };
}

/**
 * "24h", "3d", "90m", una fecha ISO, o epoch en ms. Null si no se entiende:
 * el que llama decide si eso es un error o "sin límite".
 */
export function parseWhen(v: unknown, now = Date.now()): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  const rel = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[rel[2]!.toLowerCase() as 'm' | 'h' | 'd' | 'w'];
    return now - n * unit;
  }
  if (/^\d{10,13}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/* ── el almacén ───────────────────────────────────────────────────── */

export interface JournalOptions {
  dir: string;
  maxBytes?: number;
  keep?: number;
  now?: () => number;
}

interface JournalState {
  lastBriefingAt: number | null;
  /** Rotaciones hechas: numera el siguiente fichero rotado. */
  rotations: number;
}

/**
 * El diario en disco, sin nada del hub: lo que un test abre sobre un
 * directorio temporal y lo que `createJournal` monta sobre ~/.orca/hub.
 */
export class Journal {
  readonly dir: string;
  readonly file: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => number;
  private writes: Promise<void> = Promise.resolve();
  private state: JournalState = { lastBriefingAt: null, rotations: 0 };
  /** Agentes con launch / end ya anotados, para no repetirlos tras un snapshot. */
  private launched = new Set<string>();
  private ended = new Set<string>();
  private seq = 0;

  constructor(opts: JournalOptions) {
    this.dir = opts.dir;
    this.file = join(this.dir, JOURNAL_FILE);
    this.maxBytes = Math.max(64 * 1024, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    this.keep = Math.max(0, opts.keep ?? DEFAULT_KEEP);
    this.now = opts.now ?? (() => Date.now());
    // Un directorio que no se puede crear no tumba el hub: el diario avisa y
    // cada escritura volverá a intentarlo (y a avisar) por su cuenta.
    try { mkdirSync(this.dir, { recursive: true }); }
    catch (err) { console.warn('[journal] no pude crear', this.dir, err); }
    this.loadState();
    for (const e of this.scan()) this.index(e);
  }

  /* ── ficheros ─────────────────────────────────────────────────── */

  private names(): string[] {
    try { return readdirSync(this.dir); } catch { return []; }
  }

  /** Todos los ficheros del diario, del más viejo al más nuevo (el vivo al final). */
  files(): string[] {
    const names = this.names();
    const out = sortRotated(names).map((n) => join(this.dir, n));
    if (names.includes(JOURNAL_FILE)) out.push(this.file);
    return out;
  }

  /** Cada entrada válida de cada fichero, en orden de escritura. */
  private scan(): JournalEntry[] {
    const out: JournalEntry[] = [];
    for (const file of this.files()) {
      let text: string;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const v: unknown = JSON.parse(line);
          if (isEntry(v)) out.push(migrate(v));
        } catch { /* una línea partida por un corte no invalida el resto */ }
      }
    }
    return out;
  }

  private index(e: JournalEntry): void {
    if (!e.agentId) return;
    if (e.kind === 'launch') this.launched.add(e.agentId);
    if (e.kind === 'end') this.ended.add(e.agentId);
  }

  private loadState(): void {
    try {
      const file = join(this.dir, STATE_FILE);
      if (!existsSync(file)) return;
      const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<JournalState>;
      this.state = {
        lastBriefingAt: typeof v.lastBriefingAt === 'number' ? v.lastBriefingAt : null,
        rotations: typeof v.rotations === 'number' ? v.rotations : 0,
      };
      // Un state.json perdido no puede reutilizar un número: se sigue del mayor en disco.
      const onDisk = Math.max(-1, ...sortRotated(this.names()).map(rotatedSeq));
      if (onDisk + 1 > this.state.rotations) this.state.rotations = onDisk + 1;
    } catch { /* un state.json roto es un briefing que mira 6 h atrás, nada más */ }
  }

  private saveState(): void {
    try {
      writeFileSync(join(this.dir, STATE_FILE), JSON.stringify(this.state), { mode: 0o600 });
    } catch (err) { console.warn('[journal] no pude escribir state.json', err); }
  }

  /* ── escritura ────────────────────────────────────────────────── */

  hasLaunch(agentId: string): boolean { return this.launched.has(agentId); }
  hasEnd(agentId: string): boolean { return this.ended.has(agentId); }
  /** El agente volvió a trabajar tras terminar: su próximo fin cuenta otra vez. */
  reopen(agentId: string): void { this.ended.delete(agentId); }

  append(input: JournalInput): JournalEntry {
    this.seq += 1;
    const at = input.at ?? this.now();
    const entry: JournalEntry = {
      ...input,
      id: `jr_${at.toString(36)}${this.seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at,
      brief: input.brief === undefined ? undefined : clip(input.brief, MAX_BRIEF),
      lastSay: input.lastSay === undefined ? undefined : clip(input.lastSay, MAX_SAY),
      question: input.question === undefined ? undefined : clip(input.question, MAX_QUESTION),
      answer: input.answer === undefined ? undefined : clip(input.answer, MAX_QUESTION),
    };
    // Sin `undefined` en disco: JSON los omite, pero la copia en memoria que
    // devolvemos debe ser la misma que se leerá luego.
    for (const k of Object.keys(entry) as (keyof JournalEntry)[]) if (entry[k] === undefined) delete entry[k];
    this.index(entry);
    this.writes = this.writes.then(async () => {
      try {
        await mkdir(this.dir, { recursive: true });
        await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
        await this.rotateIfBig();
      } catch (err) {
        console.warn('[journal] no pude escribir', this.file, err);
      }
    });
    return entry;
  }

  /**
   * Rotación por tamaño: el fichero vivo se renombra con la fecha y se abre
   * otro. Nunca se recorta un fichero (eso perdería entradas); lo que se
   * borra son rotados enteros, los más viejos, por encima de `keep`.
   */
  private async rotateIfBig(): Promise<void> {
    let size = 0;
    try { size = (await stat(this.file)).size; } catch { return; }
    if (size <= this.maxBytes) return;
    const name = `journal.${stamp(this.now())}.${String(this.state.rotations).padStart(6, '0')}.jsonl`;
    this.state.rotations += 1;
    this.saveState();
    await rename(this.file, join(this.dir, name));
    const rotated = sortRotated(await readdir(this.dir));
    for (const old of rotated.slice(0, Math.max(0, rotated.length - this.keep))) {
      await rm(join(this.dir, old), { force: true });
    }
  }

  flush(): Promise<void> { return this.writes; }

  /* ── lectura ──────────────────────────────────────────────────── */

  /**
   * Todo lo que casa con la consulta, sin recortar y ya ordenado.
   *
   * Separado de `query()` porque el tope de 500 es de la API —lo que una
   * consola o un CLI pueden pedir de una vez— y no una propiedad del diario.
   * `stats()` pedía 500.000 y `query()` se lo recortaba a 500 con un
   * `Math.min` silencioso: el informe del 2026-09-08 dijo «500 lanzamientos,
   * 0 finales» porque leyó las 500 entradas MÁS VIEJAS de una ventana de
   * 112.216 y ninguna era un final. Un agregado no puede recortar la
   * población que agrega, y menos sin decirlo.
   */
  private select(q: JournalQuery = {}): JournalEntry[] {
    const project = q.project ? q.project.trim().toLowerCase() : null;
    const squad = q.squad ? q.squad.trim().toLowerCase() : null;
    const agent = q.agent ? q.agent.trim().toLowerCase() : null;
    const kinds = q.kind ? new Set(Array.isArray(q.kind) ? q.kind : [q.kind]) : null;
    const text = q.text ? normalize(q.text) : null;
    const since = q.since ?? null;
    const until = q.until ?? null;
    const desc = (q.order ?? 'desc') !== 'asc';
    const withSynthetic = q.includeSynthetic === true;

    const out: JournalEntry[] = [];
    for (const e of this.scan()) {
      if (!withSynthetic && e.synthetic === true) continue;
      if (since !== null && e.at < since) continue;
      if (until !== null && e.at > until) continue;
      if (kinds && !kinds.has(e.kind)) continue;
      if (project && (e.projectId ?? '').toLowerCase() !== project && (e.project ?? '').toLowerCase() !== project) continue;
      if (squad && (e.squad ?? '').toLowerCase() !== squad) continue;
      if (q.missionId && e.missionId !== q.missionId) continue;
      if (agent && (e.agentId ?? '').toLowerCase() !== agent && (e.callsign ?? '').toLowerCase() !== agent) continue;
      if (q.state && (e.kind !== 'end' || e.state !== q.state)) continue;
      if (q.by && (e.kind !== 'launch' || e.by !== q.by)) continue;
      if (text && !normalize([e.brief, e.lastSay, e.question, e.answer, e.title, e.note, e.detail]
        .filter((s): s is string => typeof s === 'string').join(' ')).includes(text)) continue;
      out.push(e);
    }
    out.sort((a, b) => (a.at - b.at) || a.id.localeCompare(b.id));
    if (desc) out.reverse();
    return out;
  }

  /** Una página para quien pregunta: el tope de la API, aquí y sólo aquí. */
  query(q: JournalQuery = {}): JournalEntry[] {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(q.limit ?? DEFAULT_LIMIT)));
    return this.select(q).slice(0, limit);
  }

  stats(q: Pick<JournalQuery, 'project' | 'since' | 'until' | 'squad'> = {}): JournalStats {
    // Una sola pasada para las dos cifras: lo que se cuenta y lo que se aparta
    // salen del mismo recorrido, así que no pueden contradecirse.
    const all = this.select({ ...q, order: 'asc', includeSynthetic: true });
    const entries = all.filter((e) => e.synthetic !== true);
    const excluded = all.length - entries.length;
    const byLauncher: Record<LaunchedBy, number> = { human: 0, capcom: 0, agent: 0 };
    const ends = { done: 0, dead: 0 };
    const used: number[] = [];
    const sessionUsage = new Map<string, JournalEntry>();
    const dur: number[] = [];
    const proj = new Map<string, ProjectStats & { used: number[]; durs: number[] }>();
    const projOf = (e: JournalEntry) => {
      const key = e.projectId ?? e.project ?? '?';
      let p = proj.get(key);
      if (!p) {
        p = { project: e.project ?? null, projectId: e.projectId ?? null, launches: 0, done: 0, dead: 0, doneRate: null, totalTokens: 0, avgTokens: null, avgDurationMs: null, escalations: 0, used: [], durs: [] };
        proj.set(key, p);
      }
      return p;
    };
    const launches = new Map<string, JournalEntry>();
    const finals = new Map<string, FinalState>();
    const asked = new Map<string, JournalEntry>();
    const answered = new Map<string, JournalEntry>();
    const withdrawn = new Map<string, JournalEntry>();
    const withdrawnBy = Object.fromEntries(WITHDRAW_CAUSES.map((c) => [c, 0])) as Record<WithdrawCause, number>;
    let withdrawnTotal = 0;
    const waits: number[] = [];
    let rotations = 0;
    const landings = { ok: 0, failed: 0 };

    for (const e of entries) {
      switch (e.kind) {
        case 'launch':
          if (e.by) byLauncher[e.by] += 1;
          projOf(e).launches += 1;
          if (e.agentId) launches.set(e.agentId, e);
          break;
        case 'end': {
          if (e.state === 'done') ends.done += 1; else if (e.state === 'dead') ends.dead += 1;
          const p = projOf(e);
          if (e.state === 'done') p.done += 1; else if (e.state === 'dead') p.dead += 1;
          const tok = entryTokens(e);
          if (tok !== null) {
            // Ends are cumulative snapshots, including after reopen. Missing
            // identity stays independent rather than merging unrelated records.
            const key = e.agentId ? JSON.stringify([e.machineId ?? null, e.agentId]) : e.id;
            const previous = sessionUsage.get(key);
            if (!previous || tok > entryTokens(previous)!) sessionUsage.set(key, e);
          }
          if (typeof e.durationMs === 'number') { dur.push(e.durationMs); p.durs.push(e.durationMs); }
          if (e.agentId && e.state) finals.set(e.agentId, e.state);
          break;
        }
        case 'escalation':
          projOf(e).escalations += 1;
          if (e.escalationId) asked.set(e.escalationId, e);
          else if (e.agentId) asked.set(`agent:${e.agentId}:${e.at}`, e);
          break;
        case 'answer':
          if (e.escalationId) answered.set(e.escalationId, e);
          if (typeof e.waitedMs === 'number') waits.push(e.waitedMs);
          break;
        case 'withdraw':
          // Se cuenta aunque la pregunta se hiciera antes de la ventana, igual
          // que las respuestas; lo que NO hace es contar como espera: nadie
          // esperó por una pregunta que dejó de hacer falta.
          withdrawnTotal += 1;
          if (e.cause && e.cause in withdrawnBy) withdrawnBy[e.cause] += 1;
          if (e.escalationId) withdrawn.set(e.escalationId, e);
          break;
        case 'rotation': rotations += 1; break;
        case 'landing': if (e.ok === false) landings.failed += 1; else landings.ok += 1; break;
      }
    }

    for (const e of sessionUsage.values()) {
      const tok = entryTokens(e)!;
      used.push(tok);
      const p = projOf(e);
      p.used.push(tok);
      p.totalTokens += tok;
    }

    const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const round = (n: number | null, d = 4): number | null => (n === null ? null : Number(n.toFixed(d)));
    const byProject = [...proj.values()]
      .map(({ used: u, durs, ...p }) => ({
        ...p,
        doneRate: p.done + p.dead ? round(p.done / (p.done + p.dead)) : null,
        totalTokens: Math.round(p.totalTokens),
        avgTokens: round(avg(u), 0),
        avgDurationMs: round(avg(durs), 0),
      }))
      .sort((a, b) => b.launches - a.launches);

    let byCapcom = 0, byHuman = 0;
    for (const a of answered.values()) { if (a.answeredBy === 'capcom') byCapcom += 1; else byHuman += 1; }

    // Un brief que acabó en escalación: el agente que la levantó y con qué se
    // le lanzó. Ordenado por la pregunta más reciente.
    const escalatedBriefs: EscalatedBrief[] = [];
    const seenAgents = new Set<string>();
    for (const e of [...asked.values()].reverse()) {
      if (!e.agentId || seenAgents.has(e.agentId)) continue;
      seenAgents.add(e.agentId);
      const l = launches.get(e.agentId);
      const a = e.escalationId ? answered.get(e.escalationId) : undefined;
      const w = e.escalationId ? withdrawn.get(e.escalationId) : undefined;
      escalatedBriefs.push({
        agentId: e.agentId, callsign: e.callsign ?? l?.callsign ?? null,
        project: e.project ?? l?.project ?? null, squad: e.squad ?? l?.squad ?? null, missionId: e.missionId ?? l?.missionId ?? null,
        brief: clip(l?.brief ?? null, 240), question: clip(e.question ?? null, 200),
        answeredBy: a?.answeredBy ?? null,
        withdrawn: a ? null : w?.cause ?? null,
        state: finals.get(e.agentId) ?? null,
      });
      if (escalatedBriefs.length >= 20) break;
    }

    const total = used.reduce((a, b) => a + b, 0);
    return {
      since: q.since ?? null, until: q.until ?? null,
      entries: entries.length,
      excluded,
      launches: launches.size || entries.filter((e) => e.kind === 'launch').length,
      byLauncher,
      ends,
      doneRate: ends.done + ends.dead ? round(ends.done / (ends.done + ends.dead)) : null,
      usage: { tokens: Math.round(total), avgTokens: round(avg(used), 0), measured: used.length },
      duration: { avgMs: round(avg(dur), 0) },
      byProject,
      escalations: {
        asked: asked.size, answeredByCapcom: byCapcom, answeredByHuman: byHuman,
        withdrawn: withdrawnTotal, withdrawnBy,
        unanswered: [...asked.keys()].filter((k) => !answered.has(k) && !withdrawn.has(k)).length,
        avgWaitMs: round(avg(waits), 0),
      },
      escalatedBriefs,
      rotations,
      landings,
    };
  }

  /* ── briefing ─────────────────────────────────────────────────── */

  get lastBriefingAt(): number | null { return this.state.lastBriefingAt; }

  /** Anota que CAPCOM acaba de recibir un briefing: lo siguiente empieza aquí. */
  markBriefing(at = this.now()): void {
    this.state.lastBriefingAt = at;
    this.saveState();
  }
}

/* ── el lado del hub ──────────────────────────────────────────────── */

export interface RotationInput {
  fromId: string;
  machineId?: string | null;
  turns?: number;
  compactions?: number;
  contextTokens?: number;
}

export interface SpawnHint {
  by: LaunchedBy;
  projectId: string;
  mission: string;
  squad?: string | null;
}

export interface LandingInput {
  agentId: string | null;
  projectId?: string | null;
  branch?: string | null;
  target?: string | null;
  commit?: string | null;
  ok: boolean;
  detail?: string | null;
}

export interface JournalApi {
  /** Dónde está el diario en disco. */
  dir: string;
  query(q?: JournalQuery): JournalEntry[];
  stats(q?: Pick<JournalQuery, 'project' | 'since' | 'until' | 'squad'>): JournalStats;
  /**
   * Lo terminado desde el último briefing (o las últimas 6 h si nunca hubo
   * uno), en líneas cortas, y marca este instante como el último briefing.
   */
  briefingLines(now?: number): string[];
  /** server.ts: el frame capcom:rotated, con sus cifras. */
  rotated(input: RotationInput): void;
  /** server.ts: quién pidió un spawn, para atribuir el launch que viene. */
  spawnRequested(hint: SpawnHint): void;
  /** Pieza C: un worktree aterrizó (o no). Marcada si era de una máquina sintética. */
  landed(input: LandingInput): JournalEntry;
  /** Cualquier otra pieza: una entrada a mano. Marcada si era de una máquina sintética. */
  record(input: JournalInput): JournalEntry;
  /**
   * Recorre la flota y anota lo que los eventos no trajeron: agentes sin
   * launch, terminados sin end. Corre solo cada SWEEP_MS; expuesto para que
   * un test no tenga que esperar. Devuelve cuántas entradas escribió.
   */
  sweep(): number;
  flush(): Promise<void>;
  stop?(): void;
}

/** Cuánto vive una pista de spawn sin que aparezca el agente que la explique. */
const HINT_TTL_MS = 5 * 60_000;
/** Cuánto se espera al CAPCOM nuevo antes de anotar la rotación sin destino. */
const ROTATION_HOLD_MS = 180_000;
const BRIEFING_DEFAULT_MS = 6 * 3_600_000;
const DEFAULT_SWEEP_MS = 5_000;
export const BRIEFING_MAX_LINES = 8;

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60 ? `${m % 60}m` : ''}` : `${Math.round(h / 24)}d`;
}

/** Una entrada `end`, en una línea para CAPCOM o para un terminal. */
export function endLine(e: JournalEntry, now: number): string {
  const parts: string[] = [];
  const tok = entryTokens(e);
  if (tok !== null && tok > 0) parts.push(`${fmtTokens(tok)} tokens`);
  if (typeof e.durationMs === 'number') parts.push(ago(e.durationMs));
  if (e.lines && (e.lines.added || e.lines.removed)) parts.push(`+${e.lines.added}/-${e.lines.removed}`);
  if (e.missionId) parts.push(e.missionId);
  if (e.squad) parts.push(`squad ${e.squad}`);
  return `${e.callsign ?? e.agentId ?? '?'} [${e.project ?? e.projectId ?? '?'}] ${e.state ?? 'ended'} ${ago(now - e.at)} ago`
    + (parts.length ? ` · ${parts.join(' · ')}` : '')
    + (e.lastSay ? `: "${clip(e.lastSay, 140)}"` : '');
}

export function createJournal(deps: AutonomyDeps): JournalApi {
  const journal = new Journal({
    dir: join(deps.dir, 'journal'),
    maxBytes: Number(deps.env['ORCA_JOURNAL_MAX_BYTES']) > 0 ? Number(deps.env['ORCA_JOURNAL_MAX_BYTES']) : undefined,
    keep: Number.isInteger(Number(deps.env['ORCA_JOURNAL_KEEP'])) && deps.env['ORCA_JOURNAL_KEEP'] !== undefined
      ? Number(deps.env['ORCA_JOURNAL_KEEP']) : undefined,
    now: () => deps.now(),
  });

  const sweepMs = Number(deps.env['ORCA_JOURNAL_SWEEP_MS']) > 0 ? Number(deps.env['ORCA_JOURNAL_SWEEP_MS']) : DEFAULT_SWEEP_MS;
  const hints: (SpawnHint & { at: number })[] = [];
  let rotation: { input: RotationInput; at: number; timer: { cancel(): void } } | null = null;
  let capcomId: string | null = deps.capcom()?.id ?? null;
  /** Escalaciones abiertas por agente, para casar la respuesta con la pregunta. */
  const open = new Map<string, JournalEntry>();
  const openById = new Map<string, JournalEntry>();

  /*
   * El arnés entra MARCADO, y ninguna lectura agregada lo cuenta.
   *
   * Hasta el 2026-09-13 esto descartaba la entrada. Limpiaba las cifras —lo
   * que se construye encima, el informe de AUTOMEJORA y los briefings de
   * CAPCOM, es uso real o no es nada— pero descartar es borrar: el diario no
   * podía enseñar la serie completa a quien la pidiera ni decir cuánto había
   * dejado fuera, y un total que cambia sin explicación al lado es peor que
   * uno equivocado. Así que la regla sigue estando aquí, en el único sitio
   * por el que se escribe, y ahora ES UNA MARCA: `query()` la excluye por
   * defecto, `includeSynthetic` devuelve la serie entera y `stats().excluded`
   * dice cuánto se apartó. Incluso en un hub de pruebas: sus fixtures se
   * miran en la consola, no se auditan.
   *
   * Por la marca que la máquina declara en su `hello` y nada más: una lista
   * de nombres se queda atrás el día que el mock cambia de flota. Sin máquina
   * conocida, real, que es el defecto de toda la frontera.
   */
  const synthetic = (machineId: string | null | undefined): boolean =>
    machineId ? isSynthetic(deps.machine?.(machineId)) : false;
  const write = (input: JournalInput): JournalEntry =>
    journal.append(synthetic(input.machineId) ? { ...input, synthetic: true } : input);

  const code = (projectId: string | null): string | null => (projectId ? deps.project(projectId)?.code ?? null : null);
  const missionOf = (a: Pick<Agent, 'id' | 'squad'>): string | null => {
    let fallback: string | null = null;
    for (const t of Object.values(deps.missions())) {
      if (t.agentIds.includes(a.id)) { if (t.status === 'active') return t.id; fallback ??= t.id; }
      else if (a.squad && t.squads?.includes(a.squad) && t.status === 'active') fallback ??= t.id;
    }
    return fallback;
  };

  const base = (a: Agent) => ({
    agentId: a.id, callsign: a.callsign, machineId: a.machineId,
    projectId: a.projectId, project: code(a.projectId),
    squad: a.squad ?? null, missionId: missionOf(a),
  });

  function launchedBy(a: Agent, at: number): LaunchedBy {
    // La pista del hub gana: sabe por qué puerta entró la orden.
    for (let i = hints.length - 1; i >= 0; i -= 1) {
      const h = hints[i]!;
      if (at - h.at > HINT_TTL_MS) { hints.splice(i, 1); continue; }
      if (h.projectId !== a.projectId) continue;
      if ((a.mission ?? '').trim() === h.mission.trim() || (h.squad && h.squad === a.squad)) {
        hints.splice(i, 1);
        return h.by;
      }
    }
    if (a.parentId) return deps.agent(a.parentId)?.role === 'capcom' ? 'capcom' : 'agent';
    return 'human';
  }

  function recordLaunch(a: Agent, at: number): void {
    write({
      kind: 'launch', at: a.startedAt || at, ...base(a),
      by: launchedBy(a, at), parentId: a.parentId, lead: a.lead === true,
      brief: a.mission ?? a.lastPrompt ?? null, title: a.title || null,
      runtime: a.runtime, model: a.model, origin: a.origin ?? null, startedAt: a.startedAt,
    });
  }

  function recordEnd(a: Agent, state: FinalState, at: number, late = false): void {
    const m = a.metrics;
    write({
      kind: 'end', at, ...base(a), state,
      costUSD: Number((m?.costUSD ?? 0).toFixed(4)),
      durationMs: Math.max(0, (a.updatedAt || at) - (a.startedAt || at)),
      tokens: {
        input: m?.inputTokens ?? 0, output: m?.outputTokens ?? 0,
        cacheRead: m?.cacheReadTokens ?? 0, thinking: m?.thinkingTokens ?? 0,
        // Sin esto no se puede aplicar `ceilingTokens` a una entrada del
        // journal: en Claude la escritura de caché es casi toda la entrada.
        ...(typeof m?.cacheWriteTokens === 'number' ? { cacheWrite: m.cacheWriteTokens } : {}),
      },
      lines: { added: m?.linesAdded ?? 0, removed: m?.linesRemoved ?? 0 },
      toolCalls: m?.toolCalls ?? 0, turns: m?.turns ?? 0,
      lastSay: a.lastSay, runtime: a.runtime, model: a.model,
      ...(late ? { late: true } : {}),
    });
  }

  /** Un CAPCOM vivo que no era el conocido. Devuelve si escribió una rotación. */
  function capcomArrived(a: Agent, at: number): boolean {
    let wrote = false;
    if (rotation) {
      rotation.timer.cancel();
      const { input } = rotation;
      rotation = null;
      write({
        kind: 'rotation', at, agentId: a.id, callsign: a.callsign, machineId: a.machineId,
        projectId: a.projectId, project: code(a.projectId), squad: null, missionId: null,
        fromId: input.fromId, toId: a.id, turns: input.turns ?? null,
        compactions: input.compactions ?? null, contextTokens: input.contextTokens ?? null,
      });
      wrote = true;
    } else if (capcomId && capcomId !== a.id) {
      // Sin gancho del hub: un CAPCOM nuevo cuando había otro ES una rotación.
      write({
        kind: 'rotation', at, agentId: a.id, callsign: a.callsign, machineId: a.machineId,
        projectId: a.projectId, project: code(a.projectId), squad: null, missionId: null,
        fromId: capcomId, toId: a.id, note: 'inferred: a new CAPCOM appeared while another was known',
      });
      wrote = true;
    }
    capcomId = a.id;
    return wrote;
  }

  const offs = [
    deps.lifecycle.on('agent:new', (a, at) => {
      if (a.subagent) return;
      // Un CAPCOM del arnés no es una rotación del de verdad, ni el punto de
      // partida de la siguiente: eso es estado del hub, no un renglón que se
      // pueda marcar y luego filtrar.
      if (a.role === 'capcom') { if (!synthetic(a.machineId)) capcomArrived(a, at); return; }
      if (!journal.hasLaunch(a.id)) recordLaunch(a, at);
      // Llegó ya terminado (snapshot tras un reinicio del hub): el fin no se
      // vio pasar, pero cuenta igual.
      if (TERMINAL_STATES.has(a.state) && !journal.hasEnd(a.id)) recordEnd(a, a.state as FinalState, a.updatedAt || at, true);
    }),
    deps.lifecycle.on('agent:state', (c) => {
      if (c.agent.subagent || c.agent.role === 'capcom') return;
      if (!TERMINAL_STATES.has(c.to as Agent['state'])) { journal.reopen(c.agent.id); return; }
      if (journal.hasEnd(c.agent.id)) return;
      if (!journal.hasLaunch(c.agent.id)) recordLaunch(c.agent, c.at);
      recordEnd(c.agent, c.to as FinalState, c.at);
    }),
    deps.lifecycle.on('escalation:new', (e: EscalationRaised) => {
      const a = e.agentId ? deps.agent(e.agentId) : undefined;
      const entry = write({
        kind: 'escalation', at: e.at,
        agentId: e.agentId, callsign: a?.callsign ?? null, machineId: a?.machineId ?? e.machineId ?? null,
        projectId: e.projectId, project: code(e.projectId),
        squad: a?.squad ?? null, missionId: a ? missionOf(a) : null,
        escalationId: e.id, question: e.question, urgency: e.urgency ?? null, options: e.options ?? [],
        by: e.from === 'ceo' ? 'capcom' : undefined,
      });
      if (e.id) openById.set(e.id, entry);
      if (e.agentId) open.set(e.agentId, entry);
    }),
    deps.lifecycle.on('escalation:answered', (e: EscalationAnswered) => {
      const asked = (e.id ? openById.get(e.id) : undefined) ?? (e.agentId ? open.get(e.agentId) : undefined) ?? null;
      if (asked?.escalationId) openById.delete(asked.escalationId);
      if (e.agentId) open.delete(e.agentId);
      const a = e.agentId ? deps.agent(e.agentId) : undefined;
      write({
        kind: 'answer', at: e.at,
        agentId: e.agentId, callsign: a?.callsign ?? asked?.callsign ?? null, machineId: a?.machineId ?? e.machineId ?? null,
        projectId: e.projectId ?? asked?.projectId ?? null, project: code(e.projectId ?? asked?.projectId ?? null),
        squad: a?.squad ?? asked?.squad ?? null, missionId: a ? missionOf(a) : asked?.missionId ?? null,
        escalationId: e.id ?? asked?.escalationId ?? null, question: e.question ?? asked?.question ?? null,
        answer: e.answer, answeredBy: e.by === 'human' ? 'human' : 'capcom', rememberAs: e.rememberAs ?? null,
        waitedMs: asked ? Math.max(0, e.at - asked.at) : null,
      });
    }),
    deps.lifecycle.on('escalation:withdrawn', (e: EscalationWithdrawn) => {
      // Se casa con la pregunta por id y, sin id, por agente: como la
      // respuesta. Y se anota aunque no se encuentre la pregunta (un hub que
      // reinició con ella abierta): el hecho de que dejó de existir sigue
      // siendo cierto, y `stats` la casará por id con la entrada vieja.
      const asked = (e.id ? openById.get(e.id) : undefined) ?? (e.agentId ? open.get(e.agentId) : undefined) ?? null;
      if (asked?.escalationId) openById.delete(asked.escalationId);
      if (e.agentId && open.get(e.agentId) === asked) open.delete(e.agentId);
      const a = e.agentId ? deps.agent(e.agentId) : undefined;
      write({
        kind: 'withdraw', at: e.at,
        agentId: e.agentId ?? asked?.agentId ?? null, callsign: a?.callsign ?? asked?.callsign ?? null,
        machineId: a?.machineId ?? e.machineId ?? asked?.machineId ?? null,
        projectId: e.projectId ?? asked?.projectId ?? null, project: code(e.projectId ?? asked?.projectId ?? null),
        squad: a?.squad ?? asked?.squad ?? null, missionId: a ? missionOf(a) : asked?.missionId ?? null,
        escalationId: e.id ?? asked?.escalationId ?? null, question: asked?.question ?? null,
        cause: e.cause, reason: clip(e.reason, MAX_QUESTION),
        waitedMs: asked ? Math.max(0, e.at - asked.at) : null,
      });
    }),
  ];

  function sweep(): number {
    const now = deps.now();
    let wrote = 0;
    for (const a of deps.agents()) {
      if (a.subagent) continue;
      if (a.role === 'capcom') {
        if (synthetic(a.machineId)) continue;
        if (!TERMINAL_STATES.has(a.state) && capcomId !== a.id && capcomArrived(a, now)) wrote += 1;
        continue;
      }
      if (!journal.hasLaunch(a.id)) { recordLaunch(a, now); wrote += 1; }
      if (TERMINAL_STATES.has(a.state) && !journal.hasEnd(a.id)) { recordEnd(a, a.state as FinalState, a.updatedAt || now, true); wrote += 1; }
    }
    return wrote;
  }
  const ticker = deps.setInterval(() => { try { sweep(); } catch (err) { deps.log(`[journal] sweep failed: ${String(err)}`); } }, sweepMs);

  const api: JournalApi = {
    dir: journal.dir,
    query: (q) => journal.query(q),
    stats: (q) => journal.stats(q),
    sweep,

    briefingLines(now = deps.now()) {
      // Exclusivo por abajo: lo que se enseñó en el briefing anterior no vuelve.
      const since = journal.lastBriefingAt !== null ? journal.lastBriefingAt + 1 : now - BRIEFING_DEFAULT_MS;
      const ended = journal.query({ kind: ['end', 'landing'], since, until: now, order: 'asc', limit: MAX_LIMIT });
      const lines = ended.map((e) => (e.kind === 'landing'
        ? `${e.callsign ?? e.agentId ?? '?'} [${e.project ?? '?'}] ${e.ok === false ? 'FAILED to land' : 'landed'}${e.branch ? ` ${e.branch}` : ''}${e.target ? ` → ${e.target}` : ''} ${ago(now - e.at)} ago${e.detail ? `: ${clip(e.detail, 100)}` : ''}`
        : endLine(e, now)));
      journal.markBriefing(now);
      if (lines.length <= BRIEFING_MAX_LINES) return lines;
      const shown = lines.slice(-BRIEFING_MAX_LINES);
      shown.unshift(`… ${lines.length - BRIEFING_MAX_LINES} more — journal since=${new Date(since).toISOString()}`);
      return shown;
    },

    rotated(input) {
      rotation?.timer.cancel();
      const at = deps.now();
      const timer = deps.setTimer(() => {
        if (!rotation) return;
        const { input: held } = rotation;
        rotation = null;
        write({
          kind: 'rotation', at: deps.now(), agentId: held.fromId, callsign: null, machineId: held.machineId ?? null,
          projectId: null, project: null, squad: null, missionId: null,
          fromId: held.fromId, toId: null, turns: held.turns ?? null,
          compactions: held.compactions ?? null, contextTokens: held.contextTokens ?? null,
          note: 'the new CAPCOM never showed up',
        });
      }, ROTATION_HOLD_MS);
      rotation = { input, at, timer };
    },

    spawnRequested(hint) {
      hints.push({ ...hint, at: deps.now() });
      while (hints.length > 200) hints.shift();
    },

    landed(input) {
      const a = input.agentId ? deps.agent(input.agentId) : undefined;
      const projectId = input.projectId ?? a?.projectId ?? null;
      return write({
        kind: 'landing', agentId: input.agentId, callsign: a?.callsign ?? null, machineId: a?.machineId ?? null,
        projectId, project: code(projectId), squad: a?.squad ?? null, missionId: a ? missionOf(a) : null,
        branch: input.branch ?? null, target: input.target ?? null, commit: input.commit ?? null,
        ok: input.ok, detail: input.detail ?? null,
      });
    },

    record: (input) => write(input),
    flush: () => journal.flush(),

    stop() {
      for (const off of offs) off();
      ticker.cancel();
      rotation?.timer.cancel();
      rotation = null;
    },
  };
  return api;
}
