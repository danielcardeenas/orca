/** Read-only presentation of FORGE; missions and agents own every fact. */
import type { Agent } from '../../shared/types.ts';
import { isForgeSquad } from '../../shared/forge.ts';
import { missionDebt, missionLeadOf, type CapcomMission } from '../../shared/missions.ts';
import { squadName, squadsOf } from '../../shared/squads.ts';

export interface ForgeView {
  missionId: string | null;
  label: string;
  active: boolean;
}

/** An executing check, never a claim that verification passed. */
function checking(a: Agent): boolean {
  return a.state === 'working' && /(?:^|__)(?:bash|shell|exec_command|run_command)$/i.test(a.tool ?? '')
    && /(?:^|\W)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|visual|build)(?:\W|$)|(?:^|\W)(?:vitest|pytest|tsc)(?:\W|$)/i.test(a.toolDetail ?? '');
}

/** Rebuilt on feed, not per frame. No timers, persistence or synthetic agents. */
export function forgeViews(agents: Agent[], missions: Record<string, CapcomMission>): Map<string, ForgeView> {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out = new Map<string, ForgeView>();
  const associated = new Map<string, CapcomMission>();
  for (const m of Object.values(missions)) {
    if (m.status !== 'active' || m.archivedAt) continue;
    const lead = missionLeadOf(m, (id) => byId.get(id), agents)?.agent;
    if (!lead || !isForgeSquad(squadName(lead.squad))) continue;
    const old = associated.get(lead.id);
    if (!old || m.updatedAt > old.updatedAt) associated.set(lead.id, m);
  }
  for (const squad of squadsOf(agents)) {
    if (!isForgeSquad(squad.name)) continue;
    // Keep historical leaders identifiable, without presenting closed work as live.
    const leads = squad.memberIds.map((id) => byId.get(id)!).filter((a) => a.lead && a.role !== 'capcom');
    for (const lead of leads) {
      const m = associated.get(lead.id);
      if (!m) { out.set(lead.id, { missionId: null, label: 'INACTIVE', active: false }); continue; }
      const crew = squad.memberIds.map((id) => byId.get(id)!);
      const label = crew.some((a) => a.state === 'blocked') ? 'BLOCKED'
        : crew.some(checking) ? 'VERIFYING'
        : crew.some((a) => a.state === 'working') ? 'WORKING'
        : missionDebt(m).results.length ? 'WAITING CAPCOM'
        : 'WAITING';
      out.set(lead.id, { missionId: m.id, label, active: true });
    }
  }
  return out;
}
