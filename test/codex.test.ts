/**
 * Codex como segundo runtime.
 *
 * Las líneas de aquí son las que escribe codex-cli 0.153.4 en su rollout,
 * recortadas. Lo que se prueba es que se convierten en el mismo `Agent` que
 * una sesión de Claude: estado, prompt, lo último que dijo, la tool abierta,
 * los tokens. Y que el watcher encuentra los rollouts en su layout de fechas,
 * y que el argv de lanzamiento traduce la postura de permisos de ORCA.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexDeriver } from '../src/collector/codex.ts';
import { codexArgv, CODEX_TITLE_CONFIG } from '../src/collector/commands.ts';
import { TranscriptWatcher, codexRef, type LineBatch } from '../src/collector/watch.ts';
import { ok, eq, test, sleep, type TestModule } from './harness.ts';

const SID = '01a07208-9b2e-7392-b78c-023d6329cf4c';
const CWD = '/Users/dan/projects/dijosi';

function ref() {
  return { path: `/tmp/rollout-2026-09-05T14-46-01-${SID}.jsonl`, slug: '', sessionId: SID, agentId: null, metaPath: null, workflowId: null, key: SID };
}
function batch(lines: Record<string, unknown>[], bootstrap = false): LineBatch {
  return { ref: ref(), lines, bootstrap, mtimeMs: Date.now(), at: Date.now() };
}
const ts = (offsetMs: number) => new Date(Date.now() - 5000 + offsetMs).toISOString();

const META = { timestamp: ts(0), type: 'session_meta', payload: { session_id: SID, id: SID, timestamp: ts(0), cwd: CWD, originator: 'codex-tui', cli_version: '0.153.4', model_provider: 'openai' } };
const STARTED = { timestamp: ts(10), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } };
const AGENTS_MD = { timestamp: ts(11), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>…' }] } };
const PROMPT = { timestamp: ts(12), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Evalúa el agente de invitados y propón un plan.' }] } } };
const SAY = { timestamp: ts(20), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Voy a revisar cómo funciona el agente.' }], phase: 'commentary' } };
const CALL = { timestamp: ts(30), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: 'rg --files -g AGENTS.md' } };
const OUT = { timestamp: ts(40), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'ok' }] } };
const TOKENS = { timestamp: ts(41), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 19172, cached_input_tokens: 11904, output_tokens: 145, reasoning_output_tokens: 7 } } } };
const MODEL = { timestamp: ts(42), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra', approval_policy: 'on-request' } } };
const DONE = { timestamp: ts(50), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Sí, vale la pena evolucionarlo.' } };

function alive(d: CodexDeriver, pane = true) {
  d.setLiveness({ alive: true, background: false, shortId: null, pid: 1, name: null, startedAt: null, cliState: null, pane });
}

const tests = [
  test('codex: conversation preserves prompts, reasoning, tools and results without mirrored messages', () => {
    const d = new CodexDeriver(ref(), 'm1', 'p1');
    const mirror = { ...SAY, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: SAY.payload.content } } };
    const reasoning = { timestamp: ts(25), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checking the project' }], encrypted_content: 'must-never-appear' } };
    d.ingest(batch([META, STARTED, AGENTS_MD, PROMPT, SAY, mirror, reasoning, CALL, OUT]));
    const talk = d.drainTalk();
    const replay = new CodexDeriver(ref(), 'm1', 'p1');
    replay.ingest(batch([META, STARTED, AGENTS_MD, PROMPT, SAY, mirror, reasoning, CALL, OUT], true));
    return ok('chronological, paired, stable, drained',
      talk.map((t) => t.kind).join(',') === 'prompt,say,thinking,tool,result'
      && talk[2]!.text === 'Checking the project'
      && talk[3]!.toolUseId === talk[4]!.toolUseId && talk[4]!.text === 'ok'
      && replay.drainTalk().map((t) => t.id).join(',') === talk.map((t) => t.id).join(',')
      && d.drainTalk().length === 0);
  }),
  test('codex: identical prompts in separate turns remain separate exchanges', () => {
    const d = new CodexDeriver(ref(), 'm1', 'p1');
    d.ingest(batch([STARTED, PROMPT, { ...STARTED, timestamp: ts(100) }, { ...PROMPT, timestamp: ts(110) }]));
    return eq('two prompts', d.drainTalk().map((t) => t.kind), ['prompt', 'prompt']);
  }),
  test('codex: el rollout se convierte en un agente con runtime codex, cwd y prompt', () => {
    const d = new CodexDeriver(ref(), 'm1', 'p1');
    alive(d);
    d.ingest(batch([META, STARTED, AGENTS_MD, PROMPT, SAY]));
    const a = d.snapshot();
    return ok('codex: el rollout se convierte en un agente con runtime codex, cwd y prompt',
      a.runtime === 'codex' && d.cwd === CWD && a.lastPrompt === 'Evalúa el agente de invitados y propón un plan.'
      && a.title === 'Evalúa el agente de invitados y propón un plan.' && a.lastSay === 'Voy a revisar cómo funciona el agente.',
      `runtime=${a.runtime} cwd=${d.cwd} prompt="${a.lastPrompt}" title="${a.title}"`);
  }),

  test('codex: AGENTS.md no es el prompt del humano', () => {
    const d = new CodexDeriver(ref(), 'm1', 'p1');
    alive(d);
    d.ingest(batch([META, STARTED, AGENTS_MD]));
    return eq('codex: AGENTS.md no es el prompt del humano', d.snapshot().lastPrompt, null);
  }),

  test('codex: turno abierto sin tool es thinking, con tool es working, cerrado es idle', () => {
    const d = new CodexDeriver(ref(), 'm1', 'p1');
    alive(d);
    d.ingest(batch([META, STARTED, PROMPT, SAY]));
    const thinking = d.state();
    d.ingest(batch([CALL]));
    const working = d.state();
    const tool = d.snapshot().tool;
    d.ingest(batch([OUT]));
    const afterOut = d.state();
    d.ingest(batch([DONE]));
    const idle = d.state();
    return ok('codex: turno abierto sin tool es thinking, con tool es working, cerrado es idle',
      thinking === 'thinking' && working === 'working' && tool === 'exec' && afterOut === 'thinking' && idle === 'idle',
      `${thinking} → ${working}(${tool}) → ${afterOut} → ${idle}`);
  }),

  test('codex: task_complete deja lo último que dijo y el modelo viene de thread_settings', () => {
    const d = new CodexDeriver(ref(), 'm1', 'p1');
    alive(d);
    d.ingest(batch([META, STARTED, PROMPT, MODEL, DONE]));
    const a = d.snapshot();
    return ok('codex: task_complete deja lo último que dijo y el modelo viene de thread_settings',
      a.lastSay === 'Sí, vale la pena evolucionarlo.' && a.model === 'gpt-6-astra' && a.metrics.turns === 1,
      `say="${a.lastSay}" model=${a.model} turns=${a.metrics.turns}`);
  }),

  /*
   * El modelo, en el hueco que dejaba `thread_settings_applied`.
   *
   * Una sesión preparada por un traspaso nace de un `codex exec` y ese evento
   * no llega hasta que la TUI aplica sus ajustes — 79 segundos y un mensaje
   * humano después, medido en un relevo real el 2026-09-08. `turn_context` lo
   * dice desde el primer turno, y en ese hueco la consola anunciaba
   * «model unknown» sobre un CAPCOM que sí sabía con qué corría.
   */
  test('codex: el modelo se sabe desde el primer turn_context, sin esperar a thread_settings', () => {
    const d = new CodexDeriver(ref(), 'm1', 'p1');
    alive(d);
    const context = { timestamp: ts(11), type: 'turn_context', payload: { cwd: CWD, model: 'gpt-6-astra', approval_policy: 'never', sandbox_policy: { type: 'read-only' } } };
    d.ingest(batch([META, STARTED, context, PROMPT, DONE]));
    const early = d.snapshot();
    const late = new CodexDeriver(ref(), 'm1', 'p1');
    late.ingest(batch([META, STARTED, context, PROMPT, DONE, MODEL]));
    return ok('codex: el modelo se sabe desde el primer turn_context, sin esperar a thread_settings',
      early.model === 'gpt-6-astra' && late.snapshot().model === 'gpt-6-astra',
      `turn_context=${early.model} con thread_settings=${late.snapshot().model}`);
  }),

  test('codex: los tokens vienen de token_count y el costo es cero (suscripción)', () => {
    const d = new CodexDeriver(ref(), 'm1', 'p1');
    alive(d);
    d.ingest(batch([META, STARTED, PROMPT, SAY, CALL, OUT, TOKENS, DONE]));
    const m = d.snapshot().metrics;
    return ok('codex: los tokens vienen de token_count y el costo es cero (suscripción)',
      m.inputTokens === 19172 && m.cacheReadTokens === 11904 && m.outputTokens === 145 && m.thinkingTokens === 7 && m.costUSD === 0 && m.toolCalls === 1,
      JSON.stringify({ in: m.inputTokens, cached: m.cacheReadTokens, out: m.outputTokens, think: m.thinkingTokens, cost: m.costUSD, tools: m.toolCalls }));
  }),

  test('codex: las compactaciones se cuentan y la ventana se mide con el último prompt, no con el acumulado', () => {
    const d = new CodexDeriver(ref(), 'm1', 'p1');
    alive(d);
    // Lo que escribe el CLI de verdad: el acumulado del hilo, el del último
    // turno —que es lo que está EN la ventana— y el tamaño de la ventana.
    const FULL = { timestamp: ts(41), type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 2_045_906, cached_input_tokens: 1_393_536, output_tokens: 2746, reasoning_output_tokens: 1188 },
      last_token_usage: { input_tokens: 122_651, cached_input_tokens: 121_600, output_tokens: 170, reasoning_output_tokens: 78 },
      model_context_window: 258_400,
    } } };
    const COMPACTED = { timestamp: ts(45), type: 'compacted', payload: { message: '', replacement_history: [] } };
    d.ingest(batch([META, STARTED, PROMPT, SAY, COMPACTED, FULL, { ...COMPACTED, timestamp: ts(46) }, DONE]));
    const m = d.snapshot().metrics;
    return ok('codex: compactaciones contadas y ventana medida por el último turno',
      m.compactions === 2 && m.contextTokens === 122_651 && m.contextWindow === 258_400 && m.inputTokens === 2_045_906,
      `${m.compactions} compactaciones · ${m.contextTokens}/${m.contextWindow} en la ventana · ${m.inputTokens} acumulados`);
  }),

  test('codex: una tool abierta 90s bajo una política que puede preguntar es un bloqueo de permiso', () => {
    const d = new CodexDeriver(ref(), 'm1', 'p1');
    alive(d);
    const old = { ...CALL, timestamp: new Date(Date.now() - 120_000).toISOString() };
    d.ingest(batch([META, STARTED, PROMPT, SAY, MODEL, old]));
    const blocked = d.state();
    const b = d.blockOf();
    const d2 = new CodexDeriver(ref(), 'm1', 'p1');
    alive(d2);
    const never = { ...MODEL, payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra', approval_policy: 'never' } } };
    d2.ingest(batch([META, STARTED, PROMPT, SAY, never, old]));
    return ok('codex: una tool abierta 90s bajo una política que puede preguntar es un bloqueo de permiso',
      blocked === 'blocked' && b?.kind === 'permission' && d2.state() === 'working',
      `on-request → ${blocked} (${b?.kind}); never → ${d2.state()}`);
  }),

  test('codex: sin proceso y con el archivo quieto un minuto, la sesión está done', () => {
    const d = new CodexDeriver(ref(), 'm1', 'p1', Date.now() - 120_000);
    const b = batch([META, STARTED, PROMPT, SAY, DONE]);
    b.mtimeMs = Date.now() - 120_000;
    const oldLines = b.lines.map((l) => ({ ...l, timestamp: new Date(Date.now() - 120_000).toISOString() }));
    d.ingest({ ...b, lines: oldLines });
    return eq('codex: sin proceso y con el archivo quieto un minuto, la sesión está done', d.state(), 'done');
  }),

  test('codex: el nombre del rollout da la sesión; otros archivos se ignoran', () => {
    const r = codexRef('/x/2026/09/05', `rollout-2026-09-05T22-46-01-${SID}.jsonl`);
    const bad = codexRef('/x/2026/09/05', 'notes.txt');
    return ok('codex: el nombre del rollout da la sesión; otros archivos se ignoran',
      r?.sessionId === SID && r.key === SID && r.slug === '' && bad === null, `${r?.key}`);
  }),

  test('codex: el watcher descubre rollouts en YYYY/MM/DD y su primer lote trae el session_meta', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-'));
    try {
      /*
       * El día de HOY, no una fecha escrita a mano.
       *
       * El escaneo de Codex descarta directorios de día que caen fuera de la
       * ventana de flota, así que un `2026/09/05` fijo dejó de descubrirse el
       * 2026-09-08 sin que cambiara una línea de `watch.ts`: la prueba llevaba
       * dentro su propia fecha de caducidad.
       */
      const now = new Date();
      const yyyy = String(now.getUTCFullYear());
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(now.getUTCDate()).padStart(2, '0');
      const day = join(root, yyyy, mm, dd);
      mkdirSync(day, { recursive: true });
      writeFileSync(join(day, `rollout-${yyyy}-${mm}-${dd}T22-46-01-${SID}.jsonl`), [META, STARTED, PROMPT].map((l) => JSON.stringify(l)).join('\n') + '\n');
      writeFileSync(join(day, 'unrelated.jsonl'), '{}\n');
      const w = new TranscriptWatcher({ layout: 'codex', root, pollMs: 200, rescanMs: 500 });
      const got: LineBatch[] = [];
      w.onLines((b) => got.push(b));
      await w.start();
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !got.length) await sleep(30);
      w.stop();
      const b = got[0];
      return ok('codex: el watcher descubre rollouts en YYYY/MM/DD y su primer lote trae el session_meta',
        !!b && b.ref.key === SID && b.lines.some((l) => l['type'] === 'session_meta') && got.every((x) => x.ref.key === SID),
        b ? `${b.lines.length} líneas, key ${b.ref.key}` : 'sin lotes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }),

  test('codex: el argv traduce la postura de permisos y deja el prompt al final', () => {
    const no = {} as NodeJS.ProcessEnv;
    const auto = codexArgv('/bin/codex', '/p', { prompt: 'hola' }, no);
    const plan = codexArgv('/bin/codex', '/p', { prompt: 'hola', permissionMode: 'plan', model: 'gpt-6-astra' }, no);
    const dash = codexArgv('/bin/codex', '/p', { prompt: '-rf everything' }, no);
    const bad = codexArgv('/bin/codex', '/p', { prompt: 'x', permissionMode: 'yolo' }, no);
    const semi = codexArgv('/bin/codex', '/p', { prompt: ';' }, no);
    const unsandboxed = '--dangerously-bypass-approvals-and-sandbox';
    // El `-c` del título va en todo lanzamiento: es de dónde sale la señal de
    // «esperando respuesta» que no depende de leer la pantalla.
    const head = `/bin/codex -C /p -c ${CODEX_TITLE_CONFIG}`;
    return ok('codex: el argv traduce la postura de permisos y deja el prompt al final',
      auto.ok && auto.argv.join(' ') === `${head} ${unsandboxed} hola`
      && plan.ok && plan.argv.join(' ') === `${head} -m gpt-6-astra -s read-only hola`
      && dash.ok && dash.argv[dash.argv.length - 1] === ' -rf everything'
      && !bad.ok && semi.ok && semi.argv[semi.argv.length - 1] === ';',
      auto.ok ? auto.argv.join(' ') : auto.detail);
  }),

  /*
   * El sandbox de Codex corta la red, así que `auto` lanza sin él y un worker
   * con navegador funciona. Lo que se prueba aquí es que la vuelta atrás existe
   * y que ningún modo emite ya `-a untrusted`: 0.153.4 sólo acepta `on-request`
   * y `never`, y ese argv lo rechazaba el CLI antes de arrancar la sesión.
   */
  test('codex: ORCA_CODEX_APPROVALS=1 devuelve las aprobaciones y nadie pide untrusted', () => {
    const asks = { ORCA_CODEX_APPROVALS: '1' } as NodeJS.ProcessEnv;
    const no = {} as NodeJS.ProcessEnv;
    const back = codexArgv('/bin/codex', '/p', { prompt: 'hola' }, asks);
    const explicit = codexArgv('/bin/codex', '/p', { prompt: 'hola', permissionMode: 'bypassPermissions' }, asks);
    const modes = ['auto', 'acceptEdits', 'manual', 'plan', 'dontAsk', 'bypassPermissions', undefined];
    const argvs = modes.flatMap((permissionMode) => [asks, no].map((env) => codexArgv('/bin/codex', '/p', { prompt: 'x', permissionMode }, env)));
    const policies = argvs.flatMap((r) => (r.ok ? r.argv.map((a, n) => (r.argv[n - 1] === '-a' ? a : null)) : [])).filter(Boolean);
    return ok('codex: ORCA_CODEX_APPROVALS=1 devuelve las aprobaciones y nadie pide untrusted',
      back.ok && back.argv.join(' ') === `/bin/codex -C /p -c ${CODEX_TITLE_CONFIG} -a on-request -s workspace-write hola`
      // El título se fuerza en todas las posturas, o la señal se pierde justo
      // en la que sí puede quedarse esperando una respuesta.
      && argvs.every((r) => r.ok && r.argv.includes(CODEX_TITLE_CONFIG))
      // Pedido a mano, el bypass manda: la variable sólo mueve el default.
      && explicit.ok && explicit.argv.includes('--dangerously-bypass-approvals-and-sandbox')
      && argvs.every((r) => r.ok)
      && policies.length > 0 && policies.every((p) => p === 'on-request' || p === 'never'),
      policies.join(','));
  }),
];

const suite: TestModule = { suite: 'collector · codex', tests };
export default suite;
