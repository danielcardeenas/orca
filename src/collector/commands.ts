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
 *     fuera del home del usuario.
 *  4. Las credenciales sólo entran al env del hijo, y sólo las del proyecto.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Command } from '../shared/protocol.ts';
import type { EscalationWatcher } from './escalate.ts';
import type { KeyVault } from './keys.ts';
import type { LineageIndex } from './lineage.ts';
import type { ProjectRegistry } from './projects.ts';
import { errText, home, isInside, log, oneLine } from './util.ts';

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
}

export interface CommandDeps {
  projects: ProjectRegistry;
  keys: KeyVault;
  lineage: LineageIndex;
  escalations: EscalationWatcher;
  /** Sólo devuelve agentes que ORCA está observando ahora mismo. */
  agent(id: string): AgentHandle | null;
  onResync(): void;
  onKeysChanged(): void;
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
        case 'key:set': return this.keySet(cmd);
        case 'key:remove': return this.keyRemove(cmd);
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
    if (!this.bin) return { ok: false, detail: 'binario `claude` no disponible' };
    const project = this.deps.projects.get(cmd.projectId);
    if (!project) return { ok: false, detail: `proyecto desconocido: ${cmd.projectId}` };

    const cwd = path.resolve(project.path);
    if (!isInside(home(), cwd)) {
      return { ok: false, detail: `ruta fuera del home del usuario: ${cwd}` };
    }
    if (!isDir(cwd)) return { ok: false, detail: `la ruta del proyecto no existe: ${cwd}` };
    if (typeof cmd.prompt !== 'string' || cmd.prompt.trim().length === 0) {
      return { ok: false, detail: 'prompt vacío' };
    }
    if (cmd.prompt.length > 100_000) return { ok: false, detail: 'prompt absurdamente largo' };

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
    args.push('-p', cmd.prompt);

    const env = {
      ...process.env,
      ...this.deps.keys.materialize(cmd.projectId, cmd.parentId ?? 'orca'),
      ORCA_SPAWNED: '1',
      ORCA_PARENT_ID: cmd.parentId ?? '',
    };

    const res = await run(this.bin, args, { cwd, env, timeoutMs: 60_000 });
    if (!res.ok) return { ok: false, detail: res.detail };

    const shortId = extractShortId(res.stdout);
    if (shortId) {
      // Anotamos el linaje ANTES de contárselo al hub: si el collector muere en
      // el siguiente instante, el padre ya quedó persistido en disco.
      this.deps.lineage.noteSpawn(shortId, cmd.parentId, cmd.mission);
    }
    log('info', SCOPE, `spawn en ${project.name} → ${shortId ?? '(sin id)'}`);
    return {
      ok: true,
      detail: shortId ? `sesión ${shortId}` : 'lanzado',
      data: { shortId, stdout: oneLine(res.stdout, 400) },
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
    const res = await run(this.bin, ['--bg', '--resume', a.sessionId, '-p', cmd.text], {
      cwd: cwd.path, env: this.envFor(a), timeoutMs: 60_000,
    });
    return res.ok
      ? { ok: true, detail: oneLine(res.stdout, 200) }
      : { ok: false, detail: res.detail };
  }

  private async resume(cmd: Extract<Command, { k: 'resume' }>): Promise<CommandResult> {
    if (!this.bin) return { ok: false, detail: 'binario `claude` no disponible' };
    const a = this.deps.agent(cmd.agentId);
    if (!a) return { ok: false, detail: `agente desconocido: ${cmd.agentId}` };
    if (!ID_RE.test(a.sessionId)) return { ok: false, detail: 'sessionId inválido' };
    const cwd = await this.cwdOf(a);
    if (!cwd.ok) return cwd.res;
    const res = await run(this.bin, ['--bg', '--resume', a.sessionId], {
      cwd: cwd.path, env: this.envFor(a), timeoutMs: 60_000,
    });
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
    const lines = res.stdout.split('\n').slice(-wanted);
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
    if (!isInside(home(), cwd)) {
      return { ok: false, res: { ok: false, detail: `ruta fuera del home: ${cwd}` } };
    }
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
export function extractShortId(stdout: string): string | null {
  const tokens = stdout.match(/\b[0-9a-f]{8}\b/g);
  if (tokens && tokens.length > 0) return tokens[tokens.length - 1]!;
  const loose = stdout.match(/\b[0-9a-f]{6,12}\b/g);
  return loose && loose.length > 0 ? loose[loose.length - 1]! : null;
}
