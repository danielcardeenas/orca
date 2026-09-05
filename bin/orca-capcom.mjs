#!/usr/bin/env node
/**
 * orca-capcom — start the collector that carries the fleet's command session.
 *
 * CAPCOM is a Claude Code session, not a process this script owns: the
 * collector launches it in ~/.orca/capcom, keeps it alive, and reports it to
 * the hub with `role: 'capcom'`. So this is a one-line wrapper around the thing
 * that actually does the work, and it exists because
 *
 *     npx tsx src/collector/index.ts --capcom
 *
 * is not a command anybody remembers at three in the morning.
 *
 *   orca-capcom                 collector + CAPCOM on this machine
 *   orca-capcom --dir PATH      keep the session somewhere else
 *   orca-capcom --hub URL       hub to dial (default ws://127.0.0.1:4479)
 *   orca-capcom --token TOKEN   the hub's token
 *
 * ONE machine in the fleet should run this. The hub delivers what you type to
 * the session with `role: 'capcom'`, and two of them would be two minds
 * triaging the same question — with the console unable to say whose transcript
 * is the command window. Every other machine runs the plain collector.
 *
 * Everything it accepts is also an environment variable, because that is how a
 * daemon is configured: ORCA_CAPCOM_DIR, ORCA_HUB_URL, ORCA_TOKEN.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ENTRY = resolve(ROOT, 'src', 'collector', 'index.ts');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (flag('help') || flag('h')) {
  console.log(`orca-capcom — run the collector that carries CAPCOM

  orca-capcom                 collector + CAPCOM on this machine
  orca-capcom --dir PATH      where the session lives   (ORCA_CAPCOM_DIR)
  orca-capcom --hub URL       hub to dial               (ORCA_HUB_URL)
  orca-capcom --token TOKEN   the hub's token           (ORCA_TOKEN)

CAPCOM is the one voice that speaks to the fleet on your behalf: it surveys,
spawns agents with real briefs, unblocks them, and absorbs the questions they
raise. It is a Claude Code session on your subscription and its tools are the
hub's MCP server, so commanding a fleet costs no API spend.

Run this on ONE machine. Every other machine runs the plain collector:
  npx tsx src/collector/index.ts`);
  process.exit(0);
}

const env = { ...process.env, ORCA_CAPCOM: '1' };
const dir = value('dir');
const hub = value('hub');
const token = value('token');
if (dir) env.ORCA_CAPCOM_DIR = resolve(dir);
if (hub) env.ORCA_HUB_URL = hub;
if (token) env.ORCA_TOKEN = token;

// tsx from this repo's node_modules: `orca-capcom` may well be a symlink on a
// PATH that has no tsx of its own.
const runner = resolve(ROOT, 'node_modules', '.bin', 'tsx');

const child = spawn(runner, [ENTRY, '--capcom'], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  shell: false,
});

child.on('error', (err) => {
  console.error(`orca-capcom: could not start the collector: ${err.message}`);
  console.error(`  expected tsx at ${runner} — run \`npm install\` in ${ROOT}`);
  process.exit(1);
});
child.on('close', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
}
