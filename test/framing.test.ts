/**
 * framing.ts — where a flight lands when windows stand in front.
 *
 * The claims are geometric and cheap to check exactly: with no window the
 * answer is the centre, coordinate for coordinate; with a window over the
 * centre the target's screen rectangle touches no window and stays on the
 * glass; with several, the same; with the glass nearly covered, the camera
 * backs off no more than `ZOOM_OUT_MAX`, and when even that cannot clear
 * it, more of the target shows than the centre would have shown.
 */

import {
  aim, CLEAR_MARGIN, coveredArea, freeRects, projectBox, worldPerPixelAt, ZOOM_OUT_MAX, type Box, type Rect, type View,
} from '../src/ui/field/framing.ts';
import { TILE_H, TILE_W } from '../src/ui/field/layout.ts';
import { eq, near, ok, test, type TestModule } from './harness.ts';

const VIEW: View = { w: 1200, h: 818 };
/** A tile at a spot, the box `field.flyTo` flies to, at its default distance. */
const tile = (x: number, y: number): Box => ({ minX: x - TILE_W / 2, maxX: x + TILE_W / 2, minY: y - TILE_H / 2, maxY: y + TILE_H / 2 });
const Z = 4.2;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
function onGlass(r: Rect, v: View): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= v.w && r.y + r.h <= v.h;
}
/** Every window the target rectangle touches, by index. */
function touched(r: Rect, obs: Rect[]): number[] {
  return obs.map((o, i) => (overlaps(r, o) ? i : -1)).filter((i) => i >= 0);
}

export default {
  suite: 'framing',
  tests: [
    test('no windows: the centre, as before', () => {
      const t = tile(3, -2);
      const a = aim(t, Z, VIEW, []);
      const r = projectBox(t, a, VIEW);
      return [
        eq('aim x', a.x, 3), eq('aim y', a.y, -2), eq('aim z', a.z, Z),
        near('centred on the glass (x)', r.x + r.w / 2, VIEW.w / 2, 1e-9),
        near('centred on the glass (y)', r.y + r.h / 2, VIEW.h / 2, 1e-9),
      ].find((x) => !x.pass) ?? ok('all', true);
    }),

    test('no windows: framing a fleet is the centre too', () => {
      const b: Box = { minX: -20, maxX: 14, minY: -9, maxY: 11 };
      const a = aim(b, 60, VIEW, []);
      return ok('unchanged', a.x === -3 && a.y === 1 && a.z === 60, JSON.stringify(a));
    }),

    test('a window off to the side that does not cover the centre changes nothing', () => {
      const t = tile(0, 0);
      const obs: Rect[] = [{ x: 0, y: 0, w: 200, h: 150 }];
      const a = aim(t, Z, VIEW, obs);
      return ok('unchanged', a.x === 0 && a.y === 0 && a.z === Z, JSON.stringify(a));
    }),

    test('one window over the centre: the tile slides into the clear at the same zoom', () => {
      const t = tile(5, 1);
      // A 560×480 terminal in front, over the middle of the glass, with room
      // for a tile —363 px wide at this distance— to its right.
      const obs: Rect[] = [{ x: 200, y: 160, w: 560, h: 480 }];
      const naive = projectBox(t, { x: 5, y: 1, z: Z }, VIEW);
      const a = aim(t, Z, VIEW, obs);
      const r = projectBox(t, a, VIEW);
      return [
        ok('the naive centring would be behind the window', overlaps(naive, obs[0]!)),
        eq('same distance', a.z, Z),
        ok('the tile touches no window', touched(r, obs).length === 0, JSON.stringify(r)),
        ok('and stays on the glass', onGlass(r, VIEW), JSON.stringify(r)),
        ok('the margin holds', !touched({ x: r.x - CLEAR_MARGIN + 1, y: r.y - CLEAR_MARGIN + 1, w: r.w + 2 * CLEAR_MARGIN - 2, h: r.h + 2 * CLEAR_MARGIN - 2 }, obs).length),
        ok('the camera moved the least it could: just right of the window, not the far corner',
          r.x >= 760 + CLEAR_MARGIN - 1e-6 && r.x < 760 + CLEAR_MARGIN + 1e-6, JSON.stringify(r)),
        near('and kept its height on the glass', r.y + r.h / 2, VIEW.h / 2, 1e-6),
      ].find((x) => !x.pass) ?? ok('all', true);
    }),

    test('a window on the left half: the tile lands in the right half, level with the centre', () => {
      const t = tile(-2, 7);
      const obs: Rect[] = [{ x: 0, y: 0, w: 640, h: VIEW.h }];
      const a = aim(t, Z, VIEW, obs);
      const r = projectBox(t, a, VIEW);
      return [
        eq('same distance', a.z, Z),
        ok('clear of the window', !touched(r, obs).length, JSON.stringify(r)),
        near('kept its height on the glass', r.y + r.h / 2, VIEW.h / 2, 1e-6),
        ok('aim moved on x only', Math.abs(a.y - 7) < 1e-9 && a.x !== -2),
      ].find((x) => !x.pass) ?? ok('all', true);
    }),

    test('several windows: the tile finds the hole between them', () => {
      const t = tile(0, 0);
      // A terminal on the left, a panel top-right, a strip along the bottom
      // right: the only clear room of tile size is the middle-right.
      const obs: Rect[] = [
        { x: 0, y: 0, w: 560, h: VIEW.h },
        { x: 560, y: 0, w: 640, h: 180 },
        { x: 560, y: 700, w: 640, h: 118 },
      ];
      const a = aim(t, Z, VIEW, obs);
      const r = projectBox(t, a, VIEW);
      return [
        eq('same distance', a.z, Z),
        ok('clear of every window', !touched(r, obs).length, JSON.stringify(r)),
        ok('on the glass', onGlass(r, VIEW)),
        ok('in the middle-right hole', r.x >= 560 && r.y >= 180 && r.y + r.h <= 700, JSON.stringify(r)),
      ].find((x) => !x.pass) ?? ok('all', true);
    }),

    test('a hole too small at this zoom: the camera backs off, no more than ZOOM_OUT_MAX, and clears it', () => {
      const t = tile(0, 0);
      const wpp = worldPerPixelAt(Z, VIEW.h);
      const tileW = TILE_W / wpp;
      // Leave a strip on the right narrower than the tile but wide enough for it at 1.5×.
      const strip = Math.round(tileW / 1.4) + 2 * CLEAR_MARGIN;
      const obs: Rect[] = [{ x: 0, y: 0, w: VIEW.w - strip, h: VIEW.h }];
      const a = aim(t, Z, VIEW, obs);
      const r = projectBox(t, a, VIEW);
      return [
        ok('backed off', a.z > Z, String(a.z)),
        ok('within the cap', a.z <= Z * ZOOM_OUT_MAX + 1e-9, String(a.z)),
        ok('the smallest step that fits (1.5×, not 2×)', Math.abs(a.z - Z * 1.5) < 1e-9, String(a.z)),
        ok('clear of the window', !touched(r, obs).length, JSON.stringify(r)),
        ok('on the glass', onGlass(r, VIEW), JSON.stringify(r)),
      ].find((x) => !x.pass) ?? ok('all', true);
    }),

    test('nothing clears it: the tile sits on the largest free room and shows more than centred', () => {
      const t = tile(0, 0);
      // Windows over almost all the glass; the largest gap is a 90px band at the bottom.
      const obs: Rect[] = [
        { x: 0, y: 0, w: 700, h: VIEW.h - 90 },
        { x: 700, y: 0, w: 500, h: VIEW.h - 30 },
      ];
      const naive = projectBox(t, { x: 0, y: 0, z: Z }, VIEW);
      const a = aim(t, Z, VIEW, obs);
      const r = projectBox(t, a, VIEW);
      const shown = (x: Rect) => x.w * x.h - coveredArea(x, obs);
      return [
        eq('distance kept: from twice as far it would still be covered', a.z, Z),
        ok('more of it shows than the centre would show', shown(r) > shown(naive), `${shown(r)} vs ${shown(naive)}`),
        ok('it is on the bottom-left band', r.y + r.h > VIEW.h - 90 && r.x + r.w <= 700 + 1e-6, JSON.stringify(r)),
      ].find((x) => !x.pass) ?? ok('all', true);
    }),

    test('a window over the whole glass: the centre, there is nowhere else', () => {
      const t = tile(1, 1);
      const a = aim(t, Z, VIEW, [{ x: -10, y: -10, w: VIEW.w + 20, h: VIEW.h + 20 }]);
      return ok('centred', a.x === 1 && a.y === 1 && a.z === Z, JSON.stringify(a));
    }),

    test('framing a fleet with a window on half the glass backs off so the fleet fits the other half', () => {
      // The fleet's box would fill the glass at z=40 and change nothing without windows.
      const b: Box = { minX: -10, maxX: 10, minY: -8, maxY: 8 };
      const z = 40;
      const obs: Rect[] = [{ x: 0, y: 0, w: 600, h: VIEW.h }];
      const a = aim(b, z, VIEW, obs);
      const r = projectBox(b, a, VIEW);
      return [
        ok('backed off', a.z > z, String(a.z)),
        ok('within the cap', a.z <= z * ZOOM_OUT_MAX + 1e-9),
        ok('clear of the window', !touched(r, obs).length, JSON.stringify(r)),
        ok('on the glass', onGlass(r, VIEW), JSON.stringify(r)),
      ].find((x) => !x.pass) ?? ok('all', true);
    }),

    test('freeRects: one window in the middle leaves four maximal rooms', () => {
      const rooms = freeRects(VIEW, [{ x: 400, y: 300, w: 300, h: 200 }]);
      const has = (r: Rect) => rooms.some((x) => x.x === r.x && x.y === r.y && x.w === r.w && x.h === r.h);
      return [
        eq('four', rooms.length, 4),
        ok('left band', has({ x: 0, y: 0, w: 400, h: 818 })),
        ok('right band', has({ x: 700, y: 0, w: 500, h: 818 })),
        ok('top band', has({ x: 0, y: 0, w: 1200, h: 300 })),
        ok('bottom band', has({ x: 0, y: 500, w: 1200, h: 318 })),
      ].find((x) => !x.pass) ?? ok('all', true);
    }),

    test('coveredArea counts overlapping windows once', () => {
      const r: Rect = { x: 0, y: 0, w: 100, h: 100 };
      const a = coveredArea(r, [{ x: 0, y: 0, w: 60, h: 100 }, { x: 40, y: 0, w: 60, h: 100 }]);
      const b = coveredArea(r, [{ x: 200, y: 200, w: 50, h: 50 }]);
      return [eq('union, not sum', a, 10000), eq('nothing over it', b, 0)].find((x) => !x.pass) ?? ok('all', true);
    }),
  ],
} satisfies TestModule;
