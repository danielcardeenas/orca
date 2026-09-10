/**
 * Console → hub link.
 *
 * Reconnects forever with backoff. A dropped link is a visible condition in
 * this world, not a silent failure: the HUD desaturates and the telemetry
 * strip says so, because an operator staring at a frozen fleet needs to know
 * whether the fleet is calm or the wire is dead.
 */

import type { ClientFrame, Command, ServerFrame } from '../../shared/protocol.ts';
import { CLOSE_UNAUTHORIZED, PROTOCOL_VERSION, newId } from '../../shared/protocol.ts';
import type { ArchiveFilter, ArchiveOutcome } from '../../shared/archive.ts';
import { MISSION_ID_PREFIX } from '../../shared/missions.ts';
import { store, type OutgoingMessage } from '../store.ts';

type AckResolver = { ok: (data: unknown) => void; fail: (why: string) => void; timer: number };
/** A window looking into a pane: bytes in, and the one reason the stream ended. */
export interface TermSink { data(chunk: string): void; exit(reason: string): void }

/** Lo que contesta cualquier petición de AUTOMEJORA: el tablero y el porqué del reloj. */
export interface ImproveWire {
  state: import('../../shared/improve.ts').ImproveState;
  verdict: import('../../shared/improve.ts').DueVerdict;
  /** Con qué nacería el próximo revisor, ya resuelto por el hub. */
  choice: ReturnType<typeof import('../../shared/improve.ts').effectiveChoice>;
  /** La máquina a la que pedirle el catálogo de modelos. */
  machineId: string | null;
}

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
      /*
       * El enlace NO está arriba porque el socket haya abierto.
       *
       * Abre siempre —cualquiera puede abrir un socket contra el hub— y sólo
       * después el hello dice quién eres. Con un token inválido el hub cierra
       * acto seguido, y dar el enlace por bueno aquí producía un ciclo entero
       * de «LINK UP» por intento: el destello lima de reconexión y su sonido,
       * cada pocos segundos, para siempre. El enlace se declara cuando el hub
       * CONTESTA (`markUp`, en `handle`), que es cuando de verdad lo hay.
       */
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

    ws.onclose = (ev) => {
      window.clearInterval(this.beat);
      store.setLink(false);
      /*
       * Un cierre por credenciales no es una caída: reintentar no lo arregla
       * y la consola no puede pedirle nada al hub hasta que alguien cambie el
       * token. Se dice una vez y se queda dicho —la pantalla de handshake— en
       * lugar de parpadear una reconexión cada pocos segundos.
       */
      if (ev.code === CLOSE_UNAUTHORIZED) store.setAuth(false);
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
    // El hub ha contestado: hay enlace, y el token valía. Las dos cosas se
    // saben por lo mismo —una trama que llega— y no por el socket abierto.
    store.setLink(true);
    store.setAuth(true);
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
      case 'mission': store.upsertMission(f.mission, f.purged === true); break;
      case 'hygiene': store.putHygiene(f.reports); break;
      case 'improve': store.putImprove(f.state, f.verdict, { choice: f.choice, machineId: f.machineId }); break;
      case 'server': store.putServer(f.rev, f.stale, f.restartable); break;
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
    const missionId = (frame.t === 'ceo:say' || frame.t === 'mission:say') && frame.missionId ? frame.missionId : null;
    const message: OutgoingMessage = { id, agentId, text, at: Date.now(), status: 'sending', ...(missionId ? { missionId } : {}) };
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

  /* ── AUTOMEJORA ─────────────────────────────────────────────────── */

  /**
   * El tablero de auto-revisión. Se pide al montar el panel; a partir de ahí
   * los cambios llegan solos como `t:'improve'`, igual que la higiene.
   */
  improve(): Promise<ImproveWire> {
    const id = newId('cmd');
    return this.request(id, { t: 'improve:get', id }) as Promise<ImproveWire>;
  }

  /** Lanza una revisión ahora. El rechazo trae el motivo, y se enseña. */
  improveRun(): Promise<ImproveWire & { ok: boolean; reason: string }> {
    const id = newId('cmd');
    return this.request(id, { t: 'improve:run', id }) as Promise<ImproveWire & { ok: boolean; reason: string }>;
  }

  /** Para la revisión en vuelo: mata al revisor y deja el hueco libre. */
  improveCancel(): Promise<ImproveWire & { ok: boolean; reason: string }> {
    const id = newId('cmd');
    return this.request(id, { t: 'improve:cancel', id }) as Promise<ImproveWire & { ok: boolean; reason: string }>;
  }

  improveAct(proposalId: string, act: 'reply' | 'snooze' | 'dismiss' | 'reopen' | 'seen', opts: { text?: string; untilMs?: number } = {}): Promise<ImproveWire> {
    const id = newId('cmd');
    return this.request(id, { t: 'improve:act', id, proposalId, act, ...opts }) as Promise<ImproveWire>;
  }

  /** Apaga el aviso. Sin ids, el de todas las novedades. */
  improveSeen(proposalIds?: string[]): Promise<ImproveWire> {
    const id = newId('cmd');
    return this.request(id, { t: 'improve:seen', id, ...(proposalIds ? { proposalIds } : {}) }) as Promise<ImproveWire>;
  }

  /**
   * Manda una propuesta a CAPCOM. El id de misión se acuña aquí, como en
   * `createMission`: el hub se niega si la propuesta ya tiene una, así que un
   * segundo clic no abre una segunda misión.
   */
  /**
   * IMPLEMENT: abre la misión y lanza al implementador. `launched` trae su
   * callsign; `saved` dice por qué no se pudo lanzar, con la misión escrita.
   */
  improveSend(proposalId: string): Promise<ImproveWire & { missionId: string; delivery: 'launched' | 'saved'; callsign?: string }> {
    const id = newId('cmd');
    return this.request(id, { t: 'improve:send', id, proposalId, missionId: newId(MISSION_ID_PREFIX) }) as
      Promise<ImproveWire & { missionId: string; delivery: 'launched' | 'saved'; callsign?: string }>;
  }

  improveConfig(patch: Partial<import('../../shared/improve.ts').ImproveConfig & { budgetTokens: number; runtime: string | null; model: string | null }>): Promise<ImproveWire> {
    const id = newId('cmd');
    return this.request(id, { t: 'improve:config', id, patch }) as Promise<ImproveWire>;
  }

  /** El catálogo de modelos de una máquina: los alias de Claude y el caché de Codex. */
  models(machineId: string): Promise<import('../../shared/provider-handoff.ts').ProviderModel[]> {
    return this.cmd({ k: 'models:list', machineId }) as Promise<import('../../shared/provider-handoff.ts').ProviderModel[]>;
  }

  createMission(title = 'New mission'): Promise<import('../../shared/missions.ts').CapcomMission> {
    const id = newId('cmd');
    return this.request(id, { t: 'mission:create', id, missionId: newId(MISSION_ID_PREFIX), title }) as Promise<import('../../shared/missions.ts').CapcomMission>;
  }

  archiveMission(missionId: string, on = true): Promise<import('../../shared/missions.ts').CapcomMission> {
    const id = newId('cmd');
    return this.request(id, { t: 'mission:archive', id, missionId, on }) as Promise<import('../../shared/missions.ts').CapcomMission>;
  }

  /**
   * El parte de una misión. Se pide al abrirlo, no llega solo: ver
   * `mission:debrief` en shared/protocol.ts.
   */
  missionDebrief(missionId: string): Promise<import('../../shared/debrief.ts').MissionDebrief> {
    const id = newId('cmd');
    return this.request(id, { t: 'mission:debrief', id, missionId }) as Promise<import('../../shared/debrief.ts').MissionDebrief>;
  }

  purgeMission(missionId: string): Promise<{ purged: string }> {
    const id = newId('cmd');
    return this.request(id, { t: 'mission:purge', id, missionId }) as Promise<{ purged: string }>;
  }

  say(text: string, missionId: string | undefined = store.activeMissionId ?? undefined) {
    const id = newId('cmd');
    // Every entry point shares the same visible delivery history. Failures are
    // recorded there, including sends from the global command line.
    void this.message(id, null, text, { t: 'ceo:say', id, text, ...(missionId ? { missionId } : {}) }).catch(() => {});
  }

  /**
   * Una línea EN una misión, desde su ventana. El hub elige el destinatario
   * —el líder si está en pie, CAPCOM si no— con la misma regla que la ventana
   * enseña (`missionLeadOf`), y el ack dice a quién fue. El eco se registra
   * con `missionId` para que la ventana lo pinte en su sitio mientras vuela.
   */
  missionSay(missionId: string, text: string): Promise<{ to: 'lead' | 'capcom'; callsign?: string; delivery?: string }> {
    const id = newId('cmd');
    return this.message(id, null, text, { t: 'mission:say', id, missionId, text }) as
      Promise<{ to: 'lead' | 'capcom'; callsign?: string; delivery?: string }>;
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

  /**
   * Un lote de gestos de la interfaz para AUTOMEJORA. Sin ack: devuelve si
   * salió por el cable, y quien lo manda conserva el lote si no salió.
   */
  gestures(counts: Record<string, number>): boolean { return this.send({ t: 'gestures', counts }); }

  /**
   * Pide el relevo del hub y de los collectors supervisados.
   *
   * Sin ack y sin promesa: lo que contestaría se está muriendo. Quien confirma
   * es el enlace, cayéndose y volviendo. Ver hud/update.ts.
   */
  restart() { this.send({ t: 'restart' }); }

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

/**
 * Sube un archivo del operador al disco del hub y devuelve dónde quedó.
 *
 * Es HTTP y no el socket porque un archivo son bytes, no un frame; misma
 * puerta que `/api/artifact`: el token va en la URL. El nombre viaja en una
 * cabecera percent-encoded (una cabecera no lleva UTF-8) y el hub lo sanea.
 * Ver hub/uploads.ts y windows/attach.ts.
 */
export async function uploadFile(file: File): Promise<{ path: string; bytes: number }> {
  const res = await fetch(authedUrl('/api/uploads')!, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-orca-name': encodeURIComponent(file.name) },
    body: file,
  });
  const body = await res.json().catch(() => ({})) as { path?: string; bytes?: number; error?: string };
  if (!res.ok || !body.path) throw new Error(body.error ?? `HTTP ${res.status}`);
  return { path: body.path, bytes: body.bytes ?? file.size };
}

/** Can this hub transcribe, and with what. `ready: false` carries the reason in the operator's terms. */
export async function transcribeStatus(): Promise<{ ready: boolean; reason: string; model: string | null }> {
  try {
    const res = await fetch(authedUrl('/api/transcribe')!, { cache: 'no-store' });
    const body = await res.json() as { ready?: boolean; reason?: string; model?: string | null; error?: string };
    if (!res.ok) return { ready: false, reason: body.error ?? `HTTP ${res.status}`, model: null };
    return { ready: !!body.ready, reason: body.reason ?? '', model: body.model ?? null };
  } catch { return { ready: false, reason: 'hub unreachable', model: null }; }
}

/**
 * What the operator said, as 16 kHz mono WAV (`ui/audio.ts`), to whisper.cpp
 * on the hub, which hears it with the fleet's names in its prompt.
 */
export async function transcribeAudio(wav: ArrayBuffer, lang: string): Promise<{ text: string; ms: number }> {
  const res = await fetch(authedUrl(`/api/transcribe?lang=${encodeURIComponent(lang)}`)!, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
  });
  const body = await res.json().catch(() => ({})) as { text?: string; ms?: number; error?: string };
  if (!res.ok || typeof body.text !== 'string') throw new Error(body.error ?? `HTTP ${res.status}`);
  return { text: body.text, ms: body.ms ?? 0 };
}

export const hub = new HubLink();
