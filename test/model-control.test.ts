import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { peekIdentity } from '../src/collector/capcom-identity.ts';
import { ModelController, modelMenu, modelPromptReady, modelConfirmed, pendingDialog, switchConfirmation } from '../src/collector/model-control.ts';
import type { AgentHandle } from '../src/collector/commands.ts';
import { test, ok } from './harness.ts';
import { sanitizeAgentPatch } from '../src/hub/world.ts';

function rig(runtime = 'codex', catalog?: { id: string; label: string }[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-model-'));
  const a = { id: 'capcom', sessionId: 'session-1234', shortId: null, runtime, pane: 'orca-test', alive: true, state: 'idle', model: 'old' } as AgentHandle;
  let view = 'prompt'; let selection = 0; let current = 0; let confirmed = false;
  const ids = runtime === 'codex' ? ['old', 'new'] : ['Opus', 'Sonnet'];
  const writes: string[] = [];
  const screen = () => view === 'menu'
    ? `${runtime === 'codex' ? 'Select Model and Effort' : 'Select model'}\n${ids.map((id, i) => `${i === selection ? '›' : ' '} ${i + 1}. ${id}  description`).join('\n')}\ns to use this session only`
    : view === 'effort' ? 'Select Reasoning Level for new\n› 1. Medium'
    : `${confirmed ? runtime === 'codex' ? '• Model changed to new medium' : '⎿ Set model to Sonnet 5 for this session only' : ''}\n${runtime === 'codex' ? '› Ask Codex to do anything' : '❯ '}`;
  const good = () => ({ ok: true, detail: '', stdout: '' });
  const deps = { dir: () => dir, owns: () => true, agent: () => a, wait: async () => {}, ...(catalog ? { catalog: () => catalog } : {}), tmux: {
    capture: async () => ({ ...good(), stdout: screen() }),
    paste: async (_pane: string, text: string) => { assert.equal(text, '/model'); writes.push(text); view = 'menu'; selection = current; return good(); },
    keys: async (_pane: string, keys: string[]) => {
      writes.push(keys.join(','));
      for (const key of keys) {
        if (key === 'Down') selection++;
        if (key === 'Up') selection--;
        if (key === 'Escape') view = 'prompt';
        if (key === 's' || (key === 'Enter' && view === 'effort')) { current = selection; confirmed = true; view = 'prompt'; }
        else if (key === 'Enter') view = 'effort';
      }
      return good();
    },
  } };
  const controller = new ModelController(deps);
  const settle = async () => { for (let i = 0; i < 100 && controller.locked(a.id); i++) await Promise.resolve(); };
  return { dir, a, writes, deps, controller, settle, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/*
 * Pantallas reales de Claude Code 2.1.268 (capturadas con `capture-pane -p -J`
 * en una sesión desechable): Sonnet 5 con una respuesta ya dada, `/model`,
 * Opus (1M context) y `s`. Al menú se le quitaron las líneas en blanco.
 */
const real = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const MENU = real('model-control/claude-model-menu-2.1.268');
const SWITCH = real('model-control/claude-switch-dialog-2.1.268');
const SWITCH_HAIKU = real('model-control/claude-switch-dialog-haiku-2.1.268');
const CONFIRMED = real('model-control/claude-switch-confirmed-2.1.268');
const PROMPT = CONFIRMED.split('\n').filter(l => !/^❯ \/model|Set model to/.test(l)).join('\n');
const OPUS = { id: 'opus', label: 'Opus (1M context)' };

/** Un Claude que tras `s` enseña `afterS`; Enter sobre el diálogo de cambio lo confirma si `enterConfirms`. */
function claudeRig(afterS: string, enterConfirms = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-model-'));
  const a = { id: 'capcom', sessionId: 'session-1234', shortId: null, runtime: 'claude', pane: 'orca-test', alive: true, state: 'idle', model: 'sonnet' } as AgentHandle;
  let view = PROMPT; let selection = 4;
  const menu = () => MENU.replace('   ❯ 4.', '     4.').replace(`     ${selection}.`, `   ❯ ${selection}.`);
  const writes: string[] = [];
  const good = () => ({ ok: true, detail: '', stdout: '' });
  const deps = { dir: () => dir, owns: () => true, agent: () => a, wait: async () => {}, catalog: () => [OPUS, { id: 'sonnet', label: 'Sonnet' }], tmux: {
    capture: async () => ({ ...good(), stdout: view === MENU ? menu() : view }),
    paste: async (_pane: string, text: string) => { writes.push(text); view = MENU; selection = 4; return good(); },
    keys: async (_pane: string, keys: string[]) => {
      writes.push(keys.join(','));
      for (const key of keys) {
        if (key === 'Down') selection++;
        if (key === 'Up') selection--;
        if (key === 'Escape') view = PROMPT;
        if (key === 's' && view === MENU) view = selection === 2 ? afterS : PROMPT;
        else if (key === 'Enter' && view === SWITCH && enterConfirms) view = CONFIRMED;
      }
      return good();
    },
  } };
  const controller = new ModelController(deps);
  const settle = async () => { for (let i = 0; i < 1000 && controller.locked(a.id); i++) await new Promise(r => setImmediate(r)); };
  return { dir, a, writes, controller, settle, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export default { suite: 'CAPCOM model control', tests: [
  test('hub retains bounded model state and rejects malformed metadata', async () => {
    const r = rig();
    try {
      const state = await r.controller.list(r.a.id);
      assert.deepEqual(sanitizeAgentPatch({ modelControl: state }).modelControl, state);
      assert.equal(sanitizeAgentPatch({ modelControl: { ...state, phase: 'invented' } }).modelControl, undefined);
      assert.equal(sanitizeAgentPatch({ modelControl: { ...state, sessionId: '../escape' } }).modelControl, undefined);
      return ok('wire state survives validation', true);
    } finally { r.dispose(); }
  }),
  test('menus and prompt guards recognize native controls, refuse drafts and dialogs', () => {
    assert.equal(modelMenu('Select Model and Effort\n› 1. gpt-6-astra (current)  description', 'codex')[0]?.id, 'gpt-6-astra');
    assert.equal(modelMenu('Select model\n ❯ 2. Opus (1M context) ✔  description', 'claude')[0]?.id, 'opus');
    assert.equal(modelPromptReady('› my unfinished draft', 'codex'), false);
    assert.equal(modelPromptReady('› Ask Codex to do anything\nEsc to interrupt', 'codex'), false);
    assert.equal(modelPromptReady('❯\u00a0', 'claude'), true);
    assert.equal(modelConfirmed('› /model new', 'codex', { id: 'new', label: 'new' }), false);
    return ok('native menus only', true);
  }),
  test('queued change waits for idle, confirms same session, persists recovery and journal', async () => {
    const r = rig();
    try {
      fs.writeFileSync(path.join(r.dir, 'codex-recovery.json'), JSON.stringify({ sessionId: r.a.sessionId, model: 'old' }));
      await r.controller.list(r.a.id);
      r.a.state = 'working'; r.controller.request(r.a.id, 'new'); r.controller.tick(r.a);
      assert.equal(r.controller.state(r.a)?.phase, 'queued');
      assert.equal(r.writes.filter(x => x === '/model').length, 1);
      r.a.state = 'idle'; r.controller.tick(r.a); await r.settle();
      const state = r.controller.state(r.a)!;
      assert.equal(state.phase, 'ready'); assert.equal(state.active, 'new'); assert.equal(state.sessionId, 'session-1234');
      assert.equal(state.events.length, 1);
      // Un agente cuyo id no es una sesión de mando: se mira sin exigir que
      // el archivo sea una identidad de CAPCOM.
      const recovery = peekIdentity(r.dir);
      assert.equal(recovery, null, 'a non-CAPCOM session leaves the command identity alone');
      assert.match(fs.readFileSync(path.join(r.dir, 'codex-recovery.json'), 'utf8'), /"model": ?"old"|"model":"old"/);
      const restarted = new ModelController(r.deps);
      assert.deepEqual(restarted.state(r.a), state);
      assert.equal(fs.readFileSync(path.join(r.dir, 'model-changes.jsonl'), 'utf8').trim().split('\n').length, 1);
      return ok('queued, confirmed, durable, same identity', true);
    } finally { r.dispose(); }
  }),
  test('Claude changes only this session, never the account default', async () => {
    const r = rig('claude');
    try {
      await r.controller.list(r.a.id); r.controller.request(r.a.id, 'sonnet'); r.controller.tick(r.a); await r.settle();
      assert.equal(r.controller.state(r.a)?.active, 'sonnet');
      assert.ok(r.writes.includes('s')); assert.ok(!r.writes.includes('Enter'));
      return ok('session-only Claude selection', true);
    } finally { r.dispose(); }
  }),
  test('cancel, unknown model and interrupted change never dispatch another change', async () => {
    const r = rig();
    try {
      await r.controller.list(r.a.id);
      assert.throws(() => r.controller.request(r.a.id, 'other-provider'), /choose one/);
      r.controller.request(r.a.id, 'new'); r.controller.request(r.a.id, null); r.controller.tick(r.a);
      assert.equal(r.controller.state(r.a)?.phase, 'ready');
      const file = path.join(r.dir, `model-control-${r.a.sessionId}.json`);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')); saved.phase = 'applying'; fs.writeFileSync(file, JSON.stringify(saved));
      const restarted = new ModelController(r.deps);
      assert.equal(restarted.state(r.a)?.phase, 'failed'); restarted.tick(r.a);
      assert.equal(r.writes.filter(x => x === '/model').length, 1);
      return ok('no implicit retry after ambiguous delivery', true);
    } finally { r.dispose(); }
  }),
  test('missing CLI confirmation stays failed, and never claims the requested model is active', async () => {
    const r = rig();
    try {
      await r.controller.list(r.a.id);
      const capture = r.deps.tmux.capture;
      r.deps.tmux.capture = async () => {
        const result = await capture();
        return { ...result, stdout: result.stdout.replace('• Model changed to new medium', '') };
      };
      r.controller.request(r.a.id, 'new'); r.controller.tick(r.a); await r.settle();
      assert.equal(r.controller.state(r.a)?.phase, 'failed');
      assert.equal(r.controller.state(r.a)?.active, 'old');
      assert.equal(r.controller.state(r.a)?.events.length, 0);
      assert.ok(!fs.existsSync(path.join(r.dir, 'model-changes.jsonl')));
      return ok('unconfirmed is not success', true);
    } finally { r.dispose(); }
  }),
  test('a provider-catalog model is accepted while the session is busy, and the CLI menu confirms it once idle', async () => {
    // Nadie ha tecleado `/model` en esta sesión —está trabajando—, así que
    // `choices` está vacío. Antes eso bloqueaba cualquier cambio dentro del
    // mismo proveedor con «Refresh models»: el catálogo del proveedor basta
    // para encolar, y la verificación de verdad sigue siendo el menú real.
    const r = rig('claude', [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }]);
    try {
      r.a.state = 'working';
      assert.deepEqual(r.controller.state(r.a)?.choices, [], 'nothing was listed');
      const queued = r.controller.request(r.a.id, 'sonnet');
      assert.equal(queued.phase, 'queued'); assert.equal(queued.requested, 'sonnet');
      r.controller.tick(r.a);
      assert.equal(r.writes.length, 0, 'a busy session is not typed into');
      r.a.state = 'idle'; r.controller.tick(r.a); await r.settle();
      const state = r.controller.state(r.a)!;
      assert.equal(state.phase, 'ready'); assert.equal(state.active, 'sonnet');
      assert.ok(r.writes.includes('/model') && r.writes.includes('s'), 'applied through the native menu, session-only');
      // Y lo que el catálogo no conoce se sigue rechazando de entrada.
      assert.throws(() => r.controller.request(r.a.id, 'invented'), /choose one/);
      return ok('catalog admits, menu confirms', true);
    } finally { r.dispose(); }
  }),
  test('a catalog model this CLI does not offer fails at the menu with its reason, and changes nothing', async () => {
    // El catálogo dice «haiku»; el menú de este CLI sólo tiene Opus y Sonnet.
    // La protección real está aquí: se abre el menú, no está, se cierra y
    // queda «failed» diciendo por qué — nunca se pulsa a ciegas.
    const r = rig('claude', [{ id: 'haiku', label: 'Haiku' }]);
    try {
      r.controller.request(r.a.id, 'haiku'); r.controller.tick(r.a); await r.settle();
      const state = r.controller.state(r.a)!;
      assert.equal(state.phase, 'failed');
      assert.match(state.detail, /does not offer haiku/);
      assert.equal(state.active, 'old'); assert.equal(state.events.length, 0);
      assert.deepEqual(r.writes, ['/model', 'Escape'], 'menu opened, nothing selected, menu closed');
      return ok('unoffered model: clear failure, no keystrokes beyond closing the menu', true);
    } finally { r.dispose(); }
  }),
  test('the real "Switch model?" dialog is recognized for its own model only, and unknown dialogs are named', () => {
    assert.ok(switchConfirmation(SWITCH, OPUS), 'Sonnet → Opus 5 (1M context)');
    assert.ok(switchConfirmation(SWITCH_HAIKU, { id: 'haiku', label: 'Haiku' }), 'Sonnet → Haiku 4.5: not only 1M');
    assert.ok(!switchConfirmation(SWITCH_HAIKU, OPUS), 'a dialog for another model is not ours to confirm');
    assert.ok(!switchConfirmation(CONFIRMED, OPUS) && !switchConfirmation(MENU, OPUS));
    assert.ok(CONFIRMED.split('\n').some(l => modelConfirmed(l, 'claude', OPUS)));
    assert.equal(pendingDialog(SWITCH), 'Switch model?');
    assert.equal(pendingDialog(MENU), 'Select model');
    assert.equal(pendingDialog(real('permissions/claude-bash-2.1.263')), 'Bash command');
    assert.equal(pendingDialog(CONFIRMED), null);
    assert.equal(pendingDialog(PROMPT), null);
    return ok('real 2.1.268 screens', true);
  }),
  test('Claude asks to confirm a switch away from a cached model: answered once, session-only, confirmed', async () => {
    const r = claudeRig(SWITCH);
    try {
      r.controller.request(r.a.id, 'opus'); r.controller.tick(r.a); await r.settle();
      const state = r.controller.state(r.a)!;
      assert.equal(state.phase, 'ready', state.detail); assert.equal(state.active, 'opus');
      assert.equal(state.events.length, 1);
      assert.deepEqual(r.writes, ['/model', 'Up,Up', 's', 'Enter'], 'session-only pick, then the dialog\'s «Yes»');
      assert.equal(fs.readFileSync(path.join(r.dir, 'model-changes.jsonl'), 'utf8').trim().split('\n').length, 1);
      return ok('Sonnet 5 → Opus 5 (1M context) without a human', true);
    } finally { r.dispose(); }
  }),
  test('an unknown dialog after `s` stays failed, untouched, and the detail quotes what it asks', async () => {
    const r = claudeRig(real('permissions/claude-bash-2.1.263'));
    try {
      r.controller.request(r.a.id, 'opus'); r.controller.tick(r.a); await r.settle();
      const state = r.controller.state(r.a)!;
      assert.equal(state.phase, 'failed'); assert.equal(state.active, 'sonnet'); assert.equal(state.events.length, 0);
      assert.match(state.detail, /The CLI is asking "Bash command"/);
      assert.deepEqual(r.writes, ['/model', 'Up,Up', 's'], 'nothing typed into a dialog nobody here understands');
      assert.ok(!fs.existsSync(path.join(r.dir, 'model-changes.jsonl')));
      return ok('unknown dialog: named, not answered', true);
    } finally { r.dispose(); }
  }),
  test('a switch dialog that survives its answer is pressed once, then left to the operator', async () => {
    const r = claudeRig(SWITCH, false);
    try {
      r.controller.request(r.a.id, 'opus'); r.controller.tick(r.a); await r.settle();
      const state = r.controller.state(r.a)!;
      assert.equal(state.phase, 'failed'); assert.match(state.detail, /asking "Switch model\?"/);
      assert.equal(r.writes.filter(w => w === 'Enter').length, 1);
      return ok('one Enter, never a loop', true);
    } finally { r.dispose(); }
  }),
  test('permission blocks cannot be interrupted by a queued model change', async () => {
    const r = rig();
    try {
      await r.controller.list(r.a.id); r.controller.request(r.a.id, 'new');
      r.a.state = 'blocked'; r.a.blockKind = 'permission'; r.controller.tick(r.a);
      assert.equal(r.controller.state(r.a)?.phase, 'queued');
      assert.equal(r.writes.filter(x => x === '/model').length, 1);
      r.a.blockKind = 'error'; r.controller.tick(r.a); await r.settle();
      assert.equal(r.controller.state(r.a)?.active, 'new');
      return ok('permission deferred, error can recover', true);
    } finally { r.dispose(); }
  }),
] };
