/**
 * El collector: un daemon por máquina.
 *
 * Junta las piezas y mantiene una única conexión saliente al hub. Todo lo demás
 * (descubrir transcripts, derivar estado, vigilar buzones, ejecutar comandos)
 * ocurre igual esté el hub arriba o abajo: el socket es un transporte, no una
 * dependencia. Arrancar con el hub caído es el caso normal, no el error.
 *
 * Config por entorno:
 *   ORCA_HUB_URL       ws://127.0.0.1:4479   (se le añade PATHS.collector)
 *   ORCA_TOKEN         token compartido con el hub
 *   ORCA_MACHINE_NAME  nombre visible; por defecto el hostname
 *   ORCA_LOG           trace|debug|info|warn|error
 *   ORCA_DIAG=1        corre contra los transcripts reales, imprime un resumen
 *                      y sale. No abre socket ni ejecuta nada.
 *   ORCA_CAPCOM        `0` / `--no-capcom` apaga CAPCOM; `1` / `--capcom` lo
 *                      fuerza. Sin decir nada, CAPCOM arranca cuando el hub es
 *                      local (ORCA_HUB_URL vacío o loopback) y no cuando es
 *                      remoto. SÓLO UNA máquina de la flota debe llevarlo.
 *   ORCA_CAPCOM_DIR    dónde vive esa sesión; por defecto ~/.orca/capcom
 *   ORCA_CAPCOM_MAX_COMPACTIONS   compactaciones a partir de las cuales se
 *                      recicla la sesión CAPCOM por una limpia (2; 0 apaga)
 *   ORCA_CAPCOM_MAX_TURNS         lo mismo por turnos (300; 0 apaga)
 *   ORCA_CAPCOM_ROTATE_IDLE_MS    cuánto ha de llevar CAPCOM en silencio para
 *                      rotarlo (30000). Nunca se rota con un turno en curso ni
 *                      con una escalación pendiente. Ver rotation.ts.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import type { CollectorFrame, Command, CommandFrame, TermFrame } from '../shared/protocol.ts';
import { BEAT_INTERVAL_MS, HYGIENE_INTERVAL_MS, PATHS, PORTS, PROTOCOL_VERSION, newId } from '../shared/protocol.ts';
import { exitForRestart, isSupervised } from '../shared/restart.ts';
import { sharedToken } from '../shared/token.ts';
import type {
  Agent, AgentMessage, AgentState, Artifact, Escalation, FeedItem, FeedLevel, Machine, Project,
  SessionRollup, TalkItem,
} from '../shared/types.ts';
import { MAX_TALK, TERMINAL_STATES, emptyRollup } from '../shared/types.ts';
import { ceilingTokens } from '../shared/tokens.ts';
import { hiddenInWorkspace, type ExcludedWorkspace } from '../shared/workspaces.ts';
import { ArtifactIndex } from './artifacts.ts';
import { CapcomSession, capcomDir, wantsCapcom } from './capcom.ts';
import { rotationConfig, rotationRoute, type RotationConfig } from './rotation.ts';
import type { AgentHandle, SpawnLookup } from './commands.ts';
import { CommandRunner, resolveClaudeBin } from './commands.ts';
import type { BlockSignal, Deriver, Liveness } from './derive.ts';
import { CallsignBook, SessionDeriver } from './derive.ts';
import { CodexDeriver } from './codex.ts';
import type { CollisionAgent } from './collisions.ts';
import { CollisionIndex } from './collisions.ts';
import { EscalationWatcher } from './escalate.ts';
import { ImproveDropWatcher, type ImproveAck } from './improve-drop.ts';
import { StrayWatch, type AgentView } from './strays.ts';
import { HygieneSampler } from './hygiene.ts';
import { memoryPct } from './memory.ts';
import { liveText, promptOn, permissionClosed, screenSignature } from './screen.ts';
import { answerPermission, type PermissionRequest } from './permissions.ts';
import { KeyVault } from './keys.ts';
import { MessageWatcher } from './messages.ts';
import { SpawnWatcher, planChild, writeAck, type SpawnRequest } from './spawns.ts';
import { LineageIndex } from './lineage.ts';
import { ProjectRegistry, foldWorktreeSlug, pathToSlug } from './projects.ts';
import { TerminalRelay } from './term.ts';
import { TmuxHost, paneName, sessionIdOfPane, type PaneInfo } from './tmux.ts';
import type { OutputWatch } from './tmux.ts';
import {
  COLLECTOR_VERSION, claudeJobsDir, errText, guard, isRecord, log, num, oneLine,
  orcaDir, safeJson, sleep, str,
  codexSessionsDir,
} from './util.ts';
import type { LineBatch, TranscriptRef } from './watch.ts';
import { TranscriptWatcher } from './watch.ts';

const SCOPE = 'collector';

/** Un pane de CAPCOM escuchado: el cliente de control y el debounce de su lectura. */
interface LiveWatch {
  pane: string;
  watch: OutputWatch;
  timer: ReturnType<typeof setTimeout> | null;
  lastAt: number;
  /** Pintó otra vez mientras se leía: leer de nuevo al terminar. */
  again: boolean;
}

const TICK_MS = 500;
const LIVENESS_MS = 4_000;
/**
 * Las colisiones se recalculan cada N ticks. Es O(agentes × rutas) y no cambia
 * en 500ms: dos segundos es latencia irrelevante para un aviso cuya alternativa
 * es enterarse mañana en un `git diff`.
 */
const COLLISION_EVERY = 4;
const GIT_MS = 15_000;
/**
 * Cada cuánto se comprueba que CAPCOM sigue vivo.
 *
 * Diez segundos: un mando caído es una flota sin comando, y eso se parece
 * exactamente a una flota tranquila —nadie falla, simplemente dejan de
 * contestarse preguntas— así que la latencia con la que se nota importa.
 */
const CAPCOM_CHECK_MS = 10_000;
/**
 * El texto en vivo se lee por evento: un cliente de control de tmux avisa
 * cuando el pane pinta y entonces se captura. Estos son sus tiempos:
 *
 *  - LIVE_DEBOUNCE_MS: cuánto se espera tras el primer aviso antes de leer,
 *    para que una ráfaga de escritura sea una lectura y no veinte.
 *  - LIVE_MIN_GAP_MS: techo de lecturas seguidas mientras la ráfaga no para.
 *  - LIVE_MS: el sondeo de respaldo cuando no hay cliente de control (tmux
 *    sin modo control, o el cliente cayó y aún no se relanzó), y la vuelta de
 *    limpieza que retira el texto cuando el estado deja de ser redactar.
 *  - LIVE_WATCH_RETRY_MS: cuánto se espera para relanzar un cliente caído.
 */
const LIVE_DEBOUNCE_MS = 100;
const LIVE_MIN_GAP_MS = 80;
const LIVE_MS = 400;
const LIVE_WATCH_RETRY_MS = 5_000;
/**
 * Cuánto puede estar una pantalla sin pintar NADA, con el turno abierto, antes
 * de que se dé por parada esperando a alguien. `ORCA_STALL_MS` lo mueve.
 *
 * Cinco muestras del poll de liveness. Las dos CLIs animan mientras trabajan
 * —spinner, segundos, tokens—, así que veinte segundos de pantalla idéntica no
 * son un modelo pensando: son un diálogo abierto, o un cuelgue.
 */
const STALL_MS = Math.max(4_000, Number(process.env['ORCA_STALL_MS'] ?? 20_000) || 20_000);
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const FEED_MAX = 200;

/* ── identidad de la máquina ──────────────────────────────────────── */

/**
 * El id debe sobrevivir a reinicios y a cambios de hostname, porque el hub
 * indexa proyectos y agentes por él: si cambiara, la flota entera se duplicaría
 * en la consola.
 */
function machineIdentity(): { id: string; name: string } {
  const file = path.join(orcaDir(), 'machine-id');
  let id = guard(SCOPE, 'leer machine-id',
    () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''), '');
  if (!/^[a-f0-9]{16,64}$/.test(id)) {
    id = crypto.randomBytes(16).toString('hex');
    guard(SCOPE, 'escribir machine-id', () => {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, id, { mode: 0o600 });
    }, undefined);
  }
  const name = process.env['ORCA_MACHINE_NAME'] ?? os.hostname();
  return { id, name };
}

/* ── el collector ─────────────────────────────────────────────────── */

class Collector {
  private readonly machineId: string;
  private readonly machineName: string;
  private readonly connectedAt = Date.now();

  private readonly watcher = new TranscriptWatcher();
  /** Los rollouts de Codex, si esta máquina tiene Codex. Misma lectura, otro layout. */
  private readonly codexWatcher: TranscriptWatcher | null =
    fs.existsSync(codexSessionsDir()) ? new TranscriptWatcher({ layout: 'codex', root: codexSessionsDir() }) : null;
  private readonly projects: ProjectRegistry;
  private readonly lineage = new LineageIndex();
  private readonly keys = new KeyVault();
  private readonly callsigns = new CallsignBook();
  private readonly escalations: EscalationWatcher;
  /** El buzón por el que un agente revisor archiva. Ver improve-drop.ts. */
  private readonly improveDrops: ImproveDropWatcher;
  /** Lo que ORCA dejó atrás en esta máquina: procesos, puertos, panes. */
  private readonly strays: StrayWatch;
  /** `reportId` → dónde espera su respuesta el revisor. La ruta no sale de aquí. */
  private readonly improveAcks = new Map<string, string>();
  private readonly messages: MessageWatcher;
  private readonly spawns: SpawnWatcher;
  private readonly collisions = new CollisionIndex();
  private readonly artifacts: ArtifactIndex;
  private readonly runner: CommandRunner;
  private readonly tmux = new TmuxHost();
  private readonly terms: TerminalRelay;
  /** Panes vivos en el servidor tmux de ORCA, por nombre. Se refresca con la liveness. */
  private panes = new Map<string, PaneInfo>();
  /** El mando de la flota, cuando esta máquina es la que lo lleva. */
  private capcom: CapcomSession | null = null;
  /**
   * What ORCA costs this machine (hygiene.ts). Built lazily on the first
   * sample so a collector that never files one never walks a directory.
   */
  private hygieneSampler: HygieneSampler | null = null;
  /**
   * Agentes que existen pero no están en la flota, y por qué.
   *
   * Son los que viven en un directorio que no es un proyecto (el propio de
   * CAPCOM, un scratchpad de sesión). Se siguen derivando y se siguen
   * reportando —el transcript está en disco y el operador puede querer
   * mirarlo— pero salen con `hidden: true` y el hub y la consola los dejan
   * fuera de la flota. La sesión CAPCOM viva NO entra aquí: es lo único que
   * ese directorio produce y que la consola quiere ver.
   */
  private hiddenAgents = new Map<string, ExcludedWorkspace>();
  /** Cuándo reciclar CAPCOM (rotation.ts), leído del entorno al arrancar. */
  private readonly rotation: RotationConfig = rotationConfig();
  /** Último `say` pegado a CAPCOM: no se rota con un mensaje recién entregado. */
  private lastCapcomSayAt = 0;
  /** Se dice una vez por sesión: "toca rotar pero está ocupado". */
  private rotationDueSaid = false;
  /** Último traspaso de rotación pedido: el freno entre intentos. */
  private rotationHandoffAt = 0;

  private derivers = new Map<string, Deriver>();
  private sent = new Map<string, Agent>();
  private sentProjects = new Map<string, string>(); // id → JSON de lo enviado
  private liveness = new Map<string, Liveness>();   // sessionId → liveness
  private jobStates = new Map<string, BlockSignal>(); // sessionId → bloqueo del job
  /**
   * Prompts vistos en la pantalla de un pane. sessionId → escalación abierta
   * por ello. Un `--bg` no tiene pantalla y sigue con la sospecha por tiempo.
   */
  private screenPrompts = new Map<string, { escalation: Escalation; block: BlockSignal; request: PermissionRequest }>();
  /** Última huella de cada pantalla y desde cuándo no cambia. Ver STALL_MS. */
  private screenStill = new Map<string, { sig: string; since: number }>();
  /**
   * Diálogo ya anunciado en un pane sin sesión, por nombre de pane. Ver
   * `readOrphanScreens`: sin esto el feed repetiría la línea en cada poll.
   */
  private paneDialogs = new Map<string, string>();
  /**
   * Agentes esperando algo que ORCA no sabe leer: el CLI lo declara en su
   * título, o su pantalla lleva parada. Sólo un bloqueo, nunca una respuesta.
   */
  private waiting = new Map<string, BlockSignal>();
  private feed: FeedItem[] = [];
  private pendingFeed: FeedItem[] = [];
  /** La charla ya enviada por agente CAPCOM, para reponerla tras una reconexión. */
  private talkSent = new Map<string, TalkItem[]>();
  /** Lo último que se mandó como texto en vivo por agente; null = nada en marcha. */
  private liveSent = new Map<string, string | null>();
  /**
   * El texto de pantalla de un bloque que YA llegó por el transcript. La
   * pantalla lo sigue mostrando mientras el turno continúa, y volver a
   * mandarlo pintaría el mismo párrafo dos veces en la consola.
   */
  private liveDone = new Map<string, string>();
  private livePolling = false;
  /** Por agente: el cliente de control que avisa cuando su pane pinta. */
  private liveWatches = new Map<string, LiveWatch>();
  /** Agentes cuyo cliente cayó o no arrancó: no antes de este instante. */
  private liveWatchRetryAt = new Map<string, number>();
  private liveCapturing = new Set<string>();
  private escalationBySession = new Map<string, Escalation>();
  private ticks = 0;
  private activityTimer: NodeJS.Timeout | null = null;
  private lastActivityTick = 0;

  private ws: WebSocket | null = null;
  private connected = false;
  private helloSent = false;
  private backoff = RECONNECT_MIN_MS;
  private stopping = false;
  private timers: NodeJS.Timeout[] = [];
  private cpuPrev: { idle: number; total: number } | null = null;
  private readonly wantsCapcom: boolean;

  constructor(opts: { capcom?: boolean } = {}) {
    const ident = machineIdentity();
    this.wantsCapcom = opts.capcom === true;
    this.machineId = ident.id;
    this.machineName = ident.name;
    // Las altas por ruta se recuerdan en disco: un proyecto sin transcripts
    // todavía no se redescubre solo y desaparecería en el próximo reinicio.
    this.projects = new ProjectRegistry(this.machineId, capcomDir(), path.join(orcaDir(), 'projects.json'));
    this.projects.adopt();
    this.escalations = new EscalationWatcher({
      machineId: this.machineId,
      resolveAgent: (projectId, hint) => this.resolveAgent(projectId, hint),
    });
    this.improveDrops = new ImproveDropWatcher({
      resolveAgent: (projectId, hint) => this.resolveAgent(projectId, hint),
    });
    this.strays = new StrayWatch({
      tmux: this.tmux,
      home: os.homedir(),
      // El puerto en el que este ORCA sirve su consola, para no ofrecerlo
      // jamás como resto: es el que el operador está mirando.
      uiPort: Number(process.env['ORCA_UI_PORT']) || PORTS.ui,
      agents: () => this.strayAgents(),
      // Recién arrancado el collector no ha mirado la liveness de nadie: su
      // mapa está vacío y toda la flota parecería muerta. Ver `livenessReady`.
      livenessReady: () => this.liveness.size > 0 || this.derivers.size === 0,
    });
    this.messages = new MessageWatcher({
      resolveAgent: (projectId, hint) => this.resolveAgent(projectId, hint),
      agentByCallsign: (cs) => this.agentByCallsign(cs),
      projectByName: (name) => this.projectByName(name),
      callsignOf: (id) => this.derivers.get(id)?.callsign ?? '??',
    });
    this.artifacts = new ArtifactIndex({
      machineId: this.machineId,
      resolveAgent: (projectId, hint) => this.resolveAgent(projectId, hint),
    });
    this.spawns = new SpawnWatcher({
      resolveAgent: (projectId, hint) => this.resolveAgent(projectId, hint),
    });
    this.terms = new TerminalRelay({
      inputBlocked: id => this.runner?.handoffs.locked(id) ?? false,
      tmux: this.tmux,
      send: (f) => this.send(f),
      agent: (id) => this.agentHandle(id),
    });
    this.runner = new CommandRunner({
      projects: this.projects,
      keys: this.keys,
      tmux: this.tmux,
      lineage: this.lineage,
      escalations: this.escalations,
      strays: () => this.strays,
      messages: this.messages,
      artifacts: this.artifacts,
      agent: (id) => this.agentHandle(id),
      awaitSpawn: (want, ms) => this.awaitSpawn(want, ms),
      onResync: () => { this.sent.clear(); this.sentProjects.clear(); this.sendSnapshot(); },
      onKeysChanged: () => this.sendKeys(),
      transfer: {
        context: () => JSON.stringify([...this.derivers.values()].map(d => { const a = d.snapshot(); return { id: a.id, project: a.projectId, squad: a.squad, mission: a.mission, state: a.state, lastSay: a.lastSay }; }), null, 2),
        hold: (fromId, hold, plan) => { this.capcom?.holdTransfer(hold); this.send({ t: 'capcom:transfer', machineId: this.machineId, fromId, hold, contextMode: plan?.contextMode, cutoffAt: plan?.at, ...(plan?.toId ? { toId: plan.toId } : {}) }); },
        activate: async (plan, id) => {
          if (!this.capcom) throw new Error('CAPCOM unavailable');
          await this.capcom.activateHandoff(plan, id);
          await this.pollLiveness(); await this.watcher.refresh(); await this.codexWatcher?.refresh();
          this.tick();
          this.sendSnapshot();
        },
      },
      permissions: {
        get: (id) => {
          for (const [agentId, p] of this.screenPrompts) if (p.escalation.id === id) return { agentId };
          return null;
        },
        answer: (id, answer) => this.answerScreenPermission(id, answer),
      },
      // El acuse de una interrupción: lo escribe el CLI en su transcript y el
      // deriver lo apunta al ingerirlo. Sin esto `interrupt` no podría decir
      // más que "mandé la tecla".
      interruptedAt: (agentId) => this.derivers.get(agentId)?.interruptedMarkAt() ?? 0,
      // Se resuelve en cada llamada: `this.capcom` no existe hasta start().
      capcom: {
        owns: (shortId) => this.capcom?.owns(shortId) ?? false,
        dir: () => this.capcom?.dir ?? null,
        launchArgs: () => this.capcom?.launchArgs() ?? [],
        adoptCleared: (toId, mode, cutoffAt, model) => {
          this.capcom?.adoptCleared(toId, mode, cutoffAt, model);
          // El hilo nuevo puede no estar todavía en el mapa de liveness: sin
          // esta vuelta el snapshot saldría sin CAPCOM y el hub lo diría.
          void this.pollLiveness().then(() => this.codexWatcher?.refresh()).then(() => {
            this.tick(); this.sendSnapshot();
          }).catch(e => log('warn', SCOPE, `resync tras /clear: ${errText(e)}`));
        },
        adopt: (shortId) => this.capcom?.adopt(shortId),
      },
    });
  }

  /* ── arranque ─────────────────────────────────────────────────── */

  async start(diag: boolean): Promise<void> {
    this.watcher.onLines((b) => this.onLines(b));
    this.watcher.onGone((r) => this.onGone(r));
    await this.watcher.start();
    if (this.codexWatcher) {
      this.codexWatcher.onLines((b) => this.onCodexLines(b));
      this.codexWatcher.onGone((r) => this.onGone(r));
      await this.codexWatcher.start();
    }
    await this.pollLiveness();

    if (diag) { await this.diagnose(); return; }

    this.escalations.onOpen((e) => this.onEscalation(e));
    this.escalations.onWithdraw((id, reason) => this.onWithdraw(id, reason));
    this.escalations.start();
    /*
     * Un informe de AUTOMEJORA sube tal cual: quién lo escribió, qué revisión
     * dice contestar y las propuestas. Quien decide si vale es el hub, que es
     * el único que sabe qué revisión está en vuelo y de quién es; el collector
     * sólo valida forma y tamaño, y devuelve al agente lo que el hub conteste.
     */
    this.improveDrops.onDrop((d) => {
      // La ruta del ack se queda AQUÍ, indexada por un id que sí viaja: el hub
      // contesta con el id y nunca elige dónde se escribe un fichero.
      const reportId = `rep_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      this.improveAcks.set(reportId, d.ackFile);
      this.send({
        t: 'improve:report', machineId: this.machineId, reportId,
        agentId: d.agentId, reviewId: d.reviewId, proposals: d.proposals,
      });
    });
    this.improveDrops.start();

    this.messages.onMessage((m) => this.onMessage(m));
    this.messages.start();

    this.artifacts.onArtifact((a) => this.onArtifact(a));
    this.artifacts.onGone((id) => this.send({ t: 'artifact:gone', machineId: this.machineId, id }));
    this.artifacts.start();

    this.spawns.onRequest((r) => this.onSpawnRequest(r));
    this.spawns.start();

    if (this.wantsCapcom) {
      /*
       * Sólo UNA máquina de la flota debe llevar CAPCOM: el hub entrega lo que
       * escribe el humano a la sesión con `role:'capcom'`, y dos de ellas serían
       * dos mentes triando la misma pregunta. Aquí no se puede comprobar —esta
       * máquina no ve a las otras— así que la regla vive en `wantsCapcom`: por
       * defecto lo lleva la máquina del hub, y las demás sólo con `--capcom`.
       */
      this.capcom = new CapcomSession({
        bin: resolveClaudeBin(),
        hubUrl: this.hubUrl(),
        token: sharedToken(),
        lineage: this.lineage,
        alive: (id) => this.shortIdAlive(id),
        note: (level, text) => this.note(level, text),
        tmux: this.tmux,
        // Sus directorios de trabajo adicionales: leer los repos que manda
        // no debe abrirle un diálogo en un pane que nadie mira.
        roots: () => this.projects.all().map((p) => p.path),
        agentIdOf: (id) => this.capcomDeriver(id)?.id ?? null,
        rotated: (info) => { this.send({ t: 'capcom:rotated', machineId: this.machineId, ...info }); },
      });
      log('info', SCOPE, `CAPCOM habilitado en ${this.capcom.dir}`);
      this.timers.push(setInterval(() => {
        // Sin hub no se relanza: sus herramientas viven en el hub, y un CAPCOM
        // sin tools quema una vuelta para descubrir que no puede hacer nada.
        if (!this.connected) return;
        this.capcom?.check();
        this.maybeRotateCapcom();
      }, CAPCOM_CHECK_MS));
    }

    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    this.timers.push(setInterval(() => { void this.pollLive(); }, LIVE_MS));
    this.timers.push(setInterval(() => { void this.pollLiveness(); }, LIVENESS_MS));
    this.timers.push(setInterval(() => { void this.projects.refreshGit(); }, GIT_MS));
    this.timers.push(setInterval(() => this.beat(), BEAT_INTERVAL_MS));
    // Hygiene rides its own slow clock: it costs a bounded directory walk, and
    // disk usage moves in minutes. The first one waits a beat so a starting
    // collector is not competing with its own discovery for the disk.
    this.timers.push(setInterval(() => { void this.sampleHygiene(); }, HYGIENE_INTERVAL_MS));
    setTimeout(() => { void this.sampleHygiene(); }, 20_000).unref?.();
    for (const t of this.timers) t.unref?.();

    log('info', SCOPE, `máquina ${this.machineName} (${this.machineId.slice(0, 8)}) lista`);
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = null;
    this.terms.closeAll();
    for (const w of this.liveWatches.values()) { if (w.timer) clearTimeout(w.timer); w.watch.close(); }
    this.liveWatches.clear();
    for (const t of this.timers) clearInterval(t);
    this.watcher.stop();
    this.codexWatcher?.stop();
    this.escalations.stop();
    this.improveDrops.stop();
    this.messages.stop();
    this.artifacts.stop();
    this.spawns.stop();
    try { this.ws?.close(); } catch { /* ya cerrado */ }
  }

  /* ── ingesta ──────────────────────────────────────────────────── */

  private onLines(batch: LineBatch): void {
    const d = this.deriverFor(batch.ref);
    d.ingest(batch);
    this.lineage.ingest(batch);
    // El cwd se lee DESPUÉS de ingerir: una línea del propio lote puede ser la
    // primera que lo declara, y las rutas relativas de file-history dependen de
    // él. Un lote de arranque trae ambas cosas junta.
    this.collisions.ingest(batch, d.cwd);
    if (d.cwd) {
      const p = this.projects.ensureWork(batch.ref.slug, d.cwd);
      if (p) {
        this.unhide(d.id);
        d.setProject(p.id);
        this.escalations.track(p.id, p.path);
        this.improveDrops.track(p.id, p.path);
        this.messages.track(p.id, p.path);
        this.artifacts.track(p.id, p.path);
        this.spawns.track(p.id, p.path);
      } else {
        // El directorio no es un proyecto: ni se registra, ni se vigilan sus
        // buzones. Sin `spawns.track` nadie puede pedir trabajo ahí dejando un
        // archivo, que es la otra puerta además del hub.
        this.hide(d.id, this.projects.excludes(batch.ref.slug, d.cwd));
        d.setProject(this.projects.idForSlug(foldWorktreeSlug(batch.ref.slug)));
      }
    }
    this.publishActivity();
  }

  /**
   * Un rollout de Codex. El proyecto sale del cwd que declara el session_meta
   * —no hay slug en la ruta— así que hasta ver esa línea no hay deriver: en un
   * archivo grande llega por el rescate hacia atrás, un batch después.
   */
  private onCodexLines(batch: LineBatch): void {
    let d = this.derivers.get(batch.ref.key);
    if (!d) {
      const cwd = cwdFromCodexLines(batch.lines);
      if (!cwd) return;
      const slug = pathToSlug(cwd);
      const project = this.projects.ensureWork(slug, cwd);
      if (!project) this.hide(batch.ref.key, this.projects.excludes(slug, cwd));
      const projectId = project?.id ?? this.projects.idForSlug(slug);
      const cd = new CodexDeriver(batch.ref, this.machineId, projectId);
      cd.setCallsign(this.callsigns.assign(projectId, batch.ref.key));
      this.derivers.set(batch.ref.key, cd);
      d = cd;
    }
    d.ingest(batch);
    if (d.cwd) {
      const slug = pathToSlug(d.cwd);
      const p = this.projects.ensureWork(slug, d.cwd);
      if (p) {
        this.unhide(d.id);
        d.setProject(p.id);
        this.escalations.track(p.id, p.path);
        this.improveDrops.track(p.id, p.path);
        this.messages.track(p.id, p.path);
        this.artifacts.track(p.id, p.path);
        this.spawns.track(p.id, p.path);
      } else {
        this.hide(d.id, this.projects.excludes(slug, d.cwd));
        d.setProject(this.projects.idForSlug(slug));
      }
    }
    this.publishActivity();
  }

  private onGone(ref: TranscriptRef): void {
    const d = this.derivers.get(ref.key);
    if (!d) return;
    this.derivers.delete(ref.key);
    this.hiddenAgents.delete(ref.key);
    this.screenStill.delete(ref.key);
    this.waiting.delete(ref.key);
    this.callsigns.release(d.projectId, ref.key);
    this.collisions.forget(ref.key);
    // Su `ask` abierto ya no bloquea a nadie: no hay nadie a quien bloquear.
    for (const id of this.messages.forgetAgent(ref.key)) {
      log('info', SCOPE, `mensaje ${id} retirado: su emisor desapareció`);
    }
    this.sent.delete(ref.key);
    this.talkSent.delete(ref.key);
    this.send({ t: 'agent:gone', machineId: this.machineId, id: ref.key });
    this.note('info', `${ref.key.slice(0, 8)} desapareció del disco`, ref.key);
  }

  /** Apunta que este agente vive fuera de la flota. Sin razón, no hace nada. */
  private hide(id: string, why: ExcludedWorkspace | null): void {
    if (why) this.hiddenAgents.set(id, why);
  }

  /** El transcript resultó estar en un proyecto de verdad después de todo. */
  private unhide(id: string): void {
    this.hiddenAgents.delete(id);
  }

  /**
   * Pone la marca de "fuera de la flota" sobre un snapshot ya derivado.
   *
   * Se aplica AQUÍ y no dentro del deriver porque depende de dos cosas que el
   * deriver no conoce: dónde vive su transcript y qué rol acabó teniendo. El
   * CAPCOM vivo queda visible aunque su directorio esté excluido, que es lo
   * que lo distingue de los CAPCOM anteriores que quedaron en el mismo sitio.
   */
  private markHidden(snap: Agent, id: string): Agent {
    const where = this.hiddenAgents.get(id) ?? null;
    // Se escribe `false` explícito —y no se omite— cuando el sitio está
    // excluido pero el agente es el mando: una rotación estrena sesión ahí y
    // pasa por hidden hasta que el linaje le da el rol, y un patch con el
    // campo ausente dejaría al hub creyendo que sigue escondido. Un agente de
    // un proyecto normal no lleva el campo en absoluto.
    if (where) snap.hidden = hiddenInWorkspace(where, snap.role);
    // La CLASE del sitio viaja siempre que haya sitio, `hidden` o no: es lo
    // que la consola necesita para agrupar en una isla `capcom` y una
    // `scratch` en vez de una por directorio. Ver `shared/workspaces.ts`.
    if (where) snap.workspace = where;
    return snap;
  }

  private deriverFor(ref: TranscriptRef): Deriver {
    let d = this.derivers.get(ref.key);
    if (d) return d;
    const project = this.projects.ensureWork(ref.slug);
    // Sin proyecto el agente conserva un id derivado del slug: el tipo lo
    // exige y el linaje lo usa para agrupar, aunque nadie registre esa isla.
    const projectId = project?.id ?? this.projects.idForSlug(foldWorktreeSlug(ref.slug));
    if (!project) this.hide(ref.key, this.projects.excludes(ref.slug));
    d = new SessionDeriver(ref, this.machineId, projectId);
    d.setCallsign(this.callsigns.assign(projectId, ref.key));
    this.derivers.set(ref.key, d);
    if (project) {
      this.escalations.track(project.id, project.path);
      this.improveDrops.track(project.id, project.path);
      this.messages.track(project.id, project.path);
      this.artifacts.track(project.id, project.path);
      this.spawns.track(project.id, project.path);
    }
    return d;
  }

  /* ── liveness: `claude agents --json` + ~/.claude/jobs ────────── */

  private async pollLiveness(): Promise<void> {
    const rows = await claudeAgentsJson();
    const next = new Map<string, Liveness>();
    for (const row of rows) {
      const sessionId = str(row['sessionId']);
      if (!sessionId) continue;
      const kind = str(row['kind']);
      const shortId = str(row['id']);
      const cliState = str(row['state']) ?? str(row['status']);
      next.set(sessionId, {
        alive: true,
        background: kind === 'background',
        shortId,
        pid: typeof row['pid'] === 'number' ? row['pid'] : null,
        name: str(row['name']),
        startedAt: num(row['startedAt'], 0) || null,
        cliState,
        pane: false,
      });
      if (shortId) this.lineage.bind(shortId, sessionId);
    }

    /*
     * Los panes. Un pane vivo es una sesión viva aunque `claude agents` aún no
     * la liste —tarda unos segundos tras arrancar— y es lo que dice si se
     * puede abrir una TERMINAL sobre ella.
     */
    this.panes = await this.tmux.list();
    for (const [name, info] of this.panes) {
      const sessionId = sessionIdOfPane(name);
      if (!sessionId || info.dead) continue;
      const l = next.get(sessionId);
      if (l) { l.pane = true; continue; }
      next.set(sessionId, {
        alive: true, background: false, shortId: null, pid: info.pid,
        name: null, startedAt: null, cliState: null, pane: true,
      });
    }
    this.liveness = next;
    await this.pollScreens();

    // Los background publican su propio estado en ~/.claude/jobs/<id>/state.json,
    // que es lo más cercano a "el agente dice que está bloqueado" que existe hoy.
    this.jobStates.clear();
    for (const [sessionId, l] of this.liveness) {
      if (!l.shortId) continue;
      const sig = readJobBlock(l.shortId);
      if (sig) this.jobStates.set(sessionId, sig);
    }
  }

  /* ── prompts en pantalla ──────────────────────────────────────── */

  /**
   * Mira la pantalla de cada pane vivo por si hay un prompt esperando.
   *
   * Cada pane, en cada poll de liveness: un `capture-pane` cuesta milisegundos
   * y no hay otra señal fiable. El transcript NO sirve de filtro: el CLI
   * escribe el turno con el `tool_use` DESPUÉS de que el humano conteste, así
   * que mientras el diálogo está en pantalla la sesión parece `booting` o
   * `idle` y `gatedPending` no ve nada — medido con un heredoc de python3.
   *
   * Lo que se ve se convierte en lo mismo que una pregunta del agente — una
   * escalación con `allow | deny` — así que CAPCOM la recibe por el camino de
   * siempre, el humano la ve en la cola de interrupciones si CAPCOM no
   * contesta, y la respuesta vuelve como teclas al pane (`permit`).
   *
   * Sin esto un agente hospedado en `acceptEdits` que lanza un `Bash` se
   * queda con "Do you want to proceed?" en una pantalla que nadie mira, y la
   * consola lo pinta como `working`. Medido en ping-pong-papas.
   */
  private screensPolling = false;
  private async pollScreens(): Promise<void> {
    if (this.screensPolling) return;
    this.screensPolling = true;
    try { await this.readScreens(); } finally { this.screensPolling = false; }
  }

  private async readScreens(): Promise<void> {
    const now = Date.now();
    // Una pantalla por sesión raíz: los subagentes comparten el pane del padre.
    const seen = new Set<string>();
    for (const d of this.derivers.values()) {
      if (d.ref.agentId) continue;
      const l = this.liveness.get(d.ref.sessionId);
      const pane = l?.pane ? paneName(d.ref.sessionId) : null;
      const open = this.screenPrompts.get(d.id);
      // Sin pane no hay pantalla; si ya no está vivo, lo que hubiera se retira.
      if (!pane || !l?.alive || seen.has(pane)) {
        if (open) this.withdrawPrompt(d.id, 'la sesión terminó');
        this.screenStill.delete(d.id);
        this.waiting.delete(d.id);
        continue;
      }
      seen.add(pane);
      const pending = d.gatedPending(now, 0);

      const shot = await this.tmux.permissionView(pane);
      if (!shot) continue; // unreadable is not confirmation
      const still = this.stillFor(d.id, shot.screen, now);
      const prompt = promptOn(shot.screen);
      if (!prompt) {
        this.markWaiting(d, still, shot.title, now);
        if (open?.request.claimed && shot.identity === open.request.identity && permissionClosed(shot.screen)) {
          open.escalation.permission!.phase = 'confirmed';
          open.escalation.status = 'answered';
          open.escalation.answer = 'Dialog closure observed. Approval decision and tool success are not observable from the terminal.';
          open.escalation.answeredAt = now;
          this.send({ t: 'escalation', machineId: this.machineId, escalation: open.escalation });
        }
        if (open) this.withdrawPrompt(d.id, 'Dialog no longer observable; no approval or tool success inferred');
        continue;
      }
      // Reconocido el diálogo, el parón no aporta: la escalación dice más.
      const priorWait = this.waiting.get(d.id);
      this.waiting.delete(d.id);
      if (open && open.request.identity === shot.identity && open.request.fingerprint === prompt.fingerprint) continue;
      if (open) this.withdrawPrompt(d.id, 'Permission dialog changed; previous outcome unconfirmed');
      /*
       * La confianza de carpeta no tiene alcance "una vez": no hay tecla que
       * ORCA pueda mandar en nombre de nadie, así que no hay escalación que
       * ofrecer. Lo que sí hay es lo que faltó el 2026-09-08: decir QUÉ se
       * pregunta y DÓNDE se contesta, en vez de dejarlo al parón genérico.
       */
      if (prompt.kind === 'trust') {
        const block = nativeDialogSignal(
          prompt.question, this.tmux.attachHint(pane),
          priorWait?.summary?.startsWith(NATIVE_DIALOG_MARK) ? priorWait.since : now,
        );
        this.waiting.set(d.id, block);
        if (priorWait?.summary !== block.summary) this.note('alert', `${d.callsign} está parado en un diálogo nativo: ${prompt.question}`, d.id);
        continue;
      }

      const question = `${d.callsign} requests ${prompt.runtime} permission`;
      const e: Escalation = {
        id: newId('esc'), agentId: d.id, projectId: d.projectId, machineId: this.machineId,
        question, context: `${prompt.summary}\nRisk: ${prompt.summary.includes('MCP server') ? 'MCP tool may read or change external state' : 'shell execution may affect files, processes or network'}. Arguments are omitted; inspect the terminal against the mission before deciding. Allow is once only.`,
        permission: { phase: shot.claimedFingerprint === prompt.fingerprint ? 'pending' : 'requested', fingerprint: prompt.fingerprint },
        options: ['allow', 'deny'], optionsOnly: true,
        urgency: 'blocking', status: 'pending', ceoAttempt: null,
        answer: null, answeredBy: null, rememberAs: null,
        askedAt: pending?.at ?? now, answeredAt: null, expiresAt: null,
      };
      this.screenPrompts.set(d.id, {
        escalation: e,
        request: { agentId: d.id, sessionId: d.ref.sessionId, pane, identity: shot.identity, fingerprint: prompt.fingerprint, claimed: shot.claimedFingerprint === prompt.fingerprint },
        block: { kind: 'permission', summary: oneLine(question, 160), escalationId: e.id, since: e.askedAt },
      });
      this.escalationBySession.set(d.id, e);
      this.send({ t: 'escalation', machineId: this.machineId, escalation: e });
      this.note('alert', question, d.id);
    }
    await this.readOrphanScreens(seen);
  }

  /**
   * Panes de ORCA que ningún agente reclama todavía.
   *
   * Es el agujero por el que se colaron los cinco workers del 2026-09-08:
   * mientras el diálogo de confianza está en pantalla, Claude Code NO crea su
   * directorio en `~/.claude/projects` —comprobado con 2.1.263, con y sin
   * `--session-id`—, así que no hay transcript, no hay deriver, y el bucle de
   * arriba, que recorre derivers, nunca mira ese pane. El agente no existe
   * para ORCA y su pane está congelado: la única forma de contarlo es por el
   * pane, que sí existe.
   *
   * No hay agente al que colgarle un bloqueo, así que sale por el feed —la
   * misma línea que el operador ya lee— y una sola vez por diálogo: el poll
   * pasa cada pocos segundos y esto puede durar horas.
   */
  private async readOrphanScreens(claimed: Set<string>): Promise<void> {
    for (const name of this.paneDialogs.keys()) {
      if (!this.panes.has(name) || claimed.has(name)) this.paneDialogs.delete(name);
    }
    for (const [name, info] of this.panes) {
      if (claimed.has(name) || info.dead) continue;
      const shot = await this.tmux.permissionView(name);
      if (!shot) continue;
      const prompt = promptOn(shot.screen);
      if (!prompt) { this.paneDialogs.delete(name); continue; }
      if (this.paneDialogs.get(name) === prompt.fingerprint) continue;
      this.paneDialogs.set(name, prompt.fingerprint);
      this.note('alert',
        `${name} no ha llegado a existir como sesión: está parado en un diálogo del CLI. `
        + nativeDialogSignal(prompt.question, this.tmux.attachHint(name), Date.now()).summary);
    }
  }

  /**
   * Cuánto lleva esta pantalla sin cambiar, en ms. Cero si acaba de cambiar.
   *
   * Se guarda una huella por agente y se compara con la anterior. Nada de esto
   * mira lo que la pantalla dice, y ése es el punto: es la única señal de
   * "parado" que no se rompe cuando una CLI reescribe su TUI.
   */
  private stillFor(agentId: string, screen: string, now: number): number {
    const sig = screenSignature(screen);
    const prev = this.screenStill.get(agentId);
    if (!prev || prev.sig !== sig) {
      this.screenStill.set(agentId, { sig, since: now });
      // Algo se pintó: lo que estuviera parado, ya no lo está.
      this.waiting.delete(agentId);
      return 0;
    }
    return now - prev.since;
  }

  /**
   * Sin diálogo reconocido, las dos señales que quedan, en orden de confianza:
   * lo que el CLI declara en su título, y el parón de la pantalla.
   */
  private markWaiting(d: Deriver, stillMs: number, title: string, now: number): void {
    const declared = titleSignal(title, now);
    const open = this.waiting.get(d.id);
    if (declared) {
      // Ya anotado: se conserva el `since` de la primera vez. El marcador del
      // título parpadea, y un bloqueo que se reinicia cada segundo no dura.
      if (open?.kind === 'permission') return;
      this.waiting.set(d.id, declared);
      this.note('alert', `${d.callsign} pide una respuesta en su terminal (lo dice su CLI)`, d.id);
      return;
    }
    // Lo declaró y ya no: alguien contestó, o el CLI siguió solo.
    if (open?.kind === 'permission') { this.waiting.delete(d.id); return; }
    if (open) return;
    const block = stallSignal(d.state(now), stillMs, now, STALL_MS);
    if (!block) return;
    this.waiting.set(d.id, block);
    this.note('warn', `${d.callsign} lleva ${Math.round(stillMs / 1000)}s parado esperando input`, d.id);
  }

  /**
   * Lo que CAPCOM está escribiendo, leído de su pane. Sólo CAPCOM, sólo con
   * pane, sólo en `thinking`/`working`: fuera de eso no hay nada que leer.
   *
   * La lectura la dispara el pane al pintar (`ensureLiveWatch`); esta vuelta
   * de 400 ms es el respaldo: mantiene el cliente de control vivo, retira el
   * texto cuando el estado deja de ser redactar, y sondea sólo cuando no hay
   * cliente —tmux sin modo control, o caído y en espera de relanzarse.
   */
  private async pollLive(): Promise<void> {
    if (this.livePolling || !this.connected) return;
    this.livePolling = true;
    try {
      for (const d of this.derivers.values()) {
        const last = this.sent.get(d.id);
        if (!last || last.role !== 'capcom') continue;
        const l = this.liveness.get(d.ref.sessionId);
        const pane = l?.pane && l.alive ? paneName(d.ref.sessionId) : null;
        if (!pane) { this.dropLiveWatch(d.id); this.setLive(d.id, null); this.liveDone.delete(d.id); continue; }
        const state = d.state();
        const writing = state === 'thinking' || state === 'working';
        if (!writing) { this.setLive(d.id, null); this.liveDone.delete(d.id); }
        if (this.ensureLiveWatch(d.id, pane)) continue;   // el evento lee; aquí no
        if (writing) await this.captureLive(d.id);
      }
    } finally {
      this.livePolling = false;
    }
  }

  /** El cliente de control del pane de este agente, creándolo si toca. Null = sin él, se sondea. */
  private ensureLiveWatch(agentId: string, pane: string): LiveWatch | null {
    const cur = this.liveWatches.get(agentId);
    if (cur && cur.pane === pane) return cur;
    if (cur) this.dropLiveWatch(agentId);
    if ((this.liveWatchRetryAt.get(agentId) ?? 0) > Date.now()) return null;
    const watch = this.tmux.watchOutput(pane, {
      output: () => this.scheduleLive(agentId),
      exit: (reason) => {
        const w = this.liveWatches.get(agentId);
        if (w?.pane !== pane) return;
        if (w.timer) clearTimeout(w.timer);
        this.liveWatches.delete(agentId);
        this.liveWatchRetryAt.set(agentId, Date.now() + LIVE_WATCH_RETRY_MS);
        log('debug', SCOPE, `texto en vivo de ${pane}: ${reason}; sondeo hasta relanzar`);
      },
    });
    if (!watch) { this.liveWatchRetryAt.set(agentId, Date.now() + LIVE_WATCH_RETRY_MS * 6); return null; }
    const w: LiveWatch = { pane, watch, timer: null, lastAt: 0, again: false };
    this.liveWatches.set(agentId, w);
    log('info', SCOPE, `texto en vivo de ${pane} por eventos de tmux`);
    return w;
  }

  private dropLiveWatch(agentId: string): void {
    const w = this.liveWatches.get(agentId);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    this.liveWatches.delete(agentId);
    w.watch.close();
  }

  /**
   * El pane pintó: leer, pero no ahora mismo. Se espera LIVE_DEBOUNCE_MS para
   * que una ráfaga sea una lectura, y nunca más seguido que LIVE_MIN_GAP_MS.
   * Si mientras se leía volvió a pintar, se lee otra vez al terminar.
   */
  private scheduleLive(agentId: string): void {
    const w = this.liveWatches.get(agentId);
    if (!w) return;
    if (w.timer) { w.again = true; return; }
    const wait = Math.max(LIVE_DEBOUNCE_MS, w.lastAt + LIVE_MIN_GAP_MS - Date.now());
    w.timer = setTimeout(async () => {
      w.again = false;
      w.lastAt = Date.now();
      try { await this.captureLive(agentId); } finally {
        w.timer = null;
        if (w.again) this.scheduleLive(agentId);
      }
    }, wait);
    w.timer.unref?.();
  }

  /** Una lectura del pane y su traducción a texto en vivo (o a nada). */
  private async captureLive(agentId: string): Promise<void> {
    const d = this.derivers.get(agentId);
    if (!d || this.liveCapturing.has(agentId)) return;
    const l = this.liveness.get(d.ref.sessionId);
    const pane = l?.pane && l.alive ? paneName(d.ref.sessionId) : null;
    const state = d.state();
    if (!pane || (state !== 'thinking' && state !== 'working')) { this.setLive(agentId, null); this.liveDone.delete(agentId); return; }
    this.liveCapturing.add(agentId);
    try {
      // 120 líneas: un párrafo largo a 100 columnas son 30; el bloque tiene
      // que caber entero o no se sabe dónde empieza.
      const shot = await this.tmux.capture(pane, 120);
      const text = shot.ok ? liveText(shot.stdout) : null;
      if (text !== null && text === this.liveDone.get(agentId)) return;
      if (text !== null) this.liveDone.delete(agentId);
      this.setLive(agentId, text);
    } finally {
      this.liveCapturing.delete(agentId);
    }
  }

  private setLive(agentId: string, text: string | null): void {
    const prev = this.liveSent.get(agentId) ?? null;
    if (prev === text) return;
    if (text === null) this.liveSent.delete(agentId); else this.liveSent.set(agentId, text);
    this.send({ t: 'talk:live', machineId: this.machineId, agentId, text });
  }

  private withdrawPrompt(agentId: string, reason: string): void {
    const open = this.screenPrompts.get(agentId);
    if (!open) return;
    this.screenPrompts.delete(agentId);
    if (this.escalationBySession.get(agentId)?.id === open.escalation.id) {
      this.escalationBySession.delete(agentId);
    }
    this.send({ t: 'escalation:withdraw', machineId: this.machineId, id: open.escalation.id, reason });
  }

  private async answerScreenPermission(id: string, answer: string): Promise<{ ok: boolean; detail: string }> {
    const entry = [...this.screenPrompts.values()].find(p => p.escalation.id === id);
    if (!entry) return { ok: false, detail: 'Stale permission; no key sent' };
    const r = entry.request;
    return answerPermission(r, answer, {
      current: () => {
        const d = this.derivers.get(r.agentId);
        const a = d && this.handleOf(d);
        return this.screenPrompts.get(r.agentId) === entry && a?.id === r.agentId && a.sessionId === r.sessionId && a.pane === r.pane && a.alive;
      },
      view: () => this.tmux.permissionView(r.pane),
      key: (identity, key) => this.tmux.permissionKey(identity, key, r.fingerprint),
      retire: reason => { if (this.screenPrompts.get(r.agentId) === entry) this.withdrawPrompt(r.agentId, reason); },
      pending: () => {
        entry.escalation.permission!.phase = 'pending';
        entry.escalation.context += '\nResponse requested; waiting for terminal evidence. Do not retry. If still visible, finish manually.';
        this.send({ t: 'escalation', machineId: this.machineId, escalation: entry.escalation });
      },
    });
  }

  /* ── escalaciones ─────────────────────────────────────────────── */

  private onEscalation(e: Escalation): void {
    this.escalationBySession.set(e.agentId, e);
    this.send({ t: 'escalation', machineId: this.machineId, escalation: e });
    const d = this.derivers.get(e.agentId);
    this.note('alert', `${d?.callsign ?? '??'} pregunta: ${oneLine(e.question, 100)}`, e.agentId);
  }

  private onWithdraw(id: string, reason: string): void {
    for (const [agentId, e] of this.escalationBySession) {
      if (e.id === id) this.escalationBySession.delete(agentId);
    }
    this.send({ t: 'escalation:withdraw', machineId: this.machineId, id, reason });
  }

  /* ── mensajes entre agentes ───────────────────────────────────── */

  private onMessage(m: AgentMessage): void {
    this.send({ t: 'message', machineId: this.machineId, message: m });
    const level: FeedLevel = m.kind === 'warning' ? 'alert'
      : m.kind === 'ask' ? 'warn' : 'info';
    const to = m.scope === 'agent' && m.toAgentId
      ? (this.derivers.get(m.toAgentId)?.callsign ?? m.toAgentId.slice(0, 8))
      : m.scope === 'project' ? (this.projects.get(m.toProjectId ?? '')?.code ?? 'proyecto')
        : m.scope === 'squad' ? `squad:${m.toSquad ?? '?'}`
          : 'flota';
    this.note(level, `${m.fromCallsign} → ${to} (${m.kind}): ${oneLine(m.subject, 90)}`,
      m.fromAgentId);
  }

  /* ── un agente pide otro agente ───────────────────────────────── */

  /**
   * `orca-spawn` desde un agente: se decide aquí, con lo que el collector ya
   * sabe del que pide, y se lanza por el mismo runner que usa la consola. El
   * ack se escribe SIEMPRE, también cuando se rechaza: una petición que no
   * dice nada es indistinguible de un collector caído.
   */
  private async onSpawnRequest(r: SpawnRequest): Promise<void> {
    const d = r.requesterId ? this.derivers.get(r.requesterId) : undefined;
    const who = d ? (() => {
      const snap = d.snapshot();
      const live = snap.childIds.filter((id) => {
        const c = this.derivers.get(id);
        return c ? !TERMINAL_STATES.has(c.state()) : false;
      }).length;
      return { id: d.id, callsign: d.callsign, squad: snap.squad, liveChildren: live };
    })() : null;
    const size = (name: string) => {
      let n = 0;
      for (const x of this.derivers.values()) {
        if (x.snapshot().squad === name && !TERMINAL_STATES.has(x.state())) n++;
      }
      return n;
    };

    const plan = planChild(r, who, size);
    if (!plan.ok) {
      this.note('warn', `${who?.callsign ?? '??'} pidió un agente: rechazado — ${plan.reason}`, who?.id);
      await writeAck(r.ackFile, { ok: false, reason: plan.reason, at: Date.now() });
      return;
    }

    const res = await this.runner.execute(plan.cmd);
    const data = (res.data ?? {}) as { agentId?: string | null; callsign?: string | null; shortId?: string | null };
    await writeAck(r.ackFile, {
      ok: res.ok,
      ...(res.ok ? {} : { reason: res.detail ?? 'the collector could not launch it' }),
      agentId: data.agentId ?? null,
      callsign: data.callsign ?? null,
      shortId: data.shortId ?? null,
      squad: plan.squad,
      parentId: who?.id ?? null,
      at: Date.now(),
    });
    this.note(res.ok ? 'info' : 'warn',
      res.ok
        ? `${who?.callsign ?? '??'} lanzó a ${data.callsign ?? '(pendiente)'}${plan.squad ? ` en ${plan.squad}` : ''}: ${oneLine(r.mission, 80)}`
        : `${who?.callsign ?? '??'} pidió un agente: falló — ${res.detail ?? '?'}`,
      who?.id);
  }

  /* ── artefactos ───────────────────────────────────────────────── */

  private onArtifact(a: Artifact): void {
    this.send({ t: 'artifact', machineId: this.machineId, artifact: a });
    const d = this.derivers.get(a.agentId);
    this.note('info', `${d?.callsign ?? '??'} produjo ${a.kind}: ${oneLine(a.title, 80)}`, a.agentId);
  }

  /** Callsign → agente. Prefiere uno vivo: las etiquetas se reciclan al morir. */
  private agentByCallsign(callsign: string): { agentId: string; projectId: string } | null {
    const want = callsign.trim().toUpperCase();
    if (!want) return null;
    let fallback: { agentId: string; projectId: string } | null = null;
    for (const d of this.derivers.values()) {
      if (d.callsign.toUpperCase() !== want) continue;
      const hit = { agentId: d.id, projectId: d.projectId };
      if (!TERMINAL_STATES.has(d.state())) return hit;
      fallback ??= hit;
    }
    return fallback;
  }

  /** Nombre, código o slug de proyecto → id. El agente escribe lo que recuerda. */
  private projectByName(name: string): string | null {
    const want = name.trim().toLowerCase();
    if (!want) return null;
    for (const p of this.projects.all()) {
      if (p.name.toLowerCase() === want || p.code.toLowerCase() === want
        || p.slug.toLowerCase() === want) return p.id;
    }
    // Segunda pasada, más laxa: "dijosi" debe encontrar "dijosi-workers-…".
    for (const p of this.projects.all()) {
      if (p.name.toLowerCase().includes(want)) return p.id;
    }
    return null;
  }

  /* ── colisiones ───────────────────────────────────────────────── */

  private sweepCollisions(agents: Agent[], now: number): void {
    const input: CollisionAgent[] = agents.map((a) => ({
      id: a.id,
      projectId: a.projectId,
      machineId: a.machineId,
      /*
       * "Vivo" aquí es "no terminado", no `isLive()`. Un agente en `idle` está
       * parado en end_turn con su proceso arriba: acaba de escribir y va a
       * seguir escribiendo en cuanto alguien le hable. Excluirlo perdería
       * justo las colisiones del momento en que un humano está a punto de
       * mandar a dos agentes sobre el mismo archivo.
       */
      live: !TERMINAL_STATES.has(a.state),
      parentId: a.parentId,
    }));
    const { open, cleared } = this.collisions.detect(input, now);
    for (const col of open) {
      this.send({ t: 'collision', machineId: this.machineId, collision: col });
      const who = col.agentIds
        .map((id) => this.derivers.get(id)?.callsign ?? id.slice(0, 8)).join(' + ');
      this.note('alert', `colisión: ${who} escriben ${shortPath(col.path)}`, col.agentIds[0]);
    }
    for (const id of cleared) {
      this.send({ t: 'collision:clear', machineId: this.machineId, id });
    }
  }

  /** Atribuye un buzón a un agente: el que declara el archivo, o el más activo. */
  private resolveAgent(projectId: string, hint: string | null): string | null {
    if (hint) {
      if (this.derivers.has(hint)) return hint;
      for (const d of this.derivers.values()) {
        if (d.ref.sessionId === hint || d.ref.agentId === hint) return d.id;
      }
    }
    let best: Deriver | null = null;
    let bestAt = -1;
    for (const d of this.derivers.values()) {
      if (d.projectId !== projectId) continue;
      const snap = d.snapshot();
      if (snap.state === 'done' || snap.state === 'dead') continue;
      if (snap.updatedAt > bestAt) { bestAt = snap.updatedAt; best = d; }
    }
    return best?.id ?? null;
  }

  /* ── tick: derivar y emitir ───────────────────────────────────── */

  /** Coalesce transcript events; keep the 500ms timer as reconciliation. */
  private publishActivity(): void {
    if (this.stopping || this.activityTimer) return;
    const delay = Math.max(25, 250 - (Date.now() - this.lastActivityTick));
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      if (!this.stopping) this.tick();
    }, delay);
    this.activityTimer.unref?.();
  }

  private tick(): void {
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = null;
    this.lastActivityTick = Date.now();
    const now = Date.now();
    this.ticks++;
    this.escalations.reapExpired(now);
    this.messages.reapExpired(now);
    const peers = this.messages.blocks();

    // 1. señales externas dentro de cada deriver
    const inputs = [] as { key: string; sessionId: string; agentId: string | null;
      metaPath: string | null; shortId: string | null }[];
    for (const d of this.derivers.values()) {
      const l = this.liveness.get(d.ref.sessionId);
      d.setLiveness(l ?? {
        alive: false, background: false, shortId: null, pid: null,
        name: null, startedAt: null, cliState: null, pane: false,
      });
      // Prioridad: humano > par > job. Si un agente espera a las dos cosas, la
      // pregunta al humano es la que nadie más puede desatascar.
      const esc = this.escalationBySession.get(d.id);
      const peer = peers.get(d.id);
      const screen = this.screenPrompts.get(d.id);
      if (screen) {
        // Es una escalación, pero de tipo permiso: la consola lo pinta distinto.
        d.setBlock(screen.block);
      } else if (esc) {
        d.setBlock({
          kind: 'question', summary: oneLine(esc.question, 160),
          escalationId: esc.id, since: esc.askedAt,
        });
      } else if (peer) {
        d.setBlock({
          kind: 'peer', summary: peer.summary,
          messageId: peer.messageId, waitingOn: peer.waitingOn, since: peer.since,
        });
      } else if (this.waiting.has(d.id)) {
        // Espera algo que nadie ha sabido leer: va detrás de todo lo que sí
        // tiene nombre, porque ninguna de sus dos señales dice qué se pregunta.
        d.setBlock(this.waiting.get(d.id)!);
      } else {
        d.setBlock(this.screenPrompts.get(d.id)?.block ?? this.jobStates.get(d.ref.sessionId) ?? null);
      }
      // Lo que el agente escribió y merece verse. El deriver sólo apunta la
      // ruta; aquí se le pone dueño y proyecto, que es lo que él no sabe.
      for (const file of d.drainProduced()) {
        this.artifacts.observe({
          path: file.path, projectId: d.projectId, agentId: d.id,
          at: file.at, cwd: d.cwd,
        });
      }
      inputs.push({
        key: d.id, sessionId: d.ref.sessionId, agentId: d.ref.agentId,
        metaPath: d.ref.metaPath, shortId: l?.shortId ?? null,
      });
    }

    // 2. linaje (barato: sólo lee meta.json con mtime cambiado)
    const tree = this.lineage.resolve(inputs);
    for (const d of this.derivers.values()) {
      const lin = tree.get(d.id);
      if (lin) d.setLineage(lin);
    }

    void this.runner.workers.reconcile().catch(e => log('warn', 'recovery', String(e)));
    // 3. diffs de agentes
    const all: Agent[] = [];
    const byProject = new Map<string, Agent[]>();
    for (const d of this.derivers.values()) {
      const snap = this.markHidden(d.snapshot(now), d.id);
      const handle = this.handleOf(d);
      this.runner.models.tick(handle);
      this.runner.reset.tick(handle);
      snap.modelControl = this.runner.models.state(handle);
      snap.resetControl = this.runner.reset.state(handle);
      Object.assign(snap, this.runner.workers.snapshotState(d.id));
      all.push(snap);
      const list = byProject.get(snap.projectId);
      if (list) list.push(snap); else byProject.set(snap.projectId, [snap]);

      // Every agent window reads its bounded conversation stream.
      // Va DESPUÉS del agente: el hub descarta la charla de un id que no conoce.
      const talk = d.drainTalk();
      const sendTalk = () => {
        if (talk.length === 0) return;
        this.send({ t: 'talk', machineId: this.machineId, agentId: snap.id, items: talk });
        // Un bloque de texto que ya llegó entero: lo que la pantalla muestra
        // de él deja de ser "en vivo", aunque siga ahí pintado.
        if (talk.some((t) => t.kind === 'say')) {
          const shown = this.liveSent.get(snap.id) ?? null;
          if (shown !== null) { this.liveDone.set(snap.id, shown); this.setLive(snap.id, null); }
        }
        // Y a la memoria: un hub que se reinicia pierde su charla, y el
        // snapshot de la reconexión la vuelve a mandar (el hub deduplica).
        const ring = this.talkSent.get(snap.id) ?? [];
        ring.push(...talk);
        this.talkSent.set(snap.id, ring.length > MAX_TALK ? ring.slice(-MAX_TALK) : ring);
      };

      const prev = this.sent.get(snap.id);
      if (!prev) {
        this.sent.set(snap.id, snap);
        this.send({ t: 'agent:new', machineId: this.machineId, agent: snap });
        sendTalk();
        this.note('info', `${snap.callsign} ${snap.state}: ${oneLine(snap.title, 60)}`, snap.id);
        continue;
      }
      if (prev.state !== snap.state) {
        this.note(snap.state === 'blocked' ? 'alert' : 'info',
          `${snap.callsign} ${prev.state} → ${snap.state}`, snap.id);
      }
      const patch = diffAgent(prev, snap);
      if (patch) {
        this.sent.set(snap.id, snap);
        this.send({ t: 'agent', machineId: this.machineId, id: snap.id, patch });
      }
      sendTalk();
    }

    // 4. rollups por proyecto
    for (const project of this.projects.all()) {
      const agents = byProject.get(project.id) ?? [];
      const changed = this.projects.setSessions(
        project.id, agents.map((a) => a.id).sort(), rollup(agents),
      );
      const keyNames = this.keys.namesFor(project.id);
      const keysChanged = this.projects.setKeyNames(project.id, keyNames);
      const fresh = this.projects.get(project.id);
      if (!fresh) continue;
      const json = JSON.stringify(fresh);
      const prev = this.sentProjects.get(project.id);
      if (prev === undefined) {
        this.sentProjects.set(project.id, json);
        this.send({ t: 'project:new', machineId: this.machineId, project: fresh });
      } else if (prev !== json || changed || keysChanged) {
        this.sentProjects.set(project.id, json);
        this.send({ t: 'project', machineId: this.machineId, id: project.id, patch: fresh });
      }
      this.escalations.track(project.id, project.path);
      this.improveDrops.track(project.id, project.path);
      this.messages.track(project.id, project.path);
      this.artifacts.track(project.id, project.path);
    this.spawns.track(project.id, project.path);
    }

    // 5. colisiones (cada COLLISION_EVERY ticks; ver la constante)
    if (this.ticks % COLLISION_EVERY === 0) this.sweepCollisions(all, now);

    // 6. feed
    if (this.pendingFeed.length > 0) {
      const items = this.pendingFeed;
      this.pendingFeed = [];
      this.send({ t: 'feed', machineId: this.machineId, items });
    }
  }

  private note(level: FeedLevel, text: string, agentId?: string): void {
    const d = agentId ? this.derivers.get(agentId) : undefined;
    const project = d ? this.projects.get(d.projectId) : null;
    const item: FeedItem = {
      id: newId('fd'),
      at: Date.now(),
      level,
      source: project && d ? `${project.code}/${d.callsign}` : 'ORCA',
      text,
      ...(agentId ? { agentId } : {}),
      ...(d ? { projectId: d.projectId } : {}),
    };
    this.feed.push(item);
    if (this.feed.length > FEED_MAX) this.feed = this.feed.slice(-FEED_MAX);
    this.pendingFeed.push(item);
  }

  /* ── rotación de CAPCOM ───────────────────────────────────────── */

  /** El deriver de la sesión CAPCOM, nombrada por session id (hospedado) o short id (`--bg`). */
  private capcomDeriver(id: string): Deriver | null {
    const direct = this.derivers.get(id);
    if (direct) return direct;
    for (const d of this.derivers.values()) {
      if (d.ref.sessionId === id) return d;
      if (this.liveness.get(d.ref.sessionId)?.shortId === id) return d;
    }
    return null;
  }

  /**
   * ¿Toca reciclar CAPCOM? Corre con el vigilante, cada CAPCOM_CHECK_MS.
   *
   * Lo que se mira es lo que este collector ve: el transcript (compactaciones,
   * turnos, estado) y lo que él mismo le ha pegado. Una escalación de OTRA
   * máquina llega como un `say` del hub y pone a CAPCOM a pensar, así que el
   * silencio exigido (`idleMs`) la cubre con margen; las de esta máquina se
   * cuentan directamente.
   */
  private maybeRotateCapcom(): void {
    const cap = this.capcom;
    const id = cap?.current();
    if (!cap || !id) return;
    // Una sesión preparada (Codex, o un traspaso ya activado) no se recicla
    // matándola: su relevo se prepara antes de retirarla. La decisión de
    // CUÁNDO es la misma; sólo cambia el camino.
    let prepared = false;
    try { prepared = !!cap.recovery(); } catch { return; }
    const d = this.capcomDeriver(id);
    if (!d) return;
    const now = Date.now();
    const m = d.metrics(now);
    const pending = this.escalations.list().filter((e) => e.status === 'pending').length + this.screenPrompts.size;
    const route = rotationRoute({
      state: d.state(now),
      turns: m.turns,
      compactions: m.compactions ?? 0,
      contextTokens: m.contextTokens ?? 0,
      contextWindow: m.contextWindow ?? 0,
      lastActivityAt: d.snapshot(now).updatedAt,
      lastDeliveryAt: this.lastCapcomSayAt,
      pendingEscalations: pending,
    }, { prepared, lastHandoffAt: this.rotationHandoffAt }, this.rotation, now);
    if (route.act === 'none') { this.rotationDueSaid = false; return; }
    if (route.act === 'wait') {
      if (!this.rotationDueSaid) { this.rotationDueSaid = true; log('info', SCOPE, `CAPCOM: toca rotar, espero: ${route.reason}`); }
      return;
    }
    this.rotationDueSaid = false;
    if (route.act === 'handoff') return this.rotateByHandoff(d.id, route.reason, route.mode, now);
    log('info', SCOPE, `CAPCOM: rotando (${route.reason})`);
    void cap.rotate({ turns: m.turns, compactions: m.compactions ?? 0, contextTokens: m.contextTokens ?? 0 });
  }

  /**
   * Rotar preparando el relevo, que es la única forma con Codex.
   *
   * `New CAPCOM` con `continuity` es exactamente esto hecho a mano: prepara un
   * hilo nuevo, comprueba que arranca, y sólo entonces retira al anterior. El
   * checkpoint que hereda lo escribe el hub, no el modelo, y el correo queda
   * retenido durante el cambio — todo eso ya está en `ProviderHandoffs`, así
   * que aquí sólo se decide cuándo pedirlo.
   *
   * Un fallo —cuota agotada, sobre todo— deja al CAPCOM actual exactamente
   * donde estaba; el freno entre intentos lo pone `rotationRoute`.
   */
  private rotateByHandoff(agentId: string, why: string, mode: 'continuity' | 'clean', now: number): void {
    this.rotationHandoffAt = now;
    try {
      const plan = this.runner.handoffs.fresh(agentId, mode);
      log('info', SCOPE, `CAPCOM: rotando por traspaso ${mode} (${why}); plan ${plan.id}`);
      this.note('info', `CAPCOM rota a una sesión nueva (${mode}): ${why}. El relevo se prepara antes de retirar al actual.`);
    } catch (err) {
      log('warn', SCOPE, `CAPCOM: no pude rotar por traspaso (${why}): ${errText(err)}`);
    }
  }

  /* ── handles para commands.ts ─────────────────────────────────── */

  /** ¿Sigue el CLI listando esa sesión de background? Lo que usa CAPCOM. */
  private shortIdAlive(id: string): boolean {
    // Un hospedado se conoce por su session id, que es también el nombre del
    // pane; un `--bg` sólo por el short id que imprimió el CLI.
    if (this.liveness.get(id)?.alive) return true;
    for (const l of this.liveness.values()) {
      if (l.shortId === id && l.alive) return true;
    }
    return false;
  }

  private agentHandle(id: string): AgentHandle | null {
    const d = this.derivers.get(id);
    if (!d) return null;
    return this.handleOf(d);
  }

  private handleOf(d: Deriver): AgentHandle {
    const l = this.liveness.get(d.ref.sessionId);
    return {
      id: d.id,
      projectId: d.projectId,
      sessionId: d.ref.sessionId,
      shortId: l?.shortId ?? null,
      background: l?.background ?? false,
      alive: l?.alive ?? false,
      callsign: d.callsign,
      pane: l?.pane ? paneName(d.ref.sessionId) : null,
      runtime: d.runtime,
      transcriptPath: d.ref.path,
      model: d.snapshot().model,
      state: d.snapshot().state,
      blockKind: d.snapshot().block?.kind,
      worktree: this.lineage.worktreeOf(d.ref.sessionId, l?.shortId ?? null),
      mission: d.snapshot().mission,
      cwd: d.cwd ?? undefined, origin: d.snapshot().origin,
      parentId: d.snapshot().parentId, squad: d.snapshot().squad, lead: d.snapshot().lead, subagent: d.snapshot().subagent,
    };
  }

  /**
   * Espera a que la sesión que acabamos de lanzar exista de verdad.
   *
   * Lanzar es sólo arrancar un proceso: el agente no es nadie para ORCA hasta
   * que `claude agents --json` lo lista y su transcript aparece. Quien lanzó a
   * un líder necesita ese id para lanzarle miembros, así que aquí se paga la
   * espera una vez en lugar de obligar a la consola a sondear.
   *
   * Se refresca la liveness en cada vuelta: sin eso estaríamos esperando a un
   * mapa que sólo se actualiza cada LIVENESS_MS y la espera duraría siempre lo
   * mismo, gane quien gane.
   */
  private async awaitSpawn(want: SpawnLookup, timeoutMs: number): Promise<AgentHandle | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const hit = this.findSpawned(want);
      if (hit) return hit;
      if (Date.now() >= deadline) return null;
      await sleep(250);
      await this.pollLiveness();
      await this.watcher.refresh();
      await this.codexWatcher?.refresh();
    }
  }

  /**
   * La sesión recién nacida, si ya se ve.
   *
   * Con short id es exacto: el CLI lo imprimió y la liveness lo empareja con su
   * sessionId. Sin él —un spawn en primer plano no imprime ninguno— se cae a
   * "la sesión raíz más nueva de ese proyecto que no existía antes de lanzar",
   * que es cierto porque `since` se toma justo antes del `spawn()`.
   */
  private findSpawned(want: SpawnLookup): AgentHandle | null {
    if (want.sessionId) {
      // ORCA eligió el id: o está, o todavía no escribió su transcript.
      const d = this.derivers.get(want.sessionId);
      return d ? this.handleOf(d) : null;
    }
    if (want.shortId) {
      for (const [sessionId, l] of this.liveness) {
        if (l.shortId !== want.shortId) continue;
        const d = this.derivers.get(sessionId);
        if (d) return this.handleOf(d);
      }
      return null;
    }
    let best: Deriver | null = null;
    const runtime = want.runtime ?? 'claude';
    for (const d of this.derivers.values()) {
      // Sólo sesiones raíz: un subagente no es lo que acabamos de lanzar.
      if (d.ref.metaPath !== null) continue;
      if (d.runtime !== runtime) continue;
      if (d.projectId !== want.projectId) continue;
      if (d.firstSeenAt < want.since) continue;
      if (!best || d.firstSeenAt > best.firstSeenAt) best = d;
    }
    return best ? this.handleOf(best) : null;
  }

  /* ── websocket ────────────────────────────────────────────────── */

  private hubUrl(): string {
    const base = process.env['ORCA_HUB_URL'] ?? 'ws://127.0.0.1:4479';
    return base.endsWith(PATHS.collector) ? base : base.replace(/\/$/, '') + PATHS.collector;
  }

  private connect(): void {
    if (this.stopping || this.ws) return;
    const url = this.hubUrl();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 8000 });
    } catch (err) {
      log('debug', SCOPE, `no pude abrir el socket: ${errText(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.helloSent = false;

    ws.on('open', () => {
      this.connected = true;
      this.backoff = RECONNECT_MIN_MS;
      log('info', SCOPE, `conectado al hub en ${url}`);
      this.sendHello();
      this.sendSnapshot();
      this.sendKeys();
      // El mando arranca cuando hay hub: sus herramientas son el servidor MCP
      // del hub, así que lanzarlo antes es lanzarlo manco.
      void this.capcom?.ensure();
    });
    ws.on('message', (raw) => { void this.onFrame(raw.toString()); });
    ws.on('error', (err) => {
      // Con el hub caído esto ocurre cada pocos segundos: no es ruido de warn.
      log('debug', SCOPE, `socket: ${errText(err)}`);
    });
    ws.on('close', () => {
      const was = this.connected;
      this.connected = false;
      this.ws = null;
      // Sin hub no hay consola mirando: se sueltan los ptys, los panes siguen.
      this.terms.closeAll('hub link lost');
      if (was) log('warn', SCOPE, 'hub desconectado, reintentando');
      this.scheduleReconnect();
    });
  }

  /** Backoff exponencial 1s→30s con jitter, para no sincronizar toda la flota. */
  private scheduleReconnect(): void {
    if (this.stopping) return;
    const jitter = Math.random() * this.backoff * 0.3;
    const wait = Math.min(RECONNECT_MAX_MS, this.backoff) + jitter;
    const t = setTimeout(() => this.connect(), wait);
    t.unref?.();
    this.backoff = Math.min(RECONNECT_MAX_MS, Math.round(this.backoff * 1.8));
    log('debug', SCOPE, `reintento en ${Math.round(wait)}ms`);
  }

  private send(frame: CollectorFrame): void {
    // Sin hub no encolamos: al reconectar mandamos un snapshot, que es una
    // verdad más nueva que cualquier cola de patches viejos.
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.helloSent && frame.t !== 'hello') return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      log('debug', SCOPE, `envío falló: ${errText(err)}`);
    }
  }

  private sendHello(): void {
    const frame: CollectorFrame = {
      t: 'hello', v: PROTOCOL_VERSION, machine: this.machine(),
      token: sharedToken(),
    };
    try {
      this.ws?.send(JSON.stringify(frame));
      this.helloSent = true;
    } catch (err) {
      log('debug', SCOPE, `hello falló: ${errText(err)}`);
    }
  }

  private sendSnapshot(): void {
    const now = Date.now();
    const agents = [...this.derivers.values()].map((d) => this.markHidden({ ...d.snapshot(now), ...this.runner.workers.snapshotState(d.id), modelControl: this.runner.models.state(this.handleOf(d)), resetControl: this.runner.reset.state(this.handleOf(d)) }, d.id));
    for (const a of agents) this.sent.set(a.id, a);
    const projects = this.projects.all();
    for (const p of projects) this.sentProjects.set(p.id, JSON.stringify(p));
    this.send({
      t: 'snapshot', machineId: this.machineId, projects, agents, keys: this.keys.list(),
    });
    const handoff = this.capcom?.handoff(this.machineId);
    if (handoff) this.send({ t: 'capcom:handoff', machineId: this.machineId, event: handoff });
    for (const e of this.escalations.list()) {
      this.send({ t: 'escalation', machineId: this.machineId, escalation: e });
    }
    // Los prompts de pantalla también son estado: el primer poll corre antes
    // de conectar, y un diálogo visto entonces se perdería sin esto.
    for (const p of this.screenPrompts.values()) {
      this.send({ t: 'escalation', machineId: this.machineId, escalation: p.escalation });
    }
    // Un `ask` abierto y una colisión viva son estado, no eventos: si el hub se
    // reinició, no se enteraría de ellos hasta que cambiaran.
    for (const m of this.messages.list()) {
      this.send({ t: 'message', machineId: this.machineId, message: m });
    }
    for (const c of this.collisions.list()) {
      this.send({ t: 'collision', machineId: this.machineId, collision: c });
    }
    for (const a of this.artifacts.list()) {
      this.send({ t: 'artifact', machineId: this.machineId, artifact: a });
    }
    for (const [agentId, items] of this.talkSent) {
      if (items.length > 0) this.send({ t: 'talk', machineId: this.machineId, agentId, items });
    }
    if (this.feed.length > 0) {
      this.send({ t: 'feed', machineId: this.machineId, items: this.feed.slice(-50) });
    }
  }

  private sendKeys(): void {
    // Los descriptores viajan dentro del snapshot; un cambio de keys es raro y
    // barato de reenviar entero.
    this.send({
      t: 'snapshot', machineId: this.machineId,
      projects: this.projects.all(),
      agents: [...this.derivers.values()].map((d) => this.markHidden({ ...d.snapshot(), ...this.runner.workers.snapshotState(d.id), modelControl: this.runner.models.state(this.handleOf(d)), resetControl: this.runner.reset.state(this.handleOf(d)) }, d.id)),
      keys: this.keys.list(),
    });
  }

  private beat(): void {
    this.send({
      t: 'beat', machineId: this.machineId, at: Date.now(), load: this.load(),
    });
  }

  private async onFrame(text: string): Promise<void> {
    const frame = safeJson<CommandFrame>(text);
    if (frame && frame.t === 'hygiene:sample') {
      // No ack: the report itself is the reply, on the same channel.
      void this.sampleHygiene({ force: frame.force === true });
      return;
    }
    if (frame && frame.t === 'restart') {
      /*
       * El operador pidió el relevo desde la consola.
       *
       * Decide este proceso, no el hub: sin un supervisor que lo relance, un
       * collector que se apaga deja esta máquina fuera de la flota y sin nadie
       * que la devuelva. Con supervisor, salir ES el reinicio. Los agentes no
       * se tocan: viven en tmux, no dentro de este proceso, y siguen
       * trabajando mientras el collector vuelve. Ver shared/restart.ts.
       */
      if (!isSupervised()) {
        log('warn', SCOPE, 'el hub pidió relevo, pero aquí no hay supervisor que relance: se ignora');
        return;
      }
      log('info', SCOPE, 'relevo pedido desde la consola: cerrando para volver con el código nuevo');
      this.stop();
      // `exitForRestart` y no un exit a secas: hay que dejar que salga lo
      // último por el cable SIN que el proceso se escape con un 0 mientras
      // tanto, que es lo que el supervisor lee como «no lo relances».
      exitForRestart();
      return;
    }
    if (frame && frame.t === 'improve:ack') {
      // El recibo de un informe de AUTOMEJORA. La ruta la teníamos aquí; el
      // hub sólo dijo a cuál. Un id que no conocemos se ignora en silencio: o
      // es de otro collector, o de antes de este reinicio.
      const file = this.improveAcks.get(frame.reportId);
      if (file) {
        this.improveAcks.delete(frame.reportId);
        const { reportId: _ignored, t: _t, ...body } = frame;
        void this.improveDrops.ack(file, body as ImproveAck);
      }
      return;
    }
    if (frame && typeof frame.t === 'string' && frame.t.startsWith('term:')) {
      // Una terminal no es un comando: no hay ack, hay un flujo mientras dure.
      this.terms.handle(frame as TermFrame);
      return;
    }
    if (!frame || frame.t !== 'cmd' || typeof frame.id !== 'string') {
      log('debug', SCOPE, 'frame entrante ignorado');
      return;
    }
    const cmd = frame.cmd as Command;
    if (!isRecord(cmd) || typeof cmd.k !== 'string') {
      this.send({ t: 'ack', cmdId: frame.id, ok: false, detail: 'comando malformado' });
      return;
    }
    log('info', SCOPE, `cmd ${cmd.k} (${frame.id})`);
    if (cmd.k === 'say' && this.capcom) {
      const a = this.sent.get(cmd.agentId);
      if (a?.role === 'capcom' || this.capcom.owns(cmd.agentId) || this.capcom.owns(a?.shortId ?? null)) this.lastCapcomSayAt = Date.now();
    }
    const res = await this.runner.execute(cmd);
    this.send({
      t: 'ack', cmdId: frame.id, ok: res.ok,
      ...(res.detail ? { detail: res.detail } : {}),
      ...(res.data !== undefined ? { data: res.data } : {}),
    });
    this.note(res.ok ? 'info' : 'warn',
      `${cmd.k}: ${res.ok ? 'ok' : (res.detail ?? 'falló')}`);
  }

  /* ── máquina ──────────────────────────────────────────────────── */

  private machine(): Machine {
    return {
      id: this.machineId,
      hostname: this.machineName,
      platform: process.platform,
      version: COLLECTOR_VERSION,
      online: true,
      lastSeen: Date.now(),
      connectedAt: this.connectedAt,
      load: this.load(),
    };
  }

  /**
   * Take a hygiene sample and file it.
   *
   * Cached inside the sampler, so the ten-minute clock and a panel asking at
   * the same moment cost one walk between them. A failure here is a note, not
   * an outage: hygiene is an observation, and a collector that cannot stat a
   * directory still has a fleet to watch.
   */
  private async sampleHygiene(opts: { force?: boolean } = {}): Promise<void> {
    try {
      this.hygieneSampler ??= new HygieneSampler({
        machineId: this.machineId,
        hostname: this.machineName,
        processes: () => this.hygieneProcesses(),
      });
      const report = await this.hygieneSampler.sample(opts);
      /*
       * Los restos viajan con la higiene: es la misma pregunta —qué está
       * costando ORCA aquí— medida en procesos en vez de en bytes, y así
       * comparten reloj lento, frame y panel. Un fallo del escáner no puede
       * tumbar la muestra de disco: se anota como límite y se sigue.
       */
      try { report.strays = await this.strays.scan(); }
      catch (err) { report.limits.push(`stray scan failed: ${errText(err)}`); }
      this.send({ t: 'hygiene', machineId: this.machineId, report });
    } catch (err) {
      log('warn', SCOPE, `higiene: ${errText(err)}`);
    }
  }

  /**
   * The processes worth measuring: this collector, and every agent whose pid
   * liveness already knows. No new discovery — if we had to go looking for
   * processes, the measurement would cost more than the thing it measures.
   */
  /**
   * Lo que el escáner de restos necesita saber de cada sesión.
   *
   * Se le da TODO lo que el collector observa, no sólo lo sospechoso: la
   * decisión de qué es un fantasma vive en `strays.ts`, donde está escrita y
   * probada, y no repartida entre dos ficheros que un día discrepan. Y los
   * pids de los que están vivos son justo lo que impide que el escáner ofrezca
   * matar a un agente de la flota.
   */
  private strayAgents(): AgentView[] {
    const out: AgentView[] = [];
    for (const d of this.derivers.values()) {
      const snap = d.snapshot();
      const l = this.liveness.get(d.ref.sessionId);
      out.push({
        sessionId: d.ref.sessionId,
        callsign: snap.callsign,
        state: d.state(),
        alive: l?.alive ?? false,
        pid: l?.pid ?? null,
        // El NOMBRE del pane, no un booleano: es lo que se puede ir a buscar
        // al servidor de tmux, y sin poder buscarlo no hay prueba de nada.
        pane: l?.pane === true ? paneName(d.ref.sessionId) : null,
        updatedAt: snap.updatedAt,
      });
    }
    return out;
  }

  private hygieneProcesses(): { pid: number; role: 'hub' | 'collector' | 'console' | 'agent' | 'other'; name: string }[] {
    const out: { pid: number; role: 'hub' | 'collector' | 'console' | 'agent' | 'other'; name: string }[] = [
      { pid: process.pid, role: 'collector', name: 'orca-collector' },
    ];
    for (const [sessionId, live] of this.liveness) {
      if (!live.alive || typeof live.pid !== 'number' || live.pid <= 0) continue;
      const d = this.derivers.get(sessionId) ?? [...this.derivers.values()].find((x) => x.ref.sessionId === sessionId);
      out.push({ pid: live.pid, role: 'agent', name: d?.snapshot().callsign ?? 'agent' });
      if (out.length >= 48) break;
    }
    return out;
  }

  private load(): Machine['load'] {
    let active = 0;
    for (const d of this.derivers.values()) {
      const s = d.state();
      if (s === 'thinking' || s === 'working' || s === 'booting') active++;
    }
    return {
      sessions: this.derivers.size,
      activeSessions: active,
      cpuPct: this.cpuPct(),
      // Committed memory, not `1 - free/total`: on darwin that fraction is
      // ~97% on an idle machine because everything spare is file cache. Null
      // on the first beat, like cpuPct — see collector/memory.ts.
      memPct: memoryPct(),
    };
  }

  /** CPU por delta entre muestras: os.cpus() da acumulados, no porcentajes. */
  private cpuPct(): number | null {
    const cpus = os.cpus();
    if (!cpus || cpus.length === 0) return null;
    let idle = 0, total = 0;
    for (const c of cpus) {
      idle += c.times.idle;
      total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
    }
    const prev = this.cpuPrev;
    this.cpuPrev = { idle, total };
    if (!prev) return null;
    const dIdle = idle - prev.idle;
    const dTotal = total - prev.total;
    if (dTotal <= 0) return null;
    return Math.round((1 - dIdle / dTotal) * 1000) / 10;
  }

  /* ── diagnóstico contra transcripts reales ────────────────────── */

  private async diagnose(): Promise<void> {
    // Damos tiempo a que el descubrimiento y las lecturas de cola terminen. En
    // esta máquina son 539 transcripts y 2.8GB; 4s no alcanzaban.
    await sleep(Number(process.env['ORCA_DIAG_WAIT_MS'] ?? 15_000));
    await this.projects.refreshGit();
    const now = Date.now();

    const inputs = [...this.derivers.values()].map((d) => ({
      key: d.id, sessionId: d.ref.sessionId, agentId: d.ref.agentId,
      metaPath: d.ref.metaPath, shortId: this.liveness.get(d.ref.sessionId)?.shortId ?? null,
    }));
    const tree = this.lineage.resolve(inputs);
    for (const d of this.derivers.values()) {
      const l = this.liveness.get(d.ref.sessionId);
      d.setLiveness(l ?? {
        alive: false, background: false, shortId: null, pid: null,
        name: null, startedAt: null, cliState: null, pane: false,
      });
      const lin = tree.get(d.id);
      if (lin) d.setLineage(lin);
    }

    const agents = [...this.derivers.values()].map((d) => d.snapshot(now));
    const states = new Map<string, number>();
    for (const a of agents) states.set(a.state, (states.get(a.state) ?? 0) + 1);
    for (const p of this.projects.all()) {
      const mine = agents.filter((a) => a.projectId === p.id);
      this.projects.setSessions(p.id, mine.map((a) => a.id).sort(), rollup(mine));
    }

    console.log('\n══ ORCA collector · diagnóstico contra transcripts reales ══\n');
    console.log(`máquina    ${this.machineName} (${this.machineId.slice(0, 8)}) ${process.platform}`);
    console.log(`proyectos  ${this.projects.all().length}`);
    console.log(`agentes    ${agents.length}`);
    console.log(`estados    ${[...states].map(([s, n]) => `${s}=${n}`).join('  ')}`);
    console.log(`vivos CLI  ${this.liveness.size} sesiones reportadas por \`claude agents --json\``);
    const withParent = agents.filter((a) => a.parentId).length;
    console.log(`linaje     ${withParent} con padre, profundidad máx ${Math.max(0, ...agents.map((a) => a.depth))}`);
    const used = agents.reduce((s, a) => s + ceilingTokens(a.metrics), 0);
    console.log(`uso        ${used} tokens de techo acumulados (entrada + salida + escritura de caché)\n`);

    console.log('── proyectos ──');
    for (const p of this.projects.all().slice(0, 20)) {
      const ok = fs.existsSync(p.path) ? '✓' : '✗';
      console.log(
        `  ${p.code}  ${ok} ${p.name.padEnd(22)} ${(p.gitBranch ?? '-').padEnd(16)}`
        + `${p.gitDirty ? 'dirty' : 'clean'}  ${p.sessionIds.length} ses  ${p.path}`,
      );
    }

    console.log('\n── 25 agentes más recientes ──');
    const recent = [...agents].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 25);
    for (const a of recent) {
      const p = this.projects.get(a.projectId);
      const m = a.metrics;
      console.log(
        `  ${a.callsign} ${(p?.code ?? '--')} ${a.state.padEnd(8)} `
        + `d${a.depth} tps=${m.tokensPerSec.toFixed(1).padStart(6)} `
        + `out=${String(m.outputTokens).padStart(8)} use=${String(ceilingTokens(m)).padStart(9)} `
        + `tools=${String(m.toolCalls).padStart(4)} turns=${String(m.turns).padStart(3)} `
        + `up=${fmtDur(a.uptimeMs)}  ${oneLine(a.title, 46)}`,
      );
      if (a.tool) console.log(`        ↳ ${a.tool}: ${oneLine(a.toolDetail ?? '', 90)}`);
      if (a.block) console.log(`        ⚠ ${a.block.kind}: ${oneLine(a.block.summary, 90)}`);
    }

    // Chequeos de sanidad: son aserciones, no adornos.
    console.log('\n── sanidad ──');
    const problems: string[] = [];
    for (const a of agents) {
      if (a.uptimeMs < 0) problems.push(`${a.id} uptime negativo`);
      if (a.metrics.tokensPerSec < 0) problems.push(`${a.id} tps negativo`);
      if (a.metrics.tokensPerSec > 5000) problems.push(`${a.id} tps absurdo ${a.metrics.tokensPerSec}`);
      if (a.state === 'working' && !a.tool) problems.push(`${a.id} working sin tool`);
      if (a.depth > 0 && !a.parentId) problems.push(`${a.id} depth>0 sin padre`);
      if (a.callsign.length !== 2) problems.push(`${a.id} callsign inválido`);
    }
    const seen = new Map<string, string>();
    for (const a of agents) {
      const k = `${a.projectId}/${a.callsign}`;
      const other = seen.get(k);
      if (other) problems.push(`callsign duplicado ${k}: ${other} y ${a.id}`);
      seen.set(k, a.id);
    }
    if (problems.length === 0) console.log('  ✓ sin anomalías en el estado derivado');
    else for (const p of problems.slice(0, 20)) console.log(`  ✗ ${p}`);
    console.log('');
    this.stop();
    // Salida explícita: puede quedar I/O de fondo en vuelo (el rastreo de
    // cost-state, un `claude agents` a medias) y el diagnóstico ya terminó.
    process.exit(problems.length === 0 ? 0 : 1);
  }
}

/* ── helpers de módulo ────────────────────────────────────────────── */

/**
 * El CLI dice de sí mismo que espera una respuesta, en el título de su pane.
 *
 * Codex escribe el título del terminal con OSC, y uno de los elementos que
 * pinta —`activity`, en `[tui].terminal_title`— es literalmente «spinner
 * mientras trabaja, mensaje de acción requerida mientras está bloqueado».
 * Medido el 2026-09-07 contra codex-cli 0.153.4 en un tmux aislado:
 *
 *   Ready | proyecto                    fin de turno, nada pendiente
 *   ⠸ Working | proyecto                turno abierto
 *   [ ! ] Action Required | proyecto    esperando una respuesta   (parpadea a `[ . ]`)
 *
 * Es la mejor señal que hay para esto, y por eso va delante del parón: no es
 * una deducción de ORCA sobre una pantalla, es el CLI declarando su estado. No
 * dice QUÉ pregunta —para eso está `promptOn`, que sabe además qué tecla
 * mandar—, así que el bloqueo no trae opciones: trae dónde contestarlo.
 *
 * Los spawns fuerzan el elemento en el argv (ver `codexArgv`) para no depender
 * de lo que tenga el `config.toml` del operador. Si aun así no aparece —una
 * sesión adoptada, una versión que lo renombre— queda el parón detrás.
 *
 * Claude Code está sin medir: escribe título, pero no se ha comprobado que
 * marque nada al pedir permiso. Hasta comprobarlo, para Claude manda `promptOn`
 * y detrás el parón, que es lo que ya había.
 */
export function titleSignal(title: string, now: number): BlockSignal | null {
  if (!/\bAction Required\b/i.test(title)) return null;
  return {
    kind: 'permission',
    summary: 'the CLI reports it is waiting for an answer; open its terminal to see what it asks',
    since: now,
  };
}

/** Con qué empieza el resumen de un diálogo nativo. Lo lee el propio poll. */
export const NATIVE_DIALOG_MARK = 'native dialog waiting';

/**
 * Un diálogo del CLI que ORCA reconoce pero no puede contestar.
 *
 * Es lo contrario de `stallSignal`, y por eso son dos funciones: allí no se
 * sabe nada y se dice que no se sabe; aquí se ha LEÍDO la pregunta y hay que
 * decirla, con el comando exacto para ir a contestarla. Un bloqueo que dice
 * «nada se ha pintado en 20 s» manda al operador a adivinar; éste le da las
 * dos cosas que necesita y ninguna más.
 *
 * El comando lleva su socket porque las sesiones de ORCA no viven en el de
 * por defecto: `tmux ls` a secas contesta «no server running» (ver
 * `attachHint`). Ese detalle costó parte de los 25 minutos del 2026-09-08.
 */
export function nativeDialogSignal(question: string, attach: string, since: number): BlockSignal {
  return {
    kind: 'input',
    summary: `${NATIVE_DIALOG_MARK}: "${oneLine(question, 140)}" — nobody can answer it from ORCA; answer it in its terminal: ${attach}`,
    since,
  };
}

/**
 * Nadie pinta nada y el turno sigue abierto: el agente espera a alguien.
 *
 * Es el respaldo de `promptOn`, y existe porque un diálogo que ORCA no sabe
 * leer —una redacción nueva, una herramienta MCP con otros campos que los de la
 * fixture— no puede acabar en silencio. Aquí no se afirma QUÉ se pregunta: sólo
 * que la sesión está parada y que la respuesta está en su terminal. Por eso el
 * bloqueo es `input` y no `permission`: decir «permiso» sería inventarse la
 * causa, y ya se inventó una vez.
 *
 * Un `Bash` de diez minutos no cae aquí: las dos CLIs animan spinner, segundos
 * y tokens mientras un comando corre, así que su pantalla cambia y `stillMs`
 * vuelve a cero. Lo que no cambia es una TUI esperando una tecla.
 *
 * Sólo cuenta con el turno abierto. Un agente `idle` también tiene la pantalla
 * quieta, y eso ya se llama idle: no es un bloqueo y no debe despertar a nadie.
 */
export function stallSignal(state: AgentState, stillMs: number, now: number, thresholdMs = STALL_MS): BlockSignal | null {
  if (stillMs < thresholdMs) return null;
  if (state !== 'working' && state !== 'thinking') return null;
  return {
    kind: 'input',
    summary: `waiting on its terminal: nothing has been painted for ${Math.round(stillMs / 1000)}s with a turn open`,
    since: now - stillMs,
  };
}

/** Compara dos snapshots y devuelve sólo lo que cambió de verdad. */
export function diffAgent(prev: Agent, next: Agent): Partial<Agent> | null {
  const patch: Partial<Agent> = {};
  let any = false;
  const set = <K extends keyof Agent>(k: K): void => {
    patch[k] = next[k]; any = true;
  };

  for (const k of ['state', 'title', 'callsign', 'model', 'tool', 'toolDetail',
    'lastPrompt', 'lastSay', 'mission', 'squad', 'lead', 'role', 'origin', 'hidden', 'workspace', 'parentId', 'depth',
    // `pane` llega tarde: el transcript aparece antes de que tmux liste el
    // pane, así que sin diffearlo el hub se queda con `false` para siempre y
    // TERMINAL dice "no pane" sobre un agente que sí lo tiene.
    'background', 'shortId', 'pane', 'projectId'] as const) {
    if (prev[k] !== next[k]) set(k);
  }
  // `lastReport` es el mismo hecho que `lastSay` sin recortar, y el hub lo usa
  // para escribir en la misión: van juntos o no van. Separados, un frame que
  // trae la línea nueva y deja el informe viejo hace que la misión guarde el
  // informe del turno anterior debajo del titular del actual.
  if (prev.lastReport !== next.lastReport || 'lastSay' in patch) set('lastReport');
  if (JSON.stringify(prev.block) !== JSON.stringify(next.block)) set('block');
  if (JSON.stringify(prev.continuation) !== JSON.stringify(next.continuation)) set('continuation');
  if (JSON.stringify(prev.modelControl) !== JSON.stringify(next.modelControl)) set('modelControl');
  if (JSON.stringify(prev.resetControl) !== JSON.stringify(next.resetControl)) set('resetControl');
  if (JSON.stringify(prev.childIds) !== JSON.stringify(next.childIds)) set('childIds');

  // Las métricas se mandan sólo cuando se mueven de forma perceptible: uptimeMs
  // cambia en cada tick y no queremos 2 frames por segundo por agente muerto.
  const pm = prev.metrics, nm = next.metrics;
  const metricsMoved =
    pm.outputTokens !== nm.outputTokens || pm.inputTokens !== nm.inputTokens
    || pm.toolCalls !== nm.toolCalls || pm.turns !== nm.turns
    || pm.costUSD !== nm.costUSD || pm.linesAdded !== nm.linesAdded
    || pm.linesRemoved !== nm.linesRemoved
    || Math.abs(pm.tokensPerSec - nm.tokensPerSec) >= 0.5;
  if (metricsMoved) set('metrics');

  if (!any) return null;
  patch.updatedAt = next.updatedAt;
  patch.uptimeMs = next.uptimeMs;
  return patch;
}

export function rollup(agents: Agent[]): SessionRollup {
  const r = emptyRollup();
  for (const a of agents) {
    r.total++;
    r.byState[a.state]++;
    r.tokens += ceilingTokens(a.metrics);
    r.tokensPerSec += a.metrics.tokensPerSec;
    if (a.state === 'blocked') r.blocked++;
  }
  r.tokens = Math.round(r.tokens);
  // El rollup alimenta un mosaico, no la escena 3D: décimas de token/s sólo
  // servirían para reenviar el proyecto entero varias veces por segundo.
  r.tokensPerSec = Math.round(r.tokensPerSec);
  return r;
}

/** `claude agents --json`. Si el CLI no está o cambia de formato: lista vacía. */
/** El cwd del `session_meta` (o de un `turn_context`) en un lote de Codex. */
function cwdFromCodexLines(lines: Record<string, unknown>[]): string | null {
  for (const line of lines) {
    const t = line['type'];
    if (t !== 'session_meta' && t !== 'turn_context') continue;
    const p = isRecord(line['payload']) ? line['payload'] : null;
    const cwd = p ? str(p['cwd']) : null;
    if (cwd) return cwd;
  }
  return null;
}

function claudeAgentsJson(): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const bin = process.env['ORCA_CLAUDE_BIN'] ?? 'claude';
    let settled = false;
    const done = (v: Record<string, unknown>[]): void => {
      if (!settled) { settled = true; resolve(v); }
    };
    try {
      const child = execFile(bin, ['agents', '--json'], {
        timeout: 15_000, maxBuffer: 8 * 1024 * 1024, shell: false,
      }, (err, stdout) => {
        if (err) { log('debug', SCOPE, `claude agents falló: ${errText(err)}`); done([]); return; }
        const parsed = safeJson<unknown>(stdout);
        if (!Array.isArray(parsed)) { done([]); return; }
        done(parsed.filter(isRecord));
      });
      child.on('error', () => done([]));
    } catch {
      done([]);
    }
  });
}

/** ~/.claude/jobs/<shortId>/state.json: el propio agente background se declara. */
function readJobBlock(shortId: string): BlockSignal | null {
  const file = path.join(claudeJobsDir(), shortId, 'state.json');
  const text = guard(SCOPE, `leer job ${shortId}`,
    () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''), '');
  const obj = safeJson<Record<string, unknown>>(text);
  if (!obj) return null;
  if (str(obj['state']) !== 'blocked') return null;
  const needs = str(obj['needs']) ?? str(obj['detail']) ?? 'necesita al humano';
  let since = Date.now();
  try { since = fs.statSync(file).mtimeMs; } catch { /* ok */ }
  return { kind: 'input', summary: oneLine(needs, 200), since };
}

/** Las dos últimas partes de una ruta: en el HUD lo demás no cabe ni importa. */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/* ── main ─────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const diag = process.env['ORCA_DIAG'] === '1' || process.argv.includes('--diag');
  const collector = new Collector({ capcom: wantsCapcom() });

  // Un throw suelto en un callback de fs no puede matar la observabilidad.
  process.on('uncaughtException', (err) => {
    log('error', SCOPE, `excepción no capturada, sigo vivo: ${errText(err)}`);
  });
  process.on('unhandledRejection', (err) => {
    log('error', SCOPE, `promesa rechazada, sigo vivo: ${errText(err)}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { collector.stop(); process.exit(0); });
  }

  await collector.start(diag);
}

// Sólo corre como entrypoint; importarlo desde los tests no arranca nada.
const invoked = process.argv[1] ?? '';
if (invoked.endsWith('collector/index.ts') || invoked.endsWith('collector/index.js')) {
  void main();
}

export { Collector };
