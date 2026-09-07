/**
 * hud/task-status.ts — what the task panel says about each task.
 *
 * Worth guarding: the phase rule (alive crew beats CAPCOM's last word; the
 * hub's completed/failed beats both), the order (open first by movement,
 * finished after), the fold (the newest N finished stay visible), and the
 * title (the hub's, or the first thing the human said, cut on a space).
 */

import type { CapcomTask, TaskMessage, TaskStatus } from '../src/shared/tasks.ts';
import type { Agent, AgentState } from '../src/shared/types.ts';
import { liveCrew, movedAt, splitRows, taskPhase, taskRows, taskTitle } from '../src/ui/hud/task-status.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const T0 = 1_800_000_000_000;

function agent(id: string, state: AgentState, extra: Partial<Agent> = {}): Agent {
  return { id, callsign: id.toUpperCase(), state, role: 'worker', updatedAt: T0, startedAt: T0 - 1000, ...extra } as Agent;
}

function msg(role: TaskMessage['role'], text: string, at = T0, agentId?: string): TaskMessage {
  return { id: `m_${at}_${role}`, role, text, at, ...(agentId ? { agentId } : {}) };
}

function task(id: string, o: { status?: TaskStatus; title?: string; agentIds?: string[]; messages?: TaskMessage[]; updatedAt?: number } = {}): CapcomTask {
  return {
    id, title: o.title ?? 'New task', status: o.status ?? 'active',
    createdAt: T0 - 10_000, updatedAt: o.updatedAt ?? T0, agentIds: o.agentIds ?? [], messages: o.messages ?? [],
  };
}

const FLEET: Record<string, Agent> = {
  a1: agent('a1', 'working', { updatedAt: T0 + 5_000 }),
  a2: agent('a2', 'blocked'),
  a3: agent('a3', 'done'),
  a4: agent('a4', 'dead'),
  cap: agent('cap', 'idle', { role: 'capcom', callsign: 'CAPCOM' }),
};
const agentOf = (id: string) => FLEET[id];

const mod: TestModule = {
  suite: 'task-status',
  tests: [
    test('liveCrew: assigned and alive, in assignment order; the dead, the done, the unknown and CAPCOM are not crew', () => {
      const t = task('t', { agentIds: ['a3', 'a2', 'ghost', 'cap', 'a1', 'a4'] });
      return eq('crew', liveCrew(t, agentOf).map((a) => a.id), ['a2', 'a1']);
    }),
    test('taskPhase: nobody has taken it → queued', () => {
      const t = task('t', { messages: [msg('human', 'Fix the login flow')] });
      return eq('phase', taskPhase(t, liveCrew(t, agentOf)), 'queued');
    }),
    test('taskPhase: no messages at all is still queued', () => {
      return eq('phase', taskPhase(task('t'), []), 'queued');
    }),
    test('taskPhase: CAPCOM had the last word and nobody is running → waiting on you', () => {
      const t = task('t', { messages: [msg('human', 'Fix it', T0), msg('capcom', 'Which branch?', T0 + 1)] });
      return eq('phase', taskPhase(t, liveCrew(t, agentOf)), 'waiting');
    }),
    test('taskPhase: a live assigned agent beats CAPCOM\'s last word → in progress', () => {
      const t = task('t', { agentIds: ['a1'], messages: [msg('human', 'Fix it', T0), msg('capcom', 'Launched A1, will report back', T0 + 1)] });
      return eq('phase', taskPhase(t, liveCrew(t, agentOf)), 'progress');
    }),
    test('taskPhase: assigned agents that finished are not progress; the last word decides again', () => {
      const wait = task('w', { agentIds: ['a3', 'a4'], messages: [msg('human', 'Go', T0), msg('capcom', 'Done? Check the diff and tell me', T0 + 1)] });
      const queued = task('q', { agentIds: ['a3'], messages: [msg('human', 'Go', T0), msg('agent', 'Finished the diff', T0 + 1, 'a3')] });
      const a = taskPhase(wait, liveCrew(wait, agentOf)), b = taskPhase(queued, liveCrew(queued, agentOf));
      return ok('phases', a === 'waiting' && b === 'queued', `${a} ${b}`);
    }),
    test('taskPhase: a human reply after CAPCOM, nobody running → queued again', () => {
      const t = task('t', { messages: [msg('capcom', 'Which branch?', T0), msg('human', 'main', T0 + 1)] });
      return eq('phase', taskPhase(t, []), 'queued');
    }),
    test('taskPhase: a system line (delivery failed) is not CAPCOM speaking → queued', () => {
      const t = task('t', { messages: [msg('human', 'Go', T0), msg('system', 'Delivery failed: no CAPCOM', T0 + 1)] });
      return eq('phase', taskPhase(t, []), 'queued');
    }),
    test('taskPhase: the hub\'s completed and failed win over everything, live crew included', () => {
      const done = task('d', { status: 'completed', agentIds: ['a1'], messages: [msg('capcom', 'Anything else?')] });
      const fail = task('f', { status: 'failed', agentIds: ['a2'] });
      const a = taskPhase(done, liveCrew(done, agentOf)), b = taskPhase(fail, liveCrew(fail, agentOf));
      return ok('phases', a === 'completed' && b === 'failed', `${a} ${b}`);
    }),
    test('taskTitle: the hub\'s title, else the first human line, else NEW TASK', () => {
      const own = taskTitle(task('a', { title: 'Ship the checkout', messages: [msg('human', 'something else')] }));
      const first = taskTitle(task('b', { messages: [msg('capcom', 'hi'), msg('human', '  Fix   the\nlogin  ')] }));
      const none = taskTitle(task('c'));
      return eq('titles', [own, first, none], ['Ship the checkout', 'Fix the login', 'NEW TASK']);
    }),
    test('taskTitle: long titles cut on a space and end in an ellipsis', () => {
      const t = taskTitle(task('a', { title: 'Rewrite the payment webhook handler so retries are idempotent' }), 40);
      return ok('cut', t.length <= 41 && t.endsWith('…') && !t.endsWith(' …') && t.startsWith('Rewrite the payment webhook'), t);
    }),
    test('movedAt: the task\'s own update, or a live agent\'s if later', () => {
      const t = task('t', { agentIds: ['a1', 'a2'], updatedAt: T0 + 1000 });
      const idle = task('i', { agentIds: ['a2'], updatedAt: T0 + 9000 });
      return eq('at', [movedAt(t, liveCrew(t, agentOf)), movedAt(idle, liveCrew(idle, agentOf))], [T0 + 5_000, T0 + 9000]);
    }),
    test('taskRows: open first by last movement, then finished by last movement; crew as callsigns', () => {
      const rows = taskRows([
        task('old-open', { messages: [msg('human', 'a')], updatedAt: T0 - 50_000 }),
        task('done-new', { status: 'completed', updatedAt: T0 + 90_000 }),
        task('busy', { agentIds: ['a1', 'a2'], updatedAt: T0 - 90_000 }),
        task('failed-old', { status: 'failed', updatedAt: T0 - 500_000 }),
        task('waiting', { messages: [msg('capcom', '?')], updatedAt: T0 + 10_000 }),
      ], agentOf);
      const order = rows.map((r) => `${r.id}:${r.phase}`);
      const crew = rows.find((r) => r.id === 'busy')!.crew.map((c) => c.callsign);
      return eq('order', [order, crew], [
        ['waiting:waiting', 'busy:progress', 'old-open:queued', 'done-new:completed', 'failed-old:failed'],
        ['A1', 'A2'],
      ], 'busy moved at T0+5000 through A1');
    }),
    test('splitRows: every open row shows; the newest N finished stay, the rest fold', () => {
      const rows = taskRows([
        task('o1', { updatedAt: T0 }),
        task('o2', { updatedAt: T0 + 1 }),
        ...[1, 2, 3, 4, 5].map((i) => task(`d${i}`, { status: i % 2 ? 'completed' : 'failed', updatedAt: T0 + i })),
      ], agentOf);
      const g = splitRows(rows, 2);
      return eq('groups', [g.open.map((r) => r.id), g.done.map((r) => r.id), g.more.map((r) => r.id)],
        [['o2', 'o1'], ['d5', 'd4'], ['d3', 'd2', 'd1']]);
    }),
    test('splitRows: zero recent folds every finished row; more than there are folds none', () => {
      const rows = taskRows([task('d1', { status: 'completed' }), task('d2', { status: 'failed', updatedAt: T0 - 1 })], agentOf);
      const none = splitRows(rows, 0), all = splitRows(rows, 10);
      return eq('edges', [none.done.length, none.more.length, all.done.length, all.more.length], [0, 2, 2, 0]);
    }),
  ],
};

export default mod;
