import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { uploadRecoveryImage, RECOVERY_IMAGE_LIMIT } from '../src/hub/recovery-images.ts';
import { test, ok, type TestModule } from './harness.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=', 'base64');

export default {
  suite: 'recovery-images',
  tests: [test('uploads preserve bytes; filenames, formats, size and cross-site requests are bounded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-image-test-'));
    const server = createServer((req, res) => { void uploadRecoveryImage(req, res, dir); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing port');
    const url = `http://127.0.0.1:${address.port}/api/recovery-images`;
    const post = (body: Buffer, mime: string, extra: Record<string, string> = {}) => fetch(url, {
      method: 'POST', headers: { 'content-type': mime, ...extra }, body: new Uint8Array(body),
    });
    try {
      const valid = await post(png, 'image/png');
      const saved = await valid.json() as { path: string };
      const exact = (await readFile(saved.path)).equals(png) && saved.path.startsWith(dir + '/');
      const fake = await post(Buffer.from('<script>alert(1)</script>'), 'image/png');
      const svg = await post(Buffer.from('<svg></svg>'), 'image/svg+xml');
      const huge = await post(Buffer.alloc(RECOVERY_IMAGE_LIMIT + 1), 'image/png');
      const cross = await post(png, 'image/png', { 'sec-fetch-site': 'cross-site' });
      const method = await fetch(url);
      const files = await readdir(dir);
      return ok('validated uploads', valid.status === 201 && exact && fake.status === 415 && svg.status === 415
        && huge.status === 413 && cross.status === 403 && method.status === 405 && files.length === 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  })],
} satisfies TestModule;
