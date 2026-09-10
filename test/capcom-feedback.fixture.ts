import { store } from '../src/ui/store.ts';
import { emptyWorld, type Agent } from '../src/shared/types.ts';
import { mountCeo } from '../src/ui/windows/kinds/ceo.ts';
import { hub } from '../src/ui/net/client.ts';
import type { ProviderHandoffPlan } from '../src/shared/provider-handoff.ts';
import { parseHandoff } from '../src/shared/handoff.ts';
import type { WinCtx } from '../src/ui/windows/wm.ts';
import type { Console } from '../src/ui/console.ts';

export const event = parseHandoff({ fromId: 'old', toId: 'cap', machineId: 'm', at: 1788676926973,
  fromRuntime: 'claude', fromModel: 'claude-fable-5-1', toRuntime: 'codex', toModel: 'gpt-6-astra', reason: 'usage_limit',
  historyPath: '/tmp/recovery/conversation.md', checkpointPath: '/tmp/recovery/HANDOFF.md' })!;
const w = emptyWorld();
w.agents.cap = { id: 'cap', machineId: 'm', projectId: 'p', role: 'capcom', state: 'idle', runtime: 'codex', model: 'gpt-6-astra', callsign: 'CP',
  title: 'CAPCOM', parentId: null, childIds: [], depth: 0, squad: null, lead: false, block: null, mission: null, lastSay: null, lastPrompt: null,
  tool: null, toolDetail: null, startedAt: Date.now(), updatedAt: Date.now(), uptimeMs: 0, background: false, shortId: null,
  metrics: { costUSD: 0, tokensPerSec: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0 } } as Agent;
w.capcomHandoffs = [event];
w.talk = { cap: [ { id: 'p', agentId: 'cap', at: event.at + 100, kind: 'prompt', text: 'Confirma que recuerdas lo que quedó pendiente.' },
  { id: 'a', agentId: 'cap', at: event.at + 200, kind: 'say', text: 'Conservé las referencias al historial y a los pendientes. El módulo de higiene y la revisión de autonomy-01 siguen pendientes.' } ] };
store.replaceWorld(w);
store.linkUp = false;
localStorage.removeItem('orca.capcom.mission');
localStorage.removeItem('orca.capcom.task');
localStorage.removeItem('orca.capcom.tab');
export const openedFiles: string[] = [];
const c = { openFile: (file: { path: string }) => openedFiles.push(file.path), note() {}, openTerminal() {}, go() {} } as unknown as Console;
export const mounted = mountCeo({ body: document.querySelector('main')!, win: { id: 'handoff-fixture', el: document.querySelector('main')! }, setTitle() {}, setCallsign() {}, setState() {} } as unknown as WinCtx, c);

export function update(state: Agent['state'] = 'idle', block: Agent['block'] = null) {
  store.applyPatch(store.world.rev + 1, [{ o: 'agent:patch', id: 'cap', v: { state, block } }]);
}
export function link(up: boolean) { store.setLink(up); }
export function auth(ok: boolean) { store.setAuth(ok); }
export function outgoing(status: 'sending' | 'delivered' | 'accepted' | 'failed') {
  store.recordOutgoing({ id: 'out', agentId: null, text: 'Synthetic instruction', at: Date.now(), status });
}
export function received() {
  const m = store.outgoing[0]!;
  store.applyPatch(store.world.rev + 1, [{ o: 'talk', id: 'cap', v: [{ id: 'receipt', agentId: 'cap', kind: 'prompt', at: m.at + 100, text: m.text }] }]);
}
export const commands: string[] = [];
let statusFailures = 0;
export const plan: ProviderHandoffPlan = { id: 'fixture-plan', fromId: 'cap', fromRuntime: 'codex', fromModel: 'gpt-6-astra', runtime: 'claude', model: 'test-model', at: Date.now(), archive: '/tmp/archive', historyPath: '/tmp/history', checkpointPath: '/tmp/checkpoint', bytes: 100, sha256: 'test', phase: 'preparing', detail: 'Preparing synthetic destination' };
export function failStatus(n: number) { statusFailures = n; }
export function phase(next: ProviderHandoffPlan['phase']) { plan.phase = next; }
hub.cmd = async cmd => {
  commands.push(cmd.k);
  if (cmd.k === 'handoff:status') {
    if (statusFailures-- > 0) throw new Error('Synthetic status outage');
    return { ...plan };
  }
  if (cmd.k === 'capcom:new') return { ...plan };
  if (cmd.k === 'model:list') return { sessionId: 'cap', runtime: 'codex', active: 'gpt-6-astra', choices: [{ id: 'gpt-6-astra', label: 'Astra' }], phase: 'ready', requested: null, detail: '', events: [] };
  if (cmd.k === 'handoff:models') return [];
  throw new Error(`Unexpected fixture command: ${cmd.k}`);
};
export function hosted() { store.applyPatch(store.world.rev + 1, [{ o: 'agent:patch', id: 'cap', v: { pane: true } }]); }
