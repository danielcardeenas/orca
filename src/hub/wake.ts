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
 *                                idle o blocked. Con proyecto, squad, misión y
 *                                lo último que dijo.
 *   [HEARTBEAT]                  N minutos sin turnos: llama a `briefing` y
 *                                actúa sólo si hay algo que hacer.
 *   [MISSION <id>]               el OPERADOR preguntó en una misión y nadie le
 *                                ha contestado. Con la pregunta entera y la
 *                                llamada exacta con la que se responde.
 *   [MISSION <id> stalled]       una misión ACTIVA que no avanza: el envío no
 *                                llegó, no queda nadie en ella, o nadie ha dado
 *                                señal desde el encargo. Con el motivo y qué
 *                                hacer con él.
 *
 * ── Por qué existe el tercero ─────────────────────────────────────
 *
 * Había una asimetría difícil de defender. Cuando un AGENTE pregunta, el hub
 * despierta a CAPCOM y a los 90 segundos le pasa la pregunta al operador
 * diciendo que CAPCOM no respondió: hay reloj, hay escalada y hay constancia.
 * Cuando el OPERADOR pregunta en una misión, su mensaje se entrega una vez y
 * ya está: si CAPCOM contesta en la consola y se olvida de `report_mission`,
 * la misión se queda en `pending_human` para siempre. El 2026-09-08 pasó tres
 * veces en la misma tarde; una espera duró 30 minutos y otra 23, y el operador
 * tuvo que preguntar si el estado «en progreso» que veía era cierto. Lo era.
 *
 * El tiempo de un agente estaba mejor protegido que el del operador. Esto lo
 * corrige con la misma maquinaria, no con una paralela.
 *
 * ── Y por qué existe el cuarto ────────────────────────────────────
 *
 * Los tres primeros avisan de COSAS QUE PASARON: un worker que acabó, una
 * pregunta que se hizo. Ninguno mira lo que NO pasó. El 2026-09-09 había dos
 * misiones activas, cada una con su agente en idle, y las dos daban
 * `awaiting_reply: false`, `unreported_results: 0`, `owed: nothing`: en una el
 * envío había fallado con la máquina desconectada, en la otra el acuse decía
 * «pegado» sobre una sesión que nunca lo leyó. Nadie había hecho nada mal
 * según la deuda de la misión, que sólo cuenta mensajes; simplemente no había
 * pasado nada, y no pasar nada no era un evento.
 *
 * Este avisa de eso: `shared/missions.ts:missionStall` dice si una misión
 * activa lleva parada y por qué, y aquí se le pone reloj, escalera y
 * constancia. No reintenta el envío: repetir una acción externa porque el
 * reloj lo diga es cómo se manda dos veces el mismo encargo.
 *
 * ── Ruido ─────────────────────────────────────────────────────────
 *
 * Un turno de CAPCOM cuesta lo que cuesta un turno de CLI, y un CAPCOM que
 * recibe un mensaje por cada parpadeo de estado se pasa el día contestando
 * "nada nuevo". Tres reglas lo evitan:
 *
 *   - **Coalescing.** Los fines se juntan una ventana corta (5 s) y salen en
 *     un solo mensaje. Un squad de cinco que termina a la vez es un turno.
 *     Los recordatorios de misión igual: tres misiones esperando son un
 *     mensaje, nunca tres.
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
import {
  MISSION_STALL_GRACE_MS, missionDebt, missionStall,
  type CapcomMission, type MissionMessage, type MissionStall, type MissionStallReason,
} from '../shared/missions.ts';
import type { AutonomyDeps } from './autonomy.ts';
import type { CapcomTimer } from './capcom.ts';
import type { AgentStateChange } from './lifecycle.ts';

/** Prefijos estables: el brief los nombra y CAPCOM los distingue por ellos. */
export const AGENT_WAKE_PREFIX = 'AGENT';
export const HEARTBEAT_PREFIX = 'HEARTBEAT';
export const MISSION_WAKE_PREFIX = 'MISSION';

/**
 * A los cuántos minutos se recuerda una pregunta del operador, y cada cuánto
 * después.
 *
 * **Cuatro minutos el primero.** Una escalación de agente urge a los 90
 * segundos porque el agente está DETENIDO; aquí no hay nadie parado, así que
 * el reloj puede ser más largo. Pero no mucho más: un turno de CAPCOM dura
 * minutos, y avisar por debajo de tres llegaría mientras está escribiendo esa
 * misma respuesta — que es la versión ansiosa del problema. Cuatro minutos
 * cae justo detrás de un turno normal y muy por delante de los 23 y los 30 que
 * el operador esperó de verdad.
 *
 * **Y luego espaciado: 15, 45, y cada dos horas.** El primer recordatorio lleva
 * casi toda la información; el quinto idéntico no lleva ninguna y tapa la
 * pantalla. Es la misma lección que los trece avisos de presupuesto.
 */
export const MISSION_REPLY_STEPS_MIN: readonly number[] = [4, 15, 45, 120];

/**
 * A partir de aquí el OPERADOR se entera de que su pregunta sigue sin
 * respuesta. Treinta minutos es exactamente lo que esperó sin saberlo.
 */
export const MISSION_REPLY_ALERT_MIN = 30;

/**
 * A los cuántos minutos se avisa de una misión que no avanza, y cada cuánto
 * después. Se cuentan desde que la condición EMPEZÓ, no desde que se detectó.
 *
 * El primer escalón es un minuto porque la única condición que puede llegar
 * aquí tan pronto es un envío que falló, y eso no es una sospecha: el hub
 * acusó el fallo con su motivo. El minuto es para no pisarle un reintento que
 * CAPCOM ya esté escribiendo en el mismo turno. Las otras tres condiciones se
 * infieren del silencio y no llegan hasta pasado el respiro de
 * `MISSION_STALL_GRACE_MS`, así que su primer aviso cae ahí, no en el minuto.
 */
export const MISSION_STALL_STEPS_MIN: readonly number[] = [1, 30, 120];

/**
 * A partir de aquí el OPERADOR ve que una misión suya lleva parada demasiado.
 * Más largo que el de las preguntas sin contestar porque aquí no hay nadie
 * esperando delante de la pantalla: lo que se corrige es que un trabajo se
 * quede dormido, y tres cuartos de hora es donde eso empieza a costar caro.
 */
export const MISSION_STALL_ALERT_MIN = 45;

/** Cuántas misiones paradas se detallan en un aviso antes de resumir el resto. */
export const MISSION_STALL_MAX = 6;

/** Cuánto de la pregunta del operador viaja en el recordatorio. */
export const MISSION_ASK_CHARS = 600;
/** Cuántas misiones se detallan en un recordatorio antes de resumir el resto. */
export const MISSION_WAKE_MAX = 6;

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
  /**
   * Minutos de espera a los que se recuerda una pregunta del operador, en
   * orden. El último se repite. `ORCA_MISSION_REPLY_STEPS`, lista separada por
   * comas; vacía o `0` apaga el recordatorio.
   */
  missionReplySteps: readonly number[];
  /**
   * Minutos tras los cuales el operador ve en el feed que su pregunta sigue
   * sin contestar. `ORCA_MISSION_REPLY_ALERT_MIN`; 0 apaga.
   */
  missionAlertMin: number;
  /**
   * Minutos de espera a los que se avisa de una misión parada, en orden. El
   * último se repite. `ORCA_MISSION_STALL_STEPS`; vacía o `0` apaga el aviso.
   */
  missionStallSteps: readonly number[];
  /**
   * Cuánto silencio hace falta antes de llamar parada a una misión que no ha
   * dado ningún fallo. `ORCA_MISSION_STALL_MIN`; 0 usa el default compartido.
   */
  missionStallMin: number;
  /**
   * Minutos tras los cuales el operador ve en el feed que una misión suya
   * lleva parada. `ORCA_MISSION_STALL_ALERT_MIN`; 0 apaga.
   */
  missionStallAlertMin: number;
}

export const WAKE_DEFAULTS: Readonly<WakeConfig> = {
  enabled: true,
  coalesceMs: 5_000,
  idleSettleMs: 3_000,
  states: new Set(['done', 'dead', 'idle', 'blocked']),
  heartbeatMin: 15,
  missionReplySteps: MISSION_REPLY_STEPS_MIN,
  missionAlertMin: MISSION_REPLY_ALERT_MIN,
  missionStallSteps: MISSION_STALL_STEPS_MIN,
  missionStallMin: MISSION_STALL_GRACE_MS / 60_000,
  missionStallAlertMin: MISSION_STALL_ALERT_MIN,
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
    missionReplySteps: stepsOf(env['ORCA_MISSION_REPLY_STEPS'], WAKE_DEFAULTS.missionReplySteps),
    missionAlertMin: num('ORCA_MISSION_REPLY_ALERT_MIN', WAKE_DEFAULTS.missionAlertMin),
    missionStallSteps: stepsOf(env['ORCA_MISSION_STALL_STEPS'], WAKE_DEFAULTS.missionStallSteps),
    missionStallMin: num('ORCA_MISSION_STALL_MIN', WAKE_DEFAULTS.missionStallMin) || WAKE_DEFAULTS.missionStallMin,
    missionStallAlertMin: num('ORCA_MISSION_STALL_ALERT_MIN', WAKE_DEFAULTS.missionStallAlertMin),
  };
}

/** `"4,15,45"` → [4,15,45]. Vacío conserva el default; `0` o basura, apagado. */
function stepsOf(raw: string | undefined, fallback: readonly number[]): readonly number[] {
  if (raw === undefined || raw.trim() === '') return fallback;
  const steps = raw.split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return steps;
}

/** Un fin de worker, tal como va a viajar. Se construye al ocurrir, no al entregar. */
export interface WakeEntry {
  agentId: string;
  callsign: string;
  state: string;
  project: string | null;
  squad: string | null;
  missionId: string | null;
  lastSay: string | null;
  at: number;
}

/* ── formato ──────────────────────────────────────────────────────── */

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * `[AGENT K9 done] project: orca · squad: audit-01 · mission: mission_x`
 * `  last: lo último que dijo, en una línea, recortado`
 *
 * El prefijo va primero y entre corchetes por la misma razón que en las
 * escalaciones: es lo único que un modelo encuentra siempre. La misión va en la
 * cabecera porque es lo que CAPCOM tiene que citar en `report_mission`.
 */
export function agentWakeLine(e: WakeEntry): string {
  const facts = [
    `project: ${e.project ?? '?'}`,
    e.squad ? `squad: ${e.squad}` : null,
    e.missionId ? `mission: ${e.missionId}` : null,
  ].filter((s): s is string => s !== null);
  const head = `[${AGENT_WAKE_PREFIX} ${e.callsign} ${e.state}] ${facts.join(' · ')}`;
  const last = e.lastSay ? oneLine(e.lastSay, WAKE_LAST_SAY_CHARS) : '';
  return last ? `${head}\n  last: ${last}` : `${head}\n  last: (nothing said)`;
}

/** Varios fines, un mensaje. La primera línea siempre empieza por el prefijo. */
export function agentWakeMessage(entries: WakeEntry[]): string {
  const body = entries.map(agentWakeLine).join('\n');
  if (entries.length === 1) return body;
  return `${body}\n(${entries.length} workers finished. Handle each: report_mission where there is a mission, then chain or close.)`;
}

/** Una misión que debe respuesta, tal y como va a viajar. */
export interface MissionWakeEntry {
  missionId: string;
  title: string;
  /** El mensaje del operador que lleva más tiempo sin contestar. */
  askedAt: number;
  ask: string;
  /** Cuántos mensajes suyos se han quedado sin respuesta, contando ése. */
  pending: number;
  waitingMs: number;
}

/** `23m`, `1h 5m` — la espera, para quien lee un aviso y no un log. */
function waited(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h${min % 60 ? ` ${min % 60}m` : ''}` : `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

/**
 * `[MISSION mission_ab12] "Rediseñar el selector" · the operator has been waiting 23m`
 * `  asked: ¿Puedes empezar por el filtro de estado?`
 * `  reply with: report_mission(mission_id="mission_ab12", …)`
 *
 * Las tres cosas que hacen falta para actuar sin investigar: qué misión,
 * cuánto lleva esperando, y qué preguntó — con la llamada exacta debajo, para
 * que contestar sea copiar una línea y no ir a buscar la firma.
 */
export function missionWakeLine(e: MissionWakeEntry): string {
  const head = `[${MISSION_WAKE_PREFIX} ${e.missionId}] "${oneLine(e.title, 80)}" · the operator has been waiting ${waited(e.waitingMs)} for a reply`
    + (e.pending > 1 ? ` (${e.pending} messages unanswered)` : '');
  return `${head}\n  asked: ${oneLine(e.ask, MISSION_ASK_CHARS)}`
    + `\n  reply with: report_mission(mission_id="${e.missionId}", text="<your reply>", status="active")`;
}

/**
 * Varias misiones, un mensaje. Contestar en la consola NO cierra una misión, y
 * eso es lo que hay que decir: el incidente que trajo este aviso fue
 * exactamente eso tres veces en una tarde.
 */
export function missionWakeMessage(entries: MissionWakeEntry[]): string {
  const shown = entries.slice(0, MISSION_WAKE_MAX);
  const body = shown.map(missionWakeLine).join('\n');
  if (entries.length === 1) {
    return `${body}\nAnswering in the console does not close a mission: only report_mission does.`;
  }
  const oldest = entries.reduce((w, e) => (e.waitingMs > w.waitingMs ? e : w), entries[0]!);
  const rest = entries.length - shown.length;
  return `[${MISSION_WAKE_PREFIX}] ${entries.length} operator questions are waiting on you, the oldest ${waited(oldest.waitingMs)}.\n${body}`
    + (rest > 0 ? `\n…and ${rest} more; call list_missions(only_pending=true) for the rest.` : '')
    + '\nAnswer each with report_mission. Answering in the console does not close a mission.';
}

/* ── la misión que no avanza ──────────────────────────────────────── */

/** Una misión activa que no se mueve, tal y como va a viajar. */
export interface MissionStallEntry {
  missionId: string;
  title: string;
  reason: MissionStallReason;
  since: number;
  detail: string;
  agent: string | null;
  stuckMs: number;
}

/**
 * Qué hacer con cada clase de parón. Una frase por motivo, con el verbo
 * delante, porque lo que faltaba no era la noticia sino saber qué se hace con
 * ella. Ninguna promete que ORCA lo arregle solo: los tres primeros piden un
 * envío nuevo, y un envío es una acción externa que nadie debe repetir por
 * inferencia — la decide quien manda, no el reloj.
 */
const STALL_ACTION: Record<MissionStallReason, string> = {
  'send-failed': 'check the machine is back (list_fleet), then send again or hand the work to another agent. ORCA does not retry it for you.',
  'no-agent': 'nobody is working on it: spawn or assign someone, or close it with report_mission(status="completed"|"failed").',
  'no-start': 'check the agent yourself (inspect_agent, or open its terminal) before sending again; if its session is gone, hand the work over.',
  'no-progress': 'inspect_agent to see what it was doing, then send it a nudge, take the work elsewhere, or report what there is.',
};

/**
 * `[MISSION mission_ab12 stalled] "Iconos CAPCOM" · no-start for 32m`
 * `  what: WO has shown no activity since the order went out …`
 * `  do: check the agent yourself …`
 *
 * El motivo va en la cabecera y en una sola palabra porque es lo que decide la
 * acción, y la acción va literal debajo: este aviso existe para misiones que
 * llevaban horas pareciendo sanas, y llegar sin decir qué hacer sería cambiar
 * un silencio por una alarma.
 */
export function missionStallLine(e: MissionStallEntry): string {
  return `[${MISSION_WAKE_PREFIX} ${e.missionId} stalled] "${oneLine(e.title, 80)}" · ${e.reason} for ${waited(e.stuckMs)}`
    + `\n  what: ${oneLine(e.detail, MISSION_ASK_CHARS)}`
    + `\n  do: ${STALL_ACTION[e.reason]}`;
}

/** Varias misiones paradas, un mensaje. */
export function missionStallMessage(entries: MissionStallEntry[]): string {
  const shown = entries.slice(0, MISSION_STALL_MAX);
  const body = shown.map(missionStallLine).join('\n');
  if (entries.length === 1) return body;
  const oldest = entries.reduce((w, e) => (e.stuckMs > w.stuckMs ? e : w), entries[0]!);
  const rest = entries.length - shown.length;
  return `[${MISSION_WAKE_PREFIX}] ${entries.length} active missions are not moving, the oldest for ${waited(oldest.stuckMs)}.\n${body}`
    + (rest > 0 ? `\n…and ${rest} more; call list_missions(only_pending=true) for the rest.` : '')
    + '\nHandle each: unstick it or close it. An active mission nobody is working on is the fleet lying to the operator.';
}

/** Lo que el OPERADOR ve en el feed cuando una misión suya lleva parada. */
export function missionStallAlertLine(e: MissionStallEntry): string {
  return `mission ${e.missionId} "${oneLine(e.title, 60)}" has not moved for ${waited(e.stuckMs)} (${e.reason}):`
    + ` ${oneLine(e.detail, 200)}. CAPCOM has been told; it is not a mission ORCA can restart on its own.`;
}

/** Lo que el OPERADOR ve en el feed cuando su pregunta lleva demasiado sin respuesta. */
export function missionAlertLine(e: MissionWakeEntry): string {
  return `mission ${e.missionId} "${oneLine(e.title, 60)}": your question has been waiting ${waited(e.waitingMs)}`
    + ' and CAPCOM has not answered it in the mission. It may have replied in the console without calling'
    + ' report_mission, which leaves the mission open.';
}

export function heartbeatMessage(quietMin: number): string {
  return `[${HEARTBEAT_PREFIX}] ${quietMin} min without a turn. Call briefing. Act only if something is owed`
    + ' — a blocked agent, a mission waiting on you, a finished worker nobody reported.'
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
  /**
   * Recordatorios de misión ya dados, por misión. Persistido porque el hub
   * reinicia con cada edición bajo `tsx watch`: sin esto, cada reinicio
   * volvería a mandar el primer recordatorio de todas las misiones abiertas,
   * que es exactamente la ráfaga que este módulo existe para no producir.
   * `messageId` es la ÚLTIMA pregunta sin contestar: si el operador vuelve a
   * escribir, la escalera empieza de cero y el recordatorio sale enseguida.
   * Insistir es señal de que corre más prisa, no menos.
   */
  missions: Record<string, { messageId: string; sent: number; alerted: boolean }>;
  /**
   * Avisos de misión parada ya dados, por misión. `key` es el motivo y el
   * momento en que la condición empezó: si cambia cualquiera de los dos —el
   * envío vuelve a fallar, el agente se va, la misión se mueve y se vuelve a
   * parar— es otra condición y la escalera empieza de cero. Mientras sea la
   * misma, `sent` la va espaciando. Persistido por lo mismo que el resto: un
   * hub bajo `tsx watch` reinicia con cada edición, y sin esto cada reinicio
   * repetiría el primer aviso de todas las misiones paradas.
   */
  stalls: Record<string, { key: string; sent: number; alerted: boolean }>;
}

export function emptyWatermark(): WakeWatermark {
  return { seen: {}, lastDeliveredAt: 0, capcoms: [], missions: {}, stalls: {} };
}

export function loadWatermark(dir: string): WakeWatermark {
  const file = path.join(dir, WAKE_STATE_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WakeWatermark>;
    const seen: WakeWatermark['seen'] = {};
    for (const [id, v] of Object.entries(raw.seen ?? {})) {
      if (v && typeof v === 'object' && typeof v.state === 'string' && typeof v.at === 'number') seen[id] = { state: v.state, at: v.at };
    }
    const missions: WakeWatermark['missions'] = {};
    for (const [id, v] of Object.entries(raw.missions ?? {})) {
      if (v && typeof v === 'object' && typeof v.messageId === 'string' && typeof v.sent === 'number') {
        missions[id] = { messageId: v.messageId, sent: v.sent, alerted: v.alerted === true };
      }
    }
    const stalls: WakeWatermark['stalls'] = {};
    for (const [id, v] of Object.entries(raw.stalls ?? {})) {
      if (v && typeof v === 'object' && typeof v.key === 'string' && typeof v.sent === 'number') {
        stalls[id] = { key: v.key, sent: v.sent, alerted: v.alerted === true };
      }
    }
    return {
      seen,
      lastDeliveredAt: typeof raw.lastDeliveredAt === 'number' ? raw.lastDeliveredAt : 0,
      capcoms: Array.isArray(raw.capcoms) ? raw.capcoms.filter((c): c is string => typeof c === 'string') : [],
      missions,
      stalls,
    };
  } catch {
    return emptyWatermark();
  }
}

/** tmp + rename, síncrono, como missions.ts: un reinicio a mitad deja el anterior, no medio archivo. */
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
  /**
   * Un tick de los recordatorios de misión: manda un `[MISSION …]` por las que
   * llevan esperando respuesta del operador más de lo tolerable, y avisa al
   * propio operador de las que llevan demasiado. Se llama sola en cada tick;
   * expuesta para tests. Devuelve cuántas misiones se recordaron.
   */
  missionReplies(): number;
  /**
   * Un tick de los avisos de misión parada: manda un `[MISSION … stalled]` por
   * las misiones activas que llevan sin avanzar más de lo tolerable, y avisa
   * al operador de las que llevan demasiado. Se llama sola en cada tick;
   * expuesta para tests. Devuelve cuántas se avisaron.
   */
  missionStalls(): number;
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

/**
 * Cuánto atrás se mira para saber si el miembro ya avisó a su líder. Un turno
 * largo cabe de sobra; un mensaje de hace dos horas era de otro trabajo.
 */
export const LEAD_NOTICE_LOOKBACK_MS = 30 * 60_000;

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

  function missionOf(agentId: string): string | null {
    for (const t of Object.values(deps.missions())) {
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
    return missionOf(a.id) !== null;
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
      squad: a.squad, missionId: missionOf(a.id), lastSay: a.lastSay, at,
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

  /* ── el líder ─────────────────────────────────────────────────── */

  /**
   * El líder se entera de que su miembro terminó, aunque el miembro no se lo
   * dijera.
   *
   * Un líder de escuadrón espera a que sus miembros le escriban. Cuando el
   * canal falla —y el 2026-09-08 falló para catorce agentes de golpe, porque
   * `orca-tell` ni siquiera existía en su PATH— el líder se queda esperando un
   * mensaje que no va a llegar mientras el entregable lleva veinte minutos en
   * el disco. `wake` ya ve exactamente ese instante para despertar a CAPCOM;
   * el líder es el otro que lo necesita, y por las mismas razones.
   *
   * No se manda si el miembro ya avisó él: el aviso es el respaldo, no una
   * copia. Y el líder no se avisa a sí mismo.
   */
  /** El líder vivo de este miembro, o null: sin squad, siendo él el líder, o con el líder ya ido. */
  function liveLeadOf(a: Agent): Agent | null {
    if (!a.squad || a.lead) return null;
    const lead = deps.agents().find((o) => o.squad === a.squad && o.lead && o.id !== a.id && o.role !== 'capcom');
    return lead && lead.state !== 'done' && lead.state !== 'dead' ? lead : null;
  }

  function tellLead(a: Agent, state: string, at: number): void {
    if (!deps.tellAgent) return;
    const lead = liveLeadOf(a);
    // Sin líder vivo no hay a quién avisar; CAPCOM se entera por su canal.
    if (!lead) return;
    const since = at - LEAD_NOTICE_LOOKBACK_MS;
    const told = (deps.saidTo?.(a.id, since) ?? [])
      .some((m) => m.toAgentId === lead.id || m.toSquad === a.squad);
    if (told) return;
    const sent = deps.tellAgent({
      toAgentId: lead.id,
      kind: state === 'dead' ? 'warning' : 'notice',
      subject: `${a.callsign} finished (${state}) and did not report to you`,
      body: `ORCA is telling you because ${a.callsign} reached ${state} without sending you anything.`
        + ' Its work is on disk in its own working directory; go and read it rather than waiting for a message.'
        + (a.lastSay ? `\nLast thing it said: ${oneLine(a.lastSay, WAKE_LAST_SAY_CHARS)}` : ''),
    });
    if (sent) deps.note(`aviso al líder del escuadrón ${a.squad}: ${a.callsign} terminó (${state}) sin reportar`);
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

    /*
     * Un miembro de escuadrón con su líder en pie le reporta AL LÍDER, y a
     * nadie más. Hasta el 2026-09-09 cada miembro que paraba despertaba
     * también a CAPCOM —seis miembros, seis turnos del mando para leer lo que
     * el líder ya estaba consolidando—, que es el ruido que un líder existe
     * para absorber. Ahora el fin de un miembro va al líder (y sólo si el
     * miembro no se lo dijo él); CAPCOM se entera cuando el LÍDER termina, con
     * el resultado ya consolidado. Muerto el líder, el miembro vuelve a
     * despertar a CAPCOM: es lo único que queda.
     */
    const underLead = liveLeadOf(a) !== null;

    if (asIdle) {
      if (idleReported.has(a.id)) return;
      cancelSettle(a.id);
      const timer = deps.setTimer(() => {
        settling.delete(a.id);
        const now = deps.agent(a.id);
        const stillIdle = now && (now.state === 'idle' || (now.state === 'blocked' && now.block?.kind === 'input'));
        if (!now || !stillIdle) return;
        idleReported.add(a.id);
        if (liveLeadOf(now)) { tellLead(now, 'idle', deps.now()); return; }
        enqueue(entryFor(now, 'idle', deps.now()));
      }, config.idleSettleMs);
      settling.set(a.id, timer);
      return;
    }

    // done / dead / blocked (peer, error): cuentan ya.
    cancelSettle(a.id);
    if (to === 'done' || to === 'dead') tellLead(a, to, at);
    if (underLead) return;
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

  /* ── la pregunta del operador ─────────────────────────────────── */

  /**
   * Cuánto tiene que llevar esperando una pregunta para el recordatorio número
   * `sent`. Los pasos son esperas ABSOLUTAS acumuladas: 4 min el primero, 15
   * el segundo, 45 el tercero, y de ahí cada dos horas. Así el aviso número
   * cinco no llega a los veinte minutos de haber preguntado.
   */
  function dueAtMs(steps: readonly number[], sent: number): number {
    if (steps.length === 0) return Infinity;
    if (sent < steps.length) return steps[sent]! * 60_000;
    const last = steps[steps.length - 1]!;
    return (steps[steps.length - 1]! + last * (sent - steps.length + 1)) * 60_000;
  }

  function entryFrom(mission: CapcomMission, oldest: MissionMessage, pending: number, now: number): MissionWakeEntry {
    return {
      missionId: mission.id,
      title: mission.title,
      askedAt: oldest.at,
      ask: oldest.text,
      pending,
      waitingMs: Math.max(0, now - oldest.at),
    };
  }

  /**
   * Una pasada por las misiones vivas.
   *
   * Recuerda a CAPCOM lo que el operador preguntó y no ha sido contestado EN
   * LA MISIÓN — que es distinto de contestado en la consola, y ésa fue
   * exactamente la confusión que dejó tres misiones abiertas media tarde. Se
   * apaga solo: en cuanto CAPCOM llama a `report_mission`, la deuda desaparece
   * y con ella el recordatorio.
   */
  function missionReplies(): number {
    if (stopped) return 0;
    const now = deps.now();
    const missions = deps.missions();
    const due: MissionWakeEntry[] = [];
    let changed = false;

    for (const mission of Object.values(missions)) {
      if (mission.status !== 'active' || mission.archivedAt) continue;
      const humans = missionDebt(mission).humans;
      const oldest = humans[0];
      if (!oldest) {
        // Contestada: la cuenta se olvida, para que la próxima pregunta
        // empiece su escalera desde cero.
        if (wm.missions[mission.id]) { delete wm.missions[mission.id]; changed = true; }
        continue;
      }
      // La cuenta se ata a la ÚLTIMA pregunta y el texto se toma de la
      // PRIMERA: si el operador insiste, la escalera se reinicia, pero lo que
      // se reporta sigue siendo cuánto lleva esperando de verdad.
      const latest = humans[humans.length - 1]!;
      const prev = wm.missions[mission.id];
      const mark = prev && prev.messageId === latest.id ? prev : { messageId: latest.id, sent: 0, alerted: prev?.alerted === true };
      const entry = entryFrom(mission, oldest, humans.length, now);

      // El operador se entera aparte, y aunque no haya CAPCOM vivo a quien
      // recordárselo: sobre todo si no lo hay.
      if (config.missionAlertMin > 0 && !mark.alerted && entry.waitingMs >= config.missionAlertMin * 60_000) {
        mark.alerted = true;
        wm.missions[mission.id] = mark;
        changed = true;
        const line = missionAlertLine(entry);
        // `deps.alert?.(x) ?? deps.note(x)` mandaría las DOS: una llamada que
        // funciona devuelve undefined.
        if (deps.alert) deps.alert(line); else deps.note(line);
      }

      if (entry.waitingMs >= dueAtMs(config.missionReplySteps, mark.sent)) due.push(entry);
      wm.missions[mission.id] = mark;
    }

    // Las que ya no existen no deben dejar cuenta abierta.
    for (const id of Object.keys(wm.missions)) {
      if (!missions[id]) { delete wm.missions[id]; changed = true; }
    }

    if (due.length === 0) {
      if (changed) persist();
      return 0;
    }
    // Sin CAPCOM no se pierde nada: la deuda sigue en la misión y el próximo
    // tick con mando la vuelve a encontrar. No se apunta como enviado.
    if (!deps.capcom()) { if (changed) persist(); return 0; }

    due.sort((a, b) => b.waitingMs - a.waitingMs);
    const outcome = deps.sayToCapcom(missionWakeMessage(due));
    if (outcome === false) { if (changed) persist(); return 0; }
    lastTurn = deps.now();
    for (const e of due) {
      const mark = wm.missions[e.missionId];
      if (mark) mark.sent += 1;
    }
    persist();
    deps.note(`CAPCOM recordado: ${due.length} misión(es) esperando respuesta del operador `
      + `(${due.map((e) => `${e.missionId} ${waited(e.waitingMs)}`).join(', ')})`);
    return due.length;
  }

  /* ── la misión que no avanza ──────────────────────────────────── */

  function stallEntry(mission: CapcomMission, stall: MissionStall, now: number): MissionStallEntry {
    return {
      missionId: mission.id,
      title: mission.title,
      reason: stall.reason,
      since: stall.since,
      detail: stall.detail,
      agent: stall.callsign ?? stall.agentId,
      stuckMs: Math.max(0, now - stall.since),
    };
  }

  /**
   * Una pasada por las misiones vivas buscando las que no se mueven.
   *
   * Se apaga sola, y ésa es la mitad del diseño: la condición no se guarda en
   * ninguna parte, se vuelve a calcular de la flota y de la conversación en
   * cada tick. Actividad del agente, un reenvío que sale, un resultado que
   * cae, un `report_mission`, archivar la misión — cualquiera de esas hace que
   * `missionStall` devuelva null y el aviso deja de existir sin que nadie lo
   * cancele. Lo único que se persiste es cuántas veces se avisó ya de ESTA
   * condición, para espaciarlos.
   */
  function missionStalls(): number {
    if (stopped) return 0;
    const steps = config.missionStallSteps;
    const now = deps.now();
    const missions = deps.missions();
    const graceMs = Math.max(0, config.missionStallMin) * 60_000;
    const due: MissionStallEntry[] = [];
    let changed = false;

    for (const mission of Object.values(missions)) {
      const stall = missionStall(mission, (id) => deps.agent(id), now, graceMs);
      if (!stall) {
        // Se desatascó: la cuenta se olvida, para que el próximo parón —si lo
        // hay— vuelva a avisar enseguida en vez de heredar la escalera vieja.
        if (wm.stalls[mission.id]) { delete wm.stalls[mission.id]; changed = true; }
        continue;
      }
      const key = `${stall.reason}:${stall.since}`;
      const prev = wm.stalls[mission.id];
      const mark = prev && prev.key === key ? prev : { key, sent: 0, alerted: false };
      if (mark !== prev) changed = true;
      const entry = stallEntry(mission, stall, now);

      // El operador se entera aparte, y aunque no haya CAPCOM a quien
      // decírselo: si no lo hay, con más razón.
      if (config.missionStallAlertMin > 0 && !mark.alerted && entry.stuckMs >= config.missionStallAlertMin * 60_000) {
        mark.alerted = true;
        changed = true;
        const line = missionStallAlertLine(entry);
        if (deps.alert) deps.alert(line); else deps.note(line);
      }

      if (steps.length > 0 && entry.stuckMs >= dueAtMs(steps, mark.sent)) due.push(entry);
      wm.stalls[mission.id] = mark;
    }

    for (const id of Object.keys(wm.stalls)) {
      if (!missions[id]) { delete wm.stalls[id]; changed = true; }
    }

    if (due.length === 0) { if (changed) persist(); return 0; }
    // Sin CAPCOM no se pierde nada: la misión sigue parada y el próximo tick
    // con mando la vuelve a encontrar. No se apunta como avisado.
    if (!deps.capcom()) { if (changed) persist(); return 0; }

    due.sort((a, b) => b.stuckMs - a.stuckMs);
    const outcome = deps.sayToCapcom(missionStallMessage(due));
    if (outcome === false) { if (changed) persist(); return 0; }
    lastTurn = deps.now();
    for (const e of due) {
      const mark = wm.stalls[e.missionId];
      if (mark) mark.sent += 1;
    }
    persist();
    deps.note(`CAPCOM avisado: ${due.length} misión(es) sin avanzar `
      + `(${due.map((e) => `${e.missionId} ${e.reason} ${waited(e.stuckMs)}`).join(', ')})`);
    return due.length;
  }

  /* ── montaje ──────────────────────────────────────────────────── */

  adoptExisting();
  const offs = [
    deps.lifecycle.on('agent:state', onState),
    deps.lifecycle.on('agent:new', onNew),
    deps.lifecycle.on('agent:gone', onGone),
  ];
  const tick = deps.setInterval(() => {
    // Los recordatorios van primero: una pregunta del operador sin contestar
    // pesa más que un latido, y si hay uno el latido ya no hace falta.
    try { missionReplies(); } catch (err) { deps.log(`wake: recordatorio de misión falló: ${String(err)}`); }
    try { missionStalls(); } catch (err) { deps.log(`wake: aviso de misión parada falló: ${String(err)}`); }
    try { heartbeat(); } catch (err) { deps.log(`wake: tick falló: ${String(err)}`); }
  }, HEARTBEAT_TICK_MS);

  return {
    config,
    pending: () => queue.length,
    flush,
    heartbeat,
    missionReplies,
    missionStalls,
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
