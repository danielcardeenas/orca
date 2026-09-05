/**
 * motion.ts — the one place the console's timing lives.
 */

import { applyToRoot, beats, dur, EASE, EASE_CSS, REDUCE, shaderMotion, T } from '../src/ui/motion.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const monotone = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]!);

export default {
  suite: 'motion',
  tests: [
    test('beats(n) returns n non-decreasing offsets, for bursts and strikes', () => {
      for (const n of [0, 1, 4, 7, 10, 11, 23, 60]) {
        const b = beats(n);
        if (b.length !== n) return eq('length', b.length, n, `n=${n}`);
        if (!monotone(b)) return ok('monotone', false, `n=${n}: ${b.join(',')}`);
      }
      return ok('beats(n) returns n non-decreasing offsets, for bursts and strikes', true, '0..60');
    }),

    test('small counts are two bursts with a pause between them', () => {
      const b = beats(8);
      const gap = b[4]! - b[3]!;
      const step = b[1]! - b[0]!;
      return ok('small counts are two bursts with a pause between them',
        gap > 0.45 && step < 0.15 && b[7]! - b[6]! < 0.15,
        `step ${step.toFixed(2)}s, pause ${gap.toFixed(2)}s`);
    }),

    test('large counts strike in groups, several tiles sharing one offset', () => {
      const b = beats(22);
      const distinct = new Set(b.map((x) => x.toFixed(3))).size;
      // 4+2+3+5+2+6 = 22 → exactly six strikes, never one per tile.
      return eq('large counts strike in groups, several tiles sharing one offset', distinct, 6, 'six strikes for 22 tiles');
    }),

    test('dur(x) collapses to zero under reduced motion and lands otherwise', () => {
      const was = REDUCE.value;
      try {
        REDUCE.value = false;
        const full = dur(T.wipe);
        REDUCE.value = true;
        const none = dur(T.wipe);
        return ok('dur(x) collapses to zero under reduced motion and lands otherwise', full === T.wipe && none === 0, `${full} → ${none}`);
      } finally {
        REDUCE.value = was;
      }
    }),

    test('applyToRoot writes every token CSS reads, with the names tokens.css uses', () => {
      const set = new Map<string, string>();
      applyToRoot({ style: { setProperty: (k, v) => set.set(k, v) } });
      const want = ['--t-snap', '--t-quick', '--t-move', '--t-wipe', '--t-check', '--t-flash', '--ease-out', '--ease-inout', '--ease-arrive'];
      const missing = want.filter((k) => !set.has(k));
      const snap = set.get('--t-snap');
      return ok('applyToRoot writes every token CSS reads, with the names tokens.css uses',
        missing.length === 0 && snap === `${T.snap}s` && set.get('--ease-out') === EASE_CSS.out,
        missing.length ? `missing ${missing.join(', ')}` : `${set.size} properties`);
    }),

    test('the GSAP and CSS easings name the same four curves', () => {
      const a = Object.keys(EASE).sort(), b = Object.keys(EASE_CSS).sort();
      return eq('the GSAP and CSS easings name the same four curves', a, b);
    }),

    test('shaderMotion derives its rates from T', () => {
      const s = shaderMotion();
      return ok('shaderMotion derives its rates from T', Math.abs(Math.exp(-s.flash * T.flash) - Math.exp(-4)) < 1e-9 && s.breathe > 2.8 && s.breathe < 2.9, `flash k=${s.flash.toFixed(2)}, breathe ${s.breathe.toFixed(3)} rad/s`);
    }),
  ],
} satisfies TestModule;
