/**
 * `/api/file`: archivos de proyecto servidos a la consola.
 *
 * Un endpoint que lee del disco a petición de un cliente es donde viven los
 * path traversal, así que la mitad de esto son intentos de salirse de la raíz:
 * `..`, codificado, symlinks que apuntan fuera, la home del usuario, la raíz
 * del disco declarada como proyecto. El resto comprueba que lo que sí está
 * dentro sale con el tipo correcto y con html sin poder ejecutar.
 */

import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { PATHS, PROTOCOL_VERSION, type ServerFrame } from '../src/shared/protocol.ts';
import { createAuth } from '../src/hub/auth.ts';
import { findPaths, fileKind } from '../src/ui/windows/paths.ts';
import { startHub } from '../src/hub/server.ts';
import { acceptableRoot, envRoots, scratchpadRoots, fileMime, parseRange, resolveServedPath, REFUSAL } from '../src/hub/files.ts';
import { ok, eq, test, freePort, type TestModule } from './harness.ts';

const BASE = realpathSync(tmpdir());
const FIXTURE = mkdtempSync(join(BASE, 'orca-files-test-'));
const ROOT = join(FIXTURE, 'project');
const OUTSIDE = join(FIXTURE, 'outside');
const ALIAS = join(FIXTURE, 'alias');
/** El árbol aislado de un agente, donde el CLI lo pone: `<proyecto>/.claude/worktrees/<nombre>`. */
const WORKTREE = join(ROOT, '.claude', 'worktrees', 'k9');
/** Una home de mentira con la misma forma dentro, para el caso que NO se abre. */
const HOMEFAKE = join(FIXTURE, 'home');
const TEST_TOKEN = 'orca-files-fixture-token';
let ready = false;
const CANARY = 'ESTO-NO-DEBE-SALIR-POR-/api/file';

function fixture(): void {
  if (ready) return;
  ready = true;
  mkdirSync(join(ROOT, 'src'), { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(ROOT, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(ROOT, 'page.html'), '<script>fetch("/api/world")</script>');
  writeFileSync(join(ROOT, 'shot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  writeFileSync(join(ROOT, 'clip.mp4'), Buffer.alloc(1000, 7));
  writeFileSync(join(ROOT, 'big.bin'), Buffer.alloc(64));
  writeFileSync(join(OUTSIDE, 'outside.txt'), CANARY);
  symlinkSync(join(OUTSIDE, 'outside.txt'), join(ROOT, 'leak.txt'));
  symlinkSync(OUTSIDE, join(ROOT, 'leakdir'));
  symlinkSync(ROOT, ALIAS);
  symlinkSync(BASE, join(FIXTURE, 'broad-alias'));
  writeFileSync(join(ROOT, '.env'), 'NON-SENSITIVE-FIXTURE');
  symlinkSync(join(ROOT, '.env'), join(ROOT, 'innocent.txt'));
  writeFileSync(join(ROOT, 'voice.wav'), Buffer.alloc(100, 1));
  execFileSync('mkfifo', [join(ROOT, 'pipe')]);
  // Un worktree con las dos clases de contenido dentro. Los prohibidos existen
  // en disco a propósito: si el veto se rompiera darían 200 y no 404, que es la
  // diferencia entre una prueba que detecta el agujero y una que lo tapa.
  mkdirSync(join(WORKTREE, 'src'), { recursive: true });
  mkdirSync(join(WORKTREE, '.claude'), { recursive: true });
  writeFileSync(join(WORKTREE, 'src', 'dentro.ts'), 'export const donde = "el worktree";\n');
  writeFileSync(join(WORKTREE, '.claude', 'settings.json'), '{ "anidado": true }\n');
  writeFileSync(join(WORKTREE, '.env'), 'NON-SENSITIVE-FIXTURE');
  writeFileSync(join(WORKTREE, 'deploy.key'), 'NON-SENSITIVE-FIXTURE');
  writeFileSync(join(ROOT, '.claude', 'settings.json'), '{ "del proyecto": true }\n');
  mkdirSync(join(HOMEFAKE, '.claude', 'worktrees', 'k9', 'src'), { recursive: true });
  writeFileSync(join(HOMEFAKE, '.claude', 'worktrees', 'k9', 'src', 'dentro.ts'), 'export const donde = "la home";\n');
}

async function withHub<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const port = await freePort();
  const hub = await startHub({ port, host: '127.0.0.1', quiet: true, fileRoots: [ALIAS], auth: createAuth({ ORCA_TOKEN: TEST_TOKEN, ORCA_STRICT_AUTH: '1' }) });
  try { return await fn(`http://127.0.0.1:${port}`); } finally { await hub.close(); }
}

const url = (base: string, path: string) => `${base}/api/file?path=${encodeURIComponent(path)}&token=${TEST_TOKEN}`;

const tests = [
  /* ── resolveServedPath, en seco ────────────────────────────────── */
  test('un archivo bajo la raíz se resuelve', () => {
    fixture();
    const r = resolveServedPath(join(ROOT, 'src', 'a.ts'), [ROOT]);
    return ok('ok', r.ok && r.path === join(ROOT, 'src', 'a.ts') && r.mime.startsWith('text/plain'), JSON.stringify(r));
  }),

  test('.. que se sale de la raíz es 403', () => {
    const r = resolveServedPath(join(ROOT, 'src', '..', '..', 'outside', 'outside.txt'), [ROOT]);
    return eq('403', r.ok ? 'ok' : r.status, 403);
  }),

  test('un symlink a un archivo de fuera es 403', () => {
    const r = resolveServedPath(join(ROOT, 'leak.txt'), [ROOT]);
    return eq('403', r.ok ? 'ok' : r.status, 403);
  }),

  test('un symlink a un directorio de fuera es 403', () => {
    const r = resolveServedPath(join(ROOT, 'leakdir', 'outside.txt'), [ROOT]);
    return eq('403', r.ok ? 'ok' : r.status, 403);
  }),

  test('dentro pero inexistente es 404, no 403', () => {
    const r = resolveServedPath(join(ROOT, 'nope.ts'), [ROOT]);
    return eq('404', r.ok ? 'ok' : r.status, 404);
  }),

  test('un directorio no se sirve', () => {
    const r = resolveServedPath(join(ROOT, 'src'), [ROOT]);
    return eq('404', r.ok ? 'ok' : r.status, 404);
  }),

  test('una ruta relativa es 400', () => {
    const r = resolveServedPath('src/a.ts', [ROOT]);
    return eq('400', r.ok ? 'ok' : r.status, 400);
  }),

  test('vacío o con NUL es 400', () =>
    eq('400s', [resolveServedPath('', [ROOT]), resolveServedPath(`${ROOT}/a\0.ts`, [ROOT])].map((r) => r.ok ? 'ok' : r.status), [400, 400])),

  test('por encima del techo es 413', () => {
    const r = resolveServedPath(join(ROOT, 'big.bin'), [ROOT], { maxBytes: 16 });
    return eq('413', r.ok ? 'ok' : r.status, 413);
  }),

  test('~/ se expande a la home dada y sigue contenido', () => {
    const r = resolveServedPath('~/project/src/a.ts', [ROOT], { home: FIXTURE });
    const out = resolveServedPath('~/secret.txt', [ROOT], { home: OUTSIDE });
    return ok('home', r.ok && r.path.endsWith('/src/a.ts') && !out.ok && out.status === 403, JSON.stringify([r, out]));
  }),

  test('sin raíces nada se sirve', () =>
    eq('403', (() => { const r = resolveServedPath(join(ROOT, 'src', 'a.ts'), []); return r.ok ? 'ok' : r.status; })(), 403)),

  test('la raíz del disco, /Users y la home no valen como raíz', () =>
    eq('roots', ['/', '/Users', homedir(), 'relative/x', ROOT].map((r) => acceptableRoot(r)), [false, false, false, false, true])),

  test('una raíz de otra máquina no contiene nada de esta', () => {
    const r = resolveServedPath('/Users/otra/persona/x.ts', ['/Users/otra/persona']);
    return eq('404', r.ok ? 'ok' : r.status, 404);
  }),

  test('el tipo por extensión, y texto para lo que parece código', () =>
    eq('mime', ['a.png', 'b.PDF', 'c.mp3', 'd.md', 'e.ts', 'Makefile', '.gitignore', 'f.bin'].map(fileMime),
      ['image/png', 'application/pdf', 'audio/mpeg', 'text/markdown; charset=utf-8', 'text/plain; charset=utf-8',
        'text/plain; charset=utf-8', 'text/plain; charset=utf-8', 'application/octet-stream'])),

  test('rangos: a-b, a-, -n, y los que no caben', () =>
    eq('ranges', [parseRange('bytes=0-9', 100), parseRange('bytes=90-', 100), parseRange('bytes=-10', 100), parseRange('bytes=200-', 100), parseRange('items=1-2', 100)],
      [{ start: 0, end: 9 }, { start: 90, end: 99 }, { start: 90, end: 99 }, null, null])),

  test('aliases de raíz: forma declarada y canónica', () =>
    ok('aliases', [ROOT, ALIAS].every((r) => resolveServedPath(join(r, 'src/a.ts'), [ALIAS]).ok))),

  test('alias macOS inverso de una raíz canónica funciona por realpath', () => {
    const alias = ROOT.replace(/^\/private\/(tmp|var)(?=\/)/, '/$1');
    return ok('canonical grant', realpathSync(alias) === ROOT
      && resolveServedPath(join(alias, 'shot.png'), [ROOT]).ok);
  }),

  test('scratchpad TMPDIR propio se admite sin ampliar el padre', () => {
    const parent = join(FIXTURE, 'work-temp');
    const scratch = join(parent, `claude-${process.getuid?.()}`);
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'note.txt'), 'fixture');
    writeFileSync(join(parent, 'loose.txt'), 'fixture');
    const roots = scratchpadRoots({ TMPDIR: parent });
    return ok('narrow', roots.includes(scratch) && resolveServedPath(join(scratch, 'note.txt'), roots).ok
      && !resolveServedPath(join(parent, 'loose.txt'), roots).ok);
  }),

  test('aliases reales macOS son linkificables sin cambiar el visor', () => {
    const paths = ['/tmp/claude-501/a.png', '/private/tmp/claude-501/a.html',
      '/var/folders/z0/example/T/claude-501/a.mp4', '/private/var/folders/z0/example/T/claude-501/a.wav'];
    return eq('paths', paths.map((p) => [findPaths(p)[0]?.path, fileKind(p)]),
      paths.map((p, i) => [p, ['image', 'html', 'video', 'audio'][i]]));
  }),

  test('contenedores temporales y alias de contenedor no autorizan', () => {
    const roots = ['/private', '/private/tmp', '/tmp', '/private/temp', '/private/var',
      '/var/tmp', '/private/var/tmp', tmpdir(), BASE, '/var/folders/z0/example/T'];
    const broad = resolveServedPath(join(FIXTURE, 'broad-alias', 'anything.txt'), [join(FIXTURE, 'broad-alias')]);
    return ok('blocked', roots.every((r) => !acceptableRoot(r)) && !broad.ok && broad.status === 403);
  }),

  test('archivo explícito autoriza sólo ese archivo y sus aliases', () => {
    const file = join(ALIAS, 'shot.png');
    const roots = envRoots({ ORCA_FILE_ROOTS: file });
    return eq('scoped', [resolveServedPath(join(ROOT, 'shot.png'), roots).ok,
      resolveServedPath(join(ROOT, 'page.html'), roots).ok], [true, false]);
  }),

  test('configuración privada y symlink con nombre inocuo se excluyen', () => {
    const names = ['.env', '.env.local', '.ssh/id_ed25519', '.aws/credentials', '.claude/settings.json',
      '.codex/auth.json', '.config/app/config.json', '.orca/token', 'innocent.txt', 'client.key'];
    return ok('403', names.every((p) => {
      const r = resolveServedPath(join(ROOT, p), [ROOT]); return !r.ok && r.status === 403;
    }));
  }),

  /*
   * El permiso de `.claude/worktrees` es POSICIONAL, y esto es lo que lo
   * distingue de una comprobación de subcadena.
   *
   * Una subcadena (`path.includes('.claude/worktrees')`) dejaría pasar la
   * segunda fila —la configuración de un agente anidado dentro del worktree—
   * y la sexta convertiría en servible la home del hub, donde viven los
   * transcripts de todas las sesiones. Ninguna de las dos se reconstruye
   * leyendo el código: el shot del navegador las cubre, pero cuesta veinte
   * segundos y levanta un hub, así que el día que alguien toque `privatePath`
   * sin leer el comentario, esto es lo que se pone rojo.
   *
   * Las dos últimas filas son el mismo fichero: sólo cambia quién es la home.
   * Ahí está toda la regla — la excepción mira dónde cuelga ese `.claude`, no
   * sólo cómo se llama.
   */
  test('el worktree se sirve, y lo privado de dentro —y el de la home— no', () => {
    fixture();
    const enHome = join(HOMEFAKE, '.claude', 'worktrees', 'k9', 'src', 'dentro.ts');
    // El motivo y no sólo el código: un 403 «fuera de las raíces» aquí sería
    // un fallo del fixture disfrazado de prueba verde.
    const estado = (path: string, roots: string[], home?: string) => {
      const r = resolveServedPath(path, roots, home ? { home } : {});
      return r.ok ? 'ok' : r.reason === REFUSAL.private ? 'política' : `${r.status} ${r.reason}`;
    };
    return eq('posicional', [
      estado(join(WORKTREE, 'src', 'dentro.ts'), [ROOT]),
      estado(join(WORKTREE, '.claude', 'settings.json'), [ROOT]),
      estado(join(WORKTREE, '.env'), [ROOT]),
      estado(join(WORKTREE, 'deploy.key'), [ROOT]),
      estado(join(ROOT, '.claude', 'settings.json'), [ROOT]),
      estado(enHome, [FIXTURE], HOMEFAKE),
      estado(enHome, [FIXTURE], OUTSIDE),
    ], ['ok', 'política', 'política', 'política', 'política', 'política', 'ok']);
  }),

  /*
   * La otra puerta: `files:allow` decide con `acceptableRoot`, que decide con
   * lo mismo. Que un worktree pueda fijarse como raíz es la consecuencia
   * buscada; que el de la home no, es lo que impide que autorizar una carpeta
   * abra `~/.claude`.
   */
  test('un worktree puede ser raíz autorizada; el de la home, no', () =>
    eq('allow', [acceptableRoot(WORKTREE), acceptableRoot(join(HOMEFAKE, '.claude', 'worktrees', 'k9'), HOMEFAKE), acceptableRoot(join(ROOT, '.claude'))],
      [true, false, false])),

  test('FIFO y raíces de otro usuario se rechazan sin leer', () => {
    const pipe = resolveServedPath(join(ROOT, 'pipe'), [ROOT]);
    const other = resolveServedPath(join(ROOT, 'claude-999999', 'a.txt'), [ROOT]);
    const system = resolveServedPath('/usr/bin/true', ['/usr/bin']);
    return ok('refused', !pipe.ok && pipe.status === 404 && !other.ok && other.status === 403
      && (process.getuid?.() === 0 || (!system.ok && system.status === 403)));
  }),

  test('scratchpad sólo adopta directorios propios y nunca symlinks', () => {
    const parent = join(FIXTURE, 'temp-parent');
    mkdirSync(parent);
    symlinkSync(ROOT, join(parent, `claude-${process.getuid?.()}`));
    return ok('no alias adoption', !scratchpadRoots({ TMPDIR: parent }).some((r) => r.startsWith(parent)));
  }),

  /* ── el endpoint de verdad ─────────────────────────────────────── */
  test('GET /api/file sirve un archivo del proyecto con su tipo', () => withHub(async (base) => {
    fixture();
    const r = await fetch(url(base, join(ROOT, 'src', 'a.ts')));
    const body = await r.text();
    return ok('200', r.status === 200 && body.includes('export const a') && (r.headers.get('content-type') ?? '').startsWith('text/plain')
      && r.headers.get('x-content-type-options') === 'nosniff', `http ${r.status} ${r.headers.get('content-type')}`);
  })),

  test('el html sale con CSP sandbox', () => withHub(async (base) => {
    const r = await fetch(url(base, join(ROOT, 'page.html')));
    return ok('sandbox', r.status === 200 && r.headers.get('content-security-policy') === 'sandbox'
      && (r.headers.get('content-type') ?? '').startsWith('text/html'), `${r.status} csp=${r.headers.get('content-security-policy')}`);
  })),

  test('una imagen no lleva CSP y sí su tipo', () => withHub(async (base) => {
    const r = await fetch(url(base, join(ROOT, 'shot.png')));
    return ok('png', r.status === 200 && r.headers.get('content-type') === 'image/png' && r.headers.get('content-security-policy') === null, `${r.status}`);
  })),

  test('Range devuelve 206 con content-range', () => withHub(async (base) => {
    const r = await fetch(url(base, join(ROOT, 'clip.mp4')), { headers: { range: 'bytes=0-99' } });
    const buf = new Uint8Array(await r.arrayBuffer());
    return ok('206', r.status === 206 && buf.length === 100 && r.headers.get('content-range') === 'bytes 0-99/1000', `${r.status} ${r.headers.get('content-range')} ${buf.length}`);
  })),

  test('fuera de la raíz es 403 y el canario no sale', () => withHub(async (base) => {
    const attempts = [
      join(OUTSIDE, 'outside.txt'),
      `${ROOT}/../outside/outside.txt`,
      `${ROOT}/leak.txt`,
      `${ROOT}/leakdir/outside.txt`,
      `${ROOT}/src/%2e%2e/%2e%2e/outside/outside.txt`,
      '/etc/passwd',
      '~/.orca/token',
    ];
    const results: string[] = [];
    for (const p of attempts) {
      const r = await fetch(url(base, p));
      const body = await r.text();
      results.push(`${r.status}${body.includes(CANARY) ? ' LEAK' : ''}`);
    }
    return ok('all refused', results.every((s) => /^(403|404)$/.test(s)), results.join(', '));
  })),

  test('lo que no existe es 404', () => withHub(async (base) => {
    const r = await fetch(url(base, join(ROOT, 'nope.ts')));
    return eq('404', r.status, 404);
  })),

  test('sin path es 400', () => withHub(async (base) => {
    const r = await fetch(`${base}/api/file?token=${TEST_TOKEN}`);
    return eq('400', r.status, 400);
  })),

  test('sin token el endpoint exige autenticación', () => withHub(async (base) => {
    const r = await fetch(`${base}/api/file?path=${encodeURIComponent(join(ROOT, 'shot.png'))}`);
    return eq('401', r.status, 401);
  })),

  test('audio, HEAD y rechazos privados/especiales pasan por el endpoint', () => withHub(async (base) => {
    const audio = await fetch(url(base, join(ROOT, 'voice.wav')), { headers: { range: 'bytes=0-9' } });
    const head = await fetch(url(base, join(ALIAS, 'shot.png')), { method: 'HEAD' });
    const statuses = [];
    for (const name of ['.env', 'innocent.txt', 'pipe']) {
      const r = await fetch(url(base, join(ROOT, name))); statuses.push(r.status);
    }
    return ok('http', audio.status === 206 && audio.headers.get('content-type') === 'audio/wav'
      && (await audio.arrayBuffer()).byteLength === 10 && head.status === 200 && (await head.text()) === ''
      && JSON.stringify(statuses) === '[403,403,404]');
  })),

  test('con token equivocado es 401', () => withHub(async (base) => {
    const r = await fetch(url(base, join(ROOT, 'src', 'a.ts')).replace(TEST_TOKEN, 'nope'));
    return eq('401', r.status, 401);
  })),

  /* ── files:allow: una carpeta que el operador autoriza desde el visor ── */
  test('files:allow abre la carpeta pedida, la home no, y un hub nuevo la recuerda', async () => {
    fixture();
    const rootsFile = join(FIXTURE, 'file-roots.json');
    const target = join(OUTSIDE, 'outside.txt');
    /** Una consola mínima: hello, un comando, su ack. */
    const allow = async (port: number, path: string): Promise<{ ok: boolean; detail?: string; data?: unknown }> => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${PATHS.console}?token=${TEST_TOKEN}`);
      await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token: TEST_TOKEN }));
      const id = `cmd-${Math.random().toString(36).slice(2)}`;
      ws.send(JSON.stringify({ t: 'cmd', id, cmd: { k: 'files:allow', path } }));
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('sin ack')), 5000);
          ws.on('message', (d) => {
            const f = JSON.parse(d.toString()) as ServerFrame;
            if (f.t === 'ack' && f.cmdId === id) { clearTimeout(timer); resolve(f); }
          });
        });
      } finally { ws.close(); }
    };
    const start = async () => {
      const port = await freePort();
      const hub = await startHub({ port, host: '127.0.0.1', quiet: true, fileRootsFile: rootsFile, auth: createAuth({ ORCA_TOKEN: TEST_TOKEN, ORCA_STRICT_AUTH: '1' }) });
      return { port, base: `http://127.0.0.1:${port}`, hub };
    };
    const first = await start();
    try {
      const before = (await fetch(url(first.base, target))).status;
      const home = await allow(first.port, homedir());
      const done = await allow(first.port, target);
      const after = await fetch(url(first.base, target));
      const body = await after.text();
      if (before !== 403) return eq('antes: 403', before, 403);
      if (home.ok) return ok('la home no se autoriza', false, JSON.stringify(home));
      if (!done.ok || (done.data as { root?: string }).root !== OUTSIDE) return ok('ack con la raíz', false, JSON.stringify(done));
      if (after.status !== 200 || body !== CANARY) return ok('después: 200 con el contenido', false, `${after.status} ${body.slice(0, 40)}`);
    } finally { await first.hub.close(); }
    const second = await start();
    try {
      const r = await fetch(url(second.base, target));
      const still = (await fetch(url(second.base, join(OUTSIDE, '..', 'project', '..', '..', 'nope.txt')))).status;
      return ok('un hub nuevo con el mismo json sirve la carpeta y nada más', r.status === 200 && still !== 200, `reopen=${r.status} traversal=${still}`);
    } finally { await second.hub.close(); }
  }),
];

export default { suite: 'files', tests } satisfies TestModule;
