/**
 * Directorios que no son proyectos: el de CAPCOM y los scratchpads de sesión.
 *
 * Lo que se demuestra aquí, en el orden en que falla si alguien lo rompe:
 *
 *  1. El slug del directorio de CAPCOM —y el de un scratchpad de Claude Code—
 *     no produce proyecto. Es el origen de la isla "capcom" con 39 agentes y de
 *     los proyectos "probe-a"/"probe-b" que nadie lanzó.
 *  2. Lo que quedó dentro se reporta marcado (`hidden`), MENOS la sesión CAPCOM
 *     viva: esa sigue siendo el puesto de mando. La marca sobrevive al hub y la
 *     consola no la pinta.
 *  3. Nadie puede lanzar trabajo ahí: ni por el hub, ni por `spawn_agent`, ni
 *     por `launch_squad`, ni dejando un archivo en el buzón de spawn.
 *  4. Lo ya registrado se puede archivar en bloque por estar oculto.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { diffAgent } from '../src/collector/index.ts';
import { ProjectRegistry } from '../src/collector/projects.ts';
import { SpawnWatcher } from '../src/collector/spawns.ts';
import { runTool, type CeoContext } from '../src/agents/tools.ts';
import { archiveCandidates } from '../src/shared/archive.ts';
import { sanitizeAgent, sanitizeAgentPatch } from '../src/hub/world.ts';
import { startHub, type Hub } from '../src/hub/server.ts';
import { HubStore } from '../src/hub/persist.ts';
import { AnswerMemory } from '../src/hub/memory.ts';
import { createAuth } from '../src/hub/auth.ts';
import { PATHS, newId, type ServerFrame } from '../src/shared/protocol.ts';
import { emptyRollup, type Agent, type Project } from '../src/shared/types.ts';
import {
  CAPCOM_DIR_REFUSAL, excludedWorkspace, hiddenInWorkspace, pathToSlug,
} from '../src/shared/workspaces.ts';
import { ok, test, until, type TestModule } from './harness.ts';

const CAPCOM = '/Users/dan/.orca/capcom';
/** El slug que Claude Code le da: los puntos también son guión. */
const CAPCOM_SLUG = pathToSlug(CAPCOM); // -Users-dan--orca-capcom
const TOKEN = 'test-token-orca-0000';

function agent(over: Partial<Agent> = {}): Agent {
  const now = Date.now();
  return {
    id: 'a1', machineId: 'm1', projectId: `m1/${CAPCOM_SLUG}`, title: 't', callsign: 'K9',
    runtime: 'claude', role: 'agent', state: 'dead', block: null, parentId: null, depth: 0,
    childIds: [], mission: null, squad: null, lead: false, model: null, tool: null,
    toolDetail: null, lastPrompt: null, lastSay: null, startedAt: now, updatedAt: now, uptimeMs: 0,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
      tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0,
      apiDurationMs: 0, turns: 0,
    },
    background: false, shortId: null, ...over,
  };
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'm1/-Users-dan-projects-axolots', machineId: 'm1', slug: '-Users-dan-projects-axolots',
    name: 'axolots', path: '/Users/dan/projects/axolots', code: 'AX', gitBranch: 'main',
    gitDirty: false, keyNames: [], sessionIds: [], rollup: emptyRollup(), ...over,
  };
}

/** Un contexto de CAPCOM que sólo sabe de proyectos: lo que estas dos puertas leen. */
function ctxWith(projects: Project[]): CeoContext {
  const refuse = (): never => { throw new Error('no debería llegar aquí'); };
  return {
    agents: () => [], projects: () => projects,
    agent: () => undefined, project: (id: string) => projects.find((p) => p.id === id),
    escalation: () => undefined, escalations: () => [], rules: () => [],
    dispatch: refuse, nextSquadName: refuse, fleets: () => [],
    recall: () => [], remember: refuse, raiseToHuman: refuse, resolveEscalation: refuse,
    messages: () => [], message: () => undefined, collisions: () => [],
    relay: refuse, answerPeer: refuse, acknowledgeCollision: refuse, archiveAgents: refuse,
  } as unknown as CeoContext;
}

/**
 * Corre `fn` con CAPCOM viviendo en `dir`.
 *
 * El hub y las herramientas del mando resuelven el directorio del entorno en
 * cada llamada —no lo cachean— así que moverlo aquí es lo que hace posible
 * probar el rechazo sin tocar el CAPCOM de la máquina que corre la suite.
 */
async function withCapcomDir<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env['ORCA_CAPCOM_DIR'];
  process.env['ORCA_CAPCOM_DIR'] = dir;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env['ORCA_CAPCOM_DIR'];
    else process.env['ORCA_CAPCOM_DIR'] = previous;
  }
}

/** El brief mínimo que las dos herramientas exigen antes de mirar el proyecto. */
const BRIEF = 'Audit the payments module and report every unhandled error path you find.';

async function withHub<T>(fn: (hub: Hub) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-workspaces-hub-'));
  const hub = await startHub({
    port: 0, host: '127.0.0.1', quiet: true,
    auth: createAuth({ ORCA_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    store: new HubStore({ dir }),
    memory: new AnswerMemory(join(dir, 'memory.jsonl')),
  });
  try { return await fn(hub); } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── 1 · el registro de proyectos ─────────────────────────────────── */

const registry = [
  test('the CAPCOM directory, its subdirectories and session scratchpads are not projects', () => {
    assert.equal(excludedWorkspace(CAPCOM_SLUG, CAPCOM), 'capcom');
    assert.equal(excludedWorkspace(CAPCOM, CAPCOM), 'capcom');
    // Una prueba que alguien lanzó dentro: mismo sitio, misma respuesta.
    assert.equal(excludedWorkspace(`${CAPCOM_SLUG}-probe`, CAPCOM), 'capcom');
    assert.equal(excludedWorkspace(pathToSlug(`${CAPCOM}/notes`), CAPCOM), 'capcom');
    // El scratchpad por sesión, en sus dos formas (macOS resuelve /tmp).
    assert.equal(excludedWorkspace('/private/tmp/claude-501/x/scratchpad/probe-a', CAPCOM), 'scratchpad');
    assert.equal(excludedWorkspace('/tmp/claude-501/session/scratchpad', CAPCOM), 'scratchpad');
    assert.equal(excludedWorkspace('-private-tmp-claude-501--Users-dan-projects-orca-scratchpad-probe-b', CAPCOM), 'scratchpad');
    // Y un repo de verdad sigue siendo un repo, incluido uno que se llame así.
    assert.equal(excludedWorkspace('-Users-dan-projects-axolots', CAPCOM), null);
    assert.equal(excludedWorkspace('/Users/dan/projects/capcom-tools', CAPCOM), null);
    assert.equal(excludedWorkspace('/tmp/claude-code-notes', CAPCOM), null);
    return ok('CAPCOM y scratchpads reconocidos, los repos intactos', true);
  }),

  test('ensureWork registers a real project and refuses the excluded ones', () => {
    const reg = new ProjectRegistry('m1', CAPCOM);
    const real = reg.ensureWork('-Users-dan-projects-axolots', '/Users/dan/projects/axolots');
    assert.ok(real, 'un repo de verdad sí es un proyecto');
    assert.equal(reg.ensureWork(CAPCOM_SLUG, CAPCOM), null);
    assert.equal(reg.ensureWork(`${CAPCOM_SLUG}-probe`), null);
    assert.equal(reg.ensureWork('-private-tmp-claude-501-x-scratchpad-probe-a'), null);
    // Lo que importa: nada de eso entra en el registro, así que no viaja en el
    // snapshot y el hub nunca ve una isla "capcom".
    assert.deepEqual(reg.all().map((p) => p.slug), ['-Users-dan-projects-axolots']);
    // Y el id sigue existiendo para el agente que vive ahí, sin proyecto detrás.
    assert.equal(reg.get(reg.idForSlug(CAPCOM_SLUG)), null);
    return ok(`registrados: ${reg.all().map((p) => p.code).join(',')}`, true);
  }),
];

/* ── 2 · la marca de los que quedaron dentro ──────────────────────── */

const marking = [
  test('past CAPCOM sessions are marked hidden; the live commander is not', () => {
    // Lo que decide la marca: dónde vive, y qué rol tiene.
    assert.equal(hiddenInWorkspace('capcom', 'agent'), true, 'un CAPCOM anterior, ya terminado');
    assert.equal(hiddenInWorkspace('capcom', undefined), true, 'un worker que alguien lanzó ahí');
    assert.equal(hiddenInWorkspace('capcom', 'capcom'), false, 'el mando vivo se queda');
    assert.equal(hiddenInWorkspace('scratchpad', 'agent'), true);
    assert.equal(hiddenInWorkspace(null, 'agent'), false, 'un agente de un proyecto real');
    return ok('la marca distingue al mando de lo que quedó a su lado', true);
  }),

  test('the mark survives the hub and keeps the console from drawing it', async () => {
    const sane = sanitizeAgent({ ...agent({ hidden: true }) }, 'm1');
    assert.equal(sane?.hidden, true, 'el hub copia la marca');
    assert.deepEqual(sanitizeAgentPatch({ hidden: true }), { hidden: true });
    assert.equal(sanitizeAgent({ ...agent() }, 'm1')?.hidden, undefined, 'un agente normal no la lleva');

    // La consola: el filtro está en un sitio, y el campo y el HUD leen su vista.
    const { Store } = await import('../src/ui/store.ts');
    const { getPref, setPref } = await import('../src/ui/prefs.ts');
    const before = { showAll: getPref('showAll'), origin: getPref('origin') };
    try {
      setPref('showAll', false); setPref('origin', 'all');
      const store = new Store();
      assert.equal(store.visible(agent({ id: 'past', hidden: true, state: 'working' })), false);
      assert.equal(store.visible(agent({ id: 'real', projectId: 'm1/-Users-dan-projects-axolots', state: 'working' })), true);
      // SHOW ALL sigue siendo la puerta para mirar lo que quedó dentro.
      setPref('showAll', true);
      assert.equal(store.visible(agent({ id: 'past', hidden: true, state: 'working' })), true);
    } finally { setPref('showAll', before.showAll); setPref('origin', before.origin); }
    return ok('marcado en el hub, fuera del campo, visible con SHOW ALL', true);
  }),

  test('a rotated CAPCOM stops being hidden, and the change reaches the hub', () => {
    // Una rotación estrena sesión en el mismo directorio: nace marcada y deja
    // de estarlo en cuanto el linaje le da el rol. El patch tiene que LLEVAR
    // el `false` — un campo ausente se pierde al serializar y el hub se
    // quedaría con el mando escondido para siempre.
    const before = agent({ id: 'rotated', hidden: true, state: 'booting' });
    const after = agent({ id: 'rotated', hidden: false, role: 'capcom', state: 'thinking' });
    const patch = diffAgent(before, after);
    assert.equal(patch?.hidden, false, 'el diff manda la marca a false');
    assert.ok('hidden' in JSON.parse(JSON.stringify(patch)), 'y sobrevive al JSON');
    assert.equal(sanitizeAgentPatch(patch)?.hidden, false, 'y el hub la copia');
    return ok('el mando recién rotado vuelve a la vista', true);
  }),

  test('archive_agents can clear what was left in there, and only that', () => {
    const all = [
      agent({ id: 'past', hidden: true, state: 'dead' }),
      agent({ id: 'worker', projectId: 'm1/-Users-dan-projects-axolots', state: 'dead' }),
      agent({ id: 'live', hidden: true, state: 'working' }),
    ];
    const plan = archiveCandidates(all, { hidden: true });
    assert.deepEqual(plan.archive.map((a) => a.id), ['past'], 'sólo lo oculto y terminado');
    const every = archiveCandidates(all, {});
    assert.deepEqual(every.archive.map((a) => a.id).sort(), ['past', 'worker']);
    return ok('la purga en bloque existe y no se lleva por delante lo vivo', true);
  }),
];

/* ── 3 · nadie lanza trabajo ahí ──────────────────────────────────── */

const refusals = [
  test('spawn_agent and launch_squad refuse the CAPCOM directory with a usable reason', () => withCapcomDir(CAPCOM, async () => {
    // Por id de proyecto, sin que el proyecto exista siquiera: es el caso real
    // desde que el collector dejó de registrarlo.
    const byId = await runTool(ctxWith([]), 'spawn_agent', {
      project_id: `m1/${CAPCOM_SLUG}`, mission: BRIEF,
    });
    assert.equal(byId.isError, true);
    assert.ok(byId.result.includes('not a project'), byId.result);
    assert.ok(byId.result.includes('pick a work project'), byId.result);

    // Y por un proyecto que alguien hubiera conseguido registrar de todas
    // formas: la segunda puerta mira la RUTA, no el id.
    const registered = project({ id: 'p-cap', slug: CAPCOM_SLUG, name: 'capcom', path: CAPCOM, code: 'CA' });
    const byPath = await runTool(ctxWith([registered]), 'spawn_agent', {
      project_id: 'p-cap', mission: BRIEF,
    });
    assert.equal(byPath.isError, true);
    assert.ok(byPath.result.includes('not a project'), byPath.result);

    const squad = await runTool(ctxWith([registered]), 'launch_squad', {
      project_id: 'p-cap', squad: 'audit', lead_mission: BRIEF,
      members: [{ mission: BRIEF, model: null }],
    });
    assert.equal(squad.isError, true);
    assert.ok(squad.result.includes('not a project'), squad.result);

    // Un proyecto de verdad no se rechaza aquí (falla más tarde, sin máquina).
    const fine = await runTool(ctxWith([project()]), 'spawn_agent', {
      project_id: 'm1/-Users-dan-projects-axolots', mission: BRIEF,
    }).catch((err: unknown) => ({ result: String(err), isError: true }));
    assert.ok(!String(fine.result).includes('not a project'), String(fine.result));
    return ok('las dos puertas de CAPCOM dicen qué hacer en vez de "no project"', true);
  })),

  test('the hub refuses a spawn command aimed at the CAPCOM directory', () => withCapcomDir(CAPCOM, async () => {
    return await withHub(async (hub) => {
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}${PATHS.console}?token=${TOKEN}`);
      const frames: ServerFrame[] = [];
      ws.on('message', (d) => {
        try { frames.push(JSON.parse(d.toString()) as ServerFrame); } catch { /* ignora */ }
      });
      ws.on('error', () => { /* el cierre lo cuenta el test */ });
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('close', (code) => reject(new Error(`la consola cerró con ${code}`)));
      });
      const acks = (): Extract<ServerFrame, { t: 'ack' }>[] =>
        frames.filter((f) => f.t === 'ack') as Extract<ServerFrame, { t: 'ack' }>[];
      try {
        const capcomCmd = newId('cmd');
        ws.send(JSON.stringify({
          t: 'cmd', id: capcomCmd,
          cmd: {
            k: 'spawn', projectId: `m1/${CAPCOM_SLUG}`, prompt: BRIEF, parentId: null,
            mission: BRIEF, background: true,
          },
        }));
        await until(() => acks().some((a) => a.cmdId === capcomCmd), 4_000);
        const refused = acks().find((a) => a.cmdId === capcomCmd);
        assert.equal(refused?.ok, false, 'el hub debía rechazarlo');
        assert.equal(refused?.detail, CAPCOM_DIR_REFUSAL, refused?.detail);

        // Un proyecto normal que nadie reporta falla por otra razón, y se nota:
        // el rechazo es del sitio, no de que el mundo esté vacío.
        const otherCmd = newId('cmd');
        ws.send(JSON.stringify({
          t: 'cmd', id: otherCmd,
          cmd: {
            k: 'spawn', projectId: 'm1/-Users-dan-projects-axolots', prompt: BRIEF,
            parentId: null, mission: BRIEF, background: true,
          },
        }));
        await until(() => acks().some((a) => a.cmdId === otherCmd), 4_000);
        const other = acks().find((a) => a.cmdId === otherCmd);
        assert.equal(other?.ok, false);
        assert.ok(other?.detail?.includes('desconocido'), other?.detail);
        return ok(`el hub contesta: "${String(refused?.detail).slice(0, 48)}…"`, true);
      } finally { try { ws.close(); } catch { /* ya */ } }
    });
  })),

  test('the file spawn mailbox is not watched inside the CAPCOM directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-workspaces-'));
    try {
      // Un CAPCOM de mentira con su buzón ya lleno: el peor caso, porque el
      // archivo existe antes de que el vigilante mire.
      const capcom = join(root, '.orca', 'capcom');
      const real = join(root, 'axolots');
      for (const dir of [capcom, real]) mkdirSync(join(dir, '.orca', 'spawn'), { recursive: true });
      const brief = JSON.stringify({ mission: BRIEF });
      writeFileSync(join(capcom, '.orca', 'spawn', 'req.json'), brief);
      writeFileSync(join(real, '.orca', 'spawn', 'req.json'), brief);

      const seen: string[] = [];
      const watcher = new SpawnWatcher({ resolveAgent: () => 'asker' });
      watcher.onRequest((r) => { seen.push(r.projectId); });
      try {
        await withCapcomDir(capcom, async () => {
          watcher.track('p-cap', capcom);
          watcher.track('p-real', real);
          await watcher.scan();
        });
      } finally { watcher.stop(); }
      assert.deepEqual(seen, ['p-real'], `sólo el proyecto de verdad; llegó ${seen.join(',')}`);
      assert.ok(existsSync(join(capcom, '.orca', 'spawn', 'req.json')), 'la petición sigue ahí, sin leer');
      return ok('un archivo en el buzón de CAPCOM no lanza nada', true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }),
];

export default {
  suite: 'Workspaces that are not projects',
  tests: [...registry, ...marking, ...refusals],
} satisfies TestModule;
