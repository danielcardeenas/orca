/**
 * ¿Sigue existiendo este agente?
 *
 * Un solo guardián, delante de TODO barrido periódico del hub. Nació de dos
 * incidentes que resultaron ser el mismo: trece `[BUDGET 100%]` sobre dos
 * escuadrones que el operador había parado horas antes, y cuatro `[SWARM CAP]`
 * sobre un agente cuya sesión de tmux ya no existía y que decía tener
 * veinticinco subagentes vivos. Ninguno de los dos avisos podía acallarse:
 * `archive_agents` no tocaba al fantasma porque el hub lo tenía por vivo, y
 * `stop_agent` lo rechazaba porque no era background.
 *
 * La lección es que el mundo del hub y los procesos de la máquina divergen y
 * nada los reconcilia. El collector sólo retira a un agente cuando su
 * TRANSCRIPT desaparece del disco, y un transcript no desaparece porque se
 * cierre el pane: queda ahí, con el último estado derivado congelado —
 * `working`, veinticinco hijos — hasta que alguien lo borra. Peor: al
 * reconectar, el collector vuelve a anunciar esa sesión y el hub la resucita.
 *
 * Así que aquí hay dos cosas, y sólo dos:
 *
 *   `isLiveAgent`  — la pregunta que toda comprobación periódica hace primero.
 *   `ghostReason`  — por qué el hub puede declarar terminado a uno por su
 *                    cuenta, con un motivo que se lee.
 *
 * ## El silencio NO es prueba de muerte
 *
 * Este archivo tuvo una primera versión que daba por ido a quien decía estar
 * `working` y llevaba veinte minutos sin escribir en su transcript. Marcó
 * muertos a siete agentes vivos de una tacada, en mitad de su turno: estaban
 * razonando, o escribiendo un fichero de quinientas líneas, que son cosas que
 * no pintan nada durante un buen rato. El operador estuvo a punto de relanzar
 * a cinco evaluadores y duplicar horas de trabajo y de consumo.
 *
 * De ahí la regla que gobierna este módulo: **la muerte exige evidencia
 * positiva; la vida es el valor por defecto.** Los dos errores no cuestan lo
 * mismo. Dar por vivo a un muerto cuesta un aviso molesto, que se arregla
 * retirándolo a mano. Dar por muerto a un vivo tira trabajo en curso. La
 * asimetría está en el código y no en el criterio de quien lo lee: aquí no se
 * infiere nada de la ausencia de señal.
 *
 * Sólo tres cosas terminan a un agente, y las tres son alguien AFIRMANDO algo,
 * nunca alguien callándose:
 *
 *   - el collector dice que terminó (`done` / `dead`);
 *   - alguien lo paró: `stop_agent`, `stop_squad`, `retire_agent`, o el propio
 *     libro de presupuestos al despachar una parada;
 *   - su máquina no está conectada, que es un hecho del hub y no una
 *     conjetura sobre el agente.
 *
 * Y todas son reversibles: si el agente vuelve a producir, vuelve a estar
 * vivo. Ver `world.reviveGhosts`.
 */

import type { Agent, Machine } from '../shared/types.ts';
import { TERMINAL_STATES } from '../shared/types.ts';

/** Estados en los que un agente afirma estar consumiendo ahora mismo. */
export const CONSUMING_STATES: ReadonlySet<string> = new Set(['booting', 'thinking', 'working']);

export interface LivenessView {
  machines: Record<string, Machine>;
  /** Agentes que alguien ya retiró a mano o parando la sesión. */
  retired?: (id: string) => boolean;
}

/**
 * La pregunta única: ¿cuenta este agente como vivo para un barrido?
 *
 * Tres formas de no estarlo, y ninguna es una conjetura: terminó, alguien lo
 * paró, o su máquina no está conectada. Un agente callado está vivo.
 */
export function isLiveAgent(a: Agent, view: LivenessView, now: number): boolean {
  return ghostReason(a, view, now) === null;
}

/**
 * Por qué este agente no está vivo, en una línea que el operador puede leer en
 * el feed. `null` cuando sí lo está.
 */
export function ghostReason(a: Agent, view: LivenessView, now: number): string | null {
  if (TERMINAL_STATES.has(a.state)) return `sesión ${a.state}`;
  if (view.retired?.(a.id)) return 'sesión detenida por el operador';
  const m = view.machines[a.machineId];
  if (!m) return 'máquina desconocida';
  if (!m.online) {
    return `máquina no conectada desde hace ${Math.max(0, Math.round((now - m.lastSeen) / 60_000))} min`;
  }
  // Y hasta aquí. NO se infiere nada del silencio: un agente que lleva media
  // hora sin escribir puede estar razonando o redactando un fichero largo, y
  // eso es trabajo normal. Si su sesión de verdad desapareció, lo dirá el
  // collector, lo dirá la máquina al desconectarse, o lo dirá una persona con
  // `retire_agent`. Ninguna de las tres es este `if` que no existe.
  return null;
}

/* ── Alcanzabilidad ───────────────────────────────────────────────── */

/**
 * Qué se puede HACER con este agente. Una sola respuesta para las tres
 * herramientas que se remitían la una a la otra.
 *
 * El caso que obligó a escribir esto: `interrupt_agent` mandaba a
 * `stop_agent`, `stop_agent` contestaba "sólo aplica a sesiones background", y
 * `archive_agents` decía "nothing to archive" porque el hub lo tenía por vivo.
 * Tres consejos, tres callejones. Un aviso que recomienda acciones que fallan
 * cuesta más tiempo que un aviso sin consejo.
 *
 * Los predicados son los mismos que aplican las herramientas de verdad:
 * interrumpir un turno exige un pane; parar exige un pane o una sesión
 * background de Claude a la que el CLI pueda dirigirse por id; archivar exige
 * que ya haya terminado.
 */
export interface Reachability {
  /** `interrupt_agent` puede tirarle el turno. */
  interrupt: boolean;
  /** `stop_agent` puede terminarle la sesión. */
  stop: boolean;
  /** `archive_agents` puede retirarlo de la flota. */
  archive: boolean;
  /** `retire_agent`, la salida manual, siempre alcanza. */
  retire: true;
}

export function reachability(a: Agent): Reachability {
  const pane = a.pane === true;
  const addressable = a.runtime === 'claude' && (a.background === true || !!a.shortId);
  return {
    interrupt: pane,
    stop: pane || addressable,
    archive: TERMINAL_STATES.has(a.state),
    retire: true,
  };
}

/**
 * El consejo que un aviso puede dar sobre este agente, ya filtrado por lo que
 * de verdad funciona. Nunca vuelve vacío: `retire_agent` alcanza siempre, y
 * ésa es justamente la salida que no existía.
 */
export function adviceFor(a: Agent): string {
  const r = reachability(a);
  const parts: string[] = [];
  if (r.interrupt) parts.push('interrupt_agent to drop the turn that is spawning them');
  if (r.stop) parts.push('stop_agent to end the session');
  if (r.archive) parts.push('archive_agents to retire it');
  if (!r.interrupt && !r.stop) {
    parts.push('retire_agent to declare it gone — this session has neither a pane nor a background id, so nothing else reaches it');
  } else {
    parts.push('retire_agent if it turns out the session no longer exists');
  }
  return parts.join(', or ');
}
