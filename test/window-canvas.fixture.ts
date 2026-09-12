import { WindowManager } from '../src/ui/windows/wm.ts';
import { mountTray } from '../src/ui/hud/tray.ts';
import { mountFile } from '../src/ui/windows/kinds/file.ts';
import { lockPageZoom } from '../src/ui/zoom-lock.ts';
// La barrera del zoom nativo, puesta como en la consola real: lo que esta
// suite comprueba del visor de imágenes sólo vale con ella delante.
lockPageZoom();
export const plane = { origin: { x: 600, y: 400 }, ppu: 40 };
export let mounts = 0;
export const located: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = [];
/** Pinches the windows handed to the field. */
export let zooms = 0;
/** What the windows could not scroll, handed to the field as a pan. */
export const panned: Array<{ dx: number; dy: number }> = [];
let tray: ReturnType<typeof mountTray> | undefined;
/** Where the anchor tile is on the glass; the suite moves it off screen. */
export const tile = { x: 250, y: 200, w: 180, h: 140, visible: true, ahead: true };
export const wm = new WindowManager(document.body, {
  tileRect: () => ({ ...tile }),
  agentOrigin: () => ({ x: 1.5, y: 1 }),
  onLocateWindow: bounds => {
    located.push(bounds);
    plane.ppu = Math.min((window.innerWidth - 160) / (bounds.maxX - bounds.minX),
      (window.innerHeight - 260) / (bounds.maxY - bounds.minY));
    plane.origin.x = window.innerWidth / 2 - (bounds.minX + bounds.maxX) / 2 * plane.ppu;
    plane.origin.y = (window.innerHeight + 12) / 2 + (bounds.minY + bounds.maxY) / 2 * plane.ppu;
  },
  plane: () => plane, onFocus() {}, onTray: () => tray?.render(),
  onZoom: () => { zooms++; },
  onPan: (dx, dy) => { panned.push({ dx, dy }); },
});
wm.register('file', (ctx) => mountFile(ctx, {} as never));
wm.register('help', ({ body }) => {
  mounts++;
  body.innerHTML = '<textarea aria-label="Draft" style="height:120px">Keep this draft</textarea><div class="win__scroll">' + '<p>Persistent scroll content</p>'.repeat(70) + '</div><iframe title="Preview" srcdoc="<input value=original>"></iframe>';
});
const dock = document.createElement('div'); dock.className = 'dock'; document.body.appendChild(dock);
tray = mountTray(dock, wm);
export const win = wm.open({ kind: 'help', key: 'canvas-fixture', callsign: 'WORK', title: 'Canvas workspace', w: 420, h: 430 });
/** What a window wears when it opens. This suite is about the canvas, so it sends it there. */
export const openedMode = win.mode;
wm.returnToCanvas(win);
wm.restoreSession(spec => wm.open(spec));
function frame() { wm.reproject(); requestAnimationFrame(frame); }
frame();
