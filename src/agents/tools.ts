import type { TaskStore } from '../hub/tasks.ts';
import type { CapcomTask, TaskMessage } from '../shared/tasks.ts';
import { budgetLimit, hasLimit, type AgentBudget, type BudgetConfig, type BudgetLimit, type BudgetScope, type ScopeBudget } from '../hub/budgets.ts';
/**
 * CAPCOM's tool surface — what the hub's MCP server offers the command session.
 *
 * Deliberately small: these are the tools of a commander, the levers over a
 * fleet. The repo-touching tools (Bash, Edit, Write) CAPCOM already has from
 * its own CLI, in its own directory, and they are not the hub's business.
 *
 * Two tools carry the product's whole thesis:
 *   ask_human      — CAPCOM admits it cannot answer and interrupts the human
 *   answer_agent   — CAPCOM answers on the human's behalf, from memory
 * Every question an agent raises must end in exactly one of those.
 *
 * The traffic tools are the same idea one level down. Agents ask each other
 * things too, and an agent waiting on another agent is just as stopped as one
 * waiting on a person — with nobody watching. CAPCOM is the only party that
 * sees every agent at once, so answer_peer and resolve_collision are where it
 * can end a wait that neither side can see the shape of.
 *
 * The names in this file still say "CEO" (CeoContext, CEO_TOOLS): that was the
 * API-driven commander removed on 2026-09-06. The identifiers are shared with
 * persisted state and the console protocol, so they are renamed separately.
 */

import type {
  Agent, AgentMessage, Collision, Escalation, MessageKind, Project,
} from '../shared/types.ts';
import type { Command, SpawnAck } from '../shared/protocol.ts';
import { MAX_SQUAD_NAME, squadName, squadsOf, type Squad } from '../shared/squads.ts';
import { findPreset, squadStem, type Preset } from '../shared/fleets.ts';
import { TERMINAL_STATES } from '../shared/types.ts';
import { CAMERA_PENDING_MS, findAgentRef, type CameraDirective, type CameraWhat } from '../shared/camera.ts';
import { archivableState, parseAge, type ArchiveFilter, type ArchiveOutcome } from '../shared/archive.ts';
import { excludedWorkspace, refusalFor } from '../shared/workspaces.ts';
import type { InterruptOutcome } from '../shared/interrupt.ts';
import { newId } from '../shared/protocol.ts';
// Type-only: the shapes the collector answers `land` and `discard` with.
import type { DiscardResult, LandResult } from '../collector/worktrees.ts';
import { EXTENSION_TOOLS, runExtension } from './extensions.ts';
import { HYGIENE_TOOLS, runHygieneTool } from './tools-hygiene.ts';
import { briefingLines as journalBriefingLines } from './tools-journal.ts';
import type { AutonomyApi } from '../hub/autonomy.ts';
import { handoffText } from '../shared/handoff.ts';

/** Everything the tools are allowed to reach. The hub supplies this. */
export interface CeoContext {
  handoffs?(): import('../shared/handoff.ts').CapcomHandoff[];
  /** Las piezas del squad autonomy montadas en el hub (wake, verify, land, budget, journal). */
  autonomy?: AutonomyApi;
  tasks?: Pick<TaskStore, 'get' | 'assign' | 'message' | 'bindSquad' | 'all'>;
  /** Read-only view of the fleet. */
  agents(): Agent[];
  projects(): Project[];
  agent(id: string): Agent | undefined;
  project(id: string): Project | undefined;
  escalation(id: string): Escalation | undefined;
  /** Every escalation the hub still holds, any status. `briefing` reads it. */
  escalations?(): Escalation[];
  /** The rules `remember` stored, newest first. `briefing` shows the latest. */
  rules?(limit: number): { question: string; answer: string; projectId: string | null; at: number }[];

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

  /**
   * Archive finished agents (done/dead) matching a filter: they leave the
   * fleet and stay out until the session is resumed. `dryRun` only counts.
   * Never touches a live agent, whatever the filter says.
   */
  archiveAgents(filter: ArchiveFilter, opts: { dryRun?: boolean; by?: string }): ArchiveOutcome;

  /**
   * Point every connected console's camera at something. Returns how many
   * consoles heard it — zero is not an error, it is "nobody is looking".
   * Optional because the fleet is commandable without a console at all.
   */
  show?(directive: CameraDirective): number;

  /**
   * What ORCA costs the machines it runs on: the newest report per machine and
   * the fleet roll-up. Optional because a hub with no collector attached has
   * nothing to report, and the tools say so rather than inventing a zero.
   */
  hygiene?: {
    all(): import('../shared/hygiene.ts').HygieneReport[];
    get(machineId: string): import('../shared/hygiene.ts').HygieneReport | undefined;
    fleet(): import('../hub/hygiene.ts').FleetHygiene;
    /** Ask every connected collector to sample now. Returns how many were asked. */
    refresh(force?: boolean): number;
  };

  /**
   * Budgets: ceilings in dollars and minutes on an agent, a squad or a task.
   * The hub's book keeps them and watches the fleet; the tools only set and
   * read. Optional because a fleet is commandable with no book at all.
   */
  budgets?: BudgetContext;
}

/** The book of budgets, with the fleet already bound to it. */
export interface BudgetContext {
  set(scope: BudgetScope, limit: BudgetLimit): void;
  get(scope: BudgetScope): BudgetLimit | null;
  /** For an agent the spawn ack could only name by short id. */
  setPendingByShortId(shortId: string, limit: BudgetLimit): void;
  agentStatus(agent: Agent): AgentBudget;
  scopeStatus(scope: BudgetScope): ScopeBudget | null;
  config(): BudgetConfig;
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

/** One tool as the MCP server advertises it: name, prose, and a JSON Schema for its input. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Every property listed, none extra: the model cannot forget an argument. */
  strict?: boolean;
}

export const CEO_TOOLS: ToolSpec[] = [
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
    name: 'list_agents',
    description:
      'The agents themselves, newest first: id, callsign, state, project, squad, runtime, who launched it and when, and the mission in one line. This is how you answer "which agents did I spawn lately", "who is in AX", "what is running". Name them by callsign in your reply: callsigns are clickable on the console and fly the camera to the tile.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: ['string', 'null'], description: 'Only this project (id or code). Null for every project.' },
        squad: { type: ['string', 'null'], description: 'Only this squad, e.g. "audit-01". Null for everyone.' },
        state: { type: ['string', 'null'], description: 'Only this state: booting, thinking, working, blocked, idle, done, dead. Null for any.' },
        include_finished: { type: 'boolean', description: 'Also list done and dead agents. Default false.' },
        include_hidden: { type: 'boolean', description: 'Also list sessions that are not on the fleet: CAPCOM\'s previous sessions and anything running in CAPCOM\'s own directory or a session scratchpad. False unless the operator asks what is left in there.' },
        limit: { type: 'integer', description: 'At most this many, newest first. Default 20, max 100.' },
      },
      required: ['project_id', 'squad', 'state', 'include_finished', 'include_hidden', 'limit'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'show',
    description:
      'Move the operator\'s camera on the console to something: one agent, several agents, a squad, a project, or the whole fleet. The console flies there and selects it. Use it whenever the operator asks where something is, or to show, find, look at or go to something ("show me K9", "where is the audit squad", "take me to the agent that is running the tests", "zoom out"). After spawn_agent or launch_squad the console flies to what went up on its own, so you need not call it for that. `open` also opens the thing\'s window.',
    input_schema: {
      type: 'object',
      properties: {
        what: { type: 'string', enum: ['agent', 'agents', 'squad', 'project', 'fleet'] },
        refs: {
          type: 'array', items: { type: 'string' },
          description: 'What to look at: agent ids or callsigns (agent, agents), one squad name (squad), one project id or code (project). Empty for fleet.',
        },
        open: { type: 'boolean', description: 'Also open its window (the agent, the squad, the project, the fleet). Default false: just fly.' },
        note: { type: ['string', 'null'], description: 'One short line the operator sees in their feed, e.g. "K9 · running the tests". Null for none.' },
      },
      required: ['what', 'refs', 'open', 'note'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'report_task',
    description: 'Publish a reply or final result to the exact ORCA task conversation. Required for every ORCA TASK message: prose in the CLI alone does not reach the task. Assign existing workers by full ID if reusing them.',
    input_schema: { type: 'object', properties: {
      task_id: { type: 'string' }, text: { type: 'string' },
      status: { type: 'string', enum: ['active', 'completed', 'failed'] },
      agent_ids: { type: 'array', items: { type: 'string' }, description: 'Existing worker IDs to associate, or empty. Spawned agents are associated automatically by task_id.' },
    }, required: ['task_id', 'text', 'status', 'agent_ids'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'list_tasks',
    description:
      'The ORCA task conversations — the ones the operator opens with NEW TASK and that reach you as [ORCA TASK <id>] messages — newest activity first. Each comes with its status, its assigned agents (callsign and state), when it last moved, and whether it is waiting on you: a human message with no report_task reply after it, or worker results nobody has reported. This is how you find out what you owe without remembering it: after a restart or a compaction, call briefing first and then this with only_pending.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: ['string', 'null'], enum: ['active', 'completed', 'failed', null], description: 'Only tasks in this status. Null for all.' },
        only_pending: { type: 'boolean', description: 'Only tasks that are waiting on you: an unanswered human message or unreported worker results.' },
        limit: { type: 'integer', description: 'At most this many, newest activity first. Default 20, max 100.' },
      },
      required: ['status', 'only_pending', 'limit'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'inspect_task',
    description:
      'One ORCA task in full: the whole conversation, every assigned agent with its current state and last result, and exactly what is still owed — the human messages with no reply after them and the worker results not yet reported. Read it before you report_task on a task you do not remember: the conversation on the hub is the record, not your context.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task id, e.g. "task_ab12".' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'briefing',
    description:
      'A situation report in one call, written for a CAPCOM that remembers nothing: agents blocked and what they are asking, tasks waiting on a reply, workers that finished recently with results nobody reported, squads with no live member left, projects with activity, and the latest rules the operator stored. Short and dense, capped per section. Call it FIRST in a new session and again right after every context compaction, before you act on anything; then inspect_task, inspect_agent or list_agents for whatever needs detail.',
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: ['number', 'null'], description: 'How far back "recently finished" reaches, in hours. Null for the default of 6.' },
      },
      required: ['hours'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'spawn_agent',
    description:
      'Launch a new coding agent (Claude Code by default, or Codex) on a project with a mission. The mission is the whole brief the agent wakes up with, so write it as you would write a task for a capable engineer who has not seen the conversation: what to do, what done looks like, what not to touch. Prefer one well-briefed agent over three vague ones.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        task_id: { type: ['string', 'null'], description: 'The ORCA TASK id from the current conversation; null for legacy commands.' },
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
        model: { type: ['string', 'null'], description: 'Exact model ID, e.g. gpt-6-astra with runtime codex. Null uses the runtime default.' },
        runtime: {
          type: ['string', 'null'],
          description: 'Which CLI runs it: "claude" (default) or "codex". Both run on their subscriptions. Pick codex for a second opinion, a GPT-6 pass, or when the human asks for it; null means claude.',
        },
        permission_mode: {
          type: ['string', 'null'],
          enum: ['auto', 'acceptEdits', 'plan', 'bypassPermissions', null],
          description: 'How much the worker may do without asking. Null or "auto" (the default): the CLI decides by itself and never leaves a prompt waiting on a screen nobody watches. "plan": read-only reconnaissance, it cannot change anything. "bypassPermissions": it never stops to ask — only when the operator has explicitly asked for that. "acceptEdits": edits go through but shell commands ask — only when the operator will be sitting at its terminal.',
        },
        budget_usd: {
          type: ['number', 'null'],
          description: 'Spend ceiling for this agent in dollars. At 80% you get a [BUDGET 80%] line; at 100% the hub stops it if it has made no progress lately, and only warns you if it is still working. Null: the ORCA_DEFAULT_BUDGET_USD default, or no limit.',
        },
        budget_min: {
          type: ['number', 'null'],
          description: 'Time ceiling for this agent in minutes of wall clock since launch, same rules. Null: the ORCA_DEFAULT_BUDGET_MIN default, or no limit.',
        },
      },
      required: ['project_id', 'mission', 'parent_agent_id', 'background', 'squad', 'lead', 'runtime', 'model', 'task_id', 'permission_mode', 'budget_usd', 'budget_min'],
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
        task_id: { type: ['string', 'null'], description: 'ORCA TASK id for these agents; null for legacy commands.' },
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
        runtime: { type: ['string', 'null'], enum: ['claude', 'codex', null], description: 'Runtime for all inline squad briefs. With a preset, each agent uses its saved runtime.' },
        lead_model: { type: ['string', 'null'], description: 'Model id for the lead, or null for the default.' },
        background: {
          type: 'boolean',
          description: 'Background agents survive the console disconnecting. Almost always true for a squad.',
        },
        permission_mode: {
          type: ['string', 'null'],
          enum: ['auto', 'acceptEdits', 'plan', 'bypassPermissions', null],
          description: 'How much every agent of the squad may do without asking. Null or "auto" (the default): the CLI decides by itself and never leaves a prompt waiting. "plan": read-only. "bypassPermissions": never asks — only when the operator explicitly asked for that. "acceptEdits": shell commands ask — only with the operator at the terminal.',
        },
        budget_usd: { type: ['number', 'null'], description: 'Spend ceiling in dollars for EACH agent of the squad, lead included. Null: the ORCA_DEFAULT_BUDGET_USD default, or none.' },
        budget_min: { type: ['number', 'null'], description: 'Time ceiling in minutes for EACH agent. Null: the default, or none.' },
        squad_budget_usd: { type: ['number', 'null'], description: 'Spend ceiling in dollars for the WHOLE squad, summed over every member. At 100% the members that have gone quiet are stopped; the ones still working are reported. Null: none.' },
        squad_budget_min: { type: ['number', 'null'], description: 'Time ceiling in minutes for the whole squad, wall clock since the lead went up. Null: none.' },
        shared_worktree: {
          type: 'boolean',
          description: 'Only matters when the collector runs workers in git worktrees (ORCA_WORKTREES=1). True: the whole squad shares one worktree and one branch, named after the squad, so members see each other\'s files and `land` integrates them together. False (the default): one worktree per member, landed one by one. Share it when the members edit the same files on purpose; keep them apart when they should not.',
        },
      },
      required: ['project_id', 'preset', 'squad', 'lead_mission', 'members', 'lead_model', 'background', 'runtime', 'task_id', 'permission_mode', 'budget_usd', 'budget_min', 'squad_budget_usd', 'squad_budget_min', 'shared_worktree'],
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
    name: 'interrupt_agent',
    description:
      'Cancel the turn an agent is in the middle of — the Esc an operator would press — and optionally tell it what to do instead in the same breath. Use this the moment you see an agent going the wrong way: send_to_agent waits for it to finish first, which on a ten-minute detour is ten wasted minutes, and stop_agent kills the session instead of the turn. Nothing is lost: same session, same id, same context, and whatever it already wrote stays on disk. Only sessions ORCA hosts in a pane can be interrupted; a background session answers unsupported and says why, and you should NOT then stop it as a substitute unless you actually want it dead. Read the result: `interrupt` says whether the cancel key went out, `message` says whether your text was pasted or queued, and `evidence` says whether the CLI itself recorded the turn as interrupted — "pending" means the key was delivered and the acknowledgement has not appeared yet, not that it failed. It never claims the agent has read your text.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The agent, by id or callsign like "K9".' },
        text: {
          type: ['string', 'null'],
          description: 'What it should do instead, delivered with the cancel. Null to just stop the turn and leave it waiting.',
        },
        reason: { type: 'string', description: 'Why you are cutting in. One line, for the audit trail.' },
      },
      required: ['agent_id', 'text', 'reason'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'set_budget',
    description:
      'Put a spend or time ceiling on one agent, one squad (shared by every member) or one ORCA task (shared by every agent assigned to it), or change one already set. Name exactly one of agent_id, squad, task_id. Both limits null removes the budget. The hub warns you at 80% with a [BUDGET 80%] line; at 100% it stops agents that have made no progress in the last few minutes (ORCA_BUDGET_ACTION=stop, the default) and only reports the ones still working. Raising a budget re-arms its warnings, so this is also how you let an over-budget agent go on. Returns the current spend against the new ceiling.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: ['string', 'null'], description: 'Agent id or callsign. Null unless this is an agent budget.' },
        squad: { type: ['string', 'null'], description: 'Squad label, e.g. "audit-01". Null unless this is a squad budget.' },
        task_id: { type: ['string', 'null'], description: 'ORCA task id, e.g. "task_ab12". Null unless this is a task budget.' },
        budget_usd: { type: ['number', 'null'], description: 'Dollars, or null for no dollar limit.' },
        budget_min: { type: ['number', 'null'], description: 'Minutes of wall clock, or null for no time limit.' },
      },
      required: ['agent_id', 'squad', 'task_id', 'budget_usd', 'budget_min'],
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
    name: 'archive_agents',
    description:
      'Archive finished agents — state done or dead — so they stop cluttering list_fleet, list_agents and the console. Filters combine: a project, a squad, how long ago they finished (older_than_hours), one of the two states, or nothing for every finished agent. Live agents (booting, thinking, working, blocked, idle) are never archived, whatever you pass; a finished parent whose children are still alive is kept and reported. A squad whose last member is archived disappears with it. Nothing on disk is deleted: the transcript stays and a resumed session comes back on its own. Call with dry_run true first — it answers exactly what would go — then again with dry_run false.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: ['string', 'null'], description: 'Only this project (id or code). Null for every project.' },
        squad: { type: ['string', 'null'], description: 'Only this squad, e.g. "audit-01". Null for everyone.' },
        older_than_hours: { type: ['number', 'null'], description: 'Only agents that finished at least this many hours ago, e.g. 24. Null for any age.' },
        state: { type: ['string', 'null'], enum: ['done', 'dead', null], description: 'Only this terminal state. Null for both.' },
        hidden: { type: 'boolean', description: 'Only finished sessions that are not on the fleet: what was left in CAPCOM\'s own directory or in a session scratchpad. Use it to clear that backlog for good; false for ordinary archiving.' },
        dry_run: { type: 'boolean', description: 'True: report what would be archived and change nothing. False: archive it.' },
      },
      required: ['project_id', 'squad', 'older_than_hours', 'state', 'hidden', 'dry_run'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'land',
    description:
      'Integrate a worker\'s branch into the project\'s branch. Only for agents the collector launched in a worktree of their own (it runs with ORCA_WORKTREES=1; inspect_agent shows `worktree` and `branch`). What happens, in order: whatever the worker left uncommitted is committed on its branch; the branch is rebased onto the project\'s current branch inside the worktree; the project\'s test suite runs there (package.json scripts.test, a Makefile `test` target, Cargo, Go, pytest, or `test` in <project>/.orca/land.json); and if it passes, ONE commit lands on the project branch naming the callsign and the task. A conflict or a failing suite lands NOTHING: the result says why, with the conflicting files or the suite\'s output, and the project branch is untouched — then decide: send the files back to the worker with send_to_agent, resolve it yourself, or discard. With a squad, every worktree its members have is landed (a shared one, once).',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: ['string', 'null'], description: 'The worker, by id or callsign like "K9". Null when landing a squad.' },
        squad: { type: ['string', 'null'], description: 'Land every worktree of this squad, e.g. "audit-01". Null when landing one agent.' },
        run_tests: { type: 'boolean', description: 'Run the project suite in the rebased worktree before committing. True unless the operator said otherwise.' },
        message: { type: ['string', 'null'], description: 'Commit title. Null for "land <callsign>: <mission>".' },
      },
      required: ['agent_id', 'squad', 'run_tests', 'message'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'discard',
    description:
      'Throw away a worker\'s worktree and branch. Refused while it holds unlanded work — uncommitted changes, or commits the project branch does not have — unless force is true, so nothing is lost by accident. A worker that was landed and then archived or removed loses its worktree on its own; this is for work you have decided not to keep. With a squad, every worktree its members have.',
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: ['string', 'null'], description: 'The worker, by id or callsign. Null when discarding a squad.' },
        squad: { type: ['string', 'null'], description: 'Discard every worktree of this squad. Null when discarding one agent.' },
        force: { type: 'boolean', description: 'True: remove it even with unlanded work. Say so to the operator when you do.' },
      },
      required: ['agent_id', 'squad', 'force'],
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
      'For terminal permissions, inspect the current escalation context against the mission and answer allow (once) or deny. Detection is not authorization; never infer approval from detection or remember a permission globally. A requested response is not confirmed execution. Answer a waiting agent yourself, without involving the human. Use this whenever you can answer correctly from recall, from the fleet state, or from what the human has already said in this conversation. Answering here is always better than interrupting — but a confident wrong answer sends an agent down a wrong path for an hour, so do not guess.',
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
  // Squad autonomy: verify, land, budget, journal. Ver extensions.ts.
  ...EXTENSION_TOOLS,
  // What ORCA costs the machine it runs on. Ver tools-hygiene.ts.
  ...HYGIENE_TOOLS,
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
      case 'inspect_agent': return await inspectAgent(ctx, input);
      case 'list_agents': return listAgents(ctx, input);
      case 'show': return show(ctx, input);
      case 'report_task': {
        if (!ctx.tasks) throw new Error('Task conversations unavailable');
        const id = String(input.task_id ?? '');
        ctx.tasks.get(id);
        if (!['active', 'completed', 'failed'].includes(String(input.status))) throw new Error('Invalid task status');
        if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('Empty task reply');
        const ids = Array.isArray(input.agent_ids) ? input.agent_ids : [];
        if (!ids.every((v): v is string => typeof v === 'string' && !!ctx.agent(v))) throw new Error('Use known full agent IDs');
        if (ids.length) ctx.tasks.assign(id, ids);
        ctx.tasks.message(id, 'capcom', input.text, input.status as 'active' | 'completed' | 'failed');
        return { result: JSON.stringify({ task_id: id, status: input.status }), summary: `replied to task ${id}` };
      }
      case 'list_tasks': return listTasks(ctx, input);
      case 'inspect_task': return inspectTask(ctx, input);
      case 'briefing': return briefing(ctx, input);
      case 'spawn_agent': return await spawnAgent(ctx, input);
      case 'launch_squad': return await launchSquad(ctx, input);
      case 'list_fleets': return listFleets(ctx, input);
      case 'inspect_squad': return inspectSquad(ctx, input);
      case 'stop_squad': return await stopSquad(ctx, input);
      case 'send_to_agent': return await sendToAgent(ctx, input);
      case 'interrupt_agent': return await interruptAgent(ctx, input);
      case 'stop_agent': return await stopAgent(ctx, input);
      case 'set_budget': return setBudget(ctx, input);
      case 'archive_agents': return await archiveAgents(ctx, input);
      case 'land': return await landWorktrees(ctx, input);
      case 'discard': return await discardWorktrees(ctx, input);
      case 'recall': return doRecall(ctx, input);
      case 'remember': return doRemember(ctx, input);
      case 'answer_agent': return answerAgent(ctx, input);
      case 'ask_human': return askHuman(ctx, input);
      case 'read_traffic': return readTraffic(ctx, input);
      case 'relay': return relay(ctx, input);
      case 'answer_peer': return answerPeer(ctx, input);
      case 'resolve_collision': return resolveCollision(ctx, input);
      default: {
        const hyg = await runHygieneTool(ctx, name, input);
        if (hyg) return hyg;
        const ext = await runExtension(ctx, name, input);
        if (ext) return ext;
        return { result: `unknown tool: ${name}`, summary: `unknown tool ${name}`, isError: true };
      }
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
  // CAPCOM's own directory is not a project: it is where the commander lives,
  // and listing it invites launching workers there. It is left out entirely;
  // the agents inside it (CAPCOM, or a stray worker) still show in list_agents.
  const controlProjects = new Set(ctx.agents().filter((a) => a.role === 'capcom').map((a) => a.projectId));
  const projects = ctx.projects()
    .filter((p) => !controlProjects.has(p.id))
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
      budget: projectBudget(ctx, p.id),
    }));

  // Lo que vive fuera de la flota no se cuenta ni se nombra: los CAPCOM que
  // ya terminaron y lo que alguien lanzó en el directorio del mando o en un
  // scratchpad de sesión. Siguen en disco; simplemente no son la flota.
  const all = ctx.agents().filter((a) => a.hidden !== true);
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

async function inspectAgent(ctx: CeoContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const ref = String(input.agent_id ?? '');
  const a = findAgent(ctx, ref);
  if (!a) return { result: `no agent matching "${ref}"`, summary: `no agent ${ref}`, isError: true };
  const p = ctx.project(a.projectId);
  // Squad autonomy (verify): lo que el agente hizo de verdad — archivos tocados,
  // diff --stat y su última suite — sin fiarse de su reporte. Null si el hub
  // no monta la pieza o la máquina no contesta; nunca rompe la inspección.
  const verify = ctx.autonomy?.verify
    ? await ctx.autonomy.verify.summary(a.id).catch(() => null)
    : null;
  return {
    result: JSON.stringify({
      id: a.id, callsign: a.callsign, title: a.title, state: a.state,
      project: p ? { id: p.id, code: p.code, name: p.name, path: p.path, branch: p.gitBranch } : null,
      mission: a.mission, tool: a.tool, tool_detail: a.toolDetail,
      block: a.block, model: a.model,
      last_prompt: a.lastPrompt, last_say: a.lastSay,
      uptime_sec: Math.round(a.uptimeMs / 1000),
      metrics: a.metrics,
      budget: ctx.budgets ? budgetView(ctx.budgets.agentStatus(a)) : null,
      parent: a.parentId, children: a.childIds, depth: a.depth,
      worktree: a.worktree ?? null, branch: a.branch ?? null,
      verify,
    }, null, 1),
    summary: `inspected ${a.callsign} (${a.state})`,
  };
}

/**
 * ¿Apunta esta referencia de proyecto a un sitio donde no se lanza trabajo?
 *
 * El directorio de CAPCOM ya no se registra como proyecto, así que lo normal
 * es que `ctx.project()` no encuentre nada — y "no project" invita a probar
 * otro id en vez de decir que ahí no. Esto se comprueba ANTES de resolver, con
 * lo que el mando tecleó: el id de proyecto es `<máquina>/<slug>`, y tanto el
 * slug como una ruta pegada a pelo se reconocen igual.
 */
function refuseWorkspace(ref: string | null, verb: string): ToolOutcome | null {
  if (!ref) return null;
  const why = excludedWorkspace(ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref);
  if (!why) return null;
  return { result: refusalFor(why), summary: `${verb} refused: not a project`, isError: true };
}

/** A project by id or by the code the operator sees on the field ("AX"). */
function findProject(ctx: CeoContext, ref: string): Project | undefined {
  return ctx.project(ref)
    ?? ctx.projects().find((p) => p.code.toUpperCase() === ref.toUpperCase());
}

function listAgents(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  const projectRef = typeof input.project_id === 'string' && input.project_id.trim() ? input.project_id.trim() : null;
  const project = projectRef ? findProject(ctx, projectRef) : undefined;
  if (projectRef && !project) return { result: `no project "${projectRef}"`, summary: `list_agents failed: no project ${projectRef}`, isError: true };
  const squad = input.squad !== undefined && input.squad !== null && input.squad !== '' ? squadRef(input.squad) : null;
  const state = typeof input.state === 'string' && input.state.trim() ? input.state.trim().toLowerCase() : null;
  const finished = input.include_finished === true;
  const limit = Math.max(1, Math.min(100, Number.isFinite(Number(input.limit)) && Number(input.limit) > 0 ? Math.floor(Number(input.limit)) : 20));

  const all = ctx.agents()
    .filter((a) => a.role !== 'capcom')
    // Fuera de la flota por vivir donde no hay proyecto. `include_hidden` los
    // devuelve para el rato en que el operador pregunta qué quedó ahí.
    .filter((a) => a.hidden !== true || input.include_hidden === true)
    .filter((a) => !project || a.projectId === project.id)
    .filter((a) => !squad || a.squad === squad)
    .filter((a) => !state || a.state === state)
    .filter((a) => finished || !TERMINAL_STATES.has(a.state))
    .sort((a, b) => b.startedAt - a.startedAt);
  const now = Date.now();
  const agents = all.slice(0, limit).map((a) => {
    const p = ctx.project(a.projectId);
    const parent = a.parentId ? ctx.agent(a.parentId) : undefined;
    return {
      id: a.id, callsign: a.callsign, state: a.state,
      project: p?.code ?? a.projectId,
      squad: a.squad, lead: a.lead, runtime: a.runtime,
      // The console shows the same word: ORCA launched it, or it was found running.
      origin: a.role === 'capcom' || a.pane === true ? 'orca' : a.origin ?? 'unknown',
      parent: parent ? parent.callsign : a.parentId,
      started_at: new Date(a.startedAt).toISOString(),
      age_sec: Math.max(0, Math.round((now - a.startedAt) / 1000)),
      tool: a.tool, tool_detail: a.toolDetail,
      blocked_on: a.block?.summary ?? null,
      mission: (a.mission || a.title || '').replace(/\s+/g, ' ').slice(0, 120),
    };
  });
  return {
    result: JSON.stringify({ agents, total: all.length, shown: agents.length }, null, 1),
    summary: `listed ${agents.length} of ${all.length} agent(s)`
      + (project ? ` on ${project.code}` : '') + (squad ? ` in ${squad}` : '') + (state ? ` (${state})` : ''),
  };
}

/** One directive, dressed. The console fills in everything positional. */
function directive(o: Pick<CameraDirective, 'what' | 'refs'> & Partial<CameraDirective>): CameraDirective {
  const at = Date.now();
  return {
    id: newId('cam'), at, what: o.what, refs: o.refs,
    projectId: o.projectId ?? null, open: o.open ?? false, note: o.note ?? null,
    by: o.by ?? 'capcom', until: o.until ?? at + CAMERA_PENDING_MS,
  };
}

function show(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  if (!ctx.show) return { result: 'this command has no console to point at', summary: 'show unavailable', isError: true };
  const what = String(input.what ?? '') as CameraWhat;
  const refs = (Array.isArray(input.refs) ? input.refs : []).map((r) => String(r ?? '').trim()).filter(Boolean);
  const open = input.open === true;
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;

  let d: CameraDirective;
  let shown: string;
  switch (what) {
    case 'agent':
    case 'agents': {
      if (!refs.length) return { result: 'name at least one agent: an id or a callsign', summary: 'show refused: no agent', isError: true };
      const found: Agent[] = [];
      const missing: string[] = [];
      for (const r of refs) {
        const a = findAgentRef(ctx.agents(), r);
        if (a && !found.some((f) => f.id === a.id)) found.push(a); else if (!a) missing.push(r);
      }
      if (!found.length) return { result: `no agent matching ${missing.map((m) => `"${m}"`).join(', ')}`, summary: `show failed: no agent ${missing[0]}`, isError: true };
      d = directive({ what: found.length === 1 ? 'agent' : 'agents', refs: found.map((a) => a.id), open, note });
      shown = found.map((a) => a.callsign).join(', ') + (missing.length ? ` (not found: ${missing.join(', ')})` : '');
      break;
    }
    case 'squad': {
      const name = refs[0] ? squadRef(refs[0]) : null;
      if (!name) return { result: 'name the squad, e.g. "audit-01"', summary: 'show refused: no squad', isError: true };
      const sq = findSquad(ctx, name);
      if (!sq) return noSuchSquad(ctx, name, 'show');
      const first = sq.memberIds.map((id) => ctx.agent(id)).find(Boolean);
      d = directive({ what: 'squad', refs: [name], projectId: first?.projectId ?? null, open, note });
      shown = `squad ${name}`;
      break;
    }
    case 'project': {
      const ref = refs[0] ?? '';
      const p = ref ? findProject(ctx, ref) : undefined;
      if (!p) return { result: ref ? `no project "${ref}"` : 'name the project: its id or code', summary: 'show failed: no project', isError: true };
      d = directive({ what: 'project', refs: [p.id], projectId: p.id, open, note });
      shown = `project ${p.code}`;
      break;
    }
    case 'fleet':
      d = directive({ what: 'fleet', refs: [], open, note });
      shown = 'the whole fleet';
      break;
    default:
      return { result: `what must be one of agent, agents, squad, project, fleet — not "${what}"`, summary: 'show refused: bad target', isError: true };
  }
  const consoles = ctx.show(d);
  return {
    result: JSON.stringify({ ok: true, shown, consoles, directive: d }),
    summary: consoles ? `showed ${shown} on ${consoles} console(s)` : `showed ${shown} — but no console is connected to see it`,
  };
}

/**
 * The console follows what just went up. Best effort and never in the way:
 * a command with no console, or a spawn ORCA cannot name yet, simply shows
 * nothing, and the launch is exactly as launched as it was.
 */
function follow(ctx: CeoContext, o: Pick<CameraDirective, 'what' | 'refs'> & Partial<CameraDirective>): void {
  if (!ctx.show || !o.refs.length) return;
  try { ctx.show(directive({ ...o, by: 'launch' })); } catch { /* the launch stands */ }
}

async function spawnAgent(ctx: CeoContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const projectId = String(input.project_id ?? '');
  const refused = refuseWorkspace(projectId, 'spawn');
  if (refused) return refused;
  const p = ctx.project(projectId);
  if (!p) return { result: `no project "${projectId}"`, summary: 'spawn failed: no project', isError: true };
  const where = excludedWorkspace(p.path);
  if (where) return { result: refusalFor(where), summary: 'spawn refused: not a project', isError: true };

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
  const model = modelOf(input.model);
  if (input.model != null && input.model !== '' && !model) {
    return { result: 'invalid model id', summary: 'spawn refused: invalid model', isError: true };
  }
  const permissionMode = permissionModeOf(input.permission_mode);
  if (!permissionMode) {
    return { result: PERMISSION_MODE_HELP, summary: 'spawn refused: bad permission_mode', isError: true };
  }

  const budget = budgetLimit(input.budget_usd, input.budget_min);
  if ('error' in budget) return { result: budget.error, summary: 'spawn refused: bad budget', isError: true };

  const taskId = typeof input.task_id === 'string' ? input.task_id : null;
  if (taskId) { if (!ctx.tasks) throw new Error('Task conversations unavailable'); ctx.tasks.get(taskId); }
  // A durable squad label also identifies a Codex rollout arriving after its
  // launch acknowledgement, when no session ID was available yet.
  if (taskId) {
    squad ??= ctx.nextSquadName('task');
    ctx.tasks!.bindSquad(taskId, squad);
  }
  const data = await ctx.dispatch(p.machineId, {
    k: 'spawn',
    projectId: p.id,
    prompt: mission,
    parentId: parent?.id ?? null,
    mission,
    ...(squad ? { squad, lead } : {}),
    ...(model ? { model } : {}),
    ...(typeof input.runtime === 'string' && input.runtime ? { runtime: input.runtime } : {}),
    background: input.background !== false,
    // `auto` salvo que CAPCOM pida otra cosa: el CLI decide solo y nunca deja
    // un prompt esperando en una pantalla que nadie mira. Con `acceptEdits` un
    // `Bash` se queda colgado hasta que alguien pulsa Yes — y en una flota
    // autónoma ese alguien no está.
    permissionMode,
  });

  if (taskId && (data as SpawnAck | undefined)?.agentId) ctx.tasks!.assign(taskId, [(data as SpawnAck).agentId!]);

  // Fly the operator to it. By id when the session showed in time, by short
  // id when only the CLI's line named it, and by squad when it has one and
  // neither did — the block is where it will appear.
  const ack = data as SpawnAck | undefined;
  hangBudget(ctx, ack, budget);
  const ref = ack?.agentId ?? ack?.shortId ?? null;
  if (ref) follow(ctx, { what: 'agent', refs: [ref], note: `spawned ${ack?.callsign ?? 'an agent'} on ${p.code}` });
  else if (squad) follow(ctx, { what: 'squad', refs: [squad], projectId: p.id, note: `spawned into ${squad} on ${p.code}` });

  return {
    result: JSON.stringify({ ok: true, spawned: data, squad, lead, task_id: taskId, budget: hasLimit(budget) ? budget : null }),
    summary: `spawned ${typeof input.runtime === 'string' && input.runtime ? input.runtime : 'an'} agent on ${p.code}`
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

/**
 * The postures CAPCOM may hand a worker. `manual` and `dontAsk` are deliberately
 * not here: `manual` parks the worker at a prompt nobody will answer, and
 * `dontAsk` is `auto` with the useful half removed.
 */
type WorkerPermissionMode = 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions';
const WORKER_PERMISSION_MODES: ReadonlySet<string> = new Set(['auto', 'acceptEdits', 'plan', 'bypassPermissions']);
const PERMISSION_MODE_HELP =
  'invalid permission_mode: use null or "auto" (the CLI decides, never blocks), "plan" (read-only), "bypassPermissions" (never asks) or "acceptEdits" (shell commands ask).';

/** Null and "" mean "auto"; anything else must be one of the four. */
function permissionModeOf(v: unknown): WorkerPermissionMode | null {
  if (v === undefined || v === null || v === '') return 'auto';
  return typeof v === 'string' && WORKER_PERMISSION_MODES.has(v) ? (v as WorkerPermissionMode) : null;
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
    return { mission, prompt: mission, model: modelOf(o.model), runtime: typeof input.runtime === 'string' ? input.runtime : null };
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
    lead: { mission: leadMission, prompt: leadMission, model: modelOf(input.lead_model), runtime: typeof input.runtime === 'string' ? input.runtime : null },
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
  const refused = refuseWorkspace(projectRef, 'launch');
  if (refused) return refused;
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
  const whereSquad = excludedWorkspace(p.path);
  if (whereSquad) return { result: refusalFor(whereSquad), summary: 'launch refused: not a project', isError: true };

  const taskId = typeof input.task_id === 'string' ? input.task_id : null;
  if (taskId) { if (!ctx.tasks) throw new Error('Task conversations unavailable'); ctx.tasks.get(taskId); }
  const background = input.background !== false;
  const permissionMode = permissionModeOf(input.permission_mode);
  if (!permissionMode) {
    return { result: PERMISSION_MODE_HELP, summary: 'launch refused: bad permission_mode', isError: true };
  }
  const memberBudget = budgetLimit(input.budget_usd, input.budget_min);
  if ('error' in memberBudget) return { result: memberBudget.error, summary: 'launch refused: bad budget', isError: true };
  const squadBudget = budgetLimit(input.squad_budget_usd, input.squad_budget_min);
  if ('error' in squadBudget) return { result: `squad_${squadBudget.error}`, summary: 'launch refused: bad squad budget', isError: true };

  const squad = plan.fixedSquad ?? ctx.nextSquadName(plan.base);
  if (taskId) ctx.tasks!.bindSquad(taskId, squad);
  // The squad's own ceiling goes on before anyone is up: it is keyed by the
  // label, and the label is the one thing known before the first ack.
  if (ctx.budgets && hasLimit(squadBudget)) ctx.budgets.set({ kind: 'squad', ref: squad }, squadBudget);

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
    // `auto` salvo que CAPCOM pida otra cosa para todo el escuadrón; ver spawnAgent.
    permissionMode,
    // One worktree named after the squad, when the lead wants the members on
    // the same files. Nothing without ORCA_WORKTREES=1 on the collector.
    ...(input.shared_worktree === true ? { worktree: squad } : {}),
  });

  // The lead goes up first and alone: a squad has a head before it has
  // members, or the members' footers name a lead that does not exist.
  let leadId: string | null = null;
  let leadCallsign: string | null = null;
  if (plan.lead) {
    const leadAck = (await ctx.dispatch(p.machineId, spawn(plan.lead, null, true))) as SpawnAck | undefined;
    leadId = leadAck?.agentId ?? null;
    hangBudget(ctx, leadAck, memberBudget);
    if (!leadId) leadId = await settleLead(ctx, squad, leadAck?.shortId ?? null);
    if (taskId && leadId) ctx.tasks!.assign(taskId, [leadId]);
    leadCallsign = leadAck?.callsign ?? (leadId ? ctx.agent(leadId)?.callsign ?? null : null);
  }

  const launched: { member: number; agent_id: string | null; callsign: string | null }[] = [];
  const failures: { member: number; error: string }[] = [];
  for (const [i, m] of plan.members.entries()) {
    try {
      const ack = (await ctx.dispatch(p.machineId, spawn(m, leadId, false))) as SpawnAck | undefined;
      if (taskId && ack?.agentId) ctx.tasks!.assign(taskId, [ack.agentId]);
      hangBudget(ctx, ack, memberBudget);
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

  if (leadId || launched.some((m) => m.agent_id)) {
    follow(ctx, { what: 'squad', refs: [squad], projectId: p.id, note: `launched ${squad} on ${p.code}` });
  }

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
      budget: {
        per_agent: hasLimit(memberBudget) ? memberBudget : null,
        squad: hasLimit(squadBudget) ? squadBudget : null,
      },
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
      budget: ctx.budgets ? budgetView(ctx.budgets.agentStatus(a)) : null,
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
      budget: ctx.budgets ? scopeView(ctx.budgets.scopeStatus({ kind: 'squad', ref: sq.name })) : null,
      waiting,
    }, null, 1),
    summary: `inspected squad ${sq.name}: ${alive}/${members.length} alive, ${blocked} blocked, ${waiting.length} waiting`,
  };
}

/* ── Worktrees: land / discard ────────────────────────────────────── */

/**
 * The agents `land` and `discard` act on: one by id, or every worktree of a
 * squad. A squad that shares a worktree yields it ONCE — landing it twice
 * would land nothing the second time and say so, which is noise, not safety.
 */
function worktreeTargets(
  ctx: CeoContext, input: Record<string, unknown>, verb: string,
): { targets: Agent[] } | ToolOutcome {
  const ref = typeof input.agent_id === 'string' && input.agent_id.trim() ? input.agent_id.trim() : null;
  const squad = input.squad !== undefined && input.squad !== null && input.squad !== '' ? squadRef(input.squad) : null;
  if (input.squad && !squad) return { result: `not a squad name: ${String(input.squad)}`, summary: `${verb} refused: bad squad`, isError: true };
  if (!ref && !squad) return { result: `${verb} needs agent_id or squad`, summary: `${verb} refused: no target`, isError: true };
  if (ref) {
    const a = findAgent(ctx, ref);
    if (!a) return { result: `no agent matching "${ref}"`, summary: `${verb} failed: no agent ${ref}`, isError: true };
    if (!a.worktree) {
      return {
        result: `${a.callsign} runs on the project's own working tree, not in a worktree of its own: there is no branch to ${verb}. Workers get a worktree when the collector runs with ORCA_WORKTREES=1.`,
        summary: `${verb} refused: ${a.callsign} has no worktree`, isError: true,
      };
    }
    return { targets: [a] };
  }
  const members = ctx.agents().filter((a) => a.squad === squad && typeof a.worktree === 'string' && a.worktree);
  if (!members.length) {
    return { result: `no agent in ${squad} has a worktree` + (findSquad(ctx, squad!) ? '' : ` (no squad ${squad} either)`), summary: `${verb} refused: nothing in ${squad}`, isError: true };
  }
  const seen = new Set<string>();
  const targets: Agent[] = [];
  // The lead first, so a shared worktree is landed under the lead's name.
  for (const a of [...members].sort((x, y) => Number(y.lead) - Number(x.lead))) {
    const key = `${a.machineId}:${a.worktree}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(a);
  }
  return { targets };
}

async function landWorktrees(ctx: CeoContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const picked = worktreeTargets(ctx, input, 'land');
  if ('summary' in picked) return picked;
  const runTests = input.run_tests !== false;
  const message = typeof input.message === 'string' && input.message.trim() ? input.message.trim() : null;

  const landed: Record<string, unknown>[] = [];
  const refused: Record<string, unknown>[] = [];
  for (const a of picked.targets) {
    let r: LandResult | undefined;
    try {
      r = (await ctx.dispatch(a.machineId, { k: 'land', agentId: a.id, runTests, message })) as LandResult | undefined;
    } catch (err) {
      refused.push({ agent_id: a.id, callsign: a.callsign, branch: a.branch, reason: 'error', detail: err instanceof Error ? err.message : String(err), conflicts: [] });
      continue;
    }
    if (!r) { refused.push({ agent_id: a.id, callsign: a.callsign, branch: a.branch, reason: 'error', detail: 'the collector answered nothing', conflicts: [] }); continue; }
    if (r.ok) {
      landed.push({
        agent_id: a.id, callsign: a.callsign, branch: r.branch, onto: r.projectBranch, commit: r.commit, files: r.files,
        tests: r.tests ? { command: r.tests.command.join(' '), ok: true, seconds: Math.round(r.tests.durationMs / 1000) } : null,
        note: r.note,
      });
    } else {
      refused.push({
        agent_id: a.id, callsign: a.callsign, branch: a.branch, reason: r.reason, detail: r.detail, conflicts: r.conflicts,
        ...(r.tests ? { tests: { command: r.tests.command.join(' '), ok: r.tests.ok, code: r.tests.code, output: r.tests.output } } : {}),
      });
    }
    // Al diario, aterrice o no: "esta rama entró" y "esta rama se quedó fuera
    // porque la suite estaba roja" son las dos cosas que alguien va a buscar
    // dentro de una semana, y ninguna de las dos vive en ningún otro sitio.
    try {
      ctx.autonomy?.journal.landed({
        agentId: a.id, projectId: a.projectId,
        branch: r.ok ? r.branch : a.branch, target: r.ok ? r.projectBranch : null,
        commit: r.ok ? r.commit : null, ok: r.ok,
        detail: r.ok ? (r.note ?? null) : `${r.reason}: ${r.detail}`,
      });
    } catch { /* el diario nunca decide si un aterrizaje cuenta */ }
  }
  const next = refused.length
    ? 'for a conflict: send_to_agent the worker with the files and ask it to rebase on the project branch and fix them, or resolve in the worktree yourself; for a failing suite: send the output back to the worker; to drop the work: discard.'
    : null;
  return {
    result: JSON.stringify({ ok: refused.length === 0, landed, refused, ...(next ? { next } : {}) }, null, 1),
    summary: `landed ${landed.length}/${picked.targets.length}`
      + (landed.length ? `: ${landed.map((l) => `${String(l.callsign)}@${String(l.commit).slice(0, 8)}`).join(', ')}` : '')
      + (refused.length ? `; refused: ${refused.map((r) => `${String(r.callsign)} (${String(r.reason)})`).join(', ')}` : ''),
    ...(landed.length === 0 ? { isError: true } : {}),
  };
}

async function discardWorktrees(ctx: CeoContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const picked = worktreeTargets(ctx, input, 'discard');
  if ('summary' in picked) return picked;
  const force = input.force === true;
  const gone: Record<string, unknown>[] = [];
  const kept: Record<string, unknown>[] = [];
  for (const a of picked.targets) {
    try {
      const r = (await ctx.dispatch(a.machineId, { k: 'discard', agentId: a.id, force })) as DiscardResult | undefined;
      if (r?.ok) gone.push({ agent_id: a.id, callsign: a.callsign, worktree: a.worktree, removed: r.removed, detail: r.detail });
      else kept.push({ agent_id: a.id, callsign: a.callsign, worktree: a.worktree, detail: r?.detail ?? 'the collector answered nothing', status: r && !r.ok ? r.status : null });
    } catch (err) {
      kept.push({ agent_id: a.id, callsign: a.callsign, worktree: a.worktree, detail: err instanceof Error ? err.message : String(err), status: null });
    }
  }
  return {
    result: JSON.stringify({
      ok: kept.length === 0, discarded: gone, kept,
      ...(kept.length && !force ? { next: 'land what is worth keeping, or call again with force true to drop it' } : {}),
    }, null, 1),
    summary: `discarded ${gone.length}/${picked.targets.length}${force ? ' (force)' : ''}`
      + (kept.length ? `; kept: ${kept.map((k) => String(k.callsign)).join(', ')}` : ''),
    ...(gone.length === 0 ? { isError: true } : {}),
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

/**
 * Cortar el turno en vuelo, con o sin corrección.
 *
 * Lo que devuelve es el parte del collector tal cual, porque cada campo dice
 * una cosa distinta que el mando necesita distinguir: si la tecla salió, si el
 * texto se pegó o se encoló, y si el CLI dejó constancia del corte. Un
 * `unsupported` se devuelve como error para que el modelo no lo lea como hecho
 * — y con el motivo, para que no pruebe a matar la sesión en su lugar.
 */
async function interruptAgent(ctx: CeoContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const ref = String(input.agent_id ?? '');
  const a = findAgent(ctx, ref);
  if (!a) return { result: `no agent matching "${ref}"`, summary: `interrupt failed: no agent ${ref}`, isError: true };
  const raw = input.text;
  const text = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  if (raw !== null && raw !== undefined && typeof raw !== 'string') {
    return { result: 'text must be a string or null', summary: 'interrupt refused: bad text', isError: true };
  }
  let out: InterruptOutcome | undefined;
  try {
    out = (await ctx.dispatch(a.machineId, { k: 'interrupt', agentId: a.id, text })) as InterruptOutcome | undefined;
  } catch (err) {
    // El collector rechaza con el motivo dentro del error: es información
    // para el modelo (por ejemplo "esta sesión no tiene pane"), no un fallo.
    const detail = err instanceof Error ? err.message : String(err);
    return {
      result: JSON.stringify({ ok: false, agent: a.callsign, detail }, null, 1),
      summary: `interrupt refused for ${a.callsign}: ${detail}`.slice(0, 160),
      isError: true,
    };
  }
  return {
    result: JSON.stringify({
      agent: a.callsign,
      interrupt: out?.interrupt ?? 'sent',
      message: out?.message ?? (text ? 'pasted' : 'none'),
      evidence: out?.evidence ?? 'pending',
      order: out?.order ?? [],
      runtime: out?.runtime ?? a.runtime,
      detail: out?.detail ?? '',
      reason: String(input.reason ?? ''),
    }, null, 1),
    summary: `interrupted ${a.callsign}`
      + (out?.evidence === 'confirmed' ? ' (confirmed)' : ' (no acknowledgement yet)')
      + (text ? ' with a correction' : ''),
  };
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

/* ── Budgets ──────────────────────────────────────────────────────── */

/** Hang a per-agent budget on whatever the ack named: the id, or the short id until the session shows. */
function hangBudget(ctx: CeoContext, ack: SpawnAck | undefined, limit: BudgetLimit): void {
  if (!ctx.budgets || !hasLimit(limit)) return;
  if (ack?.agentId) ctx.budgets.set({ kind: 'agent', ref: ack.agentId }, limit);
  else if (ack?.shortId) ctx.budgets.setPendingByShortId(ack.shortId, limit);
}

const usd2 = (n: number): number => Number(n.toFixed(2));

/** An agent's budget picture as the model reads it: rounded, and only the ceilings that reach it. */
function budgetView(b: AgentBudget): Record<string, unknown> | null {
  if (b.lines.length === 0) return null;
  return {
    level: b.level,
    pct: Math.round(b.pct * 100),
    spent_usd: usd2(b.spent_usd),
    estimated: b.estimated,
    elapsed_min: Math.round(b.elapsed_min),
    last_progress_sec_ago: b.last_progress_at === null ? null : Math.max(0, Math.round((Date.now() - b.last_progress_at) / 1000)),
    limits: b.lines.map((l) => ({
      scope: l.scope, ref: l.ref,
      limit_usd: l.limit_usd, limit_min: l.limit_min,
      spent_usd: usd2(l.spent_usd), elapsed_min: Math.round(l.elapsed_min),
      pct: Math.round(l.pct * 100),
    })),
  };
}

function scopeView(s: ScopeBudget | null): Record<string, unknown> | null {
  if (!s) return null;
  return {
    limit_usd: s.limit.usd, limit_min: s.limit.min,
    spent_usd: usd2(s.spent_usd), estimated: s.estimated, elapsed_min: Math.round(s.elapsed_min),
    pct: Math.round(s.pct * 100), level: s.level, agents: s.agent_ids.length,
  };
}

/**
 * A project's budgets, summed: how many agents carry a ceiling, what they
 * have spent against it, and how many are past 80% or 100%. Null when no
 * agent in it has one, so a fleet without budgets reads as before.
 */
function projectBudget(ctx: CeoContext, projectId: string): Record<string, unknown> | null {
  if (!ctx.budgets) return null;
  let agents = 0, spent = 0, limit = 0, capped = true, warn = 0, over = 0;
  for (const a of ctx.agents()) {
    if (a.projectId !== projectId || a.role === 'capcom') continue;
    const b = ctx.budgets.agentStatus(a);
    if (b.lines.length === 0) continue;
    agents++;
    spent += b.spent_usd;
    // Only the agent's own ceiling adds up per project; a squad's or a task's
    // is shared and would be counted once per member.
    const own = b.lines.find((l) => l.scope === 'agent' || l.scope === 'default');
    if (own?.limit_usd != null) limit += own.limit_usd; else capped = false;
    if (b.level === 'over') over++; else if (b.level === 'warn') warn++;
  }
  if (agents === 0) return null;
  return { agents, spent_usd: usd2(spent), limit_usd: capped ? usd2(limit) : null, warn, over };
}

function setBudget(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  if (!ctx.budgets) return { result: 'budgets are not available on this hub', summary: 'set_budget failed: no book', isError: true };
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const agentRef = str(input.agent_id);
  const squadIn = str(input.squad);
  const taskId = str(input.task_id);
  const named = [agentRef, squadIn, taskId].filter((v) => v !== null).length;
  if (named !== 1) {
    return { result: 'name exactly one of agent_id, squad or task_id', summary: 'set_budget refused: ambiguous target', isError: true };
  }
  const limit = budgetLimit(input.budget_usd, input.budget_min);
  if ('error' in limit) return { result: limit.error, summary: 'set_budget refused: bad limit', isError: true };

  let scope: BudgetScope;
  let label: string;
  if (agentRef) {
    const a = findAgent(ctx, agentRef);
    if (!a) return { result: `no agent matching "${agentRef}"`, summary: `set_budget failed: no agent ${agentRef}`, isError: true };
    scope = { kind: 'agent', ref: a.id };
    label = a.callsign;
  } else if (squadIn) {
    const ref = squadRef(squadIn);
    if (!ref) return { result: `not a squad name: ${squadIn}`, summary: 'set_budget refused: bad squad', isError: true };
    const sq = findSquad(ctx, ref);
    if (!sq) return noSuchSquad(ctx, ref, 'set_budget');
    scope = { kind: 'squad', ref: sq.name };
    label = `squad ${sq.name}`;
  } else {
    if (!ctx.tasks) throw new Error('Task conversations unavailable');
    ctx.tasks.get(taskId!);
    scope = { kind: 'task', ref: taskId! };
    label = `task ${taskId}`;
  }

  ctx.budgets.set(scope, limit);
  const status = scopeView(ctx.budgets.scopeStatus(scope));
  const cfg = ctx.budgets.config();
  const words = hasLimit(limit)
    ? [limit.usd !== null ? `$${limit.usd}` : null, limit.min !== null ? `${limit.min} min` : null].filter(Boolean).join(' / ')
    : 'removed';
  return {
    result: JSON.stringify({
      ok: true, scope: scope.kind, ref: scope.ref,
      budget: hasLimit(limit) ? limit : null,
      status,
      policy: { at_100_percent: cfg.action, progress_window_min: cfg.progressMs / 60_000 },
    }, null, 1),
    summary: `budget on ${label}: ${words}`,
  };
}

/**
 * Archive what is finished. The hub decides and does; this resolves what a
 * model types — a project code, "squad:audit-01", "24h" — into the filter the
 * hub takes, and dresses the outcome so the same call reads well in a dry run.
 */
async function archiveAgents(ctx: CeoContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const projectRef = typeof input.project_id === 'string' && input.project_id.trim() ? input.project_id.trim() : null;
  const project = projectRef ? findProject(ctx, projectRef) : undefined;
  if (projectRef && !project) return { result: `no project "${projectRef}"`, summary: `archive_agents failed: no project ${projectRef}`, isError: true };
  const squad = input.squad !== undefined && input.squad !== null && input.squad !== '' ? squadRef(input.squad) : null;
  if (input.squad && !squad) return { result: `not a squad name: ${String(input.squad)}`, summary: 'archive_agents refused: bad squad', isError: true };
  const olderThanMs = parseAge(input.older_than_hours);
  if (olderThanMs !== null && !Number.isFinite(olderThanMs)) {
    return { result: `older_than_hours must be a number of hours, got ${JSON.stringify(input.older_than_hours)}`, summary: 'archive_agents refused: bad age', isError: true };
  }
  const state = archivableState(input.state);
  if (input.state && !state) return { result: 'state must be "done", "dead" or null', summary: 'archive_agents refused: bad state', isError: true };
  const dryRun = input.dry_run !== false;

  const filter: ArchiveFilter = { projectId: project?.id ?? null, squad, olderThanMs, state, hidden: input.hidden === true ? true : null };
  // Who is about to go and still owns a worktree: looked up BEFORE archiving,
  // because afterwards the hub no longer lists them. A landed worktree goes
  // with its worker; one with unlanded work stays, and the result says so.
  const owners = dryRun ? [] : ctx.archiveAgents(filter, { dryRun: true, by: 'capcom' }).archived
    .map((t) => ctx.agent(t.id))
    .filter((a): a is Agent => a !== undefined && typeof a.worktree === 'string' && a.worktree.length > 0);
  const out = ctx.archiveAgents(filter, { dryRun, by: 'capcom' });
  const worktrees: { callsign: string; worktree: string; removed: boolean; detail: string }[] = [];
  for (const a of owners) {
    if (!out.archived.some((t) => t.id === a.id)) continue;
    try {
      const r = (await ctx.dispatch(a.machineId, { k: 'discard', agentId: a.id, force: false })) as DiscardResult | undefined;
      worktrees.push({ callsign: a.callsign, worktree: a.worktree!, removed: r?.ok === true && r.removed, detail: r?.detail ?? 'no answer' });
    } catch (err) {
      worktrees.push({ callsign: a.callsign, worktree: a.worktree!, removed: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  const now = Date.now();
  const archived = out.archived.map((t) => ({
    id: t.id, callsign: t.callsign, state: t.state,
    project: ctx.project(t.projectId)?.code ?? t.projectId,
    squad: t.squad, lead: t.lead,
    finished_ago_sec: Math.max(0, Math.round((now - t.finishedAt) / 1000)),
    mission: (t.mission || t.title || '').replace(/\s+/g, ' ').slice(0, 120),
  }));
  const scope = [
    project ? `on ${project.code}` : '', squad ? `in ${squad}` : '',
    state ? `(${state})` : '', olderThanMs ? `finished over ${Math.round(olderThanMs / 36_000) / 100}h ago` : '',
  ].filter(Boolean).join(' ');
  const n = archived.length;
  const tail = (out.kept.length ? `, ${out.kept.length} kept (live children)` : '')
    + (out.squadsRetired.length ? `, squads retired: ${out.squadsRetired.join(', ')}` : '');
  return {
    result: JSON.stringify({
      dry_run: dryRun, count: n, archived,
      kept: out.kept.map((k) => ({ id: k.id, callsign: k.callsign, reason: k.reason })),
      squads_retired: out.squadsRetired,
      ...(worktrees.length ? { worktrees } : {}),
      ...(dryRun ? { next: n ? 'call again with dry_run false to archive these' : 'nothing to archive' } : {}),
    }, null, 1),
    summary: (dryRun ? `dry run: would archive ${n} agent(s)` : `archived ${n} agent(s)`)
      + (scope ? ` ${scope}` : '') + tail,
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
  if (esc.permission && (!['pending', 'with_ceo'].includes(esc.status) || esc.permission.phase !== 'requested' || !/^(allow|once|deny)$/i.test(answer.trim()))) return { result: 'Permission stale, already requested, or invalid answer; use allow (once) or deny on the current escalation.', summary: 'permission rejected', isError: true };
  ctx.resolveEscalation(id, answer, 'ceo');
  return {
    result: JSON.stringify(esc.permission ? { ok: true, status: 'requested', confirmed: false, note: 'Collector validates the current dialog before sending. Follow the escalation/terminal; do not retry.' } : { ok: true }),
    summary: `${esc.permission ? 'permission response requested; confirmation pending' : 'answered it myself'}: ${String(input.basis ?? '')}`.slice(0, 120),
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

/* ── Tasks and the briefing ───────────────────────────────────────── */

/**
 * What a task still owes CAPCOM.
 *
 * The rule is positional and deliberately simple: everything after the last
 * `capcom` message is unanswered. A human line there is a question nobody
 * replied to; an agent line is a result nobody reported. The alternative —
 * matching replies to questions by content — is guesswork, and a commander
 * that has just lost its memory needs a rule it can trust, not one it can
 * argue with.
 */
interface TaskDebt {
  /** Human messages with no report_task after them. */
  humans: TaskMessage[];
  /** Worker results with no report_task after them. */
  results: TaskMessage[];
  /** When CAPCOM last spoke in this task, or 0 for never. */
  lastCapcomAt: number;
}

function taskDebt(task: CapcomTask): TaskDebt {
  let cut = -1;
  for (let i = task.messages.length - 1; i >= 0; i--) {
    if (task.messages[i]!.role === 'capcom') { cut = i; break; }
  }
  const tail = task.messages.slice(cut + 1);
  return {
    humans: tail.filter((m) => m.role === 'human'),
    results: tail.filter((m) => m.role === 'agent'),
    lastCapcomAt: cut >= 0 ? task.messages[cut]!.at : 0,
  };
}

/** True when the task is active and something in it is waiting on CAPCOM. */
function taskOwed(task: CapcomTask, debt: TaskDebt): boolean {
  return task.status === 'active' && (debt.humans.length > 0 || debt.results.length > 0);
}

function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function iso(at: number | null | undefined): string | null {
  return at ? new Date(at).toISOString() : null;
}

/** "4m", "2h 10m", "3d" — for a commander reading a list, not a log. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

function taskAgents(ctx: CeoContext, task: CapcomTask): { id: string; callsign: string | null; state: string }[] {
  return task.agentIds.map((id) => {
    const a = ctx.agent(id);
    return { id, callsign: a?.callsign ?? null, state: a?.state ?? 'unknown' };
  });
}

function listTasks(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  if (!ctx.tasks) throw new Error('Task conversations unavailable');
  const status = typeof input.status === 'string' && input.status.trim() ? input.status.trim() : null;
  if (status && !['active', 'completed', 'failed'].includes(status)) throw new Error('Invalid task status');
  const onlyPending = input.only_pending === true;
  const limit = Math.max(1, Math.min(100, Number.isFinite(Number(input.limit)) && Number(input.limit) > 0 ? Math.floor(Number(input.limit)) : 20));
  const now = Date.now();

  const all = Object.values(ctx.tasks.all())
    .filter((t) => !status || t.status === status)
    .map((t) => ({ task: t, debt: taskDebt(t) }))
    .filter(({ task, debt }) => !onlyPending || taskOwed(task, debt))
    .sort((a, b) => b.task.updatedAt - a.task.updatedAt);

  const tasks = all.slice(0, limit).map(({ task, debt }) => {
    const last = task.messages.at(-1);
    const oldest = debt.humans[0];
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      created_at: iso(task.createdAt),
      updated_at: iso(task.updatedAt),
      last_message_at: iso(last?.at),
      last_message_role: last?.role ?? null,
      messages: task.messages.length,
      agents: taskAgents(ctx, task),
      squads: task.squads ?? [],
      awaiting_reply: task.status === 'active' && debt.humans.length > 0,
      // The oldest unanswered line: what the operator is actually waiting on.
      pending_human: oldest ? { text: clip(oldest.text, 200), waiting: ago(now - oldest.at) } : null,
      unreported_results: task.status === 'active' ? debt.results.length : 0,
    };
  });
  const owed = tasks.filter((t) => t.awaiting_reply || t.unreported_results > 0).length;
  return {
    result: JSON.stringify({ tasks, total: all.length, shown: tasks.length }, null, 1),
    summary: `listed ${tasks.length} of ${all.length} task(s)`
      + (status ? ` (${status})` : '') + (onlyPending ? ', pending only' : '')
      + (owed ? `, ${owed} waiting on you` : ''),
  };
}

function inspectTask(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  if (!ctx.tasks) throw new Error('Task conversations unavailable');
  const id = String(input.task_id ?? '').trim();
  const task = ctx.tasks.get(id);
  const debt = taskDebt(task);
  const now = Date.now();
  const who = (m: TaskMessage): string | null => {
    if (!m.agentId) return null;
    return ctx.agent(m.agentId)?.callsign ?? m.agentId;
  };
  const agents = task.agentIds.map((agentId) => {
    const a = ctx.agent(agentId);
    const reported = [...task.messages].reverse().find((m) => m.agentId === agentId);
    return a ? {
      id: a.id, callsign: a.callsign, state: a.state, project: ctx.project(a.projectId)?.code ?? a.projectId,
      squad: a.squad, tool: a.tool, blocked_on: a.block?.summary ?? null,
      last_say: a.lastSay, updated_at: iso(a.updatedAt),
      last_result_in_task: reported ? clip(reported.text, 200) : null,
    } : { id: agentId, callsign: null, state: 'unknown', last_result_in_task: reported ? clip(reported.text, 200) : null };
  });
  const owed: string[] = [];
  if (task.status === 'active' && debt.humans.length) owed.push(`reply to ${debt.humans.length} human message(s)`);
  if (task.status === 'active' && debt.results.length) owed.push(`report ${debt.results.length} worker result(s)`);
  return {
    result: JSON.stringify({
      id: task.id, title: task.title, status: task.status,
      created_at: iso(task.createdAt), updated_at: iso(task.updatedAt),
      squads: task.squads ?? [],
      agents,
      conversation: task.messages.map((m) => ({
        role: m.role, at: iso(m.at), agent: who(m), text: m.text,
      })),
      awaiting_reply: task.status === 'active' && debt.humans.length > 0,
      pending_human: debt.humans.map((m) => ({ text: m.text, waiting: ago(now - m.at) })),
      unreported_results: debt.results.map((m) => ({ agent: who(m), text: clip(m.text, 400) })),
      owed: owed.length ? owed.join('; ') : 'nothing',
    }, null, 1),
    summary: `inspected task ${task.id} (${task.status})${owed.length ? ` — owed: ${owed.join('; ')}` : ''}`,
  };
}

/** Lines per section of the briefing. Past it, "…and N more". */
const BRIEFING_PER_SECTION = 8;
const BRIEFING_DEFAULT_HOURS = 6;

/** One section: a heading with the count, the first lines, and the rest as a number. */
function section(title: string, lines: string[], max = BRIEFING_PER_SECTION): string[] {
  if (lines.length === 0) return [`${title}: none`];
  const out = [`${title} (${lines.length}):`, ...lines.slice(0, max).map((l) => `  ${l}`)];
  if (lines.length > max) out.push(`  …and ${lines.length - max} more`);
  return out;
}

/**
 * The fleet, in one screen, for a mind with no memory.
 *
 * Text and not JSON on purpose: the reader is a model that has just booted or
 * just compacted, and what it needs is the shape of the situation — what is
 * stuck, what is owed, what finished — not a structure to walk. Every line
 * names the thing by the id the follow-up tool takes, so the next call is
 * never a search.
 */
function briefing(ctx: CeoContext, input: Record<string, unknown>): ToolOutcome {
  const hours = Number.isFinite(Number(input.hours)) && Number(input.hours) > 0 ? Number(input.hours) : BRIEFING_DEFAULT_HOURS;
  const now = Date.now();
  const cutoff = now - hours * 3600_000;
  // Ni el mando ni lo que vive fuera de la flota: el briefing es sobre trabajo.
  const agents = ctx.agents().filter((a) => a.role !== 'capcom' && a.hidden !== true);
  const live = agents.filter((a) => !TERMINAL_STATES.has(a.state));
  const code = (projectId: string): string => ctx.project(projectId)?.code ?? projectId;
  const name = (id: string): string => ctx.agent(id)?.callsign ?? id;

  /* Blocked: open escalations first (they carry the id to answer), then any
   * other blocked agent — a permission prompt read off a screen, a peer wait. */
  const blocked: string[] = [];
  const covered = new Set<string>();
  const open = (ctx.escalations?.() ?? [])
    .filter((e) => e.status === 'pending' || e.status === 'with_ceo')
    .sort((a, b) => a.askedAt - b.askedAt);
  for (const e of open) {
    if (e.agentId) covered.add(e.agentId);
    const who = e.agentId ? `${name(e.agentId)} [${code(e.projectId)}]` : `[${code(e.projectId)}]`;
    blocked.push(`${who} waiting ${ago(now - e.askedAt)}${e.urgency === 'blocking' ? ' BLOCKING' : ''}: "${clip(e.question, 140)}"`
      + (e.options.length ? ` · options: ${e.options.join(' | ')}` : '') + ` (${e.id}${e.status === 'with_ceo' ? ', with you' : ''})`);
  }
  for (const a of agents) {
    if (a.state !== 'blocked' || covered.has(a.id)) continue;
    const since = a.block?.since ?? a.updatedAt;
    blocked.push(`${a.callsign} [${code(a.projectId)}] ${a.block?.kind ?? 'blocked'} ${ago(now - since)}: "${clip(a.block?.summary ?? 'blocked', 140)}"`
      + (a.block?.escalationId ? ` (${a.block.escalationId})` : ''));
  }

  /* Tasks owed, oldest debt first: a human waiting an hour outranks one waiting a minute. */
  const debts = Object.values(ctx.tasks?.all() ?? {})
    .map((task) => ({ task, debt: taskDebt(task) }))
    .filter(({ task, debt }) => taskOwed(task, debt))
    .sort((a, b) => (a.debt.humans[0]?.at ?? a.task.updatedAt) - (b.debt.humans[0]?.at ?? b.task.updatedAt));
  const owed = debts.map(({ task, debt }) => {
    const parts: string[] = [];
    const h = debt.humans[0];
    if (h) parts.push(`human waiting ${ago(now - h.at)}: "${clip(h.text, 120)}"`);
    if (debt.results.length) parts.push(`${debt.results.length} unreported result(s) from ${[...new Set(debt.results.map((m) => (m.agentId ? name(m.agentId) : '?')))].join(', ')}`);
    return `${task.id} "${clip(task.title, 60)}" — ${parts.join('; ')}`;
  });

  /* Finished lately and nobody reported it. Owned by a task, or by nobody. */
  const taskOf = new Map<string, CapcomTask>();
  for (const task of Object.values(ctx.tasks?.all() ?? {})) {
    // An active task wins over a closed one that also names the agent.
    for (const id of task.agentIds) if (task.status === 'active' || !taskOf.has(id)) taskOf.set(id, task);
  }
  const finished = agents
    .filter((a) => TERMINAL_STATES.has(a.state) && a.updatedAt >= cutoff)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .flatMap((a) => {
      const task = taskOf.get(a.id);
      if (task) {
        // A closed task was reported by definition; in an open one, reported
        // means CAPCOM spoke after the agent's last result landed.
        if (task.status !== 'active') return [];
        const debt = taskDebt(task);
        const landed = task.messages.some((m) => m.agentId === a.id);
        // Its result is in the task: reported unless it sits after CAPCOM's
        // last word. Not in the task yet: reported only if CAPCOM spoke after
        // the agent finished.
        const reported = landed ? !debt.results.some((m) => m.agentId === a.id) : a.updatedAt <= debt.lastCapcomAt;
        if (reported) return [];
      }
      return [`${a.callsign} [${code(a.projectId)}] ${a.state} ${ago(now - a.updatedAt)} ago`
        + (task ? ` · ${task.id} "${clip(task.title, 40)}"` : ' · no task')
        + (a.lastSay ? `: "${clip(a.lastSay, 120)}"` : '')];
    });

  /* Squads with nobody left alive: finished, or finished badly. */
  const dead = squadsOf(agents)
    .filter((sq) => sq.memberIds.every((id) => TERMINAL_STATES.has(ctx.agent(id)?.state ?? 'dead')))
    .map((sq) => {
      const states = sq.memberIds.map((id) => ctx.agent(id)?.state ?? 'gone');
      const count = (st: string): number => states.filter((x) => x === st).length;
      return `${sq.name} (${sq.memberIds.length} members: ${count('done')} done, ${count('dead')} dead)`;
    });

  /* Projects with anything on them. CAPCOM's own directory is not a project. */
  const control = new Set(ctx.agents().filter((a) => a.role === 'capcom').map((a) => a.projectId));
  const projects = ctx.projects()
    .filter((p) => !control.has(p.id) && p.rollup.total > 0)
    .sort((a, b) => b.rollup.total - a.rollup.total)
    .map((p) => {
      const by = Object.entries(p.rollup.byState).filter(([, n]) => n > 0).map(([st, n]) => `${n} ${st}`).join(', ');
      return `${p.code} ${p.name}${p.gitBranch ? ` @${p.gitBranch}` : ''}${p.gitDirty ? ' (dirty)' : ''} · ${by}${p.rollup.costUSD ? ` · $${p.rollup.costUSD.toFixed(2)}` : ''}`;
    });

  /* The latest rules: what the operator has said that still applies. */
  const rules = (ctx.rules?.(5) ?? []).map((r) =>
    `${r.projectId ? `[${code(r.projectId)}] ` : '[fleet] '}${clip(r.answer, 120)} (re: ${clip(r.question, 60)})`);

  const lines = [
    `BRIEFING ${new Date(now).toISOString()} · ${live.length} live agent(s), ${agents.length - live.length} finished, ${projects.length} project(s) with activity`,
    ...section('CAPCOM SESSION HANDOFFS — earlier history is stored separately', (ctx.handoffs?.() ?? []).slice(-3).map(handoffText), 3),
    ...section('CAPCOM MODEL CHANGES — same session, history retained', ctx.agents().filter(a => a.role === 'capcom').flatMap(a => a.modelControl?.events.slice(-3).map(e => `${new Date(e.at).toISOString()} ${e.text}`) ?? []), 3),
    ...section('BLOCKED — answer with answer_agent or pass up with ask_human', blocked),
    ...section('TASKS WAITING ON YOU — inspect_task, then report_task', owed),
    ...section(`FINISHED IN THE LAST ${hours}h, NOT REPORTED — report_task or archive_agents`, finished),
    ...section('LATEST RESULTS SINCE YOUR LAST BRIEFING — journal for more', journalBriefingLines(ctx, now)),
    ...section('SQUADS WITH NO LIVE MEMBER — inspect_squad or archive_agents', dead),
    ...section('PROJECTS WITH ACTIVITY', projects),
    ...section('LATEST RULES FROM THE OPERATOR — recall for more', rules, 5),
  ];
  return {
    result: lines.join('\n'),
    summary: `briefing: ${blocked.length} blocked, ${owed.length} task(s) owed, ${finished.length} finished unreported, ${dead.length} dead squad(s)`,
  };
}
