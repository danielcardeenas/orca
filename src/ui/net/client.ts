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
import { store } from '../store.ts';

type AckResolver = { ok: (data: unknown) => void; fail: (why: string) => void; timer: number };

class HubLink {
  private ws: WebSocket | null = null;
  private backoff = 500;
  private acks = new Map<string, AckResolver>();
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
      case 'ceo:message': store.pushCeo(f.message); break;
      case 'ceo:delta':   store.appendCeoDelta(f.id, f.text); break;
      case 'ceo:done':    store.finishCeo(f.id); break;
      case 'ack': {
        const r = this.acks.get(f.cmdId);
        if (!r) break;
        this.acks.delete(f.cmdId);
        window.clearTimeout(r.timer);
        if (f.ok) r.ok(f.data); else r.fail(f.detail ?? 'command failed');
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

  /** Fire a machine command and wait for the collector's ack. */
  cmd(cmd: Command): Promise<unknown> {
    const id = newId('cmd');
    return new Promise((resolve, reject) => {
      if (!this.send({ t: 'cmd', id, cmd })) {
        reject(new Error('not connected'));
        return;
      }
      const timer = window.setTimeout(() => {
        this.acks.delete(id);
        reject(new Error('command timed out'));
      }, 30_000);
      this.acks.set(id, { ok: resolve, fail: (w) => reject(new Error(w)), timer });
    });
  }

  say(text: string) { this.send({ t: 'ceo:say', text }); }

  answer(id: string, answer: string, rememberAs: string | null) {
    this.send({ t: 'escalation:answer', id, answer, rememberAs });
  }

  dismiss(id: string) { this.send({ t: 'escalation:dismiss', id }); }

  resync() { this.send({ t: 'resync' }); }

  close() { this.closed = true; this.ws?.close(); }
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
