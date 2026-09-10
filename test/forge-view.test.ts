/** FORGE labels are pure projections of existing agents and mission debt. */
import assert from 'node:assert/strict';
import { forgeViews } from '../src/ui/field/forge.ts';
import type { Agent } from '../src/shared/types.ts';
import type { CapcomMission } from '../src/shared/missions.ts';
import { test, ok, type TestModule } from './harness.ts';

function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return { id, callsign: id, machineId: 'fixture', projectId: 'orca', state: 'idle',
    squad: 'forge-canvas', lead: false, startedAt: 1, updatedAt: 1,
    tool: null, toolDetail: null, ...patch } as Agent;
}
function mission(patch: Partial<CapcomMission> = {}): CapcomMission {
  return { id: 'mission_fixture', title: 'FORGE', status: 'active', createdAt: 1, updatedAt: 1,
    agentIds: ['lead'], squads: ['forge-canvas'], messages: [], ...patch };
}
function view(agents: Agent[], m = mission()) { return forgeViews(agents, { [m.id]: m }).get('lead')!; }
const lead = () => agent('lead', { lead: true });
const result = { id: 'report', role: 'agent' as const, agentId: 'lead', at: 2, text: 'Ready for review' };

export default {
  suite: 'forge-view',
  tests: [
    test('label precedence follows blocked, checking, work, result debt and idle', () => {
      const l = lead(), worker = agent('worker', { state: 'working' });
      const checker = agent('checker', { state: 'working', tool: 'exec_command', toolDetail: 'npm run typecheck' });
      const blocked = agent('blocked', { state: 'blocked' });
      const m = mission({ messages: [result] });
      assert.equal(view([l, worker, checker, blocked], m).label, 'BLOCKED');
      assert.equal(view([l, worker, checker], m).label, 'VERIFYING');
      assert.equal(view([l, worker], m).label, 'WORKING');
      assert.equal(view([l], m).label, 'WAITING CAPCOM');
      assert.equal(view([l]).label, 'WAITING');
      assert.equal(view([l]).active, true);
      return ok('priority reflects current observations without claiming checks passed', true);
    }),
    test('only executing check commands count as verification', () => {
      for (const [tool, toolDetail] of [['bash', 'pnpm test --changed'], ['mcp__shell', 'yarn run build'], ['run_command', 'bun test'], ['exec_command', 'pytest tests'], ['shell', 'tsc --noEmit']]) {
        assert.equal(view([lead(), agent('child', { state: 'working', tool, toolDetail })]).label, 'VERIFYING');
      }
      assert.equal(view([lead(), agent('child', { state: 'idle', tool: 'bash', toolDetail: 'npm test' })]).label, 'WAITING');
      assert.equal(view([lead(), agent('child', { state: 'working', tool: 'read_file', toolDetail: 'npm test' })]).label, 'WORKING');
      assert.equal(view([lead(), agent('child', { state: 'working', tool: 'bash', toolDetail: 'npm install' })]).label, 'WORKING');
      return ok('runtime and tool observations gate VERIFYING', true);
    }),
    test('CAPCOM acknowledgement clears result debt without closing a mission', () => {
      const m = mission({ messages: [result, { id: 'ack', role: 'capcom', at: 3, text: 'Reviewed' }] });
      assert.deepEqual(view([lead()], m), { missionId: m.id, label: 'WAITING', active: true });
      const human = mission({ messages: [{ id: 'request', role: 'human', at: 4, text: 'Continue' }] });
      assert.equal(view([lead()], human).label, 'WAITING');
      return ok('result debt comes from the existing missionDebt function', true);
    }),
    test('closed, archived or absent missions keep historical FORGE inactive', () => {
      for (const status of ['completed', 'failed'] as const) {
        assert.deepEqual(view([agent('lead', { lead: true, state: 'working' })], mission({ status })),
          { missionId: null, label: 'INACTIVE', active: false });
      }
      assert.equal(view([lead()], mission({ archivedAt: 2 })).label, 'INACTIVE');
      assert.deepEqual(forgeViews([lead()], {}).get('lead'), { missionId: null, label: 'INACTIVE', active: false });
      return ok('history stays visible without inventing an active mission', true);
    }),
    test('only real FORGE leads appear and squad names follow shared normalization', () => {
      const agents = [agent('lead', { lead: true, state: 'working', squad: ' forge-canvas ' }),
        agent('ordinary', { lead: true, squad: 'audit' }), agent('capcom', { lead: true, role: 'capcom' }), agent('member')];
      const views = forgeViews(agents, { fixture: mission() });
      assert.deepEqual([...views.keys()], ['lead']);
      assert.equal(views.get('lead')!.label, 'WORKING');
      assert.equal(forgeViews([agent('invalid', { lead: true, squad: 'forge-invalid/name' })], {}).size, 0);
      return ok('shared squad identity and no synthetic agents', true);
    }),
    test('replacement leads and multiple missions use existing mission lead selection', () => {
      const old = agent('old', { lead: true, state: 'dead', updatedAt: 20 });
      const current = agent('lead', { lead: true, state: 'working', updatedAt: 10 });
      const second = agent('second', { lead: true, squad: 'forge-second' });
      const m = mission({ agentIds: ['old', 'lead'] });
      const newer = mission({ id: 'mission_newer', updatedAt: 3, agentIds: ['lead'] });
      const other = mission({ id: 'mission_other', agentIds: [], squads: ['forge-second'] });
      const views = forgeViews([old, current, second], { first: m, newer, other });
      assert.equal(views.size, 3);
      assert.equal(views.get('old')!.label, 'INACTIVE');
      assert.equal(views.get('lead')!.missionId, newer.id);
      assert.equal(views.get('second')!.missionId, other.id);
      assert.equal(views.get('second')!.label, 'WAITING');
      return ok('each real lead remains unique; latest active mission and squad fallback resolve', true);
    }),
    test('projection never mutates source agents, missions, messages or lifecycle', () => {
      const agents = [lead(), agent('child', { state: 'working' })];
      const m = mission({ messages: [result] });
      const snapshot = JSON.stringify({ agents, m });
      Object.freeze(m.messages); Object.freeze(m);
      for (const a of agents) Object.freeze(a);
      const first = forgeViews(agents, { [m.id]: m });
      const second = forgeViews(agents, { [m.id]: m });
      assert.deepEqual([...first], [...second]);
      assert.notEqual(first, second);
      assert.equal(JSON.stringify({ agents, m }), snapshot);
      return ok('views derive on demand without a parallel lifecycle or source mutation', true);
    }),
  ],
} satisfies TestModule;
