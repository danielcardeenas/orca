/**
 * Adjuntar un archivo a un mensaje: soltarlo en la caja, o pegarlo.
 *
 * Un agente no ve el navegador; ve su disco. Así que un archivo no «viaja con
 * el mensaje»: se sube al hub (`POST /api/uploads`, net/client.ts), el hub
 * devuelve dónde lo dejó, y ESA RUTA se escribe en la caja donde estaba el
 * cursor, como hace un terminal cuando se le suelta un archivo encima. El
 * operador ve exactamente lo que va a mandar, puede escribir alrededor, y el
 * borrador (drafts.ts) lo guarda sin saber que era un archivo.
 *
 * Tres cajas —agente, CAPCOM, misión— hacen lo mismo, así que la regla vive
 * aquí una vez: `bindAttach` cablea arrastrar-y-soltar y pegar en una caja;
 * `stage`/`onStage` es el puente desde el lienzo, que suelta el archivo sobre
 * una baldosa y abre su ventana: la ventana puede no estar montada todavía,
 * así que las rutas esperan en `staged` hasta que su caja aparece.
 *
 * `insertPaths` es puro —valor y caret— para que test/attach.test.ts lo
 * ejercite sin navegador.
 */

export interface AttachField {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Escribe las rutas donde está el cursor, separadas de lo que hubiera por un
 * espacio a cada lado si hace falta. Devuelve el texto y dónde queda el
 * caret: justo después de lo insertado, para seguir escribiendo.
 */
export function insertPaths(field: AttachField, paths: string[]): { value: string; caret: number } {
  const before = field.value.slice(0, field.selectionStart);
  const after = field.value.slice(field.selectionEnd);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const tail = after && !/^\s/.test(after) ? ' ' : '';
  const chunk = `${lead}${paths.join(' ')}${tail}`;
  return { value: before + chunk + after, caret: before.length + lead.length + paths.join(' ').length };
}

/* ── Rutas que esperan a su caja ───────────────────────────────────── */

const staged = new Map<string, string[]>();
const listeners = new Map<string, (paths: string[]) => void>();

/**
 * Deja rutas para la caja de `key` (una clave de drafts.ts). Si la caja está
 * montada las recibe ya; si no, las encuentra al montarse.
 */
export function stage(key: string, paths: string[]): void {
  if (!paths.length) return;
  const fn = listeners.get(key);
  if (fn) { fn(paths); return; }
  staged.set(key, [...(staged.get(key) ?? []), ...paths]);
}

/** La caja de `key` está montada: se lleva lo que esperaba y lo que venga. */
export function onStage(key: string, fn: (paths: string[]) => void): () => void {
  listeners.set(key, fn);
  const pending = staged.get(key);
  if (pending?.length) { staged.delete(key); fn(pending); }
  return () => { if (listeners.get(key) === fn) listeners.delete(key); };
}

/** Sólo para pruebas: nada esperando, nadie escuchando. */
export function resetStaged(): void { staged.clear(); listeners.clear(); }

/* ── Subir ─────────────────────────────────────────────────────────── */

export type Upload = (file: File) => Promise<{ path: string }>;

/**
 * Sube en orden y devuelve las rutas de los que llegaron. Un fallo se cuenta
 * y no detiene a los demás: tres archivos y uno grande de más son dos rutas
 * y un aviso, no cero rutas.
 */
export async function uploadAll(files: File[], upload: Upload, note: (text: string, level?: 'info' | 'warn' | 'alert') => void): Promise<string[]> {
  const paths: string[] = [];
  for (const f of files) {
    try { paths.push((await upload(f)).path); }
    catch (err) { note(`${f.name} not uploaded · ${(err as Error).message}`, 'warn'); }
  }
  return paths;
}

/** Los archivos de un arrastre o un pegado; vacío si no traía ninguno. */
export function filesOf(dt: DataTransfer | null | undefined): File[] {
  return dt && dt.files ? [...dt.files] : [];
}

/** ¿Este arrastre lleva archivos del sistema? (una miniatura de la galería no). */
export function carriesFiles(dt: DataTransfer | null | undefined): boolean {
  return !!dt && [...dt.types].includes('Files');
}

/* ── Cablear una caja ──────────────────────────────────────────────── */

export interface AttachOptions {
  /** La clave de drafts.ts de esta caja: por ahí llegan las rutas del lienzo. */
  key: string;
  upload: Upload;
  note: (text: string, level?: 'info' | 'warn' | 'alert') => void;
}

/**
 * Soltar o pegar archivos en `box` los sube y escribe sus rutas en ella.
 *
 * El área que acepta el arrastre es la caja entera (`.ceo__in`, o el padre):
 * apuntar al textarea de dos líneas con un archivo en la mano es demasiado
 * fino. La clase `is-drop` en ese contenedor es lo que el CSS resalta, e
 * `is-uploading` dura lo que la subida. Devuelve cómo soltarlo.
 */
export function bindAttach(box: HTMLTextAreaElement, opts: AttachOptions): () => void {
  const host = box.closest<HTMLElement>('.ceo__in') ?? box.parentElement ?? box;
  let depth = 0;

  const write = (paths: string[]) => {
    if (!paths.length) return;
    const { value, caret } = insertPaths(box, paths);
    box.value = value;
    box.setSelectionRange(caret, caret);
    // Un cambio programático no dispara `input`; el borrador y las etiquetas
    // que siguen al texto (INTERRUPT + SEND) lo necesitan.
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
  };

  const take = async (files: File[]) => {
    if (!files.length) return;
    if (box.disabled) { opts.note('this box cannot take files right now', 'warn'); return; }
    host.classList.add('is-uploading');
    try { write(await uploadAll(files, opts.upload, opts.note)); }
    finally { host.classList.remove('is-uploading'); }
  };

  const enter = (e: DragEvent) => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (++depth === 1) host.classList.add('is-drop');
  };
  const over = (e: DragEvent) => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = box.disabled ? 'none' : 'copy';
  };
  const leave = (e: DragEvent) => {
    if (!carriesFiles(e.dataTransfer)) return;
    if (--depth <= 0) { depth = 0; host.classList.remove('is-drop'); }
  };
  const drop = (e: DragEvent) => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth = 0;
    host.classList.remove('is-drop');
    void take(filesOf(e.dataTransfer));
  };
  const paste = (e: ClipboardEvent) => {
    const files = filesOf(e.clipboardData);
    if (!files.length) return;          // texto: el pegado normal sigue su curso
    e.preventDefault();
    void take(files);
  };

  host.addEventListener('dragenter', enter);
  host.addEventListener('dragover', over);
  host.addEventListener('dragleave', leave);
  host.addEventListener('drop', drop);
  box.addEventListener('paste', paste);
  const offStage = onStage(opts.key, write);

  return () => {
    host.removeEventListener('dragenter', enter);
    host.removeEventListener('dragover', over);
    host.removeEventListener('dragleave', leave);
    host.removeEventListener('drop', drop);
    box.removeEventListener('paste', paste);
    host.classList.remove('is-drop', 'is-uploading');
    offStage();
  };
}

/**
 * Que soltar un archivo fuera de toda caja no abra el archivo en la pestaña.
 *
 * El navegador navega al archivo soltado si nadie reclama el drop; en una
 * consola eso es perder la sesión por un gesto. Se reclama al final del
 * burbujeo y sólo si nadie lo hizo antes, así las cajas y el lienzo mandan.
 */
export function guardStrayDrops(doc: Document = document): () => void {
  const over = (e: DragEvent) => {
    if (e.defaultPrevented || !carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'none';
  };
  const drop = (e: DragEvent) => { if (!e.defaultPrevented && carriesFiles(e.dataTransfer)) e.preventDefault(); };
  doc.addEventListener('dragover', over);
  doc.addEventListener('drop', drop);
  return () => { doc.removeEventListener('dragover', over); doc.removeEventListener('drop', drop); };
}
