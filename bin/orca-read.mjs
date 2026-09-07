#!/usr/bin/env node
/**
 * orca-read — read what other agents have sent you.
 *
 * The receiving half of orca-tell. The collector drops messages into
 * `<project>/.orca/in/`; this prints the unread ones and marks them read by
 * dropping a `<id>.read` marker next to each, which is what ORCA watches to
 * fill `readBy` in the console.
 *
 *   orca-read                 what has been sent to me, unread only
 *   orca-read --all           including what I have already read
 *   orca-read --json          machine-readable
 *   orca-read --peek          print without marking anything read
 *
 * Exit codes:
 *   0  printed (an empty inbox is not an error)
 *   1  bad usage
 *   2  ORCA is not running here
 *   3  timed out waiting for mail
 *
 * Read your inbox when you finish a chunk of work, not mid-edit. A message
 * whose subject starts with "[no encontré a …]" was aimed at somebody ORCA
 * could not find and was broadcast to the project rather than dropped — it may
 * well not be for you.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { waitFor } from './lib/wait-for.mjs';

const argv = process.argv.slice(2);

/* ── Arguments ────────────────────────────────────────────────────── */

function parse(args) {
  const out = { wait: false, timeout: 60, all: false, json: false, peek: false, project: null, kind: null, limit: 50 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case '--wait': case '-w': out.wait = true; break;
      case '--timeout': out.timeout = Number(next()); break;
      case '--all': case '-a': out.all = true; break;
      case '--json': out.json = true; break;
      case '--peek': out.peek = true; break;
      case '--kind': case '-k': out.kind = next() ?? null; break;
      case '--limit': case '-n': out.limit = Math.max(1, Number(next() ?? 50) || 50); break;
      case '--project': case '-p': out.project = next() ?? null; break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default:
        console.error(`unknown argument: ${a}`);
        process.exit(1);
    }
  }
  if (!Number.isFinite(out.timeout) || out.timeout <= 0 || out.timeout > 3600) {
    console.error('--timeout must be between 0 and 3600 seconds (exclusive of 0)');
    process.exit(1);
  }
  return out;
}

function usage() {
  console.log(`orca-read — read what other agents have sent you, through ORCA

  orca-read [options]

  -w, --wait              wait for unread mail without repeated tool calls
      --timeout <seconds>  maximum wait (default: 60); exit 3 on timeout
  -a, --all               include messages already marked read
      --peek              print without marking anything read
  -k, --kind <kind>       only notice | ask | handoff | warning
  -n, --limit <n>         at most this many (default: 50, newest first)
  -p, --project <path>    project root (default: git root, else cwd)
      --json              machine-readable output

  Exit: 0 printed (empty is fine) · 1 bad usage · 2 ORCA not running

  Reading marks messages read unless you pass --peek. An "ask" wants an answer:
  reply with

      orca-tell --reply <id> "your answer"

  and whoever asked stops being blocked.`);
}

/* ── Where to read ────────────────────────────────────────────────── */

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
const root = projectRoot(opts.project);
const inDir = join(root, '.orca', 'in');

if (!orcaPresent()) {
  console.error('orca-read: ORCA is not running on this machine (no ~/.orca).');
  process.exit(2);
}

function readItems() {
  const now = Date.now();
  const items = [];

  if (existsSync(inDir)) {
    for (const name of readdirSync(inDir)) {
      if (!name.endsWith('.json')) continue;
      if (name.startsWith('.')) continue;             // a .tmp mid-rename
      if (name.endsWith('.answer.json')) continue;    // an answer to something I asked
      const id = name.slice(0, -'.json'.length);
      const file = join(inDir, name);
      let msg;
      try {
        msg = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue; // torn write, or somebody's stray file: not our problem
      }
      // An expired notice is swept here rather than by the collector: nothing
      // else ever walks this directory, and leaving them would turn the inbox
      // into an archive.
      if (typeof msg.expiresAt === 'number' && msg.expiresAt < now) {
        rmSync(file, { force: true });
        rmSync(join(inDir, `${id}.read`), { force: true });
        continue;
      }
      const readMark = join(inDir, `${id}.read`);
      const read = existsSync(readMark);
      if (read && !opts.all) continue;
      if (opts.kind && msg.kind !== opts.kind) continue;
      items.push({ id, file, readMark, read, msg });
    }
  }

  return items.length ? items : null;
}

const items = opts.wait
  ? await waitFor(inDir, readItems, opts.timeout * 1000)
  : readItems() ?? [];
if (!items) { console.error('orca-read: no new mail before timeout'); process.exit(3); }
const now = Date.now();
items.sort((a, b) => (b.msg.at ?? 0) - (a.msg.at ?? 0));
const shown = items.slice(0, opts.limit);

if (opts.json) {
  console.log(JSON.stringify(shown.map((i) => ({ ...i.msg, id: i.id, read: i.read })), null, 2));
} else if (shown.length === 0) {
  console.log(opts.all ? 'inbox empty' : 'nothing new');
} else {
  for (const i of shown) {
    const m = i.msg;
    const when = m.at ? new Date(m.at).toISOString().slice(0, 16).replace('T', ' ') : '';
    const mark = i.read ? ' (read)' : '';
    console.log(`\n${(m.kind ?? '?').toUpperCase()}  from ${m.from ?? '??'}  ${when}${mark}`);
    console.log(`  ${m.subject ?? ''}`);
    if (m.body) for (const line of String(m.body).split('\n')) console.log(`  | ${line}`);
    if (Array.isArray(m.files) && m.files.length) {
      console.log(`  files: ${m.files.join(', ')}`);
    }
    if (m.replyTo) console.log(`  reply: orca-tell --reply ${m.replyTo} "your answer"`);
  }
  console.log('');
}

// Marking read is the last thing that happens: if this process dies mid-print,
// the message shows up again rather than vanishing unseen.
if (!opts.peek) {
  mkdirSync(inDir, { recursive: true });
  for (const i of shown) {
    if (i.read) continue;
    try {
      writeFileSync(i.readMark, String(now));
    } catch {
      // A read-only checkout, a full disk: printing already did the useful
      // half of the job, and re-printing next time is the benign failure.
    }
  }
}

process.exit(0);
