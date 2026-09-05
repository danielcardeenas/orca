#!/usr/bin/env node
/**
 * orca-spawn — ask ORCA for another pair of hands.
 *
 * Sibling of orca-tell. You have no socket to the fleet and no hub token; you
 * have a filesystem. So asking for an agent is writing a brief into
 * `<project>/.orca/spawn/` and reading the answer the collector drops next to
 * it: the new agent's callsign, so you can address it.
 *
 *   orca-spawn "Migrate the charges table to the new schema. Done when …"
 *   orca-spawn @briefs/charges.md
 *   orca-spawn "<brief>" --squad payments-01        # only if you are in no squad
 *   orca-spawn "<brief>" --model claude-sonnet-5
 *   orca-spawn "<brief>" --no-wait                  # file it and go on
 *
 * The child is YOURS: it is spawned as your child, in your squad if you are in
 * one, and it reports to you with orca-tell. It is never a lead. Give it a
 * complete brief — what to do, what done looks like, what not to touch — as
 * you would to an engineer who has not seen your conversation.
 *
 * Exit codes:
 *   0  launched (callsign on stdout), or filed with --no-wait
 *   1  bad usage
 *   2  ORCA is not running here
 *   3  timed out waiting for the collector
 *   4  refused — the ack says why (too many children, squad full, thin brief)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);

/* ── Arguments ────────────────────────────────────────────────────── */

function parse(args) {
  const out = {
    mission: '', squad: null, model: null, wait: true, timeoutSec: 90,
    project: null, agentId: process.env.CLAUDE_SESSION_ID ?? null, json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case '--squad': case '-s': out.squad = next() ?? null; break;
      case '--model': case '-m': out.model = next() ?? null; break;
      case '--no-wait': out.wait = false; break;
      case '--wait': case '-w': out.wait = true; break;
      case '--timeout': out.timeoutSec = Number(next() ?? 90); break;
      case '--project': case '-p': out.project = next() ?? null; break;
      case '--agent': out.agentId = next() ?? null; break;
      case '--json': out.json = true; break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default:
        if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); process.exit(1); }
        out.mission = out.mission ? `${out.mission} ${a}` : a;
    }
  }
  return out;
}

function usage() {
  console.log(`orca-spawn — ask ORCA to launch an agent that works for you

  orca-spawn "<brief>" [options]
  orca-spawn @<file>   [options]      the brief is in that file

  -s, --squad <name>      enlist it in a squad — only if you are in none;
                          in a squad, the child joins yours, always
  -m, --model <id>        model for the child (default: the runtime's)
      --no-wait           file the request and return at once
      --timeout <sec>     how long to wait for the collector (default: 90)
  -p, --project <path>    project root (default: git root, else cwd)
      --agent <id>        your session id, so the child is parented to you
      --json              machine-readable output

  Exit: 0 launched · 1 usage · 2 ORCA not running · 3 timed out · 4 refused

  The child is spawned as YOUR child, in your squad, and reports to you with
  orca-tell. Write the brief for an engineer who has not seen your conversation.
  You may have at most 8 live children; a squad holds at most 13 agents.`);
}

/* ── Where to write ───────────────────────────────────────────────── */

function projectRoot(explicit) {
  if (explicit) return resolve(explicit);
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
}

function orcaPresent() {
  const home = process.env.ORCA_HOME ?? join(process.env.HOME ?? '', '.orca');
  return existsSync(home);
}

/* ── Main ─────────────────────────────────────────────────────────── */

const opts = parse(argv);
let mission = opts.mission.trim();
if (mission.startsWith('@')) {
  const file = resolve(mission.slice(1));
  try { mission = readFileSync(file, 'utf8').trim(); }
  catch (err) { console.error(`orca-spawn: cannot read ${file}: ${err.message}`); process.exit(1); }
}
if (!mission) { usage(); process.exit(1); }
if (mission.length < 20) {
  console.error('orca-spawn: that brief is too thin. Say what to do, what done looks like, and what not to touch.');
  process.exit(1);
}
if (!orcaPresent()) {
  console.error('orca-spawn: ORCA is not running on this machine (no ~/.orca).');
  console.error('Do the work yourself, or say in your summary what you would have delegated.');
  process.exit(2);
}

const root = projectRoot(opts.project);
const dir = join(root, '.orca', 'spawn');
const id = `spawn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(dir, { recursive: true });

const payload = {
  mission,
  squad: opts.squad,
  model: opts.model,
  agentId: opts.agentId,
  at: Date.now(),
  cwd: process.cwd(),
};

// Temp name and rename: the collector watches this directory, and a
// half-written JSON would be parsed as garbage exactly once, at the worst time.
const finalPath = join(dir, `${id}.json`);
const ackPath = join(dir, `${id}.ack.json`);
const tmpPath = join(dir, `.${id}.tmp`);
writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
try {
  renameSync(tmpPath, finalPath);
} catch (err) {
  rmSync(tmpPath, { force: true });
  console.error('orca-spawn: could not file the request:', err.message);
  process.exit(2);
}

if (!opts.wait) {
  if (opts.json) console.log(JSON.stringify({ id, filed: true, ack: ackPath }));
  else console.log(`filed: ${id} — the ack arrives at .orca/spawn/${id}.ack.json`);
  process.exit(0);
}

/* ── Waiting ──────────────────────────────────────────────────────── */

const deadline = Date.now() + opts.timeoutSec * 1000;
let notified = false;
while (Date.now() < deadline) {
  const ack = readAck(ackPath);
  if (ack) {
    rmSync(ackPath, { force: true });
    if (!ack.ok) {
      if (opts.json) console.log(JSON.stringify(ack));
      else console.error(`orca-spawn: refused — ${ack.reason ?? 'no reason given'}`);
      process.exit(4);
    }
    if (opts.json) console.log(JSON.stringify(ack));
    else {
      const who = ack.callsign ?? '(callsign pending)';
      console.log(`launched ${who}${ack.squad ? ` in squad ${ack.squad}` : ''} — it reports to you with orca-tell; read orca-read each turn`);
      if (!ack.callsign) console.log('its session had not appeared when the collector answered; list it later with orca-read or ask the console');
    }
    process.exit(0);
  }
  if (!notified) {
    notified = true;
    process.stderr.write(`orca-spawn: waiting for the collector to launch it (${id})\n`);
  }
  await sleep(1000);
}

console.error(`orca-spawn: no answer from the collector within ${opts.timeoutSec}s.`);
console.error(`The request is still filed as ${id}; the agent may yet appear. Carry on and check orca-read.`);
process.exit(3);

/* ── Helpers ──────────────────────────────────────────────────────── */

function readAck(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
