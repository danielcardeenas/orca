#!/usr/bin/env node
/**
 * orca-show — put something you made in front of the operator.
 *
 * Sibling of orca-tell. Same shape, different payload: instead of a sentence,
 * a file. ORCA already notices most of what you write — a .png, an .svg, a
 * generated .html — but it cannot know which one of them is *the* one, or what
 * to call it. That is what this is for.
 *
 *   orca-show test/shots/console-06-map.png "The map with 40 agents"
 *   orca-show report.html "Bundle size, before and after"
 *   orca-show diagram.svg
 *   orca-show report.html "Bundle size, before and after" --open
 *
 * Exit codes:
 *   0  filed
 *   1  bad usage, or the file is not something a person can look at
 *   2  ORCA is not running here — mention the path in your summary instead
 *
 * What travels is a declaration, not the bytes: `<project>/.orca/artifacts/`
 * gets a small JSON pointing at the file, the collector picks it up, and the
 * hub fetches the file only if somebody actually looks at it. Rewriting the
 * same path updates the same artifact rather than making a second one, so
 * regenerating a chart replaces it where the operator already had it.
 */

import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sessionId } from './lib/whoami.mjs';

const argv = process.argv.slice(2);

/** Kept in step with src/collector/artifacts.ts — only things worth a look. */
const KINDS = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
  '.webp': 'image', '.svg': 'image',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video',
  '.html': 'html', '.htm': 'html',
  '.md': 'text', '.txt': 'text',
};

/* ── Arguments ────────────────────────────────────────────────────── */

function parse(args) {
  const out = {
    path: null, title: null, kind: null, project: null,
    agentId: sessionId(), json: false, open: false,
  };
  const loose = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
      case '--title': case '-t': out.title = next() ?? null; break;
      case '--kind': case '-k': out.kind = next() ?? null; break;
      case '--project': case '-p': out.project = next() ?? null; break;
      case '--agent': out.agentId = next() ?? null; break;
      case '--open': case '-o': out.open = true; break;
      case '--json': out.json = true; break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default:
        if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); process.exit(1); }
        loose.push(a);
    }
  }
  // `orca-show <path> [title]` — the title is everything after the path, so it
  // does not need quoting to survive.
  if (loose.length) out.path = loose[0];
  if (loose.length > 1 && !out.title) out.title = loose.slice(1).join(' ');
  return out;
}

function usage() {
  console.log(`orca-show — show the operator something you produced

  orca-show <path> [title] [options]

  -t, --title <text>      what this is, in one line (default: the file name)
  -k, --kind <kind>       image | video | html | text | file  (default: by extension)
  -p, --project <path>    project root (default: git root, else cwd)
      --agent <id>        your session id, so the console attributes it right
  -o, --open              ask the console to open it, not just file it
      --json              machine-readable output

  Exit: 0 filed · 1 bad usage · 2 ORCA not running

  The file must live inside the project and be something a person can look at:
  ${Object.keys(KINDS).join(' ')}

  ORCA already picks up most files you write with these extensions. Use this
  when it matters which one — the finished chart among forty frames — or when
  the file name does not say what it is.

  --open asks for it to be opened rather than filed. It is a request, not a
  guarantee: the console decides what opening means and whether now is the
  moment. Use it for the one thing the operator has to see, not for every
  screenshot — an --open that did not need to be one trains them to close the
  next one without looking.`);
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

/** Same marker orca-tell uses: no ~/.orca means nobody is reading this. */
function orcaPresent() {
  const home = process.env.ORCA_HOME ?? join(process.env.HOME ?? '', '.orca');
  return existsSync(home);
}

/* ── Main ─────────────────────────────────────────────────────────── */

const opts = parse(argv);
if (!opts.path) { usage(); process.exit(1); }

const root = projectRoot(opts.project);
const target = resolve(opts.path);

if (!orcaPresent()) {
  console.error('orca-show: ORCA is not running on this machine (no ~/.orca).');
  console.error(`Mention the path in your summary instead: ${target}`);
  process.exit(2);
}

if (!existsSync(target) || !statSync(target).isFile()) {
  console.error(`orca-show: ${target} is not a file.`);
  process.exit(1);
}

const ext = extname(target).toLowerCase();
if (!KINDS[ext]) {
  console.error(`orca-show: ${ext || 'that'} is not something the console can show.`);
  console.error(`Looking at is the point; try one of: ${Object.keys(KINDS).join(' ')}`);
  process.exit(1);
}

// The collector refuses a declaration pointing outside its own project, so
// failing here is the same rule said earlier and with the reason attached.
const rel = relative(root, target);
if (rel.startsWith('..')) {
  console.error(`orca-show: ${target} is outside the project (${root}).`);
  console.error('Copy it in, or pass --project with the root it belongs to.');
  process.exit(1);
}

const outDir = join(root, '.orca', 'artifacts');
const id = `show_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const payload = {
  path: target,
  title: opts.title ?? basename(target),
  ...(opts.kind ? { kind: opts.kind } : {}),
  // Sólo viaja cuando se pide: un `open: false` en cada declaración sería ruido
  // en un archivo que un humano puede acabar leyendo a mano.
  ...(opts.open ? { open: true } : {}),
  agentId: opts.agentId,
  at: Date.now(),
};

mkdirSync(outDir, { recursive: true });
const finalPath = join(outDir, `${id}.json`);
const tmpPath = join(outDir, `.${id}.tmp`);
writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
try {
  renameSync(tmpPath, finalPath);
} catch (err) {
  rmSync(tmpPath, { force: true });
  console.error('orca-show: could not file it:', err.message);
  process.exit(2);
}

if (opts.json) {
  console.log(JSON.stringify({
    id, shown: true, path: target, title: payload.title, open: opts.open,
  }));
} else {
  console.log(`${opts.open ? 'opening' : 'showing'}: ${payload.title}  (${rel})`);
}
