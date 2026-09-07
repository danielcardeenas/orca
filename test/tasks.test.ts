import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { TaskStore } from '../src/hub/tasks.ts';
import { taskPrompt, visibleTasks } from '../src/shared/tasks.ts';
import type { Agent } from '../src/shared/types.ts';
import { startHub } from '../src/hub/server.ts';
import { HubStore } from '../src/hub/persist.ts';
import { FleetStore } from '../src/hub/fleets.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { createAuth } from '../src/hub/auth.ts';
import { hubContext } from '../src/agents/context.ts';
import { freshCapcomCheckpoint } from '../src/hub/capcom-checkpoint.ts';
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
  test('archiving retires a task reversibly, frees its slot, and purging needs it archived first', () => {
    temporary((dir) => {
      const s = new TaskStore(dir);
      s.create('task_a', 'Ship the console'); s.message('task_a', 'human', 'Ship the console', 'completed');
      s.create('task_b', 'Still running');
      // Hasta aquí una tarea creada no salía nunca de la vista, y a las cien el
      // hub dejaba de poder crear.
      assert.throws(() => s.purge('task_a'), /Archive the task before purging/);
      const archived = s.archive('task_a');
      assert.ok(archived.archivedAt && archived.messages.length === 1);
      assert.deepEqual(visibleTasks(s.all()).map((t) => t.id), ['task_b']);
      assert.equal(new TaskStore(dir).get('task_a').archivedAt, archived.archivedAt);
      assert.ok(!s.archive('task_a', false).archivedAt, 'restoring brings it back whole');
      assert.equal(s.get('task_a').messages[0]!.text, 'Ship the console');

      // El tope cuenta lo que está a la vista: cien archivadas no bloquean.
      s.archive('task_a');
      for (let i = 0; i < 99; i++) s.create(`task_f${i}`, `Filler ${i}`);
      assert.throws(() => s.create('task_over', 'One too many'), /Task limit reached/);
      s.archive('task_f0');
      assert.equal(s.create('task_over', 'Now there is room').id, 'task_over');

      const purged: string[] = [];
      const watched = new TaskStore(dir, (t) => { if ((t as { purged?: true }).purged) purged.push(t.id); });
      watched.purge('task_a');
      assert.throws(() => watched.get('task_a'), /Unknown task/);
      assert.throws(() => new TaskStore(dir).get('task_a'), /Unknown task/);
      assert.deepEqual(purged, ['task_a']);
      assert.equal(watched.get('task_b').title, 'Still running', 'purging one leaves the rest');
    });
    return ok('archive is reversible and frees the slot; purge is deliberate and permanent', true);
  }),
  test('an archived task stops being work: no listing, no checkpoint, no waking CAPCOM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-tasks-'));
    try {
      const s = new TaskStore(dir);
      s.create('task_a', 'Retired work'); s.message('task_a', 'human', 'Retired work');
      s.assign('task_a', ['w1']);
      s.create('task_b', 'Live work'); s.message('task_b', 'human', 'Live work');
      s.archive('task_a');
      const listed = await runTool({ tasks: s } as unknown as Parameters<typeof runTool>[0], 'list_tasks', {});
      const rows = (JSON.parse(listed.result) as { tasks: { id: string }[] }).tasks;
      assert.deepEqual(rows.map((t) => t.id), ['task_b']);
      const checkpoint = freshCapcomCheckpoint({ tasks: s.all(), escalations: {}, agents: {} } as never, []);
      assert.ok(!checkpoint.includes('task_a') && checkpoint.includes('task_b'));
      // `observe` es lo que trae resultados nuevos de los workers a la tarea.
      const worker = { id: 'w1', state: 'done', lastSay: 'finished the retired work', updatedAt: Date.now(), startedAt: Date.now() } as Agent;
      s.observe({ w1: worker });
      assert.equal(s.get('task_a').messages.length, 1, 'a retired task does not collect new results');
      return ok('archived tasks leave the listing, the checkpoint and CAPCOM alone', true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

      // Retirar y borrar por el mismo camino que usa la consola.
      frames.length = 0;
      ws.send(JSON.stringify({ t: 'task:purge', id: 'purge_early', taskId: 'task_a' }));
      assert(await until(() => frames.some((f) => f.cmdId === 'purge_early'), 2000));
      const refused = frames.find((f) => f.cmdId === 'purge_early');
      assert.equal(refused.ok, false); assert.match(String(refused.detail), /Archive the task before purging/);
      ws.send(JSON.stringify({ t: 'task:archive', id: 'arch_a', taskId: 'task_a' }));
      assert(await until(() => frames.some((f) => f.t === 'task' && f.task.id === 'task_a' && f.task.archivedAt), 2000));
      ws.send(JSON.stringify({ t: 'task:purge', id: 'purge_a', taskId: 'task_a' }));
      assert(await until(() => frames.some((f) => f.t === 'task' && f.task.id === 'task_a' && f.purged === true), 2000));
      assert.throws(() => hub.tasks.get('task_a'), /Unknown task/);
      frames.length = 0; await connect();
      assert(await until(() => frames.some((f) => f.t === 'world'), 2000));
      const after = frames.find((f) => f.t === 'world');
      assert.equal(after.state.tasks.task_a, undefined, 'a purged task is gone from the snapshot too');
      assert.equal(after.state.tasks.task_b.messages[0].text, 'Request b');
      return ok('routing, explicit replies, reconnect, worker notification, archive and purge over the wire', true);
    } finally {
      sockets.forEach((s) => s.close()); await hub.close(); rmSync(dir, { recursive: true, force: true });
    }
  }),
] };
