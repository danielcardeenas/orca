/**
 * ¿Está el hub corriendo el código que hay en disco?
 *
 * En producción el operador construye la consola con `npm run publish` y sigue
 * trabajando: el hub no se entera, porque sirve `dist/` desde disco y su
 * propio código lo cargó al arrancar. Eso es justo lo que se quiere de la
 * consola —nada cambia bajo la mano del operador hasta que pica recargar—
 * pero abre una asimetría que hay que decir en voz alta: recargar la página
 * NO actualiza el hub. Un bundle nuevo hablando con un hub viejo es protocolo
 * nuevo contra protocolo viejo, y el síntoma —un comando que no hace nada, un
 * campo que llega vacío— no se parece en nada a la causa.
 *
 * Así que el hub se vigila a sí mismo. Al arrancar toma la revisión de su
 * código fuente; cada tanto la vuelve a tomar; si cambió, lo que corre ya no
 * es lo que hay escrito, y las consolas se enteran (frame `server` en
 * shared/protocol.ts). No recarga nada ni se reinicia solo: sólo lo dice.
 *
 * En desarrollo esto no se enciende nunca, y no por un `if`: bajo `tsx watch`
 * el proceso se reinicia al guardar, así que la revisión de arranque vuelve a
 * ser la del disco antes de que a nadie le dé tiempo a mirar.
 *
 * ── Qué cuenta como «el código del servidor» ───────────────────────
 *
 * Todo `src/**\/*.ts` menos `src/ui/`. La UI ya tiene su propia señal —el
 * conjunto de `/assets/*` con hash del index, que ES el build id— y contarla
 * aquí encendería las dos píldoras por el mismo cambio. `src/shared/` sí
 * cuenta aunque lo comparta la consola: un cambio ahí puede mover el
 * protocolo, y equivocarse hacia «avisa de más» cuesta un vistazo, mientras
 * que hacia «avisa de menos» cuesta una tarde de depuración.
 *
 * No se leen contenidos: ruta, tamaño y mtime bastan para saber que algo se
 * escribió, y un escaneo de unos cientos de `stat` cada medio minuto no se
 * nota. La contrapartida honesta es que un `touch` sin cambios también
 * cuenta; el aviso dice «reinicia», que no hace daño de más.
 */

import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Lo que se mira de un archivo. Ni contenido ni permisos: qué es y cuándo se escribió. */
export interface SourceStat { path: string; mtimeMs: number; size: number }

/** Directorios que no forman parte del servidor. Relativos a la raíz escaneada. */
export const NOT_SERVER = ['ui'];

/**
 * La revisión de un conjunto de archivos: doce hex, deterministas y en orden.
 *
 * Se ordena antes de resumir porque `readdir` no promete orden entre sistemas
 * de archivos, y una revisión que dependa del orden de lectura cambia sola.
 */
export function revOf(files: SourceStat[]): string {
  const h = createHash('sha1');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(`${f.path}\0${f.size}\0${Math.trunc(f.mtimeMs)}\n`);
  }
  return h.digest('hex').slice(0, 12);
}

/** Los `.ts` del servidor bajo `root`, con lo que hace falta para resumirlos. */
export async function scanSource(root: string): Promise<SourceStat[]> {
  const out: SourceStat[] = [];
  const skip = new Set(NOT_SERVER);

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // desapareció mientras mirábamos: el próximo escaneo lo verá
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(root, full);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        if (skip.has(rel.split(sep)[0] ?? '')) continue;
        await walk(full);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.ts')) continue;
      try {
        const s = await stat(full);
        out.push({ path: rel, mtimeMs: s.mtimeMs, size: s.size });
      } catch { /* igual: ya no está */ }
    }
  };

  await walk(root);
  return out;
}

/** La revisión del código del servidor que hay ahora mismo en `root`. */
export async function sourceRev(root: string): Promise<string> {
  return revOf(await scanSource(root));
}

/* ── el centinela ─────────────────────────────────────────────────── */

export interface SourceIO {
  /** La revisión que hay en disco ahora. */
  rev(): Promise<string>;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SourceSentinel {
  /** Con la que arrancó el proceso. */
  boot(): string;
  /** ¿Lo que corre dejó de ser lo que hay escrito? */
  stale(): boolean;
  /** Mira el disco una vez. Resuelve a `stale()`. */
  check(): Promise<boolean>;
  start(): void;
  stop(): void;
  onStale(fn: () => void): void;
}

export const SOURCE_POLL_MS = 30_000;

/**
 * Deliberadamente gemelo del centinela de la consola (ui/hud/update.ts): una
 * línea base tomada al empezar, una comprobación que no dice nada hasta que
 * hay diferencia, y el reloj que se para en cuanto la hay. Dos avisos que
 * significan lo mismo desde los dos lados del cable se leen mejor si se
 * comportan igual.
 */
export function createSourceSentinel(boot: string, io: SourceIO, intervalMs = SOURCE_POLL_MS): SourceSentinel {
  let stale = false;
  let timer: unknown = null;
  let checking: Promise<boolean> | null = null;
  const listeners: (() => void)[] = [];

  const sentinel: SourceSentinel = {
    boot: () => boot,
    stale: () => stale,
    check() {
      if (stale) return Promise.resolve(true);
      if (checking) return checking;
      checking = (async () => {
        try {
          const now = await io.rev();
          // Un escaneo vacío es un árbol que no se pudo leer, no un cambio.
          if (now && now !== boot) {
            stale = true;
            sentinel.stop();
            for (const fn of listeners) fn();
          }
        } catch { /* el disco contestará el próximo minuto */ }
        finally { checking = null; }
        return stale;
      })();
      return checking;
    },
    start() {
      if (timer !== null || stale) return;
      const tick = () => {
        timer = io.set(() => { void sentinel.check().then(() => { if (timer !== null) tick(); }); }, intervalMs);
      };
      tick();
    },
    stop() {
      if (timer !== null) io.clear(timer);
      timer = null;
    },
    onStale(fn) { listeners.push(fn); },
  };
  return sentinel;
}
