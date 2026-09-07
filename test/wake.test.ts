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

import type { Agent } from '../src/shared/types.ts';
import type { CapcomTask } from '../src/shared/tasks.ts';
import { newId } from '../src/shared/protocol.ts';
import type { AutonomyDeps } from '../src/hub/autonomy.ts';
import type { CapcomTimer } from '../src/hub/capcom.ts';
import { AgentLifecycle } from '../src/hub/lifecycle.ts';
import {
  AGENT_WAKE_PREFIX, HEARTBEAT_PREFIX, HEARTBEAT_TICK_MS, WAKE_DEFAULTS, WAKE_LAST_SAY_CHARS, WAKE_STATE_FILE,
  agentWakeLine, createWake, wakeConfig,
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
  tasks: Record<string, CapcomTask>;
  said: string[];
  notes: string[];
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
  const tasks: Record<string, CapcomTask> = {};
  const said: string[] = [];
  const notes: string[] = [];
  const r: Rig = {
    clock, lifecycle, agents, tasks, said, notes, capcom, dir,
    done() { rmSync(dir, { recursive: true, force: true }); },
    deps: {
      agents: () => Object.values(agents),
      agent: (id) => agents[id],
      projects: () => [],
      project: (id) => (id === 'p1' ? { id: 'p1', name: 'orca' } as never : undefined),
      tasks: () => structuredClone(tasks),
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

const COALESCE = WAKE_DEFAULTS.coalesceMs;
const SETTLE = WAKE_DEFAULTS.idleSettleMs;

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
    r.tasks['task_1'] = { id: 'task_1', title: 't', status: 'active', createdAt: 0, updatedAt: 0, agentIds: ['w1'], messages: [] };
    r.arrive(agent({ id: 'w1', callsign: 'K9', squad: 'audit-01', lastSay: 'Tests green,\n  nothing left.' }));
    r.move('w1', 'done');
    const before = r.said.length;
    r.clock.advance(COALESCE);
    const msg = r.said[0] ?? '';
    wake.stop(); r.done();
    return ok(
      'done → [AGENT K9 done] with the facts on one line and last_say below',
      before === 0 && r.said.length === 1
      && msg.startsWith(`[${AGENT_WAKE_PREFIX} K9 done] project: orca · squad: audit-01 · task: task_1`)
      && msg.includes('\n  last: Tests green, nothing left.')
      && r.notes.some((n) => n.includes('K9 done')),
      msg.split('\n')[0],
    );
  }),

  test('last_say is cut to a bounded size', () => {
    const line = agentWakeLine({
      agentId: 'x', callsign: 'K1', state: 'dead', project: 'orca', squad: null, taskId: null,
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
    // Un externo asignado a una tarea sí cuenta: la tarea lo hace de CAPCOM.
    r.tasks['task_2'] = { id: 'task_2', title: 't', status: 'active', createdAt: 0, updatedAt: 0, agentIds: ['ext'], messages: [] };
    r.move('ext', 'working');
    r.move('ext', 'dead');
    r.clock.advance(COALESCE);
    wake.stop(); r.done();
    return ok(
      'nothing for external, subagent, CAPCOM, escalation or a human squad; one for the task-bound external',
      quiet === 0 && r.said.length === 1 && (r.said[0] ?? '').startsWith('[AGENT E1 dead] project: orca · task: task_2'),
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

  test('a squad member counts when its lead is a child of CAPCOM, even after CAPCOM rotated', () => {
    const r = rig();
    const wake = createWake(r.deps);
    r.arrive(agent({ id: 'lead', callsign: 'L1', squad: 'audit-01', lead: true }));
    r.arrive(agent({ id: 'mem', callsign: 'M1', squad: 'audit-01', parentId: 'lead', depth: 2 }));
    // CAPCOM rota: la sesión que lanzó al lead se va y otra ocupa su sitio.
    delete r.agents['cap'];
    r.setCapcom(capcomAgent({ id: 'cap2' }));
    r.move('mem', 'done', { lastSay: 'audit section 3 clean' });
    r.clock.advance(COALESCE);
    wake.stop(); r.done();
    return ok(
      'member of a CAPCOM squad wakes the new CAPCOM',
      r.said.length === 1 && (r.said[0] ?? '').startsWith('[AGENT M1 done] project: orca · squad: audit-01'),
      `${r.said.length} said`,
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

  test('the brief teaches both prefixes: report_task on [AGENT], briefing and silence on [HEARTBEAT]', () => {
    const brief = capcomBrief();
    const has = (s: string) => brief.includes(s);
    return ok(
      'brief covers [AGENT …] and [HEARTBEAT]',
      has('`[AGENT <callsign> <state>]`') && has('`report_task`') && has('`[HEARTBEAT]`')
      && has('`briefing`') && has('do nothing'),
    );
  }),
];

export default { suite: 'CAPCOM wake', tests } satisfies TestModule;
