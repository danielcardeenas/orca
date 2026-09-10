/**
 * El navegador de archivos: la navegación sin DOM (file-nav.ts), el listado
 * del hub (`/api/dir`) con la misma contención que `/api/file`, y la ventana
 * de verdad en Chromium con las teclas de vim y la fila del menú del proyecto.
 *
 * La mitad de lo del hub son intentos de salirse: `..`, una carpeta fuera,
 * un symlink que apunta fuera, la home. Un navegador es la forma más cómoda
 * de recorrer un disco, así que es donde más importa que no pueda.
 */

import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createAuth } from '../src/hub/auth.ts';
import { startHub } from '../src/hub/server.ts';
import { resolveServedDir, type DirEntry } from '../src/hub/files.ts';
import { FileNav, HALF_PAGE, joinPath, parentOf, relativeTo, underRoot, type NavEntry } from '../src/ui/windows/file-nav.ts';
import { ok, eq, test, freePort, sleep, type TestModule } from './harness.ts';
// Keep the actual browser fixture in the affected-import graph.
import type * as Fixture from './file-browser.fixture.ts';
type F = typeof Fixture;

/* ── Un árbol de mentira para la navegación ─────────────────────────── */

const d = (name: string): NavEntry => ({ name, kind: 'dir', size: null, mtime: 1 });
const f = (name: string, size = 10): NavEntry => ({ name, kind: 'file', size, mtime: 1 });
const o = (name: string): NavEntry => ({ name, kind: 'other', size: null, mtime: null });
const ROOT_ENTRIES = [d('src'), d('test'), f('README.md'), f('package.json'), o('leak')];

function navAt(dir = '/p') {
  const nav = new FileNav('/p', dir);
  nav.show(dir, ROOT_ENTRIES);
  return nav;
}

/* ── Un árbol de verdad para el hub ─────────────────────────────────── */

const BASE = realpathSync(tmpdir());
const FIXTURE = mkdtempSync(join(BASE, 'orca-dir-test-'));
const ROOT = join(FIXTURE, 'project');
const OUTSIDE = join(FIXTURE, 'outside');
const TOKEN = 'orca-dir-fixture-token';
let ready = false;

function fixture(): void {
  if (ready) return;
  ready = true;
  mkdirSync(join(ROOT, 'src', 'ui'), { recursive: true });
  mkdirSync(join(ROOT, '.git'), { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(ROOT, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(ROOT, 'src', 'ui', 'main.ts'), '// ui\n');
  writeFileSync(join(ROOT, 'README.md'), '# hi\n');
  writeFileSync(join(ROOT, 'zeta.txt'), 'z\n');
  writeFileSync(join(ROOT, '.env'), 'NON-SENSITIVE-FIXTURE');
  writeFileSync(join(OUTSIDE, 'secret.txt'), 'ESTO-NO-DEBE-SALIR');
  symlinkSync(OUTSIDE, join(ROOT, 'leakdir'));
  symlinkSync(join(ROOT, 'src'), join(ROOT, 'srclink'));
  execFileSync('mkfifo', [join(ROOT, 'pipe')]);
}

async function withHub<T>(fn: (base: string) => Promise<T>): Promise<T> {
  fixture();
  const port = await freePort();
  const hub = await startHub({ port, host: '127.0.0.1', quiet: true, fileRoots: [ROOT], auth: createAuth({ ORCA_TOKEN: TOKEN, ORCA_STRICT_AUTH: '1' }) });
  try { return await fn(`http://127.0.0.1:${port}`); } finally { await hub.close(); }
}

const url = (base: string, path: string, token: string | null = TOKEN) => `${base}/api/dir?path=${encodeURIComponent(path)}${token ? `&token=${token}` : ''}`;
type Reply = { ok: true; path: string; entries: DirEntry[]; truncated: boolean };

export default {
  suite: 'file-browser',
  tests: [
    /* ── file-nav.ts ─────────────────────────────────────────────── */

    test('paths: the root is a wall', () => {
      assert.equal(parentOf('/p/src/ui', '/p'), '/p/src');
      assert.equal(parentOf('/p/src', '/p/'), '/p');
      assert.equal(parentOf('/p', '/p'), null, 'at the root there is nowhere up');
      assert.equal(parentOf('/elsewhere', '/p'), null, 'outside the root is not a place');
      assert.equal(parentOf('/proj2/x', '/proj'), null, 'a sibling that shares the prefix is not inside');
      assert.equal(relativeTo('/p/src/ui', '/p'), 'src/ui');
      assert.equal(relativeTo('/p', '/p'), '');
      assert.ok(underRoot('/p/src', '/p') && !underRoot('/px', '/p') && !underRoot('/', '/p'));
      assert.equal(joinPath('/p', 'a'), '/p/a');
      assert.equal(joinPath('/', 'a'), '/a');
      const nav = new FileNav('/p', '/outside');
      assert.equal(nav.dir, '/p', 'a remembered dir outside the root falls back to the root');
      nav.show('/elsewhere', []);
      assert.equal(nav.dir, '/p', 'nor can show() move it out');
      return ok('root wall', true);
    }),

    test('j k gg G and half pages move the cursor and clamp', () => {
      const nav = navAt();
      assert.equal(nav.key('k').k, 'none', 'k at the top does nothing');
      assert.equal(nav.key('j').k, 'moved'); assert.equal(nav.cursor, 1);
      assert.equal(nav.key('arrowdown').k, 'moved'); assert.equal(nav.cursor, 2);
      assert.equal(nav.key('shift+g').k, 'moved'); assert.equal(nav.cursor, ROOT_ENTRIES.length - 1);
      assert.equal(nav.key('j').k, 'none', 'j at the bottom does nothing');
      assert.equal(nav.key('g').k, 'none', 'the first g waits');
      assert.equal(nav.key('g').k, 'moved', 'the second g jumps'); assert.equal(nav.cursor, 0);
      nav.key('g'); nav.key('j');
      assert.equal(nav.cursor, 1, 'g then something else forgets the g');
      nav.key('g'); nav.key('g');
      assert.equal(nav.cursor, 0);
      const many = new FileNav('/p'); many.show('/p', Array.from({ length: 30 }, (_, i) => f(`f${i}`)));
      assert.equal(many.key('ctrl+d').k, 'moved'); assert.equal(many.cursor, HALF_PAGE);
      many.key('ctrl+d'); many.key('ctrl+d');
      assert.equal(many.cursor, 29, 'clamped at the end');
      assert.equal(many.key('ctrl+u').k, 'moved'); assert.equal(many.cursor, 29 - HALF_PAGE);
      return ok('movement', true);
    }),

    test('l enters a folder, opens a file, refuses what is not served; h asks for the parent', () => {
      const nav = navAt();
      assert.deepEqual(nav.key('l'), { k: 'enter', path: '/p/src' });
      assert.deepEqual(nav.key('h'), { k: 'blocked', why: 'root' }, 'h at the root is blocked, not a request');
      nav.show('/p/src', [d('ui'), f('a.ts')], { select: 'a.ts' });
      assert.equal(nav.cursor, 1, 'show() can put the cursor on a name');
      assert.deepEqual(nav.key('enter'), { k: 'open', path: '/p/src/a.ts' });
      assert.deepEqual(nav.key('h'), { k: 'up', path: '/p', from: 'src' });
      nav.show('/p', ROOT_ENTRIES, { select: 'src' });
      assert.equal(nav.current()?.name, 'src', 'back on the folder we came from');
      nav.key('shift+g');
      assert.deepEqual(nav.key('l'), { k: 'blocked', why: 'other' }, 'a row the hub would not serve does not open');
      const empty = new FileNav('/p'); empty.show('/p', []);
      assert.deepEqual(empty.key('l'), { k: 'blocked', why: 'empty' });
      assert.deepEqual(empty.key('/'), { k: 'find' });
      assert.deepEqual(empty.key('q'), { k: 'close' });
      assert.deepEqual(empty.key('x'), { k: 'none' });
      assert.ok(FileNav.handles('j') && FileNav.handles('shift+g') && !FileNav.handles('x') && !FileNav.handles('escape'), 'escape stays the window manager\'s');
      return ok('enter, open, up', true);
    }),

    test('the filter narrows the rows, resets the cursor and is forgotten on a folder change', () => {
      const nav = navAt();
      nav.key('shift+g');
      nav.setFilter('READ');
      assert.deepEqual(nav.visible().map((e) => e.name), ['README.md'], 'case-insensitive substring');
      assert.equal(nav.cursor, 0);
      assert.deepEqual(nav.key('l'), { k: 'open', path: '/p/README.md' });
      nav.setFilter('s');
      assert.deepEqual(nav.visible().map((e) => e.name), ['src', 'test', 'package.json'], 'dirs stay first');
      nav.setFilter('zzz');
      assert.equal(nav.current(), null);
      assert.deepEqual(nav.key('l'), { k: 'blocked', why: 'empty' });
      nav.setFilter('src');
      nav.show('/p/src', [f('a.ts')]);
      assert.equal(nav.filter, '', 'a new folder starts unfiltered');
      return ok('filter', true);
    }),

    /* ── /api/dir ────────────────────────────────────────────────── */

    test('/api/dir lists a project folder: dirs first, private names hidden, symlinks out marked', async () => {
      fixture();
      const r = resolveServedDir(ROOT, [ROOT]);
      assert.ok(r.ok, `lists the root: ${JSON.stringify(r)}`);
      const names = r.entries.map((e) => `${e.name}:${e.kind}`);
      assert.deepEqual(names, ['src:dir', 'srclink:dir', 'leakdir:other', 'pipe:other', 'README.md:file', 'zeta.txt:file'], 'dirs first, then by name without case');
      assert.ok(!names.some((n) => n.startsWith('.env') || n.startsWith('.git')), 'what /api/file would refuse is not listed');
      assert.equal(r.entries.find((e) => e.name === 'README.md')?.size, 5);
      assert.equal(r.truncated, false);
      const cut = resolveServedDir(ROOT, [ROOT], { max: 2 });
      assert.ok(cut.ok && cut.truncated && cut.entries.length === 2, 'a cap says it cut');
      const sub = resolveServedDir(join(ROOT, 'src'), [ROOT]);
      assert.ok(sub.ok && sub.entries.map((e) => e.name).join(',') === 'ui,a.ts');
      const viaLink = resolveServedDir(join(ROOT, 'srclink'), [ROOT]);
      assert.ok(viaLink.ok && viaLink.path === join(ROOT, 'src'), 'a symlink inside resolves to where it points');
      return ok('listing', true);
    }),

    test('/api/dir stays inside the roots: .., outside, symlink out, a file, no token', async () => {
      const direct = (p: string) => resolveServedDir(p, [ROOT]);
      assert.equal(direct(join(ROOT, '..')).ok, false);
      assert.equal((direct(join(ROOT, '..')) as { status: number }).status, 403);
      assert.equal((direct(OUTSIDE) as { status: number }).status, 403);
      assert.equal((direct(join(ROOT, 'leakdir')) as { status: number }).status, 403, 'a symlink out of the root is refused, not followed');
      assert.equal((direct(join(ROOT, 'README.md')) as { status: number }).status, 404, 'a file is not a folder');
      assert.equal((direct(join(ROOT, 'nope')) as { status: number }).status, 404);
      assert.equal((direct(join(ROOT, '.git')) as { status: number }).status, 403, 'a private folder inside is still private');
      assert.equal((direct('relative') as { status: number }).status, 400);
      assert.equal((direct('/') as { status: number }).status, 403);
      return withHub(async (base) => {
        const good = await fetch(url(base, ROOT));
        assert.equal(good.status, 200);
        const body = await good.json() as Reply;
        assert.equal(body.path, ROOT);
        assert.ok(body.entries.some((e) => e.name === 'src' && e.kind === 'dir'));
        assert.equal((await fetch(url(base, ROOT, null))).status, 401, 'no token, no listing');
        assert.equal((await fetch(url(base, OUTSIDE))).status, 403);
        assert.equal((await fetch(url(base, `${ROOT}/../outside`))).status, 403);
        assert.equal((await fetch(url(base, `${ROOT}/leakdir`))).status, 403);
        assert.equal((await fetch(url(base, `${ROOT}/README.md`))).status, 404);
        const secret = await fetch(`${base}/api/file?path=${encodeURIComponent(join(ROOT, 'leakdir', 'secret.txt'))}&token=${TOKEN}`);
        assert.equal(secret.status, 403, 'and the file behind the link is still not served');
        return ok('containment', true);
      });
    }),

    /* ── la ventana, en Chromium ─────────────────────────────────── */

    test('the window: vim keys against the real DOM, and the project menu offers it', async () => {
      const server = await createServer({ configFile: false, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
      await server.listen();
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
        const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
        await page.route('**/files-fixture', (route) => route.fulfill({ contentType: 'text/html', body:
          '<!doctype html><link rel="stylesheet" href="/src/ui/styles/tokens.css"><link rel="stylesheet" href="/src/ui/styles/window.css"><link rel="stylesheet" href="/src/ui/styles/hud.css"><body style="margin:0;background:var(--bezel)"></body>' }));
        await page.goto(`${server.resolvedUrls!.local[0]}files-fixture`);
        await page.evaluate(async () => { (window as any).fixture = await import('/test/file-browser.fixture.ts' as string); });
        const run = <T,>(fn: (f: F) => T | Promise<T>): Promise<T> => page.evaluate(`(${fn.toString()})(window.fixture)`) as Promise<T>;
        const st = () => run((f) => f.state());

        await run((f) => { f.open(); });
        await page.waitForSelector('.fb__row', { timeout: 10_000 });
        let s = await st();
        assert.deepEqual(s.rows, ['src/', 'test/', 'README.md', 'package.json', 'leak'], 'the root, dirs first, from the hub');
        assert.equal(s.cur, 'src/');
        assert.equal(s.title, 'proj');

        // j j G gg
        await page.keyboard.press('j'); await page.keyboard.press('j');
        assert.equal((await st()).cur, 'README.md', 'j moves the cursor');
        await page.keyboard.press('Shift+G');
        assert.equal((await st()).cur, 'leak', 'G is the end');
        await page.keyboard.press('g'); await page.keyboard.press('g');
        assert.equal((await st()).cur, 'src/', 'gg is the start');
        await page.keyboard.press('k');
        assert.equal((await st()).cur, 'src/', 'k at the top stays');

        // l into src, l into ui, h back with the cursor on where we came from
        await page.keyboard.press('l');
        await page.waitForFunction(() => document.querySelector('[data-path]')?.textContent?.includes('/src'), null, { timeout: 5000 });
        s = await st();
        assert.equal(s.dir, '/proj/src'); assert.deepEqual(s.rows, ['ui/', 'a.ts', 'b.ts']); assert.equal(s.title, 'src');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('[data-path]')?.textContent?.includes('/src/ui'), null, { timeout: 5000 });
        assert.equal((await st()).dir, '/proj/src/ui');
        await page.keyboard.press('h');
        await page.waitForFunction(() => document.querySelector('[data-path]')?.textContent === 'proj/src', null, { timeout: 5000 });
        s = await st();
        assert.equal(s.dir, '/proj/src'); assert.equal(s.cur, 'ui/', 'back on the folder we came out of');
        await page.keyboard.press('ArrowLeft');
        await page.waitForFunction(() => document.querySelector('[data-path]')?.textContent === 'proj', null, { timeout: 5000 });
        s = await st();
        assert.equal(s.dir, '/proj'); assert.equal(s.cur, 'src/');
        await page.keyboard.press('h');
        await sleep(100);
        s = await st();
        assert.equal(s.dir, '/proj', 'h at the root goes nowhere');
        assert.ok(s.notes.some((n) => /ROOT/.test(n)), 'and says so');
        assert.ok(s.asked.every((p) => p === '/proj' || p.startsWith('/proj/')), `nothing outside the root was ever asked for: ${s.asked.join(' ')}`);

        // / filters, ↵ keeps it, l opens the file in the viewer with the project code
        await page.keyboard.press('/');
        await sleep(50);
        assert.equal((await st()).finding, true, '/ gives the keyboard to the filter');
        await page.keyboard.type('pack');
        s = await st();
        assert.deepEqual(s.rows, ['package.json']); assert.equal(s.cur, 'package.json');
        await page.keyboard.press('Enter');
        s = await st();
        assert.equal(s.finding, false, '↵ leaves the filter'); assert.equal(s.filter, 'pack', 'and keeps it');
        await page.keyboard.press('l');
        s = await st();
        assert.deepEqual(s.opened, [{ path: '/proj/package.json', project: 'PJ' }], 'l on a file opens the viewer');
        await page.keyboard.press('/');
        await page.keyboard.press('Escape');
        s = await st();
        assert.equal(s.filter, '', 'esc in the filter clears it'); assert.equal(s.windows, 1, 'and does not close the window');
        assert.equal(s.rows.length, 5);

        // a row the hub will not serve
        await page.keyboard.press('Shift+G'); await page.keyboard.press('l');
        s = await st();
        assert.equal(s.opened.length, 1, 'a NOT SERVED row does not open');
        assert.ok(s.notes.some((n) => /NOT SERVED/.test(n)));

        // mouse: click selects, double click enters
        await page.dblclick('.fb__row:nth-child(2)');
        await page.waitForFunction(() => document.querySelector('[data-path]')?.textContent === 'proj/test', null, { timeout: 5000 });
        s = await st();
        assert.equal(s.dir, '/proj/test'); assert.deepEqual(s.rows, []);
        assert.ok(await page.$eval('.fb__msg', (n) => /EMPTY/.test(n.textContent ?? '')), 'an empty folder says so');
        await page.keyboard.press('h');
        await page.waitForFunction(() => document.querySelector('[data-path]')?.textContent === 'proj', null, { timeout: 5000 });

        // q closes
        await page.keyboard.press('q');
        await sleep(600);
        assert.equal((await st()).windows, 0, 'q closes the window');

        // the project menu offers it, and picking it asks the console for the project
        const labels = await run((f) => f.projectMenu());
        assert.ok(labels.includes('BROWSE FILES'), `the project menu has BROWSE FILES: ${labels.join(', ')}`);
        const picked = await run((f) => f.pickMenu('BROWSE FILES'));
        assert.deepEqual(picked, ['p1']);

        assert.deepEqual(errors, [], 'no page errors');
        return eq('dom', true, true);
      } finally {
        await browser.close();
        await server.close();
      }
    }),
  ],
} satisfies TestModule;
