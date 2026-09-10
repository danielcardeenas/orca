/**
 * The fleet, as a set of verbs — wired to a live hub.
 *
 * `CeoContext` is the seam that keeps `agents/tools.ts` testable against a
 * world in a box: the tools know how to survey and spawn, and nothing about
 * websockets. This file is the other side of that seam, and it lives apart
 * from `runtime.ts` for one concrete reason — `runtime.ts` pulls in the
 * Anthropic SDK, and the hub needs this context without it. The MCP server is
 * the whole point of that: CAPCOM runs on a subscription, and a hub that had
 * to load an API client to serve it would be carrying the bill's ghost around.
 */

import { join } from 'node:path';

import type { CeoMessage, Escalation } from '../shared/types.ts';
import { newId } from '../shared/protocol.ts';
import type { Hub } from '../hub/server.ts';
import { nextSquadName, SQUAD_SEQ_FILE } from '../hub/squad-seq.ts';
import { stopHarnessProcs } from '../hub/harness.ts';
import type { CeoContext } from './tools.ts';

/**
 * How a caller wants the shared fleet context bent.
 *
 * The MCP server bends it in exactly two places, both about `ask_human`:
 * CAPCOM *is* a session in the fleet, so a question it raises should be
 * attributed to it and should land on the record it was already handed. The
 * bare context (no options) is what tests and in-process callers use.
 */
export interface HubContextOptions {
  /** Who to blame for an `ask_human` that names no agent. */
  defaultAgentId?: () => string | null;
  /**
   * The existing escalation this question is really a pass-up of, when the
   * tool did not say. Returning an id folds the attempt onto that record
   * instead of showing the human the same question twice.
   */
  replacesFor?: (agentId: string | null) => string | null;
}

/**
 * Everything a fleet command can touch, wired to a live hub.
 *
 * One implementation of every tool, behind the MCP server and behind any
 * in-process caller (tests, `hub.relayMessage`): the fleet has exactly one
 * set of levers, whoever is pulling them.
 */
export function hubContext(hub: Hub, hopts: HubContextOptions = {}): CeoContext {
  const world = hub.world;

  const ctx: CeoContext = {
    handoffs: () => world.state.capcomHandoffs ?? [],
    autonomy: hub.autonomy,
    missions: hub.missions,
    // AUTOMEJORA. Sólo lo que las herramientas necesitan tocar: leer el
    // tablero, archivar lo que reporta una revisión y contestar en un hilo.
    // Nada de config ni de lanzar revisiones — eso es del operador.
    improve: {
      state: () => hub.autonomy.improve.store.state(),
      file: (reviewId, drafts) => hub.autonomy.improve.store.file(reviewId, drafts),
      note: (id, role, text) => hub.autonomy.improve.store.note(id, role, text),
    },
    agents: () => Object.values(world.state.agents),
    projects: () => Object.values(world.state.projects),
    machines: () => Object.values(world.state.machines),
    agent: (id) => world.state.agents[id],
    project: (id) => world.state.projects[id],
    escalation: (id) => world.state.escalations[id],
    escalations: () => Object.values(world.state.escalations),
    // Newest first: after a restart the last thing the operator said is the
    // thing most likely to still apply.
    rules: (limit) => [...hub.memory.all()]
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(1, limit))
      .map((e) => ({ question: e.question, answer: e.rememberAs ?? e.answer, projectId: e.projectId, at: e.at })),

    dispatch: (_machineId, cmd) => hub.dispatch(cmd),

    /*
     * Los procesos primero y el mundo después, siempre en ese orden: un mock
     * vivo replanta sus máquinas en cuanto se le purga por debajo. El puerto
     * que se pasa es el de ESTE hub, y es lo que acota a quién se señala: un
     * arnés que apunta a otro sitio no es asunto nuestro. Ver hub/harness.ts.
     */
    async purgeHarness() {
      const stopped = await stopHarnessProcs({ hubPort: hub.port });
      return { stopped, removed: world.purgeSynthetic() };
    },

    hygiene: hub.hygiene,

    fleets: () => hub.fleets.list(),

    // Numbered against the counter on disk AND the labels on the fleet, so a
    // hub restarted with an empty file still never reissues a name in use.
    nextSquadName: (base) => nextSquadName(
      join(hub.store.dir, SQUAD_SEQ_FILE), base,
      Object.values(world.state.agents).map((a) => a.squad),
    ),

    recall: (question, projectId) =>
      hub.memory.recall(question, { projectId, limit: 4 }).map((r) => ({
        question: r.entry.question,
        // A stored rule beats the one-off answer that produced it: the rule is
        // what the human actually wanted applied next time.
        answer: r.entry.rememberAs ?? r.entry.answer,
        score: r.score,
      })),

    remember: (question, answer, projectId) => {
      hub.memory.remember({ question, answer, projectId, at: Date.now() });
    },

    raiseToHuman(input) {
      /*
       * Quién pregunta, cuando el que llama no lo dijo.
       *
       * Sin opciones la respuesta es "nadie". Para CAPCOM es él mismo, y eso
       * importa: la consola agrupa la escalación en
       * la ventana del agente al que pertenece, así que sin esto una pregunta
       * del mando aparecería sin dueño en ninguna parte.
       */
      const agentId = input.agentId ?? hopts.defaultAgentId?.() ?? null;
      // Triaje de una pregunta existente: se anota el intento del CEO sobre el
      // registro original y se devuelve a la cola del humano. Un segundo
      // registro sería la misma pregunta dos veces en pantalla.
      const replaces = input.replaces ?? hopts.replacesFor?.(input.agentId ?? null) ?? null;
      const existing = replaces ? world.state.escalations[replaces] : undefined;
      if (existing) {
        world.attachCeoAttempt(existing.id, input.ceoAttempt);
        hub.pushCeoMessage({
          id: newId('msg'), role: 'ceo', at: Date.now(), actions: [],
          escalationId: existing.id,
          text: input.question,
        });
        return existing;
      }

      const esc: Escalation = {
        id: newId('esc'),
        agentId: agentId ?? '',
        projectId: input.projectId ?? '',
        machineId: (agentId && world.state.agents[agentId]?.machineId) || '',
        question: input.question,
        context: input.context,
        options: input.options,
        optionsOnly: false,
        urgency: input.urgency,
        status: 'pending',
        ceoAttempt: input.ceoAttempt,
        answer: null, answeredBy: null, rememberAs: null,
        askedAt: Date.now(), answeredAt: null, expiresAt: null,
      };
      world.upsertEscalationLocal(esc);
      // Say it in the conversation too. The operator should be able to live in
      // the CEO panel and still see everything the fleet needs from them.
      hub.pushCeoMessage({
        id: newId('msg'), role: 'ceo', at: Date.now(), actions: [],
        escalationId: esc.id,
        text: input.question,
      });
      return esc;
    },

    resolveEscalation(id, answer, by) {
      hub.answerEscalationLocal(id, answer, by);
    },

    /* ── tráfico entre agentes ────────────────────────────────────── */

    messages: () => Object.values(world.state.messages),
    message: (id) => world.state.messages[id],
    collisions: () => Object.values(world.state.collisions),

    relay(input) {
      const out = hub.relayMessage({
        kind: input.kind,
        scope: input.scope,
        toAgentId: input.toAgentId,
        toProjectId: input.toProjectId,
        toSquad: input.toSquad,
        subject: input.subject,
        body: input.body,
        files: input.files,
      });
      // Se devuelve a quién llegó de verdad, no a quién iba dirigido: el CEO
      // tiene que poder decirle al operador "no le llegó" en vez de dar por
      // hecho que sí.
      return {
        messageId: out.message.id,
        delivered: out.delivered,
        skipped: out.skipped,
        reason: out.reason,
      };
    },

    // El CEO contesta en lugar del destinatario. Firma la respuesta como suya:
    // quien preguntó merece saber que no se la contestó el agente al que
    // preguntó, por si acaso quería justamente a ése.
    answerPeer: (messageId, answer) => hub.replyToMessageLocal(messageId, answer, 'ceo'),

    acknowledgeCollision: (id) => hub.acknowledgeCollision(id),

    archiveAgents: (filter, opts) => hub.archiveAgents(filter, opts),
    retireAgent: (id, reason, by) => world.retireAgent(id, reason, by),
    archivedAgents: () => hub.archivedAgents(),
    unarchive: (id) => { hub.world.dropTombstone(id); },

    // El libro de presupuestos, con la flota ya atada: las herramientas piden
    // "cuánto lleva K9" y no tienen que saber de dónde salen los agentes.
    budgets: {
      set: (scope, limit) => hub.budgets.set(scope, limit),
      get: (scope) => hub.budgets.get(scope),
      setPendingByShortId: (shortId, limit) => hub.budgets.setPendingByShortId(shortId, limit),
      agentStatus: (agent) => hub.budgets.agentStatus(agent, world.state.agents, hub.missions.all()),
      scopeStatus: (scope) => hub.budgets.scopeStatus(scope, world.state.agents, hub.missions.all()),
      config: () => hub.budgets.cfg,
    },

    // La cámara vive en la consola: el hub sólo reparte la orden y cuenta
    // quién la oyó, para que CAPCOM pueda decir "no hay nadie mirando".
    show(directive) {
      hub.broadcast({ t: 'camera', directive });
      return hub.counts().consoles;
    },
  };

  return ctx;
}
