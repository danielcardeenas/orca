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
 *   improve  (F)  AUTOMEJORA: contadores de uso y revisión periódica de ORCA
 *
 * Las otras dos piezas del squad van por sus propios caminos, ya cableados
 * en server.ts y tools.ts: los worktrees y el aterrizaje (C) son comandos
 * tipados `land`/`discard` (collector/worktrees.ts) y los presupuestos (D)
 * son el `BudgetBook` de hub/budgets.ts, evaluado en el sweep del hub.
 */

import type { Agent, Project } from '../shared/types.ts';
import type { CapcomMission } from '../shared/missions.ts';
import type { Command } from '../shared/protocol.ts';
import type { CapcomTimer } from './capcom.ts';
import { AgentLifecycle } from './lifecycle.ts';
import type { Publisher } from './publisher.ts';
import { createWake, type WakeApi } from './wake.ts';
import { createVerify, type VerifyApi } from './verify.ts';
import { createJournal, type JournalApi } from './journal.ts';
import { createImprove, type ImproveApi } from './improve.ts';
import { missionDebt, missionOwed } from '../shared/missions.ts';

export interface AutonomyDeps {
  agents(): Agent[];
  agent(id: string): Agent | undefined;
  projects(): Project[];
  project(id: string): Project | undefined;
  /** Las conversaciones de misión (missions.json), por id. Copia: mutarla no cambia nada. */
  missions(): Record<string, CapcomMission>;
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
  /**
   * Una línea en el feed DIRIGIDA AL OPERADOR, con nivel de aviso: algo que
   * él tiene que ver, no una nota de funcionamiento. Se usa cuando una
   * pregunta suya lleva demasiado sin respuesta (ver `wake.ts`).
   *
   * Opcional: un arnés que monte `AutonomyDeps` a mano cae en `note`.
   */
  alert?(text: string): void;
  /**
   * Mete un mensaje en el correo de un agente, como hace `relay`. True si
   * llegó a un collector.
   *
   * Opcional porque un arnés puede montar `AutonomyDeps` sin el hub entero;
   * sin ella, el aviso al líder simplemente no sale (ver `wake.ts`).
   */
  tellAgent?(input: { toAgentId: string; kind: 'notice' | 'handoff' | 'warning'; subject: string; body: string | null }): boolean;
  /**
   * A quién ha escrito este agente desde `since`. Sólo se usa para no
   * duplicar un aviso que el propio miembro ya dio.
   */
  saidTo?(fromAgentId: string, since: number): { toAgentId: string | null; toSquad: string | null }[];
  lifecycle: AgentLifecycle;
  /**
   * El tablero de AUTOMEJORA cambió y hay que empujarlo a las consolas.
   *
   * Opcional: un arnés que monte las piezas a mano no tiene consolas a las que
   * empujar nada, y la sección funciona igual — lo que se pierde es que el
   * panel se entere sin recargar.
   */
  improveChanged?(): void;
  /**
   * Pone techo a un agente revisor por el libro de presupuestos del hub.
   *
   * Inyectado y no importado: el libro es del hub y esta pieza no debe tener
   * su propia contabilidad. Usar el mismo mecanismo que frena a los demás
   * agentes es lo que hace que el revisor se frene igual, se vea igual en la
   * ventana de presupuestos y se pare igual.
   */
  improveBudget?(ref: { agentId: string | null; shortId: string | null }, tokens: number): void;
  /**
   * Quien construye la consola cuando el trabajo sobre el repo de ORCA
   * termina. Opcional: sólo el hub de verdad lo tiene, y sin él todo lo demás
   * sigue igual — lo que se pierde es que el trabajo terminado llegue al
   * operador sin que nadie teclee `npm run publish`. Ver hub/publisher.ts.
   */
  publisher?: Publisher;
}

export interface AutonomyApi {
  lifecycle: AgentLifecycle;
  /** Ver `AutonomyDeps.publisher`. Es por donde `land_work` pide un build. */
  publisher?: Publisher;
  wake: WakeApi;
  verify: VerifyApi;
  journal: JournalApi;
  improve: ImproveApi;
  stop(): void;
}

export function createAutonomy(deps: AutonomyDeps): AutonomyApi {
  const wake = createWake(deps);
  const verify = createVerify(deps);
  const journal = createJournal(deps);
  /*
   * La telemetría de AUTOMEJORA sale del diario y de la flota que ya hay
   * montada aquí, no de una fuente nueva: lo que se quiere saber —cuánto se
   * escala, cuánto se espera, cuánto cuesta, qué se atasca— está medido desde
   * que existe el diario, y un segundo medidor sólo añadiría una segunda
   * versión de la verdad.
   */
  const improve = createImprove(deps, {
    journal,
    fleet: () => {
      const agents = deps.agents().filter((a) => a.state !== 'done' && a.state !== 'dead');
      const missions = Object.values(deps.missions()).filter((m) => !m.archivedAt && m.status === 'active');
      return {
        agents: agents.length,
        blocked: agents.filter((a) => a.state === 'blocked').length,
        missionsOpen: missions.length,
        missionsOwed: missions.filter((m) => missionOwed(m, missionDebt(m))).length,
      };
    },
    ...(deps.improveChanged ? { changed: deps.improveChanged } : {}),
    ...(deps.improveBudget ? { budget: deps.improveBudget } : {}),
  });
  return {
    lifecycle: deps.lifecycle,
    ...(deps.publisher ? { publisher: deps.publisher } : {}),
    wake, verify, journal, improve,
    stop() {
      for (const p of [wake, verify, journal, improve]) {
        try { p.stop?.(); } catch { /* ya parado */ }
      }
    },
  };
}
