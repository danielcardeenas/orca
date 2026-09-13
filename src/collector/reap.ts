/**
 * El cierre del proceso de un agente cuando su sesión termina.
 *
 * Las reglas están en `shared/reap.ts`, puras y probables sin matar nada.
 * Aquí está lo que no se puede hacer puro: recordar el pid de cada sesión
 * mientras vive, volver a leer `ps` justo antes de señalar, mandar la señal, y
 * contar lo que pasó de verdad —incluido que no se pudo—.
 *
 * ── De dónde sale el pid ───────────────────────────────────────────
 *
 * La liveness lo sabe mientras la sesión vive: `claude agents --json` lo lista,
 * y el pane que ORCA creó (`orca-<sessionId>`) tiene `pane_pid`. En cuanto la
 * sesión termina, las dos fuentes lo OLVIDAN —el CLI deja de listarla y el
 * pane ya no existe— que es justo cuando hace falta. Por eso se anota aquí la
 * identidad completa (pid, hora de arranque, línea de comandos) la primera vez
 * que se ve, y se conserva hasta que el proceso se va.
 *
 * Y para lo que este collector no vio nacer —se reinicia bajo `tsx watch` al
 * editar `src/collector/*`, y la memoria se pierde— hay una tercera fuente: un
 * `claude` con `--session-id <uuid>` o `--resume <uuid>` en su línea de
 * comandos lleva su sesión puesta, y si esa sesión es de ORCA y ya terminó, el
 * proceso es un resto igual. Codex no lleva el id en su argv y sólo se conoce
 * por memoria: un reinicio del collector lo deja fuera del alcance, y se dice.
 *
 * ── Dos caminos, una decisión ──────────────────────────────────────
 *
 * `afterStop` corre DENTRO de `stop`/`remove`: espera a que la sesión termine
 * de verdad (pane ido, CLI sin listarla) y entonces decide. `sweep` corre con
 * la liveness para el agente que termina solo: la misma decisión, con una
 * espera de asentamiento para no pisar a un `stop` en curso ni a un CLI que
 * está saliendo. Las dos pasan por `decideReap` y ninguna se salta una puerta.
 */

import { execFile } from 'node:child_process';

import {
  decideReap, describeProcess, runtimeShape, sessionIdInCommand, sessionStray,
  type ProcSource, type ProcessOutcome, type ReapAgent, type ReapDecision, type SessionProc,
} from '../shared/reap.ts';
import { TERM_GRACE_MS, type ProcRow, type Stray, type StrayOutcome } from '../shared/strays.ts';
import { etimeToStart } from './hygiene.ts';
import { ORCA_REPO, readProcs } from './strays.ts';
import { paneName, type TmuxHost } from './tmux.ts';
import { errText, log } from './util.ts';

const SCOPE = 'reap';

/** Cuánto se espera, tras detener, a que el pane se vaya y el CLI deje de listar la sesión. */
export const STOP_SETTLE_MS = 8_000;
/**
 * Cuánto tiene que llevar terminada una sesión que terminó SOLA antes de que
 * el barrido toque su proceso. Un CLI que está saliendo tarda unos segundos en
 * soltar su pane; un `stop` en curso ya tiene su propio camino.
 */
export const SWEEP_SETTLE_MS = 20_000;
/** Cada cuánto busca el barrido, en `ps`, procesos que llevan puesto un id de sesión de ORCA. */
export const DISCOVER_EVERY_MS = 60_000;

/** Lo que el collector sabe del agente de una sesión, para decidir. */
export interface ReapAgentView extends ReapAgent {
  state: string;
  /** Lo que dice la liveness. Su ausencia NO es prueba de nada por sí sola. */
  alive: boolean;
}

export interface ReapDeps {
  tmux: TmuxHost;
  /** El agente por session id, o null si ORCA no lo observa. */
  agent(sessionId: string): ReapAgentView | null;
  /** Las sesiones de ORCA que existen, con o sin proceso: para atar un argv a una. */
  sessionIds(): Iterable<string>;
  /** Todos los pids que la liveness lista vivos AHORA. Nada de esto se señala. */
  alivePids(): number[];
  /** Los panes vivos del servidor de ORCA, según la última lectura de la liveness. */
  panes(): ReadonlySet<string>;
  /** Vuelve a leer la liveness y los panes. Para esperar a que una sesión termine. */
  refresh(): Promise<void>;
  /** ¿Ha mirado ya el collector la liveness? Recién arrancado, no, y no se afirma nada. */
  livenessReady(): boolean;
  feed(level: 'info' | 'warn', text: string, agentId?: string): void;
  repo?: string;
  now?(): number;
  /** El asentamiento del barrido. Sólo las pruebas lo acortan. */
  sweepSettleMs?: number;
}

/** Una fila de `ps` con su RSS, que es lo que se enseña como coste. */
interface RowWithRss extends ProcRow { rssBytes: number | null }

export class SessionReaper {
  private readonly now: () => number;
  private readonly repo: string;
  /** La identidad de cada sesión con proceso conocido. */
  private readonly procs = new Map<string, SessionProc>();
  /** Pids vistos y aún sin identidad leída, por sesión. */
  private readonly pending = new Map<string, { pid: number; source: ProcSource }>();
  /** Desde cuándo lleva terminada cada sesión con proceso vivo, para el asentamiento. */
  private readonly endedSince = new Map<string, number>();
  /** Sesiones cuyo proceso se está cerrando ahora: el barrido no las pisa. */
  private readonly busy = new Set<string>();
  private lastDiscover = 0;
  private sweeping = false;

  constructor(private readonly deps: ReapDeps) {
    this.now = deps.now ?? Date.now;
    this.repo = deps.repo ?? ORCA_REPO;
  }

  /* ── recordar ───────────────────────────────────────────────────── */

  /** Un pid visto en la liveness. Barato: la lectura de `ps` se agrupa en `remember`. */
  note(sessionId: string, pid: number, source: ProcSource): void {
    if (!Number.isInteger(pid) || pid <= 0) return;
    const known = this.procs.get(sessionId);
    if (known && known.pid === pid) return;
    const queued = this.pending.get(sessionId);
    if (queued && queued.pid === pid) return;
    this.pending.set(sessionId, { pid, source });
  }

  /** Lee la identidad de los pids nuevos: una llamada a `ps` para todos. */
  async remember(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = new Map(this.pending);
    this.pending.clear();
    const rows = await readRows([...batch.values()].map((p) => p.pid), this.now());
    for (const [sessionId, p] of batch) {
      const row = rows.get(p.pid);
      if (!row) continue;                       // se fue antes de poder mirarlo
      const stale = this.procs.get(sessionId);
      if (stale && stale.pid !== p.pid) this.endedSince.delete(sessionId);
      this.procs.set(sessionId, {
        sessionId, pid: p.pid, startedAt: row.startedAt, command: row.command, source: p.source, seenAt: this.now(),
      });
    }
  }

  /** Lo que recuerda de una sesión, si algo. Para las pruebas y el panel. */
  known(sessionId: string): SessionProc | null {
    return this.procs.get(sessionId) ?? null;
  }

  /**
   * Encuentra en `ps` los `claude` que llevan puesto un id de sesión de ORCA y
   * que este collector no recuerda: lo que quedó de antes de su último
   * reinicio. Cuesta un `ps -eo`; se llama poco.
   */
  async discover(only?: string): Promise<void> {
    const ids = new Set(only ? [only] : this.deps.sessionIds());
    const procs = await readProcs(this.now());
    for (const p of procs) {
      if (runtimeShape(p.command) !== 'claude') continue;
      const sid = sessionIdInCommand(p.command);
      if (!sid || !ids.has(sid)) continue;
      const known = this.procs.get(sid);
      if (known && known.pid === p.pid) continue;
      this.procs.set(sid, { sessionId: sid, pid: p.pid, startedAt: p.startedAt, command: p.command, source: 'argv', seenAt: this.now() });
    }
    this.lastDiscover = this.now();
  }

  /* ── ¿terminó la sesión? ────────────────────────────────────────── */

  /**
   * Si la sesión terminó, y por qué se sabe. `explicit` es que ORCA acaba de
   * detenerla ella misma, que es lo único que autoriza a dar por terminada una
   * sesión `--bg` sin pane: desde fuera no se distingue «terminó» de «el CLI
   * no la listó en este latido».
   */
  private ended(proc: SessionProc, now: ProcRow | undefined, explicit: boolean): { ended: boolean; why: string } {
    const pane = paneName(proc.sessionId) ?? `orca-`;
    const paneAlive = this.deps.panes().has(pane);
    const listed = this.deps.agent(proc.sessionId)?.alive === true;
    if (paneAlive) return { ended: false, why: `its pane ${pane} is still on the tmux server` };
    if (listed) return { ended: false, why: 'the CLI still lists the session as running' };
    if (proc.source === 'cli' && !explicit) {
      return { ended: false, why: 'a background session with no pane: from outside, "not listed" is not proof that it ended' };
    }
    if (proc.source === 'argv' && !explicit && now && now.ppid !== 1) {
      return { ended: false, why: `pid ${proc.pid} still has a parent (${now.ppid}): whatever hosts it has not let go` };
    }
    return {
      ended: true,
      why: explicit
        ? `ORCA stopped the session; its pane ${pane} is gone and the CLI no longer lists it`
        : `its pane ${pane} is gone and the CLI no longer lists the session`,
    };
  }

  /* ── cerrar ─────────────────────────────────────────────────────── */

  /**
   * Lo que `stop` y `remove` llaman DESPUÉS de terminar la sesión, y sólo si
   * la terminaron. Espera a que la sesión esté terminada de verdad —el pane
   * tarda en irse y el CLI en dejar de listarla— y entonces decide y actúa.
   */
  async afterStop(sessionId: string, opts: { settleMs?: number; dryRun?: boolean } = {}): Promise<ProcessOutcome> {
    if (this.busy.has(sessionId)) return { result: 'unknown', why: 'its process is already being closed' };
    this.busy.add(sessionId);
    try {
      await this.remember();
      if (!this.procs.has(sessionId)) await this.discover(sessionId);
      const proc = this.procs.get(sessionId);
      if (!proc) return { result: 'unknown', why: 'ORCA never observed a pid for this session, and no process carries its id' };

      const until = this.now() + (opts.settleMs ?? STOP_SETTLE_MS);
      let verdict = this.ended(proc, undefined, true);
      while (!verdict.ended && this.now() < until) {
        await sleep(400);
        await this.deps.refresh();
        verdict = this.ended(proc, undefined, true);
      }
      return await this.close(proc, verdict, opts.dryRun === true);
    } finally {
      this.busy.delete(sessionId);
    }
  }

  /**
   * Decidir y, si procede, señalar. `SIGTERM` primero para que el CLI suelte
   * sus hijos y su transcript; `SIGKILL` sólo si sigue ahí.
   */
  private async close(proc: SessionProc, session: { ended: boolean; why: string }, dryRun: boolean): Promise<ProcessOutcome> {
    const fresh = await readRow(proc.pid, this.now());
    const agent = this.deps.agent(proc.sessionId);
    const decision = decideReap({
      proc, agent, now: fresh, session, repo: this.repo,
      untouchable: new Set([process.pid, process.ppid, ...this.deps.alivePids()]),
    });
    const label = agent?.callsign ?? proc.sessionId.slice(0, 8);
    if (decision.act === 'gone') {
      this.procs.delete(proc.sessionId);
      this.endedSince.delete(proc.sessionId);
      return { result: 'gone', pid: proc.pid, why: decision.why };
    }
    if (decision.act === 'refuse') {
      log('info', SCOPE, `${label}: pid ${proc.pid} se queda (${decision.reason}): ${decision.why}`);
      if (decision.reason === 'reused') { this.procs.delete(proc.sessionId); this.endedSince.delete(proc.sessionId); }
      return { result: 'kept', pid: proc.pid, rssBytes: fresh?.rssBytes ?? null, reason: decision.reason, why: decision.why };
    }
    const rssBytes = fresh?.rssBytes ?? null;
    if (dryRun) return { result: 'kept', pid: proc.pid, rssBytes, why: 'dry run: SIGTERM would be sent' };

    const out = await this.signal(proc.pid, rssBytes);
    if (out.result === 'freed') {
      this.procs.delete(proc.sessionId);
      this.endedSince.delete(proc.sessionId);
      log('info', SCOPE, `${label}: ${describeProcess(out)}`);
      this.deps.feed('info', `${label}: ${describeProcess(out)}`, proc.sessionId);
    } else {
      log('warn', SCOPE, `${label}: ${describeProcess(out)}`);
      this.deps.feed('warn', `${label}: ${describeProcess(out)}`, proc.sessionId);
    }
    return out;
  }

  private async signal(pid: number, rssBytes: number | null): Promise<ProcessOutcome> {
    try { process.kill(pid, 'SIGTERM'); }
    catch (err) { return { result: 'failed', pid, rssBytes, why: `SIGTERM: ${errText(err)}` }; }
    if (await gone(pid, this.now, TERM_GRACE_MS)) return { result: 'freed', pid, rssBytes, signal: 'TERM', why: 'exited on SIGTERM' };
    try { process.kill(pid, 'SIGKILL'); }
    catch (err) { return { result: 'failed', pid, rssBytes, signal: 'TERM', why: `SIGKILL: ${errText(err)}` }; }
    if (await gone(pid, this.now, 1_000)) {
      return { result: 'freed', pid, rssBytes, signal: 'KILL', why: `did not exit in ${TERM_GRACE_MS / 1000}s; killed` };
    }
    return { result: 'failed', pid, rssBytes, signal: 'KILL', why: 'still running after SIGKILL' };
  }

  /* ── el agente que termina solo ─────────────────────────────────── */

  /**
   * Con cada latido de liveness: lo que lleva terminado más de
   * `SWEEP_SETTLE_MS` y sigue con proceso, se cierra. Nunca dos barridos a la
   * vez, y nunca sobre una sesión que `stop` está cerrando.
   */
  async sweep(): Promise<ProcessOutcome[]> {
    if (this.sweeping || !this.deps.livenessReady()) return [];
    this.sweeping = true;
    const out: ProcessOutcome[] = [];
    try {
      await this.remember();
      if (this.now() - this.lastDiscover >= DISCOVER_EVERY_MS) await this.discover();
      const now = this.now();
      for (const proc of [...this.procs.values()]) {
        if (this.busy.has(proc.sessionId)) continue;
        const verdict = this.ended(proc, undefined, false);
        if (!verdict.ended) { this.endedSince.delete(proc.sessionId); continue; }
        const since = this.endedSince.get(proc.sessionId) ?? now;
        this.endedSince.set(proc.sessionId, since);
        if (now - since < (this.deps.sweepSettleMs ?? SWEEP_SETTLE_MS)) continue;
        this.busy.add(proc.sessionId);
        try { out.push(await this.close(proc, verdict, false)); }
        finally { this.busy.delete(proc.sessionId); }
      }
    } catch (err) {
      log('warn', SCOPE, `barrido: ${errText(err)}`);
    } finally {
      this.sweeping = false;
    }
    return out;
  }

  /* ── el panel ───────────────────────────────────────────────────── */

  /**
   * «Sesión detenida, proceso vivo», con su coste, para el informe de higiene.
   *
   * Enseña todo lo que recuerda cuya sesión no esté corriendo con normalidad,
   * decidido con la misma función que cierra: lo que se ofrece es exactamente
   * lo que `clean` haría, y lo que no, dice por qué.
   */
  async scan(): Promise<Stray[]> {
    if (!this.deps.livenessReady()) return [];
    await this.remember();
    await this.discover();
    const out: Stray[] = [];
    const rows = await readRows([...this.procs.values()].map((p) => p.pid), this.now());
    const untouchable = new Set([process.pid, process.ppid, ...this.deps.alivePids()]);
    for (const proc of [...this.procs.values()]) {
      const fresh = rows.get(proc.pid);
      const agent = this.deps.agent(proc.sessionId);
      const pane = paneName(proc.sessionId) ?? `orca-`;
      // Un agente corriendo con normalidad no es un resto y no se lista.
      if (agent?.alive && this.deps.panes().has(pane)) continue;
      if (!fresh) { this.procs.delete(proc.sessionId); this.endedSince.delete(proc.sessionId); continue; }
      const session = this.ended(proc, fresh, false);
      const decision: ReapDecision = decideReap({ proc, agent, now: fresh, session, repo: this.repo, untouchable });
      const stray = sessionStray({
        proc, callsign: agent?.callsign ?? proc.sessionId.slice(0, 8), state: agent?.state ?? 'unknown',
        rssBytes: fresh.rssBytes, pane: this.deps.panes().has(pane) ? pane : null,
      }, decision);
      if (stray) out.push(stray);
    }
    return out;
  }

  /** `strays:clean` sobre un resto `session`: la misma decisión, ahora mismo. */
  async clean(id: string, opts: { dryRun?: boolean } = {}): Promise<StrayOutcome> {
    const sessionId = id.startsWith('stray_session_') ? id.slice('stray_session_'.length) : '';
    const proc = sessionId ? this.procs.get(sessionId) : undefined;
    if (!proc) return { id, label: id, result: 'gone', detail: 'not on the machine any more' };
    const label = this.deps.agent(sessionId)?.callsign ?? sessionId.slice(0, 8);
    if (this.busy.has(sessionId)) return { id, label, result: 'refused', detail: 'its process is already being closed' };
    this.busy.add(sessionId);
    try {
      const fresh = await readRow(proc.pid, this.now());
      const out = await this.close(proc, this.ended(proc, fresh, false), opts.dryRun === true);
      switch (out.result) {
        case 'freed': return { id, label, result: 'stopped', signal: out.signal!, detail: describeProcess(out) };
        case 'gone': return { id, label, result: 'gone', detail: out.why };
        case 'kept': return opts.dryRun
          ? { id, label, result: 'stopped', signal: 'TERM', detail: out.why }
          : { id, label, result: 'refused', detail: out.why };
        default: return { id, label, result: 'failed', ...(out.signal ? { signal: out.signal } : {}), detail: out.why };
      }
    } finally {
      this.busy.delete(sessionId);
    }
  }
}

/* ── leer la máquina ─────────────────────────────────────────────── */

const READ_TIMEOUT_MS = 4_000;

/** `ps -o pid=,ppid=,etime=,rss=,command= -p …` → filas con RSS, por pid. */
export async function readRows(pids: number[], now = Date.now()): Promise<Map<number, RowWithRss>> {
  const out = new Map<number, RowWithRss>();
  const wanted = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  if (wanted.length === 0 || (process.platform !== 'darwin' && process.platform !== 'linux')) return out;
  const text = await new Promise<string>((resolve) => {
    execFile('ps', ['-o', 'pid=,ppid=,etime=,rss=,command=', '-p', wanted.join(',')],
      { timeout: READ_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => resolve(stdout ?? ''));
  });
  for (const raw of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(raw);
    if (!m) continue;
    const command = m[5]!.trim();
    if (!command) continue;
    out.set(Number(m[1]), {
      pid: Number(m[1]), ppid: Number(m[2]), startedAt: etimeToStart(m[3]!, now),
      rssBytes: Number(m[4]) * 1024, command,   // ps da KiB
    });
  }
  return out;
}

export async function readRow(pid: number, now = Date.now()): Promise<RowWithRss | undefined> {
  return (await readRows([pid], now)).get(pid);
}

/** ¿Se fue ya? Sondeo corto: `kill(pid, 0)` no cuesta nada. */
async function gone(pid: number, now: () => number, within: number): Promise<boolean> {
  const until = now() + within;
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (now() >= until) return false;
    await sleep(150);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
