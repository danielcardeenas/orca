/**
 * Archivos que el operador suelta en la consola, guardados en el disco del hub.
 *
 * Un agente no tiene ojos en el navegador: lo que ve es su disco. Cuando el
 * operador arrastra un archivo a una conversación, la consola lo sube aquí,
 * el hub lo deja en `ORCA_HOME/uploads` y devuelve la ruta absoluta; la
 * consola pega esa ruta en el mensaje, como hace un terminal al soltar un
 * archivo encima. Claude Code y Codex leen rutas del prompt sin más ceremonia:
 * una imagen la abren con su herramienta de imágenes, un texto con `Read`.
 *
 * Reglas, todas aquí y no en el servidor:
 *
 *  - el nombre lo pone el cliente en `x-orca-name` (percent-encoded, porque
 *    una cabecera no lleva UTF-8), y se sanea: sólo el basename, sin espacios
 *    ni caracteres de control, sin punto inicial. El original importa porque
 *    `informe-q3.pdf` le dice al agente lo que `3f2a9c1e.bin` no;
 *  - cada archivo cae con un prefijo aleatorio, así dos `captura.png` no se
 *    pisan y una ruta no se adivina;
 *  - el cuerpo se lee acotado aunque `content-length` mienta o falte;
 *  - una petición cross-site se rechaza: la consola es el único remitente.
 *
 * Quién puede subir lo decide el servidor antes de llamar aquí (el token, como
 * en `/api/recovery-images`). Esto no autentica.
 *
 * `~/.orca/uploads` es un candidato de limpieza (`scratch` en la higiene):
 * lo que se adjuntó a una conversación ya vive en el transcript por su ruta,
 * y el archivo en sí es prescindible cuando la conversación lo es.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Un PDF de cien páginas o una captura de pantalla 5K caben; un vídeo, no. */
export const UPLOAD_LIMIT = 64 * 1024 * 1024;
/** Un nombre más largo no lee nadie y algún sistema de archivos lo rechaza. */
const NAME_MAX = 120;

/**
 * El nombre con el que se guarda, a partir del que trajo el cliente.
 * Sólo el basename: una ruta del navegador nunca decide dónde cae nada.
 */
export function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^[._-]+/, '')
    .slice(0, NAME_MAX);
  return cleaned || 'file';
}

/**
 * Lee el cuerpo entero, o devuelve null si supera `limit`. No se fía de
 * `content-length`: se cuenta lo que llega.
 */
export async function readBounded(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Sólo después de que el hub haya autenticado la petición. */
export async function uploadFile(req: IncomingMessage, res: ServerResponse, directory: string): Promise<void> {
  const reply = (code: number, value: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); reply(405, { error: 'Use POST.' }); return; }
  if (req.headers['sec-fetch-site'] === 'cross-site') { reply(403, { error: 'Use the ORCA console to upload files.' }); return; }
  if (Number(req.headers['content-length']) > UPLOAD_LIMIT) { reply(413, { error: 'Files must be 64 MB or smaller.' }); return; }
  const header = req.headers['x-orca-name'];
  let name = 'file';
  try { name = safeName(decodeURIComponent(typeof header === 'string' ? header : '')); } catch { /* percent-encoding roto: se queda `file` */ }
  try {
    const bytes = await readBounded(req, UPLOAD_LIMIT);
    if (!bytes) {
      res.setHeader('connection', 'close');
      reply(413, { error: 'Files must be 64 MB or smaller.' });
      return;
    }
    if (!bytes.length) { reply(400, { error: 'The file is empty.' }); return; }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${randomUUID().slice(0, 8)}-${name}`);
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
    reply(201, { path, name, mime: req.headers['content-type'] ?? 'application/octet-stream', bytes: bytes.length });
  } catch {
    if (!res.headersSent) reply(500, { error: 'Upload failed. Try again.' });
  }
}
