/**
 * Quién es CAPCOM, en un solo sitio.
 *
 * Ese hecho —qué sesión lleva el mando ahora mismo, y con qué hay que
 * relanzarla— vivía repartido en dos archivos que no se hablaban:
 *
 *   session.json         `{ shortId }`: la sesión adoptada.
 *   codex-recovery.json  la sesión, su runtime, su modelo y su cwd, escrito
 *                        por cada traspaso, y con PRIORIDAD sobre el anterior.
 *
 * Dos registros del mismo hecho, uno con más autoridad que el otro y ninguna
 * regla escrita sobre cuál actualizar. La consecuencia se vio el 2026-09-07:
 * un `/clear` movió el rol en memoria y en `session.json` y no tocó el otro, y
 * el vigilante devolvió el mando a un hilo ya vaciado. La flota se quedó sin
 * CAPCOM con el proceso corriendo delante, y la lectura de disco decía dos
 * cosas distintas a la vez.
 *
 * Aquí hay uno: `capcom.json`. Un hecho, un archivo, una escritura atómica.
 *
 * ── Cómo llega lo que ya existe ────────────────────────────────────
 *
 * `read` migra sola: si no hay `capcom.json` pero sí los antiguos, los combina
 * dando prioridad a la recuperación —que es la que la mandaba— y devuelve el
 * resultado. La migración no borra nada: los archivos viejos se quedan donde
 * están, porque una versión anterior del collector que vuelva a arrancar tiene
 * que seguir encontrando lo suyo, y porque un archivo de recuperación es
 * evidencia de un traspaso además de un puntero.
 *
 * ── Lo que NO vive aquí ────────────────────────────────────────────
 *
 * El nombre del pane (`orca-<sessionId>`) se deriva, no se guarda. El rol en
 * `lineage.json` y el `role:'capcom'` del mundo del hub son publicaciones de
 * este hecho, no copias con voto propio: se escriben al adoptar y se leen para
 * enrutar, nunca para decidir quién manda.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface CapcomIdentity {
  /** La sesión que lleva el mando. */
  sessionId: string;
  runtime: 'claude' | 'codex';
  model: string;
  /** Dónde corre, cuando no es el directorio de CAPCOM. */
  cwd?: string;
  /** Con qué contexto nació, si nació de un reset o un traspaso. */
  contextMode?: 'continuity' | 'clean';
  /** Nada anterior a esto pertenece a su contexto. */
  cutoffAt?: number;
  /* ── de dónde viene, para el acta del cambio ── */
  previousSessionId?: string;
  previousRuntime?: string;
  previousModel?: string | null;
  reason?: string;
  activatedAt?: string;
  /** Referencias del traspaso que la creó, cuando lo hubo. */
  handoffId?: string;
  archive?: string;
  historyPath?: string;
  checkpointPath?: string;
  handoffModel?: string;
}

export const IDENTITY_FILE = 'capcom.json';
/** Los dos de los que se migra. Se leen; no se escriben ni se borran. */
export const LEGACY_FILES = ['codex-recovery.json', 'session.json'] as const;

/**
 * Un id de sesión, de cualquiera de las dos formas que CAPCOM ha tenido: el
 * UUID de una hospedada, o el short id que imprimía un `--bg`. Cuál de las dos
 * es se deduce de la forma, y sólo importa a quien decida cómo relanzarla —
 * aquí se guarda quién manda, no qué se puede hacer con ello.
 */
const sessionRef = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._-]{4,80}$/.test(v);
const modelName = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v);

/**
 * Lo que hay en disco, o `null`.
 *
 * Falla cerrado y ruidoso: una identidad a medias —sin sesión, sin modelo, con
 * un runtime que no se reconoce— se rechaza en vez de completarse con valores
 * por defecto. Adivinar aquí significa relanzar el CLI equivocado sobre la
 * conversación equivocada, que es peor que no arrancar y decirlo.
 */
export function readIdentity(dir: string): CapcomIdentity | null {
  const file = path.join(dir, IDENTITY_FILE);
  if (fs.existsSync(file)) return parseIdentity(JSON.parse(fs.readFileSync(file, 'utf8')), IDENTITY_FILE);
  const migrated = fromLegacy(dir);
  if (migrated) writeIdentity(dir, migrated);
  return migrated;
}

function parseIdentity(raw: unknown, from: string, fallbackRuntime?: 'claude' | 'codex'): CapcomIdentity {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (!sessionRef(r['sessionId'])) throw new Error(`invalid ${from}: no usable session id; refusing to guess which CAPCOM to run`);
  /*
   * Un modelo sin declarar no invalida el resto.
   *
   * Un registro puede traer sólo el rastro de un traspaso —dónde quedó el
   * historial, qué plan lo creó— y rechazarlo entero por no nombrar un modelo
   * perdería eso. `default` es el centinela de «no declarado», y `recovery`,
   * que es quien necesita saber con qué relanzar, lo lee como «nada que
   * reanudar» en vez de inventarse uno.
   */
  const model = modelName(r['model']) ? r['model'] : 'default';
  /*
   * El runtime es obligatorio en `capcom.json` y opcional en lo migrado.
   *
   * Un `codex-recovery.json` escrito antes de que hubiera dos runtimes no lo
   * declaraba: lo decía el nombre del archivo, y el código lo asumía. Rechazar
   * ese archivo dejaría sin CAPCOM a quien actualice, así que se le concede lo
   * que siempre significó — y lo que se escriba a partir de ahí ya lo lleva.
   */
  const runtime = r['runtime'] === 'claude' || r['runtime'] === 'codex' ? r['runtime'] : fallbackRuntime;
  if (!runtime) throw new Error(`invalid ${from}: unknown runtime "${String(r['runtime'])}"`);
  /*
   * Declarar modelo es decir «esta sesión se preparó», y una sesión preparada
   * tiene UUID. Un modelo junto a un short id de `--bg` no es una de las dos
   * formas válidas: es un registro corrupto, y reanudar a partir de él sería
   * lanzar un CLI sobre una conversación que no existe. Falla cerrado.
   */
  if (model !== 'default' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r['sessionId'])) {
    throw new Error(`invalid ${from}: "${r['sessionId']}" is not a hosted session id but a model is declared; refusing to resume it`);
  }
  const out: CapcomIdentity = { sessionId: r['sessionId'], model, runtime };
  for (const key of ['cwd', 'contextMode', 'previousSessionId', 'previousRuntime', 'reason', 'activatedAt',
    'handoffId', 'archive', 'historyPath', 'checkpointPath', 'handoffModel'] as const) {
    if (typeof r[key] === 'string') (out as unknown as Record<string, unknown>)[key] = r[key];
  }
  if (typeof r['previousModel'] === 'string' || r['previousModel'] === null) out.previousModel = r['previousModel'] as string | null;
  if (typeof r['cutoffAt'] === 'number') out.cutoffAt = r['cutoffAt'];
  if (out.contextMode !== undefined && out.contextMode !== 'clean' && out.contextMode !== 'continuity') delete out.contextMode;
  return out;
}

/**
 * Los dos archivos viejos, combinados como se comportaban.
 *
 * La recuperación mandaba, así que manda; `session.json` sólo aporta la sesión
 * cuando no hay recuperación, y entonces no hay runtime ni modelo que declarar
 * —esa era la forma de un CAPCOM de Claude arrancado sin traspaso—, así que se
 * completa con lo que ese caso significaba: `claude`, y el modelo por defecto
 * de su CLI, que es lo que `--resume` sin `--model` hacía.
 */
function fromLegacy(dir: string): CapcomIdentity | null {
  let recovery: Record<string, unknown> | null = null;
  try { recovery = JSON.parse(fs.readFileSync(path.join(dir, 'codex-recovery.json'), 'utf8')) as Record<string, unknown>; } catch { /* no la había */ }
  if (recovery) return parseIdentity(recovery, 'codex-recovery.json', 'codex');
  let state: Record<string, unknown> | null = null;
  try { state = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as Record<string, unknown>; } catch { return null; }
  const id = state['shortId'];
  if (!sessionRef(id)) return null;
  // Sin traspaso no hay runtime ni modelo declarados: era la forma de un CAPCOM
  // de Claude arrancado a secas, y `default` es justo lo que `--resume` sin
  // `--model` hacía. `recovery()` lo lee como «nada que reanudar».
  return { sessionId: id, runtime: 'claude', model: 'default' };
}

/**
 * Mirar sin decidir: `null` en vez de excepción cuando no hay o no vale.
 *
 * Quien pregunta «¿quién manda?» necesita que un archivo roto sea ruidoso, y
 * por eso `readIdentity` lanza. Quien sólo quiere anotar algo —el controlador
 * de modelos, que gobierna también agentes cuyos ids no son sesiones de CAPCOM—
 * no debe fallar porque el archivo que miró no fuera una identidad de mando.
 */
export function peekIdentity(dir: string): CapcomIdentity | null {
  try { return readIdentity(dir); } catch { return null; }
}

/** Escritura atómica: quien lea a la vez ve la anterior o la nueva, nunca media. */
export function writeIdentity(dir: string, identity: CapcomIdentity): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, IDENTITY_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * El mando pasa a otra sesión, conservando lo que no cambia.
 *
 * Un relevo hereda runtime, modelo y directorio salvo que se diga otra cosa
 * —un `/clear` es el mismo proceso— y siempre encadena de dónde viene, que es
 * lo que convierte una sucesión de sesiones en un linaje legible.
 */
export function succeed(previous: CapcomIdentity | null, next: Partial<CapcomIdentity> & { sessionId: string }, at: number): CapcomIdentity {
  const runtime = next.runtime ?? previous?.runtime;
  const model = next.model ?? previous?.model;
  if (!runtime || !model) throw new Error('A CAPCOM identity needs a runtime and a model; refusing to record a partial one.');
  const out: CapcomIdentity = {
    ...(previous ?? {}), ...next, runtime, model,
    activatedAt: new Date(at).toISOString(),
    ...(previous ? { previousSessionId: previous.sessionId, previousRuntime: previous.runtime, previousModel: previous.model } : {}),
  };
  if (next.cwd === undefined && previous?.cwd) out.cwd = previous.cwd;
  return out;
}

/** Borrar el hecho: no hay CAPCOM. Los archivos antiguos se dejan como evidencia. */
export function clearIdentity(dir: string): void {
  try { fs.rmSync(path.join(dir, IDENTITY_FILE)); } catch { /* no la había */ }
}
