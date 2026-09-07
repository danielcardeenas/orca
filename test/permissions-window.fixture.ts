import { store } from '../src/ui/store.ts';
import { mountInterrupt } from '../src/ui/windows/kinds/interrupt.ts';
import { mountAgent } from '../src/ui/windows/kinds/agent.ts';
import { hub } from '../src/ui/net/client.ts';
import type { Escalation } from '../src/shared/types.ts';

// No network connection or real IDs: exercise the production views with a local store.
(hub as any).cmd = () => { throw new Error('Fixture forbids collector commands'); };
export const events = { answers: 0, closed: 0 };
const e: Escalation = { id: 'fixture-permission', agentId: 'fixture-agent', machineId: 'fixture-machine', projectId: 'fixture-project', question: 'K9 requests Codex permission', context: 'Tool: isolated fixture. Response requested; waiting for terminal evidence.', options: ['allow','deny'], optionsOnly: true, urgency: 'blocking', status: 'pending', ceoAttempt: null, answer: null, answeredBy: null, rememberAs: null, askedAt: Date.now(), answeredAt: null, expiresAt: null, permission: { phase: 'requested', fingerprint: 'a'.repeat(64) } };
const a: any = { id: e.agentId, callsign: 'K9', projectId: e.projectId, machineId: e.machineId, runtime: 'codex', model: 'Codex', state: 'blocked', block: { kind: 'permission', escalationId: e.id, summary: e.question, since: e.askedAt }, role: 'agent', title: 'Isolated permission check', origin: 'orca', childIds: [], metrics: { costUSD: 0, inputTokens: 0, outputTokens: 0, tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 1, turns: 1 }, uptimeMs: 1000, startedAt: Date.now(), updatedAt: Date.now(), pane: false };
store.world.agents[a.id]=a;
store.world.escalations[e.id]=e;
store.world.projects[e.projectId]={ id:e.projectId,name:'Permission fixture',code:'OR' } as any;
store.replaceWorld(store.world);
const c: any = { answer() { events.answers++; update('pending'); }, note() {},go(){},openSpawn(){},stop(){},wm:{closeWith(){events.closed++;}} };
const ctx = (body: HTMLElement, params: object): any => ({ body,win:{spec:{params}},setTitle(){},setCallsign(){},setState(){},close(){events.closed++;body.hidden=true;} });
mountInterrupt(ctx(document.querySelector('#interrupt')!, {escalationId:e.id}), c);
mountAgent(ctx(document.querySelector('#agent')!, {agentId:a.id}), c);
export function update(phase: 'requested'|'pending'|'confirmed') {
  const next = { ...e, status: phase==='confirmed' ? 'answered' : 'pending', permission: {...e.permission!,phase} };
  store.applyPatch(store.world.rev+1,[{o:'escalation',id:e.id,v:next as Escalation}]);
}
