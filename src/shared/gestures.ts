/**
 * GESTOS DE LA CONSOLA: qué toca el operador, contado sin contenido.
 *
 * Los contadores `ui:<frame>` de AUTOMEJORA cuentan lo que la consola PIDE al
 * hub, y eso no es lo mismo que lo que el operador HACE. Abrir la galería,
 * desplegar MISIONES, volar a un agente o pulsar ⌥C no le piden nada al hub:
 * ocurren enteras en el navegador, y con sólo las peticiones una revisión
 * veía «7 gestos de consola» al lado de 500 lanzamientos. La pregunta que
 * el brief del revisor hace —qué no toca nadie— no se podía contestar.
 *
 * Esto es el vocabulario con el que se contesta. Cada gesto es un NOMBRE y
 * una CUENTA, `gesture:<familia>:<detalle>`, y viaja al hub en lotes por el
 * mismo camino que los demás contadores (`ImproveStore.record`). Nunca el
 * contenido: ni qué agente, ni qué archivo, ni qué se escribió.
 *
 * ── Familias cerradas, detalles con techo ──────────────────────────
 *
 * Las familias son una LISTA PERMITIDA, no un prefijo libre: un nombre que no
 * cae en una se tira. El detalle sí es libre —es la clase de ventana, la
 * tecla, la sección— pero cada familia tiene un techo de nombres distintos
 * (`MAX_GESTURE_NAMES`); pasado el techo, lo nuevo se funde en `other`. Es
 * lo que impide que una consola con un fallo, o un cliente ajeno, infle el
 * tablero hasta el tope global de contadores y deje fuera a las
 * herramientas de CAPCOM.
 */

/** Las familias de gesto que se cuentan. Lista cerrada. */
export const GESTURE_FAMILIES = ['win', 'hud', 'key', 'fly'] as const;
export type GestureFamily = typeof GESTURE_FAMILIES[number];

/** Qué es cada familia, en las palabras que ve el revisor. */
export const GESTURE_FAMILY_LABELS: Readonly<Record<GestureFamily, string>> = {
  win: 'windows opened, by kind',
  hud: 'HUD sections unfolded or opened',
  key: 'keyboard shortcuts used',
  fly: 'camera flights',
};

export const GESTURE_PREFIX = 'gesture:';
/** El nombre en el que se funde lo que pasa del techo de una familia. */
export const GESTURE_OTHER = 'other';
/** Nombres distintos por familia. Pasado esto, `other`. */
export const MAX_GESTURE_NAMES = 24;
/** Entradas que acepta un lote. Lo que sobre se ignora, no se corta a medias. */
export const MAX_GESTURE_BATCH = 64;
/** Cuenta máxima por nombre y lote. Un lote se manda cada pocos segundos. */
export const MAX_GESTURE_N = 1_000;

/**
 * Las clases de ventana que existen, para que el revisor pueda decir cuáles
 * NO se abrieron. Vive aquí y no en `wm.ts` porque el hub, que no tiene
 * ventanas, es quien escribe esa línea. `wm.ts` deriva su tipo de esta lista.
 */
export const WIN_KINDS = [
  'agent', 'interrupt', 'queue', 'ceo', 'feed', 'fleet', 'spawn', 'artifact', 'breach', 'help', 'settings',
  'gallery', 'launch', 'timeline', 'sfx', 'music', 'terminal', 'file', 'hygiene', 'mission',
] as const;

const DETAIL = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

/**
 * Un detalle libre → uno que cabe en un nombre de contador, o null.
 *
 * Minúsculas, y todo lo que no sea letra, dígito, punto, guión o guión bajo
 * se vuelve un guión. `KeyC` → `keyc`, `sheet improve` → `sheet-improve`. Lo
 * que queda vacío no es un gesto.
 */
export function gestureDetail(raw: string): string | null {
  const d = String(raw ?? '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return DETAIL.test(d) ? d : null;
}

/** El nombre de contador de un gesto, o null si no es contable. */
export function gestureName(family: string, detail: string): string | null {
  if (!(GESTURE_FAMILIES as readonly string[]).includes(family)) return null;
  const d = gestureDetail(detail);
  return d ? `${GESTURE_PREFIX}${family}:${d}` : null;
}

/** De un nombre de contador, su familia y su detalle; null si no es un gesto válido. */
export function parseGesture(name: string): { family: GestureFamily; detail: string } | null {
  if (!name.startsWith(GESTURE_PREFIX)) return null;
  const rest = name.slice(GESTURE_PREFIX.length);
  const i = rest.indexOf(':');
  if (i <= 0) return null;
  const family = rest.slice(0, i);
  const detail = rest.slice(i + 1);
  if (!(GESTURE_FAMILIES as readonly string[]).includes(family) || !DETAIL.test(detail)) return null;
  return { family: family as GestureFamily, detail };
}

/**
 * Un lote tal como llega por el cable → sólo lo que se puede contar.
 *
 * Lo escribe un navegador, así que se valida como lo que escribe un modelo:
 * nombres que no sean gestos, cuentas que no sean enteros positivos y todo lo
 * que pase de `MAX_GESTURE_BATCH` entradas se tira. Las cuentas se recortan a
 * `MAX_GESTURE_N`: un lote sale cada pocos segundos y mil de un mismo gesto
 * en ese rato no es un operador.
 */
export function normalizeGestures(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let taken = 0;
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (taken >= MAX_GESTURE_BATCH) break;
    if (!parseGesture(name)) continue;
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
    if (n <= 0) continue;
    out[name] = Math.min(MAX_GESTURE_N, n);
    taken++;
  }
  return out;
}

/**
 * El nombre bajo el que se guarda un gesto, dado lo que ya hay guardado.
 *
 * Si la familia ya tiene `MAX_GESTURE_NAMES` nombres distintos y éste es
 * nuevo, se funde en `other`. `other` no cuenta contra el techo, así que
 * siempre hay dónde caer.
 */
export function foldGesture(name: string, counts: Readonly<Record<string, number>>): string | null {
  const g = parseGesture(name);
  if (!g) return null;
  if (g.detail === GESTURE_OTHER || counts[name] !== undefined) return name;
  const prefix = `${GESTURE_PREFIX}${g.family}:`;
  let distinct = 0;
  for (const k of Object.keys(counts)) {
    if (k.startsWith(prefix) && k !== `${prefix}${GESTURE_OTHER}`) distinct++;
  }
  return distinct >= MAX_GESTURE_NAMES ? `${prefix}${GESTURE_OTHER}` : name;
}

export interface GestureFamilyCount {
  family: GestureFamily;
  n: number;
  /** Los nombres de la familia, de más a menos. Detalle sin el prefijo. */
  names: { detail: string; n: number }[];
}

/** Los contadores de gesto, agregados por familia. Toda familia sale, con cero incluido. */
export function gesturesByFamily(counts: Readonly<Record<string, number>>): GestureFamilyCount[] {
  const out = new Map<GestureFamily, GestureFamilyCount>(GESTURE_FAMILIES.map((f) => [f, { family: f, n: 0, names: [] }]));
  for (const [name, n] of Object.entries(counts)) {
    const g = parseGesture(name);
    if (!g) continue;
    const fam = out.get(g.family)!;
    fam.n += n;
    fam.names.push({ detail: g.detail, n });
  }
  for (const fam of out.values()) fam.names.sort((a, b) => b.n - a.n || a.detail.localeCompare(b.detail));
  return [...out.values()];
}

/** Las clases de ventana que no se abrieron ni una vez en estos contadores. */
export function windowKindsNeverOpened(counts: Readonly<Record<string, number>>): string[] {
  return WIN_KINDS.filter((k) => !((counts[`${GESTURE_PREFIX}win:${k}`] ?? 0) > 0));
}
