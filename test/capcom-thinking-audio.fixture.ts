import { mountSound } from '../src/ui/hud/sound.ts';
import { store } from '../src/ui/store.ts';
import type { Agent } from '../src/shared/types.ts';

export const starts: number[][] = [];
export let stops = 0;
export let release: (() => void) | null = null;
export let delay = false;
class FakeAudio {
  state = 'running'; currentTime = 0; destination = {};
  resume() { return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  createBufferSource() { return { buffer: null, connect(g: unknown) { return g; }, disconnect() {},
    start(...args: number[]) { starts.push(args); }, stop() { stops++; }, onended: null }; }
  async decodeAudioData() { if (delay) await new Promise<void>(r => { release = r; }); return { duration: 2 }; }
}
Object.defineProperty(window, 'AudioContext', { value: FakeAudio, configurable: true });
window.fetch = (async (input: RequestInfo | URL) => String(input).endsWith('manifest.json')
  ? new Response(JSON.stringify({ clips: [{ id: 'tick', file: 'fake.mp3' }] }))
  : new Response(new ArrayBuffer(8))) as typeof fetch;
const a = { id: 'cap', role: 'capcom', machineId: 'isolated-unit', state: 'idle',
  startedAt: 1, updatedAt: 1, metrics: {}, block: null } as Agent;
store.world.agents = { cap: a };
store.booting = false;
store.setLink(true);
export let sound = mountSound();
export function request(id: string) { store.recordOutgoing({ id, at: Date.now(), agentId: null, status: 'sending', text: 'fixture' }); }
export function state(value: Agent['state']) {
  a.state = value;
  // Exercise the real subscription without any websocket or collector.
  (store as unknown as { emit(e: { k: 'agents'; ids: string[] }): void }).emit({ k: 'agents', ids: ['cap'] });
}
export function reset(slow = false, gesture = true) {
  sound.dispose(); starts.length = 0; stops = 0; delay = slow; release = null;
  store.outgoing = []; a.state = 'idle'; store.setLink(true); store.setAuth(true);
  sound = mountSound();
  if (gesture) window.dispatchEvent(new Event('pointerdown'));
}
export function link(up: boolean) { store.setLink(up); }
export function auth(ok: boolean) { store.setAuth(ok); }
export function delivery() { store.recordOutgoing({ ...store.outgoing.at(-1)!, status: 'accepted' }); }

export function snapshot() { store.replaceWorld(store.world); }
export function booting(value: boolean) { store.booting = value; }
