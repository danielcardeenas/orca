/**
 * Pieza E del squad autonomy: herramientas MCP de `journal`.
 *
 * Dos verbos sobre el diario de la flota (hub/journal.ts):
 *
 *   journal        consulta con filtros; devuelve entradas compactas
 *   journal_stats  coste y duración medios por proyecto, done vs dead,
 *                  briefs que acabaron en escalación
 *
 * Y `briefingLines`, que `briefing` (tools.ts) puede llamar en una línea para
 * enseñarle a un CAPCOM recién nacido qué terminó desde el último briefing.
 *
 * Contrato con extensions.ts: `TOOLS` con la forma de CEO_TOOLS y `run` que
 * devuelve null cuando el nombre no es suyo. Lo que hace falta del hub llega
 * por `ctx.autonomy?.journal`.
 */

import type { CeoContext, ToolOutcome, ToolSpec } from './tools.ts';
import {
  JOURNAL_KINDS, MAX_LIMIT, DEFAULT_LIMIT, parseWhen,
  type JournalEntry, type JournalKind, type JournalQuery,
} from '../hub/journal.ts';
import { fmtTokens } from '../hub/budgets.ts';

const WHEN = 'A window edge: "24h", "3d", "90m", an ISO date, or epoch ms. Null for no bound.';

export const TOOLS: ToolSpec[] = [
  {
    name: 'journal',
    description:
      'The fleet journal: every launch (who launched it, the full brief, runtime, model), every end (final state, tokens used, duration, lines changed, last message), every escalation and who answered it (CAPCOM or human) or why it was withdrawn instead (the agent moved on, a permission dialog changed, the agent left, superseded, expired, dismissed), every CAPCOM rotation and every landing — persisted across sessions and hub restarts. This is how a new CAPCOM learns what earlier ones did: read it before re-launching something that already ran, and before writing a brief like one that ended in an escalation. Returns compact entries, newest first unless asked otherwise; `full` returns the whole brief and message. For averages and rates call journal_stats.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: ['string', 'null'], description: 'Project id or code. Null for all.' },
        squad: { type: ['string', 'null'], description: 'Squad label, e.g. "audit-01". Null for all.' },
        mission_id: { type: ['string', 'null'], description: 'Only entries of agents bound to this ORCA mission. Null for all.' },
        agent: { type: ['string', 'null'], description: 'Agent id or callsign. Null for all.' },
        kind: { type: ['string', 'null'], enum: [...JOURNAL_KINDS, null], description: 'One kind: launch, end, escalation, answer, withdraw, rotation, landing. Null for every kind.' },
        since: { type: ['string', 'null'], description: WHEN },
        until: { type: ['string', 'null'], description: WHEN },
        state: { type: ['string', 'null'], enum: ['done', 'dead', null], description: 'Only `end` entries with this final state. Null for any.' },
        by: { type: ['string', 'null'], enum: ['human', 'capcom', 'agent', null], description: 'Only `launch` entries made by this party. Null for any.' },
        text: { type: ['string', 'null'], description: 'Free text matched (accents and case ignored) against the brief, the last message, the question, the answer and the title. Null for no text filter.' },
        limit: { type: ['integer', 'null'], description: `At most this many. Null for ${DEFAULT_LIMIT}; max ${MAX_LIMIT}.` },
        newest_first: { type: 'boolean', description: 'True (the default) for newest first; false for oldest first.' },
        full: { type: 'boolean', description: 'Return the full brief, last message, question and answer instead of the clipped ones.' },
      },
      required: ['project', 'squad', 'mission_id', 'agent', 'kind', 'since', 'until', 'state', 'by', 'text', 'limit', 'newest_first', 'full'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'journal_stats',
    description:
      'A summary of the fleet journal: launches by who launched them, done vs dead and the done rate, separate input, output, cache-read and cache-write token maxima per session, unknown historical writes explicitly null, legacy mixed ceiling totals for compatibility, and average duration overall and per project, escalations split into answered (by whom), withdrawn (by cause: nobody owed those an answer) and unanswered (asked in the window and still open), CAPCOM rotations, landings — and the briefs that ended in an escalation, which are the ones to write better next time. Narrow it with a project or a time window.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: ['string', 'null'], description: 'Project id or code. Null for all.' },
        squad: { type: ['string', 'null'], description: 'Squad label. Null for all.' },
        since: { type: ['string', 'null'], description: WHEN },
        until: { type: ['string', 'null'], description: WHEN },
      },
      required: ['project', 'squad', 'since', 'until'],
      additionalProperties: false,
    },
    strict: true,
  },
];

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Recorte de una entrada para el modelo: lo largo se acorta, lo demás se queda. */
export const COMPACT_CHARS = 200;
export function compact(e: JournalEntry): JournalEntry {
  const cut = (s: string | null | undefined): string | null | undefined =>
    (typeof s === 'string' && s.length > COMPACT_CHARS ? `${s.slice(0, COMPACT_CHARS - 1)}…` : s);
  const out: JournalEntry = { ...e };
  if ('brief' in out) out.brief = cut(out.brief);
  if ('lastSay' in out) out.lastSay = cut(out.lastSay);
  if ('question' in out) out.question = cut(out.question);
  if ('answer' in out) out.answer = cut(out.answer);
  if ('reason' in out) out.reason = cut(out.reason);
  return out;
}

/**
 * Los filtros de la herramienta, en la consulta del diario. Un `since` que no
 * se entiende es un error dicho en voz alta, no una consulta sin límite que
 * devuelve todo y parece correcta.
 */
export function queryOf(input: Record<string, unknown>, now = Date.now()): JournalQuery | { error: string } {
  const since = parseWhen(input.since, now);
  if (input.since != null && input.since !== '' && since === null) return { error: `cannot read since="${String(input.since)}": use "24h", "3d", an ISO date or epoch ms` };
  const until = parseWhen(input.until, now);
  if (input.until != null && input.until !== '' && until === null) return { error: `cannot read until="${String(input.until)}": use "24h", "3d", an ISO date or epoch ms` };
  const kind = str(input.kind);
  if (kind && !(JOURNAL_KINDS as readonly string[]).includes(kind)) return { error: `unknown kind "${kind}": ${JOURNAL_KINDS.join(', ')}` };
  const state = str(input.state);
  if (state && state !== 'done' && state !== 'dead') return { error: `state is done or dead, not "${state}"` };
  const by = str(input.by);
  if (by && by !== 'human' && by !== 'capcom' && by !== 'agent') return { error: `by is human, capcom or agent, not "${by}"` };
  const limit = input.limit == null ? null : Number(input.limit);
  if (limit !== null && (!Number.isFinite(limit) || limit < 1)) return { error: 'limit must be a positive integer' };
  return {
    project: str(input.project), squad: str(input.squad), missionId: str(input.mission_id) ?? str(input.task_id), agent: str(input.agent),
    kind: (kind as JournalKind | null), since, until,
    state: state as 'done' | 'dead' | null, by: by as JournalQuery['by'],
    text: str(input.text), limit, order: input.newest_first === false ? 'asc' : 'desc',
    // La serie completa hay que pedirla: el defecto es uso real (hub/journal.ts).
    includeSynthetic: input.include_synthetic === true,
  };
}

/**
 * Lo terminado desde el último briefing, para la sección de `briefing`.
 * Vacío cuando el hub no montó el diario: la sección no se imprime.
 */
export function briefingLines(ctx: CeoContext, now = Date.now()): string[] {
  const j = ctx.autonomy?.journal;
  if (!j || typeof j.briefingLines !== 'function') return [];
  try { return j.briefingLines(now); } catch { return []; }
}

export function run(ctx: CeoContext, name: string, input: Record<string, unknown>): ToolOutcome | null {
  if (name !== 'journal' && name !== 'journal_stats') return null;
  const j = ctx.autonomy?.journal;
  if (!j || typeof j.query !== 'function') {
    return { result: 'the journal is not mounted on this hub', summary: `${name}: no journal`, isError: true };
  }
  const q = queryOf(input);
  if ('error' in q) return { result: q.error, summary: `${name} refused: ${q.error}`, isError: true };

  if (name === 'journal_stats') {
    const s = j.stats({ project: q.project, squad: q.squad, since: q.since, until: q.until });
    const scope = [q.project ? `project ${q.project}` : null, q.squad ? `squad ${q.squad}` : null, q.since ? `since ${new Date(q.since).toISOString()}` : null]
      .filter(Boolean).join(', ');
    return {
      result: JSON.stringify(s, null, 1),
      summary: `journal stats${scope ? ` (${scope})` : ''}: ${s.launches} launch(es), ${s.ends.done} done / ${s.ends.dead} dead`
        + (s.doneRate !== null ? ` (${Math.round(s.doneRate * 100)}% done)` : '')
        // Las mismas tres cifras que el digest de AUTOMEJORA, con la misma
        // regla: retirada no es sin respuesta.
        + `, ${fmtTokens(s.usage.tokens)} legacy mixed tokens over ${s.usage.measured} measured session(s); ${fmtTokens(s.tokenComponents.cacheRead)} cache-read tokens, new tokens: ${s.tokenComponents.newTokens === null ? 'unknown (missing measurements)' : fmtTokens(s.tokenComponents.newTokens)}, ${s.escalations.asked} escalation(s) (${s.escalations.answeredByCapcom + s.escalations.answeredByHuman} answered, ${s.escalations.withdrawn} withdrawn, ${s.escalations.unanswered} unanswered), ${s.escalatedBriefs.length} brief(s) that escalated`
        // Lo apartado se dice con el total, o el total miente por omisión.
        + (s.excluded > 0 ? ` · ${s.excluded} harness entr${s.excluded === 1 ? 'y' : 'ies'} excluded` : ''),
    };
  }

  const entries = j.query(q);
  const shown = input.full === true ? entries : entries.map(compact);
  return {
    result: JSON.stringify({ count: shown.length, entries: shown }, null, 1),
    summary: `journal: ${shown.length} entr${shown.length === 1 ? 'y' : 'ies'}`
      + (q.kind ? ` of kind ${q.kind}` : '') + (q.project ? ` on ${q.project}` : '') + (q.squad ? ` in ${q.squad}` : '')
      + (q.text ? ` matching "${q.text}"` : ''),
  };
}
