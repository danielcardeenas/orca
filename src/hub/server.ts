/**
 * ORCA hub — servidor HTTP + WebSocket.
 *
 *   collector ──(ws saliente)──▶ /ws/collector ─┐
 *                                               ├── World ── PatchBus ──▶ /ws/console
 *   console   ──(ws)──────────▶ /ws/console  ───┘
 *
 * Todas las conexiones son salientes desde los collectors: el Mac tras NAT y el
 * VPS tras firewall son ciudadanos idénticos, y sólo este proceso necesita un
 * puerto abierto.
 *
 * Reglas de aislamiento: un cliente que manda basura se lleva su propio error y
 * nada más. Cada handler va envuelto; un JSON inválido responde {t:'error'} a
 * ese socket y sigue. Un collector caído marca su máquina offline y deja los
 * registros para que el humano vea qué murió.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';

import type { CeoMessage } from '../shared/types.ts';
import type {
  ClientFrame, CollectorFrame, Command, CommandFrame, PatchOp, ServerFrame,
} from '../shared/protocol.ts';
import { PATHS, PORTS, PROTOCOL_VERSION, newId } from '../shared/protocol.ts';

import { World } from './world.ts';
import type { WorldEvent } from './world.ts';
import { PatchBus } from './bus.ts';
import type { PatchFrame } from './bus.ts';
import { CLOSE_BAD_HELLO, CLOSE_BAD_VERSION, CLOSE_UNAUTHORIZED, createAuth } from './auth.ts';
import type { Auth } from './auth.ts';
import { HubStore } from './persist.ts';
import { AnswerMemory, MEMORY_FILE } from './memory.ts';

/* ── constantes de operación ──────────────────────────────────────── */

/** Un socket que no dice `hello` a tiempo no es un cliente, es ruido. */
const HELLO_TIMEOUT_MS = 8_000;
/** Un comando sin ack en 30 s se declara fallido y se contesta ok:false. */
const CMD_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 15_000;
const SWEEP_INTERVAL_MS = 2_000;
/** Si una consola acumula esto en el buffer, dejó de leer: no la ahogamos más. */
const MAX_BUFFERED = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/* ── tipos internos ───────────────────────────────────────────────── */

interface Conn {
  id: string;
  ws: WebSocket;
  remote: string;
  alive: boolean;
  authed: boolean;
  helloTimer: ReturnType<typeof setTimeout> | null;
}

interface CollectorConn extends Conn {
  machineId: string | null;
}

interface ConsoleConn extends Conn {
  /** true cuando se le debe reenviar el mundo entero en el próximo flush. */
  needsWorld: boolean;
}

interface Pending {
  cmdId: string;
  consoleId: string | null;
  machineId: string;
  timer: ReturnType<typeof setTimeout>;
  at: number;
  kind: string;
}

export interface HubOptions {
  port?: number;
  host?: string;
  auth?: Auth;
  store?: HubStore;
  memory?: AnswerMemory;
  hz?: number;
  /** Silencia el log; los tests lo agradecen. */
  quiet?: boolean;
  /**
   * Gancho para el runtime del CEO, que vive fuera del hub. Si no está, el hub
   * guarda el mensaje del humano y contesta que no hay CEO conectado.
   */
  onCeoSay?: (text: string, hub: Hub) => void;
  /**
   * Un agente hizo una pregunta. El runtime del CEO la intercepta aquí e
   * intenta contestarla antes de que llegue al humano; si no hay runtime, la
   * pregunta va directa a la cola de interrupciones, que es el comportamiento
   * correcto sin CEO — nunca se pierde.
   */
  onEscalation?: (escalationId: string, hub: Hub) => void;
}

export interface Hub {
  world: World;
  bus: PatchBus;
  store: HubStore;
  memory: AnswerMemory;
  auth: Auth;
  http: Server;
  port: number;
  url: string;
  /** Publica un mensaje del CEO a todas las consolas y lo persiste. */
  pushCeoMessage(msg: CeoMessage): void;
  /**
   * Lanza un comando desde dentro del proceso y espera su ack. Es el canal del
   * runtime del CEO, que no es una consola y no tiene a quién devolverle un
   * frame de ack.
   */
  dispatch(cmd: Command): Promise<unknown>;
  /**
   * Responde una escalación desde dentro del proceso — es como el CEO contesta
   * a un agente sin pasar por una consola. Mismo camino que la respuesta
   * humana: cierra el registro, la manda al agente, y la guarda si procede.
   */
  answerEscalationLocal(id: string, answer: string, by: 'human' | 'ceo'): void;
  broadcast(frame: ServerFrame): void;
  counts(): { collectors: number; consoles: number; pending: number };
  close(): Promise<void>;
}

/* ── utilidades ───────────────────────────────────────────────────── */

function parseFrame(data: RawData): unknown {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  if (text.length > MAX_FRAME_BYTES) throw new Error('frame demasiado grande');
  return JSON.parse(text);
}

function remoteOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? '';
}

function tokenFromRequest(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://hub.local');
  const q = url.searchParams.get('token');
  if (q) return q;
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const x = req.headers['x-orca-token'];
  if (typeof x === 'string' && x.length > 0) return x;
  return null;
}

/** Nunca logueamos el valor de una credencial: sólo la forma del comando. */
function describeCommand(cmd: Command): string {
  switch (cmd.k) {
    case 'spawn': return `spawn ${cmd.projectId}`;
    case 'say': return `say ${cmd.agentId}`;
    case 'permit': return `permit ${cmd.agentId} allow=${cmd.allow}`;
    case 'stop': return `stop ${cmd.agentId}`;
    case 'resume': return `resume ${cmd.agentId}`;
    case 'remove': return `remove ${cmd.agentId}`;
    case 'answer': return `answer ${cmd.escalationId}`;
    case 'key:set': return `key:set ${cmd.projectId}/${cmd.name} (valor omitido)`;
    case 'key:remove': return `key:remove ${cmd.projectId}/${cmd.name}`;
    case 'resync': return 'resync';
    case 'logs': return `logs ${cmd.agentId}`;
    default: return 'desconocido';
  }
}

function isCommand(v: unknown): v is Command {
  if (typeof v !== 'object' || v === null) return false;
  const k = (v as { k?: unknown }).k;
  return typeof k === 'string' && [
    'spawn', 'say', 'permit', 'stop', 'resume', 'remove',
    'answer', 'key:set', 'key:remove', 'resync', 'logs',
  ].includes(k);
}

/* ── el hub ───────────────────────────────────────────────────────── */

export async function startHub(options: HubOptions = {}): Promise<Hub> {
  const quiet = options.quiet ?? false;
  const log = (...args: unknown[]): void => { if (!quiet) console.log('[hub]', ...args); };
  const warn = (...args: unknown[]): void => { if (!quiet) console.warn('[hub]', ...args); };

  const auth = options.auth ?? createAuth();
  const store = options.store ?? new HubStore();
  const mem = options.memory ?? new AnswerMemory(MEMORY_FILE);

  const collectors = new Map<string, CollectorConn>();   // machineId → conn
  const orphanCollectors = new Set<CollectorConn>();     // aún sin hello
  const consoles = new Set<ConsoleConn>();
  const pending = new Map<string, Pending>();

  /* ── mundo + bus ────────────────────────────────────────────────── */

  const world = new World({
    onOps: (ops: PatchOp[]) => bus.push(ops),
    onEvent: (ev: WorldEvent) => {
      store.logEvent(ev);
      const escId = ev.kind === 'escalation:new'
        ? (ev.data as { id?: string } | undefined)?.id
        : undefined;
      if (escId && options.onEscalation) {
        // Fuera del camino crítico: el mundo no espera al CEO para publicar.
        queueMicrotask(() => {
          try { options.onEscalation!(escId, hub); }
          catch (err) { warn('onEscalation falló:', err); }
        });
      }
    },
    onOverflow: (kind, items) => store.overflow(kind, items),
  });

  const bus = new PatchBus({
    hz: options.hz ?? 10,
    onBeforeFlush: () => { world.settle(); },
    onFlush: (frame: PatchFrame) => publishPatch(frame),
  });

  // La conversación con el CEO sobrevive a los reinicios del hub.
  const priorCeo = store.loadCeo();
  if (priorCeo.length > 0) {
    world.hydrateCeo(priorCeo);
    log(`conversación del CEO recuperada: ${priorCeo.length} mensajes`);
  }

  /* ── envío ──────────────────────────────────────────────────────── */

  function send(conn: Conn, frame: ServerFrame | CommandFrame): boolean {
    if (conn.ws.readyState !== WebSocket.OPEN) return false;
    try {
      conn.ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      warn('envío falló a', conn.id, err);
      return false;
    }
  }

  function sendWorld(conn: ConsoleConn): void {
    conn.needsWorld = false;
    send(conn, { t: 'world', state: world.snapshot(bus.rev) });
  }

  function publishPatch(frame: PatchFrame): void {
    if (consoles.size === 0) return;
    const payload = JSON.stringify({ t: 'patch', rev: frame.rev, ops: frame.ops } satisfies ServerFrame);
    for (const conn of consoles) {
      if (!conn.authed || conn.ws.readyState !== WebSocket.OPEN) continue;
      if (conn.needsWorld) { sendWorld(conn); continue; }
      if (conn.ws.bufferedAmount > MAX_BUFFERED) {
        // Dejó de leer: cortamos el goteo y le mandaremos el mundo entero
        // cuando el buffer baje. Es más barato que acumular ops para siempre.
        conn.needsWorld = true;
        continue;
      }
      try { conn.ws.send(payload); } catch { conn.needsWorld = true; }
    }
  }

  function broadcast(frame: ServerFrame): void {
    const payload = JSON.stringify(frame);
    for (const conn of consoles) {
      if (!conn.authed || conn.ws.readyState !== WebSocket.OPEN) continue;
      try { conn.ws.send(payload); } catch { /* aislado */ }
    }
  }

  /* ── enrutado de comandos ───────────────────────────────────────── */

  /** A qué máquina pertenece un comando, mirando el mundo. */
  function targetOf(cmd: Command): { machineId: string | null; broadcast: boolean; error?: string } {
    switch (cmd.k) {
      case 'resync':
        return { machineId: null, broadcast: true };
      case 'spawn':
      case 'key:set':
      case 'key:remove': {
        const p = world.state.projects[cmd.projectId];
        return p ? { machineId: p.machineId, broadcast: false }
          : { machineId: null, broadcast: false, error: `proyecto desconocido: ${cmd.projectId}` };
      }
      case 'answer': {
        const e = world.state.escalations[cmd.escalationId];
        return e ? { machineId: e.machineId, broadcast: false }
          : { machineId: null, broadcast: false, error: `escalación desconocida: ${cmd.escalationId}` };
      }
      default: {
        const a = world.state.agents[cmd.agentId];
        return a ? { machineId: a.machineId, broadcast: false }
          : { machineId: null, broadcast: false, error: `agente desconocido: ${cmd.agentId}` };
      }
    }
  }

  /** Comandos lanzados dentro del proceso (el CEO), esperando su ack. */
  const localWaiters = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  function ackTo(consoleId: string | null, cmdId: string, ok: boolean, detail?: string, data?: unknown): void {
    const waiter = localWaiters.get(cmdId);
    if (waiter) {
      localWaiters.delete(cmdId);
      if (ok) waiter.resolve(data ?? { ok: true, detail });
      else waiter.reject(new Error(detail ?? 'command failed'));
      return;
    }
    if (!consoleId) return;
    for (const conn of consoles) {
      if (conn.id !== consoleId) continue;
      send(conn, { t: 'ack', cmdId, ok, ...(detail !== undefined ? { detail } : {}), ...(data !== undefined ? { data } : {}) });
      return;
    }
  }

  function dispatchCommand(cmdId: string, cmd: Command, consoleId: string | null): void {
    const target = targetOf(cmd);
    if (target.error) { ackTo(consoleId, cmdId, false, target.error); return; }

    if (target.broadcast) {
      let sent = 0;
      for (const conn of collectors.values()) {
        if (send(conn, { t: 'cmd', id: `${cmdId}#${conn.machineId}`, cmd })) sent += 1;
      }
      ackTo(consoleId, cmdId, sent > 0, `resync a ${sent} máquina(s)`);
      return;
    }

    const machineId = target.machineId;
    const conn = machineId ? collectors.get(machineId) : undefined;
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      ackTo(consoleId, cmdId, false, `máquina no conectada: ${machineId ?? '?'}`);
      return;
    }
    if (!send(conn, { t: 'cmd', id: cmdId, cmd })) {
      ackTo(consoleId, cmdId, false, 'no pude enviar al collector');
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(cmdId);
      ackTo(consoleId, cmdId, false, `timeout ${CMD_TIMEOUT_MS / 1000}s sin ack`);
    }, CMD_TIMEOUT_MS);
    timer.unref?.();
    pending.set(cmdId, { cmdId, consoleId, machineId: machineId ?? '', timer, at: Date.now(), kind: cmd.k });
    store.logEvent({ at: Date.now(), kind: 'cmd', machineId: machineId ?? undefined, text: describeCommand(cmd) });
  }

  function resolveAck(cmdId: string, ok: boolean, detail?: string, data?: unknown): void {
    const p = pending.get(cmdId);
    if (!p) return;      // ack tardío o de un resync broadcast: se ignora
    clearTimeout(p.timer);
    pending.delete(cmdId);
    ackTo(p.consoleId, cmdId, ok, detail, data);
  }

  /* ── collectors ─────────────────────────────────────────────────── */

  function acceptCollector(ws: WebSocket, req: IncomingMessage): void {
    const conn: CollectorConn = {
      id: newId('col'), ws, remote: remoteOf(req), alive: true,
      authed: false, helloTimer: null, machineId: null,
    };
    orphanCollectors.add(conn);
    const queryToken = tokenFromRequest(req);

    conn.helloTimer = setTimeout(() => {
      if (!conn.authed) { warn('collector sin hello, cerrando'); ws.close(CLOSE_BAD_HELLO, 'sin hello'); }
    }, HELLO_TIMEOUT_MS);
    conn.helloTimer.unref?.();

    ws.on('pong', () => { conn.alive = true; });

    ws.on('message', (data) => {
      let frame: CollectorFrame;
      try {
        frame = parseFrame(data) as CollectorFrame;
        if (typeof frame !== 'object' || frame === null || typeof frame.t !== 'string') {
          throw new Error('frame sin tipo');
        }
      } catch (err) {
        warn('collector mandó basura:', String(err));
        return;                      // aislado: no tumba a nadie más
      }

      try {
        if (!conn.authed) {
          if (frame.t !== 'hello') { ws.close(CLOSE_BAD_HELLO, 'se esperaba hello'); return; }
          const result = auth.check(frame.token || queryToken, conn.remote);
          if (!result.ok) {
            warn(`collector rechazado desde ${conn.remote}: ${result.reason}`);
            ws.close(CLOSE_UNAUTHORIZED, 'no autorizado');
            return;
          }
          if (frame.v !== PROTOCOL_VERSION) {
            warn(`collector con protocolo v${frame.v}, hub habla v${PROTOCOL_VERSION}`);
            ws.close(CLOSE_BAD_VERSION, `protocolo v${PROTOCOL_VERSION}`);
            return;
          }
          const machineId = frame.machine?.id;
          if (typeof machineId !== 'string' || machineId.length === 0) {
            ws.close(CLOSE_BAD_HELLO, 'hello sin machine.id');
            return;
          }
          // Reconexión: la conexión vieja de esa máquina se descarta.
          const previous = collectors.get(machineId);
          if (previous && previous !== conn) {
            previous.machineId = null;      // que su cierre no marque offline
            try { previous.ws.close(4009, 'reemplazado'); } catch { /* ya estaba muerto */ }
          }
          conn.authed = true;
          conn.machineId = machineId;
          if (conn.helloTimer) { clearTimeout(conn.helloTimer); conn.helloTimer = null; }
          orphanCollectors.delete(conn);
          collectors.set(machineId, conn);
          world.applyCollector(frame, machineId);
          if (result.anonymous) warn(`collector ${machineId} aceptado SIN token (loopback, modo dev)`);
          log(`collector conectado: ${machineId} (${frame.machine.hostname}) desde ${conn.remote}`);
          // Pedimos foto completa de inmediato; el hello sólo trae la máquina.
          const id = newId('cmd');
          send(conn, { t: 'cmd', id, cmd: { k: 'resync' } });
          return;
        }

        const machineId = conn.machineId;
        if (!machineId) return;
        world.touchMachine(machineId);

        if (frame.t === 'ack') {
          resolveAck(frame.cmdId, Boolean(frame.ok), frame.detail, frame.data);
          return;
        }
        if (frame.t === 'hello') return;   // un segundo hello no re-autentica

        world.applyCollector(frame, machineId);
      } catch (err) {
        warn('error procesando frame de collector', conn.machineId, err);
      }
    });

    ws.on('error', (err) => warn('socket de collector', conn.machineId, String(err)));

    ws.on('close', (code) => {
      if (conn.helloTimer) clearTimeout(conn.helloTimer);
      orphanCollectors.delete(conn);
      const machineId = conn.machineId;
      if (!machineId) return;
      if (collectors.get(machineId) === conn) collectors.delete(machineId);
      log(`collector desconectado: ${machineId} (code ${code})`);
      // No borramos nada: offline + agentes vivos a 'dead'. El humano tiene que
      // poder ver qué se cayó y con qué estaba.
      world.markMachineOffline(machineId, `collector desconectado (${code})`);
      for (const [cmdId, p] of pending) {
        if (p.machineId !== machineId) continue;
        clearTimeout(p.timer);
        pending.delete(cmdId);
        ackTo(p.consoleId, cmdId, false, 'la máquina se desconectó');
      }
    });
  }

  /* ── consolas ───────────────────────────────────────────────────── */

  function acceptConsole(ws: WebSocket, req: IncomingMessage): void {
    const conn: ConsoleConn = {
      id: newId('con'), ws, remote: remoteOf(req), alive: true,
      authed: false, helloTimer: null, needsWorld: false,
    };
    consoles.add(conn);
    const queryToken = tokenFromRequest(req);

    // Una consola de navegador no puede poner cabeceras: si el token viene en
    // la query la damos por saludada y le mandamos el mundo ya.
    const early = auth.check(queryToken, conn.remote);
    if (early.ok) {
      conn.authed = true;
      if (early.anonymous) warn(`consola aceptada SIN token (loopback, modo dev) desde ${conn.remote}`);
      sendWorld(conn);
    } else if (queryToken !== null) {
      // Trajo token y es el equivocado: no hay nada que esperar.
      warn(`consola rechazada desde ${conn.remote}: ${early.reason}`);
      ws.close(CLOSE_UNAUTHORIZED, 'no autorizado');
      return;
    } else {
      conn.helloTimer = setTimeout(() => {
        if (!conn.authed) ws.close(CLOSE_UNAUTHORIZED, 'sin hello');
      }, HELLO_TIMEOUT_MS);
      conn.helloTimer.unref?.();
    }

    ws.on('pong', () => { conn.alive = true; });

    ws.on('message', (data) => {
      let frame: ClientFrame;
      try {
        frame = parseFrame(data) as ClientFrame;
        if (typeof frame !== 'object' || frame === null || typeof frame.t !== 'string') {
          throw new Error('frame sin tipo');
        }
      } catch (err) {
        send(conn, { t: 'error', message: `frame inválido: ${String(err)}` });
        return;
      }

      try {
        if (!conn.authed) {
          if (frame.t !== 'hello') { ws.close(CLOSE_UNAUTHORIZED, 'se esperaba hello'); return; }
          const result = auth.check(frame.token, conn.remote);
          if (!result.ok) { ws.close(CLOSE_UNAUTHORIZED, 'no autorizado'); return; }
          if (typeof frame.v === 'number' && frame.v !== PROTOCOL_VERSION) {
            ws.close(CLOSE_BAD_VERSION, `protocolo v${PROTOCOL_VERSION}`);
            return;
          }
          conn.authed = true;
          if (conn.helloTimer) { clearTimeout(conn.helloTimer); conn.helloTimer = null; }
          if (result.anonymous) warn(`consola aceptada SIN token (loopback, modo dev) desde ${conn.remote}`);
          log(`consola conectada: ${conn.id}`);
          sendWorld(conn);
          return;
        }

        handleConsoleFrame(conn, frame);
      } catch (err) {
        warn('error procesando frame de consola', conn.id, err);
        send(conn, { t: 'error', message: 'el hub no pudo procesar ese frame' });
      }
    });

    ws.on('error', (err) => warn('socket de consola', conn.id, String(err)));

    ws.on('close', () => {
      if (conn.helloTimer) clearTimeout(conn.helloTimer);
      consoles.delete(conn);
      // Los comandos que pidió quedan huérfanos: su ack ya no tiene destino.
      for (const p of pending.values()) if (p.consoleId === conn.id) p.consoleId = null;
      log(`consola desconectada: ${conn.id}`);
    });
  }

  function handleConsoleFrame(conn: ConsoleConn, frame: ClientFrame): void {
    switch (frame.t) {
      // El hello ya se validó al aceptar la conexión; repetirlo no es un error.
      case 'hello':
        return;

      case 'resync':
        sendWorld(conn);
        return;

      case 'beat':
        return;

      case 'cmd': {
        if (typeof frame.id !== 'string' || !isCommand(frame.cmd)) {
          send(conn, { t: 'error', message: 'cmd malformado' });
          return;
        }
        dispatchCommand(frame.id, frame.cmd, conn.id);
        return;
      }

      case 'ceo:say': {
        const text = typeof frame.text === 'string' ? frame.text : '';
        if (!text.trim()) return;
        const msg: CeoMessage = {
          id: newId('msg'), role: 'human', text, at: Date.now(), actions: [],
        };
        pushCeoMessage(msg);
        if (options.onCeoSay) {
          options.onCeoSay(text, hub);
        } else {
          // Sin runtime de CEO conectado, decirlo es mejor que el silencio.
          pushCeoMessage({
            id: newId('msg'), role: 'system', at: Date.now(), actions: [],
            text: 'El runtime del CEO no está conectado a este hub todavía. Tu mensaje quedó guardado.',
          });
        }
        return;
      }

      case 'escalation:answer': {
        if (typeof frame.id !== 'string' || typeof frame.answer !== 'string') return;
        answerEscalation(frame.id, frame.answer, frame.rememberAs ?? null, conn.id);
        return;
      }

      case 'escalation:dismiss': {
        if (typeof frame.id !== 'string') return;
        world.dismissEscalation(frame.id);
        return;
      }

      default:
        send(conn, { t: 'error', message: `frame desconocido: ${String((frame as { t: unknown }).t)}` });
    }
  }

  /**
   * Responder una escalación hace tres cosas a la vez: cierra el registro en el
   * mundo, la manda de vuelta al agente que preguntó, y —si el humano lo pidió—
   * la guarda en memoria para no volver a preguntar lo mismo nunca.
   */
  function answerEscalation(
    id: string, answer: string, rememberAs: string | null, consoleId: string | null,
    by: 'human' | 'ceo' = 'human',
  ): void {
    const before = world.state.escalations[id];
    if (!before) { ackTo(consoleId, id, false, 'escalación desconocida'); return; }
    const e = world.answerEscalation(id, answer, by, rememberAs);
    if (!e) return;
    store.saveAnswered(e);
    if (rememberAs && rememberAs.trim()) {
      mem.remember({
        question: e.question, answer: e.answer ?? answer, rememberAs,
        projectId: e.projectId, agentId: e.agentId, escalationId: e.id,
      });
      log(`memoria +1: "${rememberAs.slice(0, 60)}"`);
    }
    dispatchCommand(newId('cmd'), { k: 'answer', escalationId: id, answer, rememberAs }, consoleId);
  }

  function pushCeoMessage(msg: CeoMessage): void {
    const saved = world.addCeoMessage(msg);
    store.appendCeo(saved);
    broadcast({ t: 'ceo:message', message: saved });
  }

  /* ── HTTP ───────────────────────────────────────────────────────── */

  function json(res: ServerResponse, code: number, body: unknown): void {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(payload);
  }

  const http = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://hub.local');
      switch (url.pathname) {
        case '/api/health':
          json(res, 200, {
            ...world.health(),
            connections: { collectors: collectors.size, consoles: consoles.size, pendingCommands: pending.size },
            bus: { rev: bus.rev, ...bus.stats },
            protocol: PROTOCOL_VERSION,
          });
          return;
        case '/api/world':
          json(res, 200, world.snapshot(bus.rev));
          return;
        case '/api/memory': {
          // Útil para ver por qué el CEO decidió no preguntar.
          const q = url.searchParams.get('q');
          json(res, 200, q ? { q, results: mem.recall(q, { limit: 10, threshold: 0 }) } : { size: mem.size, entries: mem.all() });
          return;
        }
        default:
          json(res, 404, { ok: false, error: 'no such route', routes: ['/api/health', '/api/world', '/api/memory?q='] });
      }
    } catch (err) {
      try { json(res, 500, { ok: false, error: String(err) }); } catch { res.end(); }
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = '';
    try { pathname = new URL(req.url ?? '/', 'http://hub.local').pathname; } catch { /* url basura */ }
    if (pathname !== PATHS.collector && pathname !== PATHS.console) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      try {
        if (pathname === PATHS.collector) acceptCollector(ws, req);
        else acceptConsole(ws, req);
      } catch (err) {
        warn('fallo aceptando conexión', err);
        try { ws.close(1011, 'error interno'); } catch { /* ya cerrado */ }
      }
    });
  });

  /* ── temporizadores ─────────────────────────────────────────────── */

  const sweepTimer = setInterval(() => {
    try { world.sweep(); } catch (err) { warn('sweep falló', err); }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  const pingTimer = setInterval(() => {
    const all: Conn[] = [...collectors.values(), ...orphanCollectors, ...consoles];
    for (const conn of all) {
      if (!conn.alive) { try { conn.ws.terminate(); } catch { /* ya muerto */ } continue; }
      conn.alive = false;
      try { conn.ws.ping(); } catch { /* ya muerto */ }
    }
  }, PING_INTERVAL_MS);
  pingTimer.unref?.();

  const pruneTimer = setInterval(() => { void store.prune(); }, 6 * 3600_000);
  pruneTimer.unref?.();

  /* ── arranque ───────────────────────────────────────────────────── */

  const port = options.port ?? Number(process.env['ORCA_PORT'] ?? PORTS.hub);
  const host = options.host ?? process.env['ORCA_HOST'] ?? '0.0.0.0';

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => { http.removeListener('error', reject); resolve(); });
  });

  const address = http.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  const hub: Hub = {
    world, bus, store, memory: mem, auth, http,
    port: actualPort,
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`,
    pushCeoMessage,
    broadcast,
    answerEscalationLocal(id, answer, by) {
      // Una respuesta del CEO no se guarda en memoria: la memoria es lo que
      // dijo el humano. Recordar lo que el CEO dedujo la contaminaría.
      answerEscalation(id, answer, null, null, by);
    },
    dispatch(cmd) {
      const cmdId = newId('cmd');
      return new Promise<unknown>((resolve, reject) => {
        localWaiters.set(cmdId, { resolve, reject });
        dispatchCommand(cmdId, cmd, null);
      });
    },
    counts: () => ({ collectors: collectors.size, consoles: consoles.size, pending: pending.size }),
    async close() {
      clearInterval(sweepTimer);
      clearInterval(pingTimer);
      clearInterval(pruneTimer);
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      bus.stop();
      for (const conn of [...collectors.values(), ...orphanCollectors, ...consoles]) {
        try { conn.ws.close(1001, 'hub cerrando'); } catch { /* da igual */ }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await store.close();
    },
  };

  if (!quiet) {
    for (const line of auth.banner()) console.log(line);
    console.log(`[hub] escuchando en http://${host}:${actualPort}`);
    console.log(`[hub]   collectors → ws://${host}:${actualPort}${PATHS.collector}`);
    console.log(`[hub]   consolas   → ws://${host}:${actualPort}${PATHS.console}`);
    console.log(`[hub]   salud      → http://localhost:${actualPort}/api/health`);
    console.log(`[hub]   memoria    → ${mem.size} respuestas recordadas`);
  }

  return hub;
}

/* ── CLI ──────────────────────────────────────────────────────────── */

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith('server.ts') || entry.endsWith('server.js');
})();

if (invokedDirectly) {
  const hub = await startHub();
  const bye = (signal: string): void => {
    console.log(`\n[hub] ${signal}, cerrando…`);
    hub.store.flushSync();
    void hub.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref?.();
  };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('uncaughtException', (err) => {
    // Un fallo aislado no debe tumbar la flota entera: lo registramos y seguimos.
    console.error('[hub] excepción no capturada:', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[hub] promesa rechazada:', err);
  });
}
