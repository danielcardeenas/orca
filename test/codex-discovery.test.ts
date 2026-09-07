import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher, type LineBatch } from '../src/collector/watch.ts';
import { CodexDeriver } from '../src/collector/codex.ts';
import { ok, sleep, test, type TestModule } from './harness.ts';

const tests = [test('large Codex rollout supplies authentic identity and recent activity together on restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-discovery-'));
  const id = '01a0777a-0698-7e20-b498-734ee8ba9888';
  const day = join(root, '2026', '09', '07');
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-date-${id}.jsonl`);
  const at = new Date().toISOString();
  const meta = { type: 'session_meta', payload: { id, cwd: '/projects/orca', timestamp: at } };
  const say = (text: string) => ({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
  // No turn_context in the tail; metadata is beyond the reverse-scan budget.
  writeFileSync(file, JSON.stringify(meta) + '\n' + (JSON.stringify({ type: 'padding', text: 'x'.repeat(256) }) + '\n').repeat(100) + JSON.stringify(say('still working')) + '\n');
  const w = new TranscriptWatcher({ root, layout: 'codex', maxAgeMs: 0, bootstrapBytes: 1024, deepScanBytes: 1024, pollMs: 50 });
  const got: LineBatch[] = [];
  w.onLines(b => got.push(b));
  try {
    await w.start();
    for (let i = 0; i < 100 && !got.length; i++) await sleep(20);
    const first = got[0];
    if (!first) return ok('large rollout recovery', false, 'no batch');
    const d = new CodexDeriver(first.ref, 'machine', 'project-or');
    d.ingest(first);
    appendFileSync(file, JSON.stringify(say('next update')) + '\n');
    for (let i = 0; i < 100 && !got.some(b => !b.bootstrap); i++) await sleep(20);
    for (const b of got.slice(1)) d.ingest(b);
    return ok('large rollout recovery', first.lines[0]?.type === 'session_meta'
      && first.ref.key === id && d.cwd === '/projects/orca'
      && first.lines.some(l => JSON.stringify(l).includes('still working'))
      && got.flatMap(b => b.lines).filter(l => l.type === 'session_meta').length === 1
      && d.snapshot().lastSay === 'next update', 'identity + tail in first batch, incremental updates retained');
  } finally { w.stop(); rmSync(root, { recursive: true, force: true }); }
})];

export default { suite: 'Codex discovery recovery', tests } satisfies TestModule;
