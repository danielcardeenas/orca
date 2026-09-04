/**
 * Client-side world store.
 *
 * One store, two renderers. The 2D deck and the 3D scene both subscribe here
 * and neither knows the other exists. That separation is what keeps the 3D
 * from becoming a parallel application with its own truth.
 */

import type {
  Agent, AgentState, Escalation, FeedItem, Machine, Project, WorldState, CeoMessage,
} from '../shared/types.ts';
import { emptyWorld, emptyRollup } from '../shared/types.ts';
import type { PatchOp } from '../shared/protocol.ts';

export type StoreEvent =
  | { k: 'world' }                                  // wholesale replacement
  | { k: 'agents'; ids: string[] }                  // these agents changed
  | { k: 'projects'; ids: string[] }
  | { k: 'machines'; ids: string[] }
  | { k: 'escalations'; ids: string[] }
  | { k: 'feed' }
  | { k: 'ceo' }
  | { k: 'link'; up: boolean }                      // hub connection state
  /** An agent crossed into or out of `blocked`. The alarm listens for this. */
  | { k: 'alarm'; agentId: string; on: boolean };

type Listener = (e: StoreEvent) => void;

export class Store {
  world: WorldState = emptyWorld();
  linkUp = false;
  /** Set while the boot sequence owns the screen. */
  booting = true;

  private listeners = new Set<Listener>();
  /** Previous state per agent, so we can detect alarm transitions. */
  private lastState = new Map<string, AgentState>();

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
    for (const a of Object.values(w.agents)) this.lastState.set(a.id, a.state);
    this.emit({ k: 'world' });
  }

  applyPatch(rev: number, ops: PatchOp[]) {
    const w = this.world;
    const agents: string[] = [];
    const projects: string[] = [];
    const machines: string[] = [];
    const escalations: string[] = [];
    const alarms: { agentId: string; on: boolean }[] = [];
    let feed = false;
    let ceo = false;

    for (const op of ops) {
      switch (op.o) {
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
          if (op.v) { w.agents[op.id] = op.v; this.lastState.set(op.id, op.v.state); }
          else { delete w.agents[op.id]; this.lastState.delete(op.id); }
          const after = op.v?.state;
          this.noteAlarm(op.id, before, after, alarms);
          agents.push(op.id);
          break;
        }
        case 'agent:patch': {
          const cur = w.agents[op.id];
          if (!cur) break; // patch for an agent we never saw; resync will fix it
          const before = cur.state;
          Object.assign(cur, op.v);
          this.lastState.set(op.id, cur.state);
          this.noteAlarm(op.id, before, cur.state, alarms);
          agents.push(op.id);
          break;
        }
        case 'escalation':
          if (op.v) w.escalations[op.id] = op.v; else delete w.escalations[op.id];
          escalations.push(op.id);
          break;
        case 'key':
          if (op.v) w.keys[op.id] = op.v; else delete w.keys[op.id];
          break;
        case 'feed':
          // Newest last, bounded. The HUD strip reads from the tail.
          w.feed = w.feed.concat(op.v).slice(-500);
          feed = true;
          break;
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
    if (feed) this.emit({ k: 'feed' });
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
