import './capcom-model.fixture.ts';
import { hub } from '../src/ui/net/client.ts';
import { store } from '../src/ui/store.ts';
import { mountCommand } from '../src/ui/hud/command.ts';
import type { Console } from '../src/ui/console.ts';
import type { ProviderHandoffPlan } from '../src/shared/provider-handoff.ts';
import type { CapcomResetControl } from '../src/shared/capcom-reset-control.ts';
import type { Agent } from '../src/shared/types.ts';
export const calls: { k: string; mode?: string; model?: string | null }[] = [];
export const notes: string[] = [];
/** Los modelos del OTRO runtime: los únicos que preparan una sesión aparte. */
const CROSSING = ['sonnet', 'opus'];
/** El id que el CLI estrena tras un `/clear`, descubierto por el collector. */
export const CLEARED = '99999999-8888-4777-8666-555555555555';
let plan: ProviderHandoffPlan | undefined;
const commandHost = document.createElement('div'); document.body.appendChild(commandHost);
mountCommand(commandHost, { openCeo() {}, note: (text: string) => notes.push(text), field: { select() {} } } as unknown as Console);
/**
 * ¿La sesión está ocupada cuando se le pregunta por su menú?
 *
 * Un CAPCOM al mando casi nunca está ocioso con el prompt limpio en el instante
 * en que el operador abre la elección, y entonces `model:list` devuelve el
 * catálogo guardado, que puede estar vacío. Eso es lo que dejaba sin opciones
 * de Claude a quien quería cambiar de Opus a Sonnet, mientras Codex sí salía.
 */
let busy = false;
export function busySession(on: boolean) { busy = on; }
/**
 * El NEW CAPCOM encolado, igual que `capcom-model.fixture.ts` modela
 * `modelControl`: `capcom:new` contesta YA con `phase: 'queued'` —no espera a
 * que el `/clear` real termine—, y sólo `applyQueuedReset`/`failQueuedReset`
 * mueven la aguja, como haría el `tick()` del collector en la máquina real.
 */
let reset: CapcomResetControl | undefined;
function updateReset() {
  store.applyPatch(store.world.rev + 1, [{ o: 'agent', id: 'cap', v: { ...store.world.agents.cap!, resetControl: reset ? structuredClone(reset) : undefined } as unknown as Agent }]);
}
export function applyQueuedReset() {
  if (!reset || reset.phase !== 'queued') return;
  reset = { ...reset, phase: 'ready', detail: `Context cleared; now ${CLEARED}.` };
  updateReset();
}
export function failQueuedReset(detail = 'CAPCOM did not go idle within 10 minutes. The context was not cleared.') {
  if (!reset) return;
  reset = { ...reset, phase: 'failed', detail };
  updateReset();
}
hub.cmd = async cmd => {
  calls.push(cmd);
  if (cmd.k === 'capcom:new') {
    // El collector contesta dos cosas distintas, y la consola tiene que
    // distinguirlas: quedarse en el proveedor encola el vaciado en el sitio —
    // el `tick()` real lo aplica cuando CAPCOM está idle, no en esta llamada—,
    // y cruzar prepara una sesión aparte y devuelve el plan de traspaso.
    const crossing = cmd.model && CROSSING.includes(cmd.model) ? cmd.model : null;
    if (!crossing) {
      reset = { sessionId: 'cap', runtime: 'codex', mode: cmd.mode as 'clean' | 'continuity', model: cmd.model ?? '',
        phase: 'queued', detail: 'Waiting for CAPCOM to be idle.', requestedAt: Date.now() };
      updateReset();
      return structuredClone(reset);
    }
    plan = { id: '11111111-2222-4333-8444-555555555555', fromId: 'cap', fromRuntime: 'codex', fromModel: 'gpt-6-astra', runtime: 'claude', model: crossing, contextMode: cmd.mode,
      at: Date.now(), archive: '/tmp/isolated-archive', historyPath: '/tmp/isolated-archive/conversation.md', checkpointPath: '/tmp/isolated-archive/HANDOFF.md', bytes: 12345, sha256: 'abc', phase: 'preparing', detail: 'Preparing new CAPCOM; messages held.' };
    return structuredClone(plan);
  }
  if (cmd.k === 'capcom:new:cancel') {
    if (reset?.phase === 'queued') { reset = { ...reset, phase: 'ready', detail: '', model: '' }; updateReset(); }
    return structuredClone(reset ?? { sessionId: 'cap', runtime: 'codex', mode: 'clean', model: '', phase: 'ready', detail: '', requestedAt: 0 });
  }
  if (cmd.k === 'handoff:status') return structuredClone(plan);
  // Lo que el CLI contesta cuando se le pregunta por su catálogo: la elección
  // de New CAPCOM lo pide sola al abrirse. Una sesión ocupada contesta lo que
  // tenía guardado —nada—, porque el menú sólo se abre con el prompt libre.
  if (cmd.k === 'model:list') return { sessionId: 'cap', runtime: 'codex', active: 'gpt-6-astra', requested: null,
    phase: 'ready', detail: '', events: [], choices: busy ? [] : [{ id: 'gpt-6-astra', label: 'gpt-6-astra' }, { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna' }] };
  // Y el de los proveedores, del que salen los modelos del OTRO runtime — y
  // los del mismo que la sesión aún no ha confirmado: `gpt-5.6-terra` no está
  // en el menú de arriba, sólo aquí.
  if (cmd.k === 'handoff:models') return [
    { runtime: 'codex', id: 'gpt-6-astra', label: 'gpt-6-astra', installed: true },
    { runtime: 'codex', id: 'gpt-5.6-terra', label: 'gpt-5.6-terra', installed: true },
    { runtime: 'claude', id: 'sonnet', label: 'Sonnet', installed: true },
    { runtime: 'claude', id: 'opus', label: 'Opus', installed: false },
  ];
  throw new Error(`Unexpected fixture command: ${cmd.k}`);
};
export function fail() { if (plan) plan = { ...plan, phase: 'failed', detail: 'Destination unavailable. Original CAPCOM retained; retry when ready.' }; }
export function complete() { if (plan) plan = { ...plan, phase: 'complete', toId: 'new-capcom', detail: 'Clean CAPCOM is active and waiting for new instructions.' }; }
export function link(up: boolean) { store.linkUp = up; store.applyPatch(store.world.rev + 1, []); }

store.applyPatch(store.world.rev + 1, [{ o: 'agent', id: 'cap', v: { ...store.world.agents.cap!, pane: true, state: 'idle' } as unknown as Agent }]);

/**
 * Un CAPCOM recién arrancado al que nadie ha preguntado por sus modelos.
 *
 * El catálogo lo llena el CLI cuando se le pregunta: hasta que alguien pulsa
 * CHANGE MODEL, `choices` está vacío. La elección de New CAPCOM tiene que
 * pedirlo ella misma o no tendría nada que ofrecer.
 */
export function forgetModels() {
  store.applyPatch(store.world.rev + 1, [{ o: 'agent', id: 'cap', v: { ...store.world.agents.cap!,
    modelControl: { sessionId: 'cap', runtime: 'codex', active: 'gpt-6-astra', requested: null,
      phase: 'ready', detail: '', events: [], choices: [] } } as unknown as Agent }]);
}
