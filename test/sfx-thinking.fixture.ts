/**
 * The SOUND window on its own: a real `mountSound()` over an empty world and
 * `mountSfx` in a bare `.win__body`. No hub, no collector, no websocket, no
 * session — the CAPCOM thinking level is a knob on `sound.ts`'s state, and
 * that state needs nothing but localStorage to exist.
 */
import { store } from '../src/ui/store.ts';
import { emptyWorld } from '../src/shared/types.ts';
import { mountSound } from '../src/ui/hud/sound.ts';
import { mountSfx } from '../src/ui/windows/kinds/sfx.ts';
import type { WinCtx } from '../src/ui/windows/wm.ts';
import type { Console } from '../src/ui/console.ts';

store.replaceWorld(emptyWorld());

export const notes: string[] = [];
const c = { note: (t: string) => notes.push(t) } as unknown as Console;

/** The singleton `getSound()` hands out; the window takes it from there. */
export const sound = mountSound();

const main = document.querySelector<HTMLElement>('main')!;
export const mounted = mountSfx({
  body: main, win: { id: 'sfx-fixture', el: main }, setTitle() {}, setCallsign() {}, setState() {}, close() {},
} as unknown as WinCtx, c);
