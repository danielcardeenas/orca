import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { HandoffStore } from '../src/hub/handoffs.ts';
import { parseHandoff, handoffText, HANDOFF_NOTICE_PREFIX } from '../src/shared/handoff.ts';
import { classifyPrompt } from '../src/ui/windows/talk.ts';
import { startHub } from '../src/hub/server.ts';
import { HubStore } from '../src/hub/persist.ts';
import { FleetStore } from '../src/hub/fleets.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { createAuth } from '../src/hub/auth.ts';
import { hubContext } from '../src/agents/context.ts';
import { runTool } from '../src/agents/tools.ts';
import type { Agent } from '../src/shared/types.ts';
import { test, ok, until } from './harness.ts';

export const exampleHandoff = parseHandoff({ fromId: 'old', toId: 'cap', machineId: 'm', at: 1788676926973,
  fromRuntime: 'claude', fromModel: 'claude-fable-5-1', toRuntime: 'codex', toModel: 'gpt-6-astra', reason: 'usage_limit',
  historyPath: '/tmp/recovery/conversation.md', checkpointPath: '/tmp/recovery/HANDOFF.md' })!;

export default { suite: 'CAPCOM handoff indicator', tests: [
  test('handoff survives restart and duplicate replay without losing history references', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-handoff-'));
    try {
      const store = new HandoffStore(dir);
      assert.ok(store.add(exampleHandoff));
      assert.equal(store.add(exampleHandoff), null);
      fs.appendFileSync(path.join(dir, 'capcom-handoffs.jsonl'), '{torn');
      const again = new HandoffStore(dir);
      assert.deepEqual(again.all(), [exampleHandoff]);
      assert.equal(again.add(exampleHandoff), null);
      const next = { ...exampleHandoff, fromId: 'cap', toId: 'new' };
      assert.ok(again.add(next));
      assert.equal(new HandoffStore(dir).all().length, 2);
      assert.match(handoffText(exampleHandoff), /TALK can load the archived conversation/);
      assert.equal(classifyPrompt(`${HANDOFF_NOTICE_PREFIX}\n${handoffText(exampleHandoff)}`).role, 'system');
      return ok('durable, idempotent, honest history scope', true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }),
  test('invalid metadata is not presented as a successful handoff', () => {
    for (const patch of [{ fromId: 'cap' }, { at: NaN }, { reason: 'success' }, { historyPath: 'javascript:alert(1)' }, { toModel: '<script>' }]) {
      assert.equal(parseHandoff({ ...exampleHandoff, ...patch }), null);
    }
    return ok('invalid event rejected', true);
  }),
  test('authenticated handoff reaches chat, feed and repeatable MCP briefing once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-handoff-hub-'));
    const hub = await startHub({ port: 0, host: '127.0.0.1', quiet: true,
      auth: createAuth({ ORCA_TOKEN: 'handoff-test' }), store: new HubStore({ dir }),
      memory: new AnswerMemory(path.join(dir, 'memory.jsonl')), fleets: new FleetStore(path.join(dir, 'fleets')) });
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws/collector`);
    let notices = 0;
    ws.on('message', raw => {
      const f = JSON.parse(raw.toString());
      if (f.t === 'cmd') {
        if (f.cmd.k === 'say') notices++;
        ws.send(JSON.stringify({ t: 'ack', cmdId: f.id, ok: true }));
      }
    });
    try {
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      ws.send(JSON.stringify({ t: 'hello', v: 1, token: 'handoff-test', machine: {
        id: 'm', hostname: 'fixture', platform: 'darwin', version: '1', online: true, lastSeen: Date.now(), connectedAt: Date.now(),
        load: { sessions: 1, activeSessions: 1, cpuPct: null, memPct: null } } }));
      await until(() => !!hub.world.state.machines.m, 2000, 10);
      hub.world.state.agents.cap = { id: 'cap', machineId: 'm', projectId: 'p', role: 'capcom', state: 'idle', runtime: 'codex', model: 'gpt-6-astra', callsign: 'CP',
        title: 'CAPCOM', parentId: null, childIds: [], depth: 0, squad: null, lead: false, block: null, mission: null, lastSay: null, lastPrompt: null,
        tool: null, toolDetail: null, startedAt: Date.now(), updatedAt: Date.now(), uptimeMs: 0, background: false, shortId: null,
        metrics: { costUSD: 0, tokensPerSec: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0 } } as Agent;
      const send = (event: unknown) => ws.send(JSON.stringify({ t: 'capcom:handoff', machineId: 'm', event }));
      send({ ...exampleHandoff, machineId: 'foreign' });
      send(exampleHandoff);
      send(exampleHandoff);
      await until(() => notices === 1, 2000, 10);
      assert.equal(hub.world.state.capcomHandoffs?.length, 1);
      assert.equal(hub.world.state.ceo.messages.filter(m => m.id === exampleHandoff.id).length, 1);
      assert.equal(hub.world.state.feed.filter(f => f.id === exampleHandoff.id).length, 1);
      for (let i = 0; i < 2; i++) {
        const out = await runTool(hubContext(hub), 'briefing', {});
        assert.match(out.result, /CAPCOM SESSION HANDOFFS/);
        assert.match(out.result, /claude-fable-5-1/);
        assert.match(out.result, /conversation.md/);
      }
      assert.equal(new HandoffStore(dir).all().length, 1);
      return ok('one event and notice; briefing retains it after each read', true);
    } finally { ws.close(); await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }),
] };
