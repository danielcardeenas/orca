import { WindowManager } from '../src/ui/windows/wm.ts';
import { mountAgent } from '../src/ui/windows/kinds/agent.ts';
import { hub } from '../src/ui/net/client.ts';
import { store } from '../src/ui/store.ts';

// Local content and transport only; this page never connects to the hub.
const agent = { id: 'viewport-fixture', callsign: 'DU', projectId: 'fixture',
  runtime: 'codex', model: 'Fixture', state: 'idle', role: 'agent',
  title: 'Window viewport fixture', origin: 'orca', childIds: [], pane: true,
  metrics: { costUSD: 0, inputTokens: 120, outputTokens: 1800, tokensPerSec: 0,
    linesAdded: 0, linesRemoved: 0, toolCalls: 0, turns: 1 }, uptimeMs: 30000,
  startedAt: Date.now(), updatedAt: Date.now() };
store.world.agents[agent.id] = agent as any;
store.world.projects.fixture = { id: 'fixture', name: 'ORCA', code: 'OR' } as any;
store.replaceWorld(store.world);
store.linkUp = true;
export const transport = { opens: 0, resizes: 0, inputs: 0 };
hub.termOpen = (_id, cols, rows, sink) => {
  transport.opens++;
  const paint = (c: number, r: number) => setTimeout(() => sink.data(
    `\x1b[2J\x1b[HFixture terminal — no agent connection\r\n${'─'.repeat(c)}\x1b[${r};1HLAST ROW · ${c} × ${r}`), 0);
  paint(cols, rows);
  return { id: 'viewport-fixture', input() { transport.inputs++; },
    resize(c, r) { transport.resizes++; paint(c, r); }, close() {} };
};
export const tile = { x: 426, y: 274, w: 348, h: 270, visible: true };
const tileEl = document.createElement('div');
tileEl.style.cssText = 'position:absolute;border:1px solid var(--lime);color:var(--ink);padding:12px;box-sizing:border-box';
tileEl.textContent = 'DU · FIXTURE TILE';
document.body.append(tileEl);
export const wm = new WindowManager(document.body, { tileRect: () => tile, onTray() {}, onFocus() {} });
wm.register('agent', ctx => mountAgent(ctx, {} as any));
export const win = wm.open({ kind: 'agent', key: 'viewport-fixture', callsign: 'DU',
  title: 'Window viewport fixture', anchor: agent.id, params: { agentId: agent.id }, ephemeral: true });
function frame() {
  tileEl.style.left = `${tile.x}px`; tileEl.style.top = `${tile.y}px`;
  tileEl.style.width = `${tile.w}px`; tileEl.style.height = `${tile.h}px`;
  wm.reproject(); requestAnimationFrame(frame);
}
frame();
