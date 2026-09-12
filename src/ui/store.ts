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
import { ceilingTokens } from '../shared/tokens.ts';
import { mergeTalk } from '../shared/talk.ts';
import type { PatchOp } from '../shared/protocol.ts';
import { agentOrigin } from '../shared/origin.ts';
import { isSynthetic } from '../shared/synthetic.ts';
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
  | { k: 'missions' }
  /** A machine filed what ORCA costs it. See shared/hygiene.ts. */
  | { k: 'hygiene' }
  /** El tablero de AUTOMEJORA cambió. Ver shared/improve.ts. */
  | { k: 'improve' }
  /** El hub dijo qué código corre, y si sigue siendo el que hay en disco. */
  | { k: 'server' }
  | { k: 'link'; up: boolean }                      // hub connection state
  | { k: 'auth'; ok: boolean }                      // el hub aceptó, o no, este token
  /** An agent crossed into or out of `blocked`. The alarm listens for this. */
  | { k: 'alarm'; agentId: string; on: boolean }
  /** CAPCOM, or a launch, pointing the camera at something. The director listens. */
  | { k: 'camera'; directive: CameraDirective };

type Listener = (e: StoreEvent) => void;

/**
 * Dónde se recuerda la conversación abierta entre recargas.
 *
 * La clave vieja se lee cuando la nueva no está: el operador que tenía una
 * misión abierta antes del renombrado la encuentra abierta después, en vez de
 * volver a la general sin saber por qué. Se escribe siempre la nueva, y la
 * vieja se retira al cerrar la conversación.
 */
const MISSION_KEY = 'orca.capcom.mission';
const LEGACY_MISSION_KEY = 'orca.capcom.task';

export interface OutgoingMessage {
  missionId?: string;
  id: string;
  agentId: string | null;
  text: string;
  at: number;
  status: 'sending' | 'delivered' | 'accepted' | 'failed';
  detail?: string;
  elapsedMs?: number;
}

export class Store {
  activeMissionId: string | null = null;
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

  /**
   * AUTOMEJORA: el tablero de la auto-revisión, tal cual lo tiene el hub.
   *
   * Fuera de `world` por la misma razón que la higiene: son unos kilobytes en
   * un reloj de horas y ningún tile depende de ellos. `null` hasta que llega el
   * primero, que es lo que distingue «no hay propuestas» de «todavía no se ha
   * preguntado» — y son dos pantallas distintas.
   */
  improve: import('../shared/improve.ts').ImproveState | null = null;
  improveVerdict: import('../shared/improve.ts').DueVerdict | null = null;
  /** Con qué nacería el próximo revisor, y dónde. Lo resuelve el hub. */
  improveChoice: ReturnType<typeof import('../shared/improve.ts').effectiveChoice> | null = null;
  improveMachine: string | null = null;
  putImprove(
    state: import('../shared/improve.ts').ImproveState,
    verdict?: import('../shared/improve.ts').DueVerdict | null,
    extra?: { choice?: ReturnType<typeof import('../shared/improve.ts').effectiveChoice>; machineId?: string | null },
  ) {
    this.improve = state;
    if (verdict !== undefined) this.improveVerdict = verdict;
    if (extra?.choice) this.improveChoice = extra.choice;
    if (extra && 'machineId' in extra) this.improveMachine = extra.machineId ?? null;
    this.emit({ k: 'improve' });
  }

  /**
   * Qué código corre el hub del otro lado del cable.
   *
   * `stale` es que el proceso arrancó con un código que ya no es el que hay
   * escrito: alguien publicó y el hub sigue con el de antes. `null` mientras
   * no lo haya dicho — que no es lo mismo que «está al día», y por eso no se
   * pinta nada hasta entonces. `restartable` es si ese proceso puede darse el
   * relevo a sí mismo, que es lo que decide si el aviso es un botón o un
   * cartel (shared/restart.ts).
   */
  server: { rev: string; stale: boolean; restartable: boolean } | null = null;
  putServer(rev: string, stale: boolean, restartable = false) {
    const now = this.server;
    if (now && now.rev === rev && now.stale === stale && now.restartable === restartable) return;
    this.server = { rev, stale, restartable };
    this.emit({ k: 'server' });
  }

  upsertMission(mission: import('../shared/missions.ts').CapcomMission, purged = false) {
    if (purged) {
      if (this.world.missions) delete this.world.missions[mission.id];
      // La que estaba abierta ya no existe: volver a la general, no a un id muerto.
      if (this.activeMissionId === mission.id) this.selectMission(null);
    } else (this.world.missions ??= {})[mission.id] = mission;
    // Archivar la abierta la saca del selector; seguir "dentro" de ella dejaría
    // la consola escribiendo a una conversación que ya no se ve.
    if (!purged && mission.archivedAt && this.activeMissionId === mission.id) return this.selectMission(null);
    this.emit({ k: 'missions' });
  }
  /**
   * Which mission conversation the console is in: the CAPCOM window's picker
   * and the HUD's mission panel both set it, and both follow it. Remembered
   * across reloads.
   */
  selectMission(id: string | null) {
    this.activeMissionId = id;
    try { if (id) localStorage.setItem(MISSION_KEY, id); else { localStorage.removeItem(MISSION_KEY); localStorage.removeItem(LEGACY_MISSION_KEY); } } catch { /* private mode */ }
    this.emit({ k: 'missions' });
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
  private authOk = true;
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
    try {
      const stored = localStorage.getItem(MISSION_KEY);
      const legacy = stored === null ? localStorage.getItem(LEGACY_MISSION_KEY) : null;
      this.activeMissionId = stored ?? legacy;
      // Consolidar la migración en la primera carga: si sólo estaba la vieja,
      // se copia a la nueva y se retira. Sin esto la consola seguiría leyendo
      // la clave del vocabulario anterior en cada recarga, para siempre.
      if (legacy !== null) { localStorage.setItem(MISSION_KEY, legacy); localStorage.removeItem(LEGACY_MISSION_KEY); }
    } catch {}
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

  /**
   * ¿Aceptó el hub este token?
   *
   * Aparte del enlace a propósito: un enlace caído es una condición pasajera
   * —la red vuelve, el hub se reinicia— y la consola sigue mostrando lo
   * último que sabía. Un token rechazado no vuelve solo; no hay nada que
   * mirar y no hay nada que mandar, así que la consola se retira detrás del
   * handshake hasta que alguien cambie el token. Ver `ui/handshake.ts`.
   */
  setAuth(ok: boolean) {
    if (this.authOk === ok) return;
    this.authOk = ok;
    this.emit({ k: 'auth', ok });
  }

  /** Lo último que dijo el hub sobre este token. Optimista hasta que diga que no. */
  authed(): boolean { return this.authOk; }

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
      const a = this.all.get(id);
      if (!a || this.dismissed.has(id)) continue;
      // El CAPCOM vivo no se oculta. `onField` lo pone en el campo siempre —
      // el mando está a la vista — y `visible` mira el descarte antes que a
      // `onField`, así que dejarlo pasar aquí sacaría al mando de la consola
      // por delante de esa regla, recuperable sólo desde SETTINGS.
      if (a.role === 'capcom' && alive(a)) continue;
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

  /**
   * ¿Salió esto del arnés? Vale para cualquier cosa que traiga máquina —una
   * escalación, un agente, un proyecto—, porque la marca vive en la máquina y
   * no en el registro. Ver `shared/synthetic.ts`.
   *
   * La consola lo pregunta para no tratar una pregunta inventada como una que
   * espera a una persona: sigue en la cola y se puede abrir, pero no se abre
   * sola encima de lo que estabas mirando.
   */
  fromHarness(m: { machineId: string } | string | undefined | null): boolean {
    const id = typeof m === 'string' ? m : m?.machineId;
    return !!id && isSynthetic(this.world.machines[id]);
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
      r.tokens += ceilingTokens(a.metrics);
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
