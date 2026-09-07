import './capcom-model.fixture.ts';
import { hub } from '../src/ui/net/client.ts';
import type { ProviderHandoffPlan } from '../src/shared/provider-handoff.ts';
const native = hub.cmd.bind(hub);
export const calls: string[] = [];
let plan: ProviderHandoffPlan = { id: '11111111-2222-4333-8444-555555555555', fromId: 'cap', fromRuntime: 'codex', fromModel: 'gpt-6-astra', runtime: 'claude', model: 'sonnet', at: Date.now(), archive: '/tmp/archive', historyPath: '/tmp/archive/conversation.md', checkpointPath: '/tmp/archive/HANDOFF.md', bytes: 123456, sha256: 'abc', phase: 'review', detail: 'Backup ready. Confirmation sends the archived conversation and pending tasks to Claude Code.' };
hub.cmd = async cmd => {
  calls.push(cmd.k);
  if (cmd.k === 'handoff:models') return [{ runtime: 'claude', id: 'sonnet', label: 'Sonnet', installed: true }, { runtime: 'claude', id: 'fable', label: 'Fable', installed: true }];
  if (cmd.k === 'handoff:prepare') { plan = { ...plan, phase: 'review', model: cmd.model }; return structuredClone(plan); }
  if (cmd.k === 'handoff:commit') { plan = { ...plan, phase: 'preparing', detail: 'Waiting for destination receipt.' }; return structuredClone(plan); }
  if (cmd.k === 'handoff:status') return structuredClone(plan);
  if (cmd.k === 'handoff:history') return { text: cmd.offset === 0 ? '## Previous session\n\nRemember the pending hygiene task.\n' : '## Beginning\n\nOriginal CAPCOM conversation.\n', total: 2, next: cmd.offset === 0 ? 1 : null };
  return native(cmd);
};
export function fail() { plan = { ...plan, phase: 'failed', detail: 'Destination quota exhausted. Original CAPCOM retained.' }; }
