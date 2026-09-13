/** FORGE is a mission lead, not another agent role or lifecycle. */
export const FORGE_SQUAD_PREFIX = 'forge-';

/** Also covers children: squad membership survives delayed IDs and restarts. */
export function isForgeSquad(squad: string | null | undefined): boolean {
  return !!squad?.startsWith(FORGE_SQUAD_PREFIX);
}

/* ── La puerta: qué proyectos sólo admiten escritura desde FORGE ──── */

/**
 * ¿Puede este lanzamiento ESCRIBIR en el proyecto?
 *
 * La puerta mira esto y no los ficheros, porque los ficheros no se saben
 * antes de tocarlos: nadie puede decidir de antemano si un agente acabará
 * cambiando código o sólo documentación, y una puerta que lo intente acaba
 * preguntándole al que lanza qué piensa hacer. La escritura, en cambio, es
 * una capacidad que el lanzamiento lleva encima, y se lee de dos campos.
 *
 * `review` le QUITA las herramientas de edición al arrancar (ver el comando
 * `spawn` en shared/protocol.ts), y `plan` es el modo en el que el CLI
 * propone sin tocar. Los dos son sólo lectura y pasan siempre: el 2026-09-12
 * hubo que lanzar dos reconocimientos sobre este mismo repositorio, y una
 * puerta que rechazara todo lanzamiento sin prefijo habría obligado a montar
 * un squad FORGE para algo que no escribe una línea.
 *
 * Lo que no se sabe, escribe: un `permissionMode` ausente es el defecto del
 * collector, y el defecto del collector edita.
 */
export function spawnWrites(cmd: { review?: boolean; permissionMode?: string | null }): boolean {
  if (cmd.review === true) return false;
  return cmd.permissionMode !== 'plan';
}

/**
 * Lo que se le contesta a quien lanza. Nombra la alternativa exacta: un
 * rechazo que sólo dice que no deja a quien lanza adivinando, y lo que se
 * adivina es saltarse la puerta por otro sitio.
 */
export function forgeGateRefusal(project: string, squad: string | null | undefined): string {
  return `${project} only accepts WRITING launches from a FORGE squad`
    + `${squad ? ` (this one is "${squad}")` : ' (this one has no squad)'}`
    + `: relaunch with squad "${FORGE_SQUAD_PREFIX}<name>", or as read-only`
    + ' (permission_mode "plan", or a review spawn), which always passes.'
    + ' The mark is per project, in ~/.orca/hub/project-policy.json.';
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
