/**
 * Las rutas saben que la estantería existe.
 *
 * La rejilla reserva `SHELF_H` bajo cada fila que lleva fichas
 * (`layout.ts`), pero `routeGutter` y `routeGutterMsg` buscaban el canalón
 * «bajo la fila» desde `TILE_H` a secas, así que el bus de linaje que salía
 * del puerto inferior de un padre con estantería cruzaba su franja de fichas
 * en horizontal, y un ask que pasaba por debajo iba entre la baldosa y las
 * fichas. Nada lanzaba un error: se veía en la foto.
 *
 * Lo que se mide aquí: que una fila con estantería enruta por debajo de la
 * franja; que una fila sin ella enruta EXACTAMENTE como antes, número a
 * número, porque un canalón que se ensancha sin fichas mueve el campo entero
 * sin motivo; que ninguna ruta pisa una baldosa en una rejilla con filas
 * reservadas; y que `layout.ts` deja en cada `Spot` lo que su fila reserva.
 */

import { routeGutter, routeGutterMsg, type Pt, type RoutePt } from '../src/ui/field/pipes.ts';
import { GAP_X, GAP_Y, TILE_H, TILE_W, emptyLayout, layoutFleet, type Layout } from '../src/ui/field/layout.ts';
import { SHELF_H, shelfChips } from '../src/ui/field/shelf.ts';
import type { Agent, Project } from '../src/shared/types.ts';
import { emptyRollup } from '../src/shared/types.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const GAPS = { x: GAP_X, y: GAP_Y };
const LANES: (-1 | 0 | 1)[] = [-1, 0, 1];
/** Paso vertical entre una fila con estantería y la de abajo, como lo deja la rejilla. */
const STEP_SHELVED = TILE_H + GAP_Y + SHELF_H;
const STEP = TILE_H + GAP_Y;

const at = (x: number, y: number, shelf = 0): RoutePt => ({ x, y, shelf });
/** La franja de una baldosa: de su borde inferior a `SHELF_H` por debajo. */
const strip = (p: Pt) => ({ top: p.y - TILE_H / 2, bottom: p.y - TILE_H / 2 - SHELF_H });
/** Los tramos horizontales de una ruta, por su altura. */
const horizontals = (pts: Pt[]): number[] => {
  const out: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i]!.y - pts[i - 1]!.y) < 1e-9 && Math.abs(pts[i]!.x - pts[i - 1]!.x) > 1e-9) out.push(pts[i]!.y);
  }
  return out;
};
const same = (a: Pt[], b: Pt[]) => a.length === b.length
  && a.every((p, i) => Math.abs(p.x - b[i]!.x) < 1e-9 && Math.abs(p.y - b[i]!.y) < 1e-9);

/* ── Lo de siempre, calculado con las fórmulas de siempre ─────────── */

/**
 * `routeGutter` tal y como era antes de saber de la estantería, para un padre
 * arriba y un hijo en la fila de abajo a la columna de al lado: una Z por el
 * canalón entre las dos filas, que a un solo canalón de distancia es el
 * mismo para los dos y la ruta se queda en cuatro puntos.
 */
function legacyDown(P: Pt, C: Pt): Pt[] {
  const px = P.x - TILE_W * 0.32, cx = C.x - TILE_W * 0.32;
  const pEdge = P.y - TILE_H / 2, cEdge = C.y + TILE_H / 2;
  const gy = pEdge - GAPS.y / 2;
  return [{ x: px, y: pEdge }, { x: px, y: gy }, { x: cx, y: gy }, { x: cx, y: cEdge }];
}

/* ── Una rejilla con filas reservadas, para buscar pisadas ─────────── */

const COLS = 5, ROWS = 4;
/** Las filas 0 y 2 llevan estantería, como haría `rowDrop`. */
const SHELF_ROW = [true, false, true, false];
interface Rect { minX: number; minY: number; maxX: number; maxY: number }
const grid: RoutePt[] = [];
const tiles: Rect[] = [];
const strips: Rect[] = [];
{
  let drop = 0;
  for (let r = 0; r < ROWS; r++) {
    const y = -r * STEP - drop;
    for (let c = 0; c < COLS; c++) {
      const p = { x: c * (TILE_W + GAP_X), y, shelf: SHELF_ROW[r] ? SHELF_H : 0 };
      grid.push(p);
      tiles.push({ minX: p.x - TILE_W / 2 + 1e-3, maxX: p.x + TILE_W / 2 - 1e-3, minY: p.y - TILE_H / 2 + 1e-3, maxY: p.y + TILE_H / 2 - 1e-3 });
      if (SHELF_ROW[r]) strips.push({ minX: p.x - TILE_W / 2, maxX: p.x + TILE_W / 2, minY: p.y - TILE_H / 2 - SHELF_H + 1e-3, maxY: p.y - TILE_H / 2 - 1e-3 });
    }
    if (SHELF_ROW[r]) drop += SHELF_H;
  }
}

/** Liang–Barsky: ¿comparte el tramo más que un punto con la caja? */
function crosses(a: Pt, b: Pt, r: Rect): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  let t0 = 0, t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  if (!clip(-dx, a.x - r.minX)) return false;
  if (!clip(dx, r.maxX - a.x)) return false;
  if (!clip(-dy, a.y - r.minY)) return false;
  if (!clip(dy, r.maxY - a.y)) return false;
  return t1 - t0 > 1e-9;
}

/** La primera baldosa que pisa una ruta, o la primera franja que un tramo HORIZONTAL atraviesa. */
function offence(name: string, pts: Pt[]): string | null {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    for (let k = 0; k < tiles.length; k++) if (crosses(a, b, tiles[k]!)) return `${name}: tramo ${i} pisa la baldosa ${k}`;
    // Un tramo vertical cruza la franja a la fuerza: el puerto está en el
    // borde de la baldosa y la franja cuelga de él. Lo que no puede pasar es
    // que un tramo horizontal corra por dentro de ella.
    if (Math.abs(a.y - b.y) < 1e-9) {
      for (let k = 0; k < strips.length; k++) if (crosses(a, b, strips[k]!)) return `${name}: tramo ${i} corre por la franja ${k} (y=${a.y.toFixed(3)})`;
    }
  }
  return null;
}

/* ── La rejilla de verdad ─────────────────────────────────────────── */

const PJ = 'p1';
function agent(id: string, extra: Record<string, unknown> = {}): Agent {
  return {
    id, machineId: 'm1', projectId: PJ, sessionId: `s_${id}`, callsign: id.toUpperCase(), title: '',
    runtime: 'claude', model: 'x', state: 'working', block: null, parentId: null, childIds: [],
    startedAt: 1, lastActivity: 1,
    metrics: { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 0 },
    placement: null, ...extra,
  } as unknown as Agent;
}
const SIX = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
const projects = () => new Map<string, Project>([[PJ, {
  id: PJ, machineId: 'm1', slug: 'p', name: 'p', path: '/p', code: 'PP', gitBranch: 'main', gitDirty: false,
  keyNames: [], sessionIds: [], rollup: emptyRollup(),
} as unknown as Project]]);
const lay = (shelved: string[] = []): Layout =>
  layoutFleet(SIX.map((id) => agent(id)), projects(), new Map(), emptyLayout(), { kind: 'field' },
    new Map(), new Map(), new Map(), new Map(), new Set(shelved));

export default {
  suite: 'shelf-routes',
  tests: [
    test('sin estantería, la ruta es la de siempre, número a número', () => {
      const P = at(0, 0), C = at(TILE_W + GAP_X, -STEP);
      const sinCampo = routeGutter({ x: P.x, y: P.y }, { x: C.x, y: C.y }, GAPS, 0);
      const conCero = routeGutter(P, C, GAPS, 0);
      const legado = legacyDown(P, C);
      const pass = same(sinCampo, legado) && same(conCero, legado);
      return ok('sin estantería, la ruta es la de siempre, número a número', pass,
        `${legado.length} puntos, iguales con \`shelf\` ausente y con \`shelf: 0\``);
    }),

    test('el bus de un padre con estantería corre por debajo de su franja, no por dentro', () => {
      const P = at(0, 0, SHELF_H), C = at(TILE_W + GAP_X, -STEP_SHELVED);
      const pts = routeGutter(P, C, GAPS, 0);
      const hs = horizontals(pts);
      const s = strip(P);
      // Todo tramo horizontal por debajo de la franja del padre y por encima del hijo.
      const pass = hs.length > 0 && hs.every((y) => y <= s.bottom + 1e-9 && y >= C.y + TILE_H / 2 - 1e-9);
      return ok('el bus de un padre con estantería corre por debajo de su franja, no por dentro', pass,
        `franja de ${s.top.toFixed(3)} a ${s.bottom.toFixed(3)}; horizontales en ${hs.map((y) => y.toFixed(3)).join(', ')}`);
    }),

    test('y con estantería el canalón baja exactamente SHELF_H, ni más ni menos', () => {
      const P = at(0, 0, SHELF_H), C = at(TILE_W + GAP_X, -STEP_SHELVED);
      const con = routeGutter(P, C, GAPS, 0);
      const sin = routeGutter(at(0, 0), at(TILE_W + GAP_X, -STEP), GAPS, 0);
      // El canalón bajo el padre: el primer tramo horizontal.
      const d = horizontals(sin)[0]! - horizontals(con)[0]!;
      return ok('y con estantería el canalón baja exactamente SHELF_H, ni más ni menos', Math.abs(d - SHELF_H) < 1e-9,
        `baja ${d.toFixed(3)} contra SHELF_H ${SHELF_H.toFixed(3)}`);
    }),

    test('la bajada por el puerto cae en el hueco entre la primera y la segunda ficha', () => {
      const P = at(0, 0, SHELF_H), C = at(TILE_W + GAP_X, -STEP_SHELVED);
      const pts = routeGutter(P, C, GAPS, 0);
      const chips = shelfChips(['a', 'b', 'c', 'd', 'e'], { x: P.x, y: P.y, z: 0, scale: 1, trayOf: null });
      const drop = pts[0]!.x;
      const pisa = chips.find((c) => Math.abs(drop - c.x) < c.w / 2);
      return ok('la bajada por el puerto cae en el hueco entre la primera y la segunda ficha', !pisa,
        pisa ? `el puerto en x=${drop.toFixed(3)} cae dentro de la ficha centrada en ${pisa.x.toFixed(3)}` : `puerto en x=${drop.toFixed(3)}`);
    }),

    test('un hijo justo debajo sigue siendo una bajada recta, franja incluida', () => {
      const P = at(0, 0, SHELF_H), C = at(0, -STEP_SHELVED);
      const pts = routeGutter(P, C, GAPS, 0);
      return ok('un hijo justo debajo sigue siendo una bajada recta, franja incluida', pts.length === 2,
        `${pts.length} puntos`);
    }),

    test('dos en la misma fila con estantería se unen por debajo de la franja', () => {
      const P = at(0, 0, SHELF_H), C = at(2 * (TILE_W + GAP_X), 0, SHELF_H);
      const pts = routeGutter(P, C, GAPS, 0);
      const hs = horizontals(pts);
      return ok('dos en la misma fila con estantería se unen por debajo de la franja', hs.length === 1 && hs[0]! <= strip(P).bottom + 1e-9,
        `canalón en ${hs[0]?.toFixed(3)}, franja hasta ${strip(P).bottom.toFixed(3)}`);
    }),

    test('subiendo hacia un padre con estantería, el canalón bajo él respeta su franja', () => {
      // El padre abajo, el hijo arriba con estantería: la ruta llega al hijo
      // por su borde inferior, y el canalón junto a él está bajo su franja.
      const P = at(0, -STEP_SHELVED), C = at(TILE_W + GAP_X, 0, SHELF_H);
      const pts = routeGutter(P, C, GAPS, 0);
      const hs = horizontals(pts);
      const alto = Math.max(...hs);
      return ok('subiendo hacia un padre con estantería, el canalón bajo él respeta su franja', alto <= strip(C).bottom + 1e-9,
        `el tramo más alto va por ${alto.toFixed(3)}, la franja llega a ${strip(C).bottom.toFixed(3)}`);
    }),

    test('un ask entre dos de una fila con estantería cruza por debajo de las fichas', () => {
      const A = at(0, 0, SHELF_H), B = at(2 * (TILE_W + GAP_X), 0, SHELF_H);
      const pts = routeGutterMsg(A, B, GAPS, 0);
      const hs = horizontals(pts).filter((y) => y < A.y - TILE_H / 2);
      const pass = hs.length === 1 && hs[0]! <= strip(A).bottom + 1e-9;
      return ok('un ask entre dos de una fila con estantería cruza por debajo de las fichas', pass,
        `cruza por ${hs[0]?.toFixed(3)}, la franja llega a ${strip(A).bottom.toFixed(3)}`);
    }),

    test('un ask hacia una fila de arriba con estantería cruza por debajo de su franja; hacia abajo, como siempre', () => {
      /*
       * Dos columnas de distancia, para que el cruce horizontal exista: a una
       * columna los dos canalones verticales coinciden y la ruta no cruza. Y
       * se mira sólo el CRUCE — el tramo horizontal que no está a la altura
       * del puerto lateral de ninguna de las dos —, porque los tramos que
       * salen del puerto van a la altura del puerto, con o sin estantería.
       */
      const cross = (pts: Pt[], A: Pt, B: Pt) => horizontals(pts)
        .filter((y) => Math.abs(y - (A.y + TILE_H * 0.12)) > 1e-9 && Math.abs(y - (B.y + TILE_H * 0.12)) > 1e-9);
      const A1 = at(0, -STEP_SHELVED), B1 = at(2 * (TILE_W + GAP_X), 0, SHELF_H);
      const up = cross(routeGutterMsg(A1, B1, GAPS, 0), A1, B1);
      const bajoFranja = up.length === 1 && up[0]! <= strip(B1).bottom + 1e-9;
      const A2 = at(0, 0, SHELF_H), B2 = at(2 * (TILE_W + GAP_X), -STEP_SHELVED);
      const A3 = at(0, 0), B3 = at(2 * (TILE_W + GAP_X), -STEP);
      const downCon = cross(routeGutterMsg(A2, B2, GAPS, 0), A2, B2).map((y) => y - B2.y);
      const downSin = cross(routeGutterMsg(A3, B3, GAPS, 0), A3, B3).map((y) => y - B3.y);
      // Hacia abajo el cruce va sobre el borde superior del destino, donde no
      // hay franja: a la misma altura relativa al destino que sin estantería.
      const igual = downCon.length === 1 && downSin.length === 1 && Math.abs(downCon[0]! - downSin[0]!) < 1e-9;
      return ok('un ask hacia una fila de arriba con estantería cruza por debajo de su franja; hacia abajo, como siempre', bajoFranja && igual,
        `subiendo cruza por ${up[0]?.toFixed(3)} (franja hasta ${strip(B1).bottom.toFixed(3)}); bajando, a ${downCon[0]?.toFixed(3)} del destino contra ${downSin[0]?.toFixed(3)} sin estantería`);
    }),

    test('en una rejilla con filas reservadas ninguna ruta pisa baldosa ni corre por una franja', () => {
      for (let i = 0; i < grid.length; i++) for (let j = 0; j < grid.length; j++) {
        if (i === j) continue;
        for (const lane of LANES) {
          const a = offence(`linaje ${i}→${j} carril ${lane}`, routeGutter(grid[i]!, grid[j]!, GAPS, lane));
          if (a) return ok('pisada', false, a);
          const b = offence(`mensaje ${i}→${j} carril ${lane}`, routeGutterMsg(grid[i]!, grid[j]!, GAPS, lane));
          if (b) return ok('pisada', false, b);
        }
      }
      return ok('en una rejilla con filas reservadas ninguna ruta pisa baldosa ni corre por una franja', true,
        `${grid.length * (grid.length - 1) * LANES.length * 2} rutas en ${COLS}×${ROWS} con dos filas reservadas`);
    }),

    test('la rejilla deja en cada baldosa lo que reserva su fila, y nada donde no hay fichas', () => {
      const con = lay(['a1']);
      const sin = lay();
      const a1 = con.spots.get('a1')!;
      const rowY = a1.ty;
      const filaDeA1 = [...con.spots.values()].filter((s) => Math.abs(s.ty - rowY) < 1e-9);
      const otras = [...con.spots.values()].filter((s) => Math.abs(s.ty - rowY) >= 1e-9);
      const pass = filaDeA1.length >= 2
        && filaDeA1.every((s) => Math.abs(s.shelf - SHELF_H) < 1e-9)
        && otras.length >= 1 && otras.every((s) => s.shelf === 0)
        && [...sin.spots.values()].every((s) => s.shelf === 0);
      return ok('la rejilla deja en cada baldosa lo que reserva su fila, y nada donde no hay fichas', pass,
        `fila de a1: ${filaDeA1.length} baldosas a ${SHELF_H.toFixed(3)}; otras: ${otras.length} a 0; sin declarar, ${sin.spots.size} a 0`);
    }),

    test('con la rejilla de verdad, el bus baja hasta el canalón que la fila reservó', () => {
      const layout = lay(['a1']);
      const a1 = layout.spots.get('a1')!;
      // Uno de la fila de abajo en OTRA columna: justo debajo sería una bajada
      // recta, sin tramo horizontal que medir.
      const abajo = [...layout.spots.values()].find((s) => s.ty < a1.ty - TILE_H && Math.abs(s.tx - a1.tx) > TILE_W)!;
      const pts = routeGutter({ x: a1.tx, y: a1.ty, shelf: a1.shelf }, { x: abajo.tx, y: abajo.ty, shelf: abajo.shelf }, GAPS, 0);
      const hs = horizontals(pts);
      const s = strip({ x: a1.tx, y: a1.ty });
      const pass = hs.every((y) => y <= s.bottom + 1e-9) && hs.some((y) => Math.abs(y - (s.bottom - GAP_Y / 2)) < 1e-9);
      return eq('con la rejilla de verdad, el bus baja hasta el canalón que la fila reservó', pass, true,
        `horizontales en ${hs.map((y) => y.toFixed(3)).join(', ')}; canalón esperado en ${(s.bottom - GAP_Y / 2).toFixed(3)}`);
    }),
  ],
} satisfies TestModule;
