/**
 * Cerrar el proceso de un agente cuando su sesión ya terminó.
 *
 * Existe por un hecho medido el 2026-09-13: tres agentes que habían entregado
 * seguían con su proceso vivo —612M, 464M y 490M, 1,5G retenidos— y dos de
 * ellos se habían detenido expresamente desde el hub, que los daba por
 * detenidos. La máquina no. Detener una sesión terminaba la SESIÓN (Ctrl-C,
 * `kill-session`, `claude stop`) y nada miraba si el proceso se había ido.
 *
 * ── La decisión, tomada por el operador ────────────────────────────
 *
 * El cierre va DENTRO de la detención, no en una herramienta aparte que alguien
 * tenga que recordar: detener tiene dos efectos, la sesión termina y su
 * proceso se cierra. Y si un agente termina solo y deja proceso, se cierra
 * igual. Pero con cinco condiciones, y cada una es una puerta que se cruza en
 * orden y no un matiz:
 *
 *   1. **Sólo procesos que ORCA lanzó.** `origin === 'orca'`, que el linaje
 *      verifica por el registro de spawns. Una sesión externa —las que el
 *      operador abre en su terminal— nunca, y «no se sabe» cuenta como externa.
 *   2. **Sólo cuando la sesión ya terminó**, nunca como forma de terminarla.
 *      Cerrar el proceso de un agente que escribe un fichero es corromperlo.
 *   3. **Nunca el collector, nunca el hub, nunca CAPCOM.** Ni ningún pid que
 *      la liveness liste vivo: un fallo aquí se lleva la capacidad de verlo.
 *   4. **La identidad se verifica justo antes**, con una lectura nueva de `ps`:
 *      mismo pid, misma hora de arranque, MISMA línea de comandos. Los pids se
 *      reciclan, y al ir dentro de la detención nadie va a pensarlo dos veces.
 *   5. **Se dice qué se liberó**, con el RSS medido antes de la señal, para que
 *      «se recuperaron 1,5G» sea comprobable.
 *
 * Y una consecuencia de la forma: detener puede fallar por una razón nueva,
 * que el proceso no cierre. Eso NO es una detención fallida —la sesión sí
 * terminó— y por eso el resultado lleva las dos partes separadas
 * (`StopOutcome`). Colapsarlas en un `ok` sería volver a confundir lo que el
 * hub cree con lo que la máquina hace, que es el defecto que esto cierra.
 *
 * Todo lo de aquí es puro y toma la salida de `ps` como entrada, como
 * `shared/strays.ts` y por el mismo motivo: en un módulo cuyo trabajo es
 * terminar procesos, poder probarlo sin terminar ninguno no es un detalle.
 */

import { formatBytes } from './hygiene.ts';
import { START_SKEW_MS, isViteCommand, orcaEntrypoint, type ProcRow, type Stray } from './strays.ts';

/* ── lo que ORCA recuerda de cada sesión ─────────────────────────── */

/**
 * De dónde salió el pid. Es la mitad de la «pertenencia»: un pid que ORCA leyó
 * del pane que ella misma creó (`orca-<sessionId>`) o del listado del CLI
 * mientras la sesión vivía, o uno encontrado en `ps` por llevar el id de la
 * sesión en su línea de comandos.
 */
export type ProcSource = 'pane' | 'cli' | 'argv';

/** La identidad de un proceso, tomada mientras la sesión estaba viva. */
export interface SessionProc {
  sessionId: string;
  pid: number;
  /** Epoch ms. Sin hora de arranque no se cierra nada. */
  startedAt: number | null;
  /** La línea de comandos ENTERA, tal cual la dio `ps`. Se compara, no se publica. */
  command: string;
  source: ProcSource;
  /** Cuándo se tomó la identidad. */
  seenAt: number;
}

/* ── reconocer un runtime de agente ──────────────────────────────── */

/**
 * ¿Es esta línea de comandos uno de los programas que ORCA lanza como agente?
 *
 * Lista permitida de formas OBSERVADAS en la flota, no una lista de lo
 * prohibido: `~/.local/bin/claude …` con sus argumentos, y el Codex de npm
 * (`node …/bin/codex` y su binario nativo `…/codex-darwin-arm64/…/bin/codex`).
 * Lo que no encaja no se cierra, aunque todo lo demás cuadre: reconocer por
 * exclusión es lo que un día mata al proceso equivocado.
 */
export type RuntimeShape = 'claude' | 'codex';

export function runtimeShape(command: string): RuntimeShape | null {
  const first = command.split(/\s+/)[0] ?? '';
  const name = first.slice(first.lastIndexOf('/') + 1);
  if (name === 'claude') return 'claude';
  if (name === 'codex') return 'codex';
  if (name === 'node' && /(?:^|\s)\S*\/bin\/codex(?:\s|$)/.test(command)) return 'codex';
  return null;
}

/**
 * El id de sesión que una línea de comandos de `claude` lleva puesto, o null.
 *
 * ORCA lanza hospedado con `--session-id <uuid>` y reanuda con `--resume
 * <uuid>`: son las dos formas con las que un proceso encontrado en `ps` se
 * puede atar a una sesión sin haberlo visto nacer.
 */
export function sessionIdInCommand(command: string): string | null {
  const m = /(?:^|\s)--(?:session-id|resume)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s|$)/i.exec(command);
  return m ? m[1]!.toLowerCase() : null;
}

/* ── decidir ──────────────────────────────────────────────────────── */

/** Lo que el collector sabe del agente al que pertenece el proceso. */
export interface ReapAgent {
  callsign: string;
  /** Procedencia verificada por el linaje. Ausente = no se sabe = no se toca. */
  origin?: 'orca' | 'external';
  role?: string;
  subagent?: boolean;
}

export interface ReapSubject {
  proc: SessionProc;
  /** null cuando ORCA no observa ya ningún agente con ese id. */
  agent: ReapAgent | null;
  /** La fila de `ps` de ese pid, leída AHORA. undefined = ya no está. */
  now: ProcRow | undefined;
  /** ¿Terminó la sesión, y por qué se sabe? Nunca se cierra sin esto. */
  session: { ended: boolean; why: string };
  /** Pids que no se señalan jamás: este proceso, su padre, y todo lo que la liveness lista vivo. */
  untouchable: ReadonlySet<number>;
  /** La raíz del repositorio de ORCA, para reconocer sus propios entrypoints. */
  repo: string;
}

export type ReapRefusal =
  /** No hay agente con ese id: no se sabe de quién es. */
  | 'unknown'
  /** El agente no lo lanzó ORCA, o no consta que lo hiciera. */
  | 'external'
  | 'capcom'
  | 'subagent'
  /** El hub, el collector, la CLI de ORCA o un Vite: ORCA misma. */
  | 'orca-self'
  /** La línea de comandos no es la de un runtime que ORCA lance. */
  | 'not-a-runtime'
  /** La sesión no ha terminado. */
  | 'session-alive'
  /** La liveness lo lista vivo, o es este proceso o su padre. */
  | 'untouchable'
  /** El pid existe pero no es el mismo proceso: otra hora, otra orden. */
  | 'reused'
  /** Sin hora de arranque no hay identidad que comprobar. */
  | 'no-identity';

export type ReapDecision =
  | { act: 'terminate'; evidence: string[] }
  | { act: 'refuse'; reason: ReapRefusal; why: string; evidence: string[] }
  | { act: 'gone'; why: string };

/**
 * ¿Se puede cerrar este proceso?
 *
 * Las puertas van en el orden de la cabecera, y la primera que no se cruza
 * decide: así el motivo que se devuelve es el primero que importa, y las
 * comprobaciones caras (la identidad contra `ps`) sólo se hacen cuando lo
 * demás ya cuadra.
 */
export function decideReap(s: ReapSubject): ReapDecision {
  const { proc, agent } = s;
  const evidence: string[] = [];
  const refuse = (reason: ReapRefusal, why: string): ReapDecision => ({ act: 'refuse', reason, why, evidence });

  // 1. Sólo lo que ORCA lanzó.
  if (!agent) return refuse('unknown', `ORCA does not observe any agent for session ${proc.sessionId.slice(0, 8)}: nothing says who owns pid ${proc.pid}`);
  if (agent.origin !== 'orca') {
    return refuse('external', agent.origin === 'external'
      ? `${agent.callsign} was not launched by ORCA: an external session is never ORCA's to close`
      : `${agent.callsign} has no verified launch provenance: treated as external`);
  }
  evidence.push(`ORCA launched ${agent.callsign} (verified by the spawn record)`);

  // 3. Nunca CAPCOM, nunca un subagente (su padre manda), nunca ORCA misma.
  if (agent.role === 'capcom') return refuse('capcom', `${agent.callsign} is CAPCOM: never closed from here`);
  if (agent.subagent) return refuse('subagent', `${agent.callsign} is a subagent: its parent owns the process`);
  if (isViteCommand(proc.command) || orcaEntrypoint(proc.command, s.repo)) {
    return refuse('orca-self', `pid ${proc.pid} runs ORCA itself, not an agent`);
  }
  const shape = runtimeShape(proc.command);
  if (!shape) return refuse('not-a-runtime', `pid ${proc.pid} does not run a CLI ORCA launches (${shortCommand(proc.command)})`);
  evidence.push(`pid ${proc.pid} runs ${shape}, observed ${sourceWord(proc.source)}`);

  // 2. Sólo cuando la sesión ya terminó.
  if (!s.session.ended) return refuse('session-alive', `${agent.callsign}'s session has not ended: ${s.session.why}`);
  evidence.push(s.session.why);

  // 3, otra vez: nada que la liveness liste vivo, ni este proceso ni su padre.
  if (s.untouchable.has(proc.pid)) {
    return refuse('untouchable', `pid ${proc.pid} is listed alive right now, or is ORCA's own process`);
  }

  // 4. La identidad, contra una lectura nueva de ps.
  if (!s.now) return { act: 'gone', why: `pid ${proc.pid} is not running: nothing to free` };
  if (proc.startedAt === null || s.now.startedAt === null) {
    return refuse('no-identity', `no start time for pid ${proc.pid}: refusing to act on the number alone`);
  }
  if (Math.abs(s.now.startedAt - proc.startedAt) > START_SKEW_MS) {
    return refuse('reused', `pid ${proc.pid} now belongs to a process started at a different time: it was reused`);
  }
  if (s.now.command !== proc.command) {
    return refuse('reused', `pid ${proc.pid} now runs a different command (${shortCommand(s.now.command)}): it was reused`);
  }
  evidence.push(`pid ${proc.pid} still has the start time and command line ORCA recorded`);
  return { act: 'terminate', evidence };
}

function sourceWord(source: ProcSource): string {
  return source === 'pane' ? 'as the pid of its own ORCA pane'
    : source === 'cli' ? 'in the CLI\'s own session listing'
      : 'by the session id on its command line';
}

/** Los primeros caracteres de una orden, sin la ruta del binario. */
export function shortCommand(command: string): string {
  const parts = command.split(/\s+/);
  const first = parts[0] ?? '';
  const name = first.slice(first.lastIndexOf('/') + 1) || 'unknown';
  const rest = parts.slice(1, 3).join(' ');
  return (rest ? `${name} ${rest}` : name).slice(0, 48);
}

/* ── lo que salió ────────────────────────────────────────────────── */

/** Qué pasó con el proceso, aparte de lo que pasó con la sesión. */
export interface ProcessOutcome {
  /**
   *   `freed`    se cerró y el RSS medido antes es lo que se recuperó
   *   `gone`     no había proceso que cerrar: se fue con la sesión
   *   `kept`     lo había y NO se cerró, por una de las salvaguardas
   *   `failed`   se intentó y no murió, o la señal falló
   *   `unknown`  ORCA nunca supo el pid de esa sesión: no puede decir nada
   */
  result: 'freed' | 'gone' | 'kept' | 'failed' | 'unknown';
  pid?: number;
  /** RSS justo antes de la señal, cuando se pudo leer. */
  rssBytes?: number | null;
  signal?: 'TERM' | 'KILL';
  reason?: ReapRefusal;
  why: string;
}

/** Detener una sesión, en dos partes que no se mezclan. */
export interface StopOutcome {
  session: { stopped: boolean; detail: string };
  process: ProcessOutcome;
}

/** La línea del ack: primero la sesión, después el proceso, y nunca un solo veredicto. */
export function describeStop(o: StopOutcome): string {
  const session = o.session.stopped ? `sesión detenida (${o.session.detail})` : `sesión NO detenida: ${o.session.detail}`;
  return `${session} · ${describeProcess(o.process)}`;
}

export function describeProcess(p: ProcessOutcome): string {
  const rss = p.rssBytes !== undefined && p.rssBytes !== null ? ` · ${formatBytes(p.rssBytes)}` : '';
  switch (p.result) {
    case 'freed': return `proceso ${p.pid} liberado${rss}${p.signal === 'KILL' ? ' (SIGKILL)' : ''}`;
    case 'gone': return `proceso ${p.pid ? `${p.pid} ` : ''}ya no estaba`;
    case 'kept': return `proceso ${p.pid} NO liberado${rss}: ${p.why}`;
    case 'failed': return `proceso ${p.pid} NO liberado${rss}: ${p.why}`;
    default: return `proceso: ${p.why}`;
  }
}

/* ── lo que se enseña en el panel ────────────────────────────────── */

/**
 * «Sesión detenida, proceso vivo», como resto de higiene.
 *
 * Es la pieza que vale sola: hoy esa situación es invisible —el agente sale de
 * las listas y su medio giga se queda— y un informe que dijera «tres sesiones
 * detenidas retienen 1,5G» habría hecho innecesaria la investigación entera.
 * Va en la misma lista y con el mismo botón que los demás restos.
 */
export function sessionStray(
  s: { proc: SessionProc; callsign: string; state: string; rssBytes: number | null; pane: string | null },
  d: ReapDecision,
): Stray | null {
  if (d.act === 'gone') return null;
  const base = {
    id: `stray_session_${s.proc.sessionId}`,
    kind: 'session' as const,
    label: `${s.callsign} · ${s.state}${s.rssBytes !== null ? ` · ${formatBytes(s.rssBytes)} retained` : ''}`,
    pid: s.proc.pid,
    startedAt: s.proc.startedAt,
    agentId: s.proc.sessionId,
    ...(s.pane ? { pane: s.pane } : {}),
    ...(s.rssBytes !== null ? { rssBytes: s.rssBytes } : {}),
  };
  if (d.act === 'terminate') return { ...base, verdict: 'orphan', action: 'terminate', evidence: d.evidence };
  const protectedReasons: ReapRefusal[] = ['external', 'capcom', 'subagent', 'orca-self', 'untouchable', 'session-alive'];
  return {
    ...base,
    verdict: protectedReasons.includes(d.reason) ? 'protected' : 'ambiguous',
    action: 'none',
    evidence: d.evidence.length ? d.evidence : [d.why],
    why: d.why,
  };
}

/** Cuánto retienen entre todas las sesiones detenidas de una lista de restos. */
export function retainedBySessions(strays: Iterable<Stray>): { count: number; bytes: number } {
  let count = 0; let bytes = 0;
  for (const s of strays) {
    if (s.kind !== 'session' || s.verdict !== 'orphan') continue;
    count += 1; bytes += s.rssBytes ?? 0;
  }
  return { count, bytes };
}
