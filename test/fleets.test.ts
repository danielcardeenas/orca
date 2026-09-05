/**
 * Fleet presets: one list, on the hub's disk, read by the console and CAPCOM.
 *
 * What is worth proving:
 *
 *  1. The seed is written once, and a deleted preset stays deleted.
 *  2. `PUT /api/fleets` makes the directory hold exactly the list sent — that
 *     is how the JSON editor deletes anything — and refuses a half-valid list
 *     whole, because a preset that half-parses spawns half a fleet.
 *  3. A broken file is reported, not fatal.
 *  4. `POST /api/squads/next` numbers from the same counter `launch_squad`
 *     uses, so a browser launch and a CAPCOM launch never share a label.
 *
 * Every directory here is temporary. Nothing touches ~/.orca.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAuth } from '../src/hub/auth.ts';
import { FleetStore, presetFile } from '../src/hub/fleets.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { HubStore } from '../src/hub/persist.ts';
import { startHub, type Hub } from '../src/hub/server.ts';
import { hubContext } from '../src/agents/context.ts';
import { parsePresets, SEED_PRESETS, squadStem, type Preset } from '../src/shared/fleets.ts';
import { ok, eq, test, type TestModule } from './harness.ts';

const TOKEN = 'test-token-fleets-000';

function tempDir(): string { return mkdtempSync(join(tmpdir(), 'orca-fleets-')); }

async function withHub<T>(fn: (hub: Hub, dir: string) => Promise<T>): Promise<T> {
  const dir = tempDir();
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    store: new HubStore({ dir: join(dir, 'hub') }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
    fleets: new FleetStore(join(dir, 'fleets')),
  });
  try { return await fn(hub, dir); } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function call(port: number, path: string, init: RequestInit = {}, token: string | null = TOKEN) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try { body = text ? JSON.parse(text) as Record<string, unknown> : null; } catch { body = null; }
  return { status: res.status, body };
}

const ONE: Preset = {
  name: 'nightly',
  project: 'AX',
  agents: [
    { lead: true, mission: 'Lead the nightly pass.', prompt: 'Run everything and consolidate.' },
    { mission: 'Check the lockfile.', prompt: 'Audit the lockfile and report.' },
  ],
};

const tests = [
  test('the seed is written once, and a deleted preset stays deleted', () => {
    const dir = tempDir();
    try {
      const store = new FleetStore(join(dir, 'fleets'));
      const first = store.list();
      store.replaceAll(first.filter((p) => p.name !== 'ship'));
      const second = store.list();
      const files = readdirSync(join(dir, 'fleets'));
      return ok(
        'the seed is written once, and a deleted preset stays deleted',
        first.length === SEED_PRESETS.length && second.length === SEED_PRESETS.length - 1
          && !second.some((p) => p.name === 'ship') && !files.includes(presetFile('ship')),
        `${first.map((p) => p.name).join(',')} → ${second.map((p) => p.name).join(',')}`,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('a broken file is reported, and the rest still load', () => {
    const dir = tempDir();
    try {
      const store = new FleetStore(join(dir, 'fleets'));
      store.list();
      writeFileSync(join(dir, 'fleets', 'oops.json'), '{"name":"oops","agents":[]}');
      writeFileSync(join(dir, 'fleets', 'junk.json'), 'not json');
      const { presets, broken } = store.read();
      return ok(
        'a broken file is reported, and the rest still load',
        presets.length === SEED_PRESETS.length && broken.length === 2
          && broken.some((b) => b.file === 'oops.json' && b.why.includes('NO AGENTS'))
          && broken.some((b) => b.file === 'junk.json' && b.why.startsWith('NOT JSON')),
        broken.map((b) => `${b.file}: ${b.why}`).join(' · '),
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('parsePresets refuses a half-valid list whole, and two leaders, and a duplicate name', () => {
    const twoLeads = parsePresets(JSON.stringify([{ ...ONE, agents: ONE.agents.map((a) => ({ ...a, lead: true })) }]));
    const dup = parsePresets(JSON.stringify([ONE, { ...ONE, name: 'Nightly' }]));
    const half = parsePresets(JSON.stringify([ONE, { name: 'x', agents: [{ mission: 'm' }] }]));
    const good = parsePresets(JSON.stringify([ONE]));
    return ok(
      'parsePresets refuses what would half-launch',
      typeof twoLeads === 'string' && twoLeads.includes('ONLY ONE')
        && typeof dup === 'string' && dup.includes('TWICE')
        && typeof half === 'string' && half.includes('PROMPT')
        && Array.isArray(good) && good[0]?.agents.length === 2,
      [twoLeads, dup, half].map(String).join(' · '),
    );
  }),

  test('squadStem makes a preset name into a base a suffix fits on', () => {
    const a = squadStem('Payments migration');
    const b = squadStem('  --Audit!! ');
    const c = squadStem('a'.repeat(50));
    return ok(
      'squadStem makes a base a suffix fits on',
      a === 'payments-migration' && b === 'audit' && c.length <= 29,
      `${a} · ${b} · ${c.length}`,
    );
  }),

  test('GET /api/fleets needs the token and answers the seed', async () => {
    return await withHub(async (hub) => {
      const noToken = await call(hub.port, '/api/fleets', {}, null);
      const { status, body } = await call(hub.port, '/api/fleets');
      const presets = (body?.['presets'] ?? []) as Preset[];
      return ok(
        'GET /api/fleets needs the token and answers the seed',
        noToken.status === 401 && status === 200 && presets.length === SEED_PRESETS.length
          && presets.some((p) => p.name === 'audit'),
        `${noToken.status} without, ${status} with · ${presets.map((p) => p.name).join(', ')}`,
      );
    });
  }),

  test('PUT /api/fleets makes the disk hold exactly the list, and CAPCOM sees it at once', async () => {
    return await withHub(async (hub) => {
      const { status, body } = await call(hub.port, '/api/fleets', { method: 'PUT', body: JSON.stringify([ONE]) });
      const after = (body?.['presets'] ?? []) as Preset[];
      const files = readdirSync(hub.fleets.dir);
      const seen = hubContext(hub).fleets();
      return ok(
        'PUT /api/fleets makes the disk hold exactly the list',
        status === 200 && after.length === 1 && after[0]?.name === 'nightly'
          && files.length === 1 && files[0] === presetFile('nightly')
          && seen.length === 1 && seen[0]?.project === 'AX',
        `files: ${files.join(', ')}`,
      );
    });
  }),

  test('PUT /api/fleets with a half-valid list changes nothing', async () => {
    return await withHub(async (hub) => {
      const before = hub.fleets.list().length;
      const { status, body } = await call(hub.port, '/api/fleets', {
        method: 'PUT', body: JSON.stringify([ONE, { name: 'bad', agents: [] }]),
      });
      const after = hub.fleets.list();
      return ok(
        'PUT /api/fleets with a half-valid list changes nothing',
        status === 400 && String(body?.['error'] ?? '').includes('NO AGENTS')
          && after.length === before && !after.some((p) => p.name === 'nightly'),
        String(body?.['error']),
      );
    });
  }),

  test('POST /api/squads/next numbers from the same counter launch_squad uses', async () => {
    return await withHub(async (hub) => {
      const a = await call(hub.port, '/api/squads/next?base=audit', { method: 'POST' });
      const fromTool = hubContext(hub).nextSquadName('audit');
      const b = await call(hub.port, '/api/squads/next?base=audit', { method: 'POST' });
      const bad = await call(hub.port, '/api/squads/next?base=not%20ok', { method: 'POST' });
      const get = await call(hub.port, '/api/squads/next?base=audit', { method: 'GET' });
      return ok(
        'POST /api/squads/next numbers from the same counter launch_squad uses',
        a.body?.['name'] === 'audit-01' && fromTool === 'audit-02' && b.body?.['name'] === 'audit-03'
          && bad.status === 400 && get.status === 405,
        `${String(a.body?.['name'])} · ${fromTool} · ${String(b.body?.['name'])}`,
      );
    });
  }),

  test('the preset name is the squad base CAPCOM and the console both number', () => {
    return eq('preset name → squad base', squadStem('audit'), 'audit');
  }),
];

const suite: TestModule = { suite: 'hub · fleet presets', tests };
export default suite;
