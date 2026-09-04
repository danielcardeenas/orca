/**
 * El charset de ids del hub contra las formas que el collector produce.
 *
 * Divergieron una vez y falló en silencio: las claves de subagente son
 * `<sesión>#<agente>` y el `#` no estaba en la lista, así que cada subagente
 * se descartaba sin llegar nunca a la consola. El grafo de linaje —ver qué
 * agente lanzó a cuál— simplemente no existía, y el aviso no traía el id, así
 * que no había nada que depurar.
 */

import { validId } from '../src/hub/world.ts';
import { ok, test, type TestModule } from './harness.ts';

/** Formas reales que produce el collector, tal cual las construye. */
const REAL_SHAPES: { what: string; id: string }[] = [
  { what: 'sesión normal', id: '948db529-0aec-42e1-9bdc-cd860a2596c7' },
  { what: 'subagente', id: '948db529-0aec-42e1-9bdc-cd860a2596c7#a1b2c3' },
  { what: 'agente de workflow', id: 'sess_abc#agent-01' },
  { what: 'id de proyecto (máquina/slug)', id: 'a303610c/-Users-dan-projects-axolots' },
  { what: 'id de máquina', id: 'a303610cd6985e46f05a53366923d07a' },
  { what: 'escalación', id: 'esc_mtn6rr0qnb7a9n' },
  { what: 'ask del canal de archivos', id: 'ask_mtn6vaqua6ak2j' },
];

const MUST_REJECT: { what: string; id: unknown }[] = [
  { what: 'prototype pollution', id: '__proto__' },
  { what: 'constructor', id: 'constructor' },
  { what: 'vacío', id: '' },
  { what: 'con espacio', id: 'agent 1' },
  { what: 'con salto de línea', id: 'agent\n1' },
  { what: 'no string', id: 42 },
  { what: 'null', id: null },
  { what: 'absurdamente largo', id: 'a'.repeat(300) },
];

const tests = [
  ...REAL_SHAPES.map(({ what, id }) => test(`acepta: ${what}`, () =>
    ok(`acepta: ${what}`, validId(id), id.slice(0, 60)))),

  ...MUST_REJECT.map(({ what, id }) => test(`rechaza: ${what}`, () =>
    ok(`rechaza: ${what}`, !validId(id), String(id).slice(0, 40)))),
];

const suite: TestModule = { suite: 'contrato · charset de ids', tests };
export default suite;
