import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '../shared/types.ts';
import { newId } from '../shared/protocol.ts';
import { TASK_ID, type CapcomTask, type TaskMessage, type TaskStatus } from '../shared/tasks.ts';

/** Task IDs, not the currently open tab, own all messages and agent bindings. */
export class TaskStore {
  private tasks: Record<string, CapcomTask> = {};
  private file: string;
  constructor(dir: string, private changed: (task: CapcomTask) => void = () => {}) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'tasks.json');
    if (fs.existsSync(this.file)) {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, CapcomTask>;
      for (const [id, t] of Object.entries(loaded)) {
        if (!TASK_ID.test(id) || t.id !== id || !Array.isArray(t.messages) || !Array.isArray(t.agentIds)) throw new Error('Invalid tasks.json');
      }
      this.tasks = loaded;
    }
  }
  all(): Record<string, CapcomTask> { return structuredClone(this.tasks); }
  get(id: string): CapcomTask {
    const task = this.tasks[id];
    if (!task) throw new Error(`Unknown task: ${id}`);
    return structuredClone(task);
  }
  create(id: string, title: string): CapcomTask {
    if (!TASK_ID.test(id)) throw new Error('Invalid task id');
    if (this.tasks[id]) return this.get(id);
    if (Object.keys(this.tasks).length >= 100) throw new Error('Task limit reached (100)');
    const now = Date.now();
    return this.save({ id, title: title.trim().slice(0, 100) || 'New task', status: 'active', createdAt: now, updatedAt: now, agentIds: [], messages: [] });
  }
  message(id: string, role: TaskMessage['role'], text: string, status?: TaskStatus, agentId?: string): CapcomTask {
    if (!text.trim()) throw new Error('Empty task message');
    const task = this.get(id);
    if (role === 'human' && task.title === 'New task') task.title = text.trim().replace(/\s+/g, ' ').slice(0, 100);
    task.messages.push({ id: newId('msg'), role, text: text.slice(0, 8000), at: Date.now(), ...(agentId ? { agentId } : {}) });
    task.messages = task.messages.slice(-100);
    if (status) task.status = status;
    return this.save(task);
  }
  assign(id: string, agentIds: string[]): CapcomTask {
    const task = this.get(id);
    for (const other of Object.values(this.tasks)) {
      if (other.id !== id && other.status === 'active' && agentIds.some((a) => other.agentIds.includes(a))) throw new Error('Agent is already assigned to another active task');
    }
    task.agentSince ??= {};
    for (const agentId of agentIds) task.agentSince[agentId] ??= Date.now();
    task.agentIds = [...new Set([...task.agentIds, ...agentIds])].slice(0, 100);
    return this.save(task);
  }
  bindSquad(id: string, squad: string): void {
    const task = this.get(id);
    if (Object.values(this.tasks).some((other) => other.id !== id && other.status === 'active' && other.squads?.includes(squad))) throw new Error('Squad is already assigned to another active task');
    task.squads = [...new Set([...(task.squads ?? []), squad])];
    this.save(task);
  }
  observe(agents: Record<string, Agent>): void {
    for (const initial of Object.values(this.tasks)) {
      if (initial.status !== 'active') continue;
      let task = this.get(initial.id);
      // Keep both transcript segments bound to the task, including after restart.
      for (const a of Object.values(agents)) {
        if (a.continuation && task.agentIds.includes(a.continuation.fromId) && !task.agentIds.includes(a.id)) task = this.assign(task.id, [a.id]);
      }
      // Expand lineage and delayed squad IDs without guessing from whichever
      // CAPCOM turn happens to be visible now.
      const ids = new Set(task.agentIds);
      for (let pass = 0; pass < 8; pass++) {
        const before = ids.size;
        for (const a of Object.values(agents)) {
          if (a.startedAt >= task.createdAt && ((a.squad && task.squads?.includes(a.squad)) || (a.parentId && ids.has(a.parentId)))) ids.add(a.id);
        }
        if (ids.size === before) break;
      }
      if (ids.size !== task.agentIds.length) task = this.assign(task.id, [...ids]);
      for (const id of task.agentIds) {
        const a = agents[id];
        if (!a || !['idle', 'done', 'dead'].includes(a.state) || !a.lastSay) continue;
        const since = a.startedAt >= task.createdAt ? task.createdAt : task.agentSince?.[id] ?? task.createdAt;
        if (a.updatedAt < since) continue;
        const last = [...task.messages].reverse().find((m) => m.agentId === id);
        if (last?.text === a.lastSay.slice(0, 8000)) continue;
        task = this.message(task.id, 'agent', a.lastSay, undefined, id);
      }
    }
  }
  private save(task: CapcomTask): CapcomTask {
    task.updatedAt = Date.now();
    const next = { ...this.tasks, [task.id]: task };
    const json = JSON.stringify(next);
    if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new Error('Task history storage limit reached');
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, json, { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.tasks = next;
    this.changed(structuredClone(task));
    return structuredClone(task);
  }
}
