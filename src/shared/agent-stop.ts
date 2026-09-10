/** Manual stop eligibility, shared by the console and the command boundary. */
import type { Agent } from './types.ts';
import type { CapcomMission } from './missions.ts';

export function agentStopReason(a: Agent | undefined, missions: Iterable<CapcomMission> = []): string | null {
  if (!a) return 'Agent is no longer in the fleet';
  if (a.role === 'capcom') return 'CAPCOM coordinates the fleet';
  if (a.state === 'done' || a.state === 'dead') return `Session ${a.state} · use RESUME to continue`;
  if (a.subagent) return 'Subagent · controlled by its parent';
  if (a.lead && [...missions].some(m => m.status === 'active'
    && (m.agentIds.includes(a.id) || (!!a.squad && m.squads?.includes(a.squad))))) {
    return 'Lead of an active mission · finish or reassign the mission first';
  }
  if (!a.pane && !(a.runtime === 'claude' && (a.background || a.shortId))) {
    return 'No hosted pane or addressable background session';
  }
  return null;
}
