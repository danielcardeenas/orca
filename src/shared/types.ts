/**
 * ORCA state model.
 *
 * Everything the console renders — 2D deck and 3D scene alike — is derived from
 * this shape. Collectors produce it, the hub aggregates it, the UI is a pure
 * function of it. Nothing else is allowed to become a source of truth.
 */

/* ── Fleet topology ───────────────────────────────────────────────── */

/** A machine running Claude Code. Your Mac, a VPS, a container. */
export interface Machine {
  id: string;
  hostname: string;
  platform: 'darwin' | 'linux' | 'win32' | string;
  /** Collector agent version, so the hub can refuse stale wire formats. */
  version: string;
  online: boolean;
  /** epoch ms of the last frame received from this machine's collector */
  lastSeen: number;
  /** epoch ms when the collector first connected this run */
  connectedAt: number;
  /** Load signals for the deck's machine strip. */
  load: {
    sessions: number;
    activeSessions: number;
    cpuPct: number | null;
    memPct: number | null;
  };
}

/** A directory Claude Code has sessions in. One island in the 3D scene. */
export interface Project {
  id: string;
  machineId: string;
  /** ~/.claude/projects slug, e.g. "-Users-dan-projects-axolots" */
  slug: string;
  /** Human name — last path segment, or an override from project config. */
  name: string;
  path: string;
  /** Short two-char code for tiles, e.g. "AX". Derived, stable. */
  code: string;
  gitBranch: string | null;
  gitDirty: boolean;
  /** Which credentials this project has been granted. Names only, never values. */
  keyNames: string[];
  sessionIds: string[];
  /** Rolled up from sessions, for the project tile without a full scan. */
  rollup: SessionRollup;
}

/* ── Agents (Claude Code sessions) ────────────────────────────────── */

/**
 * The lifecycle an agent moves through. `blocked` is the reason this product
 * exists: it is the only state that requires a human, and the only one the
 * scene is allowed to shout about.
 */
export type AgentState =
  | 'booting'   // process spawned, no transcript events yet
  | 'thinking'  // assistant streaming, no tool call yet
  | 'working'   // executing a tool
  | 'blocked'   // waiting on a permission prompt or an explicit question
  | 'idle'      // end_turn, waiting for a human to say something
  | 'done'      // session ended cleanly
  | 'dead';     // process vanished or errored out

export const AGENT_STATES: AgentState[] = [
  'booting', 'thinking', 'working', 'blocked', 'idle', 'done', 'dead',
];

/** Why an agent is blocked — drives what the console offers the human. */
export type BlockKind =
  | 'permission'   // Claude Code is asking to run a tool
  | 'question'     // the agent asked the human something (via ORCA escalation)
  | 'peer'         // the agent asked ANOTHER AGENT something and is waiting
  | 'input'        // plain end-of-turn waiting on a prompt
  | 'error';       // needs intervention to continue

/**
 * What an agent is for.
 *
 * Almost every session is an `agent`: it works in a repo, it produces code, it
 * asks questions. Exactly one session per machine may be `capcom` — the CLI
 * session that commands the fleet on the human's behalf, whose tools are the
 * hub's MCP server rather than a filesystem.
 *
 * It is a role and not a flag because the console renders it differently (its
 * transcript IS the command window) and the hub routes to it differently (what
 * the human types goes to it, and every escalation is offered to it first).
 */
export type AgentRole = 'agent' | 'capcom';

export interface Agent {
  continuation?: import('./continuation.ts').Continuation;
  modelControl?: import('./model-control.ts').ModelControl;
  id: string;
  machineId: string;
  projectId: string;

  /** Human title. Claude Code's own `ai-title` when present. */
  title: string;
  /** ORCA's callsign for this agent, e.g. "K9". Stable, short, for tiles. */
  callsign: string;
  /**
   * Which CLI drives it: 'claude', 'codex', 'grok', … The collector that
   * watches the session knows; everything downstream only displays it.
   */
  runtime: string;
  /**
   * `agent` or `capcom`. Set by the collector that launched the session; never
   * inferred from the transcript, because a session that merely talks about the
   * fleet is not the one commanding it.
   *
   * Optional on the type and never optional on the wire: everything the hub
   * hands out has been through `sanitizeAgent`, which always fills it in. It is
   * declared optional so that reading it is `a.role === 'capcom'` — an absent
   * field means an ordinary agent, which is the only sane default and the one a
   * record written before this field existed should get.
   */
  role?: AgentRole;
  /**
   * True when this session exists but does not belong on the fleet.
   *
   * Set by the collector for everything living in a directory that is not a
   * project (see `shared/workspaces.ts`): the CAPCOM sessions that came before
   * the live one, and the agents somebody launched inside CAPCOM's own
   * directory or in a session scratchpad. They are reported rather than
   * dropped — the transcript is still on disk and the operator may want to
   * look — but `list_fleet`, `list_agents`, the field and every counter leave
   * them out unless explicitly asked for them.
   *
   * Optional, and false for every ordinary agent: an absent field means "on
   * the fleet", which is what a record written before this existed should get.
   */
  hidden?: boolean;

  /** Verified launch provenance, inherited by native children. */
  origin?: 'orca' | 'external';
  /**
   * True when this is a Claude Code `Task` subagent: a transcript under its
   * parent's `subagents/` directory, not a session of its own. It exists to
   * do one job for its parent and report back, so the console folds it into
   * the parent's block instead of giving it a tile and a pipe. An agent
   * ORCA spawned as a full session is never a subagent, whoever asked for it.
   */
  subagent?: boolean;

  state: AgentState;
  /** Present only while state === 'blocked'. */
  block: {
    kind: BlockKind;
    /** What it wants, in one line. */
    summary: string;
    /** Set when the block is an ORCA escalation. */
    escalationId?: string;
    /** Set when kind === 'peer': the unanswered message it is waiting on. */
    messageId?: string;
    /** Set when kind === 'peer': who owes the answer. */
    waitingOn?: string;
    since: number;
  } | null;

  /** Who spawned it. null = launched by the human. Drives the lineage graph. */
  parentId: string | null;
  /** 0 for a root agent, +1 per generation. */
  depth: number;
  /** Direct children, so the scene can draw lineage without a full scan. */
  childIds: string[];
  /** Why this agent exists — the brief it was spawned with. */
  mission: string | null;

  /**
   * The squad this agent was enlisted in, e.g. "audit-01". null = not in one.
   *
   * A squad is lineage with a name on it. `parentId` already says who launched
   * whom, but a tree cannot say "these five are the audit, and that one speaks
   * for them" — and that is the unit an operator actually thinks in. Set only
   * by the `spawn` command that created the agent; never inferred.
   */
  squad: string | null;
  /**
   * True when this agent leads its squad: it briefs its members, consolidates
   * what they find, and is the only one of them allowed to reach the human.
   * Meaningless without `squad`.
   */
  lead: boolean;

  model: string | null;
  /** Which tool is running right now, e.g. "Bash", "Edit". Null when not working. */
  tool: string | null;
  /** One-line detail for the tool, e.g. the command or the file path. */
  toolDetail: string | null;

  lastPrompt: string | null;
  /** Last thing the agent said, trimmed. Feeds the deck's activity column. */
  lastSay: string | null;

  startedAt: number;
  updatedAt: number;
  /** Wall-clock ms this agent has been alive. */
  uptimeMs: number;

  metrics: AgentMetrics;

  /** True when this is a background session claude can attach/stop by id. */
  background: boolean;
  /** Claude Code's own short id for `claude attach <id>`, when background. */
  shortId: string | null;
  /**
   * True when the session lives in a tmux pane ORCA created, so the console
   * can open a TERMINAL on it. A session the human started in their own shell
   * has no pane: it can be watched, not attached to.
   */
  pane?: boolean;
  /**
   * The git worktree the collector launched it in, when it runs workers in
   * worktrees (`ORCA_WORKTREES=1`), and the branch it works on there
   * (`orca/<name>`). Absent or null for an agent on the project's own tree.
   * Set by the `spawn` that created it, persisted in lineage.json like
   * `mission`; `land` and `discard` act on it.
   */
  worktree?: string | null;
  branch?: string | null;
}

export interface AgentMetrics {
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  thinkingTokens: number;
  /** Rolling output tokens/sec — drives motion amplitude in the 3D scene. */
  tokensPerSec: number;
  linesAdded: number;
  linesRemoved: number;
  toolCalls: number;
  /** ms spent inside tools vs. waiting on the API. */
  toolDurationMs: number;
  apiDurationMs: number;
  turns: number;
  /**
   * Tokens in the model's context at its last call: input + cache creation +
   * cache read. The one number that says how full the window is.
   */
  contextTokens?: number;
  /**
   * How big that window is, when the CLI says so. With `contextTokens` it
   * turns "122k tokens" — a number nobody can size by eye — into a fraction,
   * which is what a rotation threshold can be written against.
   */
  contextWindow?: number;
  /** Times the CLI compacted this conversation. Each one is memory lost. */
  compactions?: number;
}

/** Aggregate over a set of agents. Computed, never stored by a producer. */
export interface SessionRollup {
  total: number;
  byState: Record<AgentState, number>;
  costUSD: number;
  tokensPerSec: number;
  /** Number of agents needing a human right now. The deck sorts on this. */
  blocked: number;
}

/* ── Escalations: the agent → human channel ───────────────────────── */

/**
 * An agent needs something only the human knows. It asks the CEO first; if the
 * CEO cannot answer from project context, the question is escalated here and
 * surfaces in the console as an interrupt.
 */
export type EscalationStatus = 'pending' | 'with_ceo' | 'answered' | 'withdrawn' | 'expired';

export interface Escalation {
  /** Terminal approval: sending a key is not resolution. */
  permission?: { phase: 'requested' | 'pending' | 'confirmed'; fingerprint: string };
  id: string;
  /** Agent that raised it. */
  agentId: string;
  projectId: string;
  machineId: string;

  question: string;
  /** Extra context the agent supplied to help the human answer fast. */
  context: string | null;
  /** Suggested answers. The console renders these as one-tap replies. */
  options: string[];
  /** Free text is always allowed unless the agent insists on an option. */
  optionsOnly: boolean;

  urgency: 'low' | 'normal' | 'blocking';
  status: EscalationStatus;

  /** The CEO's attempt before it reached the human, if any. */
  ceoAttempt: {
    answer: string;
    confidence: number;
    /** Why it punted. Shown to the human so they can fix the gap once. */
    reason: string;
  } | null;

  answer: string | null;
  answeredBy: 'human' | 'ceo' | null;
  /** When answered by a human, offer to remember it for next time. */
  rememberAs: string | null;

  askedAt: number;
  answeredAt: number | null;
  /** Auto-withdraw if the agent dies waiting. */
  expiresAt: number | null;
}

/* ── The CEO: the human's single point of contact ─────────────────── */

export type CeoRole = 'human' | 'ceo' | 'system';

export interface CeoMessage {
  id: string;
  role: CeoRole;
  text: string;
  at: number;
  /** Tool calls the CEO made for this turn, rendered as instrument readouts. */
  actions: CeoAction[];
  /** Set when this message is the CEO relaying an agent's escalation. */
  escalationId?: string;
  /** Streaming messages render progressively and are replaced on completion. */
  streaming?: boolean;
}

export interface CeoAction {
  id: string;
  name: string;
  /** One-line human summary, e.g. "spawned 3 agents on axolots". */
  summary: string;
  status: 'running' | 'ok' | 'error';
  detail?: string;
  at: number;
}

/* ── Talk: what a session actually said, block by block ───────────── */

/**
 * One block of a session's conversation, as its CLI wrote it to disk.
 *
 * `lastPrompt` / `lastSay` are one trimmed line each, enough for a tile. A
 * command window needs the conversation itself: the prompt in full, the
 * thinking, every tool the session reached for, what came back, and the
 * answer in full — in the order it happened, as it happens. The CLI appends
 * one JSONL line per content block, so this is the finest grain there is
 * short of a pty: a reply shows up paragraph by paragraph, not token by
 * token, and thinking shows up when the block closes.
 *
 * Emitted for the CAPCOM session only: it is the one conversation the human
 * reads in the console. Any other agent's is a TERMINAL away.
 */
export type TalkKind =
  | 'prompt'    // the human (or the hub on their behalf) said this
  | 'thinking'  // a thinking block; empty text when the CLI redacted it
  | 'say'       // a text block of the assistant's reply
  | 'tool'      // a tool call: `tool` is the name, `text` the one-line detail
  | 'result';   // what a tool returned, trimmed; `error` when the CLI flagged it

export interface TalkItem {
  /** Stable: the transcript line's uuid plus the block index. */
  id: string;
  agentId: string;
  at: number;
  kind: TalkKind;
  /** Full text, bounded by MAX_TALK_TEXT. */
  text: string;
  /** For `tool` and `result`: the tool's name. */
  tool?: string;
  /** For `tool` and `result`: the `tool_use` id that pairs them. */
  toolUseId?: string;
  /** For `result`: the CLI marked it an error. */
  error?: boolean;
  /** For assistant blocks: the API message they belong to. */
  msgId?: string;
}

/** Past this a block is a file, not a line in a chat. */
export const MAX_TALK_TEXT = 8_000;
/** A tool result is a glance, never the whole file it read. */
export const MAX_TALK_RESULT = 600;
/** Blocks kept per agent, hub and console alike. */
export const MAX_TALK = 300;

/* ── Telemetry feed ───────────────────────────────────────────────── */

export type FeedLevel = 'trace' | 'info' | 'warn' | 'alert';

/** One line in the scrolling HUD telemetry strip. */
export interface FeedItem {
  id: string;
  at: number;
  level: FeedLevel;
  /** Origin, e.g. "AX/K9" (project code / agent callsign) or "ORCA". */
  source: string;
  text: string;
  agentId?: string;
  projectId?: string;
}

/* ── Agent ↔ agent traffic ────────────────────────────────────────── */

/**
 * What one agent tells another.
 *
 * Agents have no socket to each other; they have a filesystem and a CEO that
 * can see all of them. So a message is a file an agent drops, the collector
 * picks up, and the hub routes — the same shape as an escalation, with an
 * agent at the other end instead of the human.
 *
 * The CEO is the router on purpose. Twenty agents with direct lines to each
 * other is twenty agents interrupting each other; routed, a message can be
 * held until its recipient is between turns, merged with others, or answered
 * by the CEO without waking anybody.
 */
export type MessageKind =
  /** "I found this out." Anyone in scope may care; nobody must act. */
  | 'notice'
  /** "I need this from you." Creates a wait: the sender is stuck until it lands. */
  | 'ask'
  /** "This is now yours." Hands work over, with context. */
  | 'handoff'
  /** "Careful." Something the recipient is about to walk into. */
  | 'warning';

export type MessageScope =
  | 'agent'     // one named agent
  | 'project'   // everyone working in one project
  | 'squad'     // everyone enlisted in one squad, wherever they are
  | 'fleet';    // everyone, everywhere

export interface AgentMessage {
  id: string;
  kind: MessageKind;
  scope: MessageScope;

  fromAgentId: string;
  fromCallsign: string;
  fromProjectId: string;

  /** Set when scope === 'agent'. */
  toAgentId: string | null;
  /** Set when scope === 'project'. */
  toProjectId: string | null;
  /**
   * Set when scope === 'squad'. A name, not an id: a squad is not a record
   * anywhere, it is whatever set of agents currently carries that label, and
   * that set can span machines.
   */
  toSquad: string | null;

  /** One line. This is what shows on an edge in the map. */
  subject: string;
  body: string | null;
  /** Files this is about, so a collision or a handoff can point at something. */
  files: string[];

  at: number;
  /** Agent ids that have consumed it. */
  readBy: string[];
  /** Notices go stale; asks do not. */
  expiresAt: number | null;

  /**
   * Set on an `ask` once answered. An unanswered ask is what makes the sender
   * a link in a waiting chain.
   */
  answer: string | null;
  answeredAt: number | null;
  answeredBy: string | null;
}

/**
 * Two agents editing the same file.
 *
 * Derived, never declared — the transcripts already say which files each agent
 * touched, so this costs nothing and needs no cooperation from the agents. It
 * is also the failure nobody notices until the second agent's work is silently
 * overwritten.
 */
export interface Collision {
  id: string;
  path: string;
  projectId: string;
  machineId: string;
  /** Live agents that have written this file inside the collision window. */
  agentIds: string[];
  firstSeen: number;
  lastSeen: number;
  /** Cleared once the operator or the CEO has seen it. */
  acknowledged: boolean;
}

/* ── The world: where the operator arranges the fleet ─────────────── */

/**
 * Where an agent sits in the infinite field.
 *
 * Two kinds of position, and the difference matters. A *placed* agent was put
 * there by the operator, and that arrangement is meaning: "these three are the
 * payments work", "this cluster is what I check first". A *drifting* agent has
 * never been touched and is laid out automatically near its project.
 *
 * The operator's arrangement always wins and always persists. An automatic
 * layout that reshuffles what somebody deliberately placed destroys the only
 * thing that makes a spatial workspace worth more than a list.
 */
export interface Placement {
  agentId: string;
  x: number;
  y: number;
  /** Depth. Negative is further away. Usually derived, sometimes dragged. */
  z: number;
  /** True once a human moved it; automatic layout stops touching it. */
  pinned: boolean;
  at: number;
}

export type ArtifactKind = 'image' | 'video' | 'html' | 'text' | 'file';

/**
 * Something an agent produced that is worth looking at.
 *
 * The point of a workspace rather than a monitor: work appears in the space
 * where you are, next to the agent that made it, instead of being a path in a
 * log line that you have to go open somewhere else.
 */
export interface Artifact {
  id: string;
  agentId: string;
  projectId: string;
  machineId: string;
  kind: ArtifactKind;
  /** Absolute path on the machine that made it. */
  path: string;
  /** One line: what this is. */
  title: string;
  /** Served by the hub at /api/artifact/<id>; null until it is fetched. */
  url: string | null;
  bytes: number;
  /** For image/video, so the field can lay it out before loading it. */
  width: number | null;
  height: number | null;
  at: number;
  /**
   * The agent asked for this one to be opened, not merely filed —
   * `orca-show --open`. It is a request, never a guarantee: the console
   * decides what "open" means and whether now is the moment.
   */
  open: boolean;
  /** Set when the operator has pulled it out of its agent into the field. */
  placement: { x: number; y: number; z: number } | null;
}

/* ── Credentials ──────────────────────────────────────────────────── */

/**
 * Keys are given to a project once and never leave the machine that holds
 * them. The hub and console only ever see this descriptor.
 */
export interface KeyDescriptor {
  name: string;
  projectId: string;
  /** Last 4 characters, for recognition without exposure. */
  hint: string;
  addedAt: number;
  lastUsedAt: number | null;
  /** Which agents have read it, for the audit panel. */
  usedBy: string[];
}

/* ── The world ────────────────────────────────────────────────────── */

/** Complete console state. The UI renders this and nothing else. */
export interface WorldState {
  capcomHandoffs?: import('./handoff.ts').CapcomHandoff[];
  tasks?: Record<string, import('./tasks.ts').CapcomTask>;
  /** Bumped on every mutation; the UI diffs on it. */
  rev: number;
  at: number;
  machines: Record<string, Machine>;
  projects: Record<string, Project>;
  agents: Record<string, Agent>;
  escalations: Record<string, Escalation>;
  messages: Record<string, AgentMessage>;
  collisions: Record<string, Collision>;
  artifacts: Record<string, Artifact>;
  /** Operator-arranged positions, keyed by agent id. */
  placements: Record<string, Placement>;
  keys: Record<string, KeyDescriptor>;
  ceo: {
    /** Bounded — older turns live in the hub's storage, not in the frame. */
    messages: CeoMessage[];
    thinking: boolean;
    /** Set when the CEO is waiting on the human. */
    awaitingHuman: boolean;
  };
  feed: FeedItem[];
  fleet: SessionRollup;
  /** The CAPCOM conversation, block by block, keyed by agent id. See TalkItem. */
  talk?: Record<string, TalkItem[]>;
  /**
   * The reply CAPCOM is typing right now, read off its pane, keyed by agent
   * id. Present only while a text block is streaming; the finished block
   * arrives in `talk` and this goes away. Best effort: it is what the TUI
   * painted, not what the API said.
   */
  talkLive?: Record<string, string>;
}

export function emptyRollup(): SessionRollup {
  return {
    total: 0,
    byState: { booting: 0, thinking: 0, working: 0, blocked: 0, idle: 0, done: 0, dead: 0 },
    costUSD: 0,
    tokensPerSec: 0,
    blocked: 0,
  };
}

export function emptyWorld(): WorldState {
  return {
    rev: 0,
    at: Date.now(),
    machines: {},
    projects: {},
    agents: {},
    escalations: {},
    messages: {},
    collisions: {},
    artifacts: {},
    placements: {},
    keys: {},
    ceo: { messages: [], thinking: false, awaitingHuman: false },
    feed: [],
    fleet: emptyRollup(),
    talk: {},
    talkLive: {},
  };
}

/** States that mean the agent is doing something right now. */
export const LIVE_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  'booting', 'thinking', 'working', 'blocked',
]);

/** States that mean the agent is finished with this run. */
export const TERMINAL_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['done', 'dead']);

export function isLive(a: Agent): boolean {
  return LIVE_STATES.has(a.state);
}

export function needsHuman(a: Agent): boolean {
  return a.state === 'blocked' || a.state === 'idle';
}
