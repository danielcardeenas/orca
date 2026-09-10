/**
 * Push-to-talk montado solo, con motor y sintetizador de mentira, para
 * test/voice-dom.test.ts. El reconocedor falso apunta lo que le piden y deja
 * que la prueba le dicte los resultados; el sintetizador falso apunta lo que
 * le mandan leer. Lo que se comprueba es el cableado real de `hud/voice.ts`:
 * la tira, las clases del body, qué sale por `send` y qué se lee.
 */
import { store } from '../src/ui/store.ts';
import { mountVoice, voiceUnavailable, type VoiceHandle } from '../src/ui/hud/voice.ts';
import type { Agent, TalkItem } from '../src/shared/types.ts';

/* ── El motor de mentira, instalado antes de que `mountVoice` lo busque ── */

export class FakeRec {
  static last: FakeRec | null = null;
  lang = ''; continuous = false; interimResults = false; maxAlternatives = 1;
  onresult: ((e: { resultIndex: number; results: unknown[] }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0; stopped = 0; aborted = 0;
  constructor() { FakeRec.last = this; }
  start() { this.started++; }
  // Como el de verdad: parar o abortar acaba en `onend`, un tick después.
  stop() { this.stopped++; setTimeout(() => this.onend?.(), 0); }
  abort() { this.aborted++; setTimeout(() => this.onend?.(), 0); }
}
(window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRec;

/** Dicta resultados al motor: cada uno, su texto y si ya es definitivo. */
export function hear(parts: { t: string; final: boolean }[], from = 0) {
  const results = parts.map((p) => Object.assign([{ transcript: p.t }], { isFinal: p.final }));
  FakeRec.last!.onresult?.({ resultIndex: from, results });
}
export function fail(error: string) { FakeRec.last!.onerror?.({ error }); }

/* ── El sintetizador de mentira ───────────────────────────────────── */

export const spoken: string[] = [];
export let cancels = 0;
let utterance: SpeechSynthesisUtterance | null = null;
const synth = {
  cancel() { cancels++; },
  speak(u: SpeechSynthesisUtterance) { utterance = u; spoken.push(u.text); u.onstart?.(new Event('start') as SpeechSynthesisEvent); },
  getVoices() { return [] as SpeechSynthesisVoice[]; },
};
Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
/** La lectura terminó. */
export function endSpeech() { utterance?.onend?.(new Event('end') as SpeechSynthesisEvent); }

/* ── El montaje ───────────────────────────────────────────────────── */

export const sent: string[] = [];
export const notes: string[] = [];
export const host = document.createElement('div');
host.className = 'dock';
document.body.appendChild(host);
export const voice: VoiceHandle = mountVoice(host, { send: (t) => sent.push(t), note: (t) => notes.push(t), lang: 'es-ES' });
export const strip = host.querySelector<HTMLElement>('.voice')!;
export const why = voiceUnavailable;

/** Qué enseña la tira ahora mismo. */
export function shown() {
  return {
    hidden: strip.hidden,
    k: strip.querySelector('[data-k]')!.textContent,
    t: strip.querySelector('[data-t]')!.textContent,
    listening: strip.classList.contains('is-listening'),
    speaking: strip.classList.contains('is-speaking'),
    sentCls: strip.classList.contains('is-sent'),
    bodyListening: document.body.classList.contains('is-listening'),
    bodySpeaking: document.body.classList.contains('is-speaking'),
  };
}

/** Un montaje sin oído alguno: ni reconocedor ni micrófono. TALK no existe, y `start` dice por qué. */
export function mountBare(): VoiceHandle {
  // Chromium trae `webkitSpeechRecognition` y `mediaDevices` de serie: hay que tapar los dos.
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const keep = { std: w.SpeechRecognition, webkit: w.webkitSpeechRecognition, media: navigator.mediaDevices };
  delete w.SpeechRecognition;
  w.webkitSpeechRecognition = undefined;
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  try { return mountVoice(host, { send: (t) => sent.push(t), note: (t) => notes.push(t) }); }
  finally {
    w.SpeechRecognition = keep.std; w.webkitSpeechRecognition = keep.webkit;
    Object.defineProperty(navigator, 'mediaDevices', { value: keep.media, configurable: true });
  }
}

/** CAPCOM en un estado, con esta conversación, y el store lo cuenta. */
export function world(state: Agent['state'], items: TalkItem[]) {
  const a = { id: 'cap', machineId: 'm1', projectId: 'p1', callsign: 'CAPCOM', role: 'capcom', state, metrics: { costUSD: 0, tokensPerSec: 0 } } as unknown as Agent;
  store.world.agents = { cap: a };
  store.world.talk = { cap: items };
  (store as unknown as { emit(e: unknown): void }).emit({ k: 'talk', ids: ['cap'] });
}
export const prompt = (text: string, at: number): TalkItem => ({ id: `p${at}`, agentId: 'cap', at, kind: 'prompt', text });
export const say = (text: string, at: number): TalkItem => ({ id: `s${at}`, agentId: 'cap', at, kind: 'say', text });
export const tool = (at: number): TalkItem => ({ id: `t${at}`, agentId: 'cap', at, kind: 'tool', text: 'orca say K9', tool: 'Bash', toolUseId: `u${at}` });

export const tick = () => new Promise((r) => setTimeout(r, 10));
