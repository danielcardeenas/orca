/**
 * The microphone's samples, made into the file whisper.cpp reads.
 *
 * A browser hands over audio as 32-bit floats at whatever rate the device
 * runs — 44.1 or 48 kHz. whisper.cpp wants 16 kHz, mono, 16-bit PCM in a
 * WAV. Both halves of that are arithmetic, so they live here without a
 * browser and are tested without one: `hud/voice.ts` captures, this
 * converts, and the hub gets a file it can hand to the binary as it is.
 *
 * No ffmpeg anywhere, in the browser or on the hub.
 */

/** What whisper.cpp expects. */
export const WHISPER_RATE = 16_000;

/** Every recorded chunk, in one array. */
export function concat(chunks: readonly Float32Array[]): Float32Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * Linear resampling. Speech at 16 kHz is what the model was trained on;
 * a better filter would not change what it hears, and this is one pass
 * over the samples with no dependency.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || !input.length) return input;
  const ratio = from / to;
  const n = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const k = Math.min(j + 1, input.length - 1);
    const t = pos - j;
    out[i] = input[j]! * (1 - t) + input[k]! * t;
  }
  return out;
}

/** 16-bit PCM mono WAV. The header is the classic 44 bytes. */
export function wavEncode(samples: Float32Array, rate: number): ArrayBuffer {
  const data = samples.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); v.setUint32(4, 36 + data, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, 'data'); v.setUint32(40, data, true);
  for (let i = 0, at = 44; i < samples.length; i++, at += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Seconds of audio in a set of chunks at a rate. */
export function seconds(chunks: readonly Float32Array[], rate: number): number {
  let n = 0;
  for (const c of chunks) n += c.length;
  return n / rate;
}
