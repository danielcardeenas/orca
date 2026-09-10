/**
 * AUTOMEJORA, como tres herramientas de CAPCOM.
 *
 * El hub le pega un turno a CAPCOM con el informe de telemetría delante y le
 * pide que revise ORCA. Esto es por dónde vuelve la respuesta.
 *
 * `report_improvements` es la única salida. Se insiste en la descripción
 * porque el fallo natural de un modelo al que le piden una revisión es
 * escribirla en prosa: la prosa se queda en el CLI, no la ve el operador, y la
 * revisión se da por perdida a los cuarenta y cinco minutos. Lo mismo que pasa
 * con `report_mission`, y por la misma razón.
 *
 * Ninguna de las tres implementa nada, y lo dicen. Una revisión que se pone a
 * editar ficheros deja de ser una propuesta y pasa a ser un cambio que nadie
 * aprobó; lo que convierte una propuesta en trabajo es el operador pulsando
 * SEND, y eso abre una misión por el camino normal.
 */

import type { CeoContext, ToolOutcome, ToolSpec } from './tools.ts';
import {
  IMPROVE_AREAS, MAX_PER_REPORT, effectiveStatus, openProposals,
  type ImproveProposal, type ProposalDraft,
} from '../shared/improve.ts';

export const IMPROVE_TOOLS: ToolSpec[] = [
  {
    name: 'report_improvements',
    description:
      'File the result of an ORCA self-review. THIS IS THE ONLY WAY a proposal reaches the operator:'
      + ' prose written in the CLI is not stored, not shown, and the review is dropped as unanswered.'
      + ' Each proposal is one idea about ORCA itself — the console, CAPCOM, the workflow — never about the fleet\'s work.'
      + ' Two kinds, and the distinction is the point. kind="observed" rests on measurements and MUST carry `evidence`:'
      + ' figures quoted from the telemetry you were given or from the journal tools, never invented, never rounded into something stronger.'
      + ' kind="hypothesis" is an idea you believe in that the data cannot support yet — a new capability, a different shape, a hunch about'
      + ' what is slow or confusing. Those are wanted, not tolerated: file them, and state the assumption in `hypothesis`.'
      + ' Set `impact` and `effort` ONLY when you have something to base them on; a guessed estimate is worse than none, because the operator sorts by it.'
      + ' Reuse the `key` of an existing proposal (see list_improvements) when you mean the same idea — a repeat under a new key becomes a duplicate row and a second notification.'
      + ' Use `question` when a decision by the operator would change what you propose; you will get the answer back on a later turn.'
      + ' Never put a file path, a credential, or the text of anyone\'s conversation in a proposal.'
      + ' You do not implement any of this: the operator decides what becomes work.',
    input_schema: {
      type: 'object',
      properties: {
        review_id: {
          type: 'string',
          description: 'The id from the [ORCA SELF-REVIEW …] prompt you are answering. Omit only when filing unprompted.',
        },
        proposals: {
          type: 'array',
          description: `The proposals. At most ${MAX_PER_REPORT}; fewer and better beats more.`,
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Stable slug for this IDEA, lowercase-with-dashes, e.g. "capcom-turn-latency". Reuse an existing one to update it instead of duplicating.' },
              title: { type: 'string', description: 'The idea in a few words. Shown as the row.' },
              area: { type: 'string', description: `One of: ${IMPROVE_AREAS.join(', ')}.` },
              kind: { type: 'string', description: '"observed" (rests on measurements, needs evidence) or "hypothesis" (an idea the data cannot support yet, needs `hypothesis`).' },
              summary: { type: 'string', description: 'One or two sentences: what you propose and why. This is the only text read without opening anything.' },
              detail: { type: 'string', description: 'The long version: how it would work, what it touches, what it would break. Folded away in the console.' },
              evidence: { type: 'array', items: { type: 'string' }, description: 'Measured facts, quoted as given. Required for kind="observed". Never a number you did not read.' },
              hypothesis: { type: 'string', description: 'What you are assuming, plainly. Required for kind="hypothesis".' },
              question: { type: 'string', description: 'Something only the operator can settle, when it would change the proposal.' },
              impact: { type: 'string', description: 'low | medium | high. Only with grounds.' },
              effort: { type: 'string', description: 'low | medium | high. Only with grounds.' },
            },
            required: ['title', 'summary'],
            additionalProperties: false,
          },
        },
      },
      required: ['proposals'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_improvements',
    description:
      'The self-improvement board as it stands: every proposal with its key, status (a sent one follows its mission:'
      + ' completed once the mission is, archived once the mission is), whether it became a mission,'
      + ' the question it asked the operator and whatever the operator answered. Read it before filing so you reuse keys'
      + ' instead of duplicating ideas, and so you do not re-propose something already dismissed.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'open | snoozed | sent | completed | archived | dismissed | all. Default open.' },
        limit: { type: 'number', description: 'How many. Default 20.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'note_improvement',
    description:
      'Answer the operator on one proposal. Use it when the operator replied to a question you asked:'
      + ' the reply arrives as a turn naming the proposal, and this is how your answer gets back into the'
      + ' thread instead of into the CLI where nobody reads it. Keeps the whole exchange attached to the'
      + ' proposal, so what is eventually sent to implementation carries the conversation that shaped it.'
      + ' If the answer changes the idea, also re-file it with report_improvements under the same key.',
    input_schema: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string', description: 'The imp_… id.' },
        text: { type: 'string', description: 'What you want the operator to read.' },
      },
      required: ['proposal_id', 'text'],
      additionalProperties: false,
    },
  },
];

function row(p: ImproveProposal, now: number) {
  const answered = p.notes.filter((n) => n.role === 'human').at(-1);
  return {
    id: p.id,
    key: p.key,
    title: p.title,
    area: p.area,
    kind: p.kind,
    status: effectiveStatus(p, now),
    raised: p.raised,
    ...(p.impact ? { impact: p.impact } : {}),
    ...(p.effort ? { effort: p.effort } : {}),
    ...(p.question ? { question: p.question } : {}),
    ...(answered ? { operator_answered: answered.text } : {}),
    ...(p.missionId ? { mission_id: p.missionId } : {}),
  };
}

export async function runImproveTool(
  ctx: CeoContext, name: string, input: Record<string, unknown>,
): Promise<ToolOutcome | null> {
  if (name !== 'report_improvements' && name !== 'list_improvements' && name !== 'note_improvement') return null;
  if (!ctx.improve) {
    return {
      result: 'Self-review is not available on this hub.',
      summary: `${name} unavailable`, isError: true,
    };
  }
  const now = Date.now();

  if (name === 'list_improvements') {
    const state = ctx.improve.state();
    const want = String(input['status'] ?? 'open').toLowerCase();
    const limit = Math.min(60, Math.max(1, Number(input['limit']) || 20));
    const all = want === 'all'
      ? Object.values(state.proposals).sort((a, b) => b.updatedAt - a.updatedAt)
      : want === 'open' ? openProposals(state, now)
        : Object.values(state.proposals).filter((p) => effectiveStatus(p, now) === want).sort((a, b) => b.updatedAt - a.updatedAt);
    const rows = all.slice(0, limit).map((p) => row(p, now));
    return {
      result: JSON.stringify({ status: want, count: rows.length, proposals: rows }, null, 1),
      summary: `${rows.length} ${want} proposal${rows.length === 1 ? '' : 's'}`,
    };
  }

  if (name === 'note_improvement') {
    const id = String(input['proposal_id'] ?? '');
    const text = String(input['text'] ?? '');
    if (!id || !text.trim()) throw new Error('note_improvement needs proposal_id and text');
    const p = ctx.improve.note(id, 'capcom', text);
    return {
      result: JSON.stringify({ proposal_id: p.id, notes: p.notes.length }),
      summary: `answered on "${p.title}"`,
    };
  }

  const drafts = Array.isArray(input['proposals']) ? input['proposals'] as ProposalDraft[] : [];
  if (!drafts.length) throw new Error('report_improvements needs at least one proposal');
  const reviewId = typeof input['review_id'] === 'string' && input['review_id'] ? input['review_id'] : null;
  const out = ctx.improve.file(reviewId, drafts);

  // Lo rechazado vuelve como error CON los motivos y CON lo que sí entró: es
  // un turno en el que se puede corregir. Callar los motivos convertiría un
  // borrador mal formado en una propuesta que se perdió sin que nadie lo sepa.
  const summary = `${out.filed} new, ${out.merged} merged${out.rejected.length ? `, ${out.rejected.length} rejected` : ''}`;
  return {
    result: JSON.stringify({
      filed: out.filed, merged: out.merged,
      proposals: out.proposals.map((p) => ({ id: p.id, key: p.key, title: p.title, status: p.status })),
      ...(out.rejected.length ? { rejected: out.rejected } : {}),
    }, null, 1),
    summary,
    ...(out.filed === 0 && out.merged === 0 ? { isError: true } : {}),
  };
}
