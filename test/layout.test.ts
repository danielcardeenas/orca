/**
 * Layout: where a squad stands once the operator has moved it.
 *
 * Three things that break in silence: a moved squad must carry every member
 * and its own box by the same offset; a member the operator pinned by hand
 * must stay where the hand left it; and a squad nobody touched must stand
 * exactly where it did before squad placements existed.
 */

import { emptyLayout, layoutFleet, squadKey, type RegionPlacement, type SquadPlacement } from '../src/ui/field/layout.ts';
import type { Agent, Placement, Project } from '../src/shared/types.ts';
import { emptyRollup } from '../src/shared/types.ts';
import { ok, test, type TestModule } from './harness.ts';

const PJ = 'p1';

function agent(id: string, extra: Record<string, unknown> = {}): Agent {
  return {
    id, machineId: 'm1', projectId: PJ, sessionId: `s_${id}`, callsign: id.toUpperCase(), title: '',
    runtime: 'claude', model: 'x', state: 'working', block: null, parentId: null, startedAt: 1, lastActivity: 1,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, tokensPerSec: 0,
      linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    placement: null,
    ...extra,
  } as unknown as Agent;
}

function fleet(): { agents: Agent[]; projects: Map<string, Project> } {
  const agents = [
    agent('a1'), agent('a2'),
    agent('q1', { squad: 'audit', lead: true }),
    agent('q2', { squad: 'audit' }),
    agent('q3', { squad: 'audit' }),
  ];
  const project = {
    id: PJ, machineId: 'm1', slug: 'p', name: 'p', path: '/p', code: 'PP', gitBranch: 'main', gitDirty: false,
    keyNames: [], sessionIds: [], rollup: emptyRollup(),
  } as unknown as Project;
  return { agents, projects: new Map([[PJ, project]]) };
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

export default {
  suite: 'layout',
  tests: [
    test('a squad nobody touched stands where it always did', () => {
      const { agents, projects } = fleet();
      const a = layoutFleet(agents, projects, new Map(), emptyLayout());
      const b = layoutFleet(agents, projects, new Map(), emptyLayout(), { kind: 'field' }, new Map());
      for (const s of a.spots.values()) {
        const t = b.spots.get(s.id)!;
        if (t.tx !== s.tx || t.ty !== s.ty) return ok('same spot', false, `${s.id} moved`);
      }
      const q = a.regions[0]!.squads[0]!;
      return ok('a squad nobody touched stands where it always did', q.name === 'audit' && !q.moved,
        `${a.spots.size} spots, squad "${q.name}" at (${q.cx.toFixed(2)}, ${q.cy.toFixed(2)})`);
    }),

    test('a moved squad carries its members and its box by one offset', () => {
      const { agents, projects } = fleet();
      const before = layoutFleet(agents, projects, new Map(), emptyLayout());
      const q0 = before.regions[0]!.squads[0]!;
      const placed = new Map<string, SquadPlacement>([[squadKey(PJ, 'audit'), { projectId: PJ, name: 'audit', x: q0.cx + 5, y: q0.cy - 3, at: 1 }]]);
      const after = layoutFleet(agents, projects, new Map(), emptyLayout(), { kind: 'field' }, placed);
      const q1 = after.regions[0]!.squads[0]!;
      if (!q1.moved) return ok('moved flag', false, 'the block should know it was moved');
      if (!close(q1.cx, q0.cx + 5) || !close(q1.cy, q0.cy - 3)) return ok('box', false, `box at (${q1.cx}, ${q1.cy})`);
      if (q1.hw !== q0.hw || q1.hh !== q0.hh) return ok('box size', false, 'the box changed size');
      for (const id of ['q1', 'q2', 'q3']) {
        const s0 = before.spots.get(id)!, s1 = after.spots.get(id)!;
        if (!close(s1.tx, s0.tx + 5) || !close(s1.ty, s0.ty - 3)) return ok('member', false, `${id} did not move with the block`);
        if (s1.pinned) return ok('member', false, `${id} was pinned by a squad move`);
      }
      for (const id of ['a1', 'a2']) {
        const s0 = before.spots.get(id)!, s1 = after.spots.get(id)!;
        if (s1.tx !== s0.tx || s1.ty !== s0.ty) return ok('stranger', false, `${id} moved and is not in the squad`);
      }
      return ok('a moved squad carries its members and its box by one offset', true, 'three members and the outline moved by (+5, −3); two strangers stayed');
    }),

    test('a member the operator pinned keeps its own spot inside a moved squad', () => {
      const { agents, projects } = fleet();
      const before = layoutFleet(agents, projects, new Map(), emptyLayout());
      const q0 = before.regions[0]!.squads[0]!;
      const pin: Placement = { agentId: 'q2', x: -40, y: 40, z: 0, pinned: true, at: 1 };
      const placed = new Map<string, SquadPlacement>([[squadKey(PJ, 'audit'), { projectId: PJ, name: 'audit', x: q0.cx + 2, y: q0.cy, at: 1 }]]);
      const after = layoutFleet(agents, projects, new Map([['q2', pin]]), emptyLayout(), { kind: 'field' }, placed);
      const s = after.spots.get('q2')!;
      const q1 = after.regions[0]!.squads[0]!;
      return ok('a member the operator pinned keeps its own spot inside a moved squad',
        s.tx === -40 && s.ty === 40 && s.pinned && q1.count === 3 && close(q1.cx, q0.cx + 2),
        `q2 at (${s.tx}, ${s.ty}) pinned=${s.pinned}; block count ${q1.count} at cx ${q1.cx.toFixed(2)}`);
    }),

    test('a moved region carries everything in it to the placement', () => {
      const { agents, projects } = fleet();
      const before = layoutFleet(agents, projects, new Map(), emptyLayout());
      const r0 = before.regions[0]!;
      const regions = new Map<string, RegionPlacement>([[PJ, { projectId: PJ, x: r0.cx + 30, y: r0.cy - 12, at: 1 }]]);
      const after = layoutFleet(agents, projects, new Map(), emptyLayout(), { kind: 'field' }, new Map(), regions);
      const r1 = after.regions[0]!;
      if (!r1.moved || !close(r1.cx, r0.cx + 30) || !close(r1.cy, r0.cy - 12)) return ok('region', false, `region at (${r1.cx}, ${r1.cy}) moved=${r1.moved}`);
      for (const s0 of before.spots.values()) {
        const s1 = after.spots.get(s0.id)!;
        if (!close(s1.tx, s0.tx + 30) || !close(s1.ty, s0.ty - 12)) return ok('tile', false, `${s0.id} did not move with the region`);
      }
      const q0 = r0.squads[0]!, q1 = r1.squads[0]!;
      if (!close(q1.cx, q0.cx + 30) || !close(q1.cy, q0.cy - 12)) return ok('squad', false, 'the squad block did not move with the region');
      return ok('a moved region carries everything in it to the placement', true, `${after.spots.size} tiles and one squad moved by (+30, −12)`);
    }),

    test('the deck ignores squad placements', () => {
      const { agents, projects } = fleet();
      const placed = new Map<string, SquadPlacement>([[squadKey(PJ, 'audit'), { projectId: PJ, name: 'audit', x: 99, y: 99, at: 1 }]]);
      const deck = layoutFleet(agents, projects, new Map(), emptyLayout(), { kind: 'deck', sort: 'state' }, placed);
      const onGrid = [...deck.spots.values()].every((s) => Math.abs(s.tx) < 20 && Math.abs(s.ty) < 20);
      return ok('the deck ignores squad placements', deck.regions.length === 0 && onGrid, `${deck.spots.size} tiles on the deck grid, none at (99, 99)`);
    }),
  ],
} satisfies TestModule;
