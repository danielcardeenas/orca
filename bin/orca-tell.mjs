#!/usr/bin/env node
/**
 * orca-tell — the agent side of the agent → agent channel.
 *
 * Sibling of orca-ask. Same shape, different party at the other end: an agent
 * has no socket to its peers either, so telling one something is writing a file
 * into `<project>/.orca/out/` and letting the collector route it.
 *
 *   orca-tell "The /v1/charges endpoint returns 402 in sandbox" --to K9 --kind warning
 *   orca-tell "Did you migrate the sessions table?" --to T1 --kind ask --wait
 *   orca-tell "HTTP client done; caching is left" --kind handoff --to project:dijosi
 *   orca-tell "Report by 18:00, one line each" --to squad:audit-01 --kind handoff
 *   orca-tell "Switched the build to esbuild" --kind notice          # the whole fleet
 *   orca-tell --reply msg_1a2b3c4d "Yes, migrated last night"
 *
 * Exit codes:
 *   0  sent (or answered, with --wait)
 *   1  bad usage
 *   2  ORCA is not running here — say it in your summary instead
 *   3  timed out waiting for an answer
 *
 * Four kinds, and the difference matters:
 *   notice   "I found this out."   nobody must act; it expires on its own
 *   ask      "I need this."        YOU BLOCK until someone answers
 *   handoff  "This is now yours."  work changing hands, with context
 *   warning  "Careful."            something they are about to walk into
 *
 * Only `ask` blocks you. Use it when you genuinely cannot proceed; use `notice`
 * for everything you merely want on the record.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { waitFor } from './lib/wait-for.mjs';
import { sessionId } from './lib/whoami.mjs';

const argv = process.argv.slice(2);

const KINDS = ['notice', 'ask', 'handoff', 'warning'];

/* ── Arguments ────────────────────────────────────────────────────── */

function parse(args) {
  const out = {
    subject: '', body: null, kind: 'notice', to: null, files: [],
    wait: false, timeoutMin: 60, ttlMin: null, replyTo: null,
    project: null, agentId: sessionId(), json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case '--to': case '-t': out.to = next() ?? null; break;
      case '--kind': case '-k': out.kind = next() ?? 'notice'; break;
      case '--body': case '-b': out.body = next() ?? null; break;
      case '--file': case '-f': { const v = next(); if (v) out.files.push(v); break; }
      case '--wait': case '-w': out.wait = true; break;
      case '--timeout': out.timeoutMin = Number(next() ?? 60); break;
      case '--ttl': out.ttlMin = Number(next() ?? 0) || null; break;
      case '--reply': out.replyTo = next() ?? null; break;
      case '--project': case '-p': out.project = next() ?? null; break;
      case '--agent': out.agentId = next() ?? null; break;
      case '--json': out.json = true; break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default:
        if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); process.exit(1); }
        out.subject = out.subject ? `${out.subject} ${a}` : a;
    }
  }
  return out;
}

function usage() {
  console.log(`orca-tell — say something to another agent, through ORCA

  orca-tell "<subject>" [options]
  orca-tell --reply <messageId> "<answer>"

  -t, --to <who>          K9 (a callsign) · project:<name> · squad:<name> · fleet
                          (default: fleet)
  -k, --kind <kind>       notice | ask | handoff | warning           (default: notice)
  -b, --body <text>       the detail, if one line is not enough
  -f, --file <path>       a file this is about (repeatable, up to 20)
  -w, --wait              only with --kind ask: block until answered
      --timeout <min>     give up waiting after this long (default: 60)
      --ttl <min>         retire the message after this long
      --reply <id>        answer someone else's ask and unblock them
  -p, --project <path>    project root (default: git root, else cwd)
      --agent <id>        your session id, so the console attributes it right
      --json              machine-readable output

  Exit: 0 sent/answered · 1 bad usage · 2 ORCA not running · 3 timed out

  notice  "I found this out."   nobody must act; expires on its own
  ask     "I need this."        YOU BLOCK until someone answers
  handoff "This is now yours."  work changing hands, with context
  warning "Careful."            something they are about to walk into

  Only an ask blocks you, and only an ask makes you a link in a waiting chain
  the operator can see. Use notice for everything you merely want on record.
  An unroutable recipient does not lose the message: it goes out to the whole
  project with the failure spelled out in the subject. The exception is
  squad:<name>: an empty squad is not broadcast to anybody, because waking
  twenty unrelated agents is worse than not delivering — the console says so
  instead.`);
}

/* ── Where to write ───────────────────────────────────────────────── */

function projectRoot(explicit) {
  if (explicit) return resolve(explicit);
  try {
    // The message lands in the repo the agent is actually working in, which is
    // what the collector maps to a project.
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
}

/**
 * ORCA is "running here" if a collector has ever touched this machine. Without
 * the marker an agent would file messages into a directory nobody reads, which
 * is worse than failing loudly.
 */
function orcaPresent() {
  const home = process.env.ORCA_HOME ?? join(process.env.HOME ?? '', '.orca');
  return existsSync(home);
}

/* ── Main ─────────────────────────────────────────────────────────── */

const opts = parse(argv);
const root = projectRoot(opts.project);
const outDir = join(root, '.orca', 'out');
const inDir = join(root, '.orca', 'in');

if (!opts.subject.trim()) { usage(); process.exit(1); }

if (!orcaPresent()) {
  console.error('orca-tell: ORCA is not running on this machine (no ~/.orca).');
  console.error('Say what you would have told them in your summary instead.');
  process.exit(2);
}

if (!KINDS.includes(opts.kind)) {
  console.error(`orca-tell: kind must be one of ${KINDS.join(', ')} (got "${opts.kind}")`);
  process.exit(1);
}
if (opts.wait && opts.kind !== 'ask' && !opts.replyTo) {
  console.error('orca-tell: --wait only means something for --kind ask.');
  console.error('Nothing answers a notice, so waiting on one waits forever.');
  process.exit(1);
}

const id = `tell_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(outDir, { recursive: true });

const payload = opts.replyTo
  ? {
      // A reply rides the same outbox; the collector routes it to the asker's
      // inbox and clears their `peer` block instead of creating a new message.
      replyTo: opts.replyTo,
      answer: opts.subject.trim(),
      agentId: opts.agentId,
      at: Date.now(),
    }
  : {
      kind: opts.kind,
      to: opts.to,
      subject: opts.subject.trim(),
      body: opts.body,
      files: opts.files.slice(0, 20),
      agentId: opts.agentId,
      ttlMinutes: opts.ttlMin,
      at: Date.now(),
      cwd: process.cwd(),
    };

// Write to a temp name and rename: the collector watches this directory, and a
// half-written JSON would be parsed as garbage exactly once, at the worst time.
const finalPath = join(outDir, `${id}.json`);
const tmpPath = join(outDir, `.${id}.tmp`);
writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
try {
  renameSync(tmpPath, finalPath);
} catch (err) {
  rmSync(tmpPath, { force: true });
  console.error('orca-tell: could not file the message:', err.message);
  process.exit(2);
}

if (!opts.wait) {
  if (opts.json) console.log(JSON.stringify({ id, sent: true, kind: opts.kind, to: opts.to }));
  else if (opts.replyTo) console.log(`replied to ${opts.replyTo}`);
  else {
    console.log(`sent: ${id} (${opts.kind} → ${opts.to ?? 'fleet'})`);
    if (opts.kind === 'ask') console.log(`answer arrives at .orca/in/${id}.answer.json`);
  }
  process.exit(0);
}

/* ── Waiting ──────────────────────────────────────────────────────── */

process.stderr.write(`orca-tell: waiting on ${opts.to ?? 'the fleet'} (${id})\n`);
const answer = await waitFor(inDir, () => readAnswer(inDir, id), opts.timeoutMin * 60_000);
if (answer) { emit(answer, opts); process.exit(0); }

console.error(`orca-tell: no answer within ${opts.timeoutMin} min.`);
console.error('State the assumption you are making, proceed, and flag it in your summary.');
process.exit(3);

/* ── Helpers ──────────────────────────────────────────────────────── */

function readAnswer(dir, localId) {
  const path = join(dir, `${localId}.answer.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A torn read of a file being written: try again on the next tick.
    return null;
  }
}

function emit(answer, o) {
  if (o.json) { console.log(JSON.stringify(answer)); return; }
  console.log(answer.answer ?? '');
  if (answer.answeredByCallsign) {
    console.error(`\n[answered by ${answer.answeredByCallsign}]`);
  }
}
