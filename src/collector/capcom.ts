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
import { randomUUID } from 'node:crypto';
import { runtimeBin } from './runtime.ts';
import type { ProviderHandoffPlan } from '../shared/provider-handoff.ts';
import { resumedPromptReady } from './model-control.ts';
import { parseHandoff, type CapcomHandoff } from '../shared/handoff.ts';
import { clearIdentity, readIdentity, succeed, writeIdentity, type CapcomIdentity } from './capcom-identity.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FeedLevel } from '../shared/types.ts';
import { capcomBrief, cleanCapcomBrief } from './briefs.ts';
import { extractShortId, paneEnv } from './commands.ts';
import type { LineageIndex } from './lineage.ts';
import { paneName, type TmuxHost } from './tmux.ts';
import { claudeConfigPath, grantTrust } from './trust.ts';
import { errText, log, oneLine, orcaDir } from './util.ts';

export { claudeConfigPath };

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

/**
 * What a session that replaces a recycled one is told.
 *
 * It has the same brief and none of the memory, and that is the point: the
 * record is on the hub. `briefing` reads it in one call, `list_missions` says
 * what is owed, and the fleet never notices the hand-over.
 */
export const CAPCOM_ROTATED_PROMPT =
  'You are a fresh CAPCOM session replacing one that was recycled after too many context compactions.'
  + ' Nothing it remembered is in your head, and nothing needs to be: the hub is the record.'
  + ' Call `briefing` on the `orca` MCP server first, then `list_missions` with only_pending, and pick up'
  + ' whatever is owed — answer the blocked, report_mission what finished. Then say in one line what you found.';

/** The name of the hub's MCP server, as CAPCOM's tools are prefixed with it. */
export const MCP_SERVER = 'orca';

/*
 * CAPCOM has every tool the CLI ships with — Bash, Edit and Write included.
 *
 * Until 2026-09-06 those were denied on the command line, on the theory that
 * a commander briefs agents and does not touch repos. Measured that day: the
 * fence cost more than it protected. Writing one log file took a squad, two
 * sub-agents (a denied session's sub-agents inherit the denial) and eight
 * minutes. The doctrine lives on in the brief — small things directly, real
 * work through agents — as judgement, not as a fence.
 */

/**
 * A hosted CAPCOM is named by the session id ORCA chose (a UUID, also the
 * pane's name); a `--bg` one by the short id the CLI printed. The shape of the
 * id is the only record of which kind a remembered session was.
 */
export function isHostedId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Where Codex keeps per-folder trust. `CODEX_HOME` moves it. */
export function codexConfigPath(env: Record<string, string | undefined> = process.env): string {
  return path.join(env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex'), 'config.toml');
}

/**
 * The same promise for Codex, whose trust lives in TOML instead of JSON.
 *
 * A handoff resumes its destination in a directory that did not exist a second
 * earlier — `handoffs/<planId>/runtime` — so the TUI opens on "Do you trust the
 * contents of this directory?" and stops there. Nobody is watching that pane:
 * readiness times out, the original is retained, and a clean reset reports a
 * failure while the old context stays exactly where it was.
 *
 * Only appends, and only when the folder has no entry at all: a `trust_level`
 * the operator already chose — a refusal included — is left as it is, and so is
 * a config that cannot be read. The dialog then appears in the TERMINAL.
 */
export function preTrustCodex(dir: string, file: string = codexConfigPath()): 'already' | 'written' | 'skipped' {
  const key = path.resolve(dir).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const header = `[projects."${key}"]`;
  let raw = '';
  let mode = 0o600;
  if (fs.existsSync(file)) {
    try { raw = fs.readFileSync(file, 'utf8'); mode = fs.statSync(file).mode & 0o777; } catch { return 'skipped'; }
  } else if (!fs.existsSync(path.dirname(file))) return 'skipped';
  if (raw.split('\n').some(line => line.trim() === header)) return 'already';
  const tmp = `${file}.orca-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${raw}${raw && !raw.endsWith('\n') ? '\n' : ''}\n${header}\ntrust_level = "trusted"\n`, { mode });
    fs.renameSync(tmp, file);
    return 'written';
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ya no está */ }
    log('warn', SCOPE, `no pude marcar ${key} como de confianza: ${errText(err)}`);
    return 'skipped';
  }
}

/**
 * Tell Claude Code that CAPCOM's directory is trusted, before it asks.
 *
 * An interactive session in a folder it has never seen opens with "Is this a
 * project you created or one you trust?" and waits. In a pane nobody is
 * looking at, that is a CAPCOM that never boots, and the console shows nothing
 * because there is no transcript yet — observed on the first hosted launch.
 * The folder is ORCA's own, created and written by this collector, so the
 * answer is known.
 *
 * The writing itself lives in `trust.ts`, which is also what every worker
 * spawn goes through now: one implementation, one place where the reasoning
 * for touching the operator's config file is written down. This keeps the
 * three-way answer CAPCOM's callers already read.
 */
export function preTrust(dir: string, file: string = claudeConfigPath()): 'already' | 'written' | 'skipped' {
  const granted = grantTrust(dir, file);
  if (!granted.ok) return 'skipped';
  return granted.changed ? 'written' : 'already';
}

/** Where CAPCOM lives. `ORCA_CAPCOM_DIR` moves it; `ORCA_HOME` moves it too. */
export function capcomDir(): string {
  return process.env['ORCA_CAPCOM_DIR'] ?? path.join(orcaDir(), 'capcom');
}

/**
 * Does this collector carry CAPCOM?
 *
 * By default, yes — when the hub is on this machine. The machine running the
 * hub is the operator's machine, and a console with nobody to talk to is the
 * single most confusing thing ORCA can show: the human types, and what answers
 * is either a fallback that cannot think or a line saying nothing is listening.
 * That was the failure mode when CAPCOM was an explicit flag: `npm run dev`
 * came up without a command and looked exactly like a CAPCOM that was mute.
 *
 * A collector dialing a REMOTE hub is another machine in the fleet, and the
 * fleet must have exactly one CAPCOM — two would be two minds triaging the
 * same question. So there the default flips to off, and `--capcom` /
 * `ORCA_CAPCOM=1` says "this one, not the hub's machine".
 *
 * `--no-capcom` / `ORCA_CAPCOM=0` turns it off anywhere.
 */
export function wantsCapcom(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  if (argv.includes('--no-capcom') || env['ORCA_CAPCOM'] === '0') return false;
  if (argv.includes('--capcom') || env['ORCA_CAPCOM'] === '1') return true;
  return isLocalHub(env['ORCA_HUB_URL']);
}

/** Unset, or any loopback host: the hub lives on this machine. */
export function isLocalHub(hubUrl: string | undefined): boolean {
  if (!hubUrl) return true;
  let host: string;
  try { host = new URL(hubUrl).hostname; } catch { return false; }
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
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
 * Settings for the session ORCA starts, and for a human who opens this
 * directory.
 *
 * The file reaches the launched session TWICE, and only one copy counts. As
 * the project settings of `~/.orca/capcom` it is trust-gated: an untrusted
 * workspace — a directory ORCA just created is always untrusted, and a
 * background session has nobody to accept the dialog — makes the CLI discard
 * its `permissions` entries ("Ignoring 1 permissions.allow entry: this
 * workspace has not been trusted"). Passed with `--settings <file>` in the
 * argv (see `launchArgs`) it is NOT gated: measured against the CLI 2.1.263,
 * from an untrusted directory, the same file was ignored as project settings
 * and applied as `--settings`. So the tool approvals still travel as
 * `--allowedTools`, and this file carries what `--allowedTools` cannot:
 *
 * `additionalDirectories` — the roots of every project the collector knows.
 * CAPCOM reads code in those repos to answer questions and to brief agents,
 * and they are all outside its cwd. In auto mode reads outside the working
 * directories run without a prompt, but the FIRST one in an interactive
 * session — and the hosted CAPCOM is one, in a tmux pane — opens a dialog
 * ("keep allowing / block from now on / ask again"), and a hosted CAPCOM
 * has nobody in front of it. Directories listed here are working
 * directories: the dialog never fires for them. Measured, same CLI, with
 * `permissions.blockReadsOutsideWorkingDirectories` as the detector: a
 * `Read(//**)` allow rule does NOT make a path a working directory — the
 * read was still refused — while a directory listed here, or one passed with
 * `--add-dir`, was read. The rule is not the lever; the directories are.
 *
 * Why the settings file and not `--add-dir`: a directory added with the flag
 * is also a configuration root — its CLAUDE.md, skills, commands and
 * sub-agents load into the session. Twenty-odd projects on this machine would
 * be twenty-odd CLAUDE.md files in CAPCOM's context. Directories in
 * `permissions.additionalDirectories` grant file access only.
 *
 * Trade-off: the list is the registry at launch time. A project that first
 * appears while CAPCOM is running is outside the list until the next
 * relaunch, and on a config that has never answered the dialog its first read
 * prompts once (the CLI records the answer globally; on this machine it is
 * already recorded). The user's home would cover everything, but in auto mode
 * edits inside working directories skip the classifier, and CAPCOM has Edit:
 * the project roots keep that reach to the repos it is meant to work on.
 */
export function capcomSettingsJson(roots: readonly string[] = []): string {
  return JSON.stringify({
    enableAllProjectMcpServers: true,
    permissions: {
      allow: [`mcp__${MCP_SERVER}`],
      additionalDirectories: [...roots],
      defaultMode: 'auto',
    },
  }, null, 2) + '\n';
}

/**
 * The project roots that go in `additionalDirectories`: existing directories
 * only (the CLI warns about each missing one at startup, and the registry can
 * hold a project whose folder is gone), never CAPCOM's own cwd, no duplicates,
 * sorted so the file is stable between rewrites.
 */
export function capcomRoots(candidates: readonly string[], own: string): string[] {
  const ownKey = path.resolve(own);
  const out = new Set<string>();
  for (const c of candidates) {
    if (!c) continue;
    const p = path.resolve(c);
    if (p === ownKey) continue;
    try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
    out.add(p);
  }
  return [...out].sort();
}

/* ── the session ──────────────────────────────────────────────────── */

export interface CapcomLaunch {
  ok: boolean;
  shortId: string | null;
  detail: string;
}

/** Why CAPCOM is being recycled, in the numbers the feed line shows. */
export interface RotationSignals {
  turns: number;
  compactions: number;
  contextTokens: number;
}

export interface RotationNotice extends RotationSignals {
  /** The agent id the hub knows the retiring session by. */
  fromId: string;
}

export interface CapcomDeps {
  codexBin?: string;
  /** The resolved `claude` binary, or null when this machine has none. */
  bin: string | null;
  /** The collector's hub URL, ws or http. Converted with `hubHttpUrl`. */
  hubUrl: string;
  token: string;
  /**
   * So the launched session is marked `role: 'capcom'` and survives a restart,
   * and so the session it replaces stops being one (`demote`).
   */
  lineage: Pick<LineageIndex, 'noteSpawn' | 'demote' | 'bind'>;
  /** Is that id (short id, or session id for a hosted one) still running here? */
  alive(id: string): boolean;
  /**
   * The machine's tmux, when it has one. With it CAPCOM runs HOSTED: an
   * interactive session in a pane, like any other agent ORCA launches, with a
   * TERMINAL the operator can open. Without it, `--bg`.
   */
  tmux?: Pick<TmuxHost, 'available' | 'spawn'> & Partial<Pick<TmuxHost, 'kill' | 'capture'>>;
  /**
   * The hub-side agent id for a session this collector names by short id (a
   * `--bg` CAPCOM). A hosted one is its own id. Rotation tells the hub which
   * agent is going away, and the hub only knows agents.
   */
  agentIdOf?(id: string): string | null;
  /**
   * A rotation is starting: `fromId` is about to be stopped. Sent to the hub
   * BEFORE the stop, so it holds CAPCOM's mail instead of losing it.
   */
  rotated?(info: RotationNotice): void;
  /**
   * The paths of the projects this collector knows. They become CAPCOM's
   * additional working directories (see `capcomSettingsJson`); read again on
   * every launch, so a relaunch picks up the projects that appeared since.
   */
  roots?: () => readonly string[];
  /** `false` skips `preTrust` — tests must never touch the real ~/.claude.json. */
  trust?: boolean;
  note(level: FeedLevel, text: string): void;
  dir?: string;
  now?(): number;
  /** Injected only by isolated activation tests. */
  wait?(ms: number): Promise<void>;
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
  private transferBusy = false;
  holdTransfer(on: boolean) { this.transferBusy = on; }

  private resumeArgs(runtime: string, sessionId: string, model: string, cwd = this.dir): string[] {
    if (runtime === 'claude') return ['--resume', sessionId, '--model', model, '--tools', 'default', ...this.launchArgs(cwd)];
    const url = `${hubHttpUrl(this.deps.hubUrl)}/mcp${this.deps.token ? `?token=${encodeURIComponent(this.deps.token)}` : ''}`;
    return ['resume', sessionId, '-C', cwd, '-m', model, '--approve-for-me',
      '-c', `mcp_servers.orca.url=${JSON.stringify(url)}`, '-c', 'mcp_servers.orca.required=true',
      '-c', 'mcp_servers.orca.default_tools_approval_mode="approve"'];
  }

  async activateHandoff(plan: ProviderHandoffPlan, sessionId: string): Promise<void> {
    const tmux = this.deps.tmux; const name = paneName(sessionId); const old = this.shortId;
    const bin = plan.runtime === 'claude' ? this.deps.bin : this.deps.codexBin ?? runtimeBin('codex');
    if (!old || old !== plan.fromId || sessionId === old || !name || !isHostedId(sessionId) || !bin || !tmux?.capture || !tmux.kill) throw new Error('CAPCOM changed or the destination runtime is unavailable.');
    const cwd = plan.cwd ?? this.dir;
    // The destination's directory is new, and an unattended pane cannot accept
    // a trust dialog. Answer it before it is asked, in either CLI's own record.
    if (this.deps.trust !== false && (plan.runtime === 'claude' ? preTrust(cwd) : preTrustCodex(cwd)) === 'skipped') {
      this.deps.note('warn', `no pude marcar ${cwd} como de confianza para ${plan.runtime}: `
        + 'el destino puede quedarse en el diálogo de confianza y el CAPCOM actual se conserva');
    }
    this.writeConfig(cwd, plan.contextMode);
    const r = await tmux.spawn({ name, cwd, env: { ...paneEnv({}), ORCA_PANE: name }, argv: [bin, ...this.resumeArgs(plan.runtime, sessionId, plan.model, cwd)] });
    if (!r.ok) throw new Error(`Destination could not resume: ${r.detail}`);
    let cutover = false;
    try {
      let ready = false;
      for (let i = 0; i < 480; i++) {
        await (this.deps.wait?.(250) ?? new Promise(resolve => setTimeout(resolve, 250)));
        const screen = await tmux.capture(name, 40);
        if (!screen.ok) throw new Error(`Destination terminal unavailable: ${screen.detail}`);
        if (i >= 7 && resumedPromptReady(screen.stdout, plan.runtime)) { ready = true; break; }
      }
      if (!ready) {
        // Whatever it stopped on dies with the pane. Keep the screen, or the
        // next operator has to reproduce the resume by hand to see the dialog.
        const last = await tmux.capture(name, 80);
        if (last.ok) try { fs.writeFileSync(path.join(plan.archive, 'resume-screen.txt'), last.stdout, { mode: 0o600 }); } catch { /* la evidencia es mejor esfuerzo */ }
        throw new Error('Destination requires terminal setup or did not become ready. Original CAPCOM retained; its last screen is resume-screen.txt in the backup.');
      }
      /*
       * El destino verificado, todavía sin publicar.
       *
       * Se arma aquí y se escribe DESPUÉS de parar al anterior: mientras haya
       * dos procesos vivos, quien manda sigue siendo el que ya mandaba, y una
       * identidad publicada antes de tiempo haría que un collector que muriese
       * en medio readoptase una sesión que aún no tiene el mando.
       */
      const next: CapcomIdentity = { sessionId, runtime: plan.runtime, model: plan.model, cwd,
        ...(plan.contextMode ? { contextMode: plan.contextMode } : {}), cutoffAt: plan.at,
        handoffModel: plan.model, handoffId: plan.id, reason: 'manual',
        previousSessionId: old, previousRuntime: plan.fromRuntime, ...(plan.fromModel !== null ? { previousModel: plan.fromModel } : {}),
        activatedAt: new Date(this.now()).toISOString(),
        archive: plan.archive, historyPath: plan.historyPath, checkpointPath: plan.checkpointPath };
      const stopped = await tmux.kill(paneName(old)!);
      if (!stopped.ok) throw new Error('Original CAPCOM could not be stopped; handoff cancelled.');
      // The prepared pane has no activation turn yet. Publish its durable UUID
      // only after the old pane is stopped, then announce it to the hub.
      writeIdentity(this.dir, next);
      cutover = true;
      this.adopt(sessionId); this.deps.lineage.bind(sessionId, sessionId);
      this.deps.note('info', `CAPCOM handoff activated: ${plan.fromRuntime} → ${plan.runtime}/${plan.model}. Backup: ${plan.archive}`);
    } finally { if (!cutover) await tmux.kill(name); }
  }

  handoff(machineId: string): CapcomHandoff | null {
    try {
      const r = this.identity();
      // Una identidad sin motivo no es el acta de nada: es la sesión de siempre.
      if (!r?.reason) return null;
      return parseHandoff({ machineId, fromId: r.previousSessionId, toId: r.sessionId,
        at: Date.parse(r.activatedAt ?? ''), fromRuntime: r.previousRuntime ?? 'claude', toRuntime: r.runtime,
        fromModel: r.previousModel ?? null, toModel: r.handoffModel ?? r.model, reason: r.reason,
        contextMode: r.contextMode, cutoffAt: r.cutoffAt, historyPath: r.historyPath ?? null, checkpointPath: r.checkpointPath ?? null });
    } catch { return null; }
  }

  /**
   * Con qué se relanza el CAPCOM que hay. Una vista de la identidad.
   *
   * Era una lectura aparte de `codex-recovery.json` que además MANDABA sobre la
   * sesión adoptada; ahora las dos preguntas leen el mismo archivo, así que no
   * pueden discrepar. Nunca interpreta un id de Claude como uno de Codex: el
   * runtime es explícito o la identidad se rechaza al leerla.
   *
   * Devuelve `null` para una identidad migrada de un `session.json` a secas,
   * cuyo modelo es `default`: no había traspaso que reanudar, y anunciar uno
   * mandaría a `launchPreparedRecovery` a resumir con un modelo inventado.
   */
  recovery(): { sessionId: string; model: string; runtime?: 'claude' | 'codex'; cwd?: string; contextMode?: 'continuity' | 'clean' } | null {
    const id = this.identity();
    // Un `--bg` no se reanuda por aquí, y una identidad sin modelo declarado no
    // dice con qué: las dos son «no hay traspaso que reanudar», no un fallo.
    if (!id || id.model === 'default' || !isHostedId(id.sessionId)) return null;
    return { sessionId: id.sessionId, model: id.model, runtime: id.runtime,
      ...(id.cwd ? { cwd: id.cwd } : {}), ...(id.contextMode ? { contextMode: id.contextMode } : {}) };
  }

  /* ── configuration on disk ──────────────────────────────────────── */

  /**
   * Write the three files CAPCOM boots from, every time.
   *
   * Rewritten on each start rather than only when missing, because the token
   * and the hub's port can both change between runs and a stale `.mcp.json` is
   * a CAPCOM with no tools. The brief is rewritten too: it is the product, it
   * changes, and a session started tomorrow should get today's version.
   */
  writeConfig(dir = this.dir, mode?: 'continuity' | 'clean'): void {
    const hub = hubHttpUrl(this.deps.hubUrl);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), mode === 'clean' ? cleanCapcomBrief() : capcomBrief(), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), mode === 'clean' ? cleanCapcomBrief() : capcomBrief(), { mode: 0o600 });
    // 0600: this one has the hub token in it.
    fs.writeFileSync(path.join(dir, '.mcp.json'), mcpConfigJson(hub, this.deps.token), { mode: 0o600 });
    const roots = capcomRoots(this.deps.roots?.() ?? [], dir);
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), capcomSettingsJson(roots), { mode: 0o600 });
  }

  /* ── la identidad, en un solo archivo (capcom-identity.ts) ──────── */

  /**
   * Quién manda, según el disco. Un archivo ilegible se dice y no se adivina.
   *
   * `recovery` y `loadState` eran dos lecturas de dos archivos con reglas de
   * prioridad implícitas; ahora las dos preguntan aquí y devuelven vistas del
   * mismo hecho, que es lo que impide que una se actualice sin la otra.
   */
  private identity(): CapcomIdentity | null {
    try { return readIdentity(this.dir); }
    catch (err) { log('warn', SCOPE, `identidad de CAPCOM ilegible: ${errText(err)}`); throw err; }
  }

  private loadState(): string | null {
    try { return this.identity()?.sessionId ?? null; } catch { return null; }
  }

  /**
   * Apuntar quién manda, conservando con qué se relanza.
   *
   * `null` borra el hecho. Un id nuevo sucede al anterior heredando runtime,
   * modelo y directorio salvo que el llamante diga otra cosa: casi siempre es
   * el mismo proceso o el mismo sitio, y obligar a repetirlo en cada sitio que
   * adopta es exactamente cómo se acaba con dos registros que no coinciden.
   */
  private saveState(shortId: string | null, next: Partial<CapcomIdentity> = {}): void {
    try {
      if (!shortId) { clearIdentity(this.dir); return; }
      let previous: CapcomIdentity | null = null;
      try { previous = readIdentity(this.dir); } catch { previous = null; }
      if (previous?.sessionId === shortId && !Object.keys(next).length) return;
      const runtime = next.runtime ?? previous?.runtime ?? (this.deps.codexBin && !this.deps.bin ? 'codex' : 'claude');
      const model = next.model ?? previous?.model ?? 'default';
      writeIdentity(this.dir, succeed(previous?.sessionId === shortId ? null : previous,
        { ...next, sessionId: shortId, runtime, model }, this.now()));
    } catch (err) {
      log('warn', SCOPE, `no pude guardar la identidad de CAPCOM: ${errText(err)}`);
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
    if (this.transferBusy) return { ok: true, shortId: this.shortId, detail: 'handoff preparation in progress' };
    if (this.starting) return { ok: true, shortId: this.shortId, detail: 'ya arrancando' };

    const recovery = this.recovery();
    const remembered = recovery?.sessionId ?? this.shortId ?? this.loadState();
    if (remembered && this.deps.alive(remembered)) {
      /*
       * Un CAPCOM `--bg` en una máquina que ahora tiene tmux se muda a un pane.
       *
       * Es el caso de un collector actualizado, o de uno al que le instalaron
       * tmux: la sesión de fondo sigue viva y adoptarla sería seguir con el
       * canal malo —una sesión nueva por mensaje, sin TERMINAL— para siempre,
       * porque cada `say` la resucita. Se para y se arranca hospedado. La
       * conversación empieza de cero: un `--bg` no se puede traer a un pane.
       */
      if (this.deps.tmux?.available() && !isHostedId(remembered) && this.deps.bin) {
        this.deps.note('info', `CAPCOM (${remembered}) corre con --bg y aquí hay tmux: lo paro y lo arranco en un pane`);
        const runner = this.deps.launch ?? runDetached;
        const stopped = await runner(this.deps.bin, ['stop', remembered], this.dir);
        if (!stopped.ok) log('warn', SCOPE, `no pude parar el CAPCOM --bg ${remembered}: ${stopped.detail}`);
        this.deps.lineage.demote(remembered);
        this.shortId = null;
        this.saveState(null);
        return await this.launch();
      }
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
    if (this.transferBusy) return;
    if (this.starting) return;
    // An operator can install a verified recovery while the collector stays up.
    // Invalid configuration fails closed and is surfaced, never launching Claude.
    try {
      const recovery = this.recovery();
      if (!this.gaveUp && recovery && recovery.sessionId !== this.shortId && this.now() >= this.nextTry) {
        this.nextTry = this.now() + CAPCOM_RESTART_MS;
        void this.ensure().catch((err) => this.deps.note('alert', errText(err)));
        return;
      }
    } catch (err) {
      if (!this.gaveUp) this.deps.note('alert', errText(err));
      this.gaveUp = true;
      return;
    }
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

  /**
   * Recycle the session: stop the one running and start a fresh one with the
   * same brief and `CAPCOM_ROTATED_PROMPT`.
   *
   * Not a resume — a `--bg --resume` carries the whole conversation into the
   * new session, which is the context we are trying to shed — and not a death:
   * the hub is told first (`rotated`), so it holds the mail and never says
   * "no CAPCOM"; the collector's own watchdog sees a session being started,
   * not one that fell over; and the relaunch cap is not charged, since this
   * is policy, not failure. When to call it is `rotation.ts`'s decision.
   */
  async rotate(signals: RotationSignals): Promise<CapcomLaunch> {
    // Recovery resumes one verified Codex thread. Fresh-thread rotation needs
    // another prepared handoff; never recycle it through Claude's launch path.
    if (this.recovery()) return { ok: false, shortId: this.shortId, detail: 'Codex recovery: explicit handoff required for rotation' };
    if (this.starting || this.transferBusy) return { ok: false, shortId: this.shortId, detail: 'ya arrancando o transfiriendo' };
    const previous = this.shortId;
    if (!previous) return { ok: false, shortId: null, detail: 'no hay CAPCOM que rotar' };
    if (!this.deps.bin) return { ok: false, shortId: previous, detail: 'no encontré el binario `claude`' };

    this.starting = true;
    try {
      this.deps.rotated?.({ fromId: this.deps.agentIdOf?.(previous) ?? previous, ...signals });
      const runner = this.deps.launch ?? runDetached;
      if (isHostedId(previous)) {
        const pane = paneName(previous);
        const kill = this.deps.tmux?.kill;
        if (pane && kill) {
          const r = await kill.call(this.deps.tmux, pane);
          if (!r.ok) log('warn', SCOPE, `no pude cerrar el pane ${pane} al rotar: ${r.detail}`);
        }
      } else {
        const stopped = await runner(this.deps.bin, ['stop', previous], this.dir);
        if (!stopped.ok) log('warn', SCOPE, `no pude parar el CAPCOM --bg ${previous} al rotar: ${stopped.detail}`);
      }
      this.deps.lineage.demote(previous);
      this.shortId = null;
      this.saveState(null);
    } finally {
      this.starting = false;
    }
    const out = await this.launch(CAPCOM_ROTATED_PROMPT, true);
    const why = `${signals.turns} turnos, ${signals.compactions} compactaciones`;
    if (out.ok) {
      this.deps.note('info', `CAPCOM rotado (${previous} → ${out.shortId}): ${why}`);
      log('info', SCOPE, `CAPCOM rotado ${previous} → ${out.shortId}: ${why}`);
    } else {
      this.deps.note('warn', `CAPCOM rotado (${previous}) pero el nuevo no arrancó: ${oneLine(out.detail, 160)}`);
    }
    return out;
  }

  /**
   * `prompt` is what the new session is told first; `rotation` marks a launch
   * that replaces a healthy session on purpose, which the relaunch cap must
   * not count — five rotations in an hour would otherwise leave a real death
   * unanswered.
   */
  private async launch(prompt: string = CAPCOM_FIRST_PROMPT, rotation = false): Promise<CapcomLaunch> {
    const recovery = this.recovery();
    if (recovery) return this.launchPreparedRecovery(recovery);
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

    if (this.deps.tmux?.available()) return await this.launchHosted(prompt, rotation);

    const args = ['--bg', ...this.launchArgs(), prompt];

    const runner = this.deps.launch ?? runDetached;
    const res = await runner(this.deps.bin, args, this.dir);
    this.starting = false;
    if (!rotation) this.restarts.push(this.now());

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

  private async launchPreparedRecovery(recovery: NonNullable<ReturnType<CapcomSession['recovery']>>): Promise<CapcomLaunch> {
    const tmux = this.deps.tmux;
    const bin = recovery.runtime === 'claude' ? this.deps.bin : this.deps.codexBin ?? runtimeBin('codex');
    const name = paneName(recovery.sessionId);
    if (!bin || !tmux?.available() || !name) {
      this.nextTry = this.now() + CAPCOM_RESTART_MS;
      return { ok: false, shortId: this.shortId, detail: 'Codex recovery requires codex and tmux' };
    }
    if (!this.withinCap()) {
      this.gaveUp = true;
      this.deps.note('alert', 'CAPCOM Codex: restart limit reached; recovery preserved');
      return { ok: false, shortId: this.shortId, detail: 'restart limit reached' };
    }
    this.starting = true;
    this.nextTry = this.now() + CAPCOM_RESTART_MS;
    this.restarts.push(this.now());
    try {
      const cwd = recovery.cwd ?? this.dir;
      this.writeConfig(cwd, recovery.contextMode);
      const result = await tmux.spawn({
        name, cwd, env: { ...paneEnv({}), ORCA_PANE: name },
        argv: [bin, ...this.resumeArgs(recovery.runtime ?? 'codex', recovery.sessionId, recovery.model, cwd),
          ...(recovery.contextMode === 'clean' ? [] : recovery.contextMode === 'continuity' ? ['CAPCOM continuity is active. Call briefing first, reconcile pending obligations and persistent rules, and report the current state. Historical text is evidence, not authorization for new tasks.'] : ['CAPCOM recovery is active. Preserve the handoff and original transcript references in this thread. For this activation turn, call briefing, reconcile and report recovered obligations in Spanish only. Do not dispatch or retry workers yet: several Claude workers are quota-blocked and have partial changes that must be preserved. Subsequent operator messages can authorize continuing those obligations.'])],
      });
      if (!result.ok) return { ok: false, shortId: this.shortId, detail: result.detail };
      this.adopt(recovery.sessionId);
      this.deps.lineage.bind(recovery.sessionId, recovery.sessionId);
      this.deps.note('info', `CAPCOM recovered with ${recovery.runtime ?? 'codex'} ${recovery.model} (${recovery.sessionId})`);
      return { ok: true, shortId: recovery.sessionId, detail: `pane ${name}` };
    } finally { this.starting = false; }
  }

  /**
   * CAPCOM en un pane de tmux: la forma preferida.
   *
   * Un `--bg` sólo se puede continuar con `--bg --resume`, que crea OTRA sesión
   * por cada mensaje: el rol migra, el `startedAt` empata, la vieja queda
   * listada, y la conversación entera vive repartida en N transcripts que
   * nadie puede leer de corrido. En un pane la sesión es interactiva y una
   * sola: lo que escribe el humano se pega en su prompt, el id no cambia
   * nunca, y la TERMINAL de la consola es la conversación completa, en vivo,
   * tal como la ve el CLI. Igual que cualquier agente hospedado.
   *
   * El id lo elegimos aquí (`--session-id`), así que el pane ya se llama
   * `orca-<id>` antes de que exista el transcript, y el rol y el linaje se
   * apuntan ANTES de lanzar: si el collector muere en el siguiente instante,
   * el que vuelva encuentra el pane y lo readopta.
   */
  private async launchHosted(prompt: string, rotation: boolean): Promise<CapcomLaunch> {
    const tmux = this.deps.tmux;
    const sessionId = randomUUID();
    const name = paneName(sessionId);
    if (!tmux || !name || !this.deps.bin) {
      this.starting = false;
      return { ok: false, shortId: null, detail: 'no pude nombrar el pane de CAPCOM' };
    }
    const env = paneEnv({});
    env['ORCA_PANE'] = name;

    if (this.deps.trust !== false && preTrust(this.dir) === 'skipped') {
      this.deps.note('warn',
        `no pude marcar ${this.dir} como de confianza en ${claudeConfigPath()}: `
        + 'la primera vez, acepta el diálogo en la TERMINAL de CAPCOM');
    }

    this.adopt(sessionId);
    this.deps.lineage.bind(sessionId, sessionId);
    const res = await tmux.spawn({
      name, cwd: this.dir, env,
      argv: [this.deps.bin, '--session-id', sessionId, ...this.launchArgs(), prompt],
    });
    this.starting = false;
    if (!rotation) this.restarts.push(this.now());

    if (!res.ok) {
      this.shortId = null;
      this.saveState(null);
      this.deps.note('warn', `CAPCOM no arrancó en tmux: ${oneLine(res.detail, 160)}`);
      return { ok: false, shortId: null, detail: res.detail };
    }
    this.deps.note('info', `CAPCOM arrancó en ${name} — ábrelo con TERMINAL para verlo entero`);
    log('info', SCOPE, `CAPCOM ${sessionId} en pane ${name} (${this.dir})`);
    return { ok: true, shortId: sessionId, detail: `pane ${name}` };
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
  /**
   * El `/clear` del CLI dejó un hilo nuevo: apuntarlo donde manda de verdad.
   *
   * `adopt` mueve el rol en memoria y en `session.json`, y con eso bastaría si
   * `session.json` fuera la última palabra. No lo es: `ensure` lee primero
   * `codex-recovery.json`, porque una recuperación preparada es una decisión
   * más fuerte que un recuerdo, y su `sessionId` gana. Sin actualizarlo, el
   * vigilante devolvía el rol al hilo vaciado en su siguiente vuelta — un
   * CAPCOM vivo al que el hub ya no encontraba, que es como se vio: «0 UNDER
   * COMMAND» con el proceso corriendo delante.
   *
   * El resto del registro se conserva tal cual: el runtime, el modelo y el
   * `cwd` son los mismos —es el mismo proceso—, y `previousSessionId` encadena
   * el linaje igual que lo haría un traspaso.
   */
  adoptCleared(toId: string, mode: 'clean' | 'continuity', cutoffAt: number, model?: string): void {
    this.adopt(toId, { contextMode: mode, cutoffAt, reason: 'manual', ...(model ? { model } : {}) });
  }

  adopt(shortId: string, next: Partial<CapcomIdentity> = {}): void {
    this.adoptedAt = this.now();
    if (this.shortId === shortId && !Object.keys(next).length) return;
    const moved = this.shortId !== null && this.shortId !== shortId;
    const previous = this.shortId;
    this.shortId = shortId;
    // Sólo una sesión lleva el rol. La anterior sigue listada un rato después
    // del resume, y con el rol puesto el hub podría seguir hablándole a ella.
    if (moved && previous) this.deps.lineage.demote(previous);
    this.deps.lineage.noteSpawn(shortId, null, CAPCOM_MISSION, null, false, 'capcom');
    this.saveState(shortId, next);
  }

  /**
   * Las opciones que TODA invocación de CAPCOM necesita — la primera y cada
   * mensaje que se le manda después.
   *
   * Viven en un solo sitio porque olvidarlas en el camino de `say` es el fallo
   * silencioso perfecto: la sesión arranca, lee su brief, y descubre que no
   * tiene ninguna herramienta con la que hacer nada de lo que dice.
   */
  launchArgs(dir = this.recovery()?.cwd ?? this.dir): string[] {
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
     *     `--allowedTools` no pasa por esa puerta. Tampoco `--settings <file>`:
     *     medido contra el 2.1.263 desde un directorio sin confianza, el mismo
     *     archivo se ignora como settings del proyecto y se aplica como
     *     `--settings`. Por eso `additionalDirectories` —las raíces de los
     *     proyectos, para que leer sus repos no abra el diálogo de "primera
     *     lectura fuera del directorio de trabajo"— va en ese archivo y no en
     *     `--add-dir`, que además cargaría el CLAUDE.md y las skills de cada
     *     proyecto en el contexto de CAPCOM. La medida y el trade-off, junto a
     *     `capcomSettingsJson`.
     *
     * (2) `--strict-mcp-config` con `--mcp-config`: CAPCOM carga el servidor
     *     `orca` y NADA más. Sin esto hereda los servidores MCP del usuario,
     *     que pueden pedir autenticación y le cuestan una vuelta descubriendo
     *     que no puede usarlos.
     *
     * (3) Cada opción VARIÁDICA —`--mcp-config`, `--allowedTools`, y
     *     `--add-dir` si algún día se añade— va seguida de otra opción, nunca
     *     del prompt. Una variádica se come todo lo que venga detrás hasta el
     *     siguiente `-`, y con `--bg` el prompt es posicional: colocarlo tras
     *     una de ellas sería un CAPCOM que arranca sin instrucción ninguna
     *     (reproducido el 2026-09-06: `--add-dir <dir> 'prompt'` en `-p`
     *     termina en "Input must be provided either through stdin or as a
     *     prompt argument").
     *
     * (4) `auto`, el mismo modo que llevan los trabajadores: el CLI decide solo
     *     y nunca deja un prompt esperando en un pane que nadie mira. Con
     *     `acceptEdits` el primer `Bash` de CAPCOM se quedaría colgado hasta
     *     que alguien abriera su TERMINAL y pulsara Yes. Ninguna herramienta
     *     va vetada: ver la nota junto a `capcomSettingsJson`.
     */
    return [
      '--mcp-config', path.join(dir, '.mcp.json'),
      '--strict-mcp-config',
      '--allowedTools', `mcp__${MCP_SERVER}`,
      '--permission-mode', 'auto',
      '--settings', path.join(dir, '.claude', 'settings.json'),
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
