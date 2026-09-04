#!/usr/bin/env node
/**
 * orca-install — teach a project's agents that they can ask you things.
 *
 * The escalation channel is useless until the agents working in a repo know it
 * exists. This drops the `orca-ask` skill into a project's `.claude/skills/`
 * and puts `orca-ask` on the PATH, so any Claude Code session started there can
 * reach the human through ORCA instead of guessing or stopping.
 *
 *   orca-install                    the current repo
 *   orca-install ~/projects/foo     a specific one
 *   orca-install --all              every project ORCA is watching
 *   orca-install --user             once, globally, for every project
 *   orca-install --check            what is installed where
 *   orca-install --remove [path]    take it back out
 *
 * Nothing here is destructive: an existing skill is only overwritten when it
 * was installed by ORCA (it carries a marker), and never when a human has
 * edited it.
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync,
  lstatSync, unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCA_ROOT = resolve(HERE, '..');
const SKILL_SRC = join(ORCA_ROOT, 'skill', 'orca-ask', 'SKILL.md');
const ASK_BIN = join(ORCA_ROOT, 'bin', 'orca-ask.mjs');

/** Written into the installed skill so we know we may replace it later. */
const MARKER = '<!-- installed by orca-install; edits here will be preserved -->';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const positional = argv.filter((a) => !a.startsWith('-'));

if (flag('help') || flag('h')) { usage(); process.exit(0); }

function usage() {
  console.log(`orca-install — teach a project's agents to ask you things

  orca-install [path]        install into a project (default: current repo)
  orca-install --all         every project ORCA is watching
  orca-install --user        once, globally, for every project on this machine
  orca-install --check       report what is installed where
  orca-install --remove [p]  uninstall

Installs the orca-ask skill into <project>/.claude/skills/orca-ask/ and links
the orca-ask command into <project>/.claude/bin/. An agent that loads the skill
knows when to interrupt you and when to work it out itself.`);
}

/* ── Where ORCA thinks the projects are ───────────────────────────── */

function claudeProjectsDir() {
  return join(homedir(), '.claude', 'projects');
}

/** Every project directory the collector would see. */
function watchedProjects() {
  const root = claudeProjectsDir();
  if (!existsSync(root)) return [];
  const out = new Set();
  for (const slug of readdirSync(root)) {
    // A worktree slug points back at its parent project, which is the repo the
    // human actually works in and the only one worth installing into.
    const folded = slug.split('--claude-worktrees-')[0];
    const guess = '/' + folded.replace(/^-/, '').replace(/-/g, '/');
    if (existsSync(join(guess, '.git'))) out.add(guess);
  }
  return [...out].sort();
}

function currentRepo() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.cwd();
  }
}

/* ── Install ──────────────────────────────────────────────────────── */

function skillBody() {
  const src = readFileSync(SKILL_SRC, 'utf8');
  // The absolute path is baked in so the skill works with no PATH setup at all.
  return src.replace(
    'node /path/to/orca/bin/orca-ask.mjs',
    `node ${ASK_BIN}`,
  ) + `\n\n${MARKER}\n`;
}

function installInto(root, label = root) {
  const skillDir = join(root, '.claude', 'skills', 'orca-ask');
  const skillFile = join(skillDir, 'SKILL.md');

  if (existsSync(skillFile)) {
    const existing = readFileSync(skillFile, 'utf8');
    if (!existing.includes(MARKER)) {
      // Someone edited it, or wrote their own. Their version wins, always.
      console.log(`  skip   ${label}  (a hand-edited orca-ask skill is already there)`);
      return 'skipped';
    }
  }

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillFile, skillBody());

  // A symlink into .claude/bin so `orca-ask` resolves inside the project even
  // when nothing has been added to the shell's PATH.
  const binDir = join(root, '.claude', 'bin');
  mkdirSync(binDir, { recursive: true });
  const link = join(binDir, 'orca-ask');
  try {
    if (lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link);
    symlinkSync(ASK_BIN, link);
  } catch (err) {
    // A failed symlink is not fatal: the skill carries the absolute path.
    console.log(`  note   ${label}  (could not link orca-ask: ${err.message})`);
  }

  console.log(`  ok     ${label}`);
  return 'installed';
}

function removeFrom(root, label = root) {
  const skillDir = join(root, '.claude', 'skills', 'orca-ask');
  const link = join(root, '.claude', 'bin', 'orca-ask');
  let touched = false;

  if (existsSync(join(skillDir, 'SKILL.md'))) {
    const body = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    if (!body.includes(MARKER)) {
      console.log(`  skip   ${label}  (hand-edited; leaving it alone)`);
      return;
    }
    rmSync(skillDir, { recursive: true, force: true });
    touched = true;
  }
  try {
    if (lstatSync(link, { throwIfNoEntry: false })) { unlinkSync(link); touched = true; }
  } catch { /* nothing to remove */ }

  console.log(touched ? `  removed ${label}` : `  none   ${label}`);
}

function checkOne(root) {
  const skillFile = join(root, '.claude', 'skills', 'orca-ask', 'SKILL.md');
  if (!existsSync(skillFile)) return 'absent';
  return readFileSync(skillFile, 'utf8').includes(MARKER) ? 'installed' : 'custom';
}

/* ── Main ─────────────────────────────────────────────────────────── */

if (!existsSync(SKILL_SRC)) {
  console.error(`orca-install: cannot find the skill at ${SKILL_SRC}`);
  process.exit(1);
}

if (flag('check')) {
  const roots = [homedir(), ...watchedProjects()];
  console.log('orca-ask skill:');
  for (const r of roots) {
    const state = checkOne(r);
    const label = r === homedir() ? `${r}  (user-wide)` : r;
    console.log(`  ${state.padEnd(9)} ${label}`);
  }
  process.exit(0);
}

if (flag('remove')) {
  const targets = flag('user') ? [homedir()]
    : flag('all') ? watchedProjects()
      : [resolve(positional[0] ?? currentRepo())];
  console.log('removing orca-ask:');
  for (const t of targets) removeFrom(t, basename(t) === '' ? t : t);
  process.exit(0);
}

if (flag('user')) {
  // ~/.claude/skills applies to every project on the machine. One install, and
  // every agent the operator ever starts knows how to reach them.
  console.log('installing orca-ask user-wide:');
  installInto(homedir(), `${homedir()}  (every project on this machine)`);
  process.exit(0);
}

const targets = flag('all') ? watchedProjects() : [resolve(positional[0] ?? currentRepo())];

if (!targets.length) {
  console.log('orca-install: no projects found. Is ORCA watching anything yet?');
  process.exit(1);
}

console.log(`installing orca-ask into ${targets.length} project(s):`);
let installed = 0;
for (const t of targets) {
  if (installInto(t) === 'installed') installed++;
}
console.log(`\n${installed} installed. Agents started in these projects can now reach you.`);
console.log('Try it:  orca-ask "test question" --option yes --option no');
