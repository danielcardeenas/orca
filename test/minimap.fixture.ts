/**
 * The minimap with a field that is only what the map needs: bounds, a
 * viewport, and a window manager with real seats. The radar draws four kinds
 * of thing (regions, agents, canvas windows, the viewport) and this fixture
 * exists for the third — the one nothing else in the suite can see, because
 * the field itself never draws a window.
 */
import { mountMinimap } from '../src/ui/hud/minimap.ts';
import { WindowManager } from '../src/ui/windows/wm.ts';
import type { Console } from '../src/ui/console.ts';

export const plane = { origin: { x: 600, y: 400 }, ppu: 40 };
/** The world rectangle the camera is looking at, in world units. */
export const view = { minX: -8, minY: -6, maxX: 8, maxY: 6 };

export const wm = new WindowManager(document.body, {
  tileRect: () => null,
  onTray() {}, onFocus() {},
  plane: () => plane,
});
wm.register('help', ({ body }) => { body.textContent = 'seat'; });

const layout = { spots: new Map(), regions: [], trays: [], order: new Map(), bounds: { minX: -8, minY: -6, maxX: 8, maxY: 6 } };
export const c = {
  wm,
  field: {
    layout: () => layout,
    viewRect: () => ({ ...view }),
    flyToPoint() {},
  },
  pushView() {},
} as unknown as Console;

export const map = mountMinimap(document.body, c);

/** One window on the canvas, seated where the caller says, in world units. */
export function seat(key: string, x: number, y: number) {
  const w = wm.open({ kind: 'help', key, callsign: key.toUpperCase(), w: 200, h: 160 });
  wm.returnToCanvas(w);
  w.canvas = { x, y, ppu: plane.ppu };
  wm.reproject();
  return w;
}

/** Pixels of one exact colour on the map: how the suite reads what was drawn. */
export function count(hex: string): number {
  const canvas = document.querySelector<HTMLCanvasElement>('.mmap [data-mm]')!;
  const g = canvas.getContext('2d')!;
  const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
  const r = parseInt(hex.slice(1, 3), 16), gg = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] === r && d[i + 1] === gg && d[i + 2] === b) n++;
  return n;
}

/**
 * One frame of the console's loop, in the order `main.ts` runs it: the
 * manager reprojects every window against the camera, and then the map
 * redraws if anything it reads has moved.
 */
export function tick() { wm.reproject(); map.tick(); }
