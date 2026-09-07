/**
 * CAPCOM rotation: a session recycled before it forgets.
 *
 * Four things are worth testing and every one of them fails in silence:
 *
 *  - **The policy.** Rotating mid-turn kills a tool call; rotating with a
 *    question pending loses the question. The verdict has to refuse both and
 *    still fire once the session is idle and over the line.
 *  - **The signal.** Compactions are read off the transcript. If the count
 *    never moves, nothing ever rotates and the commander drifts for days.
 *  - **The hand-over.** The old session is stopped, a new one starts with the
 *    rotated prompt, the role moves, and the relaunch cap is not charged.
 *  - **The hub's window.** Between the old pane dying and the new transcript
 *    appearing, what the operator types must wait for the new CAPCOM, not
 *    bounce as "no CAPCOM connected", and the feed must say it was a rotation.
 *
 * Nothing here launches a CLI.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import type { Agent } from '../src/shared/types.ts';
import { PATHS, newId } from '../src/shared/protocol.ts';
import type { Command } from '../src/shared/protocol.ts';
import { createAuth } from '../src/hub/auth.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { HubStore } from '../src/hub/persist.ts';
import { FleetStore } from '../src/hub/fleets.ts';
import { startHub, type Hub } from '../src/hub/server.ts';
import { CapcomRouter, type CapcomTimer } from '../src/hub/capcom.ts';
import { SessionDeriver } from '../src/collector/derive.ts';
import type { TranscriptRef } from '../src/collector/watch.ts';
import {
  CapcomSession, CAPCOM_FIRST_PROMPT, CAPCOM_GRACE_MS, CAPCOM_RESTART_MS, CAPCOM_ROTATED_PROMPT,
} from '../src/collector/capcom.ts';
import { ROTATION_DEFAULTS, rotationConfig, rotationVerdict, type RotationObservation } from '../src/collector/rotation.ts';
import { ok, test, until, type TestModule } from './harness.ts';

const TOKEN = 'test-token-rotation-000';

/* ── fixtures ─────────────────────────────────────────────────────── */

function agent(over: Partial<Agent> = {}): Agent {
  const now = Date.now();
  return {
    id: over.id ?? newId('sess'), machineId: 'm1', projectId: 'p1',
    title: 'test', callsign: 'K1', runtime: 'claude', state: 'idle', block: null,
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

const NOW = 5_000_000;
function observation(over: Partial<RotationObservation> = {}): RotationObservation {
  return {
    state: 'idle', turns: 10, compactions: 0, contextTokens: 50_000,
    lastActivityAt: NOW - 120_000, lastDeliveryAt: NOW - 120_000, pendingEscalations: 0,
    ...over,
  };
}

function tempDir(): string { return mkdtempSync(join(tmpdir(), 'orca-rotation-')); }

/** A hosted CapcomSession on a fake tmux, with everything it does recorded. */
function hostedSession(dir: string, o: { alive?: (id: string) => boolean; now?: () => number } = {}) {
  const panes: { name: string; argv: string[] }[] = [];
  const killed: string[] = [];
  const demoted: string[] = [];
  const roles: string[] = [];
  const noted: string[] = [];
  const rotated: { fromId: string; turns: number; compactions: number }[] = [];
  const order: string[] = [];
  const session = new CapcomSession({
    bin: '/fake/claude', hubUrl: 'ws://127.0.0.1:4479', token: 'tok', dir,
    lineage: {
      noteSpawn: (id, _p, _m, _s, _l, role) => { if (role === 'capcom') roles.push(id); },
      demote: (id) => { demoted.push(id); order.push('demote'); },
      bind: () => { /* quiet */ },
    },
    alive: o.alive ?? (() => true),
    note: (_l, text) => { noted.push(text); },
    now: o.now,
    trust: false,
    tmux: {
      available: () => true,
      spawn: async (p) => { panes.push({ name: p.name, argv: p.argv }); order.push('spawn'); return { ok: true, stdout: '', detail: '' }; },
      kill: async (name) => { killed.push(name); order.push('kill'); return { ok: true, stdout: '', detail: '' }; },
    },
    rotated: (info) => { rotated.push({ fromId: info.fromId, turns: info.turns, compactions: info.compactions }); order.push('notify'); },
  });
  return { session, panes, killed, demoted, roles, noted, rotated, order };
}

async function withHub<T>(fn: (hub: Hub) => Promise<T>): Promise<T> {
  const dir = tempDir();
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    store: new HubStore({ dir }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
    fleets: new FleetStore(join(dir, 'fleets')),
  });
  try { return await fn(hub); } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A collector socket for machine m1 that records every `say` the hub routes to it and acks it. */
async function fakeCollector(hub: Hub): Promise<{ ws: WebSocket; says: { agentId: string; text: string }[] }> {
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
  const says: { agentId: string; text: string }[] = [];
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString()) as { t: string; id: string; cmd?: Command };
    if (f.t !== 'cmd' || !f.cmd) return;
    if (f.cmd.k === 'say') says.push({ agentId: f.cmd.agentId, text: f.cmd.text });
    ws.send(JSON.stringify({ t: 'ack', cmdId: f.id, ok: true }));
  });
  return { ws, says };
}

/* ── the policy ───────────────────────────────────────────────────── */

const tests = [
  test('under the threshold nothing rotates, however idle the session is', () => {
    const v = rotationVerdict(observation({ compactions: 1, turns: 299 }), ROTATION_DEFAULTS, NOW);
    return ok('under the threshold nothing rotates', !v.rotate && !v.due, v.reason);
  }),

  test('over the threshold it rotates only when idle: not mid-turn, not blocked, not with a question pending', () => {
    const over = { compactions: 2 };
    const idle = rotationVerdict(observation(over), ROTATION_DEFAULTS, NOW);
    const thinking = rotationVerdict(observation({ ...over, state: 'thinking' }), ROTATION_DEFAULTS, NOW);
    const working = rotationVerdict(observation({ ...over, state: 'working' }), ROTATION_DEFAULTS, NOW);
    const blocked = rotationVerdict(observation({ ...over, state: 'blocked' }), ROTATION_DEFAULTS, NOW);
    const pending = rotationVerdict(observation({ ...over, pendingEscalations: 1 }), ROTATION_DEFAULTS, NOW);
    const justDelivered = rotationVerdict(observation({ ...over, lastDeliveryAt: NOW - 5_000 }), ROTATION_DEFAULTS, NOW);
    const justActive = rotationVerdict(observation({ ...over, lastActivityAt: NOW - 5_000 }), ROTATION_DEFAULTS, NOW);
    const held = [thinking, working, blocked, pending, justDelivered, justActive];
    return ok(
      'over the threshold it rotates only when idle',
      idle.rotate && idle.due
      && held.every((v) => !v.rotate && v.due)
      && thinking.reason.includes('thinking') && pending.reason.includes('escalation') && justDelivered.reason.includes('quiet only'),
      `idle: ${idle.reason} · held: ${held.map((v) => v.reason.split(', but ')[1]).join(' / ')}`,
    );
  }),

  test('compactions are the primary signal; turns are the safety net; 0 disables either', () => {
    const byTurns = rotationVerdict(observation({ compactions: 0, turns: 300 }), ROTATION_DEFAULTS, NOW);
    const turnsOff = rotationVerdict(observation({ compactions: 0, turns: 9_999 }), { ...ROTATION_DEFAULTS, maxTurns: 0 }, NOW);
    const compactionsOff = rotationVerdict(observation({ compactions: 50 }), { ...ROTATION_DEFAULTS, maxCompactions: 0 }, NOW);
    const allOff = rotationVerdict(observation({ compactions: 50, turns: 9_999 }), { maxCompactions: 0, maxTurns: 0, idleMs: 0 }, NOW);
    return ok(
      'compactions first, turns as the net, 0 disables',
      byTurns.rotate && byTurns.reason.includes('turns')
      && !turnsOff.due && !compactionsOff.due && !allOff.due,
      byTurns.reason,
    );
  }),

  test('the thresholds come from the environment, with sensible defaults and junk ignored', () => {
    const defaults = rotationConfig({});
    const custom = rotationConfig({ ORCA_CAPCOM_MAX_COMPACTIONS: '4', ORCA_CAPCOM_MAX_TURNS: '0', ORCA_CAPCOM_ROTATE_IDLE_MS: '5000' });
    const junk = rotationConfig({ ORCA_CAPCOM_MAX_COMPACTIONS: 'lots', ORCA_CAPCOM_MAX_TURNS: '-3', ORCA_CAPCOM_ROTATE_IDLE_MS: '' });
    return ok(
      'the thresholds come from the environment',
      defaults.maxCompactions === 2 && defaults.maxTurns === 300 && defaults.idleMs === 30_000
      && custom.maxCompactions === 4 && custom.maxTurns === 0 && custom.idleMs === 5000
      && junk.maxCompactions === 2 && junk.maxTurns === 300 && junk.idleMs === 30_000,
      JSON.stringify(custom),
    );
  }),

  /* ── the signal, off the transcript ─────────────────────────────── */

  test('the deriver counts compactions off the transcript and knows the context size', () => {
    const ref: TranscriptRef = {
      path: '/tmp/x.jsonl', slug: '-tmp-proj', sessionId: 'cafe0000-0000-4000-8000-000000000001',
      agentId: null, metaPath: null, workflowId: null, key: 'cafe0000-0000-4000-8000-000000000001',
    };
    const d = new SessionDeriver(ref, 'm1', 'p1', NOW);
    const ts = (ms: number) => new Date(ms).toISOString();
    d.ingest({
      ref, bootstrap: false, mtimeMs: NOW, at: NOW,
      lines: [
        { type: 'user', timestamp: ts(NOW - 5000), uuid: 'u1', message: { role: 'user', content: 'hello' } },
        { type: 'assistant', timestamp: ts(NOW - 4000), uuid: 'a1', message: {
          role: 'assistant', model: 'x', stop_reason: 'end_turn',
          usage: { input_tokens: 2, cache_creation_input_tokens: 11_363, cache_read_input_tokens: 27_960, output_tokens: 342 },
          content: [{ type: 'text', text: 'hi' }],
        } },
        // A real CLI writes the boundary AND the summary: that is one compaction.
        { type: 'system', subtype: 'compact_boundary', timestamp: ts(NOW - 3000), uuid: 's1', content: 'Conversation compacted',
          compactMetadata: { trigger: 'auto', preTokens: 970_585, postTokens: 10_543 } },
        { type: 'user', timestamp: ts(NOW - 2900), uuid: 'u2', isCompactSummary: true,
          message: { role: 'user', content: 'This session is being continued from a previous conversation…' } },
        { type: 'system', subtype: 'compact_boundary', timestamp: ts(NOW - 1000), uuid: 's2', content: 'Conversation compacted' },
        { type: 'user', timestamp: ts(NOW - 900), uuid: 'u3', isCompactSummary: true,
          message: { role: 'user', content: 'This session is being continued…' } },
      ],
    });
    const m = d.metrics(NOW);
    return ok(
      'the deriver counts compactions and knows the context size',
      m.compactions === 2 && m.contextTokens === 39_325,
      `${m.compactions} compactions · ${m.contextTokens} context tokens · ${m.turns} turns`,
    );
  }),

  /* ── the hand-over ──────────────────────────────────────────────── */

  test('rotating a hosted CAPCOM tells the hub first, kills the pane, and starts a fresh one with the rotated prompt', async () => {
    const dir = tempDir();
    try {
      const s = hostedSession(dir);
      const first = await s.session.ensure();
      const out = await s.session.rotate({ turns: 120, compactions: 2, contextTokens: 150_000 });
      const before = first.shortId ?? '';
      const after = out.shortId ?? '';
      const newPane = s.panes[1];
      return ok(
        'rotating a hosted CAPCOM hands over cleanly',
        out.ok && after !== '' && after !== before
        && s.order.join(' ') === 'spawn notify kill demote spawn'
        && s.rotated[0]?.fromId === before && s.rotated[0].turns === 120 && s.rotated[0].compactions === 2
        && s.killed[0] === `orca-${before}` && s.demoted[0] === before
        && newPane?.name === `orca-${after}` && newPane.argv[newPane.argv.length - 1] === CAPCOM_ROTATED_PROMPT
        && !newPane.argv.includes('--resume') && !newPane.argv.includes(CAPCOM_FIRST_PROMPT)
        && s.session.owns(after) && !s.session.owns(before)
        && s.roles.join(' ') === `${before} ${after}`
        && s.noted.some((n) => n.includes('CAPCOM rotado') && n.includes('120 turnos, 2 compactaciones')),
        `${before.slice(0, 8)} → ${after.slice(0, 8)} · ${s.order.join(' ')}`,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('rotations do not count against the relaunch cap: a real death is still answered after five of them', async () => {
    const dir = tempDir();
    try {
      let now = 1_000_000;
      let alive = true;
      const s = hostedSession(dir, { alive: () => alive, now: () => now });
      await s.session.ensure();
      for (let i = 0; i < 5; i++) {
        const out = await s.session.rotate({ turns: 10, compactions: 2, contextTokens: 1 });
        if (!out.ok) return ok('rotations do not count against the cap', false, `rotation ${i + 1} refused: ${out.detail}`);
        now += 60_000;
      }
      // Now it dies for real. Past the grace window it is declared dead…
      alive = false;
      now += CAPCOM_GRACE_MS + 1_000;
      s.session.check();
      const declared = s.session.current() === null;
      // …and past the restart delay it is relaunched, because the cap counts deaths, not policy.
      now += CAPCOM_RESTART_MS + 1_000;
      s.session.check();
      const relaunched = await until(() => s.panes.length === 7, 2000);
      return ok(
        'rotations do not count against the relaunch cap',
        declared && relaunched && !s.noted.some((n) => n.includes('dejo de relanzarlo')),
        `${s.panes.length} panes spawned in all`,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('a --bg CAPCOM rotates with `claude stop` and a fresh --bg launch, never a resume', async () => {
    const dir = tempDir();
    try {
      const ran: string[][] = [];
      let n = 0;
      const rotated: string[] = [];
      const session = new CapcomSession({
        bin: '/fake/claude', hubUrl: 'ws://127.0.0.1:4479', token: 't', dir,
        lineage: { demote: () => { /* quiet */ }, bind: () => { /* quiet */ }, noteSpawn: () => { /* noted */ } },
        alive: () => true,
        note: () => { /* quiet */ },
        agentIdOf: (id) => `agent-of-${id}`,
        rotated: (info) => { rotated.push(info.fromId); },
        launch: async (_bin, args) => {
          ran.push(args);
          n += 1;
          return { ok: true, stdout: args[0] === 'stop' ? 'stopped\n' : `started aaaa000${n}\n`, detail: '' };
        },
      });
      await session.ensure();
      const out = await session.rotate({ turns: 301, compactions: 0, contextTokens: 1 });
      const stop = ran[1];
      const relaunch = ran[2];
      return ok(
        'a --bg CAPCOM rotates with stop and a fresh launch',
        out.ok && out.shortId === 'aaaa0003'
        && stop?.join(' ') === 'stop aaaa0001'
        && relaunch?.[0] === '--bg' && relaunch[relaunch.length - 1] === CAPCOM_ROTATED_PROMPT && !relaunch.includes('--resume')
        && rotated[0] === 'agent-of-aaaa0001'
        && session.owns('aaaa0003') && !session.owns('aaaa0001'),
        ran.map((a) => a.slice(0, 2).join(' ')).join(' | '),
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  /* ── the hub's window ───────────────────────────────────────────── */

  test('while a rotation is in progress the router holds mail, ignores the retiring session, and delivers to the new one', () => {
    const clock = fakeClock();
    const old = agent({ id: 'cap_old', callsign: 'C1', role: 'capcom', startedAt: 1 });
    const fresh = agent({ id: 'cap_new', callsign: 'C2', role: 'capcom', startedAt: 2 });
    let world: Agent[] = [old];
    const said: { to: string; text: string }[] = [];
    const notes: string[] = [];
    const router = new CapcomRouter({
      capcom: () => world.find((a) => a.role === 'capcom' && a.state !== 'dead') ?? null,
      say: (to, text) => { said.push({ to, text }); },
      escalation: () => undefined,
      markWithCeo: () => { /* none */ },
      giveUp: () => { /* none */ },
      note: (t) => { notes.push(t); },
      setTimer: clock.setTimer,
    });
    const before = router.humanSays('before');
    router.rotating('cap_old');
    // The old one is still listed as alive for a moment: it must not be a target.
    const hidden = router.live() === null;
    const q1 = router.humanSays('first while rotating');
    const q2 = router.humanSays('second while rotating');
    const queued = router.queued();
    const nothingYet = router.flush() === 0;
    world = [{ ...old, state: 'dead' }, fresh];
    const delivered = router.flush();
    const afterwards = router.humanSays('after');
    return ok(
      'the router holds mail across a rotation',
      before === 'delivered' && hidden && q1 === 'queued' && q2 === 'queued' && queued === 2 && nothingYet
      && delivered === 2 && !router.inRotation() && router.queued() === 0
      && said.map((s) => `${s.to}:${s.text}`).join(' | ') === 'cap_old:before | cap_new:first while rotating | cap_new:second while rotating | cap_new:after'
      && afterwards === 'delivered' && notes.some((n) => n.includes('CAPCOM de vuelta')),
      said.map((s) => s.to).join(' → '),
    );
  }),

  test('if the new CAPCOM never shows, the hold expires, the mail is dropped with a reason, and the router declines again', () => {
    const clock = fakeClock();
    const dropped: string[] = [];
    const router = new CapcomRouter({
      capcom: () => null,
      say: () => { throw new Error('nothing should be delivered'); },
      escalation: () => undefined,
      markWithCeo: () => { /* none */ },
      giveUp: () => { /* none */ },
      setTimer: clock.setTimer,
    });
    router.rotating('cap_old', 60_000);
    const queued = router.humanSays('lost?', undefined, (reason) => { dropped.push(reason); });
    clock.advance(59_000);
    const stillHeld = router.inRotation() && dropped.length === 0;
    clock.advance(2_000);
    const declined = router.humanSays('now?');
    return ok(
      'an expired hold drops the mail with a reason',
      queued === 'queued' && stillHeld && !router.inRotation() && dropped.length === 1
      && dropped[0]!.includes('did not come back') && declined === false,
      dropped[0] ?? 'nothing dropped',
    );
  }),

  test('against a live hub: the feed records the rotation, and what the operator types in the window reaches the new CAPCOM', async () => {
    return await withHub(async (hub) => {
      const { ws, says } = await fakeCollector(hub);
      const console1 = new WebSocket(`ws://127.0.0.1:${hub.port}${PATHS.console}?token=${TOKEN}`);
      await new Promise<void>((res, rej) => { console1.once('open', () => res()); console1.once('error', rej); });
      const receipts: { cmdId: string; ok: boolean; detail?: string }[] = [];
      const systemLines: string[] = [];
      console1.on('message', (raw) => {
        const f = JSON.parse(raw.toString()) as { t: string; cmdId?: string; ok?: boolean; detail?: string; message?: { role: string; text: string } };
        if (f.t === 'ack' && f.cmdId) receipts.push({ cmdId: f.cmdId, ok: f.ok === true, detail: f.detail });
        if (f.t === 'ceo:message' && f.message?.role === 'system') systemLines.push(f.message.text);
      });
      try {
        // A CAPCOM is up; the operator can talk to it.
        ws.send(JSON.stringify({ t: 'agent:new', machineId: 'm1', agent: agent({ id: 'cap1', callsign: 'C1', role: 'capcom', startedAt: 1_000 }) }));
        await until(() => Boolean(hub.world.state.agents['cap1']), 2000);
        console1.send(JSON.stringify({ t: 'ceo:say', id: 'r0', text: 'before rotation' }));
        await until(() => says.length === 1, 2000);

        // The collector announces the rotation. The old session is still listed.
        ws.send(JSON.stringify({ t: 'capcom:rotated', machineId: 'm1', fromId: 'cap1', turns: 120, compactions: 2, contextTokens: 150_000 }));
        const logged = await until(() => hub.world.state.feed.some((f) => f.text === 'CAPCOM rotado: 120 turnos, 2 compactaciones, 150k tokens de contexto'), 2000);

        // What the operator types now is held, with a receipt saying so — not refused.
        console1.send(JSON.stringify({ t: 'ceo:say', id: 'r1', text: 'typed during rotation' }));
        const held = await until(() => receipts.some((r) => r.cmdId === 'r1'), 2000);
        const receipt = receipts.find((r) => r.cmdId === 'r1');
        // And so is a task prompt.
        console1.send(JSON.stringify({ t: 'task:create', id: 'c1', taskId: 'task_rot', title: 'New task' }));
        await until(() => receipts.some((r) => r.cmdId === 'c1'), 2000);
        console1.send(JSON.stringify({ t: 'ceo:say', id: 'r2', taskId: 'task_rot', text: 'task line during rotation' }));
        await until(() => receipts.some((r) => r.cmdId === 'r2'), 2000);
        const taskReceipt = receipts.find((r) => r.cmdId === 'r2');
        const nothingSaid = says.length === 1;

        // The new session shows up. Everything held goes to it, in order.
        ws.send(JSON.stringify({ t: 'agent', machineId: 'm1', id: 'cap1', patch: { state: 'dead' } }));
        ws.send(JSON.stringify({ t: 'agent:new', machineId: 'm1', agent: agent({ id: 'cap2', callsign: 'C2', role: 'capcom', startedAt: 2_000 }) }));
        const flushed = await until(() => says.length === 3, 3000);
        const toNew = says.slice(1).every((s) => s.agentId === 'cap2');
        const inOrder = says[1]?.text === 'typed during rotation' && (says[2]?.text.includes('task line during rotation') ?? false);
        const back = hub.world.state.feed.some((f) => f.text.includes('CAPCOM de vuelta'));

        return ok(
          'against a live hub the rotation is invisible to the operator',
          logged && held && receipt?.ok === true && receipt.detail === 'CAPCOM rotating: queued'
          && taskReceipt?.ok === true && nothingSaid
          && flushed && toNew && inOrder && back
          && !systemLines.some((t) => t.includes('No hay CAPCOM')),
          `${says.length} say(s): ${says.map((s) => s.agentId).join(', ')}`,
        );
      } finally { console1.close(); ws.close(); }
    });
  }),
];

const suite: TestModule = { suite: 'CAPCOM rotation · policy · hand-over · the hub\'s window', tests };
export default suite;
