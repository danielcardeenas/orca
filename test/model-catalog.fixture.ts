import { mountCapcomModel } from '../src/ui/windows/capcom-model.ts';
import type { Agent } from '../src/shared/types.ts';
import type { Command } from '../src/shared/protocol.ts';
export const calls: Command[] = [];
let mounted: ReturnType<typeof mountCapcomModel>;
let scenario = 'ready';
export function setup(runtime: 'codex' | 'claude', worker: boolean, mode = 'ready') {
  mounted?.dispose(); calls.length = 0; scenario = mode;
  const host = document.querySelector<HTMLElement>('main')!; host.replaceChildren();
  const own = runtime === 'codex' ? ['gpt-6-astra', 'gpt-5.6-terra'] : ['opus', 'sonnet'];
  mounted = mountCapcomModel(host, async cmd => {
    calls.push(cmd);
    if (cmd.k === 'model:list') {
      if (scenario === 'native-error') throw new Error('native unavailable');
      return { sessionId: 'fixture-agent', runtime, active: own[0], choices: scenario === 'fresh' ? [] : own.map(id => ({ id, label: id })), requested: null, phase: 'ready', detail: '', events: [] };
    }
    if (cmd.k === 'handoff:models') {
      if (scenario === 'provider-error') throw new Error('collector unavailable');
      if (scenario === 'malformed') return { models: [] };
      return ['codex', 'claude'].flatMap(runtime => (runtime === 'codex' ? ['gpt-6-astra', 'gpt-5.6-terra'] : ['opus', 'sonnet']).map(id => ({ runtime, id, label: id, installed: true })));
    }
    if (cmd.k === 'handoff:prepare') return { id: 'review', fromId: 'fixture-agent', fromRuntime: runtime, runtime: cmd.runtime, model: cmd.model, phase: 'review', bytes: 0 };
    if (cmd.k === 'model:set') return { runtime, active: cmd.model, choices: [], phase: 'ready' };
    throw new Error('Unexpected command: ' + cmd.k);
  }, () => {}, undefined, worker ? { scope: 'fixture', openAgent() {} } : undefined);
  mounted.update({ id: 'fixture-agent', runtime, model: own[0], pane: '%fixture', state: 'idle' } as unknown as Agent, true);
}
export function recover() { scenario = 'ready'; }
