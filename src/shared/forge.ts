/** FORGE is a mission lead, not another agent role or lifecycle. */
export const FORGE_SQUAD_PREFIX = 'forge-';

/** Also covers children: squad membership survives delayed IDs and restarts. */
export function isForgeSquad(squad: string | null | undefined): boolean {
  return !!squad?.startsWith(FORGE_SQUAD_PREFIX);
}

/** Operating instructions, not a shell classifier or a provider sandbox. */
export const FORGE_EXECUTION_POLICY = [
  'FORGE execution permissions: lead and members run in auto mode for routine work within the approved scope.',
  'Proceed without asking for routine reads, local searches, typecheck, tests and file edits inside the assigned worktree/project.',
  'Inspect commands and their effects first: a test or script that deletes data, stops processes or contacts an external service is not routine just because of its name.',
  'Before elevated or ambiguous actions, pause that action and escalate to CAPCOM: deletion, stopping processes or reloading services, deploy/publication/push/merge, accessing or exposing secrets, external network access, leaving the assigned worktree/project (including symlink targets), or changing permissions/security settings.',
  'Members send these blockers to their lead with orca-tell --kind ask; the lead uses orca-ask for CAPCOM review. Include the exact action, target, effects and approval needed; continue independent routine work while waiting.',
  'The lead cannot authorize elevated actions on its own. Ambiguity is not approval. Do not bypass native permission prompts or widen scope; use the existing escalation channel.',
  'Execution permission does not grant publication permission. FORGE completion never triggers automatic publication; CAPCOM retains final review, mission closure and publication control.',
].join('\n');
