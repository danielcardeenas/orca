/**
 * Quién está haciendo una misión, y en qué orden se lee.
 *
 * La ventana de misión contestaba dos preguntas —qué se dijo, cómo acabó— y
 * la tercera, la que se hace mirando el campo, no la contestaba nadie: **quién
 * está en ella y bajo quién**. Lo único que había era la lista plana de WHAT
 * CHANGED, una fila por agente, sin proyecto, sin squad y sin decir quién
 * manda; y estaba detrás de la pestaña de resultados, que es donde se mira una
 * misión terminada, no una en marcha.
 *
 * Esto arma la nómina en tres niveles —proyecto, squad, miembros— porque ése
 * es el eje que sobrevive: el parte del hub (`shared/debrief.ts`) trae
 * `projectId`, `squad` y `lead` de cada agente que voló, así que una misión
 * archivada se sigue leyendo entera. El linaje (`parentId`) sería más fiel a
 * cómo nació la misión, pero sólo existe mientras el agente está en el mundo:
 * una misión cerrada se vería plana, que es justo el defecto que esto arregla.
 *
 * Dos fuentes, una regla: el mundo vivo manda en lo que cambia (estado, si se
 * le puede hablar, en qué squad está ahora) y el diario manda en lo que ya no
 * está (quién voló y ya no aparece, y todas las medidas). Un agente que el
 * mundo no conoce no desaparece de la nómina: sale con lo que el diario sabe y
 * sin baldosa, porque «quién trabajó en esto» también es la respuesta.
 *
 * Puro y sin DOM: la ventana lo pinta, `test/mission-crew.test.ts` lo
 * comprueba y el campo recibe de aquí los ids que tiene que encuadrar.
 */

import type { CapcomMission } from '../../shared/missions.ts';
import type { DebriefAgent, MissionDebrief } from '../../shared/debrief.ts';
import type { Agent } from '../../shared/types.ts';
import { alive } from '../store.ts';

export interface CrewMember {
  id: string;
  callsign: string;
  /**
   * La semilla de su sigilo: el squad si lo tiene, si no su id. Es la misma
   * regla que usa la baldosa (`field/field.ts`, `sigilOf`), y por eso una fila
   * de esta nómina y un tile del campo llevan el mismo glifo.
   */
  seed: string;
  squad: string | null;
  lead: boolean;
  runtime: string | null;
  /** Su estado en la flota, o null cuando ya no está en ella. */
  state: string | null;
  /** Mientras se le pueda hablar. */
  live: boolean;
  final: 'done' | 'dead' | null;
  /** Por qué existió, o lo último que dijo. */
  say: string | null;
  /** Del diario, y sólo del diario: `null` es «nadie lo midió», nunca 0. */
  linesAdded: number | null;
  linesRemoved: number | null;
  tokens: number | null;
  durationMs: number | null;
  /** Tiene baldosa: el campo puede seleccionarlo y volar hasta él. */
  onField: boolean;
}

/** Un squad de la misión, o —con `squad: null`— los que salieron sueltos. */
export interface CrewSquad {
  squad: string | null;
  /** Quien lo lidera, si el squad tiene líder. Va antes que los demás. */
  lead: CrewMember | null;
  /** El resto, en orden de asignación. Nunca incluye al líder. */
  members: CrewMember[];
}

/** Una isla del campo: el proyecto donde esa parte de la misión se hizo. */
export interface CrewRegion {
  projectId: string | null;
  name: string;
  squads: CrewSquad[];
}

export interface MissionCrew {
  regions: CrewRegion[];
  /** Todos, en orden de lectura. */
  ids: string[];
  /** Los que el campo puede enseñar: lo que MUSTER selecciona y encuadra. */
  onField: string[];
  live: number;
  total: number;
  /** Los squads que participaron, en orden de aparición. */
  squads: string[];
}

/**
 * La palabra que rotula a un miembro: su estado mientras vive, cómo acabó
 * cuando terminó, y `GONE` cuando ni el mundo ni el diario lo saben.
 *
 * La firma es estructural a propósito: la come tanto un `CrewMember` como un
 * `DebriefAgent`, que es lo que pinta WHAT CHANGED. Dos reglas para la misma
 * palabra acabarían discrepando, y la que discrepa es siempre la que nadie mira.
 */
export function crewWord(a: { live: boolean; final: 'done' | 'dead' | null; state: string | null }): string {
  if (a.live) return (a.state ?? 'live').toUpperCase();
  if (a.final) return a.final.toUpperCase();
  return a.state ? a.state.toUpperCase() : 'GONE';
}

function member(id: string, a: Agent | undefined, d: DebriefAgent | undefined): CrewMember {
  const squad = a?.squad ?? d?.squad ?? null;
  const state = a?.state ?? d?.state ?? null;
  const live = a ? alive(a) : d?.live ?? false;
  // Un agente que el mundo todavía tiene y ya no está vivo no necesita el
  // diario para decir cómo acabó: su propio estado lo dice.
  const final: 'done' | 'dead' | null = d?.final
    ?? (a && !alive(a) ? (a.state === 'dead' ? 'dead' : 'done') : null);
  return {
    id,
    callsign: a?.callsign ?? d?.callsign ?? '??',
    seed: squad ?? id,
    squad,
    lead: a?.lead ?? d?.lead ?? false,
    runtime: a?.runtime ?? d?.runtime ?? null,
    state,
    live,
    final,
    say: d?.brief ?? d?.lastSay ?? a?.title ?? null,
    linesAdded: d?.linesAdded ?? null,
    linesRemoved: d?.linesRemoved ?? null,
    tokens: d?.tokens ?? null,
    durationMs: d?.durationMs ?? null,
    onField: !!a,
  };
}

/**
 * La nómina de la misión.
 *
 * `parte` puede no haber llegado —se pide al abrir la ventana— y entonces la
 * nómina sale sólo del mundo: menos columnas, mismos nombres y misma
 * jerarquía. El orden es el de asignación de la misión y detrás lo que sólo
 * conoce el diario, que es el orden en que el operador los vio salir.
 */
export function missionCrew(
  mission: CapcomMission,
  parte: MissionDebrief | null,
  agentOf: (id: string) => Agent | undefined,
  projectOf: (id: string) => { name: string } | undefined,
): MissionCrew {
  const filed = new Map<string, DebriefAgent>();
  for (const d of parte?.agents ?? []) filed.set(d.id, d);

  const ids: string[] = [];
  for (const id of mission.agentIds) if (!ids.includes(id)) ids.push(id);
  for (const d of parte?.agents ?? []) if (!ids.includes(d.id)) ids.push(d.id);

  const regions: CrewRegion[] = [];
  const byProject = new Map<string, CrewRegion>();
  const bySquad = new Map<string, CrewSquad>();
  const out: MissionCrew = { regions, ids: [], onField: [], live: 0, total: 0, squads: [] };

  for (const id of ids) {
    const a = agentOf(id);
    // El mando nunca es tripulación, igual que en `liveCrew`: CAPCOM lleva la
    // misión, no la trabaja, y su baldosa ya está donde siempre.
    if (a?.role === 'capcom') continue;
    const d = filed.get(id);
    if (!a && !d) continue;

    const m = member(id, a, d);
    const projectId = a?.projectId ?? d?.projectId ?? null;
    const rkey = projectId ?? '';
    let region = byProject.get(rkey);
    if (!region) {
      const name = (projectId ? projectOf(projectId)?.name : null) ?? d?.project ?? projectId ?? 'NO PROJECT';
      region = { projectId, name, squads: [] };
      byProject.set(rkey, region);
      regions.push(region);
    }
    const skey = `${rkey} ${m.squad ?? ''}`;
    let group = bySquad.get(skey);
    if (!group) {
      group = { squad: m.squad, lead: null, members: [] };
      bySquad.set(skey, group);
      region.squads.push(group);
      if (m.squad && !out.squads.includes(m.squad)) out.squads.push(m.squad);
    }
    // Un squad con dos líderes no existe por contrato; si el mundo dijera eso,
    // el segundo se lee como un miembro más antes que perderlo de la nómina.
    if (m.lead && !group.lead) group.lead = m; else group.members.push(m);

    out.ids.push(id);
    out.total++;
    if (m.live) out.live++;
    if (m.onField) out.onField.push(id);
  }

  // Los sueltos van detrás de los squads de su isla: un squad es una unidad y
  // se lee como un bloque; quien salió solo no parte ese bloque en dos.
  for (const r of regions) r.squads.sort((a, b) => (a.squad ? 0 : 1) - (b.squad ? 0 : 1));
  return out;
}

/** Todos los miembros de un squad, el líder primero. Para pintar y para contar. */
export function squadMembers(s: CrewSquad): CrewMember[] {
  return s.lead ? [s.lead, ...s.members] : s.members;
}
