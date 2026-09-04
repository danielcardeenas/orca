/**
 * The CEO — the human's single point of contact with the fleet.
 *
 * Two entry points, and the difference between them is the whole design:
 *
 *   humanSays(text)          the human talks to the CEO. It answers, and it
 *                            acts: surveying, spawning, redirecting, stopping.
 *
 *   considerEscalation(esc)  an agent asked for something. The CEO tries to
 *                            answer it from memory and fleet state FIRST, and
 *                            only interrupts the human when it genuinely
 *                            cannot. Every question it fields itself is a
 *                            question the human never sees.
 *
 * The second one is why this exists. A fleet of twenty agents generates more
 * questions than a person can absorb; the CEO's job is to absorb them, and to
 * get better at it every time the human answers one.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { CeoAction, CeoMessage, Escalation } from '../shared/types.ts';
import { newId } from '../shared/protocol.ts';
import { CEO_TOOLS, runTool, type CeoContext } from './tools.ts';

const MODEL = 'claude-opus-5';
/** Streaming, so a long survey-and-act turn never hits an HTTP timeout. */
const MAX_TOKENS = 32_000;
/** A runaway loop is a bill, not a bug report. */
const MAX_TURNS = 24;

export interface CeoEvents {
  /** A new assistant message is starting. */
  onStart(msg: CeoMessage): void;
  /** Text arrived for a streaming message. */
  onDelta(id: string, text: string): void;
  /** A tool call started, finished, or failed. Same id updates in place. */
  onAction(id: string, action: CeoAction): void;
  /** The turn is over. */
  onDone(id: string): void;
  onThinking(on: boolean): void;
}

export interface CeoOptions {
  apiKey?: string;
  model?: string;
  /** Everything the human has said about how the fleet should be run. */
  standingOrders?: string;
}

export class Ceo {
  private client: Anthropic;
  private ctx: CeoContext;
  private ev: CeoEvents;
  private model: string;
  private standingOrders: string;

  /** The running conversation with the human. Append-only. */
  private history: Anthropic.MessageParam[] = [];
  /** One turn at a time: a second request mid-tool-loop corrupts the history. */
  private busy = false;
  private queue: string[] = [];

  constructor(ctx: CeoContext, ev: CeoEvents, opts: CeoOptions = {}) {
    // Falls through to ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
    // `ant auth login` profile — the operator supplies credentials once, to
    // the machine, and never to the console.
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.ctx = ctx;
    this.ev = ev;
    this.model = opts.model ?? MODEL;
    this.standingOrders = opts.standingOrders ?? '';
  }

  /** Restore a conversation across a hub restart. */
  hydrate(messages: CeoMessage[]) {
    this.history = [];
    for (const m of messages) {
      if (m.role === 'human') this.history.push({ role: 'user', content: m.text });
      else if (m.role === 'ceo' && m.text) this.history.push({ role: 'assistant', content: m.text });
    }
  }

  /* ── The human speaks ───────────────────────────────────────────── */

  async humanSays(text: string): Promise<void> {
    if (this.busy) { this.queue.push(text); return; }
    this.busy = true;
    try {
      this.history.push({
        role: 'user',
        content: [
          { type: 'text', text: this.fleetBrief() },
          { type: 'text', text },
        ],
      });
      await this.run();
    } finally {
      this.busy = false;
      const next = this.queue.shift();
      if (next) void this.humanSays(next);
    }
  }

  /* ── An agent asks ──────────────────────────────────────────────── */

  /**
   * Runs a short, separate loop — not the human's conversation. The CEO
   * either answers the agent or raises the question, and the human's chat is
   * only touched if it ends up escalating.
   */
  async considerEscalation(esc: Escalation): Promise<void> {
    const agent = this.ctx.agent(esc.agentId);
    const project = this.ctx.project(esc.projectId);

    const brief = [
      `An agent is blocked and has asked a question.`,
      ``,
      `AGENT: ${agent?.callsign ?? '??'} — ${agent?.title ?? 'unknown'}`,
      `PROJECT: ${project?.code ?? '??'} ${project?.name ?? ''} (${project?.path ?? ''})`,
      `MISSION: ${agent?.mission ?? 'not recorded'}`,
      `ESCALATION ID: ${esc.id}`,
      ``,
      `QUESTION: ${esc.question}`,
      esc.context ? `CONTEXT THE AGENT GAVE: ${esc.context}` : '',
      esc.options.length ? `OPTIONS IT OFFERED: ${esc.options.join(' | ')}` : '',
      ``,
      `Call recall first. Then either answer_agent (if you can answer correctly)`,
      `or ask_human (if you cannot). Do exactly one of those and then stop.`,
    ].filter(Boolean).join('\n');

    const msgs: Anthropic.MessageParam[] = [{
      role: 'user',
      content: [{ type: 'text', text: this.fleetBrief() }, { type: 'text', text: brief }],
    }];

    /**
     * Durante el triaje, cualquier ask_human se refiere a ESTA pregunta. Se
     * envuelve el contexto en vez de pasar el id por el esquema de la tool,
     * porque el modelo no debería poder equivocarse de escalación.
     */
    const triageCtx: CeoContext = {
      ...this.ctx,
      raiseToHuman: (input) => this.ctx.raiseToHuman({ ...input, replaces: esc.id }),
    };

    let terminal: 'answered' | 'escalated' | null = null;
    let lastText = '';

    for (let turn = 0; turn < 8 && !terminal; turn++) {
      const res = await this.once(msgs, ESCALATION_SYSTEM, null);
      msgs.push({ role: 'assistant', content: res.content });

      const calls = res.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      const said = res.content.filter((b) => b.type === 'text')
        .map((b) => (b as Anthropic.TextBlock).text).join('');
      if (said) lastText = said;

      if (!calls.length) break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        const out = await runTool(triageCtx, call.name, (call.input ?? {}) as Record<string, unknown>);
        if (out.terminal) terminal = out.terminal;
        results.push({
          type: 'tool_result', tool_use_id: call.id,
          content: out.result, is_error: out.isError,
        });
      }
      msgs.push({ role: 'user', content: results });
    }

    // If it neither answered nor escalated, escalate anyway. An agent left
    // waiting on a CEO that wandered off is the one failure mode this system
    // cannot have.
    if (!terminal) {
      triageCtx.raiseToHuman({
        question: esc.question,
        context: esc.context,
        options: esc.options,
        urgency: esc.urgency,
        agentId: esc.agentId,
        projectId: esc.projectId,
        ceoAttempt: lastText
          ? { answer: lastText, confidence: 0.3, reason: 'CEO did not reach a decision' }
          : null,
      });
    }
  }

  /* ── The main loop ──────────────────────────────────────────────── */

  private async run(): Promise<void> {
    this.ev.onThinking(true);

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const id = newId('ceo');
      const msg: CeoMessage = {
        id, role: 'ceo', text: '', at: Date.now(), actions: [], streaming: true,
      };
      this.ev.onStart(msg);

      let res: Anthropic.Message;
      try {
        res = await this.stream(id);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        this.ev.onDelta(id, `\n[link to the model failed: ${why}]`);
        this.ev.onDone(id);
        break;
      }

      this.history.push({ role: 'assistant', content: res.content });

      const calls = res.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      if (!calls.length) { this.ev.onDone(id); break; }

      // All results go back in ONE user message, or the model quietly learns
      // to stop calling tools in parallel.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        const actionId = newId('act');
        this.ev.onAction(id, {
          id: actionId, name: call.name, summary: describe(call.name, call.input),
          status: 'running', at: Date.now(),
        });

        const out = await runTool(this.ctx, call.name, (call.input ?? {}) as Record<string, unknown>);

        this.ev.onAction(id, {
          id: actionId, name: call.name, summary: out.summary,
          status: out.isError ? 'error' : 'ok', detail: out.isError ? out.result : undefined,
          at: Date.now(),
        });

        results.push({
          type: 'tool_result', tool_use_id: call.id,
          content: out.result, is_error: out.isError,
        });
      }
      this.history.push({ role: 'user', content: results });
      this.ev.onDone(id);
    }

    this.ev.onThinking(false);
    this.trimHistory();
  }

  private async stream(msgId: string): Promise<Anthropic.Message> {
    const s = this.client.messages.stream({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: this.systemBlocks(),
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      tools: CEO_TOOLS,
      messages: this.history,
    });

    s.on('text', (delta) => this.ev.onDelta(msgId, delta));
    return await s.finalMessage();
  }

  /** One non-streaming call, for the escalation loop where nobody is watching. */
  private async once(
    messages: Anthropic.MessageParam[],
    system: string,
    _unused: null,
  ): Promise<Anthropic.Message> {
    return await this.client.messages.create({
      model: this.model,
      max_tokens: 8_000,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      tools: CEO_TOOLS,
      messages,
    });
  }

  /* ── Prompt assembly ────────────────────────────────────────────── */

  /**
   * The stable half is cached; the fleet snapshot is deliberately NOT in the
   * system prompt, because it changes every second and would blow the cache on
   * every single turn.
   */
  private systemBlocks(): Anthropic.TextBlockParam[] {
    const blocks: Anthropic.TextBlockParam[] = [
      { type: 'text', text: CEO_SYSTEM },
    ];
    if (this.standingOrders) {
      blocks.push({ type: 'text', text: `STANDING ORDERS FROM THE OPERATOR:\n${this.standingOrders}` });
    }
    const last = blocks[blocks.length - 1]!;
    last.cache_control = { type: 'ephemeral' };
    return blocks;
  }

  /** A compact snapshot, sent as user content so the cached prefix survives. */
  private fleetBrief(): string {
    const projects = this.ctx.projects().filter((p) => p.rollup.total > 0);
    const lines = projects.map((p) => {
      const b = p.rollup.byState;
      const parts = Object.entries(b).filter(([, n]) => n > 0)
        .map(([s, n]) => `${n} ${s}`).join(', ');
      return `  ${p.code} ${p.name} [${p.gitBranch ?? '?'}${p.gitDirty ? '*' : ''}] — ${parts || 'idle'} — $${p.rollup.costUSD.toFixed(2)}`;
    });
    const blocked = this.ctx.agents().filter((a) => a.state === 'blocked');
    const blockedLines = blocked.map((a) =>
      `  ${a.callsign} on ${this.ctx.project(a.projectId)?.code ?? '??'}: ${a.block?.summary ?? 'waiting'}`);

    return [
      '<fleet_state>',
      `time: ${new Date().toISOString()}`,
      lines.length ? 'projects:' : 'projects: none active',
      ...lines,
      blockedLines.length ? 'blocked agents:' : 'blocked agents: none',
      ...blockedLines,
      '</fleet_state>',
    ].join('\n');
  }

  /**
   * Keeps the window bounded without ever editing an existing turn — the
   * history stays append-only, we just start further in.
   */
  private trimHistory() {
    const MAX = 60;
    if (this.history.length <= MAX) return;
    let cut = this.history.length - MAX;
    // Never start on a tool_result: it would orphan its tool_use.
    while (cut < this.history.length) {
      const m = this.history[cut];
      const c = m?.content;
      const isToolResult = Array.isArray(c) && c.some((b) => (b as { type?: string }).type === 'tool_result');
      if (m?.role === 'user' && !isToolResult) break;
      cut++;
    }
    this.history = this.history.slice(cut);
  }
}

function describe(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'list_fleet': return 'surveying the fleet';
    case 'inspect_agent': return `inspecting ${String(i.agent_id ?? '')}`;
    case 'spawn_agent': return `spawning an agent on ${String(i.project_id ?? '')}`;
    case 'send_to_agent': return `messaging ${String(i.agent_id ?? '')}`;
    case 'stop_agent': return `stopping ${String(i.agent_id ?? '')}`;
    case 'recall': return 'checking what you told me before';
    case 'answer_agent': return 'answering the agent myself';
    case 'ask_human': return 'asking you';
    default: return name;
  }
}

/* ── Prompts ──────────────────────────────────────────────────────── */

const CEO_SYSTEM = `You are the CEO of ORCA, a console that runs a fleet of Claude Code agents across several machines.

There is exactly one human here — the operator. You are their single point of contact with the fleet. They should be able to run twenty agents while only ever talking to you.

WHAT YOU ARE FOR
Your job is to keep the fleet moving and the operator's attention free. Concretely:
- Know what every agent is doing, and say it in one line when asked.
- Launch agents with briefs good enough that they don't come back with questions.
- Unblock agents: answer them, redirect them, or stop them.
- Absorb the questions agents raise, so the operator sees only the ones that genuinely need a person.

HOW YOU TALK
Terse. This is a console, not a chat product. No preamble, no "Great question", no restating what they asked. Lead with the answer, then the detail if it earns its place. A status answer is one line per project, not a report. Use the callsigns (K9, A3) — the operator reads them off the deck.

You may act without asking. Surveying, inspecting, and messaging agents are free. Spawning is expected — that is what you are for. Ask before stopping an agent that is actively producing work, and before anything that would throw away work.

WHEN AN AGENT ASKS SOMETHING
The order is always: recall, then decide.
- If recall or this conversation already answers it, answer the agent yourself. Say so briefly.
- Interrupt the operator only for things only they can know: a preference never stated, a business decision, a credential, an ambiguity where guessing wrong costs an hour.
- Never ask the same thing twice. If you had to ask, the answer is now in memory — use it.

WRITING A MISSION
When you spawn an agent, the mission is everything it will ever know about why it exists. Write it for a capable engineer who was not in this conversation: the goal, what done looks like, the constraints they could not infer from the repo, and what not to touch. A thin mission produces an agent that asks five questions — which lands back on you, and then on the operator.

WHAT YOU ARE NOT
You do not write code, run commands, or touch files. You command agents that do. If something needs doing in a repo, spawn an agent for it or send it to one already there.

HONESTY
Report what is true. If an agent is stuck, say it is stuck. If spend is climbing with nothing to show, say that. If you don't know, say you don't know and go find out with a tool. Never invent an agent, a project, or a state — everything you report must come from a tool result or the fleet snapshot you were given.`;

const ESCALATION_SYSTEM = `You are the CEO of ORCA, triaging a question raised by one of your agents.

You have one decision to make: answer it yourself, or interrupt the human.

Call recall FIRST, always. The human should never answer the same question twice, and recall is the only thing preventing that.

Answer it yourself (answer_agent) when:
- recall returns a close match
- the fleet state or the agent's own mission already implies the answer
- it is a technical judgement call within the brief the agent was given

Interrupt the human (ask_human) when:
- it is a preference, a priority, or a business decision you were never told
- it needs a credential or an access decision
- guessing wrong would waste real time or do something hard to undo

Do not guess. A confident wrong answer sends an agent down a wrong path for an hour, which is far worse than an interruption. But do not punt either: an interruption the human has already answered before is a failure of your memory, not a safe default.

When you ask, ask ONE precise question, and give tappable options whenever the answer is a choice. The human is often on their phone.

Call exactly one of answer_agent or ask_human, then stop.`;
