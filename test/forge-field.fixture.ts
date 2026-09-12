import { createField } from '../src/ui/field/field.ts';
import { store } from '../src/ui/store.ts';
import { emptyRollup, emptyWorld, type Agent } from '../src/shared/types.ts';
import type { CapcomMission } from '../src/shared/missions.ts';

const now = Date.now();
const metrics = { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0 };
function agent(id: string, patch: Partial<Agent>): Agent {
  return { id, callsign: id, title: 'Canvas verification', machineId: 'fixture', projectId: 'p', runtime: 'codex', state: 'working', block: null, parentId: null, depth: 0, childIds: [], mission: 'Represent FORGE on the canvas', squad: 'forge-fixture', lead: false, model: 'fixture', tool: null, toolDetail: null, lastPrompt: '', lastSay: null, startedAt: now, updatedAt: now, uptimeMs: 1000, metrics: { ...metrics }, background: false, shortId: null, origin: 'orca', ...patch };
}
export const lead = agent('F1', { lead: true, childIds: ['F2'] });
export const child = agent('F2', { parentId: 'F1', depth: 1 });
export const member = agent('F3', {});
export const capcom = agent('C1', { role: 'capcom', squad: null, projectId: 'command' });
export const worker = agent('O1', { squad: null });
export const mission: CapcomMission = { id: 'mission_fixture', title: 'FORGE canvas', status: 'active', createdAt: now, updatedAt: now, agentIds: ['F1'], squads: ['forge-fixture'], messages: [] };
store.world = emptyWorld();
store.world.projects.p = { id: 'p', machineId: 'fixture', slug: 'orca', name: 'ORCA', path: '/fixture/orca', code: 'ORCA', gitBranch: null, gitDirty: false, keyNames: [], sessionIds: [], rollup: emptyRollup() };
store.world.agents = { F1: lead, F2: child, F3: member, C1: capcom, O1: worker };
store.world.missions = { [mission.id]: mission };
export const opened: string[] = [];
export const field = createField(document.querySelector<HTMLElement>('.field')!, {
  onSelect(ids, at) { if (at) opened.push(...ids); }, onOpen(id) { opened.push(id); }, onOpenProject() {}, onOpenSquad() {}, onOpenArtifact() {}, onOpenGallery() {}, onContext() {}, onPlace() {}, onPlaceArtifact() {}, onUnplaceArtifact() {}, onHover() {},
});
field.setActive(true);
export function phase(label: string) {
  lead.state = child.state = member.state = 'idle';
  child.block = null; child.tool = child.toolDetail = null;
  mission.status = 'active'; mission.messages = [];
  if (label === 'WORKING') lead.state = 'working';
  if (label === 'VERIFYING') { child.state = 'working'; child.tool = 'exec_command'; child.toolDetail = 'npm run typecheck'; }
  if (label === 'BLOCKED') { child.state = 'blocked'; child.block = { kind: 'peer', summary: 'Waiting on F1', since: now } as Agent['block']; }
  if (label === 'WAITING CAPCOM') mission.messages = [{ id: 'result', role: 'agent', agentId: lead.id, text: 'Verification report', at: now }];
  if (label === 'INACTIVE') mission.status = 'completed';
  field.feed();
}
