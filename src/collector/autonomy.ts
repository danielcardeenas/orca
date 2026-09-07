/**
 * Lado collector del squad autonomy: el comando `autonomy` del protocolo.
 *
 * Un solo comando con `op` en vez de N comandos nuevos, para que protocol.ts,
 * el `isCommand` del hub y el switch de commands.ts crezcan una línea cada
 * uno y no cinco. Cada pieza atiende su prefijo:
 *
 *   verify:*   (B)  diff, tests, pantalla         → verify.ts
 *
 * La pieza C (worktrees y aterrizaje) va por comandos tipados propios
 * (`land`, `discard`, `spawn.worktree`) en protocol.ts; ver worktrees.ts.
 *
 * Un handler devuelve null si el `op` no es suyo.
 */

import type { AutonomyCommand } from '../shared/protocol.ts';
import type { CommandDeps, CommandResult } from './commands.ts';
import { runVerify } from './verify.ts';

export type AutonomyHandler = (cmd: AutonomyCommand, deps: CommandDeps) => Promise<CommandResult | null>;

const HANDLERS: AutonomyHandler[] = [runVerify];

export async function runAutonomy(cmd: AutonomyCommand, deps: CommandDeps): Promise<CommandResult> {
  for (const h of HANDLERS) {
    const out = await h(cmd, deps);
    if (out) return out;
  }
  return { ok: false, detail: `autonomy: op desconocida: ${cmd.op}` };
}
