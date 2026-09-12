/**
 * Lo que un agente produce y vale la pena mirar.
 *
 * Un agente ya deja su trabajo en disco: una captura, un svg, una página que
 * generó para enseñar un resultado. Hoy eso sólo aparece como una línea de log
 * con una ruta que hay que ir a abrir a otra parte. Este módulo lo convierte en
 * un registro que viaja al hub, y que el hub puede servir a la consola.
 *
 * Dos formas de entrar, y las dos importan:
 *
 *  1. **Automática.** Un `tool_use` de Write/Edit/MultiEdit/NotebookEdit sobre
 *     un archivo con extensión de imagen, vídeo, html o texto. Es lo que hace
 *     que esto funcione sin que ningún agente sepa que ORCA existe.
 *  2. **Explícita.** El agente escribe `<project>/.orca/artifacts/<id>.json`
 *     con `{path, title}` — vía `orca-show`. Es para lo que la detección no
 *     puede adivinar: cuál de los treinta png que generó es EL que hay que ver,
 *     y cómo se llama.
 *  3. **Por efecto.** Un archivo que aparece en el árbol del proyecto sin que
 *     ninguna tool lo haya escrito: lo que sale de `ffmpeg`, de un
 *     `playwright`, de un script de generación, de un build. Nada de eso pasa
 *     por Write, así que (1) no lo ve, y es justo la forma que tiene un
 *     pipeline de producir su resultado. Se observa el ARCHIVO, nunca el
 *     comando: leer `convert a.png b.png` para adivinar qué produjo sería
 *     volver a adivinar a partir de una cadena, y ahí `a.png` es una entrada.
 *
 * La postura de seguridad es la misma que la del resto del collector: el hub
 * nombra un ID, nunca una ruta. `read()` sirve exclusivamente rutas que este
 * proceso registró él mismo, así que un token de hub robado no se convierte en
 * "léeme cualquier archivo de ese portátil".
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { Artifact, ArtifactKind, ArtifactSource } from '../shared/types.ts';
import { MAX_ARTIFACT_BYTES, artifactMime } from '../shared/protocol.ts';
import { errText, isInside, launchable, log, oneLine, safeJson, sha1, str } from './util.ts';

const SCOPE = 'artifacts';

/** Dónde un agente publica a mano lo que quiere que se vea. */
export const ARTIFACTS_DIR = path.join('.orca', 'artifacts');

/**
 * Techo por máquina.
 *
 * Un agente que genera fotogramas en un bucle produce miles de png sin que eso
 * signifique que hay miles de cosas que mirar. Al pasarse se expulsa el más
 * viejo — lo último que produjo la flota es siempre lo que el operador quiere
 * ver, y lo expulsado sigue en su disco, intacto.
 */
export const MAX_ARTIFACTS = 200;

/** Un `.json` de publicación más grande que esto no es una declaración. */
const MAX_DECL_BYTES = 64 * 1024;

/**
 * Dónde no se mira nunca.
 *
 * Ni dependencias, ni trabajo intermedio, ni nada oculto — un `.git` durante un
 * commit produce miles de eventos, y ninguno es algo que mirar. El filtro es
 * por segmento de ruta y por cadena, antes de tocar el disco.
 *
 * `out/` NO está: es donde un pipeline de render deja su resultado tanto como
 * donde un bundler deja el suyo, y perder el caso que motivó todo esto para
 * ahorrarse unos html de build es un mal cambio.
 */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'target', 'coverage', 'vendor',
  '__pycache__', 'venv',
]);

/**
 * Cuántos archivos nuevos se aceptan por tick.
 *
 * Un `git checkout` de rama renueva el mtime de todo el repo de golpe, y un
 * render por lotes escribe cientos de png en segundos. Ni una cosa ni la otra
 * son cientos de resultados. El tope deja pasar los más recientes y anota el
 * resto en el log: perder de vista un fotograma intermedio no cuesta nada,
 * ahogar el índice sí.
 */
const MAX_BURST = 24;

/**
 * Cuántos veredictos de `git check-ignore` se recuerdan por proyecto.
 *
 * La respuesta para una ruta no cambia salvo que alguien edite un `.gitignore`,
 * y un render por lotes pregunta por los mismos directorios una y otra vez.
 * Al llenarse se vacía entero: reconstruirlo cuesta un `git` y olvidar de más
 * no rompe nada.
 */
const MAX_IGNORE_MEMO = 4_000;

/** Tools cuyo `file_path` es, literalmente, un archivo que acaba de aparecer. */
export const ARTIFACT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Extensión → qué es. La lista es corta a propósito: sólo cosas que un humano
 * quiere ver de un vistazo. Un `.ts` es trabajo, no un artefacto; ya se ve en
 * el diff.
 */
export const ARTIFACT_KINDS: Readonly<Record<string, ArtifactKind>> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
  '.webp': 'image', '.svg': 'image',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video',
  '.html': 'html', '.htm': 'html',
  '.md': 'text', '.txt': 'text',
};

const KIND_NAMES = new Set<string>(['image', 'video', 'html', 'text', 'file']);

/** Sólo estas extensiones llegan a ser artefacto, venga de donde venga. */
export function kindOf(file: string): ArtifactKind | null {
  return ARTIFACT_KINDS[path.extname(file).toLowerCase()] ?? null;
}

/** El Content-Type lo fija `protocol.ts`: el hub lo repite al servir la caché. */
export const mimeOf = artifactMime;

/** Mismo id para la misma ruta en la misma máquina: reescribirla lo actualiza. */
export function artifactId(machineId: string, file: string): string {
  return 'art_' + sha1(`${machineId} ${path.resolve(file)}`).slice(0, 16);
}

/* ── entradas ─────────────────────────────────────────────────────── */

export interface ArtifactInput {
  /** Ruta tal cual la escribió el agente; puede ser relativa a `cwd`. */
  path: string;
  projectId: string;
  agentId: string;
  /** epoch ms del `tool_use` o del archivo. */
  at: number;
  /** Para resolver una ruta relativa. */
  cwd?: string | null;
  title?: string | null;
  kind?: ArtifactKind | null;
  /**
   * El agente pidió que se abra, no sólo que se archive (`orca-show --open`).
   * La detección automática nunca lo pone: adivinar que un png cualquiera
   * merece robarle la pantalla a alguien es exactamente lo que no queremos.
   */
  open?: boolean | null;
  /**
   * Publicación explícita: la ruta la nombró el agente en un JSON, no la
   * dedujimos de una escritura suya. Entonces se exige que caiga dentro del
   * proyecto — ver `resolve()`.
   */
  declaredIn?: string | null;
}

export interface ArtifactDeps {
  machineId: string;
  /** Atribuye una publicación a un agente, igual que en escalate/messages. */
  resolveAgent(projectId: string, hint: string | null): string | null;
}

interface Tracked {
  projectId: string;
  projectPath: string;
  dir: string;
}

export class ArtifactIndex {
  private readonly deps: ArtifactDeps;
  private items = new Map<string, Artifact>();
  private tracked = new Map<string, Tracked>();
  private watchers = new Map<string, fs.FSWatcher>();
  /** Watch recursivo del árbol de cada proyecto. Ver `attachTreeWatch()`. */
  private trees = new Map<string, fs.FSWatcher>();
  /** ruta absoluta → proyecto, de lo que el árbol vio y el tick aún no miró. */
  private seen = new Map<string, string>();
  /** ruta absoluta → la ignora git. Ver `gitIgnores()`. */
  private ignored = new Map<string, boolean>();
  /** archivo de declaración → mtime ya procesado. Ver `takeDecl()`. */
  private decls = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private scans = 0;
  private newCbs: ((a: Artifact) => void)[] = [];
  private goneCbs: ((id: string) => void)[] = [];

  constructor(deps: ArtifactDeps) { this.deps = deps; }

  onArtifact(cb: (a: Artifact) => void): void { this.newCbs.push(cb); }
  onGone(cb: (id: string) => void): void { this.goneCbs.push(cb); }

  start(pollMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.scan(); }, pollMs);
    this.timer.unref?.();
    void this.scan();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of [...this.watchers.values(), ...this.trees.values()]) {
      try { w.close(); } catch { /* ya cerrado */ }
    }
    this.watchers.clear();
    this.trees.clear();
    this.seen.clear();
    this.ignored.clear();
  }

  track(projectId: string, projectPath: string): void {
    const cur = this.tracked.get(projectId);
    if (cur && cur.projectPath === projectPath) return;
    this.untrack(projectId);
    this.tracked.set(projectId, {
      projectId, projectPath, dir: path.join(projectPath, ARTIFACTS_DIR),
    });
  }

  untrack(projectId: string): void {
    this.tracked.delete(projectId);
    for (const map of [this.watchers, this.trees]) {
      const w = map.get(projectId);
      if (w) { try { w.close(); } catch { /* ya cerrado */ } map.delete(projectId); }
    }
  }

  /** Lo que hay ahora mismo. El snapshot de reconexión lo reenvía entero. */
  list(): Artifact[] {
    return [...this.items.values()];
  }

  get(id: string): Artifact | null {
    return this.items.get(id) ?? null;
  }

  /* ── alta ───────────────────────────────────────────────────────── */

  /**
   * Registra —o refresca— un artefacto. Devuelve el registro si algo cambió y
   * hay que contárselo al hub, o null si la ruta no califica.
   *
   * Reescribir el mismo archivo NO crea otro artefacto: el id sale de
   * máquina+ruta, así que la segunda versión de una gráfica sustituye a la
   * primera en el sitio donde el operador ya la tenía puesta.
   */
  note(input: ArtifactInput): Artifact | null {
    const file = this.resolve(input);
    if (!file) return null;
    /*
     * La extensión manda, incluso sobre un `kind` declarado. Si el `kind`
     * pudiera saltarse la lista, `{"path": ".env", "kind": "text"}` en un
     * .orca/artifacts convertiría este canal en una forma de sacar los secretos
     * del proyecto por el hub. Declarar sólo puede reetiquetar lo que ya
     * califica — un .html que se quiere ver como texto, por ejemplo.
     */
    const natural = kindOf(file);
    if (!natural) return null;
    const kind = input.kind ?? natural;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      // Un transcript viejo puede nombrar algo que ya no existe. No es un error.
      return null;
    }
    if (!stat.isFile()) return null;

    const id = artifactId(this.deps.machineId, file);
    const prev = this.items.get(id);
    const at = input.at > 0 ? input.at : Math.round(stat.mtimeMs);
    const dim = kind === 'image' ? imageSize(file) : null;

    const next: Artifact = {
      id,
      agentId: input.agentId,
      projectId: input.projectId,
      machineId: this.deps.machineId,
      kind,
      path: file,
      title: oneLine(input.title ?? prev?.title ?? path.basename(file), 120),
      // La url la pone el hub, que es quien lo sirve. El collector no sabe con
      // qué host lo va a mirar nadie.
      url: null,
      bytes: stat.size,
      width: dim?.width ?? null,
      height: dim?.height ?? null,
      at,
      /*
       * Sólo lo declarado sube la mano. Si `open` no viene en esta alta pero el
       * artefacto ya la tenía, se conserva: reescribir el archivo que el agente
       * mandó abrir no es retirar la petición.
       */
      open: input.open === true || (input.open == null && prev?.open === true),
      /*
       * Declarar es una decisión, y no se pierde. Un agente que publica una
       * gráfica y luego la reescribe con Write no acaba de degradarla a «algo
       * que apareció»: sigue siendo la que él eligió, con el título que le
       * puso. Al revés sí ocurre: lo observado sube a declarado en cuanto el
       * agente lo publica.
       */
      source: input.declaredIn ? 'declared' : (prev?.source ?? 'observed'),
      placement: prev?.placement ?? null,
    };

    // Un tick que vuelve a ver la misma escritura no debería generar tráfico.
    if (prev && prev.bytes === next.bytes && prev.at === next.at
      && prev.title === next.title && prev.agentId === next.agentId
      && prev.open === next.open && prev.source === next.source) return null;

    this.items.set(id, next);
    this.evict();
    return this.items.has(id) ? next : null;
  }

  /**
   * Ruta absoluta y permitida, o null.
   *
   * La detección automática nace de una escritura que el agente YA hizo, y la
   * lista de extensiones acota lo que puede ser; ahí basta con vetar las raíces
   * del sistema. Una publicación explícita es distinta: ahí el agente teclea
   * una ruta cualquiera, y esa ruta se vuelve descargable desde el hub. Por eso
   * una declaración sólo puede señalar dentro de su propio proyecto.
   */
  private resolve(input: ArtifactInput): string | null {
    const raw = input.path.trim();
    if (!raw) return null;
    const base = input.declaredIn ?? input.cwd ?? null;
    const file = path.resolve(base ?? process.cwd(), raw);
    const allowed = launchable(file);
    if (!allowed.ok) {
      log('warn', SCOPE, `${file} descartado: ${allowed.why}`);
      return null;
    }
    if (input.declaredIn && !isInside(input.declaredIn, file)) {
      log('warn', SCOPE, `publicación fuera del proyecto, ignorada: ${file}`);
      return null;
    }
    return file;
  }

  /**
   * El más viejo se va cuando se pasa el techo. Ver MAX_ARTIFACTS.
   *
   * Con una excepción, y es la que importa: lo que un agente publicó a
   * propósito se va el último. Una corrida del arnés visual produce diez
   * capturas en un minuto y un render por lotes cientos, y sin esto la gráfica
   * que alguien eligió enseñar se cae del índice empujada por trabajo
   * intermedio que nadie miró nunca.
   */
  private evict(): void {
    if (this.items.size <= MAX_ARTIFACTS) return;
    const rank = (a: Artifact): number => (a.source === 'declared' ? 1 : 0);
    const ordered = [...this.items.values()]
      .sort((a, b) => rank(a) - rank(b) || a.at - b.at);
    const excess = this.items.size - MAX_ARTIFACTS;
    for (let i = 0; i < excess; i++) {
      const victim = ordered[i]!;
      this.forget(victim.id);
    }
    log('info', SCOPE, `techo de ${MAX_ARTIFACTS} artefactos: expulsados ${excess}`);
  }

  /** Lo saca del índice y avisa. El archivo en disco no se toca jamás. */
  forget(id: string): void {
    if (!this.items.delete(id)) return;
    for (const cb of this.goneCbs) { try { cb(id); } catch { /* aislar */ } }
  }

  private announce(a: Artifact): void {
    for (const cb of this.newCbs) { try { cb(a); } catch { /* aislar */ } }
  }

  /**
   * Alta desde la detección automática. Existe aparte de `note()` para que el
   * llamador no tenga que acordarse de emitir.
   */
  observe(input: ArtifactInput): void {
    const a = this.note(input);
    if (a) {
      this.announce(a);
      log('info', SCOPE, `${a.kind} ${a.id}: ${a.title} (${a.bytes}B)`);
    }
  }

  /* ── lectura para el hub ────────────────────────────────────────── */

  /**
   * Los bytes de un artefacto, en base64. SÓLO ids que este proceso registró:
   * ésta es toda la lista blanca, y por eso el comando lleva un id y no una
   * ruta.
   */
  async read(id: string): Promise<{ ok: boolean; detail?: string; data?: unknown }> {
    const a = this.items.get(id);
    if (!a) return { ok: false, detail: `artefacto desconocido: ${id}` };
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(a.path);
    } catch (err) {
      // Desapareció del disco: que el hub lo sepa y deje de ofrecerlo.
      this.forget(id);
      return { ok: false, detail: `ya no está en disco: ${errText(err)}` };
    }
    if (!stat.isFile()) {
      this.forget(id);
      return { ok: false, detail: 'ya no es un archivo' };
    }
    if (stat.size > MAX_ARTIFACT_BYTES) {
      return {
        ok: false,
        detail: `${a.path} pesa ${stat.size}B, por encima del límite de `
          + `${MAX_ARTIFACT_BYTES}B; está en la máquina, no viaja por el cable`,
      };
    }
    const buf = await fsp.readFile(a.path);
    return {
      ok: true,
      data: { base64: buf.toString('base64'), mime: mimeOf(a.path), bytes: buf.length },
    };
  }

  /* ── publicación explícita: <project>/.orca/artifacts ───────────── */

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.scans++;
    try {
      for (const t of this.tracked.values()) {
        this.attachWatch(t);
        this.attachTreeWatch(t);
        const names = await readdirQuiet(t.dir);
        if (names === null) continue;
        for (const name of names) {
          if (!name.endsWith('.json') || name.startsWith('.')) continue;
          await this.takeDecl(t, path.join(t.dir, name));
        }
      }
      await this.takeSeen();
      // Un artefacto cuyo archivo ya no existe es un hueco en la consola. No
      // hace falta comprobarlo cada segundo: es un cambio raro y caro.
      if (this.scans % 8 === 0) await this.sweepMissing();
    } finally {
      this.scanning = false;
    }
  }

  private attachWatch(t: Tracked): void {
    if (this.watchers.has(t.projectId)) return;
    if (!fs.existsSync(t.dir)) return;
    try {
      const w = fs.watch(t.dir, () => { void this.scan(); });
      w.on('error', () => {
        try { w.close(); } catch { /* ya cerrado */ }
        this.watchers.delete(t.projectId);
      });
      this.watchers.set(t.projectId, w);
    } catch {
      // Sin watch queda el poll de 1s, que es latencia irrelevante aquí.
    }
  }

  /* ── por efecto: el árbol del proyecto ──────────────────────────── */

  /**
   * Mira el proyecto entero, para ver aparecer lo que ninguna tool escribió.
   *
   * Un `fs.watch` recursivo es el sistema operativo haciendo el trabajo: ni
   * recorremos el árbol ni tocamos disco hasta que algo cambia de verdad, que
   * es lo que hace viable mirar un repo grande una vez por segundo. Donde el
   * recursivo no existe —Linux, según versión— esto no se monta y la captura
   * se queda en las otras dos entradas, que es una degradación, no un fallo.
   */
  private attachTreeWatch(t: Tracked): void {
    if (this.trees.has(t.projectId)) return;
    if (!fs.existsSync(t.projectPath)) return;
    try {
      const w = fs.watch(t.projectPath, { recursive: true }, (_ev, name) => {
        if (typeof name === 'string') this.sawInTree(t, name);
      });
      w.on('error', () => {
        try { w.close(); } catch { /* ya cerrado */ }
        this.trees.delete(t.projectId);
      });
      this.trees.set(t.projectId, w);
    } catch {
      log('debug', SCOPE, `sin watch recursivo en ${t.projectPath}: sólo tools y declaraciones`);
    }
  }

  /**
   * Un cambio en el árbol. Barato a propósito: esto corre en el hilo del
   * evento y en una ráfaga se llama miles de veces, así que aquí sólo hay
   * comparaciones de cadenas. Statear, atribuir y registrar es trabajo del
   * tick, sobre la cola que esto deja.
   */
  private sawInTree(t: Tracked, rel: string): void {
    if (!kindOf(rel)) return;
    const parts = rel.split(path.sep);
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]!;
      // El nombre del archivo puede empezar por punto sin ser un directorio
      // oculto; los directorios del camino, no.
      if (i < parts.length - 1 && (seg.startsWith('.') || SKIP_DIRS.has(seg))) return;
    }
    this.seen.set(path.join(t.projectPath, rel), t.projectId);
  }

  /**
   * Drena lo que vio el árbol.
   *
   * La atribución es la parte floja y hay que decirlo: se le cuelga al agente
   * vivo del proyecto con la actividad más reciente, porque un archivo que
   * aparece no lleva firma. Con cinco agentes en el mismo repo se equivocará a
   * veces. El daño está acotado por diseño: esto entra como `observed`, y lo
   * observado no se ancla solo en el campo — vive en la galería, donde una
   * atribución torcida cuesta una línea mal puesta y no una imagen junto al
   * agente equivocado.
   */
  private async takeSeen(): Promise<void> {
    if (this.seen.size === 0) return;
    const batch = [...this.seen.entries()];
    this.seen.clear();
    if (batch.length > MAX_BURST) {
      log('info', SCOPE, `${batch.length} archivos de golpe en el árbol: me quedo con ${MAX_BURST}`);
    }

    const fresh: { file: string; projectId: string; at: number }[] = [];
    for (const [file, projectId] of batch) {
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      fresh.push({ file, projectId, at: Math.round(stat.mtimeMs) });
    }
    fresh.sort((a, b) => b.at - a.at);

    const keep = await this.dropIgnored(fresh.slice(0, MAX_BURST));
    for (const f of keep) {
      const agentId = this.deps.resolveAgent(f.projectId, null);
      // Sin nadie a quien colgárselo no hay registro: un artefacto sin dueño
      // no tiene dónde vivir en la consola, y adivinar un dueño es peor.
      if (!agentId) continue;
      this.observe({ path: f.file, projectId: f.projectId, agentId, at: f.at });
    }
  }

  /**
   * Quita del lote lo que el propio proyecto declara que no es suyo.
   *
   * `.gitignore` es la única lista de «esto no es trabajo» que un repo escribe
   * de verdad y mantiene al día, así que es mejor que cualquier lista de
   * directorios que pudiéramos inventar aquí — que además nunca cerraría:
   * mañana hay otro directorio. Se midió el día que esto entró en servicio:
   * veintitrés capturas del arnés visual (`test/shots/`, ignorado) en diez
   * minutos, todas atribuidas a agentes que no las habían hecho.
   *
   * Esto vale SÓLO para lo que aparece solo. Una declaración —`orca-show`—
   * nunca se filtra por aquí: un render de vídeo vive en un directorio
   * ignorado casi siempre, porque los binarios no se commitean, y colar ahí
   * este filtro mataría justo el caso que motivó la captura. Que el agente lo
   * publique sigue siendo la forma de decir «éste sí».
   */
  private async dropIgnored(
    batch: { file: string; projectId: string; at: number }[],
  ): Promise<{ file: string; projectId: string; at: number }[]> {
    if (batch.length === 0) return batch;
    const ask = new Map<string, string[]>();   // proyecto → rutas sin veredicto
    for (const f of batch) {
      if (this.ignored.has(f.file)) continue;
      const root = this.tracked.get(f.projectId)?.projectPath;
      if (!root) continue;
      const list = ask.get(root) ?? [];
      list.push(f.file);
      ask.set(root, list);
    }
    for (const [root, files] of ask) {
      const hits = await gitIgnores(root, files);
      if (hits === null) continue;   // no es un repo, o git no contestó
      if (this.ignored.size > MAX_IGNORE_MEMO) this.ignored.clear();
      for (const f of files) this.ignored.set(f, hits.has(f));
    }
    return batch.filter((f) => this.ignored.get(f.file) !== true);
  }

  /**
   * Lee una declaración. A diferencia de un mensaje, el archivo NO se borra:
   * una publicación es estado, no un evento. Que sobreviva es lo que hace que
   * un collector reiniciado vuelva a encontrar lo que el agente ya dijo que
   * había que mirar, y que reescribirla —mismo archivo, mtime nuevo— sea la
   * forma de refrescar el título o la marca de tiempo.
   */
  private async takeDecl(t: Tracked, file: string): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(file);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    if (stat.size > MAX_DECL_BYTES) {
      log('warn', SCOPE, `${file} pesa ${stat.size}B, no es una declaración`);
      return;
    }
    const mtime = Math.round(stat.mtimeMs);
    if (this.decls.get(file) === mtime) return;

    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    const obj = safeJson<Record<string, unknown>>(text);
    if (!obj) return;   // escrito a medias: el próximo tick lo reintenta
    this.decls.set(file, mtime);

    const target = str(obj['path']);
    if (!target) {
      log('warn', SCOPE, `${file}: sin "path"`);
      return;
    }
    const rawKind = str(obj['kind']);
    const hint = str(obj['agentId']) ?? str(obj['sessionId']);
    const agentId = this.deps.resolveAgent(t.projectId, hint) ?? hint;
    if (!agentId) {
      log('warn', SCOPE, `${file}: no sé a qué agente atribuirlo todavía`);
      // Sin agente el registro no tiene dónde colgarse. Se reintenta al
      // siguiente cambio de mtime, o cuando el collector reinicie.
      this.decls.delete(file);
      return;
    }

    this.observe({
      path: target,
      projectId: t.projectId,
      agentId,
      at: mtime,
      declaredIn: t.projectPath,
      title: str(obj['title']),
      kind: rawKind && KIND_NAMES.has(rawKind) ? rawKind as ArtifactKind : null,
      open: obj['open'] === true,
    });
  }

  private async sweepMissing(): Promise<void> {
    for (const a of [...this.items.values()]) {
      const there = await fsp.stat(a.path).then((s) => s.isFile()).catch(() => false);
      if (!there) this.forget(a.id);
    }
  }
}

/* ── helpers de módulo ────────────────────────────────────────────── */

/**
 * Cuáles de esas rutas ignora git, o null si no se puede saber.
 *
 * Un solo proceso para todo el lote — `check-ignore` lee las rutas por stdin —
 * y sin bloqueos de git, porque esto corre mientras la flota trabaja en el
 * mismo árbol. Que devuelva null (no es un repo, git no está, se pasó el
 * tiempo) significa exactamente «no sé», y entonces no se filtra nada: perder
 * un resultado por una duda es peor que dejar pasar una captura de más.
 */
function gitIgnores(root: string, files: string[]): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: Set<string> | null): void => { if (!settled) { settled = true; resolve(v); } };
    try {
      const child = execFile('git', ['-C', root, 'check-ignore', '--stdin'], {
        timeout: 3_000, maxBuffer: 4 * 1024 * 1024, shell: false, windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      }, (err, stdout) => {
        // 0 = alguna ignorada, 1 = ninguna. Cualquier otra cosa es un fallo.
        const code = (err as NodeJS.ErrnoException & { code?: number } | null)?.code;
        if (err && code !== 1) return done(null);
        done(new Set(String(stdout).split('\n').map((l) => l.trim()).filter(Boolean)));
      });
      child.on('error', () => done(null));
      child.stdin?.on('error', () => done(null));
      child.stdin?.end(files.join('\n') + '\n');
    } catch {
      done(null);
    }
  });
}

async function readdirQuiet(dir: string): Promise<string[] | null> {
  try {
    return await fsp.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      log('debug', SCOPE, `readdir ${dir}: ${errText(err)}`);
    }
    return null;
  }
}

/**
 * Ancho y alto leyendo la cabecera, sin decodificar nada.
 *
 * Vale la pena porque el campo tiene un uso concreto: el campo espacial puede
 * reservar el hueco con la proporción correcta ANTES de que la imagen llegue,
 * y sin eso cada artefacto que carga da un salto de layout. Son 32 bytes de
 * lectura; un decodificador de imágenes no entraría aquí.
 */
export function imageSize(file: string): { width: number; height: number } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    const buf = head.subarray(0, read);
    return sizeFromHeader(buf);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* da igual */ } }
  }
}

export function sizeFromHeader(buf: Buffer): { width: number; height: number } | null {
  // PNG: firma de 8 bytes, luego el chunk IHDR con ancho y alto.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47
    && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF: cabecera fija, little-endian.
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // JPEG: hay que caminar los marcadores hasta el SOFn, que es el único que
  // lleva las dimensiones. Los SOF de 0xC4/0xC8/0xCC no lo son.
  if (buf.length >= 4 && buf.readUInt16BE(0) === 0xffd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}
