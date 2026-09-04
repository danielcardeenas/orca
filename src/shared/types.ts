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
  | 'input'        // plain end-of-turn waiting on a prompt
  | 'error';       // needs intervention to continue

export interface Agent {
  id: string;
  machineId: string;
  projectId: string;

  /** Human title. Claude Code's own `ai-title` when present. */
  title: string;
  /** ORCA's callsign for this agent, e.g. "K9". Stable, short, for tiles. */
  callsign: string;

  state: AgentState;
  /** Present only while state === 'blocked'. */
  block: {
    kind: BlockKind;
    /** What it wants, in one line. */
    summary: string;
    /** Set when the block is an ORCA escalation. */
    escalationId?: string;
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
  /** Bumped on every mutation; the UI diffs on it. */
  rev: number;
  at: number;
  machines: Record<string, Machine>;
  projects: Record<string, Project>;
  agents: Record<string, Agent>;
  escalations: Record<string, Escalation>;
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
    keys: {},
    ceo: { messages: [], thinking: false, awaitingHuman: false },
    feed: [],
    fleet: emptyRollup(),
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
