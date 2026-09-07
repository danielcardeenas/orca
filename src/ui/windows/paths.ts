/**
 * File paths in what an agent writes, as things you can open.
 *
 * "Saved the screenshot to /Users/dan/x/shot.png", "see src/ui/main.ts:543",
 * "the report is in ./out/report.md". Every one of those is a path the
 * operator would otherwise retype into a terminal, so every one becomes a
 * link that opens the file inside ORCA (see kinds/file.ts): click opens the
 * viewer, ⌘click opens a second one even if that path is already up.
 *
 * Same shape as refs.ts: HTML in, HTML out, and it never looks inside a tag,
 * so the `href` of a real link or the `title` of a tool step is left alone.
 * Text inside `<a>` is already a link and stays one. Text inside `<pre>` and
 * `<code>` IS scanned: that is where paths mostly live.
 *
 * What counts as a path is deliberately narrow. Absolute paths need a root
 * a machine actually has (`/Users`, `/home`, `/tmp`, `/private`…) or a file
 * extension; relative ones need a slash AND an extension or a `:line`
 * suffix. So `and/or`, `w/o`, `1.2.3`, `2026/09/06`, `/api/health` and the
 * path half of a URL are words, and `src/ui/main.ts`, `./foo/bar.png`,
 * `~/notes.md` and `/private/tmp/x/y.log:12:4` are places. Relative paths
 * resolve against the project of the agent whose output this is; with no
 * project known they stay text, because a guess would open the wrong file.
 */

export interface PathScope {
  /** Absolute path of the agent's project. Relative paths resolve against it. */
  root?: string | null;
}

export interface PathMatch {
  /** Exactly what was written, without the :line:col suffix. */
  text: string;
  /** The absolute path to ask the hub for; `~/…` is left for the hub to expand. */
  path: string;
  line: number | null;
  col: number | null;
  /** Offsets into the scanned text, suffix included. */
  start: number;
  end: number;
}

/** Roots a real machine has. A bare `/x/y` with no extension is not one. */
const KNOWN_ROOTS = /^\/(?:Users|home|private|tmp|var|opt|etc|srv|mnt|Volumes|root|workspace|workspaces|app|data|usr)\//;

/** A file extension: a dot, a letter, up to seven more. `1.5` and `v2` are not. */
const EXT = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * One token that could be a path, followed by an optional `:line[:col]`.
 * The look-behind refuses to start inside a word, after a `:` (the scheme of
 * a URL) or after a `/` (the middle of a longer path); the look-ahead refuses
 * to stop inside one.
 */
const TOKEN = /(?<![\w./@+~:%-])((?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+)*\/?)(?::(\d+)(?::(\d+))?)?(?![\w/@+~-])/g;

function classify(token: string, hasLine: boolean): 'abs' | 'home' | 'rel' | null {
  if (token.endsWith('/')) return null;                 // a directory, nothing to show
  if (token.includes('//')) return null;
  if (token.startsWith('/')) {
    const segments = token.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    return KNOWN_ROOTS.test(token) || EXT.test(token) ? 'abs' : null;
  }
  if (token.startsWith('~/')) return token.length > 2 ? 'home' : null;
  if (token.startsWith('./') || token.startsWith('../')) return token.replace(/^(\.\.?\/)+/, '').length ? 'rel' : null;
  if (!token.includes('/')) return null;
  return EXT.test(token) || hasLine ? 'rel' : null;
}

/** Lexical join and normalise: `a/b/../c/./d` → `a/c/d`. Never leaves the root. */
function joinUnder(root: string, rel: string): string {
  const out = root.replace(/\/+$/, '').split('/');
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (out.length > 1) out.pop(); continue; }
    out.push(part);
  }
  return out.join('/') || '/';
}

/** Every path in plain text, in order. */
export function findPaths(text: string, scope: PathScope = {}): PathMatch[] {
  const found: PathMatch[] = [];
  TOKEN.lastIndex = 0;
  for (const m of text.matchAll(TOKEN)) {
    let token = m[1]!;
    let end = m.index! + m[0].length;
    let line = m[2] ? Number(m[2]) : null;
    let col = m[3] ? Number(m[3]) : null;
    // A sentence ends with the path: "see src/a.ts." — the dot is prose.
    while (token.endsWith('.') && !token.endsWith('..')) { token = token.slice(0, -1); end--; }
    if (line !== null && !m[1]!.endsWith(token)) { line = null; col = null; }
    const kind = classify(token, line !== null);
    if (!kind) continue;
    let path: string;
    if (kind === 'abs' || kind === 'home') path = token;
    else {
      if (!scope.root) continue;
      path = joinUnder(scope.root, token);
    }
    found.push({ text: token, path, line, col, start: m.index!, end: line === null ? m.index! + token.length : end });
  }
  return found;
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function anchor(m: PathMatch, written: string): string {
  const where = m.line !== null ? ` data-line="${m.line}"${m.col !== null ? ` data-col="${m.col}"` : ''}` : '';
  return `<a class="ref ref--file" data-file="${attr(m.path)}"${where} title="OPEN IN ORCA · ⌘CLICK OPENS ANOTHER">${written}</a>`;
}

/**
 * Link every path in `html`, leaving tags and attributes alone.
 *
 * The text between tags is already HTML-escaped, so a path never contains
 * `&`, `<`, `>` or a quote: the token pattern stops at all of them, and the
 * written form goes back out untouched.
 */
export function linkPaths(html: string, scope: PathScope = {}): string {
  if (!html.includes('/')) return html;
  let quiet = 0;
  return html.split(/(<[^>]*>)/).map((part, i) => {
    if (i % 2 === 1) {
      if (/^<a\b/i.test(part)) quiet++;
      else if (/^<\/a\b/i.test(part)) quiet = Math.max(0, quiet - 1);
      return part;
    }
    if (quiet || !part.includes('/')) return part;
    const matches = findPaths(part, scope);
    if (!matches.length) return part;
    let out = '';
    let at = 0;
    for (const m of matches) {
      out += part.slice(at, m.start) + anchor(m, part.slice(m.start, m.end));
      at = m.end;
    }
    return out + part.slice(at);
  }).join('');
}

/** The last segment: what the window is called. */
export function baseName(path: string): string {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/');
  return cut >= 0 ? path.slice(cut + 1) : path;
}

export function dirName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : '/';
}

/** What the viewer will do with a file, decided by its name. */
export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'html' | 'markdown' | 'text';

export function fileKind(path: string): FileKind {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(baseName(path))?.[1] ?? '').toLowerCase();
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/.test(ext)) return 'image';
  if (/^(mp4|webm|mov|m4v|ogv)$/.test(ext)) return 'video';
  if (/^(mp3|wav|ogg|oga|m4a|aac|flac)$/.test(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (/^(html?)$/.test(ext)) return 'html';
  if (/^(md|markdown)$/.test(ext)) return 'markdown';
  return 'text';
}

/** highlight.js language for a file name, among the ones markdown.ts registers. */
export function languageOf(path: string): string | null {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(baseName(path))?.[1] ?? '').toLowerCase();
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts': return 'typescript';
    case 'js': case 'mjs': case 'cjs': case 'jsx': return 'javascript';
    case 'sh': case 'bash': case 'zsh': return 'bash';
    case 'json': case 'jsonl': return 'json';
    case 'py': return 'python';
    case 'css': return 'css';
    case 'html': case 'htm': case 'xml': case 'svg': case 'vue': return 'xml';
    case 'sql': return 'sql';
    case 'diff': case 'patch': return 'diff';
    case 'yml': case 'yaml': return 'yaml';
    default: return null;
  }
}
