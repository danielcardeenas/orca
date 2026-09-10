/**
 * Los ganchos de gesto montados solos, para test/gestures-dom.test.ts: un
 * gestor de ventanas con una clase de mentira y la barra de secciones con dos
 * paneles vacíos. Lo que se comprueba es el cableado real: que abrir cuenta,
 * que enfocar y restaurar no, y que lo contado sale como un solo lote.
 */
import { WindowManager } from '../src/ui/windows/wm.ts';
import { mountSections, type SectionsHandle } from '../src/ui/hud/sections.ts';
import { flushGestures, mountGestures } from '../src/ui/gestures.ts';

/** Lo que salió hacia el «hub». Cada entrada, un lote. */
export const batches: Record<string, number>[] = [];
export let linkUp = true;
export function setLink(up: boolean) { linkUp = up; }
mountGestures((counts) => { if (!linkUp) return false; batches.push(counts); return true; });
export const flush = flushGestures;

const app = document.createElement('div');
app.id = 'app';
document.body.appendChild(app);

export const wm = new WindowManager(app, {
  tileRect: () => null,
  onTray: () => {},
  onFocus: () => {},
});
// Una sola clase de mentira sirve para todas: lo que se cuenta es `spec.kind`.
for (const kind of ['help', 'terminal', 'gallery'] as const) wm.register(kind, () => {});

const dock = document.createElement('div');
document.body.appendChild(dock);
const missions = document.createElement('section');
const improve = document.createElement('section');
document.body.append(missions, improve);
export const sections: SectionsHandle = mountSections(dock, { missions, improve });

/** Deja una sesión guardada, como la dejaría una consola cerrada con ventanas. */
export function saveSession(kinds: string[]) {
  localStorage.setItem('orca.windows.v2', JSON.stringify(kinds.map((kind, i) => ({
    spec: { kind, key: `saved:${kind}:${i}`, callsign: kind.toUpperCase() }, x: 40 + i * 20, y: 80, w: 320, h: 200, minimized: false,
  }))));
}
