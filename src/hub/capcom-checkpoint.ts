import type { WorldState } from '../shared/types.ts';
import type { MemoryEntry } from './memory.ts';

/** Metadata only: task conversations and full mail remain in the hub. */
export function freshCapcomCheckpoint(world: WorldState, rules: readonly MemoryEntry[]): string {
  const short = (s: string) => s.replace(/\s+/g, ' ').slice(0, 240);
  const section = (label: string, rows: string[], limit = 16) =>
    `${label} (${rows.length}):\n${rows.slice(0, limit).join('\n') || 'none'}${rows.length > limit ? `\n… ${rows.length - limit} more; retrieve through briefing, list_tasks, inspect_task and recall.` : ''}`;
  return [
    '# Fresh CAPCOM checkpoint',
    `Snapshot: ${new Date().toISOString()}. Call briefing before acting; snapshot is not new authorization.`,
    section('Open hub tasks', Object.values(world.tasks ?? {}).filter(t => t.status === 'active' && !t.archivedAt)
      .map(t => `${t.id}: ${short(t.title)}; agents=${t.agentIds.slice(0, 12).join(',') || 'none'}; last message=${t.messages.at(-1)?.id ?? 'none'}`)),
    section('Unresolved questions', Object.values(world.escalations).filter(e => ['pending', 'with_ceo'].includes(e.status))
      .map(e => `${e.id}: ${short(e.question)}; agent=${e.agentId ?? 'operator'}`)),
    section('Persistent operator rules', [...rules].sort((a, b) => b.at - a.at)
      .map(r => `${r.id} [${r.projectId ?? 'fleet'}]: ${short(r.rememberAs ?? r.answer)}`)),
    section('Fleet references', Object.values(world.agents).filter(a => a.role !== 'capcom' && !a.hidden)
      .map(a => `${a.id}: ${a.state}; squad=${a.squad ?? 'none'}; ${short(a.mission ?? a.title)}`)),
    'History references: inspect_task(task_id) for full task conversations; inspect_agent(agent_id) for workers; recall for complete persistent rules; briefing for current obligations. Existing hub state, rules, files and transcripts are retained. Incoming mail is held separately and delivered after cutover. Do not replay prior commands from history.',
  ].join('\n\n');
}
