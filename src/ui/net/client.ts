/**
 * Console → hub link.
 *
 * Reconnects forever with backoff. A dropped link is a visible condition in
 * this world, not a silent failure: the HUD desaturates and the telemetry
 * strip says so, because an operator staring at a frozen fleet needs to know
 * whether the fleet is calm or the wire is dead.
 */

import type { ClientFrame, Command, ServerFrame } from '../../shared/protocol.ts';
import { PROTOCOL_VERSION, newId } from '../../shared/protocol.ts';
import type { ArchiveFilter, ArchiveOutcome } from '../../shared/archive.ts';
import { store, type OutgoingMessage } from '../store.ts';

type AckResolver = { ok: (data: unknown) => void; fail: (why: string) => void; timer: number };
/** A window looking into a pane: bytes in, and the one reason the stream ended. */
export interface TermSink { data(chunk: string): void; exit(reason: string): void }

class HubLink {
  private ws: WebSocket | null = null;
  private backoff = 500;
  private acks = new Map<string, AckResolver>();
  private terms = new Map<string, TermSink>();
  private beat = 0;
  private closed = false;

  connect() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/console`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      store.setLink(true);
      this.send({ t: 'hello', v: PROTOCOL_VERSION, token: token() });
      this.beat = window.setInterval(() => this.send({ t: 'beat' }), 10_000);
    };

    ws.onmessage = (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(ev.data as string) as ServerFrame;
      } catch {
        return; // a malformed frame is not worth dropping the link over
      }
      this.handle(frame);
    };

    ws.onclose = () => {
      window.clearInterval(this.beat);
      store.setLink(false);
      this.failAllAcks('link dropped');
      // A terminal cannot survive the link: its pty is gone on the far side.
      for (const [id, sink] of this.terms) { this.terms.delete(id); sink.exit('link dropped'); }
      this.retry();
    };

    ws.onerror = () => { /* onclose always follows; handle it there */ };
  }

  private retry() {
    if (this.closed) return;
    // Jitter keeps a fleet of reopened tabs from stampeding the hub.
    const wait = this.backoff + Math.random() * this.backoff * 0.4;
    this.backoff = Math.min(this.backoff * 1.8, 20_000);
    window.setTimeout(() => this.connect(), wait);
  }

  private handle(f: ServerFrame) {
    switch (f.t) {
      case 'world':
        store.replaceWorld(f.state);
        break;
      case 'patch':
        // A gap in rev means we missed a frame; ask for the whole world rather
        // than render a torn one.
        if (f.rev !== store.world.rev + 1 && store.world.rev !== 0) {
          this.send({ t: 'resync' });
          break;
        }
        store.applyPatch(f.rev, f.ops);
        break;
      case 'task': store.upsertTask(f.task, f.purged === true); break;
      case 'hygiene': store.putHygiene(f.reports); break;
      case 'ceo:message': store.pushCeo(f.message); break;
      case 'ceo:delta':   store.appendCeoDelta(f.id, f.text); break;
      case 'ceo:done':    store.finishCeo(f.id); break;
      case 'camera':      store.camera(f.directive); break;
      case 'ack': {
        const r = this.acks.get(f.cmdId);
        if (!r) break;
        this.acks.delete(f.cmdId);
        window.clearTimeout(r.timer);
        if (f.ok) r.ok(f.data); else r.fail(f.detail ?? 'command failed');
        break;
      }
      case 'term:data': this.terms.get(f.termId)?.data(f.data); break;
      case 'term:exit': {
        const sink = this.terms.get(f.termId);
        if (!sink) break;
        this.terms.delete(f.termId);
        sink.exit(f.reason);
        break;
      }
      case 'error':
        console.error('[hub]', f.message);
        break;
    }
  }

  private send(f: ClientFrame) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(f));
    return true;
  }

  private failAllAcks(why: string) {
    for (const [, r] of this.acks) {
      window.clearTimeout(r.timer);
      r.fail(why);
    }
    this.acks.clear();
  }

  /* ── Public surface ─────────────────────────────────────────────── */

  /** Register before sending, so even an immediate ack has a waiter. */
  private request(id: string, frame: ClientFrame): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.acks.delete(id);
        reject(new Error('Delivery unconfirmed: timed out. Check the agent before resending.'));
      }, 30_000);
      this.acks.set(id, { ok: resolve, fail: (w) => reject(new Error(w)), timer });
      if (!this.send(frame)) {
        window.clearTimeout(timer);
        this.acks.delete(id);
        reject(new Error('not connected'));
      }
    });
  }

  private async message(id: string, agentId: string | null, text: string, frame: ClientFrame): Promise<unknown> {
    const message: OutgoingMessage = { id, agentId, text, at: Date.now(), status: 'sending', ...(frame.t === 'ceo:say' && frame.taskId ? { taskId: frame.taskId } : {}) };
    store.recordOutgoing(message);
    try {
      const data = await this.request(id, frame);
      const accepted = (data as { delivery?: string } | null)?.delivery === 'accepted';
      store.recordOutgoing({ ...message, status: accepted ? 'accepted' : 'delivered', elapsedMs: Date.now() - message.at });
      return data;
    } catch (err) {
      store.recordOutgoing({ ...message, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  cmd(cmd: Command): Promise<unknown> {
    const id = newId('cmd');
    return cmd.k === 'say'
      ? this.message(id, cmd.agentId, cmd.text, { t: 'cmd', id, cmd })
      : this.request(id, { t: 'cmd', id, cmd });
  }

  /**
   * Archive finished agents on the hub — for every console, not just this
   * one. `dryRun` answers what would go and changes nothing.
   */
  archive(filter: ArchiveFilter, dryRun = false): Promise<ArchiveOutcome> {
    const id = newId('cmd');
    return this.request(id, { t: 'agents:archive', id, filter, dryRun }) as Promise<ArchiveOutcome>;
  }

  /**
   * The fleet's hygiene: what ORCA costs each machine. `refresh` asks every
   * collector for a fresh sample first — new reports then arrive on their own
   * as `t:'hygiene'` pushes, so this resolves without waiting for any disk.
   */
  hygiene(refresh = false): Promise<{ reports: import('../../shared/hygiene.ts').HygieneReport[]; asked: number }> {
    const id = newId('cmd');
    return this.request(id, { t: 'hygiene:get', id, ...(refresh ? { refresh: true } : {}) }) as
      Promise<{ reports: import('../../shared/hygiene.ts').HygieneReport[]; asked: number }>;
  }

  createTask(title = 'New task'): Promise<import('../../shared/tasks.ts').CapcomTask> {
    const id = newId('cmd');
    return this.request(id, { t: 'task:create', id, taskId: newId('task'), title }) as Promise<import('../../shared/tasks.ts').CapcomTask>;
  }

  archiveTask(taskId: string, on = true): Promise<import('../../shared/tasks.ts').CapcomTask> {
    const id = newId('cmd');
    return this.request(id, { t: 'task:archive', id, taskId, on }) as Promise<import('../../shared/tasks.ts').CapcomTask>;
  }

  purgeTask(taskId: string): Promise<{ purged: string }> {
    const id = newId('cmd');
    return this.request(id, { t: 'task:purge', id, taskId }) as Promise<{ purged: string }>;
  }

  say(text: string, taskId: string | undefined = store.activeTaskId ?? undefined) {
    const id = newId('cmd');
    // Every entry point shares the same visible delivery history. Failures are
    // recorded there, including sends from the global command line.
    void this.message(id, null, text, { t: 'ceo:say', id, text, ...(taskId ? { taskId } : {}) }).catch(() => {});
  }

  /* ── Terminals ──────────────────────────────────────────────────── */

  /**
   * Attach to an agent's pane. Returns a handle the window writes into; the
   * hub answers with bytes on `sink.data` and, once, with `sink.exit`. The id
   * is minted here so the window can name the stream before the first byte.
   */
  termOpen(agentId: string, cols: number, rows: number, sink: TermSink): TermHandle {
    const termId = newId('term');
    this.terms.set(termId, sink);
    if (!this.send({ t: 'term:open', termId, agentId, cols, rows })) {
      this.terms.delete(termId);
      window.setTimeout(() => sink.exit('not connected'), 0);
    }
    return {
      id: termId,
      input: (data) => { if (data.length) this.send({ t: 'term:input', termId, data }); },
      resize: (c, r) => { this.send({ t: 'term:resize', termId, cols: c, rows: r }); },
      close: () => {
        if (!this.terms.delete(termId)) return;
        this.send({ t: 'term:close', termId });
      },
    };
  }

  answer(id: string, answer: string, rememberAs: string | null) {
    this.send({ t: 'escalation:answer', id, answer, rememberAs });
  }

  dismiss(id: string) { this.send({ t: 'escalation:dismiss', id }); }

  resync() { this.send({ t: 'resync' }); }

  close() { this.closed = true; this.ws?.close(); }
}

export interface TermHandle {
  id: string;
  input(data: string): void;
  resize(cols: number, rows: number): void;
  /** Detach. The pane keeps running; only this viewer leaves. */
  close(): void;
}

/**
 * The console token. Read from the URL once (?k=…) and kept in localStorage so
 * the link survives a reload without the secret sitting in the address bar.
 */
function token(): string {
  const u = new URL(location.href);
  const fromUrl = u.searchParams.get('k');
  if (fromUrl) {
    try { localStorage.setItem('orca.token', fromUrl); } catch { /* private mode */ }
    u.searchParams.delete('k');
    history.replaceState(null, '', u.toString());
    return fromUrl;
  }
  try { return localStorage.getItem('orca.token') ?? ''; } catch { return ''; }
}

/**
 * `/api/artifact/<id>` is authenticated like the socket. A hub with a token
 * wants it on the URL, since an <img> cannot send a header.
 */
export function authedUrl(url: string | null): string | null {
  if (!url) return null;
  const t = token();
  if (!t || url.includes('token=')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}`;
}

export const hub = new HubLink();
