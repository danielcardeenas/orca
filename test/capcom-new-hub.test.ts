import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startHub } from '../src/hub/server.ts';
import { HubStore } from '../src/hub/persist.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { FleetStore } from '../src/hub/fleets.ts';
import { createAuth } from '../src/hub/auth.ts';
import { emptyRollup, type Agent } from '../src/shared/types.ts';
import { PATHS, PROTOCOL_VERSION } from '../src/shared/protocol.ts';
import { test, ok } from './harness.ts';
const OLD = '11111111-2222-4333-8444-555555555555', NEW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) { for (let i = 0; i < 150; i++) { if (predicate()) return; await delay(20); } throw Error('fixture timed out'); }
function agent(id: string, role: Agent['role'] = 'capcom'): Agent {
  return { id, role, callsign: 'CP', machineId: 'm', projectId: 'p', runtime: 'codex', state: 'idle', model: 'gpt-6-astra', pane: true,
    title: 'CAPCOM', block: null, parentId: null, childIds: [], depth: 0, mission: null, squad: null, lead: false, origin: 'orca',
    tool: null, toolDetail: null, lastPrompt: null, lastSay: null, startedAt: Date.now(), updatedAt: Date.now(), uptimeMs: 0, background: true, shortId: null,
    metrics: { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0 },
  };
}
export default { suite: 'Fresh CAPCOM isolated hub routing', tests: (['clean', 'continuity'] as const).map(mode => test(`${mode}: command, held TALK/direct mail, task context, activation notice and persistent mode`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-new-hub-'));
  const hub = await startHub({ port: 0, host: '127.0.0.1', quiet: true, auth: createAuth({ ORCA_TOKEN: 'fixture-token' }),
    store: new HubStore({ dir }), memory: new AnswerMemory(path.join(dir, 'memory.jsonl')), fleets: new FleetStore(path.join(dir, 'fleets')) });
  const collector = new WebSocket(`${hub.url.replace('http:', 'ws:')}${PATHS.collector}`);
  const ui = new WebSocket(`${hub.url.replace('http:', 'ws:')}${PATHS.console}`);
  const commands: any[] = []; const uiFrames: any[] = [];
  collector.on('message', data => { const f = JSON.parse(String(data)); if (f.t === 'cmd') { commands.push(f); collector.send(JSON.stringify({ t: 'ack', cmdId: f.id, ok: true, data: {} })); } });
  ui.on('message', data => uiFrames.push(JSON.parse(String(data))));
  try {
    await Promise.all([once(collector, 'open'), once(ui, 'open')]);
    const send = (f: unknown) => collector.send(JSON.stringify(f));
    const consoleSend = (f: unknown) => ui.send(JSON.stringify(f));
    send({ t: 'hello', v: PROTOCOL_VERSION, token: 'fixture-token', machine: { id: 'm', hostname: 'isolated', platform: 'darwin', version: 'test', online: true, lastSeen: Date.now(), connectedAt: Date.now(), load: { sessions: 1, activeSessions: 1, cpuPct: 0, memPct: 0 } } });
    const project = { id: 'p', machineId: 'm', slug: '-tmp-fixture', name: 'fixture', path: dir, code: 'FX', gitBranch: null, gitDirty: false, keyNames: [], sessionIds: [OLD], rollup: emptyRollup() };
    send({ t: 'snapshot', machineId: 'm', projects: [project], agents: [agent(OLD)], keys: [] });
    consoleSend({ t: 'hello', v: PROTOCOL_VERSION, token: 'fixture-token' });
    await until(() => !!hub.world.state.agents[OLD]);
    hub.tasks.create('task_fixture', 'Pending fixture'); hub.tasks.message('task_fixture', 'human', 'OLD_TASK_CONVERSATION_SENTINEL');
    consoleSend({ t: 'cmd', id: 'start-new', cmd: { k: 'capcom:new', agentId: OLD, mode, checkpoint: 'UNTRUSTED_CLIENT_CHECKPOINT' } });
    await until(() => commands.some(f => f.cmd.k === 'capcom:new'));
    const start = commands.find(f => f.cmd.k === 'capcom:new').cmd;
    assert.equal(start.mode, mode); assert.ok(!start.checkpoint.includes('UNTRUSTED_CLIENT_CHECKPOINT'));
    assert.equal(start.checkpoint.includes('task_fixture'), mode === 'continuity');
    hub.tasks.assign('task_fixture', ['worker']);
    const cutoffAt = Date.now();
    send({ t: 'capcom:transfer', machineId: 'm', fromId: OLD, hold: true, contextMode: mode, cutoffAt });
    await delay(40);
    const count = commands.filter(f => f.cmd.k === 'say').length;
    consoleSend({ t: 'ceo:say', id: 'new-task-message', taskId: 'task_fixture', text: 'NEW_OPERATOR_MESSAGE' });
    consoleSend({ t: 'cmd', id: 'direct-message', cmd: { k: 'say', agentId: OLD, text: 'DIRECT_MESSAGE' } });
    await until(() => uiFrames.some(f => f.cmdId === 'direct-message' || f.id === 'direct-message'));
    assert.equal(commands.filter(f => f.cmd.k === 'say').length, count);
    send({ t: 'snapshot', machineId: 'm', projects: [project], agents: [{ ...agent(OLD), role: undefined, state: 'done' }, agent(NEW), { ...agent('worker'), role: undefined, updatedAt: cutoffAt - 1, lastSay: 'OLD_WORKER_RESULT_SENTINEL' }], keys: [] });
    send({ t: 'message', machineId: 'm', message: { id: 'msg_during_cutover', kind: 'notice', scope: 'agent', fromAgentId: 'worker', fromCallsign: 'WK', fromProjectId: 'p', toAgentId: OLD, toProjectId: null, toSquad: null, subject: 'MAIL_DURING_CUTOVER', body: 'New report', files: [], at: Date.now(), readBy: [], expiresAt: null, answer: null, answeredAt: null, answeredBy: null } });
    send({ t: 'message', machineId: 'm', message: { id: 'msg_historical', kind: 'notice', scope: 'agent', fromAgentId: 'worker', fromCallsign: 'WK', fromProjectId: 'p', toAgentId: OLD, toProjectId: null, toSquad: null, subject: 'HISTORICAL_MAIL', body: 'New report', files: [], at: cutoffAt - 1, readBy: [], expiresAt: null, answer: null, answeredAt: null, answeredBy: null } });
    const handoff = { fromId: OLD, toId: NEW, machineId: 'm', at: Date.now(), fromRuntime: 'codex', toRuntime: 'codex', fromModel: 'gpt-6-astra', toModel: 'gpt-6-astra', reason: 'manual', contextMode: mode, cutoffAt, historyPath: path.join(dir, 'history.md'), checkpointPath: path.join(dir, 'HANDOFF.md') };
    send({ t: 'capcom:handoff', machineId: 'm', event: handoff });
    await until(() => !!hub.world.state.agents[NEW]);
    await delay(40); assert.equal(commands.filter(f => f.cmd.k === 'say').length, count);
    send({ t: 'capcom:transfer', machineId: 'm', fromId: OLD, hold: false, contextMode: mode, cutoffAt, toId: NEW });
    await until(() => commands.some(f => f.cmd.k === 'say' && f.cmd.text === 'DIRECT_MESSAGE'));
    await delay(850);
    const sayings = commands.filter(f => f.cmd.k === 'say').slice(count).map(f => f.cmd);
    assert.ok(sayings.every(c => c.agentId === NEW));
    assert.equal(commands.filter(f => f.cmd.k === 'deliver' && f.cmd.message.subject === 'MAIL_DURING_CUTOVER' && f.cmd.agentId === NEW).length, 1);
    assert.equal(commands.filter(f => f.cmd.k === 'deliver' && f.cmd.message.subject === 'HISTORICAL_MAIL').length, mode === 'clean' ? 0 : 1);
    assert.ok(hub.world.state.messages.msg_historical);
    assert.equal(sayings.filter(c => c.text === 'DIRECT_MESSAGE').length, 1);
    const taskText = sayings.find(c => c.text.includes('NEW_OPERATOR_MESSAGE')).text;
    assert.equal(taskText.includes('OLD_TASK_CONVERSATION_SENTINEL'), mode === 'continuity');
    assert.equal(sayings.some(c => c.text.includes('Call briefing first')), mode === 'continuity');
    assert.equal(sayings.some(c => c.text.includes('OLD_WORKER_RESULT_SENTINEL')), mode === 'continuity');
    send({ t: 'capcom:handoff', machineId: 'm', event: handoff });
    await delay(40); assert.equal(commands.filter(f => f.cmd.k === 'say').length, count + sayings.length);
    send({ t: 'snapshot', machineId: 'm', projects: [project], agents: [{ ...agent(OLD), role: undefined, state: 'done' }, agent(NEW), { ...agent('worker'), role: undefined, lastSay: 'NEW_WORKER_RESULT', updatedAt: Date.now() }], keys: [] });
    await until(() => commands.some(f => f.cmd.k === 'say' && f.cmd.text.includes('NEW_WORKER_RESULT')));
    const workerText = commands.find(f => f.cmd.k === 'say' && f.cmd.text.includes('NEW_WORKER_RESULT')).cmd.text;
    assert.equal(workerText.includes('OLD_TASK_CONVERSATION_SENTINEL'), mode === 'continuity');
    assert.ok(hub.tasks.get('task_fixture').messages.some(m => m.text === 'OLD_TASK_CONVERSATION_SENTINEL'));
    assert.match(fs.readFileSync(path.join(dir, 'capcom-handoffs.jsonl'), 'utf8'), new RegExp(`"contextMode":"${mode}"`));
    return ok(`${mode}: isolated websocket hub preserves mail, routes new UUID once, honors context and persists mode`, true);
  } finally { collector.terminate(); ui.terminate(); await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); }
})) };
