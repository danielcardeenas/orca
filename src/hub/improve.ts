/**
 * AUTOMEJORA, lado hub: los contadores, el almacén y el lanzador.
 *
 * Tres piezas y una sola razón para estar juntas — las tres existen para que
 * una revisión ocurra *de vez en cuando, con motivo, y a la vista*:
 *
 *   UsageMeter    cuenta gestos. `ui:<frame>` lo que pide la consola,
 *                 `mcp:<tool>` lo que llama CAPCOM. Nombres y cuentas, nunca
 *                 contenido. Es la telemetría entera, y cabe en un objeto.
 *   ImproveStore  guarda propuestas, revisiones, config y contadores en
 *                 `~/.orca/hub/improve/improve.json`, con el mismo
 *                 escribir-y-renombrar que `missions.json`.
 *   createImprove el reloj y el ciclo de vida de la revisión: mira si toca
 *                 (ver `dueForReview`), LANZA UN AGENTE REVISOR por el camino
 *                 normal de spawn, lo sigue hasta que reporta o muere, y cierra.
 *
 * ── Un agente, no un turno ─────────────────────────────────────────
 *
 * La revisión la hace un agente temporal que ORCA lanza como lanza cualquier
 * otro: aparece en el campo, tiene callsign, estado, coste y ventana, se le
 * puede volar, mirar y parar. Antes esto era un turno de CAPCOM, y un turno de
 * CAPCOM no se puede mirar: no se sabe si está pensando, cuánto lleva ni
 * cuánto ha gastado, y compite por el contexto del mando con todo lo demás.
 *
 * Lo que eso obliga a hacer bien es el CIERRE. Un turno o contesta o no; un
 * agente puede morir, colgarse, quedarse esperando, o terminar sin haber dicho
 * nada. Cada una de esas es un estado distinto (`ReviewStatus`) y ninguna se
 * cuenta como «revisión completada»: `reported` se gana archivando propuestas
 * y nada más.
 *
 * ── Una sola revisión, y nunca en bucle ────────────────────────────
 *
 * El sitio se reserva ANTES de pedir el spawn (`beginReview` deja la revisión
 * en `launching`), así que dos ticks no pueden lanzar dos revisores ni aunque
 * el spawn tarde. Y la señal que dispara una revisión son los contadores de la
 * CONSOLA y de CAPCOM, que un revisor no toca: un revisor no puede provocar la
 * siguiente revisión ni aunque trabaje una hora.
 *
 * Nada de esto ocurre en un render: la consola mira, no dispara.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { newId, type Command, type SpawnAck } from '../shared/protocol.ts';
import { isForgeSquad } from '../shared/forge.ts';
import { TERMINAL_STATES, type Agent, type Project } from '../shared/types.ts';
import { ceilingTokens } from '../shared/tokens.ts';
import {
  IMPROVE_DEFAULTS, MAX_COUNTERS, MAX_NOTE, MAX_NOTES, MAX_PER_REPORT, MAX_PROPOSALS,
  BUDGET_MAX, BUDGET_MIN, MAX_REVIEWS, REVIEWER_BUDGET_TOKENS, REVIEWER_IDLE_MS, REVIEW_MAX_MS,
  STOP_ATTEMPTS, STOP_BACKOFF_MS, activeReview, dueForReview, effectiveChoice, validateChoice,
  MISSION_STATUSES, effectiveStatus, emptyState, emptyUsage, findDuplicate, linkedStatus, normalizeDraft, openProposals,
  redact, reviewerBrief, topCounters, HOUR_MS, USAGE_HOURS, foldHours, hourOf,
  type ImproveConfig, type ImproveProposal, type ImproveReview, type ImproveState,
  type ImproveUsage, type ProposalDraft, type ReviewStatus, type TelemetryDigest, type UsageHour,
} from '../shared/improve.ts';
import type { CapcomMission } from '../shared/missions.ts';
import { GESTURE_FAMILY_LABELS, GESTURE_PREFIX, foldGesture, gesturesByFamily, windowKindsNeverOpened } from '../shared/gestures.ts';
import type { AutonomyDeps } from './autonomy.ts';
import type { JournalApi, JournalStats } from './journal.ts';
import { fmtTokens } from './budgets.ts';
import type { CapcomTimer } from './capcom.ts';

export const IMPROVE_DIR = 'improve';
export const IMPROVE_FILE = 'improve.json';
/**
 * Cada cuánto se mira si toca, se barre lo colgado y se comprueba el gasto del
 * revisor en vuelo.
 *
 * Veinte segundos y no sesenta, y el motivo es el gasto: medido en la primera
 * revisión real, un revisor cruzó su techo de 400k en menos de un minuto. Con
 * un tic de sesenta segundos, la comprobación llegaba una vez pasado el
 * problema. El tic no cuesta nada —lee un objeto en memoria y sale por la
 * primera condición que falla— así que mirar tres veces más a menudo es gratis
 * y acorta el rebase.
 */
export const IMPROVE_TICK_MS = 20_000;
/** La ventana de telemetría que se le enseña al revisor: el anillo entero. */
export const DIGEST_WINDOW_MS = USAGE_HOURS * HOUR_MS;
/**
 * Cada cuánto se guardan las cuentas nuevas. Un minuto: lo peor que pierde un
 * reinicio es ese minuto, y escribir el fichero más a menudo no compra nada.
 */
export const USAGE_SAVE_MS = 60_000;
/** Tope del fichero. Muy por debajo de lo que 60 propuestas ocupan. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * La raíz de ORCA, para encontrar su propio repositorio entre los proyectos.
 *
 * `src/hub/` → `../..`. El mismo truco que usa `collector/shims.ts` para
 * encontrar `bin/`, y por la misma razón: es el único sitio del que ORCA sabe
 * con certeza que es suyo.
 */
export const ORCA_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/* ── configuración por entorno ────────────────────────────────────── */

export interface ImproveEnv {
  /** `ORCA_IMPROVE=0` apaga la sección entera: ni reloj, ni revisión manual. */
  enabled: boolean;
  defaults: ImproveConfig & { budgetTokens: number };
  /** Id, código o ruta del proyecto donde corre el revisor. Vacío = el repo de ORCA. */
  project: string;
  /** Con qué CLI se lanza. Ver `spawnCommand`. */
  runtime: string;
  model: string;
}

function num(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function improveEnv(env: Record<string, string | undefined> = process.env): ImproveEnv {
  return {
    enabled: env['ORCA_IMPROVE'] !== '0',
    defaults: {
      paused: env['ORCA_IMPROVE_PAUSED'] === '1',
      everyMin: num(env['ORCA_IMPROVE_EVERY_MIN'], IMPROVE_DEFAULTS.everyMin, 5, 7 * 24 * 60),
      perDay: num(env['ORCA_IMPROVE_PER_DAY'], IMPROVE_DEFAULTS.perDay, 1, 48),
      minSignal: num(env['ORCA_IMPROVE_MIN_SIGNAL'], IMPROVE_DEFAULTS.minSignal, 0, 100_000),
      budgetTokens: num(env['ORCA_IMPROVE_BUDGET_TOKENS'], REVIEWER_BUDGET_TOKENS, 20_000, 20_000_000),
    },
    project: (env['ORCA_IMPROVE_PROJECT'] ?? '').trim(),
    runtime: (env['ORCA_IMPROVE_RUNTIME'] ?? 'claude').trim() || 'claude',
    model: (env['ORCA_IMPROVE_MODEL'] ?? '').trim(),
  };
}

/* ── el almacén ───────────────────────────────────────────────────── */

export interface FileOutcome {
  filed: number;
  merged: number;
  /** Los borradores que no pasaron la validación, con el motivo. */
  rejected: string[];
  proposals: ImproveProposal[];
}

export type ImproveAct =
  | { act: 'seen' }
  | { act: 'reply'; text: string }
  | { act: 'snooze'; untilMs: number }
  | { act: 'dismiss'; text?: string }
  | { act: 'reopen' }
  | { act: 'sent'; missionId: string };

/** Quién archivó unas propuestas, cuando fue un agente y no una herramienta. */
export interface Reporter { agentId?: string; callsign?: string }

/**
 * Lo que va al fichero: el estado, con la ventana plegada en `usage` (lo que
 * lee un hub anterior) y el anillo del que sale en `usageHours`.
 */
type StoredImprove = Omit<ImproveState, 'degraded'> & { usageHours: UsageHour[]; usageSince: number };

function isHour(v: unknown): v is UsageHour {
  if (!v || typeof v !== 'object') return false;
  const h = v as Partial<UsageHour>;
  return Number.isFinite(h.hour) && Number.isFinite(h.total) && !!h.counts && typeof h.counts === 'object'
    && Object.values(h.counts).every((n) => Number.isFinite(n));
}

/**
 * El anillo, tal como lo dejó el fichero.
 *
 * Un fichero anterior al anillo trae UNA ventana sin horas (`usage`). No se
 * tira: lo que también está en `signal` pasó después de la última revisión y
 * va a esa hora; el resto va a la hora más vieja que pueda ser suya. Así nada
 * se queda más de lo que le toca. Y si todo lo contado está en `signal`, la
 * ventana cuenta desde la última revisión y no desde el `since` viejo, que
 * pudo ser el de un vaciado.
 */
function loadRing(loaded: Partial<StoredImprove>, signal: ImproveUsage, now: number): { hours: UsageHour[]; since: number } {
  const first = hourOf(now) - (USAGE_HOURS - 1) * HOUR_MS;
  const since = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  if (Array.isArray(loaded.usageHours)) {
    return {
      hours: loaded.usageHours.filter(isHour).filter((h) => h.hour >= first && h.hour <= now).sort((a, b) => a.hour - b.hour),
      since: since(loaded.usageSince, since(loaded.usage?.since, now)),
    };
  }
  const old = loaded.usage;
  if (!old?.counts) return { hours: [], since: now };
  const oldSince = since(old.since, now);
  const byHour = new Map<number, UsageHour>();
  const put = (at: number, name: string, n: number): void => {
    const hour = Math.max(first, hourOf(Math.min(at, now)));
    const h = byHour.get(hour) ?? { hour, counts: {}, total: 0 };
    h.counts[name] = (h.counts[name] ?? 0) + n;
    h.total += n;
    byHour.set(hour, h);
  };
  const signalInside = signal.since >= oldSince;
  let all = 0, recent = 0;
  for (const [name, raw] of Object.entries(old.counts)) {
    const n = Number.isFinite(raw) ? raw : 0;
    if (n <= 0) continue;
    const late = signalInside ? Math.min(n, signal.counts[name] ?? 0) : 0;
    if (late > 0) put(signal.since, name, late);
    if (n - late > 0) put(oldSince, name, n - late);
    all += n; recent += late;
  }
  return {
    hours: [...byHour.values()].sort((a, b) => a.hour - b.hour),
    since: signalInside && all > 0 && recent === all ? signal.since : oldSince,
  };
}

export class ImproveStore {
  /** Todo menos la ventana de uso, que vive en `hours` y se pliega al leerla. */
  private data: Omit<ImproveState, 'usage' | 'degraded'>;
  /** El anillo de la ventana de uso: un cubo por hora, el más viejo primero. */
  private hours: UsageHour[] = [];
  /** Desde cuándo cuenta este almacén, para que un cero tenga fecha. */
  private usageSince: number;
  /** Hay cuentas en memoria que el disco todavía no tiene. Ver `flush`. */
  private usageDirty = false;
  private filePath: string;
  /** Por qué no se puede guardar, cuando no se puede. Viaja hasta el panel. */
  private degraded: string | null = null;

  constructor(
    dir: string,
    private now: () => number = Date.now,
    private changed: () => void = () => {},
    defaults?: ImproveConfig & { budgetTokens?: number },
    /**
     * El runtime del entorno, para saber cuál es el EFECTIVO.
     *
     * `setConfig` necesita distinguir «heredar» de «claude»: sin esto, volver
     * a heredar parecería un cambio cuando no lo es, o parecería no serlo
     * cuando el entorno corre otro CLI.
     */
    private envRuntime: () => string = () => 'claude',
  ) {
    const home = path.join(dir, IMPROVE_DIR);
    // Un directorio que no se puede crear no tumba el hub: la sección sigue
    // en memoria y lo DICE (`degraded`), que es lo único que hace honesta la
    // degradación — un tablero que se pierde al reiniciar sin avisar es peor
    // que uno que no existe. Mismo criterio que el diario.
    try { fs.mkdirSync(home, { recursive: true }); }
    catch (err) { this.degraded = `cannot write ${home}: ${err instanceof Error ? err.message : String(err)}`; }
    this.filePath = path.join(home, IMPROVE_FILE);
    const { usage: _empty, ...empty } = emptyState(this.now());
    this.data = empty;
    this.usageSince = this.now();
    if (defaults) {
      this.data.config = { paused: defaults.paused, everyMin: defaults.everyMin, perDay: defaults.perDay, minSignal: defaults.minSignal };
      this.data.budgetTokens = defaults.budgetTokens ?? REVIEWER_BUDGET_TOKENS;
    }
    if (fs.existsSync(this.filePath)) {
      // Un fichero ilegible no puede tumbar el hub: la sección arranca vacía y
      // lo dice. Lo que se pierde son propuestas, no la flota.
      try {
        const loaded = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<StoredImprove>;
        this.data = {
          config: { ...IMPROVE_DEFAULTS, ...(defaults ?? {}), ...(loaded.config ?? {}) },
          budgetTokens: loaded.budgetTokens ?? this.data.budgetTokens,
          // Ausentes en un fichero anterior a que esto se pudiera elegir: se
          // quedan en null, que significa «lo que diga el entorno» — que es
          // exactamente lo que esa instalación hacía antes de actualizar.
          runtime: typeof loaded.runtime === 'string' ? loaded.runtime : null,
          model: typeof loaded.model === 'string' ? loaded.model : null,
          proposals: loaded.proposals && typeof loaded.proposals === 'object' ? loaded.proposals : {},
          reviews: Array.isArray(loaded.reviews) ? loaded.reviews : [],
          signal: loaded.signal?.counts ? loaded.signal : emptyUsage(this.now()),
        };
        const ring = loadRing(loaded, this.data.signal, this.now());
        this.hours = ring.hours;
        this.usageSince = ring.since;
      } catch { /* se queda el vacío */ }
    }
  }

  state(): ImproveState {
    return { ...structuredClone(this.data), usage: this.usage(), ...(this.degraded ? { degraded: this.degraded } : {}) };
  }
  config(): ImproveConfig { return { ...this.data.config }; }

  /**
   * Cambiar los límites y la elección.
   *
   * Todo lo numérico se RECORTA al rango, no se rechaza: el panel ofrece unos
   * presets pero también deja escribir un valor, y una caja de texto es por
   * donde entra un cero de más. La elección de runtime/modelo sí se rechaza
   * con su motivo, porque ahí no hay un valor cercano razonable al que
   * recortar — un runtime que ORCA no sabe lanzar no se parece a ninguno.
   *
   * Nada de esto toca una revisión en curso: los valores se leen al LANZAR y
   * se sellan en la revisión (ver `beginReview`).
   *
   * Cambiar de runtime efectivo BORRA el modelo, salvo que el mismo parche
   * traiga uno. Un alias de Claude Code no existe en el catálogo de Codex, así
   * que la pareja que quedaría no es «rara»: es imposible, y sólo se
   * descubriría al fallar el lanzamiento. La regla vive aquí y no en el panel
   * porque la consola no es la única puerta.
   */
  setConfig(patch: Partial<ImproveConfig & { budgetTokens: number; runtime: string | null; model: string | null }>): ImproveSettings {
    const choice = validateChoice(patch);
    if (!choice.ok) throw new Error(choice.error);
    const next = { ...this.data.config };
    if (typeof patch.paused === 'boolean') next.paused = patch.paused;
    if (Number.isFinite(patch.everyMin)) next.everyMin = Math.min(7 * 24 * 60, Math.max(5, Math.round(patch.everyMin!)));
    if (Number.isFinite(patch.perDay)) next.perDay = Math.min(48, Math.max(1, Math.round(patch.perDay!)));
    if (Number.isFinite(patch.minSignal)) next.minSignal = Math.min(100_000, Math.max(0, Math.round(patch.minSignal!)));
    if (Number.isFinite(patch.budgetTokens)) this.data.budgetTokens = Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, Math.round(patch.budgetTokens!)));
    const wasRuntime = this.data.runtime ?? this.envRuntime();
    if (choice.value.runtime !== undefined) this.data.runtime = choice.value.runtime;
    const nowRuntime = this.data.runtime ?? this.envRuntime();
    // El modelo explícito del mismo parche gana: elegir CLI y modelo a la vez
    // es una sola decisión, y borrarla sería contradecir lo que se acaba de
    // pedir. Sin él, un cambio de runtime efectivo lo deja en «lo que diga el
    // CLI», que es lo único que se sabe válido.
    if (choice.value.model !== undefined) this.data.model = choice.value.model;
    else if (nowRuntime !== wasRuntime) this.data.model = null;
    this.data.config = next;
    this.save();
    return {
      ...next,
      budgetTokens: this.data.budgetTokens,
      runtime: this.data.runtime,
      model: this.data.model,
    };
  }

  /**
   * Un gesto más.
   *
   * Dos acumuladores con el mismo hecho: `usage` es la ventana que se le
   * enseña al revisor, `signal` es lo que ha pasado DESDE la última revisión y
   * es lo que decide si vale la pena lanzar otra. Separados porque se ponen a
   * cero en momentos distintos, y un solo contador no puede responder a las
   * dos preguntas.
   *
   * No escribe a disco en cada llamada —son miles al día—: marca que hay
   * cuentas nuevas y `flush`, con su temporizador, las guarda. Antes no se
   * guardaban hasta que pasara algo que importara, y el hub se reinicia a
   * menudo: la ventana que veía el revisor salía corta sin decirlo.
   *
   * Un gesto de la interfaz (`gesture:…`) pasa además por su techo de familia
   * (`foldGesture`): pasado `MAX_GESTURE_NAMES` nombres distintos en una
   * familia, lo nuevo se funde en `other`. Un nombre con ese prefijo que no
   * sea un gesto válido no entra. Es lo que impide que la consola —que manda
   * lotes que escribe un navegador— llene el tope global de contadores y deje
   * fuera a las herramientas de CAPCOM.
   */
  record(name: string, n = 1): void {
    if (!/^[a-z]+:[A-Za-z0-9_:.-]{1,60}$/.test(name)) return;
    if (!Number.isFinite(n) || n <= 0) return;
    const window = this.usage().counts;
    if (name.startsWith(GESTURE_PREFIX)) {
      const folded = foldGesture(name, window);
      if (!folded) return;
      name = folded;
    }
    // El tope de nombres distintos es de la VENTANA, no de cada hora: si no,
    // veinticuatro horas podrían juntar veinticuatro veces el tope.
    if (window[name] !== undefined || Object.keys(window).length < MAX_COUNTERS) {
      const bucket = this.hourNow();
      bucket.counts[name] = (bucket.counts[name] ?? 0) + n;
      bucket.total += n;
      this.usageDirty = true;
    }
    const signal = this.data.signal;
    if (signal.counts[name] !== undefined || Object.keys(signal.counts).length < MAX_COUNTERS) {
      signal.counts[name] = (signal.counts[name] ?? 0) + n;
      signal.total += n;
      this.usageDirty = true;
    }
  }

  /**
   * La ventana de telemetría: las últimas `windowMs`, en cubos de una hora.
   *
   * Leerla recorta lo que ya salió del anillo y NADA MÁS. Antes, una ventana
   * de más de 48 h se reemplazaba entera por una vacía, y como el informe se
   * compone al lanzar la revisión, era esa lectura la que la vaciaba: el
   * revisor veía cero herramientas, cero peticiones y cero gestos.
   */
  usage(windowMs = DIGEST_WINDOW_MS): ImproveUsage {
    const now = this.now();
    this.trimHours(now);
    return foldHours(this.hours, now, this.usageSince, Math.max(1, Math.ceil(windowMs / HOUR_MS)));
  }

  /**
   * Guarda si hay cuentas que el disco no tiene. Lo llama un temporizador
   * (`USAGE_SAVE_MS`) y el cierre del hub; no avisa a las consolas, porque
   * unas cuentas más no cambian nada de lo que el panel enseña.
   */
  flush(): boolean {
    if (!this.usageDirty) return false;
    this.save(false);
    return true;
  }

  /** El cubo de la hora en curso, creado si hace falta. */
  private hourNow(): UsageHour {
    const now = this.now();
    const hour = hourOf(now);
    const last = this.hours[this.hours.length - 1];
    if (last && last.hour === hour) return last;
    this.trimHours(now);
    const bucket: UsageHour = { hour, counts: {}, total: 0 };
    this.hours.push(bucket);
    this.hours.sort((a, b) => a.hour - b.hour);
    return bucket;
  }

  /** Suelta los cubos que ya salieron del anillo. */
  private trimHours(now: number): void {
    const first = hourOf(now) - (USAGE_HOURS - 1) * HOUR_MS;
    if (this.hours.length && this.hours[0]!.hour < first) this.hours = this.hours.filter((h) => h.hour >= first);
  }

  signal(): ImproveUsage { return structuredClone(this.data.signal); }

  /* ── revisiones ─────────────────────────────────────────────────── */

  /**
   * Reserva el sitio ANTES de pedir el spawn.
   *
   * El orden es lo que impide dos revisores: el spawn tarda segundos, y un tic
   * que llegara mientras tanto vería el hueco libre. Con la revisión ya en
   * `launching`, no lo ve.
   */
  beginReview(trigger: ImproveReview['trigger'], reason: string, with_: { runtime: string; model: string | null }): ImproveReview {
    const review: ImproveReview = {
      id: newId('rev'), at: this.now(), trigger, reason: reason.slice(0, 200),
      status: 'launching', filed: 0, merged: 0, budgetTokens: this.data.budgetTokens,
      // Lo EFECTIVO, sellado: cambiar el modelo en SETUP no reescribe lo que
      // ya corrió, y una revisión en vuelo sigue con el suyo.
      runtime: with_.runtime,
      ...(with_.model ? { model: with_.model } : {}),
    };
    this.data.reviews = [review, ...this.data.reviews].slice(0, MAX_REVIEWS);
    // La señal se pone a cero al LANZAR, no al recibir el informe: lo que se
    // le está enseñando al revisor es lo acumulado hasta aquí, y contarlo otra
    // vez haría que una consola quieta pareciera activa para siempre.
    this.data.signal = emptyUsage(this.now());
    this.save();
    return { ...review };
  }

  /** El spawn respondió: ya hay a quién mirar. */
  bindReviewer(reviewId: string, who: { agentId?: string | null; shortId?: string | null; callsign?: string | null; projectId?: string; machineId?: string }): ImproveReview | null {
    const r = this.data.reviews.find((x) => x.id === reviewId);
    if (!r) return null;
    if (who.agentId) r.agentId = who.agentId;
    if (who.shortId) r.shortId = who.shortId;
    if (who.callsign) r.callsign = who.callsign;
    if (who.projectId) r.projectId = who.projectId;
    if (who.machineId) r.machineId = who.machineId;
    if (r.status === 'launching') r.status = 'running';
    this.save();
    return { ...r };
  }

  /**
   * Decide CÓMO acabó una revisión sin soltar el sitio.
   *
   * Se pasó del techo, se le acabó el reloj, o el operador la paró: el
   * resultado ya está, pero su agente puede seguir vivo, y mientras pueda
   * seguir vivo no hay hueco para otro. `endedAt` lo pone `closeReview`, y sólo
   * cuando el mundo confirma que se fue.
   */
  settleOutcome(reviewId: string, status: ReviewStatus, note: string, spend?: { costUSD?: number; tokens?: number }): ImproveReview | null {
    const r = this.data.reviews.find((x) => x.id === reviewId);
    if (!r || r.endedAt !== undefined) return null;
    // Un resultado ya decidido no se pisa: lo primero que pasó es lo que pasó.
    if (r.outcomeAt === undefined) {
      if (r.status !== 'reported') r.status = status;
      r.outcomeAt = this.now();
    }
    r.note = note.slice(0, 300);
    if (spend?.costUSD !== undefined) r.costUSD = spend.costUSD;
    if (spend?.tokens !== undefined) r.tokens = spend.tokens;
    this.save();
    return { ...r };
  }

  /** Un `stop` más a un revisor que no se muere. Sólo cuenta, no manda nada. */
  noteStop(reviewId: string): number {
    const r = this.data.reviews.find((x) => x.id === reviewId);
    if (!r) return 0;
    r.stopAttempts = (r.stopAttempts ?? 0) + 1;
    r.lastStopAt = this.now();
    this.save();
    return r.stopAttempts;
  }

  /**
   * Cierra una revisión, y no miente sobre cómo acabó.
   *
   * Una que ya archivó propuestas se queda `reported` pase lo que pase después
   * —el agente termina, o lo paran, y eso no deshace lo que entregó—; sólo se
   * le apunta cuándo terminó y qué costó.
   */
  closeReview(reviewId: string, status: ReviewStatus, note?: string, spend?: { costUSD?: number; tokens?: number }): ImproveReview | null {
    const r = this.data.reviews.find((x) => x.id === reviewId);
    if (!r) return null;
    if (r.status !== 'reported') r.status = status;
    r.endedAt = this.now();
    if (note) r.note = note.slice(0, 300);
    if (spend?.costUSD !== undefined) r.costUSD = spend.costUSD;
    if (spend?.tokens !== undefined) r.tokens = spend.tokens;
    this.save();
    return { ...r };
  }

  /**
   * El operador pidió pararla. NO la cierra.
   *
   * Marca el estado y la hora de la petición, y deja `endedAt` sin poner, así
   * que la revisión sigue ocupando el sitio hasta que el mundo confirme que su
   * agente se murió (o hasta que se agote la gracia). Cerrarla aquí liberaría
   * el hueco con el revisor todavía vivo.
   */
  requestCancel(reviewId: string, note: string): ImproveReview | null {
    const r = this.data.reviews.find((x) => x.id === reviewId);
    if (!r || r.endedAt !== undefined) return null;
    r.cancelledAt = this.now();
    return this.settleOutcome(reviewId, 'cancelled', note);
  }

  /** La revisión que ocupa el sitio, o null. */
  active(): ImproveReview | null { return activeReview(this.data, this.now()); }

  review(id: string): ImproveReview | null {
    return this.data.reviews.find((r) => r.id === id) ?? null;
  }

  /**
   * Archiva lo que reportó una revisión.
   *
   * Cada borrador se valida y se compara con lo que ya hay: lo repetido sube
   * `raised` y refresca la evidencia sin volver a avisar, lo nuevo entra sin
   * ver. Un borrador inválido no tumba a los demás — vuelve como motivo, que
   * es algo que el revisor puede corregir y volver a mandar.
   */
  file(reviewId: string | null, drafts: ProposalDraft[], by: Reporter = {}): FileOutcome {
    const now = this.now();
    const out: FileOutcome = { filed: 0, merged: 0, rejected: [], proposals: [] };
    for (const raw of drafts.slice(0, MAX_PER_REPORT)) {
      const parsed = normalizeDraft(raw);
      if (!parsed.ok) { out.rejected.push(parsed.error); continue; }
      const v = parsed.value;
      const dup = findDuplicate(this.data, v.key, v.title);
      if (dup) {
        const p = this.data.proposals[dup.id]!;
        p.raised += 1;
        p.lastRaisedAt = now;
        p.updatedAt = now;
        // Se refresca lo que puede haber mejorado con más datos, y NUNCA el
        // estado: una propuesta que el operador descartó sigue descartada por
        // mucho que la revisión insista.
        if (v.evidence.length) p.evidence = v.evidence;
        if (v.impact) p.impact = v.impact;
        if (v.effort) p.effort = v.effort;
        out.merged += 1;
        out.proposals.push(structuredClone(p));
        continue;
      }
      const proposal: ImproveProposal = {
        id: newId('imp'),
        reviewId: reviewId ?? 'manual',
        at: now, updatedAt: now,
        status: 'open',
        raised: 1, lastRaisedAt: now,
        notes: [],
        ...(by.agentId ? { agentId: by.agentId } : {}),
        ...(by.callsign ? { callsign: by.callsign } : {}),
        ...v,
      };
      this.data.proposals[proposal.id] = proposal;
      out.filed += 1;
      out.proposals.push(structuredClone(proposal));
    }

    const review = reviewId ? this.data.reviews.find((r) => r.id === reviewId) : undefined;
    if (review) {
      review.reportedAt = now;
      review.filed += out.filed;
      review.merged += out.merged;
      // `reported` se gana archivando algo. Un informe entero rechazado deja la
      // revisión donde estaba: decir «completada» sin una sola propuesta sería
      // el resultado falso que hace inútil el panel.
      if ((out.filed > 0 || out.merged > 0) && (review.status === 'running' || review.status === 'launching')) {
        review.status = 'reported';
      }
    }
    this.prune();
    this.save();
    return out;
  }

  /* ── lo que hace el operador ────────────────────────────────────── */

  get(id: string): ImproveProposal {
    const p = this.data.proposals[id];
    if (!p) throw new Error(`Unknown proposal: ${id}`);
    return structuredClone(p);
  }

  /**
   * Marca vistas las novedades. Es lo que apaga el aviso, y por eso es una
   * acción explícita de la consola y no un efecto de pintar: un panel que se
   * declara leído solo cada vez que se dibuja no avisa de nada.
   */
  markSeen(ids?: string[]): number {
    const now = this.now();
    let n = 0;
    for (const p of Object.values(this.data.proposals)) {
      if (p.seenAt !== undefined) continue;
      if (ids && !ids.includes(p.id)) continue;
      p.seenAt = now;
      n += 1;
    }
    if (n) this.save();
    return n;
  }

  act(id: string, action: ImproveAct): ImproveProposal {
    const p = this.data.proposals[id];
    if (!p) throw new Error(`Unknown proposal: ${id}`);
    const now = this.now();
    switch (action.act) {
      case 'seen':
        p.seenAt ??= now;
        break;
      case 'reply': {
        const text = redact(String(action.text ?? '')).trim().slice(0, MAX_NOTE);
        if (!text) throw new Error('Empty reply');
        p.notes.push({ id: newId('n'), role: 'human', text, at: now });
        p.notes = p.notes.slice(-MAX_NOTES);
        p.seenAt ??= now;
        // Contestar es mirarla: una pospuesta que recibe respuesta vuelve.
        if (p.status === 'snoozed') { p.status = 'open'; delete p.snoozeUntil; }
        break;
      }
      case 'snooze': {
        const until = Number(action.untilMs);
        if (!Number.isFinite(until) || until <= now) throw new Error('Snooze needs a future time');
        p.status = 'snoozed';
        p.snoozeUntil = Math.min(until, now + 365 * 86_400_000);
        p.seenAt ??= now;
        break;
      }
      case 'dismiss': {
        p.status = 'dismissed';
        delete p.snoozeUntil;
        p.seenAt ??= now;
        const text = redact(String(action.text ?? '')).trim().slice(0, MAX_NOTE);
        if (text) p.notes.push({ id: newId('n'), role: 'human', text, at: now });
        break;
      }
      case 'reopen':
        // Enviada, terminada o archivada: sigue siendo una misión, y una misión
        // no se reabre desde el tablero sino desde su ventana.
        if (p.missionId) throw new Error('This proposal is already a mission');
        p.status = 'open';
        delete p.snoozeUntil;
        break;
      case 'sent': {
        // La guarda contra el doble envío. Vive aquí y no en la consola porque
        // hay dos caminos hasta aquí —el botón y la herramienta— y una regla
        // escrita dos veces es una regla que un día discrepa.
        if (p.missionId) throw new Error(`Already sent to CAPCOM as ${p.missionId}`);
        p.status = 'sent';
        p.missionId = action.missionId;
        p.seenAt ??= now;
        delete p.snoozeUntil;
        break;
      }
    }
    p.updatedAt = now;
    this.save();
    return structuredClone(p);
  }

  /** Una línea de CAPCOM en la conversación de una propuesta. */
  note(id: string, role: 'capcom' | 'system', text: string): ImproveProposal {
    const p = this.data.proposals[id];
    if (!p) throw new Error(`Unknown proposal: ${id}`);
    const clean = redact(text).trim().slice(0, MAX_NOTE);
    if (!clean) throw new Error('Empty note');
    p.notes.push({ id: newId('n'), role, text: clean, at: this.now() });
    p.notes = p.notes.slice(-MAX_NOTES);
    p.updatedAt = this.now();
    this.save();
    return structuredClone(p);
  }

  /* ── lo que hace la misión ──────────────────────────────────────── */

  /**
   * La misión le cuenta a su propuesta cómo va.
   *
   * El enlace `missionId` era de ida: SEND lo escribía y nadie volvía a
   * mirarlo. Una misión terminada dejaba la propuesta en `sent` para siempre,
   * y una archivada dejaba en el tablero una fila viva de un trabajo que el
   * panel de misiones ya no enseñaba —dos paneles diciendo cosas distintas
   * del mismo hecho, y trabajo terminado que parecía pendiente. Aquí la
   * propuesta copia lo que la misión dice (`linkedStatus`), en las dos
   * direcciones: cerrar y archivar, pero también reabrir y desarchivar,
   * porque el operador hace las dos cosas desde la ventana de la misión.
   *
   * Sólo toca las propuestas enlazadas a ESA misión y que ya estén en un
   * estado de misión: una descartada no resucita porque alguien escriba en
   * la misión. Cada cambio deja una nota `system` en el hilo, que es donde el
   * operador lee qué pasó. Devuelve las que cambiaron.
   */
  syncMission(mission: Pick<CapcomMission, 'id' | 'status' | 'archivedAt'>): ImproveProposal[] {
    const changed = this.mirror(mission);
    if (changed.length) this.save();
    return changed;
  }

  /**
   * El barrido de arranque: lo que les pasó a las misiones mientras el hub
   * no estaba, o antes de que supiera contarlo. Una misión que ya no existe
   * (purgada) no dice nada, y la propuesta se queda como la dejó el archivo
   * previo. Una sola escritura para todas.
   */
  syncMissions(missions: Record<string, Pick<CapcomMission, 'id' | 'status' | 'archivedAt'>>): ImproveProposal[] {
    const changed: ImproveProposal[] = [];
    for (const m of Object.values(missions)) changed.push(...this.mirror(m));
    if (changed.length) this.save();
    return changed;
  }

  private mirror(mission: Pick<CapcomMission, 'id' | 'status' | 'archivedAt'>): ImproveProposal[] {
    const want = linkedStatus(mission);
    const now = this.now();
    const changed: ImproveProposal[] = [];
    for (const p of Object.values(this.data.proposals)) {
      if (p.missionId !== mission.id || !MISSION_STATUSES.includes(p.status) || p.status === want) continue;
      const text = want === 'archived' ? 'Mission archived: it leaves the board with it.'
        : p.status === 'archived' ? 'Mission restored from the archive.'
          : want === 'completed' ? 'Mission completed.' : 'Mission reopened.';
      p.notes.push({ id: newId('n'), role: 'system', text, at: now });
      p.notes = p.notes.slice(-MAX_NOTES);
      p.status = want;
      p.updatedAt = now;
      changed.push(structuredClone(p));
    }
    return changed;
  }

  /**
   * Poda por el final cerrado.
   *
   * Lo abierto no se toca nunca: es lo único que el operador todavía no ha
   * decidido. Lo cerrado se conserva mientras quepa porque es lo que impide
   * que la revisión vuelva a proponer lo que ya se descartó, y cuando ya no
   * cabe se va lo más viejo, que es lo que menos probable es que vuelva.
   */
  private prune(): void {
    const all = Object.values(this.data.proposals);
    if (all.length <= MAX_PROPOSALS) return;
    const closed = all
      .filter((p) => p.status === 'dismissed' || MISSION_STATUSES.includes(p.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const p of closed) {
      if (Object.keys(this.data.proposals).length <= MAX_PROPOSALS) break;
      delete this.data.proposals[p.id];
    }
  }

  /**
   * Escribe el fichero. `usage` va plegado, para que un hub anterior que lea
   * este fichero siga viendo su ventana; el anillo va aparte, en `usageHours`.
   */
  private save(notify = true): void {
    const stored = (): StoredImprove => {
      this.trimHours(this.now());
      return { ...this.data, usage: this.usage(), usageHours: this.hours, usageSince: this.usageSince };
    };
    if (Buffer.byteLength(JSON.stringify(stored())) > MAX_FILE_BYTES) { this.prune(); }
    try {
      const temp = `${this.filePath}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(stored()), { mode: 0o600 });
      fs.renameSync(temp, this.filePath);
      this.degraded = null;
      this.usageDirty = false;
    } catch (err) {
      // Lo de memoria sigue siendo correcto para este proceso; lo que se
      // pierde es el reinicio, y el panel lo enseña en vez de callarlo.
      this.degraded = `not saved: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (notify) this.changed();
  }
}

/* ── la telemetría, en palabras ───────────────────────────────────── */

function money(n: number): string { return `$${n.toFixed(2)}`; }
function mins(ms: number | null): string { return ms === null ? '—' : `${Math.round(ms / 60_000)}m`; }
function hoursOf(ms: number): string { return `${Math.round(Math.max(0, ms) / 360_000) / 10}h`; }

/**
 * El diario y los contadores, en líneas que un modelo puede leer y un humano
 * puede comprobar.
 *
 * Todo lo que sale de aquí es una CUENTA o un AGREGADO. Los proyectos salen
 * por su código (`AX`), que es como los nombra una persona y no dice dónde
 * están. Nada de rutas, nada de briefs, nada de preguntas ni respuestas: el
 * revisor no necesita el contenido para ver dónde se atasca la consola, y el
 * contenido es exactamente lo que no debe acabar en un informe.
 */
export function buildDigest(input: {
  stats: JournalStats;
  usage: ImproveUsage;
  fleet: { agents: number; blocked: number; missionsOpen: number; missionsOwed: number };
  windowMs: number;
  /** Para decir cuántas horas lleva la ventana. Sin él, sólo desde cuándo. */
  now?: number;
}): TelemetryDigest {
  const { stats, usage, fleet } = input;
  const lines: string[] = [];

  lines.push(`fleet now: ${fleet.agents} agents, ${fleet.blocked} blocked, ${fleet.missionsOpen} open missions (${fleet.missionsOwed} owed an answer)`);
  lines.push(`launches: ${stats.launches} (human ${stats.byLauncher.human}, capcom ${stats.byLauncher.capcom}, agent ${stats.byLauncher.agent})`);
  lines.push(`endings: ${stats.ends.done} done, ${stats.ends.dead} dead${stats.doneRate === null ? '' : ` (${Math.round(stats.doneRate * 100)}% done)`}`);
  lines.push(`use: ${fmtTokens(stats.usage.tokens)} tokens total, ${stats.usage.avgTokens === null ? '—' : fmtTokens(stats.usage.avgTokens)} per agent over ${stats.usage.measured} measured end(s), avg run ${mins(stats.duration.avgMs)}`);
  lines.push(`escalations: ${stats.escalations.asked} asked · capcom answered ${stats.escalations.answeredByCapcom} · human answered ${stats.escalations.answeredByHuman} · ${stats.escalations.unanswered} unanswered · avg wait ${mins(stats.escalations.avgWaitMs)}`);
  lines.push(`capcom rotations: ${stats.rotations} · landings ${stats.landings.ok} ok / ${stats.landings.failed} failed`);

  const projects = stats.byProject.slice(0, 5)
    .map((p) => `${p.project ?? p.projectId ?? '?'} ${p.launches}L ${p.dead}✝ ${fmtTokens(p.totalTokens)}`);
  if (projects.length) lines.push(`by project: ${projects.join(' · ')}`);

  /*
   * Desde cuándo cuentan los contadores de aquí abajo. Un cero sin fecha no se
   * distingue de un contador que se acaba de vaciar, y eso fue exactamente lo
   * que vio el revisor: ceros que eran un vaciado y parecían desuso.
   */
  const covered = input.now === undefined ? '' : ` (${hoursOf(input.now - usage.since)} of the last ${hoursOf(input.windowMs)})`;
  lines.push(`usage counters below: window since ${new Date(usage.since).toISOString().slice(0, 16)}Z${covered}; a zero means none since then`);

  const tools = topCounters({ ...usage, counts: Object.fromEntries(Object.entries(usage.counts).filter(([k]) => k.startsWith('mcp:'))) }, 10);
  const ui = topCounters({ ...usage, counts: Object.fromEntries(Object.entries(usage.counts).filter(([k]) => k.startsWith('ui:'))) }, 10);
  lines.push(`capcom tool calls (${tools.reduce((a, t) => a + t.n, 0)}): ${tools.length ? tools.map((t) => `${t.name.slice(4)} ${t.n}`).join(' · ') : 'none recorded'}`);
  lines.push(`console requests to the hub (${ui.reduce((a, t) => a + t.n, 0)}): ${ui.length ? ui.map((t) => `${t.name.slice(3)} ${t.n}`).join(' · ') : 'none recorded'}`);

  /*
   * Los GESTOS: lo que el operador hizo en la interfaz, que es distinto de lo
   * que la consola pidió. Tres líneas porque son tres preguntas: qué se tocó
   * más, cuánto por familia (con los ceros, que es la mitad interesante), y
   * qué clases de ventana no se abrieron ni una vez — la línea que permite
   * proponer retirar o acercar algo con una cifra detrás.
   */
  const families = gesturesByFamily(usage.counts);
  const gestures = families.flatMap((f) => f.names.map((x) => ({ name: `${f.family}:${x.detail}`, n: x.n })))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 12);
  lines.push(`console gestures (${families.reduce((a, f) => a + f.n, 0)}): ${gestures.length ? gestures.map((g) => `${g.name} ${g.n}`).join(' · ') : 'none recorded'}`);
  lines.push(`gestures by family: ${families.map((f) => `${f.family} ${f.n} (${GESTURE_FAMILY_LABELS[f.family]})`).join(' · ')}`);
  const never = windowKindsNeverOpened(usage.counts);
  lines.push(never.length ? `window kinds never opened in this window: ${never.join(', ')}` : 'every window kind was opened at least once');
  // Lo que NO se usó es tan interesante como lo que sí, y es la mitad que
  // nadie mira: una herramienta con cero llamadas o sobra, o no se encuentra.
  lines.push('counters are names and counts only: no paths, no transcripts, no secrets');

  return { windowMs: input.windowMs, lines, top: topCounters(usage, 14) };
}

/* ── el lanzador ──────────────────────────────────────────────────── */

/** Lo que contesta `cancel`. `holding`: el hueco sigue ocupado. */
export interface CancelOutcome { ok: boolean; reason: string; holding?: boolean }

/** Lo que contesta `setConfig`: los límites y la elección, ya normalizados. */
export type ImproveSettings = ImproveConfig & { budgetTokens: number; runtime: string | null; model: string | null };

export interface ImproveApi {
  store: ImproveStore;
  /** Un gesto que contar. Lo llaman el hub y el servidor MCP. */
  record(name: string, n?: number): void;
  /**
   * Lanza una revisión ahora. `manual` la pide el operador desde la consola y
   * se salta el reloj, la señal y el tope diario — pero no la revisión que ya
   * está en vuelo, que es una imposibilidad y no una preferencia.
   */
  run(trigger: 'auto' | 'manual'): Promise<{ ok: boolean; reason: string; review?: ImproveReview }>;
  /**
   * Pide parar la revisión en vuelo. `holding` dice que el sitio SIGUE
   * ocupado: se libera cuando el mundo confirma que el agente se fue.
   */
  cancel(): Promise<CancelOutcome>;
  /** Lo que un revisor archiva. Valida que quien reporta ES el revisor. */
  report(input: { agentId: string | null; reviewId: string | null; proposals: ProposalDraft[] }): FileOutcome & { reviewId: string | null };
  /** Por qué no toca ahora, para enseñarlo sin lanzar nada. */
  verdict(): { due: boolean; reason: string; nextAt?: number };
  /**
   * Con qué se lanzaría el próximo, y de dónde sale cada parte. El panel lo
   * enseña para que una casilla vacía no haya que interpretarla.
   */
  choice(): ReturnType<typeof effectiveChoice>;
  /** El proyecto donde correría el revisor, o null. La consola necesita su máquina. */
  project(): Project | null;
  /**
   * Lanza el agente que IMPLEMENTA una propuesta, como líder del squad que se
   * le da, sobre el repositorio de ORCA. No le pide nada a CAPCOM: es el
   * camino por el que una automejora deja de costarle turnos al mando. El
   * spawn puede fallar —sin proyecto, sin máquina— y entonces se dice por qué
   * en vez de lanzar una excepción: quien llama ya escribió la misión y tiene
   * que dejar constancia ahí.
   */
  implement(input: { brief: string; squad: string; mission: string }): Promise<ImplementOutcome>;
  /** Cierra lo que se quedó colgado. Lo llama el tic y el arranque. */
  sweep(): void;
  stop(): void;
}

export type ImplementOutcome =
  | { ok: true; agentId: string | null; shortId: string | null; callsign: string | null; project: Project }
  | { ok: false; reason: string };

export interface ImproveHooks {
  journal: Pick<JournalApi, 'stats'>;
  /** Los datos de flota que la telemetría resume. */
  fleet(): { agents: number; blocked: number; missionsOpen: number; missionsOwed: number };
  /** Se llama cuando el estado cambia, para que el hub lo empuje a las consolas. */
  changed?(): void;
  /**
   * Pone techo al revisor. Vive fuera porque el libro de presupuestos es del
   * hub y esta pieza no debe tener su propia contabilidad: usar el mecanismo
   * que ya frena a los demás agentes es lo que hace que el revisor se frene
   * igual, se vea igual en la ventana de presupuestos y se pare igual.
   */
  budget?(ref: { agentId: string | null; shortId: string | null }, tokens: number): void;
}

/**
 * El proyecto donde corre el revisor.
 *
 * Por defecto, el repositorio de ORCA: es lo que va a leer, y es el único que
 * ORCA sabe encontrar sin que nadie se lo diga (`ORCA_ROOT`). Un despliegue que
 * lo tenga en otro sitio lo nombra con `ORCA_IMPROVE_PROJECT` por id, código o
 * ruta. Sin ninguno de los dos no se lanza nada y el panel dice por qué: una
 * revisión que corriera en un proyecto cualquiera leería el repositorio
 * equivocado y propondría mejoras para otra cosa.
 */
export function reviewProject(projects: Project[], want: string): Project | null {
  if (want) {
    const w = want.toLowerCase();
    return projects.find((p) => p.id === want || p.code.toLowerCase() === w
      || p.name.toLowerCase() === w || path.resolve(p.path) === path.resolve(want)) ?? null;
  }
  return projects.find((p) => path.resolve(p.path) === ORCA_ROOT) ?? null;
}

export function createImprove(deps: AutonomyDeps, hooks: ImproveHooks): ImproveApi {
  const env = improveEnv(deps.env);
  const store = new ImproveStore(deps.dir, deps.now, () => hooks.changed?.(), env.defaults, () => env.runtime);

  /** El agente de la revisión en vuelo, si el mundo todavía lo tiene. */
  function reviewerOf(r: ImproveReview | null): Agent | null {
    if (!r?.agentId) return null;
    return deps.agents().find((a) => a.id === r.agentId) ?? null;
  }

  /**
   * Cierra lo que ya no puede terminar bien.
   *
   * Tres casos, y los tres dejarían la sección apagada para siempre si nadie
   * los mirara: el reloj de pared se agotó; el hub se reinició y el agente que
   * estaba revisando ya no está en el mundo; el agente terminó o murió y el
   * evento de ciclo de vida se perdió. Se barre en cada tic y al arrancar,
   * porque el arranque es exactamente cuando el tercero es más probable.
   */
  function sweep(): void {
    const now = deps.now();
    for (const r of store.state().reviews) {
      // Sin cerrar es `endedAt` sin poner: una revisión que ya archivó
      // (`reported`), que se está parando o que se pasó del techo sigue
      // teniendo un agente al que mirar, y filtrarlas por estado las dejaba
      // fuera del barrido — que es justo donde se libera el hueco.
      if (r.endedAt !== undefined) continue;

      if (!r.agentId) {
        /*
         * Nunca hubo agente que esperar. Se cierra en cuanto hay un resultado,
         * o cuando el reloj dice que el spawn no va a aparecer ya.
         */
        if (r.outcomeAt !== undefined) { store.closeReview(r.id, r.status, r.note ?? 'no agent ever appeared'); continue; }
        if (now - r.at >= REVIEW_MAX_MS) store.closeReview(r.id, 'failed', 'the spawn never produced an agent');
        continue;
      }

      const a = reviewerOf(r);
      /*
       * CONFIRMADO IDO: ya no está en el mundo, o el mundo lo da por terminal.
       * Es lo ÚNICO que suelta el sitio. Todo lo demás de aquí abajo decide el
       * resultado y sigue bloqueando.
       */
      if (!a) {
        store.closeReview(r.id, r.outcomeAt !== undefined ? r.status : 'failed',
          r.outcomeAt !== undefined ? `${r.note ?? 'closed'} · confirmed gone` : 'the reviewer is no longer on the fleet');
        continue;
      }
      if (!r.callsign && a.callsign) store.bindReviewer(r.id, { callsign: a.callsign });
      if (TERMINAL_STATES.has(a.state)) { closeFor(r, a); continue; }

      // Vivo. A partir de aquí sólo se decide el resultado y se insiste con el
      // `stop`; el hueco NO se suelta.
      if (r.outcomeAt === undefined) {
        if (overBudget(r, a)) { retryStop(r, a); continue; }
        if (now - r.at >= REVIEW_MAX_MS) {
          const spend = { costUSD: a.metrics.costUSD, tokens: tokensOf(a) };
          store.settleOutcome(r.id, 'expired', `no report in ${Math.round(REVIEW_MAX_MS / 60_000)} minutes`, spend);
          deps.log(`improve: review ${r.id} out of time; stopping ${a.callsign}`);
          retryStop(store.review(r.id) ?? r, a);
          continue;
        }
        /*
         * Terminado de verdad, aunque el CLI no lo diga.
         *
         * Un agente de Claude Code no termina solo: acaba su turno, se queda
         * `idle` y espera otro prompt que nadie le va a mandar. Un revisor que
         * lleva un minuto quieto ha acabado, y dejarlo vivo sería el agente
         * permanente que esta sección promete no dejar. Se DECIDE el resultado
         * y se le para; el sitio se suelta cuando se confirme que se fue.
         */
        if (a.state === 'idle' && now - a.updatedAt >= REVIEWER_IDLE_MS) {
          const reported = (store.review(r.id)?.reportedAt ?? 0) > 0;
          store.settleOutcome(r.id, reported ? 'reported' : 'ended',
            reported ? 'filed and went quiet' : 'the reviewer finished without filing anything',
            { costUSD: a.metrics.costUSD, tokens: tokensOf(a) });
          retryStop(store.review(r.id) ?? r, a);
        }
        continue;
      }

      // Resultado ya decidido y sigue vivo: insistir, acotado, y esperar.
      retryStop(r, a);
    }
  }

  /** Lo que se compara con el techo: sin la lectura de caché. Ver shared/tokens.ts. */
  function tokensOf(a: Agent): number {
    return ceilingTokens(a.metrics);
  }

  /**
   * Otro `stop`, si toca.
   *
   * Acotado: `STOP_ATTEMPTS` intentos con espera creciente. Agotarlos NO suelta
   * el sitio — sólo deja de insistir. Un `stop` que ha fallado cinco veces no
   * va a funcionar la sexta, y repetirlo para siempre sería ruido; soltar el
   * hueco, en cambio, sería el fallo que no se puede deshacer.
   *
   * No gasta nada del revisor: mandar un `stop` no le da turnos.
   */
  function retryStop(r: ImproveReview, a: Agent): void {
    const tries = r.stopAttempts ?? 0;
    if (tries >= STOP_ATTEMPTS) return;
    const wait = STOP_BACKOFF_MS[Math.min(tries, STOP_BACKOFF_MS.length - 1)]!;
    if (tries > 0 && deps.now() - (r.lastStopAt ?? 0) < wait) return;
    const n = store.noteStop(r.id);
    void deps.stopAgent(a.id).catch((err) => {
      deps.log(`improve: stop ${n}/${STOP_ATTEMPTS} for ${a.callsign} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * ¿Se ha pasado del techo? Si sí, se le para y se cierra.
   *
   * Se mira aquí y en cada cambio de estado del revisor, que es lo más cerca
   * que se puede estar de mirar continuamente sin sondear: el consumo se
   * deriva del transcript y sólo cambia cuando el agente hace algo. Aun así
   * llega tarde por definición — la cifra que se lee es la de la última
   * relectura, no la de ahora. Ver `REVIEWER_BUDGET_TOKENS`.
   */
  function overBudget(r: ImproveReview, a: Agent): boolean {
    const cap = r.budgetTokens ?? store.state().budgetTokens;
    if (!cap || r.outcomeAt !== undefined) return false;
    const spent = tokensOf(a);
    if (spent <= cap) return false;
    // Se DECIDE el resultado y se le manda parar. El sitio sigue ocupado hasta
    // que el mundo confirme que se fue: un agente al que se le acaba de pedir
    // que pare sigue vivo, y darle su hueco a otro tendría dos revisores.
    store.settleOutcome(r.id, 'overbudget',
      `stopped at ${Math.round(spent / 1000)}k of a ${Math.round(cap / 1000)}k ceiling`,
      { costUSD: a.metrics.costUSD, tokens: spent });
    deps.note(`AUTOMEJORA: ${a.callsign} went over its ${Math.round(cap / 1000)}k ceiling at ${Math.round(spent / 1000)}k; stopping it`);
    deps.log(`improve: review ${r.id} over budget (${spent}/${cap}), stopping ${a.callsign}`);
    return true;
  }

  /** Cierra una revisión por el estado final de su agente, con lo que gastó. */
  function closeFor(r: ImproveReview, a: Agent): void {
    const spend = {
      costUSD: a.metrics.costUSD,
      tokens: tokensOf(a),
    };
    // Un final que ya se ganó no lo deshace la muerte del agente: una revisión
    // que archivó siguió siendo `reported`, y una que el operador paró sigue
    // siendo `cancelled` aunque el agente acabe en `dead`.
    // Un resultado ya decidido no lo cambia la muerte del agente: sólo se le
    // añade la confirmación y lo que gastó.
    if (r.outcomeAt !== undefined) {
      store.closeReview(r.id, r.status, `${r.note ?? r.status} · confirmed stopped`, spend);
      return;
    }
    if ((store.review(r.id)?.reportedAt ?? 0) > 0) {
      store.closeReview(r.id, 'reported', undefined, spend);
      return;
    }
    store.closeReview(r.id, a.state === 'dead' ? 'failed' : 'ended',
      a.state === 'dead' ? 'the reviewer died before reporting'
        : 'the reviewer finished without filing anything', spend);
  }

  function capcomHealth(): { capcomAlive: boolean; capcomBusy: boolean } {
    // El revisor no es CAPCOM y no depende de él para trabajar. Pero sí se
    // espera a que el mando esté quieto: lanzar un agente mientras CAPCOM está
    // en mitad de un turno le mete un `[AGENT …]` en medio del razonamiento.
    const cap = deps.capcom();
    if (!cap) return { capcomAlive: true, capcomBusy: false };
    return { capcomAlive: true, capcomBusy: cap.state === 'working' || cap.state === 'thinking' };
  }

  /*
   * Lee y no escribe, a propósito: lo llama el frame que pinta el panel, y una
   * lectura que guarda dispara `changed`, que difunde el tablero, que se
   * vuelve a leer. `activeReview` ya trata una revisión caducada como si no
   * existiera, así que barrer aquí no cambiaría ninguna respuesta.
   */
  function verdict(): { due: boolean; reason: string; nextAt?: number } {
    if (!env.enabled) return { due: false, reason: 'DISABLED BY ORCA_IMPROVE=0' };
    // El reloj primero, el sitio después. Si está en pausa o falta señal, eso
    // es lo que el operador quiere leer; que además no haya proyecto es un
    // problema que sólo importa cuando de verdad se iba a lanzar algo.
    const v = dueForReview(store.state(), deps.now(), capcomHealth());
    if (!v.due) return v;
    if (!reviewProject(deps.projects(), env.project)) {
      return { due: false, reason: env.project ? `NO PROJECT MATCHES ${env.project.toUpperCase()}` : 'ORCA\'S OWN REPO IS NOT A PROJECT ON THIS FLEET' };
    }
    return v;
  }

  /**
   * Con qué CLI y qué modelo nace el próximo revisor.
   *
   * La elección del operador gana; sin ella, el entorno; sin él, `claude`. Se
   * resuelve aquí, una vez por lanzamiento, y se sella en la revisión: así el
   * panel puede enseñar lo que VA a pasar y el historial lo que pasó, sin que
   * ninguno de los dos tenga que volver a deducirlo.
   */
  function choiceNow(): { runtime: string; model: string | null } {
    const c = effectiveChoice(store.state(), { runtime: env.runtime, model: env.model });
    return { runtime: c.runtime, model: c.model };
  }

  /** El comando de spawn del revisor. Aparte para poder leerlo y probarlo. */
  function spawnCommand(project: Project, brief: string, reviewId: string, with_: { runtime: string; model: string | null }): Command {
    return {
      k: 'spawn',
      projectId: project.id,
      prompt: brief,
      // Sin padre: el revisor no es de nadie. Colgarlo de CAPCOM lo metería en
      // el despertador del mando (`wake.ts`) y le costaría un turno por cada
      // revisión, que es exactamente lo que esta arquitectura vino a quitar.
      parentId: null,
      mission: `AUTOMEJORA ${reviewId}`,
      background: true,
      // Un pane cuando la máquina tiene tmux: el operador puede abrir su
      // TERMINAL y mirar lo que está haciendo, que es la mitad del punto de
      // que esto sea un agente.
      permissionMode: 'auto',
      // Sin worktree: no va a escribir nada, y uno vacío por revisión sería
      // basura en disco que alguien tendría que limpiar.
      worktree: false,
      // Lo que lo convierte en revisor para el collector: le quita las
      // herramientas de edición y le pone `orca-improve` en el PATH.
      review: true,
      // `claude` es el defecto del propio comando: mandarlo igualmente no
      // cambia nada, pero mandar SIEMPRE lo que se decidió hace que el payload
      // diga la verdad y se pueda comprobar desde fuera.
      runtime: with_.runtime,
      ...(with_.model ? { model: with_.model } : {}),
    };
  }

  /**
   * El comando de spawn del IMPLEMENTADOR. Se parece al del revisor y se
   * diferencia en lo que importa: escribe (sin `review`, con las herramientas
   * de edición y un worktree propio cuando la flota los usa) y lidera un
   * squad, que es lo que lo hace líder de su misión y le da al operador un
   * destinatario en la ventana de la misión.
   */
  function implementCommand(project: Project, input: { brief: string; squad: string; mission: string }, with_: { runtime: string; model: string | null }): Command {
    return {
      k: 'spawn',
      projectId: project.id,
      prompt: input.brief,
      // Sin padre, por lo mismo que el revisor: colgarlo de CAPCOM lo haría
      // «suyo» en el linaje. Que despierte a CAPCOM al terminar lo decide la
      // misión a la que está atado, no el padre.
      parentId: null,
      mission: input.mission,
      background: true,
      // Routine execution is separate from CAPCOM's publication authority.
      permissionMode: isForgeSquad(input.squad) ? 'auto' : 'manual',
      squad: input.squad,
      lead: true,
      runtime: with_.runtime,
      ...(with_.model ? { model: with_.model } : {}),
    };
  }

  async function implement(input: { brief: string; squad: string; mission: string }): Promise<ImplementOutcome> {
    const project = reviewProject(deps.projects(), env.project);
    if (!project) {
      return {
        ok: false,
        reason: env.project
          ? `no project matches ORCA_IMPROVE_PROJECT=${env.project}`
          : `ORCA's own repository (${ORCA_ROOT}) is not a project on this fleet. Register it, or set ORCA_IMPROVE_PROJECT.`,
      };
    }
    const with_ = choiceNow();
    try {
      const ack = await deps.dispatch(implementCommand(project, input, with_)) as SpawnAck | undefined;
      deps.log(`improve: implementer ${ack?.callsign ?? ack?.shortId ?? 'an agent'} launched on ${project.code} as lead of ${input.squad}`
        + ` with ${with_.runtime}${with_.model ? `/${with_.model}` : ''}`);
      return { ok: true, agentId: ack?.agentId ?? null, shortId: ack?.shortId ?? null, callsign: ack?.callsign ?? null, project };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      deps.log(`improve: implementer failed to launch: ${detail}`);
      return { ok: false, reason: `could not launch the implementer: ${detail}` };
    }
  }

  async function run(trigger: 'auto' | 'manual'): Promise<{ ok: boolean; reason: string; review?: ImproveReview }> {
    if (!env.enabled) return { ok: false, reason: 'self-review is off (ORCA_IMPROVE=0)' };
    sweep();

    const live = store.active();
    if (live) return { ok: false, reason: `${live.callsign ?? 'a reviewer'} is already reviewing` };

    const project = reviewProject(deps.projects(), env.project);
    if (!project) {
      return {
        ok: false,
        reason: env.project
          ? `no project matches ORCA_IMPROVE_PROJECT=${env.project}`
          : `ORCA's own repository (${ORCA_ROOT}) is not a project on this fleet. Register it, or set ORCA_IMPROVE_PROJECT.`,
      };
    }

    const state = store.state();
    let reason: string;
    if (trigger === 'auto') {
      const v = dueForReview(state, deps.now(), capcomHealth());
      if (!v.due) return { ok: false, reason: v.reason };
      reason = v.reason;
    } else {
      reason = 'ASKED BY THE OPERATOR';
    }

    const now = deps.now();
    const digest = buildDigest({
      stats: hooks.journal.stats({ since: now - DIGEST_WINDOW_MS }),
      usage: store.usage(DIGEST_WINDOW_MS),
      fleet: hooks.fleet(),
      windowMs: DIGEST_WINDOW_MS,
      now,
    });
    const open = openProposals(state, now);
    const answered = Object.values(state.proposals)
      .filter((p) => p.notes.some((n) => n.role === 'human') && p.lastRaisedAt < (state.reviews[0]?.at ?? 0));

    // El sitio se reserva ANTES del spawn: ver `beginReview`.
    const with_ = choiceNow();
    const review = store.beginReview(trigger, reason, with_);
    const brief = reviewerBrief({ reviewId: review.id, digest, openProposals: open, answered, projectName: project.name });

    try {
      const ack = await deps.dispatch(spawnCommand(project, brief, review.id, with_)) as SpawnAck | undefined;
      const bound = store.bindReviewer(review.id, {
        agentId: ack?.agentId ?? null,
        shortId: ack?.shortId ?? null,
        callsign: ack?.callsign ?? null,
        projectId: project.id,
        machineId: project.machineId,
      });
      // El techo, por el mismo libro que frena a todos los demás. Por short id
      // cuando la sesión todavía no ha aparecido: el libro lo resuelve solo en
      // cuanto el CLI la nombra (ver `setPendingByShortId`).
      hooks.budget?.({ agentId: ack?.agentId ?? null, shortId: ack?.shortId ?? null }, store.state().budgetTokens);
      deps.log(`improve: review ${review.id} spawned ${ack?.callsign ?? ack?.shortId ?? 'an agent'} on ${project.code}`
        + ` with ${with_.runtime}${with_.model ? `/${with_.model}` : ''} and a ${Math.round((review.budgetTokens ?? 0) / 1000)}k ceiling`);
      deps.note(`AUTOMEJORA: ${ack?.callsign ?? 'a reviewer'} is looking at ORCA itself (${reason.toLowerCase()})`);
      return { ok: true, reason, review: bound ?? review };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      store.closeReview(review.id, 'failed', `could not launch: ${detail}`);
      deps.log(`improve: review ${review.id} failed to launch: ${detail}`);
      return { ok: false, reason: `could not launch the reviewer: ${detail}` };
    }
  }

  /**
   * Parar la revisión en vuelo.
   *
   * Pedir el `stop` NO libera el hueco, y no hay plazo que lo libere. El hueco
   * lo libera ÚNICAMENTE que el mundo confirme que el agente se fue: terminal,
   * o fuera del mundo. Si el `stop` falla, se reintenta acotado
   * (`STOP_ATTEMPTS`) y la sección se queda bloqueada diciéndolo — un bloqueo
   * visible es un problema que alguien puede mirar; dos revisores a la vez, no.
   *
   * La excepción es una revisión que aún no tiene agente: ahí no hay nada a
   * quien esperar, y se cierra en el acto.
   */
  async function cancel(): Promise<CancelOutcome> {
    const live = store.active();
    if (!live) return { ok: false, reason: 'no review is running' };
    if (!live.agentId) {
      store.closeReview(live.id, 'cancelled', 'cancelled before its agent appeared');
      return { ok: true, reason: 'the review was cancelled before its agent appeared' };
    }
    const who = live.callsign ?? live.agentId;
    store.requestCancel(live.id, `stop requested by the operator for ${who}`);
    store.noteStop(live.id);
    try {
      await deps.stopAgent(live.agentId);
      // Aceptado no es muerto: el hueco sigue ocupado hasta que el mundo lo diga.
      return { ok: true, reason: `stopping ${who} · the slot stays taken until the fleet confirms it is gone`, holding: true };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      store.settleOutcome(live.id, 'cancelled', `stop failed: ${why}`);
      return {
        ok: true, holding: true,
        reason: `could not stop ${who}: ${why}.`
          + ` The slot stays taken until the fleet confirms it is gone; ORCA will retry up to ${STOP_ATTEMPTS} times.`,
      };
    }
  }

  /**
   * Lo que archiva un revisor.
   *
   * Se comprueba QUIÉN reporta. Un agente cualquiera con el comando en el PATH
   * no puede llenar el tablero: sólo el agente de la revisión en vuelo, o —si
   * el spawn todavía no había resuelto su id de sesión— uno cuyo short id
   * coincida. Sin esa comprobación, `orca-improve` sería un canal abierto a
   * cualquier sesión de la máquina.
   */
  function report(input: { agentId: string | null; reviewId: string | null; proposals: ProposalDraft[] }): FileOutcome & { reviewId: string | null } {
    const target = input.reviewId ? store.review(input.reviewId) : store.active();
    if (!target) throw new Error(input.reviewId ? `unknown review ${input.reviewId}` : 'no review is running');
    const who = input.agentId;
    const mine = !who || target.agentId === who || target.shortId === who;
    if (!mine) throw new Error(`review ${target.id} belongs to ${target.callsign ?? target.agentId ?? 'another agent'}`);
    // El agente reporta antes de que el ack le haya puesto id: se aprovecha
    // para atarlo, que es más fiable que el ack (aquí ya habló de verdad).
    if (who && !target.agentId) store.bindReviewer(target.id, { agentId: who });
    const agent = who ? deps.agents().find((a) => a.id === who) : undefined;
    const out = store.file(target.id, input.proposals, {
      ...(who ? { agentId: who } : {}),
      ...(agent?.callsign ? { callsign: agent.callsign } : {}),
    });
    return { ...out, reviewId: target.id };
  }

  /*
   * El ciclo de vida del revisor, por el mismo canal tipado que usa el
   * despertador: un agente que termina o muere cierra su revisión en el acto,
   * sin esperar al barrido. El barrido es la red, no el mecanismo.
   */
  const offState = deps.lifecycle.on('agent:state', (change) => {
    if (!TERMINAL_STATES.has(change.to as Agent['state'])) return;
    // Se busca por AGENTE entre las revisiones sin cerrar, no sólo la activa:
    // una que ya archivó sigue abierta —archivar no es terminar— y su coste
    // final se apunta igual cuando el agente acaba.
    const mine = store.state().reviews.find((r) => r.endedAt === undefined && r.agentId === change.agent.id);
    if (!mine) return;
    closeFor(mine, change.agent);
  });
  /*
   * El gasto, en cada movimiento del revisor. El tic mira cada veinte
   * segundos; esto mira además cada vez que el agente cambia de estado, que es
   * cuando su consumo acaba de moverse. Las dos cosas juntas son lo más cerca
   * de mirar continuamente que se puede estar sin sondear.
   */
  const offSpend = deps.lifecycle.on('agent:state', (change) => {
    if (TERMINAL_STATES.has(change.to as Agent['state'])) return;
    const mine = store.state().reviews.find((r) => r.endedAt === undefined && r.agentId === change.agent.id);
    if (mine) overBudget(mine, change.agent);
  });
  /*
   * El agente apareció con el id de sesión que el ack no llegó a ver. Es la
   * carrera normal de un spawn (ver SPAWN_ACK_TIMEOUT_MS): sin esto la
   * revisión se quedaría sin `agentId` y el panel no podría llevar a nadie.
   */
  const offNew = deps.lifecycle.on('agent:new', (agent) => {
    const live = store.active();
    if (!live) return;
    // El ack puede traer el id de sesión y NO el callsign: el CLI lo imprime
    // antes de que ORCA le ponga nombre. Medido en la primera revisión real,
    // donde la revisión se quedó sin callsign y el historial decía «—» para
    // siempre. Se ata por cualquiera de los dos nombres.
    if (live.agentId === agent.id) {
      if (!live.callsign && agent.callsign) store.bindReviewer(live.id, { callsign: agent.callsign });
      return;
    }
    if (live.agentId || !live.shortId || agent.shortId !== live.shortId) return;
    store.bindReviewer(live.id, { agentId: agent.id, callsign: agent.callsign });
  });

  // El reloj mira, no gasta: `verdict` lee un objeto en memoria y sale por la
  // primera condición que falla. Lo caro —componer el brief y lanzar el
  // agente— sólo ocurre cuando todas pasan.
  const timer: CapcomTimer | null = env.enabled
    ? deps.setInterval(() => { sweep(); if (verdict().due) void run('auto'); }, IMPROVE_TICK_MS)
    : null;
  // Las cuentas de uso se guardan con su propio reloj, esté o no encendida la
  // revisión: se cuentan igual, y un reinicio no debe llevárselas.
  const saver = deps.setInterval(() => { store.flush(); }, USAGE_SAVE_MS);
  // Al arrancar, lo primero es cerrar lo que el hub anterior dejó abierto.
  sweep();

  return {
    store,
    record: (name, n) => store.record(name, n),
    run, cancel, report, verdict, sweep, implement,
    choice: () => effectiveChoice(store.state(), { runtime: env.runtime, model: env.model }),
    project: () => reviewProject(deps.projects(), env.project),
    stop() { timer?.cancel(); saver.cancel(); store.flush(); offState(); offSpend(); offNew(); },
  };
}

/** Cuántas propuestas hay en cada estado. La cabecera del panel. */
export function improveCounts(state: ImproveState, now: number): { open: number; unseen: number; questions: number; sent: number; completed: number; archived: number; dismissed: number } {
  let open = 0, unseen = 0, questions = 0, sent = 0, completed = 0, archived = 0, dismissed = 0;
  for (const p of Object.values(state.proposals)) {
    const s = effectiveStatus(p, now);
    if (s === 'open') {
      open += 1;
      if (p.seenAt === undefined) unseen += 1;
      if (p.question && !p.notes.some((n) => n.role === 'human')) questions += 1;
    } else if (s === 'sent') sent += 1;
    else if (s === 'completed') completed += 1;
    else if (s === 'archived') archived += 1;
    else if (s === 'dismissed') dismissed += 1;
  }
  return { open, unseen, questions, sent, completed, archived, dismissed };
}
