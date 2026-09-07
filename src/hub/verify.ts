/**
 * Pieza B del squad autonomy: verify. Lado hub.
 *
 * Verificar lo que hizo un agente sin fiarse de lo que dice. El hub no tiene
 * el disco del agente —eso es del collector— así que aquí sólo hay tres cosas:
 *
 *   diff / work   piden al collector dueño del agente (comando `autonomy`,
 *                 ops `verify:diff` y `verify:work`) y devuelven su ack.
 *   summary       las dos anteriores, tolerante a fallo: lo que `inspect_agent`
 *                 puede pegar en su respuesta sin que un collector caído la
 *                 convierta en un error.
 *   screenshot    una captura de la consola ORCA, hecha desde el propio hub
 *                 con un Chromium sin cabeza (Playwright). Lo que devuelve es
 *                 una ruta bajo ~/.orca/hub/shots/.
 *
 * ── La captura ───────────────────────────────────────────────────
 *
 * Playwright es devDependency (test/visual.ts ya la usa) y se importa en
 * diferido: un hub sin ella sigue arrancando y `screenshot` explica qué
 * instalar. La consola se abre con `?noboot=1` (la secuencia de arranque son
 * nueve segundos de nada para una foto) y `?k=<token>`, que es como la
 * consola aprende el token. Antes de disparar espera a que el campo tenga
 * flota (`window.__orca.stats()`), y entre medias llama a `onReady`: ahí es
 * donde la herramienta mueve la cámara (`show`), porque la página recién
 * abierta es una consola más y sólo oye una directiva enviada después de que
 * exista.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AutonomyDeps } from './autonomy.ts';
import type { Agent } from '../shared/types.ts';
import { PORTS } from '../shared/protocol.ts';

/* ── lo que viaja ─────────────────────────────────────────────────── */

export interface DiffRequest {
  /** Dónde correr git, si se sabe mejor que el transcript. Sólo vale dentro de un proyecto conocido. */
  cwd?: string | null;
  files?: string[] | null;
  maxBytes?: number | null;
  patch?: boolean;
  onlyTouched?: boolean;
}

/** Espejo de `DiffResult` en collector/verify.ts, más el agente. */
export interface AgentDiff {
  agentId: string;
  callsign: string;
  cwd: string;
  root: string;
  top: string;
  branch: string | null;
  stat: string;
  untracked: string[];
  patch: string | null;
  truncated: boolean;
  bytes: number;
  totalBytes: number;
  files: string[] | null;
  ignored: string[];
  touched: number | null;
  note?: string;
}

export interface AgentWork {
  agentId: string;
  callsign: string;
  runtime: string;
  cwd: string | null;
  transcript: string | null;
  lines: number;
  touched: { path: string; tools: string[]; writes: number; firstAt: number; lastAt: number }[];
  lastTestRun: {
    command: string; ok: boolean | null; tail: string; at: number; finishedAt: number | null; exitCode: number | null;
  } | null;
  note?: string;
}

/** Lo que `inspect_agent` puede pegar sin miedo: cada mitad falla por su lado. */
export interface VerifySummary {
  touched: string[];
  touchedCount: number;
  lastTestRun: AgentWork['lastTestRun'];
  stat: string | null;
  untracked: number | null;
  branch: string | null;
  top: string | null;
  /** Por qué falta lo que falta. Vacío cuando todo llegó. */
  errors: string[];
}

export interface ScreenshotRequest {
  /** Se llama con la página ya conectada al hub, antes de esperar y disparar. */
  onReady?: () => void | Promise<void>;
  /** Cuánto dejar que la cámara y las ventanas se asienten tras `onReady`. */
  settleMs?: number;
  width?: number;
  height?: number;
  /** Sustituye la URL que el hub deduciría. */
  url?: string | null;
}

export interface Screenshot {
  path: string;
  url: string;
  bytes: number;
  width: number;
  height: number;
  /** Agentes que la consola tenía en el campo al disparar. */
  agents: number;
}

export interface VerifyApi {
  diff(agentId: string, req?: DiffRequest): Promise<AgentDiff>;
  work(agentId: string, opts?: { tail?: number }): Promise<AgentWork>;
  summary(agentId: string, opts?: { maxTouched?: number }): Promise<VerifySummary>;
  screenshot(req?: ScreenshotRequest): Promise<Screenshot>;
  /** La URL que `screenshot` abriría. Para decirlo en un error o en la ayuda. */
  consoleUrl(): string;
  stop?(): void;
}

/* ── límites ──────────────────────────────────────────────────────── */

const DEFAULT_SETTLE_MS = 1_800;
const MAX_SETTLE_MS = 15_000;
const FLEET_WAIT_MS = 20_000;
const SHOT_TIMEOUT_MS = 60_000;
const DEFAULT_W = 1600;
const DEFAULT_H = 1000;
const MAX_SUMMARY_TOUCHED = 40;

/** La consola construida, si el hub la sirve. Mismo cálculo que server.ts. */
function distServed(): boolean {
  try {
    return existsSync(join(fileURLToPath(new URL('../../dist', import.meta.url)), 'index.html'));
  } catch {
    return false;
  }
}

/* ── la fábrica ───────────────────────────────────────────────────── */

export function createVerify(deps: AutonomyDeps): VerifyApi {
  const shotsDir = join(deps.dir, 'shots');
  let shooting: Promise<Screenshot> | null = null;

  function ensureAgent(agentId: string): Agent {
    const a = deps.agent(agentId);
    if (!a) throw new Error(`no agent ${agentId}`);
    return a;
  }

  async function diff(agentId: string, req: DiffRequest = {}): Promise<AgentDiff> {
    const a = ensureAgent(agentId);
    const args: Record<string, unknown> = {
      files: req.files ?? null,
      patch: req.patch !== false,
      onlyTouched: req.onlyTouched === true,
    };
    if (typeof req.maxBytes === 'number' && Number.isFinite(req.maxBytes)) args['maxBytes'] = Math.floor(req.maxBytes);
    // El worktree que la pieza C anota en el Agent es donde vive su trabajo: va
    // como pista de cwd. El collector sólo la acepta dentro de una raíz conocida.
    const worktree = req.cwd ?? (a as Agent & { worktree?: string | null }).worktree;
    if (typeof worktree === 'string' && worktree.trim()) args['cwd'] = worktree.trim();
    const out = await deps.dispatch({ k: 'autonomy', op: 'verify:diff', agentId: a.id, args });
    return out as AgentDiff;
  }

  async function work(agentId: string, opts: { tail?: number } = {}): Promise<AgentWork> {
    const a = ensureAgent(agentId);
    const args: Record<string, unknown> = {};
    if (typeof opts.tail === 'number') args['tail'] = opts.tail;
    const out = await deps.dispatch({ k: 'autonomy', op: 'verify:work', agentId: a.id, args });
    return out as AgentWork;
  }

  async function summary(agentId: string, opts: { maxTouched?: number } = {}): Promise<VerifySummary> {
    const max = Math.max(1, Math.min(MAX_SUMMARY_TOUCHED, opts.maxTouched ?? MAX_SUMMARY_TOUCHED));
    const errors: string[] = [];
    const [w, d] = await Promise.all([
      work(agentId).catch((err: unknown) => { errors.push(`work: ${msg(err)}`); return null; }),
      diff(agentId, { patch: false }).catch((err: unknown) => { errors.push(`diff: ${msg(err)}`); return null; }),
    ]);
    if (w?.note) errors.push(`work: ${w.note}`);
    return {
      touched: (w?.touched ?? []).slice(0, max).map((t) => t.path),
      touchedCount: w?.touched.length ?? 0,
      lastTestRun: w?.lastTestRun ?? null,
      stat: d ? (d.stat || '(clean)') : null,
      untracked: d ? d.untracked.length : null,
      branch: d?.branch ?? null,
      top: d?.top ?? null,
      errors,
    };
  }

  /** Dónde está la consola: lo dicho por env, o el hub si sirve dist/, o Vite. */
  function consoleUrl(): string {
    const explicit = deps.env['ORCA_CONSOLE_URL'];
    if (explicit) return explicit.replace(/\/+$/, '') + '/';
    const port = Number(deps.env['ORCA_PORT']) || PORTS.hub;
    return distServed() ? `http://127.0.0.1:${port}/` : `http://127.0.0.1:${PORTS.ui}/`;
  }

  function token(): string {
    const fromEnv = deps.env['ORCA_TOKEN'];
    if (fromEnv) return fromEnv;
    const home = deps.env['ORCA_HOME'] ?? join(deps.env['HOME'] ?? '', '.orca');
    try { return readFileSync(join(home, 'token'), 'utf8').trim(); } catch { return ''; }
  }

  async function screenshot(req: ScreenshotRequest = {}): Promise<Screenshot> {
    // Dos capturas a la vez serían dos Chromium a la vez; la segunda espera.
    if (shooting) await shooting.catch(() => undefined);
    shooting = shoot(req);
    try { return await shooting; } finally { shooting = null; }
  }

  async function shoot(req: ScreenshotRequest): Promise<Screenshot> {
    let pw: typeof import('playwright');
    try {
      pw = await import('playwright');
    } catch {
      throw new Error('screenshot needs Playwright on the hub machine: `npm i -D playwright && npx playwright install chromium`');
    }
    const width = clamp(req.width, DEFAULT_W, 320, 3840);
    const height = clamp(req.height, DEFAULT_H, 240, 2160);
    const settle = clamp(req.settleMs, DEFAULT_SETTLE_MS, 0, MAX_SETTLE_MS);
    const base = req.url ? req.url.replace(/\/+$/, '') + '/' : consoleUrl();
    const url = new URL(base);
    url.searchParams.set('noboot', '1');
    const k = token();
    if (k) url.searchParams.set('k', k);

    const deadline = deps.now() + SHOT_TIMEOUT_MS;
    let browser: import('playwright').Browser | null = null;
    try {
      try {
        browser = await pw.chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-gpu', '--ignore-gpu-blocklist'] });
      } catch (err) {
        throw new Error(`could not launch Chromium (${msg(err)}). Run \`npx playwright install chromium\` on the hub machine`);
      }
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => { if (errors.length < 5) errors.push(e.message); });
      try {
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
      } catch (err) {
        throw new Error(`console did not load at ${base} (${msg(err)}). Build it (npm run build) or set ORCA_CONSOLE_URL`);
      }
      // La consola cuenta como conectada cuando su hook existe y ve flota; con
      // una flota vacía basta con el hook, porque nunca habrá más que eso.
      const hooked = await until(page, () => typeof (window as unknown as { __orca?: unknown }).__orca !== 'undefined', 10_000);
      if (!hooked) throw new Error(`no ORCA console at ${base}: the page loaded but is not the console (${errors[0] ?? 'no page error'})`);
      const fleetSize = deps.agents().length;
      if (fleetSize > 0) {
        await until(page, () => ((window as unknown as { __orca?: { stats(): { agents: number } } }).__orca?.stats().agents ?? 0) > 0, FLEET_WAIT_MS);
      }
      await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => false);
      if (req.onReady) await req.onReady();
      if (settle > 0) await page.waitForTimeout(Math.min(settle, Math.max(0, deadline - deps.now())));
      const agents = await page.evaluate(() => (window as unknown as { __orca?: { stats(): { agents: number } } }).__orca?.stats().agents ?? 0).catch(() => 0);

      mkdirSync(shotsDir, { recursive: true });
      const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, '-');
      const file = join(shotsDir, `console-${stamp}.png`);
      const buf = await page.screenshot({ path: file, type: 'png' });
      deps.log(`verify: screenshot ${file} (${buf.length} bytes, ${agents} agents on the field)`);
      return { path: file, url: url.origin + url.pathname, bytes: buf.length, width, height, agents };
    } finally {
      if (browser) await browser.close().catch(() => undefined);
    }
  }

  return { diff, work, summary, screenshot, consoleUrl, stop() { /* nada que parar: cada captura cierra su navegador */ } };
}

/* ── helpers ──────────────────────────────────────────────────────── */

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clamp(v: unknown, dflt: number, min: number, max: number): number {
  const n = Number(v);
  if (v === undefined || v === null || !Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Sondea la página hasta que `fn` sea cierto o venza el plazo. */
async function until(page: import('playwright').Page, fn: () => boolean, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForFunction(fn, undefined, { timeout: timeoutMs, polling: 250 });
    return true;
  } catch {
    return false;
  }
}
