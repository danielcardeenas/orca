import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderHandoffs, transcriptMarkdown, demoteArchivedRules } from '../src/collector/provider-handoff.ts';
import { capcomBrief, cleanCapcomBrief } from '../src/collector/briefs.ts';
import type { AgentHandle } from '../src/collector/commands.ts';
import { CapcomSession, capcomHandoffsDirFor } from '../src/collector/capcom.ts';
import { test, ok } from './harness.ts';
const sourceId = '11111111-2222-4333-8444-555555555555';
const targetId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function rig() {
  // Como en producción: bajo un mismo padre, el directorio de CAPCOM y, a su
  // lado —no debajo—, el de sus relevos.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-provider-'));
  const dir = path.join(root, 'capcom'); fs.mkdirSync(dir, { mode: 0o700 });
  const archives = capcomHandoffsDirFor(dir);
  const source = path.join(dir, 'source.jsonl');
  fs.writeFileSync(source, JSON.stringify({ type: 'response_item', timestamp: '2026-09-06T01:00:00Z', payload: { type: 'message', role: 'user', content: [{ text: 'Do not lose the hygiene task.' }] } }) + '\n');
  const a = { id: sourceId, sessionId: sourceId, runtime: 'codex', model: 'gpt-6-astra', pane: 'orca-source', alive: true, state: 'idle', transcriptPath: source } as AgentHandle;
  const holds: boolean[] = []; const activations: string[] = [];
  // El dueño de los ficheros con los que arranca un CAPCOM: el mismo que los
  // escribe al activar y al recuperar. El servicio de relevos sólo le pide que
  // amueble el cwd del destino.
  const cap = new CapcomSession({ dir, bin: '/fake/claude', hubUrl: 'ws://127.0.0.1:1', token: '', trust: false,
    alive: () => false, note() {}, lineage: { noteSpawn() {}, bind() {}, demote() {} } });
  const deps = { dir: () => dir, archives: () => archives, configure: (cwd: string, mode: 'continuity' | 'clean') => cap.writeConfig(cwd, mode),
    agent: () => a, owns: () => true, context: () => 'Pending: hygiene', busy: () => false,
    models: () => [{ runtime: 'claude' as const, id: 'sonnet', label: 'Sonnet', installed: true }],
    hold: (_id: string, on: boolean) => { holds.push(on); },
    activate: async (_p: unknown, id: string) => { activations.push(id); },
    prepare: async (p: { id: string }, prompt: string) => { assert.match(prompt, /Do not lose the hygiene task/); return { sessionId: targetId, receipt: `Pending hygiene. ORCA_HANDOFF_READY_${p.id}` }; },
  };
  const service = new ProviderHandoffs(deps);
  async function settle() { for (let i = 0; i < 100 && service.locked(a.id); i++) await Promise.resolve(); }
  return { root, dir, archives, source, a, deps, service, settle, holds, activations, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * Los ficheros de reglas que un CLI cargaría desde un cwd: el suyo y el de
 * todos sus ancestros hasta la raíz que se le dé. Es el camino que convirtió
 * un respaldo en instrucciones y el que le colaba el brief largo a un reset
 * limpio, así que la prueba lo recorre igual.
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
/** ¿Cuelga `child` de `parent`? Lo que el cwd de un relevo ya no puede hacer del directorio de CAPCOM. */
const under = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
export default { suite: 'Provider handoff', tests: [
  test('a relieved session runs beside the CAPCOM directory, and loads its brief exactly once', () => {
    const r = rig(); try {
      // Como en producción: el brief vivo del directorio de CAPCOM, que el
      // collector reescribe al arrancar y que no se puede quitar de ahí.
      const brief = capcomBrief();
      for (const name of ['CLAUDE.md', 'AGENTS.md']) fs.writeFileSync(path.join(r.dir, name), brief);
      const plan = r.service.review(r.a.id, 'codex', 'gpt-6-astra', 'hygiene pending', 'continuity');
      // El archivo y el cwd viven en el hermano, no bajo el directorio de CAPCOM.
      assert.ok(under(plan.archive, r.archives) && under(plan.cwd!, plan.archive));
      assert.equal(under(plan.cwd!, r.dir), false);
      // El respaldo se conserva, byte a byte, y no en un ancestro del destino.
      assert.equal(fs.existsSync(path.join(plan.archive, 'CLAUDE.md')), false);
      assert.equal(fs.existsSync(path.join(plan.archive, 'AGENTS.md')), false);
      assert.equal(fs.readFileSync(path.join(plan.archive, 'rules', 'CLAUDE.md'), 'utf8'), brief);
      assert.equal(fs.readFileSync(path.join(plan.archive, 'rules', 'AGENTS.md'), 'utf8'), brief);
      assert.match(fs.readFileSync(plan.checkpointPath, 'utf8'), /copies in rules\/ inside this archive/);
      // El relevo arranca con su brief completo en su propio cwd, amueblado por
      // el dueño de la configuración: el MCP y los settings llegan con él.
      assert.equal(fs.readFileSync(path.join(plan.cwd!, 'CLAUDE.md'), 'utf8'), brief);
      assert.equal(fs.readFileSync(path.join(plan.cwd!, 'AGENTS.md'), 'utf8'), brief);
      assert.ok(fs.existsSync(path.join(plan.cwd!, '.mcp.json')) && fs.existsSync(path.join(plan.cwd!, '.claude', 'settings.json')));
      // Lo que se cobraba: tres ficheros de reglas en la cadena, dos idénticos.
      // Después del respaldo en rules/: dos, el del cwd y el vivo de CAPCOM.
      // Ahora: uno. Recorrido hasta el padre común, que es donde se separan.
      assert.deepEqual(rulesOnPath(plan.cwd!, r.root), [path.join(plan.cwd!, 'CLAUDE.md')]);
      assert.deepEqual(rulesOnPath(plan.cwd!, r.root, 'AGENTS.md'), [path.join(plan.cwd!, 'AGENTS.md')]);
      return ok('archive beside CAPCOM, backup kept, one brief on the chain', true);
    } finally { r.dispose(); }
  }),
  test('a clean reset receives only the short brief: nothing above its runtime carries the long one', () => {
    const r = rig(); try {
      const brief = capcomBrief();
      for (const name of ['CLAUDE.md', 'AGENTS.md']) fs.writeFileSync(path.join(r.dir, name), brief);
      const plan = r.service.review(r.a.id, 'codex', 'gpt-6-astra', '', 'clean');
      // Lo que hoy no se cumplía: el modo que promete no inyectar las reglas
      // persistentes las recibía enteras por el ancestro. Un solo fichero en
      // la cadena, y es el corto.
      for (const name of ['CLAUDE.md', 'AGENTS.md']) {
        const chain = rulesOnPath(plan.cwd!, r.root, name);
        assert.deepEqual(chain, [path.join(plan.cwd!, name)]);
        assert.equal(fs.readFileSync(chain[0]!, 'utf8'), cleanCapcomBrief());
        assert.equal(chain.some(f => fs.readFileSync(f, 'utf8') === brief), false, `${name}: the long brief reached a clean reset`);
      }
      // El largo sigue archivado como evidencia, donde ningún CLI lo carga.
      assert.equal(fs.readFileSync(path.join(plan.archive, 'rules', 'CLAUDE.md'), 'utf8'), brief);
      return ok('clean reset: the short brief, once, and nothing else on the chain', true);
    } finally { r.dispose(); }
  }),
  test('archives written under the CAPCOM directory stay there: still found by id, demoted and pruned', () => {
    const r = rig(); try {
      const brief = capcomBrief();
      for (const name of ['CLAUDE.md', 'AGENTS.md']) fs.writeFileSync(path.join(r.dir, name), brief);
      // Un archivo de antes: bajo el directorio de CAPCOM, con el respaldo en
      // la raíz y su plan. Es historial de sesiones anteriores: no se mueve.
      const oldId = 'aaaaaaaa-1111-4111-8111-111111111111';
      const old = path.join(r.dir, 'handoffs', oldId);
      fs.mkdirSync(path.join(old, 'runtime'), { recursive: true });
      for (const name of ['CLAUDE.md', 'AGENTS.md', 'source.jsonl', 'conversation.md']) fs.writeFileSync(path.join(old, name), brief);
      fs.writeFileSync(path.join(old, 'plan.json'), JSON.stringify({ id: oldId, fromId: 'x', fromRuntime: 'codex', fromModel: null, runtime: 'codex', model: 'gpt-6-astra', at: 1, archive: old, historyPath: path.join(old, 'conversation.md'), checkpointPath: path.join(old, 'HANDOFF.md'), bytes: 0, sha256: '', phase: 'complete', detail: '' }));
      const plan = r.service.review(r.a.id, 'codex', 'gpt-6-astra', '', 'clean');
      assert.equal(under(plan.archive, r.archives), true);
      assert.equal(fs.existsSync(old), true, 'the old archive is not moved');
      // Se sigue encontrando por id, donde está.
      assert.equal(r.service.has(oldId), true);
      assert.equal(r.service.status(oldId).archive, old);
      // Su respaldo baja a rules/, como prometía el arreglo anterior; lo que
      // le queda por ancestro es el brief vivo de CAPCOM, que sólo deja de
      // cobrar cuando esa sesión se releva a un cwd de fuera.
      assert.equal(fs.existsSync(path.join(old, 'CLAUDE.md')), false);
      assert.equal(fs.readFileSync(path.join(old, 'rules', 'CLAUDE.md'), 'utf8'), brief);
      assert.deepEqual(rulesOnPath(path.join(old, 'runtime'), r.root), [path.join(r.dir, 'CLAUDE.md')]);
      // Y la poda de lo superado sigue alcanzándolo, como antes.
      assert.equal(fs.existsSync(path.join(old, 'source.jsonl')), false);
      assert.ok(fs.existsSync(path.join(old, 'PRUNED.md')));
      assert.equal(demoteArchivedRules(r.archives) + demoteArchivedRules(path.join(r.dir, 'handoffs')), 0);
      return ok('legacy archives: in place, found by id, demoted and pruned', true);
    } finally { r.dispose(); }
  }),
  test('without an owner for the runtime files a fresh-context handoff is refused; a plain one runs where CAPCOM runs', () => {
    const r = rig(); try {
      const { configure: _configure, ...orphan } = r.deps;
      const service = new ProviderHandoffs(orphan);
      assert.throws(() => service.review(r.a.id, 'codex', 'gpt-6-astra', '', 'clean'), /furnish/);
      assert.equal(fs.existsSync(r.archives), false, 'nothing was written');
      // Sin contexto nuevo no hay cwd que amueblar: el destino corre donde el
      // origen, y el plan lo dice en vez de dejar que alguien lo deduzca.
      const plain = service.review(r.a.id, 'claude', 'sonnet', 'pending');
      assert.equal(plain.cwd, r.dir);
      assert.equal(fs.existsSync(path.join(plain.archive, 'runtime')), false);
      return ok('no owner, no fresh runtime; a plain handoff keeps its cwd explicit', true);
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
