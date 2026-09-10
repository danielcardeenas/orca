/**
 * hub/file-roots.ts — las carpetas que el operador autorizó al visor.
 *
 * Lo que vale la pena guardar: autorizar un archivo autoriza su carpeta y
 * autorizar una carpeta la deja tal cual; lo que files.ts no serviría nunca
 * (la home, `~/.ssh`, `~/.orca`, un temporal, una ruta relativa, algo que no
 * existe) tampoco se puede autorizar; una carpeta ya cubierta no se repite y
 * una que contiene a otras las absorbe; la lista sobrevive a un hub nuevo
 * leyendo el mismo json, y un json roto o ajeno no rompe el arranque.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRoots, MAX_FILE_ROOTS } from '../src/hub/file-roots.ts';
import { ORCA_DIR } from '../src/hub/auth.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

/*
 * Una «home» de pruebas dentro del temporal del sistema. acceptableRoot
 * rechaza contenedores temporales sólo cuando son LA raíz, no cuando algo
 * cuelga de ellos, así que `home/Desktop/logos` es una raíz que vale.
 */
const BASE = realpathSync(tmpdir());
const HOME = mkdtempSync(join(BASE, 'orca-file-roots-home-'));
const DESKTOP = join(HOME, 'Desktop');
const LOGOS = join(DESKTOP, 'logos');
const FILE = join(HOME, 'hub', 'file-roots.json');
mkdirSync(LOGOS, { recursive: true });
mkdirSync(join(HOME, '.ssh'), { recursive: true });
writeFileSync(join(LOGOS, 'grid3.png'), 'png');
writeFileSync(join(HOME, '.ssh', 'id_ed25519'), 'nope');
writeFileSync(join(HOME, 'notes.md'), 'x');

export default {
  suite: 'file-roots',
  tests: [
    test('a file allows its folder; a folder allows itself; the list persists', async () => {
      const roots = new FileRoots(FILE, HOME);
      const byFile = await roots.allow(join(LOGOS, 'grid3.png'));
      if (!byFile.ok || byFile.root !== LOGOS || !byFile.added) return ok('by file', false, JSON.stringify(byFile));
      const again = await roots.allow(join(LOGOS, 'grid3.png'));
      if (!again.ok || again.added) return ok('already covered', false, JSON.stringify(again));
      const tilde = await roots.allow('~/Desktop/logos');
      if (!tilde.ok || tilde.root !== LOGOS || tilde.added) return ok('tilde resolves against the hub home', false, JSON.stringify(tilde));
      const parent = await roots.allow(DESKTOP);
      if (!parent.ok || parent.root !== DESKTOP || !parent.added) return ok('folder as is', false, JSON.stringify(parent));
      if (roots.list().join() !== DESKTOP) return eq('the parent absorbs the child', roots.list().join(), DESKTOP);
      const saved = JSON.parse(readFileSync(FILE, 'utf8')) as { roots: string[] };
      if (saved.roots.join() !== DESKTOP) return eq('persisted', saved.roots.join(), DESKTOP);
      const reloaded = new FileRoots(FILE, HOME);
      return eq('a new hub reads the same list', reloaded.list().join(), DESKTOP);
    }),
    test('what files.ts would never serve cannot be allowed either', async () => {
      const roots = new FileRoots(null, HOME);
      const refused: Record<string, string> = {
        home: HOME,
        ssh: join(HOME, '.ssh', 'id_ed25519'),
        relative: 'Desktop/logos',
        missing: join(HOME, 'nowhere', 'x.png'),
        tmp: '/tmp',
        orca: ORCA_DIR,
        empty: '   ',
      };
      for (const [name, path] of Object.entries(refused)) {
        const r = await roots.allow(path);
        if (r.ok) return ok(`refused: ${name}`, false, `${path} → ${r.root}`);
      }
      // Un archivo suelto en la home autoriza la home entera: no.
      const loose = await roots.allow(join(HOME, 'notes.md'));
      return ok('a loose file in the home does not open the home', !loose.ok && roots.list().length === 0, JSON.stringify(loose));
    }),
    test('a broken or foreign json starts empty, and the list has a ceiling', async () => {
      const broken = join(HOME, 'hub', 'broken.json');
      writeFileSync(broken, '{ roots: [nope');
      const a = new FileRoots(broken, HOME);
      const foreign = join(HOME, 'hub', 'foreign.json');
      writeFileSync(foreign, JSON.stringify({ roots: ['relative/x', HOME, 42, LOGOS] }));
      const b = new FileRoots(foreign, HOME);
      const roots = new FileRoots(null, HOME);
      for (let i = 0; i < MAX_FILE_ROOTS; i++) {
        const dir = join(HOME, 'many', `d${i}`);
        mkdirSync(dir, { recursive: true });
        await roots.allow(dir);
      }
      mkdirSync(join(HOME, 'many', 'one-more'), { recursive: true });
      const over = await roots.allow(join(HOME, 'many', 'one-more'));
      return ok('bounds', a.list().length === 0 && b.list().join() === LOGOS && roots.list().length === MAX_FILE_ROOTS && !over.ok,
        `broken=${a.list().length} foreign=${b.list().join()} many=${roots.list().length} over=${JSON.stringify(over)}`);
    }),
  ],
} satisfies TestModule;
