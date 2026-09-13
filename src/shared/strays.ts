/**
 * Procesos que ORCA dejó atrás, y cómo se decide que lo son.
 *
 * La higiene mide lo que ORCA ocupa en DISCO. Esto es la otra mitad: lo que
 * ocupa en PROCESOS y PUERTOS. Un `npm run dev` que muere mal deja un Vite
 * escuchando en el 4478 para siempre; una consola que se cae deja su hub o su
 * collector reparentados a init; un pane cuyo programa salió se queda ahí; y un
 * agente puede seguir en el mundo con su proceso muerto hace horas.
 *
 * ── La regla que gobierna este archivo ─────────────────────────────
 *
 * **Matar exige evidencia positiva de orfandad; no matar es el valor por
 * defecto.** Es la misma asimetría que `hub/liveness.ts` escribió para los
 * agentes, y por la misma razón: los dos errores no cuestan lo mismo. Dejar
 * vivo un proceso huérfano cuesta memoria y un puerto. Matar uno vivo tira el
 * trabajo de alguien, y aquí «alguien» puede ser el servidor de desarrollo que
 * el operador tiene delante.
 *
 * Por eso NADA de esto basta por sí solo para declarar huérfano a un proceso:
 * llevar mucho rato arriba, estar ocioso, no aparecer en un latido, o tener un
 * puerto abierto. Lo único que cuenta es la combinación de tres hechos
 * comprobables:
 *
 *   1. **Es nuestro.** El proceso corre un entrypoint de ORCA, o un Vite cuyo
 *      **cwd es este repositorio**. Nunca por el nombre del programa: hay un
 *      Vite en cada proyecto de la máquina y `pkill vite` es exactamente lo
 *      que este módulo existe para no hacer.
 *   2. **ORCA lo lanzó y su dueño se fue.** No «no tiene padre»: eso NO es
 *      prueba de nada. `nohup`, `setsid`, `disown` y cualquier arranque
 *      deliberadamente desatendido dejan `ppid === 1` en un proceso
 *      perfectamente sano, que puede estar sirviendo otra consola en otro
 *      puerto. La prueba es un **lease** de ORCA (`shared/lease.ts`) que
 *      nombra a este proceso exacto y cuyo dueño ya no está. Sin lease, ORCA
 *      no lanzó esto y no puede saber si sobra: se enseña y no se toca.
 *   3. **Sigue siendo el mismo.** El pid y su hora de arranque se comprueban
 *      otra vez justo antes de terminarlo, junto con el lease y las
 *      protecciones. Un pid se reutiliza; matar por un pid leído hace un
 *      minuto es matar a un desconocido.
 *
 * Lo que cumple las tres es `orphan`. Lo que cumple la primera y falla alguna
 * de las otras es `ambiguous`: **se enseña y no se toca**. La consecuencia
 * práctica, dicha en voz alta: un Vite que alguien arrancó a mano, con o sin
 * `nohup`, NO es terminable desde aquí nunca. Sólo lo es lo que ORCA lanzó
 * ella misma y anotó. Y lo que se
 * reconoce como intocable —el hub, el collector, CAPCOM, un agente vivo, el
 * Vite de otro proyecto— sale marcado `protected` con el motivo, porque un
 * panel que esconde lo que decidió no tocar no deja comprobar la decisión.
 *
 * Todo lo de aquí es puro y toma la salida de `ps` como entrada, igual que
 * `hub/harness.ts` y por el mismo motivo: en un módulo cuyo trabajo es
 * terminar procesos, poder probarlo sin terminar ninguno no es un detalle de
 * estilo.
 */

import { LEASE_STALE_MS, leaseFor, leaseVerdict, type Lease } from './lease.ts';

/* ── lo que se lee de la máquina ──────────────────────────────────── */

/** Una línea de `ps`, ya en números. */
export interface ProcRow {
  pid: number;
  ppid: number;
  /** Cuándo arrancó, epoch ms. Null si `ps` no lo dio: sin esto no se mata. */
  startedAt: number | null;
  /** La línea de comandos entera. Se usa para reconocer, nunca se publica cruda. */
  command: string;
}

/**
 * `ps -eo pid=,ppid=,etime=,command=` → filas.
 *
 * `etime` y no `lstart` porque es el que tiene el mismo formato en macOS y en
 * Linux, y ya hay un lector suyo probado en `collector/hygiene.ts`.
 */
export function parsePs(text: string, now: number, etime: (s: string, now: number) => number | null): ProcRow[] {
  const out: ProcRow[] = [];
  for (const raw of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(raw);
    if (!m) continue;
    const command = m[4]!.trim();
    if (!command) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), startedAt: etime(m[3]!, now), command });
  }
  return out;
}

/* ── el hallazgo ──────────────────────────────────────────────────── */

/**
 * Qué clase de cosa quedó atrás.
 *
 *   `vite`   un servidor de desarrollo de ESTE repositorio
 *   `orca`   un entrypoint de ORCA: el hub, el collector, la CLI
 *   `pane`   un pane de tmux cuyo programa ya salió
 *   `agent`  un agente que sigue en el mundo sin proceso ni pane
 *   `session` lo contrario: una sesión que terminó y cuyo proceso sigue vivo,
 *            reteniendo su memoria. Lo decide `shared/reap.ts`.
 */
export type StrayKind = 'vite' | 'orca' | 'pane' | 'agent' | 'session';

/**
 * `orphan` cumple las tres condiciones y se puede limpiar. `ambiguous` es
 * nuestro pero algo no encaja: se enseña y no se toca. `protected` es algo que
 * ORCA reconoce y decide no tocar, con el motivo.
 */
export type StrayVerdict = 'orphan' | 'ambiguous' | 'protected';

/** Qué haría la limpieza. `retire` no mata nada: retira un registro. */
export type StrayAction = 'terminate' | 'retire' | 'none';

export interface Stray {
  id: string;
  kind: StrayKind;
  verdict: StrayVerdict;
  action: StrayAction;
  /** Lo que el operador lee para reconocerlo: «vite · :4478», «K9», el pane. */
  label: string;
  pid?: number;
  ppid?: number;
  /** Epoch ms. Es la mitad de la identidad: un pid sin hora no se termina. */
  startedAt?: number | null;
  /** Puertos que escucha, cuando se pudo saber. Informativo: nunca es prueba. */
  ports?: number[];
  /** RSS del proceso, medido en el escaneo. Sólo en `session`: es el coste que se enseña. */
  rssBytes?: number;
  /** El cwd, ya relativo a `~`. Sólo cuando se pudo leer con fiabilidad. */
  cwd?: string;
  /** El agente o el pane al que corresponde, cuando lo hay. */
  agentId?: string;
  pane?: string;
  /** Por qué. Una línea por hecho comprobado, tal cual se comprobó. */
  evidence: string[];
  /** Por qué NO se toca. Sólo en `protected` y en `ambiguous`. */
  why?: string;
}

/* ── reconocer lo nuestro ─────────────────────────────────────────── */

/**
 * ¿Es esta línea de comandos un Vite?
 *
 * Por la RUTA del binario dentro de `node_modules`, no por la palabra «vite»:
 * un editor abierto en un fichero llamado `vite.config.ts` también la lleva, y
 * el objetivo es no acertar por accidente.
 */
export function isViteCommand(command: string): boolean {
  return /node_modules\/(?:\.bin\/vite|vite\/bin\/vite\.js)(?:\s|$)/.test(command);
}

/**
 * Los entrypoints de ORCA que pueden quedarse colgados.
 *
 * `test/*` NO está aquí: los procesos del arnés tienen su propia operación
 * (`hub/harness.ts`), que sabe además a qué hub apuntan. Duplicar la lista
 * sería tener dos reglas para lo mismo, y la que discrepa siempre es la que
 * mata de más.
 */
export const ORCA_ENTRYPOINTS = ['src/orca.ts', 'src/hub/server.ts', 'src/collector/index.ts'] as const;

/** El entrypoint de ORCA que corre esta línea, o null. Exige la ruta del repo. */
export function orcaEntrypoint(command: string, repo: string): string | null {
  for (const e of ORCA_ENTRYPOINTS) {
    // Con la raíz del repo delante o como argumento suelto de un `tsx` cuyo
    // cwd ya se comprobó: las dos formas aparecen en la práctica.
    if (command.includes(`${repo}/${e}`) || new RegExp(`(?:^|\\s)${e.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?:\\s|$)`).test(command)) return e;
  }
  return null;
}

/* ── decidir ──────────────────────────────────────────────────────── */

export interface StrayScan {
  procs: ProcRow[];
  /** La raíz del repositorio de ORCA en esta máquina, absoluta. */
  repo: string;
  /** cwd por pid. Sin entrada = no se pudo leer, y eso vuelve todo ambiguo. */
  cwd: Map<number, string>;
  /** Puertos que escucha cada pid. Informativo. */
  ports: Map<number, number[]>;
  /**
   * Lo que ORCA lanzó y anotó (`shared/lease.ts`). Es la ÚNICA licencia para
   * ofrecer terminar algo: sin un lease que nombre a un proceso, no se ofrece.
   */
  leases: Lease[];
  /** Lo que ORCA sabe que es suyo y está vivo. Nada de esto se toca jamás. */
  own: {
    /** Este proceso y su padre: suicidarse en mitad de una limpieza no es contención. */
    self: number;
    parent: number;
    /** Los pids de la flota que el collector sabe vivos, CAPCOM incluido. */
    agents: number[];
    /**
     * Los puertos en los que hay una consola de ORCA sirviendo AHORA: el de
     * este ORCA y el de cualquier lease vivo. Se protege el conjunto, no sólo
     * el propio: dos consolas del mismo repositorio en puertos distintos son
     * dos cosas que alguien está usando, y sólo mirar la de uno mismo dejaba
     * la del vecino en la lista de lo matable.
     */
    consolePorts?: number[];
  };
  home: string;
  now: number;
}

function rel(p: string, home: string): string {
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/**
 * Los procesos que quedaron atrás, clasificados.
 *
 * Devuelve TODO lo que reconoce como suyo, incluido lo que no va a tocar: un
 * panel que sólo enseña lo que va a matar no deja comprobar por qué lo demás
 * se salvó, y esa comprobación es el único control que tiene el operador
 * sobre una operación que termina procesos.
 */
export function scanStrays(s: StrayScan): Stray[] {
  const byPid = new Map(s.procs.map((p) => [p.pid, p]));
  const out: Stray[] = [];
  const untouchable = new Set<number>([s.own.self, s.own.parent, ...s.own.agents]);

  for (const p of s.procs) {
    const vite = isViteCommand(p.command);
    const entry = vite ? null : orcaEntrypoint(p.command, s.repo);
    if (!vite && !entry) continue;

    const cwd = s.cwd.get(p.pid);
    const ports = s.ports.get(p.pid) ?? [];
    const evidence: string[] = [];
    const kind: StrayKind = vite ? 'vite' : 'orca';
    const label = vite ? `vite${ports.length ? ` · :${ports.join(', :')}` : ''}` : `orca · ${entry}`;
    const base = {
      id: `stray_${kind}_${p.pid}`,
      kind, label, pid: p.pid, ppid: p.ppid, startedAt: p.startedAt,
      ...(ports.length ? { ports } : {}),
      ...(cwd ? { cwd: rel(cwd, s.home) } : {}),
    };

    /*
     * PRIMERA CONDICIÓN: es nuestro.
     *
     * Para un Vite eso es su cwd, y sólo su cwd. Sin poder leerlo no se sabe
     * de quién es, y de lo que no se sabe no se dice nada: se enseña como
     * ambiguo. Con un cwd de otro proyecto se enseña como protegido, para que
     * quede constancia de que se miró y se descartó.
     */
    if (vite) {
      if (!cwd) {
        out.push({ ...base, verdict: 'ambiguous', action: 'none',
          evidence: ['a vite server, but its working directory could not be read'],
          why: 'without the working directory there is no way to tell whose vite this is' });
        continue;
      }
      const ours = cwd === s.repo || cwd.startsWith(`${s.repo}/`);
      if (!ours) {
        out.push({ ...base, verdict: 'protected', action: 'none',
          evidence: [`working directory is ${rel(cwd, s.home)}`],
          why: 'a dev server for another project: never ORCA\'s to stop' });
        continue;
      }
      evidence.push(`working directory is this repository (${rel(cwd, s.home)})`);
    } else {
      evidence.push(`runs ORCA's ${entry}`);
      if (cwd) evidence.push(`working directory ${rel(cwd, s.home)}`);
    }

    // SEGUNDA CONDICIÓN: nadie lo tiene.
    if (untouchable.has(p.pid)) {
      out.push({ ...base, verdict: 'protected', action: 'none',
        evidence: [...evidence, 'ORCA is running inside this process, or launched it'],
        why: 'this is ORCA itself' });
      continue;
    }
    const serving = (s.own.consolePorts ?? []).filter((n) => ports.includes(n));
    if (serving.length) {
      out.push({ ...base, verdict: 'protected', action: 'none',
        evidence: [...evidence, `serving an ORCA console on :${serving.join(', :')}`],
        why: 'a console is being served on that port right now' });
      continue;
    }
    if (p.ppid !== 1) {
      const parent = byPid.get(p.ppid);
      out.push({ ...base, verdict: 'ambiguous', action: 'none',
        evidence: [...evidence, `parent ${p.ppid}${parent ? ` is alive (${short(parent.command)})` : ' is not in this listing'}`],
        why: parent
          ? 'something launched it and is still there: it is somebody\'s dev server, not a leftover'
          : 'its parent is not on this listing; ORCA cannot tell whether it was adopted or died' });
      continue;
    }
    if (p.startedAt === null) {
      out.push({ ...base, verdict: 'ambiguous', action: 'none',
        evidence: [...evidence, 'start time unreadable'],
        why: 'without a start time the pid cannot be confirmed at kill time, and a pid gets reused' });
      continue;
    }

    /*
     * Aquí estaba el agujero. Antes, `ppid === 1` bastaba para ofrecerlo.
     *
     * No basta: `nohup`, `setsid` y `disown` dejan esa misma firma en un
     * proceso que alguien arrancó a propósito y que puede estar sirviendo otra
     * consola. Lo único que autoriza a ofrecer una terminación es que ORCA lo
     * lanzara ella misma, lo anotara, y su dueño ya no esté.
     */
    const verdict = leaseVerdict(leaseFor(s.leases, p.pid, p.startedAt, START_SKEW_MS), {
      now: s.now,
      alive: (pid, at) => {
        const q = byPid.get(pid);
        return !!q && (at === null || q.startedAt === null || Math.abs(q.startedAt - at) <= START_SKEW_MS);
      },
    });
    if (verdict.state === 'unleased') {
      out.push({ ...base, verdict: 'ambiguous', action: 'none',
        evidence: [...evidence, 'no parent, and no ORCA lease naming it'],
        why: 'ORCA did not start this, so it cannot tell whether it is wanted.'
          + ' Running with no parent is what nohup, setsid and disown all leave behind' });
      continue;
    }
    if (verdict.state === 'held') {
      out.push({ ...base, verdict: 'protected', action: 'none',
        evidence: [...evidence, verdict.why], why: 'ORCA started it and it is still claimed' });
      continue;
    }
    out.push({ ...base, verdict: 'orphan', action: 'terminate', evidence: [...evidence, verdict.why] });
  }

  return out.sort(order);
}

function short(command: string): string {
  const first = command.split(/\s+/)[0] ?? '';
  const name = first.slice(first.lastIndexOf('/') + 1);
  return name || 'unknown';
}

/** Lo que hay que decidir primero, arriba. */
function order(a: Stray, b: Stray): number {
  const rank = (s: Stray) => (s.verdict === 'orphan' ? 0 : s.verdict === 'ambiguous' ? 1 : 2);
  return rank(a) - rank(b) || a.kind.localeCompare(b.kind) || (a.pid ?? 0) - (b.pid ?? 0);
}

/* ── volver a mirar antes de matar ────────────────────────────────── */

/**
 * ¿Sigue siendo el mismo proceso?
 *
 * Se comprueba justo antes de terminarlo y con una lectura nueva de `ps`,
 * nunca con la del informe: entre que se pinta un panel y alguien pulsa un
 * botón pueden pasar minutos, y un pid se reutiliza. Tres cosas tienen que
 * seguir coincidiendo — el pid existe, arrancó cuando decía, y sigue
 * reparentado — porque cada una por su cuenta se puede repetir por casualidad
 * y las tres juntas no.
 *
 * `SKEW_MS` existe porque `etime` tiene resolución de segundos y la resta se
 * hace contra un reloj distinto en cada lectura.
 */
export const START_SKEW_MS = 4_000;

export function stillTheSame(before: Stray, now: ProcRow | undefined): { ok: true } | { ok: false; why: string } {
  if (!now) return { ok: false, why: 'the process is already gone' };
  if (before.startedAt === undefined || before.startedAt === null || now.startedAt === null) {
    return { ok: false, why: 'no start time to compare: refusing to act on the pid alone' };
  }
  if (Math.abs(now.startedAt - before.startedAt) > START_SKEW_MS) {
    return { ok: false, why: `pid ${before.pid} now belongs to a process started at a different time: it was reused` };
  }
  if (now.ppid !== 1) return { ok: false, why: `pid ${before.pid} has a parent again (${now.ppid}): it is not orphaned` };
  return { ok: true };
}

/* ── lo que salió de una limpieza ─────────────────────────────────── */

export interface StrayOutcome {
  id: string;
  label: string;
  /** `stopped` terminó de verdad · `refused` no pasó la revalidación · `failed` no se pudo. */
  result: 'stopped' | 'refused' | 'failed' | 'gone' | 'retired';
  /** Qué señal hizo falta, cuando hizo falta alguna. */
  signal?: 'TERM' | 'KILL';
  detail: string;
}

/** Cuánto se espera a que un `SIGTERM` haga efecto antes de subir a `SIGKILL`. */
export const TERM_GRACE_MS = 4_000;
