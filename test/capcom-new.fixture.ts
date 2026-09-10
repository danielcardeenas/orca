import './capcom-model.fixture.ts';
import { hub } from '../src/ui/net/client.ts';
import { store } from '../src/ui/store.ts';
import { mountCommand } from '../src/ui/hud/command.ts';
import type { Console } from '../src/ui/console.ts';
import type { ProviderHandoffPlan } from '../src/shared/provider-handoff.ts';
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
 * Un `capcom:new` que no contesta hasta que la prueba lo suelta.
 *
 * Vaciar en el sitio tarda segundos en la máquina real —el CLI tiene que
 * volver a su prompt y el transcript nuevo tiene que aparecer—, y lo que la
 * ventana enseña durante ese rato es justo lo que hay que poder mirar.
 */
let open: (() => void) | null = null;
let gate: Promise<void> | null = null;
export function hold() { gate = new Promise<void>(resolve => { open = resolve; }); }
export function release() { open?.(); open = null; gate = null; }
hub.cmd = async cmd => {
  calls.push(cmd);
  if (cmd.k === 'capcom:new') {
    if (gate) await gate;
    // El collector contesta dos cosas distintas, y la consola tiene que
    // distinguirlas: quedarse en el proveedor vacía el contexto en el sitio y
    // devuelve el recibo del `/clear` —sin plan, sin archivo, sin fases—, y
    // cruzar prepara una sesión aparte y devuelve el plan de traspaso.
    const crossing = cmd.model && CROSSING.includes(cmd.model) ? cmd.model : null;
    if (!crossing) return { fromId: 'cap', toId: CLEARED, mode: cmd.mode, cutoffAt: Date.now(), renamed: true };
    plan = { id: '11111111-2222-4333-8444-555555555555', fromId: 'cap', fromRuntime: 'codex', fromModel: 'gpt-6-astra', runtime: 'claude', model: crossing, contextMode: cmd.mode,
      at: Date.now(), archive: '/tmp/isolated-archive', historyPath: '/tmp/isolated-archive/conversation.md', checkpointPath: '/tmp/isolated-archive/HANDOFF.md', bytes: 12345, sha256: 'abc', phase: 'preparing', detail: 'Preparing new CAPCOM; messages held.' };
    return structuredClone(plan);
  }
  if (cmd.k === 'handoff:status') return structuredClone(plan);
  // Lo que el CLI contesta cuando se le pregunta por su catálogo: la elección
  // de New CAPCOM lo pide sola al abrirse.
  if (cmd.k === 'model:list') return { sessionId: 'cap', runtime: 'codex', active: 'gpt-6-astra', requested: null,
    phase: 'ready', detail: '', events: [], choices: [{ id: 'gpt-6-astra', label: 'gpt-6-astra' }, { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna' }] };
  // Y el de los proveedores, del que salen los modelos del OTRO runtime.
  if (cmd.k === 'handoff:models') return [
    { runtime: 'codex', id: 'gpt-6-astra', label: 'gpt-6-astra', installed: true },
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
