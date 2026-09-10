import assert from 'node:assert/strict';
import { mountWakeLock } from '../src/ui/wake-lock.ts';
import { test, ok } from './harness.ts';
export default { suite: 'wake-lock', tests: [test('visible installed app acquires, hides/releases and reacquires; late acquisition is released', async () => {
  const names = ['navigator', 'document', 'matchMedia', 'localStorage'] as const;
  const before = names.map(n => Object.getOwnPropertyDescriptor(globalThis, n));
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const display = Object.assign(new EventTarget(), { matches: true });
  let acquired = 0, released = 0;
  let resolve: ((s: WakeLockSentinel) => void) | undefined;
  const sentinel = () => Object.assign(new EventTarget(), { release: async () => { released++; } }) as WakeLockSentinel;
  const mocks = [{ wakeLock: { request: async () => { acquired++; return new Promise<WakeLockSentinel>(r => { resolve = r; }); } } }, doc, () => display, { getItem: () => null, setItem: () => {} }];
  names.forEach((n, i) => Object.defineProperty(globalThis, n, { configurable: true, value: mocks[i] }));
  const tick = () => new Promise(r => setTimeout(r, 0));
  try {
    const wake = mountWakeLock(); assert.equal(acquired, 1);
    resolve!(sentinel()); await tick();
    doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')); await tick(); assert.equal(released, 1);
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); assert.equal(acquired, 2);
    wake.set(false); resolve!(sentinel()); await tick(); assert.equal(released, 2);
    wake.set(true); assert.equal(acquired, 3); resolve!(sentinel()); await tick();
    wake.dispose(); await tick(); assert.equal(released, 3);
    doc.dispatchEvent(new Event('visibilitychange')); assert.equal(acquired, 3);
    return ok('wake lifecycle', true);
  } finally { names.forEach((n, i) => { const d = before[i]; if (d) Object.defineProperty(globalThis, n, d); else Reflect.deleteProperty(globalThis, n); }); }
})] };
