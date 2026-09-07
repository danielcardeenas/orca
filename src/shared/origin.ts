import type { Agent } from './types.ts';
export type AgentOrigin = 'orca' | 'external' | 'unknown';
/** A mission or a project name is not evidence of an ORCA launch. */
export function agentOrigin(a: Agent): AgentOrigin {
  if (a.role === 'capcom' || a.pane === true) return 'orca';
  return a.origin ?? 'unknown';
}
export function originLabel(a: Agent): string {
  return a.role === 'capcom' ? 'CAPCOM' : agentOrigin(a) === 'orca' ? 'ORCA' : agentOrigin(a) === 'external' ? 'EXTERNAL' : 'UNVERIFIED';
}
export function groupOrigin(agents: Agent[]): string {
  const origins = new Set(agents.map(agentOrigin));
  return origins.size > 1 ? 'MIXED' : origins.has('orca') ? 'ORCA' : origins.has('external') ? 'EXTERNAL' : 'UNVERIFIED';
}
