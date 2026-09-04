/**
 * The CEO's tool surface.
 *
 * Deliberately small. The CEO commands a fleet; it does not edit code, run
 * shells, or touch the filesystem — those are the coding agents' job, and
 * keeping that line sharp is what makes it safe to let the CEO act without
 * asking permission for every step.
 *
 * Two tools carry the product's whole thesis:
 *   ask_human      — the CEO admits it cannot answer and interrupts the human
 *   answer_agent   — the CEO answers on the human's behalf, from memory
 * Every question an agent raises must end in exactly one of those.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Agent, Escalation, Project } from '../shared/types.ts';
import type { Command } from '../shared/protocol.ts';

/** Everything the tools are allowed to reach. The hub supplies this. */
export interface CeoContext {
  /** Read-only view of the fleet. */
  agents(): Agent[];
  projects(): Project[];
  agent(id: string): Agent | undefined;
  project(id: string): Project | undefined;
  escalation(id: string): Escalation | undefined;

  /** Route a command to the collector that owns the machine. Throws on refusal. */
  dispatch(machineId: string, cmd: Command): Promise<unknown>;

  /** Past human answers, for answering without interrupting anyone. */
  recall(question: string, projectId: string | null): { question: string; answer: string; score: number }[];
  /** Persist an answer so the same question never reaches the human twice. */
  remember(question: string, answer: string, projectId: string | null): void;

  /** Raise a question to the human. Returns the escalation it created. */
  raiseToHuman(input: {
    question: string;
    context: string | null;
    options: string[];
    urgency: Escalation['urgency'];
    agentId: string | null;
    projectId: string | null;
    ceoAttempt: Escalation['ceoAttempt'];
  }): Escalation;

  /** Send an answer back down to a waiting agent. */
  resolveEscalation(id: string, answer: string, by: 'ceo' | 'human'): void;
}

export const CEO_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_fleet',
    description:
      'Survey the fleet. Returns every project with its agent counts by state, spend, and which agents are blocked. Call this first when you need situational awareness — it is cheap and always current.',
    input_schema: {
      type: 'object',
      properties: {
        only_blocked: {
          type: 'boolean',
          description: 'Return only projects that have agents needing a human.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'inspect_agent',
    description:
      'Full detail on one agent: state, current tool, mission, last prompt, last output, metrics, parent and children. Use before answering a question about what an agent is doing or why it stalled.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent id, or its callsign like "K9".' },
      },
      required: ['agent_id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'spawn_agent',
    description:
      'Launch a new Claude Code agent on a project with a mission. The mission is the whole brief the agent wakes up with, so write it as you would write a task for a capable engineer who has not seen the conversation: what to do, what done looks like, what not to touch. Prefer one well-briefed agent over three vague ones.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        mission: {
          type: 'string',
          description: 'The complete brief. Include acceptance criteria and any constraint the agent could not infer from the repo.',
        },
        parent_agent_id: {
          type: ['string', 'null'],
          description: 'Set when this agent is being spawned on behalf of another agent, so the lineage graph stays honest.',
        },
        background: {
          type: 'boolean',
          description: 'Background agents survive the console disconnecting. Default true for anything that will take more than a minute.',
        },
      },
      required: ['project_id', 'mission', 'parent_agent_id', 'background'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'send_to_agent',
    description:
      'Send text to a running agent — an answer, a correction, a nudge, a change of direction. This is how you unblock an agent that is waiting on input.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['agent_id', 'text'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'stop_agent',
    description:
      'Stop a running agent. Its conversation is kept and can be resumed. Use when an agent is off track, duplicating work, or burning spend with no progress.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['agent_id', 'reason'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'recall',
    description:
      'Search what the human has told you before. Call this BEFORE ask_human, every single time — the human should never have to answer the same question twice, and this is the only thing standing between them and that.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question you are trying to answer.' },
        project_id: { type: ['string', 'null'] },
      },
      required: ['question', 'project_id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'answer_agent',
    description:
      'Answer a waiting agent yourself, without involving the human. Use this whenever you can answer correctly from recall, from the fleet state, or from what the human has already said in this conversation. Answering here is always better than interrupting — but a confident wrong answer sends an agent down a wrong path for an hour, so do not guess.',
    input_schema: {
      type: 'object',
      properties: {
        escalation_id: { type: 'string' },
        answer: { type: 'string' },
        basis: {
          type: 'string',
          description: 'Where the answer came from: a recall hit, something the human said earlier, or fleet state. Shown to the human in the audit trail.',
        },
      },
      required: ['escalation_id', 'answer', 'basis'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'ask_human',
    description:
      'Interrupt the human. Use only after recall came back empty and you genuinely cannot answer — a preference you have never been told, a business decision, a credential, an ambiguity where guessing wrong is expensive. Ask ONE precise question. Supply options whenever the answer is a choice: an answerable-in-one-tap question gets answered in seconds, an open one waits for hours.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One precise question. No preamble, no restating context the human can see.' },
        context: {
          type: ['string', 'null'],
          description: 'Two or three lines of why this is being asked, for a human who has not been watching.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Suggested answers, tappable. Give these whenever the answer is a choice between known alternatives.',
        },
        urgency: {
          type: 'string',
          enum: ['low', 'normal', 'blocking'],
          description: 'blocking means an agent is stopped and burning nothing until this is answered. Reserve it for that.',
        },
        agent_id: { type: ['string', 'null'] },
        project_id: { type: ['string', 'null'] },
      },
      required: ['question', 'context', 'options', 'urgency', 'agent_id', 'project_id'],
      additionalProperties: false,
    },
    strict: true,
  },
];

/* ── Execution ────────────────────────────────────────────────────── */

export interface ToolOutcome {
  /** Serialised result handed back to the model. */
  result: string;
  /** One-line human summary for the console's action readout. */
  summary: string;
  isError?: boolean;
  /** Set when the tool ended the escalation loop. */
  terminal?: 'answered' | 'escalated';
}

export async function runTool(
  ctx: CeoContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'list_fleet': return listFleet(ctx, input);
      case 'inspect_agent': return inspectAgent(ctx, input);
      case 'spawn_agent': return await spawnAgent(ctx, input);
      case 'send_to_agent': return await sendToAgent(ctx, input);
      case 'stop_agent': return await stopAgent(ctx, input);
      case 'recall': return doRecall(ctx, input);
      case 'answer_agent': return answerAgent(ctx, input);
      case 'ask_human': return askHuman(ctx, input);
      default:
        return { result: `unknown tool: ${name}`, summary: `unknown tool ${name}`, isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A failed tool is data for the model, not a crash: it should be able to
    // recover, explain, or route around it.
    return { result: `error: ${msg}`, summary: `${name} failed: ${msg}`, isError: true };
  }
}

function listFleet(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  const onlyBlocked = input.only_blocked === true;
  const projects = ctx.projects()
    .filter((p) => p.rollup.total > 0 && (!onlyBlocked || p.rollup.blocked > 0))
    .map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      branch: p.gitBranch,
      dirty: p.gitDirty,
      keys: p.keyNames,
      agents: p.rollup.total,
      by_state: p.rollup.byState,
      blocked: p.rollup.blocked,
      spend_usd: Number(p.rollup.costUSD.toFixed(2)),
    }));

  const blocked = ctx.agents()
    .filter((a) => a.state === 'blocked')
    .map((a) => ({
      id: a.id, callsign: a.callsign, project: a.projectId,
      wants: a.block?.summary ?? null, kind: a.block?.kind ?? null,
      waiting_sec: a.block ? Math.round((Date.now() - a.block.since) / 1000) : null,
    }));

  return {
    result: JSON.stringify({ projects, blocked }, null, 1),
    summary: `surveyed ${projects.length} projects, ${blocked.length} blocked`,
  };
}

/** Accepts an id or a callsign, because the human will type the callsign. */
function findAgent(ctx: CeoContext, ref: string): Agent | undefined {
  return ctx.agent(ref)
    ?? ctx.agents().find((a) => a.callsign.toLowerCase() === ref.toLowerCase());
}

function inspectAgent(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  const ref = String(input.agent_id ?? '');
  const a = findAgent(ctx, ref);
  if (!a) return { result: `no agent matching "${ref}"`, summary: `no agent ${ref}`, isError: true };
  const p = ctx.project(a.projectId);
  return {
    result: JSON.stringify({
      id: a.id, callsign: a.callsign, title: a.title, state: a.state,
      project: p ? { id: p.id, code: p.code, name: p.name, path: p.path, branch: p.gitBranch } : null,
      mission: a.mission, tool: a.tool, tool_detail: a.toolDetail,
      block: a.block, model: a.model,
      last_prompt: a.lastPrompt, last_say: a.lastSay,
      uptime_sec: Math.round(a.uptimeMs / 1000),
      metrics: a.metrics,
      parent: a.parentId, children: a.childIds, depth: a.depth,
    }, null, 1),
    summary: `inspected ${a.callsign} (${a.state})`,
  };
}

async function spawnAgent(ctx: CeoContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const projectId = String(input.project_id ?? '');
  const p = ctx.project(projectId);
  if (!p) return { result: `no project "${projectId}"`, summary: 'spawn failed: no project', isError: true };

  const mission = String(input.mission ?? '').trim();
  if (mission.length < 20) {
    // A one-line mission produces an agent that asks five questions. Refuse it
    // here rather than pay for that later.
    return {
      result: 'mission too thin. Write the full brief: goal, acceptance criteria, constraints.',
      summary: 'spawn refused: mission too thin',
      isError: true,
    };
  }

  const parentRef = input.parent_agent_id;
  const parent = typeof parentRef === 'string' && parentRef ? findAgent(ctx, parentRef) : undefined;

  const data = await ctx.dispatch(p.machineId, {
    k: 'spawn',
    projectId: p.id,
    prompt: mission,
    parentId: parent?.id ?? null,
    mission,
    background: input.background !== false,
    permissionMode: 'acceptEdits',
  });

  return {
    result: JSON.stringify({ ok: true, spawned: data }),
    summary: `spawned an agent on ${p.code}`,
  };
}

async function sendToAgent(ctx: CeoContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const a = findAgent(ctx, String(input.agent_id ?? ''));
  if (!a) return { result: 'no such agent', summary: 'send failed', isError: true };
  await ctx.dispatch(a.machineId, { k: 'say', agentId: a.id, text: String(input.text ?? '') });
  return { result: JSON.stringify({ ok: true }), summary: `sent to ${a.callsign}` };
}

async function stopAgent(ctx: CeoContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const a = findAgent(ctx, String(input.agent_id ?? ''));
  if (!a) return { result: 'no such agent', summary: 'stop failed', isError: true };
  await ctx.dispatch(a.machineId, { k: 'stop', agentId: a.id });
  return {
    result: JSON.stringify({ ok: true }),
    summary: `stopped ${a.callsign}: ${String(input.reason ?? '')}`.slice(0, 120),
  };
}

function doRecall(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  const q = String(input.question ?? '');
  const pid = typeof input.project_id === 'string' ? input.project_id : null;
  const hits = ctx.recall(q, pid);
  return {
    result: hits.length
      ? JSON.stringify(hits.map((h) => ({
        past_question: h.question, answer: h.answer, similarity: Number(h.score.toFixed(2)),
      })), null, 1)
      : 'no prior answers. The human has never been asked anything close to this.',
    summary: hits.length ? `recalled ${hits.length} prior answer(s)` : 'nothing in memory',
  };
}

function answerAgent(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  const id = String(input.escalation_id ?? '');
  const esc = ctx.escalation(id);
  if (!esc) return { result: 'no such question', summary: 'answer failed', isError: true };
  const answer = String(input.answer ?? '');
  ctx.resolveEscalation(id, answer, 'ceo');
  return {
    result: JSON.stringify({ ok: true }),
    summary: `answered it myself: ${String(input.basis ?? '')}`.slice(0, 120),
    terminal: 'answered',
  };
}

function askHuman(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  const opts = Array.isArray(input.options) ? input.options.map(String).slice(0, 6) : [];
  const esc = ctx.raiseToHuman({
    question: String(input.question ?? '').trim(),
    context: typeof input.context === 'string' && input.context ? input.context : null,
    options: opts,
    urgency: (input.urgency === 'blocking' || input.urgency === 'low' ? input.urgency : 'normal'),
    agentId: typeof input.agent_id === 'string' && input.agent_id ? input.agent_id : null,
    projectId: typeof input.project_id === 'string' && input.project_id ? input.project_id : null,
    ceoAttempt: null,
  });
  return {
    result: JSON.stringify({ ok: true, escalation_id: esc.id, note: 'The human has been asked. Stop here and wait.' }),
    summary: 'asked the human',
    terminal: 'escalated',
  };
}
