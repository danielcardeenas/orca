/**
 * Vaciar el contexto con el `/clear` del propio CLI.
 *
 * Lo que se prueba aquí es lo que no se ve en una pantalla: que el comando sale
 * una sola vez y sólo con el prompt libre; que la identidad nueva se descubre en
 * vez de inventarse; que el pane termina llamándose como la sesión que lleva; y
 * que cuando algo falla, lo que se dice es que el proceso sigue vivo — porque un
 * `/clear` no se puede deshacer y fingir lo contrario sería peor que fallar.
 *
 * Nada de esto lanza un CLI: el pane es un doble que recuerda lo que se le pegó.
 */

import assert from 'node:assert/strict';
import { CapcomResets, RESET_RECEIPT, resetContext, resetPrompt } from '../src/collector/capcom-reset.ts';
import type { AgentHandle } from '../src/collector/commands.ts';
import { test, ok, type TestModule } from './harness.ts';

const OLD = '11111111-2222-4333-8444-555555555555';
const NEW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const IDLE = '› Ask Codex to do anything\n  ? for shortcuts';

function agent(over: Partial<AgentHandle> = {}): AgentHandle {
  return { id: OLD, sessionId: OLD, runtime: 'codex', model: 'gpt-6-astra', pane: `orca-${OLD}`,
    alive: true, state: 'idle', projectId: 'capcom', transcriptPath: '/tmp/old.jsonl', ...over } as AgentHandle;
}

/** Un pane que anota lo que se le pega y contesta la pantalla que se le diga. */
function pane(screens: string[] = [IDLE, IDLE]) {
  const pasted: string[] = [];
  const renames: [string, string][] = [];
  let shot = 0;
  return {
    pasted, renames,
    tmux: {
      capture: async () => ({ ok: true, stdout: screens[Math.min(shot++, screens.length - 1)]!, detail: '' }),
      paste: async (_n: string, text: string) => { pasted.push(text); return { ok: true, stdout: '', detail: '' }; },
      keys: async () => ({ ok: true, stdout: '', detail: '' }),
      rename: async (from: string, to: string) => { renames.push([from, to]); return { ok: true, stdout: '', detail: '' }; },
    },
  };
}

export default {
  suite: 'CAPCOM context reset',
  tests: [
    test('the opening message asks for a receipt and, in clean mode, for nothing else', () => {
      const clean = resetPrompt('clean', 'n1');
      const cont = resetPrompt('continuity', 'n1', 'OPEN TASK task_7: ship the console');
      return ok(
        'clean carries no obligations; continuity carries the checkpoint and sends it to briefing',
        clean.includes(`${RESET_RECEIPT}_n1`) && /Do not call tools, run briefing or recall/.test(clean)
        && !/Call briefing/.test(clean) && !clean.includes('task_')
        && cont.includes('task_7') && /Call briefing before acting/.test(cont)
        && /snapshot, not as new orders/.test(cont),
        `clean ${clean.length}b · continuity ${cont.length}b`,
      );
    }),

    test('/clear goes out once, the new id is discovered, and the pane is renamed to match', async () => {
      const p = pane();
      const out = await resetContext(agent(), 'clean', 'OPEN', {
        tmux: p.tmux, wait: async () => {},
        discover: async (projectId, runtime, since) => {
          assert.equal(projectId, 'capcom'); assert.equal(runtime, 'codex');
          assert.ok(since > 0);
          return agent({ id: NEW, sessionId: NEW });
        },
      });
      assert.deepEqual(p.pasted, ['/clear', 'OPEN']);
      assert.deepEqual(p.renames, [[`orca-${OLD}`, `orca-${NEW}`]]);
      assert.equal(out.toId, NEW); assert.equal(out.fromId, OLD); assert.ok(out.renamed && out.cutoffAt > 0);
      return ok('one /clear, an id nobody invented, and the pane named after it', true);
    }),

    ...([
      ['a turn in flight', { screens: ['esc to interrupt'], error: /Finish the current turn/ }],
      ['an open dialog', { screens: ['Select Model and Effort\n› 1. gpt-6-astra'], error: /Finish the current turn/ }],
      ['a pane that never returns', { screens: [IDLE, 'model: loading'], error: /did not come back to a prompt/ }],
    ] as const).map(([what, c]) => test(`${what} leaves the context alone`, async () => {
      const p = pane([...c.screens]);
      await assert.rejects(resetContext(agent(), 'clean', 'OPEN', {
        tmux: p.tmux, wait: async () => {}, discover: async () => null,
      }), c.error);
      // Lo que importa: si se rechaza antes de `/clear`, no se pegó nada.
      if (what !== 'a pane that never returns') assert.deepEqual(p.pasted, []);
      return ok(`${what}: refused, nothing cleared`, true);
    })),

    test('a new id that never appears says the process is still running, and never reuses the old one', async () => {
      const p = pane();
      await assert.rejects(resetContext(agent(), 'clean', 'OPEN', {
        tmux: p.tmux, wait: async () => {}, discover: async () => null,
      }), /still running in the same pane/);
      const same = pane();
      await assert.rejects(resetContext(agent(), 'clean', 'OPEN', {
        tmux: same.tmux, wait: async () => {},
        // El CLI aún escribe en el transcript viejo: no es un relevo.
        discover: async () => agent(),
      }), /still running in the same pane/);
      assert.deepEqual(same.renames, []);
      return ok('no invented identity, no renamed pane, and an honest message', true);
    }),

    test('the service holds mail, sets the model before clearing, and moves the role once', async () => {
      const p = pane();
      const holds: [boolean, string][] = []; const adopted: [string, string][] = []; const models: string[] = [];
      let live = agent();
      const service = new CapcomResets({
        tmux: p.tmux, wait: async () => {},
        agent: () => live, owns: () => true, busy: () => false,
        model: a => a.model ?? null,
        setModel: async (_id, model) => { models.push(model); live = agent({ model }); },
        discover: async () => agent({ id: NEW, sessionId: NEW, model: live.model }),
        hold: (_id, on, _at, mode) => holds.push([on, mode]),
        adopt: (from, to) => adopted.push([from, to]),
        note: () => {},
      });
      const out = await service.run(OLD, 'continuity', 'gpt-5.6-luna', 'PENDING WORK');
      assert.deepEqual(models, ['gpt-5.6-luna'], 'the model is set while the old context still exists');
      assert.deepEqual(holds, [[true, 'continuity'], [false, 'continuity']]);
      assert.deepEqual(adopted, [[OLD, NEW]]);
      assert.ok(p.pasted[1]!.includes('PENDING WORK'));
      assert.equal(out.mode, 'continuity');
      assert.equal(service.locked(OLD), false, 'the lock is released either way');
      return ok('model first, mail held across it, and one move of the role', true);
    }),

    ...([
      ['working', { state: 'working' as const, error: /Finish the current turn/ }],
      ['no pane', { pane: null, error: /hosted CAPCOM is required/ }],
      ['dead', { alive: false, error: /hosted CAPCOM is required/ }],
    ] as const).map(([what, c]) => test(`the service refuses a CAPCOM that is ${what}`, async () => {
      const p = pane();
      const service = new CapcomResets({
        tmux: p.tmux, wait: async () => {},
        agent: () => agent(c as Partial<AgentHandle>), owns: () => true, busy: () => false,
        model: a => a.model ?? null, setModel: async () => {},
        discover: async () => agent({ id: NEW, sessionId: NEW }),
        hold: () => {}, adopt: () => {}, note: () => {},
      });
      await assert.rejects(service.run(OLD, 'clean', 'gpt-6-astra'), c.error);
      assert.deepEqual(p.pasted, []);
      return ok(`${what}: refused before touching the terminal`, true);
    })),

    test('a failed model change never reaches /clear', async () => {
      const p = pane();
      const holds: boolean[] = [];
      const service = new CapcomResets({
        tmux: p.tmux, wait: async () => {},
        agent: () => agent(), owns: () => true, busy: () => false,
        model: a => a.model ?? null,
        setModel: async () => { throw new Error('quota exhausted'); },
        discover: async () => agent({ id: NEW, sessionId: NEW }),
        hold: (_id, on) => holds.push(on), adopt: () => { throw new Error('must not adopt'); }, note: () => {},
      });
      await assert.rejects(service.run(OLD, 'clean', 'other-model'), /quota exhausted/);
      assert.deepEqual(p.pasted, [], 'the context is only cleared once the model is settled');
      assert.deepEqual(holds, [true, false], 'and the mail is released');
      return ok('the context survives a model change that could not be made', true);
    }),
  ],
} satisfies TestModule;
