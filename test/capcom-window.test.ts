/**
 * The CAPCOM transcript log.
 *
 * The hub keeps only the last thing CAPCOM said and the last thing you told
 * it. The window is supposed to remember the rest. That accumulation is the
 * only piece of the window that can be wrong silently — a log that quietly
 * drops a turn, or that re-dates its whole history every time the agent
 * breathes, looks exactly like a log that works — so it lives in a pure
 * function and it gets tested here.
 */

import type { AgentMessage, FeedItem } from '../src/shared/types.ts';
import { capcomLog, CAPCOM_LOG_MAX, type CapcomEntry } from '../src/ui/windows/kinds/ceo.ts';
import { ok, eq, test, type TestModule } from './harness.ts';

type Snap = { id: string; lastPrompt: string | null; lastSay: string | null; updatedAt: number };

function snap(o: Partial<Snap> = {}): Snap {
  return { id: 'cap', lastPrompt: null, lastSay: null, updatedAt: 1_000, ...o };
}

function msg(o: Partial<AgentMessage> & { id: string }): AgentMessage {
  return {
    kind: 'notice', scope: 'agent',
    fromAgentId: 'cap', fromCallsign: 'CAPCOM', fromProjectId: 'p1',
    toAgentId: 'a1', toProjectId: null, toSquad: null,
    subject: 'subject', body: null, files: [],
    at: 2_000, answer: null, answeredAt: null, readAt: null,
    ...o,
  } as AgentMessage;
}

function feedItem(o: Partial<FeedItem> & { id: string }): FeedItem {
  return { at: 3_000, level: 'info', source: 'ORCA', text: 'something', agentId: 'cap', ...o };
}

const texts = (l: CapcomEntry[]) => l.map((e) => e.text);

export default {
  suite: 'capcom-window',
  tests: [
    test('empty agent, empty log', () => {
      const l = capcomLog(snap(), [], [], []);
      return eq('no entries', l.length, 0);
    }),

    test('a prompt and a reply become two lines, prompt first', () => {
      const l = capcomLog(snap({ lastPrompt: 'fleet status', lastSay: 'four working, one blocked' }), [], [], []);
      return eq('order', l.map((e) => `${e.role}:${e.text}`),
        ['human:fleet status', 'capcom:four working, one blocked']);
    }),

    test('an unchanged lastSay adds nothing on the next pass', () => {
      const a = snap({ lastPrompt: 'spend', lastSay: '$4.10 today' });
      const first = capcomLog(a, [], [], []);
      const second = capcomLog({ ...a, updatedAt: 9_999 }, [], [], first);
      return eq('still two', second.length, 2);
    }),

    test('the history grows when what CAPCOM says changes', () => {
      const one = capcomLog(snap({ lastSay: 'surveying' }), [], [], []);
      const two = capcomLog(snap({ lastSay: 'spawned K9', updatedAt: 1_100 }), [], [], one);
      const three = capcomLog(snap({ lastSay: 'K9 is on it', updatedAt: 1_200 }), [], [], two);
      return eq('three replies', texts(three), ['surveying', 'spawned K9', 'K9 is on it']);
    }),

    test('an entry keeps the moment it was first seen', () => {
      const one = capcomLog(snap({ lastSay: 'surveying' }), [], [], []);
      const two = capcomLog(snap({ lastSay: 'surveying', updatedAt: 50_000 }), [], [], one);
      return eq('at unchanged', two[0]?.at, 1_000);
    }),

    test('traffic out carries kind, direction and the peer id', () => {
      const l = capcomLog(snap(), [msg({ id: 'm1', kind: 'handoff', subject: 'take the audit', toAgentId: 'a7' })], [], []);
      const e = l[0]!;
      return ok('shape', e.role === 'system' && e.kind === 'handoff' && e.dir === 'out' && e.peerId === 'a7',
        `${e.role}/${e.kind}/${e.dir}/${e.peerId}`);
    }),

    test('traffic in is attributed to the sender', () => {
      const l = capcomLog(snap(), [msg({ id: 'm2', fromAgentId: 'a3', fromCallsign: 'K9', toAgentId: 'cap', kind: 'ask', subject: 'may I push?' })], [], []);
      const e = l[0]!;
      return ok('inbound', e.dir === 'in' && e.peerCallsign === 'K9' && e.text === 'may I push?', JSON.stringify(e));
    }),

    test('feed lines from other agents are not CAPCOM history', () => {
      const l = capcomLog(snap(), [], [
        feedItem({ id: 'f1', text: 'mine' }),
        feedItem({ id: 'f2', text: 'someone else', agentId: 'a9' }),
      ], []);
      return eq('only ours', texts(l), ['mine']);
    }),

    test('everything is ordered by time across the three sources', () => {
      const l = capcomLog(
        snap({ lastSay: 'said at 1000' }),
        [msg({ id: 'm1', subject: 'sent at 2000', at: 2_000 })],
        [feedItem({ id: 'f1', text: 'logged at 1500', at: 1_500 })],
        [],
      );
      return eq('by at', texts(l), ['said at 1000', 'logged at 1500', 'sent at 2000']);
    }),

    test(`the log is capped at ${CAPCOM_LOG_MAX}, oldest dropped`, () => {
      let l: CapcomEntry[] = [];
      for (let i = 0; i < CAPCOM_LOG_MAX + 40; i++) {
        l = capcomLog(snap({ lastSay: `turn ${i}`, updatedAt: 1_000 + i }), [], [], l);
      }
      return ok('capped, tail kept',
        l.length === CAPCOM_LOG_MAX && l[l.length - 1]!.text === `turn ${CAPCOM_LOG_MAX + 39}` && l[0]!.text === 'turn 40',
        `${l.length} · ${l[0]?.text} … ${l[l.length - 1]?.text}`);
    }),

    test('prev is never mutated', () => {
      const one = capcomLog(snap({ lastSay: 'a' }), [], [], []);
      const before = one.length;
      capcomLog(snap({ lastSay: 'b', updatedAt: 1_100 }), [], [], one);
      return eq('prev intact', one.length, before);
    }),
  ],
} satisfies TestModule;
