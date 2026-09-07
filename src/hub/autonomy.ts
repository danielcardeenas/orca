/**
 * Autonomía de CAPCOM: lo que el hub monta para que el mando opere solo.
 *
 * Cinco piezas, cada una en su módulo, todas con la misma firma de fábrica
 * `createX(deps: AutonomyDeps)`. Este archivo sólo las instancia y las expone
 * como `hub.autonomy`; server.ts llama a `createAutonomy` una vez y no sabe
 * nada más. Las herramientas MCP de cada pieza viven en agents/tools-*.ts y
 * llegan a este objeto a través de `CeoContext.autonomy`.
 *
 *   wake     (A)  despierta a CAPCOM cuando un worker termina; latido
 *   verify   (B)  diff, tests y pantalla del trabajo de un agente
 *   journal  (E)  diario persistente de lanzamientos
 *
 * Las otras dos piezas del squad van por sus propios caminos, ya cableados
 * en server.ts y tools.ts: los worktrees y el aterrizaje (C) son comandos
 * tipados `land`/`discard` (collector/worktrees.ts) y los presupuestos (D)
 * son el `BudgetBook` de hub/budgets.ts, evaluado en el sweep del hub.
 */

import type { Agent, Project } from '../shared/types.ts';
import type { CapcomTask } from '../shared/tasks.ts';
import type { Command } from '../shared/protocol.ts';
import type { CapcomTimer } from './capcom.ts';
import { AgentLifecycle } from './lifecycle.ts';
import { createWake, type WakeApi } from './wake.ts';
import { createVerify, type VerifyApi } from './verify.ts';
import { createJournal, type JournalApi } from './journal.ts';

export interface AutonomyDeps {
  agents(): Agent[];
  agent(id: string): Agent | undefined;
  projects(): Project[];
  project(id: string): Project | undefined;
  /** Las conversaciones de tarea (tasks.json), por id. Copia: mutarla no cambia nada. */
  tasks(): Record<string, CapcomTask>;
  /** La sesión CAPCOM viva, o null. */
  capcom(): Agent | null;
  /**
   * Manda un turno a CAPCOM por el router (respeta rotaciones: si CAPCOM se
   * está reciclando, la línea espera a la sesión nueva).
   */
  contextCutoff?(): number | null;
  sayToCapcom(text: string): 'delivered' | 'queued' | false;
  /** Manda un comando al collector dueño del agente y espera su ack. */
  dispatch(cmd: Command): Promise<unknown>;
  /** Detiene un agente (mismo camino que `stop_agent`). */
  stopAgent(agentId: string): Promise<unknown>;
  /** Directorio persistente del hub (~/.orca/hub). Cada pieza escribe el suyo debajo. */
  dir: string;
  env: Record<string, string | undefined>;
  now(): number;
  /** Reloj inyectable, el mismo que usa el router de CAPCOM en los tests. */
  setTimer(fn: () => void, ms: number): CapcomTimer;
  setInterval(fn: () => void, ms: number): CapcomTimer;
  log(text: string): void;
  /** Una línea en el feed de la consola. */
  note(text: string): void;
  lifecycle: AgentLifecycle;
}

export interface AutonomyApi {
  lifecycle: AgentLifecycle;
  wake: WakeApi;
  verify: VerifyApi;
  journal: JournalApi;
  stop(): void;
}

export function createAutonomy(deps: AutonomyDeps): AutonomyApi {
  const wake = createWake(deps);
  const verify = createVerify(deps);
  const journal = createJournal(deps);
  return {
    lifecycle: deps.lifecycle,
    wake, verify, journal,
    stop() {
      for (const p of [wake, verify, journal]) {
        try { p.stop?.(); } catch { /* ya parado */ }
      }
    },
  };
}
