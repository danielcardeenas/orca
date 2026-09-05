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
import { runtimeNote, runtimeReady } from './runtime.ts';
import fs from 'node:fs';
import path from 'node:path';

import type { Command, SpawnAck } from '../shared/protocol.ts';
import { SPAWN_ACK_TIMEOUT_MS } from '../shared/protocol.ts';
import { squadName } from '../shared/squads.ts';
import type { AgentMessage } from '../shared/types.ts';
import { squadBrief, withBrief } from './briefs.ts';
import type { ArtifactIndex } from './artifacts.ts';
import type { EscalationWatcher } from './escalate.ts';
import type { KeyVault } from './keys.ts';
import type { LineageIndex } from './lineage.ts';
import type { MessageWatcher } from './messages.ts';
import type { ProjectRegistry } from './projects.ts';
import { errText, home, isInside, launchable, log, oneLine } from './util.ts';

const SCOPE = 'commands';

/** Modos que `claude --permission-mode` acepta de verdad (CLI 2.1.260). */
const PERMISSION_MODES = new Set([
  'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan',
]);

/** Un id de sesión/short id sólo puede ser esto. Corta cualquier argv raro. */
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

export interface AgentHandle {
  id: string;
  projectId: string;
  sessionId: string;
  shortId: string | null;
  background: boolean;
  alive: boolean;
  /** La etiqueta que la consola enseña, p.ej. "K9". */
  callsign: string;
}

/** Qué sesión buscar tras un spawn. Ver `CommandDeps.awaitSpawn`. */
export interface SpawnLookup {
  /** El short id que imprimió el CLI, cuando lo imprimió. */
  shortId: string | null;
  projectId: string;
  /** epoch ms justo antes de lanzar: descarta sesiones que ya existían. */
  since: number;
}

export interface CommandDeps {
  projects: ProjectRegistry;
  keys: KeyVault;
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
}

/** Lo que `commands.ts` necesita saber de CAPCOM. Lo implementa capcom.ts. */
export interface CapcomChannel {
  /** ¿Es este short id la sesión CAPCOM? */
  owns(shortId: string | null): boolean;
  /** Las opciones que toda invocación suya necesita: MCP, permisos, nombre. */
  launchArgs(): string[];
  /** El resume creó una sesión nueva: el rol se muda a ella. */
  adopt(shortId: string): void;
}

export interface CommandResult {
  ok: boolean;
  detail?: string;
  data?: unknown;
}

export class CommandRunner {
  private readonly deps: CommandDeps;
  private readonly bin: string | null;

  constructor(deps: CommandDeps) {
    this.deps = deps;
    this.bin = resolveClaudeBin();
    if (!this.bin) {
      log('warn', SCOPE, 'no encontré el binario `claude` en PATH: spawn/stop/logs no funcionarán');
    } else {
      log('info', SCOPE, `binario permitido: ${this.bin}`);
    }
  }

  async execute(cmd: Command): Promise<CommandResult> {
    try {
      switch (cmd.k) {
        case 'spawn': return await this.spawn(cmd);
        case 'say': return await this.say(cmd);
        case 'permit': return this.permit(cmd);
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
        default: {
          // Exhaustividad: si protocol.ts crece, esto deja de compilar.
          const never: never = cmd;
          return { ok: false, detail: `comando desconocido: ${JSON.stringify(never)}` };
        }
      }
    } catch (err) {
      log('error', SCOPE, `${cmd.k} lanzó: ${errText(err)}`);
      return { ok: false, detail: errText(err) };
    }
  }

  /* ── spawn ────────────────────────────────────────────────────── */

  private async spawn(cmd: Extract<Command, { k: 'spawn' }>): Promise<CommandResult> {
    // Un runtime que este collector no sabe conducir se rechaza con el porqué,
    // en vez de lanzar `claude` y fingir que era Codex.
    if (!runtimeReady(cmd.runtime)) return { ok: false, detail: runtimeNote(cmd.runtime) };
    if (!this.bin) return { ok: false, detail: 'binario `claude` no disponible' };
    const project = this.deps.projects.get(cmd.projectId);
    if (!project) return { ok: false, detail: `proyecto desconocido: ${cmd.projectId}` };

    const cwd = path.resolve(project.path);
    const allowed = launchable(cwd);
    if (!allowed.ok) return { ok: false, detail: allowed.why };
    if (!isDir(cwd)) return { ok: false, detail: `la ruta del proyecto no existe: ${cwd}` };
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
    const args: string[] = [];
    if (cmd.background) args.push('--bg');
    if (cmd.model) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(cmd.model)) {
        return { ok: false, detail: `modelo inválido: ${cmd.model}` };
      }
      args.push('--model', cmd.model);
    }
    if (cmd.permissionMode) {
      if (!PERMISSION_MODES.has(cmd.permissionMode)) {
        return { ok: false, detail: `permissionMode inválido: ${cmd.permissionMode}` };
      }
      args.push('--permission-mode', cmd.permissionMode);
    }
    const name = oneLine(cmd.mission, 60);
    if (name) args.push('--name', name);

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

    const since = Date.now();
    const res = await run(this.bin, args, { cwd, env, timeoutMs: 60_000, detach: true });
    if (!res.ok) return { ok: false, detail: res.detail };

    const shortId = extractShortId(res.stdout);
    if (shortId) {
      // Anotamos el linaje ANTES de contárselo al hub: si el collector muere en
      // el siguiente instante, el padre ya quedó persistido en disco.
      this.deps.lineage.noteSpawn(shortId, cmd.parentId, cmd.mission, squad, lead);
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

  /* ── decir / reanudar ─────────────────────────────────────────── */

  private async say(cmd: Extract<Command, { k: 'say' }>): Promise<CommandResult> {
    if (!this.bin) return { ok: false, detail: 'binario `claude` no disponible' };
    const a = this.deps.agent(cmd.agentId);
    if (!a) return { ok: false, detail: `agente desconocido: ${cmd.agentId}` };
    if (!ID_RE.test(a.sessionId)) return { ok: false, detail: 'sessionId inválido' };
    if (typeof cmd.text !== 'string' || !cmd.text.trim()) return { ok: false, detail: 'texto vacío' };
    const cwd = await this.cwdOf(a);
    if (!cwd.ok) return cwd.res;

    // No hay `claude say`. Continuar la sesión en background con un prompt nuevo
    // ES el canal de entrada de texto que el CLI ofrece hoy.
    // Prompt posicional: con --bg, -p es un error del CLI (ver spawn()).
    const cap = this.capcomFor(a);
    const res = await run(this.bin, ['--bg', ...(cap?.launchArgs() ?? []), '--resume', a.sessionId, cmd.text], {
      cwd: cwd.path, env: this.envFor(a), timeoutMs: 60_000, detach: true,
    });
    if (res.ok && cap) this.moveCapcom(cap, res.stdout);
    return res.ok
      ? { ok: true, detail: oneLine(res.stdout, 200) }
      : { ok: false, detail: res.detail };
  }

  /** El canal de CAPCOM si este agente lo es, null para todos los demás. */
  private capcomFor(a: AgentHandle): CapcomChannel | null {
    const cap = this.deps.capcom;
    return cap && cap.owns(a.shortId) ? cap : null;
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
    const id = a.shortId ?? a.sessionId;
    if (!ID_RE.test(id)) return { ok: false, detail: 'id inválido' };
    if (!a.background && a.shortId === null) {
      return { ok: false, detail: `${what} sólo aplica a sesiones background` };
    }
    const cwd = await this.cwdOf(a);
    const res = await run(this.bin, [...verb, id], {
      cwd: cwd.ok ? cwd.path : home(), env: process.env, timeoutMs: 30_000,
    });
    return res.ok
      ? { ok: true, detail: oneLine(res.stdout, 200) }
      : { ok: false, detail: res.detail };
  }

  private async logs(cmd: Extract<Command, { k: 'logs' }>): Promise<CommandResult> {
    if (!this.bin) return { ok: false, detail: 'binario `claude` no disponible' };
    const a = this.deps.agent(cmd.agentId);
    if (!a) return { ok: false, detail: `agente desconocido: ${cmd.agentId}` };
    const id = a.shortId;
    if (!id || !ID_RE.test(id)) {
      return { ok: false, detail: 'sin short id: `claude logs` sólo lee sesiones background' };
    }
    const cwd = await this.cwdOf(a);
    const res = await run(this.bin, ['logs', id], {
      cwd: cwd.ok ? cwd.path : home(), env: process.env, timeoutMs: 30_000,
    });
    if (!res.ok) return { ok: false, detail: res.detail };
    const wanted = Math.max(1, Math.min(2000, Math.floor(cmd.lines) || 200));
    // Sin limpiar, treinta lineas utiles llegan como cien kilobytes de escapes
    // de terminal y fotogramas de spinner.
    const lines = stripAnsi(res.stdout).split('\n').slice(-wanted);
    return { ok: true, data: { lines } };
  }

  /* ── permisos ─────────────────────────────────────────────────── */

  private permit(cmd: Extract<Command, { k: 'permit' }>): CommandResult {
    const a = this.deps.agent(cmd.agentId);
    if (!a) return { ok: false, detail: `agente desconocido: ${cmd.agentId}` };
    // Claude Code 2.1.260 no expone ninguna forma de contestar un prompt de
    // permisos desde fuera del proceso: no hay subcomando ni archivo de control.
    // Ver docs/CONTRACT-REQUESTS.md. Fallar explícito es mejor que fingir.
    return {
      ok: false,
      detail: 'el CLI no expone respuesta remota a prompts de permisos; '
        + 'usa `claude attach` o relanza con --permission-mode',
    };
  }

  /* ── escalaciones ─────────────────────────────────────────────── */

  private async answer(cmd: Extract<Command, { k: 'answer' }>): Promise<CommandResult> {
    if (typeof cmd.answer !== 'string' || !cmd.answer.length) {
      return { ok: false, detail: 'respuesta vacía' };
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
