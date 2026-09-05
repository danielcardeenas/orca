/**
 * The agent → fleet channel: an agent asks for another pair of hands.
 *
 * Sibling of `messages.ts`, and deliberately the same shape: an agent has no
 * socket and no hub token, it has a filesystem. So growing a squad is writing
 * a file and waiting for the collector to answer next to it:
 *
 *   <project>/.orca/spawn/<id>.json        the request (orca-spawn writes it)
 *   <project>/.orca/spawn/<id>.ack.json    what happened (we write it)
 *
 * The request is a brief and, optionally, a squad. Everything else is decided
 * HERE, from what the collector already knows, and never trusted from the
 * file: the child's parent is whoever asked, its squad is the asker's squad,
 * and it is never a lead. A lead that wants a fourth member does not get to
 * appoint a second lead, and a member does not get to defect to another squad
 * by asking nicely.
 *
 * Two caps keep this from being a fork bomb with a nice name:
 *
 *  - an agent may have at most `MAX_CHILDREN` live children of its own
 *  - a squad may hold at most `MAX_SQUAD` agents, however they got there
 *
 * Both refusals are written into the ack with the reason, because a request
 * that silently did nothing looks exactly like a collector that is down.
 *
 * Nothing under `.orca/spawn/` is trusted: it was written by an agent, and an
 * agent that is having a bad day can write anything. Shape, size and length
 * are checked before a single process starts.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { Command } from '../shared/protocol.ts';
import { squadName } from '../shared/squads.ts';
import { errText, guardAsync, log, oneLine, safeJson, str } from './util.ts';

const SCOPE = 'spawns';

export const SPAWN_DIR = path.join('.orca', 'spawn');

/** Live children one agent may have asked for. Enough for a real fan-out. */
export const MAX_CHILDREN = 8;
/** Agents in one squad, counting the lead. Matches the launcher's ceiling. */
export const MAX_SQUAD = 13;
/** A brief shorter than this produces an agent that asks five questions. */
export const MIN_BRIEF = 20;
export const MAX_BRIEF = 100_000;
/** A request bigger than this is not a request, it is an accident. */
const MAX_REQ_BYTES = 256 * 1024;
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

/* ── the request ──────────────────────────────────────────────────── */

export interface SpawnRequest {
  /** The request file's stem: what the ack is named after. */
  id: string;
  projectId: string;
  /** Who asked, resolved by the collector — never taken from the file alone. */
  requesterId: string | null;
  mission: string;
  /** A squad the requester named. Only honoured when they are in none. */
  squad: string | null;
  model: string | null;
  at: number;
  /** Where to write the ack. */
  ackFile: string;
}

/** What the collector knows about the asker, for the policy below. */
export interface Requester {
  id: string;
  callsign: string;
  squad: string | null;
  /** Ids of its live children. */
  liveChildren: number;
}

export interface SpawnAckFile {
  ok: boolean;
  /** Why not, when `ok` is false. Written for the agent to read and act on. */
  reason?: string;
  agentId?: string | null;
  callsign?: string | null;
  shortId?: string | null;
  squad?: string | null;
  parentId?: string | null;
  at: number;
}

/**
 * Turn a request into the spawn the collector will run, or a refusal.
 *
 * Pure on purpose: the whole policy is here and a test can read it without a
 * collector. `squadSize` is how many agents currently carry the label the
 * child would get.
 */
export function planChild(
  req: SpawnRequest, who: Requester | null, squadSize: (name: string) => number,
): { ok: true; cmd: Command; squad: string | null } | { ok: false; reason: string } {
  if (!who) {
    return { ok: false, reason: 'could not tell which agent asked; pass --agent <your session id>' };
  }
  if (who.liveChildren >= MAX_CHILDREN) {
    return { ok: false, reason: `${who.callsign} already has ${who.liveChildren} live children (max ${MAX_CHILDREN}); wait for one to finish, or hand work to the ones you have` };
  }
  // The asker's squad wins. An agent in a squad spawns into it, full stop;
  // one in none may name one, and then the child carries that label with the
  // asker as its parent — the asker leads it in fact if not in name.
  const squad = who.squad ?? req.squad;
  if (squad !== null) {
    const size = squadSize(squad);
    if (size >= MAX_SQUAD) {
      return { ok: false, reason: `squad ${squad} already has ${size} agents (max ${MAX_SQUAD})` };
    }
  }
  return {
    ok: true,
    squad,
    cmd: {
      k: 'spawn',
      projectId: req.projectId,
      prompt: req.mission,
      mission: req.mission,
      parentId: who.id,
      ...(squad ? { squad, lead: false } : {}),
      ...(req.model ? { model: req.model } : {}),
      background: true,
      permissionMode: 'acceptEdits',
    },
  };
}

/** Write the ack next to the request, atomically, so a torn read is impossible. */
export async function writeAck(file: string, ack: SpawnAckFile): Promise<void> {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(ack, null, 2));
  await fsp.rename(tmp, file);
}

/* ── the watcher ──────────────────────────────────────────────────── */

interface Tracked {
  projectId: string;
  projectPath: string;
  dir: string;
}

export interface SpawnDeps {
  /** Attribute the file to an agent. The file may declare `agentId`; else the project's most active. */
  resolveAgent(projectId: string, hint: string | null): string | null;
}

async function readdirQuiet(dir: string): Promise<string[] | null> {
  try { return await fsp.readdir(dir); } catch { return null; }
}

export class SpawnWatcher {
  private readonly deps: SpawnDeps;
  private tracked = new Map<string, Tracked>();
  private watchers = new Map<string, fs.FSWatcher>();
  private timer: NodeJS.Timeout | null = null;
  private cbs: ((r: SpawnRequest) => Promise<void> | void)[] = [];
  private scanning = false;
  /** Requests being handled right now: a second tick must not launch twice. */
  private busy = new Set<string>();

  constructor(deps: SpawnDeps) { this.deps = deps; }

  /**
   * A request was picked up. The handler decides, spawns, and writes the ack;
   * the watcher deletes the request file once the handler returns, so a crash
   * mid-spawn re-emits the same request rather than losing it — and the ack
   * file, if it got written, tells the second pass it is already done.
   */
  onRequest(cb: (r: SpawnRequest) => Promise<void> | void): void { this.cbs.push(cb); }

  start(pollMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.scan(); }, pollMs);
    this.timer.unref?.();
    void this.scan();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of this.watchers.values()) { try { w.close(); } catch { /* ya cerrado */ } }
    this.watchers.clear();
  }

  track(projectId: string, projectPath: string): void {
    const cur = this.tracked.get(projectId);
    if (cur && cur.projectPath === projectPath) return;
    this.untrack(projectId);
    this.tracked.set(projectId, { projectId, projectPath, dir: path.join(projectPath, SPAWN_DIR) });
  }

  untrack(projectId: string): void {
    this.tracked.delete(projectId);
    const w = this.watchers.get(projectId);
    if (w) { try { w.close(); } catch { /* ya cerrado */ } this.watchers.delete(projectId); }
  }

  /** One pass over every tracked directory. Exposed so a test need not wait a tick. */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const t of this.tracked.values()) {
        this.attachWatch(t);
        const names = await readdirQuiet(t.dir);
        if (names === null) continue;
        for (const name of names) {
          if (!name.endsWith('.json') || name.endsWith('.ack.json')) continue;
          if (name.startsWith('.')) continue; // the CLI's half-renamed .tmp
          await this.take(t, path.join(t.dir, name));
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private attachWatch(t: Tracked): void {
    if (this.watchers.has(t.projectId)) return;
    if (!fs.existsSync(t.dir)) return;
    try {
      const w = fs.watch(t.dir, () => { void this.scan(); });
      w.on('error', () => {
        try { w.close(); } catch { /* ya cerrado */ }
        this.watchers.delete(t.projectId);
      });
      this.watchers.set(t.projectId, w);
    } catch {
      // Without watch there is the 1 s poll. A spawn takes seconds anyway.
    }
  }

  private async take(t: Tracked, file: string): Promise<void> {
    if (this.busy.has(file)) return;
    let stat: fs.Stats;
    try { stat = await fsp.stat(file); } catch { return; }
    if (!stat.isFile()) return;
    if (stat.size > MAX_REQ_BYTES) {
      log('warn', SCOPE, `${file} pesa ${stat.size}B, descartado`);
      await fsp.unlink(file).catch(() => { /* da igual */ });
      return;
    }
    const text = await guardAsync(SCOPE, `leer ${path.basename(file)}`, () => fsp.readFile(file, 'utf8'), '');
    const obj = safeJson<Record<string, unknown>>(text);
    if (!obj) return; // half-written: next tick

    const stem = path.basename(file, '.json');
    const ackFile = path.join(t.dir, `${stem}.ack.json`);

    // Already answered on a previous pass that died before deleting the
    // request: do not launch a second agent for the same file.
    if (fs.existsSync(ackFile)) {
      await fsp.unlink(file).catch(() => { /* ya no está */ });
      return;
    }

    const req = this.build(t, obj, stem, ackFile, Math.round(stat.mtimeMs || Date.now()));
    if (typeof req === 'string') {
      log('warn', SCOPE, `${file}: ${req}`);
      await writeAck(ackFile, { ok: false, reason: req, at: Date.now() }).catch(() => { /* best effort */ });
      await fsp.unlink(file).catch(() => { /* ya no está */ });
      return;
    }

    this.busy.add(file);
    try {
      for (const cb of this.cbs) {
        try { await cb(req); } catch (err) { log('warn', SCOPE, `handler: ${errText(err)}`); }
      }
    } finally {
      this.busy.delete(file);
      await fsp.unlink(file).catch(() => { /* the agent withdrew it */ });
    }
  }

  /** Validate and normalise. A string is the reason it is not a request. */
  private build(
    t: Tracked, obj: Record<string, unknown>, id: string, ackFile: string, at: number,
  ): SpawnRequest | string {
    const missionRaw = str(obj['mission']) ?? str(obj['prompt']);
    if (!missionRaw || !missionRaw.trim()) return 'no mission: the child needs a brief';
    const mission = missionRaw.trim();
    if (mission.length < MIN_BRIEF) return `mission too thin (${mission.length} chars): write what to do, what done looks like, what not to touch`;
    if (mission.length > MAX_BRIEF) return 'mission absurdly long';

    let squad: string | null = null;
    const squadRaw = obj['squad'];
    if (squadRaw !== undefined && squadRaw !== null && squadRaw !== '') {
      squad = squadName(squadRaw);
      if (!squad) return `invalid squad name "${oneLine(squadRaw, 40)}"`;
    }

    let model: string | null = null;
    const modelRaw = str(obj['model']);
    if (modelRaw) {
      if (!MODEL_RE.test(modelRaw)) return `invalid model "${oneLine(modelRaw, 40)}"`;
      model = modelRaw;
    }

    const hint = str(obj['agentId']) ?? str(obj['sessionId']);
    return {
      id,
      projectId: t.projectId,
      requesterId: this.deps.resolveAgent(t.projectId, hint),
      mission, squad, model, at, ackFile,
    };
  }
}
