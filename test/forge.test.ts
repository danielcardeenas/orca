import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchForge } from '../src/hub/forge.ts';
import { ImproveStore, type ImproveApi } from '../src/hub/improve.ts';
import { MissionStore } from '../src/hub/missions.ts';
import { missionDebt } from '../src/shared/missions.ts';
import { implementerSquad } from '../src/shared/improve.ts';
import { finishedOwnWork, REPO_ROOT } from '../src/hub/publisher.ts';
import { planChild, type SpawnRequest } from '../src/collector/spawns.ts';
import { squadBrief } from '../src/collector/briefs.ts';
import { FORGE_EXECUTION_POLICY } from '../src/shared/forge.ts';
import { ok, test, type TestModule } from './harness.ts';

async function rig(fn: (r: { dir: string; improve: Pick<ImproveApi, 'store' | 'implement'>; missions: MissionStore; id: string }) => Promise<boolean>) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-forge-'));
  try {
    const store = new ImproveStore(dir);
    const id = store.file('review_fixture', [{ title: 'Queue order', summary: 'Keep oldest first', key: 'queue-order', kind: 'hypothesis', hypothesis: 'Ordering may reduce wait' }]).proposals[0]!.id;
    const improve = { store, implement: async () => ({ ok: false as const, reason: 'offline fixture' }) } as Pick<ImproveApi, 'store' | 'implement'>;
    return await fn({ dir, improve, missions: new MissionStore(dir), id });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function refused(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}

const tests = [
  test('approval reserves proposal and squad before dispatch, even for concurrent clicks', async () => ok('one attempt and durable ownership', await rig(async (r) => {
    let launches = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let bound = false;
    r.improve.implement = async () => {
      launches++;
      bound = r.missions.get('mission_forge').squads?.includes(implementerSquad(r.improve.store.get(r.id))) === true;
      await held;
      return { ok: false, reason: 'uncertain receipt' };
    };
    const first = dispatchForge(r, r.id, 'mission_forge');
    const second = await refused(() => dispatchForge(r, r.id, 'mission_duplicate'));
    release();
    await first;
    return bound && launches === 1 && second && !r.missions.all()['mission_duplicate'];
  }))),
  test('failure survives restart, stays active and cannot silently relaunch', async () => ok('recover through the existing mission', await rig(async (r) => {
    const result = await dispatchForge(r, r.id, 'mission_failure');
    const proposal = new ImproveStore(r.dir).get(r.id);
    const mission = new MissionStore(r.dir).get('mission_failure');
    return result.delivery === 'saved' && proposal.missionId === mission.id && proposal.status === 'sent'
      && mission.status === 'active' && !!mission.squads?.[0]?.startsWith('forge-')
      && mission.messages.some((m) => m.text.includes('offline fixture'))
      && await refused(() => dispatchForge(r, r.id, 'mission_retry'));
  }))),
  test('existing mission IDs cannot absorb a second improvement', async () => ok('no proposal mutation or launch', await rig(async (r) => {
    r.missions.create('mission_existing', 'Unrelated task');
    let launched = false;
    r.improve.implement = async () => { launched = true; return { ok: false, reason: 'unexpected' }; };
    return await refused(() => dispatchForge(r, r.id, 'mission_existing')) && !launched
      && r.missions.get('mission_existing').messages.length === 0 && r.improve.store.get(r.id).status === 'open';
  }))),
  test('dismissed proposals require reopening before approval', async () => ok('no mission', await rig(async (r) => {
    r.improve.store.act(r.id, { act: 'dismiss' });
    return await refused(() => dispatchForge(r, r.id, 'mission_dismissed')) && Object.keys(r.missions.all()).length === 0;
  }))),
  test('unexpected dispatch exceptions are visible without losing the link', async () => ok('saved blocker', await rig(async (r) => {
    r.improve.implement = async () => { throw new Error('fixture transport failure'); };
    const out = await dispatchForge(r, r.id, 'mission_throw');
    return out.delivery === 'saved' && out.detail === 'fixture transport failure'
      && r.improve.store.get(r.id).missionId === 'mission_throw';
  }))),
  test('approval is audit evidence, not an unanswered CAPCOM question', async () => ok('no operational reminder debt', await rig(async (r) => {
    await dispatchForge(r, r.id, 'mission_audit');
    const m = r.missions.get('mission_audit');
    return missionDebt(m).humans.length === 0 && m.messages[0]!.text.includes(r.id)
      && m.messages[0]!.text.includes('operator approved');
  }))),
  test('FORGE members run auto and cannot escape their squad or publication exclusion', () => {
    const req: SpawnRequest = { id: 'spawn_fixture', projectId: 'p', requesterId: 'lead', mission: 'Inspect isolated fixture and report results', squad: 'other', model: null, at: 1, ackFile: '/unused' };
    const out = planChild(req, { id: 'lead', callsign: 'F1', squad: 'forge-fixture', liveChildren: 0 }, () => 1);
    if (!out.ok || out.cmd.k !== 'spawn') return ok('spawn planned', false);
    const grandchild = planChild({ ...req, requesterId: 'member' }, { id: 'member', callsign: 'F2', squad: out.squad, liveChildren: 0 }, () => 2);
    return ok('auto throughout the inherited squad, still excluded from publication', out.cmd.permissionMode === 'auto'
      && out.cmd.squad === 'forge-fixture' && out.cmd.parentId === 'lead' && out.cmd.lead === false
      && !finishedOwnWork({ to: 'done', agent: out.cmd }, REPO_ROOT)
      && grandchild.ok && grandchild.cmd.k === 'spawn' && grandchild.cmd.permissionMode === 'auto'
      && grandchild.cmd.squad === 'forge-fixture' && grandchild.cmd.parentId === 'member'
      && !finishedOwnWork({ to: 'done', agent: grandchild.cmd }, REPO_ROOT));
  }),
  test('collector supplies the same routine/elevated policy to FORGE leads and members even without a detailed task brief', () => {
    const footers = [squadBrief('forge-fixture', true, null), squadBrief('forge-fixture', false, 'F1'), squadBrief('forge-fixture', false, null)];
    return ok('policy reaches every squad launch, with member escalation through the lead', footers.every((text) => text?.includes(FORGE_EXECUTION_POLICY))
      && !squadBrief('ordinary', true, null)?.includes(FORGE_EXECUTION_POLICY)
      && !squadBrief('ordinary', false, null)?.includes(FORGE_EXECUTION_POLICY)
      && squadBrief(null, false, null) === null);
  }),
  test('execution brief distinguishes routine work from every elevated boundary and ambiguous script effects', () => ok('complete operational boundaries; no inferred publication approval',
    ['reads', 'local searches', 'typecheck', 'tests', 'file edits', 'deletion', 'stopping processes', 'deploy/publication/push/merge',
      'secrets', 'external network access', 'symlink targets', 'changing permissions/security settings', 'ambiguous actions',
      'not routine just because of its name', 'lead cannot authorize elevated', 'CAPCOM retains final review, mission closure and publication control']
      .every((boundary) => FORGE_EXECUTION_POLICY.includes(boundary)))),
  test('a FORGE completion cannot trigger publication; ordinary workers keep their policy', () => ok('no automatic publication from FORGE',
    !finishedOwnWork({ to: 'done', agent: { squad: 'forge-fixture' } }, REPO_ROOT)
    && finishedOwnWork({ to: 'done', agent: { squad: 'ordinary' } }, REPO_ROOT))),
];
export default { suite: 'FORGE · approval and coordination boundaries', tests } satisfies TestModule;
