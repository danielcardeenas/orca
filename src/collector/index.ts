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
  Agent, Escalation, FeedItem, FeedLevel, Machine, Project, SessionRollup,
} from '../shared/types.ts';
import { emptyRollup } from '../shared/types.ts';
import type { AgentHandle } from './commands.ts';
import { CommandRunner } from './commands.ts';
import type { BlockSignal, Liveness } from './derive.ts';
import { CallsignBook, SessionDeriver } from './derive.ts';
import { EscalationWatcher } from './escalate.ts';
import { KeyVault } from './keys.ts';
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
const GIT_MS = 15_000;
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
  private readonly runner: CommandRunner;

  private derivers = new Map<string, SessionDeriver>();
  private sent = new Map<string, Agent>();
  private sentProjects = new Map<string, string>(); // id → JSON de lo enviado
  private liveness = new Map<string, Liveness>();   // sessionId → liveness
  private jobStates = new Map<string, BlockSignal>(); // sessionId → bloqueo del job
  private feed: FeedItem[] = [];
  private pendingFeed: FeedItem[] = [];
  private escalationBySession = new Map<string, Escalation>();

  private ws: WebSocket | null = null;
  private connected = false;
  private helloSent = false;
  private backoff = RECONNECT_MIN_MS;
  private stopping = false;
  private timers: NodeJS.Timeout[] = [];
  private cpuPrev: { idle: number; total: number } | null = null;

  constructor() {
    const ident = machineIdentity();
    this.machineId = ident.id;
    this.machineName = ident.name;
    this.projects = new ProjectRegistry(this.machineId);
    this.escalations = new EscalationWatcher({
      machineId: this.machineId,
      resolveAgent: (projectId, hint) => this.resolveAgent(projectId, hint),
    });
    this.runner = new CommandRunner({
      projects: this.projects,
      keys: this.keys,
      lineage: this.lineage,
      escalations: this.escalations,
      agent: (id) => this.agentHandle(id),
      onResync: () => { this.sent.clear(); this.sentProjects.clear(); this.sendSnapshot(); },
      onKeysChanged: () => this.sendKeys(),
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
    try { this.ws?.close(); } catch { /* ya cerrado */ }
  }

  /* ── ingesta ──────────────────────────────────────────────────── */

  private onLines(batch: LineBatch): void {
    const d = this.deriverFor(batch.ref);
    d.ingest(batch);
    this.lineage.ingest(batch);
    if (d.cwd) {
      const p = this.projects.ensure(batch.ref.slug, d.cwd);
      d.setProject(p.id);
      this.escalations.track(p.id, p.path);
    }
  }

  private onGone(ref: TranscriptRef): void {
    const d = this.derivers.get(ref.key);
    if (!d) return;
    this.derivers.delete(ref.key);
    this.callsigns.release(d.projectId, ref.key);
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
    this.escalations.reapExpired(now);

    // 1. señales externas dentro de cada deriver
    const inputs = [] as { key: string; sessionId: string; agentId: string | null;
      metaPath: string | null; shortId: string | null }[];
    for (const d of this.derivers.values()) {
      const l = this.liveness.get(d.ref.sessionId);
      d.setLiveness(l ?? {
        alive: false, background: false, shortId: null, pid: null,
        name: null, startedAt: null, cliState: null,
      });
      const esc = this.escalationBySession.get(d.id);
      if (esc) {
        d.setBlock({
          kind: 'question', summary: oneLine(esc.question, 160),
          escalationId: esc.id, since: esc.askedAt,
        });
      } else {
        d.setBlock(this.jobStates.get(d.ref.sessionId) ?? null);
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
    const byProject = new Map<string, Agent[]>();
    for (const d of this.derivers.values()) {
      const snap = d.snapshot(now);
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
    }

    // 5. feed
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

  private agentHandle(id: string): AgentHandle | null {
    const d = this.derivers.get(id);
    if (!d) return null;
    const l = this.liveness.get(d.ref.sessionId);
    return {
      id: d.id,
      projectId: d.projectId,
      sessionId: d.ref.sessionId,
      shortId: l?.shortId ?? null,
      background: l?.background ?? false,
      alive: l?.alive ?? false,
    };
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
    'lastPrompt', 'lastSay', 'mission', 'parentId', 'depth', 'background',
    'shortId', 'projectId'] as const) {
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
  const collector = new Collector();

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
