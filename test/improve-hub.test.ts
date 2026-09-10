/**
 * AUTOMEJORA de extremo a extremo: consola → hub → disco → misión.
 *
 * `improve.test.ts` prueba las piezas con reloj falso. Esto levanta un hub de
 * verdad, le habla por el mismo socket que usa la consola y comprueba lo que
 * sólo se puede comprobar entero:
 *
 *   - que el tablero llega por el protocolo, con el veredicto del reloj al lado
 *   - que SEND abre una MISIÓN de verdad, con la propuesta entera dentro, y que
 *     el segundo SEND se niega — que es lo único irreversible de la sección
 *   - que contestar una propuesta queda en su hilo
 *   - que los límites que se tocan en el panel sobreviven al reinicio del hub
 *   - que la telemetría cuenta lo que la consola pide, y sólo el tipo de trama
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { startHub, type Hub } from '../src/hub/server.ts';
import { createAuth } from '../src/hub/auth.ts';
import { HubStore } from '../src/hub/persist.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { PATHS } from '../src/shared/protocol.ts';
import type { ServerFrame } from '../src/shared/protocol.ts';
import { IMPROVE_DIR, IMPROVE_FILE } from '../src/hub/improve.ts';
import type { ImproveState } from '../src/shared/improve.ts';
import { ok, test, type TestModule } from './harness.ts';

const TOKEN = 'tok-improve';

interface Ack { t: 'ack'; cmdId: string; ok: boolean; detail?: string; data?: unknown }

class Wire {
  private ws: WebSocket;
  private frames: ServerFrame[] = [];
  private n = 0;
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${PATHS.console}?token=${encodeURIComponent(TOKEN)}`);
    this.ws.on('message', (d) => { try { this.frames.push(JSON.parse(d.toString()) as ServerFrame); } catch { /* ignora */ } });
    this.ws.on('error', () => { /* el cierre lo cuenta la prueba */ });
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('close', (code) => reject(new Error(`cerró con ${code}`)));
    });
  }
  /** Manda una trama con id y espera SU ack. */
  ask(frame: Record<string, unknown>): Promise<Ack> {
    const id = `c${this.n++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sin ack para ${String(frame['t'])}`)), 6_000);
      const onMessage = (d: Buffer) => {
        const f = JSON.parse(d.toString()) as ServerFrame;
        if (f.t !== 'ack' || f.cmdId !== id) return;
        clearTimeout(timer);
        this.ws.off('message', onMessage as never);
        resolve(f as Ack);
      };
      this.ws.on('message', onMessage as never);
      this.ws.send(JSON.stringify({ ...frame, id }));
    });
  }
  pushed(): ServerFrame[] { return this.frames; }
  close(): void { try { this.ws.close(); } catch { /* ya */ } }
}

async function withHub<T>(fn: (hub: Hub, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-improve-hub-'));
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    store: new HubStore({ dir }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
  });
  try { return await fn(hub, dir); } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const DRAFT = {
  key: 'queue-order',
  title: 'The queue buries the oldest escalation',
  summary: 'Sort the queue by age so the longest wait is the first row.',
  area: 'usability', kind: 'observed',
  evidence: ['avg wait 14m over 31 escalations'],
  question: 'Should the wait show on the row too?',
  impact: 'high', effort: 'low',
};

const tests = [
  test('the board travels the protocol with the reason the clock is waiting', () => withHub(async (hub) => {
    const wire = new Wire(hub.port);
    await wire.open();
    try {
      hub.autonomy.improve.store.file('rev_x', [DRAFT]);
      const ack = await wire.ask({ t: 'improve:get' });
      const data = ack.data as { state: ImproveState; verdict: { due: boolean; reason: string } };
      const p = Object.values(data.state.proposals)[0]!;
      return ok('one proposal, and why no review is due',
        ack.ok && p.title === DRAFT.title && p.evidence.length === 1 && p.impact === 'high'
        && data.verdict.due === false && data.verdict.reason.length > 0,
        data.verdict.reason);
    } finally { wire.close(); }
  })),

  test('SEND opens a real mission carrying the proposal, and never a second one', () => withHub(async (hub) => {
    const wire = new Wire(hub.port);
    await wire.open();
    try {
      const id = hub.autonomy.improve.store.file('rev_x', [DRAFT]).proposals[0]!.id;
      const first = await wire.ask({ t: 'improve:send', proposalId: id, missionId: 'mission_send_1' });
      const again = await wire.ask({ t: 'improve:send', proposalId: id, missionId: 'mission_send_2' });

      const mission = hub.missions.get('mission_send_1');
      const linked = hub.autonomy.improve.store.get(id);
      let orphan = false;
      try { hub.missions.get('mission_send_2'); orphan = true; } catch { /* nunca se creó */ }

      return ok('one mission, linked both ways, and the second click refused',
        first.ok && mission.title.startsWith('AUTOMEJORA · ')
        && mission.messages[0]!.text.includes('avg wait 14m')
        && mission.messages[0]!.text.includes(id)
        && linked.status === 'sent' && linked.missionId === 'mission_send_1'
        && !again.ok && (again.detail ?? '').includes('Already sent')
        && !orphan,
        `${again.detail ?? ''}`);
    } finally { wire.close(); }
  })),

  test('a refused SEND leaves no mission behind', () => withHub(async (hub) => {
    const wire = new Wire(hub.port);
    await wire.open();
    try {
      const id = hub.autonomy.improve.store.file('rev_x', [DRAFT]).proposals[0]!.id;
      const bad = await wire.ask({ t: 'improve:send', proposalId: id, missionId: 'not-a-mission-id' });
      const missions = Object.keys(hub.missions.all()).length;
      return ok('an invalid id is refused before anything is written',
        !bad.ok && missions === 0 && hub.autonomy.improve.store.get(id).status === 'open', bad.detail);
    } finally { wire.close(); }
  })),

  test('answering keeps the exchange on the proposal, with or without CAPCOM', () => withHub(async (hub) => {
    const wire = new Wire(hub.port);
    await wire.open();
    try {
      const id = hub.autonomy.improve.store.file('rev_x', [DRAFT]).proposals[0]!.id;
      const ack = await wire.ask({ t: 'improve:act', proposalId: id, act: 'reply', text: 'yes, and put the wait on the row' });
      const p = hub.autonomy.improve.store.get(id);
      const human = p.notes.find((n) => n.role === 'human');
      // Sin sesión CAPCOM la respuesta se guarda igual y se dice que nadie la
      // recogió: perderla en silencio sería lo único inaceptable aquí.
      const system = p.notes.find((n) => n.role === 'system');
      return ok('saved, and honest about delivery',
        ack.ok && human?.text === 'yes, and put the wait on the row'
        && !!system && system.text.includes('No CAPCOM'),
        system?.text);
    } finally { wire.close(); }
  })),

  test('the limits the operator sets outlive the hub, and so does a dismissal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-hub-'));
    const boot = () => startHub({
      port: 0, host: '127.0.0.1', quiet: true,
      auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
      store: new HubStore({ dir }),
      memory: new AnswerMemory(join(dir, 'memory.jsonl')),
    });
    return (async () => {
      let hub = await boot();
      let id = '';
      try {
        const wire = new Wire(hub.port);
        await wire.open();
        id = hub.autonomy.improve.store.file('rev_x', [DRAFT]).proposals[0]!.id;
        await wire.ask({ t: 'improve:config', patch: { everyMin: 720, perDay: 2, paused: true } });
        await wire.ask({ t: 'improve:act', proposalId: id, act: 'dismiss' });
        wire.close();
      } finally { await hub.close(); }

      const onDisk = JSON.parse(readFileSync(join(dir, IMPROVE_DIR, IMPROVE_FILE), 'utf8')) as ImproveState;
      hub = await boot();
      try {
        const back = hub.autonomy.improve.store.state();
        return ok('config and decisions survive a restart',
          onDisk.config.everyMin === 720
          && back.config.everyMin === 720 && back.config.perDay === 2 && back.config.paused === true
          && back.proposals[id]!.status === 'dismissed'
          && hub.autonomy.improve.verdict().reason.includes('PAUSED'),
          `everyMin=${back.config.everyMin} paused=${back.config.paused}`);
      } finally {
        await hub.close();
        rmSync(dir, { recursive: true, force: true });
      }
    })();
  }),

  test('the board carries what the next reviewer will be, and where to ask for models', () => withHub(async (hub) => {
    const wire = new Wire(hub.port);
    await wire.open();
    try {
      const ack = await wire.ask({ t: 'improve:get' });
      const data = ack.data as { choice: { runtime: string; model: string | null; from: { runtime: string; model: string } }; machineId: string | null };
      return ok('the panel does not have to deduce any of it',
        ack.ok && data.choice.runtime === 'claude' && data.choice.model === null
        && data.choice.from.runtime === 'environment' && data.choice.from.model === 'cli'
        // Sin proyecto que revisar no hay máquina a la que pedir el catálogo, y
        // se dice con null en vez de con una cadena vacía que hay que probar.
        && data.machineId === null,
        JSON.stringify(data.choice));
    } finally { wire.close(); }
  })),

  test('a runtime the hub cannot launch is refused over the wire, and nothing is stored', () => withHub(async (hub) => {
    const wire = new Wire(hub.port);
    await wire.open();
    try {
      const good = await wire.ask({ t: 'improve:config', patch: { runtime: 'codex', model: 'gpt-5-codex' } });
      const bad = await wire.ask({ t: 'improve:config', patch: { runtime: 'gemini' } });
      const badModel = await wire.ask({ t: 'improve:config', patch: { model: 'opus rm -rf' } });
      const st = hub.autonomy.improve.store.state();
      return ok('the server is the one that decides, not the panel',
        good.ok && !bad.ok && (bad.detail ?? '').includes('claude, codex')
        && !badModel.ok && (badModel.detail ?? '').includes('letters, digits')
        && st.runtime === 'codex' && st.model === 'gpt-5-codex',
        `${bad.detail} · ${badModel.detail}`);
    } finally { wire.close(); }
  })),

  test('over the wire, changing runtime alone leaves no model from the other CLI', () => withHub(async (hub) => {
    const wire = new Wire(hub.port);
    await wire.open();
    try {
      await wire.ask({ t: 'improve:config', patch: { runtime: 'claude', model: 'opus' } });
      // Exactamente lo que manda el panel al cambiar de CLI: sólo el runtime.
      // Si la limpieza viviera en la consola, esto dejaría codex/opus guardado.
      const moved = await wire.ask({ t: 'improve:config', patch: { runtime: 'codex' } });
      const afterMove = (moved.data as { config: { runtime: string | null; model: string | null } }).config;
      const joint = await wire.ask({ t: 'improve:config', patch: { runtime: 'claude', model: 'haiku' } });
      const afterJoint = (joint.data as { config: { runtime: string | null; model: string | null } }).config;
      const st = hub.autonomy.improve.store.state();
      return ok('the ack says what stuck, and what stuck is launchable',
        moved.ok && afterMove.runtime === 'codex' && afterMove.model === null
        && joint.ok && afterJoint.runtime === 'claude' && afterJoint.model === 'haiku'
        && st.runtime === 'claude' && st.model === 'haiku',
        `${afterMove.runtime}/${String(afterMove.model)} → ${afterJoint.runtime}/${String(afterJoint.model)}`);
    } finally { wire.close(); }
  })),

  test('a typed budget is clamped by the server and the panel is told what stuck', () => withHub(async (hub) => {
    const wire = new Wire(hub.port);
    await wire.open();
    try {
      const huge = await wire.ask({ t: 'improve:config', patch: { budgetTokens: 999_000_000 } });
      const got = (huge.data as { config: { budgetTokens: number } }).config.budgetTokens;
      const custom = await wire.ask({ t: 'improve:config', patch: { budgetTokens: 650_000 } });
      return ok('what comes back is what stuck, not what was typed',
        huge.ok && got === 20_000_000
        && (custom.data as { config: { budgetTokens: number } }).config.budgetTokens === 650_000
        && hub.autonomy.improve.store.state().budgetTokens === 650_000,
        String(got));
    } finally { wire.close(); }
  })),

  test('the choice outlives a hub restart, and the wire says so afterwards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-hub-'));
    const boot = () => startHub({
      port: 0, host: '127.0.0.1', quiet: true,
      auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
      store: new HubStore({ dir }),
      memory: new AnswerMemory(join(dir, 'memory.jsonl')),
    });
    return (async () => {
      let hub = await boot();
      try {
        const wire = new Wire(hub.port);
        await wire.open();
        await wire.ask({ t: 'improve:config', patch: { runtime: 'codex', model: 'gpt-5-codex', budgetTokens: 750_000 } });
        wire.close();
      } finally { await hub.close(); }

      const onDisk = JSON.parse(readFileSync(join(dir, IMPROVE_DIR, IMPROVE_FILE), 'utf8')) as ImproveState;
      hub = await boot();
      try {
        const wire = new Wire(hub.port);
        await wire.open();
        const ack = await wire.ask({ t: 'improve:get' });
        const data = ack.data as { state: ImproveState; choice: { runtime: string; model: string | null; from: { runtime: string } } };
        wire.close();
        return ok('written, reloaded, and reported the same',
          onDisk.runtime === 'codex' && onDisk.model === 'gpt-5-codex' && onDisk.budgetTokens === 750_000
          && data.state.runtime === 'codex' && data.state.budgetTokens === 750_000
          && data.choice.runtime === 'codex' && data.choice.model === 'gpt-5-codex'
          && data.choice.from.runtime === 'operator',
          `${data.choice.runtime}/${data.choice.model}`);
      } finally {
        await hub.close();
        rmSync(dir, { recursive: true, force: true });
      }
    })();
  }),

  test('the telemetry counts what the console asks for, and only the frame type', () => withHub(async (hub) => {
    const wire = new Wire(hub.port);
    await wire.open();
    try {
      await wire.ask({ t: 'improve:get' });
      await wire.ask({ t: 'improve:seen' });
      await wire.ask({ t: 'improve:config', patch: { perDay: 3 } });
      const usage = hub.autonomy.improve.store.usage();
      const names = Object.keys(usage.counts);
      return ok('names and counts, nothing else',
        usage.counts['ui:improve:get'] === 1 && usage.counts['ui:improve:seen'] === 1
        && usage.counts['ui:improve:config'] === 1
        && names.every((n) => /^(ui|mcp):/.test(n))
        && !names.some((n) => n.includes('/') || n.length > 70),
        names.join(', '));
    } finally { wire.close(); }
  })),

  test('report_improvements reaches the board through the hub\'s own MCP endpoint', () => withHub(async (hub) => {
    const res = await fetch(`http://127.0.0.1:${hub.port}/mcp?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'report_improvements', arguments: { review_id: 'rev_http', proposals: [DRAFT] } },
      }),
    });
    const body = await res.json() as { result?: { content: { text: string }[] } };
    const state = hub.autonomy.improve.store.state();
    const filed = Object.values(state.proposals)[0];
    // Y la llamada se cuenta en la telemetría por su nombre, que es la otra
    // mitad de «cómo se usa CAPCOM».
    const counted = state.usage.counts['mcp:report_improvements'];
    return ok('the tool is published, runs, and is counted',
      res.status === 200 && !!body.result && filed?.key === 'queue-order' && counted === 1,
      body.result?.content[0]?.text.slice(0, 80));
  })),
];

export default { suite: 'AUTOMEJORA · hub', tests } satisfies TestModule;
