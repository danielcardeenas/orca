/**
 * Una flota en dos máquinas.
 *
 * Un hub, un collector por Mac, y el mismo repositorio clonado en los dos. Lo
 * que hay que probar es que CAPCOM puede repartir trabajo entre ellos sin
 * nombrarlos: que el survey enseña las máquinas y su carga, que un código que
 * casa con dos clones cae en el menos cargado, que `machine` lo fija, y que
 * una ruta que el hub no conoce se registra en la máquina que la tiene y no
 * en la que no. Y lo contrario: con una sola máquina nada cambia, ni el
 * resumen que lee el operador.
 *
 * Todo en caja: un `CeoContext` con máquinas, proyectos y agentes de
 * mentira, y un `dispatch` que apunta a dónde fue cada comando.
 */

import type { Agent, Machine, Project } from '../src/shared/types.ts';
import type { Command } from '../src/shared/protocol.ts';
import { runTool, type CeoContext } from '../src/agents/tools.ts';
import { ok, eq, test, type TestModule } from './harness.ts';

const NOW = Date.now();
const MISSION = 'Audit the dependency manifest and report what is unused or behind, without upgrading anything.';

function machine(id: string, over: Partial<Machine> = {}): Machine {
  return {
    id, hostname: `${id}.local`, platform: 'darwin', version: '0.1.0', online: true,
    lastSeen: NOW, connectedAt: NOW,
    load: { sessions: 0, activeSessions: 0, cpuPct: null, memPct: null },
    ...over,
  };
}

/** El mismo repo en una máquina: el id lleva la máquina, el código no. */
function clone(machineId: string, over: Partial<Project> = {}): Project {
  return {
    id: `${machineId}/-Users-dan-projects-ax`, machineId, slug: '-Users-dan-projects-ax',
    name: 'ax', path: '/Users/dan/projects/ax', code: 'AX',
    gitBranch: 'main', gitDirty: false, keyNames: [], sessionIds: [],
    rollup: {
      total: 1, blocked: 0, costUSD: 0, tokensPerSec: 0,
      byState: { booting: 0, thinking: 0, working: 1, blocked: 0, idle: 0, done: 0, dead: 0 },
    },
    ...over,
  };
}

function agent(id: string, machineId: string, over: Partial<Agent> = {}): Agent {
  return {
    id, machineId, projectId: `${machineId}/-Users-dan-projects-ax`,
    title: 'test', callsign: id.toUpperCase(), runtime: 'claude', state: 'working', block: null,
    parentId: null, depth: 0, childIds: [], mission: null,
    squad: null, lead: false,
    model: null, tool: null, toolDetail: null,
    lastPrompt: null, lastSay: null, startedAt: NOW, updatedAt: NOW, uptimeMs: 0,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
      tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0,
      toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    background: false, shortId: null,
    ...over,
  };
}

interface Box {
  ctx: CeoContext;
  /** Cada comando despachado, con la máquina a la que fue. */
  sent: { machineId: string; cmd: Command }[];
}

/**
 * Un mundo en caja. `disks` dice qué carpetas tiene cada máquina: es lo que
 * el collector de verdad mira al registrar una ruta, y aquí lo imita el
 * dispatch — registra si la tiene, rechaza si no.
 */
function box(o: {
  machines: Machine[]; projects?: Project[]; agents?: Agent[]; disks?: Record<string, string[]>;
}): Box {
  const projects = [...(o.projects ?? [])];
  const agents = o.agents ?? [];
  const sent: Box['sent'] = [];
  const refuse = (): never => { throw new Error('not in this test'); };
  let n = 0;
  const ctx: CeoContext = {
    machines: () => o.machines,
    agents: () => agents,
    projects: () => projects,
    agent: (id) => agents.find((a) => a.id === id),
    project: (id) => projects.find((p) => p.id === id),
    escalation: () => undefined,
    dispatch: async (machineId, cmd) => {
      sent.push({ machineId, cmd });
      if (cmd.k === 'project:register') {
        if (!(o.disks?.[machineId] ?? []).includes(cmd.path)) throw new Error(`no existe o no es un directorio: ${cmd.path}`);
        const slug = cmd.path.replace(/\//g, '-');
        const id = `${machineId}/${slug}`;
        if (!projects.some((p) => p.id === id)) {
          projects.push(clone(machineId, { id, slug, path: cmd.path, name: cmd.path.split('/').pop()!, code: 'TH', rollup: { ...clone(machineId).rollup, total: 0 } }));
        }
        return { projectId: id };
      }
      if (cmd.k === 'spawn') { n += 1; return { agentId: `spawned-${n}`, callsign: `S${n}`, shortId: null }; }
      return {};
    },
    nextSquadName: (base) => `${base}-01`, fleets: () => [],
    recall: () => [], remember: refuse, raiseToHuman: refuse, resolveEscalation: refuse,
    messages: () => [], message: () => undefined, collisions: () => [],
    relay: refuse, answerPeer: refuse, acknowledgeCollision: refuse, archiveAgents: refuse,
  };
  return { ctx, sent };
}

const spawnInput = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  project_id: 'AX', machine: null, mission: MISSION, parent_agent_id: null, background: true,
  squad: null, lead: false, runtime: null, model: null, mission_id: null, permission_mode: null,
  budget_tokens: null, budget_usd: null, budget_min: null, ...over,
});

function parse<T>(out: { result: string }): T { return JSON.parse(out.result) as T; }

/** Dos Macs con el mismo repo: `a` con dos workers vivos, `b` con uno terminado. */
function twoMacs(): Box {
  return box({
    machines: [machine('a'), machine('b')],
    projects: [clone('a'), clone('b')],
    agents: [agent('a1', 'a'), agent('a2', 'a'), agent('b1', 'b', { state: 'done' })],
    disks: { a: ['/Users/dan/projects/ax'], b: ['/Users/dan/projects/ax', '/Users/dan/projects/thing'] },
  });
}

const tests = [
  test('list_fleet shows every machine with its live agents, and which machine each project is on', async () => {
    const { ctx } = twoMacs();
    const out = parse<{
      machines: { id: string; name: string; live_agents: number; projects: string[] }[];
      projects: { code: string; machine: string }[];
    }>(await runTool(ctx, 'list_fleet', { only_blocked: false }));
    const a = out.machines.find((m) => m.id === 'a');
    const b = out.machines.find((m) => m.id === 'b');
    return ok(
      'list_fleet shows machines and their load',
      out.machines.length === 2 && a?.live_agents === 2 && b?.live_agents === 0
      && a?.name === 'a.local' && a.projects.includes('AX') && b?.projects.includes('AX')
      && out.projects.length === 2
      && out.projects.map((p) => p.machine).sort().join(',') === 'a.local,b.local',
      JSON.stringify(out.machines),
    );
  }),

  test('a code that names two clones spawns on the machine with fewer live agents', async () => {
    const { ctx, sent } = twoMacs();
    const out = await runTool(ctx, 'spawn_agent', spawnInput());
    const spawn = sent.find((s) => s.cmd.k === 'spawn');
    return ok(
      'the least busy clone gets the work',
      !out.isError && spawn?.machineId === 'b'
      && parse<{ machine: string }>(out).machine === 'b.local'
      && out.summary.includes('on AX on b.local'),
      `${out.summary} · dispatched to ${spawn?.machineId ?? 'nobody'}`,
    );
  }),

  test('`machine` pins the launch to that clone, by hostname or by id', async () => {
    const byHost = twoMacs();
    const byId = twoMacs();
    const short = twoMacs();
    const o1 = await runTool(byHost.ctx, 'spawn_agent', spawnInput({ machine: 'a.local' }));
    const o2 = await runTool(byId.ctx, 'spawn_agent', spawnInput({ machine: 'a' }));
    const o3 = await runTool(short.ctx, 'spawn_agent', spawnInput({ machine: 'A' }));
    const to = (b: Box): string => b.sent.find((s) => s.cmd.k === 'spawn')?.machineId ?? 'nobody';
    return ok(
      '`machine` pins the launch',
      !o1.isError && !o2.isError && !o3.isError && to(byHost) === 'a' && to(byId) === 'a' && to(short) === 'a',
      `${to(byHost)} · ${to(byId)} · ${to(short)}`,
    );
  }),

  test('an unknown machine is a readable refusal that lists the ones reporting', async () => {
    const { ctx, sent } = twoMacs();
    const out = await runTool(ctx, 'spawn_agent', spawnInput({ machine: 'mac-studio' }));
    return ok(
      'unknown machine refused with the list',
      out.isError === true && out.result.includes('mac-studio') && out.result.includes('a.local') && out.result.includes('b.local')
      && sent.length === 0,
      out.result,
    );
  }),

  test('a clone whose collector is gone never gets the launch, however idle it looks', async () => {
    const b = box({
      machines: [machine('a'), machine('b', { online: false })],
      projects: [clone('a'), clone('b')],
      agents: [agent('a1', 'a'), agent('a2', 'a')],
    });
    const out = await runTool(b.ctx, 'spawn_agent', spawnInput());
    const pinned = await runTool(b.ctx, 'spawn_agent', spawnInput({ machine: 'b' }));
    const to = b.sent.find((s) => s.cmd.k === 'spawn')?.machineId;
    return ok(
      'offline clones are skipped, and naming one is refused',
      !out.isError && to === 'a' && pinned.isError === true && pinned.result.includes('offline'),
      `${out.summary} · pinned: ${pinned.result}`,
    );
  }),

  test('a path nobody has on the map is registered on the machine that has it, not the one that does not', async () => {
    const { ctx, sent } = twoMacs();
    const out = await runTool(ctx, 'spawn_agent', spawnInput({ project_id: '/Users/dan/projects/thing' }));
    const registers = sent.filter((s) => s.cmd.k === 'project:register').map((s) => s.machineId).sort();
    const spawn = sent.find((s) => s.cmd.k === 'spawn');
    return ok(
      'the path is asked of every machine and lands on the one that has it',
      !out.isError && registers.join(',') === 'a,b' && spawn?.machineId === 'b'
      && ctx.projects().some((p) => p.id === 'b/-Users-dan-projects-thing')
      && !ctx.projects().some((p) => p.id === 'a/-Users-dan-projects-thing'),
      `registered on ${registers.join(',')} · spawned on ${spawn?.machineId ?? 'nobody'} · ${out.summary}`,
    );
  }),

  test('a path no machine has is refused with every machine\'s reason', async () => {
    const { ctx } = twoMacs();
    const out = await runTool(ctx, 'register_project', { path: '/Users/dan/projects/nowhere', machine: null });
    return ok(
      'no machine has it: refused with reasons',
      out.isError === true && out.result.includes('a.local:') && out.result.includes('b.local:')
      && out.result.includes('nowhere'),
      out.result,
    );
  }),

  test('register_project names the machine it landed on', async () => {
    const { ctx } = twoMacs();
    const out = await runTool(ctx, 'register_project', { path: '/Users/dan/projects/thing', machine: 'b.local' });
    const r = parse<{ machine: string; machine_id: string; code: string }>(out);
    return ok(
      'register_project says where',
      !out.isError && r.machine === 'b.local' && r.machine_id === 'b' && out.summary.includes('on b.local'),
      out.summary,
    );
  }),

  test('launch_squad lands the whole squad on one clone, the least busy one', async () => {
    const { ctx, sent } = twoMacs();
    const out = await runTool(ctx, 'launch_squad', {
      project_id: 'AX', machine: null, preset: null, squad: 'audit', mission_id: null,
      lead_mission: 'Lead the audit: split the work below across your members and consolidate one report.',
      members: [{ mission: MISSION, model: null }, { mission: MISSION, model: null }],
      lead_model: null, background: true, runtime: null, permission_mode: null,
      budget_tokens: null, budget_usd: null, budget_min: null,
      squad_budget_tokens: null, squad_budget_usd: null, squad_budget_min: null, shared_worktree: false,
    });
    const spawns = sent.filter((s) => s.cmd.k === 'spawn');
    return ok(
      'the squad is on one machine',
      !out.isError && spawns.length === 3 && spawns.every((s) => s.machineId === 'b')
      && parse<{ machine: string }>(out).machine === 'b.local' && out.summary.includes('on AX on b.local'),
      `${spawns.map((s) => s.machineId).join(',')} · ${out.summary}`,
    );
  }),

  test('with one machine nothing changes: same pick, same summary', async () => {
    const b = box({
      machines: [machine('a')], projects: [clone('a')], agents: [agent('a1', 'a')],
      disks: { a: ['/Users/dan/projects/ax'] },
    });
    const out = await runTool(b.ctx, 'spawn_agent', spawnInput());
    const survey = parse<{ machines: unknown[] }>(await runTool(b.ctx, 'list_fleet', { only_blocked: false }));
    return ok(
      'one machine reads as before',
      !out.isError && out.summary === 'spawned an agent on AX' && survey.machines.length === 1,
      out.summary,
    );
  }),

  test('a synthetic machine never takes real work, even when it is the idlest', async () => {
    const b = box({
      machines: [machine('a'), machine('fx', { synthetic: true })],
      projects: [clone('a'), clone('fx')],
      agents: [agent('a1', 'a'), agent('a2', 'a')],
      disks: { a: [], fx: ['/Users/dan/projects/thing'] },
    });
    // Por código el clon del arnés sortea último aunque esté vacío; por ruta
    // ni se le pregunta: el alta sólo va a máquinas de verdad.
    const byCode = await runTool(b.ctx, 'spawn_agent', spawnInput());
    const codeTo = b.sent.find((s) => s.cmd.k === 'spawn')?.machineId;
    const out = await runTool(b.ctx, 'spawn_agent', spawnInput({ project_id: '/Users/dan/projects/thing' }));
    const registers = b.sent.filter((s) => s.cmd.k === 'project:register').map((s) => s.machineId);
    return eq(
      'the harness never takes real work',
      `${byCode.isError === true}:${codeTo}|${registers.join(',')}:${out.isError === true}`,
      'false:a|a:true',
    );
  }),
];

const suite: TestModule = { suite: 'Una flota en dos máquinas', tests };
export default suite;
