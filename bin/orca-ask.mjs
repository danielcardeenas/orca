#!/usr/bin/env node
/**
 * orca-ask — the agent side of the escalation channel.
 *
 * An agent has no socket to ORCA. It has a filesystem. So asking the human is
 * writing a file into `<project>/.orca/ask/` and waiting for the answer file to
 * appear next to it. The collector watches that directory; the CEO triages;
 * the console interrupts the human if it has to.
 *
 *   orca-ask "Which payment provider?" --option Stripe --option "Mercado Pago" --wait
 *   orca-ask --check ask_1a2b3c
 *
 * Exit codes:
 *   0  answered (with --wait), or question filed (without)
 *   1  bad usage
 *   2  ORCA is not running here — fall back to stating an assumption
 *   3  timed out waiting
 *
 * The contract this implements is docs/ESCALATION.md. Change one, change all.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);

/* ── Arguments ────────────────────────────────────────────────────── */

function parse(args) {
  const out = {
    question: '', context: null, options: [], optionsOnly: false,
    urgency: 'normal', wait: false, check: null, timeoutMin: 60,
    project: null, agentId: process.env.CLAUDE_SESSION_ID ?? null, json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case '--context': case '-c': out.context = next() ?? null; break;
      case '--option': case '-o': { const v = next(); if (v) out.options.push(v); break; }
      case '--options-only': out.optionsOnly = true; break;
      case '--urgency': case '-u': out.urgency = next() ?? 'normal'; break;
      case '--wait': case '-w': out.wait = true; break;
      case '--timeout': out.timeoutMin = Number(next() ?? 60); break;
      case '--check': out.check = next() ?? null; break;
      case '--project': case '-p': out.project = next() ?? null; break;
      case '--agent': out.agentId = next() ?? null; break;
      case '--json': out.json = true; break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default:
        if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); process.exit(1); }
        out.question = out.question ? `${out.question} ${a}` : a;
    }
  }
  return out;
}

function usage() {
  console.log(`orca-ask — ask the human operator something, through ORCA

  orca-ask "<question>" [options]
  orca-ask --check <id>

  -c, --context <text>    two or three lines of what bears on the decision
  -o, --option <text>     a one-tap answer (repeatable, up to 12)
      --options-only      free text is not useful; force a choice
  -u, --urgency <level>   low | normal | blocking      (default: normal)
  -w, --wait              block until answered, print the answer on stdout
      --timeout <min>     give up waiting after this long (default: 60)
      --check <id>        has this question been answered yet?
  -p, --project <path>    project root (default: git root, else cwd)
      --agent <id>        your session id, so the console attributes it right
      --json              machine-readable output

  Exit: 0 answered/filed · 1 bad usage · 2 ORCA not running · 3 timed out

  Ask one question. Give options when the answer is a choice — the human is
  usually on a phone. Keep working on whatever does not depend on the answer.`);
}

/* ── Where to write ───────────────────────────────────────────────── */

function projectRoot(explicit) {
  if (explicit) return resolve(explicit);
  try {
    // The escalation lands in the repo the agent is actually working in, which
    // is what the collector maps to a project.
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
}

/**
 * ORCA is "running here" if a collector has ever touched this machine. The
 * marker is the home directory the collector creates; without it, an agent
 * would file questions into a directory nobody reads, which is worse than
 * failing loudly.
 */
function orcaPresent() {
  const home = process.env.ORCA_HOME ?? join(process.env.HOME ?? '', '.orca');
  return existsSync(home);
}

/* ── Main ─────────────────────────────────────────────────────────── */

const opts = parse(argv);
const root = projectRoot(opts.project);
const askDir = join(root, '.orca', 'ask');

if (opts.check) {
  const answer = readAnswer(askDir, opts.check);
  if (!answer) {
    if (opts.json) console.log(JSON.stringify({ answered: false, id: opts.check }));
    else console.log('not answered yet');
    process.exit(3);
  }
  emit(answer, opts);
  process.exit(0);
}

if (!opts.question.trim()) { usage(); process.exit(1); }

if (!orcaPresent()) {
  console.error('orca-ask: ORCA is not running on this machine (no ~/.orca).');
  console.error('State the assumption you are making, proceed, and flag it in your summary.');
  process.exit(2);
}

if (!['low', 'normal', 'blocking'].includes(opts.urgency)) {
  console.error(`orca-ask: urgency must be low, normal or blocking (got "${opts.urgency}")`);
  process.exit(1);
}

const id = `ask_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(askDir, { recursive: true });

const payload = {
  question: opts.question.trim(),
  context: opts.context,
  options: opts.options.slice(0, 12),
  optionsOnly: opts.optionsOnly && opts.options.length > 0,
  urgency: opts.urgency,
  agentId: opts.agentId,
  ttlMinutes: opts.timeoutMin,
  askedAt: Date.now(),
  cwd: process.cwd(),
};

// Write to a temp name and rename: the collector watches this directory, and a
// half-written JSON would be parsed as garbage exactly once, at the worst time.
const finalPath = join(askDir, `${id}.json`);
const tmpPath = join(askDir, `.${id}.tmp`);
writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
try {
  const { renameSync } = await import('node:fs');
  renameSync(tmpPath, finalPath);
} catch (err) {
  rmSync(tmpPath, { force: true });
  console.error('orca-ask: could not file the question:', err.message);
  process.exit(2);
}

if (!opts.wait) {
  if (opts.json) console.log(JSON.stringify({ id, filed: true }));
  else {
    console.log(`asked: ${id}`);
    console.log(`check with: orca-ask --check ${id}`);
  }
  process.exit(0);
}

/* ── Waiting ──────────────────────────────────────────────────────── */

const deadline = Date.now() + opts.timeoutMin * 60_000;
let notified = false;

while (Date.now() < deadline) {
  const answer = readAnswer(askDir, id);
  if (answer) { emit(answer, opts); process.exit(0); }

  // One line to stderr the first time, so a human tailing the agent's terminal
  // knows why it went quiet. stdout stays clean for the answer.
  if (!notified) {
    notified = true;
    process.stderr.write(`orca-ask: waiting on the operator (${id})\n`);
  }
  await sleep(1500);
}

console.error(`orca-ask: no answer within ${opts.timeoutMin} min.`);
console.error('State the assumption you are making, proceed, and flag it in your summary.');
process.exit(3);

/* ── Helpers ──────────────────────────────────────────────────────── */

function readAnswer(dir, id) {
  const path = join(dir, `${id}.answer.json`);
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
  if (answer.rememberAs) {
    console.error(`\n[standing rule from the operator: ${answer.rememberAs}]`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
