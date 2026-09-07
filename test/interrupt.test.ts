/**
 * Interrumpir un turno sin matar la sesión.
 *
 * Lo que se prueba, y por qué cada cosa importa:
 *
 *  1. La política por runtime. Las dos TUIs quieren las dos mitades en ORDEN
 *     CONTRARIO — Claude corta y luego escucha; Codex encola y el corte es lo
 *     que entrega — así que el orden es el contrato, no un detalle. Se afirma
 *     sobre la secuencia real de llamadas a tmux.
 *  2. Que no hay sucedáneos. Ningún camino manda Ctrl-C, mata el pane ni
 *     relanza la sesión: perder el turno es reversible, perder la sesión no.
 *  3. Los estados. `sent` no es `confirmed`, y el mensaje `queued` no es el
 *     mensaje `pasted`. Una respuesta que los confunda le dice al mando que su
 *     corrección llegó cuando puede estar en una cola.
 *  4. La evidencia, contra líneas REALES de transcript capturadas de las dos
 *     CLIs interrumpidas a mano: es lo único que permite decir que el turno se
 *     cortó de verdad.
 *  5. Los rechazos: sin pane no se puede, y se dice por qué en vez de matar
 *     nada.
 *
 * Nada aquí lanza un CLI ni toca un pane de verdad: el tmux es un doble que
 * apunta lo que le piden.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommandRunner, type AgentHandle, type CommandDeps } from '../src/collector/commands.ts';
import { SessionDeriver } from '../src/collector/derive.ts';
import { CodexDeriver } from '../src/collector/codex.ts';
import { LineageIndex } from '../src/collector/lineage.ts';
import { interruptPlan, type InterruptOutcome } from '../src/shared/interrupt.ts';
import { ok, test, type TestModule } from './harness.ts';

function temp(): string { return mkdtempSync(join(tmpdir(), 'orca-interrupt-')); }

/** Lo que le pidieron a tmux, en orden, con lo que se le pasó. */
interface TmuxLog { calls: string[]; pasted: string[]; keys: string[][] }

function fakeTmux(
  log: TmuxLog,
  over: { keysOk?: boolean; pasteOk?: boolean; has?: boolean; screen?: string } = {},
) {
  return {
    available: () => true,
    has: async () => over.has !== false,
    keys: async (_pane: string, keys: string[]) => {
      log.calls.push(`keys:${keys.join('+')}`);
      log.keys.push(keys);
      return over.keysOk === false
        ? { ok: false, stdout: '', detail: 'pane no acepta teclas' }
        : { ok: true, stdout: '', detail: '' };
    },
    paste: async (_pane: string, text: string) => {
      log.calls.push('paste');
      log.pasted.push(text);
      return over.pasteOk === false
        ? { ok: false, stdout: '', detail: 'buffer lleno' }
        : { ok: true, stdout: '', detail: '' };
    },
    kill: async () => { log.calls.push('kill'); return { ok: true, stdout: '', detail: '' }; },
    spawn: async () => { log.calls.push('spawn'); return { ok: true, stdout: '', detail: '' }; },
    capture: async () => { log.calls.push('capture'); return { ok: true, stdout: over.screen ?? '', detail: '' }; },
  };
}

function handle(over: Partial<AgentHandle> = {}): AgentHandle {
  return {
    id: 'sess-1', projectId: 'p1', sessionId: 'sess-1', shortId: null,
    background: false, alive: true, callsign: 'K9', pane: 'orca-sess-1',
    runtime: 'claude', state: 'working', ...over,
  };
}

/** Deps mínimas: sólo lo que `interrupt` toca. */
function deps(
  dir: string, tmux: ReturnType<typeof fakeTmux>, a: AgentHandle,
  interruptedAt?: (id: string) => number,
): CommandDeps {
  return {
    projects: { get: () => ({ id: 'p1', name: 'proyecto', path: dir }) },
    keys: { materialize: () => ({}) },
    tmux,
    lineage: new LineageIndex(join(dir, 'lineage.json')),
    escalations: {}, messages: {}, artifacts: {},
    agent: (id: string) => (id === a.id ? a : null),
    awaitSpawn: async () => null,
    onResync: () => { /* no se usa */ },
    onKeysChanged: () => { /* no se usa */ },
    ...(interruptedAt ? { interruptedAt } : {}),
  } as unknown as CommandDeps;
}

async function run(
  over: { agent?: Partial<AgentHandle>; text?: string | null; tmux?: Parameters<typeof fakeTmux>[1];
    interruptedAt?: (id: string) => number } = {},
): Promise<{ res: Awaited<ReturnType<CommandRunner['execute']>>; out: InterruptOutcome; log: TmuxLog }> {
  const dir = temp();
  try {
    const log: TmuxLog = { calls: [], pasted: [], keys: [] };
    const a = handle(over.agent);
    const runner = new CommandRunner(deps(dir, fakeTmux(log, over.tmux ?? {}), a, over.interruptedAt));
    const res = await runner.execute({ k: 'interrupt', agentId: a.id, text: over.text ?? null });
    return { res, out: res.data as InterruptOutcome, log };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* ── 1 · la política, por runtime ─────────────────────────────────── */

const policy = [
  test('each runtime gets the order its TUI actually needs, and an unknown one is refused', () => {
    const claude = interruptPlan('claude', true, true);
    assert.equal(claude.ok && claude.delivery, 'escape-then-message');
    const codexWith = interruptPlan('codex', true, true);
    assert.equal(codexWith.ok && codexWith.delivery, 'message-then-escape');
    // Sin mensaje que encolar, el Escape de Codex no se acusa: el plan lo dice
    // para que nadie prometa una confirmación que no va a llegar.
    assert.equal(interruptPlan('codex', true, true).ok && (interruptPlan('codex', true, true) as { confirms: boolean }).confirms, true);
    assert.equal((interruptPlan('codex', true, false) as { confirms: boolean }).confirms, false);
    assert.equal((interruptPlan('claude', true, false) as { confirms: boolean }).confirms, true);
    const other = interruptPlan('grok', true, true);
    assert.equal(other.ok, false);
    assert.ok(!other.ok && other.reason.includes('grok'), other.ok ? '' : other.reason);
    return ok('claude corta y escucha; codex encola y el corte entrega', true);
  }),

  test('a session with no pane is unsupported, and the reason says stop is not a substitute', () => {
    const bg = interruptPlan('claude', false, true);
    assert.equal(bg.ok, false);
    assert.ok(!bg.ok && /does not cancel the turn/.test(bg.reason), bg.ok ? '' : bg.reason);
    const cx = interruptPlan('codex', false, false);
    assert.equal(cx.ok, false);
    return ok('sin pane: unsupported con el motivo, no un apaño', true);
  }),
];

/* ── 2 · el orden real de las teclas ──────────────────────────────── */

const order = [
  test('claude: Escape first, correction after — never the other way round', async () => {
    const { res, out, log } = await run({ text: 'stop that, do X instead' });
    assert.equal(res.ok, true, res.detail);
    assert.deepEqual(log.calls, ['keys:Escape', 'paste', 'capture'], 'el corte va primero');
    assert.deepEqual(out.order, ['escape', 'message']);
    assert.equal(out.message, 'pasted');
    assert.deepEqual(log.pasted, ['stop that, do X instead']);
    return ok(`orden: ${log.calls.join(' → ')}`, true);
  }),

  test('codex: the message is queued first and the cancel is what delivers it', async () => {
    const { res, out, log } = await run({ agent: { runtime: 'codex' }, text: 'switch to plan B' });
    assert.equal(res.ok, true, res.detail);
    assert.deepEqual(log.calls, ['paste', 'keys:Escape'], 'encolar y luego cortar');
    assert.deepEqual(out.order, ['message', 'escape']);
    assert.equal(out.message, 'queued', 'en codex el texto se encola, no se pega en un prompt libre');
    return ok(`orden: ${log.calls.join(' → ')}`, true);
  }),

  test('a bare interrupt sends one Escape and nothing else', async () => {
    const { out, log } = await run({ text: null });
    assert.deepEqual(log.calls, ['keys:Escape']);
    assert.equal(out.message, 'none');
    return ok('sin texto, sólo la tecla', true);
  }),

  test('no path kills, double Ctrl-Cs, relaunches or deletes anything', async () => {
    for (const runtime of ['claude', 'codex']) {
      for (const text of ['corrección', null]) {
        const { log } = await run({ agent: { runtime }, text });
        assert.ok(!log.calls.includes('kill'), `${runtime}: mató el pane`);
        assert.ok(!log.calls.includes('spawn'), `${runtime}: relanzó la sesión`);
        for (const keys of log.keys) {
          assert.ok(!keys.includes('C-c'), `${runtime}: mandó Ctrl-C`);
          assert.deepEqual(keys, ['Escape'], `${runtime}: mandó teclas de más`);
        }
      }
    }
    return ok('sólo Escape; nada de Ctrl-C, kill ni relaunch', true);
  }),
];

/* ── 3 · estados distinguibles ────────────────────────────────────── */

const states = [
  test('"the key went out" and "the CLI confirmed it" are different answers', async () => {
    const now = Date.now();
    // Sin acuse: el transcript no trae nada nuevo.
    const pending = await run({ text: null, interruptedAt: () => now - 60_000 });
    assert.equal(pending.out.interrupt, 'sent');
    assert.equal(pending.out.evidence, 'pending');
    assert.ok(/no acknowledgement/.test(pending.out.detail), pending.out.detail);

    // Con acuse posterior al momento en que se mandó la tecla.
    const confirmed = await run({ text: null, interruptedAt: () => Date.now() + 5_000 });
    assert.equal(confirmed.out.evidence, 'confirmed');
    assert.ok(/recorded the turn as interrupted/.test(confirmed.out.detail), confirmed.out.detail);
    return ok('el acuse viene del CLI o no se afirma', true);
  }),

  test('nothing in the answer claims the agent read the correction', async () => {
    const { out } = await run({ text: 'do X instead', interruptedAt: () => Date.now() + 5_000 });
    assert.equal(out.evidence, 'confirmed', 'el turno sí consta cortado');
    // Lo que se dice del mensaje es dónde se dejó, nunca que fuera leído.
    assert.ok(/pasted into its prompt/.test(out.detail), out.detail);
    assert.ok(!/read|understood|acknowledged the message/i.test(out.detail), out.detail);
    return ok(`detalle: "${out.detail}"`, true);
  }),

  test('a correction that landed in the CLI queue is reported as queued, not sent', async () => {
    // La pantalla de Claude Code cuando el texto no entró en el prompt libre.
    const { out } = await run({
      text: 'do X instead',
      tmux: { screen: '  17.\n❯ do X instead\n❯ Press up to edit queued messages\n' },
    });
    assert.equal(out.interrupt, 'sent', 'el corte sí salió');
    assert.equal(out.message, 'queued', 'y el texto quedó en la cola');
    // En Claude Code la cola se vacía al terminar el turno, así que decir
    // "encolado" a secas prometería una entrega que no va a ocurrir ahora.
    assert.ok(/not now/.test(out.detail), out.detail);
    return ok('encolado no se cuenta como entregado en el prompt', true);
  }),

  test('queued means something different on each CLI, and the wording says which', async () => {
    const { out } = await run({ agent: { runtime: 'codex' }, text: 'do X instead' });
    assert.equal(out.message, 'queued');
    assert.ok(/the cancel delivers/.test(out.detail), out.detail);
    assert.ok(!/not now/.test(out.detail), out.detail);
    return ok('en codex la cola SÍ la entrega el corte, y se dice así', true);
  }),

  test('a bare cancel on codex says out loud that the turn may still be running', async () => {
    const { out } = await run({ agent: { runtime: 'codex' }, text: null, interruptedAt: () => Date.now() + 5_000 });
    assert.equal(out.evidence, 'pending', 'sin cola no se espera acuse');
    assert.ok(/may still be running/.test(out.detail), out.detail);
    return ok('codex a secas: se avisa de que puede no haber cortado', true);
  }),
];

/* ── 4 · la evidencia, con líneas reales ──────────────────────────── */

const evidence = [
  test('the mark Claude Code writes on Esc is picked up from the transcript', () => {
    const ref = { key: 'sess-1', sessionId: 'sess-1', agentId: null, slug: '-tmp-p', path: '/tmp/p/sess-1.jsonl', metaPath: null };
    const d = new SessionDeriver(ref as never, 'm1', 'p1');
    assert.equal(d.interruptedMarkAt(), 0, 'de entrada, ninguna');
    // Línea capturada de una sesión interrumpida a mano con Esc.
    const line = {
      type: 'user', timestamp: '2026-09-06T23:07:00.000Z', uuid: 'u1',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    };
    d.ingest({ ref: ref as never, lines: [line], bootstrap: false, at: Date.now(), mtimeMs: Date.now() });
    assert.ok(d.interruptedMarkAt() > 0, 'la marca quedó fechada');
    // Y la variante de herramienta, que es la otra forma que escribe el CLI.
    const d2 = new SessionDeriver(ref as never, 'm1', 'p1');
    const tool = {
      type: 'user', timestamp: '2026-09-06T23:08:00.000Z', uuid: 'u2',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
    };
    d2.ingest({ ref: ref as never, lines: [tool], bootstrap: false, at: Date.now(), mtimeMs: Date.now() });
    assert.ok(d2.interruptedMarkAt() > 0, 'la variante de tool también');
    // Un prompt normal no es un acuse.
    const d3 = new SessionDeriver(ref as never, 'm1', 'p1');
    const normal = {
      type: 'user', timestamp: '2026-09-06T23:09:00.000Z', uuid: 'u3',
      message: { role: 'user', content: [{ type: 'text', text: 'please stop and do X' }] },
    };
    d3.ingest({ ref: ref as never, lines: [normal], bootstrap: false, at: Date.now(), mtimeMs: Date.now() });
    assert.equal(d3.interruptedMarkAt(), 0, 'un mensaje humano no es una interrupción');
    return ok('[Request interrupted by user] reconocido, y sólo él', true);
  }),

  test('the turn_aborted Codex writes on an interrupted turn is picked up too', () => {
    const ref = { key: 'cx-1', sessionId: 'cx-1', agentId: null, slug: '-tmp-p', path: '/tmp/p/cx.jsonl', metaPath: null };
    const d = new CodexDeriver(ref as never, 'm1', 'p1');
    assert.equal(d.interruptedMarkAt(), 0);
    // Línea capturada de un rollout real, con su razón.
    const line = {
      timestamp: '2026-09-06T23:10:00.000Z', type: 'event_msg',
      payload: { type: 'turn_aborted', turn_id: '01a07743-392f-7b01-9dfa-8d5463b08ec3', reason: 'interrupted' },
    };
    d.ingest({ ref: ref as never, lines: [line], bootstrap: false, at: Date.now(), mtimeMs: Date.now() });
    assert.ok(d.interruptedMarkAt() > 0, 'turn_aborted quedó fechado');
    return ok('turn_aborted reason=interrupted reconocido', true);
  }),
];

/* ── 5 · lo que sale mal ──────────────────────────────────────────── */

const failures = [
  test('a session with no pane is refused without touching anything', async () => {
    const { res, out, log } = await run({ agent: { pane: null, background: true }, text: 'do X' });
    assert.equal(res.ok, false);
    assert.equal(out.interrupt, 'unsupported');
    assert.equal(out.message, 'unsent', 'el texto no se da por enviado');
    assert.deepEqual(log.calls, [], 'no se tocó el pane de nadie');
    assert.ok(/no pane/.test(out.detail), out.detail);
    return ok('unsupported claro, cero efectos', true);
  }),

  test('a pane that is already gone is unsupported, not a kill', async () => {
    const { res, out, log } = await run({ text: 'do X', tmux: { has: false } });
    assert.equal(res.ok, false);
    assert.equal(out.interrupt, 'unsupported');
    assert.deepEqual(log.calls, []);
    assert.ok(/ya no existe/.test(out.detail), out.detail);
    return ok('pane muerto: se dice, no se fuerza', true);
  }),

  test('when the cancel key fails the message is not sent, and it says so', async () => {
    const { res, out, log } = await run({ text: 'do X', tmux: { keysOk: false } });
    assert.equal(res.ok, false);
    assert.equal(out.interrupt, 'failed');
    assert.equal(out.message, 'unsent');
    assert.deepEqual(log.calls, ['keys:Escape'], 'no se pegó nada tras el fallo');
    return ok('si no corta, no habla', true);
  }),

  test('when the correction cannot be pasted, the cut is reported and the message is not', async () => {
    const { res, out } = await run({ text: 'do X', tmux: { pasteOk: false } });
    assert.equal(res.ok, false);
    assert.equal(out.interrupt, 'sent', 'el turno sí se cortó');
    assert.equal(out.message, 'unsent');
    assert.ok(/mensaje no salió/.test(out.detail), out.detail);
    return ok('media operación se reporta como media', true);
  }),

  test('on codex, a failed queue stops the cancel: no cut without the message it was for', async () => {
    const { res, out, log } = await run({ agent: { runtime: 'codex' }, text: 'do X', tmux: { pasteOk: false } });
    assert.equal(res.ok, false);
    assert.equal(out.interrupt, 'failed');
    assert.deepEqual(log.calls, ['paste'], 'no se mandó Escape');
    return ok('codex: sin cola, no se corta', true);
  }),
];

export default {
  suite: 'Interrupting a turn',
  tests: [...policy, ...order, ...states, ...evidence, ...failures],
} satisfies TestModule;
