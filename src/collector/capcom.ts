/**
 * CAPCOM's life on one machine.
 *
 * The fleet's command used to be a model loop inside the hub, paying the API
 * per turn. CAPCOM is the same job done by a CLI session — Claude Code today,
 * anything that speaks MCP tomorrow — launched here, in its own directory,
 * with three files that are its entire configuration:
 *
 *   ~/.orca/capcom/CLAUDE.md              its brief (briefs.ts, `capcomBrief`)
 *   ~/.orca/capcom/.mcp.json              the hub, as an MCP server, token and all
 *   ~/.orca/capcom/.claude/settings.json  the same posture, for a human who opens it
 *
 * That is the whole trick. The session runs on the operator's subscription and
 * its tools arrive over HTTP from the hub, so the command layer costs nothing
 * per turn and is not tied to any one vendor's SDK.
 *
 * ── One, and only one ──────────────────────────────────────────────
 *
 * A collector runs at most one CAPCOM. Two would be two minds triaging the same
 * question, and the console would not know whose transcript is the command
 * window. So the short id is written to disk and re-adopted after a restart:
 * a collector coming back up finds the CAPCOM it already had instead of
 * launching a second one.
 *
 * ── And it must come back ──────────────────────────────────────────
 *
 * A dead CAPCOM is a fleet with no command, and it looks exactly like a quiet
 * one: nothing errors, questions simply stop being answered until the hub's
 * deadline pushes each of them at the human. So death is detected (the session
 * stops being listed) and answered with a relaunch — 30 s apart, at most five
 * an hour. The cap matters: a CAPCOM that cannot start, retried in a tight
 * loop, is a process bomb, and after five tries the honest thing is to say so
 * in the feed and let a person look.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { FeedLevel } from '../shared/types.ts';
import { capcomBrief } from './briefs.ts';
import { extractShortId } from './commands.ts';
import type { LineageIndex } from './lineage.ts';
import { errText, log, oneLine, orcaDir } from './util.ts';

const SCOPE = 'capcom';

/** Shown as the session's name in `claude agents` and on the console tile. */
export const CAPCOM_NAME = 'CAPCOM';

/** Recorded as its mission, so the console can say what the session is for. */
export const CAPCOM_MISSION =
  'ORCA fleet command: survey, brief, unblock, and absorb the fleet\'s questions.';

/** How long after a death before trying again. */
export const CAPCOM_RESTART_MS = 30_000;
/** Past this many relaunches in an hour, stop and tell the human. */
export const CAPCOM_MAX_RESTARTS_PER_HOUR = 5;
/**
 * How long a freshly adopted session is believed in without proof.
 *
 * Liveness comes from `claude agents --json`, polled every few seconds, so a
 * session that started a moment ago is genuinely not listed yet. Without this
 * window the watchdog would call it dead and launch a second CAPCOM — and the
 * worst case is not the first launch but every message afterwards, since a
 * `--bg --resume` adopts a brand-new id each time. One duplicate per sentence
 * the human types.
 */
export const CAPCOM_GRACE_MS = 60_000;

/**
 * The first thing CAPCOM is told.
 *
 * Deliberately one small task with a visible result: it proves the MCP link
 * works on the very first turn, and it leaves a line in the console instead of
 * a session that booted and sat there.
 */
export const CAPCOM_FIRST_PROMPT =
  'You are online. Call list_fleet on the `orca` MCP server and report the fleet in one line.';

/** The name of the hub's MCP server, as CAPCOM's tools are prefixed with it. */
export const MCP_SERVER = 'orca';

/**
 * The tools CAPCOM is not allowed to have.
 *
 * The CEO doctrine, made enforceable rather than merely written down: CAPCOM
 * commands a fleet, it does not edit repos. If it wants something changed it
 * spawns an agent with a real brief — which is both safer and better work than
 * a commander quietly fixing things itself.
 */
export const DENIED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit'];

/** Where CAPCOM lives. `ORCA_CAPCOM_DIR` moves it; `ORCA_HOME` moves it too. */
export function capcomDir(): string {
  return process.env['ORCA_CAPCOM_DIR'] ?? path.join(orcaDir(), 'capcom');
}

/**
 * ws:// → http://, because a collector is configured with the socket URL and
 * the MCP endpoint is the same host over plain HTTP. Getting this wrong is a
 * CAPCOM that starts fine and has no tools, which is the worst kind of broken:
 * silent.
 */
export function hubHttpUrl(wsUrl: string): string {
  const base = process.env['ORCA_HUB_HTTP'] ?? wsUrl;
  return base
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://')
    .replace(/\/ws\/collector\/?$/, '')
    .replace(/\/+$/, '');
}

/**
 * The MCP config Claude Code reads from the working directory.
 *
 * The token rides in the query string because that is the only place a
 * `.mcp.json` entry can carry it — the file has no field for a header the CLI
 * should send. The hub accepts it there for exactly this reason, and the file
 * is written 0600 in a directory that is already 0700.
 */
export function mcpConfigJson(hubHttp: string, token: string): string {
  const url = `${hubHttp}/mcp${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  return JSON.stringify({ mcpServers: { orca: { type: 'http', url } } }, null, 2) + '\n';
}

/**
 * Settings for a human who opens this directory.
 *
 * The launched session does NOT depend on this file: an untrusted workspace —
 * and a directory ORCA just created is always untrusted — makes the CLI
 * discard `permissions.allow` from a project settings file, and a background
 * session has nobody to accept a trust dialog. So the real permissions travel
 * in the argv (see `launch`), and this file exists so that `claude` run by
 * hand in `~/.orca/capcom` behaves the same way as the session ORCA starts:
 * same server approved, same tools off the table.
 */
export function capcomSettingsJson(): string {
  return JSON.stringify({
    enableAllProjectMcpServers: true,
    permissions: {
      allow: [`mcp__${MCP_SERVER}`],
      deny: DENIED_TOOLS,
    },
  }, null, 2) + '\n';
}

/* ── the session ──────────────────────────────────────────────────── */

export interface CapcomLaunch {
  ok: boolean;
  shortId: string | null;
  detail: string;
}

export interface CapcomDeps {
  /** The resolved `claude` binary, or null when this machine has none. */
  bin: string | null;
  /** The collector's hub URL, ws or http. Converted with `hubHttpUrl`. */
  hubUrl: string;
  token: string;
  /** So the launched session is marked `role: 'capcom'` and survives a restart. */
  lineage: Pick<LineageIndex, 'noteSpawn'>;
  /** Is that short id still a session this machine is running? */
  alive(shortId: string): boolean;
  note(level: FeedLevel, text: string): void;
  dir?: string;
  now?(): number;
  /** Swapped in tests, so nothing real is ever launched. */
  launch?(bin: string, args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; detail: string }>;
}

export class CapcomSession {
  readonly dir: string;
  private deps: CapcomDeps;
  private now: () => number;
  /** The session we believe is CAPCOM, or null when there is none. */
  private shortId: string | null = null;
  /** epoch ms of every relaunch in the last hour. The cap reads this. */
  private restarts: number[] = [];
  /** Do not try again before this. */
  private nextTry = 0;
  /** When the current session was adopted. Feeds the grace window. */
  private adoptedAt = 0;
  private starting = false;
  private gaveUp = false;

  constructor(deps: CapcomDeps) {
    this.deps = deps;
    this.dir = deps.dir ?? capcomDir();
    this.now = deps.now ?? (() => Date.now());
  }

  /** The short id of the live CAPCOM, or null. */
  current(): string | null { return this.shortId; }

  /* ── configuration on disk ──────────────────────────────────────── */

  /**
   * Write the three files CAPCOM boots from, every time.
   *
   * Rewritten on each start rather than only when missing, because the token
   * and the hub's port can both change between runs and a stale `.mcp.json` is
   * a CAPCOM with no tools. The brief is rewritten too: it is the product, it
   * changes, and a session started tomorrow should get today's version.
   */
  writeConfig(): void {
    const hub = hubHttpUrl(this.deps.hubUrl);
    fs.mkdirSync(path.join(this.dir, '.claude'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.dir, 'CLAUDE.md'), capcomBrief(), { mode: 0o600 });
    // 0600: this one has the hub token in it.
    fs.writeFileSync(path.join(this.dir, '.mcp.json'), mcpConfigJson(hub, this.deps.token), { mode: 0o600 });
    fs.writeFileSync(path.join(this.dir, '.claude', 'settings.json'), capcomSettingsJson(), { mode: 0o600 });
  }

  /** Where the short id is remembered, so a collector restart re-adopts it. */
  private statePath(): string { return path.join(this.dir, 'session.json'); }

  private loadState(): string | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath(), 'utf8')) as { shortId?: unknown };
      return typeof raw.shortId === 'string' && raw.shortId ? raw.shortId : null;
    } catch { return null; }
  }

  private saveState(shortId: string | null): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.statePath(), JSON.stringify({ shortId, at: this.now() }, null, 2),
        { mode: 0o600 });
    } catch (err) {
      log('warn', SCOPE, `no pude guardar session.json: ${errText(err)}`);
    }
  }

  /* ── lifecycle ──────────────────────────────────────────────────── */

  /**
   * Make sure there is exactly one CAPCOM running.
   *
   * Adopts the one from a previous run when it is still alive — that is the
   * whole reason the short id is on disk — and only launches when there is
   * nothing to adopt.
   */
  async ensure(): Promise<CapcomLaunch> {
    if (this.starting) return { ok: true, shortId: this.shortId, detail: 'ya arrancando' };

    const remembered = this.shortId ?? this.loadState();
    if (remembered && this.deps.alive(remembered)) {
      const fresh = this.shortId !== remembered;
      // Por `adopt` y no a mano: pone el reloj de gracia y vuelve a apuntar el
      // rol en el linaje. Sin el reloj, el vigilante puede declarar muerta a los
      // diez segundos una sesión que acaba de adoptar —`claude agents` tarda en
      // listarla— y a partir de ahí el canal de CAPCOM deja de reconocerla: lo
      // que escriba el humano llegaría como un `say` cualquiera, sin sus tools.
      this.adopt(remembered);
      if (fresh) this.deps.note('info', `CAPCOM ya estaba vivo (${remembered}), lo adopto`);
      return { ok: true, shortId: remembered, detail: 'sesión existente adoptada' };
    }
    return await this.launch();
  }

  /**
   * Called on a timer. Notices a dead CAPCOM and brings it back.
   *
   * The `alive` check is the collector's own liveness map, which is the same
   * source the console reads — so "CAPCOM is gone" here means exactly what it
   * means on screen, and never disagrees with it.
   */
  check(): void {
    if (this.starting) return;
    if (this.shortId && this.deps.alive(this.shortId)) return;
    // Too young to be declared dead: the CLI has not listed it yet.
    if (this.shortId && this.now() - this.adoptedAt < CAPCOM_GRACE_MS) return;
    if (this.shortId) {
      this.deps.note('warn', `CAPCOM (${this.shortId}) se cayó`);
      this.shortId = null;
      this.saveState(null);
      // Its death starts the clock; do not relaunch in the same tick.
      this.nextTry = Math.max(this.nextTry, this.now() + CAPCOM_RESTART_MS);
      return;
    }
    if (this.gaveUp) return;
    if (this.now() < this.nextTry) return;
    void this.ensure();
  }

  private withinCap(): boolean {
    const cutoff = this.now() - 3600_000;
    this.restarts = this.restarts.filter((t) => t >= cutoff);
    return this.restarts.length < CAPCOM_MAX_RESTARTS_PER_HOUR;
  }

  private async launch(): Promise<CapcomLaunch> {
    if (!this.deps.bin) {
      const detail = 'no encontré el binario `claude`: no puedo arrancar CAPCOM';
      this.deps.note('warn', detail);
      return { ok: false, shortId: null, detail };
    }
    if (!this.withinCap()) {
      if (!this.gaveUp) {
        this.gaveUp = true;
        this.deps.note('alert',
          `CAPCOM murió ${CAPCOM_MAX_RESTARTS_PER_HOUR} veces en una hora: dejo de relanzarlo. `
          + `Mira ${this.dir} y arranca a mano cuando esté arreglado.`);
      }
      return { ok: false, shortId: null, detail: 'tope de relanzamientos alcanzado' };
    }

    this.starting = true;
    this.nextTry = this.now() + CAPCOM_RESTART_MS;
    try {
      this.writeConfig();
    } catch (err) {
      this.starting = false;
      const detail = `no pude escribir la configuración en ${this.dir}: ${errText(err)}`;
      this.deps.note('warn', detail);
      return { ok: false, shortId: null, detail };
    }

    const args = ['--bg', ...this.launchArgs(), CAPCOM_FIRST_PROMPT];

    const runner = this.deps.launch ?? runDetached;
    const res = await runner(this.deps.bin, args, this.dir);
    this.starting = false;
    this.restarts.push(this.now());

    if (!res.ok) {
      this.deps.note('warn', `CAPCOM no arrancó: ${oneLine(res.detail, 160)}`);
      return { ok: false, shortId: null, detail: res.detail };
    }

    const shortId = extractShortId(res.stdout);
    if (!shortId) {
      // El proceso arrancó pero no sabemos nombrarlo: no lo damos por vivo, o
      // creeríamos tener mando cuando no podemos ni comprobarlo.
      this.deps.note('warn', 'CAPCOM arrancó pero el CLI no imprimió un id: no puedo vigilarlo');
      return { ok: false, shortId: null, detail: oneLine(res.stdout, 200) };
    }

    this.adopt(shortId);
    this.deps.note('info', `CAPCOM arrancó (${shortId}) en ${this.dir}`);
    log('info', SCOPE, `CAPCOM ${shortId} en ${this.dir}`);
    return { ok: true, shortId, detail: oneLine(res.stdout, 200) };
  }

  /* ── el canal de entrada ────────────────────────────────────────── */

  /** ¿Es ésta la sesión CAPCOM? Se pregunta por short id, que es lo que el CLI nombra. */
  owns(shortId: string | null): boolean {
    return shortId !== null && shortId === this.shortId;
  }

  /**
   * Esta sesión es CAPCOM a partir de ahora.
   *
   * Se llama al arrancarla y —esto es lo importante— cada vez que se le habla:
   * `claude --bg --resume <sessionId>` NO continúa bajo el mismo id, arrastra la
   * conversación entera a una sesión NUEVA (medido contra el CLI 2.1.261). Sin
   * mover el rol con ella, el primer mensaje del humano dejaría a la flota sin
   * mando: el hub buscaría un `role:'capcom'` vivo, encontraría la sesión vieja
   * ya terminada, y el collector relanzaría un CAPCOM desde cero.
   */
  adopt(shortId: string): void {
    this.adoptedAt = this.now();
    if (this.shortId === shortId) return;
    this.shortId = shortId;
    this.deps.lineage.noteSpawn(shortId, null, CAPCOM_MISSION, null, false, 'capcom');
    this.saveState(shortId);
  }

  /**
   * Las opciones que TODA invocación de CAPCOM necesita — la primera y cada
   * mensaje que se le manda después.
   *
   * Viven en un solo sitio porque olvidarlas en el camino de `say` es el fallo
   * silencioso perfecto: la sesión arranca, lee su brief, y descubre que no
   * tiene ninguna herramienta con la que hacer nada de lo que dice.
   */
  launchArgs(): string[] {
    /*
     * El argv, y por qué está en este orden exacto.
     *
     * (1) Los permisos van en la LÍNEA DE COMANDOS, no sólo en settings.json.
     *     Medido contra el CLI 2.1.261: un directorio recién creado no está en
     *     la lista de workspaces de confianza, y entonces el CLI descarta las
     *     entradas de `permissions.allow` del settings del proyecto —"Ignoring
     *     1 permissions.allow entry: this workspace has not been trusted"—. Una
     *     sesión en background no tiene a nadie que acepte el diálogo de
     *     confianza, así que el settings sería un permiso que nunca aplica.
     *     `--allowedTools` y `--disallowedTools` no pasan por esa puerta.
     *
     * (2) `--strict-mcp-config` con `--mcp-config`: CAPCOM carga el servidor
     *     `orca` y NADA más. Sin esto hereda los servidores MCP del usuario,
     *     que pueden pedir autenticación y le cuestan una vuelta descubriendo
     *     que no puede usarlos.
     *
     * (3) Cada opción VARIÁDICA —`--mcp-config`, `--allowedTools`,
     *     `--disallowedTools`— va seguida de otra opción, nunca del prompt. Una
     *     variádica se come todo lo que venga detrás hasta el siguiente `-`, y
     *     con `--bg` el prompt es posicional: colocarlo tras una de ellas sería
     *     un CAPCOM que arranca sin instrucción ninguna.
     */
    return [
      '--mcp-config', path.join(this.dir, '.mcp.json'),
      '--strict-mcp-config',
      '--allowedTools', `mcp__${MCP_SERVER}`,
      '--disallowedTools', ...DENIED_TOOLS,
      '--permission-mode', 'acceptEdits',
      '--settings', path.join(this.dir, '.claude', 'settings.json'),
      '--name', CAPCOM_NAME,
    ];
  }
}

/* ── ejecución ────────────────────────────────────────────────────── */

/**
 * Lanza el CLI sin shell y desatado del collector.
 *
 * `shell: false` y argv como array, igual que en commands.ts y por la misma
 * razón: no existe interpolación, así que no existe inyección. `detached` es lo
 * que hace que reiniciar el collector no se lleve por delante al mando de la
 * flota.
 */
function runDetached(
  bin: string, args: string[], cwd: string,
): Promise<{ ok: boolean; stdout: string; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: boolean; stdout: string; detail: string }): void => {
      if (!settled) { settled = true; resolve(r); }
    };
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: true,
      });
    } catch (err) {
      done({ ok: false, stdout: '', detail: errText(err) });
      return;
    }
    let stdout = '', stderr = '';
    child.stdout?.on('data', (c: Buffer) => { if (stdout.length < 65_536) stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { if (stderr.length < 65_536) stderr += c.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ya murió */ }
      done({ ok: false, stdout, detail: 'timeout de 60s arrancando CAPCOM' });
    }, 60_000);
    timer.unref?.();
    child.unref();
    child.on('error', (err) => { clearTimeout(timer); done({ ok: false, stdout, detail: errText(err) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({
        ok: code === 0,
        stdout,
        detail: code === 0 ? '' : `salió con ${code}: ${oneLine(stderr || stdout, 300)}`,
      });
    });
  });
}
