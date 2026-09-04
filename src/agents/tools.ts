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
 *
 * The traffic tools are the same idea one level down. Agents ask each other
 * things too, and an agent waiting on another agent is just as stopped as one
 * waiting on a person — with nobody watching. The CEO is the only party that
 * sees every agent at once, so answer_peer and resolve_collision are where it
 * can end a wait that neither side can see the shape of.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  Agent, AgentMessage, Collision, Escalation, MessageKind, Project,
} from '../shared/types.ts';
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

  /**
   * Raise a question to the human. Returns the escalation it created — or the
   * one it updated: when the CEO is triaging a question an agent already
   * asked, `replaces` names that record, and the CEO's attempt is written onto
   * it. Creating a second record would show the operator the same question
   * twice, which is precisely the noise this whole system exists to remove.
   */
  raiseToHuman(input: {
    question: string;
    context: string | null;
    options: string[];
    urgency: Escalation['urgency'];
    agentId: string | null;
    projectId: string | null;
    ceoAttempt: Escalation['ceoAttempt'];
    replaces?: string | null;
  }): Escalation;

  /** Send an answer back down to a waiting agent. */
  resolveEscalation(id: string, answer: string, by: 'ceo' | 'human'): void;

  /* ── Agent ↔ agent traffic ──────────────────────────────────────── */

  /** Everything the agents have said to each other, newest last. */
  messages(): AgentMessage[];
  message(id: string): AgentMessage | undefined;
  /** Files two live agents are both writing. */
  collisions(): Collision[];
  /** Put a message from the CEO into the fleet's traffic and deliver it. */
  relay(input: PeerRelay): RelayOutcome;
  /** Answer an agent's `ask` in the recipient's place. */
  answerPeer(messageId: string, answer: string): AgentMessage | null;
  /** Mark a collision decided, so it stops shouting at the operator. */
  acknowledgeCollision(id: string): Collision | null;
}

/** A message the CEO sends. It never sends an `ask`: it has nobody to wait on. */
export interface PeerRelay {
  kind: Exclude<MessageKind, 'ask'>;
  scope: 'agent' | 'project';
  toAgentId: string | null;
  toProjectId: string | null;
  subject: string;
  body: string | null;
  files: string[];
}

export interface RelayOutcome {
  messageId: string;
  /** Agents it actually reached. */
  delivered: string[];
  /** Recipients it did not reach — a cap, a dead agent, a machine that is down. */
  skipped: number;
  reason: string | null;
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
  {
    name: 'read_traffic',
    description:
      'Read what the agents have been saying to each other: notices, handoffs, warnings, and the questions one agent is waiting on another to answer. Look here before you answer anything about why something is stalled — an agent blocked on a peer looks exactly like an agent thinking hard, and this is the only place the difference shows. It also returns file collisions, which are two agents about to overwrite each other.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: {
          type: ['string', 'null'],
          description: 'Narrow to one project. Null reads the whole fleet, which is usually what you want when you do not yet know where the problem is.',
        },
        kind: {
          type: ['string', 'null'],
          description: 'One of notice, ask, handoff, warning. Null returns all of them.',
        },
        only_waiting: {
          type: 'boolean',
          description: 'Only questions still unanswered — every one of them is an agent standing still.',
        },
      },
      required: ['project_id', 'kind', 'only_waiting'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'relay',
    description:
      'Send a message from you into the fleet — to one agent, or to everyone working on a project. Use it to redirect ("stop, K9 already shipped that"), to warn about something an agent is walking into, or to pass context it has no way of knowing because it happened on another machine. That last case is the one that earns its keep: you see the whole fleet and the agents see one repo each. A message that only restates what the agent already knows costs it a turn and buys nothing.',
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['notice', 'handoff', 'warning'],
          description: 'notice: worth knowing, nobody must act. handoff: this work is now yours. warning: you are about to walk into something.',
        },
        agent_id: {
          type: ['string', 'null'],
          description: 'The one agent to tell. Null when addressing a whole project.',
        },
        project_id: {
          type: ['string', 'null'],
          description: 'Tell everyone alive on this project. Null when addressing a single agent.',
        },
        subject: { type: 'string', description: 'One line. This is what the agent sees first, and often all it reads.' },
        body: { type: ['string', 'null'], description: 'The detail, if the subject cannot carry it alone.' },
      },
      required: ['kind', 'agent_id', 'project_id', 'subject', 'body'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'answer_peer',
    description:
      'Answer a question one agent asked another, in the recipient\'s place. This is your first move whenever traffic shows an agent waiting — not your last. If you can answer it from fleet state, from recall, or from what the operator has already told you, answering here unblocks the asker at once and never wakes the agent it was addressed to: one agent moving again, and nobody interrupted. Leave it to the recipient only when the answer lives inside work that only they have done. The rule from the human channel holds here too: do not guess. A confident wrong answer sends the asker down a wrong path and the agent who actually knew never finds out it was asked.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        answer: { type: 'string', description: 'The answer as the recipient would have given it. Direct, no preamble.' },
        basis: {
          type: 'string',
          description: 'Where it came from: fleet state, a recall hit, or something the operator said. Shown in the audit trail.',
        },
      },
      required: ['message_id', 'answer', 'basis'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'resolve_collision',
    description:
      'Decide which of two agents keeps a file they are both writing, and warn the other off. A collision is work that is about to be lost in silence: whoever saves last wins, the other\'s edits disappear, and neither agent sees an error. You are the only one who can see both of them, so the call is yours. Make it fast — deciding late costs somebody an hour of output, deciding wrong costs a rewrite, and those are not the same price. Pick the agent whose mission actually owns that file; the other gets a warning telling it to stand down and why.',
    input_schema: {
      type: 'object',
      properties: {
        collision_id: { type: 'string' },
        keep_agent_id: { type: 'string', description: 'The agent that continues with the file.' },
        stand_down_agent_id: { type: 'string', description: 'The agent that must stop touching it.' },
        reason: {
          type: 'string',
          description: 'Why, in one line, written for the agent standing down. It has to be able to act on this without asking you back.',
        },
      },
      required: ['collision_id', 'keep_agent_id', 'stand_down_agent_id', 'reason'],
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
      case 'read_traffic': return readTraffic(ctx, input);
      case 'relay': return relay(ctx, input);
      case 'answer_peer': return answerPeer(ctx, input);
      case 'resolve_collision': return resolveCollision(ctx, input);
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

/* ── Agent ↔ agent traffic ────────────────────────────────────────── */

/** Callsigns read better than ids, and the operator sees callsigns too. */
function callsignOf(ctx: CeoContext, id: string | null): string | null {
  if (!id) return null;
  if (id === 'ceo') return 'CEO';
  return ctx.agent(id)?.callsign ?? id;
}

function readTraffic(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  const project = typeof input.project_id === 'string' && input.project_id ? input.project_id : null;
  const kind = typeof input.kind === 'string' && input.kind ? input.kind : null;
  const onlyWaiting = input.only_waiting === true;
  const now = Date.now();

  const all = ctx.messages();
  const picked = all
    .filter((m) => !project || m.fromProjectId === project || m.toProjectId === project)
    .filter((m) => !kind || m.kind === kind)
    .filter((m) => !onlyWaiting || (m.kind === 'ask' && m.answer === null))
    .sort((a, b) => b.at - a.at)
    // A page of traffic, not the archive: the whole point is to be readable.
    .slice(0, 40);

  const messages = picked.map((m) => ({
    message_id: m.id,
    kind: m.kind,
    from: m.fromCallsign,
    to: m.scope === 'agent'
      ? callsignOf(ctx, m.toAgentId)
      : (m.scope === 'project' ? `project ${m.toProjectId ?? '?'}` : 'the whole fleet'),
    subject: m.subject,
    body: m.body,
    files: m.files,
    age_sec: Math.max(0, Math.round((now - m.at) / 1000)),
    delivered_to: m.readBy.map((id) => callsignOf(ctx, id)),
    answer: m.answer,
    answered_by: callsignOf(ctx, m.answeredBy),
    // The only field that means someone is standing still right now.
    waiting: m.kind === 'ask' && m.answer === null,
  }));

  const collisions = ctx.collisions()
    .filter((c) => !project || c.projectId === project)
    .map((c) => ({
      collision_id: c.id,
      path: c.path,
      project: c.projectId,
      agents: c.agentIds.map((id) => callsignOf(ctx, id)),
      open_sec: Math.max(0, Math.round((now - c.firstSeen) / 1000)),
      acknowledged: c.acknowledged,
    }));

  const waiting = messages.filter((m) => m.waiting).length;
  return {
    result: JSON.stringify({ messages, collisions }, null, 1),
    summary: `read ${messages.length} message(s), ${waiting} waiting, ${collisions.length} collision(s)`,
  };
}

function relay(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  const rawKind = String(input.kind ?? 'notice');
  const kind: PeerRelay['kind'] =
    rawKind === 'handoff' || rawKind === 'warning' ? rawKind : 'notice';

  const subject = String(input.subject ?? '').trim();
  if (!subject) {
    return { result: 'a message needs a subject line', summary: 'relay refused: no subject', isError: true };
  }

  const agentRef = typeof input.agent_id === 'string' && input.agent_id ? input.agent_id : null;
  const projectRef = typeof input.project_id === 'string' && input.project_id ? input.project_id : null;
  const target = agentRef ? findAgent(ctx, agentRef) : undefined;
  if (agentRef && !target) {
    return { result: `no agent matching "${agentRef}"`, summary: 'relay failed: no such agent', isError: true };
  }
  if (!target && !projectRef) {
    return {
      result: 'name either an agent or a project. A message addressed to nobody reaches nobody.',
      summary: 'relay refused: no recipient',
      isError: true,
    };
  }
  if (projectRef && !target && !ctx.project(projectRef)) {
    return { result: `no project "${projectRef}"`, summary: 'relay failed: no such project', isError: true };
  }

  const out = ctx.relay({
    kind,
    scope: target ? 'agent' : 'project',
    toAgentId: target?.id ?? null,
    toProjectId: target ? null : projectRef,
    subject,
    body: typeof input.body === 'string' && input.body ? input.body : null,
    files: [],
  });

  const who = target ? target.callsign : `project ${projectRef ?? '?'}`;
  if (out.delivered.length === 0) {
    // Silence here is the failure mode: you would otherwise believe the fleet
    // was told something it never heard.
    return {
      result: JSON.stringify({ delivered: 0, reason: out.reason ?? 'nobody could receive it' }),
      summary: `relay to ${who} reached nobody`,
      isError: true,
    };
  }
  return {
    result: JSON.stringify({
      message_id: out.messageId,
      delivered_to: out.delivered.map((id) => callsignOf(ctx, id)),
      not_reached: out.skipped,
      note: out.reason,
    }),
    summary: `${kind} to ${who} — ${out.delivered.length} delivered`,
  };
}

function answerPeer(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  const id = String(input.message_id ?? '');
  const m = ctx.message(id);
  if (!m) return { result: `no message "${id}"`, summary: 'answer_peer failed: no such message', isError: true };
  if (m.kind !== 'ask') {
    return {
      result: 'that message is not a question — nobody is waiting on an answer to it',
      summary: 'answer_peer refused: not a question',
      isError: true,
    };
  }
  if (m.answer !== null) {
    return {
      result: `already answered by ${m.answeredBy ?? 'someone'}: ${m.answer}`,
      summary: 'answer_peer refused: already answered',
      isError: true,
    };
  }
  const answer = String(input.answer ?? '').trim();
  if (!answer) {
    return { result: 'an empty answer unblocks nobody', summary: 'answer_peer refused: empty', isError: true };
  }
  const done = ctx.answerPeer(id, answer);
  if (!done) {
    return { result: 'the hub could not deliver that answer', summary: 'answer_peer failed', isError: true };
  }
  return {
    result: JSON.stringify({
      ok: true,
      unblocked: m.fromCallsign,
      instead_of: callsignOf(ctx, m.toAgentId),
    }),
    summary: `answered ${m.fromCallsign} myself: ${String(input.basis ?? '')}`.slice(0, 120),
  };
}

function resolveCollision(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  const id = String(input.collision_id ?? '');
  const c = ctx.collisions().find((x) => x.id === id);
  if (!c) return { result: `no collision "${id}"`, summary: 'resolve_collision failed: unknown', isError: true };

  const keep = findAgent(ctx, String(input.keep_agent_id ?? ''));
  const standDown = findAgent(ctx, String(input.stand_down_agent_id ?? ''));
  if (!keep || !standDown) {
    return {
      result: 'name both agents: the one that keeps the file and the one that stands down',
      summary: 'resolve_collision refused: missing an agent',
      isError: true,
    };
  }
  if (keep.id === standDown.id) {
    return {
      result: 'those are the same agent. A collision has two sides.',
      summary: 'resolve_collision refused: same agent twice',
      isError: true,
    };
  }

  const reason = String(input.reason ?? '').trim();
  const out = ctx.relay({
    kind: 'warning',
    scope: 'agent',
    toAgentId: standDown.id,
    toProjectId: null,
    subject: `stand down on ${c.path} — ${keep.callsign} owns it`,
    body: [
      `${keep.callsign} is editing ${c.path}. Stop writing that file and do not save over it.`,
      reason,
      'If your work needs it, say so and hand the change over rather than writing it yourself.',
    ].filter(Boolean).join('\n'),
    files: [c.path],
  });
  ctx.acknowledgeCollision(c.id);

  const landed = out.delivered.length > 0;
  return {
    result: JSON.stringify({
      ok: true,
      path: c.path,
      keeps: keep.callsign,
      stood_down: standDown.callsign,
      warning_delivered: landed,
      note: landed ? null : (out.reason ?? 'the warning reached nobody — say so to the operator'),
    }),
    summary: landed
      ? `${c.path}: ${keep.callsign} keeps it, ${standDown.callsign} warned off`
      : `${c.path}: decided, but the warning to ${standDown.callsign} did not land`,
    isError: !landed,
  };
}
