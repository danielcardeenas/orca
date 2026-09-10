/**
 * ORCA hub — archivos de proyecto, servidos a la consola.
 *
 * Un agente escribe "guardé la captura en /Users/dan/x/shot.png" y el operador
 * quiere verla sin salir de la consola. Este módulo es la parte del hub que lo
 * permite: `GET /api/file?path=…` devuelve los bytes de un archivo local.
 *
 * Es también la ruta más peligrosa del hub, porque lee del disco a petición de
 * un cliente. Las decisiones, en orden de importancia:
 *
 *  1. **Sólo bajo raíces conocidas.** Las raíces son los `path` de los
 *     proyectos que el mundo conoce (los collectors los declaran), el
 *     scratchpad de los agentes (`/tmp/claude-<uid>`, donde Claude Code deja
 *     capturas y archivos intermedios), lo que el operador añada en
 *     `ORCA_FILE_ROOTS` y las carpetas que autorice desde el visor cuando
 *     éste dijo 403 (file-roots.ts; persisten en `~/.orca/hub`). Nada más:
 *     ni `~`, ni `/etc`, ni el propio `~/.orca` donde vive el token.
 *
 *  2. **Contención por ruta real.** La ruta pedida se resuelve, se pasa por
 *     `realpath` (que sigue symlinks) y se compara con el `realpath` de cada
 *     raíz. `../` se normaliza antes de mirar; un symlink dentro del proyecto
 *     que apunte fuera se ve como lo que apunta y se rechaza. Un archivo que no
 *     existe no puede tener realpath, así que se contiene primero por ruta
 *     léxica —para poder decir 404 y no 403— y luego por la real.
 *
 *  3. **Raíces que no son raíces.** Un collector podría declarar un proyecto en
 *     `/` o en `$HOME` y convertir toda la máquina en servible. Se ignoran las
 *     raíces con menos de dos segmentos, contenedores temporales, rutas
 *     privadas conocidas y la home del usuario del hub. (Quien
 *     declara proyectos lleva el mismo token que quien lee archivos —el hub
 *     tiene un dueño, no usuarios— así que esto es un cinturón, no la puerta.)
 *
 *  4. **HTML y SVG no ejecutan.** Se sirven con `Content-Security-Policy:
 *     sandbox`, igual que los artefactos: en el origen de la consola sin
 *     sandbox, un html escrito por un agente podría hacerle fetch al hub con el
 *     token del operador. Con él es un dibujo. El PDF no lleva sandbox porque
 *     el visor de Chrome se niega a pintar dentro de uno; el visor de PDF del
 *     navegador ya está aislado por el navegador.
 *
 *  5. **Techo de tamaño.** `MAX_ARTIFACT_BYTES` (16MB), el mismo que los
 *     artefactos. Por encima, 413 con el tamaño para que la consola lo diga.
 *
 * Con `Range` se sirve un trozo, que es lo que Safari exige para reproducir
 * vídeo y audio. Sólo un rango, sin listas: es lo que piden los navegadores.
 */

import { createReadStream, lstatSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { MAX_ARTIFACT_BYTES } from '../shared/protocol.ts';

/* ── Tipos de contenido ───────────────────────────────────────────── */

/**
 * Más amplia que `ARTIFACT_MIME` porque aquí llega cualquier archivo de un
 * repo, no sólo lo que un agente decidió enseñar. Lo que no está, si parece
 * texto por extensión, va como `text/plain`; el resto, `octet-stream`, que el
 * visor de la consola muestra como "binario" en vez de intentar leerlo.
 */
const MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/** Extensiones que son texto aunque el navegador no las conozca. */
const TEXTUAL = /\.(ts|tsx|jsx|cjs|mts|cts|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|fish|ps1|sql|yaml|yml|toml|ini|cfg|conf|env|log|lock|diff|patch|txt|text|tsv|jsonl|ndjson|graphql|gql|proto|tf|vue|svelte|astro|scss|sass|less|mk|makefile|dockerfile|gitignore|editorconfig|nix|lua|pl|r|m|mm|ex|exs|erl|hs|ml|scala|clj|dart|zig|v|sol|tex|bib|rst|adoc|org|properties|plist|htaccess|license|readme|changelog)$/i;

/** Sin extensión y con nombre de archivo de texto conocido: Makefile, Dockerfile, LICENSE… */
const TEXTUAL_NAMES = /^(makefile|dockerfile|license|readme|changelog|authors|contributors|copying|notice|procfile|gemfile|rakefile|brewfile|vagrantfile|\.[a-z0-9_-]+rc|\.[a-z0-9_-]+ignore|\.env(\.[a-z0-9_-]+)?)$/i;

export function fileMime(path: string): string {
  const name = basename(path);
  const ext = extname(name).toLowerCase();
  const known = MIME[ext];
  if (known) return known;
  if ((ext && TEXTUAL.test(name)) || TEXTUAL_NAMES.test(name)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/* ── Raíces ───────────────────────────────────────────────────────── */

/**
 * Dónde dejan cosas los agentes de Claude Code cuando no es en el repo:
 * `/tmp/claude-<uid>/<proyecto>/<sesión>/scratchpad`. En macOS `/tmp` es un
 * symlink a `/private/tmp`, así que las dos formas se dan y el `realpath`
 * las reconcilia.
 */
export function scratchpadRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const roots: string[] = [];
  if (uid !== null) {
    roots.push(`/tmp/claude-${uid}`, `/private/tmp/claude-${uid}`);
  }
  const tmp = env['TMPDIR'];
  if (tmp && uid !== null) roots.push(resolve(tmp, `claude-${uid}`));
  // Un nombre predecible en /tmp no acredita al propietario. No seguir una
  // raíz scratchpad sustituida por un symlink ni adoptar la de otro usuario.
  return roots.filter((root) => {
    try { const st = lstatSync(root); return st.isDirectory() && st.uid === uid; }
    catch { return false; }
  });
}

/** `ORCA_FILE_ROOTS=/a:/b` — subcarpetas o archivos concretos autorizados. */
export function envRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env['ORCA_FILE_ROOTS'] ?? '';
  return raw.split(':').map((s) => s.trim()).filter(Boolean);
}

/**
 * Una raíz que vale. Absoluta, con al menos dos segmentos, distinta de la
 * home y de contenedores temporales o rutas privadas conocidas. La
 * existencia en disco se comprueba al resolver, no aquí: una raíz de otra
 * máquina simplemente no contendrá nunca nada.
 */
export function acceptableRoot(root: string, home: string = homedir()): boolean {
  if (!isAbsolute(root)) return false;
  const norm = resolve(root);
  const segments = norm.split(sep).filter(Boolean);
  if (segments.length < 2) return false;
  const h = resolve(home);
  if (norm === h) return false;
  // Nunca convertir contenedores temporales o sus aliases en raíces de trabajo.
  const containers = ['/private', '/var', '/private/var', '/tmp', '/private/tmp', '/private/temp',
    '/var/tmp', '/private/var/tmp', tmpdir()];
  if (containers.some((p) => norm === resolve(p))) return false;
  if (/^\/(?:private\/)?var\/folders(?:\/[^/]+){0,3}$/.test(norm)) return false;
  if (privatePath(norm)) return false;
  return true;
}

/** Defensa por nombres conocidos; una extensión inocua no certifica contenido. */
function privatePath(path: string): boolean {
  const parts = path.split(sep).filter(Boolean);
  if (/^\/(?:private\/)?etc(?:\/|$)/i.test(path)) return true;
  if (parts.some((p) => /^(?:\.ssh|\.aws|\.azure|\.config|\.gnupg|\.kube|\.claude|\.codex|\.docker|\.git)$/i.test(p))) return true;
  if (parts.some((p) => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.claude\.json|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keychain(?:-db)?))$/i.test(p))) return true;
  if (/\/.orca\/(?:token|config(?:\.[^/]*)?)(?:\/|$)/i.test(path)) return true;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return parts.some((p) => /^claude-\d+$/.test(p) && p !== `claude-${uid}`);
}

/* ── Contención ───────────────────────────────────────────────────── */

export type Resolution =
  | { ok: true; path: string; size: number; mime: string }
  | { ok: false; status: 400 | 403 | 404 | 413; reason: string };

function within(real: string, root: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Decide si `requested` se puede servir bajo `roots`.
 *
 * La contención va en dos pasos porque un archivo inexistente no tiene
 * realpath: primero la ruta léxica (normalizada, sin `..`) contra las raíces
 * léxicas, para poder decir 404 a "está dentro pero no existe"; después la
 * real contra las reales, que es la que manda. Las raíces léxicas incluyen
 * sus formas canónicas y los aliases macOS comprobados en disco. Un `..` que se sale del
 * proyecto o un symlink que apunta fuera terminan aquí los dos con 403.
 *
 * `~/` se expande a la home del hub: la consola no sabe dónde vive cada
 * agente, y cuando hub y agente comparten máquina —el caso instalado— es lo
 * mismo. Expandir no abre nada: la ruta expandida sigue teniendo que caer
 * bajo una raíz.
 */
export function resolveServedPath(
  requested: string,
  roots: Iterable<string>,
  opts: { home?: string; maxBytes?: number } = {},
): Resolution {
  const home = opts.home ?? homedir();
  const max = opts.maxBytes ?? MAX_ARTIFACT_BYTES;

  let raw = requested.trim();
  if (!raw) return { ok: false, status: 400, reason: 'falta path' };
  if (raw.includes('\0')) return { ok: false, status: 400, reason: 'path con NUL' };
  if (raw === '~' || raw.startsWith('~/')) raw = home + raw.slice(1);
  if (!isAbsolute(raw)) return { ok: false, status: 400, reason: 'la ruta tiene que ser absoluta' };

  const lexical = resolve(raw);
  if (privatePath(lexical)) return { ok: false, status: 403, reason: 'ruta privada excluida' };
  const accepted: string[] = [];
  const realRoots: string[] = [];
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const root of roots) {
    if (!acceptableRoot(root, home)) continue;
    const r = resolve(root);
    try {
      const realRoot = realpathSync(r);
      if (!acceptableRoot(realRoot, home) || (uid !== null && statSync(realRoot).uid !== uid)) continue;
      accepted.push(r, realRoot);
      // Sólo aliases de sistema reales y equivalentes; /private/temp no se
      // inventa como alias de /tmp. Funciona en ambas direcciones para TMPDIR.
      const alias = realRoot.replace(/^\/private\/(tmp|var)(?=\/|$)/, '/$1');
      if (alias !== realRoot) {
        try { if (realpathSync(alias) === realRoot) accepted.push(alias); } catch { /* sin alias */ }
      }
      realRoots.push(realRoot);
    } catch { accepted.push(r); /* raíz inexistente: conservar el 404 */ }
  }
  // Incluir la forma canónica de cada raíz, no cualquier symlink de entrada.
  if (!accepted.some((r) => within(lexical, r))) {
    return { ok: false, status: 403, reason: 'fuera de las raíces de proyecto conocidas' };
  }

  let real: string;
  try { real = realpathSync(lexical); } catch { return { ok: false, status: 404, reason: 'no existe' }; }

  if (privatePath(real) || !realRoots.some((r) => within(real, r))) {
    return { ok: false, status: 403, reason: 'la ruta apunta fuera de las raíces (symlink)' };
  }

  let st: ReturnType<typeof statSync>;
  try { st = statSync(real); } catch { return { ok: false, status: 404, reason: 'no existe' }; }
  if (!st.isFile()) return { ok: false, status: 404, reason: 'no es un archivo' };
  if (uid !== null && st.uid !== uid) return { ok: false, status: 403, reason: 'archivo de otro usuario' };
  if (st.size > max) return { ok: false, status: 413, reason: `pesa ${st.size}B, por encima del límite de ${max}B` };

  return { ok: true, path: real, size: st.size, mime: fileMime(real) };
}

/* ── Cabeceras y servido ──────────────────────────────────────────── */

/** Lo que ejecuta scripts si se le deja: html y svg. */
function executable(mime: string): boolean {
  return mime.startsWith('text/html') || mime.startsWith('image/svg');
}

export function fileHeaders(mime: string, length: number, opts: { size?: number } = {}): Record<string, string> {
  const head: Record<string, string> = {
    'content-type': mime,
    'content-length': String(length),
    'content-disposition': 'inline',
    // Un archivo de trabajo cambia debajo del agente: no se cachea. La
    // consola pide una vez por apertura.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
  };
  if (executable(mime)) head['content-security-policy'] = 'sandbox';
  if (opts.size !== undefined) head['x-orca-file-size'] = String(opts.size);
  return head;
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n`. Cualquier otra cosa se ignora y va entero. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start: number, end: number;
  if (a === '') { const n = Number(b); start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(a); end = b === '' ? size - 1 : Math.min(Number(b), size - 1); }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

/**
 * Sirve un archivo ya resuelto. La autenticación es del que llama: este módulo
 * no sabe de tokens, sólo de bytes.
 */
export function streamFile(req: IncomingMessage, res: ServerResponse, file: { path: string; size: number; mime: string }): void {
  const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, file.size);
  const head = req.method === 'HEAD';
  if (range) {
    const length = range.end - range.start + 1;
    res.writeHead(206, { ...fileHeaders(file.mime, length, { size: file.size }), 'content-range': `bytes ${range.start}-${range.end}/${file.size}` });
    if (head) { res.end(); return; }
    createReadStream(file.path, { start: range.start, end: range.end }).pipe(res);
    return;
  }
  if (typeof req.headers.range === 'string' && file.size > 0 && /^bytes=/.test(req.headers.range)) {
    // Un rango que no cabe: 416 con el tamaño, que es lo que el reproductor necesita para reintentar.
    res.writeHead(416, { 'content-range': `bytes */${file.size}`, 'content-length': '0' });
    res.end();
    return;
  }
  res.writeHead(200, fileHeaders(file.mime, file.size, { size: file.size }));
  if (head) { res.end(); return; }
  createReadStream(file.path).pipe(res);
}
