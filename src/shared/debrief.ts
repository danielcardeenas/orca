/**
 * El parte de una misión: lo que de verdad quedó hecho, no lo que se dijo.
 *
 * La conversación de una misión (`shared/missions.ts`) es la palabra: lo que
 * el operador pidió y lo que CAPCOM contestó. Este es el otro lado — el
 * registro material de lo que la flota hizo mientras tanto: quién salió, con
 * qué brief, cuántas líneas tocó, qué costó, cómo acabó y en qué rama
 * aterrizó. Sale del diario del hub (`hub/journal.ts`), que ya anota cada
 * `launch`, cada `end` y cada `landing` con su `missionId`.
 *
 * Por qué del diario y no de la flota viva: un agente terminado se archiva, y
 * con él se van sus métricas del mundo en memoria. La misión, en cambio, se
 * abre días después — es literalmente para lo que existe. Un parte que se
 * vacía cuando pasa la limpieza no es un parte, es una foto.
 *
 * `buildDebrief` es puro y vive aquí, junto al tipo que viaja por el cable,
 * para que la prueba no necesite ni hub ni disco: entradas de diario y flota
 * viva entran, un parte sale. El hub sólo le pasa lo que ya tiene.
 *
 * Lo que este módulo NO hace: inventar. Un número que el diario no anotó sale
 * `null`, nunca `0`, y `measured` dice de cuántos agentes hay registro. La
 * consola tiene que poder distinguir «no cambió nada» de «nadie lo apuntó»,
 * porque la segunda es la que hay que decir en voz alta.
 */

import type { CapcomMission } from './missions.ts';
import { ceilingTokens } from './tokens.ts';

/** Lo que el parte lee de una línea del diario. Estructural: `JournalEntry` encaja. */
export interface DebriefEntry {
  at: number;
  kind: string;
  agentId?: string | null;
  callsign?: string | null;
  projectId?: string | null;
  project?: string | null;
  squad?: string | null;
  missionId?: string | null;
  /* launch */
  brief?: string | null;
  title?: string | null;
  runtime?: string | null;
  model?: string | null;
  lead?: boolean;
  startedAt?: number;
  /* end */
  state?: string;
  durationMs?: number;
  tokens?: { input: number; output: number; cacheRead: number; thinking: number; cacheWrite?: number };
  lines?: { added: number; removed: number };
  toolCalls?: number;
  lastSay?: string | null;
  /* landing */
  branch?: string | null;
  target?: string | null;
  commit?: string | null;
  ok?: boolean;
  detail?: string | null;
  note?: string | null;
}

/** Lo que el parte necesita saber de un agente que sigue en la flota. */
export interface DebriefFleetAgent {
  id: string;
  callsign: string;
  state: string;
  role?: string;
  squad?: string | null;
  lead?: boolean;
  runtime?: string;
  model?: string | null;
  projectId?: string;
  mission?: string | null;
  worktree?: string | null;
  branch?: string | null;
  startedAt?: number;
  updatedAt?: number;
  lastSay?: string | null;
  metrics?: { linesAdded?: number; linesRemoved?: number; toolCalls?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

/** Un agente de la misión, con lo que se sabe de él aunque ya no esté. */
export interface DebriefAgent {
  id: string;
  callsign: string | null;
  /** Su estado en la flota ahora mismo, o null si ya no está en ella. */
  state: string | null;
  /** True mientras se le pueda hablar: sigue en la flota y no ha terminado. */
  live: boolean;
  lead: boolean;
  squad: string | null;
  runtime: string | null;
  model: string | null;
  projectId: string | null;
  project: string | null;
  /** El brief con el que salió: por qué existió. */
  brief: string | null;
  /** Cómo acabó, según el diario. null = no hay `end` anotado. */
  final: 'done' | 'dead' | null;
  startedAt: number | null;
  endedAt: number | null;
  lastSay: string | null;
  /** null, nunca 0, cuando nadie lo midió. */
  linesAdded: number | null;
  linesRemoved: number | null;
  /** Uso, en tokens de techo. Sustituyó a `costUSD` el 2026-09-12. */
  tokens: number | null;
  durationMs: number | null;
  toolCalls: number | null;
  worktree: string | null;
  branch: string | null;
}

export interface DebriefLanding {
  at: number;
  agentId: string | null;
  callsign: string | null;
  branch: string | null;
  target: string | null;
  commit: string | null;
  ok: boolean;
  detail: string | null;
}

export interface DebriefTotals {
  agents: number;
  done: number;
  dead: number;
  linesAdded: number;
  linesRemoved: number;
  tokens: number;
  durationMs: number;
  /** De cuántos agentes hay medida de verdad. `0` con agentes es «nadie lo apuntó». */
  measured: number;
}

export interface MissionDebrief {
  missionId: string;
  /**
   * Si el hub pudo leer su diario. `false` no es «no hubo cambios»: es «no lo
   * sé», y la consola lo dice con esas palabras en vez de enseñar ceros.
   */
  journal: boolean;
  agents: DebriefAgent[];
  landings: DebriefLanding[];
  totals: DebriefTotals;
}

const FINAL = new Set(['done', 'dead']);

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * El uso de un fin del diario, con la regla de los techos. Null cuando esa
 * entrada no anotó tokens —una anterior a que el diario los guardara—, que no
 * es lo mismo que un cero.
 */
function endTokens(end: { tokens?: { input: number; output: number; cacheRead: number; cacheWrite?: number } } | undefined): number | null {
  const t = end?.tokens;
  if (!t) return null;
  return ceilingTokens({
    inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead,
    ...(typeof t.cacheWrite === 'number' ? { cacheWriteTokens: t.cacheWrite } : {}),
  });
}

/** Lo mismo desde la flota viva, para un agente que todavía no ha terminado. */
function liveTokens(live: { metrics?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } } | undefined): number | null {
  const m = live?.metrics;
  if (!m) return null;
  return ceilingTokens(m);
}

/**
 * El parte de una misión.
 *
 * `entries` son las líneas del diario de esa misión (cualquier orden), `fleet`
 * resuelve un agente que siga en el mundo. El orden de salida es el de
 * asignación de la misión primero —es el orden en que el operador los vio
 * salir— y detrás lo que sólo conoce el diario, por hora de arranque.
 */
export function buildDebrief(
  mission: CapcomMission,
  entries: readonly DebriefEntry[],
  fleet: (id: string) => DebriefFleetAgent | undefined,
  opts: { journal?: boolean } = {},
): MissionDebrief {
  const launches = new Map<string, DebriefEntry>();
  const ends = new Map<string, DebriefEntry>();
  const landings: DebriefLanding[] = [];

  for (const e of entries) {
    if (e.missionId && e.missionId !== mission.id) continue;
    const id = e.agentId ?? null;
    if (e.kind === 'launch' && id) {
      const had = launches.get(id);
      // El primero manda: un `launch` tardío del barrido repite lo ya anotado.
      if (!had || e.at < had.at) launches.set(id, e);
    } else if (e.kind === 'end' && id) {
      const had = ends.get(id);
      if (!had || e.at > had.at) ends.set(id, e);
    } else if (e.kind === 'landing') {
      landings.push({
        at: e.at,
        agentId: id,
        callsign: e.callsign ?? (id ? fleet(id)?.callsign ?? null : null),
        branch: e.branch ?? null,
        target: e.target ?? null,
        commit: e.commit ?? null,
        ok: e.ok !== false,
        detail: e.detail ?? e.note ?? null,
      });
    }
  }

  const ids: string[] = [...mission.agentIds];
  for (const id of [...launches.keys(), ...ends.keys()]) if (!ids.includes(id)) ids.push(id);

  const agents: DebriefAgent[] = ids.map((id) => {
    const live = fleet(id);
    const l = launches.get(id);
    const end = ends.get(id);
    const final = end && FINAL.has(String(end.state)) ? (end.state as 'done' | 'dead') : null;
    // La flota viva mide mejor que el diario mientras el agente corre; el
    // diario es lo único que queda cuando ya no está. Se prefiere el `end`
    // anotado, que es definitivo, y si no lo hay, lo que el mundo dice ahora.
    const lines = end?.lines ?? (live?.metrics
      ? { added: live.metrics.linesAdded ?? 0, removed: live.metrics.linesRemoved ?? 0 }
      : null);
    return {
      id,
      callsign: live?.callsign ?? end?.callsign ?? l?.callsign ?? null,
      state: live?.state ?? null,
      live: !!live && live.state !== 'done' && live.state !== 'dead',
      lead: live?.lead ?? l?.lead ?? false,
      squad: live?.squad ?? end?.squad ?? l?.squad ?? null,
      runtime: live?.runtime ?? end?.runtime ?? l?.runtime ?? null,
      model: live?.model ?? end?.model ?? l?.model ?? null,
      projectId: live?.projectId ?? end?.projectId ?? l?.projectId ?? null,
      project: end?.project ?? l?.project ?? null,
      brief: l?.brief ?? live?.mission ?? null,
      final,
      startedAt: num(l?.startedAt) ?? num(live?.startedAt) ?? (l ? l.at : null),
      endedAt: end ? end.at : null,
      lastSay: end?.lastSay ?? live?.lastSay ?? null,
      linesAdded: lines ? lines.added : null,
      linesRemoved: lines ? lines.removed : null,
      tokens: endTokens(end) ?? liveTokens(live),
      durationMs: num(end?.durationMs),
      toolCalls: num(end?.toolCalls) ?? num(live?.metrics?.toolCalls),
      worktree: live?.worktree ?? null,
      branch: live?.branch ?? null,
    };
  });

  const totals: DebriefTotals = {
    agents: agents.length,
    done: agents.filter((a) => a.final === 'done').length,
    dead: agents.filter((a) => a.final === 'dead').length,
    linesAdded: 0, linesRemoved: 0, tokens: 0, durationMs: 0, measured: 0,
  };
  for (const a of agents) {
    if (a.linesAdded === null && a.tokens === null && a.durationMs === null) continue;
    totals.measured++;
    totals.linesAdded += a.linesAdded ?? 0;
    totals.linesRemoved += a.linesRemoved ?? 0;
    totals.tokens += a.tokens ?? 0;
    totals.durationMs += a.durationMs ?? 0;
  }

  landings.sort((a, b) => b.at - a.at);
  return { missionId: mission.id, journal: opts.journal !== false, agents, landings, totals };
}
