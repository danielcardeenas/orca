/**
 * ORCA wire protocol.
 *
 * Three parties, two links, all connections outbound:
 *
 *   collector  ──(ws, outbound)──▶  hub  ◀──(ws)──  console
 *
 * Collectors dial the hub, never the reverse. That is what makes a VPS behind a
 * firewall and a laptop behind NAT equivalent citizens: nothing needs an open
 * port but the hub.
 */

import type {
  Agent, AgentMessage, Collision, Escalation, FeedItem, KeyDescriptor,
  Machine, Project, WorldState, CeoMessage,
} from './types.ts';

export const PROTOCOL_VERSION = 1;

/* ── collector → hub ──────────────────────────────────────────────── */

export type CollectorFrame =
  /** First frame on every connection. The hub rejects a version mismatch. */
  | { t: 'hello'; v: number; machine: Machine; token: string }
  /** Full picture of one machine. Sent on connect and after any resync. */
  | { t: 'snapshot'; machineId: string; projects: Project[]; agents: Agent[]; keys: KeyDescriptor[] }
  /** Incremental agent change. `patch` is a shallow merge over the agent. */
  | { t: 'agent'; machineId: string; id: string; patch: Partial<Agent> }
  /** A new agent appeared. */
  | { t: 'agent:new'; machineId: string; agent: Agent }
  /** An agent is gone from disk entirely (session deleted). */
  | { t: 'agent:gone'; machineId: string; id: string }
  | { t: 'project'; machineId: string; id: string; patch: Partial<Project> }
  | { t: 'project:new'; machineId: string; project: Project }
  /** Telemetry lines for the HUD strip. Batched. */
  | { t: 'feed'; machineId: string; items: FeedItem[] }
  /** An agent asked the human something. */
  | { t: 'escalation'; machineId: string; escalation: Escalation }
  /** An agent said something to another agent, a project, or the fleet. */
  | { t: 'message'; machineId: string; message: AgentMessage }
  /** Two agents are writing the same file. Derived from the transcripts. */
  | { t: 'collision'; machineId: string; collision: Collision }
  | { t: 'collision:clear'; machineId: string; id: string }
  /** The agent no longer needs its answer (died, or figured it out). */
  | { t: 'escalation:withdraw'; machineId: string; id: string; reason: string }
  /** Result of a command the hub sent down. */
  | { t: 'ack'; cmdId: string; ok: boolean; detail?: string; data?: unknown }
  /** Liveness. The hub marks a machine offline after 3 missed beats. */
  | { t: 'beat'; machineId: string; at: number; load: Machine['load'] };

/* ── hub → collector ──────────────────────────────────────────────── */

/**
 * Everything the hub can ask a machine to do. Deliberately a closed set: a
 * compromised hub token must not become arbitrary code execution on the Mac.
 * There is no `exec` case here and there must never be one.
 */
export type CommandFrame =
  | { t: 'cmd'; id: string; cmd: Command };

export type Command =
  /** Start a Claude Code session in a project. */
  | {
      k: 'spawn';
      projectId: string;
      prompt: string;
      /** Inherited by the spawned agent for the lineage graph. */
      parentId: string | null;
      mission: string;
      model?: string;
      /** Background sessions survive the console disconnecting. */
      background: boolean;
      /** Permission posture for the spawned agent. */
      permissionMode?: 'auto' | 'acceptEdits' | 'plan' | 'manual';
    }
  /** Send text to a running session — a reply, a nudge, an answer. */
  | { k: 'say'; agentId: string; text: string }
  /** Answer a permission prompt. */
  | { k: 'permit'; agentId: string; allow: boolean; scope: 'once' | 'session' }
  | { k: 'stop'; agentId: string }
  | { k: 'resume'; agentId: string }
  /** Remove a finished session and its worktree when safe. */
  | { k: 'remove'; agentId: string }
  /** Answer an escalation. Routed to the agent that raised it. */
  | { k: 'answer'; escalationId: string; answer: string; rememberAs: string | null }
  /**
   * Deliver a message into an agent's inbox on disk. This is how a routed
   * message reaches its recipient: the hub decides, the collector writes.
   */
  | { k: 'deliver'; agentId: string; message: AgentMessage }
  /** Answer an agent's `ask`, so whoever sent it stops waiting. */
  | { k: 'reply'; messageId: string; answer: string; fromAgentId: string | null }
  /** Store a credential on the machine. The value never returns. */
  | { k: 'key:set'; projectId: string; name: string; value: string }
  | { k: 'key:remove'; projectId: string; name: string }
  /** Ask for a fresh snapshot — used after a reconnect. */
  | { k: 'resync' }
  /** Fetch recent terminal output for the log drawer. */
  | { k: 'logs'; agentId: string; lines: number };

/* ── hub → console ────────────────────────────────────────────────── */

export type ServerFrame =
  /** Whole world. Sent on connect. */
  | { t: 'world'; state: WorldState }
  /** Incremental patch. `rev` must be exactly previous rev + 1 or the console
   *  asks for a resync — this is what keeps the 3D scene from tearing. */
  | { t: 'patch'; rev: number; ops: PatchOp[] }
  | { t: 'ceo:message'; message: CeoMessage }
  /** Token-by-token CEO output, appended to a streaming message. */
  | { t: 'ceo:delta'; id: string; text: string }
  | { t: 'ceo:done'; id: string }
  | { t: 'error'; message: string }
  | { t: 'ack'; cmdId: string; ok: boolean; detail?: string; data?: unknown };

/**
 * A patch operation. Intentionally coarse — whole records, not JSON pointers.
 * The console's diffing is cheap and the scene interpolates anyway.
 */
export type PatchOp =
  | { o: 'machine'; id: string; v: Machine | null }
  | { o: 'project'; id: string; v: Project | null }
  | { o: 'agent'; id: string; v: Agent | null }
  | { o: 'agent:patch'; id: string; v: Partial<Agent> }
  | { o: 'escalation'; id: string; v: Escalation | null }
  | { o: 'message'; id: string; v: AgentMessage | null }
  | { o: 'collision'; id: string; v: Collision | null }
  | { o: 'key'; id: string; v: KeyDescriptor | null }
  | { o: 'feed'; v: FeedItem[] }
  | { o: 'fleet'; v: WorldState['fleet'] }
  | { o: 'ceo:thinking'; v: boolean };

/* ── console → hub ────────────────────────────────────────────────── */

export type ClientFrame =
  | { t: 'hello'; v: number; token: string }
  /** The human said something to the CEO. */
  | { t: 'ceo:say'; text: string }
  /** The human answered an escalation directly, bypassing the CEO. */
  | { t: 'escalation:answer'; id: string; answer: string; rememberAs: string | null }
  /** The human acknowledged a file collision; stop showing it. */
  | { t: 'collision:ack'; id: string }
  | { t: 'escalation:dismiss'; id: string }
  /** Any machine command, routed by the hub to the owning collector. */
  | { t: 'cmd'; id: string; cmd: Command }
  | { t: 'resync' }
  | { t: 'beat' };

/* ── helpers ──────────────────────────────────────────────────────── */

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** Ports. Kept here so collector, hub and UI cannot drift apart. */
export const PORTS = {
  ui: 4478,
  hub: 4479,
} as const;

export const PATHS = {
  collector: '/ws/collector',
  console: '/ws/console',
} as const;

/** A machine is considered offline after this long without a beat. */
export const BEAT_INTERVAL_MS = 5_000;
export const BEAT_TIMEOUT_MS = 16_000;
