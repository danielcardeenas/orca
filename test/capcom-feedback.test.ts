import type { Agent } from '../src/shared/types.ts';
import { capcomFeedback } from '../src/ui/windows/capcom-feedback.ts';
import { eq, ok, type TestModule } from './harness.ts';

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'capcom-1', role: 'capcom', machineId: 'm1', projectId: 'p1',
    title: 'CAPCOM', callsign: 'CAPCOM', runtime: 'claude', state: 'idle', block: null,
    parentId: null, depth: 0, childIds: [], mission: null, squad: null, lead: false,
    model: null, tool: null, toolDetail: null, lastPrompt: null, lastSay: null,
    startedAt: 100, updatedAt: 100, uptimeMs: 0, background: false, shortId: null,
    metrics: { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      thinkingTokens: 0, tokensPerSec: 0, linesAdded: 0, linesRemoved: 0,
      toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0 },
    ...over,
  };
}
type Input = Parameters<typeof capcomFeedback>[0];
function feedback(over: Partial<Input> = {}) {
  return capcomFeedback({ agents: { capcom: agent() }, linkUp: true,
    authed: true, seenLink: true, thinking: false, ...over });
}
function withAgent(over: Partial<Agent>) { return feedback({ agents: { capcom: agent(over) } }); }

export default {
  suite: 'CAPCOM visual feedback — observed state, never delivery inference',
  tests: [
    () => eq('initial connection is loading; an interrupted connection is reconnecting',
      [feedback({ linkUp: false, seenLink: false }).kind, feedback({ linkUp: false }).kind],
      ['loading', 'reconnecting']),
    () => eq('authentication failure wins over disconnect and pending session change',
      feedback({ authed: false, linkUp: false, transition: 'Switching' }).label, 'ACCESS ERROR'),
    () => eq('disconnect hides stale processing and transition errors',
      [feedback({ linkUp: false, thinking: true, transition: 'Switching' }).kind,
        feedback({ linkUp: false, transitionError: 'Failed' }).kind], ['reconnecting', 'reconnecting']),
    () => eq('session-change failure wins over a pending change and agent work',
      feedback({ transition: 'Switching', transitionError: 'Could not switch', thinking: true }).detail,
      'Could not switch'),
    () => eq('explicit session transition is visible ahead of idle state',
      [feedback({ transition: 'Handoff in progress' }).label, feedback({ transition: 'Handoff in progress' }).detail],
      ['CHANGING SESSION', 'Handoff in progress']),
    () => eq('unconfirmed transition reports checking instead of claiming continued work',
      [feedback({ transitionUnconfirmed: true, transition: 'Checking handoff' }).kind,
        feedback({ transitionUnconfirmed: true, transition: 'Checking handoff' }).label,
        feedback({ transitionUnconfirmed: true, transition: 'Checking handoff' }).detail],
      ['loading', 'CHECKING SESSION', 'Checking handoff']),
    () => eq('link loss and explicit failure take precedence over unconfirmed transition',
      [feedback({ transitionUnconfirmed: true, linkUp: false }).kind,
        feedback({ transitionUnconfirmed: true, transitionError: 'Handoff failed' }).label],
      ['reconnecting', 'CHANGE ERROR']),
    () => ok('unconfirmed status offers automatic checking and clears on confirmation',
      /automatically/.test(feedback({ transitionUnconfirmed: true }).detail)
      && feedback({ transitionUnconfirmed: false }).kind === 'ready'),
    () => eq('booting, idle, thinking and tool work have distinct feedback',
      ['booting', 'idle', 'thinking', 'working'].map(state => withAgent({ state: state as Agent['state'] }).label),
      ['STARTING', 'READY', 'THINKING', 'PROCESSING']),
    () => eq('tool detail is retained while processing',
      withAgent({ state: 'working', tool: 'Read', toolDetail: 'Reading DESIGN.md' }).detail, 'Reading DESIGN.md'),
    () => eq('waiting for a peer is processing, not a request for human input',
      withAgent({ state: 'blocked', block: { kind: 'peer', summary: 'Waiting for K2', since: 100 } }).kind,
      'processing'),
    () => eq('peer wait explains who is being awaited',
      withAgent({ state: 'blocked', block: { kind: 'peer', summary: 'Waiting for K2', since: 100 } }).detail,
      'Waiting for K2'),
    () => eq('permission and question blocks explicitly wait for the human',
      (['permission', 'question'] as const).map(kind => withAgent({ state: 'blocked', block: { kind, summary: 'Review this', since: 100 } }).label),
      ['WAITING ON YOU', 'WAITING ON YOU']),
    () => eq('explicit error blocks show their recovery context',
      [withAgent({ state: 'blocked', block: { kind: 'error', summary: 'Provider unavailable', since: 100 } }).kind,
        withAgent({ state: 'blocked', block: { kind: 'error', summary: 'Provider unavailable', since: 100 } }).detail],
      ['error', 'Provider unavailable']),
    () => eq('model failure remains visible even if the agent is idle',
      withAgent({ modelControl: { sessionId: 'capcom-1', runtime: 'claude', active: null,
        choices: [], phase: 'failed', requested: null, detail: 'Model unavailable', events: [] } }).label,
      'MODEL ERROR'),
    () => eq('applying a model waits for confirmation and clears when control becomes ready',
      (['applying', 'ready'] as const).map(phase => withAgent({ modelControl: {
        sessionId: 'capcom-1', runtime: 'claude', active: null, choices: [], phase,
        requested: null, detail: '', events: [],
      } }).label), ['CHANGING MODEL', 'READY']),
    () => eq('queued model change is visible at idle but does not hide active work or human input',
      (['idle', 'working', 'blocked'] as const).map(state => withAgent({ state,
        block: state === 'blocked' ? { kind: 'permission', summary: 'Approve tool', since: 100 } : null,
        modelControl: { sessionId: 'capcom-1', runtime: 'claude', active: null,
          choices: [], phase: 'queued', requested: null, detail: '', events: [] },
      }).label), ['MODEL CHANGE QUEUED', 'PROCESSING', 'WAITING ON YOU']),
    () => {
      const a = agent();
      a.metrics.compactions = 4;
      return eq('historical compaction count cannot imply active compaction', feedback({ agents: { a } }).kind, 'ready');
    },
    () => eq('missing or terminal CAPCOM is unavailable, never ready',
      [feedback({ agents: {} }).kind, withAgent({ state: 'done' }).kind, withAgent({ state: 'dead' }).kind],
      ['unavailable', 'unavailable', 'unavailable']),
    () => eq('shared thinking signal can report processing before the agent appears',
      feedback({ agents: {}, thinking: true }).kind, 'processing'),
    () => eq('session replacement follows the newest live CAPCOM rather than the old error',
      feedback({ agents: {
        old: agent({ state: 'blocked', block: { kind: 'error', summary: 'Old failure', since: 100 } }),
        new: agent({ id: 'capcom-2', startedAt: 200, updatedAt: 200, state: 'booting' }),
      } }).label, 'STARTING'),
    () => eq('new connection and activity signals restore feedback without a sticky error',
      [feedback({ linkUp: false }).kind, feedback().kind,
        withAgent({ state: 'blocked', block: { kind: 'error', summary: 'Failure', since: 100 } }).kind,
        withAgent({ state: 'working' }).kind, feedback().kind],
      ['reconnecting', 'ready', 'error', 'processing', 'ready']),
    () => ok('reconnection copy states uncertainty, automatic retry and draft retention',
      /automatically/.test(feedback({ linkUp: false }).detail)
      && /unconfirmed/.test(feedback({ linkUp: false }).detail)
      && /draft/.test(feedback({ linkUp: false }).detail)),
  ],
} satisfies TestModule;
