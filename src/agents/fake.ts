/**
 * A deterministic stand-in for the CEO.
 *
 * Two jobs, and both matter more than they look:
 *
 *  1. It makes the whole agent→CEO→human loop testable without an API key and
 *     without spending anything. The interesting failure modes in this system
 *     are in the wiring — a question that reaches nobody, an answer that never
 *     gets back to the agent — and those are exactly what a scripted CEO
 *     exercises.
 *
 *  2. It is what runs when credentials are missing. A fleet console whose CEO
 *     cannot start should still route questions to the human rather than
 *     swallow them, and should say plainly why it is not thinking.
 *
 * Its policy is intentionally simple and honest about being simple: answer
 * from memory when memory has a close hit, otherwise ask the human. That is
 * the real CEO's policy with the judgement removed.
 */

import type { Escalation } from '../shared/types.ts';
import { newId } from '../shared/protocol.ts';
import type { CeoContext } from './tools.ts';
import type { CeoEvents } from './ceo.ts';

/**
 * Above this recall score, answering without the human is safe enough.
 *
 * Calibrated against the recalibrated similarity metric: a genuine paraphrase
 * of a stored question scores ~0.60-0.79, an unrelated question scores 0.00.
 * The gap is wide, so the exact number matters less than being inside it.
 */
const CONFIDENT = 0.55;

export interface FakeCeoOptions {
  /** Why the real CEO is not running. Shown to the operator once. */
  reason?: string;
}

export class FakeCeo {
  private ctx: CeoContext;
  private ev: CeoEvents;
  private reason: string;
  private toldThem = false;

  constructor(ctx: CeoContext, ev: CeoEvents, opts: FakeCeoOptions = {}) {
    this.ctx = ctx;
    this.ev = ev;
    this.reason = opts.reason ?? 'running without a model';
  }

  hydrate(): void { /* no history to restore */ }

  async humanSays(text: string): Promise<void> {
    const id = newId('ceo');
    this.ev.onStart({ id, role: 'ceo', text: '', at: Date.now(), actions: [], streaming: true });

    if (!this.toldThem) {
      this.toldThem = true;
      this.ev.onDelta(id, `I am not thinking right now — ${this.reason}. `);
    }

    // Still worth answering the one question the operator asks most, because
    // it needs no model: the fleet state is right here.
    if (/status|doing|running|qué|que hacen|estado/i.test(text)) {
      this.ev.onDelta(id, '\n' + this.statusLine());
      // El tráfico entre agentes también sale sin modelo, y es la mitad de la
      // respuesta a "¿por qué está parado eso?": un agente esperando a otro se
      // ve igual que uno pensando.
      const traffic = this.trafficLine();
      if (traffic) this.ev.onDelta(id, '\n' + traffic);
    } else {
      this.ev.onDelta(id, 'Questions from agents will still reach you directly.');
    }
    this.ev.onDone(id);
  }

  async considerEscalation(esc: Escalation): Promise<void> {
    const hits = this.ctx.recall(esc.question, esc.projectId || null);
    const best = hits[0];

    if (best && best.score >= CONFIDENT) {
      this.ctx.resolveEscalation(esc.id, best.answer, 'ceo');
      return;
    }

    this.ctx.raiseToHuman({
      replaces: esc.id,
      question: esc.question,
      context: esc.context,
      options: esc.options,
      urgency: esc.urgency,
      agentId: esc.agentId,
      projectId: esc.projectId,
      ceoAttempt: best
        ? {
          answer: best.answer,
          confidence: best.score,
          reason: `closest thing in memory scored ${best.score.toFixed(2)}, below the bar to act on`,
        }
        : {
          answer: '',
          confidence: 0,
          reason: `nothing in memory, and I am ${this.reason}`,
        },
    });
  }

  /**
   * Quién espera a quién, y qué archivos se están pisando. Sin juicio ninguno:
   * son hechos que ya están en el mundo y que nadie más va a leer en voz alta.
   */
  private trafficLine(): string {
    const lines: string[] = [];
    const name = (id: string | null): string =>
      id === null ? '?' : (id === 'ceo' ? 'CEO' : this.ctx.agent(id)?.callsign ?? id);

    const waiting = this.ctx.messages()
      .filter((m) => m.kind === 'ask' && m.answer === null)
      .sort((a, b) => a.at - b.at);
    for (const m of waiting.slice(0, 5)) {
      const mins = Math.round((Date.now() - m.at) / 60_000);
      lines.push(`${m.fromCallsign} espera a ${name(m.toAgentId)}: ${m.subject} (${mins}m)`);
    }
    if (waiting.length > 5) lines.push(`…y ${waiting.length - 5} preguntas más sin responder.`);

    const collisions = this.ctx.collisions().filter((c) => !c.acknowledged);
    for (const c of collisions.slice(0, 3)) {
      lines.push(`colisión en ${c.path}: ${c.agentIds.map(name).join(' y ')}`);
    }
    if (collisions.length > 3) lines.push(`…y ${collisions.length - 3} colisiones más.`);

    return lines.join('\n');
  }

  private statusLine(): string {
    const projects = this.ctx.projects().filter((p) => p.rollup.total > 0);
    if (!projects.length) return 'No active projects.';
    return projects.map((p) => {
      const b = p.rollup.byState;
      const bits = Object.entries(b).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`);
      return `${p.code} ${p.name}: ${bits.join(', ')} — $${p.rollup.costUSD.toFixed(2)}`;
    }).join('\n');
  }
}
