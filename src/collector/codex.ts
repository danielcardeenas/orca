/**
 * Codex: the second runtime.
 *
 * Codex writes one rollout per thread, `~/.codex/sessions/YYYY/MM/DD/
 * rollout-<date>-<uuid>.jsonl`, and the collector tails it exactly like a
 * Claude transcript (watch.ts, layout 'codex'). This file turns those lines
 * into the same `Agent` a Claude session becomes, so the tile, the window,
 * the squad and the terminal never know the difference.
 *
 * What the rollout says, measured on codex-cli 0.153.4:
 *
 *   session_meta          id, cwd, cli_version, model_provider — first line
 *   turn_context          cwd, approval_policy, sandbox_policy, model — per turn
 *   event_msg.task_started / task_complete / turn_aborted — the turn's edges
 *   event_msg.item_completed {item.type: UserMessage|AgentMessage|…} — what happened
 *   event_msg.token_count  {info.total_token_usage} — running totals
 *   event_msg.exec_command_begin / exec_command_end — a shell command, with its command
 *   response_item.message  role user|assistant|developer, content[].text
 *   response_item.custom_tool_call / function_call (+ _output) — tools, by call_id
 *   response_item.reasoning — thinking, contents encrypted
 *   thread_settings_applied {thread_settings.model} — the model, but only when
 *                         the interactive TUI applies them: a session prepared
 *                         with `codex exec` writes it turns later, if at all.
 *
 * What it does NOT say: approvals. A pending exec approval lives in the TUI
 * only, so the same suspicion Claude gets applies — a tool open for
 * PERMISSION_SUSPECT_MS under a policy that can ask is reported as blocked
 * on permission, and the terminal is where the human answers.
 *
 * Cost is zero: Codex here runs on the ChatGPT subscription. Rate limits
 * arrive with every token_count and are kept for the day the console shows
 * them.
 */

import { createHash } from 'node:crypto';
import { MAX_TALK, MAX_TALK_TEXT, MAX_TALK_RESULT } from '../shared/types.ts';
import type { Agent, AgentMetrics, AgentState, TalkItem } from '../shared/types.ts';
import type { BlockSignal, Lineage, Liveness, ProducedFile } from './derive.ts';
import { PERMISSION_SUSPECT_MS, REAP_AFTER_MS, TPS_WINDOW_MS } from './derive.ts';
import { isRecord, num, oneLine, stableCallsign, str, tsMs } from './util.ts';
import type { LineBatch, TranscriptRef } from './watch.ts';

interface Pending { callId: string; name: string; detail: string; at: number }
interface Sample { at: number; tokens: number }

/** Item types Codex completes that mean "the model spoke to the human". */
const SAY_ITEMS = new Set(['AgentMessage', 'agent_message']);
const PROMPT_ITEMS = new Set(['UserMessage', 'user_message']);

export class CodexDeriver {
  readonly runtime = 'codex';
  readonly id: string;
  readonly ref: TranscriptRef;
  readonly machineId: string;
  projectId: string;
  callsign: string;
  /** From session_meta; the reliable path for the project. */
  cwd: string | null = null;
  readonly firstSeenAt: number;
  rev = 0;

  private title: string | null = null;
  private model: string | null = null;
  private approvalPolicy: string | null = null;
  private lastPrompt: string | null = null;
  private lastSay: string | null = null;
  private sawAssistant = false;
  private turnOpen = false;
  private interrupted = false;
  /**
   * Cuándo registró el rollout un `turn_aborted`. 0 = nunca.
   *
   * Codex lo escribe con `reason: "interrupted"` en cuanto el turno se corta,
   * y además deja un `<turn_aborted>` en la conversación. Es el acuse que
   * `interrupt` espera para poder decir que el corte ocurrió de verdad.
   */
  private interruptedAt = 0;
  private lastLineAt = 0;
  private lastMtimeMs = 0;
  private startedAt = 0;
  private pending = new Map<string, Pending>();
  private lastTool: Pending | null = null;
  private toolCalls = 0;
  private turns = 0;
  private compactions = 0;
  private contextTokens = 0;
  private contextWindow = 0;
  private usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
  private samples: Sample[] = [];
  private tpsSmooth = 0;
  private tpsAt = 0;
  private liveness: Liveness = {
    alive: false, background: false, shortId: null, pid: null,
    name: null, startedAt: null, cliState: null, pane: false,
  };
  private block: BlockSignal | null = null;
  private apiFailure: BlockSignal | null = null;
  private lineage: Lineage = {
    parentId: null, depth: 0, childIds: [], mission: null, squad: null, lead: false, role: 'agent',
  };

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
    if (JSON.stringify(l) !== before) this.rev++;
  }

  setBlock(b: BlockSignal | null): void {
    const same = this.block?.kind === b?.kind && this.block?.summary === b?.summary
      && this.block?.escalationId === b?.escalationId && this.block?.messageId === b?.messageId;
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

  ingest(batch: LineBatch): void {
    this.lastMtimeMs = batch.mtimeMs;
    for (const line of batch.lines) this.line(line, batch.bootstrap);
    this.rev++;
  }

  drainProduced(): ProducedFile[] { return []; }

  private talk: TalkItem[] = [];
  private paired = new Map<string, { event: number; response: number }>();
  drainTalk(): TalkItem[] { const items = this.talk; this.talk = []; return items; }

  private speak(kind: TalkItem['kind'], text: string, at: number, source: 'event' | 'response' = 'response', extra: Partial<TalkItem> = {}): void {
    // Codex can report the same message in both response_item and event_msg.
    // Pair occurrences, so a repeated human prompt in a later turn is preserved.
    if (kind === 'prompt' || kind === 'say') {
      const key = `${kind}:${text}`;
      const counts = this.paired.get(key) ?? { event: 0, response: 0 };
      counts[source]++;
      this.paired.set(key, counts);
      if (counts[source] <= counts[source === 'event' ? 'response' : 'event']) return;
      if (this.paired.size > MAX_TALK) this.paired.delete(this.paired.keys().next().value!);
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([this.id, at, kind, text, extra.toolUseId])).digest('hex').slice(0, 24);
    this.talk.push({ ...extra, id: fingerprint, agentId: this.id, kind, at, text: text.slice(0, kind === 'result' ? MAX_TALK_RESULT : MAX_TALK_TEXT) });
    if (this.talk.length > MAX_TALK) this.talk.splice(0, this.talk.length - MAX_TALK);
  }

  /** Codex no pinta el diálogo de permisos de Claude Code: nada que mirar. */
  gatedPending(): null { return null; }

  /* ── una línea ────────────────────────────────────────────────── */

  private line(line: Record<string, unknown>, bootstrap: boolean): void {
    const at = tsMs(line['timestamp'], 0);
    if (at > this.lastLineAt) this.lastLineAt = at;
    const type = str(line['type']);
    const p = isRecord(line['payload']) ? line['payload'] : null;
    if (!p) return;

    switch (type) {
      case 'session_meta': {
        const cwd = str(p['cwd']);
        if (cwd) this.cwd = cwd;
        const started = tsMs(p['timestamp'], 0);
        if (started && (!this.startedAt || started < this.startedAt)) this.startedAt = started;
        return;
      }
      case 'turn_context': {
        const cwd = str(p['cwd']);
        if (cwd && !this.cwd) this.cwd = cwd;
        this.approvalPolicy = str(p['approval_policy']) ?? this.approvalPolicy;
        /*
         * El modelo, desde el PRIMER turno.
         *
         * `thread_settings_applied` también lo dice, pero lo escribe la TUI
         * cuando aplica sus ajustes: una sesión preparada por un traspaso nace
         * de un `codex exec` y no lo tiene hasta que alguien le escribe. Medido
         * el 2026-09-08 en un relevo opus → gpt-6-astra: turn_context lo decía
         * a los tres segundos y el ajuste llegó 79 después, y en ese hueco la
         * consola anunciaba «model unknown» sobre un CAPCOM que sí sabía con
         * qué corría. Las dos fuentes coinciden; se queda la que llega antes.
         */
        const model = str(p['model']);
        if (model) this.model = model;
        return;
      }
      case 'event_msg': return this.event(p, at, bootstrap);
      case 'response_item': return this.item(p, at, bootstrap);
      case 'token_usage_record': {
        const u = isRecord(p['thread_token_usage']) ? p['thread_token_usage'] : null;
        if (u) this.usageFrom(u, at, bootstrap);
        return;
      }
      // Each one is memory the commander no longer has. The line is written
      // when it happens and never rewritten, so counting it is the only way to
      // know how much of the conversation is now a summary of a summary.
      case 'compacted': this.compactions++; return;
      default: return;
    }
  }

  private event(p: Record<string, unknown>, at: number, bootstrap: boolean): void {
    switch (str(p['type'])) {
      case 'error': {
        this.apiFailure = { kind: 'error', summary: oneLine(`${JSON.stringify(p['codex_error_info'] ?? 'api_error')}: ${str(p['message']) ?? str(p['error']) ?? 'CLI request failed'}`, 500), since: at };
        this.turnOpen = false; this.pending.clear(); return;
      }
      case 'task_started':
        this.paired.clear();
        this.turnOpen = true;
        this.interrupted = false;
        this.turns++;
        return;
      case 'task_complete': {
        this.turnOpen = false;
        this.pending.clear();
        const last = str(p['last_agent_message']);
        if (last) { this.lastSay = oneLine(last, 400); this.sawAssistant = true; this.apiFailure = null; }
        return;
      }
      case 'turn_aborted':
        this.turnOpen = false;
        this.interrupted = true;
        if (at > this.interruptedAt) this.interruptedAt = at;
        this.pending.clear();
        return;
      case 'item_completed': {
        const item = isRecord(p['item']) ? p['item'] : null;
        if (!item) return;
        const kind = str(item['type']) ?? '';
        const text = firstText(item['content']) ?? str(item['text']);
        if (PROMPT_ITEMS.has(kind) && text) {
          // AGENTS.md and skills arrive as user messages too, before the real prompt.
          if (!/^# AGENTS\.md instructions|^<skills_instructions>|^<environment_context>/.test(text)) {
            this.speak('prompt', text, at, 'event');
            this.lastPrompt = oneLine(text, 400);
            if (!this.title) this.title = oneLine(text, 80);
          }
        } else if (SAY_ITEMS.has(kind) && text) {
          this.speak('say', text, at, 'event');
          this.lastSay = oneLine(text, 400);
          this.sawAssistant = true; this.apiFailure = null;
        }
        return;
      }
      case 'exec_command_begin': {
        const callId = str(p['call_id']) ?? `exec-${at}`;
        const cmd = Array.isArray(p['command']) ? p['command'].map(String).join(' ') : str(p['command']) ?? '';
        this.open(callId, 'exec', oneLine(cmd, 160), at, bootstrap);
        return;
      }
      case 'exec_command_end': {
        const callId = str(p['call_id']);
        if (callId) this.close(callId);
        return;
      }
      case 'agent_message': {
        const text = str(p['message']);
        if (text) { this.lastSay = oneLine(text, 400); this.sawAssistant = true; this.apiFailure = null; }
        return;
      }
      case 'token_count': {
        const info = isRecord(p['info']) ? p['info'] : null;
        const total = info && isRecord(info['total_token_usage']) ? info['total_token_usage'] : null;
        if (total) this.usageFrom(total, at, bootstrap);
        // `total_token_usage` accumulates over the thread and says nothing
        // about the window; the last turn's prompt is what is actually in it.
        const last = info && isRecord(info['last_token_usage']) ? info['last_token_usage'] : null;
        if (last) this.contextTokens = num(last['input_tokens']);
        const window = info ? num(info['model_context_window']) : 0;
        if (window > 0) this.contextWindow = window;
        return;
      }
      case 'thread_settings_applied': {
        const s = isRecord(p['thread_settings']) ? p['thread_settings'] : null;
        const model = s ? str(s['model']) : null;
        if (model) this.model = model;
        const policy = s ? str(s['approval_policy']) : null;
        if (policy) this.approvalPolicy = policy;
        return;
      }
      default: return;
    }
  }

  private item(p: Record<string, unknown>, at: number, bootstrap: boolean): void {
    switch (str(p['type'])) {
      case 'message': {
        const role = str(p['role']);
        const text = firstText(p['content']);
        if (role === 'assistant') {
          this.sawAssistant = true; this.apiFailure = null;
          if (text) { this.lastSay = oneLine(text, 400); this.speak('say', text, at); }
        } else if (role === 'user' && text && !/^# AGENTS\.md instructions|^<skills_instructions>|^<environment_context>/.test(text)) {
          this.speak('prompt', text, at);
          this.lastPrompt = oneLine(text, 400);
          if (!this.title) this.title = oneLine(text, 80);
        }
        return;
      }
      case 'reasoning':
        this.speak('thinking', firstText(p['summary']) ?? '', at);
        this.sawAssistant = true; this.apiFailure = null;
        return;
      case 'custom_tool_call':
      case 'function_call': {
        const callId = str(p['call_id']) ?? str(p['id']) ?? `call-${at}`;
        const name = str(p['name']) ?? 'tool';
        const input = str(p['input']) ?? str(p['arguments']) ?? '';
        this.speak('tool', input, at, 'response', { tool: name, toolUseId: callId });
        this.open(callId, name, oneLine(input, 160), at, bootstrap);
        return;
      }
      case 'custom_tool_call_output':
      case 'function_call_output': {
        const callId = str(p['call_id']);
        this.speak('result', firstText(p['output']) ?? '', at, 'response', { toolUseId: callId ?? undefined });
        if (callId) this.close(callId);
        return;
      }
      default: return;
    }
  }

  private open(callId: string, name: string, detail: string, at: number, bootstrap: boolean): void {
    const t: Pending = { callId, name, detail, at: at || Date.now() };
    this.pending.set(callId, t);
    this.lastTool = t;
    if (!bootstrap) this.toolCalls++;
    this.sawAssistant = true; this.apiFailure = null;
  }

  private close(callId: string): void {
    this.pending.delete(callId);
  }

  private usageFrom(u: Record<string, unknown>, at: number, bootstrap: boolean): void {
    const next = {
      input: num(u['input_tokens']), cached: num(u['cached_input_tokens']),
      output: num(u['output_tokens']), reasoning: num(u['reasoning_output_tokens']),
    };
    const delta = next.output - this.usage.output;
    if (!bootstrap && delta > 0) {
      this.samples.push({ at: at || Date.now(), tokens: delta });
      if (this.samples.length > 256) this.samples = this.samples.slice(-256);
    }
    // Totals only ever grow inside a thread; a smaller number is an older line.
    if (next.output >= this.usage.output) this.usage = next;
  }

  /* ── salida ───────────────────────────────────────────────────── */

  private tokensPerSec(now: number): number {
    const from = now - TPS_WINDOW_MS;
    let sum = 0, oldest = now;
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

  private stuckTool(now: number): Pending | null {
    if (this.approvalPolicy === 'never') return null;
    for (const t of this.pending.values()) {
      if (now - t.at >= PERMISSION_SUSPECT_MS) return t;
    }
    return null;
  }

  state(now = Date.now()): AgentState {
    if (this.block || this.apiFailure) return 'blocked';
    const quietFor = now - Math.max(this.lastLineAt, this.lastMtimeMs, this.firstSeenAt);
    if (!this.liveness.alive && quietFor > REAP_AFTER_MS) {
      return this.sawAssistant ? 'done' : 'dead';
    }
    if (!this.sawAssistant) return 'booting';
    if (this.stuckTool(now)) return 'blocked';
    if (!this.turnOpen) return 'idle';
    return this.pending.size > 0 ? 'working' : 'thinking';
  }

  blockOf(now = Date.now()): Agent['block'] {
    if (this.block) {
      const b: Agent['block'] = { kind: this.block.kind, summary: this.block.summary, since: this.block.since };
      if (this.block.escalationId) b.escalationId = this.block.escalationId;
      if (this.block.messageId) b.messageId = this.block.messageId;
      if (this.block.waitingOn) b.waitingOn = this.block.waitingOn;
      return b;
    }
    if (this.apiFailure) return { ...this.apiFailure };
    const stuck = this.stuckTool(now);
    if (stuck) {
      return { kind: 'permission', summary: `${stuck.name} esperando aprobación: ${stuck.detail}`.trim(), since: stuck.at };
    }
    return null;
  }

  metrics(now = Date.now()): AgentMetrics {
    return {
      costUSD: 0,
      inputTokens: this.usage.input,
      outputTokens: this.usage.output,
      cacheReadTokens: this.usage.cached,
      thinkingTokens: this.usage.reasoning,
      tokensPerSec: this.tokensPerSec(now),
      linesAdded: 0, linesRemoved: 0,
      toolCalls: this.toolCalls,
      toolDurationMs: 0, apiDurationMs: 0,
      turns: this.turns,
      contextTokens: this.contextTokens,
      ...(this.contextWindow ? { contextWindow: this.contextWindow } : {}),
      compactions: this.compactions,
    };
  }

  /** Cuándo se vio el último `turn_aborted`. 0 = ninguno. */
  interruptedMarkAt(): number { return this.interruptedAt; }

  snapshot(now = Date.now()): Agent {
    const state = this.state(now);
    const working = state === 'working';
    const startedAt = this.startedAt || this.firstSeenAt;
    const tool = working ? (this.lastTool && this.pending.has(this.lastTool.callId) ? this.lastTool : [...this.pending.values()][0] ?? null) : null;
    return {
      id: this.id,
      machineId: this.machineId,
      projectId: this.projectId,
      title: this.title ?? this.lastPrompt ?? this.ref.sessionId.slice(0, 8),
      callsign: this.callsign,
      runtime: 'codex',
      role: this.lineage.role,
      origin: this.lineage.origin,
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
      tool: tool?.name ?? null,
      toolDetail: tool?.detail ?? null,
      lastPrompt: this.lastPrompt,
      lastSay: this.lastSay,
      startedAt,
      updatedAt: Math.max(this.lastLineAt, this.lastMtimeMs) || now,
      uptimeMs: Math.max(0, now - startedAt),
      metrics: this.metrics(now),
      background: false,
      shortId: null,
      pane: this.liveness.pane,
    };
  }

  debug(): Record<string, unknown> {
    return {
      id: this.id, runtime: 'codex', cwd: this.cwd, model: this.model, turnOpen: this.turnOpen,
      pending: [...this.pending.values()].map((t) => t.name), sawAssistant: this.sawAssistant,
      interrupted: this.interrupted, usage: this.usage, liveness: this.liveness,
    };
  }
}

/** The first text in a Codex content array: input_text, output_text or text. */
function firstText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter(isRecord).map((c) => c['text']).filter((t): t is string => typeof t === 'string' && t.length > 0);
  return texts.length ? texts.join('\n') : null;
}
