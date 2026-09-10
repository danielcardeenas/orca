/**
 * El diario de la flota (hub/journal.ts) y su herramienta MCP.
 *
 * Lo que vale la pena probar es lo que una sesión CAPCOM nueva va a leer:
 * que un lanzamiento y su fin quedan en disco con lo que importa, que los
 * filtros devuelven lo que dicen, que la rotación por tamaño no pierde ni
 * duplica entradas, que un snapshot repetido no anota dos veces el mismo
 * agente, y que las estadísticas cuadran con las entradas.
 *
 * Sin hub ni websockets: el diario se monta sobre un `AutonomyDeps` de
 * mentira con un `AgentLifecycle` real, que es exactamente lo que server.ts
 * le da.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentLifecycle } from '../src/hub/lifecycle.ts';
import type { AutonomyDeps } from '../src/hub/autonomy.ts';
import {
  Journal, createJournal, parseWhen, JOURNAL_FILE, BRIEFING_MAX_LINES,
  type JournalApi, type JournalEntry,
} from '../src/hub/journal.ts';
import { TOOLS, run, queryOf, compact, briefingLines } from '../src/agents/tools-journal.ts';
import { EXTENSION_TOOLS, duplicateToolNames } from '../src/agents/extensions.ts';
import { CEO_TOOLS, type CeoContext } from '../src/agents/tools.ts';
import type { Agent, Project } from '../src/shared/types.ts';
import type { CapcomMission } from '../src/shared/missions.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

/* ── un mundo de mentira ──────────────────────────────────────────── */

function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    machineId: 'm1', projectId: 'p_ax', title: 'worker', callsign: over.id.toUpperCase().slice(0, 2),
    runtime: 'claude', role: 'agent', origin: 'orca', state: 'working', block: null,
    parentId: null, depth: 0, childIds: [], mission: 'Do the thing. Done when tests pass.', squad: null, lead: false,
    model: 'claude-sonnet-5', tool: null, toolDetail: null, lastPrompt: null, lastSay: null,
    startedAt: 1_000, updatedAt: 1_000, uptimeMs: 0,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, tokensPerSec: 0,
      linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    background: true, shortId: null,
    ...over,
  };
}

interface Box {
  dir: string;
  deps: AutonomyDeps;
  lifecycle: AgentLifecycle;
  agents: Map<string, Agent>;
  missions: Record<string, CapcomMission>;
  clock: { now: number };
  timers: { fn: () => void; ms: number; cancelled: boolean }[];
  journal: JournalApi;
  ctx: CeoContext;
  close(): Promise<void>;
}

function box(env: Record<string, string> = {}): Box {
  const dir = mkdtempSync(join(tmpdir(), 'orca-journal-'));
  const lifecycle = new AgentLifecycle();
  const agents = new Map<string, Agent>();
  const missions: Record<string, CapcomMission> = {};
  const clock = { now: 10_000 };
  const timers: Box['timers'] = [];
  const projects: Project[] = [{ id: 'p_ax', code: 'AX', name: 'axolots' } as Project, { id: 'p_or', code: 'OR', name: 'orca' } as Project];
  const deps: AutonomyDeps = {
    agents: () => [...agents.values()],
    agent: (id) => agents.get(id),
    projects: () => projects,
    project: (id) => projects.find((p) => p.id === id),
    missions: () => structuredClone(missions),
    capcom: () => [...agents.values()].find((a) => a.role === 'capcom' && a.state !== 'done' && a.state !== 'dead') ?? null,
    sayToCapcom: () => 'delivered',
    dispatch: async () => ({}),
    stopAgent: async () => ({}),
    dir, env, now: () => clock.now,
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
    setInterval: () => ({ cancel() { /* nada */ } }),
    log: () => { /* silencio */ },
    note: () => { /* silencio */ },
    lifecycle,
  };
  const journal = createJournal(deps);
  const ctx = { autonomy: { journal } } as unknown as CeoContext;
  return {
    dir, deps, lifecycle, agents, missions, clock, timers, journal, ctx,
    async close() { journal.stop?.(); await journal.flush(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Un agente entra al mundo, como lo haría server.ts al recibir agent:new. */
function arrive(b: Box, a: Agent): void {
  b.agents.set(a.id, a);
  b.lifecycle.feed({ at: b.clock.now, kind: 'agent:new', machineId: a.machineId, agentId: a.id, projectId: a.projectId }, a);
}

function move(b: Box, id: string, to: Agent['state'], patch: Partial<Agent> = {}): void {
  const a = b.agents.get(id)!;
  const from = a.state;
  Object.assign(a, patch, { state: to, updatedAt: b.clock.now });
  b.lifecycle.feed({ at: b.clock.now, kind: 'agent:state', machineId: a.machineId, agentId: a.id, projectId: a.projectId, text: `${from} → ${to}`, data: { from, to } }, a);
}

function lines(dir: string): JournalEntry[] {
  const file = join(dir, 'journal', JOURNAL_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as JournalEntry);
}

/* ── las pruebas ──────────────────────────────────────────────────── */

const tests = [
  test('a launch and its end land on disk with who, what, and how much', async () => {
    const b = box();
    try {
      b.missions['task_1'] = { id: 'task_1', title: 'Ship it', status: 'active', createdAt: 0, updatedAt: 0, agentIds: ['w1'], messages: [] };
      arrive(b, agent({ id: 'cap', role: 'capcom', projectId: 'p_or', callsign: 'CAP' }));
      arrive(b, agent({ id: 'w1', parentId: 'cap', squad: 'ship-01', mission: 'Migrate the charges table. Done when the suite is green.' }));
      b.clock.now = 70_000;
      move(b, 'w1', 'done', {
        lastSay: 'Migration landed, 12 tests added.',
        metrics: { ...agent({ id: 'x' }).metrics, costUSD: 1.2345, inputTokens: 100, outputTokens: 50, linesAdded: 120, linesRemoved: 30, toolCalls: 9, turns: 4 },
      });
      await b.journal.flush();
      const all = lines(b.dir);
      const launch = all.find((e) => e.kind === 'launch');
      const end = all.find((e) => e.kind === 'end');
      return ok('launch + end persisted',
        all.length === 2
        && launch?.agentId === 'w1' && launch.by === 'capcom' && launch.project === 'AX' && launch.squad === 'ship-01'
        && launch.missionId === 'task_1' && launch.brief?.startsWith('Migrate the charges') === true
        && launch.runtime === 'claude' && launch.model === 'claude-sonnet-5' && launch.at === 1_000
        && end?.state === 'done' && end.costUSD === 1.2345 && end.durationMs === 69_000
        && end.tokens?.input === 100 && end.lines?.added === 120 && end.lines.removed === 30
        && end.lastSay === 'Migration landed, 12 tests added.' && end.missionId === 'task_1',
        JSON.stringify({ launch, end }));
    } finally { await b.close(); }
  }),

  test('who launched it: the hub hint wins, then the parent, then the human', async () => {
    const b = box();
    try {
      arrive(b, agent({ id: 'cap', role: 'capcom', projectId: 'p_or' }));
      b.journal.spawnRequested({ by: 'human', projectId: 'p_ax', mission: 'From the console. Done when done.', squad: null });
      arrive(b, agent({ id: 'h1', mission: 'From the console. Done when done.' }));
      arrive(b, agent({ id: 'c1', parentId: 'cap' }));
      arrive(b, agent({ id: 'a1', parentId: 'c1' }));
      arrive(b, agent({ id: 'x1', origin: 'external', mission: null }));
      await b.journal.flush();
      const by = Object.fromEntries(lines(b.dir).filter((e) => e.kind === 'launch').map((e) => [e.agentId, e.by]));
      return eq('launch attribution', by, { h1: 'human', c1: 'capcom', a1: 'agent', x1: 'human' });
    } finally { await b.close(); }
  }),

  test('a snapshot after a hub restart does not journal the same agent twice, but does record a missed end', async () => {
    const b = box();
    try {
      arrive(b, agent({ id: 'w1' }));
      await b.journal.flush();
      // El hub reinicia: el mismo directorio, un diario nuevo, y el collector
      // manda su snapshot con el agente ya terminado.
      b.journal.stop?.();
      const again = createJournal(b.deps);
      b.clock.now = 50_000;
      b.lifecycle.feed({ at: b.clock.now, kind: 'agent:new', machineId: 'm1', agentId: 'w1', projectId: 'p_ax' }, agent({ id: 'w1', state: 'dead', updatedAt: 40_000 }));
      b.lifecycle.feed({ at: b.clock.now, kind: 'agent:new', machineId: 'm1', agentId: 'w1', projectId: 'p_ax' }, agent({ id: 'w1', state: 'dead', updatedAt: 40_000 }));
      await again.flush();
      again.stop?.();
      const all = lines(b.dir);
      return ok('one launch, one late end',
        all.filter((e) => e.kind === 'launch').length === 1
        && all.filter((e) => e.kind === 'end').length === 1
        && all.find((e) => e.kind === 'end')?.late === true
        && all.find((e) => e.kind === 'end')?.at === 40_000,
        all.map((e) => `${e.kind}@${e.at}`).join(' '));
    } finally { await b.close(); }
  }),

  test('an agent that resumes after done gets a second end; idle and blocked are not ends', async () => {
    const b = box();
    try {
      arrive(b, agent({ id: 'w1' }));
      move(b, 'w1', 'idle');
      move(b, 'w1', 'blocked');
      move(b, 'w1', 'done');
      move(b, 'w1', 'done');          // un frame repetido
      move(b, 'w1', 'working');       // resume
      b.clock.now = 90_000;
      move(b, 'w1', 'dead');
      await b.journal.flush();
      const ends = lines(b.dir).filter((e) => e.kind === 'end').map((e) => e.state);
      return eq('ends', ends, ['done', 'dead']);
    } finally { await b.close(); }
  }),

  test('the sweep journals agents a snapshot brought in silently, and ends the snapshot declared dead', async () => {
    const b = box();
    try {
      // Un snapshot: agentes en el mundo, ningún evento.
      b.agents.set('s1', agent({ id: 's1' }));
      b.agents.set('s2', agent({ id: 's2', state: 'done', updatedAt: 5_000, lastSay: 'all green' }));
      b.agents.set('cap', agent({ id: 'cap', role: 'capcom', projectId: 'p_or' }));
      b.agents.set('sub', agent({ id: 'sub', subagent: true }));
      const wrote = b.journal.sweep();
      const again = b.journal.sweep();
      // El snapshot siguiente ya no trae a s1: el mundo lo da por muerto sin evento.
      b.clock.now = 30_000;
      b.agents.get('s1')!.state = 'dead';
      b.agents.get('s1')!.updatedAt = 30_000;
      const third = b.journal.sweep();
      await b.journal.flush();
      const all = lines(b.dir);
      return ok('sweep',
        wrote === 3 && again === 0 && third === 1
        && all.filter((e) => e.kind === 'launch').map((e) => e.agentId).sort().join() === 's1,s2'
        && all.filter((e) => e.kind === 'end').every((e) => e.late === true)
        && all.find((e) => e.kind === 'end' && e.agentId === 's2')?.lastSay === 'all green'
        && all.find((e) => e.kind === 'end' && e.agentId === 's1')?.state === 'dead'
        && !all.some((e) => e.agentId === 'sub' || e.agentId === 'cap'),
        `${wrote}/${again}/${third} ` + all.map((e) => `${e.kind}:${e.agentId}`).join(' '));
    } finally { await b.close(); }
  }),

  test('escalations record who asked, who answered, what they said, and how long it took', async () => {
    const b = box();
    try {
      arrive(b, agent({ id: 'w1', mission: 'Deploy staging. Done when it answers 200.' }));
      b.lifecycle.feed({ at: 20_000, kind: 'escalation:new', machineId: 'm1', agentId: 'w1', projectId: 'p_ax', text: 'Test key or prod key?', data: { id: 'esc_1', urgency: 'blocking', options: ['test', 'prod'] } }, b.agents.get('w1'));
      b.lifecycle.feed({ at: 35_000, kind: 'escalation:answered', machineId: 'm1', agentId: 'w1', projectId: 'p_ax', text: 'Test key or prod key?', data: { answer: 'test', by: 'ceo', rememberAs: null } }, b.agents.get('w1'));
      // Una segunda, contestada por el humano y con id en la respuesta.
      b.lifecycle.feed({ at: 40_000, kind: 'escalation:new', machineId: 'm1', agentId: 'w1', projectId: 'p_ax', text: 'Delete the legacy branch?', data: { id: 'esc_2', urgency: 'normal', options: [] } }, b.agents.get('w1'));
      b.lifecycle.feed({ at: 41_000, kind: 'escalation:answered', machineId: 'm1', agentId: 'w1', projectId: 'p_ax', text: 'Delete the legacy branch?', data: { id: 'esc_2', answer: 'no', by: 'human', rememberAs: 'never delete branches' } }, b.agents.get('w1'));
      await b.journal.flush();
      const answers = lines(b.dir).filter((e) => e.kind === 'answer');
      const asked = lines(b.dir).filter((e) => e.kind === 'escalation');
      return ok('two escalations, two answers',
        asked.length === 2 && asked[0]?.escalationId === 'esc_1' && asked[0].urgency === 'blocking' && asked[0].options?.length === 2
        && answers.length === 2
        && answers[0]?.escalationId === 'esc_1' && answers[0].answeredBy === 'capcom' && answers[0].answer === 'test' && answers[0].waitedMs === 15_000
        && answers[1]?.escalationId === 'esc_2' && answers[1].answeredBy === 'human' && answers[1].rememberAs === 'never delete branches' && answers[1].waitedMs === 1_000,
        JSON.stringify({ asked, answers }));
    } finally { await b.close(); }
  }),

  test('a CAPCOM rotation is one entry: the hub hint carries the numbers, the new session closes it', async () => {
    const b = box();
    try {
      arrive(b, agent({ id: 'cap1', role: 'capcom', projectId: 'p_or' }));
      b.journal.rotated({ fromId: 'cap1', machineId: 'm1', turns: 300, compactions: 2, contextTokens: 150_000 });
      b.clock.now = 30_000;
      arrive(b, agent({ id: 'cap2', role: 'capcom', projectId: 'p_or' }));
      // Sin gancho: un tercer CAPCOM aparece mientras se conocía el segundo.
      b.clock.now = 60_000;
      arrive(b, agent({ id: 'cap3', role: 'capcom', projectId: 'p_or' }));
      await b.journal.flush();
      const rot = lines(b.dir).filter((e) => e.kind === 'rotation');
      return ok('two rotations',
        rot.length === 2
        && rot[0]?.fromId === 'cap1' && rot[0].toId === 'cap2' && rot[0].turns === 300 && rot[0].compactions === 2 && rot[0].contextTokens === 150_000
        && rot[1]?.fromId === 'cap2' && rot[1].toId === 'cap3' && rot[1].note?.startsWith('inferred') === true
        && b.timers[0]?.cancelled === true
        && lines(b.dir).filter((e) => e.kind === 'launch').length === 0,
        JSON.stringify(rot));
    } finally { await b.close(); }
  }),

  test('a rotation whose new CAPCOM never shows is written when the hold expires', async () => {
    const b = box();
    try {
      b.journal.rotated({ fromId: 'cap1', turns: 10, compactions: 1 });
      b.clock.now = 200_000;
      b.timers[0]!.fn();
      await b.journal.flush();
      const rot = lines(b.dir).filter((e) => e.kind === 'rotation');
      return ok('rotation without destination', rot.length === 1 && rot[0]?.fromId === 'cap1' && rot[0].toId === null && rot[0].note !== null, JSON.stringify(rot));
    } finally { await b.close(); }
  }),

  test('query filters: project by code, squad, mission, agent by callsign, kind, state, by, window, text, order, limit', async () => {
    const b = box();
    try {
      b.missions['task_9'] = { id: 'task_9', title: 't', status: 'active', createdAt: 0, updatedAt: 0, agentIds: ['w2'], messages: [] };
      arrive(b, agent({ id: 'cap', role: 'capcom', projectId: 'p_or' }));
      arrive(b, agent({ id: 'w1', callsign: 'K9', mission: 'Refactor the payments módulo. Done when green.' }));
      arrive(b, agent({ id: 'w2', callsign: 'Q2', projectId: 'p_or', squad: 'audit-01', parentId: 'cap', mission: 'Audit deps.' }));
      b.clock.now = 20_000; move(b, 'w1', 'done', { lastSay: 'Payments refactored.' });
      b.clock.now = 30_000; move(b, 'w2', 'dead', { lastSay: 'Crashed on npm audit.' });
      await b.journal.flush();
      const j = b.journal;
      const kinds = (es: JournalEntry[]) => es.map((e) => `${e.kind}:${e.agentId}`);
      const checks: [string, boolean, string][] = [
        ['project by code, any case', j.query({ project: 'ax' }).every((e) => e.projectId === 'p_ax') && j.query({ project: 'ax' }).length === 2, ''],
        ['project by id', j.query({ project: 'p_or' }).length === 2, kinds(j.query({ project: 'p_or' })).join(' ')],
        ['squad', kinds(j.query({ squad: 'audit-01', order: 'asc' })).join(' ') === 'launch:w2 end:w2', kinds(j.query({ squad: 'audit-01' })).join(' ')],
        ['mission', j.query({ missionId: 'task_9' }).length === 2, ''],
        ['agent by callsign', j.query({ agent: 'k9' }).length === 2 && j.query({ agent: 'w2' }).length === 2, ''],
        ['kind', kinds(j.query({ kind: 'end', order: 'asc' })).join(' ') === 'end:w1 end:w2', ''],
        ['state dead', kinds(j.query({ state: 'dead' })).join(' ') === 'end:w2', ''],
        ['by capcom', kinds(j.query({ by: 'capcom' })).join(' ') === 'launch:w2', ''],
        ['window', j.query({ since: 25_000 }).length === 1 && j.query({ until: 1_500 }).length === 2, `${j.query({ since: 25_000 }).length} / ${j.query({ until: 1_500 }).length}`],
        ['text, accents ignored', kinds(j.query({ text: 'payments modulo' })).join(' ') === 'launch:w1' && kinds(j.query({ text: 'NPM AUDIT' })).join(' ') === 'end:w2', kinds(j.query({ text: 'payments modulo' })).join(' ')],
        ['newest first by default', j.query()[0]?.kind === 'end' && j.query()[0]?.agentId === 'w2', ''],
        ['limit', j.query({ limit: 1 }).length === 1, ''],
      ];
      const failed = checks.filter((c) => !c[1]);
      return ok('filters', failed.length === 0, failed.map((c) => `${c[0]} ${c[2]}`).join('; '));
    } finally { await b.close(); }
  }),

  test('stats: cost and duration per project, done rate, who answered, and the briefs that escalated', async () => {
    const b = box();
    try {
      arrive(b, agent({ id: 'w1', mission: 'Ship payments. Done when green.' }));
      arrive(b, agent({ id: 'w2', mission: 'Ship refunds. Done when green.' }));
      arrive(b, agent({ id: 'w3', projectId: 'p_or', mission: 'Audit orca. Done when listed.' }));
      b.lifecycle.feed({ at: 15_000, kind: 'escalation:new', machineId: 'm1', agentId: 'w2', projectId: 'p_ax', text: 'Refund to card or wallet?', data: { id: 'esc_1', urgency: 'normal', options: [] } }, b.agents.get('w2'));
      b.lifecycle.feed({ at: 16_000, kind: 'escalation:answered', machineId: 'm1', agentId: 'w2', projectId: 'p_ax', text: 'Refund to card or wallet?', data: { answer: 'card', by: 'human' } }, b.agents.get('w2'));
      b.lifecycle.feed({ at: 17_000, kind: 'escalation:new', machineId: 'm1', agentId: 'w3', projectId: 'p_or', text: 'Which registry?', data: { id: 'esc_2', urgency: 'low', options: [] } }, b.agents.get('w3'));
      b.clock.now = 21_000; move(b, 'w1', 'done', { metrics: { ...agent({ id: 'x' }).metrics, costUSD: 2 } });
      b.clock.now = 41_000; move(b, 'w2', 'dead', { metrics: { ...agent({ id: 'x' }).metrics, costUSD: 4 } });
      b.clock.now = 11_000; move(b, 'w3', 'done', { metrics: { ...agent({ id: 'x' }).metrics, costUSD: 1 } });
      b.journal.landed({ agentId: 'w1', branch: 'orca/w1', target: 'main', commit: 'abc123', ok: true });
      b.journal.landed({ agentId: 'w2', branch: 'orca/w2', target: 'main', ok: false, detail: 'conflict in charges.ts' });
      await b.journal.flush();
      const s = b.journal.stats();
      const ax = s.byProject.find((p) => p.project === 'AX');
      const or = s.byProject.find((p) => p.project === 'OR');
      return ok('stats add up',
        s.launches === 3 && s.byLauncher.human === 3
        && s.ends.done === 2 && s.ends.dead === 1 && s.doneRate === 0.6667
        && s.cost.totalUSD === 7 && s.cost.avgUSD === 2.3333
        && s.duration.avgMs === Math.round((20_000 + 40_000 + 10_000) / 3)
        && ax?.launches === 2 && ax.done === 1 && ax.dead === 1 && ax.doneRate === 0.5 && ax.totalCostUSD === 6 && ax.avgCostUSD === 3 && ax.avgDurationMs === 30_000 && ax.escalations === 1
        && or?.launches === 1 && or.avgCostUSD === 1 && or.escalations === 1
        && s.escalations.asked === 2 && s.escalations.answeredByHuman === 1 && s.escalations.answeredByCapcom === 0 && s.escalations.unanswered === 1 && s.escalations.avgWaitMs === 1_000
        && s.escalatedBriefs.length === 2
        && s.escalatedBriefs.some((e) => e.agentId === 'w2' && e.brief === 'Ship refunds. Done when green.' && e.answeredBy === 'human' && e.state === 'dead')
        && s.escalatedBriefs.some((e) => e.agentId === 'w3' && e.answeredBy === null && e.state === 'done')
        && s.landings.ok === 1 && s.landings.failed === 1,
        JSON.stringify(s));
    } finally { await b.close(); }
  }),

  test('the file rotates by size, keeps the newest N, and a query still reads across files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-journal-rot-'));
    try {
      let now = 1_000;
      const j = new Journal({ dir, maxBytes: 64 * 1024, keep: 2, now: () => now });
      const brief = 'x'.repeat(2_000);
      const total = 200;
      for (let i = 0; i < total; i += 1) {
        now += 1_000;
        j.append({ kind: 'launch', agentId: `a${i}`, callsign: null, machineId: null, projectId: 'p', project: 'P', squad: null, missionId: null, brief, by: 'human' });
      }
      await j.flush();
      const names = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort();
      const rotated = names.filter((n) => n !== JOURNAL_FILE);
      const kept = j.query({ limit: 500, order: 'asc' });
      const ids = kept.map((e) => e.agentId);
      // Lo que queda es un sufijo contiguo de lo escrito: se pierden ficheros
      // enteros por el principio, nunca líneas sueltas ni el final.
      const contiguous = ids.every((id, i) => i === 0 || Number(id!.slice(1)) === Number(ids[i - 1]!.slice(1)) + 1);
      return ok('rotated by size',
        rotated.length === 2 && names.includes(JOURNAL_FILE)
        && kept.length < total && kept.length > 60 && contiguous && ids.at(-1) === `a${total - 1}`
        && j.files().length === 3 && j.files().at(-1)?.endsWith(JOURNAL_FILE) === true,
        `${names.join(', ')} · kept ${kept.length}/${total}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('a reopened journal knows which agents it already has, and skips a half-written line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-journal-reopen-'));
    try {
      const j = new Journal({ dir });
      j.append({ kind: 'launch', agentId: 'a1', callsign: null, machineId: null, projectId: null, project: null, squad: null, missionId: null });
      j.append({ kind: 'end', agentId: 'a1', callsign: null, machineId: null, projectId: null, project: null, squad: null, missionId: null, state: 'done' });
      await j.flush();
      const { appendFileSync } = await import('node:fs');
      appendFileSync(join(dir, JOURNAL_FILE), '{"id":"jr_x","at":5,"kind":"lau');
      const again = new Journal({ dir });
      return ok('index rebuilt', again.hasLaunch('a1') && again.hasEnd('a1') && !again.hasLaunch('a2') && again.query().length === 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('briefingLines: what ended since the last briefing, capped, and the mark moves', async () => {
    const b = box();
    try {
      for (let i = 0; i < BRIEFING_MAX_LINES + 3; i += 1) {
        arrive(b, agent({ id: `w${i}`, callsign: `W${i}` }));
        b.clock.now += 1_000;
        move(b, `w${i}`, 'done', { lastSay: `finished ${i}`, metrics: { ...agent({ id: 'x' }).metrics, costUSD: 0.5 } });
      }
      await b.journal.flush();
      const first = briefingLines(b.ctx, b.clock.now);
      const second = briefingLines(b.ctx, b.clock.now);
      b.clock.now += 5_000;
      arrive(b, agent({ id: 'late', callsign: 'LT' }));
      move(b, 'late', 'dead', { lastSay: 'oops' });
      b.journal.landed({ agentId: 'late', branch: 'orca/late', target: 'main', ok: false, detail: 'tests red' });
      await b.journal.flush();
      const third = briefingLines(b.ctx, b.clock.now);
      return ok('briefing section',
        first.length === BRIEFING_MAX_LINES + 1 && first[0]!.startsWith('… 3 more') && first.at(-1)!.includes('finished 10') && first[1]!.includes('$0.50')
        && second.length === 0
        && third.length === 2 && third[0]!.startsWith('LT [AX] dead') && third[1]!.includes('FAILED to land') && third[1]!.includes('tests red')
        && existsSync(join(b.dir, 'journal', 'state.json')),
        JSON.stringify({ first, second, third }));
    } finally { await b.close(); }
  }),

  test('the MCP tools: journal answers with compact entries, journal_stats with the summary, bad input is refused', async () => {
    const b = box();
    try {
      arrive(b, agent({ id: 'w1', callsign: 'K9', mission: 'A'.repeat(500) }));
      b.clock.now = 20_000; move(b, 'w1', 'done', { lastSay: 'B'.repeat(500) });
      await b.journal.flush();
      const out = run(b.ctx, 'journal', { project: 'AX', squad: null, mission_id: null, agent: null, kind: null, since: null, until: null, state: null, by: null, text: null, limit: null, newest_first: true, full: false })!;
      const r = JSON.parse(out.result) as { count: number; entries: JournalEntry[] };
      const full = run(b.ctx, 'journal', { project: null, squad: null, mission_id: null, agent: 'K9', kind: 'launch', since: null, until: null, state: null, by: null, text: null, limit: null, newest_first: false, full: true })!;
      const rf = JSON.parse(full.result) as { entries: JournalEntry[] };
      const stats = run(b.ctx, 'journal_stats', { project: null, squad: null, since: null, until: null })!;
      const bad = run(b.ctx, 'journal', { project: null, squad: null, mission_id: null, agent: null, kind: null, since: 'yesterday-ish', until: null, state: null, by: null, text: null, limit: null, newest_first: true, full: false })!;
      const badKind = run(b.ctx, 'journal', { project: null, squad: null, mission_id: null, agent: null, kind: 'launches', since: null, until: null, state: null, by: null, text: null, limit: null, newest_first: true, full: false })!;
      const notMine = run(b.ctx, 'list_fleet', {});
      const noJournal = run({} as CeoContext, 'journal', {})!;
      return ok('tools',
        out.isError !== true && r.count === 2 && r.entries[0]!.kind === 'end' && r.entries[0]!.lastSay!.length === 200 && r.entries[1]!.brief!.length === 200
        && out.summary.includes('2 entries')
        && rf.entries.length === 1 && rf.entries[0]!.brief!.length === 500
        && stats.isError !== true && stats.summary.includes('1 launch(es), 1 done / 0 dead (100% done)')
        && bad.isError === true && bad.result.includes('since=')
        && badKind.isError === true && badKind.result.includes('unknown kind')
        && notMine === null
        && noJournal.isError === true,
        JSON.stringify({ summary: out.summary, stats: stats.summary, bad: bad.result, badKind: badKind.result }));
    } finally { await b.close(); }
  }),

  test('tool names do not collide with CEO_TOOLS, and every schema lists every property as required (strict)', () => {
    // CEO_TOOLS ya lleva las extensiones dentro: la base son las que no lo son.
    const dupes = duplicateToolNames(CEO_TOOLS.filter((t) => !EXTENSION_TOOLS.some((x) => x.name === t.name)));
    const strict = TOOLS.every((t) => {
      const schema = t.input_schema as { properties: Record<string, unknown>; required: string[] };
      return t.strict === true && Object.keys(schema.properties).every((k) => schema.required.includes(k));
    });
    return ok('registered cleanly', dupes.length === 0 && strict && TOOLS.map((t) => t.name).join(',') === 'journal,journal_stats', dupes.join(','));
  }),

  test('parseWhen and queryOf read windows the way a person writes them', () => {
    const now = 1_000_000_000_000;
    const q = queryOf({ since: '2d', until: '1h', limit: 7, newest_first: false, kind: 'end', state: 'dead', by: 'agent', text: ' x ' }, now);
    return ok('windows',
      parseWhen('24h', now) === now - 86_400_000 && parseWhen('90m', now) === now - 5_400_000 && parseWhen('1w', now) === now - 7 * 86_400_000
      && parseWhen('2026-09-06T00:00:00Z') === Date.parse('2026-09-06T00:00:00Z') && parseWhen('1700000000000') === 1_700_000_000_000
      && parseWhen('soon') === null && parseWhen(null) === null && parseWhen(42) === 42
      && !('error' in q) && q.since === now - 2 * 86_400_000 && q.until === now - 3_600_000 && q.limit === 7 && q.order === 'asc'
      && q.kind === 'end' && q.state === 'dead' && q.by === 'agent' && q.text === 'x'
      && 'error' in queryOf({ limit: 0 }) && 'error' in queryOf({ state: 'idle' }) && 'error' in queryOf({ by: 'ceo' })
      && compact({ id: 'a', at: 1, kind: 'launch', brief: 'y'.repeat(300) } as JournalEntry).brief!.length === 200,
      JSON.stringify(q));
  }),
];

/* ── el CLI, de punta a punta ─────────────────────────────────────── */

/**
 * `orca journal` contra un hub real y la flota falsa: lo que vale probar es
 * que el subcomando llega a la herramienta con los filtros traducidos, que
 * imprime una línea por entrada, y que `--stats` y `--json` hacen lo que dicen.
 */
async function cliRun(port: number, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { execFile } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const bin = resolve(import.meta.dirname, '..', 'bin', 'orca.mjs');
  return new Promise((done) => {
    execFile('node', [bin, ...args, '--hub', `http://127.0.0.1:${port}`, '--token', 'test-token-journal'], {
      encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, ORCA_TOKEN: '', ORCA_HOME: join(tmpdir(), 'orca-journal-nohome') },
    }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number | string }).code as number | undefined ?? -1) : 0;
      done({ code: typeof code === 'number' ? code : -1, stdout, stderr });
    });
  });
}

tests.push(test('orca journal: one line per entry, --stats, --json, and a window the hub cannot read is exit 3', async () => {
  const { startHub } = await import('../src/hub/server.ts');
  const { createAuth } = await import('../src/hub/auth.ts');
  const { HubStore } = await import('../src/hub/persist.ts');
  const { AnswerMemory } = await import('../src/hub/memory.ts');
  const { FleetStore } = await import('../src/hub/fleets.ts');
  const { startFakeFleet } = await import('./fake-collector.ts');
  const { until } = await import('./harness.ts');
  const dir = mkdtempSync(join(tmpdir(), 'orca-journal-cli-'));
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: 'test-token-journal' } as NodeJS.ProcessEnv),
    store: new HubStore({ dir: join(dir, 'hub') }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
    fleets: new FleetStore(join(dir, 'fleets')),
  });
  const fleet = startFakeFleet({ hub: `ws://127.0.0.1:${hub.port}`, token: 'test-token-journal', quiet: true, speed: 6 });
  try {
    // La flota falsa entra por snapshot: es el barrido el que la anota.
    const ready = await until(() => { hub.autonomy.journal.sweep(); return hub.autonomy.journal.query({ kind: 'launch' }).length >= 3; }, 8000, 100);
    if (!ready) throw new Error('the fake fleet never produced three launches');
    await hub.autonomy.journal.flush();
    const plain = await cliRun(hub.port, ['journal', '--kind', 'launch', '--limit', '3']);
    const asJson = await cliRun(hub.port, ['journal', '--json', '--limit', '2', '--asc']);
    const parsed = JSON.parse(asJson.stdout) as { ok: boolean; result: { count: number; entries: JournalEntry[] } };
    const stats = await cliRun(hub.port, ['journal', '--stats']);
    const bad = await cliRun(hub.port, ['journal', '--since', 'whenever']);
    const none = await cliRun(hub.port, ['journal', '--text', 'zzzz-nothing-says-this-zzzz']);
    return ok('orca journal',
      plain.code === 0 && plain.stdout.trim().split('\n').length === 3 && plain.stdout.split('\n').every((l) => !l || /^\d{2}-\d{2} \d{2}:\d{2}  launch/.test(l))
      && asJson.code === 0 && parsed.ok && parsed.result.count === 2 && parsed.result.entries[0]!.at <= parsed.result.entries[1]!.at
      && stats.code === 0 && stats.stdout.startsWith('launches ') && stats.stdout.includes('project ')
      && bad.code === 3 && bad.stderr.includes('since=')
      && none.code === 0 && none.stdout.includes('nothing matches'),
      JSON.stringify({ plain: plain.stdout.slice(0, 300), stats: stats.stdout.slice(0, 200), bad: bad.stderr.slice(0, 120), none: none.stdout }));
  } finally {
    fleet.stop();
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}));

export default { suite: 'Fleet journal', tests } satisfies TestModule;
