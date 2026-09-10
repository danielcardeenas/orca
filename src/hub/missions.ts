import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '../shared/types.ts';
import { newId } from '../shared/protocol.ts';
import { MISSION_ID, type CapcomMission, type MissionDispatch, type MissionMessage, type MissionStatus } from '../shared/missions.ts';

/**
 * Un miembro de squad con su líder vivo: reporta al líder, no a la misión.
 * El propio líder, un agente suelto, o un miembro cuyo líder ya no está, sí
 * le hablan a la misión.
 */
export function underLiveLead(a: Agent, agents: Record<string, Agent>): boolean {
  if (!a.squad || a.lead) return false;
  return Object.values(agents).some((o) => o.id !== a.id && o.squad === a.squad && o.lead && o.role !== 'capcom'
    && o.state !== 'done' && o.state !== 'dead');
}

/** Mission IDs, not the currently open tab, own all messages and agent bindings. */
export class MissionStore {
  private missions: Record<string, CapcomMission> = {};
  private file: string;
  constructor(dir: string, private changed: (mission: CapcomMission) => void = () => {}) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'missions.json');
    // El concepto se llamó «task» hasta el renombrado, y su estado vive en
    // disco. Se lee el archivo viejo cuando el nuevo todavía no existe y se
    // escribe siempre en el nuevo: la primera escritura migra sola y nadie
    // pierde una conversación por un cambio de vocabulario.
    const legacy = path.join(dir, 'tasks.json');
    const from = fs.existsSync(this.file) ? this.file : fs.existsSync(legacy) ? legacy : null;
    if (from) {
      const loaded = JSON.parse(fs.readFileSync(from, 'utf8')) as Record<string, CapcomMission>;
      for (const [id, m] of Object.entries(loaded)) {
        if (!MISSION_ID.test(id) || m.id !== id || !Array.isArray(m.messages) || !Array.isArray(m.agentIds)) throw new Error('Invalid missions.json');
      }
      this.missions = loaded;
    }
  }
  all(): Record<string, CapcomMission> { return structuredClone(this.missions); }
  get(id: string): CapcomMission {
    const mission = this.missions[id];
    if (!mission) throw new Error(`Unknown mission: ${id}`);
    return structuredClone(mission);
  }
  /**
   * Retirar una misión de la vista, sin perder nada.
   *
   * Hasta aquí una misión creada no se podía quitar de ninguna manera: el
   * selector las mostraba todas para siempre, terminadas incluidas, y al
   * llegar a cien el hub dejaba de poder crear misiones. Archivar es la salida
   * barata —conserva la conversación entera y se deshace— y por eso es el
   * gesto normal. `purge` es el que borra, y exige pasar por aquí primero.
   */
  archive(id: string, on = true): CapcomMission {
    const mission = this.get(id);
    if (on === !!mission.archivedAt) return mission;
    if (on) mission.archivedAt = Date.now(); else delete mission.archivedAt;
    return this.save(mission);
  }
  /**
   * Borrar de verdad, y sólo lo que ya estaba archivado.
   *
   * Dos pasos deliberados: archivar es lo reversible y lo que basta para
   * recuperar el sitio, así que lo único que llega aquí es lo que alguien
   * decidió retirar y volvió a decidir borrar.
   */
  purge(id: string): void {
    const mission = this.get(id);
    if (!mission.archivedAt) throw new Error('Archive the mission before purging it');
    const next = { ...this.missions };
    delete next[id];
    this.write(next);
    this.changed({ ...mission, purged: true } as CapcomMission & { purged: true });
  }
  create(id: string, title: string): CapcomMission {
    if (!MISSION_ID.test(id)) throw new Error('Invalid mission id');
    if (this.missions[id]) return this.get(id);
    // Las archivadas siguen en disco pero no ocupan sitio: si contaran, un hub
    // con cien misiones viejas no podría crear ninguna aunque se hubieran
    // retirado todas, que es exactamente el callejón que el archivo resuelve.
    if (Object.values(this.missions).filter((m) => !m.archivedAt).length >= 100) throw new Error('Mission limit reached (100 active); archive some first');
    const now = Date.now();
    return this.save({ id, title: title.trim().slice(0, 100) || 'New mission', status: 'active', createdAt: now, updatedAt: now, agentIds: [], messages: [] });
  }
  /**
   * `to` es el líder al que el operador le escribió, cuando no le escribió a
   * CAPCOM (ver `MissionMessage.to`). Sólo tiene sentido en una línea `human`.
   */
  message(id: string, role: MissionMessage['role'], text: string, status?: MissionStatus, agentId?: string, to?: string): CapcomMission {
    if (!text.trim()) throw new Error('Empty mission message');
    const mission = this.get(id);
    // «New task» es el marcador que ponía el hub antes del renombrado, y sigue
    // guardado en las misiones de entonces. Sin él aquí, una misión vieja sin
    // título propio se queda llamándose «New task» para siempre en cuanto el
    // operador le escribe, que es justo cuando debería tomar su nombre.
    if (role === 'human' && (mission.title === 'New mission' || mission.title === 'New task')) mission.title = text.trim().replace(/\s+/g, ' ').slice(0, 100);
    mission.messages.push({
      id: newId('msg'), role, text: text.slice(0, 8000), at: Date.now(),
      ...(agentId ? { agentId } : {}),
      ...(to && role === 'human' ? { to } : {}),
    });
    mission.messages = mission.messages.slice(-100);
    if (status) mission.status = status;
    return this.save(mission);
  }
  /**
   * Anota el encargo que acaba de salir hacia un agente de la misión, y su
   * resultado real.
   *
   * Un envío fallido deja además una línea `system` en la conversación. Es el
   * mismo gesto que ya hace el hub cuando no consigue entregarle a CAPCOM un
   * mensaje del operador (`Delivery failed: …` en server.ts), y por el mismo
   * motivo: un fallo que sólo existe dentro del turno de quien lo provocó
   * desaparece con la primera rotación, y entonces la misión se queda activa
   * sin que nadie sepa por qué no avanza.
   *
   * Un envío que SALE no escribe línea. El registro basta para saber desde
   * cuándo se espera, y una conversación con un renglón por cada empujón deja
   * de servir para leer de qué iba la misión.
   */
  dispatched(id: string, d: MissionDispatch): CapcomMission {
    const mission = this.get(id);
    mission.dispatches = { ...(mission.dispatches ?? {}), [d.agentId]: d };
    if (!d.delivered) {
      mission.messages.push({
        id: newId('msg'),
        role: 'system',
        text: `Send to ${d.callsign ?? d.agentId} failed: ${(d.detail ?? 'no detail').slice(0, 400)}`,
        at: d.at,
        agentId: d.agentId,
      });
      mission.messages = mission.messages.slice(-100);
    }
    return this.save(mission);
  }
  assign(id: string, agentIds: string[]): CapcomMission {
    const mission = this.get(id);
    for (const other of Object.values(this.missions)) {
      if (other.id !== id && other.status === 'active' && agentIds.some((a) => other.agentIds.includes(a))) throw new Error('Agent is already assigned to another active mission');
    }
    mission.agentSince ??= {};
    for (const agentId of agentIds) mission.agentSince[agentId] ??= Date.now();
    mission.agentIds = [...new Set([...mission.agentIds, ...agentIds])].slice(0, 100);
    return this.save(mission);
  }
  bindSquad(id: string, squad: string): void {
    const mission = this.get(id);
    if (Object.values(this.missions).some((other) => other.id !== id && other.status === 'active' && other.squads?.includes(squad))) throw new Error('Squad is already assigned to another active mission');
    mission.squads = [...new Set([...(mission.squads ?? []), squad])];
    this.save(mission);
  }
  observe(agents: Record<string, Agent>): void {
    for (const initial of Object.values(this.missions)) {
      // Una misión retirada no vuelve sola porque un agente suyo diga algo.
      if (initial.status !== 'active' || initial.archivedAt) continue;
      let mission = this.get(initial.id);
      // Keep both transcript segments bound to the mission, including after restart.
      for (const a of Object.values(agents)) {
        if (a.continuation && mission.agentIds.includes(a.continuation.fromId) && !mission.agentIds.includes(a.id)) mission = this.assign(mission.id, [a.id]);
      }
      // Expand lineage and delayed squad IDs without guessing from whichever
      // CAPCOM turn happens to be visible now.
      const ids = new Set(mission.agentIds);
      for (let pass = 0; pass < 8; pass++) {
        const before = ids.size;
        for (const a of Object.values(agents)) {
          if (a.startedAt >= mission.createdAt && ((a.squad && mission.squads?.includes(a.squad)) || (a.parentId && ids.has(a.parentId)))) ids.add(a.id);
        }
        if (ids.size === before) break;
      }
      if (ids.size !== mission.agentIds.length) mission = this.assign(mission.id, [...ids]);
      for (const id of mission.agentIds) {
        const a = agents[id];
        if (!a || !['idle', 'done', 'dead'].includes(a.state) || !a.lastSay) continue;
        // La palabra de un miembro de squad va a su líder, no a la misión: el
        // líder la lee, la consolida y es SU resultado el que entra aquí. Sin
        // esto, cada miembro que paraba a respirar metía una línea en la
        // misión y cada línea despertaba a CAPCOM para publicarla, que es
        // exactamente el ruido que un líder existe para absorber. Sólo cuenta
        // mientras el líder está en pie; muerto el líder, el miembro vuelve a
        // hablarle a la misión, que es lo único que queda.
        if (underLiveLead(a, agents)) continue;
        const since = a.startedAt >= mission.createdAt ? mission.createdAt : mission.agentSince?.[id] ?? mission.createdAt;
        if (a.updatedAt < since) continue;
        const last = [...mission.messages].reverse().find((m) => m.agentId === id);
        if (last?.text === a.lastSay.slice(0, 8000)) continue;
        mission = this.message(mission.id, 'agent', a.lastSay, undefined, id);
      }
    }
  }
  private save(mission: CapcomMission): CapcomMission {
    mission.updatedAt = Date.now();
    this.write({ ...this.missions, [mission.id]: mission });
    this.changed(structuredClone(mission));
    return structuredClone(mission);
  }
  private write(next: Record<string, CapcomMission>): void {
    const json = JSON.stringify(next);
    if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new Error('Mission history storage limit reached');
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, json, { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.missions = next;
  }
}
