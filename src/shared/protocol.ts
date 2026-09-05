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
  Agent, AgentMessage, Artifact, Collision, Escalation, FeedItem, KeyDescriptor,
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
  /** Something the agent produced that is worth looking at. Upsert by id. */
  | { t: 'artifact'; machineId: string; artifact: Artifact }
  /** The file is gone, or fell off the collector's cap. */
  | { t: 'artifact:gone'; machineId: string; id: string }
  /** Two agents are writing the same file. Derived from the transcripts. */
  | { t: 'collision'; machineId: string; collision: Collision }
  | { t: 'collision:clear'; machineId: string; id: string }
  /** The agent no longer needs its answer (died, or figured it out). */
  | { t: 'escalation:withdraw'; machineId: string; id: string; reason: string }
  /** Result of a command the hub sent down. A `spawn` ack carries `SpawnAck`. */
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
      /**
       * Enlist the new agent in a squad, e.g. "audit-01". The collector
       * persists it next to the mission and appends the squad brief to the
       * prompt, so the agent knows who it answers to before its first turn.
       */
      squad?: string;
      /** This one leads that squad. Meaningless without `squad`. */
      lead?: boolean;
      model?: string;
      /** Which CLI to launch. Defaults to 'claude'; a collector refuses what it cannot drive. */
      runtime?: string;
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
  /**
   * Fetch an artifact's bytes. The collector answers with an ack carrying
   * `{ base64, mime, bytes }` and serves ONLY paths it registered itself — the
   * hub names an artifact id, never a path, so a stolen hub token cannot turn
   * this into "read me any file on that laptop".
   */
  | { k: 'artifact:read'; artifactId: string }
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
  | { o: 'artifact'; id: string; v: Artifact | null }
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

/* ── acks con forma ───────────────────────────────────────────────── */

/**
 * What the `data` of a `spawn` ack carries.
 *
 * `agentId` is the whole point. Launching a squad means launching a leader and
 * then its members with `parentId` set to that leader — and without the id of
 * what you just created you cannot do the second step. The CLI prints a short
 * id, not a session id, so the collector waits (see SPAWN_ACK_TIMEOUT_MS) for
 * the session to actually show up before answering.
 *
 * `agentId` is null when the process launched but the session did not appear in
 * time. That is a success with a caveat, not a failure: the agent is running,
 * ORCA just cannot name it yet, and it will arrive on its own via `agent:new`.
 */
export interface SpawnAck {
  agentId: string | null;
  callsign: string | null;
  shortId: string | null;
  /** First line of what the CLI printed, for when something went sideways. */
  stdout?: string;
}

/**
 * How long the collector waits for a freshly spawned session to appear before
 * answering the ack anyway.
 *
 * A session becomes visible when `claude agents --json` lists it and its
 * transcript exists — a second or two on a warm machine, longer on a cold one.
 * Eight seconds is the point past which a console waiting to launch the rest of
 * a squad should be told "it started, I do not have its id yet" instead of
 * being left hanging.
 */
export const SPAWN_ACK_TIMEOUT_MS = 8_000;

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

/**
 * Ceiling for an artifact travelling as base64 inside an ack.
 *
 * Sixteen megabytes is a screenshot, a short screen recording or a generated
 * page — everything this channel exists for. Past that the answer is not a
 * bigger buffer: whatever it is, it belongs on disk where it already is, and
 * the console shows the path instead of the bytes.
 */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/**
 * Extensión → Content-Type.
 *
 * Vive aquí y no en el collector porque los dos extremos la necesitan: el
 * collector la reporta en el ack, y el hub la pone en la cabecera cuando sirve
 * desde su caché, cuando el collector ya no está para contarla. Dos copias es
 * como se consigue que un `.webp` se sirva como `octet-stream` sólo los martes.
 */
export const ARTIFACT_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

export function artifactMime(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  const name = cut >= 0 ? file.slice(cut + 1) : file;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  return ARTIFACT_MIME[ext] ?? 'application/octet-stream';
}

/** A machine is considered offline after this long without a beat. */
export const BEAT_INTERVAL_MS = 5_000;
export const BEAT_TIMEOUT_MS = 16_000;
