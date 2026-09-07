/**
 * Pieza A del squad autonomy: wake. Lado hub.
 *
 * CAPCOM es una sesión CLI: sólo piensa cuando alguien le pega un turno. Un
 * worker que termina no le pega ninguno, así que sin este módulo un CAPCOM
 * que lanzó tres agentes a las 10:00 sigue sin saber a las 11:00 que los tres
 * acabaron a las 10:20. El operador lo descubre él, y el mando que se compró
 * para no tener que mirar la flota es el que menos la mira.
 *
 * Dos despertadores, mismo canal (el router de CAPCOM, `sayToCapcom`):
 *
 *   [AGENT <callsign> <estado>]  un worker que CAPCOM lanzó —o que está
 *                                asignado a una tarea— pasó a done, dead,
 *                                idle o blocked. Con proyecto, squad, task y
 *                                lo último que dijo.
 *   [HEARTBEAT]                  N minutos sin turnos: llama a `briefing` y
 *                                actúa sólo si hay algo que hacer.
 *
 * ── Ruido ─────────────────────────────────────────────────────────
 *
 * Un turno de CAPCOM cuesta lo que cuesta un turno de CLI, y un CAPCOM que
 * recibe un mensaje por cada parpadeo de estado se pasa el día contestando
 * "nada nuevo". Tres reglas lo evitan:
 *
 *   - **Coalescing.** Los fines se juntan una ventana corta (5 s) y salen en
 *     un solo mensaje. Un squad de cinco que termina a la vez es un turno.
 *   - **Asentamiento del idle.** `idle` cuenta sólo si el agente sigue idle
 *     pasados unos segundos: un CLI pasa por idle entre dos llamadas a
 *     herramienta y vuelve a working antes de que nadie lo vea.
 *   - **Un idle por tramo de trabajo.** Reportado el primer idle, el agente
 *     tiene que volver a trabajar (thinking/working) para que otro idle
 *     cuente. Los estados finales (done/dead) cuentan siempre.
 *
 * ── Nunca el histórico ────────────────────────────────────────────
 *
 * Medido el 2026-09-06: un hub bajo `tsx watch` reinicia con cada edición, el
 * mundo se reconstruye, y cada agente viejo cruza booting → done en el hub.
 * CAPCOM recibió de golpe 30 avisos de agentes que terminaron hace días, y
 * luego 39. Por eso un fin cuenta sólo si es una transición **en vivo**:
 * `from` es un estado de trabajo (o blocked, tras haber trabajado) y este
 * módulo vio al agente trabajar desde que arrancó. Lo que ya estaba
 * terminado al arrancar se marca como visto, y una marca de agua en
 * `deps.dir/wake.json` recuerda entre reinicios qué se entregó ya.
 *
 * Y sólo despierta lo que es de CAPCOM: hijos de una sesión `role:'capcom'`
 * (de cualquiera, porque CAPCOM rota y cambia de id), miembros de un squad
 * cuyo lead lo es, o agentes de una tarea activa. `origin:'orca'` a secas no
 * basta: un squad que el humano lanzó desde la consola también es orca.
 *
 * Sin CAPCOM vivo nada se pierde: lo pendiente espera en este módulo y sale,
 * junto, en cuanto aparece una sesión con `role:'capcom'`. Si la que hay se
 * está reciclando, el router ya retiene el correo por su cuenta.
 *
 * Todo el reloj viene inyectado por `AutonomyDeps`, así que los tests
 * avanzan minutos en un milisegundo.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Agent } from '../shared/types.ts';
import type { AutonomyDeps } from './autonomy.ts';
import type { CapcomTimer } from './capcom.ts';
import type { AgentStateChange } from './lifecycle.ts';

/** Prefijos estables: el brief los nombra y CAPCOM los distingue por ellos. */
export const AGENT_WAKE_PREFIX = 'AGENT';
export const HEARTBEAT_PREFIX = 'HEARTBEAT';

/** Cuánto del último mensaje del agente viaja en el despertador. */
export const WAKE_LAST_SAY_CHARS = 400;
/** Cuántos fines se retienen sin CAPCOM antes de olvidar los más viejos. */
export const WAKE_QUEUE_MAX = 50;
/** Cada cuánto se comprueba si toca latido o hay cola por entregar. */
export const HEARTBEAT_TICK_MS = 30_000;

export interface WakeConfig {
  /** Despertar por fin de worker. `ORCA_CAPCOM_WAKE=0` lo apaga. */
  enabled: boolean;
  /** Ventana en la que los fines se juntan en un mensaje. `ORCA_CAPCOM_WAKE_COALESCE_MS`. */
  coalesceMs: number;
  /** Cuánto debe seguir idle un agente para que el idle cuente. `ORCA_CAPCOM_WAKE_IDLE_SETTLE_MS`. */
  idleSettleMs: number;
  /** Qué estados despiertan. `ORCA_CAPCOM_WAKE_STATES`, lista separada por comas. */
  states: ReadonlySet<string>;
  /** Minutos sin turnos antes de un latido. `ORCA_CAPCOM_HEARTBEAT_MIN`; 0 apaga. */
  heartbeatMin: number;
}

export const WAKE_DEFAULTS: Readonly<WakeConfig> = {
  enabled: true,
  coalesceMs: 5_000,
  idleSettleMs: 3_000,
  states: new Set(['done', 'dead', 'idle', 'blocked']),
  heartbeatMin: 15,
};

/** Lee la configuración del entorno. Lo que no parsea conserva el default. */
export function wakeConfig(env: Record<string, string | undefined> = process.env): WakeConfig {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const statesRaw = env['ORCA_CAPCOM_WAKE_STATES'];
  const states = statesRaw && statesRaw.trim()
    ? new Set(statesRaw.split(',').map((s) => s.trim()).filter(Boolean))
    : WAKE_DEFAULTS.states;
  return {
    enabled: env['ORCA_CAPCOM_WAKE'] !== '0',
    coalesceMs: Math.floor(num('ORCA_CAPCOM_WAKE_COALESCE_MS', WAKE_DEFAULTS.coalesceMs)),
    idleSettleMs: Math.floor(num('ORCA_CAPCOM_WAKE_IDLE_SETTLE_MS', WAKE_DEFAULTS.idleSettleMs)),
    states,
    heartbeatMin: num('ORCA_CAPCOM_HEARTBEAT_MIN', WAKE_DEFAULTS.heartbeatMin),
  };
}

/** Un fin de worker, tal como va a viajar. Se construye al ocurrir, no al entregar. */
export interface WakeEntry {
  agentId: string;
  callsign: string;
  state: string;
  project: string | null;
  squad: string | null;
  taskId: string | null;
  lastSay: string | null;
  at: number;
}

/* ── formato ──────────────────────────────────────────────────────── */

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * `[AGENT K9 done] project: orca · squad: audit-01 · task: task_x`
 * `  last: lo último que dijo, en una línea, recortado`
 *
 * El prefijo va primero y entre corchetes por la misma razón que en las
 * escalaciones: es lo único que un modelo encuentra siempre. El task va en la
 * cabecera porque es lo que CAPCOM tiene que citar en `report_task`.
 */
export function agentWakeLine(e: WakeEntry): string {
  const facts = [
    `project: ${e.project ?? '?'}`,
    e.squad ? `squad: ${e.squad}` : null,
    e.taskId ? `task: ${e.taskId}` : null,
  ].filter((s): s is string => s !== null);
  const head = `[${AGENT_WAKE_PREFIX} ${e.callsign} ${e.state}] ${facts.join(' · ')}`;
  const last = e.lastSay ? oneLine(e.lastSay, WAKE_LAST_SAY_CHARS) : '';
  return last ? `${head}\n  last: ${last}` : `${head}\n  last: (nothing said)`;
}

/** Varios fines, un mensaje. La primera línea siempre empieza por el prefijo. */
export function agentWakeMessage(entries: WakeEntry[]): string {
  const body = entries.map(agentWakeLine).join('\n');
  if (entries.length === 1) return body;
  return `${body}\n(${entries.length} workers finished. Handle each: report_task where there is a task, then chain or close.)`;
}

export function heartbeatMessage(quietMin: number): string {
  return `[${HEARTBEAT_PREFIX}] ${quietMin} min without a turn. Call briefing. Act only if something is owed`
    + ' — a blocked agent, a task waiting on you, a finished worker nobody reported.'
    + ' If nothing needs you, do nothing and do not reply to the operator.';
}

/* ── marca de agua ────────────────────────────────────────────────── */

/** Nombre del archivo bajo `deps.dir`. */
export const WAKE_STATE_FILE = 'wake.json';
/** Agentes recordados como entregados; más viejos que esto se olvidan. */
export const WAKE_SEEN_MAX = 2000;

export interface WakeWatermark {
  /** Último estado entregado (o ya terminado al arrancar) por agente. */
  seen: Record<string, { state: string; at: number }>;
  /** Cuándo salió el último `[AGENT …]`. 0 = nunca. */
  lastDeliveredAt: number;
  /** Sesiones CAPCOM conocidas, vivas o no: sus hijos siguen siendo workers. */
  capcoms: string[];
}

export function emptyWatermark(): WakeWatermark {
  return { seen: {}, lastDeliveredAt: 0, capcoms: [] };
}

export function loadWatermark(dir: string): WakeWatermark {
  const file = path.join(dir, WAKE_STATE_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WakeWatermark>;
    const seen: WakeWatermark['seen'] = {};
    for (const [id, v] of Object.entries(raw.seen ?? {})) {
      if (v && typeof v === 'object' && typeof v.state === 'string' && typeof v.at === 'number') seen[id] = { state: v.state, at: v.at };
    }
    return {
      seen,
      lastDeliveredAt: typeof raw.lastDeliveredAt === 'number' ? raw.lastDeliveredAt : 0,
      capcoms: Array.isArray(raw.capcoms) ? raw.capcoms.filter((c): c is string => typeof c === 'string') : [],
    };
  } catch {
    return emptyWatermark();
  }
}

/** tmp + rename, síncrono, como tasks.ts: un reinicio a mitad deja el anterior, no medio archivo. */
export function saveWatermark(dir: string, wm: WakeWatermark): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, WAKE_STATE_FILE);
  const ids = Object.keys(wm.seen);
  if (ids.length > WAKE_SEEN_MAX) {
    const drop = ids.sort((a, b) => wm.seen[a]!.at - wm.seen[b]!.at).slice(0, ids.length - WAKE_SEEN_MAX);
    for (const id of drop) delete wm.seen[id];
  }
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(wm), { mode: 0o600 });
  fs.renameSync(temp, file);
}

/* ── la pieza ─────────────────────────────────────────────────────── */

export interface WakeApi {
  config: WakeConfig;
  /** Fines aún no entregados (sin CAPCOM, o dentro de la ventana de coalescing). */
  pending(): number;
  /**
   * Entrega ahora lo que espera, si hay CAPCOM. Se llama sola cuando aparece
   * uno y en cada tick; expuesta para tests y diagnóstico. Cuántos fines salieron.
   */
  flush(): number;
  /**
   * Un tick del latido: manda `[HEARTBEAT]` si tocan y no hay nada en curso.
   * Se llama sola cada `HEARTBEAT_TICK_MS`; expuesta para tests. True si se mandó.
   */
  heartbeat(): boolean;
  /** Cuándo CAPCOM tuvo su último turno, según lo que este módulo vio. */
  lastTurnAt(): number;
  /**
   * Copia de la marca de agua en memoria. Para tests y diagnóstico.
   *
   * Copia y no la referencia: quien la lee no debe poder mutarla, ni ver por
   * alias lo que se anote después de haberla pedido.
   */
  watermark(): WakeWatermark;
  stop(): void;
}

/** Estados desde los que un fin es una transición en vivo. */
const LIVE_FROM: ReadonlySet<string> = new Set(['thinking', 'working', 'blocked']);
const FINISHED: ReadonlySet<string> = new Set(['done', 'dead', 'idle', 'blocked']);

const BUSY_STATES: ReadonlySet<string> = new Set(['booting', 'thinking', 'working']);
const WORKING_STATES: ReadonlySet<string> = new Set(['thinking', 'working']);

export function createWake(deps: AutonomyDeps): WakeApi {
  const config = wakeConfig(deps.env);

  /** Fines listos para salir, en orden de llegada. */
  let queue: WakeEntry[] = [];
  /** La ventana de coalescing abierta, si la hay. */
  let coalesce: CapcomTimer | null = null;
  /** Idles a la espera de asentarse, por agente. */
  const settling = new Map<string, CapcomTimer>();
  /**
   * Agentes cuyo idle ya se reportó y no han vuelto a trabajar desde
   * entonces. Un segundo idle sin trabajo en medio es el mismo idle.
   */
  const idleReported = new Set<string>();
  /**
   * Agentes que este módulo vio trabajar desde que arrancó. Sólo ellos pueden
   * despertar: un agente que aparece ya terminado es historia, no un fin.
   */
  const seenWorking = new Set<string>();
  const wm = loadWatermark(deps.dir);
  const capcoms = new Set<string>(wm.capcoms);
  let lastTurn = deps.now();
  let stopped = false;

  function persist(): void {
    wm.capcoms = [...capcoms];
    try { saveWatermark(deps.dir, wm); }
    catch (err) { deps.log(`wake: no pude guardar ${WAKE_STATE_FILE}: ${String(err)}`); }
  }

  /** Recuerda una sesión CAPCOM; sus hijos son workers aunque ella ya no esté. */
  function noteCapcom(a: Agent): boolean {
    if (a.role !== 'capcom' || capcoms.has(a.id)) return false;
    capcoms.add(a.id);
    return true;
  }

  /* ── quién cuenta ─────────────────────────────────────────────── */

  function taskOf(agentId: string): string | null {
    for (const t of Object.values(deps.tasks())) {
      if (t.status === 'active' && t.agentIds.includes(agentId)) return t.id;
    }
    return null;
  }

  function refreshCapcoms(): void {
    const live = deps.capcom();
    if (live) noteCapcom(live);
    for (const a of deps.agents()) noteCapcom(a);
  }

  function launchedByCapcom(a: Agent): boolean {
    return a.parentId !== null && capcoms.has(a.parentId);
  }

  /**
   * Un worker de CAPCOM: hijo de una sesión CAPCOM, miembro de un squad cuyo
   * lead lo es, o agente de una tarea activa. Nunca CAPCOM, nunca un subagente.
   */
  function isWorker(a: Agent): boolean {
    if (a.role === 'capcom' || a.subagent) return false;
    refreshCapcoms();
    if (launchedByCapcom(a)) return true;
    if (a.squad) {
      const lead = deps.agents().find((o) => o.squad === a.squad && o.lead);
      if (lead && launchedByCapcom(lead)) return true;
    }
    return taskOf(a.id) !== null;
  }

  /** Ya entregado (o ya terminado al arrancar) en ese mismo estado, a esa hora o después. */
  function alreadySeen(agentId: string, state: string, at: number): boolean {
    const prev = wm.seen[agentId];
    return !!prev && prev.state === state && prev.at >= at;
  }

  function entryFor(a: Agent, state: string, at: number): WakeEntry {
    return {
      agentId: a.id, callsign: a.callsign, state,
      project: deps.project(a.projectId)?.name ?? a.projectId ?? null,
      squad: a.squad, taskId: taskOf(a.id), lastSay: a.lastSay, at,
    };
  }

  /* ── entrega ──────────────────────────────────────────────────── */

  function enqueue(e: WakeEntry): void {
    if (alreadySeen(e.agentId, e.state, e.at)) return;
    // Anterior a lo último entregado: sólo un replay llega así.
    if (e.at < wm.lastDeliveredAt) return;
    // El mismo agente dos veces en la cola es el último estado que tuvo.
    queue = queue.filter((q) => q.agentId !== e.agentId);
    queue.push(e);
    if (queue.length > WAKE_QUEUE_MAX) queue.splice(0, queue.length - WAKE_QUEUE_MAX);
    if (!coalesce) {
      coalesce = deps.setTimer(() => { coalesce = null; flush(); }, config.coalesceMs);
    }
  }

  function flush(): number {
    if (stopped || queue.length === 0) return 0;
    // Dentro de la ventana todavía se juntan fines; que espere a que cierre.
    if (coalesce) return 0;
    if (!deps.capcom()) return 0;
    const cutoff = deps.contextCutoff?.();
    const out = queue.filter(e => cutoff == null || e.at > cutoff);
    if (!out.length) return 0;
    queue = queue.filter(e => !out.includes(e));
    const outcome = deps.sayToCapcom(agentWakeMessage(out));
    if (outcome === false) {
      // Entre `capcom()` y `say` el mando se fue. Vuelven a la cola, sin duplicar.
      queue = [...out, ...queue.filter((q) => !out.some((o) => o.agentId === q.agentId))];
      return 0;
    }
    lastTurn = deps.now();
    wm.lastDeliveredAt = deps.now();
    for (const e of out) wm.seen[e.agentId] = { state: e.state, at: e.at };
    persist();
    const who = out.map((e) => `${e.callsign} ${e.state}`).join(', ');
    deps.note(`CAPCOM despertado (${outcome === 'queued' ? 'en espera por rotación' : 'entregado'}): ${who}`);
    return out.length;
  }

  /* ── transiciones ─────────────────────────────────────────────── */

  function cancelSettle(agentId: string): void {
    const t = settling.get(agentId);
    if (t) { t.cancel(); settling.delete(agentId); }
  }

  function onState(change: AgentStateChange): void {
    if (stopped) return;
    const { agent: a, from, to, at } = change;

    // CAPCOM: cada cambio de estado es prueba de un turno. No es un worker.
    if (a.role === 'capcom') { noteCapcom(a); lastTurn = Math.max(lastTurn, at); return; }
    if (!config.enabled) return;

    // Volvió a trabajar: el próximo idle vuelve a contar y el que estaba
    // asentándose era un parpadeo.
    if (WORKING_STATES.has(to)) { seenWorking.add(a.id); idleReported.delete(a.id); cancelSettle(a.id); return; }

    if (!config.states.has(to)) return;
    // Sólo en vivo: desde un estado de trabajo, de un agente al que vimos
    // trabajar. booting→done, idle→done o un `from` vacío es el mundo
    // reconstruyéndose, no un worker acabando.
    if (!LIVE_FROM.has(from)) return;
    if (WORKING_STATES.has(from)) seenWorking.add(a.id);
    if (!seenWorking.has(a.id)) return;
    if (!isWorker(a)) return;

    // Una escalación ya llega a CAPCOM por su propio canal, con su id. Un
    // segundo aviso por el mismo hecho es ruido.
    if (to === 'blocked' && a.block?.escalationId) return;
    // Un CLI parado en su prompt es un idle con otro nombre: mismas reglas.
    const asIdle = to === 'idle' || (to === 'blocked' && a.block?.kind === 'input');

    if (asIdle) {
      if (idleReported.has(a.id)) return;
      cancelSettle(a.id);
      const timer = deps.setTimer(() => {
        settling.delete(a.id);
        const now = deps.agent(a.id);
        const stillIdle = now && (now.state === 'idle' || (now.state === 'blocked' && now.block?.kind === 'input'));
        if (!now || !stillIdle) return;
        idleReported.add(a.id);
        enqueue(entryFor(now, 'idle', deps.now()));
      }, config.idleSettleMs);
      settling.set(a.id, timer);
      return;
    }

    // done / dead / blocked (peer, error): cuentan ya.
    cancelSettle(a.id);
    enqueue(entryFor(a, to, at));
  }

  function onNew(a: Agent): void {
    if (stopped) return;
    if (a.role === 'capcom') {
      if (noteCapcom(a)) persist();
      lastTurn = Math.max(lastTurn, deps.now());
      // Un CAPCOM nuevo se lleva lo que esperaba por el anterior.
      flush();
      return;
    }
    // Llega trabajando: su próximo fin será en vivo. Llega terminado: es historia.
    if (WORKING_STATES.has(a.state)) seenWorking.add(a.id);
    else if (FINISHED.has(a.state)) wm.seen[a.id] ??= { state: a.state, at: a.updatedAt };
  }

  function onGone(agentId: string): void {
    cancelSettle(agentId);
    idleReported.delete(agentId);
    seenWorking.delete(agentId);
  }

  /**
   * Arranque: lo que ya está terminado se da por visto, lo que trabaja se
   * anota para que su fin cuente. Se persiste, para que un reinicio en
   * caliente del hub tampoco lo reproduzca.
   */
  function adoptExisting(): void {
    let changed = false;
    for (const a of deps.agents()) {
      if (noteCapcom(a)) changed = true;
      if (a.role === 'capcom') continue;
      if (WORKING_STATES.has(a.state)) { seenWorking.add(a.id); continue; }
      if (FINISHED.has(a.state) && !alreadySeen(a.id, a.state, a.updatedAt)) {
        wm.seen[a.id] = { state: a.state, at: a.updatedAt };
        changed = true;
      }
    }
    if (changed) persist();
  }

  /* ── latido ───────────────────────────────────────────────────── */

  /** Un agente parado en una pregunta: la tiene CAPCOM o la tiene el humano. */
  function escalationPending(): boolean {
    return deps.agents().some((a) => a.role !== 'capcom' && a.state === 'blocked' && !!a.block?.escalationId);
  }

  function heartbeat(): boolean {
    if (stopped) return false;
    // Lo que esperaba por un CAPCOM sale antes que cualquier latido.
    if (flush() > 0) return false;
    if (config.heartbeatMin <= 0 || deps.contextCutoff?.() != null) return false;
    const cap = deps.capcom();
    if (!cap) return false;
    const quietMs = deps.now() - lastTurn;
    if (quietMs < config.heartbeatMin * 60_000) return false;
    // Un turno en curso, o una pregunta esperando respuesta: no se interrumpe.
    if (BUSY_STATES.has(cap.state) || cap.state === 'blocked') return false;
    if (escalationPending()) return false;
    if (queue.length > 0) return false;

    const quietMin = Math.round(quietMs / 60_000);
    const outcome = deps.sayToCapcom(heartbeatMessage(quietMin));
    if (outcome === false) return false;
    lastTurn = deps.now();
    deps.note(`latido a CAPCOM (${cap.callsign}): ${quietMin} min sin turnos`);
    return true;
  }

  /* ── montaje ──────────────────────────────────────────────────── */

  adoptExisting();
  const offs = [
    deps.lifecycle.on('agent:state', onState),
    deps.lifecycle.on('agent:new', onNew),
    deps.lifecycle.on('agent:gone', onGone),
  ];
  const tick = deps.setInterval(() => {
    try { heartbeat(); } catch (err) { deps.log(`wake: tick falló: ${String(err)}`); }
  }, HEARTBEAT_TICK_MS);

  return {
    config,
    pending: () => queue.length,
    flush,
    heartbeat,
    lastTurnAt: () => lastTurn,
    watermark: () => structuredClone(wm),
    stop() {
      stopped = true;
      for (const off of offs) off();
      tick.cancel();
      coalesce?.cancel();
      coalesce = null;
      for (const t of settling.values()) t.cancel();
      settling.clear();
      queue = [];
    },
  };
}
