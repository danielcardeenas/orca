/**
 * ORCA hub — el store autoritativo.
 *
 * Aquí vive el único `WorldState` verdadero. Los collectors mandan hechos sobre
 * su propia máquina, el hub los funde en un mundo y emite `PatchOp`s. La consola
 * nunca deriva estado propio: renderiza lo que sale de aquí.
 *
 * Tres invariantes que sostienen todo lo demás:
 *
 *  1. Cada mutación incrementa `rev` en exactamente 1 y emite al menos un
 *     PatchOp. `rev` es, literalmente, "cuántos cambios ha habido".
 *  2. Nada entra al mundo sin pasar por un sanitizador: los frames vienen de la
 *     red y se copian campo por campo desde una lista blanca. El hub nunca ve
 *     valores de credenciales, sólo `KeyDescriptor`.
 *  3. Nada se borra por muerte. Una máquina que cae marca sus agentes como
 *     'dead' pero conserva los registros: el humano necesita ver qué murió.
 *
 * Nota sobre `rev` y el cable: el publicador (bus.ts + server.ts) mantiene su
 * propia secuencia de frames, porque el protocolo exige que dos `{t:'patch'}`
 * consecutivos difieran en exactamente 1 y una ráfaga de 30 mutaciones se
 * colapsa en un solo frame. Ver docs/CONTRACT-REQUESTS.md.
 */

import type {
  Agent, AgentMetrics, AgentState, CeoMessage, Escalation, FeedItem,
  KeyDescriptor, Machine, Project, SessionRollup, WorldState,
} from '../shared/types.ts';
import { AGENT_STATES, LIVE_STATES, emptyRollup, emptyWorld } from '../shared/types.ts';
import type { CollectorFrame, PatchOp } from '../shared/protocol.ts';
import { BEAT_TIMEOUT_MS } from '../shared/protocol.ts';

/* ── límites del frame ────────────────────────────────────────────── */

export const MAX_FEED = 500;
export const MAX_CEO_MESSAGES = 100;

/*
 * Retención.
 *
 * El diseño original decía "marca muerto pero no borres: el humano necesita ver
 * qué murió". Eso es cierto durante minutos y falso para siempre. Sin desalojo
 * el hub crecía sin techo —de 50 a 1.289 agentes en dos minutos con una flota
 * activa— y terminaba con `FATAL ERROR: Reached heap limit`. Una consola que se
 * cae sola a las tres horas no es una consola.
 *
 * Lo que se conserva es lo reciente y lo que aún requiere a una persona; el
 * resto ya está en el log append-only de ~/.orca/hub, que es donde vive la
 * historia. La retención se aplica sólo a estados terminales: un agente vivo
 * nunca se desaloja, por viejo que sea.
 */
export const AGENT_RETENTION_MS = 60 * 60_000;   // una hora de muertos a la vista
export const MAX_TERMINAL_AGENTS = 300;
export const ESCALATION_RETENTION_MS = 60 * 60_000;
export const MAX_CLOSED_ESCALATIONS = 200;

/*
 * Válvula de seguridad, no una característica.
 *
 * Una máquina real tiene decenas de agentes; ningún operador tiene mil. Pero un
 * collector con un bug —o uno hostil— puede inventar agentes tan rápido como
 * el socket aguante, y el hub no tiene forma de distinguirlo de una flota
 * enorme de verdad. Sin un techo, ese collector tumba el proceso y con él la
 * consola de todas las demás máquinas.
 *
 * Al pasarse se descartan los MENOS recientemente tocados y se avisa a gritos:
 * perder los agentes más viejos de una máquina desbocada es estrictamente mejor
 * que perder el hub entero.
 */
export const MAX_AGENTS_PER_MACHINE = 400;

/**
 * Techo de preguntas abiertas.
 *
 * Si los agentes preguntan más rápido de lo que una persona contesta, la cola
 * crece para siempre. Y una cola de cinco mil preguntas no es una cola: es
 * ruido en el que la que importa se pierde, además de memoria que no se
 * recupera.
 *
 * Al pasarse se caducan las MÁS VIEJAS que no sean `blocking`. Caducar no es
 * perder: un agente que sigue necesitando su respuesta vuelve a preguntar, y
 * las `blocking` —las que tienen a alguien parado— nunca se tocan.
 */
export const MAX_OPEN_ESCALATIONS = 100;
/** Un frame malicioso no puede hacernos alojar 10 MB de strings. */
const MAX_TEXT = 4_000;
const MAX_LINE = 400;
const MAX_ARRAY = 2_000;

/* ── eventos hacia el log persistente ─────────────────────────────── */

export interface WorldEvent {
  at: number;
  kind: string;
  machineId?: string;
  agentId?: string;
  projectId?: string;
  text?: string;
  data?: unknown;
}

export interface WorldHooks {
  /** Ops recién producidas. El bus las acumula y las emite a 10 Hz. */
  onOps?: (ops: PatchOp[]) => void;
  /** Hechos dignos del log append-only. */
  onEvent?: (ev: WorldEvent) => void;
  /** Lo que se cae del frame por recorte (feed > 500, ceo > 100). */
  onOverflow?: (kind: 'feed' | 'ceo', items: unknown[]) => void;
  now?: () => number;
}

/* ── sanitización ─────────────────────────────────────────────────── */

/** Ids peligrosos para un `Record<string, T>` plano. */
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Charset de ids.
 *
 * El `#` está aquí porque el collector nombra a los subagentes
 * `<sesión>#<agente>`. Sin él, TODO subagente se rechazaba en silencio y el
 * grafo de linaje —ver qué agente lanzó a cuál, que es media razón de existir
 * de la consola— nunca llegaba a la pantalla. Fallaba callado porque el aviso
 * no incluía el id, así que no había forma de saber qué se estaba perdiendo.
 *
 * Ni `protocol.ts` ni `types.ts` fijan este charset; hasta que lo hagan, esta
 * lista es el contrato de facto y ampliarla es más barato que renombrar ids en
 * el productor.
 */
const ID_RE = /^[\w.:@/+#-]{1,200}$/;

export function validId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v) && !BAD_KEYS.has(v);
}

/**
 * Cosas que parecen credenciales. Si aparecen en texto libre las tachamos; si
 * aparecen dentro de un KeyDescriptor tiramos el descriptor entero. No cazamos
 * hex suelto a propósito: un sha de git de 40 caracteres no es un secreto y
 * tacharlo haría el feed inútil.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{12,}/g,
  /\bsk-[A-Za-z0-9]{24,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g,
  /((?:api[_-]?key|secret|passwd|password|access[_-]?token|bearer)["'\s]*[:=]\s*["']?)([A-Za-z0-9_\-/+.]{16,})/gi,
];

export function looksLikeSecret(text: string): boolean {
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}

let redactions = 0;
export function redactionCount(): number { return redactions; }

/** Devuelve el texto con los secretos tachados. Cuenta los aciertos. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    out = out.replace(re, (_m, prefix?: string) =>
      typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]');
    redactions++;
  }
  return out;
}

function s(v: unknown, max = MAX_LINE, fallback = ''): string {
  if (typeof v !== 'string') return fallback;
  return redact(v.length > max ? v.slice(0, max) : v);
}
function sOrNull(v: unknown, max = MAX_LINE): string | null {
  if (typeof v !== 'string') return null;
  return redact(v.length > max ? v.slice(0, max) : v);
}
function n(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function nOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function b(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function strArray(v: unknown, max = MAX_ARRAY): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    out.push(redact(item.slice(0, MAX_LINE)));
    if (out.length >= max) break;
  }
  return out;
}
function has(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>) : null;
}

const AGENT_STATE_SET = new Set<string>(AGENT_STATES);
function agentState(v: unknown, fallback: AgentState = 'booting'): AgentState {
  return typeof v === 'string' && AGENT_STATE_SET.has(v) ? (v as AgentState) : fallback;
}

function metrics(raw: unknown): AgentMetrics {
  const o = obj(raw) ?? {};
  return {
    costUSD: n(o['costUSD']),
    inputTokens: n(o['inputTokens']),
    outputTokens: n(o['outputTokens']),
    cacheReadTokens: n(o['cacheReadTokens']),
    thinkingTokens: n(o['thinkingTokens']),
    tokensPerSec: n(o['tokensPerSec']),
    linesAdded: n(o['linesAdded']),
    linesRemoved: n(o['linesRemoved']),
    toolCalls: n(o['toolCalls']),
    toolDurationMs: n(o['toolDurationMs']),
    apiDurationMs: n(o['apiDurationMs']),
    turns: n(o['turns']),
  };
}

function block(raw: unknown): Agent['block'] {
  const o = obj(raw);
  if (!o) return null;
  const kind = o['kind'];
  const ok = kind === 'permission' || kind === 'question' || kind === 'input' || kind === 'error';
  const out: NonNullable<Agent['block']> = {
    kind: ok ? kind : 'input',
    summary: s(o['summary'], MAX_LINE),
    since: n(o['since'], Date.now()),
  };
  if (validId(o['escalationId'])) out.escalationId = o['escalationId'];
  return out;
}

/** Copia campo por campo desde lista blanca. Todo lo demás del frame se tira. */
export function sanitizeAgentPatch(raw: unknown): Partial<Agent> {
  const o = obj(raw);
  if (!o) return {};
  const p: Partial<Agent> = {};
  if (has(o, 'machineId') && validId(o['machineId'])) p.machineId = o['machineId'];
  if (has(o, 'projectId') && validId(o['projectId'])) p.projectId = o['projectId'];
  if (has(o, 'title')) p.title = s(o['title']);
  if (has(o, 'callsign')) p.callsign = s(o['callsign'], 12);
  if (has(o, 'state')) p.state = agentState(o['state'], 'booting');
  if (has(o, 'block')) p.block = block(o['block']);
  if (has(o, 'parentId')) p.parentId = validId(o['parentId']) ? o['parentId'] : null;
  if (has(o, 'depth')) p.depth = Math.max(0, Math.min(64, Math.round(n(o['depth']))));
  if (has(o, 'childIds')) p.childIds = strArray(o['childIds'], 512).filter(validId);
  if (has(o, 'mission')) p.mission = sOrNull(o['mission'], MAX_TEXT);
  if (has(o, 'model')) p.model = sOrNull(o['model'], 80);
  if (has(o, 'tool')) p.tool = sOrNull(o['tool'], 64);
  if (has(o, 'toolDetail')) p.toolDetail = sOrNull(o['toolDetail']);
  if (has(o, 'lastPrompt')) p.lastPrompt = sOrNull(o['lastPrompt'], MAX_TEXT);
  if (has(o, 'lastSay')) p.lastSay = sOrNull(o['lastSay'], MAX_TEXT);
  if (has(o, 'startedAt')) p.startedAt = n(o['startedAt']);
  if (has(o, 'updatedAt')) p.updatedAt = n(o['updatedAt']);
  if (has(o, 'uptimeMs')) p.uptimeMs = n(o['uptimeMs']);
  if (has(o, 'metrics')) p.metrics = metrics(o['metrics']);
  if (has(o, 'background')) p.background = b(o['background']);
  if (has(o, 'shortId')) p.shortId = sOrNull(o['shortId'], 64);
  return p;
}

export function sanitizeAgent(raw: unknown, machineId: string): Agent | null {
  const o = obj(raw);
  if (!o || !validId(o['id'])) return null;
  const id = o['id'];
  const now = Date.now();
  return {
    id,
    machineId: validId(o['machineId']) ? o['machineId'] : machineId,
    projectId: validId(o['projectId']) ? o['projectId'] : '',
    title: s(o['title'], MAX_LINE, id),
    callsign: s(o['callsign'], 12, id.slice(-2).toUpperCase()),
    state: agentState(o['state']),
    block: block(o['block']),
    parentId: validId(o['parentId']) ? o['parentId'] : null,
    depth: Math.max(0, Math.min(64, Math.round(n(o['depth'])))),
    childIds: strArray(o['childIds'], 512).filter(validId),
    mission: sOrNull(o['mission'], MAX_TEXT),
    model: sOrNull(o['model'], 80),
    tool: sOrNull(o['tool'], 64),
    toolDetail: sOrNull(o['toolDetail']),
    lastPrompt: sOrNull(o['lastPrompt'], MAX_TEXT),
    lastSay: sOrNull(o['lastSay'], MAX_TEXT),
    startedAt: n(o['startedAt'], now),
    updatedAt: n(o['updatedAt'], now),
    uptimeMs: n(o['uptimeMs']),
    metrics: metrics(o['metrics']),
    background: b(o['background']),
    shortId: sOrNull(o['shortId'], 64),
  };
}

export function sanitizeProjectPatch(raw: unknown): Partial<Project> {
  const o = obj(raw);
  if (!o) return {};
  const p: Partial<Project> = {};
  if (has(o, 'machineId') && validId(o['machineId'])) p.machineId = o['machineId'];
  if (has(o, 'slug')) p.slug = s(o['slug']);
  if (has(o, 'name')) p.name = s(o['name']);
  if (has(o, 'path')) p.path = s(o['path'], 1024);
  if (has(o, 'code')) p.code = s(o['code'], 4);
  if (has(o, 'gitBranch')) p.gitBranch = sOrNull(o['gitBranch'], 200);
  if (has(o, 'gitDirty')) p.gitDirty = b(o['gitDirty']);
  if (has(o, 'keyNames')) p.keyNames = strArray(o['keyNames'], 256);
  if (has(o, 'sessionIds')) p.sessionIds = strArray(o['sessionIds']).filter(validId);
  // `rollup` se ignora a propósito: lo calcula el hub, no el productor.
  return p;
}

export function sanitizeProject(raw: unknown, machineId: string): Project | null {
  const o = obj(raw);
  if (!o || !validId(o['id'])) return null;
  const id = o['id'];
  return {
    id,
    machineId: validId(o['machineId']) ? o['machineId'] : machineId,
    slug: s(o['slug'], MAX_LINE, id),
    name: s(o['name'], MAX_LINE, id),
    path: s(o['path'], 1024),
    code: s(o['code'], 4, id.slice(0, 2).toUpperCase()),
    gitBranch: sOrNull(o['gitBranch'], 200),
    gitDirty: b(o['gitDirty']),
    keyNames: strArray(o['keyNames'], 256),
    sessionIds: strArray(o['sessionIds']).filter(validId),
    rollup: emptyRollup(),
  };
}

/**
 * Un KeyDescriptor sólo lleva metadatos. Si el collector se equivoca y manda
 * algo que huele a valor, el descriptor entero se descarta: es preferible
 * perder una fila de la tabla de auditoría que guardar una credencial.
 */
export function sanitizeKey(raw: unknown): { key: KeyDescriptor | null; rejected: string | null } {
  const o = obj(raw);
  if (!o || typeof o['name'] !== 'string') return { key: null, rejected: 'shape' };
  const name = o['name'];
  const hint = typeof o['hint'] === 'string' ? o['hint'] : '';
  for (const field of ['value', 'secret', 'token', 'apiKey', 'api_key', 'password']) {
    if (has(o, field)) return { key: null, rejected: `campo prohibido "${field}"` };
  }
  if (hint.length > 8 || looksLikeSecret(hint) || looksLikeSecret(name)) {
    return { key: null, rejected: 'hint/name parece un secreto' };
  }
  if (!validId(o['projectId'])) return { key: null, rejected: 'projectId' };
  return {
    key: {
      name: name.slice(0, 120),
      projectId: o['projectId'],
      hint,
      addedAt: n(o['addedAt'], Date.now()),
      lastUsedAt: nOrNull(o['lastUsedAt']),
      usedBy: strArray(o['usedBy'], 512).filter(validId),
    },
    rejected: null,
  };
}

export function sanitizeMachine(raw: unknown): Machine | null {
  const o = obj(raw);
  if (!o || !validId(o['id'])) return null;
  const load = obj(o['load']) ?? {};
  const now = Date.now();
  return {
    id: o['id'],
    hostname: s(o['hostname'], 200, o['id']),
    platform: s(o['platform'], 40, 'unknown'),
    version: s(o['version'], 40, '0'),
    online: true,
    lastSeen: n(o['lastSeen'], now),
    connectedAt: n(o['connectedAt'], now),
    load: {
      sessions: n(load['sessions']),
      activeSessions: n(load['activeSessions']),
      cpuPct: nOrNull(load['cpuPct']),
      memPct: nOrNull(load['memPct']),
    },
  };
}

function sanitizeLoad(raw: unknown): Machine['load'] {
  const o = obj(raw) ?? {};
  return {
    sessions: n(o['sessions']),
    activeSessions: n(o['activeSessions']),
    cpuPct: nOrNull(o['cpuPct']),
    memPct: nOrNull(o['memPct']),
  };
}

export function sanitizeFeedItem(raw: unknown, machineId: string): FeedItem | null {
  const o = obj(raw);
  if (!o) return null;
  const lvl = o['level'];
  const level = lvl === 'trace' || lvl === 'info' || lvl === 'warn' || lvl === 'alert' ? lvl : 'info';
  const item: FeedItem = {
    id: validId(o['id']) ? o['id'] : `f_${Math.random().toString(36).slice(2, 10)}`,
    at: n(o['at'], Date.now()),
    level,
    source: s(o['source'], 40, machineId),
    text: s(o['text'], MAX_LINE),
  };
  if (validId(o['agentId'])) item.agentId = o['agentId'];
  if (validId(o['projectId'])) item.projectId = o['projectId'];
  return item;
}

export function sanitizeEscalation(raw: unknown, machineId: string): Escalation | null {
  const o = obj(raw);
  if (!o || !validId(o['id'])) return null;
  const st = o['status'];
  const status = st === 'pending' || st === 'with_ceo' || st === 'answered'
    || st === 'withdrawn' || st === 'expired' ? st : 'pending';
  const urg = o['urgency'];
  const attempt = obj(o['ceoAttempt']);
  const by = o['answeredBy'];
  return {
    id: o['id'],
    agentId: validId(o['agentId']) ? o['agentId'] : '',
    projectId: validId(o['projectId']) ? o['projectId'] : '',
    machineId: validId(o['machineId']) ? o['machineId'] : machineId,
    question: s(o['question'], MAX_TEXT),
    context: sOrNull(o['context'], MAX_TEXT),
    options: strArray(o['options'], 12),
    optionsOnly: b(o['optionsOnly']),
    urgency: urg === 'low' || urg === 'blocking' ? urg : 'normal',
    status,
    ceoAttempt: attempt ? {
      answer: s(attempt['answer'], MAX_TEXT),
      confidence: n(attempt['confidence']),
      reason: s(attempt['reason'], MAX_TEXT),
    } : null,
    answer: sOrNull(o['answer'], MAX_TEXT),
    answeredBy: by === 'human' || by === 'ceo' ? by : null,
    rememberAs: sOrNull(o['rememberAs'], MAX_TEXT),
    askedAt: n(o['askedAt'], Date.now()),
    answeredAt: nOrNull(o['answeredAt']),
    expiresAt: nOrNull(o['expiresAt']),
  };
}

/* ── rollups ──────────────────────────────────────────────────────── */

/**
 * Un bucket por proyecto (más uno, con clave '', para agentes cuyo proyecto
 * todavía no conocemos). Las mutaciones sólo marcan el bucket sucio; el
 * recálculo ocurre una vez por flush, no una vez por tecla.
 */
interface Bucket {
  ids: Set<string>;
  roll: SessionRollup;
  dirty: boolean;
}

function rollupEq(a: SessionRollup, x: SessionRollup): boolean {
  if (a.total !== x.total || a.blocked !== x.blocked) return false;
  if (Math.abs(a.costUSD - x.costUSD) > 1e-9) return false;
  if (Math.abs(a.tokensPerSec - x.tokensPerSec) > 1e-9) return false;
  for (const st of AGENT_STATES) if (a.byState[st] !== x.byState[st]) return false;
  return true;
}

/* ── el mundo ─────────────────────────────────────────────────────── */

export class World {
  readonly state: WorldState = emptyWorld();
  /** Estadísticas para /api/health. */
  readonly stats = { framesApplied: 0, framesRejected: 0, keysRejected: 0, startedAt: Date.now() };

  private hooks: WorldHooks;
  private now: () => number;
  private out: PatchOp[] = [];
  private buckets = new Map<string, Bucket>();
  /** Índice agente → bucket, para mover un agente cuando cambia de proyecto. */
  private agentBucket = new Map<string, string>();

  constructor(hooks: WorldHooks = {}) {
    this.hooks = hooks;
    this.now = hooks.now ?? (() => Date.now());
  }

  /* ── plomería de mutación ───────────────────────────────────────── */

  private emit(op: PatchOp): void {
    this.state.rev += 1;             // exactamente 1 por mutación
    this.state.at = this.now();
    this.out.push(op);
  }

  private flushOut(): void {
    if (this.out.length === 0) return;
    const ops = this.out;
    this.out = [];
    this.hooks.onOps?.(ops);
  }

  private event(ev: WorldEvent): void {
    this.hooks.onEvent?.(ev);
  }

  private log(...args: unknown[]): void {
    console.warn('[world]', ...args);
  }

  /* ── buckets / rollups ──────────────────────────────────────────── */

  private bucket(key: string): Bucket {
    let bkt = this.buckets.get(key);
    if (!bkt) {
      bkt = { ids: new Set(), roll: emptyRollup(), dirty: true };
      this.buckets.set(key, bkt);
    }
    return bkt;
  }

  private indexAgent(a: Agent): void {
    const key = a.projectId || '';
    const prev = this.agentBucket.get(a.id);
    if (prev !== undefined && prev !== key) {
      const old = this.buckets.get(prev);
      if (old) { old.ids.delete(a.id); old.dirty = true; }
    }
    const bkt = this.bucket(key);
    bkt.ids.add(a.id);
    bkt.dirty = true;
    this.agentBucket.set(a.id, key);
  }

  private unindexAgent(id: string): void {
    const key = this.agentBucket.get(id);
    if (key === undefined) return;
    const bkt = this.buckets.get(key);
    if (bkt) { bkt.ids.delete(id); bkt.dirty = true; }
    this.agentBucket.delete(id);
  }

  private touchAgentBucket(id: string): void {
    const key = this.agentBucket.get(id);
    if (key === undefined) return;
    const bkt = this.buckets.get(key);
    if (bkt) bkt.dirty = true;
  }

  /**
   * Recalcula lo sucio y emite los ops derivados. Se llama justo antes de
   * publicar (o de serializar el mundo) para que un flush a 10 Hz cueste, como
   * mucho, un recorrido de los proyectos que se movieron.
   */
  settle(): void {
    let fleetDirty = false;
    for (const [key, bkt] of this.buckets) {
      if (!bkt.dirty) continue;
      bkt.dirty = false;
      const roll = emptyRollup();
      for (const id of bkt.ids) {
        const a = this.state.agents[id];
        if (!a) continue;
        roll.total += 1;
        roll.byState[a.state] += 1;
        roll.costUSD += a.metrics.costUSD;
        roll.tokensPerSec += a.metrics.tokensPerSec;
        if (a.state === 'blocked') roll.blocked += 1;
      }
      if (rollupEq(bkt.roll, roll)) continue;
      bkt.roll = roll;
      fleetDirty = true;
      const project = key ? this.state.projects[key] : undefined;
      if (project) {
        project.rollup = roll;
        this.emit({ o: 'project', id: project.id, v: project });
      }
    }
    if (!fleetDirty) { this.flushOut(); return; }

    const fleet = emptyRollup();
    for (const bkt of this.buckets.values()) {
      fleet.total += bkt.roll.total;
      fleet.costUSD += bkt.roll.costUSD;
      fleet.tokensPerSec += bkt.roll.tokensPerSec;
      fleet.blocked += bkt.roll.blocked;
      for (const st of AGENT_STATES) fleet.byState[st] += bkt.roll.byState[st];
    }
    if (!rollupEq(this.state.fleet, fleet)) {
      this.state.fleet = fleet;
      this.emit({ o: 'fleet', v: fleet });
    }
    this.flushOut();
  }

  /* ── entrada: frames de collector ───────────────────────────────── */

  /**
   * Aplica un frame de collector. `machineId` es el de la conexión, no el del
   * frame: un collector no puede hablar por otra máquina.
   */
  applyCollector(frame: CollectorFrame, machineId: string): void {
    try {
      this.dispatch(frame, machineId);
      this.stats.framesApplied += 1;
    } catch (err) {
      this.stats.framesRejected += 1;
      // Un frame malo es un hecho de seguridad, no una excepción del hub.
      // Con el id delante: un rechazo sin él es un fallo indepurable, que es
      // exactamente cómo se perdieron los subagentes durante días.
      const culprit = (frame as { id?: unknown; agent?: { id?: unknown } } | undefined);
      const idHint = typeof culprit?.id === 'string' ? culprit.id
        : typeof culprit?.agent?.id === 'string' ? culprit.agent.id
          : null;
      this.log('frame rechazado', frame?.t,
        err instanceof Error ? err.message : err,
        idHint ? `id=${JSON.stringify(idHint)}` : '');
    } finally {
      this.flushOut();
    }
  }

  private dispatch(frame: CollectorFrame, machineId: string): void {
    switch (frame.t) {
      case 'hello': {
        const m = sanitizeMachine(frame.machine);
        if (!m) throw new Error('hello sin máquina válida');
        this.upsertMachine({ ...m, id: machineId });
        return;
      }
      case 'snapshot': return this.applySnapshot(frame, machineId);
      case 'agent': return this.patchAgent(machineId, frame.id, frame.patch);
      case 'agent:new': return this.addAgent(machineId, frame.agent);
      case 'agent:gone': return this.removeAgent(machineId, frame.id);
      case 'project': return this.patchProject(machineId, frame.id, frame.patch);
      case 'project:new': return this.addProject(machineId, frame.project);
      case 'feed': return this.pushFeed(machineId, frame.items);
      case 'escalation': return this.upsertEscalation(machineId, frame.escalation);
      case 'escalation:withdraw': return this.withdrawEscalation(machineId, frame.id, frame.reason);
      case 'beat': return this.beat(machineId, frame.at, frame.load);
      case 'ack': return;   // lo maneja server.ts, no toca el mundo
      default: {
        this.log('frame desconocido', (frame as { t?: unknown }).t);
        return;
      }
    }
  }

  /* ── máquinas ───────────────────────────────────────────────────── */

  upsertMachine(m: Machine): void {
    const prev = this.state.machines[m.id];
    const next: Machine = {
      ...m,
      connectedAt: prev?.connectedAt && m.online ? m.connectedAt || prev.connectedAt : m.connectedAt,
      lastSeen: this.now(),
      online: true,
    };
    this.state.machines[m.id] = next;
    this.emit({ o: 'machine', id: m.id, v: next });
    this.event({ at: this.now(), kind: prev ? 'machine:reconnect' : 'machine:connect', machineId: m.id, text: next.hostname });
    this.flushOut();
  }

  private beat(machineId: string, at: number, load: unknown): void {
    const m = this.state.machines[machineId];
    if (!m) return;
    m.lastSeen = this.now();
    m.online = true;
    m.load = sanitizeLoad(load);
    void at;
    this.emit({ o: 'machine', id: machineId, v: m });
  }

  /**
   * Cualquier frame es señal de vida. No cuenta como mutación (no cambia nada
   * que la consola dibuje) así que no toca `rev` ni emite op.
   */
  touchMachine(machineId: string): void {
    const m = this.state.machines[machineId];
    if (m) m.lastSeen = this.now();
  }

  /**
   * Una máquina que deja de latir no borra nada: se marca offline y sus agentes
   * vivos pasan a 'dead'. Ver qué murió es la mitad del producto.
   */
  markMachineOffline(machineId: string, reason: string): void {
    const m = this.state.machines[machineId];
    if (!m) return;
    if (m.online) {
      m.online = false;
      m.load = { ...m.load, activeSessions: 0 };
      this.emit({ o: 'machine', id: machineId, v: m });
      this.event({ at: this.now(), kind: 'machine:offline', machineId, text: reason });
    }
    for (const a of Object.values(this.state.agents)) {
      if (a.machineId !== machineId) continue;
      if (!LIVE_STATES.has(a.state)) continue;
      a.state = 'dead';
      a.block = null;
      a.tool = null;
      a.toolDetail = null;
      a.metrics.tokensPerSec = 0;
      a.updatedAt = this.now();
      this.touchAgentBucket(a.id);
      this.emit({ o: 'agent', id: a.id, v: a });
    }
    for (const e of Object.values(this.state.escalations)) {
      if (e.machineId !== machineId || e.status !== 'pending') continue;
      e.status = 'expired';
      this.emit({ o: 'escalation', id: e.id, v: e });
    }
    this.pushFeed(machineId, [{
      id: `f_off_${machineId}_${this.now()}`,
      at: this.now(), level: 'alert', source: 'ORCA',
      text: `máquina ${m.hostname} offline (${reason})`,
    }]);
    this.flushOut();
  }

  /** Barrido de latidos. El server lo llama en un intervalo. */
  sweep(now = this.now()): void {
    for (const m of Object.values(this.state.machines)) {
      if (!m.online) continue;
      if (now - m.lastSeen <= BEAT_TIMEOUT_MS) continue;
      this.markMachineOffline(m.id, `sin latido ${Math.round((now - m.lastSeen) / 1000)}s`);
    }
    for (const e of Object.values(this.state.escalations)) {
      if (e.status !== 'pending' && e.status !== 'with_ceo') continue;
      if (e.expiresAt !== null && e.expiresAt < now) {
        e.status = 'expired';
        this.emit({ o: 'escalation', id: e.id, v: e });
      }
    }
    this.evictTerminal(now);
    this.enforceMachineCap();
    this.flushOut();
  }

  /**
   * Desaloja lo que ya terminó y lleva tiempo terminado.
   *
   * Dos límites por si uno falla: la edad, para que el operador conserve una
   * hora de contexto, y un tope duro, para que una flota que muere en masa no
   * pueda tumbar el proceso mientras la edad todavía no ha vencido.
   */
  private evictTerminal(now: number): void {
    const agents = Object.values(this.state.agents);
    const terminal = agents.filter((a) => a.state === 'done' || a.state === 'dead');

    if (terminal.length > 0) {
      // Más nuevos primero: lo que se tira es siempre la cola.
      terminal.sort((a, b) => b.updatedAt - a.updatedAt);
      for (let i = 0; i < terminal.length; i++) {
        const a = terminal[i]!;
        const tooOld = now - a.updatedAt > AGENT_RETENTION_MS;
        const overCap = i >= MAX_TERMINAL_AGENTS;
        if (!tooOld && !overCap) continue;
        // Un agente con hijos vivos se queda: sin él el linaje se rompe y la
        // consola mostraría subagentes huérfanos sin padre al que volver.
        if (a.childIds.some((c) => {
          const kid = this.state.agents[c];
          return kid !== undefined && kid.state !== 'done' && kid.state !== 'dead';
        })) continue;
        this.dropAgent(a.id);
      }
    }

    // Cola abierta: si desborda, caducan las más viejas no bloqueantes.
    const open = Object.values(this.state.escalations)
      .filter((e) => e.status === 'pending' || e.status === 'with_ceo');
    if (open.length > MAX_OPEN_ESCALATIONS) {
      const droppable = open
        .filter((e) => e.urgency !== 'blocking')
        .sort((a, b) => a.askedAt - b.askedAt);
      const excess = open.length - MAX_OPEN_ESCALATIONS;
      let expired = 0;
      for (const e of droppable) {
        if (expired >= excess) break;
        e.status = 'expired';
        this.emit({ o: 'escalation', id: e.id, v: e });
        expired++;
      }
      if (expired > 0) {
        this.log(
          `cola de preguntas desbordada (${open.length}); caducadas ${expired} no bloqueantes. ` +
          'Los agentes que aún las necesiten volverán a preguntar.',
        );
      }
    }

    const closed = Object.values(this.state.escalations)
      .filter((e) => e.status === 'answered' || e.status === 'withdrawn' || e.status === 'expired');
    if (closed.length === 0) return;
    closed.sort((a, b) => (b.answeredAt ?? b.askedAt) - (a.answeredAt ?? a.askedAt));
    for (let i = 0; i < closed.length; i++) {
      const e = closed[i]!;
      const when = e.answeredAt ?? e.askedAt;
      if (now - when <= ESCALATION_RETENTION_MS && i < MAX_CLOSED_ESCALATIONS) continue;
      delete this.state.escalations[e.id];
      this.emit({ o: 'escalation', id: e.id, v: null });
    }
  }

  /**
   * Techo por máquina. Ver MAX_AGENTS_PER_MACHINE: esto existe para que un
   * collector desbocado no se lleve por delante al hub.
   */
  private enforceMachineCap(): void {
    const byMachine = new Map<string, Agent[]>();
    for (const a of Object.values(this.state.agents)) {
      const list = byMachine.get(a.machineId);
      if (list) list.push(a); else byMachine.set(a.machineId, [a]);
    }
    for (const [machineId, list] of byMachine) {
      if (list.length <= MAX_AGENTS_PER_MACHINE) continue;
      // Lo que necesita a una persona nunca se tira, ni aunque sea lo más viejo.
      const droppable = list
        .filter((a) => a.state !== 'blocked')
        .sort((a, b) => a.updatedAt - b.updatedAt);
      const excess = list.length - MAX_AGENTS_PER_MACHINE;
      let dropped = 0;
      for (const a of droppable) {
        if (dropped >= excess) break;
        this.dropAgent(a.id);
        dropped++;
      }
      this.log(
        `máquina ${machineId} superó el techo de ${MAX_AGENTS_PER_MACHINE} agentes ` +
        `(${list.length}); descartados ${dropped} de los menos recientes. ` +
        'Esto casi siempre significa un collector con un bug, no una flota enorme.',
      );
    }
  }

  /** Quita un agente del mundo y de todos los índices que lo referencian. */
  private dropAgent(id: string): void {
    const a = this.state.agents[id];
    if (!a) return;
    // Desengancharlo del padre para no dejar un childIds apuntando a la nada.
    if (a.parentId) {
      const parent = this.state.agents[a.parentId];
      if (parent) {
        const at = parent.childIds.indexOf(id);
        if (at >= 0) {
          parent.childIds.splice(at, 1);
          this.emit({ o: 'agent:patch', id: parent.id, v: { childIds: parent.childIds } });
        }
      }
    }
    const project = this.state.projects[a.projectId];
    if (project) {
      const at = project.sessionIds.indexOf(id);
      if (at >= 0) project.sessionIds.splice(at, 1);
    }
    this.unindexAgent(id);
    delete this.state.agents[id];
    this.emit({ o: 'agent', id, v: null });
  }

  /* ── snapshot completo de una máquina ───────────────────────────── */

  private applySnapshot(
    frame: Extract<CollectorFrame, { t: 'snapshot' }>, machineId: string,
  ): void {
    const seenProjects = new Set<string>();
    for (const raw of Array.isArray(frame.projects) ? frame.projects : []) {
      const p = sanitizeProject(raw, machineId);
      if (!p || p.machineId !== machineId) continue;
      seenProjects.add(p.id);
      const prev = this.state.projects[p.id];
      p.rollup = prev?.rollup ?? emptyRollup();
      this.state.projects[p.id] = p;
      this.bucket(p.id).dirty = true;
      this.emit({ o: 'project', id: p.id, v: p });
    }

    const seenAgents = new Set<string>();
    for (const raw of Array.isArray(frame.agents) ? frame.agents : []) {
      const a = sanitizeAgent(raw, machineId);
      if (!a) continue;
      a.machineId = machineId;
      seenAgents.add(a.id);
      this.state.agents[a.id] = a;
      this.indexAgent(a);
      this.emit({ o: 'agent', id: a.id, v: a });
    }

    // Agentes que esta máquina ya no reporta: no los borramos, los damos por
    // muertos. Un snapshot es "lo que hay vivo ahora", no "lo que existió".
    for (const a of Object.values(this.state.agents)) {
      if (a.machineId !== machineId || seenAgents.has(a.id)) continue;
      if (!LIVE_STATES.has(a.state)) continue;
      a.state = 'dead';
      a.block = null;
      a.updatedAt = this.now();
      this.touchAgentBucket(a.id);
      this.emit({ o: 'agent', id: a.id, v: a });
    }

    for (const raw of Array.isArray(frame.keys) ? frame.keys : []) {
      const { key, rejected } = sanitizeKey(raw);
      if (!key) {
        this.stats.keysRejected += 1;
        this.log('KeyDescriptor descartado:', rejected);
        continue;
      }
      const id = `${key.projectId}/${key.name}`;
      this.state.keys[id] = key;
      this.emit({ o: 'key', id, v: key });
    }

    void seenProjects;
    this.settle();
  }

  /* ── agentes ────────────────────────────────────────────────────── */

  private addAgent(machineId: string, raw: unknown): void {
    const a = sanitizeAgent(raw, machineId);
    if (!a) throw new Error('agent:new inválido');
    a.machineId = machineId;
    this.state.agents[a.id] = a;
    this.indexAgent(a);
    this.linkParent(a);
    this.syncProjectSessions(a.projectId);
    this.emit({ o: 'agent', id: a.id, v: a });
    this.event({
      at: this.now(), kind: 'agent:new', machineId, agentId: a.id, projectId: a.projectId,
      text: a.title, data: { parentId: a.parentId, depth: a.depth, mission: a.mission },
    });
  }

  private linkParent(a: Agent): void {
    if (!a.parentId) return;
    const parent = this.state.agents[a.parentId];
    if (!parent || parent.childIds.includes(a.id)) return;
    parent.childIds = [...parent.childIds, a.id];
    this.emit({ o: 'agent:patch', id: parent.id, v: { childIds: parent.childIds } });
  }

  private patchAgent(machineId: string, id: unknown, rawPatch: unknown): void {
    if (!validId(id)) throw new Error('agent id inválido');
    const a = this.state.agents[id];
    if (!a) {
      // Llegó un patch de un agente que no conocemos. En vez de inventarlo,
      // pedimos implícitamente un resync marcando el hecho en el log.
      this.event({ at: this.now(), kind: 'agent:orphan-patch', machineId, agentId: id });
      return;
    }
    if (a.machineId !== machineId) throw new Error('máquina ajena');
    const patch = sanitizeAgentPatch(rawPatch);
    if (Object.keys(patch).length === 0) return;

    const before = a.state;
    const projBefore = a.projectId;
    // `metrics` se funde en vez de reemplazarse: los collectors mandan deltas
    // parciales y perder contadores haría saltar la escena 3D.
    if (patch.metrics) { a.metrics = { ...a.metrics, ...patch.metrics }; delete patch.metrics; }
    Object.assign(a, patch);
    a.updatedAt = this.now();

    if (a.projectId !== projBefore) this.indexAgent(a);
    else this.touchAgentBucket(a.id);

    if (patch.state && patch.state !== before) {
      this.event({
        at: this.now(), kind: 'agent:state', machineId, agentId: a.id, projectId: a.projectId,
        text: `${before} → ${a.state}`, data: { block: a.block },
      });
    }
    this.emit({ o: 'agent:patch', id: a.id, v: { ...patch, updatedAt: a.updatedAt, metrics: a.metrics } });
  }

  private removeAgent(machineId: string, id: unknown): void {
    if (!validId(id)) throw new Error('agent id inválido');
    const a = this.state.agents[id];
    if (!a || a.machineId !== machineId) return;
    delete this.state.agents[id];
    this.unindexAgent(id);
    if (a.parentId) {
      const parent = this.state.agents[a.parentId];
      if (parent && parent.childIds.includes(id)) {
        parent.childIds = parent.childIds.filter((c) => c !== id);
        this.emit({ o: 'agent:patch', id: parent.id, v: { childIds: parent.childIds } });
      }
    }
    this.syncProjectSessions(a.projectId);
    this.emit({ o: 'agent', id, v: null });
    this.event({ at: this.now(), kind: 'agent:gone', machineId, agentId: id, projectId: a.projectId });
  }

  private syncProjectSessions(projectId: string): void {
    const p = this.state.projects[projectId];
    if (!p) return;
    const bkt = this.buckets.get(projectId);
    const ids = bkt ? [...bkt.ids] : [];
    if (ids.length === p.sessionIds.length && ids.every((x, i) => p.sessionIds[i] === x)) return;
    p.sessionIds = ids;
    this.emit({ o: 'project', id: p.id, v: p });
  }

  /* ── proyectos ──────────────────────────────────────────────────── */

  private addProject(machineId: string, raw: unknown): void {
    const p = sanitizeProject(raw, machineId);
    if (!p) throw new Error('project:new inválido');
    p.machineId = machineId;
    const prev = this.state.projects[p.id];
    p.rollup = prev?.rollup ?? this.buckets.get(p.id)?.roll ?? emptyRollup();
    this.state.projects[p.id] = p;
    this.emit({ o: 'project', id: p.id, v: p });
  }

  private patchProject(machineId: string, id: unknown, rawPatch: unknown): void {
    if (!validId(id)) throw new Error('project id inválido');
    const p = this.state.projects[id];
    if (!p) return;
    if (p.machineId !== machineId) throw new Error('máquina ajena');
    const patch = sanitizeProjectPatch(rawPatch);
    if (Object.keys(patch).length === 0) return;
    Object.assign(p, patch);
    this.emit({ o: 'project', id: p.id, v: p });
  }

  /* ── feed ───────────────────────────────────────────────────────── */

  pushFeed(machineId: string, rawItems: unknown): void {
    if (!Array.isArray(rawItems) || rawItems.length === 0) return;
    const items: FeedItem[] = [];
    for (const raw of rawItems.slice(0, 200)) {
      const item = sanitizeFeedItem(raw, machineId);
      if (item) items.push(item);
    }
    if (items.length === 0) return;
    this.state.feed.push(...items);
    if (this.state.feed.length > MAX_FEED) {
      const dropped = this.state.feed.splice(0, this.state.feed.length - MAX_FEED);
      this.hooks.onOverflow?.('feed', dropped);
    }
    this.emit({ o: 'feed', v: items });
    for (const it of items) {
      if (it.level === 'alert' || it.level === 'warn') {
        this.event({ at: it.at, kind: `feed:${it.level}`, machineId, text: `${it.source} ${it.text}` });
      }
    }
  }

  /* ── escalaciones ───────────────────────────────────────────────── */

  private upsertEscalation(machineId: string, raw: unknown): void {
    const e = sanitizeEscalation(raw, machineId);
    if (!e) throw new Error('escalation inválida');
    e.machineId = machineId;
    const prev = this.state.escalations[e.id];
    // Una escalación ya respondida no vuelve a 'pending' por un frame tardío.
    if (prev && prev.status === 'answered' && e.status !== 'answered') return;
    this.state.escalations[e.id] = e;
    this.emit({ o: 'escalation', id: e.id, v: e });
    if (!prev) {
      this.event({
        at: this.now(), kind: 'escalation:new', machineId, agentId: e.agentId,
        projectId: e.projectId, text: e.question,
        data: { id: e.id, urgency: e.urgency, options: e.options },
      });
    }
  }

  private withdrawEscalation(machineId: string, id: unknown, reason: unknown): void {
    if (!validId(id)) return;
    const e = this.state.escalations[id];
    if (!e || e.machineId !== machineId) return;
    if (e.status === 'answered') return;
    e.status = 'withdrawn';
    this.emit({ o: 'escalation', id, v: e });
    this.event({ at: this.now(), kind: 'escalation:withdraw', machineId, text: s(reason, MAX_LINE) });
  }

  /** Respuesta humana (o del CEO). Devuelve la escalación resuelta. */
  answerEscalation(
    id: string, answer: string, by: 'human' | 'ceo', rememberAs: string | null,
  ): Escalation | null {
    const e = this.state.escalations[id];
    if (!e) return null;
    e.answer = redact(answer.slice(0, MAX_TEXT));
    e.answeredBy = by;
    e.answeredAt = this.now();
    e.rememberAs = rememberAs === null ? null : redact(rememberAs.slice(0, MAX_TEXT));
    e.status = 'answered';
    this.emit({ o: 'escalation', id, v: e });

    const a = this.state.agents[e.agentId];
    if (a && a.state === 'blocked' && a.block?.escalationId === id) {
      a.block = null;
      a.state = 'working';
      a.updatedAt = this.now();
      this.touchAgentBucket(a.id);
      this.emit({ o: 'agent:patch', id: a.id, v: { block: null, state: 'working', updatedAt: a.updatedAt } });
    }
    this.event({
      at: this.now(), kind: 'escalation:answered', machineId: e.machineId, agentId: e.agentId,
      projectId: e.projectId, text: e.question, data: { answer: e.answer, by, rememberAs: e.rememberAs },
    });
    this.flushOut();
    return e;
  }

  /**
   * Inserta una escalación nacida dentro del hub (la levanta el CEO), no
   * recibida de un collector. Sin esto el CEO no tendría forma de preguntarle
   * nada al humano por su cuenta.
   */
  upsertEscalationLocal(e: Escalation): Escalation {
    this.state.escalations[e.id] = e;
    this.emit({ o: 'escalation', id: e.id, v: e });
    this.event({
      at: this.now(), kind: 'escalation:new', machineId: e.machineId, agentId: e.agentId,
      projectId: e.projectId, text: e.question,
      // Sin `id` en data: ésta la levantó el CEO, y volver a notificárselo
      // provocaría que se triara a sí mismo en bucle.
      data: { urgency: e.urgency, options: e.options, from: 'ceo' },
    });
    this.flushOut();
    return e;
  }

  /**
   * El CEO intentó contestar y no pudo: se anota qué probó y por qué se rindió,
   * y la pregunta vuelve a la cola del humano. Ese rastro es lo que le permite
   * al operador cerrar el hueco de una vez con REMEMBER.
   */
  attachCeoAttempt(id: string, attempt: Escalation['ceoAttempt']): void {
    const e = this.state.escalations[id];
    if (!e) return;
    e.ceoAttempt = attempt;
    e.status = 'pending';
    this.emit({ o: 'escalation', id, v: e });
    this.flushOut();
  }

  /** El CEO se hizo cargo: la consola lo muestra en triaje, no sin leer. */
  markEscalationWithCeo(id: string): void {
    const e = this.state.escalations[id];
    if (!e || e.status !== 'pending') return;
    e.status = 'with_ceo';
    this.emit({ o: 'escalation', id, v: e });
    this.flushOut();
  }

  /** El triaje del CEO falló: la pregunta vuelve a la cola del humano. */
  markEscalationPending(id: string): void {
    const e = this.state.escalations[id];
    if (!e || e.status !== 'with_ceo') return;
    e.status = 'pending';
    this.emit({ o: 'escalation', id, v: e });
    this.flushOut();
  }

  dismissEscalation(id: string): Escalation | null {
    const e = this.state.escalations[id];
    if (!e) return null;
    e.status = 'withdrawn';
    this.emit({ o: 'escalation', id, v: e });
    this.flushOut();
    return e;
  }

  /* ── CEO ────────────────────────────────────────────────────────── */

  addCeoMessage(msg: CeoMessage): CeoMessage {
    const safe: CeoMessage = { ...msg, text: redact(msg.text.slice(0, MAX_TEXT)) };
    this.state.ceo.messages.push(safe);
    if (this.state.ceo.messages.length > MAX_CEO_MESSAGES) {
      const dropped = this.state.ceo.messages.splice(0, this.state.ceo.messages.length - MAX_CEO_MESSAGES);
      this.hooks.onOverflow?.('ceo', dropped);
    }
    // No hay PatchOp para mensajes del CEO en el protocolo: el server manda
    // {t:'ceo:message'}. Aun así contamos la mutación en `rev`.
    this.state.rev += 1;
    this.state.at = this.now();
    return safe;
  }

  /** Repone la conversación recuperada del disco sin emitir eventos ni ops. */
  hydrateCeo(messages: CeoMessage[]): void {
    const tail = messages.slice(-MAX_CEO_MESSAGES);
    this.state.ceo.messages = tail;
  }

  setCeoThinking(v: boolean): void {
    if (this.state.ceo.thinking === v) return;
    this.state.ceo.thinking = v;
    this.emit({ o: 'ceo:thinking', v });
    this.flushOut();
  }

  setAwaitingHuman(v: boolean): void {
    if (this.state.ceo.awaitingHuman === v) return;
    this.state.ceo.awaitingHuman = v;
    this.state.rev += 1;
  }

  /* ── lecturas ───────────────────────────────────────────────────── */

  /** Estado listo para el cable (ya viene recortado por construcción). */
  snapshot(rev?: number): WorldState {
    this.settle();
    const st = this.state;
    return {
      ...st,
      rev: rev ?? st.rev,
      at: this.now(),
      feed: st.feed.slice(-MAX_FEED),
      ceo: { ...st.ceo, messages: st.ceo.messages.slice(-MAX_CEO_MESSAGES) },
    };
  }

  health(): Record<string, unknown> {
    this.settle();
    const machines = Object.values(this.state.machines);
    return {
      ok: true,
      rev: this.state.rev,
      uptimeMs: this.now() - this.stats.startedAt,
      machines: {
        total: machines.length,
        online: machines.filter((m) => m.online).length,
        list: machines.map((m) => ({
          id: m.id, hostname: m.hostname, platform: m.platform, online: m.online,
          lastSeenAgoMs: Math.max(0, this.now() - m.lastSeen),
          sessions: m.load.sessions, activeSessions: m.load.activeSessions,
        })),
      },
      projects: Object.keys(this.state.projects).length,
      agents: { total: this.state.fleet.total, byState: this.state.fleet.byState },
      blocked: this.state.fleet.blocked,
      costUSD: Number(this.state.fleet.costUSD.toFixed(4)),
      tokensPerSec: Number(this.state.fleet.tokensPerSec.toFixed(1)),
      escalations: {
        total: Object.keys(this.state.escalations).length,
        pending: Object.values(this.state.escalations).filter((e) => e.status === 'pending' || e.status === 'with_ceo').length,
      },
      keys: Object.keys(this.state.keys).length,
      feed: this.state.feed.length,
      ceoMessages: this.state.ceo.messages.length,
      frames: { applied: this.stats.framesApplied, rejected: this.stats.framesRejected },
      security: { keysRejected: this.stats.keysRejected, redactions: redactionCount() },
    };
  }
}
