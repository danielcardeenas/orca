/**
 * Carpetas que el operador autorizó a `/api/file`, y que sobreviven al hub.
 *
 * files.ts sirve lo que el mundo conoce: los proyectos, el scratchpad de los
 * agentes, `~/.orca/uploads` y lo que venga en `ORCA_FILE_ROOTS`. Un agente
 * que deja una comparación en `~/Desktop/logos/grid3.png` la cita en su
 * conversación, el operador la pincha y el hub contesta 403: el Escritorio
 * no es un proyecto. La respuesta correcta a eso no es abrir la home entera,
 * ni pedir al operador que edite un `.env` y reinicie: es que diga «esta
 * carpeta sí», una vez, desde el visor que le dijo que no.
 *
 * Eso es lo que guarda esto. Cada entrada es una carpeta (la del archivo que
 * se pidió ver, o la que se pidió tal cual), y la lista vive en
 * `~/.orca/hub/file-roots.json` para que un reinicio no la olvide. Lo que
 * NO se puede autorizar sigue siendo lo mismo que en files.ts: la home
 * entera, contenedores temporales, rutas privadas con nombre conocido, el
 * propio `~/.orca` (el token, la memoria, este mismo archivo). Autorizar no
 * salta ninguna de esas puertas: `acceptableRoot` decide aquí igual que al
 * servir, y `resolveServedPath` vuelve a mirar cada raíz en cada petición.
 *
 * Por eso mismo, desde que `privatePath` abre `<proyecto>/.claude/worktrees/
 * <nombre>`, el worktree de un agente **sí** se puede autorizar como raíz.
 * Es deliberado y es la consecuencia buscada: quien puede mirar ese árbol
 * desde el navegador puede también fijarlo. Lo que no cambia es el resto de
 * `.claude`, que sigue sin poder serlo, ni `~/.claude`, que la excepción
 * excluye a propósito.
 *
 * Revocar es borrar la línea del json y reiniciar el hub, o vaciar el
 * archivo. No hay comando para ello a propósito: nadie lo ha necesitado y
 * un comando que nadie usa es una puerta más que vigilar.
 */

import { readFileSync } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { ORCA_DIR } from './auth.ts';
import { acceptableRoot } from './files.ts';
import { HUB_DIR } from './persist.ts';

export const FILE_ROOTS_FILE = join(HUB_DIR, 'file-roots.json');
/** Más carpetas que esto no las recuerda nadie; es una lista, no un índice del disco. */
export const MAX_FILE_ROOTS = 64;

export type AllowResult =
  | { ok: true; root: string; added: boolean }
  | { ok: false; reason: string };

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export class FileRoots {
  private roots: string[] = [];

  /** `file` null: sólo en memoria (pruebas, arnés). */
  constructor(private readonly file: string | null, private readonly home: string = homedir()) {
    if (!file) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { roots?: unknown };
      if (Array.isArray(parsed.roots)) {
        this.roots = parsed.roots.filter((r): r is string => typeof r === 'string' && acceptableRoot(r, home)).slice(0, MAX_FILE_ROOTS);
      }
    } catch { /* sin archivo o ilegible: se empieza vacío */ }
  }

  list(): string[] { return [...this.roots]; }

  /**
   * Autoriza la carpeta de `path` (o `path` mismo si es una carpeta).
   * Devuelve qué raíz quedó autorizada, y si ya lo estaba.
   */
  async allow(path: string): Promise<AllowResult> {
    let raw = path.trim();
    if (!raw) return { ok: false, reason: 'falta path' };
    if (raw.includes('\0')) return { ok: false, reason: 'path con NUL' };
    if (raw === '~' || raw.startsWith('~/')) raw = this.home + raw.slice(1);
    if (!isAbsolute(raw)) return { ok: false, reason: 'la ruta tiene que ser absoluta' };
    const lexical = resolve(raw);
    let root: string;
    try {
      const st = await stat(lexical);
      root = st.isDirectory() ? lexical : dirname(lexical);
    } catch { return { ok: false, reason: 'no existe en el disco del hub' }; }
    if (within(root, resolve(ORCA_DIR)) || within(resolve(ORCA_DIR), root)) {
      return { ok: false, reason: '~/.orca no se sirve: ahí viven el token y la memoria del hub' };
    }
    if (!acceptableRoot(root, this.home)) {
      return { ok: false, reason: 'esa carpeta no puede ser una raíz: la home, un temporal o una ruta privada' };
    }
    const already = this.roots.find((r) => within(root, r));
    if (already) return { ok: true, root: already, added: false };
    if (this.roots.length >= MAX_FILE_ROOTS) return { ok: false, reason: `ya hay ${MAX_FILE_ROOTS} carpetas autorizadas; quita alguna de file-roots.json` };
    // Una raíz nueva que contiene a otras las absorbe: una lista, no un árbol.
    this.roots = [...this.roots.filter((r) => !within(r, root)), root];
    await this.persist();
    return { ok: true, root, added: true };
  }

  /** Temporal y `rename`: un hub que cae a mitad de escritura no deja un json a medias. */
  private async persist(): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ roots: this.roots }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
