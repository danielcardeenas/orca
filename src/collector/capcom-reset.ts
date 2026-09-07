/**
 * Vaciar el contexto de CAPCOM con el comando que el propio CLI trae.
 *
 * Los dos CLIs saben empezar de cero: `/clear` cierra el hilo abierto y abre
 * otro —«clear the terminal and start a new chat», dice Codex, y lo deja por
 * escrito al hacerlo: «To continue this session, run codex resume … <uuid>»—.
 * El proceso no se reinicia, no hay que arrancar nada, no hay cuota que gastar
 * y no queda un archivo de decenas de megabytes por el camino.
 *
 * ── Lo que sí cuesta ───────────────────────────────────────────────
 *
 * El identificador. ORCA nombra el pane `orca-<sessionId>` y sigue el
 * transcript de ese id, y con `/clear` el id nuevo lo elige el CLI y no lo
 * anuncia a nadie: el pane conserva su nombre viejo y el collector sigue
 * mirando un archivo que ya no crece. Así que aquí la identidad se descubre en
 * vez de elegirse — el mismo camino que ya recorre un worker de Codex, que
 * tampoco puede tomar su id por adelantado: se espera al transcript nuevo del
 * mismo directorio, y cuando aparece se renombra el pane.
 *
 * Un rollout no existe hasta el primer turno, así que el relevo se abre con un
 * mensaje: en continuidad, el checkpoint del hub; en limpio, una línea que sólo
 * pide un recibo. Ese intercambio es todo lo que hereda un contexto «limpio»,
 * igual que hoy hereda el recibo de la preparación.
 *
 * ── Y lo que no protege ────────────────────────────────────────────
 *
 * `/clear` no se puede ensayar: cuando vuelve, el contexto anterior ya no está.
 * No hay «conservar el original» como en un traspaso preparado, porque no hay
 * dos sesiones entre las que elegir — hay un proceso que ya se vació. Lo que sí
 * se conserva es todo lo demás: el proceso sigue vivo y utilizable, el
 * transcript anterior sigue en el directorio del CLI con su uuid, y el registro
 * del hub —tareas, reglas, workers— no se toca. Si el descubrimiento falla, lo
 * que queda no es una flota sin mando: es un CAPCOM vivo cuyo id ORCA aún no
 * conoce, y el pane sigue ahí para el operador.
 *
 * Por eso el traspaso preparado no desaparece: cambiar de runtime sí arranca
 * otro binario, y ahí verificar antes de retirar al anterior vale lo que cuesta.
 */

import type { AgentHandle } from './commands.ts';
import type { TmuxHost } from './tmux.ts';
import { paneName } from './tmux.ts';
import { modelPromptReady, resumedPromptReady } from './model-control.ts';

/** Lo que el relevo debe devolver para darse por vivo. */
export const RESET_RECEIPT = 'ORCA_CONTEXT_READY';

/**
 * El primer mensaje del relevo.
 *
 * En limpio pide un recibo y nada más: sin herramientas, sin recuperar
 * pendientes, sin historia. Lo que hace que un contexto limpio siga limpio no
 * es el silencio, es que la única instrucción que reciba no le pida nada.
 */
export function resetPrompt(mode: 'clean' | 'continuity', nonce: string, checkpoint = ''): string {
  if (mode === 'clean') {
    return `[ORCA] Fresh CAPCOM context. Do not call tools, run briefing or recall, read history, or dispatch work.`
      + ` No historical obligations are supplied or authorized; this overrides any inherited instruction to run briefing after a reset.`
      + ` Files, workers and hub rules are unchanged and remain retrievable on request.`
      + ` Reply with exactly ${RESET_RECEIPT}_${nonce} and then wait for new instructions.`;
  }
  return `[ORCA] Fresh CAPCOM context with a checkpoint. Treat it as a snapshot, not as new orders.`
    + ` Call briefing before acting, and reconcile pending work from the hub rather than from memory.`
    + ` Acknowledge briefly, ending with exactly ${RESET_RECEIPT}_${nonce}.\n\n${checkpoint}`;
}

export interface ResetDeps {
  tmux: Pick<TmuxHost, 'capture' | 'paste' | 'keys' | 'rename'>;
  /** El transcript nuevo de este runtime en este proyecto, creado tras `since`. */
  discover(projectId: string, runtime: string, since: number, timeoutMs: number): Promise<AgentHandle | null>;
  wait?(ms: number): Promise<void>;
  now?(): number;
}

export interface ResetOutcome {
  fromId: string;
  toId: string;
  mode: 'clean' | 'continuity';
  /** Nada anterior a esto pertenece al contexto nuevo. */
  cutoffAt: number;
  renamed: boolean;
}

/** Cuánto se espera a que el CLI acepte el comando y vuelva a su prompt. */
const PROMPT_TRIES = 40;
/** Y a que el transcript del relevo aparezca tras el primer turno. */
const DISCOVER_MS = 120_000;

/**
 * `/clear` en el pane de CAPCOM, y la identidad nueva que sale de ahí.
 *
 * Devuelve sólo cuando hay un id nuevo que adoptar. Nunca inventa uno: si el
 * transcript no aparece, falla diciendo que el proceso sigue vivo, que es la
 * única lectura correcta de esa situación.
 */
export async function resetContext(
  a: AgentHandle, mode: 'clean' | 'continuity', prompt: string, deps: ResetDeps,
): Promise<ResetOutcome> {
  const pause = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  if (!a.pane || !a.alive) throw new Error('CAPCOM must be hosted and alive to clear its context.');
  if (!['claude', 'codex'].includes(a.runtime)) throw new Error('Unknown CAPCOM runtime; nothing was cleared.');

  const screen = await deps.tmux.capture(a.pane, 40);
  if (!screen.ok) throw new Error(`CAPCOM terminal unavailable: ${screen.detail}`);
  // Un menú abierto o un turno en marcha se tragarían `/clear` como texto.
  if (!modelPromptReady(screen.stdout, a.runtime)) throw new Error('Finish the current turn or close the terminal dialog, then try again.');

  const cutoffAt = now();
  const cleared = await deps.tmux.paste(a.pane, '/clear');
  if (!cleared.ok) throw new Error(`Could not send /clear: ${cleared.detail}`);

  // El CLI cierra el hilo y vuelve a un prompt vacío. Hasta aquí no hay
  // transcript nuevo: un hilo sin turnos todavía no se escribe en disco.
  let ready = false;
  for (let i = 0; i < PROMPT_TRIES && !ready; i++) {
    await pause(250);
    const after = await deps.tmux.capture(a.pane, 40);
    if (!after.ok) throw new Error(`CAPCOM terminal unavailable after /clear: ${after.detail}`);
    ready = resumedPromptReady(after.stdout, a.runtime);
  }
  if (!ready) throw new Error('The terminal did not come back to a prompt after /clear. CAPCOM is still running; check its pane.');

  const opened = await deps.tmux.paste(a.pane, prompt);
  if (!opened.ok) throw new Error(`Context cleared, but the opening message could not be sent: ${opened.detail}`);

  const found = await deps.discover(a.projectId, a.runtime, cutoffAt, DISCOVER_MS);
  if (!found || found.sessionId === a.sessionId) {
    throw new Error('Context was cleared but its new session id has not appeared yet. CAPCOM is still running in the same pane; it will be adopted when its transcript shows.');
  }

  // El pane conserva el nombre del id viejo hasta aquí: renombrarlo es lo que
  // devuelve la invariante de que un pane se llama como la sesión que lleva.
  const want = paneName(found.sessionId);
  const renamed = !!want && (await deps.tmux.rename(a.pane, want)).ok;
  return { fromId: a.sessionId, toId: found.sessionId, mode, cutoffAt, renamed };
}

export interface ResetServiceDeps extends ResetDeps {
  agent(id: string): AgentHandle | null;
  owns(a: AgentHandle): boolean;
  busy(id: string): boolean;
  /** El modelo efectivo, y cómo cambiarlo con el selector nativo. */
  model(a: AgentHandle): string | null;
  setModel(id: string, model: string): Promise<unknown>;
  /** Retener el correo mientras dura, como en un traspaso. */
  hold(id: string, on: boolean, cutoffAt: number, mode: 'clean' | 'continuity'): void;
  /** El rol se muda al id nuevo, y con él el registro que lo readopta. */
  adopt(from: string, to: string, mode: 'clean' | 'continuity', cutoffAt: number, model: string): void;
  note(text: string): void;
}

/**
 * Un reset a la vez, con el correo retenido mientras dura.
 *
 * La retención es la misma promesa que en un traspaso: lo que llegue durante el
 * cambio no se entrega a una sesión que está a punto de dejar de existir ni se
 * pierde, sino que espera al id nuevo. Lo que cambia es cuánto dura — aquí son
 * segundos, no dos minutos — y que no hay nada que cancelar si sale mal, porque
 * no se ha arrancado nada.
 */
export class CapcomResets {
  private running: string | null = null;
  private last: ResetOutcome | null = null;
  constructor(private deps: ResetServiceDeps) {}
  locked(id: string): boolean { return this.running === id; }
  latest(): ResetOutcome | null { return this.last; }

  async run(id: string, mode: 'clean' | 'continuity', model: string, checkpoint = ''): Promise<ResetOutcome> {
    if (!['clean', 'continuity'].includes(mode)) throw new Error('Choose clean or continuity explicitly.');
    const a = this.deps.agent(id);
    if (!a || !this.deps.owns(a) || !a.pane || !a.alive) throw new Error('An active hosted CAPCOM is required.');
    if (this.running) throw new Error('A CAPCOM reset is already in progress.');
    if (this.deps.busy(id)) throw new Error('Finish the current turn or model change first.');
    if (!(a.state === 'idle' || (a.state === 'blocked' && a.blockKind === 'error'))) throw new Error('Finish the current turn before clearing the context.');

    this.running = id;
    const cutoffAt = (this.deps.now ?? Date.now)();
    this.deps.hold(id, true, cutoffAt, mode);
    try {
      // Antes de vaciar: el relevo debe nacer con el modelo pedido, y mientras
      // el contexto viejo sigue ahí un cambio fallido no cuesta nada.
      if (model !== this.deps.model(a)) {
        await this.deps.setModel(id, model);
        this.deps.note(`CAPCOM model set to ${model} before clearing its context.`);
      }
      const fresh = this.deps.agent(id) ?? a;
      const nonce = `${cutoffAt.toString(36)}`;
      const out = await resetContext(fresh, mode, resetPrompt(mode, nonce, checkpoint), this.deps);
      // El modelo va con el relevo: si se cambió antes de vaciar, la identidad
      // tiene que decir con cuál se relanza, no con el que había al empezar.
      this.deps.adopt(out.fromId, out.toId, mode, out.cutoffAt, model);
      this.deps.note(`CAPCOM context cleared (${mode}); now ${out.toId} on ${model}.`);
      this.last = out;
      return out;
    } finally {
      this.running = null;
      this.deps.hold(id, false, cutoffAt, mode);
    }
  }
}
