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
import type { Command, SpawnAck } from '../shared/protocol.ts';
import { MAX_SQUAD_NAME, squadName, squadsOf, type Squad } from '../shared/squads.ts';
import { findPreset, squadStem, type Preset } from '../shared/fleets.ts';
import { TERMINAL_STATES } from '../shared/types.ts';

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

  /**
   * The next free `<base>-NN` squad name, recorded so the one after differs.
   * Every `launch_squad` takes one: two squads with the same label are one
   * squad to the router, and a launch must never merge into last week's.
   */
  nextSquadName(base: string): string;

  /** The fleet presets on disk — what `/launch` and `launch_squad {preset}` read. */
  fleets(): Preset[];

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
  scope: 'agent' | 'project' | 'squad';
  toAgentId: string | null;
  toProjectId: string | null;
  /** Set when scope === 'squad': the label, not an id. */
  toSquad: string | null;
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
        squad: {
          type: ['string', 'null'],
          description: 'Enlist it in a squad, e.g. "audit-01". Letters, digits, - and _, 32 chars max. Members report to their lead and never interrupt the human; use one whenever you are fanning work out and want a single answer back.',
        },
        lead: {
          type: 'boolean',
          description: 'This one leads that squad: it briefs the members, consolidates what they find, and is the only one of them allowed to reach you. Launch the lead first, then spawn the members with parent_agent_id set to it. Meaningless without squad.',
        },
      },
      required: ['project_id', 'mission', 'parent_agent_id', 'background', 'squad', 'lead'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'launch_squad',
    description:
      'Launch a whole squad in one call: a lead first, then its members hanging off it, all carrying the same squad label. This is how you make "a squad of three auditors" or "a fleet to migrate the payments module" — one brief per agent, and the lead\'s brief says how to split the work and what one consolidated answer looks like. The squad name is numbered for you (audit → audit-01, audit-02…), so launching the same squad twice never merges the two. Members report to the lead and never interrupt the human; the lead is the only door. Two ways to call it: with `preset` set to a saved fleet from list_fleets (the briefs come from disk; squad, lead_mission and members are then ignored and may be null), or with squad + lead_mission + members written here — one complete brief per agent, for an engineer who has not seen this conversation.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: {
          type: ['string', 'null'],
          description: 'Where it launches. Null only with a preset that names a project.',
        },
        preset: {
          type: ['string', 'null'],
          description: 'A saved fleet by name, from list_fleets. Null to write the briefs here.',
        },
        squad: {
          type: ['string', 'null'],
          description: 'Base name, e.g. "audit" or "payments". Letters, digits, - and _, up to 29 chars. The tool appends -NN. Null with a preset (its name is the base).',
        },
        lead_mission: {
          type: ['string', 'null'],
          description: 'The lead\'s complete brief: the goal, how to hand work to the members, what the consolidated answer must contain. It is spawned first and alone. Null with a preset.',
        },
        members: {
          type: ['array', 'null'],
          minItems: 1,
          maxItems: 12,
          description: 'One entry per member, in launch order. Each mission is that member\'s whole brief. Null with a preset.',
          items: {
            type: 'object',
            properties: {
              mission: { type: 'string' },
              model: {
                type: ['string', 'null'],
                description: 'Model id for this member, or null for the runtime\'s default.',
              },
            },
            required: ['mission', 'model'],
            additionalProperties: false,
          },
        },
        lead_model: { type: ['string', 'null'], description: 'Model id for the lead, or null for the default.' },
        background: {
          type: 'boolean',
          description: 'Background agents survive the console disconnecting. Almost always true for a squad.',
        },
      },
      required: ['project_id', 'preset', 'squad', 'lead_mission', 'members', 'lead_model', 'background'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'list_fleets',
    description:
      'The saved fleet presets: squads the operator launches more than once, each a name with one brief per agent and at most one lead. Call it when the operator says "launch the audit" or "the usual ship fleet" — then launch_squad with `preset`. The same list the console\'s /launch window shows; it lives on the hub\'s disk, not in the browser.',
    input_schema: {
      type: 'object',
      properties: {
        full: {
          type: 'boolean',
          description: 'Include every brief in full. Default is names, project, lead and one line per agent.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'inspect_squad',
    description:
      'One squad in full: its lead, every member with state and current tool, spend, who is blocked, and the questions still waiting inside it. Use it before redirecting a squad — the lead is the one to talk to — and to tell whether a quiet squad is finished, stuck on a peer, or stuck on you.',
    input_schema: {
      type: 'object',
      properties: {
        squad: { type: 'string', description: 'The label, e.g. "audit-01". "squad:audit-01" is accepted too.' },
      },
      required: ['squad'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'stop_squad',
    description:
      'Stop every live agent in a squad, members first and the lead last, so nobody is left reporting to a session that is gone. Conversations are kept and can be resumed. Use when the squad is off track as a whole or the work it was launched for no longer matters; to stop one member, use stop_agent.',
    input_schema: {
      type: 'object',
      properties: {
        squad: { type: 'string', description: 'The label, e.g. "audit-01".' },
        reason: { type: 'string' },
      },
      required: ['squad', 'reason'],
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
    name: 'remember',
    description:
      'Write something the human told you into the memory that `recall` reads. Use it the moment they state a preference, a rule or a decision that will come up again — "always deploy staging with the test key", "never touch the MX records". This is the only way the fleet gets cheaper to run over time: every rule stored here is a question that never reaches them again. Do not store one-off facts, and never store a guess of your own.',
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question this answers, phrased as an agent would ask it. This is what future recalls are matched against.',
        },
        answer: { type: 'string', description: 'The rule, in the human\'s terms. Short enough to act on without interpretation.' },
        project_id: {
          type: ['string', 'null'],
          description: 'Scope it to one repo when it only holds there. Null makes it a fleet-wide rule.',
        },
      },
      required: ['question', 'answer', 'project_id'],
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
        escalation_id: {
          type: ['string', 'null'],
          description: 'When you are passing up a question an agent already asked — the id from its [ESCALATION <id>] line — put it here. It writes your attempt onto that same record instead of creating a second one, which is the difference between the human seeing one question and seeing it twice.',
        },
      },
      required: ['question', 'context', 'options', 'urgency', 'agent_id', 'project_id', 'escalation_id'],
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
        squad: {
          type: ['string', 'null'],
          description: 'Tell every live member of this squad, wherever they run, e.g. "audit-01". Null otherwise. Name exactly one of agent_id, project_id, squad.',
        },
        subject: { type: 'string', description: 'One line. This is what the agent sees first, and often all it reads.' },
        body: { type: ['string', 'null'], description: 'The detail, if the subject cannot carry it alone.' },
      },
      required: ['kind', 'agent_id', 'project_id', 'squad', 'subject', 'body'],
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
      case 'launch_squad': return await launchSquad(ctx, input);
      case 'list_fleets': return listFleets(ctx, input);
      case 'inspect_squad': return inspectSquad(ctx, input);
      case 'stop_squad': return await stopSquad(ctx, input);
      case 'send_to_agent': return await sendToAgent(ctx, input);
      case 'stop_agent': return await stopAgent(ctx, input);
      case 'recall': return doRecall(ctx, input);
      case 'remember': return doRemember(ctx, input);
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

  const all = ctx.agents();
  const blocked = all
    .filter((a) => a.state === 'blocked')
    .map((a) => ({
      id: a.id, callsign: a.callsign, project: a.projectId,
      wants: a.block?.summary ?? null, kind: a.block?.kind ?? null,
      waiting_sec: a.block ? Math.round((Date.now() - a.block.since) / 1000) : null,
    }));

  /*
   * Los escuadrones no son un registro que consultar: son la etiqueta que
   * llevan puesta unos cuantos agentes, derivada aquí mismo. Van en el survey
   * porque sin ellos el mando ve veinte agentes sueltos donde hay tres equipos,
   * y le escribe a cada miembro en vez de a su líder.
   */
  const squads = squadsOf(all).map((sq) => ({
    name: sq.name,
    lead: sq.leaderId ? (ctx.agent(sq.leaderId)?.callsign ?? sq.leaderId) : null,
    members: sq.memberIds.map((id) => ctx.agent(id)?.callsign ?? id),
    address: `squad:${sq.name}`,
  }));

  return {
    result: JSON.stringify({ projects, blocked, squads }, null, 1),
    summary: `surveyed ${projects.length} projects, ${blocked.length} blocked`
      + (squads.length ? `, ${squads.length} squad(s)` : ''),
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
  if (mission.length < MIN_MISSION_CHARS) {
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

  // Un nombre de escuadrón inventado sería un escuadrón al que nadie puede
  // escribirle: se rechaza aquí, con el porqué, en vez de lanzarlo huérfano.
  let squad: string | null = null;
  if (input.squad !== undefined && input.squad !== null && input.squad !== '') {
    squad = squadName(input.squad);
    if (!squad) {
      return {
        result: `invalid squad name "${String(input.squad)}": letters, digits, - and _, up to 32 characters`,
        summary: 'spawn refused: bad squad name',
        isError: true,
      };
    }
  }
  const lead = squad !== null && input.lead === true;

  const data = await ctx.dispatch(p.machineId, {
    k: 'spawn',
    projectId: p.id,
    prompt: mission,
    parentId: parent?.id ?? null,
    mission,
    ...(squad ? { squad, lead } : {}),
    background: input.background !== false,
    permissionMode: 'acceptEdits',
  });

  return {
    result: JSON.stringify({ ok: true, spawned: data, squad, lead }),
    summary: `spawned an agent on ${p.code}`
      + (squad ? ` in squad ${squad}${lead ? ' as its lead' : ''}` : ''),
  };
}

/* ── Squads ───────────────────────────────────────────────────────── */

/** The most members one `launch_squad` may carry. Kept in step with the schema. */
export const MAX_SQUAD_MEMBERS = 12;

/** The shortest brief worth launching an agent on. Shared with `spawn_agent`. */
const MIN_MISSION_CHARS = 20;

/**
 * How long a launch waits for the lead to be *named* before the members go up.
 *
 * The collector already waits `SPAWN_ACK_TIMEOUT_MS` for the session to show.
 * When it gives up, the lead is running and ORCA cannot point at it yet; a
 * member launched then would go up unparented. So the launch keeps looking a
 * while longer — the session is usually seconds away. Exported as a mutable
 * object so a test can make the wait short instead of making the test slow.
 */
export const LAUNCH = { leadSettleMs: 15_000, pollMs: 500 };

const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

function modelOf(v: unknown): string | null {
  return typeof v === 'string' && MODEL_RE.test(v) ? v : null;
}

/** "audit-01" or "squad:audit-01" — the operator types both. */
function squadRef(v: unknown): string | null {
  const raw = String(v ?? '').trim();
  return squadName(raw.startsWith('squad:') ? raw.slice('squad:'.length) : raw);
}

function findSquad(ctx: CeoContext, ref: string): Squad | undefined {
  return squadsOf(ctx.agents()).find((s) => s.name === ref);
}

function noSuchSquad(ctx: CeoContext, ref: string, verb: string): ToolOutcome {
  const known = squadsOf(ctx.agents()).map((s) => s.name);
  return {
    result: `no squad "${ref}".` + (known.length ? ` Squads on the fleet: ${known.join(', ')}` : ' The fleet has no squads.'),
    summary: `${verb} failed: no squad ${ref}`,
    isError: true,
  };
}

/**
 * Wait for the lead's session to be named, past the collector's own wait.
 * Returns its id, or null when it still has not shown — the launch then goes
 * on with unparented members and says so, which beats a squad that never
 * launched.
 */
async function settleLead(ctx: CeoContext, squad: string, shortId: string | null): Promise<string | null> {
  const until = Date.now() + LAUNCH.leadSettleMs;
  for (;;) {
    const hit = ctx.agents().find((a) =>
      (a.squad === squad && a.lead) || (shortId !== null && a.shortId === shortId));
    if (hit) return hit.id;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, LAUNCH.pollMs));
  }
}

/** One agent of a launch plan, whichever door it came in through. */
interface PlannedAgent {
  /** One line: the tile's title. */
  mission: string;
  /** The whole brief. Inline launches use the mission for both. */
  prompt: string;
  model: string | null;
  runtime: string | null;
}

interface LaunchPlan {
  base: string;
  /** A preset may fix the label; then it is not numbered. */
  fixedSquad: string | null;
  lead: PlannedAgent | null;
  members: PlannedAgent[];
  /** Project code the preset prefers, when the call named none. */
  projectCode: string | null;
  source: string;
}

function planFromInline(input: Record<string, unknown>): LaunchPlan | ToolOutcome {
  const base = squadName(input.squad);
  const room = MAX_SQUAD_NAME - 3;
  if (!base || base.length > room) {
    return {
      result: `invalid squad name "${String(input.squad ?? '')}": letters, digits, - and _, up to ${room} characters (the tool appends -NN)`,
      summary: 'launch refused: bad squad name',
      isError: true,
    };
  }
  const leadMission = String(input.lead_mission ?? '').trim();
  if (leadMission.length < MIN_MISSION_CHARS) {
    return {
      result: 'lead_mission too thin. The lead needs the goal, how to split the work, and what the consolidated answer must contain.',
      summary: 'launch refused: lead mission too thin',
      isError: true,
    };
  }
  const rawMembers = Array.isArray(input.members) ? input.members : [];
  if (rawMembers.length === 0) {
    return { result: 'a squad needs at least one member. For a single agent, use spawn_agent.', summary: 'launch refused: no members', isError: true };
  }
  if (rawMembers.length > MAX_SQUAD_MEMBERS) {
    return {
      result: `${rawMembers.length} members is too many for one squad (max ${MAX_SQUAD_MEMBERS}). Split it, or brief fewer, better.`,
      summary: 'launch refused: too many members',
      isError: true,
    };
  }
  const members: PlannedAgent[] = rawMembers.map((m) => {
    const o = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>;
    const mission = String(o.mission ?? '').trim();
    return { mission, prompt: mission, model: modelOf(o.model), runtime: null };
  });
  const thin = members.findIndex((m) => m.mission.length < MIN_MISSION_CHARS);
  if (thin >= 0) {
    return {
      result: `member ${thin + 1} has a mission too thin to act on. Every member needs a complete brief.`,
      summary: `launch refused: member ${thin + 1} mission too thin`,
      isError: true,
    };
  }
  return {
    base, fixedSquad: null,
    lead: { mission: leadMission, prompt: leadMission, model: modelOf(input.lead_model), runtime: null },
    members, projectCode: null, source: 'inline briefs',
  };
}

function planFromPreset(ctx: CeoContext, name: string): LaunchPlan | ToolOutcome {
  const preset = findPreset(ctx.fleets(), name);
  if (!preset) {
    const known = ctx.fleets().map((p) => p.name);
    return {
      result: `no fleet preset "${name}".` + (known.length ? ` Saved presets: ${known.join(', ')}` : ' None are saved; write the briefs inline instead.'),
      summary: `launch refused: no preset ${name}`,
      isError: true,
    };
  }
  const toPlanned = (a: Preset['agents'][number]): PlannedAgent => ({
    mission: a.mission, prompt: a.prompt, model: modelOf(a.model), runtime: a.runtime ?? null,
  });
  const leadAgent = preset.agents.find((a) => a.lead) ?? null;
  return {
    base: squadStem(preset.name),
    fixedSquad: preset.squad ?? null,
    lead: leadAgent ? toPlanned(leadAgent) : null,
    members: preset.agents.filter((a) => a !== leadAgent).map(toPlanned),
    projectCode: preset.project ?? null,
    source: `preset ${preset.name}`,
  };
}

async function launchSquad(ctx: CeoContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  // Everything is checked before anything is launched. A squad that fails
  // on member three has a lead and two members running for nothing.
  const presetName = typeof input.preset === 'string' && input.preset.trim() ? input.preset.trim() : null;
  const plan = presetName ? planFromPreset(ctx, presetName) : planFromInline(input);
  if ('summary' in plan) return plan;

  const projectRef = typeof input.project_id === 'string' && input.project_id ? input.project_id : null;
  const p = projectRef
    ? ctx.project(projectRef)
    : plan.projectCode
      ? ctx.projects().find((x) => x.code.toUpperCase() === plan.projectCode!.toUpperCase())
      : undefined;
  if (!p) {
    return {
      result: projectRef
        ? `no project "${projectRef}"`
        : plan.projectCode
          ? `the preset names project code "${plan.projectCode}" and no machine is reporting it. Pass project_id.`
          : 'name a project_id: the preset does not say where it launches.',
      summary: 'launch refused: no project',
      isError: true,
    };
  }

  const background = input.background !== false;
  const squad = plan.fixedSquad ?? ctx.nextSquadName(plan.base);

  const spawn = (a: PlannedAgent, parentId: string | null, lead: boolean): Command => ({
    k: 'spawn',
    projectId: p.id,
    prompt: a.prompt,
    parentId,
    mission: a.mission,
    squad,
    lead,
    ...(a.model ? { model: a.model } : {}),
    ...(a.runtime ? { runtime: a.runtime } : {}),
    background,
    permissionMode: 'acceptEdits',
  });

  // The lead goes up first and alone: a squad has a head before it has
  // members, or the members' footers name a lead that does not exist.
  let leadId: string | null = null;
  let leadCallsign: string | null = null;
  if (plan.lead) {
    const leadAck = (await ctx.dispatch(p.machineId, spawn(plan.lead, null, true))) as SpawnAck | undefined;
    leadId = leadAck?.agentId ?? null;
    if (!leadId) leadId = await settleLead(ctx, squad, leadAck?.shortId ?? null);
    leadCallsign = leadAck?.callsign ?? (leadId ? ctx.agent(leadId)?.callsign ?? null : null);
  }

  const launched: { member: number; agent_id: string | null; callsign: string | null }[] = [];
  const failures: { member: number; error: string }[] = [];
  for (const [i, m] of plan.members.entries()) {
    try {
      const ack = (await ctx.dispatch(p.machineId, spawn(m, leadId, false))) as SpawnAck | undefined;
      launched.push({ member: i + 1, agent_id: ack?.agentId ?? null, callsign: ack?.callsign ?? null });
    } catch (err) {
      // One member failing does not abort the rest: the lead is already up and
      // waiting for people. The failure is reported, not hidden in a throw.
      failures.push({ member: i + 1, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const notes: string[] = [];
  if (!plan.lead) {
    notes.push('this preset marks no lead: the members went up as peers with nobody consolidating. Talk to them through the squad address.');
  } else if (!leadId) {
    notes.push('the lead was launched but its session had not appeared when the members went up, so they are unparented. They still address the squad by name; list_fleet will show the lead once it reports.');
  }
  if (failures.length) notes.push(`${failures.length} member(s) failed to launch; see failures.`);

  return {
    result: JSON.stringify({
      ok: failures.length === 0,
      squad,
      address: `squad:${squad}`,
      project: p.code,
      source: plan.source,
      lead: plan.lead ? { agent_id: leadId, callsign: leadCallsign } : null,
      members: launched,
      failures,
      note: notes.length ? notes.join(' ') : null,
    }, null, 1),
    summary: `launched squad ${squad} on ${p.code} from ${plan.source}: `
      + (plan.lead ? `lead ${leadCallsign ?? '(pending)'}, ` : 'no lead, ')
      + `${launched.length}/${plan.members.length} members`
      + (failures.length ? `, ${failures.length} failed` : ''),
    // Every member failing is a launch that did not happen; one failing is a
    // launch the model has to look at. Both are readable, only one is an error.
    ...(failures.length === plan.members.length ? { isError: true } : {}),
  };
}

function listFleets(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  const full = input.full === true;
  const presets = ctx.fleets().map((p) => ({
    name: p.name,
    project: p.project ?? null,
    squad: p.squad ?? `${squadStem(p.name)}-NN`,
    lead: p.agents.find((a) => a.lead)?.mission ?? null,
    agents: p.agents.map((a) => (full
      ? { mission: a.mission, prompt: a.prompt, model: a.model ?? null, runtime: a.runtime ?? null, lead: a.lead === true }
      : { mission: a.mission, lead: a.lead === true })),
  }));
  return {
    result: presets.length
      ? JSON.stringify({ presets }, null, 1)
      : 'no fleet presets are saved. Write the briefs inline in launch_squad, or save a preset from the console\'s /launch window.',
    summary: presets.length ? `${presets.length} fleet preset(s): ${presets.map((p) => p.name).join(', ')}` : 'no fleet presets',
  };
}

function inspectSquad(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  const ref = squadRef(input.squad);
  if (!ref) return { result: 'name the squad, e.g. "audit-01"', summary: 'inspect_squad refused: no name', isError: true };
  const sq = findSquad(ctx, ref);
  if (!sq) return noSuchSquad(ctx, ref, 'inspect_squad');

  const describe = (id: string) => {
    const a = ctx.agent(id);
    if (!a) return { id, callsign: id, state: 'unknown' };
    return {
      id: a.id, callsign: a.callsign, state: a.state, lead: a.lead,
      tool: a.tool, tool_detail: a.toolDetail, mission: a.mission,
      blocked_on: a.block?.summary ?? null,
      spend_usd: Number(a.metrics.costUSD.toFixed(2)),
      uptime_sec: Math.round(a.uptimeMs / 1000),
    };
  };
  const members = sq.memberIds.map(describe);
  const agents = sq.memberIds.map((id) => ctx.agent(id)).filter((a): a is Agent => !!a);
  const ids = new Set(sq.memberIds);

  // What is still waiting inside it: an unanswered ask from, to, or addressed
  // at the squad. A quiet squad with three of these is not finished, it is stuck.
  const waiting = ctx.messages()
    .filter((m) => m.kind === 'ask' && m.answer === null)
    .filter((m) => ids.has(m.fromAgentId) || (m.toAgentId !== null && ids.has(m.toAgentId)) || m.toSquad === sq.name)
    .map((m) => ({
      message_id: m.id, from: m.fromCallsign,
      to: m.toAgentId ? callsignOf(ctx, m.toAgentId) : (m.toSquad ? `squad ${m.toSquad}` : 'project'),
      subject: m.subject, age_sec: Math.max(0, Math.round((Date.now() - m.at) / 1000)),
    }));

  const alive = agents.filter((a) => !TERMINAL_STATES.has(a.state)).length;
  const blocked = agents.filter((a) => a.state === 'blocked').length;
  const spend = agents.reduce((s, a) => s + a.metrics.costUSD, 0);

  return {
    result: JSON.stringify({
      name: sq.name,
      address: `squad:${sq.name}`,
      lead: sq.leaderId ? describe(sq.leaderId) : null,
      members,
      totals: { members: members.length, alive, blocked, spend_usd: Number(spend.toFixed(2)) },
      waiting,
    }, null, 1),
    summary: `inspected squad ${sq.name}: ${alive}/${members.length} alive, ${blocked} blocked, ${waiting.length} waiting`,
  };
}

async function stopSquad(ctx: CeoContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const ref = squadRef(input.squad);
  if (!ref) return { result: 'name the squad, e.g. "audit-01"', summary: 'stop_squad refused: no name', isError: true };
  const sq = findSquad(ctx, ref);
  if (!sq) return noSuchSquad(ctx, ref, 'stop_squad');

  // Members first, the lead last: a lead that dies first leaves members
  // reporting into nothing until their own stop arrives.
  const order = [...sq.memberIds.filter((id) => id !== sq.leaderId), ...(sq.leaderId ? [sq.leaderId] : [])];
  const live = order
    .map((id) => ctx.agent(id))
    .filter((a): a is Agent => !!a && !TERMINAL_STATES.has(a.state));
  if (live.length === 0) {
    return { result: `squad ${sq.name} has nobody alive to stop`, summary: `stop_squad: ${sq.name} already over`, isError: true };
  }

  const stopped: string[] = [];
  const failed: { callsign: string; error: string }[] = [];
  for (const a of live) {
    try {
      await ctx.dispatch(a.machineId, { k: 'stop', agentId: a.id });
      stopped.push(a.callsign);
    } catch (err) {
      failed.push({ callsign: a.callsign, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    result: JSON.stringify({ ok: failed.length === 0, squad: sq.name, stopped, failed }, null, 1),
    summary: `stopped squad ${sq.name} (${stopped.length}/${live.length}): ${String(input.reason ?? '')}`.slice(0, 120),
    ...(stopped.length === 0 ? { isError: true } : {}),
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

/**
 * Guardar una regla del humano.
 *
 * Es la otra mitad de `recall`, y la que hace que la flota se abarate con el
 * tiempo: una regla guardada aquí es una pregunta que nadie va a volver a
 * hacerle a la persona. Se rechaza lo vacío porque una entrada sin contenido
 * ensucia la memoria para siempre y nadie la ve.
 */
function doRemember(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  const question = String(input.question ?? '').trim();
  const answer = String(input.answer ?? '').trim();
  if (!question || !answer) {
    return {
      result: 'both the question and the rule are required. A rule with no question attached is never recalled.',
      summary: 'remember refused: empty',
      isError: true,
    };
  }
  const pid = typeof input.project_id === 'string' && input.project_id ? input.project_id : null;
  ctx.remember(question, answer, pid);
  return {
    result: JSON.stringify({ ok: true, scope: pid ?? 'fleet' }),
    summary: `remembered: ${answer}`.slice(0, 120),
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
    // Pasar hacia arriba una pregunta que un agente YA hizo se anota sobre ese
    // registro. Sin esto el humano vería la misma duda dos veces: la del agente
    // y la del mando repitiéndola.
    replaces: typeof input.escalation_id === 'string' && input.escalation_id
      ? input.escalation_id : null,
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
  const squadRaw = typeof input.squad === 'string' && input.squad ? input.squad : null;
  const target = agentRef ? findAgent(ctx, agentRef) : undefined;
  if (agentRef && !target) {
    return { result: `no agent matching "${agentRef}"`, summary: 'relay failed: no such agent', isError: true };
  }
  // A squad is addressed by name and must exist right now: "squad:audit-01"
  // with nobody in it is a typo, and the hub will not degrade it to a broadcast.
  const squad = squadRaw ? squadRef(squadRaw) : null;
  if (squadRaw && !squad) {
    return { result: `invalid squad name "${squadRaw}"`, summary: 'relay refused: bad squad name', isError: true };
  }
  if (squad && !findSquad(ctx, squad)) return noSuchSquad(ctx, squad, 'relay');

  const named = [target ? 1 : 0, !target && projectRef ? 1 : 0, squad ? 1 : 0].reduce((a, b) => a + b, 0);
  if (named === 0) {
    return {
      result: 'name an agent, a project, or a squad. A message addressed to nobody reaches nobody.',
      summary: 'relay refused: no recipient',
      isError: true,
    };
  }
  if (named > 1) {
    return {
      result: 'name exactly one recipient: an agent, a project, or a squad — not several.',
      summary: 'relay refused: ambiguous recipient',
      isError: true,
    };
  }
  if (projectRef && !target && !squad && !ctx.project(projectRef)) {
    return { result: `no project "${projectRef}"`, summary: 'relay failed: no such project', isError: true };
  }

  const scope: PeerRelay['scope'] = target ? 'agent' : squad ? 'squad' : 'project';
  const out = ctx.relay({
    kind,
    scope,
    toAgentId: target?.id ?? null,
    toProjectId: scope === 'project' ? projectRef : null,
    toSquad: squad,
    subject,
    body: typeof input.body === 'string' && input.body ? input.body : null,
    files: [],
  });

  const who = target ? target.callsign : squad ? `squad ${squad}` : `project ${projectRef ?? '?'}`;
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
    toSquad: null,
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
