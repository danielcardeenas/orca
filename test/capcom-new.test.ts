import { TerminalRelay } from '../src/collector/term.ts';
import type { TmuxHost } from '../src/collector/tmux.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderHandoffs } from '../src/collector/provider-handoff.ts';
import { CapcomResets } from '../src/collector/capcom-reset.ts';
import { ModelController } from '../src/collector/model-control.ts';
import { CapcomSession } from '../src/collector/capcom.ts';
import { readIdentity } from '../src/collector/capcom-identity.ts';
import { CapcomRouter } from '../src/hub/capcom.ts';
import { capcomBrief, cleanCapcomBrief } from '../src/collector/briefs.ts';
import { freshCapcomCheckpoint } from '../src/hub/capcom-checkpoint.ts';
import type { ProviderHandoffPlan, ProviderModel } from '../src/shared/provider-handoff.ts';
import type { AgentHandle } from '../src/collector/commands.ts';
import type { Agent, Escalation, WorldState } from '../src/shared/types.ts';
import { test, ok } from './harness.ts';

const OLD = '11111111-2222-4333-8444-555555555555';
const NEW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function rig(runtime = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-fresh-isolated-'));
  const source = path.join(dir, 'source.jsonl');
  const line = runtime === 'codex' ? { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'HISTORICAL_CONVERSATION_SENTINEL' }] } }
    : { type: 'user', message: { content: 'HISTORICAL_CONVERSATION_SENTINEL' } };
  fs.writeFileSync(source, JSON.stringify(line) + '\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'PERSISTED_RULE_SENTINEL');
  const a = { id: OLD, sessionId: OLD, runtime, model: runtime === 'codex' ? 'gpt-6-astra' : 'opus', pane: `orca-${OLD}`, alive: true, state: 'idle', transcriptPath: source } as AgentHandle;
  let effective = a.model ?? null;
  const prompts: string[] = []; const holds: boolean[] = []; const activated: string[] = [];
  const deps = { dir: () => dir, agent: (id: string) => id === OLD ? a : null, owns: () => true, busy: () => false,
    model: () => effective, models: (): ProviderModel[] => [], context: () => 'OLD_FLEET_CONTEXT_SENTINEL',
    hold: (_id: string, on: boolean) => { holds.push(on); },
    prepare: async (p: ProviderHandoffPlan, prompt: string) => { prompts.push(prompt); return { sessionId: NEW, receipt: `ORCA_HANDOFF_READY_${p.id}` }; },
    activate: async (_p: ProviderHandoffPlan, id: string) => { activated.push(id); },
  };
  const service = new ProviderHandoffs(deps);
  const settle = async () => { for (let i = 0; i < 100 && service.locked(OLD); i++) await Promise.resolve(); assert.equal(service.locked(OLD), false); };
  return { dir, source, a, deps, service, settle, prompts, holds, activated, model: (m: string) => { effective = m; }, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
export default { suite: 'Fresh CAPCOM', tests: [
  ...['codex', 'claude'].flatMap(runtime => (['clean', 'continuity'] as const).map(mode => test(`${runtime} ${mode} keeps effective model, exact archive, and excludes historical conversation`, async () => {
    const r = rig(runtime); try {
      r.model(runtime === 'codex' ? 'gpt-5.6-terra' : 'sonnet');
      const before = fs.readFileSync(r.source);
      const p = r.service.fresh(OLD, mode, 'PENDING_HUB_SENTINEL');
      await r.settle();
      assert.equal(r.service.status(p.id).phase, 'complete'); assert.equal(p.runtime, runtime);
      assert.equal(p.model, runtime === 'codex' ? 'gpt-5.6-terra' : 'sonnet');
      assert.deepEqual(r.activated, [NEW]); assert.deepEqual(r.holds, [true, false]);
      assert.deepEqual(fs.readFileSync(path.join(p.archive, 'source.jsonl')), before);
      assert.deepEqual(fs.readFileSync(r.source), before);
      assert.match(fs.readFileSync(p.historyPath, 'utf8'), /HISTORICAL_CONVERSATION_SENTINEL/);
      assert.equal(fs.readFileSync(path.join(r.dir, 'AGENTS.md'), 'utf8'), 'PERSISTED_RULE_SENTINEL');
      assert.ok(!r.prompts[0]!.includes('HISTORICAL_CONVERSATION_SENTINEL'));
      assert.ok(!r.prompts[0]!.includes('OLD_FLEET_CONTEXT_SENTINEL'));
      assert.ok(!r.prompts[0]!.includes('PERSISTED_RULE_SENTINEL'));
      assert.equal(r.prompts[0]!.includes('PENDING_HUB_SENTINEL'), mode === 'continuity');
      if (mode === 'clean') {
        assert.ok(!r.prompts[0]!.includes(OLD)); assert.ok(!r.prompts[0]!.includes(p.historyPath));
        assert.equal(fs.readFileSync(path.join(p.cwd!, 'AGENTS.md'), 'utf8'), cleanCapcomBrief());
      }
      return ok(`${runtime}/${p.model} ${mode}: new UUID, bounded context and intact archives`, true);
    } finally { r.dispose(); }
  }))),
  test('duplicate clicks share one preparation; conflicting mode and commit are rejected', async () => {
    const r = rig(); try {
      let release!: () => void;
      r.deps.prepare = async p => { await new Promise<void>(resolve => { release = resolve; }); return { sessionId: NEW, receipt: `ORCA_HANDOFF_READY_${p.id}` }; };
      const p = r.service.fresh(OLD, 'clean');
      assert.equal(r.service.fresh(OLD, 'clean').id, p.id);
      assert.throws(() => r.service.fresh(OLD, 'continuity'));
      assert.throws(() => r.service.commit(OLD, p.id));
      release(); await r.settle(); assert.deepEqual(r.activated, [NEW]);
      assert.throws(() => r.service.commit(OLD, p.id));
      return ok('one preparation and one activation despite duplicates', true);
    } finally { r.dispose(); }
  }),
  ...['quota', 'old UUID', 'bad receipt', 'source changed', 'model changed'].map(failure => test(`${failure} retains source and releases held messages`, async () => {
    const r = rig(); try {
      r.deps.prepare = async p => {
        if (failure === 'quota') throw Error('quota exhausted');
        if (failure === 'source changed') fs.appendFileSync(r.source, '\n');
        if (failure === 'model changed') r.model('different-model');
        return { sessionId: failure === 'old UUID' ? OLD : NEW, receipt: failure === 'bad receipt' ? 'ready maybe' : `ORCA_HANDOFF_READY_${p.id}` };
      };
      const p = r.service.fresh(OLD, 'clean'); await r.settle();
      assert.equal(r.service.status(p.id).phase, 'failed'); assert.deepEqual(r.activated, []);
      assert.deepEqual(r.holds, [true, false]); assert.ok(fs.existsSync(p.historyPath));
      return ok(`${failure}: no new authority, source retained`, true);
    } finally { r.dispose(); }
  })),
  test('busy or unknown model fails before preparing a runtime', () => {
    const r = rig(); try {
      r.a.state = 'working'; assert.throws(() => r.service.fresh(OLD, 'clean'), /Finish/);
      r.a.state = 'idle'; r.a.model = null; r.model('');
      assert.throws(() => r.service.fresh(OLD, 'clean'), /unknown/);
      assert.deepEqual(r.prompts, []); return ok('no fallback model or interruption', true);
    } finally { r.dispose(); }
  }),
  test('Codex activation verifies ready pane before cutover and clean watchdog resumes without briefing', async () => {
    const r = rig(); try {
      const calls: string[] = []; const argv: string[][] = [];
      const cap = new CapcomSession({ dir: r.dir, bin: '/fake/claude', codexBin: '/fake/codex', hubUrl: 'ws://127.0.0.1:1', token: '', trust: false,
        alive: () => false, note() {}, lineage: { noteSpawn() {}, bind() {}, demote() {} },
        tmux: { available: () => true,
          spawn: async p => { calls.push('spawn'); argv.push(p.argv); assert.equal(p.cwd, plan.cwd); return { ok: true, stdout: '', detail: '' }; },
          capture: async () => { calls.push('ready'); return { ok: true, stdout: '› Ask Codex to do anything\n  ? for shortcuts', detail: '' }; },
          kill: async name => { calls.push(`kill:${name}`); assert.equal(fs.existsSync(path.join(r.dir, 'codex-recovery.json')), false); return { ok: true, stdout: '', detail: '' }; },
        },
      });
      cap.adopt(OLD); const plan = r.service.review(OLD, 'codex', 'gpt-6-astra', '', 'clean');
      await cap.activateHandoff(plan, NEW);
      assert.equal(cap.current(), NEW); assert.equal(calls.at(-1), `kill:orca-${OLD}`);
      assert.deepEqual(argv[0]!.slice(0, 3), ['/fake/codex', 'resume', NEW]);
      assert.ok(argv[0]!.includes('gpt-6-astra'));
      assert.equal(cap.recovery()?.contextMode, 'clean'); assert.equal(cap.handoff('m')?.contextMode, 'clean');
      assert.equal(fs.readFileSync(path.join(plan.cwd!, 'CLAUDE.md'), 'utf8'), cleanCapcomBrief());
      assert.equal((await cap.ensure()).ok, true);
      assert.ok(!argv[1]!.some(arg => /briefing|reconcile|quota-blocked/.test(arg)));
      return ok('Codex isolated readiness, atomic UUID publication and clean resume policy', true);
    } finally { r.dispose(); }
  }),
  test('the guard watches the origin, not the destination: a different target model is not a changed CAPCOM', async () => {
    const r = rig();
    try {
      // Un traspaso de proveedor tiene, por definición, destino distinto del
      // origen. La guarda comparaba con el destino y sólo se libraba de
      // rechazarlo porque no se aplicaba fuera de `contextMode`: cualquier
      // relevo con modelo elegido caía justo ahí.
      r.deps.models = () => [{ runtime: 'claude', id: 'sonnet', label: 'Sonnet', installed: true }];
      const p = r.service.review(OLD, 'claude', 'sonnet');
      assert.equal(p.fromRuntime, 'codex'); assert.equal(p.fromModel, 'gpt-6-astra');
      assert.notEqual(p.model, p.fromModel);
      const committed = r.service.commit(OLD, p.id);
      assert.equal(committed.phase, 'preparing');
      await r.settle();
      assert.equal(r.service.status(p.id).phase, 'complete');
      assert.deepEqual(r.activated, [NEW]);
      return ok('a destination that differs on purpose is not mistaken for a moved origin', true);
    } finally { r.dispose(); }
  }),
  test('and it still refuses when the origin really moved, before and during preparation', async () => {
    const r = rig();
    try {
      r.deps.models = () => [{ runtime: 'claude', id: 'sonnet', label: 'Sonnet', installed: true }];
      const p = r.service.review(OLD, 'claude', 'sonnet');
      r.model('gpt-5.6-luna');
      assert.throws(() => r.service.commit(OLD, p.id), /no longer the runtime\/model this handoff was prepared from/);
      assert.deepEqual(r.activated, [], 'nothing was retired on a plan that no longer describes its source');

      // Y el mismo cambio a mitad de preparación deja vivo al original.
      const r2 = rig();
      try {
        r2.deps.models = () => [{ runtime: 'claude', id: 'sonnet', label: 'Sonnet', installed: true }];
        const late = r2.service.review(OLD, 'claude', 'sonnet');
        r2.deps.prepare = async plan => { r2.model('gpt-5.6-luna'); return { sessionId: NEW, receipt: `ORCA_HANDOFF_READY_${plan.id}` }; };
        r2.service.commit(OLD, late.id);
        await r2.settle();
        const after = r2.service.status(late.id);
        assert.equal(after.phase, 'failed');
        assert.match(after.detail, /changed runtime or model during preparation/);
        assert.deepEqual(r2.activated, []);
      } finally { r2.dispose(); }
      return ok('a source that moved still stops the handoff, both before and during', true);
    } finally { r.dispose(); }
  }),
  ...(['clean', 'continuity'] as const).map(mode => test(`crossing provider keeps the mode: ${mode} is ${mode} with another runtime too`, async () => {
    const r = rig();
    try {
      r.deps.models = () => [{ runtime: 'claude', id: 'sonnet', label: 'Sonnet', installed: true }];
      // El modo y el destino son ejes distintos: antes, pedir un contexto nuevo
      // con otro proveedor caía en `Fresh CAPCOM must retain its runtime and
      // model`, y el único camino cruzado que quedaba llevaba la conversación
      // entera — lo contrario de lo que dice el botón que se pulsó.
      const p = r.service.fresh(OLD, mode, 'PENDING_HUB_SENTINEL', { runtime: 'claude', model: 'sonnet' });
      assert.equal(p.contextMode, mode);
      assert.equal(p.runtime, 'claude'); assert.equal(p.model, 'sonnet');
      assert.equal(p.fromRuntime, 'codex'); assert.equal(p.fromModel, 'gpt-6-astra');
      await r.settle();
      assert.equal(r.service.status(p.id).phase, 'complete');
      assert.deepEqual(r.activated, [NEW]);
      // Y lo que se le manda al destino sigue siendo lo que el modo promete.
      const sent = r.prompts[0]!;
      assert.ok(!sent.includes('HISTORICAL_CONVERSATION_SENTINEL'), 'no conversation crosses in either mode');
      assert.equal(sent.includes('PENDING_HUB_SENTINEL'), mode === 'continuity');
      if (mode === 'clean') assert.ok(!sent.includes(OLD));
      // El brief del destino es el del modo, en los dos ficheros de runtime.
      assert.equal(fs.readFileSync(path.join(p.cwd!, 'CLAUDE.md'), 'utf8'), mode === 'clean' ? cleanCapcomBrief() : capcomBrief());
      return ok(`${mode} across providers: same promise, prepared instead of cleared in place`, true);
    } finally { r.dispose(); }
  })),
  test('a fresh CAPCOM still refuses a model no installed provider offers', () => {
    const r = rig();
    try {
      r.deps.models = () => [{ runtime: 'claude', id: 'sonnet', label: 'Sonnet', installed: false }];
      assert.throws(() => r.service.fresh(OLD, 'clean', '', { runtime: 'claude', model: 'sonnet' }), /installed provider and a listed model/);
      assert.throws(() => r.service.fresh(OLD, 'clean', '', { runtime: 'claude', model: 'invented' }), /installed provider and a listed model/);
      // Quedarse donde se está no pasa por el catálogo: no hay salto que validar.
      const same = r.service.fresh(OLD, 'clean', '', { runtime: 'codex', model: 'gpt-6-astra' });
      assert.equal(same.runtime, 'codex');
      assert.deepEqual(r.activated.length, 0, 'nothing activated yet; the point is that it was accepted');
      return ok('a destination that does not exist is refused; staying put needs no catalog', true);
    } finally { r.dispose(); }
  }),
  test('a new CAPCOM on the same runtime takes a Claude model nobody listed: the provider catalog admits it and the menu confirms it before /clear', async () => {
    /*
     * Lo que fallaba de verdad: un CAPCOM al mando casi nunca está ocioso con
     * el prompt limpio en el instante en que se abre el selector, así que su
     * catálogo nativo (`choices`) está vacío y «Opus → Sonnet» no existía como
     * opción, mientras cruzar a Codex sí. Aquí nadie tecleó `/model` antes: el
     * relevo se pide con un modelo que sólo conoce el catálogo del proveedor, y
     * es el menú real del CLI —abierto cuando la sesión ya está ociosa— quien
     * lo confirma antes de que salga el `/clear`.
     */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-fresh-model-'));
    try {
      const live = { id: OLD, sessionId: OLD, runtime: 'claude', model: 'opus', pane: `orca-${OLD}`, alive: true, state: 'idle', projectId: 'capcom', transcriptPath: '/tmp/old.jsonl' } as AgentHandle;
      const ids = ['Opus', 'Sonnet']; let view = 'prompt'; let selection = 0; let current = 0; let confirmed = false;
      const pasted: string[] = [];
      const screen = () => view === 'menu'
        ? `Select model\n${ids.map((id, i) => `${i === selection ? '❯' : ' '} ${i + 1}. ${id}  description`).join('\n')}\ns to use this session only`
        : `${confirmed ? '⎿ Set model to Sonnet 5 for this session only' : ''}\n❯ `;
      const good = () => ({ ok: true, stdout: '', detail: '' });
      const tmux = {
        capture: async () => ({ ...good(), stdout: screen() }),
        paste: async (_pane: string, text: string) => { pasted.push(text); if (text === '/model') { view = 'menu'; selection = current; } return good(); },
        keys: async (_pane: string, keys: string[]) => {
          for (const key of keys) {
            if (key === 'Down') selection++; if (key === 'Up') selection--;
            if (key === 'Escape') view = 'prompt';
            if (key === 's') { current = selection; confirmed = true; view = 'prompt'; }
          }
          return good();
        },
        rename: async () => good(),
      };
      // El catálogo del proveedor, sin sesión de por medio: lo que `providerModels()` sabe de Claude.
      const models = new ModelController({ tmux, dir: () => dir, owns: () => true, agent: () => live, wait: async () => {},
        catalog: runtime => runtime === 'claude' ? ['opus', 'fable', 'sonnet', 'haiku'].map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) })) : [] });
      assert.deepEqual(models.state(live)?.choices, [], 'no one asked this session for its menu');
      const adopted: string[] = [];
      const service = new CapcomResets({
        tmux, wait: async () => {}, agent: () => live, owns: () => true, busy: () => models.locked(OLD),
        model: a => models.state(a)?.active ?? a.model ?? null,
        // Lo mismo que hace `CommandRunner.applyModel`: listar, pedir y esperar al menú.
        setModel: async (id, model) => {
          await models.list(id); models.request(id, model);
          for (let i = 0; i < 50; i++) { models.tick(live); const s = models.state(live); if (s?.phase === 'failed') throw new Error(s.detail); if (s?.phase === 'ready' && s.active === model) return; await Promise.resolve(); }
          throw new Error('the CLI did not confirm');
        },
        discover: async () => ({ ...live, id: NEW, sessionId: NEW }),
        hold: () => {}, adopt: (_from, to, _mode, _at, model) => adopted.push(`${to}:${model}`), note: () => {}, dir: () => dir,
      });
      const out = await service.run(OLD, 'clean', 'sonnet');
      assert.equal(out.toId, NEW);
      assert.deepEqual(adopted, [`${NEW}:sonnet`], 'the relay is adopted with the model it was asked for');
      assert.ok(pasted.indexOf('/model') < pasted.indexOf('/clear'), 'the model is settled before the context is cleared');
      assert.equal(models.state(live)?.active, 'sonnet');
      return ok('unlisted same-runtime model: admitted by the catalog, confirmed by the menu, then cleared', true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }),
  test('after a native /clear the role sticks: the record the watchdog reads points at the new session', async () => {
    const r = rig();
    try {
      // Lo que había en disco cuando esto falló de verdad: una recuperación
      // preparada que nombra el hilo viejo. `ensure` la lee ANTES que
      // `session.json`, así que sin actualizarla el vigilante devolvía el rol
      // al hilo ya vaciado y el hub decía «no hay CAPCOM» con el proceso vivo.
      // Escrito en el formato ANTERIOR a propósito: así este caso comprueba
      // también que una instalación que venía de ahí migra sin perder el mando.
      fs.writeFileSync(path.join(r.dir, 'codex-recovery.json'), JSON.stringify({ runtime: 'codex', sessionId: OLD, model: 'gpt-6-astra',
        cwd: path.join(r.dir, 'runtime'), contextMode: 'clean' }));
      const cap = new CapcomSession({ dir: r.dir, bin: '/fake/claude', codexBin: '/fake/codex', hubUrl: 'ws://127.0.0.1:1', token: '', trust: false,
        alive: id => id === NEW, wait: async () => {}, note() {}, lineage: { noteSpawn() {}, bind() {}, demote() {} },
        tmux: { available: () => true, spawn: async () => { throw new Error('a native clear must not launch anything'); },
          capture: async () => ({ ok: true, stdout: '', detail: '' }), kill: async () => ({ ok: true, stdout: '', detail: '' }) },
      });
      cap.adopt(OLD);
      cap.adoptCleared(NEW, 'clean', 1234);
      assert.equal(cap.current(), NEW);
      const saved = readIdentity(r.dir)!;
      assert.equal(saved.sessionId, NEW);
      assert.equal(saved.previousSessionId, OLD);
      assert.equal(saved.contextMode, 'clean'); assert.equal(saved.cutoffAt, 1234);
      // Lo demás es el mismo proceso: runtime, modelo y directorio no cambian.
      assert.equal(saved.runtime, 'codex'); assert.equal(saved.model, 'gpt-6-astra');
      assert.equal(saved.cwd, path.join(r.dir, 'runtime'));
      assert.equal(cap.recovery()?.sessionId, NEW, 'and that is what ensure() reads first');
      const back = await cap.ensure();
      assert.equal(back.shortId, NEW, 'the watchdog keeps the new session instead of reviving the cleared one');
      return ok('the record that outranks session.json follows the /clear', true);
    } finally { r.dispose(); }
  }),
  test('the archived transcript is not a second copy, and a superseded archive keeps its evidence without its bulk', () => {
    const r = rig();
    try {
      const live = r.service.review(OLD, 'codex', 'gpt-6-astra', '', 'clean');
      fs.writeFileSync(path.join(r.dir, 'codex-recovery.json'),
        JSON.stringify({ handoffId: live.id, archive: live.archive, sessionId: NEW, model: 'gpt-6-astra', runtime: 'codex' }));
      const stale = r.service.review(OLD, 'codex', 'gpt-6-astra', '', 'clean');
      const source = path.join(stale.archive, 'source.jsonl');
      const shared = fs.statSync(source).ino === fs.statSync(r.source).ino;
      assert.equal(fs.readFileSync(source, 'utf8'), fs.readFileSync(r.source, 'utf8'));
      const next = r.service.review(OLD, 'codex', 'gpt-6-astra', '', 'clean');
      assert.equal(fs.existsSync(source), false);
      assert.equal(fs.existsSync(stale.historyPath), false);
      assert.ok(fs.existsSync(path.join(stale.archive, 'plan.json')) && fs.existsSync(stale.checkpointPath)
        && fs.existsSync(path.join(stale.archive, 'manifest.json')));
      assert.match(fs.readFileSync(path.join(stale.archive, 'PRUNED.md'), 'utf8'), /source\.jsonl, conversation\.md/);
      assert.equal(r.service.status(stale.id).id, stale.id);
      // The activated handoff and the one being prepared are never touched.
      assert.ok(fs.existsSync(live.historyPath) && fs.existsSync(path.join(live.archive, 'source.jsonl')));
      assert.ok(fs.existsSync(next.historyPath) && fs.existsSync(path.join(next.archive, 'source.jsonl')));
      return ok('transcript archived by link; superseded bulk dropped, evidence and live archive intact',
        true, shared ? 'source.jsonl shares the transcript inode' : 'links refused here: fell back to a copy');
    } finally { r.dispose(); }
  }),
  test('the new destination directory is trusted before its pane opens, and a stuck resume keeps its screen', async () => {
    const r = rig(); const home = process.env['CODEX_HOME'];
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-codex-home-'));
    try {
      process.env['CODEX_HOME'] = codexHome;
      let atSpawn = '';
      const cap = new CapcomSession({ dir: r.dir, bin: '/fake/claude', codexBin: '/fake/codex', hubUrl: 'ws://127.0.0.1:1', token: '',
        alive: () => true, wait: async () => {}, note() {}, lineage: { noteSpawn() {}, bind() {}, demote() {} },
        tmux: { available: () => true,
          spawn: async () => { atSpawn = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'); return { ok: true, stdout: '', detail: '' }; },
          // The dialog an unwatched pane can never answer.
          capture: async () => ({ ok: true, stdout: 'Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit', detail: '' }),
          kill: async () => ({ ok: true, stdout: '', detail: '' }),
        },
      });
      cap.adopt(OLD); const plan = r.service.review(OLD, 'codex', 'gpt-6-astra', '', 'clean');
      await assert.rejects(cap.activateHandoff(plan, NEW), /resume-screen\.txt/);
      assert.ok(atSpawn.includes(`[projects."${plan.cwd}"]`) && atSpawn.includes('trust_level = "trusted"'));
      assert.match(fs.readFileSync(path.join(plan.archive, 'resume-screen.txt'), 'utf8'), /Do you trust/);
      assert.equal(cap.current(), OLD);
      return ok('destination trusted before resume; its last screen survives the failure', true);
    } finally {
      if (home === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = home;
      fs.rmSync(codexHome, { recursive: true, force: true }); r.dispose();
    }
  }),
  ...['spawn', 'capture', 'stop', 'timeout'].map(failure => test(`activation ${failure} failure does not retire the old CAPCOM`, async () => {
    const r = rig(); try {
      const killed: string[] = []; const prior = JSON.stringify({ runtime: 'codex', sessionId: OLD, model: 'gpt-6-astra' });
      fs.writeFileSync(path.join(r.dir, 'codex-recovery.json'), prior);
      const cap = new CapcomSession({ dir: r.dir, bin: '/fake/claude', codexBin: '/fake/codex', hubUrl: 'ws://127.0.0.1:1', token: '', trust: false, alive: () => true, wait: async () => {}, note() {}, lineage: { noteSpawn() {}, bind() {}, demote() {} },
        tmux: { available: () => true, spawn: async () => ({ ok: failure !== 'spawn', stdout: '', detail: 'injected spawn' }),
          capture: async () => ({ ok: failure !== 'capture', stdout: failure === 'timeout' ? 'model: loading' : '› Ask Codex to do anything\n ? for shortcuts', detail: 'injected capture' }),
          kill: async name => { killed.push(name); return { ok: !(failure === 'stop' && name === `orca-${OLD}`), stdout: '', detail: 'injected stop' }; },
        },
      });
      cap.adopt(OLD); const plan = r.service.review(OLD, 'codex', 'gpt-6-astra', '', 'clean');
      await assert.rejects(cap.activateHandoff(plan, NEW));
      assert.equal(cap.current(), OLD); assert.equal(fs.readFileSync(path.join(r.dir, 'codex-recovery.json'), 'utf8'), prior);
      if (failure !== 'spawn') assert.equal(killed.at(-1), `orca-${NEW}`);
      if (failure === 'capture' || failure === 'timeout') assert.ok(!killed.includes(`orca-${OLD}`));
      return ok(`${failure}: old identity/config retained; destination cleaned up`, true);
    } finally { r.dispose(); }
  })),
  test('mail waits through destination visibility, drains once to new UUID; old backlog stays in hub', () => {
    let cap = { id: OLD, callsign: 'CAP' } as Agent;
    const sent: [string, string][] = []; const timers: (() => void)[] = [];
    const escalations = { old: { id: 'old', status: 'pending', askedAt: 9, agentId: 'worker', options: [], question: 'old' }, new: { id: 'new', status: 'pending', askedAt: 11, agentId: 'worker', options: [], question: 'new' } } as unknown as Record<string, Escalation>;
    const router = new CapcomRouter({ capcom: () => cap, say: (id, text) => { sent.push([id, text]); }, escalation: id => escalations[id], markWithCeo() {}, giveUp() {}, setTimer: fn => { timers.push(fn); return { cancel() {} }; } });
    router.beginTransfer(OLD, 'clean', 10);
    assert.equal(router.humanSays('new operator message'), 'queued');
    timers[0]!(); assert.equal(router.queued(), 1); // Slow startup never drops mail.
    cap = { id: NEW, callsign: 'CAP' } as Agent;
    assert.equal(router.flush(), 0); assert.equal(router.humanSays('new worker message'), 'queued');
    router.releaseTransfer(NEW); router.releaseTransfer(NEW); router.flush();
    assert.deepEqual(sent, [[NEW, 'new operator message'], [NEW, 'new worker message']]);
    assert.equal(router.offer('old'), false); assert.equal(router.offer('new'), true);
    assert.equal(escalations.old!.status, 'pending'); assert.equal(router.contextCutoff(), 10);
    return ok('FIFO exactly once, no premature dispatch, old questions retained without injection', true);
  }),
  test('failed clean transfer restores prior routing policy and delivers to original; late discovery holds mail', () => {
    let cap = { id: OLD, callsign: 'CAP' } as Agent; const sent: string[] = [];
    const router = new CapcomRouter({ capcom: () => cap, say: id => { sent.push(id); }, escalation: () => undefined, markWithCeo() {}, giveUp() {}, setTimer: () => ({ cancel() {} }) });
    router.beginTransfer(OLD, 'clean', 10); router.humanSays('retained'); router.releaseTransfer();
    assert.deepEqual(sent, [OLD]); assert.equal(router.contextCutoff(), null);
    router.beginTransfer(OLD, 'clean', 20); router.humanSays('new'); router.releaseTransfer(NEW);
    assert.equal(router.queued(), 1); assert.deepEqual(sent, [OLD]);
    cap = { id: NEW, callsign: 'CAP' } as Agent; router.flush();
    assert.deepEqual(sent, [OLD, NEW]); return ok('rollback and delayed target discovery retain mail', true);
  }),
  test('terminal input pauses during transfer and resumes on rollback', () => {
    const writes: string[] = []; const frames: unknown[] = []; let locked = false;
    const relay = new TerminalRelay({ agent: () => ({ id: OLD, pane: `orca-${OLD}`, callsign: 'CP' } as AgentHandle), inputBlocked: () => locked,
      send: f => { frames.push(f); }, tmux: { available: () => true, attach: () => ({ ok: true, tty: { write: (s: string) => writes.push(s), resize() {}, kill() {}, onData() {}, onExit() {} } }) } as unknown as TmuxHost,
    });
    const termId = 'term_fresh_fixture';
    relay.handle({ t: 'term:open', termId, agentId: OLD, cols: 80, rows: 24 });
    relay.handle({ t: 'term:input', termId, data: 'before' }); locked = true;
    relay.handle({ t: 'term:input', termId, data: 'must not dispatch' }); locked = false;
    relay.handle({ t: 'term:input', termId, data: 'after' });
    assert.deepEqual(writes, ['before', 'after']); assert.match(JSON.stringify(frames), /Send new messages through TALK/);
    relay.close(termId, 'fixture complete'); return ok('attached terminal cannot race fresh CAPCOM activation', true);
  }),
  test('interrupted preparation releases hold using the durable activated UUID', () => {
    const r = rig(); try {
      const p = r.service.review(OLD, 'codex', 'gpt-6-astra', '', 'clean');
      fs.writeFileSync(path.join(p.archive, 'plan.json'), JSON.stringify({ ...p, phase: 'preparing' }));
      fs.writeFileSync(path.join(r.dir, 'codex-recovery.json'), JSON.stringify({ handoffId: p.id, sessionId: NEW }));
      const resumed = new ProviderHandoffs(r.deps).status(p.id);
      assert.equal(resumed.phase, 'complete'); assert.equal(resumed.toId, NEW); assert.deepEqual(r.holds, [false]);
      return ok('status reconciles a persisted cutover without starting another runtime', true);
    } finally { r.dispose(); }
  }),
  test('continuity checkpoint is bounded metadata; histories and complete rules remain externally retrievable', () => {
    const world = { missions: { task_a: { id: 'task_a', title: 'Pending title', status: 'active', agentIds: ['worker'], messages: [{ id: 'message_a', text: 'CONVERSATION_MUST_NOT_LEAK' }] } }, agents: {}, escalations: {} } as unknown as WorldState;
    const checkpoint = freshCapcomCheckpoint(world, []);
    assert.match(checkpoint, /task_a/); assert.match(checkpoint, /message_a/); assert.ok(!checkpoint.includes('CONVERSATION_MUST_NOT_LEAK'));
    assert.match(checkpoint, /recall/); assert.ok(checkpoint.length < 48 * 1024);
    return ok('pending references without full conversation', true);
  }),
] };
