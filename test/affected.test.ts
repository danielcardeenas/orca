import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { affected, reach } from './affected.ts';
import { test, ok } from './harness.ts';

/** Un repo de mentira: dos suites, una cadena de imports y una rama muerta. */
function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-affected-'));
  const dir = path.join(root, 'test');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(dir);
  const w = (p: string, s: string) => fs.writeFileSync(path.join(root, p), s);
  w('src/deep.ts', 'export const deep = 1;\n');
  w('src/mid.ts', "import { deep } from './deep.ts';\nexport const mid = deep;\n");
  w('src/lonely.ts', 'export const lonely = 1;\n');
  w('test/util.ts', "export * from '../src/mid.ts';\n");
  w('test/a.test.ts', "import './util.ts';\nexport default { suite: 'a', tests: [] };\n");
  w('test/b.test.ts', "export default { suite: 'b', tests: [] };\n");
  return { root, dir, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export default { suite: 'Affected suites', tests: [
  test('a transitive dependency selects the suite that reaches it', async () => {
    const r = rig(); try {
      // a.test.ts -> util.ts -> src/mid.ts -> src/deep.ts: tres saltos, ninguno directo.
      const { suites, uncovered } = await affected(r.dir, ['src/deep.ts'], r.root);
      assert.deepEqual(suites, ['a.test.ts']);
      assert.deepEqual(uncovered, []);
      return ok('reaches through re-export and two hops, and excludes b', true);
    } finally { r.dispose(); }
  }),
  test('a file no suite imports is reported, not silently skipped', async () => {
    const r = rig(); try {
      const { suites, uncovered } = await affected(r.dir, ['src/lonely.ts'], r.root);
      assert.deepEqual(suites, []);
      assert.deepEqual(uncovered.map(u => path.basename(u)), ['lonely.ts']);
      return ok('running fewer tests stays honest about the gap', true);
    } finally { r.dispose(); }
  }),
  test('a changed suite selects itself and the walk terminates on cycles', async () => {
    const r = rig(); try {
      // Un ciclo mid <-> deep colgaría un recorrido ingenuo.
      fs.appendFileSync(path.join(r.root, 'src/deep.ts'), "import '../src/mid.ts';\n");
      assert.ok((await reach(path.join(r.dir, 'a.test.ts'))).size >= 4);
      const { suites } = await affected(r.dir, ['test/b.test.ts'], r.root);
      assert.deepEqual(suites, ['b.test.ts']);
      return ok('self-selection works and cycles do not hang', true);
    } finally { r.dispose(); }
  }),
] };
