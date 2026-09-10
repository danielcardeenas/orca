/**
 * keys.ts — who owns a key while the operator is typing.
 *
 * The bug this guards against: space bar is FOCUS on the field, and its
 * `keyup` half used to sound on every space typed into a CAPCOM message. The
 * hold must refuse to engage inside an editable target, and must never
 * release — or sound — what it never engaged.
 */

import { editable, keyHold, typing } from '../src/ui/keys.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const input = { tagName: 'INPUT' } as unknown as EventTarget;
const textarea = { tagName: 'textarea' } as unknown as EventTarget;
const select = { tagName: 'SELECT' } as unknown as EventTarget;
const rich = { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget;
const canvas = { tagName: 'CANVAS', isContentEditable: false } as unknown as EventTarget;

const down = (target: EventTarget | null, repeat = false) => ({ key: ' ', repeat, target });

const mod: TestModule = {
  suite: 'keys',
  tests: [
    test('editable: inputs, textareas, selects and contentEditable', () => {
      const yes = [input, textarea, select, rich].every(editable);
      const no = !editable(canvas) && !editable(null) && !editable(undefined) && !editable({} as EventTarget);
      return ok('editable', yes && no, `yes=${yes} no=${no}`);
    }),
    test('typing: reads the event target', () => {
      return ok('typing', typing({ target: input }) && !typing({ target: canvas }) && !typing({ target: null }));
    }),
    test('hold: engages on the field and releases once', () => {
      const h = keyHold(' ');
      const engaged = h.down(down(canvas), () => true);
      const held = h.held();
      const released = h.up({ key: ' ' });
      const again = h.up({ key: ' ' });
      return ok('engage → release → nothing', engaged && held && released && !again && !h.held());
    }),
    test('hold: never engages while typing, so keyup is silent', () => {
      const h = keyHold(' ');
      let engages = 0;
      const results = [input, textarea, select, rich].map((t) => h.down(down(t), () => { engages++; return true; }));
      const released = h.up({ key: ' ' });
      return ok('silent in a field', results.every((r) => !r) && engages === 0 && !released, `engages=${engages} released=${released}`);
    }),
    test('hold: does not release what refused to engage', () => {
      const h = keyHold(' ');
      const engaged = h.down(down(canvas), () => false); // nothing selected: the field says no
      const released = h.up({ key: ' ' });
      return ok('no focus → no focus.off', !engaged && !released);
    }),
    test('hold: ignores repeats and other keys', () => {
      const h = keyHold(' ');
      let engages = 0;
      const engage = () => { engages++; return true; };
      const rep = h.down(down(canvas, true), engage);
      const other = h.down({ key: 'f', target: canvas }, engage);
      const first = h.down(down(canvas), engage);
      const second = h.down(down(canvas), engage); // already held
      const otherUp = h.up({ key: 'f' });
      return eq('one engage', [rep, other, first, second, otherUp, engages, h.held()], [false, false, true, false, false, 1, true]);
    }),
    test('hold: whileTyping lets a chord engage inside a field', () => {
      const h = keyHold('KeyV', { whileTyping: true });
      const inField = h.down({ key: 'KeyV', target: textarea }, () => true);
      const released = h.up({ key: 'KeyV' });
      const strict = keyHold('KeyV').down({ key: 'KeyV', target: textarea }, () => true);
      return ok('chord in a field', inField && released && !strict, `inField=${inField} released=${released} strict=${strict}`);
    }),
    test('hold: cancel drops a held mode silently', () => {
      const h = keyHold(' ');
      h.down(down(canvas), () => true);
      const dropped = h.cancel();
      const released = h.up({ key: ' ' });
      const idle = h.cancel();
      return ok('cancel', dropped && !released && !idle && !h.held());
    }),
  ],
};

export default mod;
