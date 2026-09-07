/**
 * ui/drafts.ts — the text typed and not yet sent, across a reload.
 *
 * What is worth guarding: a keystroke lands in storage after the debounce
 * and not before; the last write wins; an empty field removes its key; a
 * field opened after a reload gets its text back with the caret at the end
 * and never overwrites text already there; sending forgets the draft; a
 * storage that throws is survived; and pending writes flush on demand.
 */

import { createDrafts, draftKey, DRAFT_PREFIX, type DraftField, type DraftsIO, type StorageLike } from '../src/ui/drafts.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

/** A storage that remembers, and can be told to refuse. */
function memStorage(broken = false): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const fail = () => { if (broken) throw new Error('QuotaExceededError'); };
  return {
    map,
    getItem: (k) => { fail(); return map.get(k) ?? null; },
    setItem: (k, v) => { fail(); map.set(k, v); },
    removeItem: (k) => { fail(); map.delete(k); },
  };
}

/** Timers that only fire when the test says so. */
function fakeTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  const io: DraftsIO = {
    set: (fn) => { const h = next++; pending.set(h, fn); return h; },
    clear: (h) => { pending.delete(h); },
  };
  const fire = () => { for (const [h, fn] of [...pending]) { pending.delete(h); fn(); } };
  return { io, pending, fire };
}

/** A text field with just enough of the DOM to be typed into. */
function field(value = ''): DraftField & { type(s: string): void; caret: [number, number] | null } {
  const listeners = new Set<() => void>();
  const f = {
    value,
    caret: null as [number, number] | null,
    addEventListener: (_: 'input', fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_: 'input', fn: () => void) => { listeners.delete(fn); },
    setSelectionRange(a: number, b: number) { f.caret = [a, b]; },
    type(s: string) { f.value += s; for (const fn of listeners) fn(); },
  };
  return f;
}

const K = draftKey('capcom');

const mod: TestModule = {
  suite: 'drafts',
  tests: [
    test('draftKey: one key per destination, all under the same prefix', () => {
      const a = draftKey('capcom'), b = draftKey('capcom', 'task-7'), c = draftKey('agent', 'a1');
      return ok('keys', a === `${DRAFT_PREFIX}capcom` && b === `${DRAFT_PREFIX}capcom:task-7` && c === `${DRAFT_PREFIX}agent:a1`, `${a} ${b} ${c}`);
    }),

    test('typing writes after the debounce, not on every keystroke', () => {
      const s = memStorage(); const t = fakeTimers();
      const d = createDrafts(s, t.io);
      const f = field();
      d.bind(f, K);
      f.type('fleet '); f.type('status');
      const before = s.map.get(K);
      const timers = t.pending.size;
      t.fire();
      return ok('debounced', before === undefined && timers === 1 && s.map.get(K) === 'fleet status',
        `before=${JSON.stringify(before)} timers=${timers} after=${JSON.stringify(s.map.get(K))}`);
    }),

    test('get() sees the pending text before it lands', () => {
      const s = memStorage(); const t = fakeTimers();
      const d = createDrafts(s, t.io);
      d.set(K, 'half a');
      return eq('pending visible', d.get(K), 'half a');
    }),

    test('an emptied field removes its key', () => {
      const s = memStorage(); const t = fakeTimers();
      const d = createDrafts(s, t.io);
      const f = field();
      d.bind(f, K);
      f.type('oops'); t.fire();
      f.value = ''; f.type(''); t.fire();
      return ok('removed', !s.map.has(K), `still ${JSON.stringify(s.map.get(K))}`);
    }),

    test('restore(): the text comes back, caret at the end', () => {
      const s = memStorage(); const t = fakeTimers();
      s.map.set(K, 'what is K9 doing');
      const d = createDrafts(s, t.io);
      const f = field();
      const got = d.bind(f, K).restore();
      return ok('restored', got && f.value === 'what is K9 doing' && f.caret?.[0] === 16 && f.caret?.[1] === 16,
        `got=${got} value=${JSON.stringify(f.value)} caret=${JSON.stringify(f.caret)}`);
    }),

    test('restore() never overwrites text already in the field', () => {
      const s = memStorage(); const t = fakeTimers();
      s.map.set(K, 'old');
      const d = createDrafts(s, t.io);
      const f = field('typed first');
      const got = d.bind(f, K).restore();
      return ok('kept', !got && f.value === 'typed first', `got=${got} value=${JSON.stringify(f.value)}`);
    }),

    test('restore() with nothing stored leaves the field alone', () => {
      const d = createDrafts(memStorage(), fakeTimers().io);
      const f = field();
      const got = d.bind(f, K).restore();
      return ok('nothing', !got && f.value === '' && f.caret === null);
    }),

    test('clear() on send forgets the draft, pending write included', () => {
      const s = memStorage(); const t = fakeTimers();
      const d = createDrafts(s, t.io);
      const f = field();
      const b = d.bind(f, K);
      f.type('sent'); t.fire();
      f.type(' and more');       // pending, not landed
      b.clear();
      t.fire();                  // a stale timer must not resurrect it
      return ok('gone', !s.map.has(K) && d.get(K) === '' && t.pending.size === 0,
        `stored=${JSON.stringify(s.map.get(K))} get=${JSON.stringify(d.get(K))} pending=${t.pending.size}`);
    }),

    test('rekey(): CAPCOM switches task, each conversation keeps its own line', () => {
      const s = memStorage(); const t = fakeTimers();
      const d = createDrafts(s, t.io);
      const f = field();
      const b = d.bind(f, draftKey('capcom'));
      f.type('general line');
      b.save();
      b.rekey(draftKey('capcom', 't1'));
      f.value = ''; b.restore();
      const onT1 = f.value;
      f.type('task line'); t.fire();
      b.save(); b.rekey(draftKey('capcom')); f.value = ''; b.restore();
      const back = f.value;
      return ok('separate', onT1 === '' && back === 'general line' && s.map.get(draftKey('capcom', 't1')) === 'task line',
        `t1=${JSON.stringify(onT1)} back=${JSON.stringify(back)} stored=${JSON.stringify([...s.map])}`);
    }),

    test('flush() lands every pending write at once', () => {
      const s = memStorage(); const t = fakeTimers();
      const d = createDrafts(s, t.io);
      d.set(draftKey('agent', 'a1'), 'one');
      d.set(draftKey('agent', 'a2'), 'two');
      d.flush();
      return ok('flushed', s.map.get(draftKey('agent', 'a1')) === 'one' && s.map.get(draftKey('agent', 'a2')) === 'two' && t.pending.size === 0,
        `stored=${JSON.stringify([...s.map])} pending=${t.pending.size}`);
    }),

    test('dispose() stops listening and flushes what was pending', () => {
      const s = memStorage(); const t = fakeTimers();
      const d = createDrafts(s, t.io);
      const f = field();
      const b = d.bind(f, K);
      f.type('kept');
      b.dispose();
      f.type(' ignored');
      t.fire();
      return eq('stored at dispose', s.map.get(K), 'kept');
    }),

    test('a storage that throws is survived, and the field still types', () => {
      const s = memStorage(true); const t = fakeTimers();
      const d = createDrafts(s, t.io);
      const f = field();
      const b = d.bind(f, K);
      f.type('private mode'); t.fire();
      const read = d.get(K);
      const restored = b.restore();
      b.clear();
      return ok('survived', f.value === 'private mode' && read === '' && restored === false, `value=${JSON.stringify(f.value)} read=${JSON.stringify(read)}`);
    }),

    test('no storage at all: everything is a no-op', () => {
      const t = fakeTimers();
      const d = createDrafts(null, t.io);
      const f = field();
      const b = d.bind(f, K);
      f.type('x'); t.fire(); b.save(); b.clear(); d.flush();
      return ok('quiet', d.get(K) === '' && !b.restore());
    }),
  ],
};

export default mod;
