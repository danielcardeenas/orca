export type TaskStatus = 'active' | 'completed' | 'failed';
export interface TaskMessage {
  id: string;
  role: 'human' | 'capcom' | 'agent' | 'system';
  text: string;
  at: number;
  agentId?: string;
}
export interface CapcomTask {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  agentIds: string[];
  agentSince?: Record<string, number>;
  squads?: string[];
  messages: TaskMessage[];
}
export const TASK_ID = /^task_[A-Za-z0-9_-]{1,100}$/;
export function taskPrompt(task: CapcomTask): string {
  const history = task.messages.slice(-8).map((m) => `${m.role}${m.agentId ? ` (${m.agentId})` : ''}: ${m.text.slice(0, 2000)}`).join('\n');
  return `[ORCA TASK ${task.id}] ${task.title}\nThis is a separate task conversation. Use only its context below; do not transfer decisions from other tasks. Pass task_id="${task.id}" to spawn_agent and launch_squad. Publish your response with report_task(task_id="${task.id}", text=your response, status="active" or "completed" or "failed"). Plain CLI prose is not delivered to this task. Mark completed only when the requested work is actually done.\nAssigned agents: ${task.agentIds.join(', ') || 'none'}\nConversation:\n${history}`;
}
