/**
 * Runtimes: the CLIs a collector knows how to watch and drive.
 *
 * ORCA is not a Claude Code console; it is a console for coding agents, and
 * Claude Code is the first runtime it speaks. Everything runtime-specific —
 * where a CLI writes its transcripts, how to parse them into `Agent` state,
 * how to spawn, say, stop, and read logs — lives behind this interface, so
 * adding Codex or Grok is a new file here and nothing else.
 *
 * The hub, the protocol, the agent↔agent channel (`.orca/out`, `.orca/in`),
 * escalations and artifacts are already runtime-agnostic: they are files in
 * the project, and any CLI that can write a file can use them.
 *
 * Status:
 *   claude   the collector as it exists today (derive.ts, watch.ts, commands.ts)
 *   codex    not yet — needs: ~/.codex/sessions/*.jsonl reader, `codex exec` spawn
 *   grok     not yet — needs: its session format and a headless entry point
 */

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

/** What a collector reports about itself. The console builds its runtime picker from this. */
export const RUNTIMES: RuntimeInfo[] = [
  { id: 'claude', label: 'CLAUDE CODE', ready: true },
  { id: 'codex', label: 'CODEX', ready: false, note: 'adapter pending: session reader + `codex exec` spawn' },
  { id: 'grok', label: 'GROK', ready: false, note: 'adapter pending: session format + headless entry point' },
];

export function runtimeReady(id: string | undefined): boolean {
  return RUNTIMES.some((r) => r.id === (id ?? 'claude') && r.ready);
}

export function runtimeNote(id: string | undefined): string {
  const r = RUNTIMES.find((x) => x.id === (id ?? 'claude'));
  return r ? (r.ready ? `${r.label} ready` : `${r.label}: ${r.note ?? 'not available'}`) : `unknown runtime "${id}"`;
}
