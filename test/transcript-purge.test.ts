/**
 * Borrar transcripts: lo único de la limpieza que no se deshace.
 *
 * Archivar retira de la vista y una lápida pesa kilobytes; esto borra lo que el
 * CLI escribió, que es la respuesta a por qué el repositorio quedó como quedó.
 * Por eso lo que se prueba aquí no es que borre —eso es una línea— sino todo lo
 * que se niega a borrar: una sesión viva, una que este collector no conoce, un
 * id que nadie reconoce. Un borrado de más aquí no tiene vuelta atrás.
 *
 * `dryRun` mide sin tocar, y esa medida es la que decide el operador, así que
 * también se comprueba que el archivo sigue ahí después de contarlo.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRunner, type AgentHandle, type CommandDeps } from '../src/collector/commands.ts';
import { LineageIndex } from '../src/collector/lineage.ts';
import { test, ok, type TestModule } from './harness.ts';

function temp(): string { return mkdtempSync(join(tmpdir(), 'orca-purge-')); }

function handle(dir: string, over: Partial<AgentHandle> = {}): AgentHandle {
  const id = over.id ?? 'a1';
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, 'x'.repeat(2048));
  return { id, sessionId: id, runtime: 'claude', callsign: id.toUpperCase(), projectId: 'p1',
    alive: false, state: 'done', transcriptPath: file, ...over } as AgentHandle;
}

function runner(dir: string, agents: AgentHandle[]): CommandRunner {
  return new CommandRunner({
    projects: { get: () => ({ id: 'p1', name: 'proyecto', path: dir }) },
    keys: { materialize: () => ({}) },
    tmux: { available: () => false },
    lineage: new LineageIndex(join(dir, 'lineage.json')),
    escalations: {}, messages: {}, artifacts: {},
    agent: (id: string) => agents.find((a) => a.id === id) ?? null,
    awaitSpawn: async () => null,
    onResync: () => {}, onKeysChanged: () => {},
  } as unknown as CommandDeps);
}

export default {
  suite: 'Purga de transcripts',
  tests: [
    test('cuenta sin tocar, y sólo borra cuando se le dice', async () => {
      const dir = temp();
      try {
        const a = handle(dir);
        const r = runner(dir, [a]);
        const dry = await r.execute({ k: 'transcripts:purge', machineId: 'm1', agentIds: [a.id], dryRun: true });
        const counted = dry.data as { purged: string[]; bytes: number; dryRun: boolean };
        assert.deepEqual(counted.purged, [a.id]);
        assert.equal(counted.bytes, 2048, 'la medida es la que el operador usa para decidir');
        assert.equal(existsSync(a.transcriptPath!), true, 'y contar no borra');

        const real = await r.execute({ k: 'transcripts:purge', machineId: 'm1', agentIds: [a.id] });
        assert.deepEqual((real.data as { purged: string[] }).purged, [a.id]);
        assert.equal(existsSync(a.transcriptPath!), false);
        return ok('el seco mide y no toca; el de verdad borra', true, `${counted.bytes} bytes medidos`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }),

    test('se niega a borrar lo que sigue vivo, lo que no conoce y lo que no tiene archivo', async () => {
      const dir = temp();
      try {
        const done = handle(dir, { id: 'done1' });
        // Un agente vivo cuya sesión el operador archivó por error: su
        // transcript está en uso y borrarlo es tirarle el suelo debajo.
        const working = handle(dir, { id: 'live1', alive: true, state: 'working' });
        const idle = handle(dir, { id: 'idle1', alive: false, state: 'idle' });
        const noFile = { id: 'nofile', sessionId: 'nofile', runtime: 'claude', callsign: 'NF',
          projectId: 'p1', alive: false, state: 'done' } as AgentHandle;
        const r = runner(dir, [done, working, idle, noFile]);

        const out = await r.execute({ k: 'transcripts:purge', machineId: 'm1',
          agentIds: [done.id, working.id, idle.id, noFile.id, 'jamás-visto'] });
        const d = out.data as { purged: string[]; skipped: { id: string; why: string }[] };
        assert.deepEqual(d.purged, ['done1'], 'sólo lo terminado con archivo');
        assert.deepEqual(d.skipped.map((s) => s.id).sort(), ['idle1', 'jamás-visto', 'live1', 'nofile']);
        assert.match(d.skipped.find((s) => s.id === 'live1')!.why, /still/);
        assert.match(d.skipped.find((s) => s.id === 'jamás-visto')!.why, /unknown to this collector/);
        assert.equal(existsSync(working.transcriptPath!), true, 'el vivo conserva el suyo');
        assert.equal(existsSync(idle.transcriptPath!), true, 'y el que espera, también');
        return ok('lo vivo, lo ajeno y lo inexistente se saltan y se dicen', true, `${d.skipped.length} saltados`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }),

    test('un id no lleva a una ruta: sin agente conocido no se toca el disco', async () => {
      const dir = temp();
      try {
        const victim = join(dir, 'no-es-suyo.jsonl');
        writeFileSync(victim, 'contenido ajeno');
        const r = runner(dir, []);
        // Nada de derivar rutas de un id: la única ruta que se borra es la que
        // este collector ya tenía registrada para ese agente.
        const out = await r.execute({ k: 'transcripts:purge', machineId: 'm1',
          agentIds: ['../../etc/passwd', victim, 'a1'] });
        assert.deepEqual((out.data as { purged: string[] }).purged, []);
        assert.equal(existsSync(victim), true);
        return ok('sin agente no hay ruta, y sin ruta no hay borrado', true);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }),
  ],
} satisfies TestModule;
