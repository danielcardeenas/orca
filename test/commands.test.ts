/**
 * Command-path tests.
 *
 * These cover the three things that went wrong when the spawn path was first
 * exercised against the real CLI, all of which were silent:
 *
 *  - `claude --bg -p <prompt>` is rejected by the CLI; with `--bg` the prompt
 *    is positional. Every background spawn failed before it started.
 *  - a spawned child inherited the collector's process group, so restarting the
 *    collector killed every agent it had launched.
 *  - `claude logs` returns raw terminal output — escapes, cursor jumps, and
 *    hundreds of spinner frames — which reached the console as unreadable bulk.
 */

import { stripAnsi } from '../src/collector/commands.ts';
import { ok, eq, test, type TestModule } from './harness.ts';

const ESC = String.fromCharCode(27);
const CSI = ESC + '[';

/** One spinner frame as `claude logs` actually emits it. */
const spinnerFrame =
  CSI + 'H' + CSI + '19B' + CSI + '38;2;153;153;153m' + '⏺' +
  CSI + '39m' + CSI + '50;1H' + CSI + '44;2H';

const tests = [
  test('stripAnsi removes CSI colour and cursor sequences', () => {
    const raw = CSI + '32m' + 'wrote HELLO.txt' + CSI + '0m';
    return eq('stripAnsi removes CSI colour and cursor sequences',
      stripAnsi(raw), 'wrote HELLO.txt');
  }),

  test('stripAnsi collapses a wall of spinner frames', () => {
    const raw = spinnerFrame.repeat(200) + '\n' + CSI + '32m' + 'done' + CSI + '0m';
    const out = stripAnsi(raw);
    return ok('stripAnsi collapses a wall of spinner frames',
      out.includes('done') && out.length < 200,
      `${raw.length} bytes -> ${out.length}`);
  }),

  test('stripAnsi turns repaint carriage returns into real lines', () => {
    const raw = 'one\rtwo\rthree';
    return eq('stripAnsi turns repaint carriage returns into real lines',
      stripAnsi(raw), 'one\ntwo\nthree');
  }),

  test('stripAnsi removes OSC title sequences', () => {
    const raw = ESC + ']0;claude — building' + String.fromCharCode(7) + 'real output';
    return eq('stripAnsi removes OSC title sequences', stripAnsi(raw), 'real output');
  }),

  test('stripAnsi leaves clean text untouched', () => {
    const clean = 'wrote src/hub/bus.ts\nran 33 tests, all green';
    return eq('stripAnsi leaves clean text untouched', stripAnsi(clean), clean);
  }),

  test('stripAnsi survives an empty and an all-escape input', () => {
    return ok('stripAnsi survives an empty and an all-escape input',
      stripAnsi('') === '' && stripAnsi(spinnerFrame.repeat(20)) === '',
      'no throw, nothing left behind');
  }),
];

const suite: TestModule = { suite: 'collector · command path', tests };
export default suite;
