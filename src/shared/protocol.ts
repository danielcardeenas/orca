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
  Machine, Project, WorldState, CeoMessage, TalkItem,
} from './types.ts';

export const PROTOCOL_VERSION = 1;

/* ── collector → hub ──────────────────────────────────────────────── */

export type CollectorFrame =
  | { t: 'capcom:transfer'; machineId: string; fromId: string; hold: boolean; contextMode?: 'continuity' | 'clean'; cutoffAt?: number; toId?: string }
  | { t: 'capcom:handoff'; machineId: string; event: import('./handoff.ts').CapcomHandoff }
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
  /**
   * CAPCOM is being recycled on purpose: `fromId` is going away and a fresh
   * session is coming up. Sent BEFORE the old one is stopped, so the hub holds
   * its mail instead of pasting it into a dying pane or declaring no command.
   */
  | { t: 'capcom:rotated'; machineId: string; fromId: string; turns: number; compactions: number; contextTokens: number }
  /** Blocks of one session's conversation, in order. CAPCOM only. */
  | { t: 'talk'; machineId: string; agentId: string; items: TalkItem[] }
  /** The text CAPCOM is typing right now, off its pane. `null` when it stopped. */
  | { t: 'talk:live'; machineId: string; agentId: string; text: string | null }
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
  | { t: 'beat'; machineId: string; at: number; load: Machine['load'] }
  /** Bytes out of an attached terminal (see `term:open`). UTF-8 text. */
  | { t: 'term:data'; termId: string; data: string }
  /** The attachment ended: the pane died, the console closed it, or it never opened. */
  | { t: 'term:exit'; termId: string; reason: string }
  /**
   * What ORCA costs this machine: disk by category, CPU, memory, and the
   * space a future cleanup could reclaim. Sent on its own slow clock
   * (`HYGIENE_INTERVAL_MS`) and on demand. Sizes, counts and times only — no
   * file content, and every path already home-relative. See shared/hygiene.ts.
   */
  | { t: 'hygiene'; machineId: string; report: import('./hygiene.ts').HygieneReport };

/* ── hub → collector ──────────────────────────────────────────────── */

/**
 * Everything the hub can ask a machine to do. Deliberately a closed set: a
 * compromised hub token must not become arbitrary code execution on the Mac.
 * There is no `exec` case here and there must never be one.
 */
export type CommandFrame =
  | { t: 'cmd'; id: string; cmd: Command }
  /**
   * Take a hygiene sample now, and file it. Without `force` the collector may
   * answer from its cache, which is what keeps a panel refresh off the disk.
   *
   * A frame and not a `Command` on purpose. `Command` is the closed set of
   * things the hub may make a machine *do* — spawn, stop, say — and it is
   * closed precisely so that a compromised hub token cannot become arbitrary
   * work on the laptop. Asking for a measurement of ORCA's own footprint is
   * not that: it changes nothing, it carries no path and no agent, and the
   * reply is a report on the same channel rather than an ack.
   */
  | { t: 'hygiene:sample'; force?: boolean }
  | TermFrame;

/**
 * A live terminal, relayed.
 *
 * An agent hosted in a tmux pane can be looked at and typed into: the console
 * opens an attachment, the collector attaches a pty to the pane and streams
 * its bytes up; keystrokes go down the same way. `termId` is minted by the
 * console so both ends can name the stream before the first byte. It is not a
 * command — there is no ack and it lives as long as the window does — so it is
 * its own family of frames rather than a `Command` with a stream bolted on.
 *
 * Still no `exec`: the only thing an attachment can reach is a pane ORCA
 * itself created for a known agent, and only `claude` runs inside it.
 */
export type TermFrame =
  | { t: 'term:open'; termId: string; agentId: string; cols: number; rows: number }
  | { t: 'term:input'; termId: string; data: string }
  | { t: 'term:resize'; termId: string; cols: number; rows: number }
  | { t: 'term:close'; termId: string };

export type Command =
  | { k: 'recovery:settings'; automatic?: boolean }
  | { k: 'recovery:status'; agentId: string }
  | { k: 'recovery:decide'; agentId: string; decision: import('./recovery.ts').RecoveryRequest }
  /** `model` opcional: sin él, el relevo nace con el modelo que ya corría. */
  | { k: 'capcom:new'; agentId: string; mode: 'continuity' | 'clean'; checkpoint?: string; model?: string }
  | { k: 'handoff:models'; agentId: string }
  | { k: 'handoff:prepare'; agentId: string; runtime: string; model: string; checkpoint?: string }
  | { k: 'handoff:commit'; agentId: string; planId: string }
  | { k: 'handoff:status'; agentId: string; planId: string }
  | { k: 'handoff:history'; agentId: string; offset: number; before: number }
  | { k: 'model:list'; agentId: string }
  | { k: 'model:set'; agentId: string; model: string | null }
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
      /**
       * Host the session in a tmux pane the operator can attach to from the
       * console (a TERMINAL window), instead of a detached `--bg` job. The
       * default is a pane when the machine has tmux: the session is a plain
       * interactive one, so `say` is a paste into it and `--resume` keeps the
       * id (see docs/CONTRACT-REQUESTS.md §24). `false` forces `--bg`.
       */
      pane?: boolean;
      /** Permission posture for the spawned agent. */
      permissionMode?: 'auto' | 'acceptEdits' | 'plan' | 'manual' | 'dontAsk' | 'bypassPermissions';
      /**
       * Where the worker's files live, when the collector runs with
       * `ORCA_WORKTREES=1`: a name means "share the worktree of that name"
       * (a squad's, typically), `false` opts this one spawn out, and absent
       * means one worktree of its own. Ignored entirely without the env var,
       * so nothing changes for a fleet that did not ask.
       */
      worktree?: string | false;
    }
  /**
   * Integrate a worker's branch into the project's branch: rebase, run the
   * suite, one commit. The ack carries a `LandResult`; a refusal (conflict,
   * failing suite) is an `ok: true` ack whose data says why — the command ran,
   * the landing did not.
   */
  | { k: 'land'; agentId: string; runTests: boolean; message: string | null }
  /** Remove a worker's worktree and branch. Refused with unlanded work unless `force`. */
  | { k: 'discard'; agentId: string; force: boolean }
  /**
   * Borrar de disco los transcripts de sesiones terminadas.
   *
   * Lo único de toda la limpieza que quita bytes de verdad y no se puede
   * deshacer: el transcript es lo que el CLI escribió, y es la respuesta a por
   * qué el repo está como está. Los ids los elige quien llama —el hub sólo
   * propone los que ya archivó— y el collector se niega a tocar una sesión
   * viva. `dryRun` cuenta sin borrar.
   */
  /*
   * Lleva su `machineId` porque para cuando se manda, sus agentes ya no están
   * en el mundo: archivarlos es lo que los saca, y es requisito para purgar.
   * La lápida conserva de qué máquina eran, y es la única que lo sabe.
   */
  | { k: 'transcripts:purge'; machineId: string; agentIds: string[]; dryRun?: boolean }
  /** Send text to a running session — a reply, a nudge, an answer. */
  | { k: 'say'; agentId: string; text: string }
  /**
   * Cancel the turn a session is in the middle of, without ending it — the
   * operator's Esc, at a distance — and optionally say what to do instead.
   *
   * Deliberately NOT `stop`: that one kills the process and the pane. This
   * keeps the session, its uuid, its context and whatever it already wrote;
   * only the turn in flight is dropped. `text` rides along so that cancelling
   * and correcting are ONE action: the two runtimes need it in opposite
   * orders (see shared/interrupt.ts) and a caller doing it in two commands
   * would get the order wrong half the time.
   */
  | { k: 'interrupt'; agentId: string; text: string | null }
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
  | { k: 'logs'; agentId: string; lines: number }
  /**
   * Squad autonomy: un comando con `op` (`verify:diff`, `land:merge`, …)
   * en vez de uno nuevo por pieza. `agentId` es el agente sobre el que se
   * opera y decide a qué máquina va. Ver collector/autonomy.ts.
   */
  | AutonomyCommand;

export interface AutonomyCommand {
  k: 'autonomy';
  op: string;
  agentId: string;
  args?: Record<string, unknown>;
}

/* ── hub → console ────────────────────────────────────────────────── */

export type ServerFrame =
  /** Whole world. Sent on connect. */
  | { t: 'world'; state: WorldState }
  /** Incremental patch. `rev` must be exactly previous rev + 1 or the console
   *  asks for a resync — this is what keeps the 3D scene from tearing. */
  | { t: 'patch'; rev: number; ops: PatchOp[] }
  | { t: 'ceo:message'; message: CeoMessage }
  /** `purged` marca la que ya no existe: la consola la quita en vez de pintarla. */
  | { t: 'task'; task: import('./tasks.ts').CapcomTask; purged?: true }
  /** Token-by-token CEO output, appended to a streaming message. */
  | { t: 'ceo:delta'; id: string; text: string }
  | { t: 'ceo:done'; id: string }
  | { t: 'error'; message: string }
  | { t: 'ack'; cmdId: string; ok: boolean; detail?: string; data?: unknown }
  /**
   * CAPCOM (or a launch it made) pointing the operator's camera at something.
   * Not a patch: it changes no state, so it is not in the world and does not
   * replay — a console that connects later has nothing to fly to.
   */
  | { t: 'camera'; directive: import('./camera.ts').CameraDirective }
  | { t: 'term:data'; termId: string; data: string }
  | { t: 'term:exit'; termId: string; reason: string }
  /**
   * Hygiene reports, pushed as they arrive so an open panel stays current.
   * Not a patch and not in `WorldState`: it is a few kilobytes per machine on
   * its own clock, and no tile depends on it.
   */
  | { t: 'hygiene'; reports: import('./hygiene.ts').HygieneReport[] };

/**
 * A patch operation. Intentionally coarse — whole records, not JSON pointers.
 * The console's diffing is cheap and the scene interpolates anyway.
 */
export type PatchOp =
  | { o: 'capcom:handoffs'; v: import('./handoff.ts').CapcomHandoff[] }
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
  /** Append to one agent's conversation. `id` is the agent. */
  | { o: 'talk'; id: string; v: TalkItem[] }
  /** What that agent is typing right now; null when it stopped. */
  | { o: 'talk:live'; id: string; v: string | null }
  | { o: 'fleet'; v: WorldState['fleet'] }
  | { o: 'ceo:thinking'; v: boolean };

/* ── console → hub ────────────────────────────────────────────────── */

export type ClientFrame =
  | { t: 'hello'; v: number; token: string }
  /**
   * Ask for the fleet's hygiene. The ack carries the reports. `refresh` asks
   * every collector for a fresh sample first — the button, not the refresh.
   */
  | { t: 'hygiene:get'; id: string; refresh?: boolean }
  /** The human said something to the CEO. */
  | { t: 'ceo:say'; text: string; id?: string; taskId?: string }
  | { t: 'task:create'; id: string; taskId: string; title: string }
  /**
   * Retirar una tarea de la vista (`on: false` la devuelve), o borrarla.
   * `task:purge` sólo acepta una que ya esté archivada: lo reversible se pide
   * una vez, lo definitivo dos.
   */
  | { t: 'task:archive'; id: string; taskId: string; on?: boolean }
  | { t: 'task:purge'; id: string; taskId: string }
  /** The human answered an escalation directly, bypassing the CEO. */
  | { t: 'escalation:answer'; id: string; answer: string; rememberAs: string | null }
  /** The human acknowledged a file collision; stop showing it. */
  | { t: 'collision:ack'; id: string }
  | { t: 'escalation:dismiss'; id: string }
  /** Any machine command, routed by the hub to the owning collector. */
  | { t: 'cmd'; id: string; cmd: Command }
  /**
   * Archive finished agents (done/dead) matching a filter. Not a machine
   * command: the hub answers it alone, and acks with an `ArchiveOutcome`.
   * `dryRun` answers what would go without touching anything.
   */
  | { t: 'agents:archive'; id: string; filter: import('./archive.ts').ArchiveFilter; dryRun?: boolean }
  | { t: 'resync' }
  | { t: 'beat' }
  /** A terminal attachment; routed to the machine that hosts the agent's pane. */
  | TermFrame;

/** A `termId` is minted by the console; this is the only shape the hub relays. */
export const TERM_ID_RE = /^term_[A-Za-z0-9_-]{4,40}$/;
/** Cols/rows an attachment may ask for. Past this the pane, not the pty, is the problem. */
export const TERM_MAX_COLS = 500;
export const TERM_MAX_ROWS = 200;
/** One `term:input`/`term:data` frame carries at most this much text. */
export const TERM_MAX_CHUNK = 64 * 1024;

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
  /** Where it works, when the collector put it in a worktree of its own. */
  worktree?: string | null;
  branch?: string | null;
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
/**
 * How often a collector files a hygiene report unasked.
 *
 * Ten minutes, not five seconds: this one costs a bounded directory walk, and
 * disk usage is a quantity that moves in minutes. The panel gets live updates
 * because the hub pushes each report as it lands, not because anyone polls.
 */
export const HYGIENE_INTERVAL_MS = 10 * 60_000;
export const BEAT_TIMEOUT_MS = 16_000;
