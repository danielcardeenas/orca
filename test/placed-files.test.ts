/**
 * ui/placed-files.ts — una imagen soltada en el campo se queda en el campo.
 *
 * Lo que vale la pena guardar: colocar, mover y quitar; volver a soltar la
 * misma ruta la recoloca en vez de duplicarla; la lista sobrevive a un
 * reload leyendo el mismo storage y un storage roto no la tira; sólo imagen
 * y vídeo son superficies del campo; y lo que sale como `Artifact` tiene la
 * forma que media.ts dibuja: id con prefijo, url por `/api/file`, sin agente.
 */

import { createPlacedFiles, fieldKindOf, isPlacedFileId, MAX_PLACED_FILES, PLACED_FILES_KEY } from '../src/ui/placed-files.ts';
import type { StorageLike } from '../src/ui/drafts.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

function memStorage(broken = false): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const fail = () => { if (broken) throw new Error('QuotaExceededError'); };
  return {
    map,
    getItem: (k) => { fail(); return map.get(k) ?? null; },
    setItem: (k, v) => { fail(); map.set(k, v); },
    removeItem: (k) => { fail(); map.delete(k); },
  };
}

const PNG = '/Users/dan/.orca/uploads/3f2a9c1e-grid3.png';
const MOV = '/Users/dan/.orca/uploads/9b1c0d2e-demo.mov';

export default {
  suite: 'placed-files',
  tests: [
    test('place, move, remove; the same path placed twice moves instead of doubling', () => {
      const s = memStorage();
      const pf = createPlacedFiles(s);
      const a = pf.add(PNG, { x: 1, y: 2, z: 0.05 }, 1000);
      if (!a || !isPlacedFileId(a.id) || a.kind !== 'image') return ok('placed', false, JSON.stringify(a));
      const again = pf.add(PNG, { x: 5, y: 5, z: 0.05 });
      if (pf.list().length !== 1 || again?.placement.x !== 5) return ok('re-placed, not doubled', false, JSON.stringify(pf.list()));
      const moved = pf.move(a.id, { x: 7, y: 8, z: 0.05 });
      if (!moved || pf.get(a.id)?.placement.y !== 8) return ok('moved', false, JSON.stringify(pf.get(a.id)));
      const ghost = pf.move('file:/nope.png', { x: 0, y: 0, z: 0 });
      const removed = pf.remove(a.id);
      const twice = pf.remove(a.id);
      return ok('lifecycle', !ghost && removed && !twice && pf.list().length === 0, `ghost=${ghost} removed=${removed} twice=${twice} left=${pf.list().length}`);
    }),
    test('the list survives a reload from the same storage; a broken storage is survived', () => {
      const s = memStorage();
      createPlacedFiles(s).add(PNG, { x: 1, y: 2, z: 0.05 }, 1000);
      const reloaded = createPlacedFiles(s);
      if (reloaded.list().length !== 1 || reloaded.get(`file:${PNG}`)?.placement.x !== 1) return ok('reload', false, JSON.stringify(reloaded.list()));
      s.map.set(PLACED_FILES_KEY, '{ not json');
      const garbage = createPlacedFiles(s).list().length;
      s.map.set(PLACED_FILES_KEY, JSON.stringify([{ path: 42 }, { path: MOV, placement: { x: 0, y: 0, z: 0 } }, null]));
      const filtered = createPlacedFiles(s).list();
      const broken = createPlacedFiles(memStorage(true));
      const stillWorks = broken.add(PNG, { x: 0, y: 0, z: 0 }) !== null && broken.list().length === 1;
      return ok('storage', garbage === 0 && filtered.length === 1 && filtered[0]!.kind === 'video' && stillWorks,
        `garbage=${garbage} filtered=${filtered.length} stillWorks=${stillWorks}`);
    }),
    test('only images and videos are field surfaces; the rest belongs in a message box', () => {
      const kinds = ['a.png', 'b.JPG', 'c.webm', 'd.pdf', 'e.md', 'f.txt', 'g.html', 'h.mp3', 'i'].map((n) => fieldKindOf(`/x/${n}`));
      return eq('kinds', kinds.join(','), 'image,image,video,,,,,,');
    }),
    test('as artifacts: prefixed id, /api/file url, no agent, and a ceiling', () => {
      const pf = createPlacedFiles(null);
      pf.add(PNG, { x: 1, y: 2, z: 0.05 }, 1000);
      const [art] = pf.artifacts();
      const shape = !!art && art.id === `file:${PNG}` && art.kind === 'image' && art.agentId === '' && art.title === '3f2a9c1e-grid3.png'
        && art.url === `/api/file?path=${encodeURIComponent(PNG)}` && art.placement?.x === 1 && art.at === 1000;
      for (let i = 1; i < MAX_PLACED_FILES; i++) pf.add(`/x/${i}.png`, { x: i, y: 0, z: 0 });
      const full = pf.add('/x/one-more.png', { x: 0, y: 0, z: 0 });
      return ok('artifacts', shape && pf.list().length === MAX_PLACED_FILES && full === null, `shape=${shape} n=${pf.list().length} full=${JSON.stringify(full)}`);
    }),
  ],
} satisfies TestModule;
