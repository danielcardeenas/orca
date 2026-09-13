/**
 * Wake (pieza A del squad autonomy): CAPCOM se entera de que un worker acabó,
 * y late cuando lleva demasiado callado.
 *
 * Todo con reloj falso y sin hub: la pieza recibe sus deps inyectadas, y el
 * lifecycle se alimenta a mano con los mismos WorldEvent que emitiría World.
 * Un minuto de silencio cuesta una llamada a `advance`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, AgentMessage } from '../src/shared/types.ts';
import type { CapcomMission } from '../src/shared/missions.ts';
import { newId } from '../src/shared/protocol.ts';
import type { AutonomyDeps } from '../src/hub/autonomy.ts';
import type { CapcomTimer } from '../src/hub/capcom.ts';
import { AgentLifecycle } from '../src/hub/lifecycle.ts';
import {
  AGENT_WAKE_PREFIX, HEARTBEAT_PREFIX, HEARTBEAT_TICK_MS, MISSION_WAKE_PREFIX, SQUAD_WAIT_ALERT_MIN,
  SQUAD_WAIT_ORPHAN_MIN, SQUAD_WAIT_STEPS_MIN, SQUAD_WAKE_PREFIX, WAKE_DEFAULTS,
  WAKE_LAST_SAY_CHARS, WAKE_STATE_FILE, agentWakeLine, createWake, wakeConfig,
} from '../src/hub/wake.ts';
import { capcomBrief } from '../src/collector/briefs.ts';
import { ok, test, type TestModule } from './harness.ts';

/* ── fixtures ─────────────────────────────────────────────────────── */

function agent(over: Partial<Agent> = {}): Agent {
  const now = 1_000_000;
  return {
    id: over.id ?? newId('sess'), machineId: 'm1', projectId: 'p1',
    title: 'test', callsign: 'K1', runtime: 'claude', state: 'working', block: null,
    origin: 'orca',
    parentId: 'cap', depth: 1, childIds: [], mission: null,
    squad: null, lead: false,
    model: null, tool: null, toolDetail: null,
    lastPrompt: null, lastSay: null, startedAt: now, updatedAt: now, uptimeMs: 0,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
      tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0,
      toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    background: false, shortId: null,
    ...over,
  };
}

function fakeClock() {
  let now = 1_000_000;
  const queued: { at: number; fn: () => void; every: number; dead: boolean }[] = [];
  return {
    now: () => now,
    setTimer: ((fn, ms) => {
      const entry = { at: now + ms, fn, every: 0, dead: false };
      queued.push(entry);
      return { cancel: () => { entry.dead = true; } } satisfies CapcomTimer;
    }) as AutonomyDeps['setTimer'],
    setInterval: ((fn, ms) => {
      const entry = { at: now + ms, fn, every: ms, dead: false };
      queued.push(entry);
      return { cancel: () => { entry.dead = true; } } satisfies CapcomTimer;
    }) as AutonomyDeps['setInterval'],
    /** Avanza el reloj disparando lo vencido en orden, intervalos incluidos. */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = queued.filter((e) => !e.dead && e.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        if (due.every > 0) due.at += due.every; else due.dead = true;
        due.fn();
      }
      now = target;
    },
  };
}

interface Rig {
  deps: AutonomyDeps;
  clock: ReturnType<typeof fakeClock>;
  lifecycle: AgentLifecycle;
  agents: Record<string, Agent>;
  missions: Record<string, CapcomMission>;
  said: string[];
  notes: string[];
  alerts: string[];
  /** null = sin CAPCOM. */
  capcom: Agent | null;
  /** Donde vive wake.json. Se borra en `done()`. */
  dir: string;
  done(): void;
  setCapcom(a: Agent | null): void;
  /** Aplica una transición como lo haría World: muta el agente y alimenta el lifecycle. */
  move(id: string, to: Agent['state'], patch?: Partial<Agent>): void;
  arrive(a: Agent): void;
}

function capcomAgent(over: Partial<Agent> = {}): Agent {
  return agent({ id: 'cap', callsign: 'CC', role: 'capcom', state: 'idle', parentId: null, depth: 0, ...over });
}

function rig(env: Record<string, string | undefined> = {}, capcom: Agent | null = capcomAgent(), dir = mkdtempSync(join(tmpdir(), 'orca-wake-'))): Rig {
  const clock = fakeClock();
  const lifecycle = new AgentLifecycle();
  const agents: Record<string, Agent> = {};
  const missions: Record<string, CapcomMission> = {};
  const said: string[] = [];
  const notes: string[] = [];
  const alerts: string[] = [];
  const r: Rig = {
    clock, lifecycle, agents, missions, said, notes, alerts, capcom, dir,
    done() { rmSync(dir, { recursive: true, force: true }); },
    deps: {
      agents: () => Object.values(agents),
      agent: (id) => agents[id],
      projects: () => [],
      project: (id) => (id === 'p1' ? { id: 'p1', name: 'orca' } as never : undefined),
      missions: () => structuredClone(missions),
      capcom: () => r.capcom,
      sayToCapcom: (text) => { if (!r.capcom) return false; said.push(text); return 'delivered'; },
      dispatch: async () => ({}),
      stopAgent: async () => ({}),
      dir,
      env,
      now: clock.now,
      setTimer: clock.setTimer,
      setInterval: clock.setInterval,
      log: () => {},
      note: (t) => { notes.push(t); },
      alert: (t) => { alerts.push(t); },
      lifecycle,
    },
    setCapcom(a) { r.capcom = a; if (a) r.arrive(a); },
    move(id, to, patch = {}) {
      const a = agents[id];
      if (!a) throw new Error(`no agent ${id}`);
      const from = a.state;
      Object.assign(a, patch, { state: to, updatedAt: clock.now() });
      lifecycle.feed({ at: clock.now(), kind: 'agent:state', agentId: id, projectId: a.projectId, data: { from, to } }, a);
    },
    arrive(a) {
      agents[a.id] = a;
      lifecycle.feed({ at: clock.now(), kind: 'agent:new', agentId: a.id, projectId: a.projectId }, a);
    },
  };
  if (capcom) agents[capcom.id] = capcom;
  return r;
}

/** Una misión con su conversación ya escrita, para el tercer despertador. */
function mission(id: string, title: string, messages: CapcomMission['messages']): CapcomMission {
  const at = messages[0]?.at ?? 0;
  return { id, title, status: 'active', createdAt: at, updatedAt: at, agentIds: [], messages };
}

const COALESCE = WAKE_DEFAULTS.coalesceMs;
const SETTLE = WAKE_DEFAULTS.idleSettleMs;
const MIN = 60_000;

/** Un mensaje entre agentes tal como lo guarda el hub, para el quinto despertador. */
function ask(over: Partial<AgentMessage> & { id: string; fromAgentId: string; at: number }): AgentMessage {
  return {
    kind: 'ask', scope: over.toSquad ? 'squad' : 'agent',
    fromCallsign: over.fromAgentId.toUpperCase(), fromProjectId: 'p1',
    toAgentId: null, toProjectId: null, toSquad: null,
    subject: 'merge onto main or onto the branch?', body: null, files: [],
    readBy: [], expiresAt: null, answer: null, answeredAt: null, answeredBy: null,
    ...over,
  };
}

/** Un escuadrón de dos —líder y miembro— con un `ask` del miembro ya en el mundo. */
function squadRig(env: Record<string, string | undefined> = {}): Rig & { mail: AgentMessage[] } {
  const r = rig(env) as Rig & { mail: AgentMessage[] };
  r.mail = [];
  r.deps.messages = () => r.mail;
  r.arrive(agent({ id: 'lead', callsign: 'L1', squad: 'audit-01', lead: true }));
  r.arrive(agent({ id: 'mem', callsign: 'M1', squad: 'audit-01', parentId: 'lead', depth: 2 }));
  return r;
}

const squadSaid = (r: Rig): string[] => r.said.filter((t) => t.startsWith(`[${SQUAD_WAKE_PREFIX}`));

/* ── tests ────────────────────────────────────────────────────────── */

const tests = [
  test('clean context suppresses heartbeat and pre-cut worker backlog without losing new events', () => {
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '1' });
    let cutoff: number | null = r.clock.now() + 1;
    r.deps.contextCutoff = () => cutoff;
    const wake = createWake(r.deps);
    try {
      r.arrive(agent({ id: 'before' })); r.move('before', 'done');
      r.clock.advance(COALESCE + 120000);
      const quiet = r.said.length === 0;
      r.arrive(agent({ id: 'after', callsign: 'NEW' })); r.move('after', 'done');
      r.clock.advance(COALESCE);
      const onlyNew = r.said.length === 1 && r.said[0]!.includes('NEW') && !r.said[0]!.includes('[HEARTBEAT]');
      cutoff = null; wake.flush();
      return ok('clean mode waits; new results arrive; old wake entries retained for continuity', quiet && onlyNew && r.said.length === 2);
    } finally { wake.stop(); r.done(); }
  }),
  test('a worker CAPCOM launched goes done → one [AGENT] message with project, squad, task and last_say', () => {
    const r = rig();
    const wake = createWake(r.deps);
    r.missions['task_1'] = { id: 'task_1', title: 't', status: 'active', createdAt: 0, updatedAt: 0, agentIds: ['w1'], messages: [] };
    r.arrive(agent({ id: 'w1', callsign: 'K9', squad: 'audit-01', lastSay: 'Tests green,\n  nothing left.' }));
    r.move('w1', 'done');
    const before = r.said.length;
    r.clock.advance(COALESCE);
    const msg = r.said[0] ?? '';
    wake.stop(); r.done();
    return ok(
      'done → [AGENT K9 done] with the facts on one line and last_say below',
      before === 0 && r.said.length === 1
      && msg.startsWith(`[${AGENT_WAKE_PREFIX} K9 done] project: orca · squad: audit-01 · mission: task_1`)
      && msg.includes('\n  last: Tests green, nothing left.')
      && r.notes.some((n) => n.includes('K9 done')),
      msg.split('\n')[0],
    );
  }),

  test('last_say is cut to a bounded size', () => {
    const line = agentWakeLine({
      agentId: 'x', callsign: 'K1', state: 'dead', project: 'orca', squad: null, missionId: null,
      lastSay: 'x'.repeat(5000), at: 0,
    });
    const last = line.split('\n')[1] ?? '';
    return ok('last_say bounded', last.length <= WAKE_LAST_SAY_CHARS + '  last: '.length && last.endsWith('…'), `${last.length} chars`);
  }),

  test('several workers finishing within the window arrive as one message', () => {
    const r = rig();
    const wake = createWake(r.deps);
    for (const [id, cs] of [['a', 'A1'], ['b', 'B2'], ['c', 'C3']] as const) r.arrive(agent({ id, callsign: cs }));
    r.move('a', 'done');
    r.clock.advance(1000);
    r.move('b', 'dead', { lastSay: 'crashed' });
    r.clock.advance(1000);
    r.move('c', 'done');
    r.clock.advance(COALESCE);
    const msg = r.said[0] ?? '';
    const heads = msg.split('\n').filter((l) => l.startsWith(`[${AGENT_WAKE_PREFIX} `));
    wake.stop(); r.done();
    return ok(
      'three finishes, one message, three prefixed blocks',
      r.said.length === 1 && heads.length === 3 && heads[0]!.startsWith('[AGENT A1 done]')
      && heads[1]!.startsWith('[AGENT B2 dead]') && heads[2]!.startsWith('[AGENT C3 done]')
      && msg.includes('3 workers finished'),
      `${r.said.length} message(s), ${heads.length} block(s)`,
    );
  }),

  test('an idle that flickers back to working inside the same turn is not a wake; the first settled idle is, once', () => {
    const r = rig();
    const wake = createWake(r.deps);
    r.arrive(agent({ id: 'w', callsign: 'W1' }));
    // Parpadeo: idle y de vuelta a working antes de asentarse.
    r.move('w', 'idle');
    r.clock.advance(SETTLE / 2);
    r.move('w', 'working');
    r.clock.advance(COALESCE + SETTLE);
    const afterFlicker = r.said.length;
    // Idle de verdad.
    r.move('w', 'idle', { lastSay: 'done with the refactor' });
    r.clock.advance(SETTLE + COALESCE);
    const afterIdle = r.said.length;
    // Parado en su prompt y de vuelta a idle sin trabajo en medio: el mismo idle.
    r.move('w', 'blocked', { block: { kind: 'input', summary: '', since: r.clock.now() } });
    r.move('w', 'idle');
    r.clock.advance(SETTLE + COALESCE);
    const afterRepeat = r.said.length;
    // Trabaja de nuevo y vuelve a idle: cuenta.
    r.move('w', 'working');
    r.move('w', 'idle');
    r.clock.advance(SETTLE + COALESCE);
    const afterWork = r.said.length;
    wake.stop(); r.done();
    return ok(
      'flicker 0, settled idle 1, repeat idle still 1, idle after new work 2',
      afterFlicker === 0 && afterIdle === 1 && afterRepeat === 1 && afterWork === 2
      && (r.said[0] ?? '').startsWith('[AGENT W1 idle]'),
      `${afterFlicker}/${afterIdle}/${afterRepeat}/${afterWork}`,
    );
  }),

  test('external agents, subagents, CAPCOM itself and escalation blocks do not wake CAPCOM', () => {
    const r = rig();
    const wake = createWake(r.deps);
    r.arrive(agent({ id: 'ext', callsign: 'E1', origin: 'external', parentId: null }));
    r.arrive(agent({ id: 'sub', callsign: 'S1', subagent: true, parentId: 'x' }));
    r.arrive(agent({ id: 'esc', callsign: 'Q1' }));
    // Un squad que el humano lanzó desde la consola: origin orca, pero no de CAPCOM.
    r.arrive(agent({ id: 'hl', callsign: 'H1', parentId: null, squad: 'human-01', lead: true }));
    r.arrive(agent({ id: 'hm', callsign: 'H2', parentId: 'hl', squad: 'human-01' }));
    r.move('ext', 'done');
    r.move('sub', 'done');
    r.move('hl', 'done');
    r.move('hm', 'done');
    r.move('cap', 'idle');
    r.move('esc', 'blocked', { block: { kind: 'question', summary: 'which key?', escalationId: 'esc_1', since: 0 } });
    r.clock.advance(COALESCE + SETTLE);
    const quiet = r.said.length;
    // Un externo asignado a una misión sí cuenta: la misión lo hace de CAPCOM.
    r.missions['task_2'] = { id: 'task_2', title: 't', status: 'active', createdAt: 0, updatedAt: 0, agentIds: ['ext'], messages: [] };
    r.move('ext', 'working');
    r.move('ext', 'dead');
    r.clock.advance(COALESCE);
    wake.stop(); r.done();
    return ok(
      'nothing for external, subagent, CAPCOM, escalation or a human squad; one for the mission-bound external',
      quiet === 0 && r.said.length === 1 && (r.said[0] ?? '').startsWith('[AGENT E1 dead] project: orca · mission: task_2'),
      `${quiet} then ${r.said.length}`,
    );
  }),

  test('with no CAPCOM the finish waits, and the next CAPCOM gets it in one message', () => {
    const r = rig({}, null);
    // El CAPCOM que los lanzó ya murió; siguen siendo sus workers.
    r.agents['cap'] = capcomAgent({ state: 'dead' });
    const wake = createWake(r.deps);
    r.arrive(agent({ id: 'a', callsign: 'A1' }));
    r.arrive(agent({ id: 'b', callsign: 'B2' }));
    r.move('a', 'done');
    r.clock.advance(COALESCE);
    r.move('b', 'dead');
    r.clock.advance(COALESCE * 3);
    const held = wake.pending();
    const nothingSaid = r.said.length;
    r.setCapcom(capcomAgent({ id: 'cap2' }));
    const msg = r.said[0] ?? '';
    const afterArrival = wake.pending();
    wake.stop(); r.done();
    return ok(
      'held 2 with nobody to tell, delivered as one message on arrival',
      held === 2 && nothingSaid === 0 && r.said.length === 1 && afterArrival === 0
      && msg.includes('[AGENT A1 done]') && msg.includes('[AGENT B2 dead]'),
      `held ${held}, said ${r.said.length}`,
    );
  }),

  test('the heartbeat fires after N quiet minutes, asks for briefing, and lands in the feed', () => {
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '15' });
    const wake = createWake(r.deps);
    r.clock.advance(14 * 60_000);
    const early = r.said.length;
    r.clock.advance(2 * 60_000);
    const msg = r.said[0] ?? '';
    const once = r.said.length;
    // Y no repite hasta pasar otros N minutos.
    r.clock.advance(5 * 60_000);
    const stillOnce = r.said.length;
    r.clock.advance(11 * 60_000);
    const twice = r.said.length;
    wake.stop(); r.done();
    return ok(
      'silent at 14 min, one heartbeat by 16, second one ~15 min later',
      early === 0 && once === 1 && stillOnce === 1 && twice === 2
      && msg.startsWith(`[${HEARTBEAT_PREFIX}] `) && msg.includes('briefing') && msg.includes('do not reply')
      && r.notes.some((n) => n.startsWith('latido a CAPCOM (CC)')),
      `${early}/${once}/${stillOnce}/${twice}`,
    );
  }),

  test('the heartbeat holds while CAPCOM is mid-turn, a question is pending, or a worker wake is owed', () => {
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '1' });
    const wake = createWake(r.deps);
    // Turno en curso.
    r.move('cap', 'working');
    r.clock.advance(3 * 60_000);
    const whileWorking = r.said.length;
    // Turno acabado: cada cambio de estado de CAPCOM cuenta como turno, así
    // que el silencio se mide desde aquí.
    r.move('cap', 'idle');
    r.clock.advance(HEARTBEAT_TICK_MS);
    const justAfterTurn = r.said.length;
    // Escalación pendiente en la flota.
    r.arrive(agent({ id: 'q', callsign: 'Q1', state: 'blocked', block: { kind: 'question', summary: '?', escalationId: 'esc_9', since: 0 } }));
    r.clock.advance(3 * 60_000);
    const whilePending = r.said.length;
    r.move('q', 'working', { block: null });
    r.clock.advance(70_000);
    const afterPending = r.said.length;
    wake.stop(); r.done();
    return ok(
      'no heartbeat mid-turn or with a question open; one once both clear',
      whileWorking === 0 && justAfterTurn === 0 && whilePending === 0 && afterPending === 1
      && (r.said[0] ?? '').startsWith('[HEARTBEAT]'),
      `${whileWorking}/${justAfterTurn}/${whilePending}/${afterPending}`,
    );
  }),

  test('a worker wake counts as a turn, so the heartbeat clock restarts from it', () => {
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '2' });
    const wake = createWake(r.deps);
    r.arrive(agent({ id: 'w', callsign: 'W1' }));
    r.clock.advance(90_000);
    r.move('w', 'done');
    r.clock.advance(COALESCE);
    const afterWake = r.said.length;
    r.clock.advance(60_000);
    const noHeartbeatYet = r.said.length;
    r.clock.advance(90_000);
    const heartbeat = r.said.length;
    wake.stop(); r.done();
    return ok(
      'wake at 1.5 min, no heartbeat at 2.5, heartbeat by 4',
      afterWake === 1 && noHeartbeatYet === 1 && heartbeat === 2 && (r.said[1] ?? '').startsWith('[HEARTBEAT]'),
      `${afterWake}/${noHeartbeatYet}/${heartbeat}`,
    );
  }),

  test('ORCA_CAPCOM_HEARTBEAT_MIN=0 turns the heartbeat off, ORCA_CAPCOM_WAKE=0 the worker wake', () => {
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '0', ORCA_CAPCOM_WAKE: '0' });
    const wake = createWake(r.deps);
    r.arrive(agent({ id: 'w', callsign: 'W1' }));
    r.move('w', 'done');
    r.clock.advance(60 * 60_000);
    wake.stop(); r.done();
    const cfg = wakeConfig({ ORCA_CAPCOM_HEARTBEAT_MIN: 'abc', ORCA_CAPCOM_WAKE_STATES: 'done, dead', ORCA_CAPCOM_WAKE_COALESCE_MS: '250' });
    return ok(
      'nothing said in an hour; unparseable keeps the default, lists parse',
      r.said.length === 0 && cfg.heartbeatMin === WAKE_DEFAULTS.heartbeatMin && cfg.coalesceMs === 250
      && cfg.states.has('done') && cfg.states.has('dead') && !cfg.states.has('idle'),
      `${r.said.length} said`,
    );
  }),

  test('a squad member with a live lead reports to the lead, never to CAPCOM; the lead finishing is what wakes CAPCOM', () => {
    const r = rig();
    const told: { toAgentId: string; kind: string; subject: string }[] = [];
    r.deps.tellAgent = (m) => { told.push(m); return true; };
    const wake = createWake(r.deps);
    r.arrive(agent({ id: 'lead', callsign: 'L1', squad: 'audit-01', lead: true }));
    r.arrive(agent({ id: 'mem', callsign: 'M1', squad: 'audit-01', parentId: 'lead', depth: 2 }));
    r.arrive(agent({ id: 'mem2', callsign: 'M2', squad: 'audit-01', parentId: 'lead', depth: 2 }));
    // CAPCOM rota: la sesión que lanzó al lead se va y otra ocupa su sitio.
    delete r.agents['cap'];
    r.setCapcom(capcomAgent({ id: 'cap2' }));
    // Un miembro termina, otro se queda idle: los dos van al líder y ninguno a CAPCOM.
    r.move('mem', 'done', { lastSay: 'audit section 3 clean' });
    r.move('mem2', 'idle', { lastSay: 'section 4 pending review' });
    r.clock.advance(COALESCE + SETTLE);
    const quiet = r.said.length;
    const leadTold = told.filter((m) => m.toAgentId === 'lead').map((m) => m.subject);
    // El líder termina: eso sí es de CAPCOM, y llega con el squad y la misión.
    r.move('lead', 'done', { lastSay: 'audit consolidated: 2 findings' });
    r.clock.advance(COALESCE);
    wake.stop(); r.done();
    return ok(
      'members → lead (done and settled idle), lead → CAPCOM',
      quiet === 0 && leadTold.length === 2
      && leadTold.some((s) => s.startsWith('M1 finished (done)')) && leadTold.some((s) => s.startsWith('M2 finished (idle)'))
      && r.said.length === 1 && (r.said[0] ?? '').startsWith('[AGENT L1 done] project: orca · squad: audit-01'),
      `${quiet} said before the lead, ${r.said.length} after; lead told: ${leadTold.join(' | ')}`,
    );
  }),

  test('a squad member whose lead is gone wakes CAPCOM itself: it is the only door left', () => {
    const r = rig();
    const wake = createWake(r.deps);
    r.arrive(agent({ id: 'lead', callsign: 'L1', squad: 'audit-01', lead: true }));
    r.arrive(agent({ id: 'mem', callsign: 'M1', squad: 'audit-01', parentId: 'lead', depth: 2 }));
    r.move('lead', 'dead');
    r.clock.advance(COALESCE);
    const afterLead = r.said.length;
    r.move('mem', 'done', { lastSay: 'audit section 3 clean' });
    r.clock.advance(COALESCE);
    wake.stop(); r.done();
    return ok(
      'dead lead wakes CAPCOM, then the orphaned member does too',
      afterLead === 1 && r.said.length === 2 && (r.said[1] ?? '').startsWith('[AGENT M1 done] project: orca · squad: audit-01'),
      `${afterLead} then ${r.said.length}`,
    );
  }),

  test('cold start: thirty agents that finished days ago replay booting→done/idle and wake nobody', () => {
    const r = rig();
    const old = r.clock.now() - 3 * 24 * 3600_000;
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const id = `old${i}`;
      ids.push(id);
      const state = (['done', 'idle', 'dead'] as const)[i % 3]!;
      r.agents[id] = agent({ id, callsign: `O${i}`, state, startedAt: old, updatedAt: old + 60_000, lastSay: 'ping' });
    }
    const wake = createWake(r.deps);
    // El mundo se reconstruye: cada uno entra y cruza booting → su estado final.
    for (const id of ids) {
      const a = r.agents[id]!;
      const final = a.state;
      a.state = 'booting';
      r.arrive(a);
      r.move(id, final === 'dead' ? 'dead' : final === 'idle' ? 'idle' : 'done');
    }
    r.clock.advance(COALESCE + SETTLE + HEARTBEAT_TICK_MS);
    const pending = wake.pending();
    wake.stop(); r.done();
    return ok('zero wakes for history', r.said.length === 0 && pending === 0, `${r.said.length} said, ${pending} pending`);
  }),

  test('cold start: an agent that arrives already done, or goes idle→done, is history too', () => {
    const r = rig();
    const wake = createWake(r.deps);
    r.arrive(agent({ id: 'late', callsign: 'X1', state: 'done', lastSay: 'finished yesterday' }));
    r.arrive(agent({ id: 'idl', callsign: 'X2', state: 'idle' }));
    r.move('idl', 'done');
    r.arrive(agent({ id: 'unk', callsign: 'X3', state: 'booting' }));
    r.lifecycle.feed({ at: r.clock.now(), kind: 'agent:state', agentId: 'unk', data: { from: '', to: 'done' } }, r.agents['unk']!);
    r.clock.advance(COALESCE + SETTLE);
    wake.stop(); r.done();
    return ok('nothing said', r.said.length === 0, `${r.said.length} said`);
  }),

  test('restart: a delivered finish is persisted and a second wake over the same dir does not repeat it', () => {
    const r = rig();
    const first = createWake(r.deps);
    r.arrive(agent({ id: 'k9', callsign: 'K9', lastSay: 'done, tests green' }));
    r.move('k9', 'working');
    r.move('k9', 'done');
    r.clock.advance(COALESCE);
    const delivered = r.said.length;
    const file = join(r.dir, WAKE_STATE_FILE);
    const persisted = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { seen: Record<string, { state: string }>; lastDeliveredAt: number } : null;
    first.stop();
    // El hub reinicia: mismo directorio, mundo reconstruido, K9 cruza booting → done.
    const r2 = rig({}, capcomAgent(), r.dir);
    r2.clock.advance(60_000);
    const second = createWake(r2.deps);
    const k9 = agent({ id: 'k9', callsign: 'K9', state: 'booting', lastSay: 'done, tests green' });
    r2.arrive(k9);
    r2.move('k9', 'done');
    r2.clock.advance(COALESCE);
    const afterRestart = r2.said.length;   // rig nuevo: su propio contador, parte de cero
    // Y más tarde vuelve a trabajar de verdad y termina: eso sí es un fin.
    r2.move('k9', 'working');
    r2.clock.advance(1000);
    r2.move('k9', 'done', { lastSay: 'second run done' });
    r2.clock.advance(COALESCE);
    const afterLive = r2.said.length;
    second.stop(); r2.done();
    return ok(
      'first 1 and persisted, replay 0, later live finish 1',
      delivered === 1 && persisted?.seen['k9']?.state === 'done' && (persisted?.lastDeliveredAt ?? 0) > 0
      && afterRestart === 0 && afterLive === 1 && (r2.said[0] ?? '').includes('second run done'),
      `${delivered}/${afterRestart}/${afterLive}`,
    );
  }),

  test('restart: what was already finished when the wake started is written to the watermark', () => {
    const r = rig();
    r.agents['h1'] = agent({ id: 'h1', callsign: 'H1', state: 'done' });
    r.agents['w1'] = agent({ id: 'w1', callsign: 'W1', state: 'working' });
    const wake = createWake(r.deps);
    // `watermark()` devuelve una copia, así que lo que se anote después no la toca.
    const wm = wake.watermark();
    const file = join(r.dir, WAKE_STATE_FILE);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { seen: Record<string, unknown>; capcoms: string[] };
    // El que estaba trabajando sí despierta cuando termina.
    r.move('w1', 'done');
    r.clock.advance(COALESCE);
    wake.stop(); r.done();
    return ok(
      'finished agent seen, working one not, CAPCOM remembered, live finish delivered',
      wm.seen['h1']?.state === 'done' && !wm.seen['w1'] && onDisk.seen['h1'] !== undefined && onDisk.capcoms.includes('cap')
      && r.said.length === 1 && (r.said[0] ?? '').startsWith('[AGENT W1 done]'),
      `${r.said.length} said`,
    );
  }),

  /* ── el tercer despertador: la pregunta del operador ──────────── */

  test('una misión con pending_human despierta a CAPCOM a los 4 min, y responderla lo apaga', () => {
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '0' });
    const wake = createWake(r.deps);
    try {
      const asked = r.clock.now();
      r.missions['mission_a'] = mission('mission_a', 'Rediseñar el selector', [
        { id: 'm1', role: 'human', at: asked, text: '¿Puedes empezar por el filtro de estado antes que por el orden?' },
      ]);

      r.clock.advance(3 * 60_000);
      const quiet = r.said.length === 0;

      r.clock.advance(90_000);            // pasa de los 4 min
      const one = r.said.filter((t) => t.includes(MISSION_WAKE_PREFIX));
      const said = one[0] ?? '';
      const wellFormed = one.length === 1
        && said.startsWith('[MISSION mission_a] "Rediseñar el selector"')
        && /waiting 4m for a reply/.test(said)
        && said.includes('asked: ¿Puedes empezar por el filtro de estado antes que por el orden?')
        && said.includes('report_mission(mission_id="mission_a"')
        && said.includes('Answering in the console does not close a mission');

      // CAPCOM contesta EN LA MISIÓN: la deuda desaparece y el aviso se apaga.
      r.missions['mission_a']!.messages.push({ id: 'm2', role: 'capcom', at: r.clock.now(), text: 'Voy con el filtro primero.' });
      r.clock.advance(4 * 60 * 60_000);
      const silenced = r.said.filter((t) => t.includes(MISSION_WAKE_PREFIX)).length === 1;

      return ok('nothing before 4m, one well-formed reminder, silence once answered',
        quiet && wellFormed && silenced, said || `said=${r.said.length}`);
    } finally { wake.stop(); r.done(); }
  }),

  test('los recordatorios se espacian y no se repiten cada tick', () => {
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '0' });
    const wake = createWake(r.deps);
    try {
      r.missions['mission_b'] = mission('mission_b', 'Migrar cobros', [
        { id: 'm1', role: 'human', at: r.clock.now(), text: '¿Empezamos?' },
      ]);
      const count = () => r.said.filter((t) => t.includes(MISSION_WAKE_PREFIX)).length;
      r.clock.advance(5 * 60_000);
      const first = count() === 1;
      r.clock.advance(9 * 60_000);        // 14 min: todavía uno solo
      const stillOne = count() === 1;
      r.clock.advance(2 * 60_000);        // 16 min: toca el segundo
      const second = count() === 2;
      r.clock.advance(20 * 60_000);       // 36 min: el tercero es a los 45
      const stillTwo = count() === 2;
      r.clock.advance(10 * 60_000);       // 46 min
      const third = count() === 3;
      return ok('4, 15, 45 — y nada entre medias', first && stillOne && second && stillTwo && third,
        `first=${first} stillOne=${stillOne} second=${second} stillTwo=${stillTwo} third=${third}`);
    } finally { wake.stop(); r.done(); }
  }),

  test('tres misiones esperando son un mensaje, no tres', () => {
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '0' });
    const wake = createWake(r.deps);
    try {
      const t0 = r.clock.now();
      // Segundos de diferencia, no minutos: las tres vencen en el mismo tick,
      // que es cuando agrupar significa algo.
      for (const [i, id] of ['mission_a', 'mission_b', 'mission_c'].entries()) {
        r.missions[id] = mission(id, `misión ${i}`, [
          { id: 'm1', role: 'human', at: t0 - i * 1000, text: `pregunta ${i}` },
        ]);
      }
      r.clock.advance(5 * 60_000);
      const msgs = r.said.filter((t) => t.includes(MISSION_WAKE_PREFIX));
      const one = msgs.length === 1;
      const m = msgs[0] ?? '';
      return ok('one grouped message, oldest first, with the count',
        one && m.startsWith('[MISSION] 3 operator questions are waiting on you, the oldest 4m.')
        && m.indexOf('mission_c') < m.indexOf('mission_a'), m);
    } finally { wake.stop(); r.done(); }
  }),

  test('a la media hora el OPERADOR se entera de que su pregunta sigue sin respuesta, una sola vez', () => {
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '0' }, null);   // sin CAPCOM vivo
    const wake = createWake(r.deps);
    try {
      r.missions['mission_a'] = mission('mission_a', 'YINK', [
        { id: 'm1', role: 'human', at: r.clock.now(), text: 'Adelante' },
      ]);
      r.clock.advance(29 * 60_000);
      const quiet = r.alerts.length === 0;
      r.clock.advance(2 * 60_000);
      const told = r.alerts.length === 1
        && r.alerts[0]!.includes('mission_a')
        && /waiting 3[01]m/.test(r.alerts[0]!)
        && r.alerts[0]!.includes('report_mission');
      r.clock.advance(3 * 60 * 60_000);
      const once = r.alerts.length === 1;
      return ok('el operador se entera aunque no haya CAPCOM, y sólo una vez',
        quiet && told && once, r.alerts.join(' | '));
    } finally { wake.stop(); r.done(); }
  }),

  test('un reinicio del hub no repite el recordatorio, y una pregunta nueva reinicia la escalera', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-wake-mission-'));
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '0' }, capcomAgent(), dir);
    const wake = createWake(r.deps);
    try {
      r.missions['mission_a'] = mission('mission_a', 'Cobros', [
        { id: 'm1', role: 'human', at: r.clock.now(), text: 'primera' },
      ]);
      r.clock.advance(5 * 60_000);
      const first = r.said.filter((t) => t.includes(MISSION_WAKE_PREFIX)).length === 1;
      wake.stop();

      // El hub reinicia: misma carpeta, instancia nueva.
      const again = createWake(r.deps);
      r.clock.advance(60_000);
      const notRepeated = r.said.filter((t) => t.includes(MISSION_WAKE_PREFIX)).length === 1;

      // El operador insiste con OTRA pregunta: la escalera empieza de cero y
      // vuelve a avisar a los cuatro minutos, no a los quince.
      r.missions['mission_a']!.messages.push({ id: 'm2', role: 'human', at: r.clock.now(), text: 'segunda' });
      r.clock.advance(5 * 60_000);
      const msgs = r.said.filter((t) => t.includes(MISSION_WAKE_PREFIX));
      const restarted = msgs.length === 2 && msgs[1]!.includes('(2 messages unanswered)');
      again.stop();
      return ok('watermark survives the restart; a new question restarts the ladder',
        first && notRepeated && restarted, `first=${first} notRepeated=${notRepeated} restarted=${restarted}`);
    } finally { wake.stop(); r.done(); }
  }),

  test('una misión archivada o terminada no recuerda nada', () => {
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '0' });
    const wake = createWake(r.deps);
    try {
      r.missions['mission_done'] = mission('mission_done', 'cerrada', [
        { id: 'm1', role: 'human', at: r.clock.now(), text: 'y esto?' },
      ]);
      r.missions['mission_done']!.status = 'completed';
      r.missions['mission_arch'] = mission('mission_arch', 'retirada', [
        { id: 'm1', role: 'human', at: r.clock.now(), text: 'y esto otro?' },
      ]);
      r.missions['mission_arch']!.archivedAt = r.clock.now();
      r.clock.advance(60 * 60_000);
      return ok('silence', r.said.filter((t) => t.includes(MISSION_WAKE_PREFIX)).length === 0, r.said.join(' | '));
    } finally { wake.stop(); r.done(); }
  }),

  test('ORCA_MISSION_REPLY_STEPS lo reconfigura, y vacío lo apaga', () => {
    const custom = wakeConfig({ ORCA_MISSION_REPLY_STEPS: '2,30' } as Record<string, string>);
    const off = rig({ ORCA_MISSION_REPLY_STEPS: '0', ORCA_CAPCOM_HEARTBEAT_MIN: '0' });
    const wake = createWake(off.deps);
    try {
      off.missions['mission_a'] = mission('mission_a', 'x', [
        { id: 'm1', role: 'human', at: off.clock.now(), text: 'hola' },
      ]);
      off.clock.advance(6 * 60 * 60_000);
      return ok('steps parsed and disabled',
        custom.missionReplySteps.join(',') === '2,30'
        && off.said.filter((t) => t.includes(MISSION_WAKE_PREFIX)).length === 0,
        `${custom.missionReplySteps.join(',')} · said=${off.said.length}`);
    } finally { wake.stop(); off.done(); }
  }),

  /* ── la misión que no avanza ────────────────────────────────────── */

  /*
   * El caso entero, en un test: CAPCOM manda trabajo, el envío no llega a la
   * máquina, y la misión se queda activa sin deber ni un mensaje. Antes de
   * esto no salía en `only_pending`, no salía en el briefing y nadie la
   * despertaba: el 2026-09-09 dos misiones estuvieron así un día.
   */
  test('un envío que falló despierta a CAPCOM con el motivo y qué hacer, no con un idle', () => {
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '0' });
    const wake = createWake(r.deps);
    try {
      const t0 = r.clock.now();
      r.arrive(agent({ id: 'w1', callsign: 'WO', state: 'idle' }));
      r.missions['mission_a'] = {
        ...mission('mission_a', 'iconos de CAPCOM', [
          { id: 'm1', role: 'human', at: t0, text: 'hazlos' },
          { id: 'm2', role: 'capcom', at: t0 + 1000, text: 'mandado a WO' },
        ]),
        agentIds: ['w1'],
        dispatches: { w1: { agentId: 'w1', callsign: 'WO', at: t0 + 2000, delivered: false, detail: 'máquina no conectada: mac-2' } },
      };
      r.clock.advance(3 * 60_000);
      const msg = r.said.find((t) => t.includes('stalled')) ?? '';
      return ok('un solo mensaje, con motivo y acción',
        r.said.length === 1
        && msg.startsWith(`[${MISSION_WAKE_PREFIX} mission_a stalled] "iconos de CAPCOM" · send-failed for`)
        && msg.includes('máquina no conectada: mac-2')
        && msg.includes('ORCA does not retry it for you'),
        msg.split('\n')[0]);
    } finally { wake.stop(); r.done(); }
  }),

  /*
   * «Sent» no es «recibido», y el silencio de un agente tampoco es una alarma
   * inmediata: entre las dos cosas está el respiro. Aquí se comprueba que el
   * respiro se respeta y que, pasado, el aviso sale una sola vez.
   */
  test('«sent» sin señal de arranque espera al respiro y luego avisa una vez', () => {
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '0' });
    const wake = createWake(r.deps);
    try {
      const t0 = r.clock.now();
      r.arrive(agent({ id: 'w1', callsign: 'E4', state: 'idle', updatedAt: t0 }));
      r.missions['mission_b'] = {
        ...mission('mission_b', 'purge harness', [
          { id: 'm1', role: 'human', at: t0, text: 'hazlo' },
          { id: 'm2', role: 'capcom', at: t0 + 1000, text: 'mandado' },
        ]),
        agentIds: ['w1'],
        dispatches: { w1: { agentId: 'w1', callsign: 'E4', at: t0 + 2000, delivered: true } },
      };
      r.clock.advance(9 * 60_000);
      const quiet = r.said.length === 0;
      r.clock.advance(3 * 60_000);
      const first = r.said.length === 1 && r.said[0]!.includes('no-start');
      // Y no se repite en cada tick: la escalera lo espacia.
      r.clock.advance(10 * 60_000);
      const once = r.said.length === 1;
      return ok('respiro, un aviso, y silencio hasta el siguiente escalón',
        quiet && first && once, `quiet=${quiet} first=${first} said=${r.said.length}`);
    } finally { wake.stop(); r.done(); }
  }),

  /*
   * Que la condición se resuelva sola es la mitad del diseño: nadie cancela un
   * aviso, deja de haber motivo. Y si vuelve a pararse, la escalera empieza de
   * cero en vez de heredar la vieja.
   */
  test('actividad del agente resuelve el parón y borra su cuenta; un parón nuevo vuelve a avisar', () => {
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '0' });
    const wake = createWake(r.deps);
    try {
      const t0 = r.clock.now();
      r.arrive(agent({ id: 'w1', callsign: 'E4', state: 'idle', updatedAt: t0 }));
      r.missions['mission_c'] = {
        ...mission('mission_c', 'lo que sea', [
          { id: 'm1', role: 'human', at: t0, text: 'hazlo' },
          { id: 'm2', role: 'capcom', at: t0 + 1000, text: 'mandado' },
        ]),
        agentIds: ['w1'],
        dispatches: { w1: { agentId: 'w1', callsign: 'E4', at: t0 + 2000, delivered: true } },
      };
      r.clock.advance(12 * 60_000);
      const warned = r.said.length === 1;
      // Se pone a trabajar: la condición desaparece y la cuenta con ella.
      r.move('w1', 'working');
      r.clock.advance(60_000);
      const cleared = wake.watermark().stalls['mission_c'] === undefined && r.said.length === 1;
      // Se vuelve a parar: es otra condición, y avisa sin heredar la escalera.
      r.move('w1', 'idle');
      r.clock.advance(12 * 60_000);
      const again = r.said.filter((t) => t.includes('stalled')).length === 2;
      return ok('se apaga solo y vuelve a encenderse por su cuenta',
        warned && cleared && again, `warned=${warned} cleared=${cleared} said=${r.said.length}`);
    } finally { wake.stop(); r.done(); }
  }),

  /*
   * Sin CAPCOM no se pierde nada y, sobre todo, no se apunta como avisado: el
   * hub bajo `tsx watch` reinicia con cada edición, y un aviso marcado como
   * dado sobre una sesión que no existía sería un aviso que nadie leyó nunca.
   * El operador, en cambio, se entera igual.
   */
  test('sin CAPCOM el aviso espera, no se marca como dado, y el reinicio no lo repite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-wake-'));
    const r = rig({ ORCA_CAPCOM_HEARTBEAT_MIN: '0', ORCA_MISSION_STALL_ALERT_MIN: '20' }, null, dir);
    const wake = createWake(r.deps);
    try {
      const t0 = r.clock.now();
      r.arrive(agent({ id: 'w1', callsign: 'E4', state: 'idle', updatedAt: t0 }));
      r.missions['mission_d'] = {
        ...mission('mission_d', 'sin mando', [
          { id: 'm1', role: 'human', at: t0, text: 'hazlo' },
          { id: 'm2', role: 'capcom', at: t0 + 1000, text: 'mandado' },
        ]),
        agentIds: ['w1'],
        dispatches: { w1: { agentId: 'w1', callsign: 'E4', at: t0 + 2000, delivered: true } },
      };
      r.clock.advance(25 * 60_000);
      const nothingSaid = r.said.length === 0;
      const operatorTold = r.alerts.some((a) => a.includes('mission_d') && a.includes('has not moved'));
      const notCounted = (wake.watermark().stalls['mission_d']?.sent ?? -1) === 0;
      wake.stop();

      // Reinicio del hub: la marca de agua vuelve del disco y el aviso al
      // operador no se repite, pero CAPCOM —que ahora sí está— lo recibe.
      r.setCapcom(capcomAgent({ id: 'cap2', callsign: 'C2' }));
      const again = createWake(r.deps);
      r.clock.advance(60_000);
      const delivered = r.said.filter((t) => t.includes('stalled')).length === 1;
      const alertedOnce = r.alerts.filter((a) => a.includes('mission_d')).length === 1;
      again.stop();
      return ok('espera sin marcar, avisa al operador una vez, y entrega al aparecer el mando',
        nothingSaid && operatorTold && notCounted && delivered && alertedOnce,
        `said=${r.said.length} alerts=${r.alerts.length}`);
    } finally { r.done(); }
  }),

  /* La configuración se lee del entorno, y se puede apagar del todo. */
  test('ORCA_MISSION_STALL_STEPS y ORCA_MISSION_STALL_MIN reconfiguran; vacío apaga el aviso', () => {
    const custom = wakeConfig({ ORCA_MISSION_STALL_STEPS: '5,40', ORCA_MISSION_STALL_MIN: '2' } as Record<string, string>);
    const off = rig({ ORCA_MISSION_STALL_STEPS: '0', ORCA_CAPCOM_HEARTBEAT_MIN: '0' });
    const wake = createWake(off.deps);
    try {
      const t0 = off.clock.now();
      off.arrive(agent({ id: 'w1', callsign: 'E4', state: 'idle', updatedAt: t0 }));
      off.missions['mission_e'] = {
        ...mission('mission_e', 'apagado', [
          { id: 'm1', role: 'human', at: t0, text: 'hazlo' },
          { id: 'm2', role: 'capcom', at: t0 + 1000, text: 'mandado' },
        ]),
        agentIds: ['w1'],
        dispatches: { w1: { agentId: 'w1', callsign: 'E4', at: t0 + 2000, delivered: true } },
      };
      off.clock.advance(6 * 60 * 60_000);
      return ok('parseado y apagable',
        custom.missionStallSteps.join(',') === '5,40' && custom.missionStallMin === 2
        && off.said.filter((t) => t.includes('stalled')).length === 0,
        `${custom.missionStallSteps.join(',')} · said=${off.said.length}`);
    } finally { wake.stop(); off.done(); }
  }),

  /* ── el miembro que espera a su líder ───────────────────────────── */

  test('a member blocked on an ask to its lead: silence for 15 min, then one [SQUAD] with the exact call, again at 45, and nothing once answered', () => {
    const r = squadRig();
    const wake = createWake(r.deps);
    try {
      r.mail.push(ask({ id: 'msg_1', fromAgentId: 'mem', toAgentId: 'lead', at: r.clock.now() }));
      r.clock.advance(14 * MIN);
      const early = squadSaid(r).length;
      r.clock.advance(2 * MIN);
      const first = squadSaid(r);
      r.clock.advance(20 * MIN);
      const between = squadSaid(r).length;
      r.clock.advance(10 * MIN);
      const second = squadSaid(r).length;
      r.mail[0]!.answer = 'main'; r.mail[0]!.answeredAt = r.clock.now(); r.mail[0]!.answeredBy = 'lead';
      r.clock.advance(3 * 60 * MIN);
      const after = squadSaid(r).length;
      const line = first[0] ?? '';
      return ok(
        '15 → 45 ladder, the answer_peer call verbatim, silent once answered',
        early === 0 && first.length === 1 && between === 1 && second === 2 && after === 2
        && line.startsWith(`[${SQUAD_WAKE_PREFIX} audit-01] M1 has been waiting 15m for its lead L1 to answer\n`)
        && line.includes('asked: merge onto main or onto the branch?')
        && line.includes('answer_peer(message_id="msg_1"') && line.includes('send_to_agent L1')
        && r.notes.some((n) => n.includes('esperando a su líder') && n.includes('M1 15m'))
        && wake.watermark().squadWaits['msg_1'] === undefined,
        `${early}/${first.length}/${between}/${second}/${after} · ${line.split('\n')[0]}`,
      );
    } finally { wake.stop(); r.done(); }
  }),

  test('a member asking a lead that is already dead reaches CAPCOM within a minute: nobody else will ever answer', () => {
    const r = squadRig();
    const wake = createWake(r.deps);
    try {
      r.move('lead', 'dead');
      r.clock.advance(COALESCE);
      const agentWakes = r.said.length;
      r.mail.push(ask({ id: 'msg_2', fromAgentId: 'mem', toSquad: 'audit-01', at: r.clock.now() }));
      // El minuto se cumple entre dos ticks: cae en el siguiente.
      r.clock.advance(SQUAD_WAIT_ORPHAN_MIN * MIN + HEARTBEAT_TICK_MS);
      const first = squadSaid(r);
      r.clock.advance(40 * MIN);
      const held = squadSaid(r).length;
      r.clock.advance(5 * MIN);
      const second = squadSaid(r).length;
      const line = first[0] ?? '';
      return ok(
        '[AGENT L1 dead] first, then [SQUAD] at a minute saying the lead is gone, then the normal ladder',
        agentWakes === 1 && first.length === 1 && held === 1 && second === 2
        && line.startsWith(`[${SQUAD_WAKE_PREFIX} audit-01] M1 has been waiting 1m for its lead L1 to answer; L1 is gone (dead): nobody will\n`)
        && line.includes("hand M1's work to someone else") && !line.includes('send_to_agent')
        && r.notes.some((n) => n.includes('M1 1m, líder ido')),
        `${agentWakes}/${first.length}/${held}/${second} · ${line.split('\n')[0]}`,
      );
    } finally { wake.stop(); r.done(); }
  }),

  test("only a member's ask to its lead or its squad counts: handoffs, a lead's own asks, questions to peers and agents without a squad never wake", () => {
    const r = squadRig();
    r.arrive(agent({ id: 'mem2', callsign: 'M2', squad: 'audit-01', parentId: 'lead', depth: 2 }));
    r.arrive(agent({ id: 'solo', callsign: 'S1' }));
    const wake = createWake(r.deps);
    try {
      const at = r.clock.now();
      r.mail.push(
        ask({ id: 'h', kind: 'handoff', fromAgentId: 'mem', toAgentId: 'lead', at }),
        ask({ id: 'l', fromAgentId: 'lead', toSquad: 'audit-01', at }),
        ask({ id: 'p', fromAgentId: 'mem', toAgentId: 'mem2', at }),
        ask({ id: 's', fromAgentId: 'solo', toAgentId: 'lead', at }),
      );
      r.clock.advance(3 * 60 * MIN);
      return ok(
        'none of them is a member waiting on its lead',
        squadSaid(r).length === 0 && Object.keys(wake.watermark().squadWaits).length === 0,
        `${squadSaid(r).length} said`,
      );
    } finally { wake.stop(); r.done(); }
  }),

  test('past an hour the operator sees it once in their feed; a member that leaves closes its wait; several waits travel as one message', () => {
    const r = squadRig();
    r.arrive(agent({ id: 'mem2', callsign: 'M2', squad: 'audit-01', parentId: 'lead', depth: 2 }));
    const wake = createWake(r.deps);
    try {
      const at = r.clock.now();
      r.mail.push(
        ask({ id: 'a', fromAgentId: 'mem', toAgentId: 'lead', at }),
        ask({ id: 'b', fromAgentId: 'mem2', toSquad: 'audit-01', at, subject: 'which branch do I merge?' }),
      );
      r.clock.advance(16 * MIN);
      const first = squadSaid(r);
      r.move('mem2', 'done');
      r.clock.advance((SQUAD_WAIT_ALERT_MIN - 16 + 1) * MIN);
      const alerts = r.alerts.filter((t) => t.startsWith('squad audit-01'));
      r.clock.advance(3 * 60 * MIN);
      const alertsLater = r.alerts.filter((t) => t.startsWith('squad audit-01')).length;
      const later = squadSaid(r).slice(1);
      const one = first[0] ?? '';
      return ok(
        'two waits → one [SQUAD] message; one operator alert at an hour; M2 gone → only M1 keeps being reported',
        first.length === 1 && one.startsWith(`[${SQUAD_WAKE_PREFIX}] 2 squad members are waiting on their leads, the longest 15m.\n`)
        && one.includes('M1 has been waiting 15m') && one.includes('M2 has been waiting 15m') && one.includes('asked: which branch do I merge?')
        && alerts.length === 1 && alerts[0]!.startsWith('squad audit-01: M1 has been waiting 1h for its lead L1 to answer — "merge onto main')
        && alertsLater === 1
        && later.length > 0 && later.every((t) => t.includes('M1 has been waiting') && !t.includes('M2')),
        `${first.length} first · ${alerts.length}/${alertsLater} alerts · ${later.length} later`,
      );
    } finally { wake.stop(); r.done(); }
  }),

  test('a hub restart does not repeat the warning, and without CAPCOM nothing is counted as sent', () => {
    const r = squadRig();
    r.setCapcom(null);
    const wake = createWake(r.deps);
    try {
      r.mail.push(ask({ id: 'msg_5', fromAgentId: 'mem', toAgentId: 'lead', at: r.clock.now() }));
      r.clock.advance(30 * MIN);
      const withoutCapcom = squadSaid(r).length;
      const notSent = wake.watermark().squadWaits['msg_5']?.sent === 0;
      r.setCapcom(capcomAgent({ id: 'cap2' }));
      r.clock.advance(HEARTBEAT_TICK_MS);
      const once = squadSaid(r).length;
      wake.stop();
      const again = createWake(r.deps);
      try {
        r.clock.advance(10 * MIN);
        const after = squadSaid(r).length;
        const persisted = (JSON.parse(readFileSync(join(r.dir, WAKE_STATE_FILE), 'utf8')) as { squadWaits?: Record<string, { sent: number }> })
          .squadWaits?.['msg_5']?.sent === 1;
        return ok(
          'held without CAPCOM, sent once when one appears, remembered across a restart',
          withoutCapcom === 0 && notSent && once === 1 && after === 1 && persisted,
          `${withoutCapcom}/${once}/${after} · notSent=${notSent} persisted=${persisted}`,
        );
      } finally { again.stop(); }
    } finally { r.done(); }
  }),

  test('ORCA_SQUAD_WAIT_STEPS=0 switches the warning off; a custom ladder is honoured', () => {
    const off = squadRig({ ORCA_SQUAD_WAIT_STEPS: '0' });
    const wake = createWake(off.deps);
    try {
      off.mail.push(ask({ id: 'x', fromAgentId: 'mem', toAgentId: 'lead', at: off.clock.now() }));
      off.clock.advance(6 * 60 * MIN);
      const custom = wakeConfig({ ORCA_SQUAD_WAIT_STEPS: '9,2', ORCA_SQUAD_WAIT_ALERT_MIN: '0' });
      return ok(
        'off is off; steps parse and sort; defaults are the exported ladder',
        squadSaid(off).length === 0 && custom.squadWaitSteps.join(',') === '2,9' && custom.squadWaitAlertMin === 0
        && WAKE_DEFAULTS.squadWaitSteps === SQUAD_WAIT_STEPS_MIN && WAKE_DEFAULTS.squadWaitAlertMin === SQUAD_WAIT_ALERT_MIN,
        `${squadSaid(off).length} said · ${custom.squadWaitSteps.join(',')}`,
      );
    } finally { wake.stop(); off.done(); }
  }),

  test('the brief teaches the prefixes: report_mission on [AGENT], briefing and silence on [HEARTBEAT], and what a stall is not', () => {
    const brief = capcomBrief();
    const has = (s: string) => brief.includes(s);
    return ok(
      'brief covers [AGENT …], [HEARTBEAT] and [MISSION … stalled]',
      has('`[AGENT <callsign> <state>]`') && has('`report_mission`') && has('`[HEARTBEAT]`')
      && has('`briefing`') && has('do nothing')
      // El aviso nuevo sin esto sería una alarma sin manual: los cuatro
      // motivos, que `sent` no es `received`, y que ORCA no reenvía sola.
      && has('`[MISSION <mission_id> stalled]`')
      && has('`send-failed`') && has('`no-agent`') && has('`no-start`') && has('`no-progress`')
      && has('**`sent` is not `received`.**') && has('ORCA never re-sends for you')
      // La salida de emergencia de la jerarquía: el prefijo, que el miembro no
      // tiene otra puerta, y las dos acciones (contestar o empujar al líder).
      && has('`[SQUAD <name>]`') && has('`answer_peer`') && has('no other door'),
    );
  }),
];

export default { suite: 'CAPCOM wake', tests } satisfies TestModule;
