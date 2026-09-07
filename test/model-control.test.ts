import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelController, modelMenu, modelPromptReady, modelConfirmed } from '../src/collector/model-control.ts';
import type { AgentHandle } from '../src/collector/commands.ts';
import { test, ok } from './harness.ts';
import { sanitizeAgentPatch } from '../src/hub/world.ts';

function rig(runtime = 'codex') {
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
  const deps = { dir: () => dir, owns: () => true, agent: () => a, wait: async () => {}, tmux: {
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
      const recovery = JSON.parse(fs.readFileSync(path.join(r.dir, 'codex-recovery.json'), 'utf8'));
      assert.equal(recovery.model, 'new'); assert.equal(recovery.handoffModel, 'old');
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
