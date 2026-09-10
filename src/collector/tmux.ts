/**
 * tmux: where a hosted agent lives.
 *
 * A session ORCA launches "in a pane" is an ordinary interactive CLI running
 * inside a tmux session on ORCA's own server socket (`-L orca`). That buys
 * four things the detached `--bg` job cannot give:
 *
 *  - it survives the collector: tmux is its own daemon, so restarting ORCA
 *    does not kill a fleet, and neither does closing the laptop lid;
 *  - it can be looked at and typed into — `attach()` hands back a pty the
 *    console streams (see term.ts), and any number of consoles can attach;
 *  - "say" is a paste into a live prompt, not `--bg --resume`, which forks
 *    the session under a new id (docs/CONTRACT-REQUESTS.md §24);
 *  - the same substrate hosts any CLI: Codex is `codex` in a pane, not a
 *    second launcher.
 *
 * Security posture, same as commands.ts: never a shell. tmux gets an argv
 * array and, given several arguments, execs it directly — measured on 3.7:
 * an argument `x;y z` reaches the program intact as one argv[0]. The one
 * token tmux still parses after `--` is a bare `;` (its command separator),
 * so `spawn()` refuses an argv containing exactly that. Session names are
 * derived from ids and validated; nothing user-typed ever becomes a tmux
 * argument except through `-l`/buffers, which are literal by contract.
 */

import { promptOn } from './screen.ts';
import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import { errText, home, log, oneLine, orcaDir } from './util.ts';

const SCOPE = 'tmux';
const requireCjs = createRequire(import.meta.url);

/** Server socket name: ORCA's sessions never mix with the human's tmux. */
export const TMUX_SOCKET = 'orca';
/** Every pane ORCA creates is `orca-<sessionId>`; the id is the CLI's session id. */
const NAME_PREFIX = 'orca-';
const NAME_RE = /^orca-[A-Za-z0-9_-]{4,72}$/;
/** A fresh pane's geometry: what a laptop console attaches at, roughly. */
export const DEFAULT_COLS = 160;
export const DEFAULT_ROWS = 45;

export interface PaneSpawn {
  name: string;
  cwd: string;
  /** Sent with `-e` per variable, so the pane gets exactly this and not the tmux server's env. */
  env: Record<string, string>;
  /** Program and arguments; never joined, never quoted. */
  argv: string[];
  cols?: number;
  rows?: number;
}

export interface PaneInfo {
  name: string;
  pid: number | null;
  /** The program exited but the pane was kept (remain-on-exit). Not used today; reported anyway. */
  dead: boolean;
  /** Clients attached right now — consoles looking at it. */
  clients: number;
}

export interface TmuxResult { ok: boolean; stdout: string; detail: string }

/** A pty handle, shaped like node-pty's IPty but narrowed to what term.ts uses. */
export interface PaneTty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}

/** A live subscription to a pane's output events. */
export interface OutputWatch { close(): void }

/** What one line from a control-mode client means to us; null for the rest. */
export type ControlLine = { kind: 'output'; pane: string } | { kind: 'exit' } | null;

/**
 * `%output %12 <escaped bytes>` and `%exit [reason]` are the two lines that
 * matter. `%begin`/`%end` blocks, `%session-changed`, `%layout-change` and
 * the rest are noise for this purpose.
 */
export function parseControlLine(line: string): ControlLine {
  if (line.startsWith('%output ')) {
    const sp = line.indexOf(' ', 8);
    return { kind: 'output', pane: sp < 0 ? line.slice(8) : line.slice(8, sp) };
  }
  if (line === '%exit' || line.startsWith('%exit ')) return { kind: 'exit' };
  return null;
}

export function paneName(sessionId: string): string | null {
  const n = `${NAME_PREFIX}${sessionId}`;
  return NAME_RE.test(n) ? n : null;
}

export function sessionIdOfPane(name: string): string | null {
  return NAME_RE.test(name) ? name.slice(NAME_PREFIX.length) : null;
}

/**
 * El comando EXACTO que pone a una persona delante de ese pane.
 *
 * Lleva `-L orca` porque las sesiones de ORCA viven en su propio socket y no
 * en el de por defecto: un operador que teclea `tmux ls` para encontrar a un
 * agente colgado obtiene «no server running», que es peor que no decir nada.
 * Pasó el 2026-09-08 y por eso esto es una función y no una plantilla suelta:
 * todo texto que ORCA imprima sobre cómo llegar a un pane sale de aquí.
 *
 * `=name` exige igualdad exacta, igual que el resto de targets de este módulo.
 */
export function attachHint(pane: string, socket = TMUX_SOCKET): string {
  return `tmux -L ${socket} attach -t =${pane}`;
}

/**
 * `PATH` no viaja por `-e`, y las demás variables sí.
 *
 * Medido contra tmux 3.7c el 2026-09-08, servidor recién arrancado:
 *
 *   tmux -L x new-session -d -e "PATH=/tmp/ZZZ:$PATH" -e ORCA_PROBE=yes -- sh -c 'echo $PATH; echo $ORCA_PROBE'
 *   → ORCA_PROBE=yes                    llega
 *   → PATH sin /tmp/ZZZ                 NO llega: el proceso inicial hereda el
 *                                       PATH del servidor de tmux, no el de la
 *                                       sesión.
 *
 * Y es justo la variable que hace falta: los comandos `orca-*` que el brief
 * promete se le dan al worker poniéndolos en su PATH (ver `shims.ts`). Así que
 * el PATH se pasa donde tmux no lo puede reescribir, delante del argv, con
 * `env` — que exec-a en el sitio, así que el pane sigue siendo el CLI y su pid
 * no cambia. Sigue sin haber shell: `env` recibe un argv, no una línea.
 *
 * Sin `/usr/bin/env` no se toca nada: el worker arranca con el PATH del
 * servidor, que es lo que hacía antes.
 */
function withPath(value: string | undefined): string[] {
  if (!value) return [];
  try { fs.accessSync(ENV_BIN, fs.constants.X_OK); } catch { return []; }
  return [ENV_BIN, `PATH=${value}`];
}

const ENV_BIN = '/usr/bin/env';

export class TmuxHost {
  readonly bin: string | null;
  readonly socket: string;
  private readonly conf: string;
  private serverReady = false;
  private pastes = new Map<string, Promise<TmuxResult>>();
  /** node-pty, loaded lazily: the collector must run on a machine without it. */
  private ptyMod: { spawn: (file: string, args: string[], opts: Record<string, unknown>) => PaneTty } | null | undefined;

  constructor(socket = TMUX_SOCKET, bin = resolveTmuxBin()) {
    this.bin = bin;
    this.socket = socket;
    this.conf = path.join(orcaDir(), 'tmux.conf');
    if (this.bin) log('info', SCOPE, `tmux: ${this.bin} (socket ${this.socket})`);
    else log('info', SCOPE, 'tmux no está: los agentes se lanzan con --bg y no hay TERMINAL');
  }

  available(): boolean { return this.bin !== null; }

  /** `attachHint`, con el socket de ESTA instancia. Ver esa función. */
  attachHint(pane: string): string { return attachHint(pane, this.socket); }

  /* ── sessions ──────────────────────────────────────────────────── */

  async spawn(p: PaneSpawn): Promise<TmuxResult> {
    if (!this.bin) return { ok: false, stdout: '', detail: 'tmux no disponible' };
    if (!NAME_RE.test(p.name)) return { ok: false, stdout: '', detail: `nombre de pane inválido: ${p.name}` };
    if (!p.argv.length) return { ok: false, stdout: '', detail: 'argv vacío' };
    if (p.argv.some((a) => a === ';')) {
      // El único token que tmux sigue interpretando después de `--`.
      return { ok: false, stdout: '', detail: 'un argumento no puede ser exactamente ";"' };
    }
    await this.ensureServer();
    const args = ['new-session', '-d', '-s', p.name,
      '-x', String(p.cols ?? DEFAULT_COLS), '-y', String(p.rows ?? DEFAULT_ROWS),
      '-c', p.cwd];
    for (const [k, v] of Object.entries(p.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      args.push('-e', `${k}=${v}`);
    }
    args.push('--', ...withPath(p.env['PATH']), ...p.argv);
    return this.run(args, 20_000);
  }

  /*
   * Targets. `=name` exige igualdad de nombre de sesión —sin él `-t orca-ab`
   * casa con orca-abc—, y los comandos que apuntan a un PANE (paste, keys,
   * capture) necesitan además el `:` que dice "la ventana de esa sesión":
   * medido en 3.7, `-t =name` a secas es "can't find pane".
   */
  async has(name: string): Promise<boolean> {
    if (!this.bin || !NAME_RE.test(name)) return false;
    const r = await this.run(['has-session', '-t', `=${name}`], 5_000);
    return r.ok;
  }

  /** Every pane on ORCA's server. Cheap: one `list-sessions`. */
  async list(): Promise<Map<string, PaneInfo>> {
    const out = new Map<string, PaneInfo>();
    if (!this.bin) return out;
    const r = await this.run(['list-sessions', '-F', '#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{session_attached}'], 5_000);
    if (!r.ok) return out;       // sin servidor: "no server running" → ninguna
    for (const line of r.stdout.split('\n')) {
      const [name = '', pid = '', dead = '', att = ''] = line.split('\t');
      if (!NAME_RE.test(name)) continue;
      out.set(name, {
        name,
        pid: /^\d+$/.test(pid) ? Number(pid) : null,
        dead: dead === '1',
        clients: /^\d+$/.test(att) ? Number(att) : 0,
      });
    }
    return out;
  }

  /**
   * Type text into the pane as one paste, then Enter.
   *
   * A paste, not `send-keys -l`: multi-line text has to land as ONE message.
   * Bracketed paste (`-p`) is what tells the CLI the newlines are content, not
   * three submissions; every CLI ORCA hosts speaks it.
   */
  async paste(name: string, text: string): Promise<TmuxResult> {
    const previous = this.pastes.get(name);
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.pasteNow(name, text));
    this.pastes.set(name, next);
    try { return await next; }
    finally { if (this.pastes.get(name) === next) this.pastes.delete(name); }
  }

  private async pasteNow(name: string, text: string): Promise<TmuxResult> {
    if (!this.bin) return { ok: false, stdout: '', detail: 'tmux no disponible' };
    if (!NAME_RE.test(name)) return { ok: false, stdout: '', detail: 'nombre de pane inválido' };
    const buf = `orca-say-${randomUUID()}`;
    const set = await this.run(['set-buffer', '-b', buf, '--', text], 5_000);
    if (!set.ok) return set;
    const paste = await this.run(['paste-buffer', '-p', '-d', '-b', buf, '-t', `=${name}:`], 5_000);
    if (!paste.ok) return paste;
    /*
     * Un respiro entre el paste y el Enter. El CLI procesa el paste en su
     * siguiente vuelta de eventos; un Enter pegado al mismo write llega a veces
     * DENTRO del bracketed paste y se queda como salto de línea del texto.
     */
    await new Promise((r) => setTimeout(r, 120));
    return this.keys(name, ['Enter']);
  }

  /** Named keys (`C-c`, `Enter`, `Escape`), never text: `-l` is what `paste` is for. */
  async keys(name: string, keys: string[]): Promise<TmuxResult> {
    if (!this.bin) return { ok: false, stdout: '', detail: 'tmux no disponible' };
    if (!NAME_RE.test(name)) return { ok: false, stdout: '', detail: 'nombre de pane inválido' };
    if (!keys.length || keys.some((k) => !/^[A-Za-z0-9-]{1,12}$/.test(k))) {
      return { ok: false, stdout: '', detail: 'tecla inválida' };
    }
    // tmux 3.7 otherwise picks the most recent attached client, even from
    // another session, and rejects keys if that observer is read-only.
    // An explicit empty -c resolves to no client (CMD_CLIENT_CANFAIL); -t
    // still selects the validated pane. Never borrow a viewer's permissions.
    return this.run(['send-keys', '-c', '', '-t', `=${name}:`, ...keys], 5_000);
  }

  /**
   * A pane born before its session had an id (Codex does not take one up
   * front) is renamed once the rollout shows up, so liveness and the terminal
   * find it under `orca-<sessionId>` like everyone else.
   */
  async rename(from: string, to: string): Promise<TmuxResult> {
    if (!this.bin) return { ok: false, stdout: '', detail: 'tmux no disponible' };
    if (!NAME_RE.test(from) || !NAME_RE.test(to)) return { ok: false, stdout: '', detail: 'nombre de pane inválido' };
    return this.run(['rename-session', '-t', `=${from}`, to], 5_000);
  }

  async kill(name: string): Promise<TmuxResult> {
    if (!this.bin) return { ok: false, stdout: '', detail: 'tmux no disponible' };
    if (!NAME_RE.test(name)) return { ok: false, stdout: '', detail: 'nombre de pane inválido' };
    return this.run(['kill-session', '-t', `=${name}`], 5_000);
  }

  /** Stop this socket's server and every session on it. Tests only; ORCA never kills its own. */
  async killServer(): Promise<TmuxResult> {
    if (!this.bin) return { ok: false, stdout: '', detail: 'tmux no disponible' };
    return this.run(['kill-server'], 5_000);
  }

  /**
   * Be told whenever a pane paints, without reading it.
   *
   * A control-mode client (`tmux -C attach`) gets one `%output` line per chunk
   * the pane writes, and `%exit` when the session goes. It is a client like
   * any other except that tmux ignores it for sizing — measured: a 104x27 pane
   * stays 104x27 with one attached — and it never draws. It is the event the
   * live transcript wants: read the screen when it changed, not on a clock.
   *
   * The data in `%output` is deliberately ignored. It is raw terminal bytes
   * with cursor moves; making sense of it means emulating a terminal, and a
   * `capture-pane` after the event is 4 ms and already correct.
   *
   * Returns null when there is no tmux or the name is not ours. `exit` fires
   * once, for whatever reason the client ended — never after `close()`.
   */
  watchOutput(name: string, on: { output: () => void; exit: (reason: string) => void }): OutputWatch | null {
    if (!this.bin || !NAME_RE.test(name)) return null;
    let child: ReturnType<typeof spawnChild>;
    try {
      child = spawnChild(this.bin, ['-L', this.socket, '-C', 'attach-session', '-t', `=${name}`], {
        cwd: home(), env: minimalEnv(), shell: false,
        // stdin stays open: a control client whose input ends detaches.
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (err) {
      log('debug', SCOPE, `control client for ${name}: ${errText(err)}`);
      return null;
    }
    let buf = '';
    let closed = false;
    const finish = (reason: string): void => {
      if (closed) return;
      closed = true;
      try { child.kill(); } catch { /* ya */ }
      on.exit(reason);
    };
    child.stdout?.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const p = parseControlLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (!p) continue;
        if (p.kind === 'output') on.output(); else finish('la sesión terminó');
      }
      // Una línea sin fin de línea durante mucho tiempo no es tmux: se acota.
      if (buf.length > 1024 * 1024) buf = buf.slice(-65_536);
    });
    child.stderr?.on('data', () => { /* nada que decir: el cierre lo cuenta */ });
    child.on('error', (err) => finish(errText(err)));
    child.on('close', (code) => finish(`el cliente de control salió con ${code}`));
    return {
      close() {
        if (closed) return;
        closed = true;
        try { child.stdin?.end(); } catch { /* ya */ }
        try { child.kill(); } catch { /* ya */ }
      },
    };
  }

  /** The last `lines` of the pane as plain text — what LOGS shows for a hosted agent. */
  async capture(name: string, lines: number): Promise<TmuxResult> {
    if (!this.bin) return { ok: false, stdout: '', detail: 'tmux no disponible' };
    if (!NAME_RE.test(name)) return { ok: false, stdout: '', detail: 'nombre de pane inválido' };
    const n = Math.max(1, Math.min(5000, Math.floor(lines) || 200));
    // -J une las líneas que el ancho del pane partió; sin -e no hay escapes.
    return this.run(['capture-pane', '-p', '-J', '-t', `=${name}:`, '-S', `-${n}`], 10_000);
  }

  /**
   * Visible screen only; never include scrollback when recognizing a live dialog.
   *
   * El título del pane viaja con la identidad porque sale de la misma llamada y
   * es lo que el CLI dice de sí mismo (ver `titleSignal`). Va tras un tabulador
   * y NO forma parte de `identity`: el título cambia cada segundo —spinner,
   * marcador que parpadea— y una identidad que cambia no identifica nada.
   */
  async permissionView(name: string): Promise<{ identity: string; screen: string; title: string; claimedFingerprint?: string } | null> {
    if (!NAME_RE.test(name)) return null;
    const id = await this.run(['display-message', '-p', '-t', `=${name}:`, '#{session_name}|#{pane_id}|#{pane_pid}|#{pane_dead}\t#{pane_title}'], 5_000);
    const [head = '', rawTitle = ''] = id.stdout.split('\t');
    const identity = head.trim();
    if (!id.ok || !identity.startsWith(`${name}|`) || !identity.endsWith('|0')) return null;
    const title = rawTitle.trim();
    const pane = identity.split('|')[1]!;
    if (!/^%\d+$/.test(pane)) return null;
    const shot = await this.run(['capture-pane', '-p', '-J', '-t', pane, '-S', '0'], 5_000);
    const claim = await this.run(['show-options', '-p', '-v', '-t', pane, '@orca_permission_claim'], 5_000);
    return shot.ok ? { identity, screen: shot.stdout, title, claimedFingerprint: claim.ok ? claim.stdout.trim() : '' } : null;
  }

  /** Target the observed pane ID, never whichever window became active. No Enter. */
  async permissionKey(identity: string, key: string, fingerprint: string): Promise<TmuxResult> {
    const [name, pane] = identity.split('|');
    if (!name || !NAME_RE.test(name) || !pane || !/^%\d+$/.test(pane) || !/^(?:[1-9]|Escape)$/.test(key)) {
      return { ok: false, stdout: '', detail: 'Invalid permission target/key' };
    }
    const lock = `orca-permission-${pane.slice(1)}`;
    const locked = await this.run(['wait-for', '-L', lock], 5_000);
    if (!locked.ok) return { ok: false, stdout: '', detail: 'Permission delivery lock unavailable; inspect terminal' };
    try {
      const current = await this.run(['display-message', '-p', '-t', pane, '#{session_name}|#{pane_id}|#{pane_pid}|#{pane_dead}'], 5_000);
      if (!current.ok || current.stdout.trim() !== identity) return { ok: false, stdout: '', detail: 'Permission pane changed' };
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) return { ok: false, stdout: '', detail: 'Invalid fingerprint' };
      const claim = await this.run(['show-options', '-p', '-v', '-t', pane, '@orca_permission_claim'], 5_000);
      if (claim.ok && claim.stdout.trim() === fingerprint) return { ok: false, stdout: '', detail: 'Permission already attempted; no replay' };
      const marked = await this.run(['set-option', '-p', '-t', pane, '@orca_permission_claim', fingerprint], 5_000);
      if (!marked.ok) return marked;
      const finalShot = await this.run(['capture-pane', '-p', '-J', '-t', pane, '-S', '0'], 5_000);
      if (!finalShot.ok || promptOn(finalShot.stdout)?.fingerprint !== fingerprint) return { ok: false, stdout: '', detail: 'Dialog changed before delivery; no key sent' };
      return await this.run(['send-keys', '-c', '', '-t', pane, key], 5_000);
    } finally {
      await this.run(['wait-for', '-U', lock], 5_000);
    }
  }

  /* ── attach ────────────────────────────────────────────────────── */

  /**
   * A pty running `tmux attach` on the pane, sized for one console.
   *
   * With `window-size latest` (see the conf) the pane follows whichever
   * client resized last, so two consoles of different sizes do not fight — the
   * newest one wins and the other sees a re-flow. Killing the pty detaches
   * that client and nothing else.
   */
  attach(name: string, cols: number, rows: number): { ok: true; tty: PaneTty } | { ok: false; detail: string } {
    if (!this.bin) return { ok: false, detail: 'tmux no disponible' };
    if (!NAME_RE.test(name)) return { ok: false, detail: 'nombre de pane inválido' };
    const pty = this.pty();
    if (!pty) return { ok: false, detail: 'node-pty no está instalado en esta máquina' };
    try {
      const tty = pty.spawn(this.bin, ['-L', this.socket, 'attach-session', '-t', `=${name}`], {
        name: 'xterm-256color',
        cols: Math.max(2, Math.min(500, Math.floor(cols) || DEFAULT_COLS)),
        rows: Math.max(2, Math.min(200, Math.floor(rows) || DEFAULT_ROWS)),
        cwd: home(),
        env: { ...minimalEnv(), TERM: 'xterm-256color' },
      });
      return { ok: true, tty };
    } catch (err) {
      return { ok: false, detail: errText(err) };
    }
  }

  private pty() {
    if (this.ptyMod !== undefined) return this.ptyMod;
    try {
      // CommonJS con binario nativo: se carga con require, y sólo si hace falta.
      this.ptyMod = requireCjs('node-pty') as NonNullable<typeof this.ptyMod>;
    } catch (err) {
      log('warn', SCOPE, `node-pty no carga: ${errText(err)}`);
      this.ptyMod = null;
    }
    return this.ptyMod;
  }

  /* ── server ────────────────────────────────────────────────────── */

  /**
   * Start ORCA's tmux server with its own conf, once.
   *
   * The conf is written every time so an upgrade of these defaults reaches
   * the file; the server only reads it when it starts, which is why the file
   * has to exist before the first `new-session`.
   */
  async ensureServer(): Promise<void> {
    if (!this.bin || this.serverReady) return;
    try {
      fs.mkdirSync(path.dirname(this.conf), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.conf, TMUX_CONF, { mode: 0o600 });
    } catch (err) {
      log('warn', SCOPE, `no pude escribir ${this.conf}: ${errText(err)}`);
    }
    const r = await this.run(['-f', this.conf, 'start-server'], 10_000);
    if (!r.ok) log('warn', SCOPE, `start-server: ${r.detail}`);
    this.serverReady = true;
  }

  private run(args: string[], timeoutMs: number): Promise<TmuxResult> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: TmuxResult): void => { if (!settled) { settled = true; resolve(r); } };
      let child;
      try {
        child = spawnChild(this.bin!, ['-L', this.socket, ...args], {
          cwd: home(),
          env: minimalEnv(),
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        done({ ok: false, stdout: '', detail: errText(err) });
        return;
      }
      let stdout = '', stderr = '';
      child.stdout?.on('data', (c: Buffer) => { if (stdout.length < 4 * 1024 * 1024) stdout += c.toString('utf8'); });
      child.stderr?.on('data', (c: Buffer) => { if (stderr.length < 64 * 1024) stderr += c.toString('utf8'); });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ya */ }
        done({ ok: false, stdout, detail: `tmux ${args[0]}: timeout tras ${timeoutMs}ms` });
      }, timeoutMs);
      timer.unref?.();
      child.on('error', (err) => { clearTimeout(timer); done({ ok: false, stdout, detail: errText(err) }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ ok: code === 0, stdout, detail: code === 0 ? '' : `tmux ${args[0]} salió con ${code}: ${oneLine(stderr || stdout, 300)}` });
      });
    });
  }
}

/** PATH and HOME only: a tmux client needs nothing else, and keys never ride on it. */
function minimalEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'SHELL', 'TMPDIR']) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

export function resolveTmuxBin(): string | null {
  const override = process.env['ORCA_TMUX_BIN'];
  if (override) return isExec(override) ? override : null;
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  for (const d of dirs) {
    const p = path.join(d, 'tmux');
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

/**
 * ORCA's tmux server, configured for being looked at through a window.
 *
 * No status line: the console's chrome is the frame. `window-size latest` so
 * the last console to resize wins instead of everyone shrinking to the
 * smallest. Mouse on so a wheel over the terminal scrolls history. Large
 * history because an agent's whole run is what you scroll back through.
 */
export const TMUX_CONF = `# ORCA's tmux server. Regenerated by the collector; edit src/collector/tmux.ts instead.
set -g default-terminal "xterm-256color"
set -g escape-time 0
set -g history-limit 50000
set -g status off
set -g mouse on
set -g window-size latest
set -g aggressive-resize on
set -g focus-events on
set -g set-titles off
set -g allow-passthrough on
set -g remain-on-exit off
set -g detach-on-destroy on
set -g exit-empty off
set -g exit-unattached off
set -g destroy-unattached off
`;
