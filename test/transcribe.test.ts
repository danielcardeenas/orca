/**
 * hub/transcribe.ts — whisper.cpp behind the hub, without whisper.cpp.
 *
 * The binary is a shell script that records what it was asked and answers
 * with a line, so what is tested is everything around it: which model is
 * picked, what the fleet's vocabulary looks like, which flags reach the
 * binary, how its output is cleaned, and what the endpoint does with a
 * missing binary, the wrong content type, too many bytes, and two requests
 * at once. Nothing here loads a model.
 */

import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AUDIO_LIMIT, VOCAB_MAX, pickModel, transcribe, transcribeHandler, vocabulary, whisperConfig } from '../src/hub/transcribe.ts';
import type { Agent, Project } from '../src/shared/types.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

function agent(callsign: string, extra: Partial<Agent> = {}): Agent {
  return { id: callsign.toLowerCase(), machineId: 'm1', projectId: 'p1', callsign, role: 'worker', state: 'working', squad: null, ...extra } as unknown as Agent;
}
const project = (name: string): Project => ({ id: name, machineId: 'm1', slug: name, name, path: `/x/${name}` } as unknown as Project);

/** A whisper-cli of our own: logs its argv, answers with the file's wish. */
async function fakeWhisper(dir: string, answer: string): Promise<{ bin: string; argv: string }> {
  const bin = join(dir, 'whisper-cli');
  const argv = join(dir, 'argv.txt');
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argv}"\nprintf '${answer}'\n`);
  await chmod(bin, 0o755);
  return { bin, argv };
}

/** Forty-four bytes of header and a little silence: enough to be a WAV. */
const wav = Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(28), Buffer.from('data'), Buffer.alloc(200)]);

export default {
  suite: 'transcribe',
  tests: [
    test('pickModel: the best ggml file by name, none without one', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-models-'));
      try {
        const none = pickModel(dir);
        for (const f of ['ggml-base.bin', 'ggml-large-v3-turbo.bin', 'ggml-small.bin', 'notes.txt', 'ggml-medium.bin.part']) await writeFile(join(dir, f), 'x');
        const best = pickModel(dir);
        return eq('pick', [none, best?.split('/').pop(), pickModel('/nope/nowhere')], [null, 'ggml-large-v3-turbo.bin', null]);
      } finally { await rm(dir, { recursive: true, force: true }); }
    }),
    test('whisperConfig: env wins, then the usual places; the reason names what is missing', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-cfg-'));
      try {
        const { bin } = await fakeWhisper(dir, 'x');
        await writeFile(join(dir, 'model.bin'), 'x');
        const full = whisperConfig(dir, { ORCA_WHISPER_BIN: bin, ORCA_WHISPER_MODEL: join(dir, 'model.bin') });
        const noModel = whisperConfig(dir, { ORCA_WHISPER_BIN: bin, PATH: '' });
        const noBin = whisperConfig(dir, { ORCA_WHISPER_BIN: join(dir, 'missing'), ORCA_WHISPER_MODEL: join(dir, 'model.bin') });
        const gone = whisperConfig(dir, { ORCA_WHISPER_BIN: bin, ORCA_WHISPER_MODEL: join(dir, 'gone.bin') });
        return ok('config',
          full.ready && full.reason === ''
          && !noModel.ready && /no model/.test(noModel.reason)
          && !noBin.ready && /whisper-cli not found/.test(noBin.reason)
          && !gone.ready && /model not found/.test(gone.reason),
          JSON.stringify([full.reason, noModel.reason, noBin.reason, gone.reason]));
      } finally { await rm(dir, { recursive: true, force: true }); }
    }),
    test('vocabulary: ORCA, CAPCOM, live callsigns, squads and projects, once each, as a roll call', () => {
      const world = {
        agents: {
          k9: agent('K9', { squad: 'audit-01' }), lz: agent('LZ', { squad: 'audit-01' }),
          dead: agent('RIP', { state: 'dead' }), done: agent('FIN', { state: 'done' }),
          cap: agent('CAPCOM', { role: 'capcom' }),
        },
        projects: { a: project('axolots'), o: project('orca') },
      };
      const v = vocabulary(world);
      return ok('vocab', v === 'ORCA, CAPCOM, K9, LZ, audit-01, axolots, orca.', v);
    }),
    test('vocabulary: capped, so the prompt fits whisper\'s half context', () => {
      const agents = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`a${i}`, agent(`A${i}`)]));
      const n = vocabulary({ agents, projects: {} }).split(', ').length;
      return eq('cap', n, VOCAB_MAX);
    }),
    test('transcribe: the flags reach the binary and its lines come back as one, brackets dropped', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-tr-'));
      try {
        const { bin, argv } = await fakeWhisper(dir, ' para a K9\\n[BLANK_AUDIO]\\n y avisa a LZ.\\n(música)\\n');
        const out = await transcribe(wav, { bin, model: '/m/ggml-x.bin', lang: 'es', prompt: 'ORCA, K9.', threads: 2 });
        const args = (await readFile(argv, 'utf8')).trim().split('\n');
        const flag = (k: string) => args[args.indexOf(k) + 1];
        return ok('run',
          out.text === 'para a K9 y avisa a LZ.'
          && flag('-m') === '/m/ggml-x.bin' && flag('-l') === 'es' && flag('-t') === '2' && flag('--prompt') === 'ORCA, K9.'
          && args.includes('-nt') && args.includes('-np') && flag('-f')!.endsWith('/in.wav'),
          `${out.text} · ${args.join(' ')}`);
      } finally { await rm(dir, { recursive: true, force: true }); }
    }),
    test('transcribe: a binary that fails is an error with its last line, and the temp file is gone', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-tr-'));
      try {
        const bin = join(dir, 'bad');
        await writeFile(bin, '#!/bin/sh\necho "error: failed to load model" >&2\nexit 3\n'); await chmod(bin, 0o755);
        let msg = '';
        try { await transcribe(wav, { bin, model: 'm', lang: 'es', prompt: '' }); } catch (e) { msg = (e as Error).message; }
        return ok('fails', /whisper failed: error: failed to load model/.test(msg), msg);
      } finally { await rm(dir, { recursive: true, force: true }); }
    }),
    test('endpoint: status, the line, and every way to be refused', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-ep-'));
      let ready = true;
      const calls: string[] = [];
      let running = 0, overlap = 0;
      const handler = transcribeHandler({
        config: () => ready ? { bin: '/b', model: '/models/ggml-large-v3-turbo.bin', ready: true, reason: '' } : { bin: null, model: null, ready: false, reason: 'whisper-cli not found · brew install whisper-cpp' },
        vocabulary: () => 'ORCA, CAPCOM, K9.',
        run: async (bytes, opts) => {
          calls.push(`${opts.lang}|${opts.prompt}|${bytes.length}`);
          if (running++) overlap++;
          await new Promise((r) => setTimeout(r, 20));
          running--;
          return { text: 'para a K9', ms: 20 };
        },
      });
      const server = createServer((req, res) => { void handler(req, res); });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing port');
      const url = `http://127.0.0.1:${address.port}/api/transcribe`;
      const post = (body: Buffer, headers: Record<string, string> = {}, q = '?lang=es-MX') =>
        fetch(url + q, { method: 'POST', headers: { 'content-type': 'audio/wav', ...headers }, body: new Uint8Array(body) });
      try {
        const status = await (await fetch(url)).json() as { ready: boolean; model: string };
        const line = await (await post(wav)).json() as { text: string; lang: string };
        const [a, b] = await Promise.all([post(wav), post(wav)]);
        const wrongType = (await post(wav, { 'content-type': 'audio/webm' })).status;
        const crossSite = (await post(wav, { 'sec-fetch-site': 'cross-site' })).status;
        const tooBig = (await post(Buffer.alloc(AUDIO_LIMIT + 1))).status;
        const empty = (await post(Buffer.alloc(10))).status;
        const method = (await fetch(url, { method: 'PUT' })).status;
        ready = false;
        const down = await post(wav);
        const downBody = await down.json() as { error: string };
        const downStatus = await (await fetch(url)).json() as { ready: boolean; reason: string };
        return ok('endpoint',
          status.ready && status.model === 'ggml-large-v3-turbo.bin'
          && line.text === 'para a K9' && line.lang === 'es'
          && calls[0] === `es|ORCA, CAPCOM, K9.|${wav.length}`
          && a.status === 200 && b.status === 200 && overlap === 0
          && wrongType === 415 && crossSite === 403 && tooBig === 413 && empty === 400 && method === 405
          && down.status === 503 && /whisper-cli not found/.test(downBody.error)
          && !downStatus.ready && /brew install/.test(downStatus.reason),
          JSON.stringify({ status, line, calls, overlap, wrongType, crossSite, tooBig, empty, method, down: down.status, downStatus }));
      } finally {
        server.close();
        await rm(dir, { recursive: true, force: true });
      }
    }),
  ],
} satisfies TestModule;
