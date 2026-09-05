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
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';

import type {
  Agent, AgentMessage, CeoMessage, Collision, MessageKind,
} from '../shared/types.ts';
import { TERMINAL_STATES } from '../shared/types.ts';
import type {
  ClientFrame, CollectorFrame, Command, CommandFrame, PatchOp, ServerFrame,
} from '../shared/protocol.ts';
import {
  MAX_ARTIFACT_BYTES, PATHS, PORTS, PROTOCOL_VERSION, artifactMime, newId,
} from '../shared/protocol.ts';

import { World } from './world.ts';
import type { WorldEvent } from './world.ts';
import { PatchBus } from './bus.ts';
import type { PatchFrame } from './bus.ts';
import { CLOSE_BAD_HELLO, CLOSE_BAD_VERSION, CLOSE_UNAUTHORIZED, ORCA_DIR, createAuth } from './auth.ts';
import type { Auth } from './auth.ts';
import { HubStore } from './persist.ts';
import { FleetStore } from './fleets.ts';
import { nextSquadName, SQUAD_SEQ_FILE } from './squad-seq.ts';
import { parsePresetList } from '../shared/fleets.ts';
import { squadName } from '../shared/squads.ts';
import { readBody } from './mcp.ts';
import { History, HISTORY_RETENTION_MS } from './history.ts';
import { AnswerMemory, MEMORY_FILE } from './memory.ts';
import { CapcomRouter, capcomOf, realTimers } from './capcom.ts';
import type { CapcomTimer } from './capcom.ts';
import { serveMcp } from './mcp.ts';
import type { McpHttpDeps } from './mcp.ts';
import { hubContext } from '../agents/context.ts';

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

/**
 * Un collector puede mandar frames más grandes que una consola, y sólo por una
 * razón: el ack de `artifact:read` lleva los bytes del archivo en base64, que
 * infla un tercio. Se le da su propio techo —y su propio WebSocketServer— para
 * que ampliarlo no amplíe de paso lo que puede tirarle encima un navegador.
 */
const MAX_COLLECTOR_FRAME_BYTES = Math.ceil(MAX_ARTIFACT_BYTES * 4 / 3) + 256 * 1024;

/** Dónde el hub guarda una copia de lo que ya se descargó de una máquina. */
export const ARTIFACT_CACHE_DIR = join(ORCA_DIR, 'artifacts');

/**
 * Un artefacto tarda lo que tarde el disco de la otra máquina, pero no más:
 * una consola esperando un `<img>` para siempre es peor que un 502.
 */
const ARTIFACT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Los ids los produce el collector como `art_` + sha1 recortado. Aquí se exige
 * la forma estricta —sin puntos ni barras— porque el id es también el nombre
 * del archivo en la caché: sin esto, un `..` en una url sería una escritura
 * fuera de ~/.orca/artifacts.
 */
const ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * Techo de destinatarios de un mensaje difundido.
 *
 * Un `notice` a cien agentes no es un mensaje: es una tormenta que interrumpe a
 * toda la flota a la vez y le cuesta un turno a cada uno. Pasado este número se
 * entrega sólo a los que no están bloqueados —a un agente parado esperando a
 * una persona, el correo no lo desbloquea— y se anota el recorte en el feed,
 * porque un mensaje que no llegó y no se ve es peor que uno que no se mandó.
 */
export const MAX_BROADCAST = 25;

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
  /** La línea de tiempo. Una prueba la inyecta para darle su propio archivo. */
  history?: History;
  hz?: number;
  /** Silencia el log; los tests lo agradecen. */
  quiet?: boolean;
  /** Dónde se cachean los bytes de los artefactos. Por defecto ~/.orca/artifacts. */
  artifactCache?: string;
  /** Dónde viven los presets de flotilla. Por defecto ~/.orca/fleets. */
  fleets?: FleetStore;
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
   *
   * Sólo se llama cuando NO hay una sesión CAPCOM viva: el mando de la flota es
   * uno, o dos mentes triarían la misma pregunta a la vez.
   */
  onEscalation?: (escalationId: string, hub: Hub) => void;
  /**
   * `--api-command`: manda el CEO de API aunque haya una sesión CAPCOM viva.
   * Es la salida para quien no tenga CLI, no el camino normal — por defecto el
   * hub prefiere CAPCOM y no gasta un solo token de API.
   */
  apiCommand?: boolean;
  /** Cuánto se le da a CAPCOM para contestar. Las pruebas lo acortan. */
  capcomAnswerMs?: number;
  /** Reloj inyectable para esa cuenta atrás. Sin él, `setTimeout` de verdad. */
  capcomTimer?: (fn: () => void, ms: number) => CapcomTimer;
}

/** Lo que el CEO necesita decir para meter un mensaje en la flota. */
export interface RelayInput {
  kind: MessageKind;
  /** El CEO habla con un agente, con un proyecto o con un escuadrón. Difundir a
   *  la flota entera es una decisión de la que nadie se hace responsable, así
   *  que no está. */
  scope: 'agent' | 'project' | 'squad';
  toAgentId?: string | null;
  toProjectId?: string | null;
  /** Sólo con scope 'squad': el nombre del escuadrón. */
  toSquad?: string | null;
  subject: string;
  body?: string | null;
  files?: string[];
}

export interface RelayResult {
  message: AgentMessage;
  /** Agentes a cuyo collector se mandó la entrega. */
  delivered: string[];
  /** Destinatarios que se quedaron fuera (techo, máquina caída, terminados). */
  skipped: number;
  /** Por qué se quedaron fuera, si se quedó alguno. */
  reason: string | null;
}

export interface Hub {
  world: World;
  bus: PatchBus;
  store: HubStore;
  memory: AnswerMemory;
  /** Instantáneas del mundo para el scrubber y el "mientras no estabas". */
  history: History;
  /** Los presets de flotilla en disco: lo que `/launch` y `launch_squad` leen. */
  fleets: FleetStore;
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
  /**
   * El CEO mete un mensaje en el tráfico de la flota y el hub lo enruta. Es la
   * única forma que tiene de redirigir a un agente sin interrumpir a la persona.
   */
  relayMessage(input: RelayInput): RelayResult;
  /**
   * Contesta un `ask` entre agentes desde dentro del proceso. Desbloquea a quien
   * preguntó sin despertar al que le tocaba contestar, que es el caso en el que
   * el CEO aporta algo que ningún agente puede: ve la flota entera.
   */
  replyToMessageLocal(messageId: string, answer: string, from: string | null): AgentMessage | null;
  /** Marca una colisión como vista, desde la consola o desde el CEO. */
  acknowledgeCollision(id: string): Collision | null;
  /**
   * La sesión CAPCOM viva de esta flota, o null.
   *
   * Es lo que decide quién manda: con CAPCOM arriba, lo que escribe el humano y
   * cada pregunta de un agente van a esa sesión y la API no se toca.
   */
  capcom(): Agent | null;
  broadcast(frame: ServerFrame): void;
  counts(): { collectors: number; consoles: number; pending: number };
  close(): Promise<void>;
}

/* ── utilidades ───────────────────────────────────────────────────── */

function parseFrame(data: RawData, max = MAX_FRAME_BYTES): unknown {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  if (text.length > max) throw new Error('frame demasiado grande');
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
    case 'spawn': return `spawn ${cmd.projectId}`
      + (cmd.squad ? ` [${cmd.squad}${cmd.lead ? ' lead' : ''}]` : '');
    case 'say': return `say ${cmd.agentId}`;
    case 'permit': return `permit ${cmd.agentId} allow=${cmd.allow}`;
    case 'stop': return `stop ${cmd.agentId}`;
    case 'resume': return `resume ${cmd.agentId}`;
    case 'remove': return `remove ${cmd.agentId}`;
    case 'answer': return `answer ${cmd.escalationId}`;
    case 'deliver': return `deliver ${cmd.message.kind} → ${cmd.agentId}`;
    case 'reply': return `reply ${cmd.messageId}`;
    case 'key:set': return `key:set ${cmd.projectId}/${cmd.name} (valor omitido)`;
    case 'key:remove': return `key:remove ${cmd.projectId}/${cmd.name}`;
    case 'artifact:read': return `artifact:read ${cmd.artifactId}`;
    case 'resync': return 'resync';
    case 'logs': return `logs ${cmd.agentId}`;
    default: return 'desconocido';
  }
}

function isCommand(v: unknown): v is Command {
  if (typeof v !== 'object' || v === null) return false;
  const k = (v as { k?: unknown }).k;
  return typeof k === 'string' && [
    'spawn', 'say', 'permit', 'stop', 'resume', 'remove', 'answer', 'deliver',
    'reply', 'key:set', 'key:remove', 'artifact:read', 'resync', 'logs',
  ].includes(k);
}

/* ── el hub ───────────────────────────────────────────────────────── */

/**
 * Dónde vive la consola construida, si existe.
 *
 * Servirla desde el propio hub convierte el despliegue en un proceso: se pone
 * el hub en un VPS (o detrás de un túnel de Cloudflare), y la consola queda
 * alcanzable desde el teléfono sin abrir un solo puerto en el portátil, porque
 * los collectors marcan hacia fuera. En desarrollo no estorba: Vite sirve por
 * su lado y aquí simplemente no hay dist/.
 */
const DIST_DIR: string | null = (() => {
  const guess = fileURLToPath(new URL('../../dist', import.meta.url));
  return existsSync(join(guess, 'index.html')) ? guess : null;
})();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  // Sin este tipo Chrome ignora el manifest y la consola no se puede instalar.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

/* ── caché de artefactos ──────────────────────────────────────────── */

/**
 * Lo que devuelve un collector al `artifact:read`. Se valida en vez de
 * confiarse: el ack viene de la red, y de ahí sale un Buffer que servimos con
 * un Content-Type.
 */
interface ArtifactPayload { base64: string; mime: string; bytes: number; }

function asArtifactPayload(v: unknown): ArtifactPayload | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o['base64'] !== 'string' || o['base64'].length === 0) return null;
  return {
    base64: o['base64'],
    mime: typeof o['mime'] === 'string' ? o['mime'] : 'application/octet-stream',
    bytes: typeof o['bytes'] === 'number' ? o['bytes'] : 0,
  };
}

/** tmp + rename: una petición concurrente no puede leer media descarga. */
async function cacheArtifact(dir: string, id: string, buf: Buffer): Promise<boolean> {
  const file = join(dir, id);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, buf, { mode: 0o600 });
    await rename(tmp, file);
    return true;
  } catch {
    await unlink(tmp).catch(() => { /* nunca existió */ });
    // Sin caché el artefacto se sigue sirviendo: sólo cuesta otra ida y vuelta.
    return false;
  }
}

async function dropArtifactCache(dir: string, id: string): Promise<void> {
  if (!ARTIFACT_ID_RE.test(id)) return;
  await unlink(join(dir, id)).catch(() => { /* nunca se cacheó */ });
}

/**
 * Cabeceras de un artefacto.
 *
 * `Content-Security-Policy: sandbox` es lo importante y va sólo en el html: una
 * página que escribió un agente se abre en el mismo origen que la consola, así
 * que sin sandbox podría hacerle fetch al hub con las credenciales del
 * operador. Con él no tiene scripts, ni origen, ni formularios: es un dibujo.
 */
function artifactHeaders(mime: string, length: number): Record<string, string> {
  const head: Record<string, string> = {
    'content-type': mime,
    'content-length': String(length),
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
  };
  if (mime.startsWith('text/html')) head['content-security-policy'] = 'sandbox';
  return head;
}

function serveStatic(pathname: string, req: IncomingMessage, res: ServerResponse): boolean {
  if (!DIST_DIR) return false;
  /*
   * /api es de la API, siempre. Devolver el index para una llamada de API que
   * no existe convierte un error de cliente —una ruta mal escrita, un cliente
   * viejo— en un misterio: el fetch recibe 200 y un HTML donde esperaba JSON.
   */
  if (pathname === '/api' || pathname.startsWith('/api/')) return false;

  // Normaliza y confina: `..` en la url no puede salir de dist/, pase lo que
  // pase con la codificación.
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const target = resolve(DIST_DIR, '.' + (rel === '/' ? '/index.html' : rel));
  if (target !== DIST_DIR && !target.startsWith(DIST_DIR + sep)) return false;

  let file = target;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // SPA: cualquier ruta desconocida devuelve el index; el enrutado vive en
    // el cliente.
    file = join(DIST_DIR, 'index.html');
    if (!existsSync(file)) return false;
  }

  const ext = extname(file);
  const stat = statSync(file);
  const lastModified = stat.mtime.toUTCString();
  /*
   * Tres políticas de caché, no una. Los assets de Vite (`/assets/*`) llevan
   * hash en el nombre y pueden vivir un año. El index nunca se cachea: es lo
   * que apunta al hash nuevo. Todo lo demás —manifest, iconos, fuentes, sfx—
   * tiene nombre fijo, así que el navegador tiene que revalidarlo: con
   * Last-Modified, la revalidación es un 304 sin cuerpo, no una descarga.
   * Antes todo iba como immutable y un icono o manifest cambiado se quedaba
   * pegado un año en cada instalación de la PWA.
   */
  const hashed = file.startsWith(join(DIST_DIR, 'assets') + sep);
  const cache = ext === '.html' ? 'no-store'
    : hashed ? 'public, max-age=31536000, immutable'
    : 'public, max-age=0, must-revalidate';
  if (!hashed && ext !== '.html') {
    const since = req.headers['if-modified-since'];
    if (typeof since === 'string' && since === lastModified) {
      res.writeHead(304, { 'cache-control': cache, 'last-modified': lastModified });
      res.end();
      return true;
    }
  }
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': cache,
    'last-modified': lastModified,
  });
  createReadStream(file).pipe(res);
  return true;
}

export async function startHub(options: HubOptions = {}): Promise<Hub> {
  const quiet = options.quiet ?? false;
  const log = (...args: unknown[]): void => { if (!quiet) console.log('[hub]', ...args); };
  const warn = (...args: unknown[]): void => { if (!quiet) console.warn('[hub]', ...args); };

  const auth = options.auth ?? createAuth();
  const store = options.store ?? new HubStore();
  const mem = options.memory ?? new AnswerMemory(MEMORY_FILE);
  const history = options.history ?? new History();
  const artifactCache = options.artifactCache ?? ARTIFACT_CACHE_DIR;
  const fleets = options.fleets ?? new FleetStore();

  const collectors = new Map<string, CollectorConn>();   // machineId → conn
  const orphanCollectors = new Set<CollectorConn>();     // aún sin hello
  const consoles = new Set<ConsoleConn>();
  const pending = new Map<string, Pending>();

  /* ── mundo + bus ────────────────────────────────────────────────── */

  const world = new World({
    onOps: (ops: PatchOp[]) => bus.push(ops),
    onEvent: (ev: WorldEvent) => {
      store.logEvent(ev);
      // Una transición a blocked o a dead es uno de los dos instantes que el
      // operador va a querer encontrar exactamente en la línea de tiempo. La
      // rejilla de 20 s se los perdería la mitad de las veces, así que se marca
      // aquí; `mark` coalesce, así que una máquina que tumba veinte agentes
      // sigue siendo una sola instantánea.
      if (ev.kind === 'agent:state') {
        const to = (ev.data as { to?: string } | undefined)?.to;
        if (to === 'blocked' || to === 'dead') {
          try { history.mark(world.state); } catch (err) { warn('history.mark falló:', err); }
        }
      }
      const escId = ev.kind === 'escalation:new'
        ? (ev.data as { id?: string } | undefined)?.id
        : undefined;
      if (ev.kind === 'message:new') {
        const msgId = (ev.data as { id?: string } | undefined)?.id;
        // Fuera del camino crítico, igual que el triaje: el mundo publica el
        // mensaje aunque el ruteo tarde o falle.
        if (msgId) {
          queueMicrotask(() => {
            try { routeNewMessage(msgId); }
            catch (err) { warn('ruteo de mensaje falló:', err); }
          });
        }
      }
      if (escId) {
        // Fuera del camino crítico: el mundo no espera al mando para publicar.
        queueMicrotask(() => {
          try {
            // CAPCOM primero. Si se la queda, el CEO de API ni se entera: dos
            // mentes triando la misma pregunta acabarían contestándola dos
            // veces, y una de las dos respuestas sería la que el agente ignora.
            if (capcomRouter.offer(escId)) return;
            options.onEscalation?.(escId, hub);
          } catch (err) { warn('triaje de escalación falló:', err); }
        });
      }
    },
    onOverflow: (kind, items) => store.overflow(kind, items),
    // El registro y su copia en disco se van juntos, o la caché sobrevive al
    // mundo y crece para siempre en un directorio que nadie mira.
    onArtifactGone: (id) => { void dropArtifactCache(artifactCache, id); },
  });

  const bus = new PatchBus({
    hz: options.hz ?? 10,
    onBeforeFlush: () => { world.settle(); },
    onFlush: (frame: PatchFrame) => publishPatch(frame),
  });

  /*
   * El mando de la flota.
   *
   * Si hay una sesión con `role:'capcom'` viva, ella recibe lo que escribe el
   * humano y cada pregunta que levanta un agente. Si no la hay, todo sigue como
   * antes: el CEO de API si hay clave, el guionizado si no. `--api-command`
   * fuerza el segundo camino aunque exista CAPCOM.
   */
  const capcomRouter = new CapcomRouter({
    capcom: () => capcomOf(world.state.agents),
    say: (agentId, text) => { dispatchCommand(newId('cmd'), { k: 'say', agentId, text }, null); },
    escalation: (id) => world.state.escalations[id],
    markWithCeo: (id) => world.markEscalationWithCeo(id),
    giveUp: (id, reason) => {
      // El intento se anota sobre el registro original y la pregunta vuelve a
      // la cola del humano: `attachCeoAttempt` hace las dos cosas.
      world.attachCeoAttempt(id, { answer: '', confidence: 0, reason });
    },
    callsign: (id) => world.state.agents[id]?.callsign ?? null,
    note: (text) => {
      log(text);
      world.pushFeed('', [{
        id: newId('f_cap'), at: Date.now(), level: 'info', source: 'CAPCOM', text,
      }]);
    },
    setTimer: options.capcomTimer ?? realTimers(),
  }, {
    enabled: options.apiCommand !== true,
    ...(options.capcomAnswerMs !== undefined ? { answerMs: options.capcomAnswerMs } : {}),
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
      case 'artifact:read': {
        const a = world.state.artifacts[cmd.artifactId];
        return a ? { machineId: a.machineId, broadcast: false }
          : { machineId: null, broadcast: false, error: `artefacto desconocido: ${cmd.artifactId}` };
      }
      case 'answer': {
        const e = world.state.escalations[cmd.escalationId];
        return e ? { machineId: e.machineId, broadcast: false }
          : { machineId: null, broadcast: false, error: `escalación desconocida: ${cmd.escalationId}` };
      }
      case 'reply': {
        // La respuesta a un `ask` va a la máquina de QUIEN PREGUNTÓ, no a la de
        // quien contesta: ahí es donde hay un agente parado esperándola.
        const m = world.state.messages[cmd.messageId];
        if (!m) return { machineId: null, broadcast: false, error: `mensaje desconocido: ${cmd.messageId}` };
        const asker = world.state.agents[m.fromAgentId];
        return asker ? { machineId: asker.machineId, broadcast: false }
          : { machineId: null, broadcast: false, error: `el que preguntó ya no existe: ${m.fromAgentId}` };
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

  /** Manda un comando sin consola detrás y espera su ack. */
  function dispatchLocal(cmd: Command): Promise<unknown> {
    const cmdId = newId('cmd');
    return new Promise<unknown>((resolve, reject) => {
      localWaiters.set(cmdId, { resolve, reject });
      dispatchCommand(cmdId, cmd, null);
    });
  }

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

  /* ── tráfico entre agentes ──────────────────────────────────────── */

  /**
   * Quién puede recibir correo.
   *
   * `idle` cuenta: un agente esperando su siguiente turno lee el mensaje en
   * cuanto arranca, y un handoff dirigido a él es exactamente para eso. Los
   * terminales no: escribirle a un `dead` es tirar el mensaje sin decirlo.
   */
  function canReceive(a: Agent): boolean {
    return !TERMINAL_STATES.has(a.state);
  }

  /**
   * Enruta un mensaje ya guardado en el mundo.
   *
   * Éste es el trabajo que sólo el hub puede hacer: el mensaje llega del
   * collector de la máquina A y su destinatario puede estar en la B. Nadie más
   * ve las dos.
   */
  function routeMessage(msg: AgentMessage): { delivered: string[]; skipped: number; reason: string | null } {
    const all = Object.values(world.state.agents);
    let targets: Agent[];
    let reason: string | null = null;
    let skipped = 0;

    switch (msg.scope) {
      case 'agent': {
        const to = msg.toAgentId ? world.state.agents[msg.toAgentId] : undefined;
        if (!to) return { delivered: [], skipped: 1, reason: `destinatario desconocido: ${msg.toAgentId ?? '?'}` };
        if (!canReceive(to)) {
          return { delivered: [], skipped: 1, reason: `${to.callsign} ya terminó (${to.state})` };
        }
        targets = [to];
        break;
      }
      case 'project': {
        const pid = msg.toProjectId ?? msg.fromProjectId;
        targets = all.filter((a) => a.projectId === pid && canReceive(a));
        break;
      }
      case 'squad': {
        /*
         * Un escuadrón no es un registro: es la etiqueta que llevan puesta unos
         * cuantos agentes, y puede cruzar máquinas. Por eso se resuelve aquí y
         * en ningún otro sitio — el collector del emisor sólo ve la suya.
         *
         * Sin nadie con esa etiqueta el mensaje NO se difunde a la flota: quien
         * escribe a squad:audit-01 quiere hablar con ese escuadrón, y despertar
         * a veinte agentes ajenos sería peor que no entregarlo. Se devuelve el
         * porqué, y routeNewMessage lo dice en voz alta.
         */
        const squad = msg.toSquad;
        targets = all.filter((a) => a.squad === squad && canReceive(a));
        if (targets.length === 0) {
          return { delivered: [], skipped: 0, reason: `nadie en el escuadrón ${squad ?? '?'}` };
        }
        break;
      }
      case 'fleet':
        targets = all.filter(canReceive);
        break;
    }

    // Nunca de vuelta a quien lo mandó: un agente leyendo su propio aviso se
    // interrumpe a sí mismo, y en un `ask` se quedaría esperándose a sí mismo.
    // Quedarse fuera por ser el emisor no cuenta como omitido.
    targets = targets.filter((a) => a.id !== msg.fromAgentId);

    if (msg.scope !== 'agent' && targets.length > MAX_BROADCAST) {
      const wanted = targets.length;
      const awake = targets.filter((a) => a.state !== 'blocked');
      targets = (awake.length > 0 ? awake : targets)
        // Los que más recientemente hicieron algo son los que más probablemente
        // sigan trabajando en lo que el mensaje toca.
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_BROADCAST);
      skipped += wanted - targets.length;
      reason = `techo de difusión: ${wanted} destinatarios → ${targets.length}`;
      warn(`mensaje ${msg.id} (${msg.scope}) ${reason}`);
      world.pushFeed('', [{
        id: `f_bcast_${msg.id}`, at: Date.now(), level: 'warn', source: 'ORCA',
        text: `difusión de ${msg.fromCallsign} recortada: ${wanted} → ${targets.length} destinatarios`,
        ...(msg.fromProjectId ? { projectId: msg.fromProjectId } : {}),
      }]);
    }

    const delivered: string[] = [];
    const unreachable: string[] = [];
    for (const a of targets) {
      const conn = collectors.get(a.machineId);
      if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
        skipped += 1;
        unreachable.push(a.callsign);
        continue;
      }
      dispatchCommand(newId('cmd'), { k: 'deliver', agentId: a.id, message: msg }, null);
      delivered.push(a.id);
    }
    if (delivered.length > 0) world.markDelivered(msg.id, delivered);
    if (unreachable.length > 0 && reason === null) {
      reason = `sin collector conectado: ${unreachable.slice(0, 5).join(', ')}`;
    }
    return { delivered, skipped, reason };
  }

  /**
   * Un mensaje que no llega a nadie es el fallo silencioso de este canal: quien
   * lo mandó cree que informó, y en un `ask` se queda esperando una respuesta
   * que nunca va a existir. Así que cuando no llega, se dice.
   */
  function routeNewMessage(id: string): void {
    const msg = world.state.messages[id];
    if (!msg) return;
    const out = routeMessage(msg);
    if (out.delivered.length > 0) {
      log(`mensaje ${msg.kind} de ${msg.fromCallsign} → ${out.delivered.length} agente(s)`);
      return;
    }
    const why = out.reason ?? 'no había nadie a quien entregárselo';
    warn(`mensaje ${msg.id} de ${msg.fromCallsign} sin entregar: ${why}`);
    world.pushFeed('', [{
      id: `f_undeliv_${msg.id}`, at: Date.now(),
      level: msg.kind === 'ask' ? 'alert' : 'warn', source: 'ORCA',
      text: `${msg.fromCallsign}: "${msg.subject}" sin entregar — ${why}`,
      ...(msg.fromProjectId ? { projectId: msg.fromProjectId } : {}),
      ...(msg.fromAgentId ? { agentId: msg.fromAgentId } : {}),
    }]);
  }

  /**
   * Contestar un `ask` hace dos cosas a la vez: cierra el mensaje en el mundo
   * —que es lo que desbloquea a quien preguntó— y manda la respuesta a su
   * collector, que es quien la escribe en su inbox.
   */
  function replyToMessage(
    messageId: string, answer: string, from: string | null, consoleId: string | null,
  ): AgentMessage | null {
    const m = world.answerMessage(messageId, answer, from);
    if (!m) { ackTo(consoleId, messageId, false, `mensaje desconocido: ${messageId}`); return null; }
    dispatchCommand(
      newId('cmd'),
      { k: 'reply', messageId: m.id, answer: m.answer ?? answer, fromAgentId: from },
      consoleId,
    );
    return m;
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
        frame = parseFrame(data, MAX_COLLECTOR_FRAME_BYTES) as CollectorFrame;
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
        // Un `reply` no es sólo un comando de máquina: cierra el mensaje en el
        // mundo, y eso es lo que desbloquea al agente que preguntó. Mandarlo
        // por el camino genérico entregaría la respuesta y dejaría al que
        // preguntó marcado como bloqueado para siempre.
        const cmd = frame.cmd;
        if (cmd.k === 'reply') {
          if (typeof cmd.messageId !== 'string' || typeof cmd.answer !== 'string') {
            send(conn, { t: 'error', message: 'reply malformado' });
            return;
          }
          replyToMessage(
            cmd.messageId, cmd.answer,
            typeof cmd.fromAgentId === 'string' ? cmd.fromAgentId : null,
            conn.id,
          );
          return;
        }
        dispatchCommand(frame.id, cmd, conn.id);
        return;
      }

      case 'collision:ack': {
        if (typeof frame.id !== 'string') return;
        world.ackCollision(frame.id);
        return;
      }

      case 'ceo:say': {
        const text = typeof frame.text === 'string' ? frame.text : '';
        if (!text.trim()) return;
        const msg: CeoMessage = {
          id: newId('msg'), role: 'human', text, at: Date.now(), actions: [],
        };
        pushCeoMessage(msg);
        /*
         * CAPCOM manda si existe.
         *
         * El mensaje queda igualmente en `world.ceo.messages` como `human`: esa
         * lista es el historial de la línea de comandos, y tiene que seguir
         * siendo legible aunque el mando cambie de sitio a mitad de la sesión.
         */
        if (capcomRouter.humanSays(text)) return;
        if (options.onCeoSay) {
          options.onCeoSay(text, hub);
        } else {
          // Sin mando conectado, decirlo es mejor que el silencio.
          pushCeoMessage({
            id: newId('msg'), role: 'system', at: Date.now(), actions: [],
            text: 'No hay comando conectado a este hub: ni sesión CAPCOM ni CEO de API. '
              + 'Tu mensaje quedó guardado. Arranca una con `orca capcom` en la máquina que deba llevarlo.',
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

  function num(v: string | null, fallback: number): number {
    const n = Number(v);
    return v !== null && v !== '' && Number.isFinite(n) ? n : fallback;
  }

  /**
   * Puerta de /api/history.
   *
   * La historia es la misma clase de dato que /api/world —un resumen de la
   * flota, nunca contenido de la máquina de nadie— pero se cierra igual que
   * `/api/artifact` porque es un registro de 24 h y la consola ya lleva el token
   * en la url. Hereda la concesión de loopback-sin-token, así que el bucle de
   * desarrollo no cambia.
   */
  function allowApi(req: IncomingMessage, res: ServerResponse): boolean {
    const allowed = auth.check(tokenFromRequest(req), remoteOf(req));
    if (allowed.ok) return true;
    json(res, 401, {
      ok: false,
      error: `no autorizado (${allowed.reason ?? 'falta token'})`,
      hint: 'añade ?token=<ORCA_TOKEN> a la url, igual que hace el websocket',
    });
    return false;
  }

  function text(res: ServerResponse, code: number, body: string): void {
    res.writeHead(code, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  /**
   * Los bytes de un artefacto.
   *
   * Primero la caché en disco, y si no está, se le pide al collector dueño y se
   * guarda de paso. Un artefacto se mira muchas veces —el operador vuelve a él,
   * la consola lo repinta— y cada vista no puede costar un viaje al portátil que
   * lo produjo; peor aún, ese portátil puede estar dormido y el registro sigue
   * siendo verdad.
   *
   * La autenticación es la misma que la de los sockets: token en `?token=`, en
   * `Authorization: Bearer` o en `X-Orca-Token`, con la misma concesión de
   * loopback-sin-token que el resto en desarrollo. Esto es contenido de la
   * máquina de alguien, no un resumen: es la única ruta de /api donde eso pesa
   * lo suficiente como para no heredar la puerta abierta de /api/world.
   */
  async function serveArtifact(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const allowed = auth.check(tokenFromRequest(req), remoteOf(req));
    if (!allowed.ok) {
      text(res, 401, `no autorizado (${allowed.reason ?? 'falta token'}). `
        + 'Añade ?token=<ORCA_TOKEN> a la url, igual que hace el websocket.');
      return;
    }
    if (!ARTIFACT_ID_RE.test(id)) { text(res, 404, 'id de artefacto inválido'); return; }
    const record = world.state.artifacts[id];
    if (!record) { text(res, 404, `no hay ningún artefacto ${id}`); return; }

    const mime = artifactMime(record.path);
    const cached = join(artifactCache, id);
    if (existsSync(cached)) {
      let size = 0;
      try { size = statSync(cached).size; } catch { size = 0; }
      res.writeHead(200, artifactHeaders(mime, size));
      createReadStream(cached).pipe(res);
      return;
    }

    let ack: unknown;
    try {
      ack = await Promise.race([
        dispatchLocal({ k: 'artifact:read', artifactId: id }),
        new Promise((_, reject) => {
          const t = setTimeout(
            () => reject(new Error(`sin respuesta en ${ARTIFACT_FETCH_TIMEOUT_MS / 1000}s`)),
            ARTIFACT_FETCH_TIMEOUT_MS,
          );
          t.unref?.();
        }),
      ]);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      warn(`artefacto ${id} no llegó desde ${record.machineId}: ${why}`);
      text(res, 502, `la máquina ${record.machineId} no entregó el artefacto: ${why}`);
      return;
    }

    const payload = asArtifactPayload(ack);
    if (!payload) {
      text(res, 502, 'el collector contestó algo que no son bytes');
      return;
    }
    const buf = Buffer.from(payload.base64, 'base64');
    if (buf.length > MAX_ARTIFACT_BYTES) {
      text(res, 502, `el artefacto pesa ${buf.length}B, por encima del límite`);
      return;
    }
    await cacheArtifact(artifactCache, id, buf);
    res.writeHead(200, artifactHeaders(payload.mime || mime, buf.length));
    res.end(buf);
  }

  /**
   * Lo que el servidor MCP necesita del hub.
   *
   * El contexto se construye en cada llamada a propósito: entre una tool y la
   * siguiente la flota se ha movido, y un contexto cacheado le enseñaría a
   * CAPCOM un mundo de hace un minuto.
   */
  const mcp: McpHttpDeps = {
    version: `orca ${PROTOCOL_VERSION}`,
    log: (message) => log('mcp:', message),
    authorize: (r) => {
      const allowed = auth.check(tokenFromRequest(r), remoteOf(r));
      return allowed.ok ? null : (allowed.reason ?? 'falta token');
    },
    context: () => hubContext(hub, {
      // Una pregunta que levanta CAPCOM es SUYA: sin dueño no aparecería en
      // ninguna ventana de la consola, que es donde el humano la va a leer.
      defaultAgentId: () => capcomRouter.live()?.id ?? null,
      // Y si está pasando hacia arriba la pregunta de un agente sin decir cuál,
      // la recuperamos por el único dato que nunca es ambiguo: quién preguntó.
      replacesFor: (agentId) => capcomRouter.openFor(agentId),
    }),
  };

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
        case '/api/traffic': {
          /*
           * Lo que se están diciendo los agentes, en JSON.
           *
           * Sin esto, depurar el canal agente↔agente exige abrir el navegador
           * y mirar la escena, que es justo lo que no se puede hacer desde un
           * VPS por ssh a las tres de la mañana.
           */
          const project = url.searchParams.get('project');
          const kind = url.searchParams.get('kind');
          const rawLimit = Number(url.searchParams.get('limit'));
          const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.floor(rawLimit)) : 100;
          const all = Object.values(world.state.messages);
          const messages = all
            .filter((m) => !project || m.fromProjectId === project || m.toProjectId === project)
            .filter((m) => !kind || m.kind === kind)
            .sort((a, b) => b.at - a.at)
            .slice(0, limit);
          const collisions = Object.values(world.state.collisions)
            .filter((c) => !project || c.projectId === project)
            .sort((a, b) => b.lastSeen - a.lastSeen);
          json(res, 200, {
            at: Date.now(),
            total: all.length,
            // Lo primero que se quiere saber al mirar esto: cuánta gente está
            // parada esperando a otro agente.
            waiting: all.filter((m) => m.kind === 'ask' && m.answer === null).length,
            shown: messages.length,
            messages,
            collisions,
          });
          return;
        }
        case '/api/history': {
          /*
           * La flota en el tiempo, para el scrubber.
           *
           * `step` submuestrea en el servidor y no en el cliente porque 24 h de
           * instantáneas de una flota grande son megabytes que el navegador no
           * necesita para dibujar 600 columnas de píxel.
           */
          if (!allowApi(req, res)) return;
          const now = Date.now();
          const from = num(url.searchParams.get('from'), now - HISTORY_RETENTION_MS);
          const to = num(url.searchParams.get('to'), now);
          const step = Math.max(0, num(url.searchParams.get('step'), 0));
          json(res, 200, history.range(from, to, step));
          return;
        }
        case '/api/history/summary': {
          // "Qué pasó mientras no estabas": la diferencia entre el mundo que
          // dejaste y el que hay, no un volcado de eventos que haya que leer.
          if (!allowApi(req, res)) return;
          const now = Date.now();
          const since = num(url.searchParams.get('since'), now - HISTORY_RETENTION_MS);
          json(res, 200, history.summary(world.state, Math.min(since, now), now));
          return;
        }
        case '/mcp': {
          /*
           * Las herramientas de flota, como servidor MCP.
           *
           * Vive fuera de /api porque no es la API de la consola: es el otro
           * extremo de CAPCOM, y la url entera —con su token— acaba escrita en
           * un `.mcp.json` que lee un CLI.
           */
          void serveMcp(req, res, mcp).catch((err) => {
            warn('mcp:', err);
            try { json(res, 500, { ok: false, error: String(err) }); } catch { res.end(); }
          });
          return;
        }
        case '/api/fleets': {
          /*
           * Los presets de flotilla. GET los lista; PUT deja el directorio
           * exactamente con la lista del cuerpo — el texto del editor ES la
           * lista, y así es como se borra un preset. Un preset roto en disco
           * se reporta en `broken` y no tumba la ventana.
           */
          if (!allowApi(req, res)) return;
          const method = (req.method ?? 'GET').toUpperCase();
          if (method === 'GET') { json(res, 200, { ...fleets.read(), dir: fleets.dir }); return; }
          if (method !== 'PUT') { res.writeHead(405, { allow: 'GET, PUT' }).end(); return; }
          void readBody(req).then((raw) => {
            let body: unknown;
            try { body = JSON.parse(raw); } catch { json(res, 400, { ok: false, error: 'NOT JSON' }); return; }
            const list = parsePresetList(body);
            if (typeof list === 'string') { json(res, 400, { ok: false, error: list }); return; }
            fleets.replaceAll(list);
            json(res, 200, { ok: true, ...fleets.read() });
          }).catch((err) => { json(res, 413, { ok: false, error: String(err) }); });
          return;
        }
        case '/api/squads/next': {
          /*
           * Un nombre de escuadrón numerado, del mismo contador que usa
           * `launch_squad`. La consola lo pide antes de lanzar un preset para
           * que un lanzamiento desde el navegador y uno desde CAPCOM no puedan
           * acabar con la misma etiqueta. POST porque consume un número.
           */
          if (!allowApi(req, res)) return;
          if ((req.method ?? 'GET').toUpperCase() !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
          const base = squadName(url.searchParams.get('base'));
          if (!base) { json(res, 400, { ok: false, error: 'base: letters, digits, - and _' }); return; }
          try {
            const name = nextSquadName(
              join(store.dir, SQUAD_SEQ_FILE), base,
              Object.values(world.state.agents).map((a) => a.squad),
            );
            json(res, 200, { ok: true, name });
          } catch (err) {
            json(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }
        case '/api/memory': {
          // Útil para ver por qué el CEO decidió no preguntar.
          const q = url.searchParams.get('q');
          json(res, 200, q ? { q, results: mem.recall(q, { limit: 10, threshold: 0 }) } : { size: mem.size, entries: mem.all() });
          return;
        }
        default: {
          if (url.pathname.startsWith('/api/artifact/')) {
            const id = decodeURIComponent(url.pathname.slice('/api/artifact/'.length));
            void serveArtifact(id, req, res).catch((err) => {
              warn('sirviendo artefacto', err);
              try { text(res, 500, 'fallo sirviendo el artefacto'); } catch { res.end(); }
            });
            return;
          }
          // Fuera de /api, el hub sirve la consola construida si está.
          // Un solo proceso detrás de un túnel es todo lo que hace falta para
          // que la consola sea alcanzable desde cualquier parte, que es la
          // razón por la que los collectors marcan hacia fuera.
          if (serveStatic(url.pathname, req, res)) return;
          json(res, 404, {
            ok: false, error: 'no such route',
            routes: [
              '/api/health', '/api/world', '/api/traffic?project=&kind=&limit=',
              '/api/memory?q=', '/api/artifact/<id>', 'POST /mcp (fleet command, MCP)',
              '/api/history?from=&to=&step=', '/api/history/summary?since=',
              '/api/fleets (GET, PUT)', 'POST /api/squads/next?base=',
            ],
            hint: DIST_DIR
              ? 'la consola se sirve desde /'
              : 'ejecuta `npm run build` para que este hub sirva también la consola',
          });
        }
      }
    } catch (err) {
      try { json(res, 500, { ok: false, error: String(err) }); } catch { res.end(); }
    }
  });

  /*
   * Dos servidores, dos techos. El de collectors admite el ack de
   * `artifact:read`, que lleva megabytes de base64; el de consolas se queda en
   * los 4MB de siempre. Un solo maxPayload obligaría a subírselo también al
   * navegador, que no tiene ninguna razón para mandar nada grande.
   */
  const wssCollector = new WebSocketServer({ noServer: true, maxPayload: MAX_COLLECTOR_FRAME_BYTES });
  const wssConsole = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = '';
    try { pathname = new URL(req.url ?? '/', 'http://hub.local').pathname; } catch { /* url basura */ }
    if (pathname !== PATHS.collector && pathname !== PATHS.console) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const isCollector = pathname === PATHS.collector;
    (isCollector ? wssCollector : wssConsole).handleUpgrade(req, socket, head, (ws) => {
      try {
        if (isCollector) acceptCollector(ws, req);
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

  // La cadencia fija de la línea de tiempo. El anillo ya trae del disco lo que
  // sobrevivió al reinicio, así que el scrubber tiene pasado desde el segundo 0.
  history.start(() => world.state);

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
    world, bus, store, memory: mem, history, fleets, auth, http,
    port: actualPort,
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`,
    pushCeoMessage,
    broadcast,
    answerEscalationLocal(id, answer, by) {
      // Una respuesta del CEO no se guarda en memoria: la memoria es lo que
      // dijo el humano. Recordar lo que el CEO dedujo la contaminaría.
      answerEscalation(id, answer, null, null, by);
    },
    relayMessage(input) {
      const now = Date.now();
      const to = input.scope === 'agent' && input.toAgentId
        ? world.state.agents[input.toAgentId] : undefined;
      const projectId = input.scope === 'agent' ? (to?.projectId ?? '') : (input.toProjectId ?? '');
      const message: AgentMessage = {
        id: newId('m'),
        kind: input.kind,
        scope: input.scope,
        // El CEO no es un agente y no tiene máquina: se identifica como tal
        // para que el destinatario sepa que esto no viene de un compañero.
        fromAgentId: 'ceo',
        fromCallsign: 'CEO',
        fromProjectId: projectId,
        toAgentId: input.scope === 'agent' ? (input.toAgentId ?? null) : null,
        toProjectId: input.scope === 'project' ? (input.toProjectId ?? null) : null,
        toSquad: input.scope === 'squad' ? (input.toSquad ?? null) : null,
        subject: input.subject,
        body: input.body ?? null,
        files: input.files ?? [],
        at: now,
        readBy: [],
        // Un aviso del CEO caduca; nada de esto es una pregunta que alguien
        // esté esperando, así que no puede quedarse en el mundo para siempre.
        expiresAt: now + 60 * 60_000,
        answer: null, answeredAt: null, answeredBy: null,
      };
      const stored = world.upsertMessageLocal(message);
      const routed = routeMessage(stored);
      return { message: stored, ...routed };
    },
    replyToMessageLocal(messageId, answer, from) {
      return replyToMessage(messageId, answer, from, null);
    },
    acknowledgeCollision(id) {
      return world.ackCollision(id);
    },
    capcom() {
      return capcomRouter.live();
    },
    dispatch(cmd) {
      return dispatchLocal(cmd);
    },
    counts: () => ({ collectors: collectors.size, consoles: consoles.size, pending: pending.size }),
    async close() {
      clearInterval(sweepTimer);
      clearInterval(pingTimer);
      clearInterval(pruneTimer);
      capcomRouter.stop();
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      bus.stop();
      for (const conn of [...collectors.values(), ...orphanCollectors, ...consoles]) {
        try { conn.ws.close(1001, 'hub cerrando'); } catch { /* da igual */ }
      }
      await new Promise<void>((resolve) => wssCollector.close(() => resolve()));
      await new Promise<void>((resolve) => wssConsole.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await store.close();
      await history.close();
    },
  };

  if (!quiet) {
    for (const line of auth.banner()) console.log(line);
    console.log(`[hub] escuchando en http://${host}:${actualPort}`);
    console.log(`[hub]   collectors → ws://${host}:${actualPort}${PATHS.collector}`);
    console.log(`[hub]   consolas   → ws://${host}:${actualPort}${PATHS.console}`);
    console.log(`[hub]   salud      → http://localhost:${actualPort}/api/health`);
    console.log(`[hub]   MCP        → http://localhost:${actualPort}/mcp   (las tools de CAPCOM)`);
    console.log(`[hub]   memoria    → ${mem.size} respuestas recordadas`);
    console.log(`[hub]   comando    → ${options.apiCommand
      ? 'CEO de API forzado (--api-command): CAPCOM no recibirá nada'
      : 'CAPCOM cuando haya sesión viva; el CEO de API sólo si no la hay'}`);
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
    hub.history.flushSync();
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
