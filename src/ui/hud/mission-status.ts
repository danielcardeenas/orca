/**
 * What the mission panel says about each mission, derived, no DOM.
 *
 * The hub keeps a mission's conversation and its agent bindings (`CapcomMission`)
 * and tells the console about every change; it does not say whether the
 * mission is waiting on the operator, being worked, or sitting in the queue.
 * That reading is made here, from the conversation and the fleet, so the
 * panel and its tests agree on one rule:
 *
 *   completed / failed   the hub's own status
 *   not moving           active, and nothing has happened for long enough that
 *                        `missionStall` can say why (shared/missions.ts)
 *   in progress          an assigned agent is alive
 *   waiting on you       nobody alive, and the last word was CAPCOM's
 *   queued               nobody alive, and CAPCOM has not answered yet
 *
 * Alive beats the last word on purpose: CAPCOM saying "launched two, will
 * report back" while those two run is work, not a question.
 *
 * And the stall beats alive, which is the whole reason it is here. `alive`
 * counts an idle session, so a mission whose agent never received its order
 * read IN PROGRESS to the operator for as long as it sat there — on
 * 2026-09-09 the operator had to ask whether the progress he was looking at
 * was real. It was not. The rule that decides it lives in shared/missions.ts,
 * the same one the tools and the hub's wake use: three readings of "this is
 * stuck" would eventually disagree, and the one that disagrees is the one
 * that keeps quiet.
 */

import { missionBrief, missionLeadOf, missionStall, type CapcomMission, type MissionLeadOf, type MissionStall } from '../../shared/missions.ts';
import type { Agent } from '../../shared/types.ts';
import { alive } from '../store.ts';

export type MissionPhase = 'waiting' | 'progress' | 'stalled' | 'queued' | 'completed' | 'failed';

export const PHASE_WORD: Record<MissionPhase, string> = {
  waiting: 'WAITING ON YOU',
  progress: 'IN PROGRESS',
  stalled: 'NOT MOVING',
  queued: 'QUEUED',
  completed: 'COMPLETED',
  failed: 'FAILED',
};

export interface Crew { id: string; callsign: string }

export interface MissionRow {
  id: string;
  title: string;
  /** The same title uncut, for the row's detail. */
  headline: string;
  /** The opening message, whole: what was actually asked for. '' when nothing was said yet. */
  brief: string;
  phase: MissionPhase;
  /** Assigned agents still alive, in assignment order. */
  crew: Crew[];
  /**
   * La última movida de la misión: un mensaje —los de la tripulación
   * incluidos, que el hub vuelca en la conversación—, un cambio de estado, una
   * asignación. Ordena el panel y es lo que dice el «· 12M».
   *
   * Es la misión y no sus agentes a propósito. `updatedAt` de un agente sube
   * con cada latido del colector —métricas, tokens, estado—, así que una
   * misión con gente viva ponía «· 0S» para siempre y no decía nada: ni
   * cuándo se movió, ni si llevaba media hora sin devolver una palabra. Un
   * latido no es noticia; una frase, un aterrizaje o un final, sí.
   */
  at: number;
  /** When it was opened. The rail orders by this; nothing else reads it. */
  createdAt: number;
}

export type AgentOf = (id: string) => Agent | undefined;

/** The assigned agents that are still running. CAPCOM itself is never crew. */
export function liveCrew(mission: CapcomMission, agentOf: AgentOf): Agent[] {
  const out: Agent[] = [];
  for (const id of mission.agentIds) {
    const a = agentOf(id);
    if (a && a.role !== 'capcom' && alive(a)) out.push(a);
  }
  return out;
}

export function missionPhase(mission: CapcomMission, crew: readonly Agent[], stall: MissionStall | null = null): MissionPhase {
  if (mission.status === 'completed' || mission.status === 'failed') return mission.status;
  if (stall) return 'stalled';
  if (crew.length) return 'progress';
  const last = mission.messages.at(-1);
  return last?.role === 'capcom' ? 'waiting' : 'queued';
}

/**
 * The mission's title, or the first thing the human said, whole.
 *
 * The panel shows a cut of this and the row's detail shows all of it, so both
 * have to be the same sentence: two derivations would eventually disagree
 * about what a mission is called, and the one the operator saw first is the
 * one they would trust.
 */
export function missionHeadline(mission: CapcomMission): string {
  const own = mission.title.trim();
  const first = mission.messages.find((m) => m.role === 'human')?.text ?? '';
  // «New task» es el título que ponía el hub antes del renombrado, y sigue
  // guardado en las misiones de entonces: se trata igual que el de hoy.
  const placeholder = own === 'New mission' || own === 'New task';
  return (own && !placeholder ? own : first).replace(/\s+/g, ' ').trim() || 'NEW MISSION';
}

/** The headline, cut to `max` on a space where one is near. */
export function missionTitle(mission: CapcomMission, max = 40): string {
  const raw = missionHeadline(mission);
  if (raw.length <= max) return raw;
  const cut = raw.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const OPEN: ReadonlySet<MissionPhase> = new Set(['waiting', 'progress', 'stalled', 'queued']);
export const isOpen = (phase: MissionPhase): boolean => OPEN.has(phase);

/**
 * Every mission as a row: open first, then whoever has crew on it, then by
 * what was last said, newest on top.
 *
 * Las tres claves cambian con noticias y no con el reloj. Ordenar por el
 * movimiento de los agentes —que sube con cada latido del colector—
 * reordenaba el panel cada pocos segundos sin que hubiera pasado nada, y una
 * fila que se mueve sola es una fila que se pulsa mal. Que la tripulación viva
 * pese sigue siendo cierto, pero como un sí o un no, no como una carrera de
 * latidos.
 *
 * `now` entra sólo para la fase, y no toca ninguna de las tres claves: un
 * parón no cambia si la fila está abierta —`stalled` es abierta, como
 * `progress` y como `queued`—, ni la tripulación, ni el `at`. La fila se
 * queda donde está y cambia lo que dice, que es exactamente lo que hace falta.
 */
export function missionRows(missions: Iterable<CapcomMission>, agentOf: AgentOf, now = Date.now()): MissionRow[] {
  const rows: MissionRow[] = [];
  for (const mission of missions) {
    const crew = liveCrew(mission, agentOf);
    rows.push({
      id: mission.id,
      title: missionTitle(mission),
      headline: missionHeadline(mission),
      brief: missionBrief(mission)?.text.trim() ?? '',
      phase: missionPhase(mission, crew, missionStall(mission, agentOf, now)),
      crew: crew.map((a) => ({ id: a.id, callsign: a.callsign })),
      at: mission.updatedAt,
      createdAt: mission.createdAt,
    });
  }
  return rows.sort((a, b) => {
    const ao = isOpen(a.phase) ? 0 : 1, bo = isOpen(b.phase) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ac = a.crew.length ? 0 : 1, bc = b.crew.length ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return b.at - a.at || a.id.localeCompare(b.id);
  });
}

export interface RailSplit {
  /** Lo que va en la cinta, en orden de apertura. */
  strip: MissionRow[];
  /** Lo terminado que se pliega bajo MORE, lo último movido primero. */
  folded: MissionRow[];
}

/**
 * Qué va en la cinta de conversaciones y qué se pliega detrás de MORE.
 *
 * La cinta es una fila de pestañas, y una pestaña que se mueve sola es una
 * pestaña que se pulsa mal: el orden es el de apertura, así que crece por la
 * derecha y nada cambia de sitio bajo el cursor mientras la flota trabaja.
 * Eso la separa del panel del HUD, que sí se reordena porque allí lo que
 * importa es qué se movió último, no dónde estaba hace un segundo.
 *
 * Sale de la cinta lo terminado —lo que ya no navegas— con una excepción: la
 * conversación abierta siempre se ve, aunque esté cerrada, porque una cinta
 * que no dice dónde estás no es navegación.
 */
export function railSplit(rows: readonly MissionRow[], openId: string | null): RailSplit {
  const strip: MissionRow[] = [];
  const folded: MissionRow[] = [];
  for (const r of rows) (isOpen(r.phase) || r.id === openId ? strip : folded).push(r);
  strip.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return { strip, folded };
}

/** El color con el que la cinta marca cada fase. Un punto, no una palabra. */
export const PHASE_DOT: Record<MissionPhase, string> = {
  waiting: 'var(--amber)',
  progress: 'var(--lime)',
  stalled: 'var(--amber)',
  queued: 'var(--st-thinking)',
  completed: 'var(--ink-dimmer)',
  failed: 'var(--red)',
};

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
 * orden evita. Y `live` viaja con el resultado porque quien lo lea tiene que
 * poder decir «terminó» en vez de mandar un mensaje al vacío.
 *
 * CAPCOM nunca es líder de una misión: es el mando de la flota entera, y
 * confundirlo con el líder haría que «hablar con el líder» y «hablar con
 * CAPCOM» fueran el mismo botón dos veces.
 */
export type MissionLead = MissionLeadOf<Agent>;

/**
 * La regla vive en `shared/missions.ts` desde 2026-09-09, porque el hub la
 * necesita también: es él quien manda la línea (`mission:say`) y tiene que
 * elegir el mismo destinatario que la ventana prometió.
 */
export function missionLead(
  mission: CapcomMission,
  agentOf: AgentOf,
  fleet: Iterable<Agent> = [],
): MissionLead | null {
  return missionLeadOf(mission, agentOf, fleet);
}
