/**
 * `orca` — the operator's CLI, end to end.
 *
 * It is a thin wrapper over `POST /mcp`, so what is worth proving is the
 * wrapping: that a project typed as a code lands on the right id, that a brief
 * given as `@file` is read, that a squad launched from a shell appears on the
 * hub with its lead, and that the three exit codes mean what the help says —
 * a script that cannot tell "hub down" from "no such agent" cannot retry the
 * right one.
 *
 * Runs the real binary with `node`, against a real hub and the fake fleet, in
 * temporary directories. No ~/.orca is read: the token is passed explicitly.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createAuth } from '../src/hub/auth.ts';
import { FleetStore } from '../src/hub/fleets.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { HubStore } from '../src/hub/persist.ts';
import { startHub, type Hub } from '../src/hub/server.ts';
import { squadsOf } from '../src/shared/squads.ts';
import { startFakeFleet } from './fake-collector.ts';
import { ok, test, until, type TestModule } from './harness.ts';

const TOKEN = 'test-token-cli-000';
const BIN = resolve(import.meta.dirname, '..', 'bin', 'orca.mjs');

interface Run { code: number; stdout: string; stderr: string; json: Record<string, unknown> | null }

/**
 * Run the CLI against a hub. Never throws: the exit code is the result.
 *
 * Asynchronous on purpose: the hub the CLI talks to lives in THIS process, and
 * an `execFileSync` would block the event loop it needs to answer — a deadlock
 * that looks exactly like a hung CLI.
 */
function orca(port: number, args: string[], token: string | null = TOKEN): Promise<Run> {
  const argv = [BIN, ...args, '--hub', `http://127.0.0.1:${port}`, ...(token ? ['--token', token] : [])];
  return new Promise((done) => {
    execFile('node', argv, {
      encoding: 'utf8', timeout: 20_000,
      // No ~/.orca/token must leak in when the test passes no token.
      env: { ...process.env, ORCA_TOKEN: '', ORCA_HOME: join(tmpdir(), 'orca-cli-nohome') },
    }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number | string }).code as number | undefined ?? -1) : 0;
      done({ code: typeof code === 'number' ? code : -1, stdout, stderr, json: parse(stdout) });
    });
  });
}

function parse(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
}

async function withFleet<T>(fn: (hub: Hub, projectCode: string, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cli-'));
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    store: new HubStore({ dir: join(dir, 'hub') }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
    fleets: new FleetStore(join(dir, 'fleets')),
  });
  const fleet = startFakeFleet({ hub: `ws://127.0.0.1:${hub.port}`, token: TOKEN, quiet: true, speed: 6 });
  try {
    const ready = await until(() => Object.keys(hub.world.state.projects).length > 0, 8000, 50);
    if (!ready) throw new Error('the fake fleet never reported a project');
    const code = Object.values(hub.world.state.projects)[0]!.code;
    return await fn(hub, code, dir);
  } finally {
    fleet.stop();
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const tests = [
  test('orca ls --json surveys the fleet, and the plain form prints a line per project', async () => {
    return await withFleet(async (hub) => {
      const j = await orca(hub.port, ['ls', '--json']);
      const result = (j.json?.['result'] ?? {}) as { projects?: unknown[] };
      const plain = await orca(hub.port, ['ls']);
      return ok(
        'orca ls surveys the fleet',
        j.code === 0 && Array.isArray(result.projects) && result.projects.length > 0
          && plain.code === 0 && plain.stdout.split('\n').length >= result.projects.length,
        `${result.projects?.length ?? 0} projects · ${plain.stdout.split('\n')[0]?.slice(0, 60)}`,
      );
    });
  }),

  test('a wrong token is exit 2 and says so; a hub that is not there is exit 2 too', async () => {
    return await withFleet(async (hub) => {
      const bad = await orca(hub.port, ['ls'], 'not-the-token');
      const none = await orca(1, ['ls']);
      return ok(
        'hub problems are exit 2',
        bad.code === 2 && bad.stderr.includes('token') && none.code === 2 && none.stderr.includes('cannot reach'),
        `${bad.code}: ${bad.stderr.trim().slice(0, 50)} · ${none.code}: ${none.stderr.trim().slice(0, 40)}`,
      );
    });
  }),

  test('a tool that says no is exit 3, distinct from a hub that is down', async () => {
    return await withFleet(async (hub) => {
      const r = await orca(hub.port, ['inspect', 'ZZ99']);
      const rj = await orca(hub.port, ['inspect', 'ZZ99', '--json']);
      return ok(
        'a tool that says no is exit 3',
        r.code === 3 && r.stderr.includes('ZZ99') && rj.code === 3 && rj.json?.['ok'] === false,
        r.stderr.trim(),
      );
    });
  }),

  test('orca launch <preset> --project <code> puts the seed squad on the field', async () => {
    return await withFleet(async (hub, code) => {
      const r = await orca(hub.port, ['launch', 'audit', '--project', code, '--json']);
      const result = (r.json?.['result'] ?? {}) as { squad?: string; lead?: { agent_id: string | null } };
      const name = result.squad ?? '';
      const arrived = await until(() =>
        (squadsOf(hub.world.state.agents).find((s) => s.name === name)?.memberIds.length ?? 0) === 3, 8000, 50);
      const sq = squadsOf(hub.world.state.agents).find((s) => s.name === name);
      return ok(
        'orca launch puts the seed squad on the field',
        r.code === 0 && /^audit-\d\d$/.test(name) && arrived && sq?.leaderId === result.lead?.agent_id,
        `${name}: ${sq?.memberIds.length ?? 0} on the field, lead ${sq?.leaderId ?? '(none)'}`,
      );
    });
  }),

  test('orca squad reads @file briefs, resolves the project by code, and hangs members off the lead', async () => {
    return await withFleet(async (hub, code, dir) => {
      const leadFile = join(dir, 'lead.md');
      const memberFile = join(dir, 'member.md');
      writeFileSync(leadFile, 'Lead the payments migration: split the work below and consolidate one report with a risk per finding.\n');
      writeFileSync(memberFile, 'Migrate the charges table to the new schema without changing the public API; report every row you could not move.\n');
      const r = await orca(hub.port, [
        'squad', 'payments', '--project', code,
        '--lead', `@${leadFile}`,
        '--member', `@${memberFile}`,
        '--member', 'Audit the sandbox endpoints for the 402 regression and report which cards trip it.',
        '--json',
      ]);
      const result = (r.json?.['result'] ?? {}) as { squad?: string; lead?: { agent_id: string | null }; members?: unknown[] };
      const name = result.squad ?? '';
      await until(() =>
        (squadsOf(hub.world.state.agents).find((s) => s.name === name)?.memberIds.length ?? 0) === 3, 8000, 50);
      const sq = squadsOf(hub.world.state.agents).find((s) => s.name === name);
      const lead = sq?.leaderId ? hub.world.state.agents[sq.leaderId] : undefined;
      const parented = sq?.memberIds.filter((id) => id !== sq.leaderId)
        .every((id) => hub.world.state.agents[id]?.parentId === sq.leaderId) ?? false;
      return ok(
        'orca squad reads @file briefs and hangs members off the lead',
        r.code === 0 && name === 'payments-01' && result.members?.length === 2 && parented
          && (lead?.lastPrompt ?? '').startsWith('Lead the payments migration'),
        `${name}: lead ${lead?.callsign ?? '(none)'}, ${sq?.memberIds.length ?? 0} on the field`,
      );
    });
  }),

  test('a project typed as a code that nobody reports is exit 1 with the known ones listed', async () => {
    return await withFleet(async (hub, code) => {
      const r = await orca(hub.port, ['spawn', 'ZZ', 'A brief long enough to be taken seriously by the spawn tool.']);
      return ok(
        'an unknown project code is exit 1, naming the known ones',
        r.code === 1 && r.stderr.includes('no project "ZZ"') && r.stderr.includes(code),
        r.stderr.trim().slice(0, 100),
      );
    });
  }),

  test('orca tell --to squad:<name> and orca stop squad:<name> drive a squad from a shell', async () => {
    return await withFleet(async (hub, code) => {
      const launched = await orca(hub.port, ['launch', 'ship', '--project', code, '--json']);
      const name = String(((launched.json?.['result'] ?? {}) as { squad?: string }).squad ?? '');
      await until(() =>
        (squadsOf(hub.world.state.agents).find((s) => s.name === name)?.memberIds.length ?? 0) === 2, 8000, 50);
      const told = await orca(hub.port, ['tell', 'Report by 18:00, one line each', '--to', `squad:${name}`, '--kind', 'handoff', '--json']);
      const delivered = ((told.json?.['result'] ?? {}) as { delivered_to?: string[] }).delivered_to ?? [];
      const stopped = await orca(hub.port, ['stop', `squad:${name}`, '--reason', 'test over', '--json']);
      const stoppedList = ((stopped.json?.['result'] ?? {}) as { stopped?: string[] }).stopped ?? [];
      return ok(
        'orca tell and orca stop drive a squad from a shell',
        told.code === 0 && delivered.length === 2 && stopped.code === 0 && stoppedList.length === 2,
        `${name}: told ${delivered.length}, stopped ${stoppedList.join(' → ')}`,
      );
    });
  }),

  test('orca archive is a dry run by flag, takes ages like 24h, and refuses a bad state', async () => {
    return await withFleet(async (hub, code) => {
      // Contar agentes no sirve para comprobar que no se tocó nada: la flota sigue
      // arrancando y puede registrar uno por su cuenta en esa ventana. Lo que un
      // dry run no puede hacer es quitar a ninguno de los que ya estaban.
      const before = new Set(Object.keys(hub.world.state.agents));
      const dry = await orca(hub.port, ['archive', '--project', code, '--older-than', '24h', '--dry-run', '--json']);
      const r = (dry.json?.['result'] ?? {}) as { dry_run?: boolean; count?: number; archived?: unknown[] };
      const gone = [...before].filter((id) => !(id in hub.world.state.agents));
      const bad = await orca(hub.port, ['archive', '--state', 'working']);
      return ok(
        'orca archive --dry-run counts without touching, and --state is checked before the hub is asked',
        dry.code === 0 && dry.json?.['ok'] === true && r.dry_run === true && r.count === (r.archived?.length ?? -1)
          && gone.length === 0
          && bad.code === 1 && bad.stderr.includes('--state is done or dead'),
        `dry run: ${r.count ?? '?'} would go (exit ${dry.code}); ninguno de los ${before.size} previos desapareció${gone.length ? ` (se fueron ${gone.length})` : ''}; bad state exit ${bad.code}`,
      );
    });
  }),

  test('orca fleets lists the presets and orca tools lists every verb', async () => {
    return await withFleet(async (hub) => {
      const f = await orca(hub.port, ['fleets']);
      const t = await orca(hub.port, ['tools', '--json']);
      const names = Array.isArray(t.json) ? (t.json as { name: string }[]).map((x) => x.name) : [];
      return ok(
        'orca fleets and orca tools',
        f.code === 0 && f.stdout.includes('audit') && f.stdout.includes('ship')
          && t.code === 0 && names.includes('launch_squad') && names.includes('stop_squad'),
        `${names.length} tools`,
      );
    });
  }),
];

const suite: TestModule = { suite: 'cli · orca from a shell', tests };
export default suite;
