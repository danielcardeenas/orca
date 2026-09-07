/**
 * The command post's halo — the state behind it (src/ui/field/command.ts).
 *
 * The drawing is a shader and a test cannot see it; what a test can hold is
 * the arithmetic that decides what is drawn, which is where the bugs live.
 * Four claims: the ring counts the tasks the hub keeps open and nothing else;
 * an arc is lit while its task moves and dim while it waits; the notches
 * count the questions a person still owes; and a link reaches exactly what
 * CAPCOM launched — never a subagent, never a stranger's session.
 *
 * Only the pure half is imported, so this runs in node with no WebGL and no
 * DOM: `command.ts` imports three only for the halo, which is never built here.
 */

import {
  commandLinked, commandState, MAX_NOTCHES, MAX_SEGMENTS, openTasks, sameState, TASK_HOT_MS,
} from '../src/ui/field/command.ts';
import type { Agent, Escalation, WorldState } from '../src/shared/types.ts';
import type { CapcomTask } from '../src/shared/tasks.ts';
import { ok, test, type TestModule } from './harness.ts';

const NOW = 1_700_000_000_000;
const ALL = { tasks: true, notches: true, pulse: true };

function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return {
    id, machineId: 'm1', projectId: 'p1', callsign: id.toUpperCase(), title: '',
    runtime: 'claude', state: 'working', block: null, parentId: null, depth: 0, childIds: [],
    mission: null, squad: null, lead: false, origin: 'orca',
    startedAt: NOW - 1000, updatedAt: NOW, uptimeMs: 1000,
    ...extra,
  } as unknown as Agent;
}

const CAPCOM = agent('cap', { role: 'capcom', state: 'idle' });

function task(id: string, extra: Partial<CapcomTask> = {}): CapcomTask {
  return {
    id, title: id, status: 'active', createdAt: NOW - 60_000, updatedAt: NOW - 60_000,
    agentIds: [], messages: [], ...extra,
  };
}

function esc(id: string, status: Escalation['status']): Escalation {
  return { id, agentId: 'a1', projectId: 'p1', machineId: 'm1', question: '?', status } as unknown as Escalation;
}

function world(tasks: CapcomTask[], escs: Escalation[] = []): Pick<WorldState, 'tasks' | 'escalations'> {
  return {
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    escalations: Object.fromEntries(escs.map((e) => [e.id, e])),
  };
}

const none = () => undefined;

export default {
  suite: 'command',
  tests: [
    test('with no CAPCOM there is no halo at all', () => {
      const w = world([task('task_1'), task('task_2')], [esc('esc_1', 'pending')]);
      const s = commandState(w, null, none, NOW, null, ALL);
      return ok('no CAPCOM, no halo', s.segments === 0 && s.notches === 0 && s.turn === 0,
        `segments=${s.segments} notches=${s.notches}`);
    }),

    test('the ring is one arc per open task, and completed tasks leave it', () => {
      const w = world([
        task('task_1'),
        task('task_2', { status: 'completed' }),
        task('task_3'),
        task('task_4', { status: 'failed' }),
      ]);
      const s = commandState(w, CAPCOM, none, NOW, null, ALL);
      const open = openTasks(w.tasks).map((t) => t.id);
      return ok('two arcs for two open tasks', s.segments === 2 && open.join() === 'task_1,task_3',
        `segments=${s.segments} open=${open.join()}`);
    }),

    test('an arc is lit while its task moves and dim while it waits', () => {
      const fresh = task('task_1', { updatedAt: NOW - TASK_HOT_MS / 2 });
      const cold = task('task_2', { updatedAt: NOW - TASK_HOT_MS * 3 });
      const working = task('task_3', { updatedAt: NOW - TASK_HOT_MS * 3, agentIds: ['w1'] });
      const idle = task('task_4', { updatedAt: NOW - TASK_HOT_MS * 3, agentIds: ['i1'] });
      const fleet = new Map([['w1', agent('w1', { state: 'working' })], ['i1', agent('i1', { state: 'idle' })]]);
      const s = commandState(world([fresh, cold, working, idle]), CAPCOM, (id) => fleet.get(id), NOW, null, ALL);
      // Bit i is segment i, in creation order: 1 and 3 lit, 2 and 4 dim.
      return ok('lit while it moves, dim while it waits', s.segments === 4 && s.lit === 0b0101,
        `lit=${s.lit.toString(2).padStart(4, '0')}`);
    }),

    test('the operator’s open task is the heavy arc, and only while it is open', () => {
      const w = world([task('task_1'), task('task_2'), task('task_3')]);
      const on = commandState(w, CAPCOM, none, NOW, 'task_2', ALL);
      const gone = commandState(w, CAPCOM, none, NOW, 'task_9', ALL);
      return ok('the open task marks its own arc', on.active === 1 && gone.active === -1,
        `active=${on.active} unknown=${gone.active}`);
    }),

    test('a notch per question nobody has answered', () => {
      const w = world([], [
        esc('esc_1', 'pending'), esc('esc_2', 'with_ceo'), esc('esc_3', 'answered'),
        esc('esc_4', 'withdrawn'), esc('esc_5', 'expired'),
      ]);
      const s = commandState(w, CAPCOM, none, NOW, null, ALL);
      return ok('two open questions, two notches', s.notches === 2, `notches=${s.notches}`);
    }),

    test('the ring and the notches are bounded', () => {
      const tasks = Array.from({ length: MAX_SEGMENTS + 9 }, (_, i) => task(`task_${i}`, { createdAt: NOW - i }));
      const escs = Array.from({ length: MAX_NOTCHES + 5 }, (_, i) => esc(`esc_${i}`, 'pending'));
      const s = commandState(world(tasks, escs), CAPCOM, none, NOW, null, ALL);
      return ok('bounded', s.segments === MAX_SEGMENTS && s.notches === MAX_NOTCHES,
        `segments=${s.segments} notches=${s.notches}`);
    }),

    test('the turn: working beats, waiting on a person is amber, a peer block is neither', () => {
      const w = world([]);
      const turn = commandState(w, agent('cap', { role: 'capcom', state: 'thinking' }), none, NOW, null, ALL);
      const rest = commandState(w, agent('cap', { role: 'capcom', state: 'idle' }), none, NOW, null, ALL);
      const waits = commandState(w, agent('cap', {
        role: 'capcom', state: 'blocked', block: { kind: 'question', summary: '?', since: NOW },
      }), none, NOW, null, ALL);
      const peer = commandState(w, agent('cap', {
        role: 'capcom', state: 'blocked', block: { kind: 'peer', summary: '?', since: NOW },
      }), none, NOW, null, ALL);
      return ok('the turn reads off CAPCOM’s own state',
        turn.turn === 1 && turn.waiting === 0 && rest.turn === 0 && waits.waiting === 1 && peer.waiting === 0,
        `turn=${turn.turn} rest=${rest.turn} waiting=${waits.waiting} peer=${peer.waiting}`);
    }),

    test('every piece can be switched off on its own', () => {
      const w = world([task('task_1')], [esc('esc_1', 'pending')]);
      const cap = agent('cap', { role: 'capcom', state: 'working' });
      const off = commandState(w, cap, none, NOW, null, { tasks: false, notches: false, pulse: false });
      const only = commandState(w, cap, none, NOW, null, { tasks: true, notches: false, pulse: false });
      return ok('the flags are independent',
        off.segments === 0 && off.notches === 0 && off.turn === 0 && only.segments === 1 && only.notches === 0,
        `off=${JSON.stringify(off)} tasksOnly=${JSON.stringify(only)}`);
    }),

    test('a link reaches what CAPCOM launched, and nothing else', () => {
      const cases: [Agent, boolean][] = [
        [agent('a1', { parentId: 'cap' }), true],
        [agent('a2', { origin: 'orca', parentId: null }), true],
        [agent('a3', { origin: 'external', parentId: null }), false],
        [agent('a4', { origin: 'orca', parentId: 'a2' }), false],
        [agent('a5', { parentId: 'cap', subagent: true }), false],
        [CAPCOM, false],
      ];
      const wrong = cases.filter(([a, want]) => commandLinked(a, 'cap') !== want).map(([a]) => a.id);
      return ok('the link rule', wrong.length === 0,
        wrong.length ? `wrong for ${wrong.join(', ')}` : `${cases.length} cases, ${cases.filter(([, w]) => w).length} linked`);
    }),

    test('the halo only rewrites its uniforms when the picture changed', () => {
      const w = world([task('task_1')], [esc('esc_1', 'pending')]);
      const a = commandState(w, CAPCOM, none, NOW, null, ALL);
      const b = commandState(w, CAPCOM, none, NOW + 1000, null, ALL);
      const c = commandState(world([task('task_1'), task('task_2')]), CAPCOM, none, NOW, null, ALL);
      return ok('same world, same state', sameState(a, b) && !sameState(a, c),
        `stable=${sameState(a, b)} changed=${!sameState(a, c)}`);
    }),
  ],
} satisfies TestModule;
