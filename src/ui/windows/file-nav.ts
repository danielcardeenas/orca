/**
 * El estado de un navegador de archivos, sin DOM.
 *
 * Qué carpeta se mira, qué filas tiene, cuál está bajo el cursor y qué filtro
 * las recorta. Las teclas de vim se traducen aquí a acciones —moverse, entrar,
 * subir, filtrar, cerrar— y quien tiene el DOM (kinds/files.ts) las ejecuta:
 * pide la carpeta al hub, abre el visor, repinta. Separarlo así es lo que
 * permite probar la navegación entera en Node con un árbol de mentira.
 *
 * La raíz es una pared: `parent()` devuelve null cuando ya se está en ella y
 * ninguna ruta que salga de aquí la sobrepasa. El hub vuelve a contenerlo
 * todo por su cuenta (hub/files.ts), pero el navegador no le pide nunca nada
 * que no esté bajo el proyecto.
 */

export interface NavEntry {
  name: string;
  /** `other` se lista y no se abre: un enlace fuera del proyecto, un fifo, algo ajeno. */
  kind: 'dir' | 'file' | 'other';
  size: number | null;
  mtime: number | null;
}

export type NavAction =
  | { k: 'none' }
  /** El cursor se movió; hay que repintar. */
  | { k: 'moved' }
  /** Entrar en una carpeta: pedirla y enseñarla. */
  | { k: 'enter'; path: string }
  /** Abrir un archivo en el visor. */
  | { k: 'open'; path: string }
  /** Subir a la carpeta madre; `from` es de dónde se viene, para dejar el cursor encima. */
  | { k: 'up'; path: string; from: string }
  /** La tecla no puede: ya en la raíz, fila que no se abre, lista vacía. */
  | { k: 'blocked'; why: 'root' | 'other' | 'empty' }
  /** `/`: dar el teclado al filtro. */
  | { k: 'find' }
  /** `q`: cerrar la ventana. */
  | { k: 'close' };

/** Cuántas filas salta `ctrl+d` / `ctrl+u`. */
export const HALF_PAGE = 10;

const trimSlash = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** `dir` cae bajo `root` (o es `root`). Léxico: lo real lo decide el hub. */
export function underRoot(dir: string, root: string): boolean {
  const r = trimSlash(root);
  const d = trimSlash(dir);
  return d === r || d.startsWith(`${r}/`);
}

/** La carpeta madre de `dir`, o null si `dir` es la raíz o se sale de ella. */
export function parentOf(dir: string, root: string): string | null {
  const r = trimSlash(root);
  const d = trimSlash(dir);
  if (d === r || !underRoot(d, r)) return null;
  const cut = d.lastIndexOf('/');
  const up = cut <= 0 ? '/' : d.slice(0, cut);
  return underRoot(up, r) ? up : r;
}

/** `dir` relativo a `root`: '' en la raíz, `src/ui` dentro. */
export function relativeTo(dir: string, root: string): string {
  const r = trimSlash(root);
  const d = trimSlash(dir);
  if (d === r) return '';
  return underRoot(d, r) ? d.slice(r.length + 1) : d;
}

export class FileNav {
  readonly root: string;
  dir: string;
  entries: NavEntry[] = [];
  cursor = 0;
  filter = '';
  /** `g` esperando su segunda `g`. */
  private pendingG = false;

  constructor(root: string, dir?: string) {
    this.root = trimSlash(root);
    this.dir = dir && underRoot(dir, this.root) ? trimSlash(dir) : this.root;
  }

  /** Las filas que se ven: todas, o las que contienen el filtro. */
  visible(): NavEntry[] {
    const f = this.filter.trim().toLowerCase();
    if (!f) return this.entries;
    return this.entries.filter((e) => e.name.toLowerCase().includes(f));
  }

  current(): NavEntry | null {
    return this.visible()[this.cursor] ?? null;
  }

  /** Dónde está el cursor relativo a la raíz, para el título. */
  relative(): string { return relativeTo(this.dir, this.root); }

  atRoot(): boolean { return this.dir === this.root; }

  /**
   * Lo que el hub contestó para `dir`. El filtro se olvida al cambiar de
   * carpeta: era de la otra. `select` deja el cursor sobre ese nombre —al
   * subir, sobre la carpeta de la que se viene.
   */
  show(dir: string, entries: NavEntry[], opts: { select?: string } = {}): void {
    const d = trimSlash(dir);
    this.dir = underRoot(d, this.root) ? d : this.root;
    this.entries = entries;
    this.filter = '';
    this.pendingG = false;
    const at = opts.select ? entries.findIndex((e) => e.name === opts.select) : -1;
    this.cursor = at >= 0 ? at : 0;
  }

  setFilter(f: string): void {
    this.filter = f;
    this.cursor = 0;
    this.pendingG = false;
  }

  private clamp(i: number): number {
    const n = this.visible().length;
    return n ? Math.max(0, Math.min(n - 1, i)) : 0;
  }

  move(delta: number): boolean {
    const next = this.clamp(this.cursor + delta);
    const moved = next !== this.cursor;
    this.cursor = next;
    return moved;
  }

  first(): boolean { return this.move(-this.visible().length); }
  last(): boolean { return this.move(this.visible().length); }

  /** Entrar en lo que hay bajo el cursor: una carpeta se pide, un archivo se abre. */
  enter(): NavAction {
    const e = this.current();
    if (!e) return { k: 'blocked', why: 'empty' };
    const path = joinPath(this.dir, e.name);
    if (e.kind === 'dir') return { k: 'enter', path };
    if (e.kind === 'file') return { k: 'open', path };
    return { k: 'blocked', why: 'other' };
  }

  /** Subir un nivel; en la raíz no hay nivel al que subir. */
  parent(): NavAction {
    const up = parentOf(this.dir, this.root);
    if (up === null) return { k: 'blocked', why: 'root' };
    const from = this.dir.slice(this.dir.lastIndexOf('/') + 1);
    return { k: 'up', path: up, from };
  }

  /**
   * Una tecla en el alfabeto de wm.ts (`j`, `shift+g`, `ctrl+d`, `enter`…).
   * `gg` es la única secuencia: una `g` sola se guarda, la segunda salta al
   * principio, cualquier otra cosa la olvida.
   */
  key(tok: string): NavAction {
    const wasG = this.pendingG;
    this.pendingG = false;
    switch (tok) {
      case 'j': case 'arrowdown': return this.move(1) ? { k: 'moved' } : { k: 'none' };
      case 'k': case 'arrowup': return this.move(-1) ? { k: 'moved' } : { k: 'none' };
      case 'ctrl+d': return this.move(HALF_PAGE) ? { k: 'moved' } : { k: 'none' };
      case 'ctrl+u': return this.move(-HALF_PAGE) ? { k: 'moved' } : { k: 'none' };
      case 'g':
        if (wasG) return this.first() ? { k: 'moved' } : { k: 'none' };
        this.pendingG = true;
        return { k: 'none' };
      case 'shift+g': return this.last() ? { k: 'moved' } : { k: 'none' };
      case 'l': case 'enter': case 'arrowright': return this.enter();
      case 'h': case 'arrowleft': return this.parent();
      case '/': case 'shift+/': return { k: 'find' };
      case 'q': return { k: 'close' };
      default: return { k: 'none' };
    }
  }

  /** Qué teclas atiende `key`, para quien decide si robársela al campo. */
  static handles(tok: string): boolean {
    return ['j', 'k', 'g', 'shift+g', 'l', 'h', 'enter', 'q', '/', 'shift+/', 'ctrl+d', 'ctrl+u', 'arrowdown', 'arrowup', 'arrowleft', 'arrowright'].includes(tok);
  }
}
