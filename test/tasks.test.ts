import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { TaskStore } from '../src/hub/tasks.ts';
import { taskPrompt } from '../src/shared/tasks.ts';
import type { Agent } from '../src/shared/types.ts';
import { startHub } from '../src/hub/server.ts';
import { HubStore } from '../src/hub/persist.ts';
import { FleetStore } from '../src/hub/fleets.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { createAuth } from '../src/hub/auth.ts';
import { hubContext } from '../src/agents/context.ts';
import { runTool } from '../src/agents/tools.ts';
import { test, ok, until } from './harness.ts';

function temporary(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-tasks-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
export default { suite: 'Task conversations', tests: [
  test('task history and agent ownership survive restart independently', () => {
    temporary((dir) => {
      const s = new TaskStore(dir);
      s.create('task_a', 'New task'); s.create('task_b', 'New task');
      s.message('task_a', 'human', 'Review delivery'); s.assign('task_a', ['worker']);
      s.message('task_b', 'human', 'Review navigation');
      s.message('task_a', 'capcom', 'Delivery reviewed', 'completed');
      const restored = new TaskStore(dir);
      assert.equal(restored.get('task_a').status, 'completed');
      assert.deepEqual(restored.get('task_a').agentIds, ['worker']);
      assert.equal(restored.get('task_b').messages.length, 1);
      assert(!taskPrompt(restored.get('task_b')).includes('Delivery reviewed'));
      assert.equal(restored.get('task_a').title, 'Review delivery');
    });
    return ok('persistent independent conversations', true);
  }),
  test('lineage and delayed squads collect results once without claiming completion', () => {
    temporary((dir) => {
      const s = new TaskStore(dir); s.create('task_a', 'A'); s.create('task_b', 'B');
      s.assign('task_a', ['root']); s.bindSquad('task_a', 'team-01');
      assert.throws(() => s.assign('task_b', ['root']));
      const now = Date.now();
      const agents = Object.fromEntries([
        { id: 'root', state: 'working', lastSay: 'Still working' },
        { id: 'child', parentId: 'root', state: 'idle', lastSay: 'Hello' },
        { id: 'late', squad: 'team-01', state: 'done', lastSay: 'World' },
      ].map((a) => [a.id, { ...a, startedAt: now, updatedAt: now } as unknown as Agent]));
      s.observe(agents); s.observe(agents);
      const task = s.get('task_a');
      assert.deepEqual(task.agentIds, ['root', 'child', 'late']);
      assert.deepEqual(task.messages.map((m) => m.text), ['Hello', 'World']);
      assert.equal(task.status, 'active');
      assert.equal(s.get('task_b').messages.length, 0);
    });
    return ok('results follow ownership and deduplicate', true);
  }),
  test('WebSocket creation, routing, late replies and reconnect preserve the right task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-task-wire-'));
    const token = 'orca-task-test-token'; const prompts: string[] = [];
    const hub = await startHub({ port: 0, host: '127.0.0.1', quiet: true,
      auth: createAuth({ ORCA_TOKEN: token } as NodeJS.ProcessEnv), store: new HubStore({ dir }),
      memory: new AnswerMemory(join(dir, 'memory.jsonl')), fleets: new FleetStore(join(dir, 'fleets')),
      onUnrouted: (text) => { prompts.push(text); },
    });
    const sockets: WebSocket[] = [];
    try {
      const frames: any[] = [];
      const connect = async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws/console?token=${token}`); sockets.push(ws);
        ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
        await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); }); return ws;
      };
      const ws = await connect();
      for (const id of ['a', 'b']) ws.send(JSON.stringify({ t: 'task:create', id: `create_${id}`, taskId: `task_${id}`, title: 'New task' }));
      assert(await until(() => frames.some((f) => f.cmdId === 'create_b'), 2000));
      for (const id of ['a', 'b']) ws.send(JSON.stringify({ t: 'ceo:say', id: `say_${id}`, taskId: `task_${id}`, text: `Request ${id}` }));
      assert(await until(() => prompts.length === 2, 2000));
      assert(prompts[1]!.includes('Request b')); assert(!prompts[1]!.includes('Request a'));
      const reply = await runTool(hubContext(hub), 'report_task', { task_id: 'task_a', text: 'A completed late', status: 'completed', agent_ids: [] });
      assert(!reply.isError);
      assert.equal(hub.tasks.get('task_b').messages.length, 1);
      const invalid = await runTool(hubContext(hub), 'report_task', { task_id: 'task_missing', text: 'Wrong', status: 'completed', agent_ids: [] });
      assert(invalid.isError);
      frames.length = 0; await connect();
      assert(await until(() => frames.some((f) => f.t === 'world'), 2000));
      const snapshot = frames.find((f) => f.t === 'world');
      assert.equal(snapshot.state.tasks.task_a.messages.at(-1).text, 'A completed late');
      assert.equal(snapshot.state.tasks.task_b.messages[0].text, 'Request b');
      hub.tasks.assign('task_b', ['worker']);
      const now = Date.now();
      hub.tasks.observe({ worker: { id: 'worker', state: 'done', lastSay: 'Worker finished', startedAt: now, updatedAt: now } as unknown as Agent });
      assert(await until(() => prompts.length === 3, 2000));
      assert(prompts[2]!.includes('[ORCA TASK task_b]')); assert(prompts[2]!.includes('Worker finished'));
      return ok('routing, explicit replies, reconnect and worker notification', true);
    } finally {
      sockets.forEach((s) => s.close()); await hub.close(); rmSync(dir, { recursive: true, force: true });
    }
  }),
] };
