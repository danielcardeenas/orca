/**
 * What the task panel says about each task, derived, no DOM.
 *
 * The hub keeps a task's conversation and its agent bindings (`CapcomTask`)
 * and tells the console about every change; it does not say whether the
 * task is waiting on the operator, being worked, or sitting in the queue.
 * That reading is made here, from the conversation and the fleet, so the
 * panel and its tests agree on one rule:
 *
 *   completed / failed   the hub's own status
 *   in progress          an assigned agent is alive
 *   waiting on you       nobody alive, and the last word was CAPCOM's
 *   queued               nobody alive, and CAPCOM has not answered yet
 *
 * Alive beats the last word on purpose: CAPCOM saying "launched two, will
 * report back" while those two run is work, not a question.
 */

import type { CapcomTask } from '../../shared/tasks.ts';
import type { Agent } from '../../shared/types.ts';
import { alive } from '../store.ts';

export type TaskPhase = 'waiting' | 'progress' | 'queued' | 'completed' | 'failed';

export const PHASE_WORD: Record<TaskPhase, string> = {
  waiting: 'WAITING ON YOU',
  progress: 'IN PROGRESS',
  queued: 'QUEUED',
  completed: 'COMPLETED',
  failed: 'FAILED',
};

export interface Crew { id: string; callsign: string }

export interface TaskRow {
  id: string;
  title: string;
  phase: TaskPhase;
  /** Assigned agents still alive, in assignment order. */
  crew: Crew[];
  /** The last movement: the task's own, or a live agent's, whichever is later. */
  at: number;
}

export type AgentOf = (id: string) => Agent | undefined;

/** The assigned agents that are still running. CAPCOM itself is never crew. */
export function liveCrew(task: CapcomTask, agentOf: AgentOf): Agent[] {
  const out: Agent[] = [];
  for (const id of task.agentIds) {
    const a = agentOf(id);
    if (a && a.role !== 'capcom' && alive(a)) out.push(a);
  }
  return out;
}

export function taskPhase(task: CapcomTask, crew: readonly Agent[]): TaskPhase {
  if (task.status === 'completed' || task.status === 'failed') return task.status;
  if (crew.length) return 'progress';
  const last = task.messages.at(-1);
  return last?.role === 'capcom' ? 'waiting' : 'queued';
}

/** The task's title, or the first thing the human said; cut to `max` on a space where one is near. */
export function taskTitle(task: CapcomTask, max = 40): string {
  const own = task.title.trim();
  const first = task.messages.find((m) => m.role === 'human')?.text ?? '';
  const raw = (own && own !== 'New task' ? own : first).replace(/\s+/g, ' ').trim() || 'NEW TASK';
  if (raw.length <= max) return raw;
  const cut = raw.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function movedAt(task: CapcomTask, crew: readonly Agent[]): number {
  let at = task.updatedAt;
  for (const a of crew) if (a.updatedAt > at) at = a.updatedAt;
  return at;
}

const OPEN: ReadonlySet<TaskPhase> = new Set(['waiting', 'progress', 'queued']);
export const isOpen = (phase: TaskPhase): boolean => OPEN.has(phase);

/** Every task as a row, open ones first, each group by last movement, newest on top. */
export function taskRows(tasks: Iterable<CapcomTask>, agentOf: AgentOf): TaskRow[] {
  const rows: TaskRow[] = [];
  for (const task of tasks) {
    const crew = liveCrew(task, agentOf);
    rows.push({
      id: task.id,
      title: taskTitle(task),
      phase: taskPhase(task, crew),
      crew: crew.map((a) => ({ id: a.id, callsign: a.callsign })),
      at: movedAt(task, crew),
    });
  }
  return rows.sort((a, b) => {
    const ao = isOpen(a.phase) ? 0 : 1, bo = isOpen(b.phase) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return b.at - a.at || a.id.localeCompare(b.id);
  });
}

export interface RowGroups {
  open: TaskRow[];
  /** Finished tasks the panel shows in full: the newest `recent`. */
  done: TaskRow[];
  /** Finished tasks folded under "…and N more". */
  more: TaskRow[];
}

/** Split sorted rows into what is shown and what folds. `recent` finished rows stay visible. */
export function splitRows(rows: readonly TaskRow[], recent: number): RowGroups {
  const open = rows.filter((r) => isOpen(r.phase));
  const finished = rows.filter((r) => !isOpen(r.phase));
  const n = Math.max(0, Math.floor(recent));
  return { open, done: finished.slice(0, n), more: finished.slice(n) };
}
