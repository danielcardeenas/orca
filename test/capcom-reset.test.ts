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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CapcomResets, RESET_RECEIPT, resetContext, resetPrompt } from '../src/collector/capcom-reset.ts';
import type { AgentHandle } from '../src/collector/commands.ts';
import { modelPromptReady } from '../src/collector/model-control.ts';
import { TmuxHost, resolveTmuxBin } from '../src/collector/tmux.ts';
import { sanitizeAgentPatch } from '../src/hub/world.ts';
import { test, ok, type TestModule } from './harness.ts';

const OLD = '11111111-2222-4333-8444-555555555555';
const NEW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const IDLE = '› Ask Codex to do anything\n  ? for shortcuts';

/*
 * Un CAPCOM de Claude ocioso tal como lo devuelve `capture-pane -e`, copiado
 * de las pantallas reales (CAPCOM y una sesión de Claude Code 2.1.267, el
 * 2026-09-10) con las reglas horizontales recortadas. Al acabar cada turno el
 * CLI sugiere el siguiente mensaje DENTRO del cuadro de entrada, atenuado
 * (SGR 2). Sin `-e` esa sugerencia es indistinguible de un borrador, y NEW
 * CAPCOM fallaba justo con CAPCOM idle — dos entregas en verde no lo vieron
 * porque todos los dobles pintaban un prompt vacío.
 */
const RULE = '─'.repeat(24);
const SUGGESTION = '\x1b[2mavisame cuando termine mission-17\x1b[0m';
const CLAUDE_IDLE = [
  '\x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231mReply with just the word OK.\x1b[39m\x1b[49m',
  '\x1b[38;5;246m✻\x1b[39m \x1b[38;5;246mBaked for 2m 21s · done 9:17 PM\x1b[39m',
  `\x1b[38;5;244m${RULE} CAPCOM ─`,
  `\x1b[39m❯ ${SUGGESTION}          `,
  `\x1b[38;5;244m${RULE}`,
  '\x1b[39m  \x1b[38;5;246m⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent\x1b[39m   \x1b[38;5;114m\x1b]8;id=1xh72bs;https://claude.ai/code/session_x?from=cli\x1b\\/rc\x1b[39m\x1b]8;;\x1b\\',
].join('\n');
/** Lo mismo sin `-e`: lo único que ORCA miraba hasta ahora. */
const unstyled = (s: string) => s.replace(/\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

/** Como el tmux real: con `styled` devuelve los escapes; sin él, sólo el texto. */
function styledPane(screen: () => string) {
  const pasted: string[] = [];
  const asked: boolean[] = [];
  return {
    pasted, asked,
    tmux: {
      capture: async (_n: string, _l: number, o?: { styled?: boolean }) => {
        asked.push(!!o?.styled);
        return { ok: true, stdout: o?.styled ? screen() : unstyled(screen()), detail: '' };
      },
      paste: async (_n: string, text: string) => { pasted.push(text); return { ok: true, stdout: '', detail: '' }; },
      keys: async () => ({ ok: true, stdout: '', detail: '' }),
      rename: async () => ({ ok: true, stdout: '', detail: '' }),
    },
  };
}

/** Hasta que el intento lanzado por `tick()` termine, por el camino que sea. */
async function settle(service: CapcomResets, a: AgentHandle) {
  for (let i = 0; i < 200 && (service.state(a)?.phase === 'applying' || service.locked(a.sessionId)); i++) {
    await new Promise(r => setImmediate(r));
  }
}

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
        note: () => {}, dir: () => null,
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
        hold: () => {}, adopt: () => {}, note: () => {}, dir: () => null,
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
        hold: (_id, on) => holds.push(on), adopt: () => { throw new Error('must not adopt'); }, note: () => {}, dir: () => null,
      });
      await assert.rejects(service.run(OLD, 'clean', 'other-model'), /quota exhausted/);
      assert.deepEqual(p.pasted, [], 'the context is only cleared once the model is settled');
      assert.deepEqual(holds, [true, false], 'and the mail is released');
      return ok('the context survives a model change that could not be made', true);
    }),

    /*
     * `request()`/`tick()`/`cancel()`: el mismo patrón encolado que
     * `ModelController`, para que NEW CAPCOM deje de fallar duro por pescar
     * mal el instante en que CAPCOM está idle con el prompt limpio.
     */
    test('queued while busy, applied automatically once CAPCOM is idle — the same tick that ModelController already uses', async () => {
      const p = pane();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-reset-queue-'));
      try {
        let live = agent({ state: 'working' });
        const adopted: [string, string][] = [];
        const service = new CapcomResets({
          tmux: p.tmux, wait: async () => {}, agent: () => live, owns: () => true, busy: () => false,
          model: a => a.model ?? null, setModel: async () => {},
          discover: async () => agent({ id: NEW, sessionId: NEW }),
          hold: () => {}, adopt: (from, to) => adopted.push([from, to]), note: () => {}, dir: () => dir,
        });
        const queued = service.request(OLD, 'clean', 'gpt-6-astra');
        assert.equal(queued.phase, 'queued');
        service.tick(live);
        assert.equal(service.state(live)?.phase, 'queued', 'still working: nothing sent yet');
        assert.deepEqual(p.pasted, []);
        live = agent({ state: 'idle' });
        service.tick(live);
        for (let i = 0; i < 100 && service.state(live)?.phase === 'applying'; i++) await Promise.resolve();
        assert.equal(service.state(live)?.phase, 'ready');
        assert.deepEqual(adopted, [[OLD, NEW]]);
        assert.equal(p.pasted[0], '/clear');
        assert.match(p.pasted[1]!, new RegExp(RESET_RECEIPT));
        assert.match(service.state(live)!.detail, new RegExp(NEW));
        return ok('queued while working, applied on its own once idle — no re-click needed', true);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }),

    test('a queued NEW CAPCOM that never sees CAPCOM idle fails with a clear reason instead of waiting forever', async () => {
      const p = pane();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-reset-timeout-'));
      try {
        let clock = 0;
        const live = agent({ state: 'working' });
        const service = new CapcomResets({
          tmux: p.tmux, wait: async () => {}, agent: () => live, owns: () => true, busy: () => false,
          model: a => a.model ?? null, setModel: async () => {},
          discover: async () => agent({ id: NEW, sessionId: NEW }),
          hold: () => {}, adopt: () => { throw new Error('must not adopt'); }, note: () => {}, dir: () => dir,
          now: () => clock,
        });
        service.request(OLD, 'clean', 'gpt-6-astra');
        service.tick(live);
        assert.equal(service.state(live)?.phase, 'queued');
        clock += 11 * 60_000; // más de los 10 minutos de espera
        service.tick(live);
        const s = service.state(live);
        assert.equal(s?.phase, 'failed');
        assert.match(s!.detail, /did not go idle within/);
        assert.deepEqual(p.pasted, [], 'never touched the terminal');
        return ok('never idle: fails loud with a reason, no silent retry forever', true);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }),

    test('a queued NEW CAPCOM fails instead of waiting forever once the pane is gone', async () => {
      const p = pane();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-reset-nopane-'));
      try {
        let live = agent({ state: 'working' });
        const service = new CapcomResets({
          tmux: p.tmux, wait: async () => {}, agent: () => live, owns: () => true, busy: () => false,
          model: a => a.model ?? null, setModel: async () => {},
          discover: async () => agent({ id: NEW, sessionId: NEW }),
          hold: () => {}, adopt: () => { throw new Error('must not adopt'); }, note: () => {}, dir: () => dir,
        });
        service.request(OLD, 'clean', 'gpt-6-astra');
        live = agent({ state: 'idle', pane: null });
        service.tick(live);
        const s = service.state(live);
        assert.equal(s?.phase, 'failed');
        assert.match(s!.detail, /no longer hosted/);
        return ok('a pane that vanished while queued fails instead of hanging', true);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }),

    test('a queued NEW CAPCOM cancels cleanly, with no /clear left pending', async () => {
      const p = pane();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-reset-cancel-'));
      try {
        const live = agent({ state: 'working' });
        const service = new CapcomResets({
          tmux: p.tmux, wait: async () => {}, agent: () => live, owns: () => true, busy: () => false,
          model: a => a.model ?? null, setModel: async () => {},
          discover: async () => agent({ id: NEW, sessionId: NEW }),
          hold: () => {}, adopt: () => { throw new Error('must not adopt'); }, note: () => {}, dir: () => dir,
        });
        service.request(OLD, 'clean', 'gpt-6-astra');
        assert.equal(service.state(live)?.phase, 'queued');
        const cancelled = service.cancel(OLD);
        assert.equal(cancelled.phase, 'ready');
        service.tick(live); // ready: tick no tiene nada que reintentar
        assert.equal(service.state(live)?.phase, 'ready');
        assert.deepEqual(p.pasted, []);
        assert.equal(service.cancel(OLD).phase, 'ready', 'canceling with nothing queued is a harmless no-op');
        return ok('canceled while queued: nothing sent, cleanly back to ready', true);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }),

    test('the hub retains bounded reset state and rejects malformed metadata, same as modelControl', async () => {
      const p = pane();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-reset-sanitize-'));
      try {
        const live = agent({ state: 'working' });
        const service = new CapcomResets({
          tmux: p.tmux, wait: async () => {}, agent: () => live, owns: () => true, busy: () => false,
          model: a => a.model ?? null, setModel: async () => {},
          discover: async () => agent({ id: NEW, sessionId: NEW }),
          hold: () => {}, adopt: () => {}, note: () => {}, dir: () => dir,
        });
        const state = service.request(OLD, 'clean', 'gpt-6-astra');
        assert.deepEqual(sanitizeAgentPatch({ resetControl: state }).resetControl, state);
        assert.equal(sanitizeAgentPatch({ resetControl: { ...state, phase: 'invented' } }).resetControl, undefined);
        assert.equal(sanitizeAgentPatch({ resetControl: { ...state, sessionId: '../escape' } }).resetControl, undefined);
        return ok('wire state survives validation, a hostile shape does not', true);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }),

    test('cancel refuses once the reset already started applying: too late, a /clear may be in flight', async () => {
      const p = pane();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-reset-cancel-late-'));
      try {
        let live = agent({ state: 'working' });
        const service = new CapcomResets({
          tmux: p.tmux, wait: async () => {}, agent: () => live, owns: () => true, busy: () => false,
          model: a => a.model ?? null, setModel: async () => {},
          discover: async () => agent({ id: NEW, sessionId: NEW }),
          hold: () => {}, adopt: () => {}, note: () => {}, dir: () => dir,
        });
        service.request(OLD, 'clean', 'gpt-6-astra');
        live = agent({ state: 'idle' });
        service.tick(live); // sincrónico hasta el primer await: ya queda 'applying'
        assert.equal(service.state(live)?.phase, 'applying');
        assert.throws(() => service.cancel(OLD), /already started/);
        for (let i = 0; i < 100 && service.locked(OLD); i++) await Promise.resolve();
        return ok('once applying, cancel is refused instead of racing the /clear', true);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }),

    /*
     * Lo que la consola real hacía y los dobles no: un CAPCOM de Claude idle
     * con la sugerencia atenuada en el prompt.
     */
    test('the suggestion Claude Code paints dim in an idle prompt is not a draft; a typed draft still is', () => {
      const draft = CLAUDE_IDLE.replace(SUGGESTION, 'half-typed order for the fleet');
      const green = CLAUDE_IDLE.replace(SUGGESTION, '\x1b[38;5;2mhalf-typed order\x1b[39m');
      const turn = CLAUDE_IDLE.replace('Baked for 2m 21s · done 9:17 PM', '\x1b[2mThinking… (esc to interrupt)\x1b[0m');
      const codex = '\x1b[39m› \x1b[2mAsk Codex to do anything\x1b[0m\n  ? for shortcuts';
      assert.equal(modelPromptReady(CLAUDE_IDLE, 'claude'), true, 'styled: the suggestion is dropped');
      assert.equal(modelPromptReady(unstyled(CLAUDE_IDLE), 'claude'), false, 'plain: it reads as a draft — the bug');
      assert.equal(modelPromptReady(draft, 'claude'), false, 'a typed draft is never dim');
      assert.equal(modelPromptReady(green, 'claude'), false, 'colour 2 (38;5;2) is not the dim attribute');
      assert.equal(modelPromptReady(turn, 'claude'), false, 'a dim "esc to interrupt" still means a turn in flight');
      assert.equal(modelPromptReady(codex, 'codex'), true, 'Codex placeholder, styled');
      return ok('dim suggestion ignored, drafts and turns still refused', true);
    }),

    test('an idle Claude CAPCOM showing that suggestion gets its NEW CAPCOM — the case that failed in the real console', async () => {
      const p = styledPane(() => CLAUDE_IDLE);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-reset-suggestion-'));
      try {
        const live = agent({ runtime: 'claude', model: 'sonnet', state: 'idle' });
        const adopted: [string, string][] = [];
        const service = new CapcomResets({
          tmux: p.tmux, wait: async () => {}, agent: () => live, owns: () => true, busy: () => false,
          model: a => a.model ?? null, setModel: async () => { throw new Error('same model: must not change it'); },
          discover: async () => agent({ id: NEW, sessionId: NEW, runtime: 'claude' }),
          hold: () => {}, adopt: (from, to) => adopted.push([from, to]), note: () => {}, dir: () => dir,
        });
        service.request(OLD, 'clean', 'sonnet');
        service.tick(live);
        await settle(service, live);
        const s = service.state(live)!;
        assert.equal(s.phase, 'ready', s.detail);
        assert.deepEqual(adopted, [[OLD, NEW]]);
        assert.equal(p.pasted[0], '/clear');
        assert.ok(p.asked.length > 0 && p.asked.every(Boolean), 'every look at the prompt asks tmux for the styles');
        return ok('idle with a suggestion: cleared on the first tick, no re-click', true, s.detail);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }),

    test('idle but the prompt is not free: the request waits in the queue with its reason, then applies — never failed', async () => {
      let screen = CLAUDE_IDLE.replace(SUGGESTION, 'half-typed order for the fleet');
      const p = styledPane(() => screen);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-reset-draft-'));
      try {
        let clock = 1_000;
        const holds: boolean[] = [];
        const live = agent({ runtime: 'claude', model: 'sonnet', state: 'idle' });
        const service = new CapcomResets({
          tmux: p.tmux, wait: async () => {}, agent: () => live, owns: () => true, busy: () => false,
          model: a => a.model ?? null, setModel: async () => {},
          discover: async () => agent({ id: NEW, sessionId: NEW, runtime: 'claude' }),
          hold: (_id, on) => holds.push(on), adopt: () => {}, note: () => {}, dir: () => dir, now: () => clock,
        });
        service.request(OLD, 'clean', 'sonnet');
        service.tick(live);
        await settle(service, live);
        let s = service.state(live)!;
        assert.equal(s.phase, 'queued', s.detail);
        assert.match(s.detail, /prompt to clear/);
        assert.deepEqual(p.pasted, [], 'nothing typed over the draft');
        assert.deepEqual(holds, [], 'mail is not held for a prompt that could not be used');
        const looks = p.asked.length;
        clock += 1_000;
        service.tick(live);
        await settle(service, live);
        assert.equal(p.asked.length, looks, 'a busy prompt is not re-read on every tick');
        screen = CLAUDE_IDLE; // el operador borró el borrador
        clock += 1_500;
        service.tick(live);
        await settle(service, live);
        s = service.state(live)!;
        assert.equal(s.phase, 'ready', s.detail);
        assert.equal(p.pasted[0], '/clear');
        return ok('draft: queued with a reason; draft gone: applied on its own', true);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }),

    test('a prompt that never clears fails at the deadline and says why', async () => {
      const p = styledPane(() => CLAUDE_IDLE.replace(SUGGESTION, 'half-typed order for the fleet'));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-reset-draft-timeout-'));
      try {
        let clock = 1_000;
        const live = agent({ runtime: 'claude', model: 'sonnet', state: 'idle' });
        const service = new CapcomResets({
          tmux: p.tmux, wait: async () => {}, agent: () => live, owns: () => true, busy: () => false,
          model: a => a.model ?? null, setModel: async () => {},
          discover: async () => agent({ id: NEW, sessionId: NEW, runtime: 'claude' }),
          hold: () => {}, adopt: () => { throw new Error('must not adopt'); }, note: () => {}, dir: () => dir, now: () => clock,
        });
        service.request(OLD, 'clean', 'sonnet');
        service.tick(live);
        await settle(service, live);
        clock += 11 * 60_000;
        service.tick(live);
        const s = service.state(live)!;
        assert.equal(s.phase, 'failed');
        assert.match(s.detail, /prompt did not clear within 10 minutes/);
        assert.deepEqual(p.pasted, []);
        return ok('a draft that stays: a loud failure with the reason, at the deadline', true, s.detail);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }),

    test('a real tmux keeps the dim attribute that tells a suggestion from a draft', async () => {
      if (!resolveTmuxBin()) return ok('no tmux on this machine: skipped', true);
      // Socket propio de la prueba, nunca el de ORCA.
      const t = new TmuxHost(`orca-test-reset-${process.pid}`);
      try {
        const paint = (name: string, text: string) => t.spawn({ name, cwd: '/', env: {},
          argv: ['/bin/sh', '-c', `printf '${text}\\n'; sleep 30`] });
        // ❯ + NBSP, como lo pinta Claude Code; en octal para printf.
        const prompt = '\\033[39m\\342\\235\\257\\302\\240';
        assert.ok((await paint('orca-reset-suggestion', `${prompt}\\033[2mwrite the script\\033[0m`)).ok);
        assert.ok((await paint('orca-reset-draft', `${prompt}write the script`)).ok);
        let styled = ''; let plain = ''; let draft = '';
        for (let i = 0; i < 50 && !(styled.includes('write') && draft.includes('write')); i++) {
          await new Promise(r => setTimeout(r, 60));
          styled = (await t.capture('orca-reset-suggestion', 10, { styled: true })).stdout;
          draft = (await t.capture('orca-reset-draft', 10, { styled: true })).stdout;
        }
        plain = (await t.capture('orca-reset-suggestion', 10)).stdout;
        assert.equal(modelPromptReady(styled, 'claude'), true, JSON.stringify(styled));
        assert.equal(modelPromptReady(plain, 'claude'), false, 'without -e the attribute is gone');
        assert.equal(modelPromptReady(draft, 'claude'), false, JSON.stringify(draft));
        return ok('capture -e carries SGR 2 end to end; a typed draft still refuses', true);
      } finally { await t.killServer(); }
    }),
  ],
} satisfies TestModule;
