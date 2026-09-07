/**
 * blocks.ts — who is folded into whose block, and where the layout stands them.
 *
 * The rule is small and every clause of it is a case somebody will hit: the
 * `Task` subagent that always folds, the spawned child that steps out the
 * moment it talks to a stranger, the blocked child amber must keep visible,
 * the child that is a parent itself. And the layout has to put the folded
 * children in a tray beside the parent, at cell scale, in a cell no tile uses.
 */

import { absorbedChildren, TRAY_CELLS } from '../src/ui/field/blocks.ts';
import { CELL_SCALE, emptyLayout, layoutFleet, TILE_H, TILE_W } from '../src/ui/field/layout.ts';
import type { Agent, AgentMessage, Project } from '../src/shared/types.ts';
import { emptyRollup } from '../src/shared/types.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const PJ = 'p1';

function agent(id: string, extra: Record<string, unknown> = {}): Agent {
  return {
    id, machineId: 'm1', projectId: PJ, callsign: id.toUpperCase(), title: id, runtime: 'claude', model: 'x',
    state: 'working', block: null, parentId: null, depth: 0, childIds: [], mission: null, squad: null, lead: false,
    origin: 'orca', startedAt: 1, updatedAt: 1, uptimeMs: 0, tool: null, toolDetail: null, lastPrompt: null, lastSay: null,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, tokensPerSec: 0,
      linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    ...extra,
  } as unknown as Agent;
}

function msg(from: string, to: string | null, extra: Record<string, unknown> = {}): AgentMessage {
  return { id: `${from}>${to}`, fromAgentId: from, toAgentId: to, scope: to ? 'agent' : 'fleet', kind: 'notice', at: 1, ...extra } as unknown as AgentMessage;
}

const project = {
  id: PJ, machineId: 'm1', slug: 'p', name: 'p', path: '/p', code: 'PP', gitBranch: 'main', gitDirty: false,
  keyNames: [], sessionIds: [], rollup: emptyRollup(),
} as unknown as Project;

export default {
  suite: 'blocks',
  tests: [
    test('a Task subagent folds; a spawned child folds until it talks to a stranger', () => {
      const agents = [
        agent('p'),
        agent('t', { parentId: 'p', subagent: true }),
        agent('q', { parentId: 'p' }),
        agent('r', { parentId: 'p' }),
        agent('x'),
      ];
      const quiet = absorbedChildren(agents, [msg('q', 'p')]);
      const loud = absorbedChildren(agents, [msg('q', 'p'), msg('r', 'x')]);
      const bcast = absorbedChildren(agents, [msg('r', null)]);
      return eq('a Task subagent folds; a spawned child folds until it talks to a stranger',
        [[...quiet.keys()].sort(), [...loud.keys()].sort(), [...bcast.keys()].sort()],
        [['q', 'r', 't'], ['q', 't'], ['q', 't']]);
    }),

    test('never folded: blocked on a person, a parent itself, a squad member, another project, an external child', () => {
      const agents = [
        agent('p'),
        agent('b', { parentId: 'p', subagent: true, state: 'blocked', block: { kind: 'escalation', summary: '?', since: 1 } }),
        agent('w', { parentId: 'p', subagent: true, state: 'blocked', block: { kind: 'peer', summary: '?', since: 1, waitingOn: 'p' } }),
        agent('g', { parentId: 'p' }),
        agent('gg', { parentId: 'g', subagent: true }),
        agent('s', { parentId: 'p', squad: 'audit' }),
        agent('o', { parentId: 'p', projectId: 'p2' }),
        agent('e', { parentId: 'p', origin: 'external' }),
      ];
      const got = absorbedChildren(agents, []);
      return eq('never folded: blocked on a person, a parent itself, a squad member, another project, an external child',
        [...got.entries()].sort(), [['gg', 'g'], ['w', 'p']]);
    }),

    test('the layout stands folded children in a tray beside the parent, at cell scale, in a cell of their own', () => {
      const kids = Array.from({ length: TRAY_CELLS + 1 }, (_, i) => agent(`k${i}`, { parentId: 'p', subagent: true, startedAt: 10 + i }));
      const agents = [agent('p'), ...kids, agent('z', { startedAt: 99 })];
      const absorbed = absorbedChildren(agents, []);
      const lay = layoutFleet(agents, new Map([[PJ, project]]), new Map(), emptyLayout(), { kind: 'field' }, new Map(), new Map(), absorbed);
      const p = lay.spots.get('p')!, z = lay.spots.get('z')!, k0 = lay.spots.get('k0')!, k6 = lay.spots.get('k6')!;
      const trays = lay.trays.filter((t) => t.parentId === 'p');
      const t0 = trays[0]!, t1 = trays[1]!;
      const inside = (s: { x: number; y: number }, t: { cx: number; cy: number; hw: number; hh: number }) =>
        Math.abs(s.x - t.cx) <= t.hw && Math.abs(s.y - t.cy) <= t.hh;
      // No tile shares a cell with a tray: tiles and trays are all at least a tile apart.
      const cellsApart = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        Math.abs(a.x - b.x) >= TILE_W - 1e-9 || Math.abs(a.y - b.y) >= TILE_H - 1e-9;
      const tiles = [p, z, { x: t0.cx, y: t0.cy }, { x: t1.cx, y: t1.cy }];
      let apart = true;
      for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) if (!cellsApart(tiles[i]!, tiles[j]!)) apart = false;
      return ok('the layout stands folded children in a tray beside the parent, at cell scale, in a cell of their own',
        trays.length === 2 && t0.ids.length === TRAY_CELLS && t1.ids.length === 1
        && k0.scale === CELL_SCALE && k0.trayOf === 'p' && inside(k0, t0) && inside(k6, t1)
        && p.scale === 1 && p.trayOf === null && apart
        && lay.regions[0]!.count === agents.length,
        `trays ${trays.length} (${t0?.ids.length}, ${t1?.ids.length}), k0 scale ${k0?.scale} in tray ${inside(k0, t0)}, apart ${apart}, count ${lay.regions[0]?.count}`);
    }),

    test('a folded child the operator pinned is a tile again', () => {
      const agents = [agent('p'), agent('k', { parentId: 'p', subagent: true })];
      const absorbed = absorbedChildren(agents, []);
      const placements = new Map([['k', { agentId: 'k', x: 5, y: 5, pinned: true, at: 1 }]]);
      const lay = layoutFleet(agents, new Map([[PJ, project]]), placements as never, emptyLayout(), { kind: 'field' }, new Map(), new Map(), absorbed);
      const k = lay.spots.get('k')!;
      return ok('a folded child the operator pinned is a tile again', k.scale === 1 && k.trayOf === null && k.pinned && lay.trays.length === 0,
        `scale ${k.scale}, trayOf ${k.trayOf}, trays ${lay.trays.length}`);
    }),
  ],
} satisfies TestModule;
