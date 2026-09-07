import type { Agent } from './types.ts';
export type RecoveryAction = 'wait' | 'model' | 'handoff' | 'retry';
export interface RecoveryDecision {
  id: string; agentId: string; incident: string; at: number; action: RecoveryAction;
  reason: string; by: string; reviewAt?: number; runtime?: string; model?: string;
  phase: 'waiting' | 'applying' | 'ready' | 'resuming' | 'complete' | 'failed';
  detail: string; planId?: string; toId?: string; notifiedAt?: number;
}
export interface RecoveryRequest {
  incident: string; action: RecoveryAction; reason: string; supervisorId?: string;
  reviewAt?: number; runtime?: string; model?: string; planId?: string;
}
export function quotaIncident(a: Agent): { id: string; evidence: string; since: number } | null {
  if (a.block?.kind !== 'error' || a.state !== 'blocked') return null;
  const evidence = a.block.summary;
  if (!/rate.?limit|usage.?limit|quota|insufficient[_ ]quota|credits?|429|reached.{0,80}limit|hit.{0,40}limit/i.test(evidence)) return null;
  return { id: `${a.id}:${a.block.since}:${evidence}`, evidence, since: a.block.since };
}
export function canSupervise(supervisor: Agent, target: Agent, agents: Agent[]): boolean {
  if (supervisor.id === target.id) return false;
  if (supervisor.role === 'capcom') return true;
  const seen = new Set<string>(); let parent = target.parentId;
  while (parent && !seen.has(parent)) {
    if (parent === supervisor.id) return true;
    seen.add(parent); parent = agents.find(a => a.id === parent)?.parentId ?? null;
  }
  return !!(supervisor.lead && supervisor.squad && supervisor.squad === target.squad && supervisor.projectId === target.projectId && !target.lead);
}
