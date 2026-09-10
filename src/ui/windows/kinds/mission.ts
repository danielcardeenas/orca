/**
 * Una misión, en su propia ventana.
 *
 * Una misión era una pestaña dentro de CAPCOM, y eso la hacía imposible de
 * tener delante: para mirar dos había que ir y volver, y para leer un
 * resultado mientras se le escribía al mando había que elegir. Ahora cada
 * misión es una ventana del canvas como cualquier otra —se arrastra, se
 * apila, se pliega en la bandeja— con identidad estable por `mission_id`:
 * abrir una que ya está abierta la trae al frente en vez de duplicarla, y
 * cerrarla no la archiva ni la termina, igual que cerrar la ventana de un
 * agente no lo para.
 *
 * Se abre por las dos puertas: la fila del panel de misiones del HUD
 * (`hud/missions.ts`) y la cinta de conversaciones de CAPCOM
 * (`kinds/ceo.ts`), que dejó de cambiar de vista para abrir esta.
 *
 * ── Tres pestañas, y la primera es la misión ───────────────────────
 *
 *   MISSION       lo que se ve al abrirla, siempre: qué es (el título), qué
 *                 se pidió (el encargo entero), y qué ha salido de ella —el
 *                 resultado publicado o, si CAPCOM aún no lo publicó, lo
 *                 último que entregó su líder—, con lo que la flota cambió,
 *                 los ficheros y la media. Hasta el 2026-09-09 una misión viva
 *                 abría por su conversación, y para saber de qué iba había que
 *                 leer el hilo desde arriba.
 *   CONVERSATION  qué se dijo, y desde dónde se escribe. Es secundaria a
 *                 propósito: la misión es el trabajo, no la charla.
 *   CREW          quién la está haciendo y bajo quién: la nómina en tres
 *                 niveles —proyecto, squad, miembros— que arma
 *                 `windows/mission-crew.ts`. Los que ya terminaron siguen
 *                 ahí, en gris: quién trabajó en esto también es la respuesta.
 *
 * ── Dónde están, sin dibujar un segundo campo ──────────────────────
 *
 * La nómina no lleva mapa. El campo ya es el mapa, y una miniatura suya
 * dentro de una ventana serían dos verdades sobre dónde está cada agente, la
 * pequeña siempre peor. Lo que hay es un puente: MUSTER selecciona a la
 * tripulación, encuadra sus baldosas y enciende el foco, así que el campo
 * apaga al 12 % todo lo que la misión no toca; un callsign vuela a su baldosa,
 * un squad abre el suyo y un proyecto abre su isla. El gesto de vuelta —
 * Backspace— funciona porque MUSTER apila la vista antes de mover la cámara.
 *
 * ── De dónde sale cada cosa, y por qué nada se inventa ─────────────
 *
 *   BRIEF     lo primero que se dijo en la misión, entero (`missionBrief`).
 *   RESULT    el último `report_mission` de CAPCOM. Publicar el texto y
 *             marcar la misión completada son la misma llamada, así que ese
 *             mensaje ES el resultado. Si no lo hay pero el líder ya
 *             entregó, se enseña eso, rotulado como NO PUBLICADO: el trabajo
 *             existe aunque falte el sello. Si no hay nada, se dice.
 *   CHANGED   el diario del hub (`mission:debrief` → `shared/debrief.ts`):
 *             líneas tocadas, coste, duración y aterrizajes de rama, por
 *             agente. Sobrevive al archivado de la flota, que es justo cuando
 *             esta ventana se abre. Un número que nadie midió sale «—», no 0.
 *   FILES     las rutas escritas en la conversación, resueltas contra el
 *             proyecto de quien las escribió y abiertas en el visor de ORCA
 *             (`windows/paths.ts`, `kinds/file.ts`). No es una lista de
 *             ficheros tocados —eso no lo sabe nadie— sino de lo que se
 *             reportó, y así se rotula.
 *   MEDIA     los artefactos que publicaron sus agentes (`orca-show`).
 *
 * Ninguna sección se rellena cuando está vacía: cada una dice qué falta y
 * quién tendría que haberlo puesto. Un parte que aparenta tener resultados
 * cuando no los tiene es peor que no tener parte.
 *
 * ── Una sola línea de salida, y se dice a dónde va ─────────────────
 *
 * Hasta el 2026-09-09 la ventana ofrecía dos destinatarios —el líder y
 * CAPCOM— con un selector, y el operador no sabía cuál era la conversación
 * «con él» y cuál la de los agentes con CAPCOM. Ahora hay UNA línea, se
 * escribe sólo desde CONVERSATION, y el destinatario no se elige: es el
 * LÍDER de la misión si tiene uno en pie, y CAPCOM si no. Lo decide el hub
 * (`mission:say`) con la misma regla que esta ventana enseña de antemano
 * (`missionLeadOf`), así que lo que se promete y lo que pasa coinciden. La
 * respuesta del líder cae en este mismo hilo; CAPCOM sólo se entera cuando el
 * líder reporta, y sólo para publicarlo. Escribir en una misión terminada la
 * reabre.
 */

import { missionBrief, missionResult, missionStall, type CapcomMission, type MissionMessage } from '../../../shared/missions.ts';
import type { DebriefAgent, MissionDebrief } from '../../../shared/debrief.ts';
import { capcomOf } from '../../../shared/capcom.ts';
import { crewWord, missionCrew, squadMembers, type CrewMember, type CrewSquad, type MissionCrew } from '../mission-crew.ts';
import { sigilBits, sigilHTML } from '../../gfx/sigil.ts';
import { missionHeadline, missionLead, PHASE_WORD, missionPhase, liveCrew, type MissionLead } from '../../hud/mission-status.ts';
import { store, type OutgoingMessage } from '../../store.ts';
import { authedUrl, hub, uploadFile } from '../../net/client.ts';
import { bindAttach } from '../attach.ts';
import { drafts, draftKey, type DraftBinding } from '../../drafts.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { ago, clock, dur, esc, money } from '../../util.ts';
import { mdLite } from '../markdown.ts';
import { refIndex } from '../refs.ts';
import { linkPaths, findPaths, baseName, type PathMatch } from '../paths.ts';
import { pendingEchoes, timeOrdered } from '../talk.ts';
import { slabBusy, slabFlash } from '../fx.ts';
import { bindComposer, composerHint } from '../composer.ts';

/** Cuántas rutas distintas se listan antes de que la lista sea el problema. */
const FILES_SHOWN = 40;

/**
 * `results` es la pestaña MISSION: conserva su id porque el panel del HUD, la
 * cinta de CAPCOM y las ventanas guardadas la piden por ese nombre.
 */
export type MissionTab = 'results' | 'talk' | 'crew';
const TABS: MissionTab[] = ['results', 'talk', 'crew'];

/** Una ruta reportada en la conversación, con quién la escribió. */
export interface ReportedFile {
  path: string;
  /** Cómo se escribió, que es como el operador la reconoce. */
  text: string;
  line: number | null;
  /** El agente al que atribuir la apertura, para que el visor sepa su proyecto. */
  agentId: string | null;
  at: number;
}

/**
 * Las rutas que la misión reportó, sin repetir, la primera mención primero.
 *
 * `rootOf` da el proyecto de quien escribió cada mensaje: una ruta relativa
 * sin proyecto conocido no se adivina, se descarta (ver `windows/paths.ts`).
 * Puro y exportado porque es la única parte de esta ventana con una regla que
 * merezca una prueba.
 */
export function reportedFiles(
  mission: CapcomMission,
  rootOf: (agentId: string | null) => string | null,
): ReportedFile[] {
  const out: ReportedFile[] = [];
  const seen = new Set<string>();
  for (const m of mission.messages) {
    const root = rootOf(m.agentId ?? null);
    const found: PathMatch[] = findPaths(m.text, root ? { root } : {});
    for (const f of found) {
      const key = `${f.path}#${f.line ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: f.path, text: f.text, line: f.line, agentId: m.agentId ?? null, at: m.at });
    }
  }
  return out;
}

/** «+12 −3» con un guion cuando nadie lo midió. Nunca un cero inventado. */
function lines(a: DebriefAgent): string {
  if (a.linesAdded === null && a.linesRemoved === null) return '—';
  return `+${a.linesAdded ?? 0} −${a.linesRemoved ?? 0}`;
}

/**
 * Los squads de la cabecera: los que la misión declaró y los que su gente
 * lleva puestos, sin repetir.
 *
 * `mission.squads` es lo que CAPCOM apuntó al lanzar, y la nómina es lo que la
 * flota dice ahora; un squad que se alistó después no está en el primero y uno
 * que ya voló entero no está en la segunda. Enseñar sólo una de las dos listas
 * deja fuera media misión según el día.
 */
export function squadNames(mission: CapcomMission, crew: { squads: string[] }): string[] {
  const out = [...(mission.squads ?? [])];
  for (const sq of crew.squads) if (!out.includes(sq)) out.push(sq);
  return out;
}

/**
 * Con qué pestaña abre una misión: la misión. Viva o terminada, lo primero
 * que se quiere saber es qué es, qué se pidió y qué ha salido; la
 * conversación está a un clic y no es lo que se viene a leer.
 */
export function openingTab(_status: CapcomMission['status']): MissionTab {
  return 'results';
}

/**
 * A quién va la línea que el operador escriba, y por qué. Es lo que la
 * ventana promete encima de la caja; el hub decide con la misma regla.
 */
export interface Outlet {
  to: 'lead' | 'capcom';
  /** El líder, en pie o no. Null cuando la misión nunca tuvo uno. */
  lead: MissionLead | null;
  /** La frase que va encima de la caja, en mayúsculas de rótulo. */
  label: string;
  /** Lo que pasa al mandar, en una o dos frases. */
  why: string;
}

export function outletFor(lead: MissionLead | null, capcomAlive: boolean, finished: boolean): Outlet {
  const reopen = finished ? ' Sending reopens this mission.' : '';
  if (lead?.live) {
    return {
      to: 'lead', lead,
      label: `TO ${lead.agent.callsign} · LEAD OF THIS MISSION`,
      why: `Goes straight to ${lead.agent.callsign}'s session${lead.agent.squad ? ` (leads ${lead.agent.squad})` : ''}.`
        + ` Its answer lands in this thread. CAPCOM is not involved until ${lead.agent.callsign} reports.${reopen}`,
    };
  }
  const cap = capcomAlive
    ? 'CAPCOM reads this thread and launches or redirects the crew.'
    : 'No CAPCOM session right now: the line is kept in the mission and taken when one appears.';
  if (lead) {
    return {
      to: 'capcom', lead,
      label: 'TO CAPCOM · THE LEAD IS GONE',
      why: `${lead.agent.callsign}'s session ended ${ago(lead.agent.updatedAt)} ago: it can be read, not reached. ${cap}${reopen}`,
    };
  }
  return {
    to: 'capcom', lead: null,
    label: 'TO CAPCOM · NO LEAD ON THIS MISSION',
    why: `${cap}${reopen}`,
  };
}

export function mountMission(ctx: WinCtx, c: Console) {
  const missionId = ctx.win.spec.params?.missionId ?? '';
  const body = ctx.body;
  body.classList.add('mission-win');
  body.innerHTML = `
    <div class="mission-win__head mono" data-head></div>
    <div class="tabs" role="tablist" data-tabs>
      <button class="tab" type="button" role="tab" data-tab="results">MISSION</button>
      <button class="tab" type="button" role="tab" data-tab="talk">CONVERSATION</button>
      <button class="tab" type="button" role="tab" data-tab="crew">CREW</button>
    </div>
    <div class="win__scroll scroll" data-scroll role="tabpanel"></div>
    <div class="mission-win__talk" data-talk></div>
  `;
  const scroll = body.querySelector<HTMLElement>('[data-scroll]')!;
  const headEl = body.querySelector<HTMLElement>('[data-head]')!;
  const tabsEl = body.querySelector<HTMLElement>('[data-tabs]')!;
  const talkEl = body.querySelector<HTMLElement>('[data-talk]')!;

  const asked = ctx.win.spec.params?.tab;
  let tab: MissionTab = TABS.includes(asked as MissionTab)
    ? asked as MissionTab
    : openingTab(store.world.missions?.[missionId]?.status ?? 'active');

  /** El parte del hub. `null` mientras no ha llegado; `parteError` cuando no llegará. */
  let parte: MissionDebrief | null = null;
  let parteError: string | null = null;
  let asking = false;
  /** Qué informes anteriores están desplegados. */
  const openReports = new Set<string>();
  let sig = '';
  let talkSig = '';
  let sending = false;
  /** El borrador vive con la caja, y la caja se rehace cada vez que cambia el destinatario. */
  let draft: DraftBinding | null = null;
  /** La regla de Enter, cableada a la caja de turno. Ver `windows/composer.ts`. */
  let unbindComposer: (() => void) | null = null;
  let unbindAttach: (() => void) | null = null;

  function mission(): CapcomMission | undefined { return store.world.missions?.[missionId]; }

  function projectRoot(agentId: string | null): string | null {
    const a = agentId ? store.knownAgent(agentId) : undefined;
    const p = a ? store.world.projects[a.projectId] : undefined;
    return p?.path ?? null;
  }

  function leadOf(m: CapcomMission): MissionLead | null {
    return missionLead(m, (id) => store.knownAgent(id), store.everyone());
  }

  async function ask() {
    if (asking) return;
    asking = true;
    try {
      parte = await hub.missionDebrief(missionId);
      parteError = null;
    } catch (err) {
      parteError = err instanceof Error ? err.message : String(err);
    } finally {
      asking = false;
      sig = '';
      render();
    }
  }

  /* ── La conversación ──────────────────────────────────────────── */

  /**
   * Quién habló, y a quién. Una línea del operador dice a quién iba —al líder
   * o a CAPCOM— porque es exactamente lo que no se distinguía; la del líder
   * lleva su papel, y la de ORCA se llama ORCA y no «system».
   */
  function said(m: MissionMessage, lead: MissionLead | null): string {
    if (m.role === 'human') {
      const to = m.to ? store.knownAgent(m.to)?.callsign ?? 'LEAD' : 'CAPCOM';
      return `YOU → ${to}`;
    }
    if (m.role === 'agent') {
      const cs = store.knownAgent(m.agentId ?? '')?.callsign ?? 'AGENT';
      return lead && m.agentId === lead.agent.id ? `${cs} · LEAD` : cs;
    }
    if (m.role === 'system') return 'ORCA';
    return m.role.toUpperCase();
  }

  const cls = (m: MissionMessage) =>
    m.role === 'human' ? 'is-human' : m.role === 'capcom' ? 'is-capcom' : m.role === 'agent' ? 'is-fleet' : 'is-system';

  /**
   * Lo que se ha mandado a esta misión y el hub todavía no ha devuelto.
   *
   * Un mensaje se ve en cuanto sale, marcado como en vuelo, y desaparece
   * cuando la conversación lo trae de vuelta: sin esto, escribir en una misión
   * es teclear contra un hilo que no cambia hasta que alguien conteste. Se
   * ordena por hora con el resto del hilo (`timeOrdered`), nunca al final.
   */
  function echoes(m: CapcomMission): OutgoingMessage[] {
    const mine = store.outgoing.filter((x) => x.agentId === null && (x.missionId ?? null) === m.id);
    const landed = (x: OutgoingMessage) =>
      m.messages.some((t) => t.role === 'human' && t.text.trim() === x.text.trim() && t.at >= x.at - 60_000);
    return pendingEchoes(mine, landed).slice(-3);
  }

  function echoHtml(m: OutgoingMessage, outlet: Outlet): string {
    const label = m.status === 'failed' ? `NOT SENT${m.detail ? '' : ' · the hub refused it'}`
      : m.status === 'sending' ? 'SENDING…' : 'DELIVERED';
    const to = outlet.to === 'lead' && outlet.lead ? outlet.lead.agent.callsign : 'CAPCOM';
    return `<div class="talk__g is-human is-echo"><div class="talk__who px">YOU → ${esc(to)} <span class="talk__t">${clock(m.at)}</span></div><div>
      <div class="talk__text mono">${esc(m.text)}</div>
      <div class="talk__echo px" style="color:var(${m.status === 'failed' ? '--amber' : '--ink-dimmer'})">${esc(label)}${m.detail ? ` · ${esc(m.detail)}` : ''}</div>
    </div></div>`;
  }

  function talkHtml(m: CapcomMission, refs: ReturnType<typeof refIndex>, outlet: Outlet): string {
    const echo = echoes(m);
    const questions = Object.values(store.world.escalations)
      .filter((e) => m.agentIds.includes(e.agentId) && (e.status === 'pending' || e.status === 'with_ceo'));
    if (!m.messages.length && !echo.length) {
      return `${questionsHtml(questions)}<div class="ceo__empty mono">Nothing has been said in this mission yet. Describe it and name its project; its messages, workers and results stay here.</div>`;
    }
    const lead = outlet.lead;
    return `${questionsHtml(questions)}<div class="talk">${timeOrdered([
      ...m.messages.map((x) => ({
        at: x.at,
        html: `<div class="talk__g ${cls(x)}"><div class="talk__who px">${esc(said(x, lead))} <span class="talk__t">${clock(x.at)}</span></div>`
          + `<div class="talk__text mono"${x.agentId ? ` data-file-agent="${esc(x.agentId)}"` : ''}>${x.role === 'capcom' || x.role === 'agent' ? mdLite(x.text, refs) : esc(x.text)}</div></div>`,
      })),
      ...echo.map((x) => ({ at: x.at, html: echoHtml(x, outlet) })),
    ])}</div>`;
  }

  function questionsHtml(list: { id: string; question: string }[]): string {
    return list.map((e) => `<div class="sec"><button class="chip" type="button" data-question="${esc(e.id)}" style="--chip-state:var(--amber)">QUESTION · ${esc(e.question)}</button></div>`).join('');
  }

  /* ── La tripulación ───────────────────────────────────────────── */

  /** La nómina de ahora mismo. Se arma una vez por pintada y la usan tres sitios. */
  function crewOf(m: CapcomMission): MissionCrew {
    return missionCrew(m, parte, (id) => store.knownAgent(id), (id) => store.world.projects[id]);
  }

  /**
   * Una fila: el glifo que lleva su baldosa, el callsign que vuela hasta ella,
   * y lo que se sabe de él. Las medidas sólo salen del diario, así que un
   * agente vivo enseña guiones hasta que alguien las anote — que es la verdad.
   */
  function memberHtml(x: CrewMember): string {
    const glyph = sigilHTML(sigilBits(x.seed), x.lead);
    const cls = x.live ? 'is-live' : x.final === 'dead' ? 'is-dead' : '';
    const say = (x.say ?? '').replace(/\s+/g, ' ').trim();
    return `<div class="mission-win__crew ${cls}">
      <button class="mission-win__cs" type="button" data-go="${esc(x.id)}"
        title="${esc(x.callsign)}${x.onField ? ' · fly to its tile' : ' · no longer on the field'}"${x.onField ? '' : ' disabled'}>${glyph}${esc(x.callsign)}</button>
      <span class="px px--tiny mission-win__st">${esc(crewWord(x))}</span>
      <span class="mono mission-win__rt">${esc((x.runtime ?? '—').toUpperCase())}</span>
      <span class="mono mission-win__lines">${x.linesAdded === null && x.linesRemoved === null ? '—' : `+${x.linesAdded ?? 0} −${x.linesRemoved ?? 0}`}</span>
      <span class="mono mission-win__cost">${x.costUSD === null ? '—' : money(x.costUSD)}</span>
      <button class="mission-win__say mono" type="button" data-open="${esc(x.id)}" title="open ${esc(x.callsign)}">${esc(say.slice(0, 140) || 'no brief filed')}</button>
    </div>`;
  }

  /** Un squad, con su líder arriba. Sin líder no se inventa uno: se dice. */
  function squadHtml(g: CrewSquad, alone: boolean): string {
    const rows = squadMembers(g).map(memberHtml).join('');
    if (!g.squad) {
      // Un solo grupo suelto no necesita rótulo: la isla ya lo dice todo.
      return alone ? rows : `<div class="mission-win__sq">
        <p class="px px--tiny mission-win__sqh mission-win__sqh--solo">ON THEIR OWN · ${g.members.length}</p>${rows}</div>`;
    }
    const n = squadMembers(g).length;
    return `<div class="mission-win__sq">
      <button class="mission-win__sqh px px--tiny" type="button" data-squad="${esc(g.squad)}" title="open the squad">
        ${sigilHTML(sigilBits(g.squad))}${esc(g.squad.toUpperCase())} · ${n} · ${g.lead ? `LED BY ${esc(g.lead.callsign)}` : 'NO LEAD'}
      </button>${rows}</div>`;
  }

  function crewHtml(cr: MissionCrew): string {
    if (!cr.total) {
      return `<p class="mission-win__none px px--tiny" style="padding:10px 12px">${parte || !asking
        ? 'NOBODY HAS FLOWN FOR THIS MISSION · CAPCOM LAUNCHES ITS CREW WITH SPAWN_AGENT AND LAUNCH_SQUAD'
        : 'READING THE FLEET JOURNAL…'}</p>`;
    }
    const head = `<p class="px px--tiny mission-win__tot">${cr.live} LIVE · ${cr.total} FLEW · ${cr.regions.length} PROJECT${cr.regions.length === 1 ? '' : 'S'}${cr.squads.length ? ` · ${cr.squads.length} SQUAD${cr.squads.length === 1 ? '' : 'S'}` : ''}${cr.onField.length < cr.total ? ` · ${cr.total - cr.onField.length} NO LONGER ON THE FIELD` : ''}</p>`;
    const regions = cr.regions.map((r) => `
      <div class="mission-win__reg">
        <button class="mission-win__proj px px--tiny" type="button"${r.projectId ? ` data-proj="${esc(r.projectId)}"` : ' disabled'}
          title="${r.projectId ? 'open the project' : 'no project on record'}">${esc(r.name.toUpperCase())}</button>
        ${r.squads.map((g) => squadHtml(g, r.squads.length === 1)).join('')}
      </div>`).join('');
    return `<section class="mission-win__sec">${head}${regions}</section>`;
  }

  /**
   * MUSTER: llevar la misión al campo en vez de dibujar el campo aquí.
   *
   * Selecciona a los suyos, encuadra sus baldosas y enciende el foco, con lo
   * que todo lo que la misión no toca cae al 12 % y las relaciones se quedan.
   * Apila la vista primero: Backspace devuelve a donde estabas.
   */
  function muster() {
    const m = mission();
    if (!m) return;
    const ids = crewOf(m).onField;
    if (!ids.length) { c.note('Nobody from this mission is on the field', 'warn'); return; }
    c.pushView();
    c.field.select(ids);
    c.field.frameAgents(ids);
    c.field.setFocus(true);
    c.note(`${ids.length} of this mission held up on the field`, 'info');
  }

  /* ── La misión: encargo y resultados ──────────────────────────── */

  /** El texto de un mensaje, con sus rutas ya abribles y sus callsigns enlazados. */
  function textHtml(m: MissionMessage, refs: ReturnType<typeof refIndex>): string {
    const scope = m.agentId ?? '';
    return `<div class="mission-win__text mono" ${scope ? `data-file-agent="${esc(scope)}"` : ''}>${mdLite(m.text, refs)}</div>`;
  }

  /**
   * El encargo, entero. Es lo que el panel enseña recortado en una fila y lo
   * que aquí se lee completo sin buscarlo en el hilo. Si la misión aún no
   * tiene una palabra, se dice: es un estado real, no un error.
   */
  function briefHtml(m: CapcomMission, refs: ReturnType<typeof refIndex>): string {
    const brief = missionBrief(m);
    if (!brief) {
      return `<p class="mission-win__none px px--tiny">NOTHING WRITTEN IN THIS MISSION YET · WRITE IN CONVERSATION TO OPEN IT</p>`;
    }
    const who = brief.role === 'human' ? 'YOU' : 'CAPCOM';
    return `<div class="mission-win__opening">
      <p class="px px--tiny mission-win__when">${who} · ${clock(brief.at)} · ${ago(brief.at)} AGO</p>
      ${textHtml(brief, refs)}
    </div>`;
  }

  function resultHtml(m: CapcomMission, refs: ReturnType<typeof refIndex>, lead: MissionLead | null): string {
    const { final, latest } = missionResult(m);
    const finished = m.status === 'completed' || m.status === 'failed';
    // Lo que entregó la flota después de la última palabra de CAPCOM: el
    // trabajo ya existe aunque CAPCOM no lo haya publicado todavía, y es lo
    // que el operador quiere leer sin esperar al sello.
    const fresh = latest ? `<div class="mission-win__result mission-win__result--fleet">
      <p class="px px--tiny mission-win__when">${esc(said(latest, lead))} · ${clock(latest.at)} · ${ago(latest.at)} AGO · NOT YET PUBLISHED BY CAPCOM</p>
      ${textHtml(latest, refs)}
    </div>` : '';
    if (!final) {
      return fresh || `<p class="mission-win__none px px--tiny">${finished
        ? 'NO RESULT PUBLISHED · THIS MISSION WAS CLOSED WITHOUT A REPORT_MISSION'
        : 'NOTHING PUBLISHED YET · THE LEAD REPORTS HERE WHEN IT FINISHES, AND CAPCOM PUBLISHES IT'}</p>`;
    }
    return `${fresh}<div class="mission-win__result">
      <p class="px px--tiny mission-win__when">CAPCOM · ${clock(final.at)} · ${ago(final.at)} AGO${finished ? '' : ' · MISSION STILL OPEN, THIS IS THE LATEST WORD'}</p>
      ${textHtml(final, refs)}
    </div>`;
  }

  function reportsHtml(m: CapcomMission, refs: ReturnType<typeof refIndex>, lead: MissionLead | null): string {
    const { progress, fromFleet, latest } = missionResult(m);
    // Lo que ya está arriba como resultado fresco no se repite aquí.
    const all = [...progress, ...fromFleet].filter((x) => x.id !== latest?.id).sort((a, b) => a.at - b.at);
    if (!all.length) return `<p class="mission-win__none px px--tiny">NO EARLIER REPORTS</p>`;
    return all.map((x) => {
      const on = openReports.has(x.id);
      const first = x.text.replace(/\s+/g, ' ').trim().slice(0, 90);
      return `<div class="mission-win__rep ${on ? 'is-open' : ''}">
        <button class="mission-win__reph" type="button" data-rep="${esc(x.id)}" aria-expanded="${on}">
          <span class="px px--tiny mission-win__who">${esc(said(x, lead))}</span>
          <span class="px px--tiny mission-win__when">${clock(x.at)}</span>
          <span class="mono mission-win__peek">${esc(first)}${x.text.length > 90 ? '…' : ''}</span>
        </button>
        ${on ? textHtml(x, refs) : ''}
      </div>`;
    }).join('');
  }

  function changedHtml(): string {
    if (parteError) {
      return `<p class="mission-win__none px px--tiny">NO CHANGE RECORD: ${esc(parteError.toUpperCase())} · <button class="mission-win__act" type="button" data-retry>RETRY</button></p>`;
    }
    if (!parte) return `<p class="mission-win__none px px--tiny">READING THE FLEET JOURNAL…</p>`;
    if (!parte.journal) {
      return `<p class="mission-win__none px px--tiny">THIS HUB KEEPS NO JOURNAL · WHAT THE FLEET CHANGED WAS NEVER FILED, WHICH IS NOT THE SAME AS NOTHING</p>`;
    }
    if (!parte.agents.length) {
      return `<p class="mission-win__none px px--tiny">NO AGENT EVER RAN FOR THIS MISSION</p>`;
    }
    const t = parte.totals;
    // «SO FAR» mientras quede alguien corriendo: el mismo número significa
    // «esto es lo que costó» cuando ha acabado y «esto lleva» cuando no, y
    // decirlo es la diferencia entre un total y una lectura a medias.
    const running = parte.agents.some((a) => a.live);
    const totals = t.measured
      ? `<p class="px px--tiny mission-win__tot">+${t.linesAdded} −${t.linesRemoved} LINES · ${money(t.costUSD)}${t.durationMs ? ` · ${dur(t.durationMs)}` : ''} · ${t.measured} OF ${t.agents} AGENTS MEASURED${running ? ' · SO FAR, SOME ARE STILL RUNNING' : ''}</p>`
      : `<p class="px px--tiny mission-win__tot">NONE OF ITS ${t.agents} AGENTS FILED A FINAL RECORD YET</p>`;
    const rows = parte.agents.map((a) => `
      <div class="mission-win__crew ${a.live ? 'is-live' : ''} ${a.final === 'dead' ? 'is-dead' : ''}">
        <button class="mission-win__cs" type="button" data-go="${esc(a.id)}" title="fly to ${esc(a.callsign ?? a.id)}">${esc(a.callsign ?? '??')}</button>
        <span class="px px--tiny mission-win__st">${esc(crewWord(a))}</span>
        <span class="mono mission-win__lines">${lines(a)}</span>
        <span class="mono mission-win__cost">${a.costUSD === null ? '—' : money(a.costUSD)}</span>
        <span class="mono mission-win__dur">${a.durationMs === null ? '—' : dur(a.durationMs)}</span>
        <span class="mono mission-win__brief">${esc((a.brief ?? a.lastSay ?? '').replace(/\s+/g, ' ').slice(0, 120) || '—')}</span>
      </div>`).join('');
    const landed = parte.landings.length ? `<div class="mission-win__lands">${parte.landings.map((l) => `
      <p class="mono mission-win__land ${l.ok ? '' : 'is-fail'}">${l.ok ? 'LANDED' : 'DID NOT LAND'} ${esc(l.branch ?? '?')}${l.target ? ` → ${esc(l.target)}` : ''}${l.commit ? ` · ${esc(l.commit.slice(0, 8))}` : ''} · ${esc(l.callsign ?? '??')} · ${ago(l.at)}${l.detail ? ` · ${esc(l.detail)}` : ''}</p>`).join('')}</div>` : '';
    return `${totals}${rows}${landed}`;
  }

  function filesHtml(m: CapcomMission): string {
    const files = reportedFiles(m, projectRoot);
    if (!files.length) {
      return `<p class="mission-win__none px px--tiny">NO FILE PATHS IN THIS MISSION'S REPORTS</p>`;
    }
    const shown = files.slice(0, FILES_SHOWN);
    return `<div class="mission-win__files">${shown.map((f) => `
      <a class="ref ref--file mission-win__file" data-file="${esc(f.path)}"${f.line !== null ? ` data-line="${f.line}"` : ''}${f.agentId ? ` data-file-agent="${esc(f.agentId)}"` : ''}
         title="${esc(f.path)} · OPEN IN ORCA · ⌘CLICK OPENS ANOTHER">
        <span class="mono mission-win__fname">${esc(baseName(f.path))}${f.line !== null ? `:${f.line}` : ''}</span>
        <span class="mono mission-win__fpath">${esc(f.path)}</span>
      </a>`).join('')}</div>
      ${files.length > shown.length ? `<p class="px px--tiny mission-win__none">…AND ${files.length - shown.length} MORE MENTIONED</p>` : ''}`;
  }

  function mediaHtml(m: CapcomMission): string {
    const ids = new Set<string>([...m.agentIds, ...(parte?.agents.map((a) => a.id) ?? [])]);
    const arts = Object.values(store.world.artifacts ?? {})
      .filter((a) => ids.has(a.agentId))
      .sort((a, b) => b.at - a.at);
    if (!arts.length) {
      return `<p class="mission-win__none px px--tiny">NO MEDIA FILED · AN AGENT PUBLISHES ONE WITH ORCA-SHOW, AND THE HUB KEEPS IT FOR A DAY</p>`;
    }
    return `<div class="thumbs thumbs--gal mission-win__media">${arts.map((x) => {
      const url = authedUrl(x.url);
      const who = store.knownAgent(x.agentId)?.callsign ?? '??';
      const media = x.kind === 'image' && url ? `<img src="${esc(url)}" alt="" loading="lazy" draggable="false" />`
        : x.kind === 'video' && url ? `<video src="${esc(url)}" muted playsinline preload="metadata"></video>`
        : `<span class="thumb__k">${esc(x.kind)}</span>`;
      return `<figure class="thumb thumb--gal" data-art="${esc(x.id)}" title="${esc(x.title)} · ${esc(x.path)}">
        ${media}
        <span class="thumb__who px">${esc(who)} · ${ago(x.at)}</span>
        <span class="thumb__t">${esc(x.title)}</span>
      </figure>`;
    }).join('')}</div>`;
  }

  /* ── La línea de salida ───────────────────────────────────────── */

  function outlet(m: CapcomMission): Outlet {
    const finished = m.status === 'completed' || m.status === 'failed';
    return outletFor(leadOf(m), !!capcomOf(store.world.agents), finished);
  }

  /**
   * El pie de la ventana: a quién va la línea, siempre; la caja, sólo en
   * CONVERSATION. En MISSION y CREW el pie es una frase y un botón que lleva
   * a la conversación, para que la ventana no invite a escribir donde no se
   * lee lo que se contesta.
   */
  function renderTalk(m: CapcomMission | undefined) {
    if (!m) { talkEl.innerHTML = ''; return; }
    const out = outlet(m);
    const s = JSON.stringify([tab, out.to, out.label, out.why, out.lead?.agent.id, out.lead?.live, store.linkUp]);
    if (s === talkSig) return;
    talkSig = s;

    const readLead = out.lead && !out.lead.live
      ? `<button class="chip" type="button" data-read="${esc(out.lead.agent.id)}">READ ${esc(out.lead.agent.callsign)}</button>` : '';
    const line = `<div class="mission-win__routes">
        <p class="mission-win__to mono is-${out.to}">${esc(out.label)}</p>
        ${readLead}
        ${tab === 'talk' ? '' : `<button class="chip" type="button" data-write>WRITE</button>`}
      </div>`;

    if (tab !== 'talk') {
      draft?.dispose(); draft = null;
      unbindComposer?.(); unbindComposer = null;
      unbindAttach?.(); unbindAttach = null;
      talkEl.innerHTML = line;
      talkEl.querySelector<HTMLElement>('[data-write]')?.addEventListener('click', () => { setTab('talk'); focusBox(); });
      talkEl.querySelector<HTMLElement>('[data-read]')?.addEventListener('click', (e) => c.openAgent((e.currentTarget as HTMLElement).dataset.read!));
      return;
    }

    talkEl.innerHTML = `
      ${line}
      <p class="mission-win__why px px--tiny">${esc(out.why)}</p>
      <div class="ceo__in">
        <textarea class="input" data-say rows="2" aria-label="${esc(out.label)}"
          placeholder="${esc(composerHint(out.to === 'lead' && out.lead ? `write to ${out.lead.agent.callsign}` : 'write to CAPCOM in this mission'))}"></textarea>
        <button class="slab-btn" type="button" data-send>SEND</button>
      </div>`;

    const say = talkEl.querySelector<HTMLTextAreaElement>('[data-say]')!;
    draft?.dispose();
    draft = drafts.bind(say, draftKey('mission', missionId));
    draft.restore();
    unbindComposer?.();
    unbindComposer = bindComposer(say, () => void send());
    // Un archivo soltado o pegado sube al hub y su ruta entra en el texto (attach.ts).
    unbindAttach?.();
    unbindAttach = bindAttach(say, { key: draftKey('mission', missionId), upload: uploadFile, note: c.note });
    talkEl.querySelector<HTMLElement>('[data-read]')?.addEventListener('click', (e) => c.openAgent((e.currentTarget as HTMLElement).dataset.read!));
    talkEl.querySelector<HTMLElement>('[data-send]')!.addEventListener('click', () => void send());
  }

  function focusBox() {
    talkEl.querySelector<HTMLTextAreaElement>('[data-say]')?.focus();
  }

  /**
   * Mandar. A quién va lo decide el hub con la regla que la ventana acaba de
   * enseñar; si eligiera distinto —el líder murió entre la pintada y el
   * clic—, se dice, porque una línea que fue a otro sitio del prometido es
   * exactamente lo que hay que saber.
   */
  async function send() {
    const say = talkEl.querySelector<HTMLTextAreaElement>('[data-say]');
    const m = mission();
    if (!say || !m || sending) return;
    const text = say.value.trim();
    if (!text) return;
    if (!store.linkUp) { c.note('link down · your message has not been sent', 'warn'); return; }
    const promised = outlet(m);
    const btn = talkEl.querySelector<HTMLElement>('[data-send]')!;
    say.value = '';
    draft?.clear();
    slabFlash(btn);
    const done = slabBusy(btn);
    sending = true;
    // El eco entra en la conversación en cuanto sale; sin esto la caja se
    // vacía y no pasa nada visible hasta que alguien conteste.
    sig = '';
    render();
    try {
      const got = await hub.missionSay(m.id, text);
      if (got.to !== promised.to) {
        c.note(got.to === 'lead'
          ? `it went to ${got.callsign ?? 'the lead'}, not to CAPCOM`
          : `${promised.lead?.agent.callsign ?? 'the lead'} is gone: it went to CAPCOM instead`, 'warn');
      }
    } catch (err) {
      // El eco ya lo dice —NOT SENT, con el motivo— y se queda en el hilo:
      // devolver el texto a la caja lo enseñaría dos veces.
      c.note(`Message not sent: ${(err as Error).message}`, 'warn');
    } finally { sending = false; done(); draft?.save(); sig = ''; render(); }
  }

  /* ── Pestañas ─────────────────────────────────────────────────── */

  function setTab(next: MissionTab) {
    if (!TABS.includes(next)) return;
    tab = next;
    sig = '';
    render();
    scroll.scrollTop = tab === 'talk' ? scroll.scrollHeight : 0;
  }
  tabsEl.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => setTab(b.dataset.tab as MissionTab)));

  function paintTabs() {
    tabsEl.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  /* ── Pintado ──────────────────────────────────────────────────── */

  function render() {
    const m = mission();
    if (!m) {
      ctx.setTitle('MISSION GONE');
      scroll.innerHTML = `<p class="mission-win__none px px--tiny" style="padding:14px 12px">THIS MISSION IS NO LONGER ON THE HUB. IT WAS PURGED, OR THIS CONSOLE HAS NOT SEEN IT YET.</p>`;
      talkEl.innerHTML = '';
      return;
    }
    const live = liveCrew(m, (id) => store.knownAgent(id));
    // La misma lectura que el panel: si la ventana dijera IN PROGRESS sobre una
    // misión que el panel marca NOT MOVING, la que se cree es la que se tiene
    // delante, y es la que menos sabe.
    const phase = missionPhase(m, live, missionStall(m, (id) => store.knownAgent(id), Date.now()));
    const cr = crewOf(m);
    const lead = leadOf(m);
    ctx.setCallsign('MISSION');
    ctx.setTitle(missionHeadline(m));
    ctx.setState(null, phase === 'failed' ? 'var(--red)' : phase === 'completed' ? 'var(--lime)' : 'var(--ink-dim)');
    paintTabs();

    const s = JSON.stringify([
      tab, m.updatedAt, m.status, m.messages.length, [...openReports],
      store.outgoing.filter((x) => x.missionId === m.id).map((x) => [x.id, x.status]),
      parte?.agents.map((a) => [a.id, a.state, a.final, a.linesAdded, a.costUSD]), parteError,
      lead?.agent.id, lead?.live, lead?.agent.callsign,
      // La nómina se mueve con la flota y no con la conversación: sin esto, un
      // agente que pasa a WORKING no repinta su fila hasta que alguien hable.
      cr.regions.map((r) => [r.projectId, r.squads.map((g) => [g.squad, [...(g.lead ? [g.lead] : []), ...g.members].map((x) => [x.id, x.state, x.live, x.final, x.lead])])]),
      Object.values(store.world.artifacts ?? {}).filter((a) => m.agentIds.includes(a.agentId)).map((a) => a.id + (a.url ? '1' : '0')),
    ]);
    if (s !== sig) {
      const wasAtBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
      sig = s;
      const refs = refIndex(store.world.agents);
      headEl.innerHTML = `
        <span class="px px--tiny mission-win__phase is-${phase}">${PHASE_WORD[phase]}</span>
        <span class="px px--tiny">OPENED ${clock(m.createdAt)} · LAST MOVED ${ago(m.updatedAt)} AGO</span>
        ${lead ? `<button class="px px--tiny mission-win__lead ${lead.live ? 'is-live' : ''}" type="button" data-open="${esc(lead.agent.id)}" title="${lead.live ? 'the lead of this mission · open it' : 'led it; its session ended · read it'}">LED BY ${esc(lead.agent.callsign)}</button>` : ''}
        ${cr.total ? `<button class="px px--tiny mission-win__count" type="button" data-crew title="who is on this mission">${cr.live} LIVE · ${cr.total} FLEW</button>` : ''}
        ${squadNames(m, cr).map((sq) => `<span class="px px--tiny mission-win__squad">${esc(sq.toUpperCase())}</span>`).join('')}
        <span class="mission-win__acts">
          <button class="mission-win__act" type="button" data-muster title="Hold this mission's crew up on the field: select them, frame them, focus. Backspace comes back."${cr.onField.length ? '' : ' disabled'}>MUSTER</button>
          <button class="mission-win__act" type="button" data-capcom title="CAPCOM's own session, outside this mission">CAPCOM</button>
          <button class="mission-win__act" type="button" data-archive title="Take it out of the console. Its agents and its conversation are kept. Closing this window does neither.">ARCHIVE</button>
        </span>`;
      scroll.innerHTML = tab === 'talk'
        ? linkPaths(talkHtml(m, refs, outlet(m)), { root: null })
        : tab === 'crew'
        ? crewHtml(cr)
        : `
        <section class="mission-win__sec"><h3 class="px px--tiny">BRIEF</h3>${briefHtml(m, refs)}</section>
        <section class="mission-win__sec"><h3 class="px px--tiny">RESULT</h3>${resultHtml(m, refs, lead)}</section>
        <section class="mission-win__sec"><h3 class="px px--tiny">WHAT CHANGED</h3>${changedHtml()}</section>
        <section class="mission-win__sec"><h3 class="px px--tiny">FILES REPORTED</h3>${filesHtml(m)}</section>
        <section class="mission-win__sec"><h3 class="px px--tiny">MEDIA</h3>${mediaHtml(m)}</section>
        <section class="mission-win__sec"><h3 class="px px--tiny">REPORTS ALONG THE WAY</h3>${reportsHtml(m, refs, lead)}</section>`;
      wire();
      if (tab === 'talk' && wasAtBottom) scroll.scrollTop = scroll.scrollHeight;
    }
    renderTalk(m);
  }

  function wire() {
    headEl.querySelector('[data-capcom]')?.addEventListener('click', () => c.openCeo());
    headEl.querySelector('[data-muster]')?.addEventListener('click', () => muster());
    headEl.querySelector('[data-crew]')?.addEventListener('click', () => setTab('crew'));
    headEl.querySelectorAll<HTMLElement>('[data-open]').forEach((b) => b.addEventListener('click', () => c.openAgent(b.dataset.open!)));
    scroll.querySelectorAll<HTMLElement>('[data-open]').forEach((b) => b.addEventListener('click', () => c.openAgent(b.dataset.open!)));
    scroll.querySelectorAll<HTMLElement>('[data-squad]').forEach((b) => b.addEventListener('click', () => c.openSquad(b.dataset.squad!)));
    scroll.querySelectorAll<HTMLElement>('[data-proj]').forEach((b) => b.addEventListener('click', () => c.openProject(b.dataset.proj!)));
    headEl.querySelector('[data-archive]')?.addEventListener('click', () => void archive());
    scroll.querySelector('[data-retry]')?.addEventListener('click', () => { parteError = null; sig = ''; render(); void ask(); });
    scroll.querySelectorAll<HTMLElement>('[data-rep]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.rep!;
      if (openReports.has(id)) openReports.delete(id); else openReports.add(id);
      sig = '';
      render();
    }));
    scroll.querySelectorAll<HTMLElement>('[data-question]').forEach((b) => b.addEventListener('click', () => {
      c.openInterrupt(b.dataset.question!);
    }));
    scroll.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation(); b.blur(); c.go(b.dataset.go!);
    }));
    scroll.querySelectorAll<HTMLElement>('[data-art]').forEach((fig) => fig.addEventListener('click', (e) => {
      c.openArtifact(fig.dataset.art!, { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY });
    }));
  }

  /**
   * Retirar la misión de la consola. Una viva no se archiva de un clic: sus
   * workers siguen ahí y su hilo es lo que los explica, así que se pregunta.
   * Cerrar la ventana, en cambio, no archiva nada — son dos gestos distintos
   * y sólo uno de ellos toca el hub.
   */
  async function archive() {
    const m = mission();
    if (!m) return;
    if (m.status === 'active' && !confirm(`"${m.title}" sigue activa. Archivarla la retira de la consola; sus agentes y su conversación se conservan.\n\n¿Archivar?`)) return;
    try {
      store.upsertMission(await hub.archiveMission(m.id));
      c.note(`Mission archived: ${m.title}`, 'info');
      ctx.close();
    } catch (err) { c.note(`Could not archive mission: ${String(err)}`, 'warn'); }
  }

  // Esta ventana es «la misión abierta» mientras está delante: el panel del
  // HUD marca su fila y el arco del campo la sigue.
  store.selectMission(missionId);

  const off = store.on((e) => {
    if (e.k === 'missions' || e.k === 'world' || e.k === 'agents' || e.k === 'artifacts'
      || e.k === 'link' || e.k === 'delivery' || e.k === 'escalations') render();
  });
  render();
  void ask();
  // Los «2M» envejecen; un tick lento basta y no mueve nada más.
  const tick = window.setInterval(() => { sig = ''; render(); }, 30_000);

  return {
    setTab,
    /** Volver a preguntar el parte: lo llama quien reabre la ventana. */
    refresh() { void ask(); },
    dispose() {
      off();
      clearInterval(tick);
      unbindComposer?.();
      unbindAttach?.();
      draft?.dispose();
      // Cerrarla no archiva ni termina nada: sólo deja de ser la que está delante.
      if (store.activeMissionId === missionId) store.selectMission(null);
    },
  };
}
