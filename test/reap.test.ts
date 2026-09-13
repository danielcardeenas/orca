/**
 * Cerrar el proceso de un agente cuando su sesión terminó: las reglas.
 *
 * Todo puro, con líneas de comandos COPIADAS de la flota real el 2026-09-13
 * (rutas del operador sustituidas por `/Users/op`): el `claude --session-id`
 * de un pane de ORCA, el `claude` escueto de una sesión externa del operador,
 * el `claude --resume … --mcp-config` de CAPCOM, el Codex de npm con su
 * envoltorio `node` y su binario nativo, y el hub bajo `tsx watch`.
 *
 * Lo que se prueba es que cada una de las cinco salvaguardas del operador
 * cierra su puerta por sí sola, en orden, y que el resultado de una detención
 * lleva SIEMPRE la sesión y el proceso por separado. Nada aquí manda una señal.
 */

import {
  decideReap, describeProcess, describeStop, retainedBySessions, runtimeShape, sessionIdInCommand, sessionStray,
  type ReapSubject, type SessionProc,
} from '../src/shared/reap.ts';
import type { ProcRow } from '../src/shared/strays.ts';
import { ok, eq, test, type TestModule } from './harness.ts';

const REPO = '/Users/op/projects/orca';
const SID = '208fd608-2193-4737-84f0-88282200490f';
const NOW = 1_789_270_000_000;

/* Formas observadas, tal cual. */
const HOSTED = `/Users/op/.local/bin/claude --session-id ${SID} --permission-mode auto --name Eres el líder FORGE de tres arreglos decididos e independie… Eres el líder`;
const EXTERNAL = 'claude';
const CAPCOM = '/Users/op/.local/bin/claude --resume 1d2c27ff-387f-4d55-bcbe-0fc99792ab1a --model sonnet --tools default --mcp-config /Users/op/.orca/capcom/handoffs/162ee578/runtime/mcp.json';
const CODEX_WRAPPER = 'node /Users/op/.nvm/versions/node/v22.17.0/bin/codex';
const CODEX_NATIVE = '/Users/op/.nvm/versions/node/v22.17.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
const HUB = `node ${REPO}/node_modules/.bin/tsx watch src/hub/server.ts`;
const VITE = `node ${REPO}/node_modules/.bin/vite --port 4478`;

function proc(over: Partial<SessionProc> = {}): SessionProc {
  return { sessionId: SID, pid: 36570, startedAt: NOW - 3_600_000, command: HOSTED, source: 'pane', seenAt: NOW - 3_500_000, ...over };
}

function row(p: SessionProc, over: Partial<ProcRow> = {}): ProcRow {
  return { pid: p.pid, ppid: 1, startedAt: p.startedAt, command: p.command, ...over };
}

/** Un caso en el que TODO cuadra: es el que cada prueba rompe por una sola puerta. */
function subject(over: Partial<ReapSubject> = {}): ReapSubject {
  const p = over.proc ?? proc();
  return {
    proc: p,
    agent: { callsign: 'K9', origin: 'orca', role: 'agent', subagent: false },
    now: row(p),
    session: { ended: true, why: 'its pane orca-208fd608 is gone and the CLI no longer lists the session' },
    untouchable: new Set([4242, 4243]),
    repo: REPO,
    ...over,
  };
}

const refusal = (s: ReapSubject) => { const d = decideReap(s); return d.act === 'refuse' ? d.reason : d.act; };

const tests = [
  test('runtimeShape is an allowlist of observed shapes, not a blocklist', () => {
    const yes = [HOSTED, EXTERNAL, CAPCOM, CODEX_WRAPPER, CODEX_NATIVE].map(runtimeShape);
    const no = [HUB, VITE, 'vim claude.md', '/bin/sh -c claude', 'node server.js', 'tmux -L orca', ''].map(runtimeShape);
    return ok('the five fleet shapes pass and nothing else does',
      yes.join(',') === 'claude,claude,claude,codex,codex' && no.every((x) => x === null),
      `${yes.join(',')} / ${no.join(',')}`);
  }),

  test('sessionIdInCommand reads --session-id and --resume, lowercased, and nothing looser', () => {
    return ok('two flags, one uuid',
      sessionIdInCommand(HOSTED) === SID
      && sessionIdInCommand(CAPCOM) === '1d2c27ff-387f-4d55-bcbe-0fc99792ab1a'
      && sessionIdInCommand(`claude --resume ${SID.toUpperCase()}`) === SID
      && sessionIdInCommand(EXTERNAL) === null
      && sessionIdInCommand('claude --session-id not-a-uuid') === null
      && sessionIdInCommand(`claude --name ${SID}`) === null);
  }),

  /* ── 1. sólo lo que ORCA lanzó ────────────────────────────────── */

  test('an external session is never closed, whatever else lines up', () => {
    const p = proc({ command: EXTERNAL, source: 'cli' });
    const external = decideReap(subject({ proc: p, now: row(p), agent: { callsign: 'orca-f0', origin: 'external' } }));
    const unverified = decideReap(subject({ proc: p, now: row(p), agent: { callsign: 'orca-f0' } }));
    return ok('external and unverified provenance both refuse before anything else is looked at',
      external.act === 'refuse' && external.reason === 'external' && external.why.includes('never ORCA')
      && unverified.act === 'refuse' && unverified.reason === 'external' && unverified.why.includes('no verified launch provenance'),
      `${external.act}/${(external as { reason?: string }).reason} · ${unverified.act}/${(unverified as { reason?: string }).reason}`);
  }),

  test('an ORCA-launched session id on an argv is still refused when its agent is external or unknown', () => {
    // El id de sesión en el argv NO es licencia: la procedencia viene del linaje.
    const p = proc({ source: 'argv' });
    return ok('argv source, external agent → external; no agent → unknown',
      refusal(subject({ proc: p, agent: { callsign: 'K9', origin: 'external' } })) === 'external'
      && refusal(subject({ proc: p, agent: null })) === 'unknown');
  }),

  /* ── 3. nunca CAPCOM, nunca ORCA misma ─────────────────────────── */

  test('CAPCOM is refused even with origin orca, session ended and identity intact', () => {
    const p = proc({ command: CAPCOM, pid: 17066 });
    const d = decideReap(subject({ proc: p, now: row(p), agent: { callsign: 'CAPCOM', origin: 'orca', role: 'capcom' } }));
    return ok('capcom', d.act === 'refuse' && d.reason === 'capcom' && d.why.includes('CAPCOM'));
  }),

  test('a subagent, the hub, a vite and a non-runtime command are all refused by what they are', () => {
    const hub = proc({ command: HUB }); const vite = proc({ command: VITE }); const other = proc({ command: 'node server.js' });
    return ok('subagent / orca-self / orca-self / not-a-runtime',
      refusal(subject({ agent: { callsign: 'K9', origin: 'orca', subagent: true } })) === 'subagent'
      && refusal(subject({ proc: hub, now: row(hub) })) === 'orca-self'
      && refusal(subject({ proc: vite, now: row(vite) })) === 'orca-self'
      && refusal(subject({ proc: other, now: row(other) })) === 'not-a-runtime');
  }),

  test('codex, by its node wrapper or its native binary, is a runtime ORCA may close', () => {
    const w = proc({ command: CODEX_WRAPPER }); const n = proc({ command: CODEX_NATIVE });
    return ok('both codex shapes reach the identity check and terminate',
      decideReap(subject({ proc: w, now: row(w) })).act === 'terminate'
      && decideReap(subject({ proc: n, now: row(n) })).act === 'terminate');
  }),

  /* ── 2. sólo cuando la sesión terminó ──────────────────────────── */

  test('a session that has not ended is never closed, and the reason says why it is alive', () => {
    const d = decideReap(subject({ session: { ended: false, why: 'its pane orca-208fd608 is still on the tmux server' } }));
    return ok('session-alive', d.act === 'refuse' && d.reason === 'session-alive' && d.why.includes('still on the tmux server'));
  }),

  /* ── 3, otra vez: nada que la liveness liste vivo ──────────────── */

  test('a pid the liveness lists alive is untouchable, even for an ended session of ORCA', () => {
    return eq('untouchable', refusal(subject({ untouchable: new Set([36570]) })), 'untouchable');
  }),

  /* ── 4. la identidad, justo antes ──────────────────────────────── */

  test('a pid that is gone is reported gone, not killed and not failed', () => {
    const d = decideReap(subject({ now: undefined }));
    return ok('gone', d.act === 'gone' && d.why.includes('not running'));
  }),

  test('a recycled pid is refused: same number, different start time', () => {
    const p = proc();
    const d = decideReap(subject({ proc: p, now: row(p, { startedAt: p.startedAt! + 600_000 }) }));
    return ok('reused by time', d.act === 'refuse' && d.reason === 'reused' && d.why.includes('different time'), d.act === 'refuse' ? d.why : d.act);
  }),

  test('a recycled pid is refused: same number, same start time, different command', () => {
    const p = proc();
    const d = decideReap(subject({ proc: p, now: row(p, { command: EXTERNAL }) }));
    return ok('reused by command', d.act === 'refuse' && d.reason === 'reused' && d.why.includes('different command'), d.act === 'refuse' ? d.why : d.act);
  }),

  test('without a start time on either side there is no identity, and no signal', () => {
    const p = proc({ startedAt: null });
    return ok('no-identity both ways',
      refusal(subject({ proc: p, now: row(p) })) === 'no-identity'
      && refusal(subject({ now: row(proc(), { startedAt: null }) })) === 'no-identity');
  }),

  test('when every gate is crossed the decision is terminate, with one line of evidence per fact', () => {
    const d = decideReap(subject());
    return ok('terminate with four facts',
      d.act === 'terminate' && d.evidence.length === 4
      && d.evidence[0]!.includes('spawn record') && d.evidence[1]!.includes('runs claude')
      && d.evidence[2]!.includes('pane') && d.evidence[3]!.includes('start time and command line'),
      d.act === 'terminate' ? d.evidence.join(' | ') : d.act);
  }),

  /* ── la forma del resultado ────────────────────────────────────── */

  test('a stop outcome always says the session and the process separately', () => {
    const freed = describeStop({ session: { stopped: true, detail: 'orca-2 salió con Ctrl-C' }, process: { result: 'freed', pid: 36570, rssBytes: 612 * 1024 * 1024, signal: 'TERM', why: 'exited on SIGTERM' } });
    const kept = describeStop({ session: { stopped: true, detail: 'orca-2 salió con Ctrl-C' }, process: { result: 'kept', pid: 36570, rssBytes: 464 * 1024 * 1024, reason: 'reused', why: 'pid 36570 was reused' } });
    const none = describeStop({ session: { stopped: false, detail: 'el pane sigue' }, process: { result: 'unknown', why: 'not attempted' } });
    return ok('freed says the bytes; kept says stopped AND not freed; a failed stop says NO detenida',
      freed.startsWith('sesión detenida') && freed.includes('36570 liberado') && freed.includes('612M')
      && kept.startsWith('sesión detenida') && kept.includes('NO liberado') && kept.includes('464M') && kept.includes('reused')
      && none.startsWith('sesión NO detenida'),
      `${freed} || ${kept} || ${none}`);
  }),

  test('describeProcess names SIGKILL when that is what it took, and says unknown honestly', () => {
    return ok('signal and unknown',
      describeProcess({ result: 'freed', pid: 1, rssBytes: null, signal: 'KILL', why: '' }).includes('SIGKILL')
      && describeProcess({ result: 'unknown', why: 'ORCA never observed a pid' }).includes('never observed'));
  }),

  /* ── el panel ──────────────────────────────────────────────────── */

  test('a stopped session with a live process is a stray with its cost on the label, and the sum only counts those', () => {
    const p = proc();
    const offered = sessionStray({ proc: p, callsign: 'K9', state: 'done', rssBytes: 612 * 1024 * 1024, pane: null }, decideReap(subject({ proc: p })));
    const external = sessionStray({ proc: p, callsign: 'orca-f0', state: 'idle', rssBytes: 500 * 1024 * 1024, pane: null },
      decideReap(subject({ proc: p, agent: { callsign: 'orca-f0', origin: 'external' } })));
    const reused = sessionStray({ proc: p, callsign: 'K9', state: 'done', rssBytes: 1, pane: null },
      decideReap(subject({ proc: p, now: row(p, { command: EXTERNAL }) })));
    const gone = sessionStray({ proc: p, callsign: 'K9', state: 'done', rssBytes: null, pane: null }, decideReap(subject({ proc: p, now: undefined })));
    const sum = retainedBySessions([offered!, external!, reused!]);
    return ok('orphan with 612M on the label · external protected · reused ambiguous · gone not listed · sum = 1 × 612M',
      offered?.kind === 'session' && offered.verdict === 'orphan' && offered.action === 'terminate'
      && offered.label === 'K9 · done · 612M retained' && offered.rssBytes === 612 * 1024 * 1024 && offered.agentId === SID
      && external?.verdict === 'protected' && external.action === 'none' && (external.why ?? '').includes('external')
      && reused?.verdict === 'ambiguous' && reused.action === 'none'
      && gone === null
      && sum.count === 1 && sum.bytes === 612 * 1024 * 1024,
      `${offered?.label} / ${external?.verdict} / ${reused?.verdict} / ${sum.count}×${sum.bytes}`);
  }),
];

export default { suite: 'reap · rules', tests } satisfies TestModule;
