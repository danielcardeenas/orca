#!/usr/bin/env node
/**
 * orca-read — read what other agents have sent you.
 *
 * The receiving half of orca-tell. The collector drops messages into
 * `<project>/.orca/in/<msgId>.<recipient>.json`; this prints the unread ones
 * addressed to whoever is running it, and marks them read by dropping a
 * `<msgId>.<recipient>.read` marker next to each, which is what ORCA watches to
 * fill `readBy` in the console.
 *
 * The inbox directory is shared by every agent in the project — one `.orca/in/`
 * per project, not per agent — so both halves of that name matter. Until
 * 2026-09-13 neither existed: the file was named after the message alone, said
 * nothing about who it was for, and the read mark was global. The first agent
 * to run this walked off with everyone else's mail and left them a `.read`
 * marker in their name; the real recipients saw "nothing new". It cost a squad
 * lead three messages in one morning, the last one addressed to himself, and it
 * is why the recipient is now part of the filename.
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
import { join } from 'node:path';

import { waitFor } from './lib/wait-for.mjs';
import { projectRoot } from './lib/project-root.mjs';
import { sessionId } from './lib/whoami.mjs';

const argv = process.argv.slice(2);

/* ── Arguments ────────────────────────────────────────────────────── */

function parse(args) {
  const out = {
    wait: false, timeout: 60, all: false, json: false, peek: false, project: null,
    kind: null, limit: 50, agentId: sessionId(), everyone: false,
  };
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
      case '--agent': out.agentId = next() ?? null; break;
      case '--everyone': out.everyone = true; break;
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
      --agent <id>        your session id, if this cannot work it out itself
      --everyone          every message in the shared inbox, not only yours
      --json              machine-readable output

  Exit: 0 printed (empty is fine) · 1 bad usage · 2 ORCA not running

  Reading marks messages read unless you pass --peek. An "ask" wants an answer:
  reply with

      orca-tell --reply <id> "your answer"

  and whoever asked stops being blocked.

  A project has ONE inbox directory shared by every agent in it, so each
  message file is named after its recipient and you are shown only yours.
  Before that, on 2026-09-13, the first agent to read carried off everybody
  else's mail and the real recipients saw "nothing new" — it happened to one
  squad lead three times in a morning, the last time to a message he had sent
  himself. Older files carry no recipient and are shown to everyone, because
  hiding mail that already exists would be a worse bug than the one being
  fixed.`);
}

/* ── Where to read ────────────────────────────────────────────────── */

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

/**
 * Is this file addressed to me?
 *
 * The collector names each delivery `<msgId>.<recipient>.json`, so the answer
 * is in the filename and needs no guessing. Two deliberate escape hatches, both
 * of which err towards showing too much rather than hiding mail:
 *
 *  - **A file with no recipient** (`<msgId>.json`) is shown to everyone. That
 *    is every message delivered before 2026-09-13 — around 200 of them on this
 *    machine at the time — and they cannot be re-addressed after the fact.
 *  - **An agent that does not know who it is** sees everything, exactly as
 *    before. `sessionId()` returning null means "I don't know", and a reader
 *    who doesn't know its own name must not conclude that no mail is its own:
 *    that would turn a shared inbox into an empty one.
 *
 * Note the recipient is decided where the routing happens — the hub resolved
 * the squad and called the collector once per agent. Re-deriving membership
 * here would be two sides answering the same question separately, which is the
 * exact shape of the worktree bug this same morning.
 */
function mine(stem) {
  if (opts.everyone || !opts.agentId) return true;
  const dot = stem.indexOf('.');
  if (dot < 0) return true;                       // no recipient: everyone's
  return stem.slice(dot + 1) === opts.agentId;
}

function readItems() {
  const now = Date.now();
  const items = [];

  if (existsSync(inDir)) {
    for (const name of readdirSync(inDir)) {
      if (!name.endsWith('.json')) continue;
      if (name.startsWith('.')) continue;             // a .tmp mid-rename
      if (name.endsWith('.answer.json')) continue;    // an answer to something I asked
      const stem = name.slice(0, -'.json'.length);
      if (!mine(stem)) continue;
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
        rmSync(join(inDir, `${stem}.read`), { force: true });
        continue;
      }
      // The read mark follows the file, so it is per recipient too: marking a
      // message read no longer does it in everybody else's name.
      const readMark = join(inDir, `${stem}.read`);
      const read = existsSync(readMark);
      if (read && !opts.all) continue;
      if (opts.kind && msg.kind !== opts.kind) continue;
      // The id an agent quotes back in `--reply` is the MESSAGE's, never the
      // filename's: the filename now carries a recipient the hub knows nothing
      // about.
      items.push({ id: msg.id ?? stem, file, readMark, read, msg });
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
