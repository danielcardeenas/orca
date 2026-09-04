/**
 * Tests del collector. Runner casero: cada test es una función que devuelve
 * {name, pass, detail}. Sin framework, sin dependencias nuevas.
 *
 *   npx tsx test/collector.test.ts
 *
 * Nada aquí toca ~/.claude ni ~/.orca reales: todo corre en un directorio
 * temporal propio. Los transcripts reales del usuario son sólo de lectura y se
 * ejercen desde `npx tsx src/collector/index.ts --diag`.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CallsignBook, SessionDeriver, toolDetail } from '../src/collector/derive.ts';
import { EscalationWatcher, escalationId } from '../src/collector/escalate.ts';
import { KeyVault } from '../src/collector/keys.ts';
import { LineageIndex } from '../src/collector/lineage.ts';
import { matchesSlug, probeSlug } from '../src/collector/projects.ts';
import { extractShortId } from '../src/collector/commands.ts';
import { diffAgent, rollup } from '../src/collector/index.ts';
import { stableCallsign, isInside, safeJson, oneLine } from '../src/collector/util.ts';
import { TranscriptWatcher, parseLines } from '../src/collector/watch.ts';
import type { LineBatch, TranscriptRef } from '../src/collector/watch.ts';
import type { Agent } from '../src/shared/types.ts';

export interface TestResult { name: string; pass: boolean; detail: string; }

type Test = () => Promise<TestResult> | TestResult;

/* ── andamiaje ────────────────────────────────────────────────────── */

let tmpRoot = '';
function tmp(sub: string): string {
  const d = path.join(tmpRoot, sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function ok(name: string, detail = ''): TestResult {
  return { name, pass: true, detail };
}
function fail(name: string, detail: string): TestResult {
  return { name, pass: false, detail };
}
async function check(name: string, fn: () => void | Promise<void>): Promise<TestResult> {
  try { await fn(); return ok(name); } catch (err) {
    return fail(name, err instanceof Error ? err.message : String(err));
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Un TranscriptRef sintético. */
function ref(sessionId: string, file: string): TranscriptRef {
  return {
    path: file, slug: '-tmp-proj', sessionId, agentId: null,
    metaPath: null, workflowId: null, key: sessionId,
  };
}

function batch(
  r: TranscriptRef, lines: Record<string, unknown>[], mtimeMs = Date.now(),
): LineBatch {
  return { ref: r, lines, bootstrap: false, mtimeMs, at: Date.now() };
}

const SID = '11111111-2222-3333-4444-555555555555';

/* Constructores de líneas con la forma REAL de Claude Code 2.1.260. */

function assistantLine(o: {
  at: number; stop: string | null; text?: string; thinking?: boolean;
  tool?: { id: string; name: string; input: Record<string, unknown> };
  outputTokens?: number;
}): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (o.thinking) content.push({ type: 'thinking', thinking: 'mmm' });
  if (o.text) content.push({ type: 'text', text: o.text });
  if (o.tool) content.push({ type: 'tool_use', id: o.tool.id, name: o.tool.name, input: o.tool.input });
  return {
    type: 'assistant',
    timestamp: new Date(o.at).toISOString(),
    sessionId: SID,
    cwd: '/tmp/proj',
    message: {
      model: 'claude-opus-5',
      stop_reason: o.stop,
      content,
      usage: {
        input_tokens: 2,
        output_tokens: o.outputTokens ?? 100,
        cache_read_input_tokens: 5000,
        output_tokens_details: { thinking_tokens: o.thinking ? 40 : 0 },
      },
    },
  };
}

function toolResultLine(at: number, toolUseId: string): Record<string, unknown> {
  return {
    type: 'user', timestamp: new Date(at).toISOString(), sessionId: SID,
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: false }] },
  };
}

function promptLine(at: number, text: string): Record<string, unknown> {
  return {
    type: 'user', timestamp: new Date(at).toISOString(), sessionId: SID,
    message: { content: text },
  };
}

const ALIVE = {
  alive: true, background: false, shortId: null, pid: 1234,
  name: 'test', startedAt: null, cliState: 'running',
};
const DEAD = {
  alive: false, background: false, shortId: null, pid: null,
  name: null, startedAt: null, cliState: null,
};

/* ── 1. máquina de estados ────────────────────────────────────────── */

const testBooting: Test = () => check('derive: booting sin líneas assistant', () => {
  const d = new SessionDeriver(ref(SID, '/tmp/x.jsonl'), 'm1', 'p1');
  d.setLiveness(ALIVE);
  d.ingest(batch(ref(SID, '/tmp/x.jsonl'), [
    { type: 'ai-title', aiTitle: 'Arrancando', sessionId: SID },
    promptLine(Date.now(), 'haz algo'),
  ]));
  assert.strictEqual(d.state(), 'booting');
  assert.strictEqual(d.snapshot().title, 'Arrancando');
});

const testThinking: Test = () => check('derive: thinking con stop_reason null', () => {
  const now = Date.now();
  const r = ref(SID, '/tmp/x.jsonl');
  const d = new SessionDeriver(r, 'm1', 'p1');
  d.setLiveness(ALIVE);
  d.ingest(batch(r, [assistantLine({ at: now, stop: null, thinking: true, text: 'Voy a ver' })]));
  assert.strictEqual(d.state(now), 'thinking');
  assert.strictEqual(d.snapshot(now).lastSay, 'Voy a ver');
  assert.strictEqual(d.snapshot(now).tool, null);
});

const testWorking: Test = () => check('derive: working con tool_use sin resultado', () => {
  const now = Date.now();
  const r = ref(SID, '/tmp/x.jsonl');
  const d = new SessionDeriver(r, 'm1', 'p1');
  d.setLiveness(ALIVE);
  d.ingest(batch(r, [assistantLine({
    at: now, stop: 'tool_use',
    tool: { id: 'toolu_1', name: 'Bash', input: { command: 'npm test', description: 'corre tests' } },
  })]));
  const s = d.snapshot(now);
  assert.strictEqual(s.state, 'working');
  assert.strictEqual(s.tool, 'Bash');
  assert.strictEqual(s.toolDetail, 'npm test', `toolDetail fue ${s.toolDetail}`);
  assert.strictEqual(s.metrics.toolCalls, 1);
});

const testWorkingToIdle: Test = () => check('derive: tool_result cierra el tool, end_turn → idle', () => {
  const now = Date.now();
  const r = ref(SID, '/tmp/x.jsonl');
  const d = new SessionDeriver(r, 'm1', 'p1');
  d.setLiveness(ALIVE);
  d.ingest(batch(r, [
    assistantLine({ at: now, stop: 'tool_use', tool: { id: 'toolu_1', name: 'Read', input: { file_path: '/a/b.ts' } } }),
  ]));
  assert.strictEqual(d.state(now), 'working');
  assert.strictEqual(d.snapshot(now).toolDetail, '/a/b.ts');
  d.ingest(batch(r, [toolResultLine(now + 100, 'toolu_1')]));
  // sin nuevo assistant: el último stop_reason sigue siendo tool_use, pero ya
  // no hay tools pendientes ⇒ está pensando la respuesta, no ejecutando.
  assert.strictEqual(d.state(now + 200), 'working', 'stop_reason tool_use sigue mandando');
  d.ingest(batch(r, [assistantLine({ at: now + 300, stop: 'end_turn', text: 'Listo' })]));
  const s = d.snapshot(now + 400);
  assert.strictEqual(s.state, 'idle');
  assert.strictEqual(s.tool, null, 'idle no puede reportar tool');
  assert.strictEqual(s.lastSay, 'Listo');
});

const testBlockedByAsk: Test = () => check('derive: AskUserQuestion bloquea de inmediato', () => {
  const now = Date.now();
  const r = ref(SID, '/tmp/x.jsonl');
  const d = new SessionDeriver(r, 'm1', 'p1');
  d.setLiveness(ALIVE);
  d.ingest(batch(r, [assistantLine({
    at: now, stop: 'tool_use',
    tool: {
      id: 'toolu_ask', name: 'AskUserQuestion',
      input: { questions: [{ question: '¿Desplegamos a prod?', header: 'Deploy', options: [] }] },
    },
  })]));
  const s = d.snapshot(now + 1000); // 1s: muy por debajo de los 90s de permisos
  assert.strictEqual(s.state, 'blocked');
  assert.strictEqual(s.block?.kind, 'question');
  assert.strictEqual(s.block?.summary, '¿Desplegamos a prod?');
});

const testBlockedByPermission: Test = () => check('derive: tool gated colgado >90s en modo manual → blocked', () => {
  const now = Date.now();
  const r = ref(SID, '/tmp/x.jsonl');
  const d = new SessionDeriver(r, 'm1', 'p1');
  d.setLiveness(ALIVE);
  d.ingest(batch(r, [
    { type: 'permission-mode', permissionMode: 'manual', sessionId: SID },
    assistantLine({ at: now, stop: 'tool_use', tool: { id: 't', name: 'Bash', input: { command: 'rm -rf build' } } }),
  ]));
  assert.strictEqual(d.state(now + 10_000), 'working', 'a los 10s todavía es trabajo normal');
  const s = d.snapshot(now + 95_000);
  assert.strictEqual(s.state, 'blocked');
  assert.strictEqual(s.block?.kind, 'permission');
  assert.ok(s.block?.summary.includes('rm -rf build'), s.block?.summary);
});

const testNotBlockedInAutoMode: Test = () => check('derive: en modo auto un tool largo NO es bloqueo', () => {
  const now = Date.now();
  const r = ref(SID, '/tmp/x.jsonl');
  const d = new SessionDeriver(r, 'm1', 'p1');
  d.setLiveness(ALIVE);
  d.ingest(batch(r, [
    { type: 'permission-mode', permissionMode: 'auto', sessionId: SID },
    assistantLine({ at: now, stop: 'tool_use', tool: { id: 't', name: 'Bash', input: { command: 'npm run build' } } }),
  ]));
  assert.strictEqual(d.state(now + 600_000), 'working');
});

const testBlockedByEscalation: Test = () => check('derive: una escalación abierta gana sobre todo', () => {
  const now = Date.now();
  const r = ref(SID, '/tmp/x.jsonl');
  const d = new SessionDeriver(r, 'm1', 'p1');
  d.setLiveness(ALIVE);
  d.ingest(batch(r, [assistantLine({ at: now, stop: 'end_turn', text: 'ok' })]));
  assert.strictEqual(d.state(now), 'idle');
  d.setBlock({ kind: 'question', summary: '¿qué API key uso?', escalationId: 'esc_x', since: now });
  const s = d.snapshot(now);
  assert.strictEqual(s.state, 'blocked');
  assert.strictEqual(s.block?.escalationId, 'esc_x');
});

const testDoneVsDead: Test = () => check('derive: done tras end_turn limpio, dead sin assistant', () => {
  const past = Date.now() - 10 * 60_000;
  const r = ref(SID, '/tmp/x.jsonl');

  const clean = new SessionDeriver(r, 'm1', 'p1', past);
  clean.ingest(batch(r, [assistantLine({ at: past, stop: 'end_turn', text: 'terminado' })], past));
  clean.setLiveness(DEAD);
  assert.strictEqual(clean.state(), 'done');

  const never = new SessionDeriver(r, 'm1', 'p1', past);
  never.ingest(batch(r, [promptLine(past, 'hola')], past));
  never.setLiveness(DEAD);
  assert.strictEqual(never.state(), 'dead', 'sin ninguna assistant nunca arrancó');
});

const testNoPrematureReap: Test = () => check('derive: proceso ausente pero archivo fresco no es done', () => {
  const now = Date.now();
  const r = ref(SID, '/tmp/x.jsonl');
  const d = new SessionDeriver(r, 'm1', 'p1', now);
  d.ingest(batch(r, [assistantLine({ at: now, stop: 'end_turn', text: 'x' })]));
  d.setLiveness(DEAD);
  // El poll del CLI y el del disco corren a ritmos distintos: no declaramos el
  // final hasta que el archivo también lleve un minuto quieto.
  assert.strictEqual(d.state(now), 'idle');
});

/* ── 2. métricas ──────────────────────────────────────────────────── */

const testCostState: Test = () => check('derive: cost-state es autoritativo y resetea lo acumulado', () => {
  const now = Date.now();
  const r = ref(SID, '/tmp/x.jsonl');
  const d = new SessionDeriver(r, 'm1', 'p1');
  d.ingest(batch(r, [
    assistantLine({ at: now, stop: 'end_turn', outputTokens: 500 }),
    {
      type: 'cost-state', sessionId: SID, totalCostUSD: 8.92,
      totalAPIDuration: 1649900, totalToolDuration: 200903,
      totalLinesAdded: 12, totalLinesRemoved: 3, startTime: now - 60_000,
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 1000, outputTokens: 9000, thinkingTokens: 700,
          cacheReadInputTokens: 400_000, costUSD: 8.92,
        },
      },
    },
  ]));
  const m = d.metrics(now);
  assert.strictEqual(m.costUSD, 8.92);
  assert.strictEqual(m.outputTokens, 9000, 'los 500 previos ya están dentro del total');
  assert.strictEqual(m.thinkingTokens, 700);
  assert.strictEqual(m.cacheReadTokens, 400_000);
  assert.strictEqual(m.linesAdded, 12);
  assert.strictEqual(m.apiDurationMs, 1649900);
  // Lo que llegue DESPUÉS del cost-state sí se suma.
  d.ingest(batch(r, [assistantLine({ at: now + 1000, stop: 'end_turn', outputTokens: 100 })]));
  assert.strictEqual(d.metrics(now + 1000).outputTokens, 9100);
});

const testTokensPerSec: Test = () => check('derive: tokens/s es una media móvil suave que decae a 0', () => {
  const t0 = Date.now();
  const r = ref(SID, '/tmp/x.jsonl');
  const d = new SessionDeriver(r, 'm1', 'p1');
  d.setLiveness(ALIVE);

  // Ráfaga sostenida: 60 tokens por segundo durante 40s.
  const series: number[] = [];
  for (let i = 0; i < 40; i++) {
    const at = t0 + i * 1000;
    d.ingest(batch(r, [assistantLine({ at, stop: 'tool_use', outputTokens: 60 })], at));
    series.push(d.tokensPerSec(at));
  }
  const settled = series[series.length - 1]!;
  assert.ok(settled > 40 && settled < 90, `debería rondar 60 tok/s, dio ${settled}`);

  // La propiedad que le importa a la escena 3D: la señal no salta. Con el EMA
  // ningún paso de 1s puede más que duplicar el valor anterior una vez que
  // arrancó, así que la amplitud del movimiento se ve continua, no epiléptica.
  for (let i = 6; i < series.length; i++) {
    const prev = series[i - 1]!;
    const cur = series[i]!;
    assert.ok(Math.abs(cur - prev) <= Math.max(8, prev * 0.5),
      `salto brusco en el paso ${i}: ${prev} → ${cur}`);
  }

  // Un pico aislado no puede disparar la métrica al infinito.
  const spikeAt = t0 + 40_000;
  d.ingest(batch(r, [assistantLine({ at: spikeAt, stop: 'tool_use', outputTokens: 20_000 })], spikeAt));
  const spike = d.tokensPerSec(spikeAt);
  assert.ok(spike < 1000, `el pico desbordó la media: ${spike}`);

  // Silencio: sin mensajes nuevos tiene que caer a 0 y quedarse ahí.
  let late = 0;
  for (let i = 1; i <= 60; i++) late = d.tokensPerSec(spikeAt + i * 5000);
  assert.strictEqual(late, 0, `no decayó tras 5 minutos de silencio: ${late}`);

  // Y evaluar dos veces el mismo instante no mueve nada (snapshot() es seguro).
  assert.strictEqual(d.tokensPerSec(spikeAt + 300_000), d.tokensPerSec(spikeAt + 300_000));
});

const testTurnsAndUptime: Test = () => check('derive: turns, uptimeMs y updatedAt', () => {
  const start = Date.now() - 3600_000;
  const r = ref(SID, '/tmp/x.jsonl');
  const d = new SessionDeriver(r, 'm1', 'p1', start);
  d.ingest(batch(r, [
    promptLine(start, 'primero'),
    assistantLine({ at: start + 1000, stop: 'tool_use', tool: { id: 'a', name: 'Bash', input: { command: 'ls' } } }),
    toolResultLine(start + 2000, 'a'),
    assistantLine({ at: start + 3000, stop: 'end_turn', text: 'hecho' }),
    promptLine(start + 4000, 'segundo'),
    assistantLine({ at: start + 5000, stop: 'end_turn', text: 'hecho 2' }),
  ]));
  const now = start + 3600_000;
  const s = d.snapshot(now);
  assert.strictEqual(s.metrics.turns, 2, 'dos prompts humanos; los tool_result no cuentan');
  assert.strictEqual(s.metrics.toolCalls, 1);
  assert.ok(Math.abs(s.uptimeMs - 3600_000) < 5000, `uptime raro: ${s.uptimeMs}`);
  assert.strictEqual(s.state, 'idle');
});

const testToolDetail: Test = () => check('derive: toolDetail por tipo de tool', () => {
  assert.strictEqual(toolDetail('Bash', { command: 'git status', description: 'd' }), 'git status');
  assert.strictEqual(toolDetail('Edit', { file_path: '/x/y.ts' }), '/x/y.ts');
  assert.strictEqual(toolDetail('Task', { description: 'buscar refs', prompt: 'largo' }), 'buscar refs');
  assert.strictEqual(toolDetail('Grep', { pattern: 'TODO' }), 'TODO');
  assert.strictEqual(toolDetail('WebFetch', { url: 'https://a.b' }), 'https://a.b');
  assert.strictEqual(
    toolDetail('AskUserQuestion', { questions: [{ question: '¿sí o no?', header: 'H' }] }),
    '¿sí o no?',
  );
  assert.strictEqual(toolDetail('ToolQueNoConozco', { algo: 'valor' }), 'valor');
  assert.strictEqual(toolDetail('Bash', null), '', 'input basura no debe lanzar');
});

/* ── 3. callsigns ─────────────────────────────────────────────────── */

const testCallsigns: Test = () => check('callsign: estable, 2 chars A-Z0-9, sin colisión por proyecto', () => {
  const a = stableCallsign('sesion-uno');
  assert.strictEqual(a, stableCallsign('sesion-uno'), 'debe ser estable entre llamadas');
  assert.match(a, /^[A-Z0-9]{2}$/);

  const book = new CallsignBook();
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const cs = book.assign('proj-1', `agent-${i}`);
    assert.match(cs, /^[A-Z0-9]{2}$/);
    assert.ok(!seen.has(cs), `colisión en ${cs} para agent-${i}`);
    seen.add(cs);
  }
  // Idempotente: pedirlo otra vez devuelve el mismo.
  assert.strictEqual(book.assign('proj-1', 'agent-7'), book.assign('proj-1', 'agent-7'));
  // Otro proyecto puede reusar la misma etiqueta.
  const other = book.assign('proj-2', 'agent-0');
  assert.strictEqual(other, stableCallsign('agent-0'));
});

/* ── 4. tail incremental por offset ───────────────────────────────── */

const testParseLines: Test = () => check('watch: parseLines guarda la cola parcial y tira JSON corrupto', () => {
  const a = parseLines('{"type":"a"}\n{"type":"b"}\n{"type":"par');
  assert.strictEqual(a.lines.length, 2);
  assert.strictEqual(a.rest, '{"type":"par');
  const b = parseLines(a.rest + 'tial"}\n');
  assert.strictEqual(b.lines.length, 1);
  assert.strictEqual((b.lines[0] as Record<string, unknown>)['type'], 'partial');
  assert.strictEqual(b.rest, '');

  const c = parseLines('{roto\n{"type":"ok"}\n\n[1,2]\n');
  assert.strictEqual(c.lines.length, 1, 'sólo el objeto válido sobrevive');
  assert.strictEqual((c.lines[0] as Record<string, unknown>)['type'], 'ok');
});

const testIncrementalTail: Test = async () => {
  const name = 'watch: tail incremental por offset, sin releer ni duplicar';
  const root = tmp('watch-root');
  const slugDir = path.join(root, '-tmp-proj');
  fs.mkdirSync(slugDir, { recursive: true });
  const file = path.join(slugDir, `${SID}.jsonl`);

  // Historia previa de ~6MB: por encima del tope de cola de 4MB, que es la
  // condición que importa (en la máquina real hay transcripts de 80MB).
  const pad = 'x'.repeat(600);
  const history: string[] = [];
  for (let i = 0; i < 10_000; i++) history.push(JSON.stringify({ type: 'attachment', n: i, pad }));
  history.push(JSON.stringify({ type: 'ai-title', aiTitle: 'Histórico', sessionId: SID }));
  fs.writeFileSync(file, history.join('\n') + '\n');
  const sizeAfterHistory = fs.statSync(file).size;
  assert.ok(sizeAfterHistory > 4 * 1024 * 1024, `la historia debe superar 4MB, fue ${sizeAfterHistory}`);

  const w = new TranscriptWatcher({ root, pollMs: 120, rescanMs: 400 });
  const seen: LineBatch[] = [];
  w.onLines((b) => seen.push(b));
  await w.start();
  await sleep(400);

  const boot = seen.filter((b) => b.bootstrap).flatMap((b) => b.lines);
  assert.ok(boot.length > 0, 'el bootstrap no leyó nada');
  assert.ok(boot.length < 10_001, `el bootstrap reprodujo la historia entera (${boot.length})`);
  const ns = boot.filter((l) => typeof l['n'] === 'number').map((l) => l['n'] as number);
  assert.ok(!ns.includes(0), 'leyó desde el principio del archivo en vez de la cola');
  assert.ok(ns.includes(9999), 'no llegó hasta el final del archivo');
  const sawTitle = boot.some((l) => l['type'] === 'ai-title');
  assert.ok(sawTitle, 'perdió el ai-title, que es lo último del archivo');

  // Append en vivo: sólo deben llegar las líneas nuevas.
  seen.length = 0;
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', marker: 'nueva-1' }) + '\n');
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', marker: 'nueva-2' }) + '\n');
  await sleep(600);
  const live = seen.filter((b) => !b.bootstrap).flatMap((b) => b.lines);
  const markers = live.map((l) => l['marker']).filter(Boolean);
  assert.deepStrictEqual(markers, ['nueva-1', 'nueva-2'], `llegaron: ${JSON.stringify(markers)}`);

  // Línea escrita a medias: no se emite hasta que cierra el \n.
  seen.length = 0;
  fs.appendFileSync(file, '{"type":"assistant","marker":"parcia');
  await sleep(400);
  assert.strictEqual(
    seen.flatMap((b) => b.lines).length, 0, 'emitió una línea incompleta',
  );
  fs.appendFileSync(file, 'l"}\n');
  await sleep(500);
  const after = seen.flatMap((b) => b.lines);
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0]?.['marker'], 'parcial');

  // Truncado bajo los pies: el offset se reinicia en vez de leer basura.
  seen.length = 0;
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', marker: 'tras-truncar' }) + '\n');
  await sleep(600);
  const truncated = seen.flatMap((b) => b.lines);
  assert.ok(
    truncated.some((l) => l['marker'] === 'tras-truncar'),
    `no recuperó tras el truncado: ${JSON.stringify(truncated).slice(0, 200)}`,
  );

  w.stop();
  return ok(name, `bootstrap leyó ${boot.length}/10001 líneas de un archivo de `
    + `${(sizeAfterHistory / 1048576).toFixed(1)}MB (ai-title=${sawTitle})`);
};

const testWatcherDiscovery: Test = async () => {
  const name = 'watch: descubre sesiones, subagentes y agentes de workflow';
  const root = tmp('watch-disc');
  const slug = path.join(root, '-tmp-proj');
  const sess = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  fs.mkdirSync(path.join(slug, sess, 'subagents', 'workflows', 'wf_1'), { recursive: true });
  const line = JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n';
  fs.writeFileSync(path.join(slug, `${sess}.jsonl`), line);
  fs.writeFileSync(path.join(slug, sess, 'subagents', 'agent-abc123.jsonl'), line);
  fs.writeFileSync(path.join(slug, sess, 'subagents', 'agent-abc123.meta.json'),
    JSON.stringify({ agentType: 'Explore', description: 'mapear', toolUseId: 'toolu_p', spawnDepth: 1 }));
  fs.writeFileSync(path.join(slug, sess, 'subagents', 'workflows', 'wf_1', 'agent-def456.jsonl'), line);
  fs.writeFileSync(path.join(slug, sess, 'subagents', 'workflows', 'wf_1', 'journal.jsonl'), line);

  const w = new TranscriptWatcher({ root, pollMs: 200, rescanMs: 300 });
  await w.start();
  await sleep(300);
  const keys = w.refs().map((r) => r.key).sort();
  w.stop();

  const expected = [sess, `${sess}#abc123`, `${sess}#def456`].sort();
  assert.deepStrictEqual(keys, expected, `encontró: ${JSON.stringify(keys)}`);
  const wf = w.refs().find((r) => r.agentId === 'def456');
  assert.strictEqual(wf?.workflowId, 'wf_1');
  assert.ok(w.refs().find((r) => r.agentId === 'abc123')?.metaPath?.endsWith('.meta.json'));
  return ok(name, `${keys.length} refs, journal.jsonl ignorado`);
};

/* ── 5. bóveda ────────────────────────────────────────────────────── */

const testVaultRoundTrip: Test = () => check('keys: cifrado/descifrado AES-256-GCM y descriptor sin valor', () => {
  const dir = tmp('vault-1');
  const v = new KeyVault(dir);
  const secretValue = 'sk-ant-super-secreto-1234ABCD';
  const desc = v.set('m1/proj', 'ANTHROPIC_API_KEY', secretValue);

  assert.strictEqual(desc.name, 'ANTHROPIC_API_KEY');
  assert.strictEqual(desc.hint, 'ABCD', 'el hint son los últimos 4');
  assert.ok(!JSON.stringify(desc).includes(secretValue), 'el descriptor filtró el valor');
  assert.ok(!JSON.stringify(v.list()).includes(secretValue), 'list() filtró el valor');

  // En disco no puede aparecer el texto claro.
  const onDisk = fs.readFileSync(path.join(dir, 'keys.json'), 'utf8');
  assert.ok(!onDisk.includes(secretValue), 'el valor quedó en claro en keys.json');
  assert.ok(!onDisk.includes('super-secreto'));

  // Permisos: secret 0600.
  const mode = fs.statSync(path.join(dir, 'secret')).mode & 0o777;
  assert.strictEqual(mode, 0o600, `secret con permisos ${mode.toString(8)}`);

  // Round trip por materialize.
  const env = v.materialize('m1/proj', 'agent-x');
  assert.strictEqual(env['ANTHROPIC_API_KEY'], secretValue);

  // Otra instancia sobre el mismo directorio descifra igual (persistencia real).
  const v2 = new KeyVault(dir);
  assert.strictEqual(v2.materialize('m1/proj')['ANTHROPIC_API_KEY'], secretValue);
  assert.deepStrictEqual(v2.namesFor('m1/proj'), ['ANTHROPIC_API_KEY']);
  assert.deepStrictEqual(v2.namesFor('m1/otro'), [], 'no puede cruzar proyectos');
  assert.deepStrictEqual(v2.materialize('m1/otro'), {});

  // Auditoría.
  const d2 = v2.list().find((k) => k.name === 'ANTHROPIC_API_KEY');
  assert.ok(d2 && d2.lastUsedAt !== null, 'no registró el uso');
  assert.ok(d2.usedBy.includes('agent-x'), 'no registró quién la usó');

  assert.ok(v2.remove('m1/proj', 'ANTHROPIC_API_KEY'));
  assert.deepStrictEqual(v2.materialize('m1/proj'), {});
});

const testVaultTamper: Test = () => check('keys: manipular el archivo invalida el descifrado (GCM + AAD)', () => {
  const dir = tmp('vault-2');
  const v = new KeyVault(dir);
  v.set('m1/proj', 'TOKEN_A', 'valor-de-A');
  v.set('m1/otro', 'TOKEN_B', 'valor-de-B');
  assert.ok(v.selfTest('m1/proj', 'TOKEN_A', 'valor-de-A'));

  // Mover el ciphertext de un proyecto a otro debe fallar: el id va como AAD.
  const file = path.join(dir, 'keys.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Record<string, string>[] };
  const a = doc.entries.find((e) => e['name'] === 'TOKEN_A');
  const b = doc.entries.find((e) => e['name'] === 'TOKEN_B');
  assert.ok(a && b);
  a['ct'] = b['ct']!; a['iv'] = b['iv']!; a['tag'] = b['tag']!; a['salt'] = b['salt']!;
  fs.writeFileSync(file, JSON.stringify(doc));

  const v2 = new KeyVault(dir);
  assert.strictEqual(v2.materialize('m1/proj')['TOKEN_A'], undefined,
    'aceptó un ciphertext robado de otro proyecto');
  // La otra sigue sana: un fallo no tumba la bóveda entera.
  assert.strictEqual(v2.materialize('m1/otro')['TOKEN_B'], 'valor-de-B');
});

const testVaultSecretChange: Test = () => check('keys: sin el secret correcto no se descifra nada', () => {
  const dir = tmp('vault-3');
  new KeyVault(dir).set('m1/p', 'K', 'valor');
  fs.writeFileSync(path.join(dir, 'secret'), crypto.randomBytes(32), { mode: 0o600 });
  assert.deepStrictEqual(new KeyVault(dir).materialize('m1/p'), {});
});

const testVaultCorrupt: Test = () => check('keys: keys.json ilegible no tumba el proceso', () => {
  const dir = tmp('vault-4');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'keys.json'), 'esto no es json {{{');
  const v = new KeyVault(dir);
  assert.deepStrictEqual(v.list(), []);
  const d = v.set('m1/p', 'K', 'v');
  assert.strictEqual(d.hint, '·', 'un valor de <4 chars se enmascara entero, no se revela');
  assert.strictEqual(v.materialize('m1/p')['K'], 'v');
});

/* ── 6. proyectos ─────────────────────────────────────────────────── */

const testProbeSlug: Test = () => check('projects: la sonda prefiere el segmento largo (jk-detailing)', () => {
  const real = new Set([
    '/Users', '/Users/dan', '/Users/dan/projects',
    '/Users/dan/projects/jk-detailing',
    '/Users/dan/projects/dijosi', '/Users/dan/projects/dijosi/workers',
    '/Users/dan/projects/dijosi/workers/guest-messages-consumer',
  ]);
  const exists = (p: string): boolean => real.has(p);
  assert.strictEqual(
    probeSlug('-Users-dan-projects-jk-detailing', exists),
    '/Users/dan/projects/jk-detailing',
  );
  assert.strictEqual(
    probeSlug('-Users-dan-projects-dijosi-workers-guest-messages-consumer', exists),
    '/Users/dan/projects/dijosi/workers/guest-messages-consumer',
  );
  assert.strictEqual(probeSlug('-no-existe-nada', exists), null);
});

const testMatchesSlug: Test = () => check('projects: un cwd de subdirectorio no mueve la raíz del proyecto', () => {
  const slug = '-Users-dan-projects-samuhomes';
  assert.strictEqual(matchesSlug('/Users/dan/projects/samuhomes', slug), '/Users/dan/projects/samuhomes');
  assert.strictEqual(matchesSlug('/Users/dan/projects/samuhomes/apps/workers/core', slug), null);
  assert.strictEqual(matchesSlug(null, slug), null);
});

/* ── 7. linaje ────────────────────────────────────────────────────── */

const testLineage: Test = () => check('lineage: Task → subagente, con depth y childIds coherentes', () => {
  const dir = tmp('lineage-1');
  const store = path.join(dir, 'lineage.json');
  const idx = new LineageIndex(store);

  const parentRef = ref('sess-root', '/tmp/root.jsonl');
  idx.ingest(batch(parentRef, [{
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'toolu_PARENT', name: 'Task', input: { description: 'mapear' } }],
    },
  }]));

  const metaA = path.join(dir, 'agent-A.meta.json');
  fs.writeFileSync(metaA, JSON.stringify({
    agentType: 'Explore', description: 'Mapear pipeline actual de leads',
    toolUseId: 'toolu_PARENT', spawnDepth: 1,
  }));

  // El nieto: lo lanzó el subagente A, no la raíz.
  const childRef = ref('sess-root', '/tmp/a.jsonl');
  idx.ingest(batch({ ...childRef, key: 'sess-root#A', agentId: 'A' }, [{
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_A', name: 'Task', input: {} }] },
  }]));
  const metaB = path.join(dir, 'agent-B.meta.json');
  fs.writeFileSync(metaB, JSON.stringify({ toolUseId: 'toolu_A', spawnDepth: 2, description: 'nieto' }));

  const tree = idx.resolve([
    { key: 'sess-root', sessionId: 'sess-root', agentId: null, metaPath: null, shortId: null },
    { key: 'sess-root#A', sessionId: 'sess-root', agentId: 'A', metaPath: metaA, shortId: null },
    { key: 'sess-root#B', sessionId: 'sess-root', agentId: 'B', metaPath: metaB, shortId: null },
  ]);

  assert.strictEqual(tree.get('sess-root')?.parentId, null);
  assert.strictEqual(tree.get('sess-root')?.depth, 0);
  assert.deepStrictEqual(tree.get('sess-root')?.childIds, ['sess-root#A']);

  assert.strictEqual(tree.get('sess-root#A')?.parentId, 'sess-root');
  assert.strictEqual(tree.get('sess-root#A')?.depth, 1);
  assert.strictEqual(tree.get('sess-root#A')?.mission, 'Mapear pipeline actual de leads');
  assert.deepStrictEqual(tree.get('sess-root#A')?.childIds, ['sess-root#B']);

  assert.strictEqual(tree.get('sess-root#B')?.parentId, 'sess-root#A');
  assert.strictEqual(tree.get('sess-root#B')?.depth, 2);
});

const testLineageSpawn: Test = () => check('lineage: spawn de ORCA persiste el padre entre reinicios', () => {
  const store = path.join(tmp('lineage-2'), 'lineage.json');
  const idx = new LineageIndex(store);
  idx.noteSpawn('e065a5f6', 'sess-padre', 'Extraer el card renderer');
  idx.bind('e065a5f6', 'sess-hija');

  // Reinicio del collector: se relee del disco.
  const idx2 = new LineageIndex(store);
  const tree = idx2.resolve([
    { key: 'sess-padre', sessionId: 'sess-padre', agentId: null, metaPath: null, shortId: null },
    { key: 'sess-hija', sessionId: 'sess-hija', agentId: null, metaPath: null, shortId: 'e065a5f6' },
  ]);
  assert.strictEqual(tree.get('sess-hija')?.parentId, 'sess-padre');
  assert.strictEqual(tree.get('sess-hija')?.depth, 1);
  assert.strictEqual(tree.get('sess-hija')?.mission, 'Extraer el card renderer');
  assert.deepStrictEqual(tree.get('sess-padre')?.childIds, ['sess-hija']);
});

const testLineageNoParent: Test = () => check('lineage: sin atribución posible, parentId null y depth 0', () => {
  const idx = new LineageIndex(path.join(tmp('lineage-3'), 'l.json'));
  const meta = path.join(tmp('lineage-3'), 'x.meta.json');
  fs.writeFileSync(meta, JSON.stringify({ toolUseId: 'toolu_DESCONOCIDO', spawnDepth: 1 }));
  // El padre no está en la lista de conocidos ⇒ ni siquiera cae a la raíz.
  const tree = idx.resolve([
    { key: 'huerfano#Z', sessionId: 'sess-que-no-vigilamos', agentId: 'Z', metaPath: meta, shortId: null },
  ]);
  assert.strictEqual(tree.get('huerfano#Z')?.parentId, null);
  assert.strictEqual(tree.get('huerfano#Z')?.depth, 1, 'sin padre conocido usa el hint del CLI');
  assert.deepStrictEqual(tree.get('huerfano#Z')?.childIds, []);
});

/* ── 8. escalaciones ──────────────────────────────────────────────── */

const testEscalation: Test = async () => {
  const name = 'escalate: buzón .orca/ask → Escalation → .answer.json';
  const projectPath = tmp('proj-esc');
  const askDir = path.join(projectPath, '.orca', 'ask');
  fs.mkdirSync(askDir, { recursive: true });

  const opened: string[] = [];
  const w = new EscalationWatcher({
    machineId: 'm1',
    resolveAgent: (_p, hint) => hint ?? 'agente-por-defecto',
  });
  w.onOpen((e) => opened.push(e.id));
  w.track('m1/proj', projectPath);
  w.start(80);

  const askFile = path.join(askDir, 'q1.json');
  fs.writeFileSync(askFile, JSON.stringify({
    question: '¿Uso Stripe o Mercado Pago?',
    context: 'El cliente factura en MXN.',
    options: ['Stripe', 'Mercado Pago'],
    optionsOnly: true,
    urgency: 'blocking',
    agentId: 'sess-42',
  }));
  await sleep(400);

  const list = w.list();
  assert.strictEqual(list.length, 1, `escalaciones abiertas: ${list.length}`);
  const e = list[0]!;
  assert.strictEqual(e.id, escalationId(askFile), 'el id debe ser estable por ruta');
  assert.strictEqual(e.agentId, 'sess-42');
  assert.strictEqual(e.projectId, 'm1/proj');
  assert.strictEqual(e.machineId, 'm1');
  assert.strictEqual(e.question, '¿Uso Stripe o Mercado Pago?');
  assert.strictEqual(e.context, 'El cliente factura en MXN.');
  assert.deepStrictEqual(e.options, ['Stripe', 'Mercado Pago']);
  assert.strictEqual(e.optionsOnly, true);
  assert.strictEqual(e.urgency, 'blocking');
  assert.strictEqual(e.status, 'pending');
  assert.deepStrictEqual(opened, [e.id]);

  // Un JSON basura no puede tumbar el watcher ni abrir una escalación.
  fs.writeFileSync(path.join(askDir, 'roto.json'), '{ esto no cierra');
  await sleep(250);
  assert.strictEqual(w.list().length, 1, 'un archivo corrupto abrió una escalación');

  // Responder.
  assert.strictEqual(await w.answer(e.id, 'Mercado Pago', 'pasarela preferida'), true);
  const answerFile = path.join(askDir, 'q1.answer.json');
  assert.ok(fs.existsSync(answerFile), 'no escribió el .answer.json');
  assert.ok(!fs.existsSync(askFile), 'no borró el pendiente');
  const ans = JSON.parse(fs.readFileSync(answerFile, 'utf8')) as Record<string, unknown>;
  assert.strictEqual(ans['answer'], 'Mercado Pago');
  assert.strictEqual(ans['answeredBy'], 'human');
  assert.strictEqual(ans['rememberAs'], 'pasarela preferida');
  assert.ok(typeof ans['at'] === 'number');
  assert.strictEqual(w.list().length, 0);
  assert.strictEqual(await w.answer(e.id, 'otra vez', null), false, 'respondió dos veces');

  // Retirada por el propio agente.
  const askFile2 = path.join(askDir, 'q2.json');
  fs.writeFileSync(askFile2, JSON.stringify({ question: 'segunda' }));
  await sleep(300);
  assert.strictEqual(w.list().length, 1);
  const withdrawn: string[] = [];
  w.onWithdraw((id) => withdrawn.push(id));
  fs.unlinkSync(askFile2);
  await sleep(300);
  assert.strictEqual(w.list().length, 0, 'no detectó que el agente retiró la pregunta');
  assert.deepStrictEqual(withdrawn, [escalationId(askFile2)]);

  w.stop();
  return ok(name, 'abrir, corrupto, responder, retirar');
};

const testEscalationExpiry: Test = async () => {
  const name = 'escalate: ttlMinutes expira la pregunta sola';
  const projectPath = tmp('proj-esc2');
  const askDir = path.join(projectPath, '.orca', 'ask');
  fs.mkdirSync(askDir, { recursive: true });
  fs.writeFileSync(path.join(askDir, 'q.json'),
    JSON.stringify({ question: 'expira ya', ttlMinutes: -1 }));

  const w = new EscalationWatcher({ machineId: 'm1', resolveAgent: () => 'a' });
  w.track('m1/proj', projectPath);
  w.start(80);
  await sleep(300);
  assert.strictEqual(w.list().length, 1);
  const reaped = w.reapExpired();
  assert.strictEqual(reaped.length, 1);
  assert.strictEqual(w.list().length, 0);
  w.stop();
  return ok(name);
};

/* ── 9. comandos ──────────────────────────────────────────────────── */

const testShortId: Test = () => check('commands: extractShortId sobre salida humana', () => {
  assert.strictEqual(extractShortId('Started background session e065a5f6\n'), 'e065a5f6');
  assert.strictEqual(extractShortId('e2e13c6e'), 'e2e13c6e');
  assert.strictEqual(extractShortId('sin ids aquí'), null);
});

const testPathGuard: Test = () => check('commands: isInside es la valla de rutas', () => {
  assert.strictEqual(isInside('/Users/dan', '/Users/dan/projects/x'), true);
  assert.strictEqual(isInside('/Users/dan', '/Users/dan'), true);
  assert.strictEqual(isInside('/Users/dan', '/Users/dan2/secret'), false, 'prefijo no es contención');
  assert.strictEqual(isInside('/Users/dan', '/etc/passwd'), false);
  assert.strictEqual(isInside('/Users/dan', '/Users/dan/../otro'), false, 'no debe permitir ..');
});

/* ── 10. diff del wire ────────────────────────────────────────────── */

function fakeAgent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1', machineId: 'm1', projectId: 'p1', title: 't', callsign: 'K9',
    state: 'idle', block: null, parentId: null, depth: 0, childIds: [], mission: null,
    model: 'claude-opus-5', tool: null, toolDetail: null, lastPrompt: null, lastSay: null,
    startedAt: 1000, updatedAt: 2000, uptimeMs: 1000,
    metrics: {
      costUSD: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, thinkingTokens: 0,
      tokensPerSec: 1, linesAdded: 0, linesRemoved: 0, toolCalls: 0,
      toolDurationMs: 0, apiDurationMs: 0, turns: 1,
    },
    background: false, shortId: null, ...over,
  };
}

const testDiff: Test = () => check('index: diffAgent sólo emite cambios perceptibles', () => {
  const a = fakeAgent();
  assert.strictEqual(diffAgent(a, fakeAgent()), null, 'dos snapshots iguales no generan patch');

  // uptimeMs solo no justifica un frame: cambia en cada tick.
  assert.strictEqual(diffAgent(a, fakeAgent({ uptimeMs: 9999, updatedAt: 9999 })), null);

  const st = diffAgent(a, fakeAgent({ state: 'working', tool: 'Bash', toolDetail: 'ls' }));
  assert.ok(st);
  assert.strictEqual(st.state, 'working');
  assert.strictEqual(st.tool, 'Bash');
  assert.ok(st.updatedAt !== undefined && st.uptimeMs !== undefined);

  // Un temblor de tps por debajo del umbral no viaja.
  const m = fakeAgent().metrics;
  assert.strictEqual(diffAgent(a, fakeAgent({ metrics: { ...m, tokensPerSec: 1.2 } })), null);
  assert.ok(diffAgent(a, fakeAgent({ metrics: { ...m, tokensPerSec: 4 } })), 'un salto real sí');
  assert.ok(diffAgent(a, fakeAgent({ metrics: { ...m, outputTokens: 2 } })), 'tokens nuevos sí');

  const bl = diffAgent(a, fakeAgent({
    state: 'blocked',
    block: { kind: 'question', summary: 's', since: 1 },
  }));
  assert.ok(bl?.block);
});

const testRollup: Test = () => check('index: rollup agrega por estado y cuenta bloqueados', () => {
  const r = rollup([
    fakeAgent({ state: 'working' }),
    fakeAgent({ state: 'blocked' }),
    fakeAgent({ state: 'blocked' }),
    fakeAgent({ state: 'idle' }),
  ]);
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.blocked, 2);
  assert.strictEqual(r.byState.blocked, 2);
  assert.strictEqual(r.byState.working, 1);
  assert.strictEqual(r.costUSD, 4);
  assert.strictEqual(r.tokensPerSec, 4);
});

/* ── 11. robustez general ─────────────────────────────────────────── */

const testJunkTolerance: Test = () => check('robustez: basura en el transcript no lanza', () => {
  const r = ref(SID, '/tmp/x.jsonl');
  const d = new SessionDeriver(r, 'm1', 'p1');
  d.ingest(batch(r, [
    { type: 'assistant' },                                   // sin message
    { type: 'assistant', message: 'no soy objeto' },
    { type: 'assistant', message: { content: 'no soy array' } },
    { type: 'assistant', message: { content: [null, 3, { type: 'tool_use' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'cost-state', modelUsage: 'basura' },
    { type: 'ai-title' },
    { type: 'tipo-del-futuro-que-no-conozco', payload: {} },
    {},
  ]));
  const s = d.snapshot();
  assert.ok(s.state.length > 0);
  assert.ok(Number.isFinite(s.metrics.costUSD));
  assert.ok(Number.isFinite(s.metrics.tokensPerSec));
  assert.strictEqual(safeJson('{roto'), null);
  assert.strictEqual(oneLine(undefined), '');
});

/* ── runner ───────────────────────────────────────────────────────── */

const TESTS: Test[] = [
  testBooting, testThinking, testWorking, testWorkingToIdle,
  testBlockedByAsk, testBlockedByPermission, testNotBlockedInAutoMode,
  testBlockedByEscalation, testDoneVsDead, testNoPrematureReap,
  testCostState, testTokensPerSec, testTurnsAndUptime, testToolDetail,
  testCallsigns,
  testParseLines, testIncrementalTail, testWatcherDiscovery,
  testVaultRoundTrip, testVaultTamper, testVaultSecretChange, testVaultCorrupt,
  testProbeSlug, testMatchesSlug,
  testLineage, testLineageSpawn, testLineageNoParent,
  testEscalation, testEscalationExpiry,
  testShortId, testPathGuard,
  testDiff, testRollup,
  testJunkTolerance,
];

/** Ningún test puede colgar la suite: un test que no responde es un test roto. */
const TEST_TIMEOUT_MS = 15_000;

export async function collectorTests(stream = false): Promise<TestResult[]> {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-collector-test-'));
  const out: TestResult[] = [];
  for (const t of TESTS) {
    const label = t.name || 'test anónimo';
    let r: TestResult;
    try {
      r = await Promise.race([
        Promise.resolve(t()),
        sleep(TEST_TIMEOUT_MS).then(() => fail(label, `timeout tras ${TEST_TIMEOUT_MS}ms`)),
      ]);
    } catch (err) {
      r = {
        name: label, pass: false,
        detail: `lanzó fuera del check: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      };
    }
    out.push(r);
    if (stream) console.log(`${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* da igual */ }
  return out;
}

async function main(): Promise<void> {
  const results = await collectorTests(true);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} pasaron`);
  if (failed > 0) process.exitCode = 1;
  // Un watcher que no se cerró bien no debe dejar el runner colgado; los timers
  // están unref'd, pero forzamos la salida para que un fallo sea visible.
  process.exit(failed > 0 ? 1 : 0);
}

const invoked = process.argv[1] ?? '';
if (invoked.endsWith('collector.test.ts')) void main();
