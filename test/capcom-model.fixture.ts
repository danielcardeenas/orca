import './capcom-handoff.fixture.ts';
import { store } from '../src/ui/store.ts';
import { hub } from '../src/ui/net/client.ts';
import type { ModelControl } from '../src/shared/model-control.ts';
export const commands: unknown[] = [];
const initial: ModelControl = { sessionId: 'same-session', runtime: 'codex', active: 'gpt-6-astra', choices: [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' }, { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
], requested: null, phase: 'ready', detail: '', events: [] };
let state = structuredClone(initial);
hub.cmd = async cmd => {
  commands.push(cmd);
  if (cmd.k === 'handoff:models') return [
    { runtime: 'codex', id: 'gpt-6-astra', label: 'GPT-6 Astra', installed: true },
    { runtime: 'codex', id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', installed: true },
    { runtime: 'claude', id: 'sonnet', label: 'Sonnet', installed: true },
  ];
  if (cmd.k === 'model:set') {
    state = { ...state, requested: cmd.model, phase: cmd.model ? 'queued' : 'ready', detail: cmd.model ? 'Waiting for the current turn to finish.' : '' };
    update();
  }
  return structuredClone(state);
};
export function update() { store.applyPatch(store.world.rev + 1, [{ o: 'agent', id: 'cap', v: { ...store.world.agents.cap!, modelControl: structuredClone(state) } }]); }
export function confirm() {
  const event = { id: 'model-event', at: Date.now(), from: 'gpt-6-astra', to: 'gpt-5.6-terra', text: 'Model changed: gpt-6-astra → gpt-5.6-terra · Same conversation. Applies to subsequent turns.' };
  state = { ...state, active: event.to, requested: null, phase: 'ready', detail: event.text, events: [event] }; update();
}
export function fail() { state = { ...state, phase: 'failed', detail: 'Change unconfirmed. Open the terminal to inspect the CLI dialog.' }; update(); }
update();
