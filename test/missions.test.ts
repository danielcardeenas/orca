import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { MissionStore } from '../src/hub/missions.ts';
import { MISSION_ID_PREFIX, missionDebt, missionGlimpse, missionLeadOf, missionPrompt, visibleMissions } from '../src/shared/missions.ts';
import { newId } from '../src/shared/protocol.ts';
import type { Agent } from '../src/shared/types.ts';
import { startHub } from '../src/hub/server.ts';
import { HubStore } from '../src/hub/persist.ts';
import { FleetStore } from '../src/hub/fleets.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { createAuth } from '../src/hub/auth.ts';
import { hubContext } from '../src/agents/context.ts';
import { freshCapcomCheckpoint } from '../src/hub/capcom-checkpoint.ts';
import { runTool } from '../src/agents/tools.ts';
import { test, ok, until } from './harness.ts';

function temporary(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-tasks-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
export default { suite: 'Mission conversations', tests: [
  test('la mirilla trae la línea que provocó el prompt y la respuesta que vino después', () => {
    const mission = {
      id: 'mission_1', title: 'T', status: 'active' as const, createdAt: 0, updatedAt: 0, agentIds: [], messages: [
        { id: 'a', role: 'human' as const, text: 'lo primero', at: 1_000 },
        { id: 'b', role: 'capcom' as const, text: 'contestado', at: 2_000 },
        { id: 'c', role: 'human' as const, text: 'lo segundo', at: 3_000 },
      ],
    };
    // El prompt del segundo llega al transcript un poco después de guardarse.
    const second = missionGlimpse(mission, 3_400);
    // El del primero no puede arrastrar la línea que aún no existía.
    const first = missionGlimpse(mission, 1_200);
    // Sin respuesta todavía: la mirilla enseña la pregunta y calla el resto.
    const pending = missionGlimpse({ ...mission, messages: mission.messages.slice(0, 1) }, 1_200);
    // Al prompt lo provoca a veces un worker, no tú: esa línea también explica.
    const reported = missionGlimpse({ ...mission, messages: [
      { id: 'z', role: 'agent' as const, text: 'terminado', at: 5_000, agentId: 'k9' },
    ] }, 5_200);
    return ok('glimpses',
      second.said?.text === 'lo segundo' && second.back === undefined
      && first.said?.text === 'lo primero' && first.back?.text === 'contestado'
      && pending.said?.text === 'lo primero' && pending.back === undefined
      && reported.said?.text === 'terminado',
      `${second.said?.text} / ${first.said?.text} → ${first.back?.text} / ${reported.said?.text}`);
  }),

  /*
   * El concepto se llamó «task» hasta hoy, y su estado está en disco: ids
   * `task_`, un `tasks.json` y el título marcador «New task». Nada de eso se
   * puede invalidar por un cambio de vocabulario — invalidarlo no renombra las
   * conversaciones del operador, las borra de la vista.
   */
  test('a mission saved before the rename keeps its id, its conversation and its slot', () => {
    temporary((dir) => {
      // Lo que había en disco: el fichero viejo, con un id viejo dentro.
      writeFileSync(join(dir, 'tasks.json'), JSON.stringify({
        task_old: { id: 'task_old', title: 'New task', status: 'active', createdAt: 1, updatedAt: 1, agentIds: ['w1'], messages: [
          { id: 'm1', role: 'capcom', text: 'Launched W1', at: 1 },
        ] },
      }));

      const s = new MissionStore(dir);
      assert.equal(s.get('task_old').messages.length, 1);
      assert.deepEqual(visibleMissions(s.all()).map((m) => m.id), ['task_old']);
      // Y el prompt que llega a CAPCOM la nombra con el vocabulario de hoy.
      assert.match(missionPrompt(s.get('task_old')), /^\[ORCA MISSION task_old\]/);

      // Un mensaje del operador le pone nombre: el marcador viejo cuenta como
      // marcador, o la misión se quedaría llamándose «New task» para siempre.
      assert.equal(s.message('task_old', 'human', 'Arreglar el webhook').title, 'Arreglar el webhook');

      // La escritura migra el fichero sin llevarse el viejo por delante.
      assert.ok(existsSync(join(dir, 'missions.json')));
      assert.ok(existsSync(join(dir, 'tasks.json')));

      // Lo que nace hoy nace con el prefijo de hoy, nunca con el viejo.
      const fresh = s.create(newId(MISSION_ID_PREFIX), 'Nueva');
      assert.ok(fresh.id.startsWith('mission_'));
      assert.throws(() => s.create('nope_1', 'x'), /Invalid mission id/);

      // Y al reabrir, el store lee el fichero nuevo con las dos dentro.
      const again = new MissionStore(dir);
      assert.deepEqual(Object.keys(again.all()).sort(), [fresh.id, 'task_old'].sort());
    });
    return ok('pre-rename state survives: id, conversation, title and file', true);
  }),

  test('mission history and agent ownership survive restart independently', () => {
    temporary((dir) => {
      const s = new MissionStore(dir);
      s.create('task_a', 'New task'); s.create('task_b', 'New task');
      s.message('task_a', 'human', 'Review delivery'); s.assign('task_a', ['worker']);
      s.message('task_b', 'human', 'Review navigation');
      s.message('task_a', 'capcom', 'Delivery reviewed', 'completed');
      const restored = new MissionStore(dir);
      assert.equal(restored.get('task_a').status, 'completed');
      assert.deepEqual(restored.get('task_a').agentIds, ['worker']);
      assert.equal(restored.get('task_b').messages.length, 1);
      assert(!missionPrompt(restored.get('task_b')).includes('Delivery reviewed'));
      assert.equal(restored.get('task_a').title, 'Review delivery');
    });
    return ok('persistent independent conversations', true);
  }),
  test('archiving retires a mission reversibly, frees its slot, and purging needs it archived first', () => {
    temporary((dir) => {
      const s = new MissionStore(dir);
      s.create('task_a', 'Ship the console'); s.message('task_a', 'human', 'Ship the console', 'completed');
      s.create('task_b', 'Still running');
      // Hasta aquí una tarea creada no salía nunca de la vista, y a las cien el
      // hub dejaba de poder crear.
      assert.throws(() => s.purge('task_a'), /Archive the mission before purging/);
      const archived = s.archive('task_a');
      assert.ok(archived.archivedAt && archived.messages.length === 1);
      assert.deepEqual(visibleMissions(s.all()).map((t) => t.id), ['task_b']);
      assert.equal(new MissionStore(dir).get('task_a').archivedAt, archived.archivedAt);
      assert.ok(!s.archive('task_a', false).archivedAt, 'restoring brings it back whole');
      assert.equal(s.get('task_a').messages[0]!.text, 'Ship the console');

      // El tope cuenta lo que está a la vista: cien archivadas no bloquean.
      s.archive('task_a');
      for (let i = 0; i < 99; i++) s.create(`task_f${i}`, `Filler ${i}`);
      assert.throws(() => s.create('task_over', 'One too many'), /Mission limit reached/);
      s.archive('task_f0');
      assert.equal(s.create('task_over', 'Now there is room').id, 'task_over');

      const purged: string[] = [];
      const watched = new MissionStore(dir, (t) => { if ((t as { purged?: true }).purged) purged.push(t.id); });
      watched.purge('task_a');
      assert.throws(() => watched.get('task_a'), /Unknown mission/);
      assert.throws(() => new MissionStore(dir).get('task_a'), /Unknown mission/);
      assert.deepEqual(purged, ['task_a']);
      assert.equal(watched.get('task_b').title, 'Still running', 'purging one leaves the rest');
    });
    return ok('archive is reversible and frees the slot; purge is deliberate and permanent', true);
  }),
  test('an archived task stops being work: no listing, no checkpoint, no waking CAPCOM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-tasks-'));
    try {
      const s = new MissionStore(dir);
      s.create('task_a', 'Retired work'); s.message('task_a', 'human', 'Retired work');
      s.assign('task_a', ['w1']);
      s.create('task_b', 'Live work'); s.message('task_b', 'human', 'Live work');
      s.archive('task_a');
      const listed = await runTool({ missions: s } as unknown as Parameters<typeof runTool>[0], 'list_missions', {});
      const rows = (JSON.parse(listed.result) as { missions: { id: string }[] }).missions;
      assert.deepEqual(rows.map((t) => t.id), ['task_b']);
      const checkpoint = freshCapcomCheckpoint({ missions: s.all(), escalations: {}, agents: {} } as never, []);
      assert.ok(!checkpoint.includes('task_a') && checkpoint.includes('task_b'));
      // `observe` es lo que trae resultados nuevos de los workers a la tarea.
      const worker = { id: 'w1', state: 'done', lastSay: 'finished the retired work', updatedAt: Date.now(), startedAt: Date.now() } as Agent;
      s.observe({ w1: worker });
      assert.equal(s.get('task_a').messages.length, 1, 'a retired task does not collect new results');
      return ok('archived missions leave the listing, the checkpoint and CAPCOM alone', true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),
  test('lineage and delayed squads collect results once without claiming completion', () => {
    temporary((dir) => {
      const s = new MissionStore(dir); s.create('task_a', 'A'); s.create('task_b', 'B');
      s.assign('task_a', ['root']); s.bindSquad('task_a', 'team-01');
      assert.throws(() => s.assign('task_b', ['root']));
      const now = Date.now();
      const agents = Object.fromEntries([
        { id: 'root', state: 'working', lastSay: 'Still working' },
        { id: 'child', parentId: 'root', state: 'idle', lastSay: 'Hello' },
        { id: 'late', squad: 'team-01', state: 'done', lastSay: 'World' },
      ].map((a) => [a.id, { ...a, startedAt: now, updatedAt: now } as unknown as Agent]));
      s.observe(agents); s.observe(agents);
      const task = s.get('task_a');
      assert.deepEqual(task.agentIds, ['root', 'child', 'late']);
      assert.deepEqual(task.messages.map((m) => m.text), ['Hello', 'World']);
      assert.equal(task.status, 'active');
      assert.equal(s.get('task_b').messages.length, 0);
    });
    return ok('results follow ownership and deduplicate', true);
  }),
  test('a squad member under a live lead does not write into the mission; the lead does, and so does an orphan', () => {
    temporary((dir) => {
      const s = new MissionStore(dir); s.create('mission_l', 'Led');
      s.bindSquad('mission_l', 'team-01');
      const now = Date.now();
      const base = (a: Record<string, unknown>) => ({ startedAt: now, updatedAt: now, ...a }) as unknown as Agent;
      const lead = base({ id: 'lead', squad: 'team-01', lead: true, state: 'idle', lastSay: 'Consolidated: all green' });
      const member = base({ id: 'mem', squad: 'team-01', state: 'done', lastSay: 'My part is done' });
      s.observe({ lead, mem: member });
      const led = s.get('mission_l');
      assert.deepEqual(led.agentIds.sort(), ['lead', 'mem'], 'both are crew');
      assert.deepEqual(led.messages.map((m) => m.text), ['Consolidated: all green'], 'only the lead speaks into the mission');
      // El líder muere: el miembro vuelve a hablarle a la misión, que es lo único que queda.
      s.observe({ lead: { ...lead, state: 'dead' } as Agent, mem: { ...member, lastSay: 'Finishing alone' } as Agent });
      assert.deepEqual(s.get('mission_l').messages.map((m) => m.text), ['Consolidated: all green', 'Finishing alone']);
    });
    return ok('members report to the lead, not to the mission', true);
  }),
  test('a line to the lead is not CAPCOM debt, and the lead is found by the same rule everywhere', () => {
    const now = Date.now();
    const mission = {
      id: 'mission_x', title: 'X', status: 'active' as const, createdAt: 0, updatedAt: 0, agentIds: ['lead', 'mem'], squads: ['team-01'],
      messages: [
        { id: 'a', role: 'human' as const, text: 'go', at: 1_000 },
        { id: 'b', role: 'capcom' as const, text: 'launched', at: 2_000 },
        { id: 'c', role: 'human' as const, text: 'lead, also do the footer', at: 3_000, to: 'lead' },
        { id: 'd', role: 'human' as const, text: 'capcom, status?', at: 4_000 },
      ],
    };
    const debt = missionDebt(mission);
    const agents: Record<string, Agent> = {
      lead: { id: 'lead', role: 'agent', lead: true, squad: 'team-01', state: 'working', updatedAt: now } as Agent,
      mem: { id: 'mem', role: 'agent', lead: false, squad: 'team-01', state: 'working', updatedAt: now } as Agent,
      old: { id: 'old', role: 'agent', lead: true, squad: 'team-01', state: 'done', updatedAt: now - 1 } as Agent,
      cap: { id: 'cap', role: 'capcom', lead: true, squad: 'team-01', state: 'working', updatedAt: now } as Agent,
    };
    const byMission = missionLeadOf(mission, (id) => agents[id], Object.values(agents));
    const bySquad = missionLeadOf({ ...mission, agentIds: [] }, (id) => agents[id], Object.values(agents));
    const gone = missionLeadOf({ ...mission, agentIds: ['old'] }, (id) => agents[id], []);
    return ok('debt skips lines addressed to the lead; lead by assignment, by squad, live before ended, never CAPCOM',
      debt.humans.map((m) => m.id).join() === 'd'
      && byMission?.agent.id === 'lead' && byMission.via === 'mission' && byMission.live
      && bySquad?.agent.id === 'lead' && bySquad.via === 'squad'
      && gone?.agent.id === 'old' && !gone.live,
      `${debt.humans.map((m) => m.id).join()} / ${byMission?.agent.id} / ${bySquad?.agent.id} / ${gone?.agent.id}`);
  }),
  test('WebSocket creation, routing, late replies and reconnect preserve the right mission', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-task-wire-'));
    const token = 'orca-task-test-token'; const prompts: string[] = [];
    const hub = await startHub({ port: 0, host: '127.0.0.1', quiet: true,
      auth: createAuth({ ORCA_TOKEN: token } as NodeJS.ProcessEnv), store: new HubStore({ dir }),
      memory: new AnswerMemory(join(dir, 'memory.jsonl')), fleets: new FleetStore(join(dir, 'fleets')),
      onUnrouted: (text) => { prompts.push(text); },
    });
    const sockets: WebSocket[] = [];
    try {
      const frames: any[] = [];
      const connect = async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws/console?token=${token}`); sockets.push(ws);
        ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
        await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); }); return ws;
      };
      const ws = await connect();
      for (const id of ['a', 'b']) ws.send(JSON.stringify({ t: 'mission:create', id: `create_${id}`, missionId: `task_${id}`, title: 'New task' }));
      assert(await until(() => frames.some((f) => f.cmdId === 'create_b'), 2000));
      for (const id of ['a', 'b']) ws.send(JSON.stringify({ t: 'ceo:say', id: `say_${id}`, missionId: `task_${id}`, text: `Request ${id}` }));
      assert(await until(() => prompts.length === 2, 2000));
      assert(prompts[1]!.includes('Request b')); assert(!prompts[1]!.includes('Request a'));
      const reply = await runTool(hubContext(hub), 'report_mission', { mission_id: 'task_a', text: 'A completed late', status: 'completed', agent_ids: [] });
      assert(!reply.isError);
      assert.equal(hub.missions.get('task_b').messages.length, 1);
      const invalid = await runTool(hubContext(hub), 'report_mission', { mission_id: 'task_missing', text: 'Wrong', status: 'completed', agent_ids: [] });
      assert(invalid.isError);
      frames.length = 0; await connect();
      assert(await until(() => frames.some((f) => f.t === 'world'), 2000));
      const snapshot = frames.find((f) => f.t === 'world');
      assert.equal(snapshot.state.missions.task_a.messages.at(-1).text, 'A completed late');
      assert.equal(snapshot.state.missions.task_b.messages[0].text, 'Request b');
      hub.missions.assign('task_b', ['worker']);
      const now = Date.now();
      hub.missions.observe({ worker: { id: 'worker', state: 'done', lastSay: 'Worker finished', startedAt: now, updatedAt: now } as unknown as Agent });
      assert(await until(() => prompts.length === 3, 2000));
      assert(prompts[2]!.includes('[ORCA MISSION task_b]')); assert(prompts[2]!.includes('Worker finished'));

      // Escribir en una misión COMPLETED desde su ventana la reabre. Sin líder
      // en pie la línea va a CAPCOM, y el ack dice a quién fue.
      assert.equal(hub.missions.get('task_a').status, 'completed');
      frames.length = 0;
      ws.send(JSON.stringify({ t: 'mission:say', id: 'say_more', missionId: 'task_a', text: 'One more thing for A' }));
      assert(await until(() => frames.some((f) => f.cmdId === 'say_more'), 2000));
      const more = frames.find((f) => f.cmdId === 'say_more');
      assert.equal(more.ok, true); assert.equal(more.data?.to, 'capcom');
      assert.equal(hub.missions.get('task_a').status, 'active', 'asking for more work reopens the mission');
      assert.equal(hub.missions.get('task_a').messages.at(-1)!.text, 'One more thing for A');
      assert(await until(() => prompts.length === 4, 2000));
      assert(prompts[3]!.includes('One more thing for A'));

      // Retirar y borrar por el mismo camino que usa la consola.
      frames.length = 0;
      ws.send(JSON.stringify({ t: 'mission:purge', id: 'purge_early', missionId: 'task_a' }));
      assert(await until(() => frames.some((f) => f.cmdId === 'purge_early'), 2000));
      const refused = frames.find((f) => f.cmdId === 'purge_early');
      assert.equal(refused.ok, false); assert.match(String(refused.detail), /Archive the mission before purging/);
      ws.send(JSON.stringify({ t: 'mission:archive', id: 'arch_a', missionId: 'task_a' }));
      assert(await until(() => frames.some((f) => f.t === 'mission' && f.mission.id === 'task_a' && f.mission.archivedAt), 2000));
      ws.send(JSON.stringify({ t: 'mission:purge', id: 'purge_a', missionId: 'task_a' }));
      assert(await until(() => frames.some((f) => f.t === 'mission' && f.mission.id === 'task_a' && f.purged === true), 2000));
      assert.throws(() => hub.missions.get('task_a'), /Unknown mission/);
      frames.length = 0; await connect();
      assert(await until(() => frames.some((f) => f.t === 'world'), 2000));
      const after = frames.find((f) => f.t === 'world');
      assert.equal(after.state.missions.task_a, undefined, 'a purged task is gone from the snapshot too');
      assert.equal(after.state.missions.task_b.messages[0].text, 'Request b');
      return ok('routing, explicit replies, reconnect, worker notification, archive and purge over the wire', true);
    } finally {
      sockets.forEach((s) => s.close()); await hub.close(); rmSync(dir, { recursive: true, force: true });
    }
  }),
] };
