import { effectiveStatus, implementerBrief, implementerSquad, proposalHandoff, proposalMissionTitle } from '../shared/improve.ts';
import { MISSION_ID } from '../shared/missions.ts';
import type { ImproveApi, ImplementOutcome } from './improve.ts';
import type { MissionStore } from './missions.ts';

export interface ForgeDelivery {
  missionId: string;
  delivery: 'launched' | 'saved';
  callsign?: string;
  detail?: string;
}

/**
 * The authenticated console's approval boundary. Never called by the review
 * clock or an agent tool. All durable facts belong to proposals and missions;
 * FORGE adds neither a queue nor a second status machine.
 */
export async function dispatchForge(
  deps: { improve: Pick<ImproveApi, 'store' | 'implement'>; missions: MissionStore },
  proposalId: string,
  missionId: string,
): Promise<ForgeDelivery> {
  const { improve, missions } = deps;
  const p = improve.store.get(proposalId);
  if (p.missionId) throw new Error(`Already sent as ${p.missionId}`);
  if (!MISSION_ID.test(missionId)) throw new Error('Invalid mission id');
  if (missions.all()[missionId]) throw new Error('Mission id already exists');
  if (effectiveStatus(p, Date.now()) !== 'open') throw new Error('Reopen the proposal before approving it');

  const squad = implementerSquad(p);
  missions.create(missionId, proposalMissionTitle(p));
  // A recorded console gesture, not an unanswered question addressed to CAPCOM.
  missions.message(missionId, 'system', proposalHandoff(p));
  improve.store.act(proposalId, { act: 'sent', missionId });
  // Persist before the first await: concurrent SEND cannot launch twice, and
  // observe can find the lead even when agent:new beats the spawn receipt.
  missions.bindSquad(missionId, squad);
  missions.message(missionId, 'system', 'FORGE coordinates assignment, follow-up, blockers and verification. CAPCOM retains final review, mission closure and publication.');

  let out: ImplementOutcome;
  try {
    out = await improve.implement({ brief: implementerBrief(p, missionId), squad, mission: proposalMissionTitle(p) });
  } catch (err) {
    out = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!out.ok) {
    // A failed/ambiguous launch is never retried automatically. Keep the link
    // and squad so a late agent is still discoverable; CAPCOM can recover it.
    missions.message(missionId, 'system', `FORGE launch not confirmed: ${out.reason}. Inspect the squad before retrying; CAPCOM retains recovery control.`);
    return { missionId, delivery: 'saved', detail: out.reason };
  }
  if (out.agentId) missions.assign(missionId, [out.agentId]);
  missions.message(missionId, 'system', `FORGE assigned to ${out.callsign ?? out.shortId ?? out.agentId ?? squad}. Launch acknowledged; verification is still pending.`);
  return { missionId, delivery: 'launched', ...(out.callsign ? { callsign: out.callsign } : {}) };
}
