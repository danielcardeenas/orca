/**
 * Herramientas MCP del squad autonomy, registradas sin tocar la lista de
 * tools.ts más que en dos líneas (el spread en CEO_TOOLS y el `default` de
 * runTool).
 *
 * Cada módulo exporta `TOOLS: ToolSpec[]` y `run(ctx, name, input)` que
 * devuelve null cuando el nombre no es suyo. Los nombres no pueden chocar
 * con los de tools.ts ni entre sí: `checkExtensionNames` lo comprueba en un
 * test.
 */

import type { CeoContext, ToolOutcome, ToolSpec } from './tools.ts';
import * as verify from './tools-verify.ts';
import * as recovery from './tools-recovery.ts';
import * as journal from './tools-journal.ts';

export interface ExtensionModule {
  TOOLS: ToolSpec[];
  run(ctx: CeoContext, name: string, input: Record<string, unknown>): Promise<ToolOutcome | null> | ToolOutcome | null;
}

const MODULES: ExtensionModule[] = [verify, journal, recovery];

export const EXTENSION_TOOLS: ToolSpec[] = MODULES.flatMap((m) => m.TOOLS);

export async function runExtension(
  ctx: CeoContext, name: string, input: Record<string, unknown>,
): Promise<ToolOutcome | null> {
  for (const m of MODULES) {
    if (!m.TOOLS.some((t) => t.name === name)) continue;
    const out = await m.run(ctx, name, input);
    if (out) return out;
  }
  return null;
}

/** Nombres duplicados entre módulos, o contra `base`. Vacío = bien. */
export function duplicateToolNames(base: ToolSpec[]): string[] {
  const seen = new Set(base.map((t) => t.name));
  const dupes: string[] = [];
  for (const t of EXTENSION_TOOLS) {
    if (seen.has(t.name)) dupes.push(t.name);
    seen.add(t.name);
  }
  return dupes;
}
