/**
 * hud/mission-status.ts — what the mission panel says about each mission.
 *
 * Worth guarding: the phase rule (alive crew beats CAPCOM's last word; the
 * hub's completed/failed beats both), the order (open first, crew next, then
 * by what was last said — nunca por un latido), the fold (the newest N finished stay visible), and the
 * title (the hub's, or the first thing the human said, cut on a space).
 */

import { MISSION_STALL_GRACE_MS, missionStall, type CapcomMission, type MissionMessage, type MissionStatus } from '../src/shared/missions.ts';
import type { Agent, AgentState } from '../src/shared/types.ts';
import { isOpen, liveCrew, railSplit, missionArchiveAsk, missionPhase, missionRows, missionTitle } from '../src/ui/hud/mission-status.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const T0 = 1_800_000_000_000;

function agent(id: string, state: AgentState, extra: Partial<Agent> = {}): Agent {
  return { id, callsign: id.toUpperCase(), state, role: 'worker', updatedAt: T0, startedAt: T0 - 1000, ...extra } as Agent;
}

function msg(role: MissionMessage['role'], text: string, at = T0, agentId?: string): MissionMessage {
  return { id: `m_${at}_${role}`, role, text, at, ...(agentId ? { agentId } : {}) };
}

function task(id: string, o: { status?: MissionStatus; title?: string; agentIds?: string[]; messages?: MissionMessage[]; updatedAt?: number; createdAt?: number } = {}): CapcomMission {
  return {
    id, title: o.title ?? 'New task', status: o.status ?? 'active',
    createdAt: o.createdAt ?? T0 - 10_000, updatedAt: o.updatedAt ?? T0, agentIds: o.agentIds ?? [], messages: o.messages ?? [],
  };
}

const FLEET: Record<string, Agent> = {
  a1: agent('a1', 'working', { updatedAt: T0 + 5_000 }),
  a2: agent('a2', 'blocked'),
  a3: agent('a3', 'done'),
  a4: agent('a4', 'dead'),
  cap: agent('cap', 'idle', { role: 'capcom', callsign: 'CAPCOM' }),
};
const agentOf = (id: string) => FLEET[id];

const mod: TestModule = {
  suite: 'mission-status',
  tests: [
    test('liveCrew: assigned and alive, in assignment order; the dead, the done, the unknown and CAPCOM are not crew', () => {
      const t = task('t', { agentIds: ['a3', 'a2', 'ghost', 'cap', 'a1', 'a4'] });
      return eq('crew', liveCrew(t, agentOf).map((a) => a.id), ['a2', 'a1']);
    }),
    test('missionPhase: nobody has taken it → queued', () => {
      const t = task('t', { messages: [msg('human', 'Fix the login flow')] });
      return eq('phase', missionPhase(t, liveCrew(t, agentOf)), 'queued');
    }),
    test('missionPhase: no messages at all is still queued', () => {
      return eq('phase', missionPhase(task('t'), []), 'queued');
    }),
    test('missionPhase: CAPCOM had the last word and nobody is running → waiting on you', () => {
      const t = task('t', { messages: [msg('human', 'Fix it', T0), msg('capcom', 'Which branch?', T0 + 1)] });
      return eq('phase', missionPhase(t, liveCrew(t, agentOf)), 'waiting');
    }),
    /*
     * Lo que el operador vio el 2026-09-09: `alive` cuenta un idle, así que una
     * misión cuyo agente nunca recibió su encargo decía IN PROGRESS. El parón
     * gana a la tripulación viva, y la fila sigue abierta: sólo cambia lo que
     * dice, no dónde está.
     */
    test('missionPhase: un agente vivo pero parado ya no dice IN PROGRESS → not moving', () => {
      const t = {
        ...task('t', { agentIds: ['a5'], messages: [msg('human', 'Fix it', T0), msg('capcom', 'Sent to A5', T0 + 1)] }),
        dispatches: { a5: { agentId: 'a5', callsign: 'A5', at: T0 + 2, delivered: true } },
      };
      const quiet: Record<string, Agent> = { a5: agent('a5', 'idle', { updatedAt: T0 }) };
      const of = (id: string) => quiet[id];
      const late = T0 + 2 + MISSION_STALL_GRACE_MS + 1;
      const stall = missionStall(t, of, late);
      const row = missionRows([t], of, late)[0];
      return ok('la fase lo dice y la fila no se mueve de sitio',
        missionPhase(t, liveCrew(t, of), stall) === 'stalled'
        && missionPhase(t, liveCrew(t, of), null) === 'progress'
        && row?.phase === 'stalled' && isOpen(row.phase),
        `${row?.phase} · ${stall?.reason}`);
    }),

    test('missionPhase: a live assigned agent beats CAPCOM\'s last word → in progress', () => {
      const t = task('t', { agentIds: ['a1'], messages: [msg('human', 'Fix it', T0), msg('capcom', 'Launched A1, will report back', T0 + 1)] });
      return eq('phase', missionPhase(t, liveCrew(t, agentOf)), 'progress');
    }),
    test('missionPhase: assigned agents that finished are not progress; the last word decides again', () => {
      const wait = task('w', { agentIds: ['a3', 'a4'], messages: [msg('human', 'Go', T0), msg('capcom', 'Done? Check the diff and tell me', T0 + 1)] });
      const queued = task('q', { agentIds: ['a3'], messages: [msg('human', 'Go', T0), msg('agent', 'Finished the diff', T0 + 1, 'a3')] });
      const a = missionPhase(wait, liveCrew(wait, agentOf)), b = missionPhase(queued, liveCrew(queued, agentOf));
      return ok('phases', a === 'waiting' && b === 'queued', `${a} ${b}`);
    }),
    test('missionPhase: a human reply after CAPCOM, nobody running → queued again', () => {
      const t = task('t', { messages: [msg('capcom', 'Which branch?', T0), msg('human', 'main', T0 + 1)] });
      return eq('phase', missionPhase(t, []), 'queued');
    }),
    test('missionPhase: a system line (delivery failed) is not CAPCOM speaking → queued', () => {
      const t = task('t', { messages: [msg('human', 'Go', T0), msg('system', 'Delivery failed: no CAPCOM', T0 + 1)] });
      return eq('phase', missionPhase(t, []), 'queued');
    }),
    test('missionPhase: the hub\'s completed and failed win over everything, live crew included', () => {
      const done = task('d', { status: 'completed', agentIds: ['a1'], messages: [msg('capcom', 'Anything else?')] });
      const fail = task('f', { status: 'failed', agentIds: ['a2'] });
      const a = missionPhase(done, liveCrew(done, agentOf)), b = missionPhase(fail, liveCrew(fail, agentOf));
      return ok('phases', a === 'completed' && b === 'failed', `${a} ${b}`);
    }),
    test('missionTitle: the hub\'s title, else the first human line, else NEW TASK', () => {
      const own = missionTitle(task('a', { title: 'Ship the checkout', messages: [msg('human', 'something else')] }));
      const first = missionTitle(task('b', { messages: [msg('capcom', 'hi'), msg('human', '  Fix   the\nlogin  ')] }));
      const none = missionTitle(task('c'));
      return eq('titles', [own, first, none], ['Ship the checkout', 'Fix the login', 'NEW MISSION']);
    }),
    test('missionTitle: long titles cut on a space and end in an ellipsis', () => {
      const t = missionTitle(task('a', { title: 'Rewrite the payment webhook handler so retries are idempotent' }), 40);
      return ok('cut', t.length <= 41 && t.endsWith('…') && !t.endsWith(' …') && t.startsWith('Rewrite the payment webhook'), t);
    }),
    test('at: la movida de la misión, no el latido de sus agentes', () => {
      // A1 late a T0+5000 mientras la misión lleva quieta desde T0+1000. El
      // «hace cuánto» cuenta desde lo último que se dijo: si contara desde el
      // latido pondría «0S» para siempre y no diría ni cuándo se movió ni que
      // lleva rato sin devolver una palabra.
      const busy = task('t', { agentIds: ['a1', 'a2'], updatedAt: T0 + 1_000 });
      const quiet = task('i', { agentIds: ['a2'], updatedAt: T0 + 9_000 });
      const at = missionRows([busy, quiet], agentOf).map((r) => r.at);
      return eq('at', at.sort(), [T0 + 1_000, T0 + 9_000]);
    }),
    test('missionRows: open first, crew next, then by what was last said; crew as callsigns', () => {
      const rows = missionRows([
        task('old-open', { messages: [msg('human', 'a')], updatedAt: T0 - 50_000 }),
        task('done-new', { status: 'completed', updatedAt: T0 + 90_000 }),
        task('busy', { agentIds: ['a1', 'a2'], updatedAt: T0 - 90_000 }),
        task('failed-old', { status: 'failed', updatedAt: T0 - 500_000 }),
        task('waiting', { messages: [msg('capcom', '?')], updatedAt: T0 + 10_000 }),
      ], agentOf);
      const order = rows.map((r) => `${r.id}:${r.phase}`);
      const crew = rows.find((r) => r.id === 'busy')!.crew.map((c) => c.callsign);
      return eq('order', [order, crew], [
        ['busy:progress', 'waiting:waiting', 'old-open:queued', 'done-new:completed', 'failed-old:failed'],
        ['A1', 'A2'],
      ], 'busy carries a live crew, so it leads the open group whatever it last said');
    }),
    test('missionRows: un latido de la flota no reordena el panel', () => {
      // Dos misiones con gente encima. Antes ordenaba `movedAt`, que sube con
      // el `updatedAt` de cada agente vivo: el colector tocaba a A1 y las dos
      // filas se cambiaban el sitio bajo el cursor sin que nadie dijera nada.
      const missions = [
        task('first', { agentIds: ['a2'], updatedAt: T0 + 1_000 }),
        task('second', { agentIds: ['a1'], updatedAt: T0 }),
      ];
      const before = missionRows(missions, agentOf);
      const beat: Record<string, Agent> = { ...FLEET, a1: agent('a1', 'working', { updatedAt: T0 + 900_000 }) };
      const after = missionRows(missions, (id) => beat[id]);
      return eq('order / at', [before.map((r) => r.id), after.map((r) => r.id), after.map((r) => r.at)],
        [['first', 'second'], ['first', 'second'], [T0 + 1_000, T0]],
        'ni el orden ni el «hace cuánto» se mueven con un latido');
    }),
    test('missionRows: lo abierto va primero y lo terminado detrás, todo a la vista', () => {
      // El panel ya no pliega nada: la lista es la lista, y lo único que se
      // pliega es el panel entero desde su título. Lo que sí decide el orden.
      const rows = missionRows([
        task('o1', { updatedAt: T0 }),
        task('o2', { updatedAt: T0 + 1 }),
        ...[1, 2, 3, 4, 5].map((i) => task(`d${i}`, { status: i % 2 ? 'completed' : 'failed', updatedAt: T0 + i })),
      ], agentOf);
      return eq('order', rows.map((r) => r.id),
        ['o2', 'o1', 'd5', 'd4', 'd3', 'd2', 'd1']);
    }),
    test('railSplit: the rail keeps the order it was opened in, whatever the fleet does', () => {
      // b se mueve el último y a sigue trabajando: el panel del HUD los
      // reordenaría, la cinta no. Una pestaña que se mueve sola se pulsa mal.
      const rows = missionRows([
        task('b', { title: 'B', createdAt: T0 - 5_000, updatedAt: T0 + 9_000 }),
        task('a', { title: 'A', createdAt: T0 - 9_000, agentIds: ['a1'] }),
        task('c', { title: 'C', createdAt: T0 - 1_000 }),
      ], agentOf);
      const r = railSplit(rows, null);
      return eq('strip', r.strip.map((x) => x.id), ['a', 'b', 'c']);
    }),

    /*
     * Se archiva desde dos sitios —la ventana de la misión y la fila abierta
     * del panel— y los dos leen esta frase. Si cada uno redactara la suya,
     * archivar desde el panel prometería otra cosa que archivar desde dentro,
     * y el operador sólo habría leído una de las dos.
     */
    test('missionArchiveAsk: una viva pregunta, y con su nombre; una terminada no pregunta nada', () => {
      const live = missionArchiveAsk(task('t', { title: 'Sacar el dinero de la consola' }));
      const done = missionArchiveAsk(task('t', { title: 'T', status: 'completed' }));
      const failed = missionArchiveAsk(task('t', { title: 'T', status: 'failed' }));
      return ok('ask',
        live !== null && live.includes('Sacar el dinero de la consola')
        && live.includes('sigue activa') && live.includes('se conservan')
        && done === null && failed === null,
        `${JSON.stringify(live)} / ${done} / ${failed}`);
    }),

    test('railSplit: lo terminado se pliega, salvo la conversación abierta', () => {
      const rows = missionRows([
        task('live', { title: 'LIVE' }),
        task('done', { title: 'DONE', status: 'completed' }),
        task('gone', { title: 'GONE', status: 'failed', updatedAt: T0 - 1 }),
      ], agentOf);
      const shut = railSplit(rows, null);
      const open = railSplit(rows, 'gone');
      return eq('strip / folded', [
        shut.strip.map((x) => x.id), shut.folded.map((x) => x.id),
        open.strip.map((x) => x.id), open.folded.map((x) => x.id),
      ], [['live'], ['done', 'gone'], ['gone', 'live'], ['done']]);
    }),
  ],
};

export default mod;
