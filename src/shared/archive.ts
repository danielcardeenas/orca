/**
 * Archivar agentes terminados.
 *
 * La flota acumula sesiones `done` y `dead`: cada transcript que queda en disco
 * sigue siendo un agente para el collector, y el collector lo reenvía entero en
 * cada snapshot. La retención del hub (una hora, 300 terminados) sólo aplaza el
 * problema: al siguiente resync vuelven todos. Archivar es la operación
 * explícita: el operador —o CAPCOM— dice "esto ya no me interesa", y el hub lo
 * saca del mundo Y se acuerda de que lo sacó, para que ningún snapshot lo
 * devuelva mientras siga terminado.
 *
 * Lo que se archiva es el REGISTRO en el hub, nunca la sesión: el transcript en
 * disco no se toca, el log append-only conserva su historia, y una sesión que
 * se reanuda (vuelve a un estado vivo) sale sola del archivo. Por eso un agente
 * vivo —booting, thinking, working, blocked, idle— nunca es candidato, se pida
 * el filtro que se pida.
 *
 * Vive en `shared/` porque el hub decide, la consola pide y el CLI muestra, y
 * los tres tienen que hablar del mismo filtro y del mismo resultado.
 */

import type { Agent, AgentState } from './types.ts';
import { islandOf } from './workspaces.ts';
import { TERMINAL_STATES } from './types.ts';
import { squadsOf } from './squads.ts';

/** Los únicos estados que se pueden archivar. */
export type ArchivableState = 'done' | 'dead';

export function archivableState(v: unknown): ArchivableState | null {
  return v === 'done' || v === 'dead' ? v : null;
}

/**
 * Qué archivar. Todo opcional; sin filtros es "todo lo terminado". Los filtros
 * se combinan con AND: `projectId` + `olderThanMs` es "lo terminado hace más
 * de N en ese proyecto".
 */
export interface ArchiveFilter {
  /** Sólo este proyecto (id, no código: el código lo resuelve quien llama). */
  projectId?: string | null;
  /** Sólo este squad (la etiqueta, p. ej. "audit-01"). */
  squad?: string | null;
  /** Sólo los que llevan terminados al menos este tiempo. */
  olderThanMs?: number | null;
  /** Sólo este estado terminal. null = done y dead. */
  state?: ArchivableState | null;
  /** Sólo estos ids — la selección de una consola. Los vivos se ignoran igual. */
  ids?: string[] | null;
  /**
   * Sólo los que están fuera de la flota (`hidden`): lo que quedó en el
   * directorio de CAPCOM o en un scratchpad de sesión. Es la limpieza de una
   * consola que ya no quiere ni verlos en el conteo de ocultos; sin él, la
   * operación normal no los distingue de los demás terminados.
   */
  hidden?: boolean | null;
}

/**
 * La lápida: lo justo para saber qué se archivó y no volver a admitirlo. Es lo
 * que se persiste, así que es pequeña a propósito: el registro completo sigue
 * en el log de eventos y en el transcript.
 */
export interface ArchivedAgent {
  id: string;
  machineId: string;
  projectId: string;
  callsign: string;
  squad: string | null;
  lead: boolean;
  state: ArchivableState;
  title: string;
  mission: string | null;
  parentId: string | null;
  startedAt: number;
  /** Cuándo terminó: el último `updatedAt` que tuvo en el mundo. */
  finishedAt: number;
  archivedAt: number;
  /** Quién lo archivó: "capcom", "console", "cli"… texto libre y corto. */
  by: string;
  /**
   * Su máquina era del arnés (`shared/synthetic.ts`).
   *
   * La lápida es el único sitio donde ese dato sobrevive: la marca la declara
   * la máquina en su `hello`, y para cuando alguien suma el archivo esa
   * máquina hace días que no está en ningún mundo que se pueda consultar. Sin
   * esto, media población del archivo es de pruebas y ninguna cifra agregada
   * puede saberlo — que es exactamente lo que pasó: 299 de 509 lápidas de este
   * hub son del fixture. Ausente significa real, como en toda la frontera.
   */
  synthetic?: true;
}

/**
 * Una lápida sin transcript ya no rechaza nada.
 *
 * Existe para que el mundo rechace a un agente cuando su collector lo vuelva a
 * mandar terminado. Borrado el transcript, no hay nada que rechazar: guarda el
 * rechazo de algo que nadie va a proponer.
 *
 * Lo que NO sirve para saberlo es que el collector deje de nombrarlo. Se probó
 * y es falso: el collector recicla lo terminado a los pocos segundos y deja de
 * reportarlo con su transcript intacto en disco, así que esa regla tiraba
 * lápidas buenas y los agentes reaparecían — justo lo que la lápida evitaba.
 * La única señal fiable es haber borrado el archivo, y de eso da fe quien lo
 * borra: `purgeTranscripts` en el collector.
 */
export function tombstonesFor(archived: readonly ArchivedAgent[], purgedIds: readonly string[]): ArchivedAgent[] {
  const gone = new Set(purgedIds);
  return archived.filter((t) => gone.has(t.id));
}

/** Un candidato que se quedó, y por qué. */
export interface ArchiveKept {
  id: string;
  callsign: string;
  /** Un padre terminado con hijos vivos se queda: sin él el linaje se rompe. */
  reason: 'live-children';
}

export interface ArchivePlan {
  /** Los que se archivan, en el orden en que estaban. */
  archive: Agent[];
  kept: ArchiveKept[];
  /**
   * Squads que se quedan sin ningún miembro en el mundo tras archivar. No hay
   * registro de squad que borrar —un squad es la etiqueta que llevan sus
   * miembros— pero quien llama quiere poder decir "y el squad audit-01 se fue".
   */
  squadsRetired: string[];
}

/** Lo que devuelve el hub, en seco o de verdad. */
export interface ArchiveOutcome {
  dryRun: boolean;
  archived: ArchivedAgent[];
  kept: ArchiveKept[];
  squadsRetired: string[];
}

/** Techo de lápidas en memoria y en la cola del archivo que se lee al arrancar. */
export const MAX_ARCHIVED = 5_000;

/** Un `by` es una etiqueta, no un párrafo. */
const MAX_BY = 40;

export function archiveBy(v: unknown, fallback = 'unknown'): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return (s || fallback).slice(0, MAX_BY);
}

function isLiveState(s: AgentState): boolean {
  return !TERMINAL_STATES.has(s);
}

/**
 * Decide qué se archiva. Puro: no toca nada, así que sirve igual para el
 * `dry_run` y para la operación real, y los dos responden lo mismo.
 */
export function archiveCandidates(
  agents: Iterable<Agent> | Record<string, Agent>,
  filter: ArchiveFilter = {},
  now = Date.now(),
): ArchivePlan {
  const all: Agent[] = Symbol.iterator in Object(agents)
    ? [...(agents as Iterable<Agent>)]
    : Object.values(agents as Record<string, Agent>);
  const byId = new Map(all.map((a) => [a.id, a]));
  const only = filter.ids ? new Set(filter.ids) : null;
  const olderThan = typeof filter.olderThanMs === 'number' && filter.olderThanMs > 0 ? filter.olderThanMs : 0;

  const archive: Agent[] = [];
  const kept: ArchiveKept[] = [];
  for (const a of all) {
    // La regla que no se negocia: un agente vivo no se archiva nunca.
    if (!TERMINAL_STATES.has(a.state)) continue;
    if (filter.state && a.state !== filter.state) continue;
    // La isla, no el directorio: `projectId` puede ser el de la isla de fuera
    // de la flota, que agrupa varios slugs que nunca fueron un proyecto.
    if (filter.projectId && a.projectId !== filter.projectId && islandOf(a) !== filter.projectId) continue;
    if (filter.squad && a.squad !== filter.squad) continue;
    if (only && !only.has(a.id)) continue;
    if (filter.hidden && a.hidden !== true) continue;
    if (olderThan && now - a.updatedAt < olderThan) continue;
    const liveKid = a.childIds.some((c) => { const k = byId.get(c); return !!k && isLiveState(k.state); });
    if (liveKid) { kept.push({ id: a.id, callsign: a.callsign, reason: 'live-children' }); continue; }
    archive.push(a);
  }

  const going = new Set(archive.map((a) => a.id));
  const squadsRetired = squadsOf(all)
    .filter((sq) => sq.memberIds.length > 0 && sq.memberIds.every((id) => going.has(id)))
    .map((sq) => sq.name);

  return { archive, kept, squadsRetired };
}

/**
 * La lápida de un agente, ahora.
 *
 * `synthetic` lo decide quien llama, porque quien llama es el que tiene el
 * mundo delante: el agente no lleva la marca, la lleva su máquina.
 */
export function tombstone(a: Agent, by: string, now = Date.now(), synthetic = false): ArchivedAgent {
  return {
    id: a.id, machineId: a.machineId, projectId: a.projectId, callsign: a.callsign,
    squad: a.squad, lead: a.lead,
    state: a.state === 'dead' ? 'dead' : 'done',
    title: a.title, mission: a.mission, parentId: a.parentId,
    startedAt: a.startedAt, finishedAt: a.updatedAt, archivedAt: now,
    by: archiveBy(by),
    ...(synthetic ? { synthetic: true as const } : {}),
  };
}

/** Guarda de lectura: una línea del archivo que no tenga esta forma se ignora. */
export function isArchivedAgent(v: unknown): v is ArchivedAgent {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['id'] === 'string' && typeof o['archivedAt'] === 'number'
    && (o['state'] === 'done' || o['state'] === 'dead') && o['undo'] !== true;
}

/** "Este id salió del archivo": la sesión se reanudó. */
export interface Unarchived { id: string; at: number; undo: true }

export function isUnarchived(v: unknown): v is Unarchived {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['id'] === 'string' && typeof o['at'] === 'number' && o['undo'] === true;
}

/**
 * "Esta lápida era del arnés": una corrección, no una lápida nueva.
 *
 * El archivo es append-only y sus líneas ya escritas no se reescriben nunca —
 * `Unarchived` es la prueba de que una corrección aquí se hace añadiendo, no
 * tocando. Lo mismo vale para una marca que llega tarde: las lápidas anteriores
 * al 2026-09-13 no guardaron `synthetic` porque el campo no existía, y la
 * alternativa a esta línea era reescribir el histórico entero o borrarlo. Se
 * marca.
 */
export interface SyntheticMark { id: string; at: number; synthetic: true; mark: true }

export function isSyntheticMark(v: unknown): v is SyntheticMark {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['id'] === 'string' && typeof o['at'] === 'number'
    && o['synthetic'] === true && o['mark'] === true;
}

export function syntheticMark(id: string, at: number): SyntheticMark {
  return { id, at, synthetic: true, mark: true };
}

/** Cuántas lápidas del arnés hay aquí, y cuántas reales. Una lectura agregada las separa. */
export function countSynthetic(archived: readonly ArchivedAgent[]): { real: number; synthetic: number } {
  let synthetic = 0;
  for (const t of archived) if (t.synthetic === true) synthetic += 1;
  return { real: archived.length - synthetic, synthetic };
}

/**
 * El archivo sin el arnés, que es lo que toda cuenta agregada quiere.
 *
 * Por defecto se excluye y se dice cuánto: un total que cae a la mitad sin
 * explicación escrita quema la confianza en los dos totales, el viejo y el
 * nuevo.
 */
export function withoutSynthetic(archived: readonly ArchivedAgent[]): ArchivedAgent[] {
  return archived.filter((t) => t.synthetic !== true);
}

/**
 * Horas → ms, desde lo que un humano o un modelo escriben: `24`, `"24"`,
 * `"24h"`, `"2d"`, `"90m"`. null si no hay nada; NaN si no se entiende.
 */
export function parseAge(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v * 3_600_000 : Number.NaN;
  if (typeof v !== 'string') return Number.NaN;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(h|hours?|d|days?|m|min|minutes?)?\s*$/i.exec(v);
  if (!m) return Number.NaN;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'h').toLowerCase();
  const scale = unit.startsWith('d') ? 24 * 3_600_000 : unit.startsWith('m') ? 60_000 : 3_600_000;
  return n * scale;
}
