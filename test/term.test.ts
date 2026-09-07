/**
 * El hub relayando terminales.
 *
 * El hub no entiende los bytes de una terminal: sabe de quién es cada
 * `termId`, en qué máquina está el pane, y cuándo hay que cerrarla porque
 * uno de los dos lados se fue. Eso es lo que se prueba, con un collector y
 * una consola de mentira sobre websockets de verdad.
 */

import { WebSocket } from 'ws';
import type { Agent, Project } from '../src/shared/types.ts';
import { emptyRollup } from '../src/shared/types.ts';
import type { CommandFrame, ServerFrame } from '../src/shared/protocol.ts';
import { PATHS, PROTOCOL_VERSION, newId } from '../src/shared/protocol.ts';
import { startHub } from '../src/hub/server.ts';
import { ok, test, freePort, sleep, type TestModule } from './harness.ts';

const MACHINE = 'm-term';
const AGENT = 'sess-term-0001';

function agent(over: Partial<Agent> = {}): Agent {
  const now = Date.now();
  return {
    id: AGENT, machineId: MACHINE, projectId: 'p1', title: 'hosted', callsign: 'T1', runtime: 'claude',
    state: 'working', block: null, parentId: null, depth: 0, childIds: [], mission: null, squad: null, lead: false,
    model: null, tool: null, toolDetail: null, lastPrompt: null, lastSay: null,
    startedAt: now, updatedAt: now, uptimeMs: 0,
    metrics: { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0 },
    background: true, shortId: null, pane: true, ...over,
  };
}

const project: Project = {
  id: 'p1', machineId: MACHINE, slug: '-tmp-p1', name: 'p1', path: '/tmp/p1', code: 'P1',
  gitBranch: null, gitDirty: false, keyNames: [], sessionIds: [AGENT], rollup: emptyRollup(),
};

class Peer<F> {
  ws: WebSocket;
  frames: F[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => { try { this.frames.push(JSON.parse(d.toString()) as F); } catch { /* */ } });
    this.ws.on('error', () => { /* */ });
  }
  open(): Promise<void> {
    return new Promise((res, rej) => {
      if (this.ws.readyState === WebSocket.OPEN) return res();
      this.ws.once('open', () => res());
      this.ws.once('close', (c) => rej(new Error(`cerró ${c}`)));
    });
  }
  send(f: unknown): void { this.ws.send(JSON.stringify(f)); }
  async wait(pred: (f: F) => boolean, ms = 3000): Promise<F | null> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      await sleep(20);
    }
    return null;
  }
  close(): void { try { this.ws.close(); } catch { /* */ } }
}

async function fleet<T>(fn: (x: { collector: Peer<CommandFrame>; console: Peer<ServerFrame> }) => Promise<T>): Promise<T> {
  const port = await freePort();
  const hub = await startHub({ port, host: '127.0.0.1', quiet: true });
  const collector = new Peer<CommandFrame>(`ws://127.0.0.1:${port}${PATHS.collector}`);
  const konsole = new Peer<ServerFrame>(`ws://127.0.0.1:${port}${PATHS.console}`);
  try {
    await collector.open();
    collector.send({
      t: 'hello', v: PROTOCOL_VERSION, token: '',
      machine: { id: MACHINE, hostname: 'term-test', platform: 'darwin', version: '0.1.0', online: true, lastSeen: Date.now(), connectedAt: Date.now(), load: { sessions: 1, activeSessions: 1, cpuPct: 1, memPct: 1 } },
    });
    collector.send({ t: 'snapshot', machineId: MACHINE, projects: [project], agents: [agent()], keys: [] });
    await konsole.open();
    konsole.send({ t: 'hello', v: PROTOCOL_VERSION, token: '' });
    await konsole.wait((f) => f.t === 'world' && !!f.state.agents[AGENT]);
    return await fn({ collector, console: konsole });
  } finally {
    collector.close(); konsole.close();
    await hub.close();
  }
}

const tests = [
  test('term:open llega al collector dueño del pane, y sus bytes vuelven a la consola', () => fleet(async ({ collector, console: k }) => {
    const termId = newId('term');
    k.send({ t: 'term:open', termId, agentId: AGENT, cols: 100, rows: 30 });
    const opened = await collector.wait((f) => f.t === 'term:open' && f.termId === termId);
    if (!opened || opened.t !== 'term:open') return ok('term:open llega al collector', false, 'el collector no recibió term:open');
    collector.send({ t: 'term:data', termId, data: 'hola\r\n' });
    const data = await k.wait((f) => f.t === 'term:data' && f.termId === termId);
    return ok('term:open llega al collector dueño del pane, y sus bytes vuelven a la consola',
      opened.agentId === AGENT && opened.cols === 100 && opened.rows === 30 && data?.t === 'term:data' && data.data === 'hola\r\n',
      `open=${opened.cols}x${opened.rows} data=${JSON.stringify(data && data.t === 'term:data' ? data.data : null)}`);
  })),

  test('teclado y resize bajan por el mismo termId; close lo cierra en el collector', () => fleet(async ({ collector, console: k }) => {
    const termId = newId('term');
    k.send({ t: 'term:open', termId, agentId: AGENT, cols: 80, rows: 24 });
    await collector.wait((f) => f.t === 'term:open' && f.termId === termId);
    k.send({ t: 'term:input', termId, data: 'ls\r' });
    k.send({ t: 'term:resize', termId, cols: 132, rows: 40 });
    k.send({ t: 'term:close', termId });
    const input = await collector.wait((f) => f.t === 'term:input' && f.termId === termId);
    const resize = await collector.wait((f) => f.t === 'term:resize' && f.termId === termId);
    const close = await collector.wait((f) => f.t === 'term:close' && f.termId === termId);
    return ok('teclado y resize bajan por el mismo termId; close lo cierra en el collector',
      input?.t === 'term:input' && input.data === 'ls\r' && resize?.t === 'term:resize' && resize.cols === 132 && !!close,
      `input=${input ? 'sí' : 'no'} resize=${resize && resize.t === 'term:resize' ? `${resize.cols}x${resize.rows}` : 'no'} close=${close ? 'sí' : 'no'}`);
  })),

  test('un agente desconocido o un id mal formado se contesta con term:exit, no con silencio', () => fleet(async ({ console: k }) => {
    const termId = newId('term');
    k.send({ t: 'term:open', termId, agentId: 'nadie', cols: 80, rows: 24 });
    const exit = await k.wait((f) => f.t === 'term:exit' && f.termId === termId);
    k.send({ t: 'term:open', termId: 'x', agentId: AGENT, cols: 80, rows: 24 });
    await sleep(150);
    const bogus = k.frames.some((f) => f.t === 'term:exit' && f.termId === 'x');
    return ok('un agente desconocido o un id mal formado se contesta con term:exit, no con silencio',
      exit?.t === 'term:exit' && /unknown agent/.test(exit.reason) && !bogus,
      `reason="${exit && exit.t === 'term:exit' ? exit.reason : ''}" bogusAnswered=${bogus}`);
  })),

  test('si la consola se va, el collector recibe term:close por cada terminal suya', () => fleet(async ({ collector, console: k }) => {
    const a = newId('term'), b = newId('term');
    k.send({ t: 'term:open', termId: a, agentId: AGENT, cols: 80, rows: 24 });
    k.send({ t: 'term:open', termId: b, agentId: AGENT, cols: 80, rows: 24 });
    await collector.wait((f) => f.t === 'term:open' && f.termId === b);
    k.close();
    const ca = await collector.wait((f) => f.t === 'term:close' && f.termId === a);
    const cb = await collector.wait((f) => f.t === 'term:close' && f.termId === b);
    return ok('si la consola se va, el collector recibe term:close por cada terminal suya', !!ca && !!cb, `a=${!!ca} b=${!!cb}`);
  })),

  test('si la máquina se va, la consola recibe term:exit', () => fleet(async ({ collector, console: k }) => {
    const termId = newId('term');
    k.send({ t: 'term:open', termId, agentId: AGENT, cols: 80, rows: 24 });
    await collector.wait((f) => f.t === 'term:open' && f.termId === termId);
    collector.close();
    const exit = await k.wait((f) => f.t === 'term:exit' && f.termId === termId);
    return ok('si la máquina se va, la consola recibe term:exit',
      exit?.t === 'term:exit' && /disconnected/.test(exit.reason), exit && exit.t === 'term:exit' ? exit.reason : 'sin term:exit');
  })),

  test('los bytes de otra máquina para un termId ajeno se descartan', () => fleet(async ({ collector, console: k }) => {
    const termId = newId('term');
    k.send({ t: 'term:open', termId, agentId: AGENT, cols: 80, rows: 24 });
    await collector.wait((f) => f.t === 'term:open' && f.termId === termId);
    // Un frame con un termId que nadie abrió: nunca llega a una consola.
    collector.send({ t: 'term:data', termId: 'term_intruso0001', data: 'pwned' });
    await sleep(150);
    const leaked = k.frames.some((f) => f.t === 'term:data' && f.data === 'pwned');
    return ok('los bytes de otra máquina para un termId ajeno se descartan', !leaked, leaked ? 'FILTRÓ' : 'descartado');
  })),
];

const suite: TestModule = { suite: 'hub · terminales', tests };
export default suite;
