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

import type { Agent, AgentMetrics, AgentRole, AgentState, BlockKind, TalkItem } from '../shared/types.ts';
import { CLAUDE_INTERRUPT_MARK } from '../shared/interrupt.ts';
import { MAX_TALK, MAX_TALK_RESULT, MAX_TALK_TEXT } from '../shared/types.ts';
import { ARTIFACT_TOOLS, kindOf } from './artifacts.ts';
import type { LineBatch, TranscriptRef } from './watch.ts';
import { isRecord, num, oneLine, stableCallsign, str, tsMs } from './util.ts';

/* ── umbrales ─────────────────────────────────────────────────────── */

/** Un tool_use sin resultado más allá de esto huele a prompt de permisos. */
export const PERMISSION_SUSPECT_MS = 90_000;
/** Sin bytes nuevos y sin proceso más allá de esto: la sesión terminó. */
export const REAP_AFTER_MS = 60_000;
/** Ventana de la media móvil de tokens/s. */
export const TPS_WINDOW_MS = 30_000;
/** Un prompt sin respuesta cuenta como "pensando" hasta esto; después, idle. */
export const PROMPT_THINKING_MS = 10 * 60_000;

/** Modos en los que Claude Code NUNCA abre un prompt de permisos. */
const PERMISSIVE_MODES = new Set(['auto', 'bypassPermissions', 'dontAsk']);

/** Tools que en modo manual sí abren un prompt de permisos. */
const GATED_TOOLS = new Set([
  'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'Task', 'MultiEdit',
]);

/**
 * Lo que `acceptEdits` (y `plan`) aprueban solos: ediciones de archivos. Un
 * `Bash` en acceptEdits SÍ pregunta. Tratar acceptEdits como "no pregunta
 * nunca" fue lo que dejó a un agente hospedado en `working` con un "Do you
 * want to proceed?" en pantalla y a nadie avisado — medido en ping-pong-papas.
 */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** Las tools que en este modo pueden quedarse esperando a un humano. */
export function gatedIn(mode: string | null): ReadonlySet<string> {
  if (mode && PERMISSIVE_MODES.has(mode)) return new Set();
  if (mode === 'acceptEdits' || mode === 'plan') {
    return new Set([...GATED_TOOLS].filter((t) => !EDIT_TOOLS.has(t)));
  }
  return GATED_TOOLS;
}

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
  /** La sesión vive en un pane de tmux de ORCA: se puede abrir una TERMINAL. */
  pane: boolean;
}

export interface BlockSignal {
  kind: BlockKind;
  summary: string;
  escalationId?: string;
  /** Sólo con kind 'peer': el mensaje sin responder que lo tiene parado. */
  messageId?: string;
  /** Sólo con kind 'peer': quién debe la respuesta. */
  waitingOn?: string;
  since: number;
}

export interface Lineage {
  origin?: 'orca' | 'external';
  parentId: string | null;
  depth: number;
  childIds: string[];
  mission: string | null;
  /** Escuadrón al que lo alistó el spawn. Ver src/shared/squads.ts. */
  squad: string | null;
  /** Si lo lidera. Sin `squad` no significa nada. */
  lead: boolean;
  /** El worktree donde lo lanzó el spawn y su rama, si corre en uno. Ver worktrees.ts. */
  worktree?: string | null;
  branch?: string | null;
  /**
   * 'capcom' cuando esta sesión es el mando de la flota, 'agent' para todo lo
   * demás. Viaja por el mismo camino que `mission`: lo dijo quien la lanzó y se
   * persistió en lineage.json, porque no hay nada en el transcript que permita
   * distinguir al comando de un agente que habla de la flota.
   */
  role: AgentRole;
}

/* ── el deriver ───────────────────────────────────────────────────── */

interface PendingTool {
  id: string;
  name: string;
  detail: string;
  at: number;
}

interface TokenSample { at: number; tokens: number; }

/** Un archivo que el agente escribió y que quizá haya que enseñar. */
export interface ProducedFile { path: string; at: number; }

/**
 * Cuántas rutas producidas se guardan sin recoger.
 *
 * index.ts las drena en cada tick, así que en marcha esto nunca pasa de dos o
 * tres. El techo es para la lectura de cola al arrancar: un transcript de un
 * agente que generó mil fotogramas no puede materializarse entero aquí dentro.
 */
const MAX_PRODUCED = 64;
/**
 * Ids de mensaje recordados para no sumar dos veces su `usage`. Las líneas de
 * un mismo mensaje llegan seguidas, así que basta con los últimos; esto sólo
 * impide que una sesión de días crezca sin techo.
 */
const MAX_COUNTED_IDS = 4_096;

/**
 * What the collector needs from a session, whichever CLI wrote it. Claude's
 * `SessionDeriver` is the reference implementation; `CodexDeriver` (codex.ts)
 * is the second. index.ts only ever talks to this.
 */
export type Deriver = Pick<SessionDeriver,
  | 'id' | 'ref' | 'machineId' | 'projectId' | 'callsign' | 'cwd' | 'firstSeenAt' | 'rev'
  | 'setLiveness' | 'setBlock' | 'setLineage' | 'setProject' | 'setCallsign'
  | 'ingest' | 'drainProduced' | 'drainTalk' | 'state' | 'blockOf' | 'metrics' | 'snapshot' | 'debug'
  | 'gatedPending' | 'interruptedMarkAt'>
  & { readonly runtime: string };

export class SessionDeriver {
  readonly runtime = 'claude';
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
  /** Cuándo llegó el último prompt humano (no meta, no tool_result). */
  private lastPromptAt = 0;
  private lastLineAt = 0;
  /**
   * The last line that was the conversation — a prompt, a reply, a tool
   * result. An idle session keeps appending housekeeping (bridge-session,
   * atis-latch, system) every half hour, so the file's mtime says "touched",
   * not "used". This is what `updatedAt` reports, and what the console uses
   * to tell a working session from a tab left open.
   */
  private lastActivityAt = 0;
  private lastMtimeMs = 0;
  private endedCleanly = false;
  private interrupted = false;
  /**
   * Cuándo escribió el CLI que el humano cortó el turno. 0 = nunca.
   *
   * `[Request interrupted by user]` es una línea `user` que el propio Claude
   * Code añade al pulsar Esc; no la escribe nadie más y no es texto del
   * humano. Es el ÚNICO acuse de que una interrupción llegó, así que se guarda
   * con su hora: quien la pidió compara contra el momento en que la mandó.
   */
  private interruptedAt = 0;

  private pending = new Map<string, PendingTool>();
  private lastTool: PendingTool | null = null;
  private produced: ProducedFile[] = [];
  /**
   * La conversación, bloque a bloque, esperando a que index.ts la drene.
   * Acotada: un deriver que nadie drena (todo agente que no es CAPCOM) se
   * queda con los últimos MAX_TALK y no crece más.
   */
  private talk: TalkItem[] = [];

  /**
   * Cuándo vio ORCA este transcript por primera vez. Público porque el ack de
   * un `spawn` sin short id necesita saber qué sesión es NUEVA.
   */
  readonly firstSeenAt: number;
  private startedAt = 0;

  /** Totales del último cost-state, que es autoritativo para toda la sesión. */
  private costBase: Partial<AgentMetrics> = {};
  /** Lo acumulado por nosotros DESPUÉS de ese cost-state. */
  private since = zeroCounters();
  /**
   * Los mensajes cuyo `usage` ya se sumó.
   *
   * Claude Code escribe UNA línea por bloque de contenido (thinking, texto,
   * cada tool_use) y todas llevan el mismo `message.id` y el mismo `usage`
   * completo. Sumar por línea contaba un mensaje dos, tres o cuatro veces:
   * medido en la revisión AJ (2026-09-11), 451.269 tokens por línea contra
   * 230.615 por mensaje, que es lo que dijo después el cost-state. De ahí los
   * «saltos» de la cifra viva que documenta `REVIEWER_BUDGET_TOKENS`.
   *
   * No se vacía con un cost-state: una línea que llegue después de él con un
   * id ya sumado sigue siendo el mismo mensaje, y ya está dentro del total.
   */
  private counted = new Set<string>();
  private toolCalls = 0;
  private turns = 0;
  /**
   * Compactaciones vistas en el transcript. El CLI escribe un `system` con
   * `subtype: 'compact_boundary'` y, detrás, un `user` con `isCompactSummary`;
   * se cuentan las fronteras, y los resúmenes sólo si no hubo frontera (un CLI
   * más viejo). Es la señal con la que se recicla a CAPCOM (rotation.ts).
   */
  private compactBoundaries = 0;
  private compactSummaries = 0;
  /** input + cache_creation + cache_read del último assistant: cuánto contexto lleva. */
  private contextTokens = 0;
  private samples: TokenSample[] = [];
  private tpsSmooth = 0;
  private tpsAt = 0;

  private liveness: Liveness = {
    alive: false, background: false, shortId: null, pid: null,
    name: null, startedAt: null, cliState: null, pane: false,
  };
  private block: BlockSignal | null = null;
  private apiFailure: Agent['block'] = null;
  private lineage: Lineage = {
    parentId: null, depth: 0, childIds: [], mission: null, squad: null, lead: false,
    role: 'agent',
  };

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
      && (this.block?.escalationId === b?.escalationId)
      && (this.block?.messageId === b?.messageId);
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
        if (at > this.lastActivityAt) this.lastActivityAt = at;
        this.assistant(l, at);
        break;
      case 'user':
        if (at > this.lastActivityAt) this.lastActivityAt = at;
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
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, thinking = 0;
    for (const v of Object.values(usage)) {
      if (!isRecord(v)) continue;
      input += num(v['inputTokens']);
      output += num(v['outputTokens']);
      cacheRead += num(v['cacheReadInputTokens']);
      cacheWrite += num(v['cacheCreationInputTokens']);
      thinking += num(v['thinkingTokens']);
    }
    this.costBase = {
      costUSD: num(l['totalCostUSD']),
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
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

  /**
   * True la primera vez que se ve este mensaje. Sin id —un CLI viejo, una
   * línea sintética— se cuenta cada línea, que es lo que se hacía antes.
   */
  private firstSightOf(msgId: string | undefined): boolean {
    if (!msgId) return true;
    if (this.counted.has(msgId)) return false;
    this.counted.add(msgId);
    if (this.counted.size > MAX_COUNTED_IDS) {
      const oldest = this.counted.values().next().value;
      if (oldest !== undefined) this.counted.delete(oldest);
    }
    return true;
  }

  private assistant(l: Record<string, unknown>, at: number): void {
    const msg = isRecord(l['message']) ? l['message'] : null;
    if (!msg) return;
    this.sawAssistant = true;
    this.lastAssistantAt = at || Date.now();
    if (l['isApiErrorMessage'] === true) {
      const content = Array.isArray(msg['content']) ? msg['content'] : [];
      const text = content.filter(isRecord).map((b) => str(b['text']) ?? '').filter(Boolean).join('\n');
      this.apiFailure = { kind: 'error', since: this.lastAssistantAt,
        summary: oneLine(`${str(l['error']) ?? 'api_error'}: ${text || 'CLI API request failed'}`, 500) };
      this.pending.clear();
      this.lastSay = oneLine(text, 200);
      this.say(str(l['uuid']), 0, { at: this.lastAssistantAt, kind: 'say', text });
      // Synthetic errors have zero usage and model <synthetic>. Preserve the
      // real model/context counters; neither proves successful model progress.
      return;
    }
    this.apiFailure = null;
    const model = str(msg['model']);
    if (model) this.model = model;

    const stop = msg['stop_reason'];
    this.lastStopReason = typeof stop === 'string' ? stop : null;
    if (this.lastStopReason === 'end_turn') this.endedCleanly = true;

    const msgId = str(msg['id']) ?? undefined;
    const usage = isRecord(msg['usage']) ? msg['usage'] : null;
    if (usage) {
      this.contextTokens = num(usage['input_tokens']) + num(usage['cache_creation_input_tokens'])
        + num(usage['cache_read_input_tokens']);
    }
    if (usage && this.firstSightOf(msgId)) {
      const out = num(usage['output_tokens']);
      this.since.inputTokens += num(usage['input_tokens']);
      this.since.outputTokens += out;
      this.since.cacheReadTokens += num(usage['cache_read_input_tokens']);
      this.since.cacheWriteTokens += num(usage['cache_creation_input_tokens']);
      const details = isRecord(usage['output_tokens_details']) ? usage['output_tokens_details'] : null;
      this.since.thinkingTokens += details ? num(details['thinking_tokens']) : 0;
      if (out > 0) this.samples.push({ at: this.lastAssistantAt, tokens: out });
    }

    const content = Array.isArray(msg['content']) ? msg['content'] : [];
    const lineId = str(l['uuid']);
    content.forEach((raw, i) => {
      if (!isRecord(raw)) return;
      const bt = raw['type'];
      if (bt === 'text') {
        const t = str(raw['text']);
        if (t) {
          this.lastSay = oneLine(t, 200);
          this.say(lineId, i, { at: this.lastAssistantAt, kind: 'say', text: t, msgId });
        }
      } else if (bt === 'thinking') {
        // Un thinking redactado llega como texto vacío: se anota igual, para
        // que la consola sepa que hubo un paso de pensar aunque no qué.
        const t = str(raw['thinking']) ?? '';
        this.say(lineId, i, { at: this.lastAssistantAt, kind: 'thinking', text: t, msgId });
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
        this.noteProduced(name, raw['input'], p.at);
        this.say(lineId, i, { at: p.at, kind: 'tool', text: p.detail, tool: name, toolUseId: p.id, msgId });
      }
    });
    // Un turno que cierra no puede dejar tools colgando.
    if (this.lastStopReason === 'end_turn') this.pending.clear();
    this.trimSamples();
  }

  private user(l: Record<string, unknown>, at: number): void {
    if (str(l['interruptedMessageId'])) this.interrupted = true;
    if (interruptMark(l['message'])) {
      this.interrupted = true;
      if (at > this.interruptedAt) this.interruptedAt = at;
    }
    const msg = isRecord(l['message']) ? l['message'] : null;
    if (!msg) return;
    const content = msg['content'];
    const lineId = str(l['uuid']);
    const meta = l['isMeta'] === true;
    if (l['isCompactSummary'] === true) this.compactSummaries++;
    if (typeof content === 'string') {
      // Prompt humano en texto plano: cuenta como turno.
      if (!meta) {
        this.turns++;
        if (isHumanText(content)) {
          this.lastPromptAt = Math.max(this.lastPromptAt, at);
          this.say(lineId, 0, { at, kind: 'prompt', text: content });
        }
      }
      return;
    }
    if (!Array.isArray(content)) return;
    let sawToolResult = false;
    content.forEach((raw, i) => {
      if (!isRecord(raw)) return;
      if (raw['type'] === 'tool_result') {
        sawToolResult = true;
        const tuid = str(raw['tool_use_id']);
        const tool = tuid ? this.pending.get(tuid) : undefined;
        if (tuid) this.pending.delete(tuid);
        this.say(lineId, i, {
          at, kind: 'result', text: resultText(raw['content']),
          ...(tool ? { tool: tool.name } : {}), ...(tuid ? { toolUseId: tuid } : {}),
          ...(raw['is_error'] === true ? { error: true } : {}),
        });
      } else if (raw['type'] === 'text' && !meta) {
        // Un prompt con adjuntos llega como bloques; el texto es lo dicho.
        const t = str(raw['text']);
        if (t && isHumanText(t)) {
          this.lastPromptAt = Math.max(this.lastPromptAt, at);
          this.say(lineId, i, { at, kind: 'prompt', text: t });
        }
      }
    });
    if (!sawToolResult && !meta) this.turns++;
  }

  /** Anota un bloque de conversación. El id es estable por línea y posición. */
  private say(lineId: string | null, i: number, item: Omit<TalkItem, 'id' | 'agentId'>): void {
    const text = item.text.length > MAX_TALK_TEXT ? `${item.text.slice(0, MAX_TALK_TEXT)}…` : item.text;
    this.talk.push({
      id: `${lineId ?? `${item.kind}:${item.at}`}:${i}`,
      agentId: this.id,
      ...item,
      text,
      at: item.at || Date.now(),
    });
    if (this.talk.length > MAX_TALK) this.talk.splice(0, this.talk.length - MAX_TALK);
  }

  /** Vacía la conversación pendiente. index.ts la drena sólo para CAPCOM. */
  drainTalk(): TalkItem[] {
    if (this.talk.length === 0) return [];
    const out = this.talk;
    this.talk = [];
    return out;
  }

  private system(l: Record<string, unknown>): void {
    const sub = str(l['subtype']);
    if (sub === 'compact_boundary') this.compactBoundaries++;
    if (sub === 'turn_duration') {
      // Claude Code cierra cada turno con esto: nada colgando.
      this.pending.clear();
    }
  }

  /**
   * Un `Write` de un .png no es una herramienta más: es una cosa que apareció y
   * que a alguien le sirve ver. Aquí sólo se anota la ruta —barato, sin tocar
   * disco—; quién es su agente y si el archivo existe de verdad lo resuelve
   * `artifacts.ts`, que es donde vive esa decisión.
   */
  private noteProduced(name: string, input: unknown, at: number): void {
    if (!ARTIFACT_TOOLS.has(name) || !isRecord(input)) return;
    const file = str(input['file_path']) ?? str(input['notebook_path']);
    if (!file || !kindOf(file)) return;
    this.produced.push({ path: file, at: at || Date.now() });
    if (this.produced.length > MAX_PRODUCED) {
      this.produced.splice(0, this.produced.length - MAX_PRODUCED);
    }
  }

  /** Vacía la cola de archivos producidos. La llama index.ts en cada tick. */
  drainProduced(): ProducedFile[] {
    if (this.produced.length === 0) return [];
    const out = this.produced;
    this.produced = [];
    return out;
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
    if (this.apiFailure) return 'blocked';
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
    // Un prompt más nuevo que la última respuesta: el modelo está en ello,
    // aunque el último stop_reason diga end_turn. Sin esto la consola decía
    // IDLE durante los segundos entre enviar y el primer bloque de respuesta.
    // Acotado: un prompt que lleva minutos sin respuesta no es "pensando".
    if (this.lastPromptAt > this.lastAssistantAt && now - this.lastPromptAt < PROMPT_THINKING_MS) return 'thinking';
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
    const gated = gatedIn(this.permissionMode);
    for (const p of this.pending.values()) {
      if (now - p.at < PERMISSION_SUSPECT_MS) continue;
      if (gated.has(p.name)) return p;
    }
    return null;
  }

  /**
   * La tool pendiente que PODRÍA estar detrás de un prompt de permisos, sin
   * esperar los 90 s de sospecha. Para una sesión en pane no hace falta
   * sospechar: se mira la pantalla, y esto dice cuándo merece la pena mirar.
   */
  gatedPending(now = Date.now(), minAgeMs = 1_500): { name: string; detail: string; at: number } | null {
    const gated = gatedIn(this.permissionMode);
    let oldest: PendingTool | null = null;
    for (const p of this.pending.values()) {
      if (!gated.has(p.name) || now - p.at < minAgeMs) continue;
      if (!oldest || p.at < oldest.at) oldest = p;
    }
    return oldest ? { name: oldest.name, detail: oldest.detail, at: oldest.at } : null;
  }

  blockOf(now = Date.now()): Agent['block'] {
    if (this.apiFailure) return this.apiFailure;
    if (this.block) {
      const b: Agent['block'] = {
        kind: this.block.kind, summary: this.block.summary, since: this.block.since,
      };
      if (this.block.escalationId) b.escalationId = this.block.escalationId;
      if (this.block.messageId) b.messageId = this.block.messageId;
      if (this.block.waitingOn) b.waitingOn = this.block.waitingOn;
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
      cacheWriteTokens: num(b.cacheWriteTokens) + this.since.cacheWriteTokens,
      thinkingTokens: num(b.thinkingTokens) + this.since.thinkingTokens,
      tokensPerSec: this.tokensPerSec(now),
      linesAdded: num(b.linesAdded),
      linesRemoved: num(b.linesRemoved),
      toolCalls: this.toolCalls,
      toolDurationMs: num(b.toolDurationMs),
      apiDurationMs: num(b.apiDurationMs),
      turns: this.turns,
      contextTokens: this.contextTokens,
      compactions: Math.max(this.compactBoundaries, this.compactSummaries),
    };
  }

  /** Cuándo se vio el último acuse de interrupción en el transcript. 0 = ninguno. */
  interruptedMarkAt(): number { return this.interruptedAt; }

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
      runtime: 'claude',
      role: this.lineage.role,
      origin: this.lineage.origin,
      // Un transcript bajo subagents/ es una tool `Task` del padre, no una sesión.
      subagent: this.ref.agentId !== null,
      state,
      block: this.blockOf(now),
      parentId: this.lineage.parentId,
      depth: this.lineage.depth,
      childIds: [...this.lineage.childIds],
      mission: this.lineage.mission,
      squad: this.lineage.squad,
      lead: this.lineage.lead,
      worktree: this.lineage.worktree ?? null,
      branch: this.lineage.branch ?? null,
      model: this.model,
      tool: working ? (this.currentTool()?.name ?? null) : null,
      toolDetail: working ? (this.currentTool()?.detail ?? null) : null,
      lastPrompt: this.lastPrompt,
      lastSay: this.lastSay,
      startedAt,
      updatedAt: this.lastActivityAt || Math.max(this.lastLineAt, this.lastMtimeMs) || now,
      uptimeMs: Math.max(0, now - startedAt),
      metrics: this.metrics(now),
      background: this.liveness.background,
      shortId: this.liveness.shortId,
      pane: this.liveness.pane,
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

/**
 * Lo que el CLI inyecta como si fuera el humano — la salida de un slash
 * command, un system-reminder, un `<command-name>` — no es conversación.
 */
const INJECTED = /^\s*<(?:system-reminder|local-command|command-name|command-message|bash-input|bash-stdout|bash-stderr)/;

/**
 * ¿Es este `message` el acuse de una interrupción?
 *
 * El contenido llega como texto plano o como bloques; la marca es la misma en
 * los dos casos y viene sola, así que basta mirar el primer texto.
 */
function interruptMark(message: unknown): boolean {
  if (!isRecord(message)) return false;
  const c = message['content'];
  if (typeof c === 'string') return CLAUDE_INTERRUPT_MARK.test(c);
  if (!Array.isArray(c)) return false;
  return c.some((b) => isRecord(b) && b['type'] === 'text' && CLAUDE_INTERRUPT_MARK.test(str(b['text']) ?? ''));
}
function isHumanText(t: string): boolean {
  return t.trim().length > 0 && !INJECTED.test(t);
}

/**
 * Un tool_result es texto plano o una lista de bloques; para la conversación
 * basta un vistazo, nunca el archivo entero que se leyó.
 */
function resultText(c: unknown): string {
  let t = '';
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) {
    t = c.map((b) => (isRecord(b) && b['type'] === 'text' ? str(b['text']) ?? '' : isRecord(b) && b['type'] === 'image' ? '[image]' : ''))
      .filter(Boolean).join('\n');
  }
  t = t.trim();
  return t.length > MAX_TALK_RESULT ? `${t.slice(0, MAX_TALK_RESULT)}…` : t;
}

function zeroCounters() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 };
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
