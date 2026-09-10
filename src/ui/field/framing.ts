/**
 * Where a flight lands when windows are in the way.
 *
 * A flight used to be one sentence: put the target in the middle of the
 * glass. With a terminal or a panel standing in front — `front` and `pinned`
 * windows live in screen pixels and do not move with the camera — the middle
 * of the glass is often exactly what is covered, and the operator flew to a
 * tile only to find it behind the window they flew from.
 *
 * This is the pure arithmetic of that decision, in screen space, with no
 * three.js and no DOM so it can be run exhaustively. `aim` takes the world
 * box the flight is for, the distance the caller wanted, the viewport and
 * the rectangles of the windows in front, and answers where the camera has
 * to look —and how far back— for the box to be seen:
 *
 *   1. no windows, or the centred box is already clear:   the centre, as before;
 *   2. some free rectangle holds the box at this zoom:      the box slides into
 *      the one nearest the centre, moving as little as it can;
 *   3. none does, but one would with the camera backed off  up to `ZOOM_OUT_MAX`:
 *      the smallest step back that clears it;
 *   4. nothing clears it (windows over nearly all the glass): the box sits on
 *      the largest free rectangle, where the most of it shows.
 *
 * Rule 1 is the contract with the flights that never had windows in the way:
 * with nothing in front, nothing here changes a coordinate.
 *
 * Screen rectangles are `x`/`y` top-left, `y` down, pixels of the field's
 * canvas. World boxes are `y` up, as the plane is.
 */

export const FOV = 30;
/** Pixels kept between the target and any window edge, so it reads as clear. */
export const CLEAR_MARGIN = 16;
/** How far back the camera will go to find a clear place, as a factor on the distance. */
export const ZOOM_OUT_MAX = 2;
/** The steps between 1 and `ZOOM_OUT_MAX` a flight tries, smallest first. */
const ZOOM_STEPS = [1, 1.25, 1.5, 1.75, 2];

export interface Rect { x: number; y: number; w: number; h: number }
export interface Box { minX: number; minY: number; maxX: number; maxY: number }
export interface View { w: number; h: number }
/** A camera destination: where to look on the plane, and from how far. */
export interface Aim { x: number; y: number; z: number }

/** World units per screen pixel on the plane, at distance `z`, on a canvas `h` pixels high. */
export function worldPerPixelAt(z: number, h: number): number {
  return (2 * Math.tan((FOV * Math.PI) / 360) * z) / Math.max(1, h);
}

/** The screen rectangle a world box occupies when the camera sits at `aim`. */
export function projectBox(b: Box, aim: Aim, view: View): Rect {
  const wpp = worldPerPixelAt(aim.z, view.h);
  const cx = view.w / 2 + ((b.minX + b.maxX) / 2 - aim.x) / wpp;
  const cy = view.h / 2 - ((b.minY + b.maxY) / 2 - aim.y) / wpp;
  const w = (b.maxX - b.minX) / wpp, h = (b.maxY - b.minY) / wpp;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function clip(r: Rect, view: View): Rect | null {
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
  const x1 = Math.min(view.w, r.x + r.w), y1 = Math.min(view.h, r.y + r.h);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function inside(px: number, py: number, r: Rect): boolean {
  return px > r.x && px < r.x + r.w && py > r.y && py < r.y + r.h;
}

function uniqSorted(vals: number[]): number[] {
  return [...new Set(vals)].sort((a, b) => a - b);
}

/**
 * The part of `r` that lies under the union of `obstacles`, in square pixels.
 * The rectangles' edges cut `r` into cells; a cell is covered or it is not,
 * so the sum is exact whatever the overlap between the obstacles.
 */
export function coveredArea(r: Rect, obstacles: Rect[]): number {
  const obs = obstacles.map((o) => clip(o, { w: Infinity, h: Infinity })).filter((o): o is Rect => !!o);
  if (!obs.length) return 0;
  const xs = uniqSorted([r.x, r.x + r.w, ...obs.flatMap((o) => [o.x, o.x + o.w])].filter((v) => v >= r.x && v <= r.x + r.w));
  const ys = uniqSorted([r.y, r.y + r.h, ...obs.flatMap((o) => [o.y, o.y + o.h])].filter((v) => v >= r.y && v <= r.y + r.h));
  let sum = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const mx = (xs[i]! + xs[i + 1]!) / 2, my = (ys[j]! + ys[j + 1]!) / 2;
      if (obs.some((o) => inside(mx, my, o))) sum += (xs[i + 1]! - xs[i]!) * (ys[j + 1]! - ys[j]!);
    }
  }
  return sum;
}

/**
 * The maximal empty rectangles of the viewport: every axis-aligned rectangle
 * touching no obstacle that cannot grow in any direction without touching
 * one. Their number is small for the handful of windows a console holds,
 * and each is a place a target could be put whole.
 */
export function freeRects(view: View, obstacles: Rect[]): Rect[] {
  const obs = obstacles.map((o) => clip(o, view)).filter((o): o is Rect => !!o);
  if (!obs.length) return [{ x: 0, y: 0, w: view.w, h: view.h }];
  const xs = uniqSorted([0, view.w, ...obs.flatMap((o) => [o.x, o.x + o.w])]);
  const ys = uniqSorted([0, view.h, ...obs.flatMap((o) => [o.y, o.y + o.h])]);
  const nx = xs.length - 1, ny = ys.length - 1;
  // blocked[i][j] for the cell between xs[i..i+1] × ys[j..j+1]; a prefix sum
  // makes "is this span of cells all free" one subtraction.
  const pre: number[][] = Array.from({ length: nx + 1 }, () => new Array<number>(ny + 1).fill(0));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const mx = (xs[i]! + xs[i + 1]!) / 2, my = (ys[j]! + ys[j + 1]!) / 2;
      const b = obs.some((o) => inside(mx, my, o)) ? 1 : 0;
      pre[i + 1]![j + 1] = b + pre[i]![j + 1]! + pre[i + 1]![j]! - pre[i]![j]!;
    }
  }
  const blockedIn = (i0: number, j0: number, i1: number, j1: number) =>
    pre[i1]![j1]! - pre[i0]![j1]! - pre[i1]![j0]! + pre[i0]![j0]! > 0;
  const out: Rect[] = [];
  for (let i0 = 0; i0 < nx; i0++) {
    for (let i1 = i0 + 1; i1 <= nx; i1++) {
      for (let j0 = 0; j0 < ny; j0++) {
        for (let j1 = j0 + 1; j1 <= ny; j1++) {
          if (blockedIn(i0, j0, i1, j1)) continue;
          // Maximal: no free strip to add on any side.
          if (i0 > 0 && !blockedIn(i0 - 1, j0, i0, j1)) continue;
          if (i1 < nx && !blockedIn(i1, j0, i1 + 1, j1)) continue;
          if (j0 > 0 && !blockedIn(i0, j0 - 1, i1, j0)) continue;
          if (j1 < ny && !blockedIn(i0, j1, i1, j1 + 1)) continue;
          out.push({ x: xs[i0]!, y: ys[j0]!, w: xs[i1]! - xs[i0]!, h: ys[j1]! - ys[j0]! });
        }
      }
    }
  }
  return out;
}

/** Slide a `w`×`h` rectangle wanted at (`x`,`y`) into `room`, moving it the least. */
function clampInto(x: number, y: number, w: number, h: number, room: Rect): { x: number; y: number } {
  const cx = room.w >= w ? Math.min(Math.max(x, room.x), room.x + room.w - w) : room.x + (room.w - w) / 2;
  const cy = room.h >= h ? Math.min(Math.max(y, room.y), room.y + room.h - h) : room.y + (room.h - h) / 2;
  return { x: cx, y: cy };
}

function shrink(r: Rect, m: number): Rect {
  return { x: r.x + m, y: r.y + m, w: r.w - 2 * m, h: r.h - 2 * m };
}

/**
 * Where the camera should look so `target` is seen with `obstacles` in
 * front. `z` is the distance the caller wanted; the answer keeps it unless
 * backing off (never more than `ZOOM_OUT_MAX`) is the only way to clear the
 * windows. With no obstacle, the answer is the centre of the box at `z`,
 * exactly as a flight always was.
 */
export function aim(target: Box, z: number, view: View, obstacles: Rect[]): Aim {
  const tx = (target.minX + target.maxX) / 2, ty = (target.minY + target.maxY) / 2;
  const centred: Aim = { x: tx, y: ty, z };
  const obs = obstacles.map((o) => clip(o, view)).filter((o): o is Rect => !!o);
  if (!obs.length) return centred;
  const at = projectBox(target, centred, view);
  if (coveredArea(at, obs) === 0) return centred;

  const free = freeRects(view, obs);
  const vcx = view.w / 2, vcy = view.h / 2;
  const aimFor = (r: Rect, zz: number): Aim => {
    const wpp = worldPerPixelAt(zz, view.h);
    return { x: tx - (r.x + r.w / 2 - vcx) * wpp, y: ty + (r.y + r.h / 2 - vcy) * wpp, z: zz };
  };
  const off = (r: Rect) => Math.hypot(r.x + r.w / 2 - vcx, r.y + r.h / 2 - vcy);

  // 2 and 3: a free rectangle that holds the whole box, at this zoom if any
  // does, else at the smallest step back that makes one hold it.
  for (const f of ZOOM_STEPS) {
    if (f > ZOOM_OUT_MAX) break;
    const zz = z * f;
    const box = projectBox(target, { x: tx, y: ty, z: zz }, view);
    let best: { r: Rect; d: number } | null = null;
    for (const room of free) {
      const inner = shrink(room, CLEAR_MARGIN);
      if (inner.w < box.w || inner.h < box.h) continue;
      const p = clampInto(box.x, box.y, box.w, box.h, inner);
      const r = { x: p.x, y: p.y, w: box.w, h: box.h };
      const d = off(r);
      if (!best || d < best.d) best = { r, d };
    }
    if (best) return aimFor(best.r, zz);
  }

  // 4: nothing holds it. The most of it shows sitting on the largest free
  // rectangle; ties go to the one that moves the camera least.
  let best: { r: Rect; shown: number; d: number } = { r: at, shown: at.w * at.h - coveredArea(at, obs), d: 0 };
  for (const room of [...free].sort((a, b) => b.w * b.h - a.w * a.h)) {
    const p = clampInto(room.x + (room.w - at.w) / 2, room.y + (room.h - at.h) / 2, at.w, at.h, { x: 0, y: 0, w: view.w, h: view.h });
    const r = { x: p.x, y: p.y, w: at.w, h: at.h };
    const shown = at.w * at.h - coveredArea(r, obs);
    const d = off(r);
    if (shown > best.shown + 0.5 || (Math.abs(shown - best.shown) <= 0.5 && d < best.d)) best = { r, shown, d };
  }
  return aimFor(best.r, z);
}
