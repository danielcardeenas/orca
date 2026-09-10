/**
 * Un proyecto, carpeta a carpeta, con las teclas de vim.
 *
 * Se abre desde el menú de un proyecto (BROWSE FILES) y enseña lo que hay en
 * su carpeta en disco: una columna de nombres, carpetas primero, y un cursor.
 * El hub lista cada carpeta por `/api/dir` (hub/files.ts decide qué se lista
 * y qué no; lo que no serviría, no aparece) y abrir un archivo es el visor de
 * siempre (kinds/file.ts), en su propia ventana, delante de ésta.
 *
 * Las teclas, mientras la ventana tiene el foco y nadie está escribiendo:
 *
 *   j / k  ↓ / ↑     mover el cursor           gg / G     principio / final
 *   l / ↵  →         entrar, o abrir           ^d / ^u    media página
 *   h  ←             subir una carpeta         /          filtrar por nombre
 *   q                cerrar                    Esc        lo de siempre en una ventana
 *
 * La raíz del proyecto es una pared: `h` en ella no hace nada, y el navegador
 * nunca pide al hub una ruta que no cuelgue de ella. Sólo lectura a propósito:
 * es un sitio para mirar un repo mientras los agentes trabajan en él, no un
 * editor, y nada de lo que se pulsa aquí escribe en disco.
 *
 * Las teclas con botón —UP, OPEN, FIND— las despacha el gestor de ventanas
 * por `data-key`, como en cualquier otra ventana; las que no tienen botón
 * (j, k, gg, G, q, ^d, ^u, flechas) se escuchan aquí en fase de captura, que
 * es antes de que main.ts las dé por suyas, y sólo con el foco.
 */

import type { Console } from '../../console.ts';
import { keyToken, type WinCtx } from '../wm.ts';
import { esc } from '../../util.ts';
import { typing } from '../../keys.ts';
import { authedUrl } from '../../net/client.ts';
import { slabFlash } from '../fx.ts';
import { baseName } from '../paths.ts';
import { refusal } from './file.ts';
import { FileNav, joinPath, type NavAction, type NavEntry } from '../file-nav.ts';

/** Teclas que tienen botón: las despacha wm.ts, no el oyente de aquí. */
const BUTTON_KEYS = new Set(['h', 'l', 'enter', '/', 'shift+/']);

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface DirReply { ok: true; path: string; entries: NavEntry[]; truncated: boolean }

export function mountFiles(ctx: WinCtx, c: Console) {
  const params = ctx.win.spec.params ?? {};
  const root = params.root ?? '';
  const project = params.project;
  const nav = new FileNav(root, params.dir);
  const body = ctx.body;
  body.classList.add('fb-workspace');
  ctx.setCallsign(project ?? 'FILES', project ? 'FILES' : undefined);

  body.innerHTML = `
    <div class="fb__bar">
      <span class="fb__path mono" data-path></span>
      <div class="row">
        <span class="px px--tiny" data-meta>LOADING…</span>
        <button class="btn" type="button" data-up data-key="h" title="Up one folder">UP</button>
        <button class="btn" type="button" data-enter data-key="l enter" title="Enter the folder, or open the file">OPEN</button>
        <button class="btn" type="button" data-find data-key="/" title="Filter this folder by name">FIND</button>
      </div>
    </div>
    <div class="fb__find" data-findbar hidden>
      <span class="mono fb__slash">/</span>
      <input class="fb__input mono" data-filter type="text" spellcheck="false" autocomplete="off" placeholder="filter this folder · ↵ keeps it · esc clears" />
    </div>
    <div class="fb__list mono" data-list role="listbox" tabindex="-1"></div>
    <div class="fb__foot px px--tiny" data-foot><kbd>j</kbd><kbd>k</kbd> MOVE · <kbd>l</kbd> OPEN · <kbd>h</kbd> UP · <kbd>gg</kbd> <kbd>G</kbd> ENDS · <kbd>/</kbd> FIND · <kbd>q</kbd> CLOSE</div>
  `;
  const pathEl = body.querySelector<HTMLElement>('[data-path]')!;
  const meta = body.querySelector<HTMLElement>('[data-meta]')!;
  const list = body.querySelector<HTMLElement>('[data-list]')!;
  const findbar = body.querySelector<HTMLElement>('[data-findbar]')!;
  const input = body.querySelector<HTMLInputElement>('[data-filter]')!;
  const upBtn = body.querySelector<HTMLButtonElement>('[data-up]')!;
  const enterBtn = body.querySelector<HTMLButtonElement>('[data-enter]')!;
  const findBtn = body.querySelector<HTMLButtonElement>('[data-find]')!;
  let disposed = false;
  let loading = 0;
  let truncated = false;
  let failed: string | null = null;

  /* ── pintar ─────────────────────────────────────────────────────── */

  function paintPath() {
    const rel = nav.relative();
    pathEl.innerHTML = `<b>${esc(baseName(root))}</b>${rel ? `<span class="fb__rel">/${esc(rel)}</span>` : ''}`;
    pathEl.title = nav.dir;
    ctx.setTitle(rel ? rel.split('/').pop()! : baseName(root));
  }

  function paintMeta() {
    if (failed) { meta.textContent = failed; return; }
    const all = nav.entries.length;
    const shown = nav.visible().length;
    const parts: string[] = [];
    parts.push(nav.filter ? `${shown}/${all}` : `${all} ${all === 1 ? 'ITEM' : 'ITEMS'}`);
    if (truncated) parts.push('FIRST ONLY');
    if (loading) parts.push('LOADING…');
    meta.textContent = parts.join(' · ');
    // UP and OPEN stay live at the root and on a row that will not open: a
    // disabled button would swallow `h` and `l` in silence, and the note
    // that `act` writes is the answer the key deserves.
    upBtn.classList.toggle('is-dim', nav.atRoot());
    const cur = nav.current();
    enterBtn.classList.toggle('is-dim', !cur || cur.kind === 'other');
  }

  function paintList() {
    const rows = nav.visible();
    if (!rows.length) {
      list.innerHTML = `<p class="px px--tiny fb__msg${failed ? ' is-warn' : ''}">${esc(failed ?? (nav.filter ? 'NOTHING MATCHES' : loading ? 'LOADING…' : 'EMPTY FOLDER'))}</p>`;
      paintMeta();
      return;
    }
    list.innerHTML = rows.map((e, i) => {
      const cls = ['fb__row', `is-${e.kind}`, i === nav.cursor ? 'is-cur' : ''].filter(Boolean).join(' ');
      const tail = e.kind === 'dir' ? '/' : '';
      const side = e.kind === 'file' && e.size !== null ? bytes(e.size) : e.kind === 'other' ? 'NOT SERVED' : '';
      return `<div class="${cls}" role="option" aria-selected="${i === nav.cursor}" data-i="${i}"><span class="fb__name">${esc(e.name)}${tail}</span><span class="fb__side">${esc(side)}</span></div>`;
    }).join('');
    paintMeta();
    list.querySelector<HTMLElement>('.is-cur')?.scrollIntoView({ block: 'nearest' });
  }

  /** Sólo el cursor cambió: mover dos clases, no reescribir la lista. */
  function paintCursor() {
    const was = list.querySelector<HTMLElement>('.is-cur');
    const now = list.querySelector<HTMLElement>(`[data-i="${nav.cursor}"]`);
    if (was === now) return;
    was?.classList.remove('is-cur'); was?.setAttribute('aria-selected', 'false');
    now?.classList.add('is-cur'); now?.setAttribute('aria-selected', 'true');
    now?.scrollIntoView({ block: 'nearest' });
    paintMeta();
  }

  function paint() { paintPath(); paintList(); }

  /* ── cargar ─────────────────────────────────────────────────────── */

  async function load(dir: string, select?: string) {
    const url = authedUrl(`/api/dir?path=${encodeURIComponent(dir)}`)!;
    const gen = ++loading;
    failed = null;
    paintMeta();
    let res: Response;
    try { res = await fetch(url, { cache: 'no-store' }); } catch { if (!disposed && gen === loading) { loading = 0; failed = 'THE HUB DID NOT ANSWER'; paint(); } return; }
    if (disposed || gen !== loading) return;
    loading = 0;
    if (!res.ok) {
      failed = refusal(res.status, (await res.text().catch(() => '')).slice(0, 200));
      // Una carpeta que no se pudo abrir no cambia dónde estamos, salvo que
      // sea la primera: entonces la ventana nace diciendo por qué está vacía.
      if (!nav.entries.length) nav.show(dir, []);
      paint();
      return;
    }
    const reply = await res.json() as DirReply;
    if (disposed || loading) return;
    truncated = reply.truncated;
    nav.show(dir, reply.entries, { select });
    if (params.dir !== nav.dir) params.dir = nav.dir;
    paint();
  }

  /* ── actuar ─────────────────────────────────────────────────────── */

  function act(a: NavAction) {
    switch (a.k) {
      case 'moved': paintCursor(); return;
      case 'enter': void load(a.path); return;
      case 'up': void load(a.path, a.from); return;
      case 'open': {
        const cur = nav.current();
        c.openFile({ path: a.path, project }, { at: { x: ctx.win.x + 48, y: ctx.win.y + 36 } });
        if (cur) list.querySelector<HTMLElement>('.is-cur')?.classList.add('is-hit');
        return;
      }
      case 'find': openFind(); return;
      case 'close': ctx.close(); return;
      case 'blocked': {
        const why = a.why === 'root' ? 'AT THE PROJECT ROOT' : a.why === 'other' ? 'NOT SERVED · OUTSIDE THE PROJECT OR NOT A FILE' : 'NOTHING HERE';
        c.note(why, 'warn');
        return;
      }
      case 'none': return;
    }
  }

  function openFind() {
    findbar.hidden = false;
    input.value = nav.filter;
    input.focus();
    input.select();
  }

  function closeFind(keep: boolean) {
    if (!keep) { nav.setFilter(''); paintList(); }
    input.blur();
    if (!nav.filter) findbar.hidden = true;
  }

  input.addEventListener('input', () => { nav.setFilter(input.value); paintList(); });
  input.addEventListener('keydown', (e) => {
    // Escape y ↵ son del filtro mientras se escribe en él: el gestor de
    // ventanas no los ve, y así Esc limpia el filtro en vez de cerrar la ventana.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(false); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); closeFind(true); }
    else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'j')) { e.preventDefault(); e.stopPropagation(); act(nav.key('j')); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'k')) { e.preventDefault(); e.stopPropagation(); act(nav.key('k')); }
  });

  upBtn.addEventListener('click', () => { slabFlash(upBtn); act(nav.key('h')); });
  enterBtn.addEventListener('click', () => { slabFlash(enterBtn); act(nav.key('l')); });
  findBtn.addEventListener('click', () => { slabFlash(findBtn); act(nav.key('/')); });

  list.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (!row) return;
    nav.cursor = Number(row.dataset.i);
    paintCursor();
  });
  list.addEventListener('dblclick', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (!row) return;
    nav.cursor = Number(row.dataset.i);
    act(nav.key('l'));
  });

  /**
   * Las teclas sin botón. En captura, para llegar antes que main.ts (que
   * daría `/` a la línea de mando y `j` al campo); sólo con esta ventana
   * activa, fuera de la bandeja y sin nadie escribiendo.
   */
  const onKey = (e: KeyboardEvent) => {
    if (disposed || !ctx.win.focused || ctx.win.minimized || c.wm.trayMode()) return;
    if (typing(e) || e.defaultPrevented) return;
    const tok = keyToken(e);
    if (!tok || BUTTON_KEYS.has(tok) || !FileNav.handles(tok)) return;
    e.preventDefault();
    e.stopPropagation();
    act(nav.key(tok));
  };
  window.addEventListener('keydown', onKey, { capture: true });

  paint();
  void load(nav.dir);

  return {
    dispose() { disposed = true; window.removeEventListener('keydown', onKey, { capture: true }); },
    state: () => ({ root, dir: nav.dir, cursor: nav.cursor, filter: nav.filter, entries: nav.visible().map((e) => e.name), current: nav.current() ? joinPath(nav.dir, nav.current()!.name) : null }),
  };
}
