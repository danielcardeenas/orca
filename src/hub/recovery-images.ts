import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBounded } from './uploads.ts';

export const RECOVERY_IMAGE_LIMIT = 8 * 1024 * 1024;
const formats = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const;

export function imageMatches(bytes: Buffer, mime: string): boolean {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString());
  return mime === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
}

/** Called only after the hub authenticates the request. No client paths/names. */
export async function uploadRecoveryImage(req: IncomingMessage, res: ServerResponse, directory: string): Promise<void> {
  const reply = (code: number, value: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); reply(405, { error: 'Use POST.' }); return; }
  if (req.headers['sec-fetch-site'] === 'cross-site') { reply(403, { error: 'Use the ORCA console to upload images.' }); return; }
  const mime = req.headers['content-type'] ?? '';
  if (!Object.hasOwn(formats, mime)) { reply(415, { error: 'Choose a PNG, JPEG, WebP or GIF image.' }); return; }
  if (Number(req.headers['content-length']) > RECOVERY_IMAGE_LIMIT) { reply(413, { error: 'Images must be 8 MB or smaller.' }); return; }
  try {
    // Read bounded bytes even when Content-Length is absent or incorrect.
    const bytes = await readBounded(req, RECOVERY_IMAGE_LIMIT);
    if (!bytes) {
      res.setHeader('connection', 'close');
      reply(413, { error: 'Images must be 8 MB or smaller.' });
      return;
    }
    const size = bytes.length;
    if (!imageMatches(bytes, mime)) { reply(415, { error: 'The file does not match its image format.' }); return; }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${randomUUID()}.${formats[mime as keyof typeof formats]}`);
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
    reply(201, { path, mime, bytes: size });
  } catch {
    if (!res.headersSent) reply(500, { error: 'Image upload failed. Try again.' });
  }
}
