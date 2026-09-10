import { ThinkingSoundGate } from '../src/ui/hud/capcom-thinking-sound.ts';
import { eq, type TestModule } from './harness.ts';

export default {
  suite: 'CAPCOM thinking sound policy',
  tests: [
    () => {
      const g = new ThinkingSoundGate();
      const request = { id: 'one', at: 100 };
      const observe = (processing: boolean, now = 100) => g.observe({ request, processing, now, baseline: false });
      return eq('one cue per request across tools, idle and error recovery',
        [observe(false), observe(true), observe(true), observe(false), observe(true, 12000)], [false, true, false, false, false]);
    },
    () => {
      const g = new ThinkingSoundGate();
      const request = { id: 'old', at: 0 };
      return eq('snapshot/reconnect consumes pending work without replay', [
        g.observe({ request, processing: false, baseline: true, now: 1 }),
        g.observe({ request, processing: true, baseline: false, now: 2 }),
      ], [false, false]);
    },
    () => eq('no message, expired message and future timestamps stay silent',
      [null, { id: 'old', at: 0 }, { id: 'future', at: 40000 }].map(request =>
        new ThinkingSoundGate().observe({ request, processing: true, baseline: false, now: 30001 })), [false, false, false]),
    () => {
      const g = new ThinkingSoundGate();
      const results: boolean[] = [];
      for (const now of [0, 5000, 10000]) {
        const request = { id: String(now), at: now };
        g.observe({ request, processing: false, baseline: false, now });
        results.push(g.observe({ request, processing: true, baseline: false, now }));
      }
      return eq('rapid requests have a ten-second ceiling, with no delayed queue', results, [true, false, true]);
    },
    () => {
      const g = new ThinkingSoundGate();
      g.observe({ request: null, processing: true, baseline: false, now: 0 });
      return eq('delivery changes during existing work cannot start a cue',
        g.observe({ request: { id: 'new', at: 1 }, processing: true, baseline: false, now: 1 }), false);
    },
  ],
} satisfies TestModule;
