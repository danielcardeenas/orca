/**
 * windows/mission-crew.ts — quién está en una misión y bajo quién.
 *
 * Lo que merece guarda: que el mundo vivo mande en lo que cambia y el diario
 * en lo que ya no está (un agente que voló y no está en la flota sigue en la
 * nómina, sin baldosa); que la jerarquía sea proyecto → squad → miembros con
 * el líder arriba y los sueltos detrás de los squads; que CAPCOM no sea
 * tripulación; y que una medida que nadie tomó salga `null` y no 0.
 */

import type { CapcomMission } from '../src/shared/missions.ts';
import type { DebriefAgent, MissionDebrief } from '../src/shared/debrief.ts';
import type { Agent, AgentState } from '../src/shared/types.ts';
import { crewWord, missionCrew, squadMembers } from '../src/ui/windows/mission-crew.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const T0 = 1_800_000_000_000;

function agent(id: string, state: AgentState, extra: Partial<Agent> = {}): Agent {
  return {
    id, callsign: id.toUpperCase(), state, role: 'worker', projectId: 'p1',
    squad: null, lead: false, runtime: 'claude', updatedAt: T0, startedAt: T0 - 1000, ...extra,
  } as Agent;
}

function filed(id: string, extra: Partial<DebriefAgent> = {}): DebriefAgent {
  return {
    id, callsign: id.toUpperCase(), state: null, live: false, lead: false, squad: null,
    runtime: null, model: null, projectId: null, project: null, brief: null, final: null,
    startedAt: null, endedAt: null, lastSay: null, linesAdded: null, linesRemoved: null,
    costUSD: null, durationMs: null, toolCalls: null, worktree: null, branch: null, ...extra,
  };
}

function parte(agents: DebriefAgent[]): MissionDebrief {
  return {
    missionId: 'm', journal: true, agents, landings: [],
    totals: { agents: agents.length, done: 0, dead: 0, linesAdded: 0, linesRemoved: 0, costUSD: 0, durationMs: 0, measured: 0 },
  };
}

function mission(agentIds: string[], squads: string[] = []): CapcomMission {
  return {
    id: 'm', title: 'Ship it', status: 'active', createdAt: T0 - 10_000, updatedAt: T0,
    agentIds, messages: [], ...(squads.length ? { squads } : {}),
  };
}

const PROJECTS: Record<string, { name: string }> = { p1: { name: 'axolots' }, p2: { name: 'orca' } };
const projectOf = (id: string) => PROJECTS[id];

const mod: TestModule = {
  suite: 'mission-crew',
  tests: [
    test('la jerarquía es proyecto → squad → miembros, con el líder arriba', () => {
      const fleet: Record<string, Agent> = {
        a1: agent('a1', 'working', { squad: 'audit-01' }),
        a2: agent('a2', 'thinking', { squad: 'audit-01', lead: true }),
        a3: agent('a3', 'idle', { projectId: 'p2' }),
      };
      const crew = missionCrew(mission(['a1', 'a2', 'a3']), null, (id) => fleet[id], projectOf);
      const shape = crew.regions.map((r) => [r.name, r.squads.map((g) => [g.squad, squadMembers(g).map((m) => m.callsign)])]);
      return eq('shape', shape, [
        ['axolots', [['audit-01', ['A2', 'A1']]]],
        ['orca', [[null, ['A3']]]],
      ]);
    }),

    test('los sueltos van detrás de los squads de su isla, nunca en medio', () => {
      const fleet: Record<string, Agent> = {
        solo: agent('solo', 'working'),
        m1: agent('m1', 'working', { squad: 'sq' }),
      };
      const crew = missionCrew(mission(['solo', 'm1']), null, (id) => fleet[id], projectOf);
      return eq('groups', crew.regions[0]?.squads.map((g) => g.squad), ['sq', null]);
    }),

    test('un agente que voló y ya no está en la flota sigue en la nómina, sin baldosa', () => {
      const crew = missionCrew(
        mission(['gone']),
        parte([filed('gone', { projectId: 'p1', squad: 'sq', final: 'done', linesAdded: 12, linesRemoved: 3, costUSD: 0.42 })]),
        () => undefined,
        projectOf,
      );
      const m = crew.regions[0]?.squads[0]?.members[0];
      return ok('member', !!m && m.onField === false && m.final === 'done' && m.linesAdded === 12 && crew.onField.length === 0
        && crew.total === 1 && crew.live === 0, JSON.stringify(m));
    }),

    test('el mundo manda en el estado y el diario en las medidas', () => {
      const fleet: Record<string, Agent> = { a1: agent('a1', 'working', { squad: 'sq' }) };
      const crew = missionCrew(
        mission(['a1']),
        parte([filed('a1', { state: 'idle', live: false, squad: null, costUSD: 1.5, linesAdded: 40, linesRemoved: 1 })]),
        (id) => fleet[id],
        projectOf,
      );
      const m = squadMembers(crew.regions[0]!.squads[0]!)[0]!;
      return eq('read', [m.state, m.live, m.squad, m.costUSD, m.linesAdded], ['working', true, 'sq', 1.5, 40]);
    }),

    test('una medida que nadie tomó es null, nunca 0', () => {
      const fleet: Record<string, Agent> = { a1: agent('a1', 'working') };
      const crew = missionCrew(mission(['a1']), null, (id) => fleet[id], projectOf);
      const m = crew.regions[0]!.squads[0]!.members[0]!;
      return eq('measures', [m.linesAdded, m.linesRemoved, m.costUSD, m.durationMs], [null, null, null, null]);
    }),

    test('CAPCOM no es tripulación aunque esté asignado a la misión', () => {
      const fleet: Record<string, Agent> = {
        cap: agent('cap', 'thinking', { role: 'capcom', callsign: 'CAPCOM' }),
        a1: agent('a1', 'working'),
      };
      const crew = missionCrew(mission(['cap', 'a1']), null, (id) => fleet[id], projectOf);
      return eq('ids', crew.ids, ['a1']);
    }),

    test('el sigilo de un miembro sale de su squad, y de su id cuando no tiene', () => {
      const fleet: Record<string, Agent> = {
        a1: agent('a1', 'working', { squad: 'audit-01' }),
        a2: agent('a2', 'working'),
      };
      const crew = missionCrew(mission(['a1', 'a2']), null, (id) => fleet[id], projectOf);
      const seeds = crew.regions[0]!.squads.flatMap((g) => squadMembers(g).map((m) => m.seed));
      return eq('seeds', seeds, ['audit-01', 'a2']);
    }),

    test('un agente que sólo conoce el diario se une a los asignados, detrás', () => {
      const fleet: Record<string, Agent> = { a1: agent('a1', 'working') };
      const crew = missionCrew(
        mission(['a1']),
        parte([filed('a1'), filed('late', { projectId: 'p1', final: 'dead' })]),
        (id) => fleet[id],
        projectOf,
      );
      return eq('ids', crew.ids, ['a1', 'late']);
    }),

    test('sin proyecto en ninguna de las dos fuentes, la isla se llama por su nombre y no se inventa', () => {
      const crew = missionCrew(mission(['x']), parte([filed('x')]), () => undefined, projectOf);
      return eq('region', [crew.regions[0]?.projectId, crew.regions[0]?.name], [null, 'NO PROJECT']);
    }),

    test('los contadores: vivos, totales, squads y quién queda en el campo', () => {
      const fleet: Record<string, Agent> = {
        a1: agent('a1', 'working', { squad: 'sq' }),
        a2: agent('a2', 'done', { squad: 'sq' }),
        a3: agent('a3', 'dead', { projectId: 'p2' }),
      };
      const crew = missionCrew(mission(['a1', 'a2', 'a3', 'gone']), parte([filed('gone', { projectId: 'p2' })]), (id) => fleet[id], projectOf);
      return eq('counts', [crew.live, crew.total, crew.squads, crew.onField], [1, 4, ['sq'], ['a1', 'a2', 'a3']]);
    }),

    test('crewWord: el estado mientras vive, el final cuando acabó, GONE cuando nadie lo sabe', () => {
      const words = [
        crewWord({ live: true, final: null, state: 'working' }),
        crewWord({ live: true, final: null, state: null }),
        crewWord({ live: false, final: 'dead', state: 'idle' }),
        crewWord({ live: false, final: null, state: 'idle' }),
        crewWord({ live: false, final: null, state: null }),
      ];
      return eq('words', words, ['WORKING', 'LIVE', 'DEAD', 'IDLE', 'GONE']);
    }),

    test('un agente del mundo que ya terminó no necesita el diario para decir cómo acabó', () => {
      const fleet: Record<string, Agent> = { a1: agent('a1', 'done'), a2: agent('a2', 'dead') };
      const crew = missionCrew(mission(['a1', 'a2']), null, (id) => fleet[id], projectOf);
      const finals = crew.regions[0]!.squads[0]!.members.map((m) => m.final);
      return eq('finals', finals, ['done', 'dead']);
    }),
  ],
};

export default mod;
