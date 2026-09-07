/**
 * Presupuestos por worker, escuadrón y tarea.
 *
 * Lo que se comprueba es la política, no la fontanería: que el 80 % avisa una
 * vez, que el 100 % con progreso reciente NO para, que el 100 % sin progreso
 * sí para (y sólo con ORCA_BUDGET_ACTION=stop), que los defaults del entorno
 * alcanzan a quien no tiene techo propio, y que el techo de un escuadrón se
 * reparte entre sus miembros. Todo con un reloj en una variable y una flota
 * en un objeto; el hub de verdad se prueba al final, en un puerto libre, para
 * ver que el aviso llega a CAPCOM por su canal y al feed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BudgetBook, budgetConfig, budgetLimit, type BudgetEvent } from '../src/hub/budgets.ts';
import { startHub } from '../src/hub/server.ts';
import { createAuth } from '../src/hub/auth.ts';
import { HubStore } from '../src/hub/persist.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { FleetStore } from '../src/hub/fleets.ts';
import { hubContext } from '../src/agents/context.ts';
import { runTool } from '../src/agents/tools.ts';
import { emptyRollup, type Agent, type AgentMetrics, type Project } from '../src/shared/types.ts';
import type { CapcomTask } from '../src/shared/tasks.ts';
import { eq, ok, test, until, type TestModule, type TestResult } from './harness.ts';

const T0 = 1_700_000_000_000;

type Fixture = Omit<Partial<Agent>, 'metrics'> & { id: string; metrics?: Partial<AgentMetrics> };

function agent(over: Fixture): Agent {
  return {
    machineId: 'm1', projectId: 'p1',
    title: over.id, callsign: over.id.toUpperCase(), runtime: 'claude',
    state: 'working', block: null,
    parentId: null, depth: 0, childIds: [], mission: null,
    squad: null, lead: false,
    model: null, tool: null, toolDetail: null, lastPrompt: null, lastSay: null,
    startedAt: T0, updatedAt: T0, uptimeMs: 0,
    background: true, shortId: null,
    ...over,
    metrics: { ...emptyMetrics(), ...(over.metrics ?? {}) },
  } as Agent;
}

function emptyMetrics(): Agent['metrics'] {
  return {
    costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
    tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0,
    toolDurationMs: 0, apiDurationMs: 0, turns: 0,
  };
}

function book(env: Record<string, string> = {}, now: () => number): BudgetBook {
  return new BudgetBook(null, budgetConfig(env as NodeJS.ProcessEnv), { now });
}

function kinds(events: BudgetEvent[]): string[] { return events.map((e) => e.kind); }

/* ── 1 · umbrales ─────────────────────────────────────────────────── */

const thresholds = test('80 % avisa una vez, 100 % avisa una vez, y en medio no repite', () => {
  let now = T0;
  const b = book({}, () => now);
  b.set({ kind: 'agent', ref: 'k9' }, { usd: 10, min: null });
  const fleet = { k9: agent({ id: 'k9', metrics: { costUSD: 5 } }) };

  const quiet = b.tick(fleet, {}, now);
  fleet.k9.metrics.costUSD = 8.5;
  const warn = b.tick(fleet, {}, (now += 1000));
  const again = b.tick(fleet, {}, (now += 1000));
  fleet.k9.metrics.toolCalls = 3;          // progresa: al 100 % sólo avisa
  fleet.k9.metrics.costUSD = 10.2;
  const over = b.tick(fleet, {}, (now += 1000));
  const overAgain = b.tick(fleet, {}, (now += 1000));

  const results = [
    eq('bajo el 80 %: nada', kinds(quiet), []),
    eq('al 80 %: un warn', kinds(warn), ['warn']),
    ok('el warn lleva el prefijo y las cifras', /^\[BUDGET 80%\] K9 · \$8\.50 of \$10\.00 \(85%\)$/.test(warn[0]!.text), warn[0]?.text),
    eq('el mismo tick después: silencio', kinds(again), []),
    eq('al 100 % con progreso: over, sin stop', kinds(over), ['over']),
    ok('el over dice que sigue avanzando y no se paró', over[0]!.text.startsWith('[BUDGET 100%] K9') && over[0]!.text.includes('not stopped'), over[0]?.text),
    eq('y tampoco se repite', kinds(overAgain), []),
  ];
  return results.find((r) => !r.pass) ?? ok('umbrales', true, `${results.length} checks`);
});

/* ── 2 · el progreso reciente evita la parada ─────────────────────── */

const progressSpares = test('al 100 % sin progreso se para; con progreso reciente no', () => {
  let now = T0;
  const b = book({ ORCA_BUDGET_PROGRESS_MIN: '3' }, () => now);
  b.set({ kind: 'agent', ref: 'k9' }, { usd: 1, min: null });
  b.set({ kind: 'agent', ref: 'l2' }, { usd: 1, min: null });
  const fleet = {
    k9: agent({ id: 'k9', metrics: { costUSD: 0.5, toolCalls: 1 } }),
    l2: agent({ id: 'l2', metrics: { costUSD: 0.5, toolCalls: 1 } }),
  };
  b.tick(fleet, {}, now);
  // Cuatro minutos después: k9 hizo llamadas, l2 no; ambos se pasan.
  now += 4 * 60_000;
  fleet.k9.metrics.toolCalls = 7;
  fleet.k9.metrics.costUSD = 1.1;
  fleet.l2.metrics.costUSD = 1.1;
  const ev = b.tick(fleet, {}, now);
  const stops = ev.filter((e) => e.kind === 'stop');
  const r1 = eq('un solo stop', stops.map((e) => e.kind === 'stop' ? e.agentId : ''), ['l2']);
  if (!r1.pass) return r1;
  const stop = stops[0] as Extract<BudgetEvent, { kind: 'stop' }>;
  const r2 = ok('el stop explica el motivo', stop.reason.includes('over budget') && stop.reason.includes('no tool calls or edits'), stop.reason);
  if (!r2.pass) return r2;
  const r3 = ok('el stop no se pide dos veces', kinds(b.tick(fleet, {}, now + 1000)).every((k) => k !== 'stop'));
  if (!r3.pass) return r3;
  // k9 se calla: tres minutos y un segundo después, también cae.
  now += 3 * 60_000 + 1000;
  const later = b.tick(fleet, {}, now);
  return eq('el que dejó de progresar cae después', later.filter((e) => e.kind === 'stop').map((e) => (e as { agentId: string }).agentId), ['k9']);
});

const linesCountAsProgress = test('las líneas cambiadas cuentan como progreso, igual que las tool calls', () => {
  let now = T0;
  const b = book({ ORCA_BUDGET_PROGRESS_MIN: '1' }, () => now);
  b.set({ kind: 'agent', ref: 'k9' }, { usd: 1, min: null });
  const fleet = { k9: agent({ id: 'k9', metrics: { costUSD: 0.2 } }) };
  b.tick(fleet, {}, now);
  now += 5 * 60_000;
  fleet.k9.metrics.linesAdded = 12;
  fleet.k9.metrics.costUSD = 2;
  return eq('over sin stop', kinds(b.tick(fleet, {}, now)), ['over']);
});

/* ── 3 · ORCA_BUDGET_ACTION ───────────────────────────────────────── */

const actionWarn = test('ORCA_BUDGET_ACTION=warn nunca para, sólo avisa', () => {
  let now = T0;
  const b = book({ ORCA_BUDGET_ACTION: 'warn', ORCA_BUDGET_PROGRESS_MIN: '1' }, () => now);
  b.set({ kind: 'agent', ref: 'k9' }, { usd: 1, min: null });
  const fleet = { k9: agent({ id: 'k9', metrics: { costUSD: 0.1 } }) };
  b.tick(fleet, {}, now);
  now += 10 * 60_000;
  fleet.k9.metrics.costUSD = 5;
  const ev = b.tick(fleet, {}, now);
  const r = eq('sólo over', kinds(ev), ['over']);
  if (!r.pass) return r;
  return ok('y lo dice', ev[0]!.text.includes('ORCA_BUDGET_ACTION=warn'), ev[0]?.text);
});

/* ── 4 · tiempo ───────────────────────────────────────────────────── */

const timeBudget = test('budget_min mide tiempo de pared desde el arranque', () => {
  let now = T0;
  const b = book({}, () => now);
  b.set({ kind: 'agent', ref: 'k9' }, { usd: null, min: 10 });
  const fleet = { k9: agent({ id: 'k9', metrics: { toolCalls: 1 } }) };
  b.tick(fleet, {}, now);
  now = T0 + 8 * 60_000 + 1000;
  const warn = b.tick(fleet, {}, now);
  const r = eq('al 80 % del tiempo avisa', kinds(warn), ['warn']);
  if (!r.pass) return r;
  return ok('con minutos en el texto', /8m of 10m \(80%\)/.test(warn[0]!.text), warn[0]?.text);
});

/* ── 5 · defaults por entorno ─────────────────────────────────────── */

const envDefaults = test('ORCA_DEFAULT_BUDGET_USD alcanza a quien no tiene techo propio, y no a CAPCOM', () => {
  let now = T0;
  const b = book({ ORCA_DEFAULT_BUDGET_USD: '2' }, () => now);
  b.set({ kind: 'agent', ref: 'own' }, { usd: 100, min: null });
  const fleet = {
    k9: agent({ id: 'k9', metrics: { costUSD: 1.7 } }),
    own: agent({ id: 'own', metrics: { costUSD: 1.7 } }),
    cap: agent({ id: 'cap', role: 'capcom', metrics: { costUSD: 50 } }),
  };
  const ev = b.tick(fleet, {}, (now += 1000));
  const r = eq('avisa sólo del que va por defecto', ev.map((e) => `${e.kind}:${e.scope.ref}`), ['warn:k9']);
  if (!r.pass) return r;
  const st = b.agentStatus(fleet.k9, fleet, {}, now);
  const r2 = eq('inspect lo ve como techo por defecto', st.lines.map((l) => l.scope), ['default']);
  if (!r2.pass) return r2;
  return eq('vacío = sin límite', budgetConfig({ ORCA_DEFAULT_BUDGET_USD: '', ORCA_DEFAULT_BUDGET_MIN: ' ' } as NodeJS.ProcessEnv).defaultUsd, null);
});

/* ── 6 · presupuesto de escuadrón compartido ──────────────────────── */

const squadShared = test('el techo de un escuadrón es la suma de sus miembros, y para sólo a los parados', () => {
  let now = T0;
  const b = book({ ORCA_BUDGET_PROGRESS_MIN: '2' }, () => now);
  b.set({ kind: 'squad', ref: 'audit-01' }, { usd: 10, min: null });
  const fleet = {
    lead: agent({ id: 'lead', squad: 'audit-01', lead: true, metrics: { costUSD: 3, toolCalls: 1 } }),
    m1: agent({ id: 'm1', squad: 'audit-01', metrics: { costUSD: 3, toolCalls: 1 } }),
    m2: agent({ id: 'm2', squad: 'audit-01', metrics: { costUSD: 2, toolCalls: 1 } }),
    other: agent({ id: 'other', squad: 'build-01', metrics: { costUSD: 50 } }),
  };
  const warn = b.tick(fleet, {}, now);
  const r1 = eq('8 de 10 entre tres: warn del escuadrón', warn.map((e) => `${e.kind}:${e.scope.kind}:${e.scope.ref}`), ['warn:squad:audit-01']);
  if (!r1.pass) return r1;
  const r2 = ok('nombra a los tres', warn[0]!.text.includes('squad audit-01 (LEAD, M1, M2)'), warn[0]?.text);
  if (!r2.pass) return r2;

  now += 3 * 60_000;
  fleet.m1.metrics.toolCalls = 9;  // sigue trabajando
  fleet.m1.metrics.costUSD = 5;    // total 10
  const ev = b.tick(fleet, {}, now);
  const stopped = ev.filter((e) => e.kind === 'stop').map((e) => (e as { agentId: string }).agentId).sort();
  const r3 = eq('para al líder y a m2, no a m1', stopped, ['lead', 'm2']);
  if (!r3.pass) return r3;
  const st = b.agentStatus(fleet.m1, fleet, {}, now);
  return ok('inspect de un miembro enseña el gasto del escuadrón entero', st.lines.some((l) => l.scope === 'squad' && Math.abs(l.spent_usd - 10) < 1e-9), JSON.stringify(st.lines));
});

/* ── 7 · presupuesto por tarea ────────────────────────────────────── */

const taskBudget = test('el techo de una tarea suma a todos sus agentes asignados', () => {
  let now = T0;
  const b = book({}, () => now);
  b.set({ kind: 'task', ref: 'task_a' }, { usd: 4, min: null });
  const fleet = {
    a: agent({ id: 'a', metrics: { costUSD: 2 } }),
    b: agent({ id: 'b', metrics: { costUSD: 1.5 } }),
    c: agent({ id: 'c', metrics: { costUSD: 9 } }),
  };
  const tasks: Record<string, CapcomTask> = {
    task_a: { id: 'task_a', title: 'A', status: 'active', createdAt: T0, updatedAt: T0, agentIds: ['a', 'b'], messages: [] },
  };
  const ev = b.tick(fleet, tasks, (now += 1000));
  const r = eq('warn de la tarea', ev.map((e) => `${e.kind}:${e.scope.kind}`), ['warn:task']);
  if (!r.pass) return r;
  return ok('con la tarea en el texto', ev[0]!.text.includes('task task_a'), ev[0]?.text);
});

/* ── 8 · estimación por tokens ────────────────────────────────────── */

const estimate = test('con costUSD a 0, los tokens estiman el gasto y la línea lo marca con ~', () => {
  let now = T0;
  const b = book({ ORCA_BUDGET_USD_PER_MTOK: '10' }, () => now);
  b.set({ kind: 'agent', ref: 'k9' }, { usd: 1, min: null });
  const fleet = { k9: agent({ id: 'k9', metrics: { inputTokens: 60_000, outputTokens: 30_000 } }) };
  const ev = b.tick(fleet, {}, (now += 1000));
  const r = eq('90k tokens a $10/M = $0.90: warn', kinds(ev), ['warn']);
  if (!r.pass) return r;
  return ok('estimado', ev[0]!.text.includes('~$0.90 of $1.00'), ev[0]?.text);
});

/* ── 9 · set_budget vuelve a armar, y el disco recuerda ───────────── */

const rearmAndPersist = test('subir el techo re-arma los avisos; los límites y lo ya avisado sobreviven al reinicio', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-budget-'));
  try {
    let now = T0;
    const b = new BudgetBook(dir, budgetConfig({} as NodeJS.ProcessEnv), { now: () => now });
    b.set({ kind: 'agent', ref: 'k9' }, { usd: 1, min: null });
    const fleet = { k9: agent({ id: 'k9', metrics: { costUSD: 0.9 } }) };
    const first = b.tick(fleet, {}, (now += 1000));
    const r1 = eq('warn', kinds(first), ['warn']);
    if (!r1.pass) return r1;

    const again = new BudgetBook(dir, budgetConfig({} as NodeJS.ProcessEnv), { now: () => now });
    const r2 = eq('reiniciado: recuerda el límite', again.get({ kind: 'agent', ref: 'k9' }), { usd: 1, min: null });
    if (!r2.pass) return r2;
    const r3 = eq('reiniciado: no repite el warn', kinds(again.tick(fleet, {}, (now += 1000))), []);
    if (!r3.pass) return r3;

    again.set({ kind: 'agent', ref: 'k9' }, { usd: 1.05, min: null });
    return eq('techo nuevo: vuelve a avisar', kinds(again.tick(fleet, {}, (now += 1000))), ['warn']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const limitParsing = test('budgetLimit acepta números, nulos y rechaza basura', () => {
  const r1 = eq('ambos', budgetLimit(5, 30), { usd: 5, min: 30 });
  if (!r1.pass) return r1;
  const r2 = eq('nulos', budgetLimit(null, undefined), { usd: null, min: null });
  if (!r2.pass) return r2;
  return ok('negativo rechazado', 'error' in budgetLimit(-1, null));
});

/* ── 10 · en el hub: set_budget, inspect_agent, el aviso a CAPCOM y el feed ── */

const throughTheHub = test('set_budget pone el techo, inspect_agent lo enseña, y el 80 % llega por el canal de CAPCOM y al feed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-budget-hub-'));
  const unrouted: string[] = [];
  let now = Date.now();
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: 'orca-budget-test-token' } as NodeJS.ProcessEnv),
    store: new HubStore({ dir }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
    fleets: new FleetStore(join(dir, 'fleets')),
    budgets: new BudgetBook(join(dir, 'hub'), budgetConfig({ ORCA_BUDGET_PROGRESS_MIN: '1' } as NodeJS.ProcessEnv), { now: () => now }),
    onUnrouted: (text) => { unrouted.push(text); },
  });
  try {
    const checks: TestResult[] = [];
    const project: Project = {
      id: 'p1', machineId: 'm1', slug: '-tmp-p1', name: 'p1', path: '/tmp/p1', code: 'P1',
      gitBranch: null, gitDirty: false, keyNames: [], sessionIds: ['a1'], rollup: emptyRollup(),
    };
    hub.world.applyCollector({ t: 'project:new', machineId: 'm1', project }, 'm1');
    hub.world.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agent({ id: 'a1', callsign: 'K9', startedAt: now, metrics: { costUSD: 1.7, toolCalls: 2 } }) }, 'm1');
    const ctx = hubContext(hub);

    const twice = await runTool(ctx, 'set_budget', { agent_id: 'K9', squad: 'x', task_id: null, budget_usd: 2, budget_min: null });
    checks.push(ok('dos objetivos: rechazado', twice.isError === true, twice.result));
    const bad = await runTool(ctx, 'set_budget', { agent_id: 'K9', squad: null, task_id: null, budget_usd: -3, budget_min: null });
    checks.push(ok('límite negativo: rechazado', bad.isError === true, bad.result));

    const set = await runTool(ctx, 'set_budget', { agent_id: 'K9', squad: null, task_id: null, budget_usd: 2, budget_min: 30 });
    checks.push(ok('set_budget por callsign', !set.isError && set.summary === 'budget on K9: $2 / 30 min', set.summary));
    const parsed = JSON.parse(set.result) as { status: { spent_usd: number; pct: number; level: string } };
    checks.push(eq('devuelve el gasto contra el techo nuevo', [parsed.status.spent_usd, parsed.status.pct, parsed.status.level], [1.7, 85, 'warn']));

    const insp = await runTool(ctx, 'inspect_agent', { agent_id: 'K9' });
    const view = (JSON.parse(insp.result) as { budget: { level: string; limits: { scope: string; limit_usd: number }[] } }).budget;
    checks.push(eq('inspect_agent enseña el presupuesto', [view.level, view.limits[0]?.scope, view.limits[0]?.limit_usd], ['warn', 'agent', 2]));

    // El sweep del hub corre cada dos segundos: el 80 % ya estaba cruzado.
    const arrived = await until(() => unrouted.some((t) => t.startsWith('[BUDGET 80%] K9')), 6000);
    checks.push(ok('el aviso sale por el canal de CAPCOM (sin CAPCOM, onUnrouted)', arrived, unrouted.join(' | ')));
    const feed = hub.world.state.feed.find((f) => f.source === 'BUDGET');
    checks.push(ok('y entra en el feed con nivel warn y agente', feed?.level === 'warn' && feed.agentId === 'a1' && feed.text.includes('$1.70 of $2.00'), feed?.text));

    const fleet = await runTool(ctx, 'list_fleet', { only_blocked: false });
    const proj = (JSON.parse(fleet.result) as { projects: { budget: { agents: number; warn: number; limit_usd: number } | null }[] }).projects[0];
    checks.push(eq('list_fleet agrega por proyecto', [proj?.budget?.agents, proj?.budget?.warn, proj?.budget?.limit_usd], [1, 1, 2]));

    // Se pasa y se calla: el hub pide el stop. Sin collector el stop no llega,
    // y eso también se cuenta, en el feed, en vez de perderse en un log.
    now += 2 * 60_000;
    hub.world.applyCollector({ t: 'agent', machineId: 'm1', id: 'a1', patch: { metrics: { ...emptyMetrics(), costUSD: 2.5, toolCalls: 2 } } }, 'm1');
    const over = await until(() => unrouted.some((t) => t.startsWith('[BUDGET 100%] K9')), 6000);
    checks.push(ok('el 100 % avisa', over, unrouted.join(' | ')));
    const stop = await until(() => unrouted.some((t) => t.startsWith('[BUDGET STOP] K9')), 6000);
    checks.push(ok('y sin progreso pide el stop', stop, unrouted.join(' | ')));
    const failedStop = await until(() => hub.world.state.feed.some((f) => f.source === 'BUDGET' && f.text.includes('did not go through')), 6000);
    checks.push(ok('un stop que no llega queda en el feed', failedStop));

    const removed = await runTool(ctx, 'set_budget', { agent_id: 'a1', squad: null, task_id: null, budget_usd: null, budget_min: null });
    checks.push(ok('ambos nulos quitan el techo', !removed.isError && removed.summary === 'budget on K9: removed' && hub.budgets.get({ kind: 'agent', ref: 'a1' }) === null, removed.summary));

    return checks.find((c) => !c.pass) ?? ok('a través del hub', true, `${checks.length} checks`);
  } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const mod: TestModule = {
  suite: 'Budgets',
  tests: [
    thresholds, progressSpares, linesCountAsProgress, actionWarn, timeBudget,
    envDefaults, squadShared, taskBudget, estimate, rearmAndPersist, limitParsing,
    throughTheHub,
  ],
};
export default mod;
