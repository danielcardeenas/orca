/**
 * El parte de una misión: `shared/debrief.ts`, `missionLead` y las rutas.
 *
 * Lo que merece guarda aquí es lo que separa un parte de una maqueta:
 *
 *  - un número que nadie midió sale `null`, nunca `0`, y `measured` dice de
 *    cuántos agentes hay registro — la consola tiene que poder decir «no lo
 *    apuntó nadie» en vez de enseñar un cero que parece un dato;
 *  - el `end` del diario gana a la flota viva, porque es definitivo, y la
 *    flota viva rellena lo que el diario todavía no tiene;
 *  - un agente archivado sigue en el parte: es exactamente el caso para el
 *    que existe, porque una misión se abre cuando su flota ya no está;
 *  - quién es el líder, con el vivo por delante del terminado, y `live`
 *    viajando con él para que nadie mande un mensaje a una sesión muerta;
 *  - qué rutas se reportaron, resueltas contra el proyecto de quien las
 *    escribió y sin adivinar las que no se pueden resolver.
 */

import { buildDebrief, type DebriefEntry, type DebriefFleetAgent } from '../src/shared/debrief.ts';
import { missionBrief, missionResult, type CapcomMission, type MissionMessage } from '../src/shared/missions.ts';
import { missionHeadline, missionLead } from '../src/ui/hud/mission-status.ts';
import { reportedFiles } from '../src/ui/windows/kinds/mission.ts';
import type { Agent } from '../src/shared/types.ts';
import { eq, ok, test, type TestModule, type TestResult } from './harness.ts';

/** Varias comprobaciones, un resultado: la primera que falle, o la última que pasó. */
function all(...rs: TestResult[]): TestResult { return rs.find((r) => !r.pass) ?? rs[rs.length - 1]!; }

const T0 = 1_800_000_000_000;

function msg(role: MissionMessage['role'], text: string, at = T0, agentId?: string): MissionMessage {
  return { id: `m_${at}_${role}_${text.length}`, role, text, at, ...(agentId ? { agentId } : {}) };
}

function mission(o: Partial<CapcomMission> = {}): CapcomMission {
  return {
    id: 'mission_x', title: 'Ship the checkout rewrite', status: 'completed',
    createdAt: T0 - 100_000, updatedAt: T0, agentIds: [], messages: [], ...o,
  };
}

function agent(id: string, o: Partial<Agent> = {}): Agent {
  return {
    id, callsign: id.toUpperCase(), state: 'working', role: 'worker', squad: null, lead: false,
    startedAt: T0 - 50_000, updatedAt: T0, projectId: 'p1', runtime: 'claude', model: 'claude-sonnet-5',
    metrics: { linesAdded: 4, linesRemoved: 1, costUSD: 0.25, toolCalls: 9 },
    ...o,
  } as unknown as Agent;
}

function launch(agentId: string, o: Partial<DebriefEntry> = {}): DebriefEntry {
  return { at: T0 - 40_000, kind: 'launch', agentId, callsign: agentId.toUpperCase(), brief: `do ${agentId}`, runtime: 'claude', ...o };
}
function end(agentId: string, o: Partial<DebriefEntry> = {}): DebriefEntry {
  return {
    at: T0 - 1_000, kind: 'end', agentId, callsign: agentId.toUpperCase(), state: 'done',
    costUSD: 1.5, durationMs: 60_000, lines: { added: 100, removed: 20 }, toolCalls: 30, lastSay: 'done', ...o,
  };
}

const NOBODY = () => undefined;

const mod: TestModule = {
  suite: 'debrief',
  tests: [
    test('buildDebrief: un agente archivado sigue en el parte, con lo que el diario guardó', () => {
      const m = mission({ agentIds: ['a1'] });
      const d = buildDebrief(m, [launch('a1'), end('a1')], NOBODY);
      const a = d.agents[0]!;
      return all(
        eq('quién', [a.id, a.callsign, a.state, a.live, a.final], ['a1', 'A1', null, false, 'done']),
        eq('qué cambió', [a.linesAdded, a.linesRemoved, a.costUSD, a.durationMs], [100, 20, 1.5, 60_000]),
        eq('por qué existió', a.brief, 'do a1'),
      );
    }),

    test('buildDebrief: sin `end` anotado, lo que no se midió es null y no cero', () => {
      const m = mission({ agentIds: ['a1'] });
      const d = buildDebrief(m, [launch('a1')], NOBODY);
      const a = d.agents[0]!;
      return all(
        eq('sin medir', [a.linesAdded, a.linesRemoved, a.costUSD, a.durationMs, a.toolCalls, a.final],
          [null, null, null, null, null, null]),
        eq('measured', d.totals.measured, 0),
        eq('agentes', d.totals.agents, 1),
      );
    }),

    test('buildDebrief: mientras corre, la flota viva mide; cuando acaba, gana el `end`', () => {
      const m = mission({ agentIds: ['a1'] });
      const live = (id: string): DebriefFleetAgent | undefined => (id === 'a1' ? agent('a1') as unknown as DebriefFleetAgent : undefined);
      const running = buildDebrief(m, [launch('a1')], live).agents[0]!;
      const done = buildDebrief(m, [launch('a1'), end('a1')], live).agents[0]!;
      return all(
        eq('corriendo lee el mundo', [running.linesAdded, running.costUSD, running.live], [4, 0.25, true]),
        eq('acabado lee el diario', [done.linesAdded, done.costUSD], [100, 1.5]),
      );
    }),

    test('buildDebrief: un agente que sólo conoce el diario entra igual', () => {
      const d = buildDebrief(mission({ agentIds: [] }), [launch('ghost'), end('ghost')], NOBODY);
      return eq('ids', d.agents.map((a) => a.id), ['ghost']);
    }),

    test('buildDebrief: los asignados van primero, en el orden en que se asignaron', () => {
      const m = mission({ agentIds: ['a2', 'a1'] });
      const d = buildDebrief(m, [launch('extra'), launch('a1'), launch('a2')], NOBODY);
      return eq('orden', d.agents.map((a) => a.id), ['a2', 'a1', 'extra']);
    }),

    test('buildDebrief: dos `launch` del mismo agente no lo duplican; manda el primero', () => {
      const m = mission({ agentIds: ['a1'] });
      const d = buildDebrief(m, [launch('a1', { at: T0 - 10_000, brief: 'late sweep' }), launch('a1', { brief: 'the real one' })], NOBODY);
      return all(
        eq('uno solo', d.agents.length, 1),
        eq('brief', d.agents[0]!.brief, 'the real one'),
      );
    }),

    test('buildDebrief: los totales suman lo medido y cuentan cómo acabó cada uno', () => {
      const m = mission({ agentIds: ['a1', 'a2', 'a3'] });
      const d = buildDebrief(m, [
        launch('a1'), end('a1'),
        launch('a2'), end('a2', { state: 'dead', lines: { added: 3, removed: 0 }, costUSD: 0.5, durationMs: 1_000 }),
        launch('a3'),
      ], NOBODY);
      return all(
        eq('líneas', [d.totals.linesAdded, d.totals.linesRemoved], [103, 20]),
        eq('final', [d.totals.done, d.totals.dead], [1, 1]),
        eq('medidos de tres', [d.totals.measured, d.totals.agents], [2, 3]),
        eq('coste', Number(d.totals.costUSD.toFixed(2)), 2),
      );
    }),

    test('buildDebrief: los aterrizajes salen, el más nuevo primero, con su rama', () => {
      const d = buildDebrief(mission(), [
        { at: T0 - 5_000, kind: 'landing', agentId: 'a1', callsign: 'A1', branch: 'orca/one', target: 'main', ok: true },
        { at: T0 - 1_000, kind: 'landing', agentId: 'a2', callsign: 'A2', branch: 'orca/two', ok: false, detail: 'conflicts' },
      ], NOBODY);
      return all(
        eq('orden', d.landings.map((l) => l.branch), ['orca/two', 'orca/one']),
        eq('el que falló lo dice', [d.landings[0]!.ok, d.landings[0]!.detail], [false, 'conflicts']),
      );
    }),

    test('buildDebrief: una entrada de otra misión no se cuela', () => {
      const d = buildDebrief(mission(), [launch('a1', { missionId: 'mission_other' }), launch('a2', { missionId: 'mission_x' })], NOBODY);
      return eq('ids', d.agents.map((a) => a.id), ['a2']);
    }),

    /* ── Lo que la conversación dice ────────────────────────────── */

    test('missionBrief: el encargo es la primera palabra del operador, entera', () => {
      const m = mission({ messages: [msg('capcom', 'framing', T0 - 10), msg('human', 'Ship it behind a flag', T0), msg('human', 'and log it', T0 + 1)] });
      return eq('brief', missionBrief(m)?.text, 'Ship it behind a flag');
    }),

    test('missionBrief: sin operador vale la apertura de CAPCOM; sin nada, null', () => {
      const opened = mission({ messages: [msg('capcom', '[OR] audit the retention limits')] });
      return all(
        eq('abierta por capcom', missionBrief(opened)?.text, '[OR] audit the retention limits'),
        eq('vacía', missionBrief(mission()), null),
      );
    }),

    test('missionResult: el resultado es la última palabra de CAPCOM; lo anterior es camino', () => {
      const m = mission({ messages: [
        msg('human', 'Ship it', T0), msg('capcom', 'launched two', T0 + 1),
        msg('agent', 'tests green', T0 + 2, 'a1'), msg('capcom', 'shipped, 3 suites green', T0 + 3),
      ] });
      const r = missionResult(m);
      return all(
        eq('final', r.final?.text, 'shipped, 3 suites green'),
        eq('progreso', r.progress.map((x) => x.text), ['launched two']),
        eq('flota', r.fromFleet.map((x) => x.text), ['tests green']),
      );
    }),

    test('missionResult: una misión cerrada sin reportar no inventa un resultado', () => {
      const m = mission({ messages: [msg('human', 'Ship it')] });
      return eq('final', missionResult(m).final, null);
    }),

    test('missionHeadline: el título entero, con el marcador viejo tratado como el de hoy', () => {
      const m = mission({ title: 'New task', messages: [msg('human', 'Rediseñar el selector de modelo de CAPCOM entero')] });
      return eq('headline', missionHeadline(m), 'Rediseñar el selector de modelo de CAPCOM entero');
    }),

    /* ── Quién manda ────────────────────────────────────────────── */

    test('missionLead: un asignado que lidera su squad es el líder, y se dice si sigue vivo', () => {
      const lead = agent('a1', { squad: 'audit-01', lead: true });
      const m = mission({ agentIds: ['a2', 'a1'] });
      const found = missionLead(m, (id) => (id === 'a1' ? lead : id === 'a2' ? agent('a2') : undefined));
      return eq('quién', [found?.agent.id, found?.via, found?.live], ['a1', 'mission', true]);
    }),

    test('missionLead: entre dos líderes, el vivo gana al terminado', () => {
      const dead = agent('a1', { squad: 's', lead: true, state: 'done', updatedAt: T0 + 9_000 });
      const live = agent('a2', { squad: 's', lead: true, state: 'blocked', updatedAt: T0 });
      const m = mission({ agentIds: ['a1', 'a2'] });
      const found = missionLead(m, (id) => (id === 'a1' ? dead : live));
      return eq('quién', [found?.agent.id, found?.live], ['a2', true]);
    }),

    test('missionLead: sin líder asignado, el del squad de la misión; y viaja que terminó', () => {
      const lead = agent('sq', { squad: 'mission-03', lead: true, state: 'done' });
      const m = mission({ agentIds: ['a2'], squads: ['mission-03'] });
      const found = missionLead(m, (id) => (id === 'a2' ? agent('a2') : undefined), [agent('a2'), lead]);
      return eq('quién', [found?.agent.id, found?.via, found?.live], ['sq', 'squad', false]);
    }),

    test('missionLead: CAPCOM no lidera una misión, y sin nadie no se inventa uno', () => {
      const cap = agent('cap', { role: 'capcom', squad: 'mission-03', lead: true });
      const m = mission({ agentIds: ['cap'], squads: ['mission-03'] });
      return all(
        eq('nadie', missionLead(m, (id) => (id === 'cap' ? cap : undefined), [cap]), null),
        eq('sin squads tampoco', missionLead(mission({ agentIds: ['a2'] }), () => agent('a2')), null),
      );
    }),

    /* ── Qué se puede abrir ─────────────────────────────────────── */

    test('reportedFiles: una ruta absoluta y una relativa con proyecto se pueden abrir', () => {
      const m = mission({ messages: [
        msg('agent', 'Dejé el informe en /Users/dan/x/out.md y toqué src/ui/main.ts:543', T0, 'a1'),
      ] });
      const files = reportedFiles(m, (id) => (id === 'a1' ? '/Users/dan/proj' : null));
      return all(
        eq('rutas', files.map((f) => f.path), ['/Users/dan/x/out.md', '/Users/dan/proj/src/ui/main.ts']),
        eq('la línea viaja', files[1]!.line, 543),
        eq('a quién atribuirla', files[1]!.agentId, 'a1'),
      );
    }),

    test('reportedFiles: una relativa sin proyecto conocido no se adivina', () => {
      const m = mission({ messages: [msg('human', 'mira src/ui/main.ts', T0)] });
      return eq('nada', reportedFiles(m, () => null).length, 0);
    }),

    test('reportedFiles: la misma ruta dicha dos veces se lista una', () => {
      const m = mission({ messages: [
        msg('capcom', 'escrito en /tmp/a/report.md', T0),
        msg('capcom', 'y otra vez /tmp/a/report.md', T0 + 1),
      ] });
      const files = reportedFiles(m, () => null);
      return all(
        eq('una', files.map((f) => f.path), ['/tmp/a/report.md']),
        ok('la primera mención manda', files[0]!.at === T0),
      );
    }),

    test('reportedFiles: una conversación sin rutas devuelve una lista vacía, no una excusa', () => {
      const m = mission({ messages: [msg('human', 'ship it'), msg('capcom', 'done and verified')] });
      return eq('vacía', reportedFiles(m, () => null), []);
    }),
  ],
};

export default mod;
