/**
 * Wires the CEO into the hub.
 *
 * The hub knows nothing about models and the CEO knows nothing about
 * websockets; this file is the only place the two meet. That seam is worth
 * keeping clean — it is what lets the hub run headless (a console with no CEO
 * is still a working fleet monitor) and what lets the CEO be tested against a
 * fake context with no network at all.
 */

import type { CeoAction, CeoMessage, Escalation } from '../shared/types.ts';
import { newId } from '../shared/protocol.ts';
import type { Hub } from '../hub/server.ts';
import { Ceo, type CeoEvents, type CeoOptions } from './ceo.ts';
import { FakeCeo } from './fake.ts';
import type { CeoContext } from './tools.ts';

export interface RuntimeOptions extends CeoOptions {
  /** Skip the model entirely. Used by tests and by `--no-ceo`. */
  disabled?: boolean;
  /**
   * Why the model is unavailable, if it is. Triggers the scripted CEO, which
   * still routes every agent question to the human — a console that cannot
   * think must not become a console that drops questions.
   */
  fallbackReason?: string;
}

/** Anything that can play CEO. Keeps the runtime honest about the seam. */
interface CeoLike {
  humanSays(text: string): Promise<void>;
  considerEscalation(esc: Escalation): Promise<void>;
}

export function attachCeo(hub: Hub, opts: RuntimeOptions = {}) {
  const world = hub.world;

  /** Messages currently streaming, so deltas land on the right record. */
  const live = new Map<string, CeoMessage>();

  const events: CeoEvents = {
    onStart(msg) {
      live.set(msg.id, msg);
      hub.pushCeoMessage(msg);
    },
    onDelta(id, text) {
      const m = live.get(id);
      if (!m) return;
      m.text += text;
      // Token-level frames, not whole messages: the console renders the CEO
      // typing rather than a long silence followed by a wall of text.
      hub.broadcast({ t: 'ceo:delta', id, text });
    },
    onAction(id, action: CeoAction) {
      const m = live.get(id);
      if (!m) return;
      const i = m.actions.findIndex((a) => a.id === action.id);
      if (i >= 0) m.actions[i] = action; else m.actions.push(action);
      hub.pushCeoMessage(m);
    },
    onDone(id) {
      const m = live.get(id);
      if (m) {
        m.streaming = false;
        // An assistant turn that produced only tool calls has no text worth
        // showing; the action rows already said what happened.
        if (!m.text.trim() && m.actions.length === 0) return;
        hub.pushCeoMessage(m);
      }
      live.delete(id);
      hub.broadcast({ t: 'ceo:done', id });
    },
    onThinking(on) {
      world.setCeoThinking(on);
    },
  };

  const ctx: CeoContext = {
    agents: () => Object.values(world.state.agents),
    projects: () => Object.values(world.state.projects),
    agent: (id) => world.state.agents[id],
    project: (id) => world.state.projects[id],
    escalation: (id) => world.state.escalations[id],

    dispatch: (_machineId, cmd) => hub.dispatch(cmd),

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
      // Triaje de una pregunta existente: se anota el intento del CEO sobre el
      // registro original y se devuelve a la cola del humano. Un segundo
      // registro sería la misma pregunta dos veces en pantalla.
      const existing = input.replaces ? world.state.escalations[input.replaces] : undefined;
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
        agentId: input.agentId ?? '',
        projectId: input.projectId ?? '',
        machineId: (input.agentId && world.state.agents[input.agentId]?.machineId) || '',
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

  if (opts.disabled) {
    return {
      ceo: null,
      onCeoSay(text: string) {
        hub.pushCeoMessage({
          id: newId('msg'), role: 'system', at: Date.now(), actions: [],
          text: `CEO disabled. Your message was recorded: "${text.slice(0, 80)}"`,
        });
      },
      onEscalation() { /* questions fall straight through to the human */ },
    };
  }

  let ceo: CeoLike;
  if (opts.fallbackReason) {
    ceo = new FakeCeo(ctx, events, { reason: opts.fallbackReason });
  } else {
    const real = new Ceo(ctx, events, opts);
    real.hydrate(world.state.ceo.messages);
    ceo = real;
  }

  return {
    ceo,
    onCeoSay(text: string) {
      void ceo.humanSays(text).catch((err) => {
        hub.pushCeoMessage({
          id: newId('msg'), role: 'system', at: Date.now(), actions: [],
          text: `CEO turn failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        world.setCeoThinking(false);
      });
    },
    onEscalation(escalationId: string) {
      const esc = world.state.escalations[escalationId];
      if (!esc || esc.status !== 'pending') return;
      // Mark it as the CEO's problem so the console shows it is being triaged
      // rather than sitting unread.
      world.markEscalationWithCeo(escalationId);
      void ceo.considerEscalation(esc).catch((err) => {
        console.warn('[ceo] escalation triage failed:', err);
        // Triage failing must not swallow the question: put it back in front
        // of the human, which is where it would have gone anyway.
        world.markEscalationPending(escalationId);
      });
    },
  };
}
