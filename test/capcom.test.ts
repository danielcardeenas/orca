/**
 * CAPCOM: the command layer, from the wire down.
 *
 * Three things are worth testing here and they are all failure modes that make
 * no noise:
 *
 *  - **The MCP door.** If `/mcp` answers without a token, the fleet's spawn and
 *    stop verbs are on the open internet the first time the hub goes behind a
 *    tunnel. If it answers *wrongly* with one, CAPCOM boots with no tools and
 *    simply never does anything.
 *  - **Routing.** What the human types has to reach the CAPCOM session. When it
 *    does not, the console looks exactly the same and nothing happens.
 *  - **The 90-second deadline.** A question handed to a wedged CAPCOM would
 *    otherwise wait forever with an agent stopped behind it. The clock is
 *    injected, so this costs a millisecond instead of a minute and a half.
 *
 * Nothing here launches a CLI or spends anything.
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, Escalation } from '../src/shared/types.ts';
import { PATHS, newId } from '../src/shared/protocol.ts';
import type { Command } from '../src/shared/protocol.ts';
import { createAuth } from '../src/hub/auth.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { HubStore } from '../src/hub/persist.ts';
import { FleetStore } from '../src/hub/fleets.ts';
import { startHub, type Hub } from '../src/hub/server.ts';
import {
  CapcomRouter, CAPCOM_TIMEOUT_REASON, capcomOf, escalationSay,
  type CapcomTimer,
} from '../src/hub/capcom.ts';
import { mcpDispatch, mcpTools, MCP_SERVER_NAME } from '../src/hub/mcp.ts';
import { CEO_TOOLS } from '../src/agents/tools.ts';
import { capcomBrief } from '../src/collector/briefs.ts';
import {
  CapcomSession, CAPCOM_FIRST_PROMPT, CAPCOM_GRACE_MS, capcomSettingsJson,
  hubHttpUrl, mcpConfigJson,
} from '../src/collector/capcom.ts';
import { squadsOf } from '../src/shared/squads.ts';
import { startFakeFleet } from './fake-collector.ts';
import { ok, eq, test, until, type TestModule } from './harness.ts';

const TOKEN = 'test-token-capcom-000';

/* ── fixtures ─────────────────────────────────────────────────────── */

function agent(over: Partial<Agent> = {}): Agent {
  const now = Date.now();
  return {
    id: over.id ?? newId('sess'), machineId: 'm1', projectId: 'p1',
    title: 'test', callsign: 'K1', runtime: 'claude', state: 'working', block: null,
    parentId: null, depth: 0, childIds: [], mission: null,
    squad: null, lead: false,
    model: null, tool: null, toolDetail: null,
    lastPrompt: null, lastSay: null, startedAt: now, updatedAt: now, uptimeMs: 0,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
      tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0,
      toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    background: false, shortId: null,
    ...over,
  };
}

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    id: 'esc_1', agentId: 'a1', projectId: 'p1', machineId: 'm1',
    question: 'Which Stripe key on staging?',
    context: null, options: ['test', 'production'], optionsOnly: false,
    urgency: 'blocking', status: 'pending', ceoAttempt: null,
    answer: null, answeredBy: null, rememberAs: null,
    askedAt: Date.now(), answeredAt: null, expiresAt: null,
    ...over,
  };
}

/** A clock the test drives by hand. Nothing here ever waits on wall time. */
function fakeClock() {
  let now = 1_000_000;
  const queued: { at: number; fn: () => void; dead: boolean }[] = [];
  return {
    now: () => now,
    setTimer: ((fn, ms) => {
      const entry = { at: now + ms, fn, dead: false };
      queued.push(entry);
      return { cancel: () => { entry.dead = true; } } satisfies CapcomTimer;
    }) as (fn: () => void, ms: number) => CapcomTimer,
    advance(ms: number): void {
      now += ms;
      for (const e of [...queued]) {
        if (e.dead || e.at > now) continue;
        e.dead = true;
        e.fn();
      }
    },
  };
}

function tempDir(): string { return mkdtempSync(join(tmpdir(), 'orca-capcom-')); }

async function withHub<T>(fn: (hub: Hub) => Promise<T>, opts: Parameters<typeof startHub>[0] = {}): Promise<T> {
  const dir = tempDir();
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    store: new HubStore({ dir }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
    fleets: new FleetStore(join(dir, 'fleets')),
    ...opts,
  });
  try { return await fn(hub); } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** POST one JSON-RPC message at a live hub's /mcp. */
async function rpc(
  port: number, body: unknown, token: string | null = TOKEN,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try { parsed = text ? JSON.parse(text) as Record<string, unknown> : null; } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

/* ── the MCP server ───────────────────────────────────────────────── */

const tests = [
  test('the MCP tool list is the fleet command, not a copy of it', () => {
    const names = mcpTools().map((t) => t.name).sort();
    const expected = CEO_TOOLS.map((t) => t.name).sort();
    const shaped = mcpTools().every((t) =>
      typeof t.description === 'string' && t.description.length > 20
      && typeof t.inputSchema === 'object' && t.inputSchema !== null);
    return ok(
      'the MCP tool list is derived from CEO_TOOLS',
      JSON.stringify(names) === JSON.stringify(expected) && shaped,
      `${names.length} tools, same set as the API command`,
    );
  }),

  test('spawn_agent can enlist a squad and list_fleet reports them back', () => {
    const spawn = mcpTools().find((t) => t.name === 'spawn_agent');
    const props = (spawn?.inputSchema['properties'] ?? {}) as Record<string, unknown>;
    return ok(
      'spawn_agent carries squad and lead',
      'squad' in props && 'lead' in props,
      Object.keys(props).join(', '),
    );
  }),

  test('initialize answers with a protocol version and a tools capability', async () => {
    return await withHub(async (hub) => {
      const { status, body } = await rpc(hub.port, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      });
      const r = (body?.['result'] ?? {}) as Record<string, unknown>;
      const info = (r['serverInfo'] ?? {}) as Record<string, unknown>;
      const caps = (r['capabilities'] ?? {}) as Record<string, unknown>;
      return ok(
        'initialize answers with a protocol version and a tools capability',
        status === 200 && r['protocolVersion'] === '2025-03-26'
        && info['name'] === MCP_SERVER_NAME && 'tools' in caps,
        `${status} · ${String(r['protocolVersion'])} · ${String(info['name'])}`,
      );
    });
  }),

  test('notifications/initialized gets 202 and no body', async () => {
    return await withHub(async (hub) => {
      const res = await fetch(`http://127.0.0.1:${hub.port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      const text = await res.text();
      return ok(
        'notifications/initialized gets 202 and no body',
        res.status === 202 && text.length === 0,
        `${res.status}, ${text.length} bytes`,
      );
    });
  }),

  test('tools/list over HTTP returns every command tool', async () => {
    return await withHub(async (hub) => {
      const { status, body } = await rpc(hub.port, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const tools = ((body?.['result'] as { tools?: { name: string }[] } | undefined)?.tools) ?? [];
      const names = tools.map((t) => t.name);
      return ok(
        'tools/list over HTTP returns every command tool',
        status === 200 && names.length === CEO_TOOLS.length
        && names.includes('list_fleet') && names.includes('ask_human')
        && names.includes('remember'),
        `${names.length} tools`,
      );
    });
  }),

  test('tools/call list_fleet runs against the live world', async () => {
    return await withHub(async (hub) => {
      hub.world.applyCollector(
        { t: 'agent:new', machineId: 'm1', agent: agent({ id: 'a1', callsign: 'K9' }) }, 'm1',
      );
      const { status, body } = await rpc(hub.port, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'list_fleet', arguments: { only_blocked: false } },
      });
      const r = (body?.['result'] ?? {}) as { content?: { type: string; text: string }[]; isError?: boolean };
      const first = r.content?.[0];
      const parsed = first ? JSON.parse(first.text) as { summary?: string; result?: unknown } : null;
      return ok(
        'tools/call list_fleet runs against the live world',
        status === 200 && first?.type === 'text' && r.isError !== true
        && typeof parsed?.summary === 'string'
        && typeof (parsed?.result as { projects?: unknown })?.projects === 'object',
        parsed?.summary,
      );
    });
  }),

  test('tools/call launch_squad over MCP puts a numbered squad on the field, lead and all', async () => {
    return await withHub(async (hub) => {
      // A fake machine with real projects: the launch has to land somewhere.
      const fleet = startFakeFleet({ hub: `ws://127.0.0.1:${hub.port}`, token: TOKEN, quiet: true, speed: 6 });
      try {
        const ready = await until(() => Object.keys(hub.world.state.projects).length > 0, 8000, 50);
        if (!ready) return ok('launch_squad over MCP', false, 'the fake fleet never reported a project');
        const projectId = Object.keys(hub.world.state.projects)[0]!;

        const { status, body } = await rpc(hub.port, {
          jsonrpc: '2.0', id: 31, method: 'tools/call',
          params: {
            name: 'launch_squad',
            arguments: {
              project_id: projectId, squad: 'audit', background: true, lead_model: null,
              lead_mission: 'Lead the audit: split the work below across your members and consolidate one report.',
              members: [
                { mission: 'Audit the dependency manifest and report what is unused or behind, without upgrading.', model: null },
                { mission: 'Run the test suite and fix what fails without changing any exported signature.', model: null },
              ],
            },
          },
        });
        const r = (body?.['result'] ?? {}) as { content?: { text: string }[]; isError?: boolean };
        const parsed = JSON.parse(r.content?.[0]?.text ?? '{}') as {
          result?: { squad?: string; lead?: { agent_id: string | null }; members?: { agent_id: string | null }[] };
        };
        const name = parsed.result?.squad ?? '';
        const onField = () => squadsOf(hub.world.state.agents).find((s) => s.name === name);
        const arrived = await until(() => (onField()?.memberIds.length ?? 0) === 3, 8000, 50);
        const sq = onField();
        const leadId = parsed.result?.lead?.agent_id ?? null;
        const parented = sq?.memberIds.filter((id) => id !== leadId)
          .every((id) => hub.world.state.agents[id]?.parentId === leadId) ?? false;
        return ok(
          'launch_squad over MCP puts a numbered squad on the field',
          status === 200 && r.isError !== true && /^audit-\d\d$/.test(name) && arrived
          && sq?.leaderId === leadId && parented,
          `${name}: lead ${leadId ?? '(none)'}, ${sq?.memberIds.length ?? 0} on the field`,
        );
      } finally {
        fleet.stop();
      }
    });
  }),

  test('a failed tool comes back as a readable result, not a protocol error', async () => {
    return await withHub(async (hub) => {
      const { status, body } = await rpc(hub.port, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'inspect_agent', arguments: { agent_id: 'nobody' } },
      });
      const r = (body?.['result'] ?? {}) as { content?: { text: string }[]; isError?: boolean };
      return ok(
        'a failed tool comes back as a readable result',
        status === 200 && body?.['error'] === undefined && r.isError === true
        && (r.content?.[0]?.text ?? '').includes('nobody'),
        r.content?.[0]?.text?.slice(0, 60),
      );
    });
  }),

  test('/mcp without a token is 401 and says how to fix it', async () => {
    return await withHub(async (hub) => {
      const res = await fetch(`http://127.0.0.1:${hub.port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
      });
      const text = await res.text();
      return ok(
        '/mcp without a token is 401',
        res.status === 401 && text.includes('token'),
        `${res.status} ${text.slice(0, 60)}`,
      );
    });
  }),

  test('/mcp with the wrong token is 401 too', async () => {
    return await withHub(async (hub) => {
      const { status } = await rpc(hub.port, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, 'not-the-token');
      return eq('/mcp with the wrong token is 401', status, 401);
    });
  }),

  test('the token may ride in the query string, which is all .mcp.json can carry', async () => {
    return await withHub(async (hub) => {
      const res = await fetch(`http://127.0.0.1:${hub.port}/mcp?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }),
      });
      return eq('the token may ride in the query string', res.status, 200);
    });
  }),

  test('GET /mcp is a clean 405 rather than a hung stream', async () => {
    return await withHub(async (hub) => {
      const res = await fetch(`http://127.0.0.1:${hub.port}/mcp?token=${TOKEN}`);
      await res.text();
      return eq('GET /mcp is 405', res.status, 405);
    });
  }),

  test('an unknown method is a JSON-RPC error, not a crash', async () => {
    const out = await mcpDispatch(
      { jsonrpc: '2.0', id: 9, method: 'tools/teleport' },
      { context: () => { throw new Error('never reached'); } },
    );
    const err = (out?.error ?? {}) as { code?: number };
    return eq('an unknown method is a JSON-RPC error', err.code, -32601);
  }),

  /* ── routing ────────────────────────────────────────────────────── */

  test('capcomOf ignores a dead command session', () => {
    const live = agent({ id: 'c2', role: 'capcom', state: 'idle', startedAt: 2 });
    const found = capcomOf([
      agent({ id: 'a1' }),
      agent({ id: 'c1', role: 'capcom', state: 'dead', startedAt: 1 }),
      live,
    ]);
    return eq('capcomOf ignores a dead command session', found?.id, 'c2');
  }),

  test('an escalation reaches CAPCOM as one line carrying its id', () => {
    const line = escalationSay(escalation(), 'K9');
    return ok(
      'an escalation reaches CAPCOM as one line carrying its id',
      line.startsWith('[ESCALATION esc_1]') && line.includes('K9 asks')
      && line.includes('options: test | production') && line.includes('BLOCKING'),
      line,
    );
  }),

  test('with a CAPCOM alive, what the human types becomes a say command to it', async () => {
    return await withHub(async (hub) => {
      const commands: { agentId: string; text: string }[] = [];
      // A CAPCOM session in the world, and a fake collector socket to receive
      // the command the hub routes to it.
      hub.world.applyCollector(
        { t: 'agent:new', machineId: 'm1', agent: agent({ id: 'cap1', callsign: 'CC', role: 'capcom' }) },
        'm1',
      );
      const { WebSocket } = await import('ws');
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}${PATHS.collector}?token=${TOKEN}`);
      await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
      ws.send(JSON.stringify({
        t: 'hello', v: 1, token: TOKEN,
        machine: {
          id: 'm1', hostname: 'test', platform: 'darwin', version: '0.1.0', online: true,
          lastSeen: Date.now(), connectedAt: Date.now(),
          load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null },
        },
      }));
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString()) as { t: string; cmd?: Command };
        if (f.t === 'cmd' && f.cmd?.k === 'say') commands.push({ agentId: f.cmd.agentId, text: f.cmd.text });
      });

      const console1 = new WebSocket(`ws://127.0.0.1:${hub.port}${PATHS.console}?token=${TOKEN}`);
      await new Promise<void>((res, rej) => { console1.once('open', () => res()); console1.once('error', rej); });
      console1.send(JSON.stringify({ t: 'ceo:say', text: 'status of the fleet please' }));

      const arrived = await until(() => commands.length > 0, 4000);
      const said = commands[0];
      // And the human's line is still in the transcript the console reads.
      const history = hub.world.state.ceo.messages.some((m) => m.role === 'human' && m.text.includes('status of the fleet'));
      ws.close(); console1.close();
      return ok(
        'what the human types becomes a say command to CAPCOM',
        arrived && said?.agentId === 'cap1' && said?.text === 'status of the fleet please' && history,
        `${commands.length} say(s) → ${said?.agentId ?? 'nobody'}`,
      );
    });
  }),

  test('with no CAPCOM, the human still reaches the API command', async () => {
    const seen: string[] = [];
    return await withHub(async (hub) => {
      const { WebSocket } = await import('ws');
      const c = new WebSocket(`ws://127.0.0.1:${hub.port}${PATHS.console}?token=${TOKEN}`);
      await new Promise<void>((res, rej) => { c.once('open', () => res()); c.once('error', rej); });
      c.send(JSON.stringify({ t: 'ceo:say', text: 'anybody home' }));
      const arrived = await until(() => seen.length > 0, 4000);
      c.close();
      return ok('with no CAPCOM the API command still gets it', arrived && seen[0] === 'anybody home', seen[0]);
    }, { onCeoSay: (text) => { seen.push(text); } });
  }),

  test('--api-command keeps the API CEO in charge even with CAPCOM alive', async () => {
    const seen: string[] = [];
    return await withHub(async (hub) => {
      hub.world.applyCollector(
        { t: 'agent:new', machineId: 'm1', agent: agent({ id: 'cap1', role: 'capcom' }) }, 'm1',
      );
      const { WebSocket } = await import('ws');
      const c = new WebSocket(`ws://127.0.0.1:${hub.port}${PATHS.console}?token=${TOKEN}`);
      await new Promise<void>((res, rej) => { c.once('open', () => res()); c.once('error', rej); });
      c.send(JSON.stringify({ t: 'ceo:say', text: 'forced to the api' }));
      const arrived = await until(() => seen.length > 0, 4000);
      c.close();
      return ok(
        '--api-command keeps the API CEO in charge',
        arrived && hub.capcom() === null,
        `onCeoSay fired: ${arrived}, hub.capcom(): ${hub.capcom()?.id ?? 'null'}`,
      );
    }, { apiCommand: true, onCeoSay: (text) => { seen.push(text); } });
  }),

  /* ── the 90-second deadline ─────────────────────────────────────── */

  test('an escalation is handed to CAPCOM and marked as being triaged', () => {
    const clock = fakeClock();
    const said: string[] = [];
    let esc = escalation();
    const router = new CapcomRouter({
      capcom: () => agent({ id: 'cap1', role: 'capcom' }),
      say: (_id, text) => { said.push(text); },
      escalation: () => esc,
      markWithCeo: () => { esc = { ...esc, status: 'with_ceo' }; },
      giveUp: () => { /* not this test */ },
      setTimer: clock.setTimer,
    });
    const took = router.offer('esc_1');
    return ok(
      'an escalation is handed to CAPCOM and marked as being triaged',
      took && esc.status === 'with_ceo' && said.length === 1 && said[0]!.includes('[ESCALATION esc_1]'),
      said[0]?.slice(0, 70),
    );
  }),

  test('a CAPCOM that answers in time keeps the human out of it', () => {
    const clock = fakeClock();
    let esc = escalation();
    let gaveUp = false;
    const router = new CapcomRouter({
      capcom: () => agent({ id: 'cap1', role: 'capcom' }),
      say: () => { /* delivered */ },
      escalation: () => esc,
      markWithCeo: () => { esc = { ...esc, status: 'with_ceo' }; },
      giveUp: () => { gaveUp = true; },
      setTimer: clock.setTimer,
    }, { answerMs: 90_000 });
    router.offer('esc_1');
    // answer_agent lands: the world closes the record.
    esc = { ...esc, status: 'answered', answer: 'the test key', answeredBy: 'ceo' };
    clock.advance(120_000);
    return ok('a CAPCOM that answers in time keeps the human out of it', !gaveUp, `gaveUp=${gaveUp}`);
  }),

  test('a silent CAPCOM loses the question to the human after 90 s', () => {
    const clock = fakeClock();
    let esc = escalation();
    const gaveUp: { id: string; reason: string }[] = [];
    const router = new CapcomRouter({
      capcom: () => agent({ id: 'cap1', role: 'capcom' }),
      say: () => { /* delivered, and never answered */ },
      escalation: () => esc,
      markWithCeo: () => { esc = { ...esc, status: 'with_ceo' }; },
      giveUp: (id, reason) => { gaveUp.push({ id, reason }); },
      setTimer: clock.setTimer,
    }, { answerMs: 90_000 });
    router.offer('esc_1');

    clock.advance(89_000);
    const earlyQuiet = gaveUp.length === 0;
    clock.advance(2_000);

    return ok(
      'a silent CAPCOM loses the question to the human after 90 s',
      earlyQuiet && gaveUp.length === 1 && gaveUp[0]?.id === 'esc_1'
      && gaveUp[0]?.reason === CAPCOM_TIMEOUT_REASON,
      `${gaveUp.length} handover(s): ${gaveUp[0]?.reason ?? '—'}`,
    );
  }),

  test('with no CAPCOM the router declines and the caller falls back', () => {
    const clock = fakeClock();
    const router = new CapcomRouter({
      capcom: () => null,
      say: () => { throw new Error('nothing should be delivered'); },
      escalation: () => escalation(),
      markWithCeo: () => { throw new Error('nothing should be marked'); },
      giveUp: () => { /* unreachable */ },
      setTimer: clock.setTimer,
    });
    return ok(
      'with no CAPCOM the router declines',
      !router.offer('esc_1') && !router.humanSays('hello'),
      'both offers declined',
    );
  }),

  test('the escalation CAPCOM holds can be recovered from who asked', () => {
    const clock = fakeClock();
    let esc = escalation({ agentId: 'a7' });
    const router = new CapcomRouter({
      capcom: () => agent({ id: 'cap1', role: 'capcom' }),
      say: () => { /* delivered */ },
      escalation: () => esc,
      markWithCeo: () => { esc = { ...esc, status: 'with_ceo' }; },
      giveUp: () => { /* not this test */ },
      setTimer: clock.setTimer,
    });
    router.offer('esc_1');
    return ok(
      'the escalation CAPCOM holds can be recovered from who asked',
      router.openFor('a7') === 'esc_1' && router.openFor('a8') === null && router.openFor(null) === null,
      `openFor(a7)=${router.openFor('a7')}`,
    );
  }),

  /* ── the brief and the files it boots from ──────────────────────── */

  test('the brief names every tool CAPCOM actually has', () => {
    const brief = capcomBrief();
    const missing = CEO_TOOLS.map((t) => t.name).filter((n) => !brief.includes(`\`${n}\``));
    return ok(
      'the brief names every tool CAPCOM actually has',
      missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : `${CEO_TOOLS.length} tools named`,
    );
  }),

  test('the brief teaches the loop: the prefix, both exits, and the deadline', () => {
    const brief = capcomBrief();
    const has = (s: string) => brief.includes(s);
    return ok(
      'the brief teaches the loop',
      has('[ESCALATION <id>]') && has('`answer_agent`') && has('`ask_human`')
      && has('`recall`') && has('90 seconds') && has('escalation_id'),
      `${brief.length} chars`,
    );
  }),

  test('the MCP config points at the hub over HTTP with the token on it', () => {
    const url = hubHttpUrl('ws://127.0.0.1:4479/ws/collector');
    const cfg = JSON.parse(mcpConfigJson(url, 'tok-123')) as {
      mcpServers: { orca: { type: string; url: string } };
    };
    const orca = cfg.mcpServers.orca;
    return ok(
      'the MCP config points at the hub over HTTP with the token on it',
      url === 'http://127.0.0.1:4479'
      && orca.type === 'http' && orca.url === 'http://127.0.0.1:4479/mcp?token=tok-123',
      orca.url,
    );
  }),

  test('wss becomes https, so a tunnelled hub still works', () => {
    return eq('wss becomes https',
      hubHttpUrl('wss://orca.example.com/ws/collector'), 'https://orca.example.com');
  }),

  test('the settings approve the orca server and deny the tools that write code', () => {
    const s = JSON.parse(capcomSettingsJson()) as {
      enableAllProjectMcpServers?: boolean;
      permissions?: { allow?: string[]; deny?: string[] };
    };
    return ok(
      'the settings approve the orca server and deny the code tools',
      s.enableAllProjectMcpServers === true
      && (s.permissions?.allow ?? []).includes('mcp__orca')
      && (s.permissions?.deny ?? []).includes('Bash')
      && (s.permissions?.deny ?? []).includes('Edit'),
      JSON.stringify(s.permissions),
    );
  }),

  test('starting CAPCOM writes its brief, its MCP config, and marks it as the command', async () => {
    const dir = tempDir();
    try {
      const noted: string[] = [];
      const spawns: { shortId: string; role: string }[] = [];
      const args: string[] = [];
      const session = new CapcomSession({
        bin: '/fake/claude',
        hubUrl: 'ws://127.0.0.1:4479',
        token: 'tok-abc',
        dir,
        lineage: {
          noteSpawn: (shortId, _p, _m, _s, _l, role) => { spawns.push({ shortId, role: role ?? 'agent' }); },
        },
        alive: () => false,
        note: (_level, text) => { noted.push(text); },
        launch: async (_bin, a) => { args.push(...a); return { ok: true, stdout: 'started 1a2b3c4d\n', detail: '' }; },
      });
      const out = await session.ensure();

      const brief = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
      const mcp = readFileSync(join(dir, '.mcp.json'), 'utf8');
      const settings = existsSync(join(dir, '.claude', 'settings.json'));

      /*
       * The argv is load-bearing and gets checked properly.
       *
       * `--allowedTools` and `--mcp-config` are VARIADIC: they swallow every
       * following argument until the next `-`. The prompt is positional under
       * `--bg`, so a variadic option left next to it would eat it and CAPCOM
       * would boot with no instruction at all — a session that starts fine and
       * does nothing, which is the failure nobody notices.
       */
      const VARIADIC = new Set(['--allowedTools', '--disallowedTools', '--mcp-config', '--tools']);
      const promptLast = args[args.length - 1] === CAPCOM_FIRST_PROMPT;
      const variadicsTerminated = args.every((a, i) => {
        if (!VARIADIC.has(a)) return true;
        // Walk its values; the argument after them must be another option.
        let j = i + 1;
        while (j < args.length && !args[j]!.startsWith('-')) j += 1;
        return j < args.length;
      });
      const preApproved = args.includes('--allowedTools') && args.includes('mcp__orca');

      return ok(
        'starting CAPCOM writes its files and marks it as the command',
        out.ok && out.shortId === '1a2b3c4d'
        && spawns[0]?.role === 'capcom'
        && brief.includes('CAPCOM') && mcp.includes('tok-abc') && settings
        && promptLast && variadicsTerminated && preApproved,
        `${out.shortId} · prompt last: ${promptLast}, variadics terminated: ${variadicsTerminated}`,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('talking to CAPCOM carries its tools, and the role follows the new session', async () => {
    const dir = tempDir();
    try {
      const spawned: { shortId: string; role: string }[] = [];
      const session = new CapcomSession({
        bin: '/fake/claude', hubUrl: 'ws://127.0.0.1:4479', token: 't', dir,
        lineage: { noteSpawn: (id, _p, _m, _s, _l, role) => { spawned.push({ shortId: id, role: role ?? 'agent' }); } },
        alive: () => false,
        note: () => { /* quiet */ },
        launch: async () => ({ ok: true, stdout: 'aaaa1111\n', detail: '' }),
      });
      await session.ensure();

      /*
       * `claude --bg --resume` does not continue under the same id: it carries
       * the conversation into a NEW session. Measured against CLI 2.1.261. If
       * the role does not move with it, the very first thing the human says
       * leaves the fleet with no command — the hub looks for a live
       * `role:'capcom'`, finds the finished session, and the collector launches
       * a second CAPCOM on top of the one that just answered.
       */
      const owned = session.owns('aaaa1111');
      session.adopt('bbbb2222');
      const moved = session.owns('bbbb2222') && !session.owns('aaaa1111');

      // Every invocation has to re-name the MCP server: a resumed CAPCOM
      // without it reads its brief and finds it has no tools at all.
      const args = session.launchArgs();
      const carriesTools = args.includes('--mcp-config') && args.includes(`mcp__orca`)
        && args.includes('--strict-mcp-config');

      return ok(
        'talking to CAPCOM carries its tools, and the role follows the new session',
        owned && moved && carriesTools
        && spawned.filter((x) => x.role === 'capcom').length === 2,
        `${spawned.map((x) => x.shortId).join(' → ')} · ${args.length} args`,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('a CAPCOM that is already alive is adopted, never launched twice', async () => {
    const dir = tempDir();
    try {
      let launches = 0;
      const make = (alive: (id: string) => boolean) => new CapcomSession({
        bin: '/fake/claude', hubUrl: 'ws://127.0.0.1:4479', token: 't', dir,
        lineage: { noteSpawn: () => { /* noted */ } },
        alive,
        note: () => { /* quiet */ },
        launch: async () => { launches += 1; return { ok: true, stdout: 'id deadbeef\n', detail: '' }; },
      });

      await make(() => false).ensure();          // first run: launches
      const after = await make(() => true).ensure();  // a collector restart: adopts

      return ok(
        'a CAPCOM that is already alive is adopted, never launched twice',
        launches === 1 && after.ok && after.shortId === 'deadbeef',
        `${launches} launch(es), adopted ${after.shortId}`,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('a session adopted a moment ago is not declared dead before the CLI lists it', async () => {
    const dir = tempDir();
    try {
      let now = 1_000_000;
      let launches = 0;
      const session = new CapcomSession({
        bin: '/fake/claude', hubUrl: 'ws://127.0.0.1:4479', token: 't', dir,
        lineage: { noteSpawn: () => { /* noted */ } },
        // The worst case: liveness never confirms it.
        alive: () => false,
        note: () => { /* quiet */ },
        now: () => now,
        launch: async () => { launches += 1; return { ok: true, stdout: 'cafe0001\n', detail: '' }; },
      });
      await session.ensure();
      // Inside the grace window: believed in, whatever liveness says.
      now += CAPCOM_GRACE_MS - 1_000;
      session.check();
      const heldOn = session.current() === 'cafe0001';
      // Past it: declared dead, and the relaunch clock starts.
      now += 2_000;
      session.check();
      return ok(
        'a session adopted a moment ago is not declared dead before the CLI lists it',
        heldOn && session.current() === null && launches === 1,
        `held on: ${heldOn}, then dropped: ${session.current() === null}`,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('CAPCOM that will not start is retried, capped, and then said out loud', async () => {
    const dir = tempDir();
    try {
      let now = 1_000_000;
      let launches = 0;
      const noted: string[] = [];
      const session = new CapcomSession({
        bin: '/fake/claude', hubUrl: 'ws://127.0.0.1:4479', token: 't', dir,
        lineage: { noteSpawn: () => { /* never reached */ } },
        alive: () => false,
        note: (_l, text) => { noted.push(text); },
        now: () => now,
        launch: async () => { launches += 1; return { ok: false, stdout: '', detail: 'exit 1' }; },
      });
      // Six attempts an hour apart from each other by a minute: the cap is five.
      for (let i = 0; i < 6; i++) {
        await session.ensure();
        now += 60_000;
      }
      return ok(
        'a CAPCOM that will not start is retried, capped, and said out loud',
        launches === 5 && noted.some((n) => n.includes('dejo de relanzarlo')),
        `${launches} attempts · ${noted[noted.length - 1]?.slice(0, 70)}`,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),
];

const suite: TestModule = { suite: 'capcom · MCP · routing · lifecycle', tests };
export default suite;
