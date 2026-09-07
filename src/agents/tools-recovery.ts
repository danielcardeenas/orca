import type { CeoContext, ToolSpec, ToolOutcome } from './tools.ts';
import type { RecoveryRequest } from '../shared/recovery.ts';

export const TOOLS: ToolSpec[] = [
  { name: 'inspect_recovery', description: 'Inspect a usage-limit incident, previous recovery decision, mission and budget. Optionally load native model and provider catalogs. Native models require an idle prompt. Catalogs do not prove credit or quota reset times. Use before recover_agent.', input_schema: {
    type: 'object', properties: { agent_id: { type: 'string' }, models: { type: 'boolean' } }, required: ['agent_id'], additionalProperties: false,
  } },
  { name: 'recover_agent', description: 'Decide how to recover an agent blocked by a usage limit: wait until review_at, change model in the same session, handoff to another provider with a complete backup, or retry once. Requires the exact incident from inspect_recovery and a reason weighing task difficulty, urgency, budget and observed quota failures. Waiting is valid. Never assume another model has credit. Handoff creates a new native session; old history and work ownership are preserved. Successful model/handoff/retry sends one continuation message. Poll inspect_recovery for the result. supervisor_id must be its ancestor/lead or CAPCOM; omitted means current CAPCOM.', input_schema: {
    type: 'object', properties: { agent_id: { type: 'string' }, incident: { type: 'string' }, action: { type: 'string', enum: ['wait', 'model', 'handoff', 'retry'] }, reason: { type: 'string' }, supervisor_id: { type: 'string' }, review_at: { type: 'number', description: 'UTC epoch milliseconds, for wait; review time, not an assumed quota reset.' }, runtime: { type: 'string', enum: ['claude', 'codex'] }, model: { type: 'string' } }, required: ['agent_id', 'incident', 'action', 'reason'], additionalProperties: false,
  } },
];
export async function run(ctx: CeoContext, name: string, input: Record<string, unknown>): Promise<ToolOutcome | null> {
  if (!TOOLS.some(t => t.name === name)) return null;
  const a = ctx.agents().find(a => a.id === input.agent_id || a.callsign.toLowerCase() === String(input.agent_id).toLowerCase());
  if (!a) throw new Error('Unknown agent');
  if (name === 'inspect_recovery') {
    const status = await ctx.dispatch(a.machineId, { k: 'recovery:status', agentId: a.id });
    const catalogs = input.models === true ? await Promise.allSettled([
      ctx.dispatch(a.machineId, { k: 'model:list', agentId: a.id }), ctx.dispatch(a.machineId, { k: 'handoff:models', agentId: a.id }),
    ]) : undefined;
    return { result: JSON.stringify({ status, mission: a.mission, parentId: a.parentId, squad: a.squad,
      budget: ctx.budgets?.agentStatus(a), catalogs: catalogs?.map(r => r.status === 'fulfilled' ? { ok: true, data: r.value } : { ok: false, detail: String(r.reason) }),
      relatedBlocks: ctx.agents().filter(o => o.runtime === a.runtime && o.block?.kind === 'error').map(o => ({ id: o.id, model: o.model, evidence: o.block!.summary })) }), summary: `recovery status ${a.callsign}` };
  }
  const supervisor = input.supervisor_id ? ctx.agents().find(a => a.id === input.supervisor_id || a.callsign === input.supervisor_id) : ctx.agents().find(a => a.role === 'capcom' && !['dead', 'done'].includes(a.state));
  if (!supervisor) throw new Error('A known supervisor is required');
  const decision: RecoveryRequest = { incident: String(input.incident ?? ''), action: input.action as RecoveryRequest['action'], reason: String(input.reason ?? ''), supervisorId: supervisor.id,
    reviewAt: input.review_at as number | undefined, runtime: input.runtime as string | undefined, model: input.model as string | undefined };
  const result = await ctx.dispatch(a.machineId, { k: 'recovery:decide', agentId: a.id, decision });
  return { result: JSON.stringify(result), summary: `${supervisor.callsign} decided ${decision.action} for ${a.callsign}` };
}
