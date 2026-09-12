/**
 * Presupuestos por worker, escuadrón y misión.
 *
 * Lo que se comprueba es la política, no la fontanería: que las unidades son
 * TOKENS y minutos activos y que el dinero ya no es ninguna —un techo en
 * dólares de un libro viejo se cae al cargarlo—, que un techo cuyo sujeto ya
 * no está en la flota se borra solo, que el 80 % avisa una vez, que el 100 % con progreso reciente NO
 * para, que el 100 % sin progreso sí para, que los defaults del entorno
 * alcanzan a quien no tiene techo propio y que el techo de un escuadrón se
 * reparte entre sus miembros.
 *
 * Y lo que salió de dos incidentes reales, que son la mitad de esta suite:
 *
 *  - un agente en idle no genera un solo aviso, por mucho reloj que pase;
 *  - un agente al que ya se paró sale del ciclo y no vuelve a avisar NUNCA;
 *  - la marca de progreso se siembra en la última actividad real, así que un
 *    hub reiniciado no declara "still making progress (0s ago)" de un muerto;
 *  - lo que gasta un subagente `Task` se carga a su ancestro EN LA MISMA
 *    PASADA, que es lo que faltaba para que el aviso llegase a tiempo;
 *  - hay un freno de descendencia, por número y por profundidad;
 *  - una ráfaga de avisos llega a CAPCOM como UN mensaje.
 *
 * Todo con un reloj en una variable y una flota en un objeto; el hub de verdad
 * se prueba al final, en un puerto libre, para ver que el aviso llega a CAPCOM
 * por su canal y al feed.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BudgetBook, budgetConfig, budgetLimit, fmtTokens, type BudgetEvent } from '../src/hub/budgets.ts';
import { startHub } from '../src/hub/server.ts';
import { createAuth } from '../src/hub/auth.ts';
import { HubStore } from '../src/hub/persist.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { FleetStore } from '../src/hub/fleets.ts';
import { hubContext } from '../src/agents/context.ts';
import { runTool } from '../src/agents/tools.ts';
import { adviceFor, reachability } from '../src/hub/liveness.ts';
import { emptyRollup, type Agent, type AgentMetrics, type Machine, type Project } from '../src/shared/types.ts';
import type { CapcomMission } from '../src/shared/missions.ts';
import { eq, ok, test, until, type TestModule, type TestResult } from './harness.ts';

const T0 = 1_700_000_000_000;
const M = 1_000_000;

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

/** Un techo, con los ejes que no se nombran a null. */
function cap(over: { tokens?: number | null; min?: number | null }) {
  return { tokens: over.tokens ?? null, min: over.min ?? null };
}

/** El plazo de `pruneOrphans`, aquí para no repetir el número mágico. */
const ORPHAN_GRACE = 10 * 60_000;

function book(env: Record<string, string> = {}, now: () => number): BudgetBook {
  return new BudgetBook(null, budgetConfig(env as NodeJS.ProcessEnv), { now });
}

function kinds(events: BudgetEvent[]): string[] { return events.map((e) => e.kind); }

/**
 * Correr el sweep como lo corre el hub: cada pocos segundos. El tiempo activo
 * se acumula por observación y una sola pasada de ocho minutos no son ocho
 * minutos de trabajo — son un hub que no estaba mirando.
 */
function advance(
  b: BudgetBook, fleet: Record<string, Agent>, missions: Record<string, CapcomMission>,
  from: number, ms: number, step = 30_000,
): { now: number; events: BudgetEvent[] } {
  let now = from;
  const events: BudgetEvent[] = [];
  const end = from + ms;
  while (now < end) {
    now = Math.min(end, now + step);
    events.push(...b.tick(fleet, missions, now));
  }
  return { now, events };
}

/* ── 1 · umbrales, en tokens ──────────────────────────────────────── */

const thresholds = test('80 % avisa una vez, 100 % avisa una vez, y en medio no repite', () => {
  let now = T0;
  const b = book({}, () => now);
  b.set({ kind: 'agent', ref: 'k9' }, cap({ tokens: 10 * M }));
  const fleet = { k9: agent({ id: 'k9', metrics: { inputTokens: 5 * M } }) };

  const quiet = b.tick(fleet, {}, now);
  fleet.k9.metrics.inputTokens = 8.5 * M;
  const warn = b.tick(fleet, {}, (now += 1000));
  const again = b.tick(fleet, {}, (now += 1000));
  fleet.k9.metrics.toolCalls = 3;          // progresa: al 100 % sólo avisa
  fleet.k9.metrics.inputTokens = 10.2 * M;
  const over = b.tick(fleet, {}, (now += 1000));
  const overAgain = b.tick(fleet, {}, (now += 1000));

  const results = [
    eq('bajo el 80 %: nada', kinds(quiet), []),
    eq('al 80 %: un warn', kinds(warn), ['warn']),
    ok('el warn lleva el prefijo y las cifras EN TOKENS', /^\[BUDGET 80%\] K9 · 8\.5M of 10\.0M tokens \(85%\)$/.test(warn[0]!.text), warn[0]?.text),
    ok('y no menciona dinero', !warn[0]!.text.includes('$'), warn[0]?.text),
    eq('el mismo tick después: silencio', kinds(again), []),
    eq('al 100 % con progreso: over, sin stop', kinds(over), ['over']),
    ok('el over dice que sigue avanzando y no se paró', over[0]!.text.startsWith('[BUDGET 100%] K9') && over[0]!.text.includes('not stopped'), over[0]?.text),
    eq('y tampoco se repite', kinds(overAgain), []),
  ];
  return results.find((r) => !r.pass) ?? ok('umbrales', true, `${results.length} checks`);
});

const tokenUnit = test('la unidad suma entrada, salida y escritura de caché; ni la lectura de caché ni el razonamiento', () => {
  const b = book({}, () => T0);
  const a = agent({ id: 'k9', metrics: { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 9000, cacheWriteTokens: 2000, thinkingTokens: 300 } });
  // Un collector anterior a `cacheWriteTokens` no sabe separarla: para él se
  // mantiene la suma vieja, porque la nueva sin la escritura no mediría nada.
  const old = agent({ id: 'l2', metrics: { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 9000, thinkingTokens: 300 } });
  const results = [
    eq('in + out + cache write, sin cache read', b.tokensOf(a), 3_400),
    eq('collector viejo: in + out + cache read', b.tokensOf(old), 10_400),
    eq('legible de un vistazo', [fmtTokens(12_400_000), fmtTokens(840_000), fmtTokens(912)], ['12.4M', '840k', '912']),
  ];
  return results.find((r) => !r.pass) ?? ok('unidad', true, `${results.length} checks`);
});

const cacheReadsNoBudget = test('un agente que sólo relee su caché no se acerca a su techo', () => {
  let now = T0;
  const b = book({}, () => now);
  b.set({ kind: 'agent', ref: 'k9' }, cap({ tokens: 400_000 }));
  // La forma de AJ a los 46 s: casi todo lectura de caché.
  const fleet = { k9: agent({ id: 'k9', metrics: { inputTokens: 12, outputTokens: 2_657, cacheReadTokens: 900_000, cacheWriteTokens: 111_339 } }) };
  const quiet = b.tick(fleet, {}, (now += 1000));
  fleet.k9.metrics.cacheWriteTokens = 340_000;
  const warn = b.tick(fleet, {}, (now += 1000));
  return ok('900k leídos de caché no avisan; 343k nuevos sí, y el aviso da esa cifra',
    quiet.length === 0 && warn.length === 1 && /343k of 400k tokens \(86%\)/.test(warn[0]!.text),
    warn[0]?.text ?? `${quiet.length} events`);
});

/* ── 2 · el progreso reciente evita la parada ─────────────────────── */

const progressSpares = test('al 100 % sin progreso se para; con progreso reciente no', () => {
  let now = T0;
  const b = book({ ORCA_BUDGET_PROGRESS_MIN: '3' }, () => now);
  b.set({ kind: 'agent', ref: 'k9' }, cap({ tokens: M }));
  b.set({ kind: 'agent', ref: 'l2' }, cap({ tokens: M }));
  const fleet = {
    k9: agent({ id: 'k9', metrics: { inputTokens: 0.5 * M, toolCalls: 1 } }),
    l2: agent({ id: 'l2', metrics: { inputTokens: 0.5 * M, toolCalls: 1 } }),
  };
  b.tick(fleet, {}, now);
  // Cuatro minutos después: k9 hizo llamadas, l2 no; ambos se pasan.
  now += 4 * 60_000;
  fleet.k9.metrics.toolCalls = 7;
  fleet.k9.metrics.inputTokens = 1.1 * M;
  fleet.l2.metrics.inputTokens = 1.1 * M;
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
  b.set({ kind: 'agent', ref: 'k9' }, cap({ tokens: M }));
  const fleet = { k9: agent({ id: 'k9', metrics: { inputTokens: 0.2 * M } }) };
  b.tick(fleet, {}, now);
  now += 5 * 60_000;
  fleet.k9.metrics.linesAdded = 12;
  fleet.k9.metrics.inputTokens = 2 * M;
  return eq('over sin stop', kinds(b.tick(fleet, {}, now)), ['over']);
});

/* ── 3 · ORCA_BUDGET_ACTION ───────────────────────────────────────── */

const actionWarn = test('ORCA_BUDGET_ACTION=warn nunca para, sólo avisa', () => {
  let now = T0;
  const b = book({ ORCA_BUDGET_ACTION: 'warn', ORCA_BUDGET_PROGRESS_MIN: '1' }, () => now);
  b.set({ kind: 'agent', ref: 'k9' }, cap({ tokens: M }));
  const fleet = { k9: agent({ id: 'k9', metrics: { inputTokens: 0.1 * M } }) };
  b.tick(fleet, {}, now);
  now += 10 * 60_000;
  fleet.k9.metrics.inputTokens = 5 * M;
  const ev = b.tick(fleet, {}, now);
  const r = eq('sólo over', kinds(ev), ['over']);
  if (!r.pass) return r;
  return ok('y lo dice', ev[0]!.text.includes('ORCA_BUDGET_ACTION=warn'), ev[0]?.text);
});

/* ── 4 · el tiempo es tiempo TRABAJANDO ───────────────────────────── */

const activeTime = test('budget_min mide minutos trabajando, no reloj de pared desde el arranque', () => {
  const now0 = T0;
  let now = now0;
  const b = book({}, () => now);
  b.set({ kind: 'agent', ref: 'k9' }, cap({ min: 10 }));
  const fleet = { k9: agent({ id: 'k9', state: 'working', metrics: { toolCalls: 1 } }) };

  const run = advance(b, fleet, {}, now, 8 * 60_000 + 30_000);
  now = run.now;
  const warns = run.events.filter((e) => e.kind === 'warn');
  const r = eq('al 80 % del tiempo trabajado avisa', warns.length, 1);
  if (!r.pass) return r;
  return ok('y lo llama activo, no transcurrido', /8m of 10m active \(8[0-9]%\)/.test(warns[0]!.text), warns[0]?.text);
});

const idleIsSilent = test('un agente en idle no consume y no genera un solo aviso, pase el reloj que pase', () => {
  let now = T0;
  const b = book({}, () => now);
  b.set({ kind: 'agent', ref: 'k9' }, cap({ tokens: M, min: 10 }));
  // Entregó su trabajo y espera. Ocho horas.
  const fleet = { k9: agent({ id: 'k9', state: 'idle', metrics: { inputTokens: 0.5 * M, toolCalls: 9 } }) };
  const run = advance(b, fleet, {}, now, 8 * 60 * 60_000, 60_000);
  now = run.now;
  const r1 = eq('ni un aviso en ocho horas', kinds(run.events), []);
  if (!r1.pass) return r1;
  const st = b.agentStatus(fleet.k9, fleet, {}, now);
  const r2 = eq('cero minutos activos', Math.round(st.active_min), 0);
  if (!r2.pass) return r2;
  return eq('y el nivel sigue en ok', st.level, 'ok');
});

/* ── 5 · quien ya fue detenido no vuelve a avisar ─────────────────── */

const retiredStaysQuiet = test('parar a un agente le saca del ciclo: no vuelve a avisar aunque su estado nunca llegue', () => {
  let now = T0;
  const b = book({ ORCA_BUDGET_PROGRESS_MIN: '1' }, () => now);
  b.set({ kind: 'squad', ref: 'rubric-01' }, cap({ tokens: 4 * M, min: 90 }));
  const fleet = {
    cg: agent({ id: 'cg', squad: 'rubric-01', state: 'working', metrics: { inputTokens: 3 * M, toolCalls: 4 } }),
    c1: agent({ id: 'c1', squad: 'rubric-01', state: 'working', metrics: { inputTokens: 2 * M, toolCalls: 4 } }),
  };
  const first = b.tick(fleet, {}, (now += 1000));
  const r1 = eq('mientras trabajan, el 100 % se dice una vez', kinds(first), ['over']);
  if (!r1.pass) return r1;

  // El operador los para con stop_squad. La sesión de tmux desaparece y el
  // `dead` no llega nunca: el estado se queda en 'working' para siempre.
  b.retire(['cg', 'c1']);
  const after = advance(b, fleet, {}, now, 6 * 60 * 60_000, 60_000);
  now = after.now;
  const r2 = eq('seis horas después, silencio absoluto', kinds(after.events), []);
  if (!r2.pass) return r2;
  const r3 = ok('y se ve en el estado que están retirados', b.agentStatus(fleet.cg, fleet, {}, now).retired === true);
  if (!r3.pass) return r3;
  // Y tampoco un techo nuevo los resucita: no queda nadie vivo en el ámbito.
  b.set({ kind: 'squad', ref: 'rubric-01' }, cap({ tokens: M }));
  return eq('re-armar el aviso no despierta a un escuadrón muerto', kinds(b.tick(fleet, {}, (now += 1000))), []);
});

const ghostsAreSilent = test('un agente callado sigue vivo; sólo callan los avisos una parada o una máquina caída', () => {
  let now = T0;
  const machines: Record<string, Machine> = {
    m1: { id: 'm1', hostname: 'mac', platform: 'darwin', version: '1', online: true, lastSeen: T0, connectedAt: T0, load: { sessions: 2, activeSessions: 2, cpuPct: null, memPct: null } },
  };
  const mk = () => new BudgetBook(null, budgetConfig({} as NodeJS.ProcessEnv), { now: () => now, liveness: () => ({ machines }) });
  const fleet: Record<string, Agent> = {
    b9: agent({ id: 'b9', squad: 'ideas-01', state: 'working', updatedAt: T0, metrics: { inputTokens: 9 * M, toolCalls: 7 } }),
    live: agent({ id: 'live', state: 'working', updatedAt: T0, metrics: { inputTokens: 0.1 * M } }),
  };
  for (let i = 0; i < 25; i++) fleet[`k${i}`] = agent({ id: `k${i}`, subagent: true, parentId: 'b9', updatedAt: T0 });

  // 1 · EL SILENCIO NO MATA. B9 lleva media hora sin escribir una línea en su
  // transcript: puede estar razonando o redactando un fichero largo. Sigue
  // contando como vivo y su presupuesto se evalúa como el de cualquiera.
  now = T0 + 30 * 60_000;
  const quiet = mk();
  quiet.set({ kind: 'agent', ref: 'b9' }, cap({ tokens: M }));
  const r1 = ok('media hora callado y en `working`: sigue vivo y se le evalúa',
    quiet.tick(fleet, {}, now).some((e) => e.kind === 'over'), 'un agente callado no es un muerto');
  if (!r1.pass) return r1;

  // 2 · Lo que sí calla los avisos: que alguien lo pare. Es una afirmación,
  // no una conjetura, y con ella se va también su cría.
  fleet.live!.updatedAt = now;   // acaba de escribir: progresa, no se le para
  const stopped = mk();
  stopped.set({ kind: 'agent', ref: 'b9' }, cap({ tokens: M }));
  stopped.set({ kind: 'agent', ref: 'live' }, cap({ tokens: 0.05 * M }));
  stopped.retire('b9');
  const ev = stopped.tick(fleet, {}, (now += 1000));
  const r2 = eq('del parado, nada; del que sigue, lo suyo',
    ev.map((e) => (e.kind === 'swarm' ? `swarm:${e.agentId}` : `${e.kind}:${e.scope.ref}`)).sort(),
    ['over:live']);
  if (!r2.pass) return r2;
  const r3 = eq('y su cría deja de contarse como viva', stopped.agentStatus(fleet.b9!, fleet, {}, now).brood.live, 0);
  if (!r3.pass) return r3;

  // 3 · Un entierro equivocado se deshace solo: si el parado sigue haciendo
  // llamadas de herramienta, la parada no surtió efecto y vuelve al ciclo.
  fleet.b9!.metrics.toolCalls = 12;
  stopped.tick(fleet, {}, (now += 1000));
  const r4 = eq('quien sigue trabajando resucita sin que nadie intervenga',
    stopped.agentStatus(fleet.b9!, fleet, {}, now).retired, false);
  if (!r4.pass) return r4;

  // 4 · Máquina no conectada: sus agentes no pueden tratarse como vivos.
  machines.m1!.online = false;
  machines.m1!.lastSeen = now;
  fleet.live!.metrics.inputTokens = 90 * M;
  const off = mk();
  off.set({ kind: 'agent', ref: 'live' }, cap({ tokens: 0.05 * M }));
  return eq('máquina caída: nadie de ella avisa', kinds(off.tick(fleet, {}, (now += 1000))), []);
});

const adviceIsExecutable = test('el consejo de un aviso sólo nombra acciones que de verdad alcanzan a ese agente', () => {
  const hosted = agent({ id: 'h', pane: true });
  const bg = agent({ id: 'b', background: true, shortId: 'abc123' });
  // El limbo de B9: ni pane, ni sesión background direccionable.
  const limbo = agent({ id: 'l', background: false, shortId: null, pane: false });

  const r1 = eq('con pane: se le puede interrumpir y parar',
    [reachability(hosted).interrupt, reachability(hosted).stop], [true, true]);
  if (!r1.pass) return r1;
  const r2 = eq('background sin pane: parar sí, interrumpir no',
    [reachability(bg).interrupt, reachability(bg).stop], [false, true]);
  if (!r2.pass) return r2;
  const r3 = eq('en el limbo no alcanza ninguna de las dos',
    [reachability(limbo).interrupt, reachability(limbo).stop, reachability(limbo).retire], [false, false, true]);
  if (!r3.pass) return r3;
  const r4 = ok('y el consejo no manda a un callejón',
    !adviceFor(limbo).includes('interrupt_agent') && !adviceFor(limbo).includes('stop_agent') && adviceFor(limbo).includes('retire_agent'),
    adviceFor(limbo));
  if (!r4.pass) return r4;
  return ok('mientras que al hospedado sí le ofrece las dos',
    adviceFor(hosted).includes('interrupt_agent') && adviceFor(hosted).includes('stop_agent'), adviceFor(hosted));
});

const progressIsNotInvented = test('la marca de progreso sale de la última actividad real, no del tick que la mira', () => {
  const now = T0 + 60 * 60_000;
  const b = book({ ORCA_BUDGET_PROGRESS_MIN: '3' }, () => now);
  // Un hub recién arrancado ve por primera vez a un agente cuya última señal
  // es de hace media hora. Sembrar la marca en `now` era lo que producía
  // "still making progress (CG 0s ago)" sobre agentes muertos.
  const fleet = {
    stale: agent({ id: 'stale', startedAt: T0, updatedAt: T0 + 30 * 60_000, metrics: { toolCalls: 4 } }),
    fresh: agent({ id: 'fresh', startedAt: now - 5_000, updatedAt: now - 5_000 }),
  };
  b.tick(fleet, {}, now);
  const r = eq('el viejo NO cuenta como progresando', b.recentProgress('stale', now), false);
  if (!r.pass) return r;
  return eq('el recién lanzado sí', b.recentProgress('fresh', now), true);
});

/* ── 6 · defaults por entorno ─────────────────────────────────────── */

const envDefaults = test('ORCA_DEFAULT_BUDGET_TOKENS alcanza a quien no tiene techo propio, y no a CAPCOM', () => {
  let now = T0;
  const b = book({ ORCA_DEFAULT_BUDGET_TOKENS: '2000000' }, () => now);
  b.set({ kind: 'agent', ref: 'own' }, cap({ tokens: 100 * M }));
  const fleet = {
    k9: agent({ id: 'k9', metrics: { inputTokens: 1.7 * M } }),
    own: agent({ id: 'own', metrics: { inputTokens: 1.7 * M } }),
    cap: agent({ id: 'cap', role: 'capcom', metrics: { inputTokens: 50 * M } }),
  };
  const ev = b.tick(fleet, {}, (now += 1000));
  const r = eq('avisa sólo del que va por defecto', ev.map((e) => `${e.kind}:${e.kind === 'swarm' ? e.agentId : e.scope.ref}`), ['warn:k9']);
  if (!r.pass) return r;
  const st = b.agentStatus(fleet.k9, fleet, {}, now);
  const r2 = eq('inspect lo ve como techo por defecto', st.lines.map((l) => l.scope), ['default']);
  if (!r2.pass) return r2;
  return eq('vacío = sin límite', budgetConfig({ ORCA_DEFAULT_BUDGET_TOKENS: '', ORCA_DEFAULT_BUDGET_MIN: ' ' } as NodeJS.ProcessEnv).defaultTokens, null);
});

/* ── 7 · presupuesto de escuadrón compartido ──────────────────────── */

const squadShared = test('el techo de un escuadrón es la suma de sus miembros, y para sólo a los parados', () => {
  let now = T0;
  const b = book({ ORCA_BUDGET_PROGRESS_MIN: '2' }, () => now);
  b.set({ kind: 'squad', ref: 'audit-01' }, cap({ tokens: 10 * M }));
  const fleet = {
    lead: agent({ id: 'lead', squad: 'audit-01', lead: true, metrics: { inputTokens: 3 * M, toolCalls: 1 } }),
    m1: agent({ id: 'm1', squad: 'audit-01', metrics: { inputTokens: 3 * M, toolCalls: 1 } }),
    m2: agent({ id: 'm2', squad: 'audit-01', metrics: { inputTokens: 2 * M, toolCalls: 1 } }),
    other: agent({ id: 'other', squad: 'build-01', metrics: { inputTokens: 50 * M } }),
  };
  const warn = b.tick(fleet, {}, now);
  const r1 = eq('8 de 10 entre tres: warn del escuadrón', warn.map((e) => `${e.kind}:${e.kind === 'swarm' ? '' : e.scope.kind}:${e.kind === 'swarm' ? '' : e.scope.ref}`), ['warn:squad:audit-01']);
  if (!r1.pass) return r1;
  const r2 = ok('nombra a los tres', warn[0]!.text.includes('squad audit-01 (LEAD, M1, M2)'), warn[0]?.text);
  if (!r2.pass) return r2;

  now += 3 * 60_000;
  fleet.m1.metrics.toolCalls = 9;      // sigue trabajando
  fleet.m1.metrics.inputTokens = 5 * M; // total 10M
  const ev = b.tick(fleet, {}, now);
  const stopped = ev.filter((e) => e.kind === 'stop').map((e) => (e as { agentId: string }).agentId).sort();
  const r3 = eq('para al líder y a m2, no a m1', stopped, ['lead', 'm2']);
  if (!r3.pass) return r3;
  const st = b.agentStatus(fleet.m1, fleet, {}, now);
  return ok('inspect de un miembro enseña el consumo del escuadrón entero', st.lines.some((l) => l.scope === 'squad' && l.tokens === 10 * M), JSON.stringify(st.lines));
});

/* ── 8 · presupuesto por misión ───────────────────────────────────── */

const missionBudget = test('el techo de una misión suma a todos sus agentes asignados', () => {
  let now = T0;
  const b = book({}, () => now);
  b.set({ kind: 'mission', ref: 'task_a' }, cap({ tokens: 4 * M }));
  const fleet = {
    a: agent({ id: 'a', metrics: { inputTokens: 2 * M } }),
    b: agent({ id: 'b', metrics: { inputTokens: 1.5 * M } }),
    c: agent({ id: 'c', metrics: { inputTokens: 9 * M } }),
  };
  const missions: Record<string, CapcomMission> = {
    task_a: { id: 'task_a', title: 'A', status: 'active', createdAt: T0, updatedAt: T0, agentIds: ['a', 'b'], messages: [] },
  };
  const ev = b.tick(fleet, missions, (now += 1000));
  const r = eq('warn de la misión', ev.map((e) => `${e.kind}:${e.kind === 'swarm' ? '' : e.scope.kind}`), ['warn:mission']);
  if (!r.pass) return r;
  return ok('con la misión en el texto', ev[0]!.text.includes('mission task_a'), ev[0]?.text);
});

/* ── 9 · la descendencia se cobra al ancestro, en la misma pasada ── */

const broodIsCharged = test('lo que gastan los subagentes Task cuenta contra su ancestro en tiempo real', () => {
  let now = T0;
  const b = book({}, () => now);
  b.set({ kind: 'agent', ref: 'lead' }, cap({ tokens: 8 * M }));
  const fleet = {
    lead: agent({ id: 'lead', metrics: { inputTokens: M, toolCalls: 3 } }),
    // Cuatro subagentes, y uno de ellos con nieto.
    s1: agent({ id: 's1', subagent: true, parentId: 'lead', depth: 1, metrics: { inputTokens: 4 * M } }),
    s2: agent({ id: 's2', subagent: true, parentId: 's1', depth: 2, metrics: { inputTokens: 5 * M } }),
    // Una sesión completa que ORCA lanzó: tiene presupuesto propio y NO se
    // le cobra a quien la lanzó.
    peer: agent({ id: 'peer', parentId: 'lead', depth: 1, metrics: { inputTokens: 40 * M } }),
  };
  const ev = b.tick(fleet, {}, (now += 1000));
  const r1 = eq('el ancestro se pasa por lo que gastó su descendencia', kinds(ev), ['over']);
  if (!r1.pass) return r1;
  const r2 = ok('y el aviso dice cuántos lleva dentro', ev[0]!.text.includes('10.0M of 8.0M tokens') && ev[0]!.text.includes('includes 2 live Task subagents'), ev[0]?.text);
  if (!r2.pass) return r2;
  const st = b.agentStatus(fleet.lead, fleet, {}, now);
  const r3 = eq('1M propios + 9M de la cría, y la sesión hermana fuera', [st.tokens, st.descendants], [10 * M, 2]);
  if (!r3.pass) return r3;
  return eq('un subagente no es sujeto de presupuesto propio', b.agentStatus(fleet.s1, fleet, {}, now).lines.length, 0);
});

const broodBrake = test('el freno corta por número de descendientes vivos y por profundidad', () => {
  let now = T0;
  const b = book({ ORCA_MAX_DESCENDANTS: '8', ORCA_MAX_AGENT_DEPTH: '2' }, () => now);
  const fleet: Record<string, Agent> = { lead: agent({ id: 'lead', pane: true }) };
  for (let i = 0; i < 9; i++) fleet[`s${i}`] = agent({ id: `s${i}`, subagent: true, parentId: 'lead', depth: 1 });
  const ev = b.tick(fleet, {}, (now += 1000));
  const swarm = ev.filter((e) => e.kind === 'swarm');
  const r1 = eq('nueve vivos sobre un tope de ocho: un aviso', swarm.length, 1);
  if (!r1.pass) return r1;
  const s = swarm[0] as Extract<BudgetEvent, { kind: 'swarm' }>;
  const r2 = ok('dice el número, el tope y qué hacer con ESTE agente',
    s.text.startsWith('[SWARM CAP] LEAD')
    && s.text.includes('9 live Task subagents (cap 8)')
    && s.text.includes('their tokens already count against LEAD')
    && s.text.includes('interrupt_agent'), s.text);
  if (!r2.pass) return r2;
  const r3 = eq('y no se repite en la pasada siguiente', kinds(b.tick(fleet, {}, (now += 1000))), []);
  if (!r3.pass) return r3;
  const r4 = eq('sin ORCA_SWARM_ACTION=stop no para a nadie', s.stopIds, []);
  if (!r4.pass) return r4;

  // La cría termina: el aviso se re-arma para la próxima tanda.
  for (let i = 0; i < 9; i++) fleet[`s${i}`]!.state = 'done';
  b.tick(fleet, {}, (now += 1000));
  for (let i = 0; i < 9; i++) fleet[`s${i}`]!.state = 'working';
  const r5 = eq('vuelve a avisar cuando vuelve a pasar', kinds(b.tick(fleet, {}, (now += 1000))), ['swarm']);
  if (!r5.pass) return r5;

  // Profundidad: una cadena de tres generaciones sobre un tope de dos.
  const deep = book({ ORCA_MAX_DESCENDANTS: '100', ORCA_MAX_AGENT_DEPTH: '2', ORCA_SWARM_ACTION: 'stop' }, () => now);
  const chain: Record<string, Agent> = {
    root: agent({ id: 'root', pane: true }),
    g1: agent({ id: 'g1', subagent: true, parentId: 'root' }),
    g2: agent({ id: 'g2', subagent: true, parentId: 'g1' }),
    g3: agent({ id: 'g3', subagent: true, parentId: 'g2' }),
  };
  const dev = deep.tick(chain, {}, (now += 1000)).filter((e) => e.kind === 'swarm') as Extract<BudgetEvent, { kind: 'swarm' }>[];
  const r6 = eq('tres generaciones sobre un tope de dos', dev.map((e) => e.agentId), ['root']);
  if (!r6.pass) return r6;
  const r7 = ok('lo dice con la profundidad', dev[0]!.text.includes('nested 3 deep (cap 2)'), dev[0]!.text);
  if (!r7.pass) return r7;
  return eq('con ORCA_SWARM_ACTION=stop para al ancestro, que es lo único parable', dev[0]!.stopIds, ['root']);
});

/* ── 10 · el dinero, fuera; los techos de los muertos, también ───── */

const moneyIsGone = test('un techo en dólares guardado antes del 2026-09-12 se ignora al cargarlo, y si era su único eje el techo entero se va', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-budget-money-'));
  try {
    let now = T0;
    // El libro de un ORCA anterior: dos techos en dólares, uno con minutos y
    // otro sin nada más. Escrito a mano porque la versión que los ponía ya no
    // existe, que es justamente la situación que hay que aguantar.
    writeFileSync(join(dir, 'budgets.json'), JSON.stringify({
      limits: {
        'agent:solo': { tokens: null, usd: 12, min: null },
        'agent:mixto': { tokens: null, usd: 12, min: 60 },
      },
      pendingByShortId: {}, fired: {}, activeMs: {}, retired: [],
    }));
    const b = new BudgetBook(dir, budgetConfig({} as NodeJS.ProcessEnv), { now: () => now });

    const r1 = eq('el que sólo tenía dólares desaparece', b.get({ kind: 'agent', ref: 'solo' }), null);
    if (!r1.pass) return r1;
    const r2 = eq('el que además tenía minutos conserva los minutos y pierde los dólares',
      b.get({ kind: 'agent', ref: 'mixto' }), cap({ min: 60 }));
    if (!r2.pass) return r2;

    // Y lo que se guarda de vuelta ya no lleva dinero: el eje no vuelve por
    // una relectura. Cualquier anotación reescribe el fichero entero.
    b.set({ kind: 'agent', ref: 'nuevo' }, cap({ tokens: M }));
    const onDisk = JSON.parse(readFileSync(join(dir, 'budgets.json'), 'utf8')) as { limits: Record<string, unknown> };
    return ok('el disco no vuelve a tener un eje en dólares',
      !JSON.stringify(onDisk.limits).includes('usd'), JSON.stringify(onDisk.limits));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const orphansArePruned = test('un techo cuyo sujeto ya no está en la flota se borra, pero no a la primera ni con la flota vacía', () => {
  let now = T0;
  const pruned: string[][] = [];
  const b = new BudgetBook(null, budgetConfig({} as NodeJS.ProcessEnv), { now: () => now, onPrune: (k) => pruned.push(k) });
  b.set({ kind: 'agent', ref: 'muerto' }, cap({ tokens: M }));
  b.set({ kind: 'agent', ref: 'k9' }, cap({ tokens: M }));
  b.set({ kind: 'squad', ref: 'sin-nadie' }, cap({ tokens: M }));

  // Una flota vacía es lo que se ve mientras el collector no ha hablado: ahí
  // no se poda nada, o un relevo del hub desarmaría a todo el mundo.
  b.tick({}, {}, (now += ORPHAN_GRACE + 1000));
  const r1 = eq('flota vacía: no se toca ningún techo', b.all().length, 3);
  if (!r1.pass) return r1;

  const fleet = { k9: agent({ id: 'k9', squad: 'vivo-01' }) };
  b.tick(fleet, {}, (now += 1000));
  const r2 = eq('primera pasada con flota: se marcan, no se borran', b.all().length, 3);
  if (!r2.pass) return r2;

  b.tick(fleet, {}, (now += 60_000));
  const r3 = eq('dentro del plazo tampoco', b.all().length, 3);
  if (!r3.pass) return r3;

  b.tick(fleet, {}, (now += ORPHAN_GRACE));
  const left = b.all().map((e) => `${e.scope.kind}:${e.scope.ref}`);
  const r4 = eq('pasado el plazo se van los dos huérfanos y se queda el vivo', left, ['agent:k9']);
  if (!r4.pass) return r4;
  const r5 = eq('y se dice cuáles', pruned.flat().sort(), ['agent:muerto', 'squad:sin-nadie']);
  if (!r5.pass) return r5;

  // Reaparecer cancela la marca: un agente desarchivado conserva su freno.
  b.set({ kind: 'agent', ref: 'vuelve' }, cap({ tokens: M }));
  b.tick(fleet, {}, (now += 1000));
  b.tick({ ...fleet, vuelve: agent({ id: 'vuelve' }) }, {}, (now += ORPHAN_GRACE + 1000));
  return eq('el que volvió sigue con techo', !!b.get({ kind: 'agent', ref: 'vuelve' }), true);
});

/* ── 11 · disco y parsing ─────────────────────────────────────────── */

const rearmAndPersist = test('subir el techo re-arma los avisos; los límites y lo ya avisado sobreviven al reinicio', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-budget-'));
  try {
    let now = T0;
    const b = new BudgetBook(dir, budgetConfig({} as NodeJS.ProcessEnv), { now: () => now });
    b.set({ kind: 'agent', ref: 'k9' }, cap({ tokens: M }));
    const fleet = { k9: agent({ id: 'k9', metrics: { inputTokens: 0.9 * M } }) };
    const first = b.tick(fleet, {}, (now += 1000));
    const r1 = eq('warn', kinds(first), ['warn']);
    if (!r1.pass) return r1;

    const again = new BudgetBook(dir, budgetConfig({} as NodeJS.ProcessEnv), { now: () => now });
    const r2 = eq('reiniciado: recuerda el límite', again.get({ kind: 'agent', ref: 'k9' }), cap({ tokens: M }));
    if (!r2.pass) return r2;
    const r3 = eq('reiniciado: no repite el warn', kinds(again.tick(fleet, {}, (now += 1000))), []);
    if (!r3.pass) return r3;

    again.set({ kind: 'agent', ref: 'k9' }, cap({ tokens: 1.05 * M }));
    const r4 = eq('techo nuevo: vuelve a avisar', kinds(again.tick(fleet, {}, (now += 1000))), ['warn']);
    if (!r4.pass) return r4;

    // El retiro también sobrevive: un muerto no resucita porque el hub reinicie.
    again.retire('k9');
    const third = new BudgetBook(dir, budgetConfig({} as NodeJS.ProcessEnv), { now: () => now });
    third.set({ kind: 'agent', ref: 'k9' }, cap({ tokens: 0.1 * M }));
    return eq('reiniciado: el retirado sigue retirado', kinds(third.tick(fleet, {}, (now += 1000))), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const limitParsing = test('budgetLimit acepta números, nulos y rechaza basura', () => {
  const r1 = eq('los dos ejes', budgetLimit(1000, 30), { tokens: 1000, min: 30 });
  if (!r1.pass) return r1;
  const r2 = eq('nulos', budgetLimit(null, undefined), { tokens: null, min: null });
  if (!r2.pass) return r2;
  const r3 = ok('negativo rechazado', 'error' in budgetLimit(null, -1));
  if (!r3.pass) return r3;
  return ok('y dice qué campo', (budgetLimit(-1, null) as { error: string }).error.includes('budget_tokens'));
});

/* ── 12 · en el hub: set_budget, inspect_agent, el aviso agrupado ── */

const throughTheHub = test('set_budget pone el techo, inspect_agent enseña el árbol, y una ráfaga llega a CAPCOM como UN mensaje', async () => {
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
    hub.world.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agent({ id: 'a1', callsign: 'K9', startedAt: now, updatedAt: now, metrics: { inputTokens: 1.7 * M, toolCalls: 2 } }) }, 'm1');
    // Dos subagentes Task colgando de K9: nadie les puso techo y su consumo
    // es de su ancestro.
    hub.world.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agent({ id: 'a1#s1', callsign: 'S1', subagent: true, parentId: 'a1', depth: 1, startedAt: now, updatedAt: now, metrics: { inputTokens: 0.2 * M } }) }, 'm1');
    hub.world.applyCollector({ t: 'agent:new', machineId: 'm1', agent: agent({ id: 'a1#s2', callsign: 'S2', subagent: true, parentId: 'a1#s1', depth: 2, startedAt: now, updatedAt: now, metrics: { inputTokens: 0.1 * M } }) }, 'm1');
    const ctx = hubContext(hub);

    const twice = await runTool(ctx, 'set_budget', { agent_id: 'K9', squad: 'x', mission_id: null, budget_tokens: 2 * M, budget_min: null });
    checks.push(ok('dos objetivos: rechazado', twice.isError === true, twice.result));
    const bad = await runTool(ctx, 'set_budget', { agent_id: 'K9', squad: null, mission_id: null, budget_tokens: -3, budget_min: null });
    checks.push(ok('límite negativo: rechazado', bad.isError === true, bad.result));

    const set = await runTool(ctx, 'set_budget', { agent_id: 'K9', squad: null, mission_id: null, budget_tokens: 2.5 * M, budget_min: 30 });
    checks.push(ok('set_budget por callsign, en tokens', !set.isError && set.summary === 'budget on K9: 2.5M tokens / 30 min active', set.summary));
    const parsed = JSON.parse(set.result) as { status: { tokens: number; pct: number; level: string }; policy: { unit: string } };
    checks.push(eq('devuelve el consumo del ancestro y su cría contra el techo nuevo', [parsed.status.tokens, parsed.status.pct, parsed.status.level], [2 * M, 80, 'warn']));
    checks.push(ok('y dice que las unidades son uso, nunca dinero',
      parsed.policy.unit === 'tokens, or minutes seen working; never dollars', parsed.policy.unit));

    const insp = await runTool(ctx, 'inspect_agent', { agent_id: 'K9' });
    const seen = JSON.parse(insp.result) as {
      budget: { level: string; tokens: number; live_subagents_charged: number; limits: { scope: string; limit_tokens: number }[] };
      children: string[];
      lineage: { live_descendants: number; live_subagents: number; max_generation: number; descendants: { callsign: string; generation: number }[] };
    };
    checks.push(eq('inspect_agent enseña el presupuesto en tokens', [seen.budget.level, seen.budget.limits[0]?.scope, seen.budget.limits[0]?.limit_tokens], ['warn', 'agent', 2.5 * M]));
    checks.push(eq('y dice cuántos subagentes lleva cobrados', seen.budget.live_subagents_charged, 2));
    // Lo que fallaba: children vacío con nietos vivos corriendo.
    checks.push(eq('children ya no viene vacío', seen.children, ['a1#s1']));
    checks.push(eq('y el árbol entero se ve donde se mira al agente',
      [seen.lineage.live_descendants, seen.lineage.live_subagents, seen.lineage.max_generation,
        seen.lineage.descendants.map((d) => `${d.callsign}:${d.generation}`).join(',')],
      [2, 2, 2, 'S1:1,S2:2']));

    // El sweep del hub corre cada dos segundos: el 80 % ya estaba cruzado.
    const arrived = await until(() => unrouted.some((t) => t.includes('[BUDGET 80%] K9')), 6000);
    checks.push(ok('el aviso sale por el canal de CAPCOM (sin CAPCOM, onUnrouted)', arrived, unrouted.join(' | ')));
    const feed = hub.world.state.feed.find((f) => f.source === 'BUDGET');
    checks.push(ok('y entra en el feed con nivel warn y agente', feed?.level === 'warn' && feed.agentId === 'a1' && feed.text.includes('2.0M of 2.5M tokens'), feed?.text));

    // Se pasa y se calla: el hub pide el stop. Sin collector el stop no llega,
    // y eso también se cuenta, en el feed, en vez de perderse en un log.
    now += 2 * 60_000;
    hub.world.applyCollector({ t: 'agent', machineId: 'm1', id: 'a1', patch: { metrics: { ...emptyMetrics(), inputTokens: 3 * M, toolCalls: 2 } } }, 'm1');
    const over = await until(() => unrouted.some((t) => t.includes('[BUDGET 100%] K9')), 6000);
    checks.push(ok('el 100 % avisa', over, unrouted.join(' | ')));
    const stop = await until(() => unrouted.some((t) => t.includes('[BUDGET STOP] K9')), 6000);
    checks.push(ok('y sin progreso pide el stop', stop, unrouted.join(' | ')));
    // El 100 % y el STOP salen en la misma pasada: son UN mensaje, no dos.
    const burst = unrouted.find((t) => t.includes('[BUDGET STOP] K9'))!;
    checks.push(ok('la ráfaga llega agrupada, con la cuenta y el peor caso',
      burst.startsWith('[BUDGET] 2 budget notices in one sweep') && burst.includes('1 stopped') && burst.includes('[BUDGET 100%] K9'), burst));
    const failedStop = await until(() => hub.world.state.feed.some((f) => f.source === 'BUDGET' && f.text.includes('did not go through')), 6000);
    checks.push(ok('un stop que no llega queda en el feed', failedStop));

    const removed = await runTool(ctx, 'set_budget', { agent_id: 'a1', squad: null, mission_id: null, budget_tokens: null, budget_min: null });
    checks.push(ok('todos nulos quitan el techo', !removed.isError && removed.summary === 'budget on K9: removed' && hub.budgets.get({ kind: 'agent', ref: 'a1' }) === null, removed.summary));

    return checks.find((c) => !c.pass) ?? ok('a través del hub', true, `${checks.length} checks`);
  } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const mod: TestModule = {
  suite: 'Budgets',
  tests: [
    thresholds, tokenUnit, cacheReadsNoBudget, progressSpares, linesCountAsProgress, actionWarn,
    activeTime, idleIsSilent, retiredStaysQuiet, progressIsNotInvented,
    ghostsAreSilent, adviceIsExecutable,
    envDefaults, squadShared, missionBudget,
    broodIsCharged, broodBrake,
    moneyIsGone, orphansArePruned,
    rearmAndPersist, limitParsing,
    throughTheHub,
  ],
};
export default mod;
