/**
 * The CAPCOM conversation, folded for reading.
 *
 * The hub hands the console a flat list of blocks — a prompt, a thinking
 * block, three tool calls, their results, two paragraphs of reply — in the
 * order the CLI wrote them. A person does not read blocks; they read an
 * exchange: what I said, then everything CAPCOM did and said until it stopped.
 * `foldTalk` turns the one into the other, and nothing here touches the DOM,
 * so the fold is a thing a test can hold.
 *
 * Three kinds of prompt reach CAPCOM and only one of them is the human:
 *
 *  - what the operator typed — a `human` group
 *  - `[ESCALATION <id>] K9 asks: …` — the hub relaying an agent's question,
 *    a `fleet` group: it is context for what CAPCOM does next, not a line
 *    the operator wrote
 *  - `[ORCA TASK <id>] …` — a task conversation's prompt, a `task` group with
 *    the task id on it, so the GENERAL view can point at the task instead of
 *    repeating a wall of context that lives there already
 *  - `You are online. …` — the collector's launch brief, a `system` group:
 *    ORCA talking, not the operator
 */

import type { TalkItem } from '../../shared/types.ts';
import { ESCALATION_PREFIX } from '../../shared/capcom.ts';

export type TalkRole = 'human' | 'capcom' | 'fleet' | 'task' | 'system';

/** One step CAPCOM took inside a reply: a thought, or a tool call with its result. */
export interface TalkStep {
  id: string;
  at: number;
  kind: 'thinking' | 'tool';
  /** The thought, or the tool's one-line detail. */
  text: string;
  tool?: string;
  toolUseId?: string;
  /** For tools: what came back. Undefined while it is still running. */
  result?: { text: string; error: boolean; at: number };
}

/** A block of the reply as it reads: a paragraph, or a step. Order preserved. */
export type TalkPart =
  | { kind: 'text'; id: string; at: number; text: string }
  | { kind: 'step'; step: TalkStep };

export interface TalkGroup {
  id: string;
  role: TalkRole;
  at: number;
  /** For `human`, `fleet` and `task`: the prompt itself. */
  text: string;
  /** For `task`: the id inside the `[ORCA TASK …]` prefix. */
  taskId?: string;
  /** For `fleet`: the escalation id inside the prefix. */
  escalationId?: string;
  /** For `capcom`: the reply, in reading order. */
  parts: TalkPart[];
}

import { HANDOFF_NOTICE_PREFIX } from '../../shared/handoff.ts';

const TASK_RE = /^\s*\[ORCA TASK\s+([^\]\s]+)\]\s*/;
/** The first line the collector types into a fresh CAPCOM (collector/capcom.ts). */
const BRIEF_RE = /^\s*You are online\b/;
const ESC_RE = new RegExp(`^\\s*\\[${ESCALATION_PREFIX}\\s+([^\\]\\s]+)\\]\\s*`);

/** What a prompt is, from the way the hub wrapped it. */
export function classifyPrompt(text: string): { role: TalkRole; taskId?: string; escalationId?: string; text: string } {
  if (text.trimStart().startsWith(HANDOFF_NOTICE_PREFIX)) return { role: 'system', text: text.trimStart().slice(HANDOFF_NOTICE_PREFIX.length).trimStart() };
  const task = TASK_RE.exec(text);
  if (task) return { role: 'task', taskId: task[1]!, text: text.slice(task[0].length) };
  const esc = ESC_RE.exec(text);
  if (esc) return { role: 'fleet', escalationId: esc[1]!, text: text.slice(esc[0].length) };
  if (BRIEF_RE.test(text)) return { role: 'system', text };
  return { role: 'human', text };
}

/**
 * Blocks in, exchanges out. Consecutive assistant blocks fold into one
 * CAPCOM group until the next prompt; a tool result attaches to the step
 * that called it, wherever that step is, and a result whose call is not in
 * the window (it fell off the ring) is dropped rather than shown orphaned.
 */
export function foldTalk(items: readonly TalkItem[]): TalkGroup[] {
  const groups: TalkGroup[] = [];
  const steps = new Map<string, TalkStep>();
  let open: TalkGroup | null = null;

  const capcom = (at: number, id: string): TalkGroup => {
    if (open) return open;
    open = { id: `c:${id}`, role: 'capcom', at, text: '', parts: [] };
    groups.push(open);
    return open;
  };

  for (const it of items) {
    switch (it.kind) {
      case 'prompt': {
        open = null;
        const c = classifyPrompt(it.text);
        const g: TalkGroup = { id: it.id, role: c.role, at: it.at, text: c.text, parts: [] };
        if (c.taskId) g.taskId = c.taskId;
        if (c.escalationId) g.escalationId = c.escalationId;
        groups.push(g);
        break;
      }
      case 'say':
        capcom(it.at, it.id).parts.push({ kind: 'text', id: it.id, at: it.at, text: it.text });
        break;
      case 'thinking': {
        const step: TalkStep = { id: it.id, at: it.at, kind: 'thinking', text: it.text };
        capcom(it.at, it.id).parts.push({ kind: 'step', step });
        break;
      }
      case 'tool': {
        const step: TalkStep = { id: it.id, at: it.at, kind: 'tool', text: it.text };
        if (it.tool) step.tool = it.tool;
        if (it.toolUseId) { step.toolUseId = it.toolUseId; steps.set(it.toolUseId, step); }
        capcom(it.at, it.id).parts.push({ kind: 'step', step });
        break;
      }
      case 'result': {
        const step = it.toolUseId ? steps.get(it.toolUseId) : undefined;
        if (step) step.result = { text: it.text, error: it.error === true, at: it.at };
        break;
      }
    }
  }
  return groups;
}

/** A local echo whose prompt has since arrived from the transcript is done. */
export function echoLanded(text: string, sentAt: number, items: readonly TalkItem[]): boolean {
  const t = text.trim();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.at < sentAt - 60_000) break;
    if (it.kind === 'prompt' && it.text.trim() === t) return true;
  }
  return false;
}

/**
 * A tool's name as a person reads it. `mcp__orca__inspect_squad` is the hub's
 * own tool and reads `inspect_squad`; another server's keeps its name in
 * front (`playwright·browser_click`); a built-in is itself.
 */
export function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return name;
  return m[1] === 'orca' ? m[2]! : `${m[1]!.replace(/^plugin_/, '')}·${m[2]!}`;
}

/** One line for a step, for the live strip and the step row. */
export function stepLabel(step: TalkStep): string {
  if (step.kind === 'thinking') return step.text ? 'thought' : 'thinking';
  return step.tool ? toolLabel(step.tool) : 'tool';
}
