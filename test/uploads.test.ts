/**
 * hub/uploads.ts — un archivo soltado en la consola llega al disco del hub.
 *
 * Lo que vale la pena guardar: los bytes son los mismos; el nombre original
 * sobrevive saneado y con prefijo, sin que una ruta del cliente decida la
 * carpeta; el límite se aplica al cuerpo real y no a la cabecera; lo vacío,
 * lo cross-site y otro método se rechazan; y un nombre imposible cae como
 * `file` en vez de romper la subida.
 */

import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { uploadFile, safeName, UPLOAD_LIMIT } from '../src/hub/uploads.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

export default {
  suite: 'uploads',
  tests: [
    test('safeName keeps the basename, drops what a shell or a filesystem would choke on', () => {
      const cases: [string, string][] = [
        ['informe q3 (final).pdf', 'informe_q3__final_.pdf'],
        ['../../etc/passwd', 'passwd'],
        ['C:\\Users\\dan\\captura.png', 'captura.png'],
        ['.env', 'env'],
        ['', 'file'],
        ['\u0000\u0001', 'file'],
        ['ñandú.txt', 'ñandú.txt'],
        ['a'.repeat(300) + '.md', 'a'.repeat(120)],
      ];
      for (const [raw, want] of cases) {
        const got = safeName(raw);
        if (got !== want) return eq(`safeName(${JSON.stringify(raw)})`, got, want);
      }
      return ok('names sanitized', true);
    }),
    test('uploads preserve bytes and names; size, emptiness, cross-site and method are bounded', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-upload-test-'));
      const server = createServer((req, res) => { void uploadFile(req, res, dir); });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing port');
      const url = `http://127.0.0.1:${address.port}/api/uploads`;
      const post = (body: Buffer, name: string | null, extra: Record<string, string> = {}) => fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/pdf', ...(name === null ? {} : { 'x-orca-name': encodeURIComponent(name) }), ...extra },
        body: new Uint8Array(body),
      });
      const pdf = Buffer.from('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\nhola\n', 'latin1');
      try {
        const valid = await post(pdf, 'informe q3.pdf');
        const saved = await valid.json() as { path: string; name: string; bytes: number };
        const exact = (await readFile(saved.path)).equals(pdf);
        const named = saved.name === 'informe_q3.pdf' && /^[0-9a-f]{8}-informe_q3\.pdf$/.test(basename(saved.path));
        const inside = saved.path.startsWith(dir + '/');
        const unnamed = await post(pdf, null);
        const fallback = basename((await unnamed.json() as { path: string }).path).endsWith('-file');
        const broken = await post(pdf, '%E0%A4%A');       // percent-encoding roto: no rompe la subida
        const empty = await post(Buffer.alloc(0), 'vacio.txt');
        const huge = await post(Buffer.alloc(UPLOAD_LIMIT + 1), 'grande.bin');
        const cross = await post(pdf, 'x.pdf', { 'sec-fetch-site': 'cross-site' });
        const method = await fetch(url);
        const files = await readdir(dir);
        return ok('validated uploads',
          valid.status === 201 && exact && named && inside && saved.bytes === pdf.length
          && unnamed.status === 201 && fallback && broken.status === 201
          && empty.status === 400 && huge.status === 413 && cross.status === 403 && method.status === 405
          && files.length === 3,
          `valid=${valid.status} exact=${exact} named=${named} inside=${inside} unnamed=${unnamed.status} fallback=${fallback} broken=${broken.status} empty=${empty.status} huge=${huge.status} cross=${cross.status} method=${method.status} files=${files.length}`);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      }
    }),
  ],
} satisfies TestModule;
