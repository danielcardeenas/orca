/**
 * Client-side world store.
 *
 * One store, two renderers. The 2D deck and the 3D scene both subscribe here
 * and neither knows the other exists. That separation is what keeps the 3D
 * from becoming a parallel application with its own truth.
 */

import type {
  Agent, AgentMessage, AgentState, Artifact, Collision, Escalation, FeedItem,
  Machine, Project, WorldState, CeoMessage,
} from '../shared/types.ts';
import { emptyWorld, emptyRollup } from '../shared/types.ts';
import { mergeTalk } from '../shared/talk.ts';
import type { PatchOp } from '../shared/protocol.ts';
import { agentOrigin } from '../shared/origin.ts';
import type { CameraDirective } from '../shared/camera.ts';
import { getPref } from './prefs.ts';

const DISMISSED_KEY = 'orca.dismissed.v1';

/** Launched by ORCA: verified provenance, an ORCA pane, or the command role. */
export function ours(a: Agent): boolean {
  return agentOrigin(a) === 'orca';
}
export function alive(a: Agent): boolean {
  return a.state !== 'done' && a.state !== 'dead';
}
/**
 * A stranger's idle is a tab someone left open. This machine had 44 of them,
 * some idle for two months, every one a live process. Past this long without
 * a line, an idle session that is not ours is not on the field; the first
 * thing it does brings it back.
 */
export const STALE_IDLE_MS = 60 * 60_000;
export function awake(a: Agent, now = Date.now()): boolean {
  return alive(a) && (a.state !== 'idle' || now - a.updatedAt < STALE_IDLE_MS);
}
/**
 * One of ours that finished stays ten minutes, so a run that ended while you were
 * away is still there to be looked at, and then leaves on its own. DISMISS
 * takes it earlier; SHOW ALL brings it back.
 */
export const DONE_LINGER_MS = 10 * 60_000;
export function onField(a: Agent, now = Date.now()): boolean {
  if (a.role === 'capcom' && alive(a)) return true;
  if (ours(a)) return awake(a, now) || (!alive(a) && now - a.updatedAt < DONE_LINGER_MS);
  return awake(a, now);
}

export type StoreEvent =
  | { k: 'world' }                                  // wholesale replacement
  | { k: 'agents'; ids: string[] }                  // these agents changed
  | { k: 'projects'; ids: string[] }
  | { k: 'machines'; ids: string[] }
  | { k: 'escalations'; ids: string[] }
  /** Messages between agents, or file collisions, changed. */
  | { k: 'traffic'; ids: string[] }
  /** Things agents produced appeared, changed or were dropped. */
  | { k: 'artifacts'; ids: string[] }
  | { k: 'feed' }
  /** These agents' conversations grew. */
  | { k: 'talk'; ids: string[] }
  | { k: 'ceo' }
  | { k: 'delivery' }
  | { k: 'tasks' }
  /** A machine filed what ORCA costs it. See shared/hygiene.ts. */
  | { k: 'hygiene' }
  | { k: 'link'; up: boolean }                      // hub connection state
  /** An agent crossed into or out of `blocked`. The alarm listens for this. */
  | { k: 'alarm'; agentId: string; on: boolean }
  /** CAPCOM, or a launch, pointing the camera at something. The director listens. */
  | { k: 'camera'; directive: CameraDirective };

type Listener = (e: StoreEvent) => void;

export interface OutgoingMessage {
  taskId?: string;
  id: string;
  agentId: string | null;
  text: string;
  at: number;
  status: 'sending' | 'delivered' | 'accepted' | 'failed';
  detail?: string;
  elapsedMs?: number;
}

export class Store {
  activeTaskId: string | null = null;
  outgoing: OutgoingMessage[] = [];
  /**
   * The newest hygiene report per machine. Held here and not in `world`: it is
   * a few kilobytes on its own ten-minute clock, and no tile depends on it.
   */
  hygiene = new Map<string, import('../shared/hygiene.ts').HygieneReport>();
  putHygiene(reports: import('../shared/hygiene.ts').HygieneReport[]) {
    for (const r of reports) this.hygiene.set(r.machineId, r);
    this.emit({ k: 'hygiene' });
  }

  upsertTask(task: import('../shared/tasks.ts').CapcomTask) {
    (this.world.tasks ??= {})[task.id] = task;
    this.emit({ k: 'tasks' });
  }
  /**
   * Which task conversation the console is in: the CAPCOM window's picker
   * and the HUD's task panel both set it, and both follow it. Remembered
   * across reloads under the same key the window has always used.
   */
  selectTask(id: string | null) {
    this.activeTaskId = id;
    try { if (id) localStorage.setItem('orca.capcom.task', id); else localStorage.removeItem('orca.capcom.task'); } catch { /* private mode */ }
    this.emit({ k: 'tasks' });
  }

  /** Not state: nothing to keep, only someone to tell. */
  camera(directive: CameraDirective) {
    this.emit({ k: 'camera', directive });
  }

  recordOutgoing(message: OutgoingMessage) {
    const i = this.outgoing.findIndex((m) => m.id === message.id);
    if (i >= 0) this.outgoing[i] = message;
    else this.outgoing.push(message);
    this.outgoing = this.outgoing.slice(-100);
    this.emit({ k: 'delivery' });
  }

  world: WorldState = emptyWorld();
  linkUp = false;
  /** Set while the boot sequence owns the screen. */
  booting = true;

  private listeners = new Set<Listener>();
  /** Previous state per agent, so we can detect alarm transitions. */
  private lastState = new Map<string, AgentState>();
  /**
   * Every agent the hub told us about, visible or not. `world.agents` is the
   * view: what the field, the windows and the command line get to see. The
   * split is here and nowhere else, so hiding is one rule, not forty filters.
   */
  private all = new Map<string, Agent>();
  private dismissed = new Set<string>(loadDismissed());

  constructor() {
    try { this.activeTaskId = localStorage.getItem('orca.capcom.task'); } catch {}
    // Time alone changes who is on the field (an idle stranger going stale):
    // sweep once a minute, in the browser only — node imports this for tests.
    if (typeof window !== 'undefined') window.setInterval(() => this.sweep(), 60_000);
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: StoreEvent) {
    for (const fn of this.listeners) {
      // One bad subscriber must not stop the others from painting.
      try { fn(e); } catch (err) { console.error('[store] listener threw', err); }
    }
  }

  setLink(up: boolean) {
    if (this.linkUp === up) return;
    this.linkUp = up;
    this.emit({ k: 'link', up });
  }

  replaceWorld(w: WorldState) {
    this.world = w;
    this.lastState.clear();
    this.all.clear();
    for (const a of Object.values(w.agents)) {
      this.lastState.set(a.id, a.state);
      this.all.set(a.id, a);
    }
    w.agents = {};
    for (const a of this.all.values()) if (this.visible(a)) w.agents[a.id] = a;
    this.emit({ k: 'world' });
  }

  /* ── Who is on the field ───────────────────────────────────────── */

  visible(a: Agent, now = Date.now()): boolean {
    if (getPref('showAll')) return true;
    // Fuera de la flota por donde vive, no por lo que hace: las sesiones CAPCOM
    // anteriores y lo que alguien lanzó en el directorio del mando o en un
    // scratchpad de sesión. El campo, el HUD y los contadores leen `world.agents`,
    // así que basta con no dejarlos entrar aquí. El CAPCOM vivo NO llega
    // marcado: se dibuja aparte, con su propio rótulo. SHOW ALL sigue siendo la
    // puerta para mirar lo que quedó ahí dentro.
    if (a.hidden === true) return false;
    if (this.dismissed.has(a.id)) return false;
    const origin = getPref('origin');
    if (origin !== 'all' && agentOrigin(a) !== origin) return false;
    return onField(a, now);
  }

  /** Re-place everyone; emit only for those whose place changed. */
  private sweep(): void {
    const now = Date.now();
    const changed: string[] = [];
    for (const [id, a] of this.all) {
      const was = id in this.world.agents;
      const is = this.visible(a, now);
      if (was === is) continue;
      if (is) this.world.agents[id] = a; else delete this.world.agents[id];
      changed.push(id);
    }
    if (changed.length) this.emit({ k: 'agents', ids: changed });
  }

  /** Re-place `id` in or out of the view after its record or the rules changed. */
  private place(id: string): void {
    const a = this.all.get(id);
    if (a && this.visible(a)) this.world.agents[id] = a;
    else delete this.world.agents[id];
  }

  /** Every agent known, hidden ones included. For the settings count and the fleet window's ALL. */
  knownAgent(id: string): Agent | undefined { return this.all.get(id); }
  everyone(): Agent[] { return [...this.all.values()]; }
  hiddenCount(): number { return this.all.size - Object.keys(this.world.agents).length; }
  isDismissed(id: string): boolean { return this.dismissed.has(id); }

  /** Hide an agent from the field. Nothing on disk changes; it can be shown again from SETTINGS. */
  dismiss(ids: string[]): number {
    let n = 0;
    for (const id of ids) {
      if (!this.all.has(id) || this.dismissed.has(id)) continue;
      this.dismissed.add(id);
      this.place(id);
      n++;
    }
    if (n) { saveDismissed(this.dismissed); this.emit({ k: 'agents', ids }); }
    return n;
  }

  /** Visual cleanup only: keep running/blocked sessions and their transcripts. */
  cleanup(now = Date.now()): number {
    // Stale idle sessions are already hidden by onField; do not persistently
    // dismiss them, so new activity can bring them back automatically.
    const n = this.dismiss(this.everyone().filter((a) => !alive(a)).map((a) => a.id));
    this.refilter();
    return n;
  }

  undismissAll(): number {
    const ids = [...this.dismissed];
    this.dismissed.clear();
    saveDismissed(this.dismissed);
    for (const id of ids) this.place(id);
    if (ids.length) this.emit({ k: 'agents', ids });
    return ids.length;
  }

  /** The rules changed (SHOW ALL): rebuild the view. */
  refilter(): void {
    for (const id of this.all.keys()) this.place(id);
    this.emit({ k: 'world' });
  }

  applyPatch(rev: number, ops: PatchOp[]) {
    const w = this.world;
    const agents: string[] = [];
    const projects: string[] = [];
    const machines: string[] = [];
    const escalations: string[] = [];
    const traffic: string[] = [];
    const artifacts: string[] = [];
    const alarms: { agentId: string; on: boolean }[] = [];
    const talk: string[] = [];
    let feed = false;
    let ceo = false;

    for (const op of ops) {
      switch (op.o) {
        case 'capcom:handoffs':
          w.capcomHandoffs = op.v;
          ceo = true;
          break;
        case 'machine':
          if (op.v) w.machines[op.id] = op.v; else delete w.machines[op.id];
          machines.push(op.id);
          break;
        case 'project':
          if (op.v) w.projects[op.id] = op.v; else delete w.projects[op.id];
          projects.push(op.id);
          break;
        case 'agent': {
          const before = this.lastState.get(op.id);
          if (op.v) { this.all.set(op.id, op.v); this.lastState.set(op.id, op.v.state); }
          else { this.all.delete(op.id); this.lastState.delete(op.id); this.dismissed.delete(op.id); }
          this.place(op.id);
          const after = op.v?.state;
          this.noteAlarm(op.id, before, after, alarms);
          agents.push(op.id);
          break;
        }
        case 'agent:patch': {
          const cur = this.all.get(op.id);
          if (!cur) break; // patch for an agent we never saw; resync will fix it
          const before = cur.state;
          Object.assign(cur, op.v);
          this.lastState.set(op.id, cur.state);
          // A stranger that woke up comes back; one that finished leaves.
          this.place(op.id);
          this.noteAlarm(op.id, before, cur.state, alarms);
          agents.push(op.id);
          break;
        }
        case 'escalation':
          if (op.v) w.escalations[op.id] = op.v; else delete w.escalations[op.id];
          escalations.push(op.id);
          break;
        case 'message':
          if (op.v) w.messages[op.id] = op.v; else delete w.messages[op.id];
          traffic.push(op.id);
          break;
        case 'collision':
          if (op.v) w.collisions[op.id] = op.v; else delete w.collisions[op.id];
          traffic.push(op.id);
          break;
        case 'artifact':
          if (op.v) w.artifacts[op.id] = op.v; else delete w.artifacts[op.id];
          artifacts.push(op.id);
          break;
        case 'key':
          if (op.v) w.keys[op.id] = op.v; else delete w.keys[op.id];
          break;
        case 'feed':
          // Newest last, bounded. The HUD strip reads from the tail.
          w.feed = w.feed.concat(op.v).slice(-500);
          feed = true;
          break;
        case 'talk': {
          const all = (w.talk ??= {});
          const cur = all[op.id] ?? [];
          const next = mergeTalk(cur, op.v);
          if (next === cur) break;
          all[op.id] = next;
          talk.push(op.id);
          break;
        }
        case 'talk:live': {
          const live = (w.talkLive ??= {});
          if ((live[op.id] ?? null) === op.v) break;
          if (op.v === null) delete live[op.id]; else live[op.id] = op.v;
          talk.push(op.id);
          break;
        }
        case 'fleet':
          w.fleet = op.v;
          break;
        case 'ceo:thinking':
          w.ceo.thinking = op.v;
          ceo = true;
          break;
      }
    }

    w.rev = rev;
    w.at = Date.now();

    if (machines.length) this.emit({ k: 'machines', ids: machines });
    if (projects.length) this.emit({ k: 'projects', ids: projects });
    if (agents.length) this.emit({ k: 'agents', ids: agents });
    if (escalations.length) this.emit({ k: 'escalations', ids: escalations });
    if (traffic.length) this.emit({ k: 'traffic', ids: traffic });
    if (artifacts.length) this.emit({ k: 'artifacts', ids: artifacts });
    if (feed) this.emit({ k: 'feed' });
    if (talk.length) this.emit({ k: 'talk', ids: talk });
    if (ceo) this.emit({ k: 'ceo' });
    for (const a of alarms) this.emit({ k: 'alarm', agentId: a.agentId, on: a.on });
  }

  /** Only `blocked` raises the alarm. Everything else is ambient. */
  private noteAlarm(
    id: string,
    before: AgentState | undefined,
    after: AgentState | undefined,
    out: { agentId: string; on: boolean }[],
  ) {
    const wasBlocked = before === 'blocked';
    const isBlocked = after === 'blocked';
    if (wasBlocked !== isBlocked) out.push({ agentId: id, on: isBlocked });
  }

  /**
   * Inserta una escalación local sin tocar `rev`.
   *
   * Existe sólo para el arnés visual, que necesita fotografiar el tratamiento
   * ámbar y el breach a demanda. Es una afordancia de prueba deliberada: la
   * alternativa —que el arnés escribiera en el mundo y adelantara el rev— hacía
   * que la consola detectara un hueco de protocolo, pidiera resync y perdiera
   * la tarjeta a mitad de captura, produciendo fotogramas que mentían sobre la
   * UI real.
   *
   * No la use nada del producto. La consola sólo muta por parches del hub.
   */
  injectForTest(esc: Escalation): void {
    this.world.escalations[esc.id] = esc;
    this.emit({ k: 'escalations', ids: [esc.id] });
  }

  pushCeo(m: CeoMessage) {
    const i = this.world.ceo.messages.findIndex((x) => x.id === m.id);
    if (i >= 0) this.world.ceo.messages[i] = m;
    else this.world.ceo.messages.push(m);
    if (this.world.ceo.messages.length > 100) this.world.ceo.messages.shift();
    this.emit({ k: 'ceo' });
  }

  appendCeoDelta(id: string, text: string) {
    const m = this.world.ceo.messages.find((x) => x.id === id);
    if (!m) return;
    m.text += text;
    m.streaming = true;
    this.emit({ k: 'ceo' });
  }

  finishCeo(id: string) {
    const m = this.world.ceo.messages.find((x) => x.id === id);
    if (m) m.streaming = false;
    this.world.ceo.thinking = false;
    this.emit({ k: 'ceo' });
  }

  /* ── Derived reads. Keep these cheap; they run inside render loops. ── */

  agentsOf(projectId: string): Agent[] {
    const p = this.world.projects[projectId];
    if (!p) return [];
    const out: Agent[] = [];
    for (const id of p.sessionIds) {
      const a = this.world.agents[id];
      if (a) out.push(a);
    }
    return out;
  }

  projectsOf(machineId: string): Project[] {
    return Object.values(this.world.projects).filter((p) => p.machineId === machineId);
  }

  /** Projects that have anything alive, ordered by urgency then by heat. */
  activeProjects(): Project[] {
    return Object.values(this.world.projects)
      .filter((p) => p.rollup.total > 0)
      .sort((a, b) => {
        if (a.rollup.blocked !== b.rollup.blocked) return b.rollup.blocked - a.rollup.blocked;
        const av = a.rollup.byState.working + a.rollup.byState.thinking;
        const bv = b.rollup.byState.working + b.rollup.byState.thinking;
        if (av !== bv) return bv - av;
        return a.name.localeCompare(b.name);
      });
  }

  /** Everything waiting on the human, most urgent first. */
  pending(): Escalation[] {
    return Object.values(this.world.escalations)
      .filter((e) => e.status === 'pending' || e.status === 'with_ceo')
      .sort((a, b) => {
        const rank = { blocking: 0, normal: 1, low: 2 } as const;
        if (rank[a.urgency] !== rank[b.urgency]) return rank[a.urgency] - rank[b.urgency];
        return a.askedAt - b.askedAt;
      });
  }

  blockedAgents(): Agent[] {
    return Object.values(this.world.agents)
      .filter((a) => a.state === 'blocked')
      .sort((a, b) => (a.block?.since ?? 0) - (b.block?.since ?? 0));
  }

  /**
   * Quién está bloqueado detrás de un objetivo, transitivamente.
   *
   * Es la conclusión del mapa, y vive aquí porque el sitio donde más importa no
   * es el mapa sino la tarjeta donde contestas: "esto desbloquea a 4" cambia el
   * orden en que atiendes la cola, y "un agente bloqueado" no.
   *
   * `'human'` como objetivo son las escalaciones pendientes; un id de agente
   * son los `ask` entre agentes sin responder.
   */
  dammedBehind(targetId: string): string[] {
    /** objetivo → quién espera directamente por él */
    const waiters = new Map<string, string[]>();
    for (const a of Object.values(this.world.agents)) {
      if (a.state !== 'blocked' || !a.block) continue;
      const target = a.block.kind === 'peer' ? a.block.waitingOn : 'human';
      if (!target) continue;
      const list = waiters.get(target);
      if (list) list.push(a.id); else waiters.set(target, [a.id]);
    }

    const seen = new Set<string>();
    const queue = [...(waiters.get(targetId) ?? [])];
    while (queue.length) {
      const id = queue.shift()!;
      // Un ciclo sería un bug aguas arriba, pero una vista no puede colgarse.
      if (seen.has(id) || id === targetId) continue;
      seen.add(id);
      for (const behind of waiters.get(id) ?? []) queue.push(behind);
    }
    return [...seen];
  }

  /** Traffic involving one agent, newest first. */
  trafficFor(agentId: string): AgentMessage[] {
    return Object.values(this.world.messages ?? {})
      .filter((m) => m.fromAgentId === agentId || m.toAgentId === agentId)
      .sort((a, b) => b.at - a.at);
  }

  /** What an agent produced, newest first. */
  artifactsOf(agentId: string): Artifact[] {
    return Object.values(this.world.artifacts ?? {})
      .filter((x) => x.agentId === agentId)
      .sort((a, b) => b.at - a.at);
  }

  /** Unacknowledged file conflicts. */
  liveCollisions(): Collision[] {
    return Object.values(this.world.collisions ?? {})
      .filter((c) => !c.acknowledged)
      .sort((a, b) => a.firstSeen - b.firstSeen);
  }

  machines(): Machine[] {
    return Object.values(this.world.machines).sort((a, b) => a.hostname.localeCompare(b.hostname));
  }

  recentFeed(n: number): FeedItem[] {
    return this.world.feed.slice(-n);
  }

  /** Children of an agent, for the lineage view. */
  childrenOf(agentId: string): Agent[] {
    const a = this.world.agents[agentId];
    if (!a) return [];
    return a.childIds.map((id) => this.world.agents[id]).filter((x): x is Agent => !!x);
  }

  /** Walk up to the root, for breadcrumbs on a subagent. */
  ancestryOf(agentId: string): Agent[] {
    const chain: Agent[] = [];
    let cur = this.world.agents[agentId];
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = cur.parentId ? this.world.agents[cur.parentId] : undefined as unknown as Agent;
    }
    return chain;
  }

  /** Fleet-wide rollup, recomputed from agents when the hub hasn't sent one. */
  recomputeFleet() {
    const r = emptyRollup();
    for (const a of Object.values(this.world.agents)) {
      r.total++;
      r.byState[a.state]++;
      r.costUSD += a.metrics.costUSD;
      r.tokensPerSec += a.metrics.tokensPerSec;
      if (a.state === 'blocked') r.blocked++;
    }
    this.world.fleet = r;
  }
}

export const store = new Store();

function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const got = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(got) ? got.filter((x): x is string => typeof x === 'string').slice(-2000) : [];
  } catch { return []; }
}
function saveDismissed(set: Set<string>): void {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set].slice(-2000))); } catch { /* private mode */ }
}
