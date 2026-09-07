import { hub } from '../src/ui/net/client.ts';
import { store as typedStore } from '../src/ui/store.ts';
import { mountAgent as typedMount } from '../src/ui/windows/kinds/agent.ts';
// Fixture deliberately supplies only the fields used by this view.
const store: any = typedStore;
const mountAgent: any = typedMount;


    const a = { id: 'fixture', callsign: 'K9', projectId: 'p', machineId: 'm', runtime: 'claude', model: 'Claude', state: 'idle', role: 'agent', title: 'Improve the agent window', origin: 'orca', childIds: [], metrics: { costUSD: 0, inputTokens: 120, outputTokens: 1800, tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, turns: 1 }, uptimeMs: 30000, startedAt: Date.now(), updatedAt: Date.now(), pane: false };
    store.world.agents.fixture = a;
    store.world.projects.p = { id: 'p', name: 'ORCA', code: 'OR' };
    store.replaceWorld(store.world);
    store.linkUp = true;
    const item = (id: string, kind: string, text: string, n: number) => ({ id, agentId: a.id, kind, text, at: 1700000000000 + n });
    store.world.talk = { fixture: [item('p', 'prompt', 'Make the agent window easier to use.', 0), item('r', 'thinking', 'I will check the conversation and terminal.', 1), item('a', 'say', 'The conversation now reads **from top to bottom**.\n\nUse the [documentation](https://example.com/docs) or https://example.org for details.\n\n| Feature | Status |\n| :--- | ---: |\n| Links | Ready |\n| Tables | Ready |\n\n> Changes stay consistent across CAPCOM and agents.\n\n```ts\nconst conversation = await agent.read();\n```', 2)] };
    const c = { say: async (_ids: string[], text: string) => { store.recordOutgoing({ id: 'echo', agentId: a.id, text, at: Date.now(), status: 'delivered' }); return { ok: 1, failed: [] }; }, note() {}, go() {}, openSpawn() {}, stop() {} };
    mountAgent({ body: document.querySelector('main'), win: { spec: { params: { agentId: a.id } } }, setTitle() {}, setCallsign() {}, setState() {} }, c);

export function appendMessages(count: number) {
  const base = store.world.talk.fixture.length;
  store.applyPatch(store.world.rev + 1, Array.from({ length: count }, (_, n) => ({ o: 'talk', id: 'fixture', v: [{ id: `more-${base + n}`, agentId: 'fixture', kind: 'say', text: `Update ${base + n}: the agent is checking the project and reporting its findings.`, at: Date.now() + n }] })));
}

export const terminalState = { opens: 0, closes: 0, input: '', rows: 0 };
export function setHosted(pane: boolean) {
  // A deterministic terminal transport: never sends input to a real agent.
  hub.termOpen = (_agentId, _cols, rows, sink) => {
    terminalState.opens++;
    terminalState.rows = rows;
    let closed = false;
    const paint = (height: number) => window.setTimeout(() => {
      if (!closed) sink.data(`\x1b[2J\x1b[1;1HConnected terminal\x1b[${height};1HLAST ROW > type here`);
    }, 0);
    paint(rows);
    return { id: 'fixture-terminal', input(data) { terminalState.input += data; },
      resize(_cols, height) { terminalState.rows = height; paint(height); },
      close() { closed = true; terminalState.closes++; } };
  };
  store.applyPatch(store.world.rev + 1, [{ o: 'agent:patch', id: a.id, v: { pane } }]);
}
