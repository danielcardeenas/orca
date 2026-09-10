/**
 * Transcription on the hub's own machine: whisper.cpp, with the fleet's
 * names in its ear.
 *
 * The browser's recogniser hears Spanish with English in it — «para a K9 y
 * haz commit en el worktree» — and writes what it can. It takes no hints.
 * Whisper does: an initial prompt biases it towards the words in it, and the
 * hub knows exactly which words those are at this moment — every callsign,
 * every squad, every project on the field. So the console records what the
 * operator said, sends the audio here, and gets back a line that says K9
 * because it was told K9 exists.
 *
 * Nothing leaves the machine: `whisper-cli` (Homebrew's `whisper-cpp`) runs
 * on the hub, on Metal, and a sentence takes about a second on Apple
 * silicon with the large-v3-turbo model. The audio is a temp file for the
 * length of that second.
 *
 * ── Where the pieces come from ─────────────────────────────────────
 *
 *   binary   ORCA_WHISPER_BIN, else `whisper-cli` in the usual Homebrew and
 *            /usr/local places
 *   model    ORCA_WHISPER_MODEL, else the best `ggml-*.bin` in
 *            ORCA_HOME/models (large-v3-turbo over large over medium …)
 *
 * With either missing the endpoint answers 503 with which one, and the
 * console's VOICE settings show the same words. Nothing is downloaded by
 * the hub on its own: a model is a gigabyte, and that is the operator's
 * decision (docs/VOICE.md says which file and where).
 *
 * The audio the console sends is 16 kHz mono 16-bit WAV, encoded in the
 * browser (`ui/audio.ts`), which is what whisper.cpp reads natively; no
 * ffmpeg on this side.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorldState } from '../shared/types.ts';
import { squadsOf } from '../shared/squads.ts';
import { readBounded } from './uploads.ts';

/** A minute of speech at 16 kHz 16-bit is under two megabytes; this is a lot of minutes. */
export const AUDIO_LIMIT = 16 * 1024 * 1024;
/** whisper.cpp keeps half its text context for the prompt: ~220 tokens. Names are short. */
export const VOCAB_MAX = 60;
/** A stuck binary must not hold the request forever. */
const RUN_TIMEOUT_MS = 90_000;

const BIN_CANDIDATES = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', '/opt/homebrew/bin/whisper-cpp', '/usr/local/bin/whisper-cpp'];
/** Bigger and newer first. `turbo` is large-v3 pruned for speed, and the right default. */
const MODEL_RANK = ['large-v3-turbo', 'large-v3', 'large', 'medium', 'small', 'base', 'tiny'];

export interface WhisperConfig {
  bin: string | null;
  model: string | null;
  ready: boolean;
  /** Why not, in the operator's terms. Empty when ready. */
  reason: string;
}

/** The best model file in a directory, by name; null with none. */
export function pickModel(dir: string): string | null {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => /^ggml-.*\.bin$/.test(f)); } catch { return null; }
  const rank = (f: string) => { const i = MODEL_RANK.findIndex((k) => f.includes(k)); return i < 0 ? MODEL_RANK.length : i; };
  const best = files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
  return best ? join(dir, best) : null;
}

export function whisperConfig(orcaDir: string, env: NodeJS.ProcessEnv = process.env): WhisperConfig {
  const bin = env['ORCA_WHISPER_BIN'] ?? BIN_CANDIDATES.find((p) => existsSync(p)) ?? null;
  const model = env['ORCA_WHISPER_MODEL'] ?? pickModel(join(orcaDir, 'models'));
  const reason = !bin ? 'whisper-cli not found · brew install whisper-cpp, or set ORCA_WHISPER_BIN'
    : !model ? `no model · put a ggml-*.bin in ${join(orcaDir, 'models')}, or set ORCA_WHISPER_MODEL`
    : !existsSync(model) ? `model not found · ${model}`
    : !existsSync(bin) ? `whisper-cli not found · ${bin}` : '';
  return { bin, model, ready: !reason, reason };
}

/**
 * The words the fleet is made of right now, for whisper's initial prompt:
 * ORCA's own, every live callsign, every squad, every project. Deduplicated,
 * capped, and shaped as a sentence, because whisper reads the prompt as
 * preceding speech and a list of names reads like a roll call — which is
 * exactly what it is.
 */
export function vocabulary(world: Pick<WorldState, 'agents' | 'projects'>): string {
  const words = new Set<string>(['ORCA', 'CAPCOM']);
  for (const a of Object.values(world.agents)) if (a.state !== 'done' && a.state !== 'dead' && a.callsign) words.add(a.callsign);
  for (const s of squadsOf(world.agents)) if (s.name) words.add(s.name);
  for (const p of Object.values(world.projects)) if (p.name) words.add(p.name);
  return [...words].slice(0, VOCAB_MAX).join(', ') + '.';
}

export interface TranscribeOpts {
  bin: string;
  model: string;
  /** ISO 639-1, `es`. `auto` lets whisper decide. */
  lang: string;
  prompt: string;
  threads?: number;
  timeoutMs?: number;
}

/** Run whisper.cpp over a WAV. The text, joined into one line; empty when it heard nothing. */
export async function transcribe(wav: Buffer, opts: TranscribeOpts): Promise<{ text: string; ms: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-voice-'));
  const file = join(dir, 'in.wav');
  const t0 = Date.now();
  try {
    await writeFile(file, wav, { mode: 0o600 });
    const threads = opts.threads ?? Math.min(8, cpus().length || 4);
    const args = ['-m', opts.model, '-f', file, '-l', opts.lang, '-t', String(threads), '-nt', '-np'];
    if (opts.prompt) args.push('--prompt', opts.prompt);
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(opts.bin, args, { timeout: opts.timeoutMs ?? RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
        if (err) reject(new Error(`whisper failed: ${String(errOut || err.message).trim().split('\n').slice(-1)[0]}`));
        else resolve(String(out));
      });
    });
    const text = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
      // whisper marks silence and noise in brackets: [BLANK_AUDIO], (música).
      .filter((l) => !/^[[(].*[\])]$/.test(l))
      .join(' ').replace(/\s+/g, ' ').trim();
    return { text, ms: Date.now() - t0 };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface TranscribeDeps {
  config(): WhisperConfig;
  vocabulary(): string;
  run?: typeof transcribe;
}

/**
 * `GET`: is this hub able to transcribe, and with what. `POST audio/wav`:
 * the line. One at a time — the model is a gigabyte of memory per run and
 * two operators do not speak at once — the rest wait their turn.
 *
 * Only after the hub has authenticated the request. This does not.
 */
export function transcribeHandler(deps: TranscribeDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let queue: Promise<unknown> = Promise.resolve();
  const run = deps.run ?? transcribe;
  return async (req, res) => {
    const reply = (code: number, value: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const cfg = deps.config();
    if (req.method === 'GET') {
      reply(200, { ready: cfg.ready, reason: cfg.reason, model: cfg.model ? cfg.model.split('/').pop() : null, bin: cfg.bin });
      return;
    }
    if (req.method !== 'POST') { res.setHeader('allow', 'GET, POST'); reply(405, { error: 'Use POST.' }); return; }
    if (req.headers['sec-fetch-site'] === 'cross-site') { reply(403, { error: 'Use the ORCA console to transcribe.' }); return; }
    if (!cfg.ready || !cfg.bin || !cfg.model) { reply(503, { error: cfg.reason }); return; }
    if (!String(req.headers['content-type'] ?? '').startsWith('audio/wav')) { reply(415, { error: 'Send audio/wav: 16 kHz, mono, 16-bit.' }); return; }
    if (Number(req.headers['content-length']) > AUDIO_LIMIT) { reply(413, { error: 'Audio must be 16 MB or smaller.' }); return; }
    const url = new URL(req.url ?? '/', 'http://hub.local');
    const lang = (url.searchParams.get('lang') ?? 'auto').toLowerCase().split('-')[0]!.replace(/[^a-z]/g, '') || 'auto';
    try {
      const bytes = await readBounded(req, AUDIO_LIMIT);
      if (!bytes) { res.setHeader('connection', 'close'); reply(413, { error: 'Audio must be 16 MB or smaller.' }); return; }
      if (bytes.length < 44) { reply(400, { error: 'The audio is empty.' }); return; }
      const job = queue.then(() => run(bytes, { bin: cfg.bin!, model: cfg.model!, lang, prompt: deps.vocabulary() }));
      queue = job.catch(() => {});
      const out = await job;
      reply(200, { text: out.text, ms: out.ms, lang, model: cfg.model.split('/').pop() });
    } catch (err) {
      if (!res.headersSent) reply(500, { error: err instanceof Error ? err.message : 'Transcription failed.' });
    }
  };
}
