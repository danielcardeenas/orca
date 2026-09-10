import type { Agent } from './types.ts';

export type MissionStatus = 'active' | 'completed' | 'failed';
export interface MissionMessage {
  id: string;
  role: 'human' | 'capcom' | 'agent' | 'system';
  text: string;
  at: number;
  agentId?: string;
  /**
   * A quién iba dirigida una línea del operador, cuando no iba a CAPCOM: el id
   * del LÍDER de la misión. Existe porque el operador puede hablarle al líder
   * desde la ventana de la misión, y esa línea no es deuda de CAPCOM —es el
   * líder quien la contesta— así que `missionDebt` no la cuenta, y el
   * despertador no le recuerda a CAPCOM una pregunta que no era para él.
   */
  to?: string;
}
export interface CapcomMission {
  id: string;
  title: string;
  status: MissionStatus;
  createdAt: number;
  updatedAt: number;
  agentIds: string[];
  agentSince?: Record<string, number>;
  squads?: string[];
  messages: MissionMessage[];
  /**
   * Cuándo se retiró de la vista. Una misión archivada conserva todo lo que
   * tenía —conversación, agentes, estado— y sólo deja de ocupar sitio: no sale
   * en el selector, no cuenta contra el tope y no se le busca actividad nueva.
   * Se puede devolver. Lo irreversible es la purga, que exige archivar antes.
   */
  archivedAt?: number;
  /**
   * El último encargo que salió hacia cada agente de la misión, por agente.
   *
   * Existe porque hasta ahora no había en ninguna parte el hecho «CAPCOM le
   * mandó trabajo a este agente a esta hora». Sin él, un envío que falla se ve
   * una vez en el turno de CAPCOM —`send_to_agent` lo devuelve como error— y
   * desaparece en cuanto esa sesión rota o compacta; y un envío que sale bien
   * no deja ningún momento contra el que comparar el silencio posterior. Las
   * dos mitades del hueco que dejó dos misiones «activas» sin seguimiento.
   *
   * Se guarda sólo el último por agente: reenviar sustituye, que es lo que
   * hace que un reintento con éxito apague el aviso sin que nadie lo borre.
   */
  dispatches?: Record<string, MissionDispatch>;
}

/**
 * Lo que de verdad se sabe de un encargo: cuándo salió y si llegó a la
 * MÁQUINA del agente.
 *
 * `delivered` es exactamente eso y nada más. Un `say` con pane acaba en
 * «pegado en el pane» y uno sin pane en «se lanzó `claude --bg --resume`»
 * (collector/commands.ts): ninguno de los dos dice que el CLI lo haya leído,
 * y este campo no pretende decirlo. Que el agente empezara se mira aparte, y
 * se mira en su propia actividad.
 */
export interface MissionDispatch {
  agentId: string;
  /** Cómo se llamaba al mandárselo: un id crudo no se lee, y el agente puede irse. */
  callsign?: string;
  at: number;
  /** False = el envío no llegó: máquina desconectada, pane muerto, timeout. */
  delivered: boolean;
  /** El motivo del fallo, tal cual lo dio el hub. Ausente si salió. */
  detail?: string;
}
/**
 * Los ids que ORCA acepta para una misión.
 *
 * Acepta `task_` además de `mission_` porque el concepto se llamó «task» hasta
 * el renombrado y hay conversaciones con ese prefijo guardadas en disco: negarles
 * la entrada no las renombraría, las borraría del selector. Lo que se escribe
 * hoy es siempre `mission_` (ver `newMissionId`), así que el prefijo viejo sólo
 * puede llegar de un id ya existente, nunca de uno nuevo.
 */
export const MISSION_ID = /^(?:mission|task)_[A-Za-z0-9_-]{1,100}$/;
/** El prefijo con el que nace una misión nueva. Nunca `task_`. */
export const MISSION_ID_PREFIX = 'mission';
/** Lo que el operador tiene delante: sin las archivadas, la reciente primero. */
export function visibleMissions(missions: Record<string, CapcomMission>): CapcomMission[] {
  return Object.values(missions).filter((m) => !m.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt);
}
/** Una misión terminada y quieta: lo que una limpieza puede retirar sin preguntar. */
export function archivableMissions(missions: Record<string, CapcomMission>): CapcomMission[] {
  return visibleMissions(missions).filter((m) => m.status !== 'active');
}
/**
 * Lo que una misión debe: lo que se dijo después de la última palabra de CAPCOM.
 *
 * Vive aquí, y no en las herramientas, porque hay dos lectores: `list_missions`
 * / `inspect_mission`, que lo enseñan, y el despertador de `hub/wake.ts`, que
 * avisa por ello. Dos implementaciones de «qué está esperando el operador»
 * acabarían discrepando, y la que discrepa siempre es la que calla.
 */
export interface MissionDebt {
  /** Mensajes del operador posteriores a la última respuesta de CAPCOM. */
  humans: MissionMessage[];
  /** Resultados de workers que CAPCOM todavía no ha reportado. */
  results: MissionMessage[];
  /** Cuándo habló CAPCOM por última vez. 0 = nunca. */
  lastCapcomAt: number;
}

export function missionDebt(mission: CapcomMission): MissionDebt {
  let cut = -1;
  for (let i = mission.messages.length - 1; i >= 0; i--) {
    if (mission.messages[i]!.role === 'capcom') { cut = i; break; }
  }
  const tail = mission.messages.slice(cut + 1);
  return {
    // Lo que el operador le dijo al LÍDER no se le debe a CAPCOM: ver `MissionMessage.to`.
    humans: tail.filter((m) => m.role === 'human' && !m.to),
    results: tail.filter((m) => m.role === 'agent'),
    lastCapcomAt: cut >= 0 ? mission.messages[cut]!.at : 0,
  };
}

/** True when the mission is active and something in it is waiting on CAPCOM. */
export function missionOwed(mission: CapcomMission, debt: MissionDebt): boolean {
  return mission.status !== 'completed' && mission.status !== 'failed' && (debt.humans.length > 0 || debt.results.length > 0);
}

/* ── misión activa que no avanza ──────────────────────────────────── */

/**
 * Por qué una misión activa no está avanzando. Cuatro condiciones OBSERVABLES,
 * cada una con una acción distinta; ninguna afirma que un agente recibiera o
 * dejara de recibir nada, porque eso no lo dice ningún transcript.
 *
 *   send-failed  el último envío a un agente suyo no llegó a la máquina, y
 *                desde entonces no ha pasado nada. Es un hecho, no una
 *                inferencia: el hub acusó el fallo con su motivo.
 *   no-agent     no queda nadie trabajando en ella y CAPCOM no ha dicho nada
 *                al respecto. Un resultado publicado esperando a que el
 *                operador lo lea NO es esto: eso es espera humana.
 *   no-start     hay agente vivo, pero no ha dado señal de actividad desde
 *                ANTES del encargo. «Sent» salió; empezar, no consta.
 *   no-progress  hubo actividad después del encargo y luego silencio, sin que
 *                nada llegara a la misión.
 */
export type MissionStallReason = 'send-failed' | 'no-agent' | 'no-start' | 'no-progress';

export interface MissionStall {
  reason: MissionStallReason;
  /** Desde cuándo dura la condición: el fallo, el encargo o la última señal. */
  since: number;
  /** A quién apunta. null cuando ya no queda ningún agente. */
  agentId: string | null;
  callsign: string | null;
  /** Qué se sabe, en una línea, sin afirmar recepción. */
  detail: string;
}

/**
 * Lo único que hace falta saber de un agente para juzgar una misión parada.
 * Un `Agent` entero lo satisface; los tests pueden montar cuatro campos.
 */
export type MissionCrew = Pick<Agent, 'id' | 'callsign' | 'state' | 'updatedAt' | 'block'>;

/**
 * Cuánto silencio hace falta antes de llamar parada a una misión que, por lo
 * demás, parece sana.
 *
 * Diez minutos, y no menos, porque las dos condiciones inferidas se apoyan en
 * la ausencia de señal: un CLI pasa por idle entre dos llamadas a herramienta,
 * y un worker que acaba de terminar necesita un momento para que su resultado
 * caiga en la conversación de la misión. Por debajo de eso el aviso sería la
 * versión ansiosa del problema — la misma lección que el asentamiento del idle
 * en hub/wake.ts. Un envío FALLIDO no pasa por aquí: ahí no hay nada que
 * inferir, y esperar diez minutos a decir lo que ya se sabe es perderlos.
 */
export const MISSION_STALL_GRACE_MS = 10 * 60_000;

/** Estados en los que el agente está haciendo algo ahora mismo. */
const CREW_BUSY: ReadonlySet<Agent['state']> = new Set(['booting', 'thinking', 'working']);
const CREW_OVER: ReadonlySet<Agent['state']> = new Set(['done', 'dead']);

/** `blocked` de tipo `input` es un CLI parado en su prompt: un idle con otro nombre. */
function crewIdle(a: MissionCrew): boolean {
  return a.state === 'idle' || (a.state === 'blocked' && a.block?.kind === 'input');
}

/** Cuándo se le encargó algo a este agente por última vez, que se sepa. */
function orderedAt(mission: CapcomMission, agentId: string): number {
  const sent = mission.dispatches?.[agentId];
  const since = mission.agentSince?.[agentId] ?? mission.createdAt;
  return Math.max(typeof sent?.at === 'number' ? sent.at : 0, since);
}

function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h${min % 60 ? ` ${min % 60}m` : ''}` : `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

/**
 * Una misión activa que no está avanzando, o null.
 *
 * Vive aquí por la misma razón que `missionDebt`: hay varios lectores —las
 * herramientas que lo enseñan, el despertador que avisa por ello y el panel
 * que lo pinta— y dos implementaciones de «esto está parado» acabarían
 * discrepando. La que discrepa siempre es la que calla.
 *
 * Lo que NO cuenta como parada, a propósito:
 *
 *   - Lo que ya se debe por otra vía (`missionOwed`): una pregunta del
 *     operador sin contestar o un resultado sin reportar ya sale en pendientes
 *     y en el briefing. Avisar dos veces por el mismo hecho es ruido.
 *   - Un agente `blocked` que no sea `input`: un permiso, una pregunta o una
 *     escalación son espera humana o bloqueo YA escalado, y tienen su propio
 *     canal con su propio reloj. Esto no los duplica.
 *   - Una misión archivada. Archivar es el gesto que ya existe para retirar
 *     una misión de la vista sin perder nada, y es el que hace de pausa
 *     explícita: no hacía falta inventar otro.
 *   - Un resultado publicado que el operador todavía no ha leído, tanto si el
 *     agente que lo produjo ya se fue (punto 2 del cuerpo) como si su sesión
 *     sigue viva y quieta, que es lo normal: un CLI que termina su encargo se
 *     queda en `idle`, no en `done` (punto 4).
 *
 * Lo que NO puede distinguir, y conviene saberlo: una misión a la que CAPCOM
 * contestó y a la que nunca asignó a nadie es indistinguible de una a la que
 * contestó y en la que el operador aún no ha vuelto a escribir. Las dos son
 * «último mensaje de CAPCOM, sin tripulación», y no hay en ninguna parte el
 * hecho «CAPCOM dijo que iba a lanzar algo». Se tratan como espera humana, que
 * es lo que el modelo de estados ya dice de ellas; afirmar lo contrario sería
 * inventar una intención que nadie midió.
 *
 * No decide reintentar nada. Devuelve qué pasa y desde cuándo; quién actúa y
 * cómo es de quien lo lea.
 */
export function missionStall(
  mission: CapcomMission,
  crewOf: (agentId: string) => MissionCrew | undefined,
  now: number,
  graceMs: number = MISSION_STALL_GRACE_MS,
): MissionStall | null {
  if (mission.status !== 'active' || mission.archivedAt) return null;
  const debt = missionDebt(mission);
  if (missionOwed(mission, debt)) return null;

  // El máximo, no el último del array: una línea puede escribirse con la hora
  // del hecho que la provocó y quedar detrás de otra más nueva.
  const lastMessageAt = mission.messages.reduce((max, m) => (m.at > max ? m.at : max), mission.createdAt);
  const crew = mission.agentIds.map(crewOf).filter((a): a is MissionCrew => !!a);

  // 1. Un envío que no llegó. Es lo primero porque es lo único que no se
  //    infiere del silencio, y porque dice qué arreglar antes de mirar nada.
  for (const sent of Object.values(mission.dispatches ?? {})) {
    if (!sent || sent.delivered || typeof sent.at !== 'number') continue;
    // Actividad posterior del agente o de la misión: algo pasó después, y lo
    // que pasó vale más que el fallo. Un reenvío con éxito sustituye el
    // registro, así que un reintento que sale bien apaga esto solo.
    const who = crewOf(sent.agentId);
    if (lastMessageAt > sent.at || (who && who.updatedAt > sent.at)) continue;
    return {
      reason: 'send-failed',
      since: sent.at,
      agentId: sent.agentId,
      callsign: who?.callsign ?? null,
      detail: `the last send to ${who?.callsign ?? sent.agentId} did not reach its machine`
        + (sent.detail ? `: ${sent.detail}` : '')
        + `, and nothing has happened in the mission since (${ago(now - sent.at)})`,
    };
  }

  // 2. Nadie trabajando, y CAPCOM sin dar cuenta de ello.
  //
  //    La condición es la segunda mitad, no la primera. Una misión cuya
  //    tripulación terminó y cuyo resultado CAPCOM ya publicó no está
  //    abandonada: está esperando a que el operador lo lea, que es un estado
  //    legítimo y el que el panel ya llama WAITING ON YOU. Lo que no tiene
  //    nombre —y lo que nadie ve— es la que se quedó sin nadie SIN que CAPCOM
  //    dijera nada: un agente que muere callado no deja resultado que reportar,
  //    así que tampoco deja deuda.
  const live = crew.filter((a) => !CREW_OVER.has(a.state));
  if (live.length === 0) {
    const since = Math.max(lastMessageAt, ...crew.map((a) => a.updatedAt), mission.createdAt);
    if (debt.lastCapcomAt >= since) return null;
    if (now - since < graceMs) return null;
    return {
      reason: 'no-agent',
      since,
      agentId: null,
      callsign: null,
      detail: `nobody is working on it and CAPCOM has not accounted for it`
        + (crew.length ? ` (${crew.map((a) => `${a.callsign} ${a.state}`).join(', ')})` : ' (its agents are no longer in the fleet)')
        + `; nothing has moved for ${ago(now - since)}`,
    };
  }

  // 3. Alguien está en ello ahora mismo, o esperando a un humano por un canal
  //    que ya tiene su propio aviso.
  if (live.some((a) => CREW_BUSY.has(a.state))) return null;
  if (live.some((a) => a.state === 'blocked' && !crewIdle(a))) return null;

  // 4. El que ya entregó no está parado: terminó.
  //
  //    Una sesión de CLI que acaba su encargo se queda en `idle`, no en `done`
  //    —`done` es que el proceso cerró—, así que «vivo y quieto» es también el
  //    aspecto normal de un worker que ya hizo lo suyo. Sin esto, una misión
  //    con su resultado entregado y reportado se marcaba `no-progress` media
  //    hora después diciendo que nada había llegado a la misión, con el
  //    resultado escrito tres líneas más arriba.
  //
  //    Lo que resuelve la condición es LA ENTREGA DE ESE AGENTE posterior a SU
  //    encargo, no una palabra cualquiera de CAPCOM. La diferencia es todo el
  //    asunto: si bastara con que CAPCOM hubiera hablado, un «mandado a WO»
  //    sobre un envío que nunca llegó volvería a tapar exactamente el caso que
  //    trajo este trabajo. Y como el encargo se cuenta por agente, un encargo
  //    NUEVO deja atrás la entrega vieja y la misión vuelve a deber progreso.
  const pending = live.filter((a) => !deliveredSince(mission, debt, a.id, orderedAt(mission, a.id)));
  if (pending.length === 0) return null;

  // 5. Los que quedan, quietos. Lo que distingue «no empezó» de «se paró» es
  //    si alguno ha dado señal DESPUÉS del último encargo. La señal es la
  //    actividad que el collector observa en el transcript (`updatedAt`), no un
  //    acuse de envío: un agente que no ha leído nada no la mueve.
  const ordered = Math.max(...pending.map((a) => orderedAt(mission, a.id)));
  const freshest = Math.max(...pending.map((a) => a.updatedAt));
  const target = pending.reduce((w, a) => (a.updatedAt < w.updatedAt ? a : w), pending[0]!);
  const started = freshest > ordered;
  const since = started ? freshest : ordered;
  if (now - since < graceMs) return null;
  return {
    reason: started ? 'no-progress' : 'no-start',
    since,
    agentId: target.id,
    callsign: target.callsign,
    detail: started
      ? `${pending.map((a) => a.callsign).join(', ')} worked after the last order and then went quiet ${ago(now - since)} ago`
        + ' without anything reaching the mission'
      : `${pending.map((a) => a.callsign).join(', ')} has shown no activity since the order went out ${ago(now - since)} ago;`
        + ' the send was acknowledged by the machine, which is not the same as the agent reading it',
  };
}

/**
 * ¿Este agente entregó algo a la misión después de `since`, y CAPCOM ya dio
 * cuenta de ello?
 *
 * Las dos mitades hacen falta. La entrega sola dejaría fuera el caso de un
 * resultado sin reportar — pero ése ya es deuda (`missionOwed`) y sale por su
 * propio canal, así que aquí llega siempre reportado; se comprueba igual para
 * que la regla siga diciendo la verdad si esa guarda cambia. Y «reportado» se
 * mide contra ESTA entrega, no contra el reloj: la última palabra de CAPCOM
 * tiene que venir después del mensaje del agente.
 */
function deliveredSince(mission: CapcomMission, debt: MissionDebt, agentId: string, since: number): boolean {
  return mission.messages.some((m) =>
    m.role === 'agent' && m.agentId === agentId && m.at > since && debt.lastCapcomAt >= m.at);
}

/**
 * La pregunta del operador que lleva más tiempo sin respuesta en una misión
 * viva, o null. Es lo único que hace falta para decidir si hay que avisar.
 */
export function oldestUnansweredHuman(mission: CapcomMission): MissionMessage | null {
  if (mission.status !== 'active' || mission.archivedAt) return null;
  return missionDebt(mission).humans[0] ?? null;
}

/* ── el líder de una misión ───────────────────────────────────────── */

/**
 * Lo que hace falta de un agente para decidir quién lidera una misión. Un
 * `Agent` entero lo satisface; un test monta cinco campos.
 */
export type MissionLeadCandidate = Pick<Agent, 'id' | 'role' | 'lead' | 'squad' | 'state' | 'updatedAt'>;

export interface MissionLeadOf<A extends MissionLeadCandidate = MissionLeadCandidate> {
  agent: A;
  /** Cómo se le encontró: asignado a la misión, o liderando su squad. */
  via: 'mission' | 'squad';
  /** True mientras su sesión siga en pie. */
  live: boolean;
}

const leadAlive = (a: MissionLeadCandidate): boolean => a.state !== 'done' && a.state !== 'dead';

/**
 * Quién manda en una misión, si es que manda alguien.
 *
 * Un squad tiene un líder por contrato (`Agent.lead`): es el único de sus
 * miembros al que se le habla, el que reparte y el que consolida. Una misión
 * puede tener uno de dos maneras, y las dos son reales:
 *
 *   `mission`  un agente asignado a la misión que además lidera su squad
 *   `squad`    nadie asignado lidera, pero la misión declara un squad
 *              (`mission.squads`) y ese squad sí tiene líder en la flota
 *
 * El vivo gana al terminado, y entre terminados el que se movió el último:
 * hablarle a una sesión muerta cuando queda otra viva es el fallo que este
 * orden evita. CAPCOM nunca es líder de una misión.
 *
 * Vive aquí, y no sólo en la consola, porque ahora tiene DOS lectores que
 * tienen que coincidir: la ventana de la misión, que dice a quién va a ir la
 * línea, y el hub, que es quien la manda (`mission:say`). Si los dos
 * decidieran por su cuenta, la ventana prometería un destinatario y el hub
 * elegiría otro.
 */
export function missionLeadOf<A extends MissionLeadCandidate>(
  mission: CapcomMission,
  agentOf: (id: string) => A | undefined,
  fleet: Iterable<A> = [],
): MissionLeadOf<A> | null {
  const rank = (a: A) => (leadAlive(a) ? 1 : 0);
  const better = (a: A, b: A) => rank(a) - rank(b) || a.updatedAt - b.updatedAt;

  let best: A | undefined;
  for (const id of mission.agentIds) {
    const a = agentOf(id);
    if (!a || a.role === 'capcom' || !a.lead) continue;
    if (!best || better(a, best) > 0) best = a;
  }
  if (best) return { agent: best, via: 'mission', live: leadAlive(best) };

  const squads = mission.squads ?? [];
  if (!squads.length) return null;
  for (const a of fleet) {
    if (a.role === 'capcom' || !a.lead || !a.squad || !squads.includes(a.squad)) continue;
    if (!best || better(a, best) > 0) best = a;
  }
  return best ? { agent: best, via: 'squad', live: leadAlive(best) } : null;
}

/**
 * La cabecera con la que una línea del operador llega al líder.
 *
 * El líder no tiene por qué recordar de qué misión le hablan días después, y
 * el id es lo que le deja contestar en el sitio correcto. Se le dice además
 * cómo llega su respuesta —su último mensaje es lo que ORCA vuelca en la
 * misión— para que no salga a buscar un comando que no existe.
 */
export function leadPrompt(mission: CapcomMission, text: string): string {
  return `[ORCA MISSION ${mission.id}] ${mission.title}
`
    + 'The operator wrote to you, the lead of this mission. Answer in your final message: ORCA carries your last message'
    + ' into the mission conversation, where the operator reads it. Do not relay it to CAPCOM.\n'
    + text;
}

export function missionPrompt(mission: CapcomMission): string {
  const history = mission.messages.slice(-8).map((m) => `${m.role}${m.agentId ? ` (${m.agentId})` : ''}: ${m.text.slice(0, 2000)}`).join('\n');
  return `[ORCA MISSION ${mission.id}] ${mission.title}\nThis is a separate mission conversation. Use only its context below; do not transfer decisions from other missions. Pass mission_id="${mission.id}" to spawn_agent and launch_squad. Publish your response with report_mission(mission_id="${mission.id}", text=your response, status="active" or "completed" or "failed"). Plain CLI prose is not delivered to this mission. Mark completed only when the requested work is actually done.\nAssigned agents: ${mission.agentIds.join(', ') || 'none'}\nConversation:\n${history}`;
}

/**
 * Lo que se dijo en una misión alrededor de un momento: la línea que provocó
 * el prompt y la primera respuesta de CAPCOM que vino después.
 *
 * Existe para que la vista GENERAL de CAPCOM pueda enseñar una misión sin
 * mandarte a ella. El prompt que recibe CAPCOM no sirve para eso —el hub le
 * adjunta el contexto entero de la misión y ocupa una pantalla—, pero la
 * conversación de la misión sí, y es la misma que verías al entrar. Vive aquí,
 * junto a `missionDebt`, porque es la misma pregunta desde el otro lado: qué
 * se dijo, y si ya hubo respuesta.
 *
 * `said` no es forzosamente tuyo: a una misión se entra también porque un
 * worker reportó algo y el hub despertó a CAPCOM con ello, y esa línea explica
 * el prompt igual de bien que la tuya. Lo único que nunca es `said` es CAPCOM,
 * que es quien contesta.
 *
 * La línea es la más cercana al momento, no la última que quepa: el hub guarda
 * el mensaje y luego lo despacha, y quien fecha el prompt es el CLI cuando lo
 * escribe, siempre un poco después, así que `slack` deja pasar ese retraso.
 * Coger «la última hasta aquí» haría que dos prompts de la misma misión
 * enseñaran los dos la línea más nueva.
 */
export function missionGlimpse(mission: CapcomMission, at: number, slack = 5_000): { said?: MissionMessage; back?: MissionMessage } {
  let said: MissionMessage | undefined;
  for (const m of mission.messages) {
    if (m.role === 'capcom' || m.at > at + slack) continue;
    if (!said || Math.abs(m.at - at) < Math.abs(said.at - at)) said = m;
  }
  const from = said?.at ?? at;
  const back = mission.messages.find((m) => m.role === 'capcom' && m.at >= from);
  return { ...(said ? { said } : {}), ...(back ? { back } : {}) };
}

/**
 * El encargo: lo primero que se dijo en la misión, entero.
 *
 * Es lo que el panel enseña recortado en una fila y lo que el operador quiere
 * leer completo sin salir de ella. La primera línea del operador manda; si la
 * misión la abrió CAPCOM (`open_mission` con `first_message`), esa es. Vacía
 * cuando la misión aún no tiene una sola palabra, que es un estado real y no
 * un error: la fila se abrió y nadie ha escrito todavía.
 */
export function missionBrief(mission: CapcomMission): MissionMessage | null {
  return mission.messages.find((m) => m.role === 'human')
    ?? mission.messages.find((m) => m.role === 'capcom')
    ?? null;
}

/**
 * Lo que se publicó como resultado, y lo que se dijo antes de llegar a él.
 *
 * `final` es la última palabra de CAPCOM: en una misión terminada es
 * literalmente el `report_mission` que la cerró, porque marcar completada y
 * publicar el texto son la misma llamada. `progress` son sus informes
 * anteriores y `fromFleet` lo que los workers reportaron por su cuenta —el
 * detalle que CAPCOM resume— en orden de llegada.
 *
 * Ninguno se inventa: si CAPCOM cerró la misión sin escribir nada, `final` es
 * null y quien lo lea tiene que decirlo así.
 */
export interface MissionResult {
  final: MissionMessage | null;
  progress: MissionMessage[];
  fromFleet: MissionMessage[];
  /**
   * Lo último que dijo la flota DESPUÉS de la última palabra de CAPCOM, o
   * null. Es lo que el operador quiere leer cuando el líder ya entregó y
   * CAPCOM todavía no lo ha publicado: el resultado existe, sólo falta el
   * sello. Quien lo enseñe tiene que decir que no está publicado.
   */
  latest: MissionMessage | null;
}

export function missionResult(mission: CapcomMission): MissionResult {
  const capcom = mission.messages.filter((m) => m.role === 'capcom');
  const final = capcom.at(-1) ?? null;
  const fromFleet = mission.messages.filter((m) => m.role === 'agent');
  const latest = fromFleet.filter((m) => !final || m.at > final.at).at(-1) ?? null;
  return {
    final,
    progress: final ? capcom.slice(0, -1) : [],
    fromFleet,
    latest,
  };
}
