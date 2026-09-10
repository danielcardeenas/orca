/**
 * ui/windows/attach.ts — una ruta entra en la caja donde estaba el cursor.
 *
 * Lo que vale la pena guardar: la ruta se separa con un espacio de lo que
 * había a cada lado, y sólo cuando hace falta; una selección se sustituye; el
 * caret queda tras lo insertado; varias rutas van en una línea; lo que el
 * lienzo deja para una caja que aún no existe la espera, y una caja montada
 * lo recibe al momento; y una subida fallida no tira las demás.
 */

import { insertPaths, onStage, resetStaged, stage, uploadAll } from '../src/ui/windows/attach.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const P = '/Users/dan/.orca/uploads/3f2a9c1e-informe.pdf';
const Q = '/Users/dan/.orca/uploads/9b1c0d2e-captura.png';

export default {
  suite: 'attach',
  tests: [
    test('a path lands at the caret, spaced from its neighbours only when needed', () => {
      const empty = insertPaths({ value: '', selectionStart: 0, selectionEnd: 0 }, [P]);
      if (empty.value !== P || empty.caret !== P.length) return eq('empty box', empty.value, P);
      const end = insertPaths({ value: 'mira esto', selectionStart: 9, selectionEnd: 9 }, [P]);
      if (end.value !== `mira esto ${P}`) return eq('at the end', end.value, `mira esto ${P}`);
      const spaced = insertPaths({ value: 'mira esto ', selectionStart: 10, selectionEnd: 10 }, [P]);
      if (spaced.value !== `mira esto ${P}`) return eq('already spaced', spaced.value, `mira esto ${P}`);
      const middle = insertPaths({ value: 'lee y resume', selectionStart: 3, selectionEnd: 3 }, [P]);
      if (middle.value !== `lee ${P} y resume`) return eq('in the middle', middle.value, `lee ${P} y resume`);
      if (middle.caret !== 4 + P.length) return eq('caret after the path', middle.caret, 4 + P.length);
      const newline = insertPaths({ value: 'lee\n', selectionStart: 4, selectionEnd: 4 }, [P]);
      if (newline.value !== `lee\n${P}`) return eq('after a newline', newline.value, `lee\n${P}`);
      const replaced = insertPaths({ value: 'lee AQUI ya', selectionStart: 4, selectionEnd: 8 }, [P]);
      if (replaced.value !== `lee ${P} ya`) return eq('selection replaced', replaced.value, `lee ${P} ya`);
      const two = insertPaths({ value: '', selectionStart: 0, selectionEnd: 0 }, [P, Q]);
      return eq('two paths, one line', two.value, `${P} ${Q}`);
    }),
    test('paths staged for an unmounted box wait; a mounted box gets them at once', () => {
      resetStaged();
      const got: string[][] = [];
      stage('orca.draft.agent:a1', [P]);
      stage('orca.draft.agent:a1', [Q]);
      const off = onStage('orca.draft.agent:a1', (p) => got.push(p));
      const waited = got.length === 1 && got[0]!.join() === [P, Q].join();
      stage('orca.draft.agent:a1', [P]);
      const live = got.length === 2 && got[1]!.join() === P;
      off();
      stage('orca.draft.agent:a1', [Q]);
      const afterOff = got.length === 2;
      onStage('orca.draft.agent:a1', (p) => got.push(p));
      const remounted = got.length === 3 && got[2]!.join() === Q;
      stage('orca.draft.agent:a1', []);
      resetStaged();
      return ok('staging', waited && live && afterOff && remounted, `waited=${waited} live=${live} afterOff=${afterOff} remounted=${remounted} got=${got.length}`);
    }),
    test('one failed upload is one note, not zero paths', async () => {
      const notes: string[] = [];
      const files = [{ name: 'a.pdf' }, { name: 'grande.bin' }, { name: 'c.png' }] as unknown as File[];
      const upload = async (f: File) => {
        if (f.name === 'grande.bin') throw new Error('Files must be 64 MB or smaller.');
        return { path: `/up/${f.name}` };
      };
      const paths = await uploadAll(files, upload, (t) => notes.push(t));
      return ok('partial upload', paths.join() === '/up/a.pdf,/up/c.png' && notes.length === 1 && notes[0]!.startsWith('grande.bin not uploaded'),
        `paths=${paths.join()} notes=${notes.join('|')}`);
    }),
  ],
} satisfies TestModule;
