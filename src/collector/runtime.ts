/**
 * Runtimes: the CLIs a collector knows how to watch and drive.
 *
 * ORCA is not a Claude Code console; it is a console for coding agents, and
 * Claude Code is the first runtime it speaks. Everything runtime-specific —
 * where a CLI writes its transcripts, how to parse them into `Agent` state,
 * how to spawn, say, stop, and read logs — lives behind this file and the
 * per-runtime modules, so adding one is a new deriver and an argv builder,
 * nothing else.
 *
 * What is shared, and therefore free for every runtime: the tmux pane that
 * hosts the session (tmux.ts), the terminal the console attaches to
 * (term.ts), `say` as a paste, `stop` as two Ctrl-C, `logs` as capture-pane,
 * the agent↔agent channel (`.orca/out`, `.orca/in`), escalations, artifacts.
 *
 * Status:
 *   claude   transcripts in ~/.claude/projects (derive.ts), `claude --session-id` in a pane
 *   codex    rollouts in ~/.codex/sessions (codex.ts), `codex -C <cwd> <prompt>` in a pane
 *   grok     not yet — needs: its session format and a headless entry point
 */

import fs from 'node:fs';
import path from 'node:path';

import { home } from './util.ts';

export type RuntimeId = 'claude' | 'codex' | 'grok' | (string & {});

export interface RuntimeInfo {
  id: RuntimeId;
  /** Shown on the tile and the spawn form. */
  label: string;
  /** True when this collector can watch and drive it. */
  ready: boolean;
  /** Why it is not ready, in one line, so the console can say so. */
  note?: string;
}

/** Where each CLI's binary was found on this machine, or null. Resolved once. */
const BINS: Record<string, string | null> = {};

export function runtimeBin(id: string): string | null {
  if (!(id in BINS)) {
    BINS[id] = id === 'claude' ? findBin('claude', 'ORCA_CLAUDE_BIN')
      : id === 'codex' ? findBin('codex', 'ORCA_CODEX_BIN')
      : null;
  }
  return BINS[id] ?? null;
}

/** What a collector reports about itself. The console builds its runtime picker from this. */
export function runtimes(): RuntimeInfo[] {
  const claude = runtimeBin('claude');
  const codex = runtimeBin('codex');
  return [
    { id: 'claude', label: 'CLAUDE CODE', ready: claude !== null, ...(claude ? {} : { note: '`claude` not found in PATH' }) },
    { id: 'codex', label: 'CODEX', ready: codex !== null, ...(codex ? {} : { note: '`codex` not found in PATH (npm i -g @openai/codex)' }) },
    { id: 'grok', label: 'GROK', ready: false, note: 'adapter pending: session format + headless entry point' },
  ];
}

export function runtimeReady(id: string | undefined): boolean {
  return runtimes().some((r) => r.id === (id ?? 'claude') && r.ready);
}

export function runtimeNote(id: string | undefined): string {
  const r = runtimes().find((x) => x.id === (id ?? 'claude'));
  return r ? (r.ready ? `${r.label} ready` : `${r.label}: ${r.note ?? 'not available'}`) : `unknown runtime "${id}"`;
}

/** Walks PATH by hand — never a shell — plus the places installers drop binaries. */
export function findBin(name: string, envOverride: string): string | null {
  const override = process.env[envOverride];
  if (override) return isExec(override) ? override : null;
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(home(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin');
  for (const d of dirs) {
    const p = path.join(d, name);
    if (isExec(p)) return p;
  }
  return null;
}

function isExec(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
