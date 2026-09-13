/**
 * El archivo histórico sabe qué era del arnés.
 *
 * Las lápidas de `~/.orca/hub/archived.jsonl` son la población sobre la que se
 * calcula cualquier cifra agregada del pasado, y en el hub del operador 299 de
 * 423 vigentes eran del fixture: dos de cada tres. La marca la declara la
 * máquina en su `hello` (`shared/synthetic.ts`) y desaparece con ella, así que
 * lo único que puede conservarla es la lápida.
 *
 * Lo que se prueba aquí es la promesa entera y en los dos tiempos: que una
 * lápida nueva nace marcada cuando su máquina lo estaba, y que las viejas
 * —escritas cuando el campo no existía— se marcan AÑADIENDO una línea, sin
 * reescribir ni borrar ninguna. Un archivo que se pudiera reescribir para
 * corregirlo dejaría de ser una prueba de nada.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  countSynthetic, syntheticMark, tombstone, withoutSynthetic,
  type ArchivedAgent,
} from '../src/shared/archive.ts';
import { HubStore } from '../src/hub/persist.ts';
import { World } from '../src/hub/world.ts';
import { plan, run } from '../tools/archive-mark.ts';
import type { Agent, Machine } from '../src/shared/types.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const NOW = 1_800_000_000_000;

function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    machineId: 'm1', projectId: 'p1', title: `t ${over.id}`, callsign: over.id.toUpperCase().slice(0, 2),
    runtime: 'claude', state: 'done', block: null, parentId: null, depth: 0, childIds: [],
    mission: null, squad: null, lead: false, model: null, tool: null, toolDetail: null,
    lastPrompt: null, lastSay: null, startedAt: NOW - 60_000, updatedAt: NOW, uptimeMs: 0,
    metrics: { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, turns: 0, tokensPerSec: 0 },
    ...over,
  } as Agent;
}

/** Una lápida como las de antes del 2026-09-13: sin el campo. */
function oldTombstone(id: string, machineId: string): string {
  return JSON.stringify({
    id, machineId, projectId: `${machineId}/p`, callsign: id.toUpperCase().slice(0, 2),
    squad: null, lead: false, state: 'done', title: id, mission: null, parentId: null,
    startedAt: NOW - 1_000, finishedAt: NOW, archivedAt: NOW, by: 'capcom',
  } satisfies ArchivedAgent);
}

const tests = [
  test('a tombstone is born with the mark its machine declared', () => {
    const real = tombstone(agent({ id: 'r1' }), 'console', NOW, false);
    const fake = tombstone(agent({ id: 'f1', machineId: 'mac-cascabel' }), 'console', NOW, true);
    const counted = countSynthetic([real, fake]);
    return ok('tombstone',
      real.synthetic === undefined && fake.synthetic === true
      && counted.real === 1 && counted.synthetic === 1
      && withoutSynthetic([real, fake]).map((t) => t.id).join() === 'r1',
      JSON.stringify({ real: real.synthetic, fake: fake.synthetic, counted }));
  }),

  test('the world copies the mark off the machine, which is the only place it lives', () => {
    const world = new World({ now: () => NOW });
    // La marca entra como entra de verdad: en la máquina, no en el agente.
    world.upsertMachine({ id: 'fx', hostname: 'fixture', platform: 'darwin', synthetic: true } as Machine);
    world.upsertMachine({ id: 'm1', hostname: 'real', platform: 'darwin' } as Machine);
    world.state.agents['r1'] = agent({ id: 'r1' });
    world.state.agents['f1'] = agent({ id: 'f1', machineId: 'fx', projectId: 'fx/p' });
    const out = world.archiveAgents({}, { by: 'test' });
    const marks = out.archived.map((t) => `${t.id}:${t.synthetic === true}`).sort().join(' ');
    return eq('archiveAgents', marks, 'f1:true r1:false');
  }),

  test('a late mark corrects an old tombstone without touching a byte of it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-archive-mark-'));
    try {
      const file = join(dir, 'archived.jsonl');
      const before = [oldTombstone('f1', 'mac-cascabel'), oldTombstone('r1', 'm-real'), oldTombstone('f2', 'mac-cascabel')];
      writeFileSync(file, `${before.join('\n')}\n`);

      const store = new HubStore({ dir });
      store.appendSyntheticMark(['f1', 'f2'], NOW + 1);
      await store.flush();

      const after = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const loaded = store.loadArchived();
      const marked = loaded.filter((t) => t.synthetic === true).map((t) => t.id).sort().join();
      return ok('a mark is an addition',
        after.slice(0, 3).join('\n') === before.join('\n') && after.length === 5
        && loaded.length === 3 && marked === 'f1,f2'
        && countSynthetic(loaded).real === 1,
        JSON.stringify({ lines: after.length, marked, real: countSynthetic(loaded).real }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('a mark that arrives BEFORE the tombstone it corrects still lands on it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-archive-mark-order-'));
    try {
      const file = join(dir, 'archived.jsonl');
      // Un id que se archiva, sale del archivo, se marca y se vuelve a archivar:
      // la lápida vigente es posterior a su marca.
      writeFileSync(file, [
        oldTombstone('f1', 'mac-cascabel'),
        JSON.stringify({ id: 'f1', at: NOW, undo: true }),
        JSON.stringify(syntheticMark('f1', NOW + 1)),
        oldTombstone('f1', 'mac-cascabel'),
      ].join('\n') + '\n');
      const loaded = new HubStore({ dir }).loadArchived();
      return ok('order does not decide', loaded.length === 1 && loaded[0]!.synthetic === true,
        JSON.stringify(loaded));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('archive-mark counts in dry run, marks with --apply, and a second pass does nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-archive-mark-tool-'));
    try {
      const file = join(dir, 'archived.jsonl');
      const lines = [
        oldTombstone('f1', 'mac-cascabel'),
        oldTombstone('f2', 'vps-nue2-r3'),
        oldTombstone('r1', 'a303610cd6985e46f05a53366923d07a'),
        oldTombstone('r2', 'orca-visual-squad'),
        // Uno del fixture que ya salió del archivo: no hay nada que corregir.
        oldTombstone('f3', 'vps-fra1'),
        JSON.stringify({ id: 'f3', at: NOW, undo: true }),
        '{ not json',
      ];
      writeFileSync(file, `${lines.join('\n')}\n`);

      const dry = run(file, false, NOW);
      const untouched = readFileSync(file, 'utf8') === `${lines.join('\n')}\n`;
      const applied = run(file, true, NOW);
      const again = run(file, false, NOW);
      const after = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const loaded = new HubStore({ dir }).loadArchived();

      const checks = {
        // `orca-visual-squad` y la máquina real no son del fixture; `f3` está fuera.
        dryFinds: dry.synthetic === 2 && dry.real === 2 && dry.marked.length === 2 && !dry.applied,
        dryTouchesNothing: untouched,
        unparsedKept: dry.unparsed === 1 && after.includes('{ not json'),
        appliedAdds: applied.applied && after.length === lines.length + 2,
        nothingRemoved: after.slice(0, lines.length).join('\n') === lines.join('\n'),
        secondPassIsANoOp: again.marked.length === 0 && again.synthetic === 2,
        loadedMarked: loaded.filter((t) => t.synthetic === true).map((t) => t.id).sort().join() === 'f1,f2',
        realUntouched: loaded.filter((t) => t.synthetic !== true).map((t) => t.id).sort().join() === 'r1,r2',
      };
      return ok('archive-mark', Object.values(checks).every(Boolean), JSON.stringify(checks));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('plan() reads a file the hub is still writing without claiming what is not there', () => {
    const empty = plan('');
    const halfLine = plan(`${oldTombstone('r1', 'm-real')}\n{"id":"f1","machineId":"mac-casc`);
    return ok('partial input',
      empty.live === 0 && empty.marked.length === 0
      && halfLine.live === 1 && halfLine.unparsed === 1 && halfLine.marked.length === 0,
      JSON.stringify({ empty, halfLine }));
  }),
];

export default { suite: 'Archivo histórico: la marca del arnés', tests } satisfies TestModule;
