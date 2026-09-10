/**
 * ui/audio.ts — the microphone's floats into whisper's WAV, in arithmetic.
 *
 * A header field off by two bytes is a file the binary rejects with a line
 * nobody reads; a resampler that drops the last sample or overshoots the
 * range clips the end of every sentence. Those are the cases.
 */

import { WHISPER_RATE, concat, resample, seconds, wavEncode } from '../src/ui/audio.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const mod: TestModule = {
  suite: 'audio',
  tests: [
    test('concat: chunks in order, none lost', () => {
      const out = concat([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])]);
      return eq('concat', [...out], [1, 2, 3]);
    }),
    test('resample: 48 kHz to 16 kHz keeps a third of the samples and the shape of the signal', () => {
      const from = 48_000;
      const input = new Float32Array(from).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / from));
      const out = resample(input, from, WHISPER_RATE);
      // The same tone, sampled a third as often: peaks stay peaks.
      let maxErr = 0;
      for (let i = 0; i < out.length; i++) maxErr = Math.max(maxErr, Math.abs(out[i]! - Math.sin((2 * Math.PI * 440 * i) / WHISPER_RATE)));
      const same = resample(input, from, from) === input;
      return ok('resample', out.length === WHISPER_RATE && maxErr < 0.02 && same, `n=${out.length} err=${maxErr.toFixed(4)}`);
    }),
    test('resample: an empty input stays empty; one sample stays one', () => {
      return eq('edges', [resample(new Float32Array(0), 48_000, 16_000).length, resample(new Float32Array([0.5]), 48_000, 16_000).length], [0, 1]);
    }),
    test('wavEncode: the classic 44-byte header, little-endian, sizes that add up', () => {
      const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
      const buf = wavEncode(samples, WHISPER_RATE);
      const v = new DataView(buf);
      const tag = (at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
      const pcm = Array.from({ length: samples.length }, (_, i) => v.getInt16(44 + i * 2, true));
      return ok('wav',
        buf.byteLength === 44 + samples.length * 2
        && tag(0) === 'RIFF' && tag(8) === 'WAVE' && tag(12) === 'fmt ' && tag(36) === 'data'
        && v.getUint32(4, true) === 36 + samples.length * 2
        && v.getUint16(20, true) === 1 && v.getUint16(22, true) === 1
        && v.getUint32(24, true) === WHISPER_RATE && v.getUint32(28, true) === WHISPER_RATE * 2
        && v.getUint16(32, true) === 2 && v.getUint16(34, true) === 16
        && v.getUint32(40, true) === samples.length * 2
        // 0, half, minus half, full scale both ways, and clipping past it.
        && pcm[0] === 0 && pcm[1] === 16383 && pcm[2] === -16384 && pcm[3] === 32767 && pcm[4] === -32768 && pcm[5] === 32767 && pcm[6] === -32768,
        JSON.stringify({ len: buf.byteLength, pcm }));
    }),
    test('seconds: length over rate', () => {
      return eq('seconds', seconds([new Float32Array(8_000), new Float32Array(8_000)], WHISPER_RATE), 1);
    }),
  ],
};

export default mod;
