/** Pure fixtures: FORGE uses its real lead's spot, identity and placement. */
import assert from 'node:assert/strict';
import { CAPCOM_SCALE, FORGE_CLEAR_X, FORGE_CLEAR_Y, TILE_W, TILE_H, emptyLayout, layoutFleet } from '../src/ui/field/layout.ts';
import type { Agent, Placement, Project } from '../src/shared/types.ts';
import { harnessIsland } from '../src/shared/synthetic.ts';
import { ok, test, type TestModule } from './harness.ts';

function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return {
    id, machineId: 'm1', projectId: 'orca', callsign: id, runtime: 'codex', state: 'working',
    parentId: null, startedAt: 1, squad: 'forge-canvas', lead: false,
    metrics: { costUSD: 0, tokensPerSec: 0 }, ...patch,
  } as Agent;
}
const capcom = agent('capcom', { role: 'capcom', squad: null });
const lead = agent('lead', { lead: true });
const child = agent('child', { parentId: lead.id });
const member = agent('member');
const fleet = [capcom, lead, child, member];
const layout = (agents = fleet, placements = new Map<string, Placement>()) =>
  layoutFleet(agents, new Map(), placements, emptyLayout());

export default {
  suite: 'forge-layout',
  tests: [
    test('FORGE is one real command spot, outside the ORCA region', () => {
      const result = layout();
      assert.equal(result.spots.size, fleet.length);
      assert.equal(result.regions.length, 1);
      const region = result.regions[0]!;
      assert.equal(region.count, 2);
      assert.equal(region.squads[0]!.count, 3);
      assert.equal(region.squads[0]!.leadId, lead.id);
      for (const id of [lead.id, capcom.id]) {
        const sp = result.spots.get(id)!;
        assert.equal(sp.scale, CAPCOM_SCALE);
        assert.equal(sp.trayOf, null);
        assert.ok(Math.abs(sp.tx - region.cx) >= region.hw + TILE_W * sp.scale / 2
          || Math.abs(sp.ty - region.cy) >= region.hh + TILE_H * sp.scale / 2);
        assert.ok(result.bounds.minY <= sp.ty - TILE_H * sp.scale / 2);
        assert.ok(result.bounds.maxY >= sp.ty + TILE_H * sp.scale / 2);
      }
      const f = result.spots.get(lead.id)!, c = result.spots.get(capcom.id)!;
      assert.ok(Math.abs(f.tx - c.tx) >= TILE_W * CAPCOM_SCALE
        || Math.abs(f.ty - c.ty) >= TILE_H * CAPCOM_SCALE);
      return ok('real identities, scale, command separation and squad linkage', true);
    }),
    test('FORGE stands beside its region, separated from CAPCOM and other instances', () => {
      const extra = agent('second-lead', { lead: true, squad: 'forge-second' });
      const result = layout([...fleet, extra]);
      const region = result.regions[0]!;
      const f = result.spots.get(lead.id)!, second = result.spots.get(extra.id)!, c = result.spots.get(capcom.id)!;
      assert.equal(f.tx, region.cx + region.hw + TILE_W * CAPCOM_SCALE / 2 + FORGE_CLEAR_X);
      assert.equal(f.ty, region.cy);
      assert.equal(second.tx, f.tx);
      assert.ok(second.ty - f.ty >= TILE_H * CAPCOM_SCALE + FORGE_CLEAR_Y - 1e-9);
      assert.ok(Math.hypot(f.tx - c.tx, f.ty - c.ty) > Math.hypot(f.tx - region.cx, f.ty - region.cy));
      const moved = layoutFleet(fleet, new Map(), new Map(), emptyLayout(), { kind: 'field' }, new Map(),
        new Map([['orca', { projectId: 'orca', x: 20, y: -10, at: 1 }]]));
      const home = moved.regions[0]!, command = moved.spots.get(lead.id)!;
      assert.equal(command.tx, home.cx + home.hw + TILE_W * CAPCOM_SCALE / 2 + FORGE_CLEAR_X);
      assert.equal(command.ty, home.cy);
      return ok('FORGE follows its home edge and instances leave room for labels', true);
    }),
    test('ORCA takes precedence over another populated home and exact clearance does not move FORGE above it', () => {
      const foreign = agent('lead', { lead: true, projectId: 'other' });
      const projects = new Map([
        ['orca', { id: 'orca', slug: 'orca', name: 'ORCA' } as Project],
        ['other', { id: 'other', slug: 'other', name: 'Other' } as Project],
      ]);
      const agents = [capcom, foreign, member, agent('other-worker', { projectId: 'other', squad: null })];
      // Fractional placement exercises subtraction at the exact clearance.
      const result = layoutFleet(agents, projects, new Map(), emptyLayout(), { kind: 'field' }, new Map(),
        new Map([['orca', { projectId: 'orca', x: 20.17, y: -10.13, at: 1 }]]));
      const orca = result.regions.find((r) => r.id === 'orca')!, f = result.spots.get(lead.id)!;
      assert.equal(f.tx, orca.cx + orca.hw + TILE_W * CAPCOM_SCALE / 2 + FORGE_CLEAR_X);
      assert.equal(f.ty, orca.cy);
      const withoutOrca = layoutFleet([capcom, foreign, agents[3]!], projects, new Map(), emptyLayout());
      const own = withoutOrca.regions[0]!, fallback = withoutOrca.spots.get(lead.id)!;
      assert.equal(own.id, 'other');
      assert.equal(fallback.tx, own.cx + own.hw + TILE_W * CAPCOM_SCALE / 2 + FORGE_CLEAR_X);
      assert.equal(fallback.ty, own.cy);
      return ok('ORCA first, home fallback and stable centre at fractional clearance', true);
    }),
    test('an absent home falls back to the real ORCA project, or a separate command position', () => {
      const foreign = agent('lead', { lead: true, projectId: 'empty-project' });
      const projects = new Map([['orca', { id: 'orca', slug: 'orca', name: 'ORCA' } as Project]]);
      const result = layoutFleet([capcom, foreign, member], projects, new Map(), emptyLayout());
      const region = result.regions[0]!, f = result.spots.get(lead.id)!;
      assert.equal(f.tx, region.cx + region.hw + TILE_W * CAPCOM_SCALE / 2 + FORGE_CLEAR_X);
      assert.equal(f.ty, region.cy);
      const lone = layout([capcom, foreign]);
      assert.equal(lone.regions.length, 0);
      assert.equal(lone.spots.get(lead.id)!.tx, 3.6);
      assert.equal(lone.spots.get(capcom.id)!.tx, 0);
      return ok('real project fallback without synthetic state or CAPCOM attachment', true);
    }),

    test('a lone FORGE never creates a project region; ordinary squad leads still do', () => {
      const result = layout([lead]);
      assert.equal(result.spots.size, 1);
      assert.equal(result.regions.length, 0);
      assert.equal(layout([agent('ordinary', { lead: true, squad: 'audit' })]).regions.length, 1);
      assert.equal(layout([agent('orphan')]).regions.length, 1);
      return ok('no empty ORCA region or promotion of ordinary workers', true);
    }),
    test('FORGE preserves operator placement, easing and depth through updates', () => {
      const placements = new Map<string, Placement>([[lead.id, { x: 12, y: -7, pinned: true } as Placement]]);
      const before = layout(fleet, placements);
      const old = before.spots.get(lead.id)!;
      old.x = 3; old.y = 4; old.z = 5;
      const after = layoutFleet(fleet, new Map(), placements, before);
      const sp = after.spots.get(lead.id)!;
      assert.equal(sp.tx, 12); assert.equal(sp.ty, -7); assert.equal(sp.pinned, true);
      assert.equal(sp.x, 3); assert.equal(sp.y, 4); assert.equal(sp.z, 5);
      assert.equal(sp.tz, old.tz);
      const deck = layoutFleet(fleet, new Map(), placements, after, { kind: 'deck', sort: 'state' });
      assert.equal(deck.spots.get(lead.id)!.scale, 1);
      assert.equal(deck.spots.get(lead.id)!.pinned, false);
      const restored = layoutFleet(fleet, new Map(), placements, deck);
      assert.equal(restored.spots.get(lead.id)!.tx, 12);
      assert.equal(restored.spots.get(lead.id)!.scale, CAPCOM_SCALE);
      return ok('placement and easing retained; deck remains uniform and reversible', true);
    }),
    test('FORGE and its children cannot disappear into a missing region tray', () => {
      const absorbed = new Map([[lead.id, capcom.id], [child.id, lead.id]]);
      const result = layoutFleet(fleet, new Map(), new Map(), emptyLayout(), { kind: 'field' }, new Map(), new Map(), absorbed);
      assert.equal(result.spots.size, fleet.length);
      assert.equal(result.spots.get(lead.id)!.trayOf, null);
      assert.equal(result.spots.get(child.id)!.trayOf, null);
      assert.equal(result.regions[0]!.squads[0]!.leadId, lead.id);
      return ok('all real spots survive block absorption', true);
    }),
    test('harness FORGE stays enclosed and does not attach to a real squad lead', () => {
      const fixture = agent('fixture', { lead: true, machineId: 'harness' });
      const result = layoutFleet([...fleet, fixture], new Map(), new Map(), emptyLayout(), { kind: 'field' }, new Map(), new Map(), new Map(), new Map([['harness', 'orca']]));
      const sp = result.spots.get(fixture.id)!;
      assert.equal(sp.scale, 1);
      assert.equal(sp.projectId, harnessIsland('orca'));
      const enclosure = result.regions.find((r) => r.harness)!;
      assert.equal(enclosure.count, 1);
      assert.equal(enclosure.squads[0]!.leadId, fixture.id);
      return ok('synthetic boundary preserved', true);
    }),
    test('multiple leads and squads keep stable identity and canonical squad links', () => {
      const newer = agent('newer', { lead: true, startedAt: 2 });
      const another = agent('another', { lead: true, squad: 'forge-second' });
      const otherMember = agent('other-member', { squad: 'forge-second', projectId: 'other' });
      const agents = [...fleet, newer, another, otherMember];
      const result = layout(agents);
      const shuffled = layout([...agents].reverse());
      assert.equal(result.spots.size, agents.length);
      for (const id of [lead.id, newer.id, another.id]) {
        assert.equal(result.spots.get(id)!.scale, CAPCOM_SCALE);
        assert.equal(result.spots.get(id)!.tx, shuffled.spots.get(id)!.tx);
        assert.equal(result.spots.get(id)!.ty, shuffled.spots.get(id)!.ty);
      }
      assert.equal(result.regions.find((r) => r.id === 'orca')!.squads[0]!.leadId, lead.id);
      assert.equal(result.regions.find((r) => r.id === 'other')!.squads[0]!.leadId, another.id);
      return ok('no duplicate spots, deterministic order and cross-project squad lead', true);
    }),
  ],
} satisfies TestModule;
