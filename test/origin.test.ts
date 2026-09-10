import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentOrigin, groupOrigin } from '../src/shared/origin.ts';
import { LineageIndex } from '../src/collector/lineage.ts';
import { sanitizeAgentPatch } from '../src/hub/world.ts';
import { Store, onField } from '../src/ui/store.ts';
import { getPref, setPref } from '../src/ui/prefs.ts';
import { emptyWorld, type Agent } from '../src/shared/types.ts';
import { test, ok } from './harness.ts';
const agent = (id: string, extra: Partial<Agent> = {}) => ({ id, state: 'working', mission: null, updatedAt: Date.now(), ...extra } as Agent);
export default { suite: 'Origin and visual cleanup', tests: [
  test('missions do not imply ownership; registered launches and descendants survive restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-origin-'));
    try {
      const file = path.join(dir, 'lineage.json');
      const meta = path.join(dir, 'child.meta.json');
      fs.writeFileSync(meta, JSON.stringify({ description: 'A native external mission', spawnDepth: 1 }));
      const inputs = [
        { key: 'root#child', sessionId: 'root', agentId: 'child', metaPath: meta, shortId: null },
        { key: 'root', sessionId: 'root', agentId: null, metaPath: null, shortId: null },
      ];
      const index = new LineageIndex(file);
      let resolved = index.resolve(inputs);
      assert.equal(resolved.get('root#child')!.origin, 'external');
      assert.equal(agentOrigin(agent('native', { ...resolved.get('root#child')! })), 'external');
      assert.equal(agentOrigin(agent('old', { mission: 'Some task' })), 'unknown');
      index.noteSpawn('root', null, null);
      resolved = new LineageIndex(file).resolve(inputs);
      assert.equal(resolved.get('root')!.origin, 'orca');
      assert.equal(resolved.get('root#child')!.origin, 'orca');
      assert.equal(groupOrigin([agent('one', { origin: 'orca' }), agent('two', { origin: 'external' })]), 'MIXED');
      assert.deepEqual(sanitizeAgentPatch({ origin: 'orca' }), { origin: 'orca' });
      assert.deepEqual(sanitizeAgentPatch({ origin: 'guessed' }), {});
      return ok('verified origin and inherited provenance', true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }),
  test('cleanup is reversible and preserves working, thinking and blocked agents', () => {
    const previous = { showAll: getPref('showAll'), origin: getPref('origin') };
    try {
      setPref('origin', 'all'); setPref('showAll', false);
      const now = Date.now(); const store = new Store(); const w = emptyWorld();
      const all = [
        agent('finished', { origin: 'orca', state: 'done' }),
        agent('stale', { origin: 'orca', state: 'idle', updatedAt: now - 7200000 }),
        agent('blocked', { origin: 'orca', state: 'blocked', updatedAt: now - 7200000 }),
        agent('busy', { origin: 'external' }),
        agent('thinking', { origin: 'orca', state: 'thinking' }),
      ];
      w.agents = Object.fromEntries(all.map((a) => [a.id, a])); store.replaceWorld(w);
      assert.equal(store.cleanup(now), 1);
      assert.deepEqual(Object.keys(store.world.agents).sort(), ['blocked', 'busy', 'thinking']);
      assert.equal(store.everyone().length, 5);
      setPref('showAll', true); store.refilter(); assert.equal(Object.keys(store.world.agents).length, 5);
      setPref('showAll', false); setPref('origin', 'orca'); store.refilter();
      assert.deepEqual(Object.keys(store.world.agents).sort(), ['blocked', 'thinking']);
      assert(!onField(agent('oldDone', { origin: 'orca', state: 'done', updatedAt: now - 660000 }), now));
      assert(onField(agent('oldBlocked', { origin: 'orca', state: 'blocked', updatedAt: now - 7200000 }), now));
      return ok('archive visibility, filters and active work preserved', true);
    } finally { setPref('origin', previous.origin); setPref('showAll', previous.showAll); }
  }),
  test('el CAPCOM vivo no se puede esconder del campo; uno terminado sí', () => {
    const previous = { showAll: getPref('showAll'), origin: getPref('origin') };
    try {
      setPref('origin', 'all'); setPref('showAll', false);
      const store = new Store(); const w = emptyWorld();
      const all = [
        agent('cap', { role: 'capcom', state: 'working' }),
        agent('past', { role: 'capcom', state: 'done' }),
        agent('w1', { origin: 'orca', state: 'working' }),
      ];
      w.agents = Object.fromEntries(all.map((a) => [a.id, a])); store.replaceWorld(w);
      // Un descarte en bloque se lleva lo que puede y deja al mando donde está.
      assert.equal(store.dismiss(['cap', 'past', 'w1']), 2);
      assert.deepEqual(Object.keys(store.world.agents), ['cap']);
      assert(!store.isDismissed('cap'));
      return ok('el mando sigue en el campo tras un DISMISS', true);
    } finally { setPref('origin', previous.origin); setPref('showAll', previous.showAll); }
  }),
] };
