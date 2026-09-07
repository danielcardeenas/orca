import { hub } from '../src/ui/net/client.ts';
import { store as typedStore } from '../src/ui/store.ts';
import { mountAgent } from '../src/ui/windows/kinds/agent.ts';
const store: any = typedStore;
const now = Date.now();
const a: any = { id: 'fixture', callsign: '24', projectId: 'p', machineId: 'm', runtime: 'claude', model: 'fable', state: 'blocked', block: { kind: 'error', since: now, summary: "You've reached your Fable limit. Switch models with /model." }, role: 'agent', title: 'Finish heartbeat recovery', mission: 'Finish heartbeat recovery and verify pending tasks', origin: 'orca', childIds: [], parentId: 'lead', squad: 'autonomy-01', metrics: { costUSD: 0, inputTokens: 120, outputTokens: 1800, tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, turns: 1 }, uptimeMs: 30000, startedAt: now, updatedAt: now, pane: true };
store.world.agents.fixture = a; store.world.projects.p = { id: 'p', name: 'ORCA', code: 'OR', path: '/project' };
store.world.talk = { fixture: [{ id: 'prompt', agentId: 'fixture', kind: 'prompt', at: now - 1000, text: 'Finish the pending heartbeat work. Preserve existing changes.' }, { id: 'answer', agentId: 'fixture', kind: 'say', at: now - 500, text: 'The implementation is ready; the remaining integration tests are pending.' }] };
store.replaceWorld(store.world); store.linkUp = true;
export const calls: any[] = [];
let decision: any = null;
let plan: any = null;
hub.cmd = async cmd => {
  calls.push(cmd);
  if (cmd.k === 'recovery:status') return { decision };
  if (cmd.k === 'model:list') return { sessionId: a.id, runtime: 'claude', active: 'fable', phase: 'ready', requested: null, choices: [{ id: 'fable', label: 'Fable' }, { id: 'sonnet', label: 'Sonnet' }], events: [] };
  if (cmd.k === 'handoff:models') return [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', runtime: 'codex', installed: true }];
  if (cmd.k === 'handoff:prepare') return plan = { id: 'plan', fromId: a.id, fromRuntime: 'claude', fromModel: 'fable', runtime: 'codex', model: 'gpt-6-astra', archive: '/backup', historyPath: '/backup/conversation.md', checkpointPath: '/backup/HANDOFF.md', bytes: 40000, phase: 'review' };
  if (cmd.k === 'handoff:status') return plan;
  if (cmd.k === 'recovery:decide') {
    decision = { ...cmd.decision, by: 'human', at: now, phase: cmd.decision.action === 'wait' ? 'waiting' : 'applying', detail: 'Decision saved. Original conversation preserved.' };
    if (cmd.decision.action === 'handoff') plan.phase = 'preparing';
    return decision;
  }
  if (cmd.k === 'handoff:history') return { text: '## 2026-09-05 · user · original\n\nOriginal worker obligation, preserved in full.\n\n', next: null, total: 1 };
  throw new Error(`Unexpected fixture command ${cmd.k}`);
};
const console: any = { openAgent() {}, openFile() {}, note() {}, go() {}, openSpawn() {}, stop() {} };
mountAgent({ body: document.querySelector('main')!, win: { spec: { params: { agentId: a.id } } }, setTitle() {}, setCallsign() {}, setState() {} } as any, console);
export function complete() { plan.phase = 'complete'; plan.toId = 'continued'; }
