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
 *   ORCA_CAPCOM=1      esta máquina lleva CAPCOM (igual que `--capcom`).
 *                      SÓLO UNA máquina de la flota debe llevarlo.
 *   ORCA_CAPCOM_DIR    dónde vive esa sesión; por defecto ~/.orca/capcom
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import type { CollectorFrame, Command, CommandFrame } from '../shared/protocol.ts';
import { BEAT_INTERVAL_MS, PATHS, PROTOCOL_VERSION, newId } from '../shared/protocol.ts';
import type {
  Agent, AgentMessage, Artifact, Escalation, FeedItem, FeedLevel, Machine, Project,
  SessionRollup,
} from '../shared/types.ts';
import { TERMINAL_STATES, emptyRollup } from '../shared/types.ts';
import { ArtifactIndex } from './artifacts.ts';
import { CapcomSession } from './capcom.ts';
import type { AgentHandle, SpawnLookup } from './commands.ts';
import { CommandRunner, resolveClaudeBin } from './commands.ts';
import type { BlockSignal, Liveness } from './derive.ts';
import { CallsignBook, SessionDeriver } from './derive.ts';
import type { CollisionAgent } from './collisions.ts';
import { CollisionIndex } from './collisions.ts';
import { EscalationWatcher } from './escalate.ts';
import { KeyVault } from './keys.ts';
import { MessageWatcher } from './messages.ts';
import { SpawnWatcher, planChild, writeAck, type SpawnRequest } from './spawns.ts';
import { LineageIndex } from './lineage.ts';
import { ProjectRegistry } from './projects.ts';
import {
  COLLECTOR_VERSION, claudeJobsDir, errText, guard, isRecord, log, num, oneLine,
  orcaDir, safeJson, sleep, str,
} from './util.ts';
import type { LineBatch, TranscriptRef } from './watch.ts';
import { TranscriptWatcher } from './watch.ts';

const SCOPE = 'collector';

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
  private readonly projects: ProjectRegistry;
  private readonly lineage = new LineageIndex();
  private readonly keys = new KeyVault();
  private readonly callsigns = new CallsignBook();
  private readonly escalations: EscalationWatcher;
  private readonly messages: MessageWatcher;
  private readonly spawns: SpawnWatcher;
  private readonly collisions = new CollisionIndex();
  private readonly artifacts: ArtifactIndex;
  private readonly runner: CommandRunner;
  /** El mando de la flota, cuando esta máquina es la que lo lleva. */
  private capcom: CapcomSession | null = null;

  private derivers = new Map<string, SessionDeriver>();
  private sent = new Map<string, Agent>();
  private sentProjects = new Map<string, string>(); // id → JSON de lo enviado
  private liveness = new Map<string, Liveness>();   // sessionId → liveness
  private jobStates = new Map<string, BlockSignal>(); // sessionId → bloqueo del job
  private feed: FeedItem[] = [];
  private pendingFeed: FeedItem[] = [];
  private escalationBySession = new Map<string, Escalation>();
  private ticks = 0;

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
    this.projects = new ProjectRegistry(this.machineId);
    this.escalations = new EscalationWatcher({
      machineId: this.machineId,
      resolveAgent: (projectId, hint) => this.resolveAgent(projectId, hint),
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
    this.runner = new CommandRunner({
      projects: this.projects,
      keys: this.keys,
      lineage: this.lineage,
      escalations: this.escalations,
      messages: this.messages,
      artifacts: this.artifacts,
      agent: (id) => this.agentHandle(id),
      awaitSpawn: (want, ms) => this.awaitSpawn(want, ms),
      onResync: () => { this.sent.clear(); this.sentProjects.clear(); this.sendSnapshot(); },
      onKeysChanged: () => this.sendKeys(),
      // Se resuelve en cada llamada: `this.capcom` no existe hasta start().
      capcom: {
        owns: (shortId) => this.capcom?.owns(shortId) ?? false,
        launchArgs: () => this.capcom?.launchArgs() ?? [],
        adopt: (shortId) => this.capcom?.adopt(shortId),
      },
    });
  }

  /* ── arranque ─────────────────────────────────────────────────── */

  async start(diag: boolean): Promise<void> {
    this.watcher.onLines((b) => this.onLines(b));
    this.watcher.onGone((r) => this.onGone(r));
    await this.watcher.start();
    await this.pollLiveness();

    if (diag) { await this.diagnose(); return; }

    this.escalations.onOpen((e) => this.onEscalation(e));
    this.escalations.onWithdraw((id, reason) => this.onWithdraw(id, reason));
    this.escalations.start();

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
       * máquina no ve a las otras— así que la regla vive en el README y en el
       * hecho de que arrancarlo es un flag explícito.
       */
      this.capcom = new CapcomSession({
        bin: resolveClaudeBin(),
        hubUrl: this.hubUrl(),
        token: process.env['ORCA_TOKEN'] ?? '',
        lineage: this.lineage,
        alive: (shortId) => this.shortIdAlive(shortId),
        note: (level, text) => this.note(level, text),
      });
      log('info', SCOPE, `CAPCOM habilitado en ${this.capcom.dir}`);
      this.timers.push(setInterval(() => {
        // Sin hub no se relanza: sus herramientas viven en el hub, y un CAPCOM
        // sin tools quema una vuelta para descubrir que no puede hacer nada.
        if (this.connected) this.capcom?.check();
      }, CAPCOM_CHECK_MS));
    }

    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    this.timers.push(setInterval(() => { void this.pollLiveness(); }, LIVENESS_MS));
    this.timers.push(setInterval(() => { void this.projects.refreshGit(); }, GIT_MS));
    this.timers.push(setInterval(() => this.beat(), BEAT_INTERVAL_MS));
    for (const t of this.timers) t.unref?.();

    log('info', SCOPE, `máquina ${this.machineName} (${this.machineId.slice(0, 8)}) lista`);
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.watcher.stop();
    this.escalations.stop();
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
      const p = this.projects.ensure(batch.ref.slug, d.cwd);
      d.setProject(p.id);
      this.escalations.track(p.id, p.path);
      this.messages.track(p.id, p.path);
      this.artifacts.track(p.id, p.path);
      this.spawns.track(p.id, p.path);
    }
  }

  private onGone(ref: TranscriptRef): void {
    const d = this.derivers.get(ref.key);
    if (!d) return;
    this.derivers.delete(ref.key);
    this.callsigns.release(d.projectId, ref.key);
    this.collisions.forget(ref.key);
    // Su `ask` abierto ya no bloquea a nadie: no hay nadie a quien bloquear.
    for (const id of this.messages.forgetAgent(ref.key)) {
      log('info', SCOPE, `mensaje ${id} retirado: su emisor desapareció`);
    }
    this.sent.delete(ref.key);
    this.send({ t: 'agent:gone', machineId: this.machineId, id: ref.key });
    this.note('info', `${ref.key.slice(0, 8)} desapareció del disco`, ref.key);
  }

  private deriverFor(ref: TranscriptRef): SessionDeriver {
    let d = this.derivers.get(ref.key);
    if (d) return d;
    const project = this.projects.ensure(ref.slug);
    d = new SessionDeriver(ref, this.machineId, project.id);
    d.setCallsign(this.callsigns.assign(project.id, ref.key));
    this.derivers.set(ref.key, d);
    this.escalations.track(project.id, project.path);
    this.messages.track(project.id, project.path);
    this.artifacts.track(project.id, project.path);
    this.spawns.track(project.id, project.path);
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
      });
      if (shortId) this.lineage.bind(shortId, sessionId);
    }
    this.liveness = next;

    // Los background publican su propio estado en ~/.claude/jobs/<id>/state.json,
    // que es lo más cercano a "el agente dice que está bloqueado" que existe hoy.
    this.jobStates.clear();
    for (const [sessionId, l] of this.liveness) {
      if (!l.shortId) continue;
      const sig = readJobBlock(l.shortId);
      if (sig) this.jobStates.set(sessionId, sig);
    }
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
    let best: SessionDeriver | null = null;
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

  private tick(): void {
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
        name: null, startedAt: null, cliState: null,
      });
      // Prioridad: humano > par > job. Si un agente espera a las dos cosas, la
      // pregunta al humano es la que nadie más puede desatascar.
      const esc = this.escalationBySession.get(d.id);
      const peer = peers.get(d.id);
      if (esc) {
        d.setBlock({
          kind: 'question', summary: oneLine(esc.question, 160),
          escalationId: esc.id, since: esc.askedAt,
        });
      } else if (peer) {
        d.setBlock({
          kind: 'peer', summary: peer.summary,
          messageId: peer.messageId, waitingOn: peer.waitingOn, since: peer.since,
        });
      } else {
        d.setBlock(this.jobStates.get(d.ref.sessionId) ?? null);
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

    // 3. diffs de agentes
    const all: Agent[] = [];
    const byProject = new Map<string, Agent[]>();
    for (const d of this.derivers.values()) {
      const snap = d.snapshot(now);
      all.push(snap);
      const list = byProject.get(snap.projectId);
      if (list) list.push(snap); else byProject.set(snap.projectId, [snap]);

      const prev = this.sent.get(snap.id);
      if (!prev) {
        this.sent.set(snap.id, snap);
        this.send({ t: 'agent:new', machineId: this.machineId, agent: snap });
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

  /* ── handles para commands.ts ─────────────────────────────────── */

  /** ¿Sigue el CLI listando esa sesión de background? Lo que usa CAPCOM. */
  private shortIdAlive(shortId: string): boolean {
    for (const l of this.liveness.values()) {
      if (l.shortId === shortId && l.alive) return true;
    }
    return false;
  }

  private agentHandle(id: string): AgentHandle | null {
    const d = this.derivers.get(id);
    if (!d) return null;
    return this.handleOf(d);
  }

  private handleOf(d: SessionDeriver): AgentHandle {
    const l = this.liveness.get(d.ref.sessionId);
    return {
      id: d.id,
      projectId: d.projectId,
      sessionId: d.ref.sessionId,
      shortId: l?.shortId ?? null,
      background: l?.background ?? false,
      alive: l?.alive ?? false,
      callsign: d.callsign,
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
    if (want.shortId) {
      for (const [sessionId, l] of this.liveness) {
        if (l.shortId !== want.shortId) continue;
        const d = this.derivers.get(sessionId);
        if (d) return this.handleOf(d);
      }
      return null;
    }
    let best: SessionDeriver | null = null;
    for (const d of this.derivers.values()) {
      // Sólo sesiones raíz: un subagente no es lo que acabamos de lanzar.
      if (d.ref.metaPath !== null) continue;
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
      token: process.env['ORCA_TOKEN'] ?? '',
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
    const agents = [...this.derivers.values()].map((d) => d.snapshot(now));
    for (const a of agents) this.sent.set(a.id, a);
    const projects = this.projects.all();
    for (const p of projects) this.sentProjects.set(p.id, JSON.stringify(p));
    this.send({
      t: 'snapshot', machineId: this.machineId, projects, agents, keys: this.keys.list(),
    });
    for (const e of this.escalations.list()) {
      this.send({ t: 'escalation', machineId: this.machineId, escalation: e });
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
      agents: [...this.derivers.values()].map((d) => d.snapshot()),
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
      memPct: Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10,
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
        name: null, startedAt: null, cliState: null,
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
    const cost = agents.reduce((s, a) => s + a.metrics.costUSD, 0);
    console.log(`costo      $${cost.toFixed(2)} acumulado en los cost-state leídos\n`);

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
        + `out=${String(m.outputTokens).padStart(8)} $${m.costUSD.toFixed(2).padStart(7)} `
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

/** Compara dos snapshots y devuelve sólo lo que cambió de verdad. */
export function diffAgent(prev: Agent, next: Agent): Partial<Agent> | null {
  const patch: Partial<Agent> = {};
  let any = false;
  const set = <K extends keyof Agent>(k: K): void => {
    patch[k] = next[k]; any = true;
  };

  for (const k of ['state', 'title', 'callsign', 'model', 'tool', 'toolDetail',
    'lastPrompt', 'lastSay', 'mission', 'squad', 'lead', 'role', 'parentId', 'depth',
    'background', 'shortId', 'projectId'] as const) {
    if (prev[k] !== next[k]) set(k);
  }
  if (JSON.stringify(prev.block) !== JSON.stringify(next.block)) set('block');
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
    r.costUSD += a.metrics.costUSD;
    r.tokensPerSec += a.metrics.tokensPerSec;
    if (a.state === 'blocked') r.blocked++;
  }
  r.costUSD = Math.round(r.costUSD * 100) / 100;
  // El rollup alimenta un mosaico, no la escena 3D: décimas de token/s sólo
  // servirían para reenviar el proyecto entero varias veces por segundo.
  r.tokensPerSec = Math.round(r.tokensPerSec);
  return r;
}

/** `claude agents --json`. Si el CLI no está o cambia de formato: lista vacía. */
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
  const capcom = process.env['ORCA_CAPCOM'] === '1' || process.argv.includes('--capcom');
  const collector = new Collector({ capcom });

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
