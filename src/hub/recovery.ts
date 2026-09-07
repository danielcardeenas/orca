import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Agent } from '../shared/types.ts';
import type { Command } from '../shared/protocol.ts';
import { canSupervise, quotaIncident, type RecoveryDecision, type RecoveryRequest } from '../shared/recovery.ts';
import type { ProviderHandoffPlan } from '../shared/provider-handoff.ts';
import type { ModelControl } from '../shared/model-control.ts';

interface Deps {
  dir: string; agents(): Agent[]; dispatch(cmd: Command): Promise<unknown>;
  notifyAllowed?(supervisor: Agent, agent: Agent): boolean;
  notify(supervisor: Agent, text: string): Promise<boolean>;
  note(text: string, agentId: string): void;
  now?(): number;
  automatic?: boolean;
  budgetBlock?(a: Agent): string | null;
}
/** One explicit supervisory decision per observed incident. No blind fallback loop. */
export class RecoveryCoordinator {
  private records: Record<string, RecoveryDecision> = {};
  private notices: Record<string, { incident: string; at: number; supervisorId: string }> = {};
  private locks = new Set<string>();
  private ticking = false;
  private file: string;
  private automatic: boolean;
  private settingsFile: string;
  constructor(private deps: Deps) {
    this.file = path.join(deps.dir, 'recovery-state.json');
    this.settingsFile = path.join(deps.dir, 'recovery-settings.json');
    this.automatic = deps.automatic ?? false;
    if (fs.existsSync(this.settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      if (typeof settings.automatic !== 'boolean') throw new Error('Invalid recovery settings');
      this.automatic = settings.automatic;
    }
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.records = saved.records ?? {}; this.notices = saved.notices ?? {};
      // A send may have reached the CLI before a crash. Never send it twice.
      for (const r of Object.values(this.records)) if (r.phase === 'resuming' || (r.phase === 'applying' && r.action === 'handoff' && !r.planId)) {
        r.phase = 'failed'; r.detail = 'Interrupted with an uncertain result. Inspect the terminal and archive before retrying.';
      }
    }
  }
  settings() { return { automatic: this.automatic }; }
  setAutomatic(automatic: boolean) {
    if (typeof automatic !== 'boolean') throw new Error('automatic must be a boolean');
    fs.mkdirSync(this.deps.dir, { recursive: true });
    fs.writeFileSync(this.settingsFile + '.tmp', JSON.stringify({ automatic }), { mode: 0o600 });
    fs.renameSync(this.settingsFile + '.tmp', this.settingsFile);
    this.automatic = automatic;
    return this.settings();
  }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private save(r?: RecoveryDecision) {
    fs.mkdirSync(this.deps.dir, { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ records: this.records, notices: this.notices }), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file);
    if (r) { fs.appendFileSync(path.join(this.deps.dir, 'recovery-decisions.jsonl'), JSON.stringify(r) + '\n', { mode: 0o600 }); this.deps.note(`${r.by}: ${r.action} · ${r.phase} · ${r.reason}. ${r.detail}`, r.agentId); }
  }
  private agent(id: string) { const a = this.deps.agents().find(a => a.id === id); if (!a) throw new Error('Unknown agent'); return a; }
  status(id: string) {
    const a = this.agent(id);
    return { agentId: id, incident: quotaIncident(a), decision: this.records[id] ? structuredClone(this.records[id]) : null,
      supported: !!a.pane && !a.subagent && !['done', 'dead'].includes(a.state),
      limits: 'Catalog availability does not prove credit. Reset time and remaining subscription quota are unknown unless the CLI explicitly reports them.' };
  }
  async decide(id: string, input: RecoveryRequest) {
    const a = this.agent(id); const incident = quotaIncident(a);
    if (!incident || input.incident !== incident.id) throw new Error('Block changed. Inspect recovery status again.');
    if (!['wait', 'model', 'handoff', 'retry'].includes(input.action) || !input.reason?.trim() || input.reason.length > 2000) throw new Error('Choose an action and give a reason (max 2000 characters).');
    if (input.supervisorId) {
      const s = this.agent(input.supervisorId);
      if (!canSupervise(s, a, this.deps.agents())) throw new Error('Only this agent’s supervisor or CAPCOM can decide its recovery.');
    }
    const previous = this.records[id];
    if (this.locks.has(id) || (previous && ['applying', 'ready', 'resuming'].includes(previous.phase))) throw new Error('Recovery already in progress');
    if (previous?.incident === incident.id && previous.action === input.action && previous.model === input.model && previous.runtime === input.runtime && previous.phase !== 'waiting') throw new Error('This attempt already ran. Inspect its result instead of repeating it.');
    if (input.action === 'wait' && (!Number.isFinite(input.reviewAt) || input.reviewAt! <= this.now() || input.reviewAt! > this.now() + 7 * 86400000)) throw new Error('Choose a review time within the next seven days. This is a review, not a guaranteed quota reset.');
    const budgetBlock = input.action !== 'wait' ? this.deps.budgetBlock?.(a) : null;
    if (budgetBlock) throw new Error(budgetBlock);
    if (input.action !== 'wait' && (!a.pane || a.subagent)) throw new Error('Recovery needs a hosted root session. Recover the native subagent through its parent.');
    if (['model', 'handoff'].includes(input.action) && (!input.model || !/^[a-zA-Z0-9._-]{1,64}$/.test(input.model))) throw new Error('Choose a model from the current catalog');
    if (input.action === 'handoff' && !['claude', 'codex'].includes(input.runtime ?? '')) throw new Error('Choose a provider');
    const r: RecoveryDecision = { id: randomUUID(), agentId: id, incident: incident.id, at: this.now(), action: input.action, reason: input.reason.trim(), by: input.supervisorId ?? 'human', reviewAt: input.reviewAt, runtime: input.runtime, model: input.model,
      phase: input.action === 'wait' ? 'waiting' : 'applying', detail: input.action === 'wait' ? 'Original session retained. Supervisor will be asked to review at the chosen time.' : 'Attempt recorded before execution.' };
    this.records[id] = r; this.save(r); this.locks.add(id);
    try {
      if (input.action === 'model') {
        await this.deps.dispatch({ k: 'model:list', agentId: id });
        const state = await this.deps.dispatch({ k: 'model:set', agentId: id, model: input.model! }) as ModelControl;
        if (state.phase === 'ready' && !state.requested) { r.phase = 'ready'; }
      } else if (input.action === 'handoff') {
        const p = await this.deps.dispatch(input.planId ? { k: 'handoff:status', agentId: id, planId: input.planId } : { k: 'handoff:prepare', agentId: id, runtime: input.runtime!, model: input.model! }) as ProviderHandoffPlan;
        if (p.fromId !== id || p.runtime !== input.runtime || p.model !== input.model || p.phase !== 'review') throw new Error('Reviewed handoff does not match this decision');
        r.planId = p.id; this.save(r);
        await this.deps.dispatch({ k: 'handoff:commit', agentId: id, planId: p.id });
      } else if (input.action === 'retry') r.phase = 'ready';
      this.save(r);
    } catch (e) { r.phase = 'failed'; r.detail = String(e); this.save(r); }
    finally { this.locks.delete(id); }
    return structuredClone(r);
  }
  async tick() {
    if (this.ticking) return; this.ticking = true;
    try {
      for (const r of Object.values(this.records)) {
        if (this.locks.has(r.agentId)) continue;
        const a = this.deps.agents().find(a => a.id === r.agentId);
        if (!a) continue;
        try {
          if (r.phase === 'applying' && r.action === 'model') {
            const s = a.modelControl;
            if (s?.phase === 'failed') throw new Error(s.detail);
            if (s?.phase === 'ready' && s.active === r.model && s.events.some(e => e.at >= r.at && e.to === r.model)) r.phase = 'ready';
            else if (this.now() - r.at > 120000) throw new Error('Model change is unconfirmed; inspect terminal before retrying.');
          }
          if (r.phase === 'applying' && r.action === 'handoff' && r.planId) {
            const p = await this.deps.dispatch({ k: 'handoff:status', agentId: a.id, planId: r.planId }) as ProviderHandoffPlan;
            if (p.phase === 'failed') throw new Error(p.detail);
            if (p.phase === 'complete') { r.toId = p.toId; r.phase = 'ready'; }
          }
          if (r.phase === 'ready') {
            const target = this.deps.agents().find(a => a.id === (r.toId ?? r.agentId));
            if (!target || !target.pane) continue;
            const budgetBlock = this.deps.budgetBlock?.(target); if (budgetBlock) throw new Error(budgetBlock); // Wait for destination discovery.
            if (!['idle', 'blocked'].includes(target.state)) { r.phase = 'complete'; r.detail = 'Agent already resumed; no extra message sent.'; this.save(r); continue; }
            if (target.block && target.block.kind !== 'error') throw new Error('Agent is waiting for a different reason. Review it before resuming.');
            r.phase = 'resuming'; this.save(r);
            await this.deps.dispatch({ k: 'say', agentId: target.id, text: '[ORCA RECOVERY]\nThe supervisor selected recovery after a usage limit. Continue the unfinished authorized task from the preserved conversation. Inspect existing files and completed tool results before retrying side effects. Preserve the original scope and report any remaining blocker.' });
            r.phase = 'complete'; r.detail = 'Recovery applied and continuation sent once. Completion of the task is still unverified.'; this.save(r);
          }
        } catch (e) { r.phase = 'failed'; r.detail = String(e); this.save(r); }
      }
      await this.notifyDue();
    } finally { this.ticking = false; }
  }
  private async notifyDue() {
    const agents = this.deps.agents();
    // One coalesced message per available supervisor; shared quota failures do not cause a turn per worker.
    const groups = new Map<string, { supervisor: Agent; items: { a: Agent; incident: string; text: string }[] }>();
    for (const a of agents) {
      const incident = quotaIncident(a); if (!incident) continue;
      const r = this.records[a.id];
      if ((a.subagent || !a.pane) && !r) continue;
      if (!this.automatic && !r) continue;
      if (r && ['applying', 'ready', 'resuming'].includes(r.phase)) continue;
      if (r?.phase === 'waiting' && r.reviewAt! > this.now()) continue;
      let supervisor = agents.filter(s => s.pane && s.state === 'idle' && canSupervise(s, a, agents)).sort((x, y) => Number(x.role === 'capcom') - Number(y.role === 'capcom') || Number(y.id === a.parentId) - Number(x.id === a.parentId))[0];
      if (!supervisor) continue;
      const key = incident.id + (r ? `:${r.id}:${r.phase}` : ''); const notice = this.notices[a.id];
      if (notice?.incident === key && notice.at + 300000 <= this.now() && supervisor.role !== 'capcom') {
        supervisor = agents.find(s => s.role === 'capcom' && s.pane && s.state === 'idle' && canSupervise(s, a, agents)) ?? supervisor;
      }
      if (notice?.incident === key && (notice.supervisorId === supervisor.id || this.now() - notice.at < 300000)) continue;
      if (this.deps.notifyAllowed?.(supervisor, a) === false) continue;
      const group = groups.get(supervisor.id) ?? { supervisor, items: [] };
      group.items.push({ a, incident: key, text: `${a.callsign} (${a.id}) · ${a.runtime}/${a.model ?? '?'} · mission: ${a.mission ?? '?'} · error: ${incident.evidence}${r ? ` · previous decision: ${r.action}/${r.phase}: ${r.reason}` : ''}` }); groups.set(supervisor.id, group);
    }
    for (const { supervisor, items } of groups.values()) {
      const text = '[ORCA USAGE LIMIT]\n' + items.map(i => i.text).join('\n') + '\nUse inspect_recovery then recover_agent (or the CLI helper) to decide: wait with a review time, change model in the same session, handoff with full backup, or retry once. Consider task difficulty, urgency, budget and observed quota failures; catalog entries do not prove credit. Prefer preserving the session when a suitable model is available. Do not retry the same exhausted option blindly. Record the reason. Waiting is a valid decision.'
        + `\nCLI fallback on the hub machine: node ${JSON.stringify(fileURLToPath(new URL('../../bin/orca-recover.mjs', import.meta.url)))} inspect <callsign> --models; then decide <callsign> <decision.json>. On remote machines use the installed orca-recover with ORCA_HUB_HTTP and the hub credential configured.`;
      if (await this.deps.notify(supervisor, text)) { for (const i of items) this.notices[i.a.id] = { incident: i.incident, at: this.now(), supervisorId: supervisor.id }; this.save(); }
    }
  }
}
