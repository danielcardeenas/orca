/**
 * La isla de fuera de la flota, con un CAPCOM retirado dentro.
 *
 * Reproduce lo que queda en la máquina después de un relevo: la sesión que
 * llevaba el mando, ya degradada a `role:'agent'` y marcada `hidden`, y el acta
 * que la retiró. Con EVERYONE puesto —que es la única manera de verla— tiene
 * que poder distinguirse del resto de sesiones terminadas que viven ahí.
 */
import { store } from '../src/ui/store.ts';
import { setPref } from '../src/ui/prefs.ts';
import { emptyWorld, type Agent } from '../src/shared/types.ts';
import { parseHandoff } from '../src/shared/handoff.ts';
import { offFleetProjectId } from '../src/shared/workspaces.ts';
import { mountFleet } from '../src/ui/windows/kinds/fleet.ts';
import type { WinCtx } from '../src/ui/windows/wm.ts';
import type { Console } from '../src/ui/console.ts';

const MACHINE = 'm1';
export const RETIRED_AT = new Date('2026-09-08T03:01:20.000Z').getTime();
const island = offFleetProjectId(MACHINE);

function agent(o: Partial<Agent> & { id: string; callsign: string }): Agent {
  return { machineId: MACHINE, projectId: island, role: 'agent', state: 'done', runtime: 'claude', model: 'claude-opus-5',
    title: '', parentId: null, childIds: [], depth: 0, squad: null, lead: false, block: null, mission: null, lastSay: null, lastPrompt: null,
    tool: null, toolDetail: null, startedAt: RETIRED_AT - 60_000, updatedAt: RETIRED_AT, uptimeMs: 0, background: false, shortId: null,
    origin: 'orca', workspace: 'capcom', hidden: true,
    metrics: { costUSD: 0, tokensPerSec: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0 },
    ...o } as Agent;
}

const w = emptyWorld();
w.agents['f0183205-0000-4000-8000-000000000001'] = agent({ id: 'f0183205-0000-4000-8000-000000000001', callsign: '1C', title: 'previous command session' });
w.agents['aaaa1111-0000-4000-8000-000000000002'] = agent({ id: 'aaaa1111-0000-4000-8000-000000000002', callsign: 'ZZ', title: 'a probe someone ran in the command directory' });
w.capcomHandoffs = [parseHandoff({ machineId: MACHINE, fromId: 'f0183205-0000-4000-8000-000000000001', toId: '01a07ef6-0000-4000-8000-000000000003',
  at: RETIRED_AT, fromRuntime: 'claude', fromModel: 'opus', toRuntime: 'codex', toModel: 'gpt-6-astra', reason: 'manual',
  contextMode: 'clean', cutoffAt: RETIRED_AT - 1000, historyPath: null, checkpointPath: null })!];
store.replaceWorld(w);
store.linkUp = true;
// Sin EVERYONE la isla está vacía a propósito: lo retirado no se pinta.
setPref('showAll', true);
store.refilter();

const c = { note() {}, go() {}, openTerminal() {}, openFile() {} } as unknown as Console;
const main = document.querySelector('main')!;
mountFleet({ body: main, win: { id: 'off-fleet-fixture', el: main, spec: { params: { scope: 'project', id: island } } },
  setTitle() {}, setCallsign() {}, setState() {} } as unknown as WinCtx, c);
export function hideRetired() { setPref('showAll', false); store.refilter(); }
