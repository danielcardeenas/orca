/**
 * La máquina de estados: de líneas de transcript a `Agent`.
 *
 * Un transcript es un log de append, no un estado. Este módulo lo colapsa a las
 * siete cajas de `AgentState` que la consola sabe dibujar. Las reglas están
 * escritas contra lo que Claude Code 2.1.260 escribe de verdad en disco, no
 * contra lo que sería elegante que escribiera.
 *
 * Tres entradas se combinan aquí:
 *   1. las líneas del .jsonl  (lo que el agente hizo)
 *   2. la liveness del proceso (`claude agents --json`) — un archivo quieto de
 *      un proceso vivo es "pensando"; de un proceso muerto es "terminado"
 *   3. señales de bloqueo externas: escalaciones ORCA y ~/.claude/jobs/<id>/state.json
 */

import type { Agent, AgentMetrics, AgentState, BlockKind } from '../shared/types.ts';
import type { LineBatch, TranscriptRef } from './watch.ts';
import { isRecord, num, oneLine, stableCallsign, str, tsMs } from './util.ts';

/* ── umbrales ─────────────────────────────────────────────────────── */

/** Un tool_use sin resultado más allá de esto huele a prompt de permisos. */
export const PERMISSION_SUSPECT_MS = 90_000;
/** Sin bytes nuevos y sin proceso más allá de esto: la sesión terminó. */
export const REAP_AFTER_MS = 60_000;
/** Ventana de la media móvil de tokens/s. */
export const TPS_WINDOW_MS = 30_000;

/** Modos en los que Claude Code no pregunta antes de correr una tool. */
const PERMISSIVE_MODES = new Set(['auto', 'acceptEdits', 'bypassPermissions', 'plan']);

/** Tools que en modo manual sí abren un prompt de permisos. */
const GATED_TOOLS = new Set([
  'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'Task', 'MultiEdit',
]);

/**
 * Tools cuya única semántica es "le estoy preguntando al humano". Un tool_use
 * de estos sin resultado ES el bloqueo, sin esperar los 90s de sospecha: no hay
 * nada que el agente pueda hacer hasta que alguien conteste.
 */
const ASKING_TOOLS = new Set(['AskUserQuestion', 'SendUserMessage']);

/* ── señales externas ─────────────────────────────────────────────── */

export interface Liveness {
  alive: boolean;
  background: boolean;
  shortId: string | null;
  pid: number | null;
  /** `name` de `claude agents --json`; sirve de título cuando no hay ai-title. */
  name: string | null;
  startedAt: number | null;
  /** `state`/`status` que reporta el propio CLI. */
  cliState: string | null;
}

export interface BlockSignal {
  kind: BlockKind;
  summary: string;
  escalationId?: string;
  since: number;
}

export interface Lineage {
  parentId: string | null;
  depth: number;
  childIds: string[];
  mission: string | null;
}

/* ── el deriver ───────────────────────────────────────────────────── */

interface PendingTool {
  id: string;
  name: string;
  detail: string;
  at: number;
}

interface TokenSample { at: number; tokens: number; }

export class SessionDeriver {
  readonly id: string;
  readonly ref: TranscriptRef;
  readonly machineId: string;
  projectId: string;
  callsign: string;

  /* estado crudo acumulado */
  private title: string | null = null;
  private cliName: string | null = null;
  private lastPrompt: string | null = null;
  private lastSay: string | null = null;
  private model: string | null = null;
  private permissionMode: string | null = null;
  private mode: string | null = null;

  private sawAssistant = false;
  private lastStopReason: string | null = null;
  private lastAssistantAt = 0;
  private lastLineAt = 0;
  private lastMtimeMs = 0;
  private endedCleanly = false;
  private interrupted = false;

  private pending = new Map<string, PendingTool>();
  private lastTool: PendingTool | null = null;

  private firstSeenAt: number;
  private startedAt = 0;

  /** Totales del último cost-state, que es autoritativo para toda la sesión. */
  private costBase: Partial<AgentMetrics> = {};
  /** Lo acumulado por nosotros DESPUÉS de ese cost-state. */
  private since = zeroCounters();
  private toolCalls = 0;
  private turns = 0;
  private samples: TokenSample[] = [];
  private tpsSmooth = 0;
  private tpsAt = 0;

  private liveness: Liveness = {
    alive: false, background: false, shortId: null, pid: null,
    name: null, startedAt: null, cliState: null,
  };
  private block: BlockSignal | null = null;
  private lineage: Lineage = { parentId: null, depth: 0, childIds: [], mission: null };

  /** Sube en cada mutación observable; index.ts la usa para diffear barato. */
  rev = 0;

  constructor(ref: TranscriptRef, machineId: string, projectId: string, now = Date.now()) {
    this.ref = ref;
    this.id = ref.key;
    this.machineId = machineId;
    this.projectId = projectId;
    this.callsign = stableCallsign(ref.key);
    this.firstSeenAt = now;
  }

  /* ── entradas ─────────────────────────────────────────────────── */

  setLiveness(l: Liveness): void {
    const before = JSON.stringify(this.liveness);
    this.liveness = l;
    if (l.name && !this.cliName) this.cliName = l.name;
    if (l.startedAt && (!this.startedAt || l.startedAt < this.startedAt)) {
      this.startedAt = l.startedAt;
    }
    if (JSON.stringify(this.liveness) !== before) this.rev++;
  }

  setBlock(b: BlockSignal | null): void {
    const same = (this.block?.kind === b?.kind) && (this.block?.summary === b?.summary)
      && (this.block?.escalationId === b?.escalationId);
    this.block = b;
    if (!same) this.rev++;
  }

  setLineage(l: Lineage): void {
    const before = JSON.stringify(this.lineage);
    this.lineage = l;
    if (JSON.stringify(l) !== before) this.rev++;
  }

  setProject(projectId: string): void {
    if (this.projectId !== projectId) { this.projectId = projectId; this.rev++; }
  }

  setCallsign(cs: string): void {
    if (this.callsign !== cs) { this.callsign = cs; this.rev++; }
  }

  /** El cwd que el propio transcript declara — la fuente fiable del slug→ruta. */
  cwd: string | null = null;

  ingest(batch: LineBatch): void {
    this.lastMtimeMs = batch.mtimeMs;
    for (const line of batch.lines) this.line(line);
    this.rev++;
  }

  private line(l: Record<string, unknown>): void {
    const type = l['type'];
    if (typeof type !== 'string') return;
    const at = tsMs(l['timestamp'], 0);
    if (at > this.lastLineAt) this.lastLineAt = at;
    if (at > 0 && (this.startedAt === 0 || at < this.startedAt)) this.startedAt = at;
    const cwd = str(l['cwd']);
    if (cwd) this.cwd = cwd;

    switch (type) {
      case 'ai-title': {
        const t = str(l['aiTitle']);
        if (t) this.title = oneLine(t, 120);
        break;
      }
      case 'last-prompt': {
        const p = str(l['lastPrompt']);
        if (p) this.lastPrompt = oneLine(p, 240);
        break;
      }
      case 'cost-state':
        this.applyCostState(l);
        break;
      case 'permission-mode':
        this.permissionMode = str(l['permissionMode']);
        break;
      case 'mode':
        this.mode = str(l['mode']);
        break;
      case 'assistant':
        this.assistant(l, at);
        break;
      case 'user':
        this.user(l, at);
        break;
      case 'system':
        this.system(l);
        break;
      default:
        // attachment, bridge-session, atis-latch, queue-operation,
        // file-history-*: ruido para el modelo de estado de ORCA.
        break;
    }
  }

  private applyCostState(l: Record<string, unknown>): void {
    const usage = isRecord(l['modelUsage']) ? l['modelUsage'] : {};
    let input = 0, output = 0, cacheRead = 0, thinking = 0;
    for (const v of Object.values(usage)) {
      if (!isRecord(v)) continue;
      input += num(v['inputTokens']);
      output += num(v['outputTokens']);
      cacheRead += num(v['cacheReadInputTokens']);
      thinking += num(v['thinkingTokens']);
    }
    this.costBase = {
      costUSD: num(l['totalCostUSD']),
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      thinkingTokens: thinking,
      linesAdded: num(l['totalLinesAdded']),
      linesRemoved: num(l['totalLinesRemoved']),
      apiDurationMs: num(l['totalAPIDuration']),
      toolDurationMs: num(l['totalToolDuration']),
    };
    // El cost-state es un total absoluto: lo acumulado antes ya está dentro.
    this.since = zeroCounters();
    const start = num(l['startTime']);
    if (start > 0 && (this.startedAt === 0 || start < this.startedAt)) this.startedAt = start;
  }

  private assistant(l: Record<string, unknown>, at: number): void {
    const msg = isRecord(l['message']) ? l['message'] : null;
    if (!msg) return;
    this.sawAssistant = true;
    this.lastAssistantAt = at || Date.now();
    const model = str(msg['model']);
    if (model) this.model = model;

    const stop = msg['stop_reason'];
    this.lastStopReason = typeof stop === 'string' ? stop : null;
    if (this.lastStopReason === 'end_turn') this.endedCleanly = true;

    const usage = isRecord(msg['usage']) ? msg['usage'] : null;
    if (usage) {
      const out = num(usage['output_tokens']);
      this.since.inputTokens += num(usage['input_tokens']);
      this.since.outputTokens += out;
      this.since.cacheReadTokens += num(usage['cache_read_input_tokens']);
      const details = isRecord(usage['output_tokens_details']) ? usage['output_tokens_details'] : null;
      this.since.thinkingTokens += details ? num(details['thinking_tokens']) : 0;
      if (out > 0) this.samples.push({ at: this.lastAssistantAt, tokens: out });
    }

    const content = Array.isArray(msg['content']) ? msg['content'] : [];
    for (const raw of content) {
      if (!isRecord(raw)) continue;
      const bt = raw['type'];
      if (bt === 'text') {
        const t = str(raw['text']);
        if (t) this.lastSay = oneLine(t, 200);
      } else if (bt === 'tool_use') {
        const id = str(raw['id']);
        const name = str(raw['name']) ?? 'tool';
        const p: PendingTool = {
          id: id ?? `${name}:${this.lastAssistantAt}`,
          name,
          detail: toolDetail(name, raw['input']),
          at: this.lastAssistantAt,
        };
        this.pending.set(p.id, p);
        this.lastTool = p;
        this.toolCalls++;
      }
    }
    // Un turno que cierra no puede dejar tools colgando.
    if (this.lastStopReason === 'end_turn') this.pending.clear();
    this.trimSamples();
  }

  private user(l: Record<string, unknown>, _at: number): void {
    if (str(l['interruptedMessageId'])) this.interrupted = true;
    const msg = isRecord(l['message']) ? l['message'] : null;
    if (!msg) return;
    const content = msg['content'];
    if (typeof content === 'string') {
      // Prompt humano en texto plano: cuenta como turno.
      if (l['isMeta'] !== true) this.turns++;
      return;
    }
    if (!Array.isArray(content)) return;
    let sawToolResult = false;
    for (const raw of content) {
      if (!isRecord(raw)) continue;
      if (raw['type'] === 'tool_result') {
        sawToolResult = true;
        const tuid = str(raw['tool_use_id']);
        if (tuid) this.pending.delete(tuid);
      }
    }
    if (!sawToolResult && l['isMeta'] !== true) this.turns++;
  }

  private system(l: Record<string, unknown>): void {
    const sub = str(l['subtype']);
    if (sub === 'turn_duration') {
      // Claude Code cierra cada turno con esto: nada colgando.
      this.pending.clear();
    }
  }

  private trimSamples(): void {
    const cutoff = Date.now() - TPS_WINDOW_MS * 2;
    if (this.samples.length > 256 || (this.samples[0] && this.samples[0].at < cutoff)) {
      this.samples = this.samples.filter((s) => s.at >= cutoff).slice(-256);
    }
  }

  /* ── salida ───────────────────────────────────────────────────── */

  /**
   * tokens/s como media móvil de 30s, suavizada.
   *
   * El crudo salta de 0 a 600 entre dos mensajes; alimentar eso directo a la
   * escena 3D da un temblor epiléptico. Un EMA con constante de tiempo de ~2s
   * conserva la forma (una ráfaga larga se ve larga) y mata el ruido.
   */
  tokensPerSec(now = Date.now()): number {
    const from = now - TPS_WINDOW_MS;
    let sum = 0;
    let oldest = now;
    for (const s of this.samples) {
      if (s.at < from) continue;
      sum += s.tokens;
      if (s.at < oldest) oldest = s.at;
    }
    const spanSec = Math.max(5, Math.min(TPS_WINDOW_MS, now - oldest) / 1000);
    const raw = sum > 0 ? sum / spanSec : 0;
    const dt = this.tpsAt === 0 ? 1000 : Math.max(0, now - this.tpsAt);
    this.tpsAt = now;
    const alpha = 1 - Math.exp(-dt / 2000);
    this.tpsSmooth += (raw - this.tpsSmooth) * alpha;
    if (this.tpsSmooth < 0.05) this.tpsSmooth = 0;
    return Math.round(this.tpsSmooth * 100) / 100;
  }

  state(now = Date.now()): AgentState {
    if (this.block) return 'blocked';
    if (this.askingTool()) return 'blocked';

    const quietFor = now - Math.max(this.lastLineAt, this.lastMtimeMs, this.firstSeenAt);

    if (!this.liveness.alive) {
      // Sin proceso: sólo cuando el archivo también se quedó quieto declaramos
      // el final. Si no, es una carrera entre el poll del CLI y el del disco.
      if (quietFor > REAP_AFTER_MS) {
        if (this.endedCleanly && !this.interrupted) return 'done';
        return this.sawAssistant ? 'done' : 'dead';
      }
    }

    if (!this.sawAssistant) return 'booting';

    const stuck = this.stuckTool(now);
    if (stuck) return 'blocked';

    if (this.pending.size > 0) return 'working';
    if (this.lastStopReason === 'end_turn') return 'idle';
    if (this.lastStopReason === 'tool_use') return 'working';
    // stop_reason null o desconocido con assistant reciente: sigue hablando.
    return 'thinking';
  }

  /** El tool_use pendiente que es, literalmente, una pregunta al humano. */
  private askingTool(): PendingTool | null {
    for (const p of this.pending.values()) {
      if (ASKING_TOOLS.has(p.name)) return p;
    }
    return null;
  }

  /** El tool colgado que hace sospechar de un prompt de permisos, si lo hay. */
  private stuckTool(now: number): PendingTool | null {
    if (this.pending.size === 0) return null;
    if (this.permissionMode && PERMISSIVE_MODES.has(this.permissionMode)) return null;
    for (const p of this.pending.values()) {
      if (now - p.at < PERMISSION_SUSPECT_MS) continue;
      if (GATED_TOOLS.has(p.name)) return p;
    }
    return null;
  }

  blockOf(now = Date.now()): Agent['block'] {
    if (this.block) {
      const b: Agent['block'] = {
        kind: this.block.kind, summary: this.block.summary, since: this.block.since,
      };
      if (this.block.escalationId) b.escalationId = this.block.escalationId;
      return b;
    }
    const asking = this.askingTool();
    if (asking) {
      return {
        kind: 'question',
        summary: asking.detail || 'el agente está esperando una respuesta',
        since: asking.at,
      };
    }
    const stuck = this.stuckTool(now);
    if (stuck) {
      return {
        kind: 'permission',
        summary: `${stuck.name} esperando permiso: ${stuck.detail}`.trim(),
        since: stuck.at,
      };
    }
    return null;
  }

  metrics(now = Date.now()): AgentMetrics {
    const b = this.costBase;
    return {
      costUSD: round(num(b.costUSD) , 4),
      inputTokens: num(b.inputTokens) + this.since.inputTokens,
      outputTokens: num(b.outputTokens) + this.since.outputTokens,
      cacheReadTokens: num(b.cacheReadTokens) + this.since.cacheReadTokens,
      thinkingTokens: num(b.thinkingTokens) + this.since.thinkingTokens,
      tokensPerSec: this.tokensPerSec(now),
      linesAdded: num(b.linesAdded),
      linesRemoved: num(b.linesRemoved),
      toolCalls: this.toolCalls,
      toolDurationMs: num(b.toolDurationMs),
      apiDurationMs: num(b.apiDurationMs),
      turns: this.turns,
    };
  }

  snapshot(now = Date.now()): Agent {
    const state = this.state(now);
    const working = state === 'working';
    const startedAt = this.startedAt || this.firstSeenAt;
    return {
      id: this.id,
      machineId: this.machineId,
      projectId: this.projectId,
      title: this.title ?? this.cliName ?? this.lastPrompt ?? shortId(this.ref.sessionId),
      callsign: this.callsign,
      state,
      block: this.blockOf(now),
      parentId: this.lineage.parentId,
      depth: this.lineage.depth,
      childIds: [...this.lineage.childIds],
      mission: this.lineage.mission,
      model: this.model,
      tool: working ? (this.currentTool()?.name ?? null) : null,
      toolDetail: working ? (this.currentTool()?.detail ?? null) : null,
      lastPrompt: this.lastPrompt,
      lastSay: this.lastSay,
      startedAt,
      updatedAt: Math.max(this.lastLineAt, this.lastMtimeMs) || now,
      uptimeMs: Math.max(0, now - startedAt),
      metrics: this.metrics(now),
      background: this.liveness.background,
      shortId: this.liveness.shortId,
    };
  }

  private currentTool(): PendingTool | null {
    let newest: PendingTool | null = null;
    for (const p of this.pending.values()) {
      if (!newest || p.at > newest.at) newest = p;
    }
    return newest ?? this.lastTool;
  }

  /** Sólo para el resumen de diagnóstico y los tests. */
  debug(): Record<string, unknown> {
    return {
      id: this.id,
      title: this.title,
      permissionMode: this.permissionMode,
      mode: this.mode,
      pending: this.pending.size,
      stop: this.lastStopReason,
      samples: this.samples.length,
      alive: this.liveness.alive,
    };
  }
}

/* ── ayudas ───────────────────────────────────────────────────────── */

function zeroCounters() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 };
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Una línea que describa la tool en curso. Cada tool esconde su "qué" en un
 * campo distinto; el fallback es el primer string del input, que casi siempre
 * es lo que un humano querría leer.
 */
export function toolDetail(name: string, input: unknown): string {
  if (!isRecord(input)) return '';
  const pick = (k: string): string | null => {
    const v = input[k];
    return typeof v === 'string' && v ? v : null;
  };
  switch (name) {
    case 'Bash':
    case 'BashOutput':
      return oneLine(pick('command') ?? pick('description') ?? '', 160);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return oneLine(pick('file_path') ?? pick('notebook_path') ?? '', 160);
    case 'Task':
      return oneLine(pick('description') ?? pick('prompt') ?? '', 160);
    case 'Glob':
    case 'Grep':
      return oneLine(pick('pattern') ?? '', 160);
    case 'WebFetch':
    case 'WebSearch':
      return oneLine(pick('url') ?? pick('query') ?? '', 160);
    case 'Skill':
      return oneLine(pick('skill') ?? pick('command') ?? '', 160);
    case 'AskUserQuestion': {
      // {questions:[{question, header, multiSelect, options:[{label,description}]}]}
      const qs = input['questions'];
      if (Array.isArray(qs) && isRecord(qs[0])) {
        const q = qs[0];
        return oneLine(
          (typeof q['question'] === 'string' ? q['question'] : null)
          ?? (typeof q['header'] === 'string' ? q['header'] : '') ?? '', 200,
        );
      }
      return '';
    }
    case 'SendUserMessage':
      return oneLine(pick('message') ?? pick('text') ?? '', 200);
    default: {
      for (const k of ['description', 'command', 'file_path', 'path', 'query', 'prompt', 'name']) {
        const v = pick(k);
        if (v) return oneLine(v, 160);
      }
      for (const v of Object.values(input)) {
        if (typeof v === 'string' && v) return oneLine(v, 160);
      }
      return '';
    }
  }
}

/**
 * Reparte callsigns de dos caracteres sin colisiones DENTRO de un proyecto.
 * El hash es estable entre reinicios, así que el mismo conjunto de sesiones
 * produce siempre las mismas etiquetas; sólo un empate real desplaza a uno.
 */
export class CallsignBook {
  private taken = new Map<string, Map<string, string>>(); // projectId → callsign → agentId

  assign(projectId: string, agentId: string): string {
    let book = this.taken.get(projectId);
    if (!book) { book = new Map(); this.taken.set(projectId, book); }
    for (const [cs, owner] of book) if (owner === agentId) return cs;
    for (let bump = 0; bump < 64; bump++) {
      const cs = stableCallsign(agentId, bump);
      if (!book.has(cs)) { book.set(cs, agentId); return cs; }
    }
    const fallback = stableCallsign(agentId + ':' + book.size);
    book.set(fallback, agentId);
    return fallback;
  }

  release(projectId: string, agentId: string): void {
    const book = this.taken.get(projectId);
    if (!book) return;
    for (const [cs, owner] of book) if (owner === agentId) book.delete(cs);
  }
}
