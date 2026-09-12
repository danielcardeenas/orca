import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderHandoffs, transcriptMarkdown, demoteArchivedRules } from '../src/collector/provider-handoff.ts';
import { capcomBrief } from '../src/collector/briefs.ts';
import type { AgentHandle } from '../src/collector/commands.ts';
import { CapcomSession } from '../src/collector/capcom.ts';
import { test, ok } from './harness.ts';
const sourceId = '11111111-2222-4333-8444-555555555555';
const targetId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-provider-'));
  const source = path.join(dir, 'source.jsonl');
  fs.writeFileSync(source, JSON.stringify({ type: 'response_item', timestamp: '2026-09-06T01:00:00Z', payload: { type: 'message', role: 'user', content: [{ text: 'Do not lose the hygiene task.' }] } }) + '\n');
  const a = { id: sourceId, sessionId: sourceId, runtime: 'codex', model: 'gpt-6-astra', pane: 'orca-source', alive: true, state: 'idle', transcriptPath: source } as AgentHandle;
  const holds: boolean[] = []; const activations: string[] = [];
  const deps = { dir: () => dir, agent: () => a, owns: () => true, context: () => 'Pending: hygiene', busy: () => false,
    models: () => [{ runtime: 'claude' as const, id: 'sonnet', label: 'Sonnet', installed: true }],
    hold: (_id: string, on: boolean) => { holds.push(on); },
    activate: async (_p: unknown, id: string) => { activations.push(id); },
    prepare: async (p: { id: string }, prompt: string) => { assert.match(prompt, /Do not lose the hygiene task/); return { sessionId: targetId, receipt: `Pending hygiene. ORCA_HANDOFF_READY_${p.id}` }; },
  };
  const service = new ProviderHandoffs(deps);
  async function settle() { for (let i = 0; i < 100 && service.locked(a.id); i++) await Promise.resolve(); }
  return { dir, source, a, deps, service, settle, holds, activations, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Los ficheros de reglas que un CLI cargaría desde un cwd: el suyo y el de
 * todos sus ancestros hasta la raíz que se le dé. Es el camino que convirtió
 * un respaldo en instrucciones, así que la prueba lo recorre igual.
 */
function rulesOnPath(cwd: string, root: string, name = 'CLAUDE.md'): string[] {
  const out: string[] = [];
  for (let dir = cwd; dir.startsWith(root); dir = path.dirname(dir)) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) out.push(file);
    if (dir === root) break;
  }
  return out;
}
export default { suite: 'Provider handoff', tests: [
  test('the rules backup leaves the ancestor chain, so a relieved session loads its brief once', () => {
    const r = rig(); try {
      // Como en producción: el brief vivo del directorio de CAPCOM, que es
      // ancestro de todo cwd de relevo y no se puede quitar de ahí.
      const brief = capcomBrief();
      for (const name of ['CLAUDE.md', 'AGENTS.md']) fs.writeFileSync(path.join(r.dir, name), brief);
      const plan = r.service.review(r.a.id, 'codex', 'gpt-6-astra', 'hygiene pending', 'continuity');
      // El respaldo se conserva, byte a byte, y no en un ancestro del destino.
      assert.equal(fs.existsSync(path.join(plan.archive, 'CLAUDE.md')), false);
      assert.equal(fs.existsSync(path.join(plan.archive, 'AGENTS.md')), false);
      assert.equal(fs.readFileSync(path.join(plan.archive, 'rules', 'CLAUDE.md'), 'utf8'), brief);
      assert.equal(fs.readFileSync(path.join(plan.archive, 'rules', 'AGENTS.md'), 'utf8'), brief);
      assert.match(fs.readFileSync(plan.checkpointPath, 'utf8'), /copies in rules\/ inside this archive/);
      // Y el relevo sigue arrancando con su brief completo en su propio cwd.
      assert.equal(fs.readFileSync(path.join(plan.cwd!, 'CLAUDE.md'), 'utf8'), brief);
      assert.equal(fs.readFileSync(path.join(plan.cwd!, 'AGENTS.md'), 'utf8'), brief);
      // Lo que se cobraba: tres ficheros de reglas en la cadena, dos idénticos.
      // Lo que queda: el del cwd y el vivo del directorio de CAPCOM.
      assert.deepEqual(rulesOnPath(plan.cwd!, r.dir), [path.join(plan.cwd!, 'CLAUDE.md'), path.join(r.dir, 'CLAUDE.md')]);
      assert.deepEqual(rulesOnPath(plan.cwd!, r.dir, 'AGENTS.md'), [path.join(plan.cwd!, 'AGENTS.md'), path.join(r.dir, 'AGENTS.md')]);
      return ok('backup kept, ancestor chain clean, destination brief intact', true);
    } finally { r.dispose(); }
  }),
  test('a clean reset loads the brief exactly once, and earlier archives stop charging for theirs', () => {
    const r = rig(); try {
      const brief = capcomBrief();
      for (const name of ['CLAUDE.md', 'AGENTS.md']) fs.writeFileSync(path.join(r.dir, name), brief);
      // Un archivo escrito antes del arreglo: el respaldo en la raíz, que es
      // ancestro del cwd de la sesión que manda ahora mismo.
      const old = path.join(r.dir, 'handoffs', 'aaaaaaaa-1111-4111-8111-111111111111');
      fs.mkdirSync(path.join(old, 'runtime'), { recursive: true });
      for (const name of ['CLAUDE.md', 'AGENTS.md']) fs.writeFileSync(path.join(old, name), brief);
      const plan = r.service.review(r.a.id, 'codex', 'gpt-6-astra', '', 'clean');
      assert.equal(fs.existsSync(path.join(old, 'CLAUDE.md')), false);
      assert.equal(fs.readFileSync(path.join(old, 'rules', 'CLAUDE.md'), 'utf8'), brief);
      assert.deepEqual(rulesOnPath(path.join(old, 'runtime'), r.dir), [path.join(r.dir, 'CLAUDE.md')]);
      // El destino limpio: su brief corto, y el brief largo una sola vez.
      const chain = rulesOnPath(plan.cwd!, r.dir);
      assert.deepEqual(chain, [path.join(plan.cwd!, 'CLAUDE.md'), path.join(r.dir, 'CLAUDE.md')]);
      assert.equal(chain.filter(f => fs.readFileSync(f, 'utf8') === brief).length, 1);
      assert.equal(demoteArchivedRules(path.join(r.dir, 'handoffs')), 0);
      return ok('clean reset pays the brief once; pre-existing archives migrate', true);
    } finally { r.dispose(); }
  }),
  test('review archives exact bytes and requires confirmation before destination preparation', async () => {
    const r = rig(); try {
      const plan = r.service.review(r.a.id, 'claude', 'sonnet', 'task-123 remains pending');
      assert.deepEqual(fs.readFileSync(path.join(plan.archive, 'source.jsonl')), fs.readFileSync(r.source));
      assert.match(fs.readFileSync(plan.checkpointPath, 'utf8'), /task-123/);
      assert.equal(r.activations.length, 0); assert.equal(r.holds.length, 0);
      r.service.commit(r.a.id, plan.id); await r.settle();
      assert.equal(r.service.status(plan.id).phase, 'complete'); assert.deepEqual(r.activations, [targetId]); assert.deepEqual(r.holds, [true, false]);
      return ok('backup, explicit commit, receipt, activation', true);
    } finally { r.dispose(); }
  }),
  test('a recovery record pointing at a deleted archive prepares from the transcript instead of failing', () => {
    const r = rig(); try {
      const gone = path.join(r.dir, 'pruned', 'conversation.md');
      fs.writeFileSync(path.join(r.dir, 'codex-recovery.json'), JSON.stringify({ sessionId: sourceId, historyPath: gone, checkpointPath: path.join(r.dir, 'pruned', 'HANDOFF.md') }));
      assert.equal(fs.existsSync(gone), false);
      const plan = r.service.review(r.a.id, 'claude', 'sonnet');
      assert.match(fs.readFileSync(plan.historyPath, 'utf8'), /Do not lose the hygiene task/);
      return ok('missing earlier history degrades to empty, transcript still archived', true);
    } finally { r.dispose(); }
  }),
  test('changed source, changed backup and same-provider requests fail closed', () => {
    const r = rig(); try {
      assert.throws(() => r.service.review(r.a.id, 'codex', 'gpt-6-astra'), /same-session/);
      const p = r.service.review(r.a.id, 'claude', 'sonnet');
      fs.appendFileSync(p.historyPath, 'tampered'); assert.throws(() => r.service.commit(r.a.id, p.id), /integrity/);
      const p2 = r.service.review(r.a.id, 'claude', 'sonnet'); fs.appendFileSync(r.source, '\n');
      assert.throws(() => r.service.commit(r.a.id, p2.id), /conversation changed/);
      assert.equal(r.activations.length, 0); return ok('no stale or altered context activated', true);
    } finally { r.dispose(); }
  }),
  test('quota failure retains old session, releases held mail and persists failure', async () => {
    const r = rig(); try {
      r.deps.prepare = async () => { throw new Error('quota exhausted'); };
      const p = r.service.review(r.a.id, 'claude', 'sonnet'); r.service.commit(r.a.id, p.id); await r.settle();
      assert.equal(r.service.status(p.id).phase, 'failed'); assert.equal(r.activations.length, 0); assert.deepEqual(r.holds, [true, false]);
      assert.equal(new ProviderHandoffs(r.deps).status(p.id).phase, 'failed');
      assert.ok(fs.existsSync(p.historyPath)); return ok('quota failure preserves coordinator and archive', true);
    } finally { r.dispose(); }
  }),
  test('archive history pagination joins prior and current messages without dropping text', () => {
    const r = rig(); try {
      const prior = path.join(r.dir, 'prior.md');
      fs.writeFileSync(prior, Array.from({ length: 30 }, (_, i) => `## 2026-09-05T01:00:00Z · user · old\n\nMessage ${i}\n\n`).join(''));
      // Como lo escribe una activación: la sesión que manda, y dónde quedó su historial.
      fs.writeFileSync(path.join(r.dir, 'codex-recovery.json'), JSON.stringify({ sessionId: sourceId, runtime: 'codex', model: 'gpt-6-astra', historyPath: prior }));
      let offset: number | null = 0; let text = ''; let pages = 0;
      while (offset !== null) { const p = r.service.history(r.a.id, offset, Date.now()); text = p.text + text; offset = p.next; pages++; }
      assert.equal(pages, 3); assert.match(text, /Message 0/); assert.match(text, /Message 29/); assert.match(text, /hygiene task/);
      assert.throws(() => transcriptMarkdown('{incomplete', 'claude', sourceId));
      return ok('all archived pages are retrievable', true);
    } finally { r.dispose(); }
  }),
  test('activation resumes the prepared Claude id and stops old pane only after destination readiness', async () => {
    const r = rig(); try {
      const calls: string[] = [];
      const cap = new CapcomSession({ dir: r.dir, bin: '/fake/claude', hubUrl: 'ws://localhost:4479', token: '', alive: () => true, note() {},
        lineage: { noteSpawn() {}, demote() {}, bind() {} }, tmux: { available: () => true,
          spawn: async p => { calls.push('spawn'); assert.ok(p.argv.includes('--resume')); assert.ok(p.argv.includes(targetId)); return { ok: true, stdout: '', detail: '' }; },
          capture: async () => { calls.push('ready'); return { ok: true, stdout: '❯ ', detail: '' }; },
          kill: async name => { calls.push(`kill:${name}`); return { ok: true, stdout: '', detail: '' }; },
        },
      });
      cap.adopt(sourceId); const p = r.service.review(r.a.id, 'claude', 'sonnet');
      await cap.activateHandoff(p, targetId);
      assert.equal(cap.current(), targetId); assert.equal(calls[0], 'spawn'); assert.ok(calls.slice(1, -1).every(c => c === 'ready')); assert.equal(calls.at(-1), `kill:orca-${sourceId}`);
      assert.equal(cap.recovery()?.runtime, 'claude'); assert.equal(cap.handoff('machine')?.toRuntime, 'claude');
      return ok('verified destination before cutover, runtime-aware resume', true);
    } finally { r.dispose(); }
  }),
  test('destination startup failure leaves original coordinator and recovery configuration intact', async () => {
    const r = rig(); try {
      const killed: string[] = [];
      const config = JSON.stringify({ sessionId: sourceId, model: 'gpt-6-astra' });
      fs.writeFileSync(path.join(r.dir, 'codex-recovery.json'), config);
      const cap = new CapcomSession({ dir: r.dir, bin: '/fake/claude', hubUrl: 'ws://localhost:4479', token: '', alive: () => true, note() {},
        lineage: { noteSpawn() {}, demote() {}, bind() {} }, tmux: { available: () => true,
          spawn: async () => ({ ok: true, stdout: '', detail: '' }),
          capture: async () => ({ ok: false, stdout: '', detail: 'CLI exited' }),
          kill: async name => { killed.push(name); return { ok: true, stdout: '', detail: '' }; },
        },
      });
      cap.adopt(sourceId); const p = r.service.review(r.a.id, 'claude', 'sonnet');
      await assert.rejects(cap.activateHandoff(p, targetId), /Destination terminal unavailable/);
      assert.equal(cap.current(), sourceId); assert.deepEqual(killed, [`orca-${targetId}`]);
      assert.equal(fs.readFileSync(path.join(r.dir, 'codex-recovery.json'), 'utf8'), config);
      return ok('failed destination never stops the original', true);
    } finally { r.dispose(); }
  }),
] };
