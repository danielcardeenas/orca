/**
 * shared/capcom.ts — the turn: what the command line says CAPCOM is doing
 * with your line, and the one moment that gets a sound.
 *
 * Two ways to be wrong silently: a command line that says THINKING for a
 * CAPCOM that is waiting on you (amber is the one thing amber means), and a
 * tick that rings for every turn CAPCOM starts on its own — a relayed
 * question, a mission's next step — until it means nothing.
 */

import { TURN_AFTER_MS, capcomTurn, turnStarted } from '../src/shared/capcom.ts';
import type { Agent } from '../src/shared/types.ts';
import { eq, test, type TestModule } from './harness.ts';

const NOW = 1_700_000_000_000;

function capcom(extra: Partial<Agent>): Agent {
  return {
    id: 'cap', machineId: 'm1', projectId: 'p1', title: '', callsign: 'CAPCOM', runtime: 'claude', role: 'capcom',
    state: 'idle', block: null, parentId: null, depth: 0, childIds: [], mission: null, squad: null, lead: false,
    model: null, tool: null, toolDetail: null, lastPrompt: null, lastSay: null,
    startedAt: NOW - 1000, updatedAt: NOW, uptimeMs: 1000,
    ...extra,
  } as Agent;
}

const mod: TestModule = {
  suite: 'turn',
  tests: [
    test('capcomTurn: one word per state, the tool in hand while working', () => {
      const of = (a: Partial<Agent>) => capcomTurn([capcom(a)]);
      return eq('states', [
        of({ state: 'idle' }), of({ state: 'booting' }), of({ state: 'thinking' }),
        of({ state: 'working', tool: 'Bash' }), of({ state: 'working' }),
        of({ state: 'blocked', block: { kind: 'question', summary: 'which project?', since: NOW } }),
        of({ state: 'blocked', block: { kind: 'peer', summary: 'asked K9', since: NOW } }),
        of({ state: 'done' }),
      ], [
        { kind: 'idle' }, { kind: 'thinking' }, { kind: 'thinking' },
        { kind: 'working', tool: 'Bash' }, { kind: 'working', tool: null },
        { kind: 'waiting' },
        { kind: 'working', tool: null },
        { kind: 'idle' },
      ]);
    }),
    test('capcomTurn: no CAPCOM — the API commander\'s flag, or nothing', () => {
      return eq('no agent', [capcomTurn([], { thinking: true }), capcomTurn([]), capcomTurn({})], [{ kind: 'thinking' }, { kind: 'idle' }, { kind: 'idle' }]);
    }),
    test('turnStarted: idle → thinking moments after your line', () => {
      return eq('yours', [
        turnStarted('idle', 'thinking', NOW - 2_000, NOW),
        turnStarted('idle', 'working', NOW - 2_000, NOW),
        turnStarted(undefined, 'thinking', NOW - 2_000, NOW),   // a CAPCOM born on your line
        turnStarted('blocked', 'thinking', NOW - 2_000, NOW),  // it asked, you answered, it goes on
      ], [true, true, true, true]);
    }),
    test('turnStarted: not for a turn CAPCOM starts on its own, nor twice in one turn', () => {
      return eq('not yours', [
        turnStarted('idle', 'thinking', null, NOW),                       // you sent nothing
        turnStarted('idle', 'thinking', NOW - TURN_AFTER_MS - 1, NOW),    // too long ago
        turnStarted('thinking', 'working', NOW - 2_000, NOW),             // already live: same turn
        turnStarted('working', 'blocked', NOW - 2_000, NOW),              // stopping to ask is not starting
        turnStarted('idle', 'blocked', NOW - 2_000, NOW),
        turnStarted('idle', 'idle', NOW - 2_000, NOW),
        turnStarted('idle', 'thinking', NOW + 5_000, NOW),                // a clock ahead of ours
      ], [false, false, false, false, false, false, false]);
    }),
  ],
};

export default mod;
