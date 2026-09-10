import { WebSocket } from 'ws';
import { PATHS } from '../src/shared/protocol.ts';
import { createAuth } from '../src/hub/auth.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub } from '../src/hub/server.ts';
import { HubStore } from '../src/hub/persist.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { FleetStore } from '../src/hub/fleets.ts';
import { runTool, type CeoContext } from '../src/agents/tools.ts';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import { agentStopReason } from '../src/shared/agent-stop.ts';
import type { Agent } from '../src/shared/types.ts';
import type { CapcomMission } from '../src/shared/missions.ts';
import type * as Fixture from './agent-stop.fixture.ts';
import { test, ok, type TestModule } from './harness.ts';
type F = typeof Fixture;
export default { suite: 'agent-stop', tests: [
  test('manual stop eligibility protects coordinators and unreachable sessions', () => {
    const a = { id: 'a', state: 'working', runtime: 'codex', pane: true } as Agent;
    assert.equal(agentStopReason(a), null);
    for (const change of [{ role: 'capcom' }, { state: 'done' }, { state: 'dead' }, { subagent: true }, { pane: false }, { pane: false, runtime: 'claude', background: false }]) {
      assert.ok(agentStopReason({ ...a, ...change } as Agent));
    }
    assert.ok(agentStopReason(undefined));
    assert.equal(agentStopReason({ ...a, runtime: 'claude', pane: false, background: true }), null);
    assert.equal(agentStopReason({ ...a, runtime: 'claude', pane: false, shortId: 'abc' }), null);
    const mission = { status: 'active', agentIds: ['a'] } as CapcomMission;
    assert.match(agentStopReason({ ...a, lead: true }, [mission])!, /active mission/);
    assert.equal(agentStopReason(a, [mission]), null);
    assert.ok(agentStopReason({ ...a, lead: true }, [{ ...mission, archivedAt: 1 }]), 'Archiving hides the mission but does not finish its work');
    assert.equal(agentStopReason({ ...a, lead: true }, [{ ...mission, status: 'completed' }]), null);
    assert.ok(agentStopReason({ ...a, lead: true, squad: 's' }, [{ ...mission, agentIds: [], squads: ['s'] }]));
    return ok('guards', true);
  }),
  test('hub revalidates manual stops before retirement; stop_agent uses the same reason and command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-agent-stop-'));
    const hub = await startHub({ port: 0, host: '127.0.0.1', quiet: true, harness: true, auth: createAuth({ ORCA_TOKEN: 'test-agent-stop-token' } as NodeJS.ProcessEnv),
      store: new HubStore({ dir: join(dir, 'hub') }), memory: new AnswerMemory(join(dir, 'memory')),
      fleets: new FleetStore(join(dir, 'fleets')) });
    try {
      const a = { id: 'guard', callsign: 'GUARD', role: 'capcom', state: 'working', pane: true } as Agent;
      hub.world.state.agents[a.id] = a;
      await assert.rejects(hub.dispatch({ k: 'stop', agentId: a.id, reason: 'manual test' }), /CAPCOM/);
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}${PATHS.console}?token=${hub.auth.token}`);
      try {
        await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        const ack = new Promise<{ ok: boolean; detail: string }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Missing synthetic console ack')), 3000);
          ws.on('message', raw => { const f = JSON.parse(String(raw)); if (f.t === 'ack' && f.cmdId === 'manual-no-reason') { clearTimeout(timer); resolve(f); } });
        });
        ws.send(JSON.stringify({ t: 'cmd', id: 'manual-no-reason', cmd: { k: 'stop', agentId: a.id } }));
        const result = await ack;
        assert.equal(result.ok, false); assert.match(result.detail, /CAPCOM/);
        assert.equal(hub.budgets.retired(a.id), false, 'A rejected stop does not retire the live agent');
      } finally { ws.close(); }
      a.role = undefined; a.lead = true;
      hub.missions.create('mission_stop_test', 'Stop guard'); hub.missions.assign('mission_stop_test', [a.id]);
      await assert.rejects(hub.dispatch({ k: 'stop', agentId: a.id, reason: 'manual test' }), /active mission/);
      a.lead = false; a.pane = false;
      await assert.rejects(hub.dispatch({ k: 'stop', agentId: a.id, reason: 'manual test' }), /background/);
      a.pane = true;
      await assert.rejects(hub.dispatch({ k: 'stop', agentId: a.id, reason: ' ' }), /reason/);
      const commands: unknown[] = [];
      const ctx = { agent: () => a, agents: () => [a], dispatch: async (_machine: string, command: unknown) => { commands.push(command); } } as unknown as CeoContext;
      const out = await runTool(ctx, 'stop_agent', { agent_id: a.id, reason: ' Duplicate work ' });
      assert.equal(out.isError, undefined);
      assert.deepEqual(commands, [{ k: 'stop', agentId: a.id, reason: 'Duplicate work' }]);
      assert.equal(hub.world.state.agents[a.id], a, 'Rejected stops preserve the agent');
      return ok('isolated hub guard and tool command', true);
    } finally { await hub.close(); rmSync(dir, { recursive: true, force: true }); }
  }),
  test('canvas and window stop confirm, cancel, revalidate and report ack/error without real commands', async () => {
    const server = await createServer({ configFile: false, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce' });
      await page.route('**/stop-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/hud.css"><link rel="stylesheet" href="/src/ui/styles/window.css"><body></body>' }));
      await page.goto(`${server.resolvedUrls!.local[0]}stop-fixture`);
      await page.evaluate(async () => { (window as any).f = await import('/test/agent-stop.fixture.ts' as string); });
      const act = (fn: (f: F) => void) => page.evaluate(`(${fn.toString()})(window.f)`);
      const count = () => page.evaluate(() => (window as any).f.commands.length);
      await act(f => f.menu());
      await page.getByRole('menuitem', { name: /STOP…/ }).click();
      await page.locator('dialog').waitFor();
      assert.equal(await count(), 0);
      await page.getByRole('button', { name: 'CANCEL', exact: true }).click();
      assert.equal(await count(), 0);
      await act(f => f.menu(true));
      await page.getByRole('menuitem', { name: /STOP…/ }).click();
      await page.locator('dialog').waitFor();
      await page.getByLabel('REASON', { exact: true }).fill('   ');
      assert.equal(await page.getByRole('button', { name: 'CONFIRM STOP' }).isDisabled(), true);
      await page.getByLabel('REASON', { exact: true }).fill('Duplicate work');
      await act(f => f.disconnect());
      assert.equal(await page.getByRole('button', { name: 'CONFIRM STOP' }).isDisabled(), true);
      await act(f => f.connect());
      await mkdir('test/shots', { recursive: true });
      await page.screenshot({ path: 'test/shots/agent-stop-desktop.png' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: 'test/shots/agent-stop-mobile.png' });
      assert.equal(await page.locator('dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
      await page.getByRole('button', { name: 'CONFIRM STOP' }).click();
      assert.equal(await count(), 1);
      assert.equal(await page.getByRole('button', { name: 'CONFIRM STOP' }).isDisabled(), true);
      await act(f => f.ack());
      await page.getByText(/Stop acknowledged/).waitFor();
      const cmd = await page.evaluate(() => (window as any).f.commands[0]);
      assert.deepEqual(cmd, { k: 'stop', agentId: 'test-stop', reason: 'Duplicate work' });
      await page.getByRole('button', { name: 'CLOSE', exact: true }).click();
      await act(f => f.open());
      await page.getByRole('button', { name: 'CONFIRM STOP' }).click();
      await act(f => f.fail());
      await page.getByText(/Stop not confirmed: synthetic timeout/).waitFor();
      assert.equal(await count(), 2);
      return ok('isolated browser checks and desktop/mobile captures', true);
    } finally { await browser.close(); await server.close(); }
  }),
] } satisfies TestModule;
