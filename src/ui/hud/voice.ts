/**
 * Voice: push-to-talk into CAPCOM, and its answer read back.
 *
 * Hold ⌥V (or the mast's TALK, on a screen with no keyboard) and speak; let
 * go and the line leaves. There is no wake word and no open microphone: the
 * console listens exactly while the key is down, which is the whole of the
 * safety story for a microphone in front of an agent that acts. Esc while
 * holding throws the line away.
 *
 * What was heard goes down `say`, the same call the composer makes, so CAPCOM
 * gets a typed line and nothing else changes: the echo lands in TALK, the
 * delivery history records it, the reply arrives block by block. The way
 * back is the console's decision, not CAPCOM's: `voice.ts` picks the first
 * sentences of the conclusion of a reply to something that was *spoken*, once
 * the turn is over, and the synthesiser reads that. A typed line is never
 * answered aloud, and the whole reply is in the window, where it always was.
 *
 * ── Two ears ──────────────────────────────────────────────────────────
 *
 * Who turns the speech into text is a preference (`voiceEngine`):
 *
 *  - **whisper** — whisper.cpp on the hub (`hub/transcribe.ts`). The console
 *    records the microphone while the key is down, converts it to the WAV
 *    the binary reads (`ui/audio.ts`), and sends it up when the key comes
 *    up. The hub answers with the line, having heard it with every callsign,
 *    squad and project on the field in its prompt — which is why it writes
 *    «K9» where the browser wrote «AK9». Nothing leaves the machine. The cost
 *    is a second or two between letting go and seeing the line;
 *  - **browser** — the Web Speech API. Words as you speak, no hints, and the
 *    audio goes to Google or Apple to be understood.
 *
 * `auto` is whisper whenever the hub says it can, and the browser otherwise.
 * With whisper, the browser's recogniser still runs if there is one, only to
 * show the words as they come — and as the line of last resort if the hub
 * fails mid-sentence. What is sent is whisper's.
 *
 * Both need a **secure context**: `localhost` is one; the plain-http remote
 * address in docs/REMOTE-ACCESS.md is not, and there the browser will not
 * open a microphone at all. Firefox has no Web Speech engine; with the hub
 * transcribing it does not need one. `supported` says whether TALK is drawn.
 *
 * The strip above the command line is the only other thing: LISTENING with
 * the words as they come, TRANSCRIBING while the hub works, CAPCOM with what
 * is being read, SENT for a moment when the line leaves.
 */

import { capcomOf } from '../../shared/capcom.ts';
import { WHISPER_RATE, concat, resample, seconds, wavEncode } from '../audio.ts';
import { transcribeAudio, transcribeStatus } from '../net/client.ts';
import { getPref } from '../prefs.ts';
import { store } from '../store.ts';
import { chooseVoice, pickReply, type Dictation } from '../voice.ts';
import { foldTalk } from '../windows/talk.ts';

/* ── The browser's engine, as much of it as the console uses ─────── */

interface RecResult { readonly isFinal: boolean; readonly 0?: { readonly transcript: string } }
interface RecEvent { readonly resultIndex: number; readonly results: ArrayLike<RecResult> }
interface RecError { readonly error: string }
interface Rec {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  onresult: ((e: RecEvent) => void) | null;
  onerror: ((e: RecError) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecCtor = new () => Rec;

function recognizerCtor(): RecCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const canCapture = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/** Why TALK is not on the mast, in the operator's terms. Empty when it is. */
export function voiceUnavailable(): string {
  if (!window.isSecureContext) return 'voice needs https · localhost, or see docs/REMOTE-ACCESS.md';
  if (!recognizerCtor() && !canCapture()) return 'this browser has no microphone access';
  return '';
}

/** Spoken lines are remembered only to recognise their replies; a handful is plenty. */
const ASKED_MAX = 8;
/** How long SENT stays on the strip. */
const SENT_MS = 1400;
/** A tap on the key is not a sentence. */
const MIN_SECONDS = 0.3;

export type VoiceEngine = 'whisper' | 'browser';
export interface HubWhisper { ready: boolean; reason: string; model: string | null }

export interface VoiceHandle {
  /** The chord and the button exist only when this is true. */
  readonly supported: boolean;
  /** Start listening. False when it could not (no engine, already on). */
  start(): boolean;
  /** Stop listening and send what was heard, if anything. */
  stop(): void;
  /** Stop listening and throw the line away. */
  cancel(): void;
  /** Stop reading a reply, if one is being read. */
  hush(): void;
  listening(): boolean;
  /** The voices this browser can read with, as it names them. May be empty until `voiceschanged`. */
  voices(): { name: string; lang: string }[];
  /** Read a sample line with the voice the preferences pick now. */
  preview(): void;
  /** Which ear the next line will use, and what the hub said about its own. */
  engine(): { engine: VoiceEngine; hub: HubWhisper };
  /** Ask the hub again whether it can transcribe. */
  refresh(): Promise<HubWhisper>;
  dispose(): void;
}

export interface VoiceOpts {
  /** Where a heard line goes. The composer's `hub.say`, in practice. */
  send(text: string): void;
  note(text: string, level?: 'info' | 'warn' | 'alert'): void;
  /** BCP 47. Defaults to the browser's. */
  lang?: string;
}

/** A microphone being recorded: stop it and get the samples, at whisper's rate. */
interface Capture { stop(): Float32Array; drop(): void }

async function captureStart(): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const AC: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  const src = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is old, but it is one line, needs no worklet file, and
  // it is everywhere. The output stays silent: nothing is written to it.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  proc.onaudioprocess = (e) => { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  src.connect(proc);
  proc.connect(ctx.destination);
  const release = () => { proc.disconnect(); src.disconnect(); for (const t of stream.getTracks()) t.stop(); void ctx.close(); };
  return {
    stop() { release(); return resample(concat(chunks), ctx.sampleRate, WHISPER_RATE); },
    drop() { release(); chunks.length = 0; },
  };
}

export function mountVoice(host: HTMLElement, opts: VoiceOpts): VoiceHandle {
  const Ctor = recognizerCtor();
  const supported = window.isSecureContext && (!!Ctor || canCapture());
  // Decided once, here: the reason TALK is missing is the reason at mount.
  const unavailable = supported ? '' : voiceUnavailable();
  const lang = opts.lang ?? navigator.language ?? 'en-US';

  const strip = document.createElement('div');
  strip.className = 'voice';
  strip.hidden = true;
  strip.setAttribute('role', 'status');
  strip.setAttribute('aria-live', 'polite');
  strip.innerHTML = '<span class="voice__k px" data-k></span><span class="voice__t mono" data-t></span>';
  host.appendChild(strip);
  const kEl = strip.querySelector<HTMLElement>('[data-k]')!;
  const tEl = strip.querySelector<HTMLElement>('[data-t]')!;
  let sentTimer = 0;

  function show(state: 'listening' | 'speaking' | 'sent', k: string, t: string) {
    window.clearTimeout(sentTimer);
    strip.hidden = false;
    strip.classList.toggle('is-listening', state === 'listening');
    strip.classList.toggle('is-speaking', state === 'speaking');
    strip.classList.toggle('is-sent', state === 'sent');
    kEl.textContent = k;
    tEl.textContent = t;
  }
  function hide() {
    window.clearTimeout(sentTimer);
    strip.hidden = true;
    strip.classList.remove('is-listening', 'is-speaking', 'is-sent');
  }

  /* ── The hub's ear ─────────────────────────────────────────────── */

  let hubWhisper: HubWhisper = { ready: false, reason: 'not asked yet', model: null };
  async function refresh(): Promise<HubWhisper> {
    hubWhisper = await transcribeStatus();
    return hubWhisper;
  }
  void refresh();

  /** Which ear the next line uses. The preference, then what the hub can do. */
  function engineNow(): VoiceEngine {
    const want = getPref('voiceEngine');
    if (want === 'browser') return 'browser';
    if (want === 'whisper') return 'whisper';
    return hubWhisper.ready && canCapture() ? 'whisper' : 'browser';
  }

  /* ── Listening ─────────────────────────────────────────────────── */

  let rec: Rec | null = null;
  let finals: string[] = [];
  let interim = '';
  let cancelled = false;
  let on = false;
  /** This line's ear. */
  let engine: VoiceEngine = 'browser';
  /** With whisper: the microphone, once the browser has opened it. */
  let capture: Promise<Capture | null> | null = null;

  function heard(): string {
    return [...finals, interim].join(' ').replace(/\s+/g, ' ').trim();
  }

  function paint() {
    if (!on) return;
    show('listening', 'LISTENING', heard() || '…');
  }

  /** The line leaves: remembered, sent, shown. */
  function deliver(text: string) {
    asked.push({ text, at: Date.now() });
    if (asked.length > ASKED_MAX) asked.splice(0, asked.length - ASKED_MAX);
    opts.send(text);
    show('sent', 'SENT', text);
    sentTimer = window.setTimeout(hide, SENT_MS);
  }

  /** The browser's engine stopped, by us or on its own: the line leaves, or not. */
  function finish() {
    if (!on || engine !== 'browser') return;
    on = false;
    rec = null;
    document.body.classList.remove('is-listening');
    const text = cancelled ? '' : heard();
    if (!text) { hide(); return; }
    deliver(text);
  }

  /** The browser's recogniser. Under whisper it only paints, and never sends. */
  function listen(shadow: boolean): Rec | null {
    if (!Ctor) return null;
    const r = new Ctor();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      // Results only ever grow: what is final stays, what is not is replaced.
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res?.[0]?.transcript?.trim() ?? '';
        if (!t) continue;
        if (res!.isFinal) finals.push(t); else live = live ? `${live} ${t}` : t;
      }
      interim = live;
      paint();
    };
    r.onerror = (e) => {
      // Silence and our own abort are not errors the operator needs to read.
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (shadow) return;                       // the hub is the ear; this one was only painting
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        opts.note('microphone blocked · allow it for this site in the browser', 'warn');
      } else {
        opts.note(`voice · ${e.error}`, 'warn');
      }
      cancelled = true;
    };
    r.onend = () => { if (!shadow) finish(); };
    try { r.start(); } catch { return null; }
    return r;
  }

  function start(): boolean {
    if (on) return false;
    if (!supported) { opts.note(unavailable, 'warn'); return false; }
    hush();
    finals = []; interim = ''; cancelled = false;
    engine = engineNow();
    if (engine === 'whisper' && !canCapture()) { opts.note('this browser cannot record · choose BROWSER under VOICE', 'warn'); return false; }
    if (engine === 'browser' && !Ctor) { opts.note(hubWhisper.reason ? `hub cannot transcribe · ${hubWhisper.reason}` : 'this browser has no speech engine', 'warn'); return false; }
    on = true;
    if (engine === 'whisper') {
      capture = captureStart().catch((err: unknown) => {
        const name = err instanceof Error ? err.name : '';
        opts.note(name === 'NotAllowedError' ? 'microphone blocked · allow it for this site in the browser' : 'voice · could not open the microphone', 'warn');
        cancelled = true;
        return null;
      });
      rec = listen(true);
    } else {
      rec = listen(false);
      if (!rec) { on = false; opts.note('voice · could not start listening', 'warn'); return false; }
    }
    document.body.classList.add('is-listening');
    paint();
    return true;
  }

  /** Whisper: the key came up. The samples go up; the line comes back. */
  async function transcribe() {
    const cap = await capture;
    capture = null;
    const fallback = heard();
    try { rec?.abort(); } catch { /* it was never the ear */ }
    rec = null;
    on = false;
    document.body.classList.remove('is-listening');
    if (!cap || cancelled) { cap?.drop(); hide(); return; }
    const pcm = cap.stop();
    if (seconds([pcm], WHISPER_RATE) < MIN_SECONDS) { hide(); return; }
    show('listening', 'TRANSCRIBING', fallback || '…');
    try {
      const out = await transcribeAudio(wavEncode(pcm, WHISPER_RATE), lang);
      if (!out.text) { hide(); return; }
      deliver(out.text);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (fallback) { opts.note(`hub could not transcribe · sent what the browser heard · ${why}`, 'warn'); deliver(fallback); }
      else { opts.note(`hub could not transcribe · ${why}`, 'warn'); hide(); }
    }
  }

  function stop() {
    if (!on) return;
    if (engine === 'whisper') { void transcribe(); return; }
    // `stop` lets the browser's engine finish the last words; `onend` sends them.
    try { rec?.stop(); } catch { finish(); }
  }

  function cancel() {
    if (!on) return;
    cancelled = true;
    if (engine === 'whisper') { void transcribe(); return; }
    try { rec?.abort(); } catch { finish(); }
  }

  /* ── Speaking ──────────────────────────────────────────────────── */

  const asked: Dictation[] = [];
  const said = new Set<string>();
  const synth: SpeechSynthesis | null = 'speechSynthesis' in window ? window.speechSynthesis : null;

  /**
   * The voice `say` would use, unless the operator named one in SETTINGS. A
   * browser lists Apple's novelty voices first — Eddy, Flo, Grandma — and the
   * first match for `es-MX` is Eddy; `voice.ts` skips them for Paulina.
   */
  function voiceFor(tag: string): SpeechSynthesisVoice | null {
    if (!synth) return null;
    return chooseVoice(synth.getVoices(), tag, getPref('voiceName'));
  }

  /**
   * The system voice, in the browser. The neural models were tried here on
   * 2026-09-09 (Chatterbox, Fish S2 Pro) and taken out the same day: seconds
   * to minutes per line on a laptop, for two sentences. docs/VOICE.md.
   */
  function speak(text: string) {
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const v = voiceFor(lang);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.onstart = () => { document.body.classList.add('is-speaking'); show('speaking', 'CAPCOM', text); };
    const done = () => { document.body.classList.remove('is-speaking'); if (strip.classList.contains('is-speaking')) hide(); };
    u.onend = done;
    u.onerror = done;
    synth.cancel();
    synth.speak(u);
  }

  function hush() {
    if (!synth) return;
    synth.cancel();
    document.body.classList.remove('is-speaking');
    if (strip.classList.contains('is-speaking')) hide();
  }

  /** A reply to a spoken line finished: read its conclusion, once. */
  function check() {
    if (!asked.length || !getPref('voiceReply') || on) return;
    const a = capcomOf(store.world.agents);
    if (!a) return;
    const groups = foldTalk(store.world.talk?.[a.id] ?? []);
    const pick = pickReply(groups, a.state, asked, said);
    if (!pick) return;
    said.add(pick.groupId);
    speak(pick.text);
  }
  const off = store.on((e) => {
    if (e.k === 'talk' || e.k === 'agents' || e.k === 'world') check();
    // The hub came back: it may have grown a model since.
    if (e.k === 'link' && e.up) void refresh();
  });

  return {
    supported,
    start, stop, cancel, hush,
    listening: () => on,
    voices: () => (synth ? synth.getVoices().map((v) => ({ name: v.name, lang: v.lang })) : []),
    preview() {
      // The same two sentences for every voice, so the comparison is fair;
      // in the voice's own language, or an accent is all one hears.
      const es = (voiceFor(lang)?.lang ?? lang).toLowerCase().startsWith('es');
      speak(es
        ? 'CAPCOM en línea. Cuatro trabajando, uno esperándote. K9 terminó los tests y LZ pide revisión del worktree.'
        : 'CAPCOM online. Four working, one waiting on you. K9 finished the tests and LZ asks for a review of the worktree.');
    },
    engine: () => ({ engine: engineNow(), hub: hubWhisper }),
    refresh,
    dispose() { off(); cancel(); hush(); strip.remove(); },
  };
}
