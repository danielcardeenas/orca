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
const TALK_SKILL_SRC = join(ORCA_ROOT, 'skill', 'orca-talk', 'SKILL.md');
const ASK_BIN = join(ORCA_ROOT, 'bin', 'orca-ask.mjs');

/** Los comandos que un agente puede necesitar. Todos se enlazan juntos. */
const COMMANDS = ['orca-ask', 'orca-tell', 'orca-read', 'orca-show', 'orca-spawn'];

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

Installs two skills into <project>/.claude/skills/ and links orca-ask,
orca-tell, orca-read, orca-show and orca-spawn into <project>/.claude/bin/:

  orca-ask   when to interrupt YOU, and when to work it out instead
  orca-talk  how to reach ANOTHER AGENT, and when that beats asking you`);
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

function skillBody(src) {
  // The absolute path is baked in so the skill works with no PATH setup at all.
  return readFileSync(src, 'utf8')
    .replace('node /path/to/orca/bin/orca-ask.mjs', `node ${ASK_BIN}`)
    .replace(/\/path\/to\/orca\/bin\//g, join(ORCA_ROOT, 'bin') + '/')
    + `\n\n${MARKER}\n`;
}

/** Las skills que se instalan juntas: preguntar al humano y hablar entre agentes. */
function skillSources() {
  const out = [{ name: 'orca-ask', src: SKILL_SRC }];
  if (existsSync(TALK_SKILL_SRC)) out.push({ name: 'orca-talk', src: TALK_SKILL_SRC });
  return out;
}

function installInto(root, label = root) {
  let wrote = 0;
  for (const { name, src } of skillSources()) {
    const skillDir = join(root, '.claude', 'skills', name);
    const skillFile = join(skillDir, 'SKILL.md');

    if (existsSync(skillFile) && !readFileSync(skillFile, 'utf8').includes(MARKER)) {
      // Someone edited it, or wrote their own. Their version wins, always.
      console.log(`  skip   ${label}  (a hand-edited ${name} skill is already there)`);
      continue;
    }
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, skillBody(src));
    wrote++;
  }
  if (wrote === 0) return 'skipped';

  // Symlinks into .claude/bin so the commands resolve inside the project even
  // when nothing has been added to the shell's PATH.
  const binDir = join(root, '.claude', 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const cmd of COMMANDS) {
    const target = join(ORCA_ROOT, 'bin', `${cmd}.mjs`);
    if (!existsSync(target)) continue;
    const link = join(binDir, cmd);
    try {
      if (lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link);
      symlinkSync(target, link);
    } catch (err) {
      // A failed symlink is not fatal: the skills carry absolute paths.
      console.log(`  note   ${label}  (could not link ${cmd}: ${err.message})`);
    }
  }

  console.log(`  ok     ${label}`);
  return 'installed';
}

function removeFrom(root, label = root) {
  let touched = false;
  for (const { name } of skillSources()) {
    const skillDir = join(root, '.claude', 'skills', name);
    const file = join(skillDir, 'SKILL.md');
    if (!existsSync(file)) continue;
    if (!readFileSync(file, 'utf8').includes(MARKER)) {
      console.log(`  skip   ${label}  (${name} is hand-edited; leaving it alone)`);
      continue;
    }
    rmSync(skillDir, { recursive: true, force: true });
    touched = true;
  }
  for (const cmd of COMMANDS) {
    const link = join(root, '.claude', 'bin', cmd);
    try {
      if (lstatSync(link, { throwIfNoEntry: false })) { unlinkSync(link); touched = true; }
    } catch { /* nothing to remove */ }
  }
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
