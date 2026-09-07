import './capcom-model.fixture.ts';
import { hub } from '../src/ui/net/client.ts';
import { store } from '../src/ui/store.ts';
import { mountCommand } from '../src/ui/hud/command.ts';
import type { Console } from '../src/ui/console.ts';
import type { ProviderHandoffPlan } from '../src/shared/provider-handoff.ts';
export const calls: { k: string; mode?: string }[] = [];
export const notes: string[] = [];
let plan: ProviderHandoffPlan | undefined;
const commandHost = document.createElement('div'); document.body.appendChild(commandHost);
mountCommand(commandHost, { openCeo() {}, note: (text: string) => notes.push(text), field: { select() {} } } as unknown as Console);
hub.cmd = async cmd => {
  calls.push(cmd);
  if (cmd.k === 'capcom:new') {
    plan = { id: '11111111-2222-4333-8444-555555555555', fromId: 'cap', fromRuntime: 'codex', fromModel: 'gpt-6-astra', runtime: 'codex', model: 'gpt-6-astra', contextMode: cmd.mode,
      at: Date.now(), archive: '/tmp/isolated-archive', historyPath: '/tmp/isolated-archive/conversation.md', checkpointPath: '/tmp/isolated-archive/HANDOFF.md', bytes: 12345, sha256: 'abc', phase: 'preparing', detail: 'Preparing new CAPCOM; messages held.' };
    return structuredClone(plan);
  }
  if (cmd.k === 'handoff:status') return structuredClone(plan);
  throw new Error(`Unexpected fixture command: ${cmd.k}`);
};
export function fail() { if (plan) plan = { ...plan, phase: 'failed', detail: 'Destination unavailable. Original CAPCOM retained; retry when ready.' }; }
export function complete() { if (plan) plan = { ...plan, phase: 'complete', toId: 'new-capcom', detail: 'Clean CAPCOM is active and waiting for new instructions.' }; }
export function link(up: boolean) { store.linkUp = up; store.applyPatch(store.world.rev + 1, []); }

store.applyPatch(store.world.rev + 1, [{ o: 'agent', id: 'cap', v: { ...store.world.agents.cap!, pane: true, state: 'idle' } }]);
