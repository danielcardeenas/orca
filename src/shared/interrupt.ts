/**
 * Interrumpir un turno sin matar la sesión: el Esc del operador, a distancia.
 *
 * Hasta ahora ORCA tenía dos verbos y ninguno servía para corregir sobre la
 * marcha. `say` espera su turno: lo que escribes llega cuando el agente
 * termina lo que estaba haciendo, que es justo lo que no quieres cuando lleva
 * diez minutos por el camino equivocado. `stop` es lo contrario y de más:
 * manda dos Ctrl-C al pane y cierra el pane a los seis segundos si no salió
 * solo — mata el proceso. La conversación se guarda, pero el turno no se
 * cancela: se pierde la sesión viva, y volver cuesta un `resume`.
 *
 * Lo que falta es lo que hace un humano sentado delante: cortar el turno y
 * decir otra cosa. Eso es esto.
 *
 * ── Lo que cada runtime sabe hacer (medido, no supuesto) ───────────────
 *
 * Claude Code 2.1.263, hospedado en un pane:
 *   Mientras trabaja, la barra dice literalmente `esc to interrupt`. UN
 *   `Escape` corta el turno a media frase y la pantalla queda en
 *   `⎿ Interrupted · What should Claude do instead?`, con el prompt libre.
 *   El transcript recibe una línea `user` con el texto
 *   `[Request interrupted by user]` (o `… for tool use]` si cortó una
 *   herramienta). Ese es el acuse: lo escribe el CLI, no ORCA.
 *   Orden: Escape PRIMERO, el mensaje después. Al revés el texto se mete en
 *   el compositor mientras el turno sigue vivo y no cancela nada.
 *
 * Codex CLI 0.153.4, hospedado en un pane:
 *   Al revés, y esto es lo que no se puede adivinar. El texto enviado
 *   mientras trabaja NO interrumpe: se ENCOLA, y la propia TUI lo anuncia —
 *   `Messages to be submitted after next tool call (press esc to interrupt
 *   and send immediately)`. Con algo en esa cola, `Escape` corta el turno y
 *   entrega el mensaje ya: `Model interrupted to submit steer instructions`,
 *   y el rollout registra `turn_aborted` con `reason: "interrupted"`.
 *   Con la cola vacía, en cambio, `Escape` durante el streaming de texto no
 *   cortó nada en ninguna de las pruebas: el turno siguió hasta el final.
 *   Orden: mensaje PRIMERO (se encola), Escape después.
 *
 * De ahí las dos únicas formas de entrega que existen, y por qué el orden no
 * es un detalle de implementación sino la mitad del contrato.
 *
 * ── Lo que NINGUNO sabe hacer ──────────────────────────────────────────
 *
 * Sin pane no hay interrupción. `claude --bg` no tiene tecla que pulsar y su
 * CLI no expone cancelar el turno: `claude stop <id>` PARA la sesión de
 * background — es el `stop` que ya existe, no una cancelación. Codex tiene
 * `codex queue`, que encola un mensaje en una sesión, pero encolar no es
 * interrumpir y exige el app-server. Así que una sesión sin pane recibe
 * `unsupported` con el motivo, y nunca un sucedáneo: matar el proceso,
 * mandar Ctrl-C dos veces o relanzar la sesión están explícitamente fuera.
 * Perder el turno es reversible; perder la sesión, su uuid y su contexto no.
 */

/** Cómo se entrega la interrupción a este runtime. */
export type InterruptDelivery =
  /** Escape y luego, si hay, el mensaje. Claude Code. */
  | 'escape-then-message'
  /** El mensaje (que se encola) y luego Escape, que lo envía cortando. Codex. */
  | 'message-then-escape';

/** Qué pasó con la cancelación en sí. */
export type InterruptStep =
  /** La tecla salió hacia el pane. */
  | 'sent'
  /** Este runtime, o esta sesión, no puede cancelar un turno. */
  | 'unsupported'
  /** Se intentó y el pane no la aceptó. */
  | 'failed';

/** Qué pasó con el mensaje que acompañaba, si lo había. */
export type MessageStep =
  /** No se pidió ninguno. */
  | 'none'
  /** Pegado en el prompt después de cortar (Claude). */
  | 'pasted'
  /** Puesto en la cola del CLI, que lo entrega al cortar (Codex). */
  | 'queued'
  /** Se pidió y no salió: la cancelación falló antes. */
  | 'unsent';

/**
 * Qué sabemos de verdad, y no lo que nos gustaría.
 *
 * `confirmed` es el único que afirma algo del agente, y sólo se pone cuando su
 * propio transcript trae la marca de interrupción que escribe el CLI. `pending`
 * es "la tecla salió y el acuse no ha llegado todavía", que es lo honesto
 * mientras no aparezca: un pane acepta cualquier tecla sin decir qué hizo con
 * ella. Nunca se afirma que el agente LEYÓ el mensaje: eso no lo dice ningún
 * transcript.
 */
export type InterruptEvidence = 'confirmed' | 'pending' | 'none';

export interface InterruptOutcome {
  ok: boolean;
  runtime: string;
  interrupt: InterruptStep;
  message: MessageStep;
  evidence: InterruptEvidence;
  /** Los pasos en el orden en que se ejecutaron. Para poder auditar el orden. */
  order: string[];
  /** Una línea para un humano o para el modelo que la lee. */
  detail: string;
}

/** El plan que se va a ejecutar sobre el pane, o el motivo de que no haya. */
export type InterruptPlan =
  | { ok: true; delivery: InterruptDelivery; settleMs: number; confirms: boolean }
  | { ok: false; reason: string };

/**
 * Cuánto se espera entre las dos mitades.
 *
 * No es una cortesía: el CLI procesa la tecla en su siguiente vuelta de
 * eventos y repinta. Medido contra un pane de verdad: con 600 ms el turno se
 * cortaba —el transcript traía la marca— pero el texto llegaba mientras Claude
 * Code todavía estaba recolocando el prompt interrumpido, y acababa en su cola
 * en vez de en el prompt libre. Con 1 s, que es lo que tarda un humano en
 * escribir, entra limpio. Por debajo de esto se gana ruido, no tiempo.
 */
export const INTERRUPT_SETTLE_MS = 1_000;

/**
 * Cuánto se espera al acuse del transcript antes de decir `pending`.
 *
 * El CLI escribe la marca en cuanto corta, pero el transcript se vuelca a
 * disco y el collector lo lee por lotes. Cuatro segundos cubren el camino
 * entero con holgura; pasado eso, la respuesta dice que no hay acuse todavía
 * en vez de inventarse uno.
 */
export const INTERRUPT_EVIDENCE_MS = 4_000;

/**
 * Qué se puede hacer con esta sesión.
 *
 * `hosted` es tener un pane: es la única vía, porque interrumpir es pulsar una
 * tecla en una TUI. `hasText` cambia el plan de Codex —sin mensaje que encolar
 * su Escape no corta de forma fiable— y por eso el plan lo dice: `confirms`
 * es si cabe esperar que el propio CLI deje constancia del corte.
 */
export function interruptPlan(
  runtime: string, hosted: boolean, hasText: boolean,
): InterruptPlan {
  if (!hosted) {
    return {
      ok: false,
      reason: runtime === 'claude'
        ? 'this session has no pane: `claude --bg` offers no way to cancel a turn '
          + '(`claude stop` ends the session, it does not cancel the turn). '
          + 'Relaunch it hosted, or use stop_agent if you really want it to end.'
        : `this session has no pane: ORCA can only interrupt a ${runtime} session it hosts in one.`,
    };
  }
  switch (runtime) {
    case 'claude':
      return { ok: true, delivery: 'escape-then-message', settleMs: INTERRUPT_SETTLE_MS, confirms: true };
    case 'codex':
      // Con mensaje, el Escape lo entrega cortando y el rollout lo registra.
      // Sin mensaje el Escape sale igual, pero medido no siempre corta, así
      // que el plan avisa de que no habrá acuse que esperar.
      return {
        ok: true, delivery: 'message-then-escape', settleMs: INTERRUPT_SETTLE_MS, confirms: hasText,
      };
    default:
      return {
        ok: false,
        reason: `ORCA does not know how to interrupt a turn in ${runtime}: `
          + 'only claude and codex have a measured cancel key.',
      };
  }
}

/**
 * La frase que acompaña al resultado. Se escribe aquí para que el hub, la
 * consola y las herramientas del mando digan exactamente lo mismo.
 */
export function describeOutcome(o: InterruptOutcome): string {
  if (o.interrupt === 'unsupported') return o.detail;
  const cut = o.evidence === 'confirmed'
    ? 'the CLI recorded the turn as interrupted'
    : 'the cancel key was delivered; no acknowledgement in the transcript yet';
  // "Encolado" no quiere decir lo mismo en los dos CLIs, y confundirlos sería
  // prometer una entrega inmediata que en Claude Code no ocurre: allí la cola
  // se vacía cuando el turno acaba — justo lo que interrumpir quería evitar.
  const queued = o.runtime === 'codex'
    ? ', and the message went into the CLI queue that the cancel delivers'
    : ', but the message landed in the CLI queue instead of the free prompt: '
      + 'it will be delivered when the current turn ends, not now';
  const msg = o.message === 'pasted' ? ', and the message was pasted into its prompt'
    : o.message === 'queued' ? queued
      : o.message === 'unsent' ? ', and the message was NOT sent'
        : '';
  return `${cut}${msg}.`;
}

/**
 * ¿Es esta línea del transcript el acuse de una interrupción?
 *
 * Claude Code escribe un turno `user` cuyo texto es exactamente
 * `[Request interrupted by user]`, y `[Request interrupted by user for tool use]`
 * cuando lo cortado era una herramienta. No es texto del humano —el humano no
 * escribió nada— así que se reconoce por la forma y no por quién lo firma.
 */
export const CLAUDE_INTERRUPT_MARK = /^\s*\[Request interrupted by user/;

/**
 * Lo que cada TUI pinta cuando lo que le acabas de dar está en su cola y no en
 * su prompt: en Claude Code, `Press up to edit queued messages`; en Codex,
 * `Messages to be submitted after next tool call`.
 *
 * Se mira la pantalla porque es la única forma de saberlo: `paste-buffer`
 * responde que el texto salió, no dónde aterrizó. Y la diferencia importa —
 * encolado significa que el agente lo verá al terminar lo que esté haciendo,
 * que es precisamente lo que interrumpir quería evitar.
 */
export const QUEUED_MARK = /Press up to edit queued messages|Messages to be submitted after/;
