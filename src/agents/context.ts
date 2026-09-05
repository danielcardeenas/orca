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
import type { CeoContext } from './tools.ts';

/**
 * How a caller wants the shared fleet context bent.
 *
 * There are two callers and they differ in exactly two places, both about
 * `ask_human`: the API CEO is nobody in the fleet, while CAPCOM *is* a session
 * in it, so a question it raises should be attributed to it and should land on
 * the record it was already handed.
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
 * Shared on purpose between the API CEO and the MCP server: the two commands
 * differ in where they run and who pays for them, and in nothing else. One
 * implementation of `spawn_agent` is how they stay that way.
 */
export function hubContext(hub: Hub, hopts: HubContextOptions = {}): CeoContext {
  const world = hub.world;

  const ctx: CeoContext = {
    agents: () => Object.values(world.state.agents),
    projects: () => Object.values(world.state.projects),
    agent: (id) => world.state.agents[id],
    project: (id) => world.state.projects[id],
    escalation: (id) => world.state.escalations[id],

    dispatch: (_machineId, cmd) => hub.dispatch(cmd),

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
       * Para el CEO de API la respuesta es "nadie": no es un agente. Para
       * CAPCOM es él mismo, y eso importa: la consola agrupa la escalación en
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
  };

  return ctx;
}
