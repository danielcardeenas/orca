/**
 * El recinto del arnés: dónde caen las teselas que levantan las pruebas.
 *
 * Lo que se defiende aquí es que correr las pruebas no le cueste nada al
 * campo de quien está trabajando. Tres cosas, y las tres se rompen en
 * silencio: la flota de verdad no se mueve ni medio milímetro porque alguien
 * arranque el mock; todo lo del arnés cae en UN recinto y no en seis islas
 * repartidas por la espiral; y ese recinto se planta pegado a la isla del
 * proyecto desde el que se lanzaron, que es donde el ojo lo espera.
 *
 * Ver src/shared/synthetic.ts y src/ui/field/layout.ts.
 */

import { emptyLayout, layoutFleet, type Region } from '../src/ui/field/layout.ts';
import { harnessIsland } from '../src/shared/synthetic.ts';
import type { Agent, Project } from '../src/shared/types.ts';
import { emptyRollup } from '../src/shared/types.ts';
import { ok, test, type TestModule } from './harness.ts';

/** El repo desde el que alguien corre `npm run visual`. */
const HOME = '-Users-dan-projects-orca';

function agent(id: string, machineId: string, projectId: string): Agent {
  return {
    id, machineId, projectId, sessionId: `s_${id}`, callsign: id.toUpperCase(), title: '',
    runtime: 'claude', model: 'x', state: 'working', block: null, parentId: null, startedAt: 1, lastActivity: 1,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, tokensPerSec: 0,
      linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    placement: null,
  } as unknown as Agent;
}

function project(id: string, machineId: string, slug: string, name: string, code: string): Project {
  return {
    id, machineId, slug, name, path: slug.replace(/-/g, '/'), code, gitBranch: 'main', gitDirty: false,
    keyNames: [], sessionIds: [], rollup: emptyRollup(),
  } as unknown as Project;
}

/** La flota de verdad: dos proyectos en la máquina del operador. */
function real() {
  const agents = [
    agent('r1', 'mac', 'mac/orca'), agent('r2', 'mac', 'mac/orca'), agent('r3', 'mac', 'mac/orca'),
    agent('r4', 'mac', 'mac/dijosi'), agent('r5', 'mac', 'mac/dijosi'),
  ];
  const projects = new Map<string, Project>([
    ['mac/orca', project('mac/orca', 'mac', HOME, 'orca', 'OR')],
    ['mac/dijosi', project('mac/dijosi', 'mac', '-Users-dan-projects-dijosi', 'dijosi', 'DI')],
  ]);
  return { agents, projects };
}

/** Lo que arranca el mock: dos máquinas de fixture, cada una con lo suyo. */
function fixtures(home: string) {
  const agents = [
    agent('f1', 'mac-cascabel', 'mac-cascabel/p1'), agent('f2', 'mac-cascabel', 'mac-cascabel/p1'),
    agent('f3', 'mac-cascabel', 'mac-cascabel/p2'),
    agent('f4', 'vps-fra1', 'vps-fra1/p3'), agent('f5', 'vps-fra1', 'vps-fra1/p3'),
  ];
  const projects = new Map<string, Project>([
    ['mac-cascabel/p1', project('mac-cascabel/p1', 'mac-cascabel', '-fake-p1', 'axolots', 'AX')],
    ['mac-cascabel/p2', project('mac-cascabel/p2', 'mac-cascabel', '-fake-p2', 'glaciar', 'GL')],
    ['vps-fra1/p3', project('vps-fra1/p3', 'vps-fra1', '-fake-p3', 'nimbo', 'NI')],
  ]);
  const machines = new Map<string, string>([['mac-cascabel', home], ['vps-fra1', home]]);
  return { agents, projects, machines };
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const overlap = (a: Region, b: Region) =>
  Math.abs(a.cx - b.cx) < a.hw + b.hw && Math.abs(a.cy - b.cy) < a.hh + b.hh;

export default {
  suite: 'harness-field',
  tests: [
    test('la flota de verdad no se mueve porque alguien corra las pruebas', () => {
      const r = real();
      const f = fixtures(HOME);
      const before = layoutFleet(r.agents, r.projects, new Map(), emptyLayout());
      const during = layoutFleet(
        [...r.agents, ...f.agents], new Map([...r.projects, ...f.projects]), new Map(),
        emptyLayout(), { kind: 'field' }, new Map(), new Map(), new Map(), f.machines,
      );
      for (const s0 of before.spots.values()) {
        const s1 = during.spots.get(s0.id)!;
        if (!close(s1.tx, s0.tx) || !close(s1.ty, s0.ty)) {
          return ok('tesela quieta', false, `${s0.id}: (${s0.tx}, ${s0.ty}) → (${s1.tx}, ${s1.ty})`);
        }
      }
      for (const r0 of before.regions) {
        const r1 = during.regions.find((x) => x.id === r0.id)!;
        if (!close(r1.cx, r0.cx) || !close(r1.cy, r0.cy)) return ok('isla quieta', false, `${r0.id} se movió`);
      }
      return ok('la flota de verdad no se mueve porque alguien corra las pruebas', true,
        `${before.spots.size} teselas y ${before.regions.length} islas en el mismo sitio con el arnés puesto`);
    }),

    test('todo el arnés cae en un recinto, y el recinto no es flota', () => {
      const r = real();
      const f = fixtures(HOME);
      const lay = layoutFleet(
        [...r.agents, ...f.agents], new Map([...r.projects, ...f.projects]), new Map(),
        emptyLayout(), { kind: 'field' }, new Map(), new Map(), new Map(), f.machines,
      );
      const pens = lay.regions.filter((x) => x.harness);
      if (pens.length !== 1) return ok('un recinto', false, `${pens.length} recintos, se esperaba 1`);
      const pen = pens[0]!;
      if (pen.id !== harnessIsland(HOME)) return ok('id del recinto', false, pen.id);
      if (pen.count !== f.agents.length) return ok('cuenta', false, `${pen.count} de ${f.agents.length} fixtures dentro`);
      // Ninguna de sus máquinas ni de sus proyectos de mentira gana isla propia.
      const strays = lay.regions.filter((x) => !x.harness && f.projects.has(x.id));
      if (strays.length) return ok('islas sueltas', false, strays.map((x) => x.id).join(', '));
      for (const a of f.agents) {
        if (lay.spots.get(a.id)!.projectId !== pen.id) return ok('tesela dentro', false, `${a.id} fuera del recinto`);
      }
      return ok('todo el arnés cae en un recinto, y el recinto no es flota', true,
        `${pen.count} fixtures de 2 máquinas y 3 proyectos en «${pen.name}»`);
    }),

    test('el recinto se planta pegado a la isla desde la que se lanzó', () => {
      const r = real();
      const f = fixtures(HOME);
      const lay = layoutFleet(
        [...r.agents, ...f.agents], new Map([...r.projects, ...f.projects]), new Map(),
        emptyLayout(), { kind: 'field' }, new Map(), new Map(), new Map(), f.machines,
      );
      const pen = lay.regions.find((x) => x.harness)!;
      const host = lay.regions.find((x) => x.id === 'mac/orca')!;
      const other = lay.regions.find((x) => x.id === 'mac/dijosi')!;
      const gap = (x: Region) => Math.hypot(pen.cx - x.cx, pen.cy - x.cy);
      if (gap(host) >= gap(other)) {
        return ok('anfitrión', false, `a ${gap(host).toFixed(2)} de orca y a ${gap(other).toFixed(2)} de dijosi`);
      }
      for (const x of lay.regions) {
        if (x !== pen && overlap(pen, x)) return ok('sin pisar', false, `el recinto pisa ${x.id}`);
      }
      if (!pen.name.endsWith('orca')) return ok('rótulo', false, pen.name);
      return ok('el recinto se planta pegado a la isla desde la que se lanzó', true,
        `«${pen.name}» a ${gap(host).toFixed(2)} de su anfitrión y a ${gap(other).toFixed(2)} de la otra isla`);
    }),

    test('un arnés que no dice de dónde salió se va al margen, sin pisar a nadie', () => {
      const r = real();
      const f = fixtures('');
      const lay = layoutFleet(
        [...r.agents, ...f.agents], new Map([...r.projects, ...f.projects]), new Map(),
        emptyLayout(), { kind: 'field' }, new Map(), new Map(), new Map(), f.machines,
      );
      const pen = lay.regions.find((x) => x.harness)!;
      if (pen.name !== 'harness') return ok('rótulo', false, `«${pen.name}» debería no nombrar anfitrión`);
      for (const x of lay.regions) {
        if (x !== pen && overlap(pen, x)) return ok('sin pisar', false, `el recinto pisa ${x.id}`);
      }
      return ok('un arnés que no dice de dónde salió se va al margen, sin pisar a nadie', true,
        `«${pen.name}» en (${pen.cx.toFixed(1)}, ${pen.cy.toFixed(1)})`);
    }),
  ],
} satisfies TestModule;
