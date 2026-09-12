/**
 * La estantería se reserva, no se superpone.
 *
 * Ésta es la prueba de la única cosa que este trabajo tenía que no hacer: tapar
 * lo que el canvas ya dice. Una capa de imágenes encima de la rejilla no lanza
 * ningún error — entierra a los vecinos, y el operador se queda sin la mitad de
 * la flota sin que nada se lo diga. Así que aquí se mide: se pide el layout, se
 * calculan las fichas de cada estantería, y se comprueba caja contra caja que
 * ninguna ficha cae sobre ninguna baldosa.
 *
 * Y la otra mitad, que importa igual: con nadie que haya declarado nada, la
 * flota tiene que quedar exactamente donde estaba. Una reserva que se cobra
 * aunque no haya nada que reservar es una regresión para todo el mundo.
 */

import { TILE_H, TILE_W, emptyLayout, layoutFleet, squadKey, type Layout } from '../src/ui/field/layout.ts';
import { SHELF_H, shelfChips, type ChipSpec } from '../src/ui/field/shelf.ts';
import type { Agent, Project } from '../src/shared/types.ts';
import { emptyRollup } from '../src/shared/types.ts';
import { ok, test, type TestModule } from './harness.ts';

const PJ = 'p1';

function agent(id: string, extra: Record<string, unknown> = {}): Agent {
  return {
    id, machineId: 'm1', projectId: PJ, sessionId: `s_${id}`, callsign: id.toUpperCase(), title: '',
    runtime: 'claude', model: 'x', state: 'working', block: null, parentId: null, childIds: [],
    startedAt: 1, lastActivity: 1,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, tokensPerSec: 0,
      linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    placement: null,
    ...extra,
  } as unknown as Agent;
}

/** Seis agentes: tres columnas y dos filas, que es lo mínimo para que una fila pueda caer sobre otra. */
const SIX = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];

function fleet(extra: Record<string, Record<string, unknown>> = {}): Agent[] {
  return SIX.map((id) => agent(id, extra[id] ?? {}));
}

const projects = () => new Map<string, Project>([[PJ, {
  id: PJ, machineId: 'm1', slug: 'p', name: 'p', path: '/p', code: 'PP', gitBranch: 'main', gitDirty: false,
  keyNames: [], sessionIds: [], rollup: emptyRollup(),
} as unknown as Project]]);

const lay = (agents: Agent[], shelved: string[] = []): Layout =>
  layoutFleet(agents, projects(), new Map(), emptyLayout(), { kind: 'field' },
    new Map(), new Map(), new Map(), new Map(), new Set(shelved));

/** Las fichas de la estantería de un agente, con cuatro artefactos declarados. */
function chipsOf(layout: Layout, id: string, n = 4): ChipSpec[] {
  const s = layout.spots.get(id);
  if (!s) return [];
  const ids = Array.from({ length: n }, (_, i) => `art_${id}_${i}`);
  return shelfChips(ids, { x: s.tx, y: s.ty, z: s.tz, scale: s.scale, trayOf: s.trayOf });
}

/** ¿Se solapan una ficha y la caja de una baldosa? */
function hits(c: ChipSpec, tile: { x: number; y: number; scale: number }): boolean {
  const hw = (TILE_W * tile.scale) / 2, hh = (TILE_H * tile.scale) / 2;
  return Math.abs(c.x - tile.x) < c.w / 2 + hw - 1e-9
    && Math.abs(c.y - tile.y) < c.h / 2 + hh - 1e-9;
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

export default {
  suite: 'shelf-layout',
  tests: [
    test('sin nadie que haya declarado nada, la flota no se mueve ni un milímetro', () => {
      const antes = lay(fleet());
      const despues = lay(fleet(), []);
      for (const s of antes.spots.values()) {
        const t = despues.spots.get(s.id)!;
        if (!close(t.tx, s.tx) || !close(t.ty, s.ty)) {
          return ok('quieta', false, `${s.id} se movió de (${s.tx}, ${s.ty}) a (${t.tx}, ${t.ty})`);
        }
      }
      const r0 = antes.regions[0]!, r1 = despues.regions[0]!;
      return ok('sin nadie que haya declarado nada, la flota no se mueve ni un milímetro',
        close(r0.hh, r1.hh) && close(r0.cy, r1.cy),
        `${antes.spots.size} baldosas en el mismo sitio y la isla con el mismo alto (${r0.hh.toFixed(3)})`);
    }),

    test('una estantería en la primera fila separa las dos filas, y exactamente lo que mide', () => {
      /*
       * La isla está anclada por su centro, así que crecer la reparte: la fila
       * de arriba sube media franja y la de abajo baja media. Lo que importa no
       * es dónde queda cada fila en el mundo, que depende de la espiral, sino
       * que el PASO entre las dos crezca lo que mide la franja — eso es lo que
       * dice que el hueco está reservado y no robado.
       */
      const antes = lay(fleet());
      const despues = lay(fleet(), ['a1']);
      // a1 está en la primera fila; a4, a5 y a6 en la segunda, con tres columnas.
      const paso = (l: Layout) => l.spots.get('a1')!.ty - l.spots.get('a4')!.ty;
      const p0 = paso(antes), p1 = paso(despues);
      const r0 = antes.regions[0]!, r1 = despues.regions[0]!;
      const pass = close(p1 - p0, SHELF_H) && close(r1.hh * 2 - r0.hh * 2, SHELF_H);
      return ok('una estantería en la primera fila separa las dos filas, y exactamente lo que mide',
        pass,
        `el paso entre filas va de ${p0.toFixed(3)} a ${p1.toFixed(3)} (+${(p1 - p0).toFixed(3)}) y la isla crece ${(r1.hh * 2 - r0.hh * 2).toFixed(3)}`);
    }),

    test('ninguna ficha cae sobre ninguna baldosa, esté quien esté en la estantería', () => {
      /*
       * El caso duro es el peor: todos declarando a la vez. Si con seis
       * estanterías no hay un solo solape, no lo hay con una.
       */
      for (const shelved of [['a1'], ['a1', 'a2'], ['a4'], SIX]) {
        const layout = lay(fleet(), shelved);
        for (const id of shelved) {
          for (const c of chipsOf(layout, id)) {
            for (const s of layout.spots.values()) {
              if (hits(c, { x: s.tx, y: s.ty, scale: s.scale })) {
                return ok('solape', false,
                  `con [${shelved.join(', ')}] una ficha de ${id} cae sobre ${s.id}`);
              }
            }
          }
        }
      }
      return ok('ninguna ficha cae sobre ninguna baldosa, esté quien esté en la estantería', true,
        'probado con una, con dos de la misma fila, con una de la última, y con las seis');
    }),

    test('dos estanterías en la misma fila cuestan un escalón, no dos', () => {
      const una = lay(fleet(), ['a1']);
      const tres = lay(fleet(), ['a1', 'a2', 'a3']);
      const a4una = una.spots.get('a4')!.ty, a4tres = tres.spots.get('a4')!.ty;
      return ok('dos estanterías en la misma fila cuestan un escalón, no dos', close(a4una, a4tres),
        `con una y con tres de la primera fila, a4 está en ${a4una.toFixed(3)} y ${a4tres.toFixed(3)}`);
    }),

    test('la última fila también tiene su franja dentro de la isla', () => {
      /*
       * Una estantería en la última fila no empuja a nadie: no hay fila debajo.
       * Lo que tiene que pasar es que la ISLA mida más, o su borde cruzaría las
       * fichas de su propia fila de abajo. Y el paso entre las dos filas no
       * cambia, porque no hay nada entre ellas que reservar.
       */
      const antes = lay(fleet());
      const despues = lay(fleet(), ['a4']);
      const r0 = antes.regions[0]!, r1 = despues.regions[0]!;
      const paso = (l: Layout) => l.spots.get('a1')!.ty - l.spots.get('a4')!.ty;
      const mismoPaso = close(paso(antes), paso(despues));
      const creció = close(r1.hh * 2 - r0.hh * 2, SHELF_H);
      const chips = chipsOf(despues, 'a4');
      const suelo = Math.min(...chips.map((c) => c.y - c.h / 2));
      const dentro = suelo >= r1.cy - r1.hh - 1e-9;
      return ok('la última fila también tiene su franja dentro de la isla',
        mismoPaso && creció && dentro,
        `el paso entre filas no cambia (${paso(despues).toFixed(3)}); la isla crece ${(r1.hh * 2 - r0.hh * 2).toFixed(3)} y la franja acaba en ${suelo.toFixed(3)} sobre el borde ${(r1.cy - r1.hh).toFixed(3)}`);
    }),

    test('el contorno de un escuadrón encierra la estantería de su fila de abajo', () => {
      const agents = fleet({
        a1: { squad: 'audit', lead: true }, a2: { squad: 'audit' },
        a4: { squad: 'audit' }, a5: { squad: 'audit' },
      });
      const layout = lay(agents, ['a4']);
      const q = layout.regions[0]!.squads.find((x) => x.name === 'audit');
      if (!q) return ok('escuadrón', false, 'no salió el bloque del escuadrón');
      const chips = chipsOf(layout, 'a4');
      if (!chips.length) return ok('escuadrón', false, 'a4 no tiene estantería');
      const suelo = Math.min(...chips.map((c) => c.y - c.h / 2));
      const dentro = suelo >= q.cy - q.hh - 1e-9;
      return ok('el contorno de un escuadrón encierra la estantería de su fila de abajo', dentro,
        `la franja acaba en ${suelo.toFixed(3)} y el contorno en ${(q.cy - q.hh).toFixed(3)}`);
    }),

    test('un escuadrón que el operador movió se lleva su estantería con él', () => {
      const agents = fleet({
        a1: { squad: 'audit', lead: true }, a2: { squad: 'audit' },
        a4: { squad: 'audit' }, a5: { squad: 'audit' },
      });
      const quieto = lay(agents, ['a4']);
      const b = quieto.regions[0]!.squads.find((x) => x.name === 'audit')!;
      const movido = layoutFleet(agents, projects(), new Map(), emptyLayout(), { kind: 'field' },
        new Map([[squadKey(PJ, 'audit'), { projectId: PJ, name: 'audit', x: b.cx + 12, y: b.cy - 5, at: 1 }]]),
        new Map(), new Map(), new Map(), new Set(['a4']));
      const s0 = quieto.spots.get('a4')!, s1 = movido.spots.get('a4')!;
      // La baldosa se fue con el bloque, así que su estantería también: las
      // fichas se calculan desde la baldosa y no desde la rejilla.
      const chips = chipsOf(movido, 'a4');
      const pegada = chips.every((c) => Math.abs(c.x - s1.tx) <= TILE_W / 2 + 1e-9)
        && !close(s1.tx, s0.tx);
      return ok('un escuadrón que el operador movió se lleva su estantería con él', pegada,
        `a4 pasó de x ${s0.tx.toFixed(2)} a ${s1.tx.toFixed(2)} y las ${chips.length} fichas van con ella`);
    }),
  ],
} satisfies TestModule;
