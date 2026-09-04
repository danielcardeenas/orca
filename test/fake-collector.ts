/**
 * ORCA — collector falso.
 *
 * Una flota sintética pero creíble para desarrollar el hub y la consola sin
 * depender del collector real. Levanta 3 máquinas (un Mac, dos Linux), 6
 * proyectos con nombres plausibles y ~20 agentes que de verdad hacen cosas:
 * cambian de estado, ejecutan herramientas reales (Bash, Edit, Read, Task,
 * WebSearch), acumulan costo y tokens/seg en rangos verosímiles, lanzan hijos
 * con `Task`, se bloquean pidiendo permiso y escalan preguntas al humano.
 *
 * Habla el protocolo entero, incluidos los comandos de vuelta: si la consola
 * manda `spawn`, aparece un agente; si manda `answer`, la escalación se cierra
 * y el agente se desbloquea; si manda `stop`, el agente muere. Es la
 * herramienta con la que se desarrolla la UI.
 *
 *   npx tsx test/fake-collector.ts
 *   npx tsx test/fake-collector.ts --chaos
 *   npx tsx test/fake-collector.ts --hub=ws://localhost:4479 --token=... --speed=3
 *
 * Flags:
 *   --hub=<url>     base ws del hub (default ws://localhost:4479)
 *   --token=<t>     token; si falta usa ORCA_TOKEN o ~/.orca/token
 *   --chaos         desconecta y reconecta máquinas al azar
 *   --speed=<n>     multiplicador de ritmo (default 1)
 *   --quiet         menos ruido en stdout
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import type { Agent, Escalation, FeedItem, KeyDescriptor, Machine, Project } from '../src/shared/types.ts';
import { emptyRollup } from '../src/shared/types.ts';
import type { Command, CollectorFrame, CommandFrame } from '../src/shared/protocol.ts';
import { BEAT_INTERVAL_MS, PATHS, PORTS, PROTOCOL_VERSION, newId } from '../src/shared/protocol.ts';

/* ── azar ─────────────────────────────────────────────────────────── */

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const int = (a: number, b: number): number => Math.floor(rnd(a, b + 1));
const chance = (p: number): boolean => Math.random() < p;
function pick<T>(xs: readonly T[]): T {
  const v = xs[Math.floor(Math.random() * xs.length)];
  if (v === undefined) throw new Error('pick sobre lista vacía');
  return v;
}

/* ── material creíble ─────────────────────────────────────────────── */

const TITLES: readonly string[] = [
  'Refactor del pipeline de audio',
  'Fix flaky auth test on CI',
  'Migrar DNS de axolots.com a Cloudflare',
  'Add WebSocket reconnect backoff',
  'Depurar fuga de memoria en el worker de correo',
  'Escribir tests del collector',
  'Portar el hero a WebGL con ribbons',
  'Tune Postgres indexes for the feed query',
  'Quitar dependencias muertas del bundle',
  'Implement escalation memory recall',
  'Revisar contratos del protocolo',
  'Bump three.js and fix EffectComposer',
  'Instrumentar métricas de tokens/seg',
  'Arreglar el 301 de .com a .ai',
  'Draft the incident postmortem',
  'Cachear el snapshot del mundo',
  'Reescribir el parser de transcripts',
  'Harden the hub against garbage frames',
  'Añadir modo caos al fake collector',
  'Investigar por qué el VPS pierde latidos',
  'Auditar claves guardadas por proyecto',
  'Simplificar el coalescing del bus',
];

const MISSIONS: readonly string[] = [
  'Dejar el build verde sin tocar la API pública.',
  'Reduce p95 latency below 120ms.',
  'Encontrar la causa raíz, no un parche.',
  'Migrate without downtime; keep the old path behind a flag.',
  'Cubrir el camino feliz y dos casos de error.',
  'No romper el contrato de src/shared.',
];

const BASH: readonly string[] = [
  'npm run build',
  'git status --porcelain',
  'rg -n "PatchOp" src/ --type ts',
  'npx tsc --noEmit',
  'curl -s localhost:4479/api/health',
  'git log --oneline -12',
  'node --test test/hub.test.ts',
  'pnpm vitest run src/hub',
  'df -h /srv',
  'systemctl status axolots-mail --no-pager',
  'wrangler deploy --dry-run',
  'psql -c "select count(*) from sessions"',
];

const FILES: readonly string[] = [
  'src/hub/world.ts', 'src/hub/bus.ts', 'src/hub/server.ts', 'src/shared/protocol.ts',
  'src/ui/scene/ribbon.ts', 'src/collector/transcript.ts', 'worker/index.ts',
  'src/components/a/Hero.astro', 'test/fake-collector.ts', 'docs/CONTRACT-REQUESTS.md',
  'src/lib/audio.ts', 'migrations/0007_add_feed_index.sql',
];

const SEARCHES: readonly string[] = [
  'cloudflare durable object websocket hibernation limits',
  'ws backpressure bufferedAmount node',
  'three.js instanced mesh dynamic count',
  'postgres partial index jsonb null',
  'claude code hooks SessionStart',
  'dkim selector google workspace cloudflare',
];

const SAYS: readonly string[] = [
  'Encontré el problema: el bus no cancelaba el timer al parar.',
  'Running the suite now, three files changed.',
  'El índice parcial baja la consulta de 400ms a 12ms.',
  'I need to check how the collector handles a partial transcript line.',
  'Listo, build verde. Voy a por el segundo caso.',
  'Hmm, that test is flaky because of the 100ms window. Widening it.',
  'Renombré la función; nada más la usaba.',
  'Reverting — the migration locks the table for too long.',
  'Dejo la rama lista para revisión.',
];

const QUESTIONS: readonly {
  q: string; ctx: string; options: string[]; urgency: Escalation['urgency'];
}[] = [
  {
    q: '¿Puedo borrar la rama legacy/hero-v1 del remoto?',
    ctx: 'Nadie la ha tocado en 4 meses y el hero nuevo ya está en main.',
    options: ['Sí, bórrala', 'No, archívala primero', 'Déjala'],
    urgency: 'normal',
  },
  {
    q: 'Which database should the migration target?',
    ctx: 'Both orca_staging and orca_prod accept the DDL. The runbook does not say.',
    options: ['orca_staging', 'orca_prod', 'ninguna, para'],
    urgency: 'blocking',
  },
  {
    q: 'El test de pago falla contra el sandbox. ¿Uso la clave de test del proyecto?',
    ctx: 'STRIPE_TEST_KEY está registrada en el proyecto pero nunca se ha usado desde CI.',
    options: ['Sí, úsala', 'No, saltá el test'],
    urgency: 'normal',
  },
  {
    q: 'Should I upgrade three.js to 0.185? EffectComposer has breaking changes.',
    ctx: 'The current pin is 0.179. Two call sites would need edits.',
    options: ['Sube y arregla', 'Quédate en 0.179'],
    urgency: 'low',
  },
  {
    q: '¿Despliego a producción ahora o espero al PR de revisión?',
    ctx: 'El cambio es de una línea en el 301 de axolots.com.',
    options: ['Despliega', 'Espera al PR'],
    urgency: 'blocking',
  },
  {
    q: 'The transcript has a tool_result with no matching tool_use. Skip or fail loudly?',
    ctx: 'Happens ~1 in 4000 lines, probably a truncated write.',
    options: ['Skip and count it', 'Fail loudly'],
    urgency: 'low',
  },
];

const PERMISSIONS: readonly string[] = [
  'Bash(rm -rf node_modules) — borrar dependencias para reinstalar',
  'Bash(git push --force-with-lease origin hero) — reescribir la rama remota',
  'Write(/etc/nginx/sites-enabled/orca) — escribir fuera del proyecto',
  'Bash(psql -c "drop index feed_at_idx") — quitar un índice en producción',
  'WebFetch(https://api.stripe.com/v1/charges) — llamar a una API externa',
];

/* ── topología ────────────────────────────────────────────────────── */

interface MachineSpec {
  id: string;
  hostname: string;
  platform: string;
  projects: { id: string; name: string; code: string; path: string; branch: string; keys: string[] }[];
  agents: number;
}

const FLEET: readonly MachineSpec[] = [
  {
    id: 'mac-cascabel', hostname: 'cascabel.local', platform: 'darwin', agents: 9,
    projects: [
      { id: 'p_axolots', name: 'axolots', code: 'AX', path: '/Users/dan/projects/axolots', branch: 'main', keys: ['FAL_KEY', 'ANTHROPIC_API_KEY'] },
      { id: 'p_orca', name: 'orca', code: 'OR', path: '/Users/dan/projects/axolots/orca', branch: 'hub/world', keys: ['ANTHROPIC_API_KEY'] },
      { id: 'p_lienzo', name: 'lienzo', code: 'LZ', path: '/Users/dan/projects/lienzo', branch: 'main', keys: [] },
    ],
  },
  {
    id: 'vps-fra1', hostname: 'orca-fra1', platform: 'linux', agents: 7,
    projects: [
      { id: 'p_mail', name: 'axolots-mail', code: 'AM', path: '/srv/axolots-mail', branch: 'fase-1', keys: ['GOOGLE_SA_JSON', 'ANTHROPIC_API_KEY'] },
      { id: 'p_telemetria', name: 'telemetria', code: 'TL', path: '/srv/telemetria', branch: 'main', keys: ['CF_API_TOKEN'] },
    ],
  },
  {
    id: 'vps-nue2', hostname: 'glaciar-nue2', platform: 'linux', agents: 4,
    projects: [
      { id: 'p_glaciar', name: 'glaciar', code: 'GL', path: '/opt/glaciar', branch: 'batch-jobs', keys: ['S3_ACCESS_KEY'] },
    ],
  },
];

/* ── una máquina falsa ────────────────────────────────────────────── */

type State = Agent['state'];

interface Local {
  agent: Agent;
  /** ms hasta el próximo cambio de estado. */
  dwell: number;
  /** Escalación abierta, si la hay. */
  escalationId: string | null;
  spawnBudget: number;
}

const CALLSIGN_LETTERS = 'KTZVRNMQXBFJ';

export class FakeMachine {
  readonly spec: MachineSpec;
  private hubUrl: string;
  private token: string;
  private quiet: boolean;
  private speed: number;

  private ws: WebSocket | null = null;
  private machine: Machine;
  private projects: Project[];
  private keys: KeyDescriptor[] = [];
  private agents = new Map<string, Local>();
  private escalations = new Map<string, Escalation>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  private callsignSeq = 0;

  constructor(spec: MachineSpec, opts: { hub: string; token: string; quiet: boolean; speed: number }) {
    this.spec = spec;
    this.hubUrl = opts.hub;
    this.token = opts.token;
    this.quiet = opts.quiet;
    this.speed = opts.speed;

    this.machine = {
      id: spec.id, hostname: spec.hostname, platform: spec.platform,
      version: '0.1.0-fake', online: true, lastSeen: Date.now(), connectedAt: Date.now(),
      load: { sessions: 0, activeSessions: 0, cpuPct: rnd(8, 40), memPct: rnd(30, 70) },
    };

    this.projects = spec.projects.map((p) => ({
      id: p.id, machineId: spec.id, slug: p.path.replace(/\//g, '-'), name: p.name,
      path: p.path, code: p.code, gitBranch: p.branch, gitDirty: chance(0.5),
      keyNames: p.keys, sessionIds: [], rollup: emptyRollup(),
    }));

    for (const p of spec.projects) {
      for (const k of p.keys) {
        this.keys.push({
          name: k, projectId: p.id,
          hint: Math.random().toString(36).slice(2, 6),
          addedAt: Date.now() - int(3, 90) * 86_400_000,
          lastUsedAt: chance(0.6) ? Date.now() - int(1, 900) * 60_000 : null,
          usedBy: [],
        });
      }
    }

    for (let i = 0; i < spec.agents; i++) this.spawn(null, 0);
  }

  private log(...args: unknown[]): void {
    if (!this.quiet) console.log(`[${this.spec.id}]`, ...args);
  }

  /* ── conexión ───────────────────────────────────────────────────── */

  connect(): void {
    if (this.stopped) return;
    const url = `${this.hubUrl}${PATHS.collector}?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.machine.connectedAt = Date.now();
      this.send({ t: 'hello', v: PROTOCOL_VERSION, machine: this.machine, token: this.token });
      this.sendSnapshot();
      this.log('conectado');
    });

    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(data.toString()) as CommandFrame;
        if (frame.t === 'cmd') this.onCommand(frame.id, frame.cmd);
      } catch (err) {
        console.warn(`[${this.spec.id}] comando ilegible`, err);
      }
    });

    ws.on('close', (code) => {
      this.log('desconectado', code);
      this.ws = null;
      if (!this.stopped) setTimeout(() => this.connect(), int(1200, 4000));
    });

    ws.on('error', (err) => {
      if (!this.quiet) console.warn(`[${this.spec.id}] ws:`, (err as Error).message);
    });
  }

  private send(frame: CollectorFrame): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(frame)); } catch { /* se reconectará */ }
  }

  private ack(cmdId: string, ok: boolean, detail: string): void {
    this.send({ t: 'ack', cmdId, ok, detail });
  }

  sendSnapshot(): void {
    this.send({
      t: 'snapshot', machineId: this.spec.id,
      projects: this.projects,
      agents: [...this.agents.values()].map((l) => l.agent),
      keys: this.keys,
    });
  }

  /* ── ciclo de vida ──────────────────────────────────────────────── */

  start(): void {
    this.connect();
    const every = (ms: number, fn: () => void): void => {
      const t = setInterval(fn, Math.max(30, ms / this.speed));
      t.unref?.();
      this.timers.push(t);
    };
    every(BEAT_INTERVAL_MS, () => this.beat());
    every(250, () => this.tick(250));
    every(1800, () => this.emitFeed());
    this.timers.push();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    try { this.ws?.close(1000, 'fin'); } catch { /* da igual */ }
  }

  /** Corta el socket sin avisar: así se ve una máquina caer de verdad. */
  drop(): void {
    this.log('caos: cortando el socket');
    try { this.ws?.terminate(); } catch { /* ya estaba */ }
    this.ws = null;
  }

  reconnect(): void {
    if (this.ws || this.stopped) return;
    this.log('caos: reconectando');
    this.connect();
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private beat(): void {
    const live = [...this.agents.values()].filter((l) => ['thinking', 'working', 'booting'].includes(l.agent.state));
    this.machine.load = {
      sessions: this.agents.size,
      activeSessions: live.length,
      cpuPct: Math.max(2, Math.min(99, (this.machine.load.cpuPct ?? 20) + rnd(-6, 6) + live.length * 0.4)),
      memPct: Math.max(10, Math.min(96, (this.machine.load.memPct ?? 40) + rnd(-2, 2))),
    };
    this.send({ t: 'beat', machineId: this.spec.id, at: Date.now(), load: this.machine.load });
  }

  /* ── agentes ────────────────────────────────────────────────────── */

  private callsign(): string {
    const letter = CALLSIGN_LETTERS[this.callsignSeq % CALLSIGN_LETTERS.length] ?? 'K';
    const num = 1 + Math.floor(this.callsignSeq / CALLSIGN_LETTERS.length);
    this.callsignSeq += 1;
    return `${letter}${num}`;
  }

  private spawn(parent: Agent | null, depth: number, projectId?: string, mission?: string): Agent {
    const project = projectId
      ? this.projects.find((p) => p.id === projectId) ?? pick(this.projects)
      : (parent ? this.projects.find((p) => p.id === parent.projectId) ?? pick(this.projects) : pick(this.projects));
    const now = Date.now();
    const agent: Agent = {
      id: newId('sess'),
      machineId: this.spec.id,
      projectId: project.id,
      title: pick(TITLES),
      callsign: this.callsign(),
      state: 'booting',
      block: null,
      parentId: parent?.id ?? null,
      depth,
      childIds: [],
      mission: mission ?? (parent ? `Subtarea: ${pick(TITLES).toLowerCase()}` : pick(MISSIONS)),
      model: pick(['claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5']),
      tool: null,
      toolDetail: null,
      lastPrompt: pick(MISSIONS),
      lastSay: null,
      startedAt: now - int(0, 900_000),
      updatedAt: now,
      uptimeMs: 0,
      metrics: {
        costUSD: rnd(0.01, 1.4), inputTokens: int(2_000, 400_000), outputTokens: int(500, 40_000),
        cacheReadTokens: int(0, 900_000), thinkingTokens: int(0, 12_000), tokensPerSec: 0,
        linesAdded: int(0, 600), linesRemoved: int(0, 300), toolCalls: int(1, 180),
        toolDurationMs: int(1_000, 900_000), apiDurationMs: int(1_000, 600_000), turns: int(1, 60),
      },
      background: chance(0.35),
      shortId: null,
    };
    if (agent.background) agent.shortId = Math.random().toString(36).slice(2, 6);

    this.agents.set(agent.id, {
      agent, dwell: rnd(600, 4_000), escalationId: null,
      spawnBudget: depth === 0 ? int(0, 3) : 0,
    });
    project.sessionIds = [...project.sessionIds, agent.id];

    if (parent) {
      parent.childIds = [...parent.childIds, agent.id];
      this.send({ t: 'agent', machineId: this.spec.id, id: parent.id, patch: { childIds: parent.childIds } });
    }
    return agent;
  }

  /** El motor: transiciones de estado con tiempos de permanencia distintos. */
  private tick(dtBase: number): void {
    const dt = dtBase * this.speed;
    for (const local of [...this.agents.values()]) {
      const a = local.agent;
      a.uptimeMs += dt;

      if (a.state === 'working' || a.state === 'thinking') {
        // Los números tienen que ser creíbles: un agente escribiendo código
        // ronda 20-90 tok/s y quema céntimos, no dólares, por minuto.
        const tps = a.state === 'thinking' ? rnd(12, 55) : rnd(20, 95);
        a.metrics.tokensPerSec = Math.round(tps * 10) / 10;
        const outDelta = Math.round((tps * dt) / 1000);
        a.metrics.outputTokens += outDelta;
        a.metrics.inputTokens += Math.round(outDelta * rnd(3, 12));
        a.metrics.cacheReadTokens += Math.round(outDelta * rnd(10, 60));
        a.metrics.costUSD += outDelta * 0.000_015 + rnd(0, 0.000_2);
        if (a.state === 'working') a.metrics.toolDurationMs += dt;
        else a.metrics.apiDurationMs += dt;
      } else if (a.metrics.tokensPerSec !== 0) {
        a.metrics.tokensPerSec = 0;
      }

      local.dwell -= dt;
      if (local.dwell > 0) {
        // Aun sin transición, un agente trabajando emite ruido: es lo que hace
        // que el coalescing del hub tenga algo que colapsar.
        if ((a.state === 'working' || a.state === 'thinking') && chance(0.25)) {
          this.send({
            t: 'agent', machineId: this.spec.id, id: a.id,
            patch: { metrics: a.metrics, uptimeMs: a.uptimeMs, updatedAt: Date.now() },
          });
        }
        continue;
      }
      this.transition(local);
    }
  }

  private transition(local: Local): void {
    const a = local.agent;
    const from = a.state;
    let next: State = from;

    switch (from) {
      case 'booting':
        next = 'thinking';
        local.dwell = rnd(800, 5_000);
        break;
      case 'thinking':
        if (chance(0.08)) next = 'idle';
        else if (chance(0.06)) next = 'blocked';
        else next = 'working';
        local.dwell = rnd(1_500, 14_000);
        break;
      case 'working':
        if (chance(0.10)) next = 'blocked';
        else if (chance(0.07)) next = 'idle';
        else if (chance(0.03)) next = 'done';
        else next = 'thinking';
        local.dwell = rnd(900, 9_000);
        break;
      case 'blocked':
        // Un bloqueo espera; sólo se resuelve solo si nadie contesta en mucho.
        local.dwell = rnd(8_000, 40_000);
        if (chance(0.25)) {
          next = 'working';
          if (local.escalationId) this.withdraw(local, 'el agente lo resolvió por su cuenta');
          a.block = null;
        }
        break;
      case 'idle':
        if (chance(0.35)) next = 'thinking';
        else if (chance(0.08)) next = 'done';
        local.dwell = rnd(4_000, 25_000);
        break;
      case 'done':
      case 'dead':
        // Los terminados se van reciclando para que la flota no se apague.
        local.dwell = rnd(20_000, 60_000);
        if (chance(0.5)) { this.retire(local); return; }
        break;
    }

    // Sin cambio de estado no hay nada que contar: un bloqueo que sigue
    // bloqueado no debe generar tráfico.
    if (next === from) return;
    this.enter(local, next);
  }

  private enter(local: Local, next: State): void {
    const a = local.agent;
    a.state = next;
    a.updatedAt = Date.now();

    if (next === 'working') {
      const tool = pick(['Bash', 'Edit', 'Read', 'Task', 'WebSearch', 'Grep', 'Write', 'WebFetch']);
      a.tool = tool;
      a.toolDetail = this.toolDetail(tool);
      a.metrics.toolCalls += 1;
      if (tool === 'Task' && local.spawnBudget > 0 && a.depth < 2) {
        local.spawnBudget -= 1;
        const child = this.spawn(a, a.depth + 1, a.projectId, a.toolDetail ?? undefined);
        this.send({ t: 'agent:new', machineId: this.spec.id, agent: child });
        this.feed('info', a, `lanzó a ${child.callsign}: ${child.mission ?? ''}`);
      }
    } else {
      a.tool = null;
      a.toolDetail = null;
    }

    if (next === 'thinking' && chance(0.5)) {
      a.lastSay = pick(SAYS);
      a.metrics.turns += 1;
    }

    if (next === 'blocked') {
      if (chance(0.55)) {
        // Escalación: el agente pregunta al humano.
        const q = pick(QUESTIONS);
        const esc: Escalation = {
          id: newId('esc'), agentId: a.id, projectId: a.projectId, machineId: this.spec.id,
          question: q.q, context: q.ctx, options: q.options, optionsOnly: chance(0.3),
          urgency: q.urgency, status: 'pending', ceoAttempt: chance(0.4) ? {
            answer: 'No tengo contexto suficiente para decidir esto.',
            confidence: rnd(0.1, 0.45),
            reason: 'La respuesta depende de una preferencia del humano, no del repositorio.',
          } : null,
          answer: null, answeredBy: null, rememberAs: null,
          askedAt: Date.now(), answeredAt: null,
          expiresAt: Date.now() + int(120, 900) * 1000,
        };
        this.escalations.set(esc.id, esc);
        local.escalationId = esc.id;
        a.block = { kind: 'question', summary: q.q, escalationId: esc.id, since: Date.now() };
        this.send({ t: 'escalation', machineId: this.spec.id, escalation: esc });
        this.feed('alert', a, `escaló: ${q.q}`);
      } else {
        a.block = { kind: 'permission', summary: pick(PERMISSIONS), since: Date.now() };
        this.feed('warn', a, `pide permiso: ${a.block.summary}`);
      }
    } else if (a.block) {
      a.block = null;
    }

    if (next === 'done' || next === 'dead') {
      a.metrics.tokensPerSec = 0;
      this.feed(next === 'dead' ? 'alert' : 'info', a, next === 'dead' ? 'murió' : 'terminó');
      if (local.escalationId) this.withdraw(local, 'el agente terminó');
    }

    this.send({
      t: 'agent', machineId: this.spec.id, id: a.id,
      patch: {
        state: a.state, block: a.block, tool: a.tool, toolDetail: a.toolDetail,
        lastSay: a.lastSay, metrics: a.metrics, updatedAt: a.updatedAt, uptimeMs: a.uptimeMs,
        childIds: a.childIds,
      },
    });
  }

  private toolDetail(tool: string): string {
    switch (tool) {
      case 'Bash': return pick(BASH);
      case 'Edit':
      case 'Read':
      case 'Write': return pick(FILES);
      case 'Grep': return `rg "${pick(['PatchOp', 'rollup', 'escalation', 'BEAT_TIMEOUT', 'markMachineOffline'])}"`;
      case 'WebSearch':
      case 'WebFetch': return pick(SEARCHES);
      case 'Task': return `subagente: ${pick(TITLES).toLowerCase()}`;
      default: return pick(FILES);
    }
  }

  private retire(local: Local): void {
    const a = local.agent;
    this.agents.delete(a.id);
    const project = this.projects.find((p) => p.id === a.projectId);
    if (project) project.sessionIds = project.sessionIds.filter((id) => id !== a.id);
    this.send({ t: 'agent:gone', machineId: this.spec.id, id: a.id });
    // La flota se repone sola: la consola nunca se queda vacía.
    const fresh = this.spawn(null, 0);
    this.send({ t: 'agent:new', machineId: this.spec.id, agent: fresh });
  }

  private withdraw(local: Local, reason: string): void {
    const id = local.escalationId;
    if (!id) return;
    const esc = this.escalations.get(id);
    local.escalationId = null;
    if (!esc || esc.status === 'answered') return;
    esc.status = 'withdrawn';
    this.send({ t: 'escalation:withdraw', machineId: this.spec.id, id, reason });
  }

  private feed(level: FeedItem['level'], a: Agent | null, text: string): void {
    const project = a ? this.projects.find((p) => p.id === a.projectId) : undefined;
    const item: FeedItem = {
      id: newId('f'), at: Date.now(), level,
      source: a && project ? `${project.code}/${a.callsign}` : this.spec.id,
      text,
      ...(a ? { agentId: a.id, projectId: a.projectId } : {}),
    };
    this.send({ t: 'feed', machineId: this.spec.id, items: [item] });
  }

  /** Ruido de fondo del HUD: lo que un collector real vería pasar. */
  private emitFeed(): void {
    const locals = [...this.agents.values()];
    if (locals.length === 0) return;
    const local = pick(locals);
    const a = local.agent;
    const lines: [FeedItem['level'], string][] = [
      ['trace', `${a.tool ?? 'API'} ${a.toolDetail ?? 'respuesta recibida'}`],
      ['info', pick(SAYS)],
      ['trace', `${a.metrics.tokensPerSec.toFixed(0)} tok/s · $${a.metrics.costUSD.toFixed(3)}`],
      ['warn', 'reintentando: 429 del API, backoff 2s'],
      ['info', `git: ${int(1, 9)} archivos modificados en ${pick(this.projects).name}`],
    ];
    const [level, text] = pick(lines);
    this.feed(level, a, text);

    if (chance(0.05)) {
      const project = pick(this.projects);
      project.gitDirty = !project.gitDirty;
      this.send({
        t: 'project', machineId: this.spec.id, id: project.id,
        patch: { gitDirty: project.gitDirty, gitBranch: project.gitBranch },
      });
    }
  }

  /* ── comandos entrantes ─────────────────────────────────────────── */

  private onCommand(cmdId: string, cmd: Command): void {
    switch (cmd.k) {
      case 'resync':
        this.sendSnapshot();
        this.ack(cmdId, true, 'snapshot enviado');
        return;

      case 'spawn': {
        const parent = cmd.parentId ? this.agents.get(cmd.parentId)?.agent ?? null : null;
        const child = this.spawn(parent, parent ? parent.depth + 1 : 0, cmd.projectId, cmd.mission);
        child.lastPrompt = cmd.prompt;
        child.background = cmd.background;
        this.send({ t: 'agent:new', machineId: this.spec.id, agent: child });
        this.feed('info', child, `lanzado por la consola: ${cmd.mission}`);
        this.ack(cmdId, true, `agente ${child.callsign} lanzado`);
        return;
      }

      case 'say': {
        const local = this.agents.get(cmd.agentId);
        if (!local) { this.ack(cmdId, false, 'agente desconocido'); return; }
        local.agent.lastPrompt = cmd.text;
        local.dwell = 0;
        this.enter(local, 'thinking');
        this.ack(cmdId, true, 'entregado');
        return;
      }

      case 'permit': {
        const local = this.agents.get(cmd.agentId);
        if (!local) { this.ack(cmdId, false, 'agente desconocido'); return; }
        local.agent.block = null;
        local.dwell = 0;
        this.enter(local, cmd.allow ? 'working' : 'idle');
        this.ack(cmdId, true, cmd.allow ? 'permitido' : 'denegado');
        return;
      }

      case 'answer': {
        const esc = this.escalations.get(cmd.escalationId);
        if (!esc) { this.ack(cmdId, false, 'escalación desconocida'); return; }
        esc.status = 'answered';
        esc.answer = cmd.answer;
        esc.answeredBy = 'human';
        esc.answeredAt = Date.now();
        esc.rememberAs = cmd.rememberAs;
        this.send({ t: 'escalation', machineId: this.spec.id, escalation: esc });
        const local = this.agents.get(esc.agentId);
        if (local) {
          local.escalationId = null;
          local.agent.block = null;
          local.dwell = 0;
          this.enter(local, 'working');
          this.feed('info', local.agent, `respuesta recibida: ${cmd.answer.slice(0, 60)}`);
        }
        this.ack(cmdId, true, 'entregada al agente');
        return;
      }

      case 'stop': {
        const local = this.agents.get(cmd.agentId);
        if (!local) { this.ack(cmdId, false, 'agente desconocido'); return; }
        local.dwell = 0;
        this.enter(local, 'done');
        this.ack(cmdId, true, 'detenido');
        return;
      }

      case 'resume': {
        const local = this.agents.get(cmd.agentId);
        if (!local) { this.ack(cmdId, false, 'agente desconocido'); return; }
        local.dwell = 0;
        this.enter(local, 'thinking');
        this.ack(cmdId, true, 'reanudado');
        return;
      }

      case 'remove': {
        const local = this.agents.get(cmd.agentId);
        if (!local) { this.ack(cmdId, false, 'agente desconocido'); return; }
        this.agents.delete(cmd.agentId);
        this.send({ t: 'agent:gone', machineId: this.spec.id, id: cmd.agentId });
        this.ack(cmdId, true, 'eliminado');
        return;
      }

      case 'key:set': {
        // Un collector real guarda el valor en el llavero de la máquina y sólo
        // devuelve el descriptor. Aquí hacemos lo mismo: el valor muere aquí.
        const hint = cmd.value.slice(-4);
        const existing = this.keys.find((k) => k.projectId === cmd.projectId && k.name === cmd.name);
        if (existing) existing.hint = hint;
        else this.keys.push({ name: cmd.name, projectId: cmd.projectId, hint, addedAt: Date.now(), lastUsedAt: null, usedBy: [] });
        const project = this.projects.find((p) => p.id === cmd.projectId);
        if (project && !project.keyNames.includes(cmd.name)) {
          project.keyNames = [...project.keyNames, cmd.name];
          this.send({ t: 'project', machineId: this.spec.id, id: project.id, patch: { keyNames: project.keyNames } });
        }
        this.sendSnapshot();
        this.ack(cmdId, true, `clave ${cmd.name} guardada en la máquina`);
        return;
      }

      case 'key:remove': {
        this.keys = this.keys.filter((k) => !(k.projectId === cmd.projectId && k.name === cmd.name));
        this.sendSnapshot();
        this.ack(cmdId, true, 'clave borrada');
        return;
      }

      case 'logs': {
        const lines = Array.from({ length: Math.min(cmd.lines, 20) }, () => `$ ${pick(BASH)}`);
        this.send({ t: 'ack', cmdId, ok: true, detail: 'logs', data: { lines } });
        return;
      }

      default:
        this.ack(cmdId, false, 'comando no soportado por el collector falso');
    }
  }
}

/* ── orquestación ─────────────────────────────────────────────────── */

function readToken(): string {
  const flag = process.argv.find((a) => a.startsWith('--token='));
  if (flag) return flag.slice('--token='.length);
  const env = process.env['ORCA_TOKEN'];
  if (env) return env;
  try {
    return readFileSync(join(process.env['ORCA_HOME'] ?? join(homedir(), '.orca'), 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

export interface FakeFleetOptions {
  hub?: string;
  token?: string;
  chaos?: boolean;
  speed?: number;
  quiet?: boolean;
}

export function startFakeFleet(opts: FakeFleetOptions = {}): { machines: FakeMachine[]; stop: () => void } {
  const hub = opts.hub ?? `ws://localhost:${PORTS.hub}`;
  const token = opts.token ?? readToken();
  const speed = opts.speed ?? 1;
  const quiet = opts.quiet ?? false;

  const machines = FLEET.map((spec) => new FakeMachine(spec, { hub, token, quiet, speed }));
  for (const m of machines) m.start();

  let chaosTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.chaos) {
    if (!quiet) console.log('[caos] activado: las máquinas caerán y volverán solas');
    chaosTimer = setInterval(() => {
      const victim = pick(machines);
      if (victim.connected && chance(0.6)) {
        victim.drop();
        setTimeout(() => victim.reconnect(), int(3_000, 20_000));
      }
    }, 12_000);
    chaosTimer.unref?.();
  }

  return {
    machines,
    stop: () => {
      if (chaosTimer) clearInterval(chaosTimer);
      for (const m of machines) m.stop();
    },
  };
}

const runDirectly = (process.argv[1] ?? '').endsWith('fake-collector.ts');
if (runDirectly) {
  const hubFlag = process.argv.find((a) => a.startsWith('--hub='));
  const speedFlag = process.argv.find((a) => a.startsWith('--speed='));
  const fleet = startFakeFleet({
    hub: hubFlag?.slice('--hub='.length),
    token: readToken(),
    chaos: process.argv.includes('--chaos'),
    speed: speedFlag ? Number(speedFlag.slice('--speed='.length)) || 1 : 1,
    quiet: process.argv.includes('--quiet'),
  });
  console.log(`[fake] ${fleet.machines.length} máquinas, ${FLEET.reduce((n, m) => n + m.agents, 0)} agentes iniciales`);
  const bye = (): void => { fleet.stop(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
