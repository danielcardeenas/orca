/**
 * El navegador de archivos montado solo, para test/file-browser.test.ts: un
 * gestor de ventanas de verdad con la clase `files`, un hub de mentira detrás
 * de `fetch` que sirve un árbol fijo, y una consola de mentira que apunta lo
 * que se le pidió abrir. Lo que se comprueba son las teclas de vim contra el
 * DOM real y que el menú de un proyecto ofrezca la fila.
 */
import { WindowManager, type Win } from '../src/ui/windows/wm.ts';
import { mountFiles } from '../src/ui/windows/kinds/files.ts';
import { showContext } from '../src/ui/hud/context.ts';
import { store } from '../src/ui/store.ts';
import type { Console } from '../src/ui/console.ts';
import type { Project } from '../src/shared/types.ts';
import type { NavEntry } from '../src/ui/windows/file-nav.ts';

export const ROOT = '/proj';

/** El árbol que el «hub» sirve. Sin `.env` ni `.git`: el hub real ya los oculta. */
const TREE: Record<string, NavEntry[]> = {
  '/proj': [
    { name: 'src', kind: 'dir', size: null, mtime: 1 },
    { name: 'test', kind: 'dir', size: null, mtime: 1 },
    { name: 'README.md', kind: 'file', size: 1200, mtime: 1 },
    { name: 'package.json', kind: 'file', size: 800, mtime: 1 },
    { name: 'leak', kind: 'other', size: null, mtime: null },
  ],
  '/proj/src': [
    { name: 'ui', kind: 'dir', size: null, mtime: 1 },
    { name: 'a.ts', kind: 'file', size: 10, mtime: 1 },
    { name: 'b.ts', kind: 'file', size: 20, mtime: 1 },
  ],
  '/proj/src/ui': [
    { name: 'main.ts', kind: 'file', size: 30, mtime: 1 },
  ],
  '/proj/test': [],
};

/** Cada carpeta que la ventana pidió al «hub», en orden. */
export const asked: string[] = [];
/** Lo que la consola de mentira abrió. */
export const opened: { path: string; project?: string | null }[] = [];
export const notes: string[] = [];
export const browsed: string[] = [];

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.pathname !== '/api/dir') return realFetch(input, init);
  const path = url.searchParams.get('path') ?? '';
  asked.push(path);
  const entries = TREE[path];
  if (!entries) return new Response(path.startsWith('/proj') ? 'no existe' : 'fuera de las raíces de proyecto conocidas', { status: path.startsWith('/proj') ? 404 : 403 });
  return new Response(JSON.stringify({ ok: true, path, entries, truncated: false }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const app = document.createElement('div');
app.id = 'app';
document.body.appendChild(app);

export const wm = new WindowManager(app, {
  tileRect: () => null,
  onTray: () => {},
  onFocus: () => {},
});

const c = {
  wm,
  note: (t: string) => notes.push(t),
  openFile: (f: { path: string; project?: string | null }) => opened.push(f),
  openFiles: (id: string) => browsed.push(id),
  field: { spotOf: () => null, regionMoved: () => false, select() {}, frameProject() {} },
  pushView() {},
  openProject() {}, openSpawn() {}, stop: async () => {},
} as unknown as Console;

wm.register('files', (ctx) => mountFiles(ctx, c));
// Lo que main.ts hace con cada tecla antes que nadie: dársela a la ventana activa.
window.addEventListener('keydown', (e) => { wm.handleKey(e); });

export function open(): Win {
  return wm.open({ kind: 'files', key: `files:${ROOT}`, callsign: 'PJ', project: 'FILES', title: 'proj', params: { root: ROOT, project: 'PJ' } });
}

export function state() {
  const w = wm.all()[0];
  const st = (w?.inst?.state?.() ?? null) as { dir: string; cursor: number; filter: string; entries: string[]; current: string | null } | null;
  return {
    windows: wm.all().length,
    ...st,
    rows: [...document.querySelectorAll<HTMLElement>('.fb__row .fb__name')].map((n) => n.textContent),
    cur: document.querySelector<HTMLElement>('.fb__row.is-cur .fb__name')?.textContent ?? null,
    path: document.querySelector<HTMLElement>('[data-path]')?.textContent ?? '',
    title: document.querySelector<HTMLElement>('.win__title')?.textContent ?? '',
    finding: document.activeElement?.matches('[data-filter]') ?? false,
    findbar: !(document.querySelector<HTMLElement>('[data-findbar]')?.hidden ?? true),
    asked: [...asked], opened: [...opened], notes: [...notes],
  };
}

/** El menú de un proyecto que el mundo conoce. */
export function projectMenu(): string[] {
  const p = { id: 'p1', machineId: 'm1', slug: '-proj', name: 'proj', path: ROOT, code: 'PJ', gitBranch: 'main', gitDirty: false, sessionIds: [], keys: [] } as unknown as Project;
  store.world.projects[p.id] = p;
  showContext({ c, sayTo() {}, toggleTilt() {} }, { kind: 'project', id: p.id }, { x: 40, y: 40 });
  return [...document.querySelectorAll<HTMLElement>('.ctx__item b')].map((b) => b.textContent ?? '');
}

/** Pulsa una fila; el menú la ejecuta tras un compás de animación, así que se espera. */
export async function pickMenu(label: string): Promise<string[]> {
  const b = [...document.querySelectorAll<HTMLElement>('.ctx__item')].find((el) => el.querySelector('b')?.textContent === label);
  b?.click();
  for (let i = 0; i < 40 && !browsed.length; i++) await new Promise((r) => setTimeout(r, 50));
  return [...browsed];
}
