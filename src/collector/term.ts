/**
 * Terminal attachments: the console looking into a pane.
 *
 * One `term:open` becomes one pty running `tmux attach` on the agent's pane;
 * its bytes go up as `term:data`, keystrokes come down as `term:input`. When
 * the window closes, the pty is killed — that detaches this client and
 * nothing else; the agent never notices.
 *
 * What is bounded here, and why:
 *  - attachments per collector, because each is a pty and a tmux client;
 *  - bytes per frame, because a `cat` of a big file would otherwise arrive
 *    as one multi-megabyte websocket frame the hub refuses;
 *  - the reasons an open can fail are said out loud in `term:exit`, since
 *    the console has nothing else to show in an empty black window.
 */

import type { CollectorFrame, TermFrame } from '../shared/protocol.ts';
import { TERM_MAX_CHUNK, TERM_MAX_COLS, TERM_MAX_ROWS, TERM_ID_RE } from '../shared/protocol.ts';
import type { AgentHandle } from './commands.ts';
import type { PaneTty, TmuxHost } from './tmux.ts';
import { log } from './util.ts';

const SCOPE = 'term';
/** Consoles attached at once on one machine. A fleet is looked at, not stared at. */
export const MAX_ATTACHMENTS = 24;
/** Output is coalesced this long so a busy pane is a few frames a second, not hundreds. */
const FLUSH_MS = 16;

interface Attachment {
  termId: string;
  agentId: string;
  pane: string;
  tty: PaneTty;
  buf: string;
  timer: NodeJS.Timeout | null;
  closed: boolean;
}

export interface TerminalDeps {
  tmux: TmuxHost;
  send(frame: CollectorFrame): void;
  inputBlocked?(id: string): boolean;
  agent(id: string): AgentHandle | null;
}

export class TerminalRelay {
  private readonly deps: TerminalDeps;
  private readonly open = new Map<string, Attachment>();

  constructor(deps: TerminalDeps) { this.deps = deps; }

  size(): number { return this.open.size; }

  handle(frame: TermFrame): void {
    switch (frame.t) {
      case 'term:open': this.attach(frame); return;
      case 'term:input': this.input(frame.termId, frame.data); return;
      case 'term:resize': this.resize(frame.termId, frame.cols, frame.rows); return;
      case 'term:close': this.close(frame.termId, 'closed by the console'); return;
      default: return;
    }
  }

  private attach(f: Extract<TermFrame, { t: 'term:open' }>): void {
    const { termId, agentId } = f;
    if (typeof termId !== 'string' || !TERM_ID_RE.test(termId)) return;   // ni nombre tiene: no hay a quién contestar
    const exit = (reason: string): void => { this.deps.send({ t: 'term:exit', termId, reason }); };
    if (this.open.has(termId)) { exit('already attached under that id'); return; }
    if (this.open.size >= MAX_ATTACHMENTS) { exit(`this machine already has ${MAX_ATTACHMENTS} terminals open`); return; }
    const a = typeof agentId === 'string' ? this.deps.agent(agentId) : null;
    if (!a) { exit('unknown agent'); return; }
    if (!a.pane) { exit('no pane: this session was not launched by ORCA, or was launched with --bg'); return; }
    if (!this.deps.tmux.available()) { exit('tmux is not installed on this machine'); return; }

    const cols = clamp(f.cols, 2, TERM_MAX_COLS, 120);
    const rows = clamp(f.rows, 2, TERM_MAX_ROWS, 36);
    const r = this.deps.tmux.attach(a.pane, cols, rows);
    if (!r.ok) { exit(r.detail); return; }

    const att: Attachment = { termId, agentId, pane: a.pane, tty: r.tty, buf: '', timer: null, closed: false };
    this.open.set(termId, att);
    r.tty.onData((data) => this.queue(att, data));
    r.tty.onExit(({ exitCode }) => {
      if (att.closed) return;
      this.flush(att);
      this.drop(att, exitCode === 0 ? 'detached' : `the pane is gone (tmux exited ${exitCode})`);
    });
    log('info', SCOPE, `attach ${termId} → ${a.callsign} (${a.pane}) ${cols}x${rows}`);
  }

  private input(termId: string, data: unknown): void {
    const att = this.open.get(termId);
    if (!att || att.closed || typeof data !== 'string' || !data.length) return;
    if (this.deps.inputBlocked?.(att.agentId)) {
      this.deps.send({ t: 'term:data', termId, data: '\r\nORCA: CAPCOM transfer in progress. Send new messages through TALK; terminal input is paused.\r\n' });
      return;
    }
    // Un frame trae como mucho TERM_MAX_CHUNK; más que eso no es teclado.
    att.tty.write(data.length > TERM_MAX_CHUNK ? data.slice(0, TERM_MAX_CHUNK) : data);
  }

  private resize(termId: string, cols: unknown, rows: unknown): void {
    const att = this.open.get(termId);
    if (!att || att.closed) return;
    try {
      att.tty.resize(clamp(cols, 2, TERM_MAX_COLS, 120), clamp(rows, 2, TERM_MAX_ROWS, 36));
    } catch { /* un resize sobre un pty que acaba de morir: el exit ya viene */ }
  }

  close(termId: string, reason: string): void {
    const att = this.open.get(termId);
    if (!att) return;
    this.flush(att);
    this.drop(att, reason);
  }

  /** Every attachment, on collector shutdown or hub loss: the panes stay, the viewers go. */
  closeAll(reason = 'collector stopping'): void {
    for (const att of [...this.open.values()]) this.drop(att, reason);
  }

  private drop(att: Attachment, reason: string): void {
    if (att.closed) return;
    att.closed = true;
    if (att.timer) { clearTimeout(att.timer); att.timer = null; }
    this.open.delete(att.termId);
    try { att.tty.kill(); } catch { /* ya */ }
    this.deps.send({ t: 'term:exit', termId: att.termId, reason });
    log('info', SCOPE, `detach ${att.termId} (${reason})`);
  }

  private queue(att: Attachment, data: string): void {
    if (att.closed) return;
    att.buf += data;
    if (att.buf.length >= TERM_MAX_CHUNK) { this.flush(att); return; }
    if (!att.timer) {
      att.timer = setTimeout(() => { att.timer = null; this.flush(att); }, FLUSH_MS);
      att.timer.unref?.();
    }
  }

  private flush(att: Attachment): void {
    if (att.timer) { clearTimeout(att.timer); att.timer = null; }
    while (att.buf.length) {
      const chunk = att.buf.slice(0, TERM_MAX_CHUNK);
      att.buf = att.buf.slice(chunk.length);
      this.deps.send({ t: 'term:data', termId: att.termId, data: chunk });
    }
  }
}

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.max(min, Math.min(max, n));
}
