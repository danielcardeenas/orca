import { parseContinuation } from '../shared/continuation.ts';
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
  Agent, AgentMessage, AgentMetrics, AgentRole, AgentState, Artifact, ArtifactKind, CeoMessage,
  Collision, Escalation, FeedItem, KeyDescriptor, Machine, MessageKind, MessageScope,
  Project, SessionRollup, WorldState,
  TalkItem,
} from '../shared/types.ts';
import { AGENT_STATES, LIVE_STATES, MAX_TALK, MAX_TALK_TEXT, TERMINAL_STATES, emptyRollup, emptyWorld } from '../shared/types.ts';
import { squadName } from '../shared/squads.ts';
import { parseModelControl } from '../shared/model-control.ts';
import {
  MAX_ARCHIVED, archiveBy, archiveCandidates, tombstone,
  type ArchiveFilter, type ArchiveOutcome, type ArchivedAgent,
} from '../shared/archive.ts';
import { mergeTalk } from '../shared/talk.ts';
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

/*
 * Tráfico entre agentes.
 *
 * Un mensaje ya entregado hizo su trabajo: vive una hora por si el operador
 * quiere entender por qué T1 hizo lo que hizo, y después se queda sólo en el
 * log append-only. Vale la misma lógica que para los agentes muertos, con una
 * excepción que no es negociable:
 *
 *   un `ask` sin responder NUNCA se desaloja.
 *
 * Detrás de cada uno hay un agente parado esperando la respuesta. Tirarlo por
 * viejo lo dejaría bloqueado para siempre y sin nada en pantalla que explique
 * por qué, que es exactamente el fallo silencioso que esta consola existe para
 * evitar. Si la cola de asks crece sin parar, el problema es que nadie está
 * contestando; esconderlo no lo arregla, así que se avisa a gritos y se
 * conservan.
 */
export const MESSAGE_RETENTION_MS = 60 * 60_000;
export const MAX_MESSAGES = 300;

/*
 * Las colisiones las cierra el collector con `collision:clear` en cuanto los
 * agentes dejan de pisarse, así que en condiciones normales este techo no se
 * toca nunca. Existe para cuando no llega ese clear: un collector con un bug,
 * uno viejo, o uno que se cayó justo después de abrirlas. Sin techo, eso es
 * memoria que no vuelve.
 */
export const MAX_COLLISIONS = 200;

/*
 * Artefactos.
 *
 * Se conservan mucho más que un mensaje o un agente muerto, y a propósito: lo
 * que la flota produjo ayer sigue siendo lo que produjo, y volver a mirarlo por
 * la mañana es un caso normal. Lo que no puede es crecer sin techo — cada
 * registro tiene además un archivo cacheado en disco detrás, así que el desalojo
 * también libera bytes de verdad.
 */
export const ARTIFACT_RETENTION_MS = 24 * 60 * 60_000;
export const MAX_ARTIFACTS = 300;

/** Un frame malicioso no puede hacernos alojar 10 MB de strings. */
const MAX_TEXT = 4_000;
const MAX_LINE = 400;
const MAX_ARRAY = 2_000;
/* Un mensaje entre agentes es un asunto de una línea y un cuerpo corto: si
 * hace falta más, lo que se pasa es un archivo, no un mensaje. */
const MAX_SUBJECT = 300;
const MAX_BODY = 8_000;
const MAX_FILES = 20;
/** Nadie necesita saber que un mensaje lo leyeron doscientos agentes. */
const MAX_READ_BY = 64;

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
  /**
   * Un artefacto salió del mundo. El hub guarda una copia de sus bytes en
   * ~/.orca/artifacts; sin este aviso la caché sobreviviría al registro y
   * crecería para siempre en un disco que nadie mira.
   */
  onArtifactGone?: (id: string) => void;
  /**
   * Agentes archivados a mano (consola, CAPCOM, CLI). El hub guarda la lápida
   * en disco: sin ella, el siguiente snapshot del collector los devolvería.
   */
  onArchived?: (entries: ArchivedAgent[]) => void;
  /** Una sesión archivada volvió a la vida; su lápida deja de valer. */
  onUnarchived?: (id: string, at: number) => void;
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

/**
 * Sólo 'capcom' asciende; todo lo demás es un agente normal.
 *
 * Es una lista blanca de un elemento a propósito: el rol decide a quién le
 * entrega el hub lo que escribe el humano, así que un valor inventado en un
 * frame no puede secuestrar el mando de la flota.
 */
function agentRole(v: unknown): AgentRole {
  return v === 'capcom' ? 'capcom' : 'agent';
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
    ...(has(o, 'contextTokens') ? { contextTokens: n(o['contextTokens']) } : {}),
    ...(has(o, 'compactions') ? { compactions: n(o['compactions']) } : {}),
  };
}

function block(raw: unknown): Agent['block'] {
  const o = obj(raw);
  if (!o) return null;
  const kind = o['kind'];
  const ok = kind === 'permission' || kind === 'question' || kind === 'peer'
    || kind === 'input' || kind === 'error';
  const out: NonNullable<Agent['block']> = {
    kind: ok ? kind : 'input',
    summary: s(o['summary'], MAX_LINE),
    since: n(o['since'], Date.now()),
  };
  if (validId(o['escalationId'])) out.escalationId = o['escalationId'];
  // Un bloqueo 'peer' sin messageId no se puede desbloquear al contestar: el
  // mundo no sabría qué mensaje lo liberó. Se copian los dos si son válidos.
  if (validId(o['messageId'])) out.messageId = o['messageId'];
  if (validId(o['waitingOn'])) out.waitingOn = o['waitingOn'];
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
  if (o['origin'] === 'orca' || o['origin'] === 'external') p.origin = o['origin'];
  if (has(o, 'subagent')) p.subagent = b(o['subagent']);
  if (has(o, 'hidden')) p.hidden = b(o['hidden']);
  if (has(o, 'role')) p.role = agentRole(o['role']);
  if (has(o, 'state')) p.state = agentState(o['state'], 'booting');
  if (has(o, 'block')) p.block = block(o['block']);
  if (has(o, 'parentId')) p.parentId = validId(o['parentId']) ? o['parentId'] : null;
  if (has(o, 'depth')) p.depth = Math.max(0, Math.min(64, Math.round(n(o['depth']))));
  if (has(o, 'childIds')) p.childIds = strArray(o['childIds'], 512).filter(validId);
  if (has(o, 'mission')) p.mission = sOrNull(o['mission'], MAX_TEXT);
  if (has(o, 'squad')) p.squad = squadName(o['squad']);
  if (has(o, 'lead')) p.lead = b(o['lead']);
  if (has(o, 'model')) p.model = sOrNull(o['model'], 80);
  if (has(o, 'continuation')) p.continuation = parseContinuation(o['continuation']);
  if (has(o, 'modelControl')) p.modelControl = parseModelControl(o['modelControl']);
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
  if (has(o, 'pane')) p.pane = b(o['pane']);
  if (has(o, 'worktree')) p.worktree = sOrNull(o['worktree'], 1024);
  if (has(o, 'branch')) p.branch = sOrNull(o['branch'], 256);
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
    runtime: s(o['runtime'], 16, 'claude'),
    /*
     * El rol viene del collector que lanzó la sesión, y sólo hay dos valores
     * posibles. Cualquier otra cosa cae a 'agent': un frame que dijera
     * `role:'capcom'` mal formado no puede convertir a un agente cualquiera en
     * el comando de la flota.
     */
    role: agentRole(o['role']),
    ...(o['origin'] === 'orca' || o['origin'] === 'external' ? { origin: o['origin'] } : {}),
    ...(has(o, 'subagent') ? { subagent: b(o['subagent']) } : {}),
    ...(has(o, 'hidden') ? { hidden: b(o['hidden']) } : {}),
    state: agentState(o['state']),
    block: block(o['block']),
    parentId: validId(o['parentId']) ? o['parentId'] : null,
    depth: Math.max(0, Math.min(64, Math.round(n(o['depth'])))),
    childIds: strArray(o['childIds'], 512).filter(validId),
    mission: sOrNull(o['mission'], MAX_TEXT),
    /*
     * El escuadrón pasa por su propio validador y no por `sOrNull`: es una
     * etiqueta que la consola enruta y dibuja, no texto libre. Un nombre con
     * espacios o de trescientos caracteres no es un escuadrón al que nadie
     * pueda escribir, así que cae a null en vez de entrar recortado.
     */
    squad: squadName(o['squad']),
    lead: squadName(o['squad']) !== null && b(o['lead']),
    model: sOrNull(o['model'], 80),
    continuation: parseContinuation(o['continuation']),
    modelControl: parseModelControl(o['modelControl']),
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
    pane: b(o['pane']),
    worktree: sOrNull(o['worktree'], 1024),
    branch: sOrNull(o['branch'], 256),
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

const TALK_KINDS = new Set<TalkItem['kind']>(['prompt', 'thinking', 'say', 'tool', 'result']);

export function sanitizeTalkItem(raw: unknown, agentId: string): TalkItem | null {
  const o = obj(raw);
  if (!o || !validId(o['id'])) return null;
  const kind = o['kind'];
  if (typeof kind !== 'string' || !TALK_KINDS.has(kind as TalkItem['kind'])) return null;
  const item: TalkItem = {
    id: o['id'],
    agentId,
    at: n(o['at'], Date.now()),
    kind: kind as TalkItem['kind'],
    text: s(o['text'], MAX_TALK_TEXT),
  };
  const tool = sOrNull(o['tool'], 80);
  if (tool) item.tool = tool;
  const tuid = sOrNull(o['toolUseId'], 120);
  if (tuid) item.toolUseId = tuid;
  if (o['error'] === true) item.error = true;
  const msgId = sOrNull(o['msgId'], 120);
  if (msgId) item.msgId = msgId;
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
    ...(obj(o['permission']) && ['requested', 'pending', 'confirmed'].includes(String(obj(o['permission'])!['phase'])) ? { permission: { phase: obj(o['permission'])!['phase'] as 'requested' | 'pending' | 'confirmed', fingerprint: s(obj(o['permission'])!['fingerprint'], 64) } } : {}),
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

const MESSAGE_KINDS = new Set<string>(['notice', 'ask', 'handoff', 'warning']);
const MESSAGE_SCOPES = new Set<string>(['agent', 'project', 'squad', 'fleet']);

/**
 * Un mensaje entre agentes.
 *
 * Mismo rigor que el resto: lista blanca campo por campo, ids validados, textos
 * recortados y secretos tachados. Dos rechazos duros, porque un mensaje así no
 * se puede ni enrutar ni atribuir:
 *
 *  - sin `fromAgentId` válido no sabríamos a quién NO devolvérselo, y un
 *    mensaje que vuelve a su emisor es un bucle;
 *  - un `scope:'agent'` sin destinatario no tiene a dónde ir.
 *
 * `machineId` no se copia a ningún campo —`AgentMessage` no lleva máquina, la
 * dice el `Agent` que lo mandó— pero se acepta por simetría con los demás
 * sanitizadores y porque quien llama ya la tiene a mano para el rechazo.
 */
export function sanitizeMessage(raw: unknown, machineId: string): AgentMessage | null {
  void machineId;
  const o = obj(raw);
  if (!o || !validId(o['id'])) return null;
  if (!validId(o['fromAgentId'])) return null;

  const k = o['kind'];
  const kind: MessageKind = typeof k === 'string' && MESSAGE_KINDS.has(k) ? k as MessageKind : 'notice';
  const sc = o['scope'];
  const scope: MessageScope = typeof sc === 'string' && MESSAGE_SCOPES.has(sc) ? sc as MessageScope : 'agent';

  const toAgentId = validId(o['toAgentId']) ? o['toAgentId'] : null;
  const fromProjectId = validId(o['fromProjectId']) ? o['fromProjectId'] : '';
  // Un mensaje de proyecto sin proyecto declarado se entiende como "los de mi
  // propio proyecto", que es lo que quiere decir un agente que no lo puso.
  const toProjectId = validId(o['toProjectId']) ? o['toProjectId']
    : (scope === 'project' && fromProjectId ? fromProjectId : null);
  const toSquad = squadName(o['toSquad']);
  if (scope === 'agent' && toAgentId === null) return null;
  if (scope === 'project' && toProjectId === null) return null;
  // Un `squad` sin nombre de escuadrón no tiene a dónde ir, igual que un
  // `agent` sin destinatario: el hub enruta por la etiqueta, no por otra cosa.
  if (scope === 'squad' && toSquad === null) return null;

  // Se recorta antes de mirar si queda algo: un asunto de espacios en blanco no
  // es un asunto, y en el mapa dibujaría una arista sin etiqueta.
  const subject = s(o['subject'], MAX_SUBJECT).trim();
  if (!subject) return null;

  return {
    id: o['id'],
    kind,
    scope,
    fromAgentId: o['fromAgentId'],
    fromCallsign: s(o['fromCallsign'], 12, o['fromAgentId'].slice(-2).toUpperCase()),
    fromProjectId,
    toAgentId: scope === 'agent' ? toAgentId : null,
    toProjectId: scope === 'project' ? toProjectId : null,
    toSquad: scope === 'squad' ? toSquad : null,
    subject,
    body: sOrNull(o['body'], MAX_BODY),
    files: strArray(o['files'], MAX_FILES),
    at: n(o['at'], Date.now()),
    readBy: strArray(o['readBy'], MAX_READ_BY).filter(validId),
    expiresAt: nOrNull(o['expiresAt']),
    answer: sOrNull(o['answer'], MAX_BODY),
    answeredAt: nOrNull(o['answeredAt']),
    answeredBy: validId(o['answeredBy']) ? o['answeredBy'] : null,
  };
}

/**
 * Una colisión es derivada, no declarada: el collector la deduce de las
 * escrituras que ya vio. Aun así entra por la misma puerta que todo lo demás —
 * el collector puede tener un bug o no ser quien dice ser.
 *
 * Con menos de dos agentes no hay colisión, y guardarla sería enseñarle al
 * operador una alarma que no describe nada.
 */
export function sanitizeCollision(raw: unknown, machineId: string): Collision | null {
  const o = obj(raw);
  if (!o || !validId(o['id'])) return null;
  const path = s(o['path'], 1024);
  if (!path) return null;
  const agentIds = strArray(o['agentIds'], 32).filter(validId);
  if (agentIds.length < 2) return null;
  const now = Date.now();
  return {
    id: o['id'],
    path,
    projectId: validId(o['projectId']) ? o['projectId'] : '',
    machineId: validId(o['machineId']) ? o['machineId'] : machineId,
    agentIds,
    firstSeen: n(o['firstSeen'], now),
    lastSeen: n(o['lastSeen'], now),
    acknowledged: b(o['acknowledged']),
  };
}

const ARTIFACT_KINDS = new Set<string>(['image', 'video', 'html', 'text', 'file']);

/**
 * Un artefacto entra por la misma puerta que todo lo demás.
 *
 * La `url` NO viene del collector: la pone el hub, porque el hub es quien lo
 * sirve y el collector no sabe con qué host lo va a mirar nadie. Dejar que la
 * declarara el productor sería dejar que un collector con un bug —o uno
 * hostil— pusiera un `javascript:` o un tercero en el `src` de la consola.
 */
export function sanitizeArtifact(raw: unknown, machineId: string): Artifact | null {
  const o = obj(raw);
  if (!o || !validId(o['id'])) return null;
  const p = s(o['path'], 1024);
  if (!p) return null;
  const k = o['kind'];
  const kind: ArtifactKind = typeof k === 'string' && ARTIFACT_KINDS.has(k)
    ? k as ArtifactKind : 'file';
  const place = obj(o['placement']);
  return {
    id: o['id'],
    agentId: validId(o['agentId']) ? o['agentId'] : '',
    projectId: validId(o['projectId']) ? o['projectId'] : '',
    machineId,
    kind,
    path: p,
    title: s(o['title'], 200) || p.split('/').pop() || p,
    url: `/api/artifact/${o['id']}`,
    bytes: Math.max(0, Math.round(n(o['bytes']))),
    width: nOrNull(o['width']),
    height: nOrNull(o['height']),
    at: n(o['at'], Date.now()),
    // `open` es una petición del agente, no un permiso: sobrevive el booleano
    // y nada más. Qué significa abrir algo lo decide la consola.
    open: b(o['open']),
    placement: place
      ? { x: n(place['x']), y: n(place['y']), z: n(place['z']) }
      : null,
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
  /**
   * Lápidas: agentes que alguien archivó y que el collector seguirá mandando
   * mientras su transcript exista. Un id de aquí no vuelve a entrar al mundo
   * salvo que llegue en un estado vivo — una sesión reanudada es un agente.
   */
  private archived = new Map<string, ArchivedAgent>();

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
        // Lo que no está en la flota tampoco cuenta en ella: las sesiones que
        // quedaron en el directorio de CAPCOM o en un scratchpad sumarían
        // decenas de agentes en el contador del HUD sin ser trabajo de nadie.
        if (!a || a.hidden === true) continue;
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
      case 'talk': return this.pushTalk(machineId, frame.agentId, frame.items);
      case 'talk:live': return this.setTalkLive(machineId, frame.agentId, frame.text);
      case 'escalation': return this.upsertEscalation(machineId, frame.escalation);
      case 'escalation:withdraw': return this.withdrawEscalation(machineId, frame.id, frame.reason);
      // El ruteo no vive aquí: el mundo guarda el mensaje y emite el evento;
      // quien sabe qué máquina tiene cada destinatario es server.ts.
      case 'message': { this.upsertMessage(machineId, frame.message); return; }
      case 'artifact': { this.upsertArtifact(machineId, frame.artifact); return; }
      case 'artifact:gone': return this.removeArtifact(machineId, frame.id);
      case 'collision': { this.upsertCollision(machineId, frame.collision); return; }
      case 'collision:clear': return this.clearCollision(machineId, frame.id);
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
    if (closed.length > 0) {
      closed.sort((a, b) => (b.answeredAt ?? b.askedAt) - (a.answeredAt ?? a.askedAt));
      for (let i = 0; i < closed.length; i++) {
        const e = closed[i]!;
        const when = e.answeredAt ?? e.askedAt;
        if (now - when <= ESCALATION_RETENTION_MS && i < MAX_CLOSED_ESCALATIONS) continue;
        delete this.state.escalations[e.id];
        this.emit({ o: 'escalation', id: e.id, v: null });
      }
    }

    this.evictMessages(now);
    this.evictCollisions();
    this.evictArtifacts(now);
  }

  /**
   * Desaloja tráfico gastado. La regla dura: un `ask` sin responder no entra
   * nunca en la lista de candidatos, ni por edad ni por techo, porque hay un
   * agente parado detrás. Todo lo demás —notices leídos, handoffs viejos, asks
   * ya contestados— se va a la hora, y si aun así se pasa el techo, se tira lo
   * menos reciente.
   */
  private evictMessages(now: number): void {
    const all = Object.values(this.state.messages);
    if (all.length === 0) return;

    const waiting = all.filter((m) => m.kind === 'ask' && m.answer === null);
    const droppable = all.filter((m) => !(m.kind === 'ask' && m.answer === null));
    // Los que no se pueden tirar ocupan sitio igual: el techo de los demás es
    // lo que queda después de ellos.
    const room = Math.max(0, MAX_MESSAGES - waiting.length);

    // Más nuevos primero: lo que se tira es siempre la cola.
    droppable.sort((a, b) => (b.answeredAt ?? b.at) - (a.answeredAt ?? a.at));
    for (let i = 0; i < droppable.length; i++) {
      const m = droppable[i]!;
      const when = m.answeredAt ?? m.at;
      const tooOld = now - when > MESSAGE_RETENTION_MS;
      const expired = m.expiresAt !== null && m.expiresAt < now;
      const overCap = i >= room;
      if (!tooOld && !expired && !overCap) continue;
      delete this.state.messages[m.id];
      this.emit({ o: 'message', id: m.id, v: null });
    }

    if (waiting.length > MAX_MESSAGES) {
      this.log(
        `${waiting.length} preguntas entre agentes sin responder (techo ${MAX_MESSAGES}). ` +
        'No se desaloja ninguna: cada una tiene un agente parado detrás. ' +
        'Esto significa que nadie está contestando, no que sobren mensajes.',
      );
    }
  }

  /**
   * Desaloja artefactos por edad y por techo. Ver ARTIFACT_RETENTION_MS: lo
   * reciente se queda, y cuando aun así sobran, se va lo más viejo. Nada de esto
   * borra el archivo del disco del agente; sólo deja de estar en la consola.
   */
  private evictArtifacts(now: number): void {
    const all = Object.values(this.state.artifacts);
    if (all.length === 0) return;
    // Más nuevos primero: lo que se tira es siempre la cola.
    all.sort((a, x) => x.at - a.at);
    for (let i = 0; i < all.length; i++) {
      const a = all[i]!;
      if (now - a.at <= ARTIFACT_RETENTION_MS && i < MAX_ARTIFACTS) continue;
      this.dropArtifact(a.id);
    }
  }

  private dropArtifact(id: string): void {
    if (!this.state.artifacts[id]) return;
    delete this.state.artifacts[id];
    this.emit({ o: 'artifact', id, v: null });
    this.hooks.onArtifactGone?.(id);
  }

  /**
   * Techo de colisiones. En condiciones normales las cierra el collector con
   * `collision:clear`; esto sólo actúa si ese clear no llega nunca. Se tiran
   * antes las ya reconocidas —alguien ya las vio— y después las más viejas.
   */
  private evictCollisions(): void {
    const list = Object.values(this.state.collisions);
    if (list.length <= MAX_COLLISIONS) return;
    list.sort((a, b) =>
      (Number(b.acknowledged) - Number(a.acknowledged)) || (a.lastSeen - b.lastSeen));
    const excess = list.length - MAX_COLLISIONS;
    for (let i = 0; i < excess; i++) {
      const c = list[i]!;
      delete this.state.collisions[c.id];
      this.emit({ o: 'collision', id: c.id, v: null });
    }
    this.log(
      `techo de colisiones superado (${list.length}); descartadas ${excess}. ` +
      'Casi siempre significa un collector que abre colisiones y no las cierra.',
    );
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
    this.dropTrafficFor(id);
    this.unindexAgent(id);
    delete this.state.agents[id];
    this.emit({ o: 'agent', id, v: null });
  }

  /**
   * Al desalojar un agente, su correo se va con él — igual que su linaje.
   *
   * Un mensaje suyo no lo puede contestar nadie ya, y uno dirigido a él no lo
   * va a leer nadie: dejarlos sería tráfico que apunta a un hueco. Ojo con el
   * orden: esto se llama ANTES de borrar el agente, así que un `ask` sin
   * responder de un agente que se va no bloquea a nadie y sí se puede tirar.
   */
  private dropTrafficFor(id: string): void {
    for (const m of Object.values(this.state.messages)) {
      if (m.fromAgentId === id || (m.scope === 'agent' && m.toAgentId === id)) {
        delete this.state.messages[m.id];
        this.emit({ o: 'message', id: m.id, v: null });
        continue;
      }
      if (!m.readBy.includes(id)) continue;
      m.readBy = m.readBy.filter((x) => x !== id);
      this.emit({ o: 'message', id: m.id, v: m });
    }
    for (const c of Object.values(this.state.collisions)) {
      if (!c.agentIds.includes(id)) continue;
      c.agentIds = c.agentIds.filter((x) => x !== id);
      // Un solo agente escribiendo un archivo es trabajo normal, no colisión.
      if (c.agentIds.length < 2) {
        delete this.state.collisions[c.id];
        this.emit({ o: 'collision', id: c.id, v: null });
        continue;
      }
      this.emit({ o: 'collision', id: c.id, v: c });
    }
  }

  /* ── archivo ─────────────────────────────────────────────────────── */

  /** Lápidas leídas del disco al arrancar. Van antes del primer snapshot. */
  hydrateArchived(entries: ArchivedAgent[]): void {
    for (const e of entries) this.archived.set(e.id, e);
    this.capArchived();
  }

  isArchived(id: string): boolean { return this.archived.has(id); }

  /** Las lápidas vigentes, la más reciente al final. */
  archivedAgents(): ArchivedAgent[] {
    return [...this.archived.values()].sort((a, b) => a.archivedAt - b.archivedAt);
  }

  /**
   * Archivar lo terminado que cumpla el filtro.
   *
   * El registro sale del mundo como en un desalojo por retención —hijos
   * desenganchados del padre, correo retirado, op `agent:null` a la consola— y
   * además queda la lápida, que es lo que distingue "archivado" de "desalojado":
   * al desalojado el siguiente snapshot lo trae de vuelta; al archivado no.
   *
   * `dryRun` responde exactamente lo mismo sin tocar nada: la misma función
   * decide en los dos casos, así que lo que se anunció es lo que se archiva.
   */
  archiveAgents(filter: ArchiveFilter = {}, opts: { dryRun?: boolean; by?: string } = {}): ArchiveOutcome {
    const now = this.now();
    const plan = archiveCandidates(this.state.agents, filter, now);
    const by = archiveBy(opts.by, 'hub');
    const archived = plan.archive.map((a) => tombstone(a, by, now));
    const outcome: ArchiveOutcome = {
      dryRun: opts.dryRun === true, archived, kept: plan.kept, squadsRetired: plan.squadsRetired,
    };
    if (outcome.dryRun || archived.length === 0) return outcome;

    const projects = new Set<string>();
    for (const t of archived) {
      this.archived.set(t.id, t);
      if (this.state.talk) delete this.state.talk[t.id];
      if (this.state.talkLive) delete this.state.talkLive[t.id];
      this.dropAgent(t.id);
      projects.add(t.projectId);
      this.event({
        at: now, kind: 'agent:archived', machineId: t.machineId, agentId: t.id, projectId: t.projectId,
        text: `${t.callsign} (${t.state}) archivado por ${by}`,
        data: { squad: t.squad, finishedAt: t.finishedAt, by },
      });
    }
    for (const pid of projects) this.syncProjectSessions(pid);
    if (plan.squadsRetired.length) {
      this.event({
        at: now, kind: 'squad:retired', text: plan.squadsRetired.join(', '),
        data: { squads: plan.squadsRetired, by },
      });
    }
    this.capArchived();
    this.hooks.onArchived?.(archived);
    this.settle();
    this.flushOut();
    return outcome;
  }

  /**
   * ¿Este agente que llega está archivado? Terminado: se rechaza y no entra.
   * Vivo: alguien reanudó la sesión, la lápida se levanta y el agente entra
   * como cualquier otro. Devuelve true cuando hay que ignorarlo.
   */
  private refuseArchived(a: Agent, machineId: string): boolean {
    if (!this.archived.has(a.id)) return false;
    if (TERMINAL_STATES.has(a.state)) return true;
    this.unarchive(a.id, machineId, 'resumed', false);
    return false;
  }

  private unarchive(id: string, machineId: string, why: string, resync: boolean): void {
    const tomb = this.archived.get(id);
    if (!tomb) return;
    this.archived.delete(id);
    const at = this.now();
    this.hooks.onUnarchived?.(id, at);
    this.event({
      at, kind: 'agent:unarchived', machineId, agentId: id, projectId: tomb.projectId,
      text: why, data: { resync, callsign: tomb.callsign },
    });
  }

  /** Las lápidas más viejas se caen primero; el archivo en disco las conserva. */
  private capArchived(): void {
    if (this.archived.size <= MAX_ARCHIVED) return;
    const excess = [...this.archived.values()]
      .sort((a, b) => a.archivedAt - b.archivedAt)
      .slice(0, this.archived.size - MAX_ARCHIVED);
    for (const t of excess) this.archived.delete(t.id);
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
      if (this.refuseArchived(a, machineId)) continue;
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
    if (this.refuseArchived(a, machineId)) return;
    a.machineId = machineId;
    this.state.agents[a.id] = a;
    this.indexAgent(a);
    this.linkParent(a);
    this.syncProjectSessions(a.projectId);
    this.emit({ o: 'agent', id: a.id, v: a });
    this.event({
      at: this.now(), kind: 'agent:new', machineId, agentId: a.id, projectId: a.projectId,
      text: a.title,
      data: {
        parentId: a.parentId, depth: a.depth, mission: a.mission,
        squad: a.squad, lead: a.lead,
      },
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
      if (this.archived.has(id)) {
        // Un archivado que cambia: si vuelve a un estado vivo es que alguien
        // reanudó la sesión. Un patch no trae el registro entero, así que se
        // levanta la lápida y se pide el snapshot que sí lo trae.
        const patch = sanitizeAgentPatch(rawPatch);
        if (patch.state && !TERMINAL_STATES.has(patch.state)) this.unarchive(id, machineId, 'resumed', true);
        return;
      }
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
        // `from`/`to` sueltos además del texto: la línea de tiempo (history.ts)
        // dispara una instantánea inmediata al cruzar a blocked/dead, y no debe
        // tener que parsear una frase para saberlo.
        text: `${before} → ${a.state}`, data: { block: a.block, from: before, to: a.state },
      });
    }
    this.emit({ o: 'agent:patch', id: a.id, v: { ...patch, updatedAt: a.updatedAt, metrics: a.metrics } });
  }

  private removeAgent(machineId: string, id: unknown): void {
    if (!validId(id)) throw new Error('agent id inválido');
    const a = this.state.agents[id];
    if (!a || a.machineId !== machineId) return;
    // La sesión ya no existe en disco: su correo tampoco lleva a ninguna parte.
    this.dropTrafficFor(id);
    delete this.state.agents[id];
    if (this.state.talk) delete this.state.talk[id];
    if (this.state.talkLive) delete this.state.talkLive[id];
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

  /* ── charla ─────────────────────────────────────────────────────── */

  /**
   * Bloques de la conversación de un agente (hoy sólo CAPCOM). Se apilan por
   * agente, deduplicados por id —un collector que reconecta relee la cola del
   * transcript y vuelve a mandar lo mismo— y acotados a MAX_TALK. No se
   * persisten: el transcript en disco ya es la copia de verdad, y el collector
   * la reproduce al arrancar.
   */
  pushTalk(machineId: string, agentId: unknown, rawItems: unknown): void {
    if (!validId(agentId) || !Array.isArray(rawItems) || rawItems.length === 0) return;
    const a = this.state.agents[agentId];
    if (!a) return;                     // charla de un id que no conocemos: la próxima llegará con el agente
    if (a.machineId !== machineId) throw new Error('máquina ajena');
    const talk = (this.state.talk ??= {});
    const list = talk[agentId] ?? [];
    const seen = new Set(list.map((t) => t.id));
    const items: TalkItem[] = [];
    for (const raw of rawItems.slice(0, MAX_TALK)) {
      const item = sanitizeTalkItem(raw, agentId);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    if (items.length === 0) return;
    // Orden por tiempo, misma regla que la consola (shared/talk.ts): una
    // reposición tras reiniciar el hub trae bloques de ayer después de los de hoy.
    talk[agentId] = mergeTalk(list, items);
    this.emit({ o: 'talk', id: agentId, v: items });
  }

  /** Lo que CAPCOM está escribiendo ahora; null cuando paró. No se persiste. */
  setTalkLive(machineId: string, agentId: unknown, raw: unknown): void {
    if (!validId(agentId)) return;
    const a = this.state.agents[agentId];
    if (!a) return;
    if (a.machineId !== machineId) throw new Error('máquina ajena');
    const text = typeof raw === 'string' ? redact(raw.length > MAX_TALK_TEXT ? raw.slice(0, MAX_TALK_TEXT) : raw) : null;
    const live = (this.state.talkLive ??= {});
    if ((live[agentId] ?? null) === text) return;
    if (text === null) delete live[agentId]; else live[agentId] = text;
    this.emit({ o: 'talk:live', id: agentId, v: text });
  }

  /* ── escalaciones ───────────────────────────────────────────────── */

  private upsertEscalation(machineId: string, raw: unknown): void {
    const e = sanitizeEscalation(raw, machineId);
    if (!e) throw new Error('escalation inválida');
    e.machineId = machineId;
    const prev = this.state.escalations[e.id];
    // Una escalación ya respondida no vuelve a 'pending' por un frame tardío.
    if (prev && (prev.status === 'answered' || (prev.permission && ['withdrawn', 'expired'].includes(prev.status))) && e.status !== prev.status) return;
    if (prev?.permission?.phase === 'pending' && e.permission?.phase === 'requested') e.permission.phase = 'pending';
    if (e.permission && !prev) {
      for (const older of Object.values(this.state.escalations)) {
        if (older.id !== e.id && older.machineId === machineId && older.agentId === e.agentId && older.permission && ['pending', 'with_ceo'].includes(older.status)) {
          older.status = 'withdrawn';
          this.emit({ o: 'escalation', id: older.id, v: older });
        }
      }
    }
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

  requestPermissionAnswer(id: string): void {
    const e = this.state.escalations[id];
    if (!e?.permission) return;
    e.permission.phase = 'pending';
    this.emit({ o: 'escalation', id, v: e });
    this.flushOut();
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

  /* ── tráfico entre agentes ──────────────────────────────────────── */

  /**
   * Entra un mensaje de un collector.
   *
   * El mundo lo guarda y emite el evento; el ruteo pasa en server.ts, que es el
   * único que ve las dos máquinas. Devuelve el mensaje ya saneado para que quien
   * lo aplicó pueda entregarlo sin volver a leer el estado.
   */
  upsertMessage(machineId: string, raw: unknown): AgentMessage {
    const m = sanitizeMessage(raw, machineId);
    if (!m) throw new Error('message inválido');
    // Un collector habla por sus propios agentes y por ninguno más. Si dice ser
    // otro, o es un bug o es un frame forjado; en los dos casos no entra.
    const from = this.state.agents[m.fromAgentId];
    if (from && from.machineId !== machineId) throw new Error('mensaje de un agente de otra máquina');

    const prev = this.state.messages[m.id];
    // Un frame tardío no deshace una respuesta ya dada, igual que con las
    // escalaciones: quien preguntó ya siguió trabajando.
    if (prev && prev.answer !== null && m.answer === null) return prev;
    if (prev) {
      const seen = new Set([...prev.readBy, ...m.readBy]);
      m.readBy = [...seen].slice(-MAX_READ_BY);
    }
    this.state.messages[m.id] = m;
    this.emit({ o: 'message', id: m.id, v: m });
    if (!prev) {
      this.event({
        at: this.now(), kind: 'message:new', machineId, agentId: m.fromAgentId,
        projectId: m.fromProjectId, text: m.subject,
        data: { id: m.id, kind: m.kind, scope: m.scope, to: m.toAgentId ?? m.toProjectId ?? m.toSquad },
      });
    }
    return m;
  }

  /**
   * Un mensaje nacido dentro del hub: lo manda el CEO, no un collector.
   *
   * Pasa por el mismo sanitizador aunque venga de casa — el texto lo escribió
   * un modelo, y un modelo puede repetir un secreto que leyó en un transcript.
   * El evento lleva otra clase (`message:relay`) a propósito: el ruteo de los
   * mensajes de collector cuelga de `message:new`, y reutilizarla haría que el
   * relay se enrutara dos veces.
   */
  upsertMessageLocal(raw: AgentMessage): AgentMessage {
    const m = sanitizeMessage(raw, '');
    if (!m) throw new Error('mensaje del CEO inválido');
    this.state.messages[m.id] = m;
    this.emit({ o: 'message', id: m.id, v: m });
    this.event({
      at: this.now(), kind: 'message:relay', agentId: m.fromAgentId, projectId: m.fromProjectId,
      text: m.subject, data: { kind: m.kind, scope: m.scope, to: m.toAgentId ?? m.toProjectId ?? m.toSquad },
    });
    this.flushOut();
    return m;
  }

  /**
   * Marca a quién se le entregó. Es lo que hace que un mensaje envejezca: uno
   * que nadie ha leído todavía no ha hecho su trabajo.
   */
  markDelivered(id: string, agentIds: string[]): void {
    const m = this.state.messages[id];
    if (!m) return;
    const seen = new Set(m.readBy);
    let added = false;
    for (const a of agentIds) {
      if (!validId(a) || seen.has(a)) continue;
      seen.add(a);
      added = true;
    }
    if (!added) return;
    m.readBy = [...seen].slice(-MAX_READ_BY);
    this.emit({ o: 'message', id, v: m });
    this.flushOut();
  }

  /**
   * Se contesta un `ask`. Esto es lo único que desbloquea a quien preguntó, así
   * que la respuesta y el desbloqueo van juntos y en la misma mutación lógica:
   * un mensaje contestado con el agente todavía en `blocked` sería un agente
   * parado sin nada que lo explique.
   *
   * `by` es quien contesta: otro agente, o 'ceo'.
   */
  answerMessage(id: string, answer: string, by: string | null): AgentMessage | null {
    const m = this.state.messages[id];
    if (!m) return null;
    m.answer = redact(answer.slice(0, MAX_BODY));
    m.answeredAt = this.now();
    m.answeredBy = by !== null && validId(by) ? by : null;
    this.emit({ o: 'message', id, v: m });

    const a = this.state.agents[m.fromAgentId];
    if (a && a.state === 'blocked' && a.block?.kind === 'peer' && a.block.messageId === id) {
      a.block = null;
      a.state = 'working';
      a.updatedAt = this.now();
      this.touchAgentBucket(a.id);
      this.emit({ o: 'agent:patch', id: a.id, v: { block: null, state: 'working', updatedAt: a.updatedAt } });
    }
    this.event({
      at: this.now(), kind: 'message:answered', agentId: m.fromAgentId, projectId: m.fromProjectId,
      text: m.subject, data: { id: m.id, by: m.answeredBy, answer: m.answer },
    });
    this.flushOut();
    return m;
  }

  /* ── colisiones ─────────────────────────────────────────────────── */

  upsertCollision(machineId: string, raw: unknown): Collision {
    const c = sanitizeCollision(raw, machineId);
    if (!c) throw new Error('collision inválida');
    c.machineId = machineId;
    const prev = this.state.collisions[c.id];
    // Reconocer es una decisión de una persona (o del CEO). Un frame nuevo del
    // collector no la deshace, o la misma alarma volvería cada dos segundos.
    if (prev?.acknowledged) c.acknowledged = true;
    this.state.collisions[c.id] = c;
    this.emit({ o: 'collision', id: c.id, v: c });
    if (!prev) {
      this.event({
        at: this.now(), kind: 'collision:new', machineId, projectId: c.projectId,
        text: c.path, data: { id: c.id, agentIds: c.agentIds },
      });
    }
    return c;
  }

  /**
   * El collector dice que dejaron de pisarse. `machineId` en null significa que
   * lo cierra el hub, no una máquina.
   */
  clearCollision(machineId: string | null, id: unknown): void {
    if (!validId(id)) return;
    const c = this.state.collisions[id];
    if (!c) return;
    if (machineId !== null && c.machineId !== machineId) return;
    delete this.state.collisions[id];
    this.emit({ o: 'collision', id, v: null });
  }

  /** Alguien la vio. Se queda en el mundo, pero deja de gritar. */
  ackCollision(id: string): Collision | null {
    const c = this.state.collisions[id];
    if (!c) return null;
    if (c.acknowledged) return c;
    c.acknowledged = true;
    this.emit({ o: 'collision', id, v: c });
    this.flushOut();
    return c;
  }

  /* ── artefactos ─────────────────────────────────────────────────── */

  /**
   * Upsert por id. Reescribir un archivo produce el mismo id, así que la
   * segunda versión de una gráfica sustituye a la primera EN EL SITIO donde el
   * operador la había dejado puesta: por eso la colocación sobrevive al cambio.
   */
  upsertArtifact(machineId: string, raw: unknown): Artifact {
    const a = sanitizeArtifact(raw, machineId);
    if (!a) throw new Error('artifact inválido');
    const prev = this.state.artifacts[a.id];
    if (prev) {
      // La colocación la decidió una persona; un frame nuevo del collector no
      // la deshace.
      if (prev.machineId !== machineId) throw new Error('artefacto de otra máquina');
      a.placement = prev.placement ?? a.placement;
    }
    this.state.artifacts[a.id] = a;
    this.emit({ o: 'artifact', id: a.id, v: a });
    if (!prev) {
      this.event({
        at: this.now(), kind: 'artifact:new', machineId, projectId: a.projectId,
        agentId: a.agentId, text: a.title, data: { id: a.id, kind: a.kind, bytes: a.bytes },
      });
    }
    this.flushOut();
    return a;
  }

  /** El collector dice que ya no está: se fue del disco o cayó de su techo. */
  removeArtifact(machineId: string | null, id: unknown): void {
    if (!validId(id)) return;
    const a = this.state.artifacts[id];
    if (!a) return;
    if (machineId !== null && a.machineId !== machineId) return;
    this.dropArtifact(id);
    this.flushOut();
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

  setCapcomHandoffs(events: import('../shared/handoff.ts').CapcomHandoff[]): void {
    this.state.capcomHandoffs = events;
    this.emit({ o: 'capcom:handoffs', v: events });
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
      archived: this.archived.size,
      blocked: this.state.fleet.blocked,
      costUSD: Number(this.state.fleet.costUSD.toFixed(4)),
      tokensPerSec: Number(this.state.fleet.tokensPerSec.toFixed(1)),
      escalations: {
        total: Object.keys(this.state.escalations).length,
        pending: Object.values(this.state.escalations).filter((e) => e.status === 'pending' || e.status === 'with_ceo').length,
      },
      messages: {
        total: Object.keys(this.state.messages).length,
        // Preguntas entre agentes sin contestar: cada una es un agente parado.
        waiting: Object.values(this.state.messages)
          .filter((m) => m.kind === 'ask' && m.answer === null).length,
      },
      collisions: {
        total: Object.keys(this.state.collisions).length,
        unacknowledged: Object.values(this.state.collisions).filter((c) => !c.acknowledged).length,
      },
      artifacts: Object.keys(this.state.artifacts).length,
      keys: Object.keys(this.state.keys).length,
      feed: this.state.feed.length,
      ceoMessages: this.state.ceo.messages.length,
      frames: { applied: this.stats.framesApplied, rejected: this.stats.framesRejected },
      security: { keysRejected: this.stats.keysRejected, redactions: redactionCount() },
    };
  }
}
