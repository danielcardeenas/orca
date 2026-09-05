/**
 * pipes.ts — the gutters, and the length `add()` hands back.
 *
 * The claim §4.1 makes is a geometric one: no pipe ever crosses a tile. It is
 * cheap to check exhaustively, so this builds the grid `layout.ts` would build
 * and runs every ordered pair of tiles through both routers in every lane,
 * against every tile rectangle. One counterexample is a bug that the eye would
 * only catch in a screenshot of a crowded region.
 */

import * as THREE from 'three';
import {
  createPipes, laneShift, pathLength, routeGutter, routeGutterMsg, type Pt,
} from '../src/ui/field/pipes.ts';
import { GAP_X, GAP_Y, TILE_H, TILE_W } from '../src/ui/field/layout.ts';
import { eq, near, ok, test, type TestModule } from './harness.ts';

/* ── A synthetic region: six columns, four rows, layout.ts's spacing ── */

const COLS = 6, ROWS = 4;
const GAPS = { x: GAP_X, y: GAP_Y };
const LANES: (-1 | 0 | 1)[] = [-1, 0, 1];

interface Rect { minX: number; minY: number; maxX: number; maxY: number }

const centres: Pt[] = [];
const rects: Rect[] = [];
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const p = { x: c * (TILE_W + GAP_X), y: -r * (TILE_H + GAP_Y) };
    centres.push(p);
    // Shrunk by 1e-3: a port sits *on* the edge, and touching it is the point.
    rects.push({
      minX: p.x - TILE_W / 2 + 1e-3, maxX: p.x + TILE_W / 2 - 1e-3,
      minY: p.y - TILE_H / 2 + 1e-3, maxY: p.y + TILE_H / 2 - 1e-3,
    });
  }
}

/** Liang–Barsky: does the segment share more than a point with the rect? */
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

/** The first tile a route runs over, described, or null when it is clean. */
function offence(name: string, pts: Pt[]): string | null {
  if (pts.length < 2) return `${name}: ${pts.length} points`;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.y - b.y) > 1e-6) {
      return `${name}: leg ${i} is diagonal (${a.x.toFixed(3)},${a.y.toFixed(3)})→(${b.x.toFixed(3)},${b.y.toFixed(3)})`;
    }
    for (let k = 0; k < rects.length; k++) {
      if (crosses(a, b, rects[k]!)) {
        return `${name}: leg ${i} (${a.x.toFixed(3)},${a.y.toFixed(3)})→(${b.x.toFixed(3)},${b.y.toFixed(3)}) crosses tile ${k}`;
      }
    }
  }
  return null;
}

export default {
  suite: 'pipes',
  tests: [
    test('no lineage route crosses a tile, for any pair in a 6×4 grid', () => {
      let checked = 0;
      for (let i = 0; i < centres.length; i++) {
        for (let j = 0; j < centres.length; j++) {
          if (i === j) continue;
          for (const lane of LANES) {
            const bad = offence(`routeGutter ${i}→${j} lane ${lane}`, routeGutter(centres[i]!, centres[j]!, GAPS, lane));
            if (bad) return ok('no lineage route crosses a tile, for any pair in a 6×4 grid', false, bad);
            checked++;
          }
        }
      }
      return ok('no lineage route crosses a tile, for any pair in a 6×4 grid', true, `${checked} routes clean`);
    }),

    test('no peer route crosses a tile, for any pair in a 6×4 grid', () => {
      let checked = 0;
      for (let i = 0; i < centres.length; i++) {
        for (let j = 0; j < centres.length; j++) {
          if (i === j) continue;
          for (const lane of LANES) {
            const bad = offence(`routeGutterMsg ${i}→${j} lane ${lane}`, routeGutterMsg(centres[i]!, centres[j]!, GAPS, lane));
            if (bad) return ok('no peer route crosses a tile, for any pair in a 6×4 grid', false, bad);
            checked++;
          }
        }
      }
      return ok('no peer route crosses a tile, for any pair in a 6×4 grid', true, `${checked} routes clean`);
    }),

    test('both routes land on the tiles they name, never inside them', () => {
      const P = centres[8]!, C = centres[15]!;
      const a = routeGutter(P, C, GAPS, 0);
      const first = a[0]!, last = a[a.length - 1]!;
      const onEdge = Math.abs(first.y - (P.y - TILE_H / 2)) < 1e-9 && Math.abs(last.y - (C.y + TILE_H / 2)) < 1e-9;
      const atPort = Math.abs(first.x - (P.x - TILE_W * 0.32)) < 1e-9 && Math.abs(last.x - (C.x - TILE_W * 0.32)) < 1e-9;
      const b = routeGutterMsg(P, C, GAPS, 0);
      const side = Math.abs(Math.abs(b[0]!.x - P.x) - TILE_W / 2) < 1e-9
        && Math.abs(b[0]!.y - (P.y + TILE_H * 0.12)) < 1e-9
        && Math.abs(Math.abs(b[b.length - 1]!.x - C.x) - TILE_W / 2) < 1e-9;
      return ok('both routes land on the tiles they name, never inside them', onEdge && atPort && side,
        `lineage ${onEdge && atPort ? 'ok' : 'off'}, message ${side ? 'ok' : 'off'}`);
    }),

    test('a child directly below in the same column is a straight drop', () => {
      const P = centres[2]!, C = centres[2 + COLS]!;
      const pts = routeGutter(P, C, GAPS, 1);
      return eq('a child directly below in the same column is a straight drop', pts.length, 2,
        `x ${pts[0]!.x.toFixed(2)}, ${pts[0]!.y.toFixed(2)} → ${pts[1]!.y.toFixed(2)}`);
    }),

    test('two rows down in the same column detours: a straight drop would cross the tile between', () => {
      const P = centres[2]!, C = centres[2 + COLS * 2]!;
      const pts = routeGutter(P, C, GAPS, 0);
      const detour = pts.length > 2 && pts.some((p) => Math.abs(p.x - (C.x - TILE_W / 2 - GAP_X / 2)) < 1e-9);
      return ok('two rows down in the same column detours: a straight drop would cross the tile between',
        detour, `${pts.length} points`);
    }),

    test('side by side in one row is one run through the gutter between them', () => {
      const pts = routeGutterMsg(centres[0]!, centres[1]!, GAPS, 0);
      return eq('side by side in one row is one run through the gutter between them', pts.length, 2,
        `${pts[0]!.x.toFixed(2)} → ${pts[1]!.x.toFixed(2)}`);
    }),

    test('lanes keep three pipes apart and inside the gutter', () => {
      const d = laneShift(GAP_X);
      const clear = GAP_X / 2 - d;
      // Narrow the gutter and the lanes must close up, never spill onto a tile.
      const tight = laneShift(0.06);
      return ok('lanes keep three pipes apart and inside the gutter',
        Math.abs(d - 0.075) < 1e-9 && clear > 0.04 && tight <= 0.03,
        `±${d} in a ${GAP_X} gutter (${clear.toFixed(3)} clear), ±${tight} in a 0.06 one`);
    }),

    test('a lane never pushes a route onto a tile, even in a gutter half as wide', () => {
      const tight = { x: 0.12, y: 0.13 };
      const half: Pt[] = [];
      const half_rects: Rect[] = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        const p = { x: c * (TILE_W + tight.x), y: -r * (TILE_H + tight.y) };
        half.push(p);
        half_rects.push({
          minX: p.x - TILE_W / 2 + 1e-3, maxX: p.x + TILE_W / 2 - 1e-3,
          minY: p.y - TILE_H / 2 + 1e-3, maxY: p.y + TILE_H / 2 - 1e-3,
        });
      }
      for (let i = 0; i < half.length; i++) for (let j = 0; j < half.length; j++) {
        if (i === j) continue;
        for (const lane of LANES) {
          for (const pts of [routeGutter(half[i]!, half[j]!, tight, lane), routeGutterMsg(half[i]!, half[j]!, tight, lane)]) {
            for (let s = 0; s < pts.length - 1; s++) {
              for (let k = 0; k < half_rects.length; k++) {
                if (crosses(pts[s]!, pts[s + 1]!, half_rects[k]!)) {
                  return ok('a lane never pushes a route onto a tile, even in a gutter half as wide', false,
                    `${i}→${j} lane ${lane} leg ${s} crosses tile ${k}`);
                }
              }
            }
          }
        }
      }
      return ok('a lane never pushes a route onto a tile, even in a gutter half as wide', true, '0.12 × 0.13 gutters');
    }),

    test('pathLength adds the legs up', () => {
      const l = pathLength([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }, { x: 0, y: 4 }]);
      const none = pathLength([{ x: 1, y: 1 }]);
      return ok('pathLength adds the legs up', Math.abs(l - 10) < 1e-9 && none === 0, `${l} and ${none}`);
    }),

    test('add() returns the length of the path it drew', () => {
      const scene = new THREE.Scene();
      const pipes = createPipes(scene);
      const path = routeGutter(centres[1]!, centres[1 + COLS * 3]!, GAPS, -1);
      pipes.begin();
      const got = pipes.add(path, -0.3, new THREE.Color(0x9dff3c), 'lineage', 0);
      const empty = pipes.add([{ x: 0, y: 0 }], -0.3, new THREE.Color(), 'lineage', 0);
      const segs = pipes.segments();
      pipes.end(0, 60);
      pipes.dispose();
      return segs === path.length - 1 && empty === 0
        ? near('add() returns the length of the path it drew', got, pathLength(path), 1e-9)
        : ok('add() returns the length of the path it drew', false, `${segs} segments for ${path.length} points, empty ${empty}`);
    }),

    test('a core paints as far as its filled length, and a pulse cuts on arrival', () => {
      const scene = new THREE.Scene();
      const pipes = createPipes(scene);
      const path: Pt[] = [{ x: 0, y: 0 }, { x: 2, y: 0 }];
      pipes.begin();
      const len = pipes.add(path, -0.3, new THREE.Color(0x9dff3c), 'core', 0.5 * pathLength(path));
      pipes.port(0, 0, -0.3, new THREE.Color(0x9dff3c), 1.3, 0, true);
      pipes.end(0, 60);
      pipes.pulse(path, -0.3, new THREE.Color(0x9dff3c));
      pipes.step(0.05);
      const flying = (scene.children.find((c) => (c as THREE.InstancedMesh).renderOrder === 1) as THREE.InstancedMesh | undefined)?.count ?? 0;
      // len / 9 is under T.quick, so the run takes T.quick; a second is past it.
      pipes.step(1);
      const after = (scene.children.find((c) => (c as THREE.InstancedMesh).renderOrder === 1) as THREE.InstancedMesh | undefined)?.count ?? 0;
      pipes.dispose();
      return ok('a core paints as far as its filled length, and a pulse cuts on arrival',
        len === 2 && flying > 0 && after === 0, `len ${len}, ${flying} pulse quads → ${after}`);
    }),

    test('bus, core and ports draw under the tiles; pulses over them', () => {
      const scene = new THREE.Scene();
      const pipes = createPipes(scene);
      const orders = scene.children.map((c) => c.renderOrder).sort((a, b) => a - b);
      pipes.dispose();
      return eq('bus, core and ports draw under the tiles; pulses over them', orders, [-1, -1, -1, 1]);
    }),
  ],
} satisfies TestModule;
