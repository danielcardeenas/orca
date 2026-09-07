/**
 * ui/hud/update.ts — "UPDATE AVAILABLE · CLICK TO RELOAD".
 *
 * What is worth guarding: the build id is the set of hashed `/assets/*`
 * paths in index.html and nothing else about the file; a served index with
 * a different set marks a newer build, the same set does not; a failed or
 * empty fetch says nothing; a dev page (no hashed assets) never polls; the
 * poll stops once a build shows up; the dev signal marks once; and stop()
 * leaves no timer behind.
 */

import { buildFingerprint, createUpdateSentinel, type SentinelIO } from '../src/ui/hud/update.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const BUILD_A = `<!doctype html><html><head><title>ORCA · Field</title>
    <script type="module" crossorigin src="/assets/index-Bua9IZKS.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-Ba9sScWB.css">
    <link rel="icon" href="/icon.svg" type="image/svg+xml">
  </head><body><div id="app"></div></body></html>`;
const BUILD_B = BUILD_A.replace('index-Bua9IZKS.js', 'index-Qz7wEe3k.js');
const DEV = `<!doctype html><html><head><script type="module" src="/@vite/client"></script>
  <script type="module" src="/src/ui/main.ts"></script></head><body></body></html>`;

/** A fetch that answers from a script, and timers that only fire on demand. */
function fakeIO(answers: (string | null | Error)[]) {
  let next = 1;
  const pending = new Map<number, () => void>();
  let fetches = 0;
  const io: SentinelIO = {
    fetchIndex: async () => {
      fetches++;
      const a = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (a instanceof Error) throw a;
      return a;
    },
    set: (fn) => { const h = next++; pending.set(h, fn); return h; },
    clear: (h) => { pending.delete(h); },
  };
  const fire = async () => { for (const [h, fn] of [...pending]) { pending.delete(h); fn(); } await Promise.resolve(); await Promise.resolve(); };
  return { io, pending, fire, fetches: () => fetches };
}

const mod: TestModule = {
  suite: 'update',
  tests: [
    test('buildFingerprint: the hashed assets, sorted, and only those', () => {
      const fp = buildFingerprint(BUILD_A);
      return eq('fingerprint', fp, '/assets/index-Ba9sScWB.css\n/assets/index-Bua9IZKS.js');
    }),
    test('buildFingerprint: a dev index has no hashed assets', () => {
      return eq('empty', buildFingerprint(DEV), '');
    }),
    test('buildFingerprint: whitespace or a retitled page is the same build', () => {
      const same = buildFingerprint(BUILD_A.replace('ORCA · Field', 'ORCA').replace(/\n\s+/g, '\n'));
      return eq('unchanged', same, buildFingerprint(BUILD_A));
    }),

    test('check(): a different set of assets marks a newer build', async () => {
      const f = fakeIO([BUILD_B]);
      const s = createUpdateSentinel(buildFingerprint(BUILD_A), f.io);
      const reasons: string[] = [];
      s.onChange((r) => reasons.push(r));
      const got = await s.check();
      return ok('marked', got && s.available() && reasons.join() === 'build', `got=${got} reasons=${reasons.join()}`);
    }),
    test('check(): the same build says nothing', async () => {
      const f = fakeIO([BUILD_A]);
      const s = createUpdateSentinel(buildFingerprint(BUILD_A), f.io);
      const got = await s.check();
      return ok('quiet', !got && !s.available());
    }),
    test('check(): a failed or empty fetch says nothing, and the next one can', async () => {
      const f = fakeIO([new Error('offline'), null, '', BUILD_B]);
      const s = createUpdateSentinel(buildFingerprint(BUILD_A), f.io);
      const a = await s.check(), b = await s.check(), c = await s.check(), d = await s.check();
      return ok('sequence', !a && !b && !c && d, `${a} ${b} ${c} ${d}`);
    }),
    test('check(): concurrent calls share one fetch', async () => {
      const f = fakeIO([BUILD_A]);
      const s = createUpdateSentinel(buildFingerprint(BUILD_A), f.io);
      await Promise.all([s.check(), s.check(), s.check()]);
      return eq('one fetch', f.fetches(), 1);
    }),

    test('start(): polls on the interval, and stops once a build shows up', async () => {
      const f = fakeIO([BUILD_A, BUILD_A, BUILD_B]);
      const s = createUpdateSentinel(buildFingerprint(BUILD_A), f.io, 60_000);
      s.start();
      const armed = f.pending.size;
      await f.fire(); await f.fire();
      const quiet = !s.available() && f.pending.size === 1;
      await f.fire();
      return ok('poll', armed === 1 && quiet && s.available() && f.pending.size === 0 && f.fetches() === 3,
        `armed=${armed} quiet=${quiet} available=${s.available()} pending=${f.pending.size} fetches=${f.fetches()}`);
    }),
    test('start(): a dev page (empty baseline) never polls, and check() is a no-op', async () => {
      const f = fakeIO([BUILD_B]);
      const s = createUpdateSentinel(buildFingerprint(DEV), f.io);
      s.start();
      const got = await s.check();
      return ok('no poll', f.pending.size === 0 && !got && f.fetches() === 0, `pending=${f.pending.size} fetches=${f.fetches()}`);
    }),
    test('stop(): leaves no timer behind; start() again re-arms once', () => {
      const f = fakeIO([BUILD_A]);
      const s = createUpdateSentinel(buildFingerprint(BUILD_A), f.io);
      s.start(); s.start();
      const once = f.pending.size;
      s.stop();
      const none = f.pending.size;
      s.start();
      return ok('timers', once === 1 && none === 0 && f.pending.size === 1, `${once} ${none} ${f.pending.size}`);
    }),

    test('mark(): the dev signal lights once, with the file, and cancels the poll', () => {
      const f = fakeIO([BUILD_A]);
      const s = createUpdateSentinel(buildFingerprint(BUILD_A), f.io);
      const reasons: string[] = [];
      s.onChange((r) => reasons.push(r));
      s.start();
      s.mark('src/ui/hud/mast.ts');
      s.mark('src/ui/main.ts');
      return ok('once', reasons.join() === 'src/ui/hud/mast.ts' && s.reason() === 'src/ui/hud/mast.ts' && f.pending.size === 0,
        `reasons=${reasons.join()} pending=${f.pending.size}`);
    }),
  ],
};

export default mod;
