/**
 * Una misión activa que no avanza: `shared/missions.ts:missionStall`.
 *
 * La regla que decide esto tiene tres lectores —las herramientas de CAPCOM, el
 * despertador del hub y el panel de la consola— y por eso vive en un solo
 * sitio y se prueba en uno solo. Lo que se guarda aquí es lo que se rompió el
 * 2026-09-09: dos misiones activas, cada una con su agente en idle, las dos
 * diciendo `owed: nothing` porque la deuda de una misión sólo contaba
 * mensajes, y ninguna de las dos avanzando.
 *
 * Todo con reloj a mano: `T0` y aritmética. Ni un sleep.
 */

import { MissionStore } from '../src/hub/missions.ts';
import {
  MISSION_STALL_GRACE_MS, missionStall,
  type CapcomMission, type MissionCrew, type MissionMessage,
} from '../src/shared/missions.ts';
import type { AgentState } from '../src/shared/types.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, test, type TestModule } from './harness.ts';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const GRACE = MISSION_STALL_GRACE_MS;

function crew(id: string, state: AgentState, updatedAt: number, block: MissionCrew['block'] = null): MissionCrew {
  return { id, callsign: id.toUpperCase(), state, updatedAt, block };
}

function fleet(...members: MissionCrew[]): (id: string) => MissionCrew | undefined {
  const by = new Map(members.map((m) => [m.id, m]));
  return (id) => by.get(id);
}

function msg(role: MissionMessage['role'], text: string, at: number, agentId?: string): MissionMessage {
  return { id: `m_${at}_${role}`, role, text, at, ...(agentId ? { agentId } : {}) };
}

/**
 * Una misión sana de partida: el operador pidió algo y CAPCOM ya contestó.
 *
 * La respuesta de CAPCOM no es decoración. Sin ella la misión debe una
 * respuesta al operador, que es deuda de mensajes y ya tiene su propio aviso;
 * lo que se prueba aquí es justo la misión que NO debe nada y aun así no
 * avanza, que era la que se colaba.
 */
function mission(over: Partial<CapcomMission> = {}): CapcomMission {
  return {
    id: 'mission_1', title: 'CAPCOM icons', status: 'active',
    createdAt: T0, updatedAt: T0, agentIds: ['w1'],
    messages: [msg('human', 'do the icons', T0), msg('capcom', 'on it', T0 + MIN)],
    ...over,
  };
}

function temporary<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'orca-stall-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

export default {
  suite: 'Missions that are not moving',
  tests: [
    /*
     * Caso 1, tal cual pasó: CAPCOM manda el trabajo, la máquina del agente
     * está desconectada y el envío no sale. Antes eso se veía una vez, dentro
     * del turno de CAPCOM, y desaparecía con la primera rotación.
     */
    test('un envío que no llegó a la máquina es un parón con motivo, no un silencio', () => {
      const m = mission({
        agentIds: ['w1'],
        messages: [msg('human', 'do the icons', T0), msg('capcom', 'on it', T0 + MIN)],
        dispatches: { w1: { agentId: 'w1', callsign: 'WO', at: T0 + 2 * MIN, delivered: false, detail: 'máquina no conectada: mac-2' } },
      });
      const at = fleet(crew('w1', 'idle', T0 + MIN));
      const stall = missionStall(m, at, T0 + 3 * MIN);
      return ok('send-failed, con el motivo del hub dentro y sin esperar al respiro',
        stall?.reason === 'send-failed'
        && stall.since === T0 + 2 * MIN
        && stall.agentId === 'w1'
        && stall.detail.includes('máquina no conectada: mac-2'),
        JSON.stringify(stall));
    }),

    /*
     * Y se apaga solo. Nadie borra el aviso: el reenvío sustituye el registro
     * y la condición deja de existir. Esto es lo que evita que un fallo viejo
     * siga gritando después de arreglarlo.
     */
    test('un reenvío que sale, o actividad posterior, apagan el aviso de envío fallido', () => {
      const failed = { agentId: 'w1', callsign: 'WO', at: T0 + 2 * MIN, delivered: false, detail: 'máquina no conectada' };
      const idle = fleet(crew('w1', 'idle', T0 + MIN));
      const resent = missionStall(
        mission({ dispatches: { w1: { agentId: 'w1', callsign: 'WO', at: T0 + 5 * MIN, delivered: true } } }),
        idle, T0 + 6 * MIN,
      );
      const worked = missionStall(mission({ dispatches: { w1: failed } }), fleet(crew('w1', 'working', T0 + 4 * MIN)), T0 + 5 * MIN);
      const said = missionStall(
        mission({ dispatches: { w1: failed }, messages: [msg('human', 'do it', T0), msg('capcom', 'sent', T0 + 4 * MIN)] }),
        idle, T0 + 5 * MIN,
      );
      return ok('reenvío, trabajo del agente o movimiento en la misión lo resuelven',
        resent?.reason !== 'send-failed' && worked === null && said?.reason !== 'send-failed',
        `${resent?.reason ?? 'null'} / ${worked === null ? 'null' : worked} / ${said?.reason ?? 'null'}`);
    }),

    /*
     * Caso 2: el acuse dijo que salió y el agente nunca lo leyó. La señal no es
     * un acuse, es que el agente no ha movido su actividad desde el encargo.
     */
    test('«sent» sin señal de que empezara es no-start, pasado el respiro', () => {
      const m = mission({
        dispatches: { w1: { agentId: 'w1', callsign: 'E4', at: T0 + 5 * MIN, delivered: true } },
      });
      const quiet = fleet(crew('w1', 'idle', T0 + MIN));
      const early = missionStall(m, quiet, T0 + 5 * MIN + GRACE - 1);
      const late = missionStall(m, quiet, T0 + 5 * MIN + GRACE + 1);
      return ok('el respiro evita la carrera; pasado él, el parón dice desde cuándo',
        early === null && late?.reason === 'no-start' && late.since === T0 + 5 * MIN && late.agentId === 'w1',
        `${early === null ? 'null' : 'early!'} / ${JSON.stringify(late)}`);
    }),

    /*
     * Que el agente trabajara después del encargo y se quedara callado sin que
     * llegara nada a la misión es OTRA cosa, y decir «no empezó» sobre eso
     * sería mentir. Se distingue porque la acción es distinta.
     */
    test('trabajó y se calló es no-progress, no no-start', () => {
      const m = mission({ dispatches: { w1: { agentId: 'w1', callsign: 'E4', at: T0 + 5 * MIN, delivered: true } } });
      const stall = missionStall(m, fleet(crew('w1', 'idle', T0 + 8 * MIN)), T0 + 8 * MIN + GRACE + 1);
      return ok('no-progress, fechado en la última señal del agente',
        stall?.reason === 'no-progress' && stall.since === T0 + 8 * MIN, JSON.stringify(stall));
    }),

    /*
     * Una misión activa sin nadie trabajando no desaparece de pendientes —
     * pero sólo cuando CAPCOM no ha dado cuenta de ello. Un agente que muere
     * callado no deja resultado que reportar, así que tampoco deja deuda: ésa
     * es la que no veía nadie.
     */
    test('quedarse sin tripulación sin que CAPCOM lo cuente es no-agent', () => {
      const stall = missionStall(
        mission({ messages: [msg('human', 'go', T0), msg('capcom', 'launched W1', T0 + MIN)] }),
        fleet(crew('w1', 'dead', T0 + 2 * MIN)), T0 + 2 * MIN + GRACE + 1,
      );
      return ok('no-agent, fechado en cuando se quedó sin nadie',
        stall?.reason === 'no-agent' && stall.since === T0 + 2 * MIN && stall.agentId === null,
        JSON.stringify(stall));
    }),

    /*
     * Y su reverso, que el enunciado pide distinguir: un resultado terminado
     * que espera revisión NO es abandono. CAPCOM publicó, y lo que falta es
     * que el operador lo lea — el estado que el panel ya llama WAITING ON YOU.
     */
    test('un resultado publicado esperando al operador no es un parón por mucho que pase', () => {
      const reviewed = missionStall(
        mission({ messages: [msg('human', 'go', T0), msg('agent', 'done', T0 + MIN, 'w1'), msg('capcom', 'aquí está', T0 + 2 * MIN)] }),
        fleet(crew('w1', 'done', T0 + MIN)), T0 + 2 * MIN + 24 * 60 * MIN,
      );
      return ok('espera humana, no abandono', reviewed === null, `${reviewed === null ? 'null' : reviewed.reason}`);
    }),

    /*
     * El falso positivo que encontró CAPCOM al revisar esto, reproducido tal
     * cual: entregó, CAPCOM lo reportó, y la sesión del worker sigue viva y
     * quieta —que es lo NORMAL, porque un CLI que acaba su encargo se queda en
     * `idle` y no en `done`—. Sin el punto 4, media hora después esto decía
     * `no-progress` y «sin que nada llegara a la misión», con el resultado
     * escrito tres líneas más arriba en la propia conversación.
     */
    test('un agente idle que ya entregó y cuyo resultado CAPCOM reportó no está parado', () => {
      const m = mission({
        messages: [
          msg('human', 'haz los iconos', T0),
          msg('capcom', 'assigned to W1', T0 + MIN),
          msg('agent', 'delivered: 12 icons', T0 + 2 * MIN, 'w1'),
          msg('capcom', 'result for review', T0 + 3 * MIN),
        ],
        agentSince: { w1: T0 },
      });
      const stall = missionStall(m, fleet(crew('w1', 'idle', T0 + 2 * MIN)), T0 + 30 * MIN);
      return ok('terminado, no parado', stall === null, stall === null ? '' : JSON.stringify(stall));
    }),

    /*
     * Y no es una amnistía permanente. Lo que resuelve la condición es la
     * entrega posterior a SU encargo, así que un encargo nuevo la deja atrás y
     * la misión vuelve a deber progreso. Si no, un worker que entregó una vez
     * quedaría a salvo de todo lo que se le mandara después.
     */
    test('un encargo nuevo después de la entrega vuelve a abrir la deuda de progreso', () => {
      const m = mission({
        messages: [
          msg('human', 'haz los iconos', T0),
          msg('capcom', 'assigned to W1', T0 + MIN),
          msg('agent', 'delivered: 12 icons', T0 + 2 * MIN, 'w1'),
          msg('capcom', 'result for review; now do the dark variants', T0 + 3 * MIN),
        ],
        agentSince: { w1: T0 },
        dispatches: { w1: { agentId: 'w1', callsign: 'W1', at: T0 + 4 * MIN, delivered: true } },
      });
      const quiet = fleet(crew('w1', 'idle', T0 + 2 * MIN));
      const early = missionStall(m, quiet, T0 + 4 * MIN + GRACE - 1);
      const late = missionStall(m, quiet, T0 + 4 * MIN + GRACE + 1);
      return ok('la entrega vieja no cubre el encargo nuevo',
        early === null && late?.reason === 'no-start' && late.since === T0 + 4 * MIN,
        `${early === null ? 'null' : 'early!'} / ${JSON.stringify(late)}`);
    }),

    /*
     * La otra mitad, y la que no se puede perder: lo que resuelve es la
     * ENTREGA del agente, no una palabra de CAPCOM. Si bastara con que CAPCOM
     * hubiera hablado, un «mandado a WO» sobre un envío que nunca llegó
     * volvería a tapar el caso que trajo todo este trabajo.
     */
    test('un informe de progreso de CAPCOM sin entrega del agente NO silencia el parón', () => {
      const m = mission({
        messages: [
          msg('human', 'haz los iconos', T0),
          msg('capcom', 'assigned to W1', T0 + MIN),
          msg('capcom', 'still on it, will report back', T0 + 5 * MIN),
        ],
        agentSince: { w1: T0 },
        dispatches: { w1: { agentId: 'w1', callsign: 'W1', at: T0 + MIN, delivered: true } },
      });
      const stall = missionStall(m, fleet(crew('w1', 'idle', T0)), T0 + 30 * MIN);
      return ok('hablar no es entregar', stall?.reason === 'no-start' && stall.since === T0 + MIN, JSON.stringify(stall));
    }),

    /*
     * Y por agente, no por misión: el que entregó sale de la cuenta, el que no
     * sigue dentro. Una misión de dos no se salva porque se salve uno.
     */
    test('con dos asignados, el que entregó no tapa al que no', () => {
      const m = mission({
        agentIds: ['w1', 'w2'],
        messages: [
          msg('human', 'haz las dos mitades', T0),
          msg('capcom', 'assigned to W1 and W2', T0 + MIN),
          msg('agent', 'delivered my half', T0 + 2 * MIN, 'w1'),
          msg('capcom', 'half in, waiting on the other', T0 + 3 * MIN),
        ],
        agentSince: { w1: T0, w2: T0 },
      });
      const stall = missionStall(m, fleet(crew('w1', 'idle', T0 + 2 * MIN), crew('w2', 'idle', T0)), T0 + 30 * MIN);
      return ok('el parón apunta al que no entregó, y sólo a él',
        stall?.reason === 'no-start' && stall.agentId === 'w2' && !stall.detail.includes('W1'),
        JSON.stringify(stall));
    }),

    /*
     * Lo que ya se debe por otra vía no se cuenta dos veces. Una pregunta del
     * operador sin contestar y un resultado sin reportar tienen su propio
     * aviso, con su propio reloj, desde antes que esto.
     */
    test('lo que ya sale en pendientes por deuda de mensajes no se avisa además como parón', () => {
      const asked = missionStall(
        mission({ messages: [msg('capcom', 'launched', T0), msg('human', '¿y esto?', T0 + MIN)] }),
        fleet(crew('w1', 'idle', T0)), T0 + MIN + GRACE + 1,
      );
      const reported = missionStall(
        mission({ messages: [msg('capcom', 'launched', T0), msg('agent', 'ya está', T0 + MIN, 'w1')] }),
        fleet(crew('w1', 'done', T0 + MIN)), T0 + MIN + GRACE + 1,
      );
      return ok('deuda de mensajes gana: el parón calla', asked === null && reported === null,
        `${asked === null ? 'null' : asked.reason} / ${reported === null ? 'null' : reported.reason}`);
    }),

    /*
     * Un agente parado en una pregunta o un permiso no es una misión dormida:
     * es espera humana o un bloqueo ya escalado, y los dos tienen canal propio.
     * Un `blocked` de tipo `input` sí es un idle con otro nombre.
     */
    test('espera humana y bloqueo escalado no son parones; un blocked de tipo input sí cuenta como quieto', () => {
      const m = mission({ dispatches: { w1: { agentId: 'w1', callsign: 'E4', at: T0, delivered: true } } });
      const now = T0 + GRACE + MIN;
      const asking = missionStall(m, fleet(crew('w1', 'blocked', T0, { kind: 'question', summary: '¿sigo?', escalationId: 'esc_1', since: T0 })), now);
      const perm = missionStall(m, fleet(crew('w1', 'blocked', T0, { kind: 'permission', summary: 'Bash', since: T0 })), now);
      const prompt = missionStall(m, fleet(crew('w1', 'blocked', T0, { kind: 'input', summary: 'nada pintado', since: T0 })), now);
      return ok('sólo el prompt vacío cuenta',
        asking === null && perm === null && prompt?.reason === 'no-start',
        `${asking === null ? 'null' : asking.reason} / ${perm === null ? 'null' : perm.reason} / ${prompt?.reason}`);
    }),

    /* Trabajando es trabajando, y archivar es la pausa que ya existía. */
    test('un agente en marcha, una misión cerrada y una archivada no son parones', () => {
      const now = T0 + 10 * 60 * MIN;
      const working = missionStall(mission(), fleet(crew('w1', 'working', T0)), now);
      const booting = missionStall(mission(), fleet(crew('w1', 'booting', T0)), now);
      const closed = missionStall(mission({ status: 'completed' }), fleet(crew('w1', 'idle', T0)), now);
      const shelved = missionStall(mission({ archivedAt: T0 + MIN }), fleet(crew('w1', 'idle', T0)), now);
      return ok('cuatro silencios legítimos',
        working === null && booting === null && closed === null && shelved === null,
        `${working} ${booting} ${closed} ${shelved}`);
    }),

    /* Con varios asignados basta uno vivo trabajando para que la misión avance. */
    test('un miembro trabajando salva a la misión aunque el resto estén quietos', () => {
      const m = mission({ agentIds: ['w1', 'w2'] });
      const now = T0 + 10 * 60 * MIN;
      const one = missionStall(m, fleet(crew('w1', 'idle', T0), crew('w2', 'working', now - MIN)), now);
      const none = missionStall(m, fleet(crew('w1', 'idle', T0), crew('w2', 'idle', T0)), now);
      return ok('uno en marcha basta; ninguno en marcha, parón',
        one === null && none?.reason === 'no-start', `${one} / ${none?.reason}`);
    }),

    /*
     * El registro del encargo. Es el hecho que no existía en ninguna parte, y
     * el único que sobrevive a la sesión de CAPCOM que lo provocó.
     */
    test('el encargo se anota por agente: el fallo deja línea en la conversación y el reenvío la sustituye', () =>
      temporary((dir) => {
        const store = new MissionStore(dir);
        store.create('mission_9', 'icons');
        store.assign('mission_9', ['w1']);
        const failed = store.dispatched('mission_9', { agentId: 'w1', callsign: 'WO', at: T0, delivered: false, detail: 'máquina no conectada: mac-2' });
        const line = failed.messages.at(-1);
        const sent = store.dispatched('mission_9', { agentId: 'w1', callsign: 'WO', at: T0 + MIN, delivered: true });
        // Y sobrevive a un hub que reinicia, que es cuando hace falta.
        const reread = new MissionStore(dir).get('mission_9');
        return ok('una línea system por el fallo, un registro por agente, nada nuevo por el envío que sale',
          line?.role === 'system' && line.text.includes('WO') && line.text.includes('mac-2')
          && failed.dispatches?.w1?.delivered === false
          && sent.dispatches?.w1?.delivered === true
          && sent.messages.length === failed.messages.length
          && reread.dispatches?.w1?.at === T0 + MIN,
          `${line?.text} · ${JSON.stringify(reread.dispatches)}`);
      })),
  ],
} satisfies TestModule;
