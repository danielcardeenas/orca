/**
 * Lo que ORCA dejó atrás en esta máquina: procesos, puertos y registros.
 *
 * La higiene mide el DISCO. Esto mide lo otro, y es lo que se acumula en una
 * máquina de desarrollo: un `npm run dev` que muere mal deja un Vite
 * escuchando para siempre; una consola que se cae deja su hub o su collector
 * reparentados a init; un pane cuyo programa salió se queda en el servidor de
 * tmux; y un agente puede seguir en el mundo con su proceso muerto hace horas.
 *
 * Las reglas de decisión están en `shared/strays.ts`, puras y probables sin
 * matar nada. Aquí está lo que no se puede hacer puro: leer `ps`, leer el cwd
 * de un pid, leer qué escucha en qué puerto, preguntarle a tmux, y —sólo
 * cuando alguien lo pide— terminar algo.
 *
 * ── Antes de terminar nada ─────────────────────────────────────────
 *
 * Se vuelve a leer `ps` ENTERO y se comprueba otra vez la identidad del
 * proceso: mismo pid, misma hora de arranque, sigue reparentado. Nunca se
 * actúa sobre la lectura del informe — entre pintar un panel y pulsar un botón
 * pueden pasar minutos, y un pid se reutiliza. Después `SIGTERM`, una espera, y
 * `SIGKILL` sólo si sigue ahí; y se cuenta lo que pasó de verdad, incluido que
 * no se pudo.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  START_SKEW_MS, TERM_GRACE_MS, parsePs, scanStrays, stillTheSame,
  type ProcRow, type Stray, type StrayOutcome,
} from '../shared/strays.ts';
import { LEASE_STALE_MS, isLease, leaseFor, leaseVerdict, type Lease } from '../shared/lease.ts';
import { orcaDir } from './util.ts';
import { etimeToStart } from './hygiene.ts';
import { sessionIdOfPane, type TmuxHost } from './tmux.ts';
import { errText, log } from './util.ts';

const SCOPE = 'strays';

/** La ruta sin enlaces, o la misma si no se puede resolver. */
function realpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

/** La raíz del repositorio de ORCA: `src/collector/` → `../..`. Ver shims.ts. */
export const ORCA_REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Cuánto puede tardar cada lectura de la máquina antes de rendirse. */
const READ_TIMEOUT_MS = 4_000;

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: READ_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // `lsof` sale con 1 cuando no encuentra nada: no es un fallo, es un cero.
      resolve(stdout || (err && !stdout ? '' : stdout));
    });
  });
}

/** Todas las líneas de `ps`, ya en números. */
export async function readProcs(now = Date.now()): Promise<ProcRow[]> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return [];
  return parsePs(await run('ps', ['-eo', 'pid=,ppid=,etime=,command=']), now, etimeToStart);
}

/**
 * El directorio de trabajo de cada pid, que es lo único que distingue el Vite
 * de este repositorio del de cualquier otro proyecto de la máquina.
 *
 * En Linux es un `readlink`. En macOS hace falta `lsof`, y si no está el mapa
 * sale vacío: sin cwd nada se declara huérfano, se declara ambiguo. Eso es
 * exactamente lo que tiene que pasar — el que no se puede identificar no se
 * toca — y por eso no hay una segunda vía «aproximada» aquí.
 */
export async function readCwds(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  if (process.platform === 'linux') {
    const fs = await import('node:fs/promises');
    await Promise.all(pids.map(async (pid) => {
      try { out.set(pid, await fs.readlink(`/proc/${pid}/cwd`)); } catch { /* se fue, o no es nuestro */ }
    }));
    return out;
  }
  if (process.platform !== 'darwin') return out;
  const text = await run('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]);
  let pid: number | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)) || null; continue; }
    if (line.startsWith('n') && pid !== null) { out.set(pid, line.slice(1)); pid = null; }
  }
  return out;
}

/**
 * Qué puertos TCP escucha cada pid.
 *
 * Informativo y nada más: un puerto abierto NO es prueba de orfandad —el
 * servidor legítimo también tiene uno— y no entra en ninguna decisión. Está
 * para que el operador reconozca lo que está mirando («vite · :4478») y para
 * poder proteger explícitamente el que sirve esta consola.
 */
export async function readListeners(): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (process.platform !== 'darwin' && process.platform !== 'linux') return out;
  const text = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  let pid: number | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)) || null; continue; }
    if (!line.startsWith('n') || pid === null) continue;
    const m = /:(\d+)$/.exec(line.slice(1));
    if (!m) continue;
    const port = Number(m[1]);
    const have = out.get(pid) ?? [];
    if (!have.includes(port)) have.push(port);
    out.set(pid, have);
  }
  return out;
}

/** Dónde apunta ORCA lo que lanza. Ver shared/lease.ts. */
export const LEASE_DIR = 'leases';

/**
 * Los leases que hay ahora mismo.
 *
 * Uno ilegible se ignora: lo escribe otro proceso y puede estar a medio
 * escribir. Uno cuyo proceso ya no existe se deja en disco — el que lo escribió
 * es quien lo borra, y que sobre es información, no basura.
 */
export async function readLeases(dir = path.join(orcaDir(), LEASE_DIR)): Promise<Lease[]> {
  let names: string[];
  try { names = await fs.promises.readdir(dir); } catch { return []; }
  const out: Lease[] = [];
  await Promise.all(names.filter((n) => n.endsWith('.json')).slice(0, 200).map(async (n) => {
    try {
      const v = JSON.parse(await fs.promises.readFile(path.join(dir, n), 'utf8')) as unknown;
      if (isLease(v)) out.push(v);
    } catch { /* a medio escribir, o basura: no es un lease */ }
  }));
  return out;
}

/* ── el vigía ─────────────────────────────────────────────────────── */

/** Lo que el collector sabe de sus propios agentes, para no tocarlos. */
export interface AgentView {
  sessionId: string;
  callsign: string;
  /** El estado derivado del transcript. Un `working` congelado es la pista. */
  state: string;
  /** Lo que dice la liveness del CLI. Su ausencia NO es prueba de nada. */
  alive: boolean;
  /** El pid, si ORCA llegó a saberlo. `null` es «no lo sé», no «no existe». */
  pid: number | null;
  /** El pane en el que vive, si dijo vivir en uno. */
  pane: string | null;
  /** Hace cuánto se movió su transcript. Informativo; nunca prueba por sí solo. */
  updatedAt: number;
}

export interface StrayDeps {
  tmux: TmuxHost;
  agents(): AgentView[];
  /**
   * ¿Ha llegado a mirar el collector la liveness de sus sesiones?
   *
   * Recién arrancado no ha mirado nada: su mapa está vacío y TODAS sus
   * sesiones parecen no estar vivas. Sin esta puerta, el primer barrido tras
   * cada reinicio declaraba fantasma a la flota entera — medido el 2026-09-08
   * contra la flota real: 27 agentes, todos vivos. Es el mismo error que
   * `hub/liveness.ts` documenta, cometido en otro sitio.
   */
  livenessReady(): boolean;
  home: string;
  /** El puerto en el que este ORCA sirve su consola, para protegerlo por nombre. */
  uiPort?: number;
  repo?: string;
  /** Dónde viven los leases. Sólo las pruebas lo cambian. */
  leaseDir?: string;
  now?(): number;
}

export class StrayWatch {
  private readonly now: () => number;
  private readonly repo: string;

  constructor(private readonly deps: StrayDeps) {
    this.now = deps.now ?? Date.now;
    /*
     * La raíz, resuelta de enlaces simbólicos.
     *
     * `lsof` y `/proc/<pid>/cwd` devuelven SIEMPRE la ruta real, y en macOS
     * `/var` es un enlace a `/private/var`: sin resolver, el cwd de un proceso
     * y la raíz que se le compara son dos cadenas distintas para el mismo
     * directorio, y todo lo de dentro del repositorio se clasificaría como «de
     * otro proyecto». Es decir: el detector no encontraría nada, en silencio.
     */
    this.repo = realpath(deps.repo ?? ORCA_REPO);
  }

  /**
   * Lo que quedó atrás, ahora mismo.
   *
   * Cuatro lecturas y ninguna cara: un `ps`, un `lsof` de cwd sobre los pocos
   * pids candidatos, un `lsof` de listeners, y un `list-sessions` de tmux. Se
   * llama con la muestra de higiene, que va en su propio reloj lento.
   */
  async scan(): Promise<Stray[]> {
    const now = this.now();
    const procs = await readProcs(now);
    const agents = this.deps.agents();

    // El cwd sólo de los que ya pintan algo: leerlo de trescientos procesos
    // costaría más que todo lo demás junto.
    const interesting = procs
      .filter((p) => p.command.includes('vite') || p.command.includes(this.repo) || p.command.includes('src/orca.ts'))
      .map((p) => p.pid);
    const [cwd, ports] = await Promise.all([readCwds(interesting), readListeners()]);

    const leases = await readLeases(this.deps.leaseDir);
    /*
     * Los puertos donde hay una consola sirviendo AHORA: el de este ORCA y el
     * de todo lease vivo. Se protege el conjunto y no sólo el propio, porque
     * dos consolas del mismo repositorio en puertos distintos son dos cosas
     * que alguien está usando.
     */
    const consolePorts = new Set<number>(this.deps.uiPort !== undefined ? [this.deps.uiPort] : []);
    for (const l of leases) {
      if (now - l.renewedAt >= LEASE_STALE_MS) continue;
      for (const port of l.ports ?? []) consolePorts.add(port);
    }

    const out = scanStrays({
      procs, cwd, ports, leases, repo: this.repo, home: this.deps.home, now,
      own: {
        self: process.pid,
        parent: process.ppid,
        agents: agents.map((a) => a.pid).filter((p): p is number => typeof p === 'number' && p > 0),
        consolePorts: [...consolePorts],
      },
    });

    const panes = await this.paneNames();
    out.push(...this.panesOf(procs, panes));
    out.push(...this.ghosts(procs, agents, new Set(panes.keys())));
    return out;
  }

  /**
   * Panes que ya no hospedan nada.
   *
   * Dos formas, y las dos son afirmaciones y no silencios: tmux dice que el
   * programa salió (`pane_dead`), o dice un pid que ya no existe en `ps`. Un
   * pane con un proceso vivo no es un resto por mucho que lleve ahí, y no
   * aparece.
   */
  /** Los panes vivos del servidor de ORCA. Vacío también cuando no hay tmux. */
  private async paneNames(): Promise<Awaited<ReturnType<TmuxHost['list']>>> {
    if (!this.deps.tmux.available()) return new Map();
    try { return await this.deps.tmux.list(); } catch { return new Map(); }
  }

  private panesOf(procs: ProcRow[], list: Awaited<ReturnType<TmuxHost['list']>>): Stray[] {
    const alive = new Set(procs.map((p) => p.pid));
    const out: Stray[] = [];
    for (const [name, info] of list) {
      const evidence: string[] = [];
      if (info.dead) evidence.push('tmux reports the pane\'s program has exited');
      else if (info.pid !== null && !alive.has(info.pid)) evidence.push(`tmux reports pid ${info.pid}, which is not running`);
      else continue;
      if (info.clients > 0) {
        out.push({
          id: `stray_pane_${name}`, kind: 'pane', verdict: 'ambiguous', action: 'none',
          label: `pane ${name}`, pane: name, evidence,
          why: `${info.clients} terminal(s) attached: somebody is looking at it`,
        });
        continue;
      }
      out.push({
        id: `stray_pane_${name}`, kind: 'pane', verdict: 'orphan', action: 'terminate',
        label: `pane ${name}`, pane: name,
        ...(sessionIdOfPane(name) ? { agentId: sessionIdOfPane(name)! } : {}),
        evidence: [...evidence, 'no terminal attached'],
      });
    }
    return out;
  }

  /**
   * Agentes que siguen en el registro sin nada detrás.
   *
   * Tres hechos a la vez, y ninguno vale solo: el transcript dejó congelado un
   * estado de trabajo, el CLI no lo lista, y no hay ni pane ni proceso. Un
   * agente terminado no aparece aquí —está terminado, no huérfano— y uno que
   * lleva rato callado tampoco: llevar rato callado es lo que hace un modelo
   * pensando, y confundir las dos cosas fue lo que casi tira siete agentes
   * vivos (ver hub/liveness.ts).
   *
   * La acción es RETIRAR el registro, nunca matar: no hay nada que matar, y
   * fingir que se mata algo que no existe es la clase de mentira que hace
   * inútil un panel.
   */
  private ghosts(procs: ProcRow[], agents: AgentView[], panes: Set<string>): Stray[] {
    // Sin haber mirado nunca, no se afirma nada. Ver `livenessReady`.
    if (!this.deps.livenessReady()) return [];
    const alive = new Set(procs.map((p) => p.pid));
    const out: Stray[] = [];
    for (const a of agents) {
      if (!CONSUMING.has(a.state)) continue;
      if (a.alive) continue;

      /*
       * La prueba positiva, y sin ella no hay fantasma.
       *
       * `pid === null` NO cuenta: significa «ORCA nunca supo su pid», que es
       * lo normal en una sesión `--bg`, y no «su proceso no existe». Tratar la
       * ausencia de dato como prueba de muerte es exactamente el error que
       * marcó muertos a 27 agentes vivos en la primera corrida real.
       */
      const evidence: string[] = [];
      if (a.pid !== null && !alive.has(a.pid)) evidence.push(`pid ${a.pid} is not running`);
      if (a.pane !== null && !panes.has(a.pane)) evidence.push(`its pane ${a.pane} is not on the tmux server`);
      if (evidence.length === 0) continue;

      out.push({
        id: `stray_agent_${a.sessionId}`, kind: 'agent', verdict: 'orphan', action: 'retire',
        label: `${a.callsign} · ${a.state}`, agentId: a.sessionId,
        ...(a.pid !== null ? { pid: a.pid } : {}),
        ...(a.pane !== null ? { pane: a.pane } : {}),
        evidence: [
          `its transcript is frozen at "${a.state}"`,
          'the CLI does not list the session any more',
          ...evidence,
        ],
      });
    }
    return out;
  }

  /* ── limpiar ────────────────────────────────────────────────────── */

  /**
   * Terminar lo que se pidió, y sólo si sigue siendo lo que era.
   *
   * `dryRun` hace todas las comprobaciones y no manda ninguna señal: es lo que
   * permite ver qué pasaría antes de que pase.
   */
  async clean(ids: string[], opts: { dryRun?: boolean } = {}): Promise<StrayOutcome[]> {
    const wanted = new Set(ids);
    const found = await this.scan();
    const out: StrayOutcome[] = [];

    for (const id of wanted) {
      const s = found.find((x) => x.id === id);
      if (!s) { out.push({ id, label: id, result: 'gone', detail: 'not on the machine any more' }); continue; }
      if (s.verdict !== 'orphan') {
        out.push({ id, label: s.label, result: 'refused', detail: s.why ?? `${s.verdict}: not offered for cleaning` });
        continue;
      }
      if (s.kind === 'agent') {
        // El registro lo retira el hub por su flujo de archivo, no esto.
        out.push({ id, label: s.label, result: 'retired', detail: 'handed to the archive flow; no process was touched' });
        continue;
      }
      if (s.kind === 'pane') { out.push(await this.killPane(s, opts.dryRun === true)); continue; }
      out.push(await this.killProc(s, opts.dryRun === true));
    }
    return out;
  }

  private async killPane(s: Stray, dryRun: boolean): Promise<StrayOutcome> {
    if (!s.pane) return { id: s.id, label: s.label, result: 'failed', detail: 'no pane name' };
    if (dryRun) return { id: s.id, label: s.label, result: 'stopped', detail: 'dry run: the pane would be killed' };
    const r = await this.deps.tmux.kill(s.pane);
    return r.ok
      ? { id: s.id, label: s.label, result: 'stopped', detail: 'pane killed' }
      : { id: s.id, label: s.label, result: 'failed', detail: r.detail || 'tmux refused' };
  }

  /**
   * Terminar un proceso, con la identidad comprobada otra vez y con educación.
   *
   * La revalidación usa una lectura de `ps` NUEVA, no la del escaneo: el
   * escaneo puede tener minutos. Y `SIGTERM` antes que `SIGKILL` porque un
   * Vite cierra su puerto y sus watchers al recibirlo, y matarlo en seco deja
   * a veces el socket ocupado — que es justo el recurso que se quería liberar.
   */
  private async killProc(s: Stray, dryRun: boolean): Promise<StrayOutcome> {
    if (typeof s.pid !== 'number') return { id: s.id, label: s.label, result: 'failed', detail: 'no pid' };
    /*
     * Volver a mirarlo todo, no sólo el pid.
     *
     * La identidad (pid y hora de arranque) es lo primero, pero no es
     * suficiente: entre el escaneo y el clic el dueño puede haber vuelto, el
     * lease puede haberse renovado, o el proceso puede haber empezado a servir
     * una consola. Cualquiera de esas cosas lo devuelve a intocable.
     */
    const fresh = await readProcs(this.now());
    const same = stillTheSame(s, fresh.find((p) => p.pid === s.pid));
    if (!same.ok) return { id: s.id, label: s.label, result: 'refused', detail: same.why };
    const byPid = new Map(fresh.map((p) => [p.pid, p]));
    const leases = await readLeases(this.deps.leaseDir);
    const claim = leaseVerdict(leaseFor(leases, s.pid, s.startedAt ?? null, START_SKEW_MS), {
      now: this.now(),
      alive: (pid, at) => {
        const q = byPid.get(pid);
        return !!q && (at === null || q.startedAt === null || Math.abs(q.startedAt - at) <= START_SKEW_MS);
      },
    });
    if (claim.state !== 'abandoned') {
      return {
        id: s.id, label: s.label, result: 'refused',
        detail: claim.state === 'unleased'
          ? 'ORCA has no lease for it any more: it is not ORCA\'s to stop'
          : `it is claimed again: ${claim.why}`,
      };
    }
    const nowPorts = (await readListeners()).get(s.pid) ?? [];
    const serving = nowPorts.filter((n) => (this.deps.uiPort !== undefined && n === this.deps.uiPort)
      || leases.some((l) => this.now() - l.renewedAt < LEASE_STALE_MS && (l.ports ?? []).includes(n)));
    if (serving.length) {
      return { id: s.id, label: s.label, result: 'refused', detail: `it is serving a console on :${serving.join(', :')}` };
    }
    if (dryRun) return { id: s.id, label: s.label, result: 'stopped', signal: 'TERM', detail: 'dry run: SIGTERM would be sent' };

    try { process.kill(s.pid, 'SIGTERM'); }
    catch (err) { return { id: s.id, label: s.label, result: 'failed', detail: `SIGTERM: ${errText(err)}` }; }
    log('info', SCOPE, `SIGTERM a ${s.label} (pid ${s.pid})`);

    if (await this.gone(s.pid)) {
      return { id: s.id, label: s.label, result: 'stopped', signal: 'TERM', detail: 'exited on SIGTERM' };
    }
    try { process.kill(s.pid, 'SIGKILL'); }
    catch (err) { return { id: s.id, label: s.label, result: 'failed', detail: `SIGKILL: ${errText(err)}` }; }
    if (await this.gone(s.pid, 1_000)) {
      return { id: s.id, label: s.label, result: 'stopped', signal: 'KILL', detail: `did not exit in ${TERM_GRACE_MS / 1000}s; killed` };
    }
    return { id: s.id, label: s.label, result: 'failed', signal: 'KILL', detail: 'still running after SIGKILL' };
  }

  /** ¿Se fue ya? Sondeo corto: `kill(pid, 0)` no cuesta nada. */
  private async gone(pid: number, within = TERM_GRACE_MS): Promise<boolean> {
    const until = this.now() + within;
    for (;;) {
      try { process.kill(pid, 0); } catch { return true; }
      if (this.now() >= until) return false;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

/** Estados en los que un agente AFIRMA estar consumiendo. Ver hub/liveness.ts. */
const CONSUMING: ReadonlySet<string> = new Set(['booting', 'thinking', 'working']);
