/**
 * File paths in agent prose become links into ORCA's own viewer.
 *
 * Half of this is about what is NOT a path: a URL's tail, a version number,
 * `and/or`, a date, a route. A linkifier that turns those into links makes
 * every transcript a minefield of 403s, so the negatives matter as much as
 * the positives. And, as with refs.ts, it must never reach inside a tag.
 */

import { findPaths, linkPaths, fileKind, baseName, dirName } from '../src/ui/windows/paths.ts';
import { ok, eq, test, type TestModule } from './harness.ts';

const ROOT = '/Users/dan/projects/orca';
const paths = (s: string, root: string | null = ROOT) => findPaths(s, { root }).map((m) => `${m.path}${m.line !== null ? `:${m.line}` : ''}${m.col !== null ? `:${m.col}` : ''}`);
const links = (html: string) => [...linkPaths(html, { root: ROOT }).matchAll(/data-file="([^"]*)"/g)].map((m) => m[1]);

const tests = [
  /* ── positives ─────────────────────────────────────────────────── */
  test('an absolute macOS path', () =>
    eq('abs', paths('saved it to /Users/dan/projects/orca/out/shot.png for you'), ['/Users/dan/projects/orca/out/shot.png'])),

  test('a scratchpad path under /private/tmp', () =>
    eq('scratch', paths('wrote /private/tmp/claude-501/x/scratchpad/report.html'), ['/private/tmp/claude-501/x/scratchpad/report.html'])),

  test('a relative path with a :line suffix resolves against the root', () =>
    eq('rel', paths('see src/ui/main.ts:543 for the artifact key'), [`${ROOT}/src/ui/main.ts:543`])),

  test(':line:col is kept', () => {
    const [m] = findPaths('error at src/hub/server.ts:12:8', { root: ROOT });
    return ok('line and col', m?.line === 12 && m?.col === 8 && m.text === 'src/hub/server.ts', JSON.stringify(m));
  }),

  test('./ and ../ resolve lexically', () =>
    eq('dots', paths('in ./out/a.png and ../sibling/b.md'), [`${ROOT}/out/a.png`, '/Users/dan/projects/sibling/b.md'])),

  test('~/ is left for the hub to expand', () =>
    eq('home', paths('notes in ~/notes/today.md'), ['~/notes/today.md'])),

  test('a sentence-ending dot is not part of the path', () =>
    eq('dot', findPaths('read docs/README.md.', { root: ROOT }).map((m) => m.text), ['docs/README.md'])),

  test('parentheses and quotes around a path are not part of it', () =>
    eq('wrapped', paths('(see src/a.ts) and "src/b.ts" and \'src/c.ts\''), [`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`, `${ROOT}/src/c.ts`])),

  test('HTML-escaped quotes stop the path too', () =>
    eq('escaped', links('&quot;src/a.ts&quot; and &#39;src/b.ts&#39;'), [`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`])),

  test('a path inside <code> is linked', () =>
    eq('code', links('<p>see <code>src/ui/main.ts:543</code></p>'), [`${ROOT}/src/ui/main.ts`])),

  test('a path inside a highlighted <pre> is linked', () =>
    eq('pre', links('<pre class="talk__pre"><code class="hljs"><span class="hljs-comment">// /Users/dan/x.ts</span></code></pre>'), ['/Users/dan/x.ts'])),

  test('the written form is preserved as the link text', () => {
    const html = linkPaths('at src/ui/main.ts:543:2 now', { root: ROOT });
    return ok('text kept', html.includes('>src/ui/main.ts:543:2</a>') && html.includes('data-line="543"') && html.includes('data-col="2"'), html);
  }),

  test('a known-root absolute path without an extension is still a path', () =>
    eq('dir-ish', paths('cd /Users/dan/projects/orca'), ['/Users/dan/projects/orca'])),

  test('a Linux home path', () =>
    eq('linux', paths('/home/ci/build/out.log'), ['/home/ci/build/out.log'])),

  test('a path with dashes, dots and @ in segments', () =>
    eq('chars', paths('node_modules/@types/node/index.d.ts'), [`${ROOT}/node_modules/@types/node/index.d.ts`])),

  /* ── negatives ─────────────────────────────────────────────────── */
  test('the tail of a URL is not a path', () =>
    eq('url', paths('open https://example.com/foo/bar.png and http://x.io/a/b.ts:3'), [])),

  test('version numbers are not paths', () =>
    eq('versions', paths('bumped 1.2.3 to v1.3.0 and node 22.10.0'), [])),

  test('and/or, w/o and dates are words', () =>
    eq('words', paths('and/or w/o 2026/09/06 either/or'), [])),

  test('a route is not a file', () =>
    eq('route', paths('GET /api/health then /api/file?path='), [])),

  test('a relative directory without an extension is not linked', () =>
    eq('dir', paths('look in src/ui and test/shots'), [])),

  test('a relative path with no known root stays text', () =>
    eq('no-root', paths('see src/ui/main.ts:543', null), [])),

  test('a method call is not a path', () =>
    eq('call', paths('foo.bar() e.g. i.e. etc.'), [])),

  test('a bare filename is not linked', () =>
    eq('bare', paths('edit package.json and README.md'), [])),

  test('a decimal after a slash is not a file', () =>
    eq('decimal', paths('ratio a/1.5 and x/2.0'), [])),

  /* ── never inside a tag ────────────────────────────────────────── */
  test('attributes are left alone', () => {
    const html = '<summary title="/Users/dan/a.ts"><b>Read</b><span>/Users/dan/a.ts</span></summary>';
    const out = linkPaths(html, { root: ROOT });
    return ok('title untouched, text linked', out.startsWith('<summary title="/Users/dan/a.ts">') && out.includes('<a class="ref ref--file" data-file="/Users/dan/a.ts"'), out);
  }),

  test('text inside an existing link is left alone', () =>
    eq('in-a', links('<a href="https://x/y">/Users/dan/a.ts</a> but /Users/dan/b.ts'), ['/Users/dan/b.ts'])),

  test('html without a slash comes back identical, fast', () => {
    const html = '<p>no paths here</p>';
    return ok('identity', linkPaths(html, { root: ROOT }) === html);
  }),

  test('a root with an ampersand is escaped in the attribute', () => {
    const out = linkPaths('src/a.ts', { root: '/Users/d&n' });
    return ok('escaped', out.includes('data-file="/Users/d&amp;n/src/a.ts"'), out);
  }),

  /* ── helpers ───────────────────────────────────────────────────── */
  test('fileKind by extension', () =>
    eq('kinds', ['a.PNG', 'b.mp4', 'c.mp3', 'd.pdf', 'e.html', 'f.md', 'g.ts', 'Makefile'].map(fileKind),
      ['image', 'video', 'audio', 'pdf', 'html', 'markdown', 'text', 'text'])),

  test('baseName and dirName', () =>
    eq('names', [baseName('/a/b/c.ts'), dirName('/a/b/c.ts'), baseName('c.ts'), dirName('/c.ts')], ['c.ts', '/a/b', 'c.ts', '/'])),
];

export default { suite: 'paths', tests } satisfies TestModule;
