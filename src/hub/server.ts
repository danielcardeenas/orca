import { agentStopReason } from '../shared/agent-stop.ts';
import { PushService } from './push.ts';
import { quotaIncident } from '../shared/recovery.ts';
import { freshCapcomCheckpoint } from './capcom-checkpoint.ts';
import { RecoveryCoordinator } from './recovery.ts';
import { HygieneRegistry, sanitizeReport } from './hygiene.ts';
import { createSourceSentinel, sourceRev, type SourceSentinel } from './source-rev.ts';
import { autopublishEnabled, createPublisher, finishedOwnWork, spawnPublish } from './publisher.ts';
import { RESTART_EXIT_CODE, isSupervised } from '../shared/restart.ts';
import { MissionStore } from './missions.ts';
import { uploadRecoveryImage } from './recovery-images.ts';
import { uploadFile } from './uploads.ts';
import { transcribeHandler, vocabulary, whisperConfig } from './transcribe.ts';
import { FILE_ROOTS_FILE, FileRoots } from './file-roots.ts';
import { ProjectPolicy, forgeGate, projectPolicyFile } from './project-policy.ts';
import { leadPrompt, missionLeadOf, missionPrompt, type CapcomMission } from '../shared/missions.ts';
import { dispatchForge } from './forge.ts';
import { normalizeGestures } from '../shared/gestures.ts';
import { buildDebrief } from '../shared/debrief.ts';
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
  Agent, AgentMessage, CeoMessage, Collision, Machine, MessageKind,
} from '../shared/types.ts';
import { TERMINAL_STATES } from '../shared/types.ts';
import { HARNESS_ENV, HARNESS_REFUSED, harnessRefusedWhy, isHarnessHub, sameWorld } from '../shared/synthetic.ts';
import type {
  ClientFrame, CollectorFrame, CollectorInstance, Command, CommandFrame, PatchOp, ServerFrame, TermFrame,
} from '../shared/protocol.ts';
import {
  CLOSE_REPLACED, MAX_ARTIFACT_BYTES, PATHS, PORTS, PROTOCOL_VERSION, artifactMime, newId,
  TERM_ID_RE, TERM_MAX_CHUNK, TERM_MAX_COLS, TERM_MAX_ROWS,
} from '../shared/protocol.ts';

import { World } from './world.ts';
import type { WorldEvent } from './world.ts';
import { PatchBus } from './bus.ts';
import type { PatchFrame } from './bus.ts';
import { CLOSE_BAD_HELLO, CLOSE_BAD_VERSION, CLOSE_NOT_HARNESS, CLOSE_UNAUTHORIZED, ORCA_DIR, createAuth } from './auth.ts';
import type { Auth } from './auth.ts';
import { harnessHomeRefusal } from './harness.ts';
import { ReplacementWatch, instanceLabel, replacementText } from './replacements.ts';
import { HubStore } from './persist.ts';
import { FleetStore } from './fleets.ts';
import { nextSquadName, SQUAD_SEQ_FILE } from './squad-seq.ts';
import { parsePresetList } from '../shared/fleets.ts';
import { squadName } from '../shared/squads.ts';
import { archivableState, type ArchiveFilter, type ArchiveOutcome } from '../shared/archive.ts';
import { OFF_FLEET_REFUSAL, excludedWorkspace, isOffFleet, refusalFor } from '../shared/workspaces.ts';
import { readBody } from './mcp.ts';
import { History, HISTORY_RETENTION_MS } from './history.ts';
import { AnswerMemory, MEMORY_FILE } from './memory.ts';
import { CapcomRouter, capcomOf, realTimers } from './capcom.ts';
import { HandoffStore } from './handoffs.ts';
import { parseHandoff, handoffText, HANDOFF_NOTICE_PREFIX } from '../shared/handoff.ts';
import { BudgetBook, budgetConfig, type BudgetEvent } from './budgets.ts';
import type { CapcomTimer } from './capcom.ts';
import { serveMcp } from './mcp.ts';
import { envRoots, resolveServedDir, resolveServedPath, scratchpadRoots, streamFile } from './files.ts';
import type { McpHttpDeps } from './mcp.ts';
import { hubContext } from '../agents/context.ts';
import { AgentLifecycle } from './lifecycle.ts';
import { createAutonomy } from './autonomy.ts';
import type { AutonomyApi } from './autonomy.ts';

/* ── constantes de operación ──────────────────────────────────────── */

/** Un socket que no dice `hello` a tiempo no es un cliente, es ruido. */
const HELLO_TIMEOUT_MS = 8_000;
/** Un comando sin ack en 30 s se declara fallido y se contesta ok:false. */
const CMD_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 15_000;
const SWEEP_INTERVAL_MS = 2_000;
// Margen que se da a las peticiones en vuelo al cerrar antes de cortar por lo sano.
const CLOSE_GRACE_MS = 1_000;
/**
 * Lo que se le da al frame de relevo para salir por el cable antes de que el
 * hub empiece a cerrar sockets. Medio segundo es de sobra para un frame de
 * veinte bytes por un socket ya abierto, y es tiempo que el operador ya está
 * esperando de todos modos: acaba de pedir un reinicio.
 */
const RESTART_GRACE_MS = 500;
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
  /** El proceso detrás del `hello`; null si era un collector que aún no lo manda. */
  instance: CollectorInstance | null;
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
   * Lo que el humano dijo al mando y ningún CAPCOM vivo recibió.
   *
   * Es una mirilla para las pruebas, que así observan qué prompt habría llegado
   * al mando sin levantar un collector. En producción no se pasa: no hay
   * segunda mente, el mensaje se guarda y el hub dice en voz alta que no hay
   * mando conectado.
   */
  onUnrouted?: (text: string, hub: Hub) => void;
  /** Cuánto se le da a CAPCOM para contestar. Las pruebas lo acortan. */
  capcomAnswerMs?: number;
  /** Reloj inyectable para esa cuenta atrás. Sin él, `setTimeout` de verdad. */
  capcomTimer?: (fn: () => void, ms: number) => CapcomTimer;
  /**
   * Raíces extra bajo las que `/api/file` puede servir, además de los
   * proyectos que el mundo conoce y del scratchpad de los agentes. Las
   * pruebas se dan un directorio temporal; en producción llega de
   * `ORCA_FILE_ROOTS`. Ver files.ts.
   */
  fileRoots?: string[];
  /**
   * Dónde persisten las carpetas que el operador autoriza desde el visor
   * (`files:allow`). Sin decir nada: el json real, salvo en el arnés, que
   * no toca el disco del operador. `null`: sólo en memoria.
   */
  fileRootsFile?: string | null;
  /**
   * Dónde vive la marca por proyecto de la puerta de lanzamiento
   * (`project-policy.ts`). Sin decir nada: el json real, salvo en el arnés,
   * que no hereda la política del operador. `null`: sin marcas.
   *
   * Un fichero que no existe NO se crea: sin él la puerta está abierta para
   * todos los proyectos, y arrancar el hub no la enciende para ninguno.
   */
  projectPolicyFile?: string | null;
  /** El libro de presupuestos. Una prueba inyecta el suyo, con reloj propio. */
  budgets?: BudgetBook;
  /**
   * ¿Es este hub de pruebas, y por tanto admite máquinas sintéticas?
   *
   * Por defecto lo dice el entorno (`ORCA_HARNESS`, ver shared/synthetic.ts) y
   * nada más: ni un flag del cliente ni un frame del protocolo. Está aquí
   * porque una prueba que arranca un hub EN PROCESO necesita poder pedir las
   * dos posturas —`test/run.ts` marca la corrida entera como arnés, y la
   * prueba de la frontera necesita un hub que no lo sea— y porque un hub que
   * lee su entorno al arrancar no se puede examinar de otra forma. El
   * `src/orca.ts` de producción no lo pasa nunca.
   */
  harness?: boolean;
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
  /**
   * ¿Es este hub de pruebas? Lo que decide si una máquina sintética puede
   * siquiera conectarse. Ver shared/synthetic.ts.
   */
  harness: boolean;
  http: Server;
  port: number;
  url: string;
  /**
   * La consola construida que este hub sirve, o null si no hay ninguna. Lo lee
   * el arranque para saber si decir «abre esta url» o «construye primero».
   */
  dist: string | null;
  /** Publica un mensaje del CEO a todas las consolas y lo persiste. */
  pushCeoMessage(msg: CeoMessage): void;
  missions: MissionStore;
  /**
   * Higiene: el último informe de cada máquina y el total de la flota. En
   * memoria, fuera del mundo. `refresh` pide muestra fresca a cada collector
   * conectado y devuelve a cuántos llegó — la petición es un frame propio, no
   * un `Command`: no cambia nada en la máquina, sólo la mide.
   */
  hygiene: {
    all(): import('../shared/hygiene.ts').HygieneReport[];
    get(machineId: string): import('../shared/hygiene.ts').HygieneReport | undefined;
    fleet(): import('./hygiene.ts').FleetHygiene;
    refresh(force?: boolean): number;
  };
  /**
   * Presupuestos por agente, escuadrón y tarea. El hub los vigila en cada
   * sweep: avisa a CAPCOM al 80 %, y al 100 % para a quien no progresa.
   */
  budgets: BudgetBook;
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
   * Archiva agentes terminados (done/dead) que cumplan el filtro: salen del
   * mundo y quedan con lápida para que el collector no los devuelva. Con
   * `dryRun` sólo cuenta. Nunca toca un agente vivo.
   */
  archiveAgents(filter: ArchiveFilter, opts: { dryRun?: boolean; by?: string }): ArchiveOutcome;
  /** Las lápidas vigentes: lo retirado, que es lo único cuyo transcript se puede purgar. */
  archivedAgents(): import('../shared/archive.ts').ArchivedAgent[];
  /**
   * La sesión CAPCOM viva de esta flota, o null.
   *
   * Es lo que decide quién manda: con CAPCOM arriba, lo que escribe el humano y
   * cada pregunta de un agente van a esa sesión y la API no se toca.
   */
  capcom(): Agent | null;
  /** Las piezas del squad autonomy (wake, verify, land, budget, journal). Ver autonomy.ts. */
  autonomy: AutonomyApi;
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

/**
 * Cabeceras que sólo pone un intermediario. Su presencia significa que el otro
 * extremo del socket es el proxy, no el cliente.
 */
const PROXY_HEADERS = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'] as const;

/**
 * Una dirección que nunca es loopback y no finge ser una IP.
 *
 * Es lo que se devuelve cuando hay un proxy delante y no se le ha autorizado:
 * no sabemos quién llama, y eso ya basta para que deje de contar como local.
 */
const BEHIND_PROXY = 'proxy';

/** La primera dirección de un `x-forwarded-for`, que es la del cliente. */
function firstForwarded(raw: string): string {
  const first = raw.split(',')[0] ?? '';
  return first.trim();
}

/**
 * De dónde viene la petición.
 *
 * Con el hub detrás de un túnel, `socket.remoteAddress` es siempre 127.0.0.1 —
 * el proxy corre en la misma máquina— y todo internet pasaría por local. Así
 * que si vienen cabeceras de proxy, el socket ya no es la fuente de la verdad:
 * o el humano ha dicho que se pueden creer (ORCA_TRUST_PROXY=1), o la petición
 * deja de ser local. Falla cerrado, que es lo que hay que hacer cuando la
 * alternativa es abrir la flota entera sin un solo error en el log.
 */
/**
 * La instancia que declara un `hello`, o null si no la trae o viene mal.
 * Es texto que va a logs y a un motivo de cierre: se acota, no se confía.
 */
function sanitizeInstance(raw: unknown): CollectorInstance | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['pid'] !== 'number' || !Number.isFinite(r['pid'])) return null;
  if (typeof r['startedAt'] !== 'number' || !Number.isFinite(r['startedAt'])) return null;
  const cwd = typeof r['cwd'] === 'string' ? r['cwd'].slice(0, 200) : '';
  return { pid: r['pid'], cwd, startedAt: r['startedAt'] };
}

/** Un motivo de cierre no puede pasar de 123 bytes UTF-8, o `ws` lanza. */
function closeReason(text: string): string {
  let out = text;
  while (Buffer.byteLength(out, 'utf8') > 123) out = out.slice(0, -1);
  return out;
}

function remoteOf(req: IncomingMessage): string {
  let forwarded = '';
  for (const h of PROXY_HEADERS) {
    const v = req.headers[h];
    const raw = Array.isArray(v) ? v[0] : v;
    if (typeof raw === 'string' && raw.trim().length > 0) { forwarded = firstForwarded(raw); break; }
  }
  if (!forwarded) return req.socket.remoteAddress ?? '';
  return process.env['ORCA_TRUST_PROXY'] === '1' ? forwarded : BEHIND_PROXY;
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
    case 'model:list': return `model:list ${cmd.agentId}`;
    case 'model:set': return `model:set ${cmd.agentId} ${cmd.model ?? 'cancel'}`;
    case 'capcom:new:cancel': return `capcom:new:cancel ${cmd.agentId}`;
    case 'spawn': return `spawn ${cmd.projectId}`
      + (cmd.squad ? ` [${cmd.squad}${cmd.lead ? ' lead' : ''}]` : '');
    case 'say': return `say ${cmd.agentId}`;
    case 'interrupt': return `interrupt ${cmd.agentId}${cmd.text ? ' +message' : ''}`;
    case 'permit': return `permit ${cmd.agentId} allow=${cmd.allow}`;
    case 'stop': return `stop ${cmd.agentId}${cmd.reason ? `: ${cmd.reason.slice(0, 500)}` : ''}`;
    case 'resume': return `resume ${cmd.agentId}`;
    case 'remove': return `remove ${cmd.agentId}`;
    case 'answer': return `answer ${cmd.escalationId}`;
    case 'deliver': return `deliver ${cmd.message.kind} → ${cmd.agentId}`;
    case 'reply': return `reply ${cmd.messageId}`;
    case 'project:register': return `project:register ${cmd.path}`;
    case 'key:set': return `key:set ${cmd.projectId}/${cmd.name} (valor omitido)`;
    case 'key:remove': return `key:remove ${cmd.projectId}/${cmd.name}`;
    case 'artifact:read': return `artifact:read ${cmd.artifactId}`;
    case 'resync': return 'resync';
    case 'logs': return `logs ${cmd.agentId}`;
    case 'autonomy': return `autonomy ${cmd.op} ${cmd.agentId}`;
    case 'land': return `land ${cmd.agentId}`;
    case 'discard': return `discard ${cmd.agentId}`;
    case 'strays:clean': return `strays:clean ${cmd.ids.length} en ${cmd.machineId}${cmd.dryRun ? ' (dry run)' : ''}`;
    case 'models:list': return `models:list ${cmd.machineId}`;
    case 'files:allow': return `files:allow ${cmd.path}`;
    default: return 'desconocido';
  }
}

function isCommand(v: unknown): v is Command {
  if (typeof v !== 'object' || v === null) return false;
  const k = (v as { k?: unknown }).k;
  return typeof k === 'string' && [
    'spawn', 'say', 'interrupt', 'permit', 'stop', 'resume', 'remove', 'answer', 'deliver',
    'reply', 'key:set', 'key:remove', 'artifact:read', 'resync', 'logs', 'autonomy',
    'recovery:settings', 'recovery:status', 'recovery:decide', 'files:allow', 'land', 'discard', 'model:list', 'model:set', 'capcom:new', 'capcom:new:cancel', 'handoff:models', 'handoff:prepare', 'handoff:commit', 'handoff:status', 'handoff:history',
    // La consola puede pedir limpiar restos. Sigue sin ser un `kill` genérico:
    // el collector sólo obedece sobre lo que su propio escáner reconoció como
    // huérfano de ORCA, y lo revalida antes de mandar una señal.
    'strays:clean',
    // Leer el catálogo de una máquina no cambia nada en ella.
    'models:list',
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
/**
 * El código del servidor, para saber si sigue siendo el que corre.
 *
 * Es la carpeta `src/` de este mismo árbol: `source-rev.ts` decide qué parte
 * de ella cuenta y por qué.
 */
const SRC_DIR: string = fileURLToPath(new URL('..', import.meta.url));

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

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.max(min, Math.min(max, n));
}

export async function startHub(options: HubOptions = {}): Promise<Hub> {
  const quiet = options.quiet ?? false;
  const log = (...args: unknown[]): void => { if (!quiet) console.log('[hub]', ...args); };
  const warn = (...args: unknown[]): void => { if (!quiet) console.warn('[hub]', ...args); };

  /*
   * Dónde escucha, resuelto aquí y no en el arranque, porque de esto depende
   * si existe la puerta anónima local: un hub alcanzable desde la tailnet no
   * puede fiarse de que una petición diga venir de 127.0.0.1.
   */
  const host = options.host ?? process.env['ORCA_HOST'] ?? '0.0.0.0';
  /*
   * La frontera del arnés, resuelta una vez al arrancar.
   *
   * Se lee del entorno del PROCESO, no de nada que llegue por el cable: es la
   * corrección del incidente del 2026-09-07, donde quien decidía si el arnés
   * entraba era el propio arnés y le bastó un `--anyway`. Ver
   * shared/synthetic.ts.
   *
   * Y antes de abrir nada en disco: un hub de pruebas sobre el ORCA_HOME del
   * operador no arranca (ver `harnessHomeRefusal`). Después ya habría leído
   * y reescrito el directorio del hub real.
   */
  const harness = options.harness ?? isHarnessHub(process.env);
  const refused = harnessHomeRefusal({ harness, orcaDir: ORCA_DIR });
  if (refused) throw new Error(refused);
  const auth = options.auth ?? createAuth(process.env, { host });
  const store = options.store ?? new HubStore();
  const mem = options.memory ?? new AnswerMemory(MEMORY_FILE);
  const history = options.history ?? new History();
  const artifactCache = options.artifactCache ?? ARTIFACT_CACHE_DIR;
  const fileRoots = options.fileRoots ?? [];
  const fleets = options.fleets ?? new FleetStore();
  // Carpetas que el operador autorizó desde el visor (file-roots.ts).
  const approvedRoots = new FileRoots(options.fileRootsFile !== undefined ? options.fileRootsFile : harness ? null : FILE_ROOTS_FILE);
  // Qué proyectos sólo admiten escritura desde un squad FORGE, si es que hay
  // alguno: sin fichero no hay marcas, y esto no lo escribe (project-policy.ts).
  const projectPolicy = new ProjectPolicy(
    options.projectPolicyFile !== undefined ? options.projectPolicyFile : harness ? null : projectPolicyFile(),
  );

  // whisper.cpp, looked up on every request: a model dropped into
  // ORCA_HOME/models while the hub runs is found without a restart. The
  // vocabulary is the fleet as it stands when the operator speaks.
  const transcribeAudio = transcribeHandler({
    config: () => whisperConfig(ORCA_DIR),
    vocabulary: () => vocabulary(world.state),
  });
  let push: PushService | null = null;
  const getPush = () => push ??= new PushService(ORCA_DIR);
  if (!harness && existsSync(join(ORCA_DIR, 'push.json'))) getPush();

  const collectors = new Map<string, CollectorConn>();   // machineId → conn
  /** Quién echó a quién por máquina; a partir del segundo en diez minutos, aviso. */
  const replacements = new ReplacementWatch();
  const orphanCollectors = new Set<CollectorConn>();     // aún sin hello
  const consoles = new Set<ConsoleConn>();
  const pending = new Map<string, Pending>();
  /**
   * Terminales abiertas: termId → quién mira y en qué máquina está el pane.
   * El hub no entiende los bytes; sólo sabe a quién pertenecen.
   */
  const terms = new Map<string, { consoleId: string; machineId: string; agentId: string }>();
  /** Terminales que una consola puede tener abiertas a la vez. */
  const MAX_TERMS_PER_CONSOLE = 12;

  /* ── mundo + bus ────────────────────────────────────────────────── */

  // Ciclo de vida tipado para el squad autonomy; se alimenta desde onEvent.
  const lifecycle = new AgentLifecycle();

  /*
   * Publicar la consola cuando el trabajo sobre ORCA termina.
   *
   * Un agente que acaba de mejorar la consola deja el trabajo en el disco, y
   * hasta que alguien construye no existe para el operador. Aquí se cierra ese
   * hueco y sólo ése: se construye, y a partir de ahí manda la doctrina de
   * siempre — se enciende la píldora y el clic es del operador. Ver
   * hub/publisher.ts y docs/PRODUCCION.md.
   */
  const publisher = autopublishEnabled(process.env, harness)
    ? createPublisher({
      run: () => spawnPublish(),
      // unref: un build pendiente no puede ser la razón de que ORCA no salga.
      setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      note: (line) => log(line),
      // A CAPCOM, que es quien puede arreglar un árbol que no compila. Al
      // operador no se le interrumpe con un build roto: él sólo verá la
      // píldora cuando haya algo que de verdad se pueda aplicar.
      tellCapcom: (text) => { capcomRouter.humanSays(text); },
    })
    : null;

  const offPublishOnDone = publisher
    ? lifecycle.on('agent:state', (change) => {
      const projectId = change.agent.projectId;
      const project = projectId ? world.state.projects[projectId] : undefined;
      if (!finishedOwnWork(change, project?.path)) return;
      publisher.request(`${change.agent.callsign} terminó sobre ${project?.name ?? 'ORCA'}`);
    })
    : null;

  const world = new World({
    onOps: (ops: PatchOp[]) => bus.push(ops),
    // Las lápidas van a disco en cuanto se ponen: un hub que reinicia sin
    // ellas vería volver, en el primer snapshot, todo lo que se archivó.
    onArchived: (entries) => store.appendArchived(entries),
    onUnarchived: (id, at) => store.appendUnarchived(id, at),
    onEvent: (ev: WorldEvent) => {
      store.logEvent(ev);
      lifecycle.feed(ev, ev.agentId ? world.state.agents[ev.agentId] : null);
      // Un archivado que reaparece vivo llegó como patch, sin registro entero:
      // se le pide a la máquina el snapshot que lo trae.
      if (ev.kind === 'agent:unarchived' && (ev.data as { resync?: boolean } | undefined)?.resync) {
        queueMicrotask(() => { dispatchLocal({ k: 'resync' }).catch((err) => warn('resync tras desarchivar falló:', err)); });
      }
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
            // Se le ofrece a CAPCOM. Si no hay CAPCOM vivo la pregunta se queda
            // en la cola del humano, que es donde iba a acabar de todos modos.
            capcomRouter.offer(escId);
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

  // Coalesce bursts without scanning or writing push state on the patch path.
  const pushTimer = setInterval(() => {
    if (push && !harness) void push.observe(world.state).catch(() => warn('push persistence failed'));
  }, 2000);
  pushTimer.unref();

  /*
   * El mando de la flota.
   *
   * Si hay una sesión con `role:'capcom'` viva, ella recibe lo que escribe el
   * humano y cada pregunta que levanta un agente. Si no la hay, no manda nadie:
   * el mensaje se guarda, la pregunta va a la cola del humano, y el hub lo dice.
   */
  /** La máquina donde vive el mando ahora mismo, o null si no manda nadie. */
  function capcomMachine(): Machine | undefined {
    const cap = capcomOf(world.state.agents);
    return cap ? world.state.machines[cap.machineId] : undefined;
  }

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
    // La cuarentena del arnés: una máquina que se declara sintética no le llega
    // al mando de verdad. Ver shared/synthetic.ts.
    routable: (machineId) => sameWorld(world.state.machines[machineId], capcomMachine()),
    callsign: (id) => world.state.agents[id]?.callsign ?? null,
    note: (text) => {
      log(text);
      world.pushFeed('', [{
        id: newId('f_cap'), at: Date.now(), level: 'info', source: 'CAPCOM', text,
      }]);
    },
    setTimer: options.capcomTimer ?? realTimers(),
  }, {
    ...(options.capcomAnswerMs !== undefined ? { answerMs: options.capcomAnswerMs } : {}),
  });

  /*
   * Autonomía del mando: despertador, verificación, aterrizaje, presupuestos
   * y diario. Todo inyectado, igual que el router: los tests le dan su reloj.
   */
  const autonomy = createAutonomy({
    agents: () => Object.values(world.state.agents),
    agent: (id) => world.state.agents[id],
    projects: () => Object.values(world.state.projects),
    project: (id) => world.state.projects[id],
    machine: (id) => world.state.machines[id],
    missions: () => missions.all(),
    capcom: () => capcomRouter.live(),
    contextCutoff: () => capcomRouter.contextCutoff(),
    sayToCapcom: (text) => capcomRouter.humanSays(text),
    dispatch: (cmd) => dispatchLocal(cmd),
    stopAgent: (agentId) => dispatchLocal({ k: 'stop', agentId }),
    dir: store.dir,
    env: process.env,
    now: () => Date.now(),
    setTimer: options.capcomTimer ?? realTimers(),
    setInterval: (fn, ms) => {
      const h = setInterval(fn, ms);
      h.unref?.();
      return { cancel: () => clearInterval(h) };
    },
    log: (text) => log(text),
    note: (text) => {
      world.pushFeed('', [{ id: newId('f_auto'), at: Date.now(), level: 'info', source: 'AUTONOMY', text }]);
    },
    // Para el operador, no para el registro: una pregunta suya que lleva media
    // hora sin contestar merece el mismo nivel que una escalación que se quedó
    // sin respuesta, y por el mismo motivo.
    alert: (text) => {
      log(text);
      world.pushFeed('', [{ id: newId('f_mission'), at: Date.now(), level: 'warn', source: 'CAPCOM', text }]);
    },
    // El mismo camino que `relay`: el mensaje entra al mundo y el collector lo
    // escribe en el buzón del destinatario. Ver `wake.tellLead`.
    tellAgent: ({ toAgentId, kind, subject, body }) =>
      hub.relayMessage({ kind, scope: 'agent', toAgentId, subject, body }).delivered.length > 0,
    saidTo: (fromAgentId, since) => Object.values(world.state.messages)
      .filter((m) => m.fromAgentId === fromAgentId && m.at >= since)
      .map((m) => ({ toAgentId: m.toAgentId, toSquad: m.toSquad })),
    // Lo que mira el aviso de miembro esperando a su líder. Ver `wake.squadWaits`.
    messages: () => Object.values(world.state.messages),
    lifecycle,
    ...(publisher ? { publisher } : {}),
    // El tablero de AUTOMEJORA entero, empujado cuando cambia. Son unos pocos
    // kilobytes cada varias horas: mucho más barato que un `PatchOp` por
    // propuesta y una máquina de estados en la consola para reensamblarlo.
    improveChanged: () => broadcast({ t: 'improve', ...improveWire() }),
    /*
     * El techo del revisor, por el libro que ya frena a todos los demás. Por
     * short id mientras la sesión no ha aparecido: el libro lo resuelve solo
     * cuando el CLI la nombra. Un presupuesto propio para esta sección sería
     * una segunda contabilidad que un día discrepa de la que se enseña.
     */
    improveBudget: (ref, tokens) => {
      const limit = { tokens, min: null };
      if (ref.agentId) budgets.set({ kind: 'agent', ref: ref.agentId }, limit);
      else if (ref.shortId) budgets.setPendingByShortId(ref.shortId, limit);
    },
  });

  const missionResultTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const missionResultSeen = new Map<string, string>();
  const missions = new MissionStore(store.dir, (mission) => {
    const purged = (mission as CapcomMission & { purged?: true }).purged === true;
    if (purged) {
      if (world.state.missions) delete world.state.missions[mission.id];
      clearTimeout(missionResultTimers.get(mission.id));
      missionResultTimers.delete(mission.id); missionResultSeen.delete(mission.id);
    } else (world.state.missions ??= {})[mission.id] = mission;
    broadcast({ t: 'mission', mission, ...(purged ? { purged: true } : {}) });
    // La propuesta de AUTOMEJORA que abrió esta misión copia su cierre y su
    // archivo, y los deshace si la misión vuelve. Ver `ImproveStore.syncMission`.
    if (!purged) autonomy.improve.store.syncMission(mission);
    const last = mission.messages.at(-1);
    // Una misión retirada no despierta a CAPCOM con la actividad de sus workers.
    if (purged || mission.archivedAt || mission.status !== 'active' || last?.role !== 'agent' || missionResultSeen.get(mission.id) === last.id) return;
    missionResultSeen.set(mission.id, last.id);
    clearTimeout(missionResultTimers.get(mission.id));
    missionResultTimers.set(mission.id, setTimeout(() => {
      missionResultTimers.delete(mission.id);
      const current = missions.get(mission.id);
      if (current.status !== 'active') return;
      const cutoff = capcomRouter.contextCutoff();
      const sourceAt = last.agentId ? world.state.agents[last.agentId]?.updatedAt : undefined;
      if (cutoff !== null && (last.at <= cutoff || (sourceAt !== undefined && sourceAt <= cutoff))) return;
      /*
       * Quién habló decide qué se le pide a CAPCOM. Si fue el LÍDER de la
       * misión, el trabajo ya está consolidado y verificado por él: CAPCOM
       * publica y no rehace. Un miembro de squad no llega aquí mientras su
       * líder viva (`observe` se lo manda al líder); lo que sí llega es un
       * agente suelto, y ése sí se revisa como siempre.
       */
      const lead = missionLeadOf(current, (id) => world.state.agents[id], Object.values(world.state.agents));
      const fromLead = !!lead && last.agentId === lead.agent.id;
      const ask = fromLead
        ? `The lead of this mission (${lead.agent.callsign}) reported. It consolidated and verified its crew's work; publish its result with report_mission (completed, failed, or active if it says more is coming). Do not redo, re-test or re-verify the work, and do not launch anyone for it.`
        : 'Worker results arrived. Review them and report progress or completion to this mission.';
      const prompt = cutoff === null ? `${ask}\n${missionPrompt(current)}`
        : `[ORCA MISSION ${current.id}] ${ask} Historical context is not attached. Use report_mission(mission_id="${current.id}") for replies.\n${last.text}`;
      const sent = capcomRouter.humanSays(prompt, (agentId, text) => {
        void dispatchLocal({ k: 'say', agentId, text }).catch((err) => {
          log(`mission ${mission.id}: worker update delivery failed: ${String(err)}`);
        });
      }, (reason) => { missions.message(mission.id, 'system', `Delivery failed: ${reason}`); });
      if (!sent) options.onUnrouted?.(prompt, hub);
    }, 750));
  });
  world.state.missions = missions.all();
  const recovery = new RecoveryCoordinator({
    dir: store.dir, agents: () => Object.values(world.state.agents), dispatch: dispatchLocal,
    automatic: process.env.ORCA_RECOVERY_AUTO === '1',
    budgetBlock: a => budgets.agentStatus(a, world.state.agents, missions.all()).level === 'over' ? 'Recovery cannot bypass the work budget. Review the budget or wait.' : null,
    notifyAllowed: (supervisor, a) => supervisor.role !== 'capcom' || capcomRouter.contextCutoff() === null || (quotaIncident(a)?.since ?? 0) > capcomRouter.contextCutoff()!,
    notify: async (supervisor, text) => {
      try { await dispatchLocal({ k: 'say', agentId: supervisor.id, text }); return true; }
      catch { return false; }
    },
    note: (text, agentId) => world.pushFeed('', [{ id: newId('f_recovery'), at: Date.now(), level: 'info', source: 'RECOVERY', agentId, text }]),
  });

  /*
   * Presupuestos.
   *
   * El libro decide; aquí sólo se reparte lo que dice: la línea a CAPCOM por
   * el mismo canal por el que le llega todo lo demás, una entrada en el feed,
   * y —cuando toca— el `stop` al collector. Se evalúa en el sweep de dos
   * segundos, que ya es el pulso al que el hub mira la flota.
   */
  /*
   * Higiene: el último informe de cada máquina, en memoria y fuera del mundo.
   * Son unos kilobytes por máquina en su propio reloj y ninguna baldosa
   * depende de ellos; meterlos en `WorldState` los metería en cada patch por
   * el bien de una ventana que casi nunca está abierta.
   */
  const hygiene = new HygieneRegistry(() => Date.now());
  /** Pide muestra a cada collector vivo. Devuelve a cuántos les llegó. */
  const refreshHygiene = (force = false): number => {
    let sent = 0;
    for (const conn of collectors.values()) {
      if (!conn.authed) continue;
      send(conn, { t: 'hygiene:sample', ...(force ? { force: true } : {}) });
      sent++;
    }
    return sent;
  };

  // El libro pregunta al mundo si un agente sigue existiendo antes de decir
  // nada de él. Sin esto, un fantasma —sesión de tmux desaparecida, estado
  // congelado en `working`— avisaba en bucle y ninguna herramienta lo alcanzaba.
  const budgets = options.budgets
    ?? new BudgetBook(store.dir, budgetConfig(), {
      liveness: () => ({ machines: world.state.machines }),
      // Un techo que se borra por no tener ya a quién frenar es un hecho, no un
      // aviso: va al log del hub y no a CAPCOM, que no puede hacer nada con él.
      onPrune: (keys) => log(`techos retirados por no quedar sujeto: ${keys.join(', ')}`),
    });
  const budgetNote = (level: 'warn' | 'alert', text: string, agentId: string | null): void => {
    world.pushFeed('', [{
      id: newId('f_bud'), at: Date.now(), level, source: 'BUDGET', text,
      ...(agentId ? { agentId, projectId: world.state.agents[agentId]?.projectId } : {}),
    }]);
  };
  /** Cuántas líneas del detalle caben en un aviso agrupado antes de resumir. */
  const BUDGET_DIGEST_LINES = 6;

  /**
   * Una ráfaga es UN suceso.
   *
   * Trece `[BUDGET 100%]` seguidos, por el mismo motivo y en el mismo instante,
   * taparon un informe que el operador estaba leyendo. El feed sigue llevando
   * una entrada por aviso — es historia, y cada una cuelga de su agente —, pero
   * a CAPCOM le llega un solo mensaje por pasada, con la cuenta por severidad,
   * el peor caso y las primeras líneas completas.
   */
  const budgetDigest = (events: BudgetEvent[]): string => {
    const rank = (e: BudgetEvent): number => (e.kind === 'stop' ? 0 : e.kind === 'swarm' ? 1 : e.kind === 'over' ? 2 : 3);
    const sorted = [...events].sort((a, b) => rank(a) - rank(b) || pctOf(b) - pctOf(a));
    const count = (k: BudgetEvent['kind']) => events.filter((e) => e.kind === k).length;
    const worst = sorted.filter((e) => e.kind !== 'swarm').reduce<BudgetEvent | null>(
      (w, e) => (!w || pctOf(e) > pctOf(w) ? e : w), null);
    const tally = [
      count('stop') ? `${count('stop')} stopped` : null,
      count('over') ? `${count('over')} at 100%` : null,
      count('warn') ? `${count('warn')} at 80%` : null,
      count('swarm') ? `${count('swarm')} over the subagent cap` : null,
    ].filter(Boolean).join(', ');
    const head = `[BUDGET] ${events.length} budget notices in one sweep — ${tally}.`
      + (worst && worst.kind !== 'swarm' ? ` Worst: ${worst.label} at ${Math.round(worst.pct * 100)}%.` : '');
    const shown = sorted.slice(0, BUDGET_DIGEST_LINES).map((e) => `· ${e.text}`);
    const rest = sorted.length - shown.length;
    return [head, ...shown, rest > 0 ? `· …and ${rest} more, all of them in the console feed.` : null]
      .filter(Boolean).join('\n');
  };

  const pctOf = (e: BudgetEvent): number => (e.kind === 'swarm' ? 0 : e.pct);

  const budgetSweep = (): void => {
    const events = budgets.tick(world.state.agents, missions.all());
    if (events.length === 0) return;

    for (const ev of events) {
      const subject = ev.kind === 'warn' || ev.kind === 'over' ? ev.agentIds[0] ?? null : ev.agentId;
      budgetNote(ev.kind === 'warn' ? 'warn' : 'alert', ev.text, subject);
      log(ev.text);
    }

    const stops = events.flatMap((ev) => (ev.kind === 'stop' ? [ev.agentId] : ev.kind === 'swarm' ? ev.stopIds : []));
    for (const agentId of stops) {
      void dispatchLocal({ k: 'stop', agentId }).catch((err) => {
        const cs = world.state.agents[agentId]?.callsign ?? agentId;
        budgetNote('alert', `[BUDGET STOP] ${cs}: the stop did not go through (${String(err)})`, agentId);
      });
    }

    const text = events.length === 1 ? events[0]!.text : budgetDigest(events);
    const sent = capcomRouter.humanSays(text);
    if (!sent) options.onUnrouted?.(text, hub);
  };

  // Lo que les pasó a las misiones mientras el hub no estaba —o antes de que
  // supiera contarlo— llega a sus propuestas de AUTOMEJORA al arrancar.
  const resynced = autonomy.improve.store.syncMissions(missions.all());
  if (resynced.length > 0) log(`propuestas de AUTOMEJORA puestas al día con su misión: ${resynced.length}`);

  // La conversación con CAPCOM sobrevive a los reinicios del hub.
  const archivedBefore = store.loadArchived();
  if (archivedBefore.length > 0) {
    world.hydrateArchived(archivedBefore);
    log(`agentes archivados recuperados: ${archivedBefore.length}`);
  }

  const priorCeo = store.loadCeo();
  if (priorCeo.length > 0) {
    world.hydrateCeo(priorCeo);
    log(`conversación con CAPCOM recuperada: ${priorCeo.length} mensajes`);
  }
  const handoffs = new HandoffStore(store.dir);
  world.state.capcomHandoffs = handoffs.all();
  const lastContext = handoffs.all().at(-1);
  if (lastContext) capcomRouter.setContext(lastContext.contextMode, lastContext.cutoffAt);

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

  /* ── ¿corre este hub el código que hay en disco? ─────────────────── */

  /**
   * Perezoso a propósito: el centinela nace con la primera consola. Sin nadie
   * mirando no hay a quién avisar, y así ninguna suite que no conecte una
   * consola se pone a escanear `src/`. Ver hub/source-rev.ts.
   */
  let source: SourceSentinel | null = null;
  let sourceBoot: Promise<SourceSentinel> | null = null;

  function sendServerRev(conn: ConsoleConn, s: SourceSentinel): void {
    send(conn, { t: 'server', rev: s.boot(), stale: s.stale(), restartable: isSupervised() });
  }

  /**
   * Decirle a una consola recién saludada qué código corre este hub.
   *
   * Va aparte porque hay DOS formas de entrar —el token en la query, que es
   * la del navegador, y el `hello`, que es la de todo lo demás— y las dos
   * tienen que contarlo. Cablearlo sólo en una fue el fallo obvio: el frame
   * llegaba en las pruebas por WebSocket y no llegaba nunca en la consola de
   * verdad, que entra por la otra puerta.
   */
  function greetSource(conn: ConsoleConn): void {
    void ensureSource()
      .then((s) => { if (conn.authed && conn.ws.readyState === WebSocket.OPEN) sendServerRev(conn, s); })
      .catch(() => { /* sin árbol que mirar: no hay nada que decir */ });
  }

  function ensureSource(): Promise<SourceSentinel> {
    return sourceBoot ??= sourceRev(SRC_DIR).then((boot) => {
      const s = createSourceSentinel(boot, {
        rev: () => sourceRev(SRC_DIR),
        // unref: este reloj no puede ser nunca la razón de que ORCA no salga.
        set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
        clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      });
      s.onStale(() => {
        log('el código del servidor cambió desde que este proceso arrancó; reinicia ORCA para aplicarlo');
        for (const conn of consoles) if (conn.authed) sendServerRev(conn, s);
      });
      s.start();
      source = s;
      return s;
    });
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
      case 'recovery:settings': return { machineId: null, broadcast: false };
      case 'files:allow': return { machineId: null, broadcast: false };   // el hub sirve los archivos; nadie más
      case 'resync':
        return { machineId: null, broadcast: true };
      case 'spawn':
      case 'key:set':
      case 'key:remove': {
        /*
         * El directorio de CAPCOM ya no se registra como proyecto, así que un
         * spawn ahí fallaría de todas formas — pero con "proyecto desconocido",
         * que le dice a quien lo pidió que lo intente con otro id en vez de que
         * ahí no se lanza. El id de proyecto es `<máquina>/<slug>`, y el slug
         * basta para reconocer el sitio aunque nadie lo haya registrado.
         */
        const why = excludedWorkspace(cmd.projectId.slice(cmd.projectId.indexOf('/') + 1));
        if (why) return { machineId: null, broadcast: false, error: refusalFor(why) };
        // La isla que agrupa todo eso tampoco es un sitio donde lanzar.
        if (isOffFleet(cmd.projectId)) return { machineId: null, broadcast: false, error: OFF_FLEET_REFUSAL };
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
      case 'project:register':
      case 'transcripts:purge':
      case 'strays:clean':
      case 'models:list':
        // La máquina viene en el comando: sus agentes ya no están en el mundo.
        // En `project:register` es lo único que puede venir — el proyecto es
        // justo lo que todavía no existe.
        return world.state.machines[cmd.machineId]
          ? { machineId: cmd.machineId, broadcast: false }
          : { machineId: null, broadcast: false, error: `máquina desconocida: ${cmd.machineId}` };
      default: {
        const a = world.state.agents[cmd.agentId];
        return a ? { machineId: a.machineId, broadcast: false }
          : { machineId: null, broadcast: false, error: `agente desconocido: ${cmd.agentId}` };
      }
    }
  }

  /**
   * Archivar terminados. El filtro viene de la red (consola, MCP, CLI), así
   * que se copia campo a campo: un objeto ajeno no entra al mundo tal cual.
   */
  function archiveAgents(raw: unknown, opts: { dryRun?: boolean; by?: string }): ArchiveOutcome {
    const f = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const filter: ArchiveFilter = {
      projectId: typeof f['projectId'] === 'string' && f['projectId'] ? f['projectId'] : null,
      squad: typeof f['squad'] === 'string' && f['squad'] ? f['squad'] : null,
      olderThanMs: typeof f['olderThanMs'] === 'number' && f['olderThanMs'] > 0 ? f['olderThanMs'] : null,
      state: archivableState(f['state']),
      ids: Array.isArray(f['ids']) ? f['ids'].filter((x): x is string => typeof x === 'string').slice(0, 2_000) : null,
      hidden: f['hidden'] === true ? true : null,
    };
    const out = world.archiveAgents(filter, opts);
    if (!out.dryRun && out.archived.length > 0) {
      log(`archivados ${out.archived.length} agente(s) por ${opts.by ?? '?'}`
        + (out.squadsRetired.length ? `; squads retirados: ${out.squadsRetired.join(', ')}` : ''));
    }
    return out;
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
    // Parar a alguien le saca del ciclo de presupuesto en el acto, venga la
    // orden de la consola, de `stop_agent`, de `stop_squad` o del propio libro.
    // Esperar al `dead` del collector es lo que dejaba a dos escuadrones
    // muertos avisando durante horas: la sesión de tmux ya no existía y el
    // estado nunca llegó.
    if (cmd.k === 'stop' && (consoleId !== null || cmd.reason !== undefined)) {
      const why = agentStopReason(world.state.agents[cmd.agentId], Object.values(missions.all()));
      if (why || (cmd.reason !== undefined && (typeof cmd.reason !== 'string' || !cmd.reason.trim()))) {
        ackTo(consoleId, cmdId, false, why ?? 'A stop reason is required');
        return;
      }
    }
    if (cmd.k === 'stop') budgets.retire(cmd.agentId);
    if (cmd.k === 'files:allow') {
      const request = cmd;
      void approvedRoots.allow(request.path)
        .then((r) => r.ok ? ackTo(consoleId, cmdId, true, undefined, { root: r.root, added: r.added, roots: approvedRoots.list() }) : ackTo(consoleId, cmdId, false, r.reason))
        .catch((e) => ackTo(consoleId, cmdId, false, String(e)));
      return;
    }
    if (cmd.k === 'recovery:settings') {
      try {
        const data = Object.hasOwn(cmd, 'automatic') ? recovery.setAutomatic(cmd.automatic!) : recovery.settings();
        ackTo(consoleId, cmdId, true, undefined, data);
      } catch (e) { ackTo(consoleId, cmdId, false, String(e)); }
      return;
    }
    if (cmd.k === 'recovery:status' || cmd.k === 'recovery:decide') {
      const request = cmd;
      void Promise.resolve().then<unknown>(() => request.k === 'recovery:status' ? recovery.status(request.agentId) : recovery.decide(request.agentId, request.decision))
        .then(data => ackTo(consoleId, cmdId, true, undefined, data)).catch(e => ackTo(consoleId, cmdId, false, String(e)));
      return;
    }
    if (cmd.k === 'say' || cmd.k === 'deliver') {
      const seen = new Set<string>();
      while (!seen.has(cmd.agentId)) {
        seen.add(cmd.agentId);
        const previousId: string = cmd.agentId;
        const capNext = (world.state.capcomHandoffs ?? []).find(h => h.fromId === previousId)?.toId;
        const next: Agent | undefined = (capNext ? world.state.agents[capNext] : undefined) ?? Object.values(world.state.agents).find(a => a.continuation?.fromId === previousId);
        if (!next || next.machineId !== world.state.agents[previousId]?.machineId) break;
        cmd = { ...cmd, agentId: next.id };
      }
    }
    if ((cmd.k === 'say' || cmd.k === 'deliver') && capcomRouter.holdingFor(cmd.agentId)) {
      const held = cmd;
      capcomRouter.humanSays('', agentId => { dispatchCommand(newId('cmd'), { ...held, agentId }, null); });
      ackTo(consoleId, cmdId, true, 'CAPCOM transition: message retained', { delivery: 'queued' });
      return;
    }
    if (cmd.k === 'capcom:new') {
      const a = world.state.agents[cmd.agentId];
      if (!a || a.role !== 'capcom') { ackTo(consoleId, cmdId, false, 'An active CAPCOM is required.'); return; }
      cmd = { ...cmd, checkpoint: cmd.mode === 'continuity' ? freshCapcomCheckpoint(world.state, mem.all()) : '' };
    }
    if (cmd.k === 'handoff:prepare') {
      const id = cmd.agentId; const a = world.state.agents[id]; const cap = a?.role === 'capcom';
      cmd = { ...cmd, checkpoint: JSON.stringify({ agent: a,
        missions: Object.values(world.state.missions ?? {}).filter(m => cap || m.agentIds.includes(id)),
        escalations: Object.values(world.state.escalations).filter(e => cap || e.agentId === id),
        messages: Object.values(world.state.messages).filter(m => cap || m.fromAgentId === id || m.toAgentId === id || (!!a?.squad && m.toSquad === a.squad)) }, null, 2) };
    }
    const target = targetOf(cmd);
    if (target.error) { ackTo(consoleId, cmdId, false, target.error); return; }
    /*
     * La puerta de lanzamiento, en el único sitio por el que pasan todos: la
     * consola, CAPCOM por MCP y los callers en proceso entran por aquí. Los
     * hijos que un agente pide con `orca-spawn` no pasan por el hub sino por
     * su collector, y ésos ya llevan el squad del padre (planChild), así que
     * el que entró por la puerta se la pasa a los suyos.
     */
    if (cmd.k === 'spawn') {
      const refusal = forgeGate(cmd, world.state.projects[cmd.projectId], projectPolicy);
      if (refusal) {
        store.logEvent({ at: Date.now(), kind: 'cmd', text: `spawn rechazado en ${cmd.projectId}: ${refusal}` });
        ackTo(consoleId, cmdId, false, refusal);
        return;
      }
    }
    // El diario atribuye el lanzamiento que viene: una consola es el humano;
    // sin consola detrás es el mando (MCP) o un caller en proceso.
    if (cmd.k === 'spawn') {
      try {
        autonomy.journal.spawnRequested({
          by: consoleId ? 'human' : 'capcom', projectId: cmd.projectId, mission: cmd.mission, squad: cmd.squad ?? null,
        });
      } catch (err) { warn('journal.spawnRequested falló:', err); }
    }

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

  /* ── terminales ─────────────────────────────────────────────────── */

  function sendToConsole(consoleId: string, frame: ServerFrame): void {
    for (const conn of consoles) {
      if (conn.id === consoleId) { send(conn, frame); return; }
    }
  }

  /**
   * Consola → collector. El hub valida la forma y decide la máquina; el
   * contenido —cols, filas, teclas— va tal cual. Un `term:open` sobre un agente
   * que no existe se contesta aquí con `term:exit`, que es lo único que una
   * ventana negra puede enseñar.
   */
  function relayTermDown(conn: ConsoleConn, frame: TermFrame): void {
    const termId = frame.termId;
    if (typeof termId !== 'string' || !TERM_ID_RE.test(termId)) return;
    const exit = (reason: string): void => { send(conn, { t: 'term:exit', termId, reason }); };

    if (frame.t === 'term:open') {
      if (terms.has(termId)) { exit('that terminal id is already in use'); return; }
      let mine = 0;
      for (const t of terms.values()) if (t.consoleId === conn.id) mine++;
      if (mine >= MAX_TERMS_PER_CONSOLE) { exit(`this console already has ${MAX_TERMS_PER_CONSOLE} terminals open`); return; }
      const a = typeof frame.agentId === 'string' ? world.state.agents[frame.agentId] : undefined;
      if (!a) { exit('unknown agent'); return; }
      const target = collectors.get(a.machineId);
      if (!target || target.ws.readyState !== WebSocket.OPEN) { exit('the agent’s machine is not connected'); return; }
      const cols = clampInt(frame.cols, 2, TERM_MAX_COLS, 120);
      const rows = clampInt(frame.rows, 2, TERM_MAX_ROWS, 36);
      terms.set(termId, { consoleId: conn.id, machineId: a.machineId, agentId: a.id });
      if (!send(target, { t: 'term:open', termId, agentId: a.id, cols, rows })) {
        terms.delete(termId);
        exit('could not reach the collector');
      }
      store.logEvent({ at: Date.now(), kind: 'cmd', machineId: a.machineId, text: `terminal on ${a.callsign}` });
      return;
    }

    const t = terms.get(termId);
    if (!t || t.consoleId !== conn.id) return;         // no es suya: se ignora en silencio
    const target = collectors.get(t.machineId);
    if (frame.t === 'term:close') {
      terms.delete(termId);
      if (target) send(target, { t: 'term:close', termId });
      return;
    }
    if (!target) return;
    if (frame.t === 'term:input') {
      if (typeof frame.data !== 'string' || !frame.data.length) return;
      send(target, { t: 'term:input', termId, data: frame.data.length > TERM_MAX_CHUNK ? frame.data.slice(0, TERM_MAX_CHUNK) : frame.data });
      return;
    }
    if (frame.t === 'term:resize') {
      send(target, { t: 'term:resize', termId, cols: clampInt(frame.cols, 2, TERM_MAX_COLS, 120), rows: clampInt(frame.rows, 2, TERM_MAX_ROWS, 36) });
    }
  }

  /** Collector → consola. Sólo la máquina dueña del pane puede hablar por ese termId. */
  function relayTermUp(machineId: string, frame: Extract<CollectorFrame, { t: 'term:data' | 'term:exit' }>): void {
    const termId = frame.termId;
    if (typeof termId !== 'string') return;
    const t = terms.get(termId);
    if (!t || t.machineId !== machineId) return;
    if (frame.t === 'term:exit') {
      terms.delete(termId);
      sendToConsole(t.consoleId, { t: 'term:exit', termId, reason: typeof frame.reason === 'string' ? frame.reason.slice(0, 300) : 'closed' });
      return;
    }
    if (typeof frame.data !== 'string' || !frame.data.length) return;
    sendToConsole(t.consoleId, { t: 'term:data', termId, data: frame.data.length > TERM_MAX_CHUNK ? frame.data.slice(0, TERM_MAX_CHUNK) : frame.data });
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
        let to = msg.toAgentId ? world.state.agents[msg.toAgentId] : undefined;
        const visited = new Set<string>();
        while (to && !visited.has(to.id)) {
          visited.add(to.id);
          const successor = (world.state.capcomHandoffs ?? []).find(h => h.fromId === to!.id)?.toId;
          if (!successor || !world.state.agents[successor]) break;
          to = world.state.agents[successor];
        }
        if (!to) return { delivered: [], skipped: 1, reason: `destinatario desconocido: ${msg.toAgentId ?? '?'}` };
        if (!canReceive(to) && !capcomRouter.holdingFor(to.id)) {
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

    /*
     * Y nunca cruzando la cuarentena del arnés. Un `squad` o un `fleet` se
     * resuelven por etiqueta y por nada más: un escuadrón sintético que se
     * llame como uno de verdad le pegaría el mensaje en el pane a agentes de
     * verdad —CAPCOM incluido— y ninguno de los dos lados lo notaría.
     * Ver shared/synthetic.ts.
     *
     * Sólo cuando el emisor es un agente de una máquina. Lo que manda el
     * operador (`fromAgentId:'ceo'`, sin máquina detrás) va a los dos mundos:
     * es la voz del humano, y el humano manda también sobre el arnés.
     */
    const sender = world.state.agents[msg.fromAgentId];
    if (sender) {
      const from = world.state.machines[sender.machineId];
      const crossWorld = targets.filter((a) => !sameWorld(from, world.state.machines[a.machineId]));
      if (crossWorld.length > 0) {
        targets = targets.filter((a) => !crossWorld.includes(a));
        skipped += crossWorld.length;
        reason = `cuarentena del arnés: ${crossWorld.length} destinatario(s) en el otro mundo`;
      }
    }

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
      const cutoff = capcomRouter.contextCutoff();
      if (cutoff !== null && msg.at <= cutoff && (a.role === 'capcom' || capcomRouter.holdingFor(a.id))) {
        skipped++; reason = 'Historical message preserved in the hub; clean CAPCOM does not replay it.'; continue;
      }
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
      authed: false, helloTimer: null, machineId: null, instance: null,
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
          /*
           * La puerta del arnés, y está aquí a propósito.
           *
           * Antes vivía en el cliente —el mock preguntaba si había mando vivo y
           * `--anyway` respondía que siguiera— y por eso no aguantó: quien
           * decidía era el que quería entrar. Ahora la máquina declara lo que
           * es en su `hello` y decide el hub, con lo único que el arnés no
           * puede falsificar desde fuera: su propio entorno. Se rechaza ANTES
           * de tocar el mundo, así que ni un agente ni un proyecto ni un dólar
           * inventado llegan a existir. Ver shared/synthetic.ts.
           */
          if (frame.machine?.synthetic === true && !harness) {
            warn(harnessRefusedWhy(machineId));
            ws.close(CLOSE_NOT_HARNESS, HARNESS_REFUSED);
            return;
          }
          const instance = sanitizeInstance(frame.instance);
          // Reconexión: la conexión vieja de esa máquina se descarta. Se cuenta
          // y se le dice al echado quién lo echó: sin eso, dos collectors con
          // el mismo id turnándose cada segundo parecen reconexiones normales.
          const previous = collectors.get(machineId);
          if (previous && previous !== conn) {
            previous.machineId = null;      // que su cierre no marque offline
            const verdict = replacements.note(machineId, previous.instance, instance, Date.now());
            const hostname = frame.machine.hostname;
            if (verdict.repeated) warn(replacementText(hostname, verdict));
            else log(`collector sustituido: ${machineId} (${hostname}), ${instanceLabel(instance)} echa a ${instanceLabel(previous.instance)}`);
            try { previous.ws.close(CLOSE_REPLACED, closeReason(`reemplazado por ${instanceLabel(instance)}`)); } catch { /* ya estaba muerto */ }
            world.noteMachineReplaced(machineId, verdict);
          }
          conn.authed = true;
          conn.machineId = machineId;
          conn.instance = instance;
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
        if (frame.t === 'term:data' || frame.t === 'term:exit') {
          relayTermUp(machineId, frame);
          return;
        }
        if (frame.t === 'hello') return;   // un segundo hello no re-autentica

        if (frame.t === 'capcom:transfer') {
          const source = world.state.agents[frame.fromId];
          const destination = frame.toId ? world.state.agents[frame.toId] : undefined;
          if (source?.machineId !== machineId && destination?.machineId !== machineId) return;
          if (frame.hold && source?.role === 'capcom') capcomRouter.beginTransfer(frame.fromId, frame.contextMode, frame.cutoffAt);
          else if (!frame.hold) capcomRouter.releaseTransfer(frame.toId);
          return;
        }
        if (frame.t === 'capcom:handoff') {
          const h = parseHandoff(frame.event);
          if (!h || h.machineId !== machineId) return;
          const target = world.state.agents[h.toId];
          if (!target || target.machineId !== machineId || target.role !== 'capcom') return;
          capcomRouter.setContext(h.contextMode, h.cutoffAt);
          const saved = handoffs.add(h);
          if (!saved) return;
          world.setCapcomHandoffs(handoffs.all());
          const text = handoffText(saved);
          pushCeoMessage({ id: saved.id, at: saved.at, role: 'system', text, actions: [] });
          world.pushFeed(machineId, [{ id: saved.id, at: saved.at, level: 'info', source: 'CAPCOM', agentId: saved.toId, text }]);
          // Best-effort immediate notice; briefing always retains the durable fact.
          if (h.contextMode !== 'clean') capcomRouter.humanSays(`${HANDOFF_NOTICE_PREFIX}\n${text}\nCall briefing first and reconcile pending obligations and persistent rules. Preserve this history reference without loading the full conversation. This notice does not authorize new work or retries; acknowledge it briefly.`);
          return;
        }

        if (frame.t === 'capcom:rotated') {
          /*
           * Un reciclado a propósito, no una caída: el router retiene el correo
           * hasta que aparezca la sesión nueva, y el feed lo dice con las
           * cifras que lo motivaron. Se anota antes de que el viejo muera, así
           * que nunca hay un instante en que "no hay CAPCOM".
           */
          if (typeof frame.fromId !== 'string' || !frame.fromId) return;
          capcomRouter.rotating(frame.fromId);
          const text = `CAPCOM rotado: ${Math.round(Number(frame.turns) || 0)} turnos, `
            + `${Math.round(Number(frame.compactions) || 0)} compactaciones`
            + (Number(frame.contextTokens) > 0 ? `, ${Math.round(Number(frame.contextTokens) / 1000)}k tokens de contexto` : '');
          log(text);
          world.pushFeed(machineId, [{ id: newId('f_cap'), at: Date.now(), level: 'info', source: 'CAPCOM', text }]);
          try {
            autonomy.journal.rotated({
              fromId: frame.fromId, machineId,
              turns: Number(frame.turns) || 0, compactions: Number(frame.compactions) || 0,
              contextTokens: Number(frame.contextTokens) || 0,
            });
          } catch (err) { warn('journal.rotated falló:', err); }
          return;
        }

        if (frame.t === 'improve:report') {
          /*
           * Un revisor archivó. Aquí se decide si vale, porque el hub es el
           * único que sabe qué revisión está en vuelo y de quién es: el
           * collector sólo sabe que un fichero apareció en un repo.
           *
           * El recibo vuelve SIEMPRE, también cuando se rechaza entero. Un
           * informe que se pierde en silencio se lleva por delante la revisión
           * entera sin que el agente pueda corregir nada.
           */
          const reply = (body: Omit<Extract<CommandFrame, { t: 'improve:ack' }>, 't' | 'reportId'>) => {
            if (typeof frame.reportId === 'string') send(conn, { t: 'improve:ack', reportId: frame.reportId, ...body });
          };
          try {
            const out = autonomy.improve.report({
              agentId: typeof frame.agentId === 'string' ? frame.agentId : null,
              reviewId: typeof frame.reviewId === 'string' ? frame.reviewId : null,
              proposals: (Array.isArray(frame.proposals) ? frame.proposals : []) as never,
            });
            reply({ ok: out.filed + out.merged > 0, filed: out.filed, merged: out.merged, ...(out.rejected.length ? { rejected: out.rejected } : {}) });
            log(`improve: ${out.filed} nueva(s), ${out.merged} fundida(s) de ${frame.agentId ?? 'un agente'}`);
          } catch (err) {
            reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        if (frame.t === 'hygiene') {
          // El machineId es el de la conexión, nunca el del frame: un collector
          // autenticado como una máquina no puede declarar por otra.
          const report = sanitizeReport(frame.report);
          if (!report) { warn(`informe de higiene inválido de ${machineId}`); return; }
          const held = hygiene.put(machineId, report);
          broadcast({ t: 'hygiene', reports: [held] });
          return;
        }

        world.applyCollector(frame, machineId);
        if (frame.t === 'agent' || frame.t === 'agent:new' || frame.t === 'snapshot') {
          missions.observe(world.state.agents);
          // Si un CAPCOM nuevo acaba de aparecer, lo retenido durante la rotación sale ahora.
          capcomRouter.flush();
        }
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
      for (const [termId, t] of terms) {
        if (t.machineId !== machineId) continue;
        terms.delete(termId);
        sendToConsole(t.consoleId, { t: 'term:exit', termId, reason: 'the machine disconnected' });
      }
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
      greetSource(conn);
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
          // Y qué código corre este hub, en cuanto se sepa: la consola lo
          // compara con lo suyo para no atribuirle al bundle nuevo lo que hace
          // un hub viejo.
          greetSource(conn);
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
      // Sus terminales se sueltan en la máquina: nadie las mira ya.
      for (const [termId, t] of terms) {
        if (t.consoleId !== conn.id) continue;
        terms.delete(termId);
        const target = collectors.get(t.machineId);
        if (target) send(target, { t: 'term:close', termId });
      }
      // Los comandos que pidió quedan huérfanos: su ack ya no tiene destino.
      for (const p of pending.values()) if (p.consoleId === conn.id) p.consoleId = null;
      log(`consola desconectada: ${conn.id}`);
    });
  }

  /* ── AUTOMEJORA ───────────────────────────────────────────────── */

  /** El tablero y el porqué del reloj, que es lo que el panel enseña. */
  function improveWire(): Omit<Extract<ServerFrame, { t: 'improve' }>, 't'> {
    return {
      state: autonomy.improve.store.state(),
      verdict: autonomy.improve.verdict(),
      choice: autonomy.improve.choice(),
      // Dónde nacería el revisor: es a quien la consola le pide el catálogo.
      machineId: autonomy.improve.project()?.machineId ?? null,
    };
  }

  /**
   * Lo que el operador hace con una propuesta.
   *
   * Contestar es lo único que sale del hub: la respuesta se guarda en el hilo
   * Y se le pega a CAPCOM, porque una respuesta que sólo se guarda es una
   * conversación de un solo lado — el operador contesta una pregunta y nadie
   * la lee nunca. Posponer, descartar y reabrir no molestan a nadie.
   */
  function improveAct(
    proposalId: string, act: 'reply' | 'snooze' | 'dismiss' | 'reopen' | 'seen',
    text?: string, untilMs?: number,
  ): import('../shared/improve.ts').ImproveProposal {
    const improve = autonomy.improve.store;
    switch (act) {
      case 'reply': {
        const p = improve.act(proposalId, { act: 'reply', text: String(text ?? '') });
        const answer = String(text ?? '').slice(0, 2_000);
        const prompt = `[ORCA SELF-REVIEW REPLY ${p.id}] The operator answered on your proposal "${p.title}".\n`
          + (p.question ? `You asked: ${p.question}\n` : '')
          + `They said: ${answer}\n`
          + `Answer them with note_improvement(proposal_id="${p.id}", text=…). If this changes the idea, re-file it with `
          + `report_improvements under key="${p.key}". Do not implement anything: the operator decides what becomes work.`;
        const sent = capcomRouter.humanSays(prompt, (agentId, message) => {
          void dispatchLocal({ k: 'say', agentId, text: message }).catch((err) => {
            log(`improve ${p.id}: reply delivery failed: ${String(err)}`);
          });
        }, (reason) => {
          try { improve.note(p.id, 'system', `Your answer was saved but CAPCOM never took it: ${reason}`); } catch { /* la propuesta pudo podarse */ }
        });
        if (sent === false) improve.note(p.id, 'system', 'Saved. No CAPCOM session took it; it will not be delivered on its own.');
        return improve.get(p.id);
      }
      case 'snooze': return improve.act(proposalId, { act: 'snooze', untilMs: Number(untilMs) });
      case 'dismiss': return improve.act(proposalId, { act: 'dismiss', ...(text ? { text: String(text) } : {}) });
      case 'reopen': return improve.act(proposalId, { act: 'reopen' });
      case 'seen': return improve.act(proposalId, { act: 'seen' });
    }
  }

  /**
   * SEND: una propuesta se convierte en trabajo.
   *
   * Es el único punto del sistema donde una revisión produce algo más que
   * texto, y por eso lo dispara una pulsación y no un reloj. Abre una misión
   * normal —el mismo camino que cualquier otra— con la propuesta entera
   * dentro, y deja la propuesta atada a ella. La guarda contra el doble envío
   * está en el almacén (`act: 'sent'`), pero se comprueba también aquí antes
   * de crear nada: si no, un segundo clic dejaría una misión huérfana.
   */
  async function improveSend(proposalId: string, missionId: string): Promise<{ missionId: string; delivery: 'launched' | 'saved'; callsign?: string; detail?: string }> {
    const out = await dispatchForge({ improve: autonomy.improve, missions }, proposalId, missionId);
    if (out.delivery === 'launched') world.pushFeed('', [{
      id: newId('f_improve'), at: Date.now(), level: 'info', source: 'AUTOMEJORA',
      text: `FORGE · ${out.callsign ?? 'a mission lead'} coordinates ${missionId}; CAPCOM retains final review and publication`,
    }]);
    return out;
  }

  /**
   * Una línea del operador EN una misión, hacia CAPCOM.
   *
   * El camino de siempre: la línea entra en la conversación, la misión vuelve
   * a `active` si estaba cerrada, y CAPCOM recibe el prompt con el hilo
   * detrás. Compartido entre `ceo:say` con `missionId` y `mission:say` sin
   * líder, para que las dos puertas hagan exactamente lo mismo.
   */
  function sayInMissionToCapcom(missionId: string, text: string, requestId: string, conn: ConsoleConn, extra: Record<string, unknown> = {}): void {
    const mission = missions.message(missionId, 'human', text, 'active');
    const prompt = capcomRouter.contextCutoff() === null ? missionPrompt(mission)
      : `[ORCA MISSION ${mission.id}] New operator instruction. Use report_mission(mission_id="${mission.id}") for replies. Historical context is not attached.\n${text}`;
    const cap = capcomRouter.live();
    if (cap) {
      void dispatchLocal({ k: 'say', agentId: cap.id, text: prompt }).then(
        (data) => ackTo(conn.id, requestId, true, undefined, { ...(typeof data === 'object' && data ? data : {}), ...extra }),
        (err) => {
          missions.message(mission.id, 'system', `Delivery unconfirmed: ${String(err)}`);
          ackTo(conn.id, requestId, false, String(err));
        },
      );
    } else if (capcomRouter.inRotation()) {
      // CAPCOM se está reciclando: el prompt espera a la sesión nueva.
      capcomRouter.humanSays(prompt, (agentId, message) => {
        void dispatchLocal({ k: 'say', agentId, text: message }).catch((err) => {
          missions.message(mission.id, 'system', `Delivery unconfirmed: ${String(err)}`);
        });
      }, (reason) => { missions.message(mission.id, 'system', `Delivery failed: ${reason}`); });
      ackTo(conn.id, requestId, true, 'CAPCOM rotating: queued', { delivery: 'queued', ...extra });
    } else if (options.onUnrouted) {
      options.onUnrouted(prompt, hub);
      ackTo(conn.id, requestId, true, undefined, { delivery: 'accepted', ...extra });
    } else throw new Error('No CAPCOM connected. Message saved in this mission.');
  }

  /**
   * Una línea del operador EN una misión, desde la ventana de la misión.
   *
   * Va al LÍDER si la misión tiene uno en pie, y si no a CAPCOM. La regla es
   * `missionLeadOf`, la misma que usa la ventana para decir de antemano a
   * quién irá. Al líder le llega a su sesión con la cabecera de la misión, y
   * la línea queda en la conversación marcada con `to`: no es deuda de CAPCOM
   * y el despertador no se la recuerda. Y en los dos casos la misión vuelve a
   * `active`: hasta hoy hablarle al líder de una misión COMPLETED la dejaba
   * completada mientras el líder trabajaba en lo nuevo, que es el fallo que
   * el operador vio el 2026-09-09.
   */
  function sayInMission(missionId: string, text: string, requestId: string, conn: ConsoleConn): void {
    const current = missions.get(missionId);
    const lead = missionLeadOf(current, (id) => world.state.agents[id], Object.values(world.state.agents));
    if (!lead?.live) {
      sayInMissionToCapcom(missionId, text, requestId, conn, { to: 'capcom' });
      return;
    }
    const mission = missions.message(missionId, 'human', text, 'active', undefined, lead.agent.id);
    if (!mission.agentIds.includes(lead.agent.id)) missions.assign(missionId, [lead.agent.id]);
    const at = Date.now();
    void dispatchLocal({ k: 'say', agentId: lead.agent.id, text: leadPrompt(mission, text) }).then(
      (data) => {
        missions.dispatched(missionId, { agentId: lead.agent.id, callsign: lead.agent.callsign, at, delivered: true });
        ackTo(conn.id, requestId, true, undefined, { ...(typeof data === 'object' && data ? data : {}), to: 'lead', callsign: lead.agent.callsign });
      },
      (err) => {
        missions.dispatched(missionId, { agentId: lead.agent.id, callsign: lead.agent.callsign, at, delivered: false, detail: String(err) });
        ackTo(conn.id, requestId, false, String(err));
      },
    );
  }

  function handleConsoleFrame(conn: ConsoleConn, frame: ClientFrame): void {
    /*
     * La otra mitad de la telemetría de AUTOMEJORA: qué pide la consola.
     *
     * El TIPO de frame y nada más — ni el texto, ni el agente, ni la ruta. Con
     * eso se ve qué partes de ORCA se usan y cuáles no, que es la pregunta; el
     * contenido no la respondería mejor y es justo lo que no debe guardarse.
     * Los latidos no cuentan: son el reloj, no un gesto de nadie. Y el lote
     * de gestos tampoco cuenta como petición: es un sobre, y lo que se cuenta
     * es lo que trae dentro (más abajo).
     */
    if (frame.t !== 'beat' && frame.t !== 'gestures') autonomy.improve.record(`ui:${frame.t}`);
    switch (frame.t) {
      /*
       * La mitad que faltaba: lo que el operador HACE en la interfaz y no le
       * pide nada al hub. Cada entrada del lote es un nombre `gesture:…` y una
       * cuenta, ya validados y recortados por `normalizeGestures`; el techo
       * por familia lo aplica el almacén al contar.
       */
      case 'gestures': {
        for (const [name, n] of Object.entries(normalizeGestures(frame.counts))) autonomy.improve.record(name, n);
        return;
      }

      // El hello ya se validó al aceptar la conexión; repetirlo no es un error.
      case 'hello':
        return;

      case 'resync':
        sendWorld(conn);
        return;

      /*
       * El clic de `SERVER CODE CHANGED`: el operador pide el relevo.
       *
       * Primero se avisa a los collectors —cada uno decide, y el suyo es el
       * proceso que comparte árbol con este— y se les deja medio segundo para
       * que el frame salga por el cable antes de que aquí se cierre nada.
       * Después el hub se apaga limpio y sale con el código convenido, que es
       * lo que `tools/supervise.mjs` entiende como «relánzame». La consola no
       * espera un ack, porque quien tendría que mandarlo es justo lo que se
       * está muriendo: lo que verá es el enlace caerse y volver.
       */
      case 'restart': {
        if (!isSupervised()) {
          send(conn, { t: 'error', message: 'este hub no corre bajo un supervisor: reinícialo a mano (npm run prod)' });
          return;
        }
        log('relevo pedido desde la consola: avisando a los collectors y saliendo');
        for (const c of collectors.values()) send(c, { t: 'restart' });
        setTimeout(() => {
          void hub.close()
            .catch((err) => warn('cierre sucio antes del relevo:', err))
            .finally(() => process.exit(RESTART_EXIT_CODE));
        }, RESTART_GRACE_MS);
        return;
      }

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

      case 'term:open': case 'term:input': case 'term:resize': case 'term:close':
        relayTermDown(conn, frame);
        return;

      case 'agents:archive': {
        if (typeof frame.id !== 'string') return;
        try {
          const out = archiveAgents(frame.filter, { dryRun: frame.dryRun === true, by: 'console' });
          ackTo(conn.id, frame.id, true, undefined, out);
        } catch (err) { ackTo(conn.id, frame.id, false, err instanceof Error ? err.message : String(err)); }
        return;
      }
      case 'hygiene:get': {
        /*
         * `refresh` pide muestra fresca y contesta con lo que hay ahora: los
         * informes nuevos llegan solos por el push de `t:'hygiene'`, así que
         * la consola no espera a nadie y el panel se actualiza cuando cada
         * máquina termina su paseo.
         */
        const asked = frame.refresh === true ? refreshHygiene(true) : 0;
        ackTo(conn.id, frame.id, true, undefined, {
          reports: hygiene.all(), fleet: hygiene.fleet(), asked,
        });
        return;
      }
      case 'improve:get': {
        ackTo(conn.id, frame.id, true, undefined, improveWire());
        return;
      }
      case 'improve:run': {
        // La ejecución manual: lanza el agente revisor. Contesta con el motivo
        // cuando no puede —no hay proyecto, ya hay un revisor trabajando, el
        // spawn falló—, porque un botón que no hace nada y no dice por qué se
        // pulsa tres veces.
        void autonomy.improve.run('manual').then(
          (out) => ackTo(conn.id, frame.id, out.ok, out.ok ? undefined : out.reason, { ...out, ...improveWire() }),
          (err) => ackTo(conn.id, frame.id, false, err instanceof Error ? err.message : String(err)),
        );
        return;
      }
      case 'improve:cancel': {
        // Parar la revisión en vuelo: mata al revisor y cierra. El hueco queda
        // libre en el acto, sin esperar a que el agente termine de morirse.
        void autonomy.improve.cancel().then(
          (out) => ackTo(conn.id, frame.id, out.ok, out.reason, { ...out, ...improveWire() }),
          (err) => ackTo(conn.id, frame.id, false, err instanceof Error ? err.message : String(err)),
        );
        return;
      }
      case 'improve:config': {
        try {
          const cfg = autonomy.improve.store.setConfig(frame.patch ?? {});
          ackTo(conn.id, frame.id, true, undefined, { config: cfg, ...improveWire() });
        } catch (err) { ackTo(conn.id, frame.id, false, err instanceof Error ? err.message : String(err)); }
        return;
      }
      case 'improve:seen': {
        const n = autonomy.improve.store.markSeen(Array.isArray(frame.proposalIds) ? frame.proposalIds : undefined);
        ackTo(conn.id, frame.id, true, undefined, { seen: n, ...improveWire() });
        return;
      }
      case 'improve:act': {
        try {
          if (typeof frame.proposalId !== 'string') throw new Error('Invalid proposal');
          const p = improveAct(frame.proposalId, frame.act, frame.text, frame.untilMs);
          ackTo(conn.id, frame.id, true, undefined, { proposal: p, ...improveWire() });
        } catch (err) { ackTo(conn.id, frame.id, false, err instanceof Error ? err.message : String(err)); }
        return;
      }
      case 'improve:send': {
        if (typeof frame.proposalId !== 'string' || typeof frame.missionId !== 'string') { ackTo(conn.id, frame.id, false, 'Invalid send'); return; }
        void improveSend(frame.proposalId, frame.missionId).then(
          (out) => ackTo(conn.id, frame.id, true, out.detail, { ...out, ...improveWire() }),
          (err) => ackTo(conn.id, frame.id, false, err instanceof Error ? err.message : String(err)),
        );
        return;
      }
      case 'mission:say': {
        const text = typeof frame.text === 'string' ? frame.text : '';
        if (!text.trim() || typeof frame.missionId !== 'string') { ackTo(conn.id, frame.id, false, 'Invalid mission message'); return; }
        try { sayInMission(frame.missionId, text, frame.id, conn); }
        catch (err) { ackTo(conn.id, frame.id, false, err instanceof Error ? err.message : String(err)); }
        return;
      }
      case 'mission:create': {
        try {
          if (typeof frame.title !== 'string' || typeof frame.missionId !== 'string') throw new Error('Invalid mission');
          const mission = missions.create(frame.missionId, frame.title);
          ackTo(conn.id, frame.id, true, undefined, mission);
        } catch (err) { ackTo(conn.id, frame.id, false, err instanceof Error ? err.message : String(err)); }
        return;
      }
      case 'mission:archive': {
        try {
          if (typeof frame.missionId !== 'string') throw new Error('Invalid mission');
          const mission = missions.archive(frame.missionId, frame.on !== false);
          ackTo(conn.id, frame.id, true, undefined, mission);
        } catch (err) { ackTo(conn.id, frame.id, false, err instanceof Error ? err.message : String(err)); }
        return;
      }
      case 'mission:purge': {
        try {
          if (typeof frame.missionId !== 'string') throw new Error('Invalid mission');
          missions.purge(frame.missionId);
          ackTo(conn.id, frame.id, true, undefined, { purged: frame.missionId });
        } catch (err) { ackTo(conn.id, frame.id, false, err instanceof Error ? err.message : String(err)); }
        return;
      }
      case 'mission:debrief': {
        /*
         * El parte de una misión: lo que la flota hizo, no lo que se dijo.
         *
         * Sale del diario y no del mundo en memoria a propósito. Un agente
         * terminado se archiva y con él se van sus métricas; la misión, en
         * cambio, se abre días después — es para lo que existe. El diario ya
         * anota cada `launch`, cada `end` y cada `landing` con su missionId,
         * así que la pregunta ya tenía respuesta, sólo le faltaba puerta.
         *
         * Se pide y no se emite: barrer el diario en cada cambio del mundo,
         * por cada consola conectada, para un panel que nadie está mirando,
         * sería pagar el coste siempre para servirlo casi nunca.
         */
        try {
          if (typeof frame.missionId !== 'string') throw new Error('Invalid mission');
          const mission = missions.get(frame.missionId);
          const entries = autonomy.journal.query({
            missionId: mission.id, kind: ['launch', 'end', 'landing'], limit: 500, order: 'asc',
          });
          ackTo(conn.id, frame.id, true, undefined,
            buildDebrief(mission, entries, (id) => world.state.agents[id]));
        } catch (err) { ackTo(conn.id, frame.id, false, err instanceof Error ? err.message : String(err)); }
        return;
      }
      case 'ceo:say': {
        const text = typeof frame.text === 'string' ? frame.text : '';
        if (!text.trim()) return;
        if (frame.missionId !== undefined) {
          const requestId = typeof frame.id === 'string' ? frame.id : newId('cmd');
          try { sayInMissionToCapcom(frame.missionId, text, requestId, conn); }
          catch (err) { ackTo(conn.id, requestId, false, err instanceof Error ? err.message : String(err)); }
          return;
        }
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
        const requestId = typeof frame.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(frame.id) ? frame.id : null;
        // Entregado más tarde (tras una rotación) va sin recibo: el de la
        // consola ya se dio al encolar, y su conexión puede haberse ido.
        let immediate = true;
        const outcome = capcomRouter.humanSays(text, (agentId, message) => {
          const withReceipt = immediate && requestId !== null;
          dispatchCommand(withReceipt ? requestId : newId('cmd'), { k: 'say', agentId, text: message }, withReceipt ? conn.id : null);
        }, (reason) => {
          pushCeoMessage({
            id: newId('msg'), role: 'system', at: Date.now(), actions: [],
            text: `${reason}. Tu mensaje quedó guardado; cuando vuelva, díselo otra vez o arranca uno con \`orca capcom\`.`,
          });
        });
        immediate = false;
        if (outcome === 'queued') {
          if (requestId) ackTo(conn.id, requestId, true, 'CAPCOM rotating: queued', { delivery: 'queued' });
          return;
        }
        if (outcome) return;
        if (options.onUnrouted) {
          options.onUnrouted(text, hub);
          if (requestId) ackTo(conn.id, requestId, true, 'no CAPCOM: observed unrouted', { delivery: 'accepted' });
        } else {
          if (requestId) ackTo(conn.id, requestId, false, 'No CAPCOM connected. Your message was saved.');
          // Sin mando conectado, decirlo es mejor que el silencio.
          pushCeoMessage({
            id: newId('msg'), role: 'system', at: Date.now(), actions: [],
            text: 'No hay CAPCOM conectado a este hub. '
              + 'Tu mensaje quedó guardado. Arranca uno con `orca capcom` en la máquina que deba llevarlo.',
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
    if (before.permission) {
      if (!['pending', 'with_ceo'].includes(before.status) || before.permission.phase !== 'requested') {
        ackTo(consoleId, id, false, 'Permission stale or response already pending'); return;
      }
      if (!/^(allow|once|deny)$/i.test(answer.trim()) || rememberAs) {
        ackTo(consoleId, id, false, 'Permission accepts allow (once) or deny; cannot remember'); return;
      }
      world.requestPermissionAnswer(id);
      dispatchCommand(newId('cmd'), { k: 'answer', escalationId: id, answer, rememberAs: null }, consoleId);
      return;
    }
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
   * Un archivo de un proyecto, para el visor de la consola.
   *
   * `GET /api/file?path=/abs/ruta[&token=…]`. La política —qué raíces, cómo se
   * contiene, qué cabeceras— vive en files.ts; aquí sólo se juntan las raíces
   * del momento y se pone la misma puerta que `/api/artifact`: es contenido de
   * la máquina de alguien, así que exige el token igual que el socket.
   *
   * Las raíces se recalculan por petición a propósito: un proyecto que acaba
   * de aparecer en el mundo es servible en cuanto aparece, sin reiniciar.
   */
  function servedRoots(): string[] {
    return [
      join(ORCA_DIR, 'recovery-images'),
      join(ORCA_DIR, 'uploads'),
      ...approvedRoots.list(),
      join(ORCA_DIR, 'capcom', 'handoffs'),
      join(ORCA_DIR, 'worker-recovery', 'handoffs'),
      ...Object.values(world.state.projects).map((p) => p.path),
      ...scratchpadRoots(),
      ...envRoots(),
      ...fileRoots,
    ];
  }

  /** La misma puerta para `/api/file` y `/api/dir`: el token, o nada. */
  function fileGate(req: IncomingMessage, res: ServerResponse): boolean {
    const allowed = auth.check(tokenFromRequest(req), remoteOf(req));
    if (allowed.ok) return true;
    text(res, 401, `no autorizado (${allowed.reason ?? 'falta token'}). `
      + 'Añade ?token=<ORCA_TOKEN> a la url, igual que hace el websocket.');
    return false;
  }

  function serveFile(url: URL, req: IncomingMessage, res: ServerResponse): void {
    if (!fileGate(req, res)) return;
    const r = resolveServedPath(url.searchParams.get('path') ?? '', servedRoots());
    if (!r.ok) { text(res, r.status, r.reason); return; }
    streamFile(req, res, r);
  }

  /**
   * Una carpeta de un proyecto, para el navegador de archivos de la consola
   * (kinds/files.ts). `GET /api/dir?path=/abs/carpeta[&token=…]` devuelve sus
   * entradas ordenadas, carpetas primero. Las mismas raíces y la misma
   * contención que `/api/file`: lo que no se serviría no se lista, y una
   * carpeta fuera de las raíces es 403 aunque exista.
   */
  function serveDir(url: URL, req: IncomingMessage, res: ServerResponse): void {
    if (!fileGate(req, res)) return;
    const r = resolveServedDir(url.searchParams.get('path') ?? '', servedRoots());
    if (!r.ok) { text(res, r.status, r.reason); return; }
    json(res, 200, { ok: true, path: r.path, entries: r.entries, truncated: r.truncated });
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
    // La mitad de la telemetría de AUTOMEJORA: qué herramientas usa CAPCOM de
    // verdad. Un nombre y una cuenta, nunca los argumentos.
    onTool: (name) => autonomy.improve.record(`mcp:${name}`),
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
        case '/api/push': {
          if (!allowApi(req, res)) return;
          if (harness) { json(res, 503, { error: 'Push is disabled in the test harness' }); return; }
          if (req.method === 'GET') { json(res, 200, { publicKey: getPush().publicKey }); return; }
          if (req.method !== 'POST' && req.method !== 'DELETE') { json(res, 405, { error: 'Method not allowed' }); return; }
          if (!req.headers['content-type']?.startsWith('application/json')) { json(res, 415, { error: 'JSON required' }); return; }
          void readBody(req).then(raw => {
            if (raw.length > 8192) { json(res, 413, { error: 'Subscription too large' }); return; }
            const value = JSON.parse(raw);
            if (req.method === 'POST') getPush().add(value);
            else {
              if (typeof value?.endpoint !== 'string') throw new Error('Invalid endpoint');
              getPush().remove(value.endpoint);
            }
            json(res, 200, { ok: true });
          }).catch(() => json(res, 400, { error: 'Invalid push subscription' }));
          return;
        }
        case '/api/recovery-images': {
          const allowed = auth.check(tokenFromRequest(req), remoteOf(req));
          if (!allowed.ok) { json(res, 401, { error: 'Image upload requires a valid ORCA access token.' }); return; }
          void uploadRecoveryImage(req, res, join(ORCA_DIR, 'recovery-images'));
          return;
        }
        // Un archivo soltado en una conversación de la consola. Misma puerta
        // que las imágenes de recovery; la política vive en uploads.ts.
        case '/api/uploads': {
          const allowed = auth.check(tokenFromRequest(req), remoteOf(req));
          if (!allowed.ok) { json(res, 401, { error: 'Uploads require a valid ORCA access token.' }); return; }
          void uploadFile(req, res, join(ORCA_DIR, 'uploads'));
          return;
        }
        // Lo que el operador dijo, como audio, a whisper.cpp en esta máquina
        // con los nombres de la flota en el prompt. Misma puerta; la política
        // vive en transcribe.ts. GET dice si este hub puede, y con qué modelo.
        case '/api/transcribe': {
          const allowed = auth.check(tokenFromRequest(req), remoteOf(req));
          if (!allowed.ok) { json(res, 401, { error: 'Transcription requires a valid ORCA access token.' }); return; }
          void transcribeAudio(req, res);
          return;
        }
        case '/api/health': {
          const full: Record<string, unknown> = {
            ...world.health(),
            /*
             * Si este hub admite fixtures, dicho en voz alta. El arnés lo lee
             * ANTES de conectarse para negarse solo con un mensaje útil, en vez
             * de estrellarse contra un cierre 4004 sin saber por qué.
             */
            harness,
            connections: { collectors: collectors.size, consoles: consoles.size, pendingCommands: pending.size },
            bus: { rev: bus.rev, ...bus.stats },
            protocol: PROTOCOL_VERSION,
          };
          if (auth.check(tokenFromRequest(req), remoteOf(req)).ok) { json(res, 200, full); return; }
          /*
           * Sin token el hub sólo habla de sí mismo: si está vivo, si es el
           * arnés y si hay mando. Eso es exactamente lo que `hubPosture()`
           * necesita para negarse a tocar un hub real —la protección que
           * impide que el arnés visual tumbe un CAPCOM de verdad— y es todo
           * lo que se puede dar sin repartir hostnames, proyectos y costes a
           * cualquiera que pregunte por un puerto expuesto.
           */
          const machines = full['machines'] as { total?: number; online?: number } | undefined;
          json(res, 200, {
            ok: full['ok'] === true,
            protocol: PROTOCOL_VERSION,
            harness,
            capcom: full['capcom'] ?? null,
            machines: { total: machines?.total ?? 0, online: machines?.online ?? 0 },
          });
          return;
        }
        case '/api/world':
          if (!allowApi(req, res)) return;
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
          if (!allowApi(req, res)) return;
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
        case '/api/file': {
          serveFile(url, req, res);
          return;
        }
        case '/api/dir': {
          serveDir(url, req, res);
          return;
        }
        case '/api/memory': {
          // Útil para ver por qué el CEO decidió no preguntar.
          if (!allowApi(req, res)) return;
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
              '/api/memory?q=', '/api/artifact/<id>', '/api/file?path=', '/api/dir?path=', 'POST /api/uploads', '/api/transcribe (GET status, POST audio/wav?lang=)', 'POST /mcp (fleet command, MCP)',
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
    // Lo que quedó pendiente sin que nadie lo triara —CAPCOM no estaba cuando
    // llegó— se le ofrece ahora que sí está.
    try { capcomRouter.flush(); capcomRouter.sweep(Object.values(world.state.escalations)); }
    catch (err) { warn('sweep de CAPCOM falló', err); }
    void recovery.tick().catch(err => warn('recovery sweep failed', err));
    try { budgetSweep(); } catch (err) { warn('sweep de presupuestos falló', err); }
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
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => { http.removeListener('error', reject); resolve(); });
  });

  const address = http.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  const hub: Hub = {
    world, bus, store, memory: mem, history, fleets, auth, harness, http,
    port: actualPort,
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`,
    dist: DIST_DIR,
    pushCeoMessage,
    missions,
    budgets,
    autonomy,
    broadcast,
    hygiene: {
      all: () => hygiene.all(),
      get: (machineId) => hygiene.get(machineId),
      fleet: () => hygiene.fleet(),
      refresh: (force) => refreshHygiene(force === true),
    },
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
        // El mando no es un compañero de flota: se identifica como CAPCOM para
        // que el destinatario sepa de dónde viene. El id interno sigue siendo
        // `ceo` porque así está en el tráfico persistido.
        fromAgentId: 'ceo',
        fromCallsign: 'CAPCOM',
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
    archivedAgents() { return world.archivedAgents(); },
    archiveAgents(filter, opts) {
      return archiveAgents(filter, opts);
    },
    counts: () => ({ collectors: collectors.size, consoles: consoles.size, pending: pending.size }),
    async close() {
      source?.stop();
      offPublishOnDone?.();
      publisher?.stop();
      for (const timer of missionResultTimers.values()) clearTimeout(timer);
      missionResultTimers.clear();
      clearInterval(sweepTimer);
      clearInterval(pingTimer);
      clearInterval(pruneTimer);
      clearInterval(pushTimer);
      capcomRouter.stop();
      autonomy.stop();
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      bus.stop();
      for (const conn of [...collectors.values(), ...orphanCollectors, ...consoles]) {
        try { conn.ws.close(1001, 'hub cerrando'); } catch { /* da igual */ }
      }
      await new Promise<void>((resolve) => wssCollector.close(() => resolve()));
      await new Promise<void>((resolve) => wssConsole.close(() => resolve()));
      // http.close() deja de aceptar conexiones pero espera a que las abiertas
      // terminen solas: un socket keep-alive ocioso lo retrasa hasta su propio
      // timeout, y un cliente que deja de leer el cuerpo de una respuesta lo
      // retiene para siempre, de modo que el hub no llega a apagarse. Se sueltan
      // las ociosas de inmediato y se le pone plazo a las demás.
      http.closeIdleConnections();
      await new Promise<void>((resolve) => {
        const cut = setTimeout(() => http.closeAllConnections(), CLOSE_GRACE_MS);
        http.close(() => { clearTimeout(cut); resolve(); });
      });
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
    console.log('[hub]   comando    → CAPCOM cuando haya sesión viva; sin ella, nadie');
    // Un hub de pruebas admite fixtures y hay que poder verlo de un vistazo;
    // el real no dice nada porque su silencio ES la postura por defecto.
    if (harness) console.log(`[hub]   arnés      → SÍ (${HARNESS_ENV}): admite máquinas sintéticas`);
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
  let closing = false;
  const bye = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`\n[hub] ${signal}, cerrando…`);
    // close() drains the serialized write queues, including compaction.
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
