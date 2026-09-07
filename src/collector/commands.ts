/**
 * Ejecución de `Command`. La superficie de ataque del collector.
 *
 * Postura de seguridad, no negociable:
 *
 *  1. UN SOLO binario permitido: el `claude` resuelto del PATH al arrancar y
 *     verificado como ejecutable existente. No hay caso `exec` y no puede
 *     haberlo — `protocol.ts` tampoco lo define.
 *  2. NUNCA hay shell. `spawn(..., { shell: false })` siempre, y el argv se
 *     construye como array. El prompt del humano viaja como UN elemento del
 *     array: no existe interpolación en una string de shell, así que no existe
 *     inyección de comandos por más comillas que traiga el prompt.
 *  3. Todo id se valida contra el estado real antes de tocar nada. Un hub
 *     comprometido no puede nombrar una sesión que no existe ni un proyecto
 *     que el collector no haya descubierto en ~/.claude/projects, y nunca una
 *     ruta de sistema.
 *  4. Las credenciales sólo entran al env del hijo, y sólo las del proyecto.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { runtimeBin, runtimeNote, runtimeReady } from './runtime.ts';
import fs from 'node:fs';
import path from 'node:path';

import type { Command, SpawnAck } from '../shared/protocol.ts';
import { SPAWN_ACK_TIMEOUT_MS } from '../shared/protocol.ts';
import { squadName } from '../shared/squads.ts';
import {
  INTERRUPT_EVIDENCE_MS, QUEUED_MARK, describeOutcome, interruptPlan,
  type InterruptOutcome,
} from '../shared/interrupt.ts';
import type { AgentMessage } from '../shared/types.ts';
import { squadBrief, withBrief } from './briefs.ts';
import type { ArtifactIndex } from './artifacts.ts';
import type { EscalationWatcher } from './escalate.ts';
import type { KeyVault } from './keys.ts';
import type { LineageIndex } from './lineage.ts';
import type { MessageWatcher } from './messages.ts';
import type { ProjectRegistry } from './projects.ts';
import { paneName, type TmuxHost } from './tmux.ts';
import { errText, home, isInside, launchable, log, oneLine, orcaDir, sleep } from './util.ts';
import {
  NAME_RE as WORKTREE_NAME_RE, createWorktree, discard as discardWorktree, land as landWorktree,
  worktreesEnabled, type WorktreeInfo,
} from './worktrees.ts';
import { runAutonomy } from './autonomy.ts';
import { WorkerHandoffs } from './worker-handoff.ts';
import { ModelController } from './model-control.ts';
import { ProviderHandoffs, providerModels } from './provider-handoff.ts';
import { CapcomResets } from './capcom-reset.ts';

const SCOPE = 'commands';

/** Modos que `claude --permission-mode` acepta de verdad (CLI 2.1.260). */
const PERMISSION_MODES = new Set([
  'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan',
]);

/** Un id de sesión/short id sólo puede ser esto. Corta cualquier argv raro. */
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

export interface AgentHandle {
  origin?: 'orca' | 'external';
  cwd?: string;
  parentId?: string | null;
  squad?: string | null;
  lead?: boolean;
  subagent?: boolean;
  transcriptPath?: string;
  model?: string | null;
  state?: import('../shared/types.ts').AgentState;
  blockKind?: import('../shared/types.ts').BlockKind;
  id: string;
  projectId: string;
  sessionId: string;
  shortId: string | null;
  background: boolean;
  alive: boolean;
  /** La etiqueta que la consola enseña, p.ej. "K9". */
  callsign: string;
  /** El pane de tmux que la hospeda (`orca-<sessionId>`), o null si no vive en uno. */
  pane: string | null;
  /** Qué CLI es: 'claude', 'codex'… Decide cómo se reanuda y qué se puede hacer sin pane. */
  runtime: string;
  /** El worktree en el que se lanzó, si el collector corre con ORCA_WORKTREES=1. */
  worktree?: WorktreeInfo | null;
  /** Su brief, para el mensaje del commit al aterrizar. */
  mission?: string | null;
}

/** Qué sesión buscar tras un spawn. Ver `CommandDeps.awaitSpawn`. */
export interface SpawnLookup {
  /** El short id que imprimió el CLI, cuando lo imprimió. */
  shortId: string | null;
  /** El id que ORCA eligió por adelantado (`--session-id`): la búsqueda es exacta. */
  sessionId?: string | null;
  /** Sin id previo (Codex): la sesión raíz más nueva de ESTE runtime en el proyecto. */
  runtime?: string;
  projectId: string;
  /** epoch ms justo antes de lanzar: descarta sesiones que ya existían. */
  since: number;
}

export interface CommandDeps {
  transfer?: { context(): string; hold(id: string, on: boolean, plan?: import('../shared/provider-handoff.ts').ProviderHandoffPlan): void; activate(plan: import('../shared/provider-handoff.ts').ProviderHandoffPlan, sessionId: string): Promise<void> };
  projects: ProjectRegistry;
  keys: KeyVault;
  /** Donde viven los agentes hospedados. Sin tmux, todo cae a `--bg`. */
  tmux: TmuxHost;
  lineage: LineageIndex;
  escalations: EscalationWatcher;
  messages: MessageWatcher;
  artifacts: ArtifactIndex;
  /** Sólo devuelve agentes que ORCA está observando ahora mismo. */
  agent(id: string): AgentHandle | null;
  /**
   * Espera a que la sesión recién lanzada aparezca de verdad, para poder
   * devolver su id en el ack. null si no llegó a tiempo — el proceso arrancó
   * igual y `agent:new` la anunciará cuando ORCA la vea.
   */
  awaitSpawn(want: SpawnLookup, timeoutMs: number): Promise<AgentHandle | null>;
  onResync(): void;
  onKeysChanged(): void;
  /**
   * El canal de CAPCOM, cuando esta máquina lo lleva.
   *
   * CAPCOM se habla con el mismo `say` que cualquier agente y NO se lanza como
   * cualquier agente: sus herramientas viven en un servidor MCP y hay que
   * volver a nombrarlo en cada invocación. Peor: `claude --bg --resume` arrastra
   * la conversación a una sesión NUEVA, así que el rol tiene que mudarse con
   * ella o la flota se queda sin mando en cuanto el humano dice la primera cosa.
   * Las dos cosas son de CAPCOM y de nadie más, así que entran por aquí en vez
   * de ensuciar `say` con condicionales.
   */
  capcom?: CapcomChannel;
  /**
   * Escalaciones de permisos que este collector levantó leyendo pantallas
   * (index.ts). `get` identifies the agent; `answer` validates the current dialog and
   * keeps the escalation pending until observable resolution.
   */
  permissions?: {
    get(escalationId: string): { agentId: string } | null;
    answer(escalationId: string, answer: string): Promise<CommandResult>;
  };
  /**
   * Cuándo vio ORCA por última vez, en el transcript de ese agente, la marca
   * de turno interrumpido que escribe su propio CLI. 0 = nunca.
   *
   * Es lo que convierte "mandé la tecla" en "el turno se cortó". Opcional
   * porque un collector de prueba no tiene derivers: sin esto, `interrupt`
   * responde `pending` en vez de afirmar algo que no puede comprobar.
   */
  interruptedAt?(agentId: string): number;
}

/** Lo que `commands.ts` necesita saber de CAPCOM. Lo implementa capcom.ts. */
export interface CapcomChannel {
  /** ¿Es este short id la sesión CAPCOM? */
  owns(shortId: string | null): boolean;
  /**
   * Dónde vive. Se usa como cwd sin pasar por el proyecto: el collector lo
   * lanzó ahí, así que no hay nada que adivinar a partir de un slug.
   */
  dir(): string | null;
  /** Las opciones que toda invocación suya necesita: MCP, permisos, nombre. */
  launchArgs(): string[];
  /** El resume creó una sesión nueva: el rol se muda a ella. */
  adopt(shortId: string): void;
  /** Tras un `/clear`: mueve el rol y el registro que lo readopta. */
  adoptCleared(toId: string, mode: 'clean' | 'continuity', cutoffAt: number): void;
}

export interface CommandResult {
  ok: boolean;
  detail?: string;
  data?: unknown;
}

/**
 * `ORCA_CAPCOM_PREPARED_RESET=1` vuelve al camino largo.
 *
 * Un New CAPCOM que no cambia de runtime se hace ahora con el `/clear` del
 * propio CLI (capcom-reset.ts). El camino que prepara una sesión aparte sigue
 * entero —lo necesita cualquier cambio de proveedor— y esta variable lo
 * devuelve también para el mismo runtime, por si el nativo se atasca en una
 * versión del CLI que aún no se ha visto.
 */
export function preparedReset(env: Record<string, string | undefined> = process.env): boolean {
  return env['ORCA_CAPCOM_PREPARED_RESET'] === '1';
}

export class CommandRunner {
  readonly workers: WorkerHandoffs;
  readonly handoffs: ProviderHandoffs;
  readonly models: ModelController;
  readonly reset: CapcomResets;
  private inputBusy = new Map<string, number>();
  private readonly deps: CommandDeps;
  private readonly bin: string | null;

  constructor(deps: CommandDeps) {
    this.deps = deps;
    this.models = new ModelController({ tmux: deps.tmux, agent: deps.agent,
      owns: a => (!!a.pane || a.origin === 'orca') && !a.subagent, dir: id => id && this.capcomFor(deps.agent(id)) ? deps.capcom!.dir() : path.join(orcaDir(), 'worker-recovery', 'models'), busy: id => this.inputBusy.has(id) || this.handoffs?.locked(id) || this.workers?.handoffs.locked(id) });
    this.handoffs = new ProviderHandoffs({ agent: deps.agent, owns: a => !!this.capcomFor(a),
      model: a => this.models.state(a)?.active ?? a.model ?? null,
      dir: () => { const dir = deps.capcom?.dir(); if (!dir) throw new Error('CAPCOM is unavailable'); return dir; },
      busy: id => this.inputBusy.has(id) || this.models.locked(id) || ['queued', 'applying'].includes(this.models.state(deps.agent(id)!)?.phase ?? ''),
      context: () => deps.transfer?.context() ?? '', hold: (id, on, plan) => deps.transfer?.hold(id, on, plan),
      activate: async (plan, sessionId) => { if (!deps.transfer) throw new Error('Provider handoff activation unavailable'); await deps.transfer.activate(plan, sessionId); },
    });
    this.workers = new WorkerHandoffs(deps, this.models, id => this.inputBusy.has(id));
    this.reset = new CapcomResets({
      tmux: deps.tmux, agent: deps.agent, owns: a => !!this.capcomFor(a),
      busy: id => this.inputBusy.has(id) || this.models.locked(id) || this.handoffs.locked(id)
        || ['queued', 'applying'].includes(this.models.state(deps.agent(id)!)?.phase ?? ''),
      model: a => this.models.state(a)?.active ?? a.model ?? null,
      setModel: (id, model) => this.applyModel(id, model),
      discover: (projectId, runtime, since, ms) => deps.awaitSpawn({ shortId: null, runtime, projectId, since }, ms),
      hold: (id, on, cutoffAt, mode) => deps.transfer?.hold(id, on, on ? { contextMode: mode, at: cutoffAt } as never : undefined),
      adopt: (_from, to, mode, cutoffAt) => { deps.capcom?.adoptCleared(to, mode, cutoffAt); },
      note: text => log('info', SCOPE, text),
    });
    this.bin = resolveClaudeBin();
    if (!this.bin) {
      log('warn', SCOPE, 'no encontré el binario `claude` en PATH: spawn/stop/logs no funcionarán');
    } else {
      log('info', SCOPE, `binario permitido: ${this.bin}`);
    }
  }

  async execute(cmd: Command): Promise<CommandResult> {
    const service = 'agentId' in cmd && !this.capcomFor(this.deps.agent(cmd.agentId)!) ? this.workers.handoffs : this.handoffs;
    const inputId = 'agentId' in cmd && !cmd.k.startsWith('handoff:') && cmd.k !== 'model:list' && cmd.k !== 'model:set' && cmd.k !== 'capcom:new' ? cmd.agentId : null;
    if ('agentId' in cmd && cmd.k !== 'capcom:new' && !cmd.k.startsWith('handoff:') && (this.handoffs.locked(cmd.agentId) || this.workers.handoffs.locked(cmd.agentId))) return { ok: false, detail: 'CAPCOM handoff preparation is in progress. Your current session is preserved.' };
    if (inputId && this.models.locked(inputId)) return { ok: false, detail: 'CAPCOM model selection is in progress; retry after it finishes.' };
    if (inputId) this.inputBusy.set(inputId, (this.inputBusy.get(inputId) ?? 0) + 1);
    try {
      switch (cmd.k) {
        case 'recovery:settings': case 'recovery:status': case 'recovery:decide': throw new Error('Recovery decisions must run through the hub');
        case 'capcom:new': return { ok: true, data: await this.freshCapcom(cmd) };
        case 'handoff:models': return { ok: true, data: providerModels() };
        case 'handoff:prepare': return { ok: true, data: service.review(cmd.agentId, cmd.runtime, cmd.model, typeof cmd.checkpoint === 'string' ? cmd.checkpoint : '') };
        case 'handoff:commit': return { ok: true, data: service.commit(cmd.agentId, cmd.planId) };
        case 'handoff:status': return { ok: true, data: (this.handoffs.has(cmd.planId) ? this.handoffs : this.workers.handoffs).status(cmd.planId) };
        case 'handoff:history': {
          if (!Number.isInteger(cmd.offset) || cmd.offset < 0 || !Number.isFinite(cmd.before)) throw new Error('Invalid history page');
          return { ok: true, data: service.history(cmd.agentId, cmd.offset, cmd.before) };
        }
        case 'model:list': return { ok: true, data: await this.models.list(cmd.agentId) };
        case 'model:set': return { ok: true, data: this.models.request(cmd.agentId, cmd.model) };
        case 'spawn': return await this.spawn(cmd);
        case 'land': return await this.land(cmd);
        case 'discard': return await this.discard(cmd);
        case 'say': return await this.say(cmd);
        case 'interrupt': return await this.interrupt(cmd);
        case 'permit': return await this.permit(cmd);
        case 'stop': return await this.simple(cmd.agentId, ['stop'], 'stop');
        case 'resume': return await this.resume(cmd);
        case 'remove': return await this.simple(cmd.agentId, ['rm'], 'remove');
        case 'answer': return await this.answer(cmd);
        case 'deliver': return await this.deliver(cmd);
        case 'reply': return await this.reply(cmd);
        case 'key:set': return this.keySet(cmd);
        case 'key:remove': return this.keyRemove(cmd);
        case 'artifact:read': return await this.artifactRead(cmd);
        case 'resync': this.deps.onResync(); return { ok: true, detail: 'resync encolado' };
        case 'logs': return await this.logs(cmd);
        case 'autonomy': return await runAutonomy(cmd, this.deps);
        default: {
          // Exhaustividad: si protocol.ts crece, esto deja de compilar.
          const never: never = cmd;
          return { ok: false, detail: `comando desconocido: ${JSON.stringify(never)}` };
        }
      }
    } catch (err) {
      log('error', SCOPE, `${cmd.k} lanzó: ${errText(err)}`);
      return { ok: false, detail: errText(err) };
    } finally {
      if (inputId) {
        const remaining = (this.inputBusy.get(inputId) ?? 1) - 1;
        if (remaining) this.inputBusy.set(inputId, remaining); else this.inputBusy.delete(inputId);
      }
    }
  }

  /* ── spawn ────────────────────────────────────────────────────── */

  private async spawn(cmd: Extract<Command, { k: 'spawn' }>): Promise<CommandResult> {
    // Un runtime que este collector no sabe conducir se rechaza con el porqué,
    // en vez de lanzar `claude` y fingir que era Codex.
    if (!runtimeReady(cmd.runtime)) return { ok: false, detail: runtimeNote(cmd.runtime) };
    if ((cmd.runtime ?? 'claude') === 'claude' && !this.bin) return { ok: false, detail: 'binario `claude` no disponible' };
    const project = this.deps.projects.get(cmd.projectId);
    if (!project) return { ok: false, detail: `proyecto desconocido: ${cmd.projectId}` };

    let cwd = path.resolve(project.path);
    const allowed = launchable(cwd);
    if (!allowed.ok) return { ok: false, detail: allowed.why };
    if (!isDir(cwd)) return { ok: false, detail: `la ruta del proyecto no existe: ${cwd}` };
    const controlRoot = path.resolve(process.env['ORCA_CAPCOM_DIR'] ?? path.join(orcaDir(), 'capcom'));
    const realControlRoot = fs.existsSync(controlRoot) ? fs.realpathSync(controlRoot) : controlRoot;
    if (isInside(realControlRoot, fs.realpathSync(cwd))) {
      return { ok: false, detail: 'CAPCOM is a control workspace: workers launched here read its CLAUDE.md and wake up believing they are the commander. Choose a work project outside the CAPCOM directory; do not retry by spawning more workers here.' };
    }
    if (typeof cmd.prompt !== 'string' || cmd.prompt.trim().length === 0) {
      return { ok: false, detail: 'prompt vacío' };
    }
    if (cmd.prompt.length > 100_000) return { ok: false, detail: 'prompt absurdamente largo' };

    /*
     * Escuadrón.
     *
     * Se valida antes de tocar nada porque el nombre acaba en tres sitios que
     * no perdonan basura: el argv de nadie (nunca), el disco (lineage.json), y
     * el pie del prompt que el agente va a leer como instrucción. Un nombre
     * inventado sería un escuadrón al que nadie puede escribirle.
     */
    let squad: string | null = null;
    if (cmd.squad !== undefined && cmd.squad !== null && cmd.squad !== '') {
      squad = squadName(cmd.squad);
      if (!squad) return { ok: false, detail: `nombre de escuadrón inválido: ${String(cmd.squad)}` };
    }
    const lead = squad !== null && cmd.lead === true;

    /*
     * El pie del brief.
     *
     * Va DENTRO del prompt, no en el env, porque el env no lo lee el modelo. Un
     * miembro que no sabe que tiene líder escala al humano, y cinco agentes
     * escalando al humano es exactamente lo que un escuadrón existe para
     * evitar. El texto vive en briefs.ts para poder editarlo sin leer esto.
     */
    let prompt = cmd.prompt;
    const brief = squadBrief(squad, lead,
      cmd.parentId ? this.deps.agent(cmd.parentId)?.callsign ?? null : null);
    if (brief) prompt = withBrief(prompt, brief);

    // argv como ARRAY. El prompt es un elemento, nunca texto de shell.
    const opts: string[] = [];
    if (cmd.model) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(cmd.model)) {
        return { ok: false, detail: `modelo inválido: ${cmd.model}` };
      }
      opts.push('--model', cmd.model);
    }
    if (cmd.permissionMode) {
      if (!PERMISSION_MODES.has(cmd.permissionMode)) {
        return { ok: false, detail: `permissionMode inválido: ${cmd.permissionMode}` };
      }
      opts.push('--permission-mode', cmd.permissionMode);
    }
    const name = oneLine(cmd.mission, 60);
    if (name) opts.push('--name', name);

    /*
     * Hospedado o suelto.
     *
     * Con tmux en la máquina, un agente que debe sobrevivir a la consola va a
     * un pane: sesión interactiva normal, id elegido aquí, y una TERMINAL que
     * el operador puede abrir. `--bg` queda para las máquinas sin tmux y para
     * quien lo pida (`pane: false`); CAPCOM nunca pasa por aquí.
     */
    const runtime = cmd.runtime ?? 'claude';
    if (cmd.background && cmd.pane !== false && this.deps.tmux.available()) {
      return runtime === 'claude'
        ? this.spawnPane(cmd, project.name, cwd, prompt, opts, squad, lead)
        : this.spawnCodexPane(cmd, project.name, cwd, prompt, squad, lead);
    }
    if (runtime !== 'claude') {
      return { ok: false, detail: `${runtime} sólo se lanza hospedado en tmux (background on, tmux instalado)` };
    }

    if (!this.bin) return { ok: false, detail: 'binario `claude` no disponible' };

    const args: string[] = [];
    if (cmd.background) args.push('--bg');
    args.push(...opts);

    /*
     * El prompt va POSICIONAL con --bg y con -p sin él. No es cosmético: el CLI
     * rechaza la combinación en seco —"--bg and --print conflict: --print never
     * starts the interactive session that `claude agents` attaches to"— así que
     * con -p todo spawn en background fallaba antes de arrancar.
     */
    if (cmd.background) args.push(prompt);
    else args.push('-p', prompt);

    const env = {
      ...process.env,
      ...this.deps.keys.materialize(cmd.projectId, cmd.parentId ?? 'orca'),
      ORCA_SPAWNED: '1',
      ORCA_PARENT_ID: cmd.parentId ?? '',
    };

    // Sin id previo (`--bg` lo elige el CLI), el worktree se nombra por un
    // nonce; el registro lo ata al short id en cuanto el CLI lo imprime.
    const projectRoot = cwd;
    const wt = await this.worktreeFor(cmd, projectRoot, randomUUID().replace(/-/g, '').slice(0, 8));
    if (!wt.ok) return { ok: false, detail: wt.detail };
    if (wt.worktree) cwd = wt.worktree.path;

    const since = Date.now();
    const res = await run(this.bin, args, { cwd, env, timeoutMs: 60_000, detach: true });
    if (!res.ok) { await this.dropFreshWorktree(projectRoot, wt); return { ok: false, detail: res.detail }; }

    const shortId = extractShortId(res.stdout);
    if (shortId) {
      // Anotamos el linaje ANTES de contárselo al hub: si el collector muere en
      // el siguiente instante, el padre ya quedó persistido en disco.
      this.deps.lineage.noteSpawn(shortId, cmd.parentId, cmd.mission, squad, lead, 'agent', wt.worktree);
    }

    /*
     * Esperar al id.
     *
     * El CLI imprime un short id, no un id de sesión, y ORCA nombra las cosas
     * por sesión. Sin resolverlo aquí, quien acaba de lanzar a un líder no
     * tiene con qué lanzar a sus miembros — `parentId` es exactamente ese id —
     * y tendría que adivinarlo mirando la consola.
     *
     * Se espera hasta SPAWN_ACK_TIMEOUT_MS (8s). Pasado eso el ack sale igual
     * con `agentId: null`: el proceso ARRANCÓ, y decir que falló sería mentir.
     */
    const found = await this.deps.awaitSpawn(
      { shortId, projectId: cmd.projectId, since }, SPAWN_ACK_TIMEOUT_MS,
    );
    const data: SpawnAck = {
      agentId: found?.id ?? null,
      callsign: found?.callsign ?? null,
      shortId: found?.shortId ?? shortId,
      stdout: oneLine(res.stdout, 400),
      worktree: wt.worktree?.path ?? null,
      branch: wt.worktree?.branch ?? null,
    };
    log('info', SCOPE, `spawn en ${project.name} → ${data.agentId ?? shortId ?? '(sin id)'}`
      + (squad ? ` [${squad}${lead ? ' lead' : ''}]` : ''));
    return {
      ok: true,
      detail: found
        ? `sesión ${found.callsign} (${found.id})`
        : `lanzado; la sesión no apareció en ${SPAWN_ACK_TIMEOUT_MS / 1000}s, llegará por agent:new`,
      data,
    };
  }

  /**
   * Un agente en su pane.
   *
   * El id de sesión lo elige ORCA (`--session-id`), así que el pane se llama
   * `orca-<id>` antes de que exista y el ack no tiene que adivinar nada: la
   * sesión aparece bajo ese id o no aparece. El env va con `-e` por variable
   * —no hereda el del servidor de tmux, que es el de quien lo arrancó— y el
   * prompt es el último argumento, después de cualquier opción.
   */
  private async spawnPane(
    cmd: Extract<Command, { k: 'spawn' }>, projectName: string, cwd: string,
    prompt: string, opts: string[], squad: string | null, lead: boolean,
  ): Promise<CommandResult> {
    const sessionId = randomUUID();
    const name = paneName(sessionId);
    if (!name || !this.bin) return { ok: false, detail: 'no pude nombrar el pane' };
    // El id lo elige ORCA, así que el worktree puede llevar su nombre desde antes de existir.
    const projectRoot = cwd;
    const wt = await this.worktreeFor(cmd, projectRoot, sessionId.slice(0, 8));
    if (!wt.ok) return { ok: false, detail: wt.detail };
    if (wt.worktree) cwd = wt.worktree.path;

    const env: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM_PROGRAM']) {
      const v = process.env[k];
      if (v) env[k] = v;
    }
    Object.assign(env, this.deps.keys.materialize(cmd.projectId, cmd.parentId ?? 'orca'));
    env['ORCA_SPAWNED'] = '1';
    env['ORCA_PARENT_ID'] = cmd.parentId ?? '';
    env['ORCA_PANE'] = name;

    const since = Date.now();
    // Se anota ANTES de lanzar: el pane puede aparecer antes de que vuelva tmux.
    this.deps.lineage.noteSpawn(sessionId, cmd.parentId, cmd.mission, squad, lead, 'agent', wt.worktree);
    this.deps.lineage.bind(sessionId, sessionId);
    const res = await this.deps.tmux.spawn({
      name, cwd, env, argv: [this.bin, '--session-id', sessionId, ...opts, prompt],
    });
    if (!res.ok) { await this.dropFreshWorktree(projectRoot, wt); return { ok: false, detail: res.detail }; }

    const found = await this.deps.awaitSpawn(
      // Hosted Claude already has a stable identity. A successful tmux launch
      // is enough to acknowledge it; transcript discovery updates the UI later.
      // Waiting up to 8s here serialized that delay across every squad member.
      { shortId: null, sessionId, projectId: cmd.projectId, since }, 0,
    );
    const data: SpawnAck = {
      agentId: found?.id ?? sessionId,
      callsign: found?.callsign ?? null,
      shortId: null,
      stdout: `pane ${name}`,
      worktree: wt.worktree?.path ?? null,
      branch: wt.worktree?.branch ?? null,
    };
    log('info', SCOPE, `spawn en ${projectName} → pane ${name}`
      + (squad ? ` [${squad}${lead ? ' lead' : ''}]` : ''));
    return {
      ok: true,
      detail: found
        ? `sesión ${found.callsign} (${found.id}) en ${name}`
        : `lanzado en ${name}; la sesión aún no escribió su transcript, llegará por agent:new`,
      data,
    };
  }

  /**
   * Codex en su pane.
   *
   * Codex no acepta un id de sesión por adelantado, así que el pane nace con
   * un nombre provisional y se renombra a `orca-<sessionId>` en cuanto el
   * rollout aparece en ~/.codex/sessions: a partir de ahí liveness, terminal,
   * say y stop lo encuentran como a cualquier otro. Si el rollout tarda más
   * que el ack, el renombrado sigue intentándolo en segundo plano.
   */
  private async spawnCodexPane(
    cmd: Extract<Command, { k: 'spawn' }>, projectName: string, cwd: string,
    prompt: string, squad: string | null, lead: boolean,
  ): Promise<CommandResult> {
    const bin = runtimeBin('codex');
    if (!bin) return { ok: false, detail: runtimeNote('codex') };
    const nonce = randomUUID().replace(/-/g, '').slice(0, 12);
    const temp = paneName(`cx-${nonce}`);
    if (!temp) return { ok: false, detail: 'no pude nombrar el pane' };
    // Codex no acepta id previo: el worktree lleva el nonce del pane provisional.
    const projectRoot = cwd;
    const wt = await this.worktreeFor(cmd, projectRoot, `cx-${nonce.slice(0, 8)}`);
    if (!wt.ok) return { ok: false, detail: wt.detail };
    if (wt.worktree) cwd = wt.worktree.path;
    const argv = codexArgv(bin, cwd, { model: cmd.model, permissionMode: cmd.permissionMode, prompt });
    if (!argv.ok) return { ok: false, detail: argv.detail };

    const env = paneEnv(this.deps.keys.materialize(cmd.projectId, cmd.parentId ?? 'orca'));
    env['ORCA_PARENT_ID'] = cmd.parentId ?? '';
    env['ORCA_PANE'] = temp;

    const since = Date.now();
    const res = await this.deps.tmux.spawn({ name: temp, cwd, env, argv: argv.argv });
    if (!res.ok) { await this.dropFreshWorktree(projectRoot, wt); return { ok: false, detail: res.detail }; }

    const want: SpawnLookup = { shortId: null, runtime: 'codex', projectId: cmd.projectId, since };
    const adopt = (found: AgentHandle): void => {
      const name = paneName(found.sessionId);
      if (!name) return;
      this.deps.lineage.noteSpawn(found.sessionId, cmd.parentId, cmd.mission, squad, lead, 'agent', wt.worktree);
      this.deps.lineage.bind(found.sessionId, found.sessionId);
      void this.deps.tmux.rename(temp, name).then((r) => {
        if (!r.ok) log('warn', SCOPE, `no pude renombrar ${temp} → ${name}: ${r.detail}`);
      });
    };
    const found = await this.deps.awaitSpawn(want, SPAWN_ACK_TIMEOUT_MS);
    if (found) adopt(found);
    else {
      // Sigue esperando al rollout sin retener el ack: el proceso YA arrancó.
      void this.deps.awaitSpawn(want, 120_000).then((late) => { if (late) adopt(late); });
    }
    const data: SpawnAck = {
      agentId: found?.id ?? null,
      callsign: found?.callsign ?? null,
      shortId: null,
      stdout: `pane ${found ? paneName(found.sessionId) ?? temp : temp}`,
      worktree: wt.worktree?.path ?? null,
      branch: wt.worktree?.branch ?? null,
    };
    log('info', SCOPE, `spawn codex en ${projectName} → ${found ? paneName(found.sessionId) : temp}`
      + (squad ? ` [${squad}${lead ? ' lead' : ''}]` : ''));
    return {
      ok: true,
      detail: found
        ? `sesión ${found.callsign} (${found.id}) en ${paneName(found.sessionId)}`
        : `lanzado en ${temp}; el rollout de Codex aún no apareció, llegará por agent:new`,
      data,
    };
  }

  /* ── decir / reanudar ─────────────────────────────────────────── */

  private async say(cmd: Extract<Command, { k: 'say' }>): Promise<CommandResult> {
    if (this.models.locked(cmd.agentId)) return { ok: false, detail: 'CAPCOM model selector is open; retry after the change finishes.' };
    const a = this.deps.agent(cmd.agentId);
    if (!a) return { ok: false, detail: `agente desconocido: ${cmd.agentId}` };
    if (!ID_RE.test(a.sessionId)) return { ok: false, detail: 'sessionId inválido' };
    if (typeof cmd.text !== 'string' || !cmd.text.trim()) return { ok: false, detail: 'texto vacío' };
    const cwd = await this.cwdOf(a);
    if (!cwd.ok) return cwd.res;

    if (!a.pane && a.runtime !== 'claude') {
      return { ok: false, detail: `${a.callsign} corre ${a.runtime} fuera de ORCA: sin pane no hay dónde escribirle` };
    }
    // Hospedado: el texto se pega en su prompt, como si lo escribiera el humano.
    // La sesión sigue siendo la misma; nada se bifurca.
    if (a.pane) {
      if (!(await this.deps.tmux.has(a.pane))) return { ok: false, detail: `su pane ${a.pane} ya no existe; /resume lo relanza` };
      const r = await this.deps.tmux.paste(a.pane, cmd.text);
      return r.ok ? { ok: true, detail: `pegado en ${a.pane}` } : { ok: false, detail: r.detail };
    }

    // No hay `claude say`. Continuar la sesión en background con un prompt nuevo
    // ES el canal de entrada de texto que el CLI ofrece hoy.
    // Prompt posicional: con --bg, -p es un error del CLI (ver spawn()).
    if (!this.bin) return { ok: false, detail: 'binario `claude` no disponible' };
    const cap = this.capcomFor(a);
    const res = await run(this.bin, ['--bg', ...(cap?.launchArgs() ?? []), '--resume', a.sessionId, cmd.text], {
      cwd: cwd.path, env: this.envFor(a), timeoutMs: 60_000, detach: true,
    });
    if (res.ok && cap) this.moveCapcom(cap, res.stdout);
    return res.ok
      ? { ok: true, detail: oneLine(res.stdout, 200) }
      : { ok: false, detail: res.detail };
  }

  /* ── interrumpir ──────────────────────────────────────────────── */

  /**
   * Cortar el turno en vuelo y, si viene texto, decir qué hacer en su lugar.
   *
   * Todo lo delicado está en `shared/interrupt.ts`, que es donde se explica
   * por qué el orden de las dos mitades es distinto en cada CLI. Aquí sólo se
   * ejecuta ese plan y se cuenta la verdad de lo que pasó:
   *
   *  - la tecla salió (`sent`) no es que el turno se cortara;
   *  - el turno se cortó (`confirmed`) sólo si el propio CLI lo escribió en su
   *    transcript, que es lo único que no depende de lo que ORCA crea;
   *  - y nada de esto dice que el agente haya LEÍDO el mensaje. Eso no lo dice
   *    ningún transcript, así que no se afirma en ninguna parte.
   *
   * Lo que NO se hace, en ningún camino: matar el pane, mandar Ctrl-C,
   * relanzar la sesión o borrarla. Si no se puede interrumpir, se dice.
   */
  private async interrupt(cmd: Extract<Command, { k: 'interrupt' }>): Promise<CommandResult> {
    const a = this.deps.agent(cmd.agentId);
    if (!a) return { ok: false, detail: `agente desconocido: ${cmd.agentId}` };
    const text = typeof cmd.text === 'string' && cmd.text.trim() ? cmd.text.trim() : null;
    const runtime = a.runtime || 'claude';
    const fail = (o: InterruptOutcome): CommandResult => ({ ok: false, detail: o.detail, data: o });

    const plan = interruptPlan(runtime, a.pane !== null, text !== null);
    if (!plan.ok) {
      return fail({
        ok: false, runtime, interrupt: 'unsupported',
        message: text ? 'unsent' : 'none', evidence: 'none',
        order: [], detail: plan.reason,
      });
    }
    const pane = a.pane!;
    if (!(await this.deps.tmux.has(pane))) {
      return fail({
        ok: false, runtime, interrupt: 'unsupported',
        message: text ? 'unsent' : 'none', evidence: 'none',
        order: [],
        detail: `su pane ${pane} ya no existe: no hay turno que interrumpir. /resume lo relanza.`,
      });
    }

    // Desde ANTES de tocar nada: una marca de interrupción anterior no puede
    // pasar por el acuse de ésta.
    const since = Date.now();
    const order: string[] = [];
    let message: InterruptOutcome['message'] = text ? 'unsent' : 'none';

    const escape = async (): Promise<string | null> => {
      const r = await this.deps.tmux.keys(pane, ['Escape']);
      order.push('escape');
      return r.ok ? null : r.detail;
    };
    const paste = async (): Promise<string | null> => {
      const r = await this.deps.tmux.paste(pane, text!);
      order.push('message');
      return r.ok ? null : r.detail;
    };

    let failed: string | null;
    if (plan.delivery === 'escape-then-message') {
      // Claude Code: cortar primero. El texto pegado antes se quedaría en el
      // compositor de un turno que sigue vivo, y no cancelaría nada.
      failed = await escape();
      if (failed) {
        return fail({
          ok: false, runtime, interrupt: 'failed', message: text ? 'unsent' : 'none',
          evidence: 'none', order, detail: `no pude mandar Escape a ${pane}: ${failed}`,
        });
      }
      if (text) {
        await sleep(plan.settleMs);
        const bad = await paste();
        if (bad) {
          return fail({
            ok: false, runtime, interrupt: 'sent', message: 'unsent', evidence: 'pending',
            order, detail: `interrumpido, pero el mensaje no salió: ${bad}`,
          });
        }
        // Dónde aterrizó no lo dice el paste: lo dice la pantalla. Claude Code
        // recoloca el prompt que acababa de interrumpir, y un texto que llegue
        // en ese momento se le queda en la cola — con lo que el agente lo verá
        // cuando termine, que es justo lo que se quería evitar. Medido.
        message = (await this.pasteLanded(pane)) ? 'pasted' : 'queued';
      }
    } else {
      // Codex: el texto se encola —lo dice su propia TUI— y es el Escape el
      // que lo entrega cortando el turno. Sin cola, el Escape sale igual pero
      // no hay acuse que esperar (plan.confirms === false).
      if (text) {
        const bad = await paste();
        if (bad) {
          return fail({
            ok: false, runtime, interrupt: 'failed', message: 'unsent', evidence: 'none',
            order, detail: `no pude encolar el mensaje en ${pane}: ${bad}`,
          });
        }
        message = 'queued';
        await sleep(plan.settleMs);
      }
      failed = await escape();
      if (failed) {
        return fail({
          ok: false, runtime, interrupt: 'failed',
          message, evidence: 'none',
          detail: `el mensaje quedó en la cola de ${pane} pero el Escape no salió: ${failed}`
            + ' — el CLI lo entregará al terminar el turno, sin interrumpir.',
          order,
        });
      }
    }

    const evidence = plan.confirms
      ? (await this.awaitInterruptMark(a.id, since) ? 'confirmed' : 'pending')
      : 'pending';
    const outcome: InterruptOutcome = {
      ok: true, runtime, interrupt: 'sent', message, evidence, order, detail: '',
    };
    outcome.detail = describeOutcome(outcome)
      + (plan.confirms || evidence === 'confirmed' ? '' : ` ${runtime}: a bare cancel key is not`
        + ' acknowledged by this CLI, so the turn may still be running.');
    return { ok: true, detail: outcome.detail, data: outcome };
  }

  /**
   * ¿El texto entró en el prompt, o en la cola del CLI?
   *
   * Se lee la pantalla porque no hay otra forma: tmux confirma que el buffer
   * salió, no dónde acabó. Si no se puede capturar, se da por bueno el caso
   * normal en vez de inventar una cola que quizá no existe — y el campo
   * `evidence` sigue diciendo lo que se sabe del corte, que es lo que decide.
   */
  private async pasteLanded(pane: string): Promise<boolean> {
    const r = await this.deps.tmux.capture(pane, 12);
    if (!r.ok) return true;
    return !QUEUED_MARK.test(r.stdout);
  }

  /**
   * Espera a que el transcript del agente traiga la marca de interrupción.
   *
   * Es la única evidencia que no se inventa ORCA: la escribe el CLI —
   * `[Request interrupted by user]` en Claude, `turn_aborted` en Codex— y
   * llega por el mismo camino que todo lo demás, el vigilante de transcripts.
   * Sin `interruptedAt` en las deps (un collector de prueba, por ejemplo) no
   * se espera nada y la respuesta dice `pending`, que es lo que se sabe.
   */
  private async awaitInterruptMark(agentId: string, since: number): Promise<boolean> {
    const at = this.deps.interruptedAt;
    if (!at) return false;
    const until = Date.now() + INTERRUPT_EVIDENCE_MS;
    for (;;) {
      if (at(agentId) > since) return true;
      if (Date.now() >= until) return false;
      await sleep(200);
    }
  }

  /** El canal de CAPCOM si este agente lo es, null para todos los demás. */
  private capcomFor(a: AgentHandle | null): CapcomChannel | null {
    const cap = this.deps.capcom;
    // Hospedado se conoce por session id; `--bg` por el short id del CLI.
    return cap && a && (cap.owns(a.shortId) || cap.owns(a.sessionId)) ? cap : null;
  }

  /**
   * Cambiar el modelo y esperar a que el CLI lo confirme.
   *
   * `ModelController` encola y aplica en su propio tick, que es lo correcto
   * para una petición del operador —espera a que el turno acabe— pero aquí
   * hace falta saber que terminó antes de vaciar el contexto. `list` primero,
   * porque `request` sólo acepta un modelo que este CLI haya ofrecido.
   */
  private async applyModel(id: string, model: string): Promise<void> {
    await this.models.list(id);
    this.models.request(id, model);
    for (let i = 0; i < 240; i++) {
      const a = this.deps.agent(id);
      if (!a) throw new Error('CAPCOM disappeared while changing its model.');
      this.models.tick(a);
      const s = this.models.state(a);
      if (s?.phase === 'failed') throw new Error(`Model change failed: ${s.detail}`);
      if (s?.phase === 'ready' && s.active === model) return;
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('The CLI did not confirm the model change. Context was not cleared.');
  }

  /**
   * New CAPCOM: contexto nuevo, y el modelo que se pida.
   *
   * Tres caminos, y el que se toma depende de lo que de verdad cambia:
   *
   *  - **Otro runtime.** Hay que arrancar otro binario, así que se prepara la
   *    sesión de destino, se verifica y sólo entonces se retira la anterior
   *    (`ProviderHandoffs`). Es el caso que justifica todo ese aparato.
   *  - **Otro modelo, mismo runtime.** El selector nativo del CLI lo cambia en
   *    el sitio (`ModelController`), y después se vacía el contexto. Cambiar
   *    primero es deliberado: el modelo pertenece a la sesión, y el relevo debe
   *    nacer ya con el que se pidió, no heredarlo y cambiarlo a continuación.
   *  - **Mismo runtime y modelo.** Sólo hace falta vaciar el contexto.
   *
   * Los dos últimos terminan en `/clear`, que es lo que el propio CLI trae para
   * esto. `ORCA_CAPCOM_PREPARED_RESET=1` los devuelve al camino largo.
   */
  private async freshCapcom(cmd: { agentId: string; mode: 'continuity' | 'clean'; checkpoint?: string; model?: string }): Promise<unknown> {
    const a = this.deps.agent(cmd.agentId);
    if (!a || !this.capcomFor(a)) throw new Error('An active CAPCOM session is required.');
    const current = this.models.state(a)?.active ?? a.model ?? null;
    const model = cmd.model?.trim() || current;
    if (!model) throw new Error('Current CAPCOM model is unknown. No new session was started.');
    const runtime = providerModels().find(m => m.id === model)?.runtime ?? a.runtime;
    // Cruzar de proveedor arranca otro binario: se prepara, se verifica y sólo
    // entonces se retira al anterior. El modo elegido viaja igual — «limpio»
    // sigue siendo limpio —, así que va por `fresh` y no por la revisión
    // manual, que llevaría la conversación entera y dejaría el botón sin hacer
    // lo que dice.
    if (runtime !== a.runtime) return this.handoffs.fresh(cmd.agentId, cmd.mode, cmd.checkpoint, { runtime, model });
    if (preparedReset()) {
      if (model !== current) throw new Error('Choosing a model needs the native reset; unset ORCA_CAPCOM_PREPARED_RESET or change the model first.');
      return this.handoffs.fresh(cmd.agentId, cmd.mode, cmd.checkpoint);
    }
    return this.reset.run(cmd.agentId, cmd.mode, model, cmd.checkpoint ?? '');
  }

  /**
   * El resume devolvió un short id nuevo: ahí está CAPCOM ahora.
   *
   * Si el CLI no imprimió ninguno no se toca nada. Mudar el rol a un id que no
   * conocemos sería peor que no mudarlo: el vigilante del collector daría por
   * muerto al mando y lanzaría un segundo CAPCOM encima del que acaba de
   * contestar.
   */
  private moveCapcom(cap: CapcomChannel, stdout: string): void {
    const next = extractShortId(stdout);
    if (next) cap.adopt(next);
  }

  private async resume(cmd: Extract<Command, { k: 'resume' }>): Promise<CommandResult> {
    if (!this.bin) return { ok: false, detail: 'binario `claude` no disponible' };
    const a = this.deps.agent(cmd.agentId);
    if (!a) return { ok: false, detail: `agente desconocido: ${cmd.agentId}` };
    if (!ID_RE.test(a.sessionId)) return { ok: false, detail: 'sessionId inválido' };
    const cwd = await this.cwdOf(a);
    if (!cwd.ok) return cwd.res;
    const paneOf = a.pane ?? (this.deps.tmux.available() ? paneName(a.sessionId) : null);
    if (paneOf) {
      // Interactivo, `--resume` conserva el id: la sesión vuelve al mismo pane
      // con la misma identidad, que es justo lo que `--bg --resume` no hace.
      if (await this.deps.tmux.has(paneOf)) return { ok: true, detail: `${paneOf} ya está corriendo` };
      const env: Record<string, string> = {};
      for (const k of ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR']) {
        const v = process.env[k];
        if (v) env[k] = v;
      }
      Object.assign(env, this.deps.keys.materialize(a.projectId, a.id));
      env['ORCA_SPAWNED'] = '1';
      env['ORCA_PANE'] = paneOf;
      let argv: string[];
      if (a.runtime === 'codex') {
        const bin = runtimeBin('codex');
        if (!bin) return { ok: false, detail: runtimeNote('codex') };
        argv = [bin, '-C', cwd.path, 'resume', a.sessionId];
        const model = this.models.state(a)?.active; if (model) argv.push('-m', model);
      } else if (a.runtime === 'claude') {
        argv = [this.bin, '--resume', a.sessionId];
        const model = this.models.state(a)?.active; if (model) argv.push('--model', model);
      } else {
        return { ok: false, detail: `no sé reanudar ${a.runtime}` };
      }
      const r = await this.deps.tmux.spawn({ name: paneOf, cwd: cwd.path, env, argv });
      return r.ok ? { ok: true, detail: `reanudado en ${paneOf}` } : { ok: false, detail: r.detail };
    }
    const cap = this.capcomFor(a);
    const res = await run(this.bin, ['--bg', ...(cap?.launchArgs() ?? []), '--resume', a.sessionId], {
      cwd: cwd.path, env: this.envFor(a), timeoutMs: 60_000, detach: true,
    });
    if (res.ok && cap) this.moveCapcom(cap, res.stdout);
    return res.ok
      ? { ok: true, detail: oneLine(res.stdout, 200) }
      : { ok: false, detail: res.detail };
  }

  /* ── stop / rm ────────────────────────────────────────────────── */

  private async simple(agentId: string, verb: string[], what: string): Promise<CommandResult> {
    if (!this.bin) return { ok: false, detail: 'binario `claude` no disponible' };
    const a = this.deps.agent(agentId);
    if (!a) return { ok: false, detail: `agente desconocido: ${agentId}` };
    if (a.pane) {
      if (what !== 'remove') return this.stopPane(a.pane);
      const r = await this.killPane(a.pane);
      if (r.ok) await this.cleanupWorktree(a);
      return r;
    }
    if (a.runtime !== 'claude') return { ok: false, detail: `${a.callsign} corre ${a.runtime} fuera de ORCA: sin pane no se puede parar` };
    const id = a.shortId ?? a.sessionId;
    if (!ID_RE.test(id)) return { ok: false, detail: 'id inválido' };
    if (!a.background && a.shortId === null) {
      return { ok: false, detail: `${what} sólo aplica a sesiones background` };
    }
    const cwd = await this.cwdOf(a);
    const res = await run(this.bin, [...verb, id], {
      cwd: cwd.ok ? cwd.path : home(), env: process.env, timeoutMs: 30_000,
    });
    if (res.ok && what === 'remove') await this.cleanupWorktree(a);
    return res.ok
      ? { ok: true, detail: oneLine(res.stdout, 200) }
      : { ok: false, detail: res.detail };
  }

  /* ── worktrees ────────────────────────────────────────────────── */

  /**
   * El worktree de un spawn, o ninguno.
   *
   * Sólo con ORCA_WORKTREES=1 en este collector: sin la variable la flota
   * sigue corriendo sobre el working tree del proyecto exactamente como hoy.
   * `cmd.worktree` con nombre es un worktree compartido (el de un escuadrón);
   * `false` deja a este spawn fuera aunque la variable esté puesta.
   */
  private async worktreeFor(
    cmd: Extract<Command, { k: 'spawn' }>, projectRoot: string, ownName: string,
  ): Promise<{ ok: true; worktree: WorktreeInfo | null; fresh: boolean } | { ok: false; detail: string }> {
    if (!worktreesEnabled() || cmd.worktree === false) return { ok: true, worktree: null, fresh: false };
    const name = typeof cmd.worktree === 'string' && cmd.worktree ? cmd.worktree : ownName;
    if (!WORKTREE_NAME_RE.test(name)) return { ok: false, detail: `nombre de worktree inválido: ${oneLine(name, 40)}` };
    const r = await createWorktree(projectRoot, name);
    if (!r.ok) return { ok: false, detail: `worktree: ${r.detail}` };
    return { ok: true, worktree: r.worktree, fresh: !r.reused };
  }

  /** El proceso no arrancó: un worktree recién creado para él no tiene dueño y se tira. */
  private async dropFreshWorktree(projectRoot: string, wt: { worktree: WorktreeInfo | null; fresh: boolean }): Promise<void> {
    if (!wt.worktree || !wt.fresh) return;
    const r = await discardWorktree(projectRoot, wt.worktree, { force: true });
    if (!r.ok) log('warn', SCOPE, `no pude tirar el worktree huérfano ${wt.worktree.path}: ${r.detail}`);
  }

  /**
   * Aterrizar lo que hizo un worker. El ack es `ok` en cuanto el comando corrió;
   * si aterrizó o no lo dice `data` (un LandResult), porque un conflicto es
   * una respuesta que CAPCOM tiene que leer, no un fallo del collector.
   */
  private async land(cmd: Extract<Command, { k: 'land' }>): Promise<CommandResult> {
    const a = this.deps.agent(cmd.agentId);
    if (!a) return { ok: false, detail: `agente desconocido: ${cmd.agentId}` };
    if (!a.worktree) return { ok: false, detail: `${a.callsign} no corre en un worktree propio: no hay rama que aterrizar` };
    const project = this.deps.projects.get(a.projectId);
    if (!project) return { ok: false, detail: 'proyecto desconocido' };
    const root = path.resolve(project.path);
    const allowed = launchable(root);
    if (!allowed.ok) return { ok: false, detail: allowed.why };
    const message = typeof cmd.message === 'string' && cmd.message.trim() ? cmd.message : null;
    const out = await landWorktree(root, a.worktree, {
      callsign: a.callsign, mission: a.mission ?? null, message, runTests: cmd.runTests !== false,
    });
    const detail = out.ok
      ? `${a.callsign}: ${a.worktree.branch} → ${out.projectBranch} @ ${out.commit.slice(0, 8)} (${out.files.length} archivos)`
      : `${a.callsign}: no aterrizado (${out.reason}): ${out.detail}`;
    log(out.ok ? 'info' : 'warn', SCOPE, `land ${detail}`);
    return { ok: true, detail, data: out };
  }

  private async discard(cmd: Extract<Command, { k: 'discard' }>): Promise<CommandResult> {
    const a = this.deps.agent(cmd.agentId);
    if (!a) return { ok: false, detail: `agente desconocido: ${cmd.agentId}` };
    if (!a.worktree) return { ok: false, detail: `${a.callsign} no corre en un worktree propio: nada que tirar` };
    const project = this.deps.projects.get(a.projectId);
    if (!project) return { ok: false, detail: 'proyecto desconocido' };
    const root = path.resolve(project.path);
    const allowed = launchable(root);
    if (!allowed.ok) return { ok: false, detail: allowed.why };
    const out = await discardWorktree(root, a.worktree, { force: cmd.force === true });
    if (out.ok) this.deps.lineage.clearWorktree(a.worktree.path);
    return { ok: true, detail: `${a.callsign}: ${out.detail}`, data: out };
  }

  /**
   * Un worker que se va (rm, archivado) se lleva su worktree SI no hay nada
   * que perder: aterrizado o sin cambios. Con trabajo sin aterrizar se queda,
   * y quien quiera tirarlo lo dice con `discard` y `force`. Nunca falla el
   * comando que lo llamó: es limpieza, no la operación.
   */
  private async cleanupWorktree(a: AgentHandle): Promise<void> {
    if (!a.worktree) return;
    const project = this.deps.projects.get(a.projectId);
    if (!project) return;
    try {
      const out = await discardWorktree(path.resolve(project.path), a.worktree, { force: false });
      if (out.ok) this.deps.lineage.clearWorktree(a.worktree.path);
      else log('info', SCOPE, `worktree de ${a.callsign} se queda: ${out.detail}`);
    } catch (err) {
      log('warn', SCOPE, `limpiando el worktree de ${a.callsign}: ${errText(err)}`);
    }
  }

  /**
   * Parar a un agente hospedado: dos Ctrl-C, que es como se sale del CLI a
   * mano, y si el pane sigue ahí pasados unos segundos, se mata. El transcript
   * queda; `resume` lo trae de vuelta al mismo pane con el mismo id.
   */
  private async stopPane(pane: string): Promise<CommandResult> {
    const tmux = this.deps.tmux;
    if (!(await tmux.has(pane))) return { ok: true, detail: `${pane} ya no existía` };
    const first = await tmux.keys(pane, ['C-c']);
    if (!first.ok) return { ok: false, detail: first.detail };
    await sleep(300);
    await tmux.keys(pane, ['C-c']);
    const t = setTimeout(() => {
      void tmux.has(pane).then((alive) => { if (alive) void tmux.kill(pane); });
    }, 6_000);
    t.unref?.();
    return { ok: true, detail: `interrumpido ${pane}; si no sale solo, se cierra en 6s` };
  }

  private async killPane(pane: string): Promise<CommandResult> {
    const r = await this.deps.tmux.kill(pane);
    return r.ok ? { ok: true, detail: `cerrado ${pane}` } : { ok: false, detail: r.detail };
  }

  private async logs(cmd: Extract<Command, { k: 'logs' }>): Promise<CommandResult> {
    if (!this.bin) return { ok: false, detail: 'binario `claude` no disponible' };
    const a = this.deps.agent(cmd.agentId);
    if (!a) return { ok: false, detail: `agente desconocido: ${cmd.agentId}` };
    const wanted = Math.max(1, Math.min(2000, Math.floor(cmd.lines) || 200));
    if (a.pane) {
      // La pantalla del pane, sin escapes: tmux ya la tiene compuesta.
      const r = await this.deps.tmux.capture(a.pane, wanted);
      if (!r.ok) return { ok: false, detail: r.detail };
      const lines = r.stdout.replace(/\s+$/, '').split('\n').slice(-wanted);
      return { ok: true, data: { lines } };
    }
    if (a.runtime !== 'claude') return { ok: false, detail: `${a.callsign} corre ${a.runtime} fuera de ORCA: sin pane no hay pantalla que leer` };
    const id = a.shortId;
    if (!id || !ID_RE.test(id)) {
      return { ok: false, detail: 'sin short id: `claude logs` sólo lee sesiones background' };
    }
    const cwd = await this.cwdOf(a);
    const res = await run(this.bin, ['logs', id], {
      cwd: cwd.ok ? cwd.path : home(), env: process.env, timeoutMs: 30_000,
    });
    if (!res.ok) return { ok: false, detail: res.detail };
    // Sin limpiar, treinta lineas utiles llegan como cien kilobytes de escapes
    // de terminal y fotogramas de spinner.
    const lines = stripAnsi(res.stdout).split('\n').slice(-wanted);
    return { ok: true, data: { lines } };
  }

  /* ── permisos ─────────────────────────────────────────────────── */

  /** Unbound permission commands cannot identify the request the operator reviewed. */
  private async permit(cmd: Extract<Command, { k: 'permit' }>): Promise<CommandResult> {
    return { ok: false, detail: 'Use answer_agent with the current permission escalation_id; unbound permit is disabled' };
  }

  /* ── escalaciones ─────────────────────────────────────────────── */

  private async answer(cmd: Extract<Command, { k: 'answer' }>): Promise<CommandResult> {
    if (typeof cmd.answer !== 'string' || !cmd.answer.length) {
      return { ok: false, detail: 'respuesta vacía' };
    }
    // Una escalación de permisos no es un archivo en .orca/ask: es un diálogo
    // en una pantalla. La levantó el collector y la contesta el collector.
    const perm = this.deps.permissions?.get(cmd.escalationId);
    if (perm) {
      return this.deps.permissions!.answer(cmd.escalationId, cmd.answer);
    }
    const ok = await this.deps.escalations.answer(cmd.escalationId, cmd.answer, cmd.rememberAs);
    return ok
      ? { ok: true }
      : { ok: false, detail: `escalación desconocida: ${cmd.escalationId}` };
  }

  /* ── mensajes entre agentes ───────────────────────────────────── */

  /**
   * Deja un mensaje en el buzón de entrada del destinatario.
   *
   * Misma postura que `spawn`: la ruta NO viene del hub. Viene del agente, del
   * agente sale su proyecto, y del registro de proyectos sale la ruta — una que
   * el collector descubrió él mismo en ~/.claude/projects. Un hub comprometido
   * no puede nombrar un directorio donde escribir; a lo sumo puede nombrar un
   * agente que existe, y el peor daño posible es un JSON en el `.orca/in/` de un
   * repo del propio usuario.
   */
  private async deliver(cmd: Extract<Command, { k: 'deliver' }>): Promise<CommandResult> {
    const a = this.deps.agent(cmd.agentId);
    if (!a) return { ok: false, detail: `agente desconocido: ${cmd.agentId}` };
    const msg = cmd.message as AgentMessage | undefined;
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string' || !msg.id) {
      return { ok: false, detail: 'mensaje malformado' };
    }
    if (typeof msg.subject !== 'string' || !msg.subject) {
      return { ok: false, detail: 'mensaje sin subject' };
    }
    const cwd = await this.cwdOf(a);
    if (!cwd.ok) return cwd.res;
    return await this.deps.messages.deliverTo(cwd.path, msg, a.id);
  }

  /** Cierra un `ask`: la respuesta llega al buzón del que preguntó. */
  private async reply(cmd: Extract<Command, { k: 'reply' }>): Promise<CommandResult> {
    if (typeof cmd.messageId !== 'string' || !cmd.messageId) {
      return { ok: false, detail: 'messageId vacío' };
    }
    if (typeof cmd.answer !== 'string' || !cmd.answer.trim()) {
      return { ok: false, detail: 'respuesta vacía' };
    }
    // El autor de la respuesta, si viene, tiene que ser un agente que ORCA está
    // mirando: `answeredBy` acaba en la consola y en el disco del que preguntó.
    let by: string | null = null;
    if (cmd.fromAgentId) {
      const from = this.deps.agent(cmd.fromAgentId);
      if (!from) return { ok: false, detail: `agente desconocido: ${cmd.fromAgentId}` };
      by = from.id;
    }
    return await this.deps.messages.reply(cmd.messageId, cmd.answer, by);
  }

  /* ── artefactos ───────────────────────────────────────────────── */

  /**
   * Los bytes de algo que el collector ya registró.
   *
   * Ojo con lo que NO hay aquí: una ruta. El hub nombra un id, y la lista
   * blanca es el propio índice de artefactos — sólo archivos que este proceso
   * vio aparecer o que un agente publicó desde su proyecto. Un hub comprometido
   * no puede convertir esto en "léeme ~/.ssh/id_rsa".
   */
  private async artifactRead(cmd: Extract<Command, { k: 'artifact:read' }>): Promise<CommandResult> {
    if (typeof cmd.artifactId !== 'string' || !cmd.artifactId) {
      return { ok: false, detail: 'artifactId vacío' };
    }
    return await this.deps.artifacts.read(cmd.artifactId);
  }

  /* ── keys ─────────────────────────────────────────────────────── */

  private keySet(cmd: Extract<Command, { k: 'key:set' }>): CommandResult {
    if (!this.deps.projects.get(cmd.projectId)) {
      return { ok: false, detail: `proyecto desconocido: ${cmd.projectId}` };
    }
    // El nombre acaba como variable de entorno de un hijo: sólo forma de env var.
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(cmd.name)) {
      return { ok: false, detail: `nombre de key inválido: ${cmd.name}` };
    }
    if (typeof cmd.value !== 'string' || !cmd.value.length) {
      return { ok: false, detail: 'valor vacío' };
    }
    const d = this.deps.keys.set(cmd.projectId, cmd.name, cmd.value);
    this.deps.onKeysChanged();
    // Devolvemos el descriptor, jamás el valor.
    return { ok: true, data: d };
  }

  private keyRemove(cmd: Extract<Command, { k: 'key:remove' }>): CommandResult {
    const ok = this.deps.keys.remove(cmd.projectId, cmd.name);
    if (ok) this.deps.onKeysChanged();
    return ok ? { ok: true } : { ok: false, detail: 'no existía' };
  }

  /* ── helpers ──────────────────────────────────────────────────── */

  private envFor(a: AgentHandle): NodeJS.ProcessEnv {
    return { ...process.env, ...this.deps.keys.materialize(a.projectId, a.id) };
  }

  private async cwdOf(
    a: AgentHandle,
  ): Promise<{ ok: true; path: string } | { ok: false; res: CommandResult }> {
    // CAPCOM: su directorio se conoce de primera mano. Resolverlo desde el
    // slug es justo lo que falló —`~/.orca/capcom` codifica el punto como
    // guión— y dejó al mando sin poder recibir ni una línea.
    const capDir = this.capcomFor(a)?.dir() ?? null;
    if (capDir) {
      if (!isDir(capDir)) return { ok: false, res: { ok: false, detail: `el directorio de CAPCOM no existe: ${capDir}` } };
      return { ok: true, path: capDir };
    }
    const project = this.deps.projects.get(a.projectId);
    if (!project) return { ok: false, res: { ok: false, detail: 'proyecto desconocido' } };
    const cwd = path.resolve(project.path);
    const allowed = launchable(cwd);
    if (!allowed.ok) return { ok: false, res: { ok: false, detail: allowed.why } };
    if (!isDir(cwd)) {
      return { ok: false, res: { ok: false, detail: `la ruta no existe: ${cwd}` } };
    }
    return { ok: true, path: cwd };
  }
}

/* ── argv por runtime ─────────────────────────────────────────────── */

/** Lo que un pane hereda del collector, más las keys del proyecto. */
export function paneEnv(keys: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM_PROGRAM']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  Object.assign(env, keys);
  env['ORCA_SPAWNED'] = '1';
  return env;
}

/**
 * `codex` interactivo, con la postura de permisos de ORCA traducida a la suya.
 *
 *   auto               → ni aprobaciones ni sandbox (ver abajo)
 *   acceptEdits        → pregunta cuando el modelo lo decide, escribe en el workspace
 *   plan               → sólo lectura
 *   manual             → como acceptEdits: `untrusted` ya no existe (ver abajo)
 *   dontAsk            → nunca pregunta, pero conserva el sandbox
 *   bypassPermissions  → lo mismo que `auto`, pedido explícitamente
 *
 * ── Por qué `auto` es distinto en Codex y en Claude ────────────────
 *
 * Medido el 2026-09-07 con codex-cli 0.153.4: el sandbox de Codex corta la red
 * (`codex sandbox -- curl https://example.com` devuelve 000). Un worker con un
 * MCP de navegador dentro de ese sandbox no navega, y `-a never` no lo salva:
 * en vez de preguntar devuelve el fallo al modelo, que reintenta. Entre parar
 * la flota ante diálogos que nadie contesta y lanzar sin sandbox, ORCA elige lo
 * segundo para Codex y lo dice aquí. `ORCA_CODEX_APPROVALS=1` devuelve la
 * postura anterior (`-a on-request -s workspace-write`) sin tocar código.
 *
 * Claude no cambia: su `auto` resuelve solo y no deja prompts colgados.
 *
 * ── `manual` ───────────────────────────────────────────────────────
 *
 * Era `-a untrusted`. En 0.153.4 `-a` sólo acepta `on-request` y `never`, así
 * que ese argv lo rechaza el CLI antes de arrancar — un spawn que fallaba en el
 * lanzamiento, no en la política. La postura más cercana que queda es la de
 * `acceptEdits`; la granularidad perdida vive ahora en los permission profiles
 * de Codex, que ORCA todavía no usa.
 *
 * El prompt va POSICIONAL y al final, después de toda opción: `-C`, `-m` y las
 * de política no son variádicas, pero el orden fijo evita tener que saberlo.
 */
/**
 * El título del pane, como canal de estado.
 *
 * `activity` es el elemento que pinta «spinner mientras trabaja, mensaje de
 * acción requerida mientras está bloqueado», y es lo que `titleSignal` lee para
 * saber que un worker espera respuesta sin tener que entender su diálogo. Se
 * fuerza en el argv porque el default vive en el `config.toml` del operador y
 * ORCA no puede quedarse sin la señal porque alguien reordenara su título.
 *
 * `project` va detrás para que el título siga sirviéndole a un humano que mire
 * la lista de panes. Un elemento que una versión futura no reconozca lo ignora
 * Codex con un aviso, sin fallar el arranque: comprobado en 0.153.4.
 */
export const CODEX_TITLE_CONFIG = 'tui.terminal_title=["activity","project"]';

export function codexArgv(
  bin: string, cwd: string,
  o: { model?: string | undefined; permissionMode?: string | undefined; prompt: string },
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; argv: string[] } | { ok: false; detail: string } {
  const argv = [bin, '-C', cwd, '-c', CODEX_TITLE_CONFIG];
  if (o.model) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(o.model)) return { ok: false, detail: `modelo inválido: ${o.model}` };
    argv.push('-m', o.model);
  }
  const unsandboxed = '--dangerously-bypass-approvals-and-sandbox';
  switch (o.permissionMode) {
    case undefined: case 'auto':
      if (env['ORCA_CODEX_APPROVALS'] === '1') argv.push('-a', 'on-request', '-s', 'workspace-write');
      else argv.push(unsandboxed);
      break;
    case 'acceptEdits': case 'manual': argv.push('-a', 'on-request', '-s', 'workspace-write'); break;
    case 'plan': argv.push('-s', 'read-only'); break;
    case 'dontAsk': argv.push('-a', 'never', '-s', 'workspace-write'); break;
    case 'bypassPermissions': argv.push(unsandboxed); break;
    default: return { ok: false, detail: `permissionMode inválido: ${o.permissionMode}` };
  }
  if (o.prompt.startsWith('-')) {
    // Un prompt que empieza por guion sería una opción para clap; un espacio delante lo salva sin cambiar su sentido.
    argv.push(` ${o.prompt}`);
  } else {
    argv.push(o.prompt);
  }
  return { ok: true, argv };
}

/* ── ejecución sin shell ──────────────────────────────────────────── */

interface RunOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** El hijo debe sobrevivir al collector (agentes en background). */
  detach?: boolean;
}

interface RunResult { ok: boolean; stdout: string; stderr: string; detail: string; }

function run(bin: string, args: string[], opts: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: RunResult): void => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,          // ← la línea que hace segura a toda esta clase
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        /*
         * Un agente en background tiene que sobrevivir al collector. Sin
         * detached hereda su grupo de procesos, así que reiniciar el collector
         * —o pararlo con Ctrl-C, que manda la señal a todo el grupo— se llevaba
         * por delante a todos los agentes que hubiera lanzado. Eso vacía de
         * sentido la palabra "background".
         *
         * Sólo para los comandos que lanzan trabajo; una consulta corta como
         * `claude agents` no lo necesita y detachearla complicaría su limpieza.
         */
        detached: opts.detach === true,
      });
    } catch (err) {
      done({ ok: false, stdout: '', stderr: '', detail: errText(err) });
      return;
    }
    let stdout = '', stderr = '';
    const cap = 1024 * 1024;
    child.stdout?.on('data', (c: Buffer) => {
      if (stdout.length < cap) stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < cap) stderr += c.toString('utf8');
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ya murió */ }
      done({ ok: false, stdout, stderr, detail: `timeout tras ${opts.timeoutMs}ms` });
    }, opts.timeoutMs);
    timer.unref?.();
    // Que el proceso del collector pueda terminar sin esperar al hijo.
    if (opts.detach) child.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, stdout, stderr, detail: errText(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({
        ok: code === 0,
        stdout, stderr,
        detail: code === 0 ? '' : `salió con ${code}: ${oneLine(stderr || stdout, 300)}`,
      });
    });
  });
}

/** Busca `claude` recorriendo el PATH a mano: nunca delegamos en un shell. */
export function resolveClaudeBin(): string | null {
  const override = process.env['ORCA_CLAUDE_BIN'];
  if (override) return isExec(override) ? override : null;
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  // El instalador nativo cae aquí y no siempre está en el PATH de un daemon.
  dirs.push(path.join(home(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin');
  for (const d of dirs) {
    const p = path.join(d, 'claude');
    if (isExec(p)) return p;
  }
  return null;
}

function isExec(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * `claude --bg` imprime el short id de la sesión. No fijamos un formato exacto
 * porque es salida humana: buscamos el último token hexadecimal aislado, que es
 * la forma que tienen los ids en ~/.claude/jobs (p.ej. "e065a5f6").
 */
/**
 * Quita las secuencias de escape de un volcado de terminal.
 *
 * `claude logs` devuelve exactamente lo que se pintó en la pantalla: colores,
 * saltos de cursor y cientos de fotogramas de un spinner. Sin limpiarlo, un
 * `logs` de treinta líneas llega a la consola como cien kilobytes de basura
 * ilegible. Esto deja el texto que un humano querría leer.
 */
export function stripAnsi(text: string): string {
  return text
    // CSI, OSC y escapes de un solo carácter
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    // Retornos de carro que sólo existían para repintar la misma línea
    .replace(/\r(?!\n)/g, '\n')
    /*
     * Se descartan las líneas sin una sola letra ni dígito. El residuo de un
     * repintado de terminal —spinners, reglas, marcos— no tiene palabras, y
     * doscientos glifos de spinner colapsan en una única línea larguísima que
     * un filtro por longitud deja pasar. "Contiene algo legible" es el criterio
     * correcto, y conserva una línea de sólo puntuación si alguna vez importa
     * (no lo hace: nunca es salida de un agente).
     */
    .split('\n')
    .filter((l) => /[\p{L}\p{N}]/u.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractShortId(stdout: string): string | null {
  const tokens = stdout.match(/\b[0-9a-f]{8}\b/g);
  if (tokens && tokens.length > 0) return tokens[tokens.length - 1]!;
  const loose = stdout.match(/\b[0-9a-f]{6,12}\b/g);
  return loose && loose.length > 0 ? loose[loose.length - 1]! : null;
}
