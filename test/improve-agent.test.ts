/**
 * El agente revisor de AUTOMEJORA, de punta a punta.
 *
 * Un hub de verdad, una máquina de verdad al otro lado del websocket de
 * collector, y el protocolo real entre los dos. Nada de esto está mockeado: el
 * hub compone el brief, despacha un `spawn`, la máquina lo acepta y contesta
 * con su `SpawnAck`, el agente entra al mundo, archiva por el frame
 * `improve:report` y termina. Es el único sitio donde se puede comprobar que
 * el recorrido entero —lanzar, verse, reportar, terminar— existe.
 *
 * Lo que NO se prueba aquí es que un CLI real escriba propuestas útiles: eso
 * es el modelo, y no hay prueba que lo garantice. Lo que se prueba es que
 * cuando escribe, llega; y que cuando no escribe, ORCA lo dice en vez de
 * inventarse un resultado.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { startHub, type Hub } from '../src/hub/server.ts';
import { createAuth } from '../src/hub/auth.ts';
import { HubStore } from '../src/hub/persist.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { PATHS, PROTOCOL_VERSION, type CollectorFrame, type CommandFrame, type ServerFrame } from '../src/shared/protocol.ts';
import { emptyRollup, type Agent, type Machine, type Project } from '../src/shared/types.ts';
import { reviewerIds } from '../src/shared/improve.ts';
import { ok, test, type TestModule } from './harness.ts';

const TOKEN = 'tok-reviewer';
const MACHINE = 'm_rev';
const PROJECT = 'p_rev';

/* ── una máquina al otro lado del cable ───────────────────────────── */

/**
 * Lo mínimo que hace un collector, y de verdad.
 *
 * Hace el hello, planta un proyecto, escucha comandos y contesta. No simula la
 * flota: simula la MÁQUINA, que es la pieza que el hub tiene enfrente. Todo lo
 * que se comprueba en este archivo pasa por aquí y por el protocolo.
 */
class FakeMachine {
  private ws: WebSocket;
  readonly commands: { id: string; cmd: Record<string, unknown> }[] = [];
  readonly acks: Extract<CommandFrame, { t: 'improve:ack' }>[] = [];
  private agents = new Map<string, Agent>();

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${PATHS.collector}?token=${encodeURIComponent(TOKEN)}`);
    this.ws.on('message', (d) => {
      const f = JSON.parse(d.toString()) as CommandFrame;
      if (f.t === 'improve:ack') { this.acks.push(f); return; }
      if (f.t !== 'cmd') return;
      const cmd = f.cmd as unknown as Record<string, unknown>;
      this.commands.push({ id: f.id, cmd });
      // Un collector de verdad contesta a todo. El `spawn` es la excepción,
      // porque cada prueba decide si esa máquina lo acepta o lo rechaza.
      if (cmd['k'] !== 'spawn') this.send({ t: 'ack', cmdId: f.id, ok: true, detail: 'ok' });
    });
    this.ws.on('error', () => { /* el cierre lo cuenta la prueba */ });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('close', (c) => reject(new Error(`collector cerró con ${c}`)));
    });
    const now = Date.now();
    const load = { sessions: 0, activeSessions: 0, cpuPct: 5, memPct: 20 };
    const machine: Machine = {
      id: MACHINE, hostname: 'rev-box', platform: 'linux', version: '0.1.0-test',
      online: true, lastSeen: now, connectedAt: now, load,
    };
    const project: Project = {
      id: PROJECT, machineId: MACHINE, slug: '-srv-orca', name: 'orca', path: '/srv/orca',
      code: 'OR', gitBranch: 'main', gitDirty: false, keyNames: [], sessionIds: [], rollup: emptyRollup(),
    };
    this.send({ t: 'hello', v: PROTOCOL_VERSION, machine, token: TOKEN });
    this.send({ t: 'snapshot', machineId: MACHINE, projects: [project], agents: [], keys: [] });
  }

  send(frame: CollectorFrame | Record<string, unknown>): void {
    try { this.ws.send(JSON.stringify(frame)); } catch { /* el hub se fue */ }
  }

  /** El spawn que el hub mandó, si mandó alguno. */
  spawn(): { id: string; cmd: Record<string, unknown> } | undefined {
    return this.commands.find((c) => c.cmd['k'] === 'spawn');
  }

  stops(): string[] {
    return this.commands.filter((c) => c.cmd['k'] === 'stop').map((c) => String(c.cmd['agentId']));
  }

  /** Acepta el spawn como lo haría el collector: agente nuevo, y un ack con su id. */
  accept(cmdId: string, over: Partial<Agent> = {}): Agent {
    const now = Date.now();
    const a: Agent = {
      id: over.id ?? 'sess_reviewer', machineId: MACHINE, projectId: PROJECT,
      title: 'AUTOMEJORA', callsign: over.callsign ?? 'R7', runtime: 'claude',
      state: 'working', block: null, origin: 'orca', role: 'agent',
      parentId: null, depth: 0, childIds: [], mission: 'AUTOMEJORA review', squad: null, lead: false,
      model: null, tool: null, toolDetail: null, lastPrompt: null, lastSay: null,
      startedAt: now, updatedAt: now, uptimeMs: 0,
      metrics: {
        costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
        tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0,
        toolDurationMs: 0, apiDurationMs: 0, turns: 0,
      },
      background: true, shortId: 'ab12cd34',
      ...over,
    };
    this.agents.set(a.id, a);
    this.send({ t: 'agent:new', machineId: MACHINE, agent: a });
    this.send({ t: 'ack', cmdId, ok: true, detail: 'lanzado', data: { agentId: a.id, callsign: a.callsign, shortId: a.shortId } });
    return a;
  }

  refuse(cmdId: string, detail: string): void {
    this.send({ t: 'ack', cmdId, ok: false, detail });
  }

  patch(id: string, patch: Partial<Agent>): void {
    const a = this.agents.get(id);
    if (a) Object.assign(a, patch);
    this.send({ t: 'agent', machineId: MACHINE, id, patch: { ...patch, updatedAt: Date.now() } });
  }

  /** Lo que escribe `orca-improve`, ya recogido por el vigilante del collector. */
  report(agentId: string | null, reviewId: string | null, proposals: unknown[], reportId = `rep_${Math.random().toString(36).slice(2)}`): string {
    this.send({ t: 'improve:report', machineId: MACHINE, agentId, reviewId, reportId, proposals });
    return reportId;
  }

  close(): void { try { this.ws.close(); } catch { /* ya */ } }
}

/* ── una consola al otro lado del cable ───────────────────────────── */

class Console {
  private ws: WebSocket;
  private n = 0;
  readonly pushed: ServerFrame[] = [];

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${PATHS.console}?token=${encodeURIComponent(TOKEN)}`);
    this.ws.on('message', (d) => { try { this.pushed.push(JSON.parse(d.toString()) as ServerFrame); } catch { /* ignora */ } });
    this.ws.on('error', () => { /* ya */ });
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('close', (c) => reject(new Error(`consola cerró con ${c}`)));
    });
  }
  ask(frame: Record<string, unknown>, timeoutMs = 8_000): Promise<{ ok: boolean; detail?: string; data?: unknown }> {
    const id = `c${this.n++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sin ack para ${String(frame['t'])}`)), timeoutMs);
      const onMessage = (d: Buffer) => {
        const f = JSON.parse(d.toString()) as ServerFrame;
        if (f.t !== 'ack' || f.cmdId !== id) return;
        clearTimeout(timer);
        this.ws.off('message', onMessage as never);
        resolve(f);
      };
      this.ws.on('message', onMessage as never);
      this.ws.send(JSON.stringify({ ...frame, id }));
    });
  }
  close(): void { try { this.ws.close(); } catch { /* ya */ } }
}

/* ── plumbing ─────────────────────────────────────────────────────── */

async function until(p: () => boolean, ms = 5_000, what = 'condición'): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (p()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`tiempo agotado esperando: ${what}`);
}

interface Rig { hub: Hub; machine: FakeMachine; console: Console }

async function withRig<T>(fn: (r: Rig) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-reviewer-'));
  // El proyecto donde corre el revisor se nombra por entorno: el repo real de
  // ORCA no es un proyecto de este hub de pruebas.
  const before = process.env['ORCA_IMPROVE_PROJECT'];
  process.env['ORCA_IMPROVE_PROJECT'] = PROJECT;
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    store: new HubStore({ dir }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
  });
  const machine = new FakeMachine(hub.port);
  const console_ = new Console(hub.port);
  try {
    await machine.open();
    await console_.open();
    await until(() => !!hub.world.state.projects[PROJECT], 5_000, 'el proyecto llega al mundo');
    return await fn({ hub, machine, console: console_ });
  } finally {
    machine.close();
    console_.close();
    await hub.close();
    if (before === undefined) delete process.env['ORCA_IMPROVE_PROJECT']; else process.env['ORCA_IMPROVE_PROJECT'] = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

const DRAFT = {
  key: 'queue-order',
  title: 'The queue buries the oldest escalation',
  summary: 'Sort the queue by age so the longest wait is the first row.',
  area: 'usability', kind: 'observed',
  evidence: ['avg wait 14m over 31 escalations'],
  impact: 'high', effort: 'low',
};

/** Cuántos spawn ha visto la máquina. */
function spawns(r: Rig): { id: string; cmd: Record<string, unknown> }[] {
  return r.machine.commands.filter((c) => c.cmd['k'] === 'spawn');
}

/**
 * Lanza el revisor y devuelve el agente que la máquina creó.
 *
 * El ack de `improve:run` no vuelve hasta que la MÁQUINA contesta al spawn,
 * porque el hub espera al collector como espera a cualquier comando. Por eso
 * se pide primero y se acepta después: al revés, la prueba se quedaría
 * esperando su propio recibo.
 */
async function launch(r: Rig, n = 1): Promise<Agent> {
  const asked = r.console.ask({ t: 'improve:run' });
  await until(() => spawns(r).length >= n, 5_000, `el spawn ${n} llega a la máquina`);
  const agent = r.machine.accept(spawns(r)[n - 1]!.id, { id: `sess_reviewer_${n}`, callsign: n === 1 ? 'R7' : `R${n}` });
  const out = await asked;
  if (!out.ok) throw new Error(`improve:run rechazado: ${out.detail ?? ''}`);
  await until(() => (r.hub.autonomy.improve.store.state().reviews[0]?.agentId ?? null) === agent.id, 5_000, 'la revisión conoce a su agente');
  return agent;
}

/* ── pruebas ──────────────────────────────────────────────────────── */

const tests = [
  test('FORGE: approval launches an auto mission lead and only its report reaches CAPCOM', () => withRig(async (r) => {
    const id = r.hub.autonomy.improve.store.file('review_fixture', [DRAFT]).proposals[0]!.id;
    const asked = r.console.ask({ t: 'improve:send', proposalId: id, missionId: 'mission_forge_wire' });
    await until(() => spawns(r).length === 1, 5_000, 'FORGE spawn');
    const spawn = spawns(r)[0]!;
    const squad = String(spawn.cmd['squad']);
    const beforeAck = r.hub.missions.get('mission_forge_wire');
    const agent = r.machine.accept(spawn.id, { id: 'forge_fixture', callsign: 'F1', squad, lead: true });
    const ack = await asked;
    r.machine.patch(agent.id, { state: 'done', lastSay: 'Verified fixture; CAPCOM review pending.' });
    await until(() => r.hub.missions.get('mission_forge_wire').messages.some((m) => m.role === 'agent'), 5_000, 'FORGE report');
    const mission = r.hub.missions.get('mission_forge_wire');
    return ok('existing mission, routine auto permissions, consolidated report and no automatic closure',
      ack.ok && squad.startsWith('forge-') && beforeAck.squads?.includes(squad) === true
      && spawn.cmd['permissionMode'] === 'auto' && spawn.cmd['parentId'] === null
      && spawn.cmd['lead'] === true && spawn.cmd['review'] !== true
      && String(spawn.cmd['prompt']).includes('You are FORGE')
      && String(spawn.cmd['prompt']).includes('Before elevated or ambiguous actions')
      && String(spawn.cmd['prompt']).includes('Execution permission does not grant publication permission')
      && String(spawn.cmd['prompt']).includes('Never test against real sessions')
      && mission.agentIds.includes(agent.id) && mission.status === 'active'
      && mission.messages.some((m) => m.role === 'agent' && m.text.includes('CAPCOM review pending')));
  })),

  test('launch: the console asks, a real spawn crosses the wire, the agent is the review', () => withRig(async (r) => {
    const agent = await launch(r);
    const spawn = r.machine.spawn()!;
    const rev = r.hub.autonomy.improve.store.state().reviews[0]!;
    const prompt = String(spawn.cmd['prompt']);
    return ok('the command a reviewer needs, and a review that knows who it is',
      spawn.cmd['review'] === true && spawn.cmd['parentId'] === null && spawn.cmd['worktree'] === false
      && String(spawn.cmd['mission']).includes(rev.id)
      && prompt.includes('[ORCA SELF-REVIEW') && prompt.includes('orca-improve report')
      && prompt.includes('TELEMETRY') && prompt.includes('You do not implement anything')
      && rev.status === 'running' && rev.agentId === agent.id && rev.callsign === 'R7'
      && rev.projectId === PROJECT,
      `${rev.status} · ${rev.callsign}`);
  })),

  test('visible: it stands on the fleet, and the console can tell it is a reviewer', () => withRig(async (r) => {
    const agent = await launch(r);
    const inWorld = r.hub.world.state.agents[agent.id];
    // La regla que usa el campo para pintarlo violeta sale del tablero, que es
    // lo que la consola ya tiene: si esto falla, el tile no se distingue.
    const marked = reviewerIds(r.hub.autonomy.improve.store.state()).has(agent.id);
    // Y su presupuesto es el del libro que frena a todos los demás.
    const budget = r.hub.budgets.get({ kind: 'agent', ref: agent.id });
    return ok('a tile like any other, marked by the board, with a real ceiling',
      !!inWorld && inWorld.state === 'working' && marked
      && !!budget && budget.tokens === r.hub.autonomy.improve.store.state().budgetTokens,
      `${inWorld?.callsign} · ${budget?.tokens} tokens`);
  })),

  test('report: what the reviewer files reaches the board, and it is told what happened', () => withRig(async (r) => {
    const agent = await launch(r);
    const rev = r.hub.autonomy.improve.store.state().reviews[0]!;
    r.machine.report(agent.id, rev.id, [DRAFT, { title: 'A guess', summary: 'no numbers behind it' }], 'rep_1');
    await until(() => r.machine.acks.length === 1, 5_000, 'el recibo vuelve');

    const ack = r.machine.acks[0]!;
    const state = r.hub.autonomy.improve.store.state();
    const p = Object.values(state.proposals)[0]!;
    return ok('one filed, one refused with its reason, and the review is reported',
      ack.ok === true && ack.filed === 1 && (ack.rejected ?? []).length === 1
      && (ack.rejected ?? [])[0]!.includes('measurements')
      && p.agentId === agent.id && p.callsign === 'R7' && p.reviewId === rev.id
      && state.reviews[0]!.status === 'reported' && state.reviews[0]!.filed === 1,
      ack.rejected?.[0]);
  })),

  test('report: an agent that is not the reviewer cannot fill the board', () => withRig(async (r) => {
    const agent = await launch(r);
    void agent;
    r.machine.report('sess_someone_else', null, [DRAFT], 'rep_x');
    await until(() => r.machine.acks.length === 1, 5_000, 'el recibo vuelve');
    const ack = r.machine.acks[0]!;
    return ok('refused, with the reason, and nothing on the board',
      ack.ok === false && (ack.error ?? '').includes('belongs to')
      && Object.keys(r.hub.autonomy.improve.store.state().proposals).length === 0,
      ack.error);
  })),

  test('finish: the agent ends, the review closes with what it actually cost', () => withRig(async (r) => {
    const agent = await launch(r);
    const rev = r.hub.autonomy.improve.store.state().reviews[0]!;
    r.machine.report(agent.id, rev.id, [DRAFT], 'rep_1');
    await until(() => r.machine.acks.length === 1, 5_000, 'el recibo vuelve');

    r.machine.patch(agent.id, {
      state: 'done',
      metrics: { ...agent.metrics, costUSD: 0.37, inputTokens: 120_000, outputTokens: 14_000, cacheReadTokens: 6_000 },
    });
    await until(() => r.hub.autonomy.improve.store.state().reviews[0]!.endedAt !== undefined, 5_000, 'la revisión se cierra');

    const closed = r.hub.autonomy.improve.store.state().reviews[0]!;
    // Y el hueco queda libre: la siguiente revisión sale de verdad.
    const next = await launch(r, 2);
    return ok('reported, costed, and the slot is free again',
      closed.status === 'reported' && closed.costUSD === 0.37 && closed.tokens === 140_000
      && spawns(r).length === 2 && next.id === 'sess_reviewer_2',
      `${closed.status} · $${closed.costUSD} · ${closed.tokens}`);
  })),

  test('finish: an agent that dies without filing is a failure, not a review', () => withRig(async (r) => {
    const agent = await launch(r);
    r.machine.patch(agent.id, { state: 'dead' });
    await until(() => r.hub.autonomy.improve.store.state().reviews[0]!.endedAt !== undefined, 5_000, 'la revisión se cierra');
    const closed = r.hub.autonomy.improve.store.state().reviews[0]!;
    return ok('failed, and it says so instead of claiming a result',
      closed.status === 'failed' && (closed.note ?? '').includes('died before reporting')
      && closed.filed === 0,
      closed.note);
  })),

  test('one at a time: a second run while one is working is refused by name', () => withRig(async (r) => {
    const agent = await launch(r);
    const second = await r.console.ask({ t: 'improve:run' });
    return ok('the slot is taken and the refusal names who has it',
      second.ok === false && (second.detail ?? '').includes('R7')
      && spawns(r).length === 1,
      `${second.detail} · agent ${agent.callsign}`);
  })),

  test('cancel: a real stop goes out, and the slot is HELD until the fleet confirms', () => withRig(async (r) => {
    const agent = await launch(r);
    const out = await r.console.ask({ t: 'improve:cancel' });
    await until(() => r.machine.stops().includes(agent.id), 5_000, 'el stop llega a la máquina');
    const held = r.hub.autonomy.improve.store.state().reviews[0]!;

    // Con el agente todavía vivo, nadie lanza un segundo revisor.
    const second = await r.console.ask({ t: 'improve:run' });
    const heldSpawns = spawns(r).length;

    // El mundo confirma que se fue: ahí, y no antes, se libera.
    r.machine.patch(agent.id, { state: 'dead' });
    await until(() => r.hub.autonomy.improve.store.state().reviews[0]!.endedAt !== undefined, 5_000, 'la revisión se cierra');
    const closed = r.hub.autonomy.improve.store.state().reviews[0]!;
    await launch(r, 2);

    return ok('stop sent, slot held, and only then free',
      out.ok === true && (out.data as { holding?: boolean }).holding === true
      && held.status === 'cancelled' && held.cancelledAt !== undefined && held.endedAt === undefined
      && second.ok === false && heldSpawns === 1
      && closed.status === 'cancelled' && closed.endedAt !== undefined
      && spawns(r).length === 2,
      `${second.detail} · ${closed.note}`);
  })),

  test('a spawn the machine refuses closes the review instead of jamming it', () => withRig(async (r) => {
    const asked = r.console.ask({ t: 'improve:run' });
    await until(() => !!r.machine.spawn(), 5_000, 'el spawn llega');
    r.machine.refuse(r.machine.spawn()!.id, 'proyecto no confiado');
    const out = await asked;
    const rev = r.hub.autonomy.improve.store.state().reviews[0]!;
    await launch(r, 2);
    return ok('failed with the machine\'s own reason, and the next one goes',
      out.ok === false && (out.detail ?? '').includes('no confiado')
      && rev.status === 'failed' && (rev.note ?? '').includes('no confiado')
      && spawns(r).length === 2,
      rev.note);
  })),

  test('the board reaches every console on its own, with the reviewer in it', () => withRig(async (r) => {
    const agent = await launch(r);
    await until(() => r.console.pushed.some((f) => f.t === 'improve'), 5_000, 'el tablero se empuja');
    const last = [...r.console.pushed].reverse().find((f) => f.t === 'improve') as Extract<ServerFrame, { t: 'improve' }>;
    return ok('pushed, not polled, and it carries who is working',
      !!last && last.state.reviews[0]!.agentId === agent.id
      && last.verdict.due === false && last.verdict.reason.includes('REVIEWER IS WORKING'),
      last?.verdict.reason);
  })),
];

export default { suite: 'AUTOMEJORA · agente revisor', tests } satisfies TestModule;
