/**
 * Linaje: quién lanzó a quién.
 *
 * Dos fuentes, ambas verificadas en disco:
 *
 * (a) SUBAGENTES. Cuando un agente llama a la tool `Task`, Claude Code crea
 *     ~/.claude/projects/<slug>/<session>/subagents/agent-<id>.jsonl junto a un
 *     agent-<id>.meta.json con esta forma exacta:
 *         { "agentType":"Explore", "description":"Mapear pipeline…",
 *           "toolUseId":"toolu_017jnN1woM5xNvLfFWXyejp2", "spawnDepth":1 }
 *     El `toolUseId` apunta al bloque tool_use que lo creó, y ese bloque vive en
 *     el transcript del PADRE — que puede ser la sesión raíz o, con spawnDepth
 *     2, otro subagente (los archivos son planos, la profundidad no está en la
 *     ruta). Por eso indexamos tool_use id → agente emisor.
 *
 * (b) SESIONES BACKGROUND LANZADAS POR ORCA. Ahí el padre lo pone la Command, y
 *     lo persistimos en ~/.orca/lineage.json para que sobreviva a un reinicio
 *     del collector.
 *
 * Cuando ninguna fuente atribuye un padre: parentId null y depth 0. Nunca se
 * inventa un padre.
 */

import fs from 'node:fs';
import path from 'node:path';

import { squadName } from '../shared/squads.ts';
import type { AgentRole } from '../shared/types.ts';
import type { Lineage } from './derive.ts';
import type { LineBatch, TranscriptRef } from './watch.ts';
import { errText, guard, isRecord, log, oneLine, orcaDir, safeJson, str } from './util.ts';

const SCOPE = 'lineage';

interface SubagentMeta {
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  spawnDepth: number | null;
}

interface SpawnRecord {
  shortId: string;
  sessionId: string | null;
  parentId: string | null;
  mission: string | null;
  /** Squad the console enlisted it in, if any. Same provenance as `mission`. */
  squad: string | null;
  /** Whether it was spawned as that squad's leader. */
  lead: boolean;
  /**
   * 'capcom' when this spawn was the fleet's command session.
   *
   * Same provenance as `mission` and `squad`, and the same reason for being on
   * disk: nothing in a transcript says "this session commands the fleet", so
   * without this line a collector restart would demote CAPCOM to an ordinary
   * agent and the console would lose its command window.
   */
  role: AgentRole;
  /**
   * El worktree en el que se lanzó y su rama, cuando el collector corre con
   * ORCA_WORKTREES=1. Misma procedencia que `mission`: lo dijo el spawn, y sin
   * apuntarlo aquí un reinicio del collector no sabría qué aterrizar ni qué
   * tirar. Ver worktrees.ts.
   */
  worktree: string | null;
  branch: string | null;
  at: number;
}

/** Lo que el spawn dice del worktree del agente, si lo tiene. */
export interface SpawnWorktree { path: string; branch: string }

/** Lo que el índice necesita saber de cada agente vivo para resolver el árbol. */
export interface LineageInput {
  key: string;
  sessionId: string;
  agentId: string | null;
  metaPath: string | null;
  shortId: string | null;
}

export class LineageIndex {
  /** tool_use id → key del agente que lo emitió. */
  private toolUseOwner = new Map<string, string>();
  /** ruta del meta.json → {mtime, parsed} */
  private metaCache = new Map<string, { mtimeMs: number; meta: SubagentMeta }>();
  private spawns: SpawnRecord[] = [];
  private storePath: string;
  private dirty = false;

  constructor(storePath = path.join(orcaDir(), 'lineage.json')) {
    this.storePath = storePath;
    this.load();
  }

  /* ── (a) subagentes ───────────────────────────────────────────── */

  /** Registra los tool_use `Task` que ve pasar. Barato: sólo mira assistant. */
  ingest(batch: LineBatch): void {
    for (const line of batch.lines) {
      if (line['type'] !== 'assistant') continue;
      const msg = isRecord(line['message']) ? line['message'] : null;
      if (!msg || !Array.isArray(msg['content'])) continue;
      for (const raw of msg['content']) {
        if (!isRecord(raw) || raw['type'] !== 'tool_use') continue;
        const id = str(raw['id']);
        if (!id) continue;
        // Guardamos TODOS los tool_use, no sólo Task: un meta.json puede apuntar
        // a una tool con otro nombre (Agent, Explore) según la versión del CLI.
        this.toolUseOwner.set(id, batch.ref.key);
      }
    }
    // El índice sólo crece; lo acotamos para no filtrar memoria en sesiones
    // de días. 50k entradas ≈ unos pocos MB y cubre semanas de trabajo real.
    if (this.toolUseOwner.size > 50_000) {
      const keep = [...this.toolUseOwner.entries()].slice(-25_000);
      this.toolUseOwner = new Map(keep);
    }
  }

  private readMeta(metaPath: string): SubagentMeta | null {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(metaPath).mtimeMs;
    } catch {
      return null; // todavía no existe, o se borró
    }
    const hit = this.metaCache.get(metaPath);
    if (hit && hit.mtimeMs === mtimeMs) return hit.meta;
    const text = guard(SCOPE, `leer ${path.basename(metaPath)}`,
      () => fs.readFileSync(metaPath, 'utf8'), '');
    const obj = safeJson<Record<string, unknown>>(text);
    if (!obj) return null;
    const meta: SubagentMeta = {
      agentType: str(obj['agentType']),
      description: str(obj['description']),
      toolUseId: str(obj['toolUseId']),
      spawnDepth: typeof obj['spawnDepth'] === 'number' ? obj['spawnDepth'] : null,
    };
    this.metaCache.set(metaPath, { mtimeMs, meta });
    return meta;
  }

  /* ── (b) spawns de ORCA ───────────────────────────────────────── */

  /**
   * Un spawn de ORCA, con todo lo que la Command dijo de él.
   *
   * `squad`, `lead` y `role` viajan por el mismo camino que `mission` y por la
   * misma razón: nada de eso está en el transcript, así que si no lo apuntamos
   * aquí el agente aparece huérfano de contexto al siguiente arranque del
   * collector — y CAPCOM, en concreto, dejaría de ser el mando de la flota.
   */
  noteSpawn(
    shortId: string, parentId: string | null, mission: string | null,
    squad: string | null = null, lead = false, role: AgentRole = 'agent',
    worktree: SpawnWorktree | null = null,
  ): void {
    // Volver a apuntar el mismo spawn (CAPCOM se readopta en cada arranque del
    // collector) no puede perder el sessionId que `bind` ya había resuelto.
    const previous = this.spawns.find((s) => s.shortId === shortId);
    this.spawns = this.spawns.filter((s) => s.shortId !== shortId);
    // Un solo mando. Apuntar un CAPCOM nuevo retira al anterior aunque nadie
    // lo haya pedido: un collector que se reinicia readopta el actual y así
    // limpia un rol viejo que quedó en disco de antes de que esto existiera.
    if (role === 'capcom') {
      for (const s of this.spawns) if (s.role === 'capcom') s.role = 'agent';
    }
    this.spawns.push({
      shortId, sessionId: previous?.sessionId ?? null, parentId, mission: mission ? oneLine(mission, 240) : null,
      squad, lead: squad ? lead : false, role,
      // Readoptar (CAPCOM en cada arranque) sin decir worktree no borra el
      // que ya se sabía: el worktree no cambia de sitio porque el collector
      // se reinicie.
      worktree: worktree?.path ?? previous?.worktree ?? null,
      branch: worktree?.branch ?? previous?.branch ?? null,
      at: Date.now(),
    });
    this.trimSpawns();
    this.dirty = true;
    this.save();
  }

  /**
   * El worktree de una sesión, por cualquiera de sus nombres: el session id
   * que `bind` resolvió, el short id del CLI, o —hospedado— el id que ORCA
   * eligió y que es las dos cosas.
   */
  worktreeOf(sessionId: string, shortId: string | null = null): SpawnWorktree | null {
    const rec = this.spawns.find(
      (s) => s.sessionId === sessionId || s.shortId === sessionId
        || (shortId !== null && s.shortId === shortId),
    );
    return rec?.worktree && rec.branch ? { path: rec.worktree, branch: rec.branch } : null;
  }

  /** Transfer an ORCA root and its children, with a rollback before cutover. */
  replaceSession(fromId: string, toId: string, a: { parentId?: string | null; mission?: string | null; squad?: string | null; lead?: boolean; worktree?: SpawnWorktree | null }): () => void {
    const previous = structuredClone(this.spawns);
    const source = this.spawns.find(s => s.sessionId === fromId || s.shortId === fromId);
    if (source?.role === 'capcom') throw new Error('Use the CAPCOM activation path');
    const persist = () => {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath + '.tmp', JSON.stringify({ spawns: this.spawns }), { mode: 0o600 });
      fs.renameSync(this.storePath + '.tmp', this.storePath);
    };
    this.spawns = this.spawns.filter(s => s.sessionId !== toId && s.shortId !== toId);
    this.spawns.push({ shortId: toId, sessionId: toId, parentId: a.parentId ?? null, mission: a.mission ?? null,
      squad: a.squad ?? null, lead: a.lead ?? false, role: 'agent', worktree: a.worktree?.path ?? null, branch: a.worktree?.branch ?? null, at: Date.now() });
    for (const s of this.spawns) if (s.parentId === fromId) s.parentId = toId;
    if (source) { source.lead = false; source.worktree = null; source.branch = null; }
    try { persist(); } catch (e) { this.spawns = previous; throw e; }
    return () => { this.spawns = previous; persist(); };
  }

  /** El worktree se fue (land + discard, o discard a secas): que el registro no lo siga nombrando. */
  clearWorktree(worktreePath: string): void {
    let changed = false;
    for (const s of this.spawns) {
      if (s.worktree !== worktreePath) continue;
      s.worktree = null; s.branch = null; changed = true;
    }
    if (!changed) return;
    this.dirty = true;
    this.save();
  }

  /** Cuando el CLI nos dice qué sessionId corresponde a un short id. */
  bind(shortId: string, sessionId: string): void {
    const rec = this.spawns.find((s) => s.shortId === shortId);
    if (!rec || rec.sessionId === sessionId) return;
    rec.sessionId = sessionId;
    this.dirty = true;
    this.save();
  }

  /**
   * Esta sesión deja de tener un rol especial: vuelve a ser un agente.
   *
   * Existe por CAPCOM. Cada mensaje que se le manda pasa por `--bg --resume`,
   * que crea una sesión NUEVA con la conversación entera dentro, y la vieja
   * sigue listada un rato. Las dos con `role:'capcom'` —y con el mismo
   * `startedAt`, porque el transcript reanudado arrastra el primero— dejan al
   * hub eligiendo a ciegas, y eligió la vieja: lo que escribía el humano se
   * reanudaba sin herramientas en sesiones huérfanas. Medido en vivo.
   */
  demote(shortId: string): void {
    const rec = this.spawns.find((s) => s.shortId === shortId);
    if (!rec || rec.role === 'agent') return;
    rec.role = 'agent';
    this.dirty = true;
    this.save();
  }

  private trimSpawns(): void {
    const cutoff = Date.now() - 30 * 24 * 3600_000;
    this.spawns = this.spawns.filter((s) => s.at >= cutoff).slice(-2000);
  }

  private load(): void {
    const text = guard(SCOPE, 'leer lineage.json',
      () => fs.existsSync(this.storePath) ? fs.readFileSync(this.storePath, 'utf8') : '', '');
    const obj = safeJson<{ spawns?: unknown }>(text);
    if (!obj || !Array.isArray(obj.spawns)) return;
    for (const raw of obj.spawns) {
      if (!isRecord(raw)) continue;
      const shortId = str(raw['shortId']);
      if (!shortId) continue;
      const squad = squadName(raw['squad']);
      this.spawns.push({
        shortId,
        sessionId: str(raw['sessionId']),
        parentId: str(raw['parentId']),
        mission: str(raw['mission']),
        squad,
        lead: squad !== null && raw['lead'] === true,
        role: raw['role'] === 'capcom' ? 'capcom' : 'agent',
        worktree: str(raw['worktree']),
        branch: str(raw['branch']),
        at: typeof raw['at'] === 'number' ? raw['at'] : Date.now(),
      });
    }
    this.trimSpawns();
  }

  private save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.storePath, JSON.stringify({ spawns: this.spawns }, null, 2), {
        mode: 0o600,
      });
    } catch (err) {
      log('warn', SCOPE, `no pude persistir lineage: ${errText(err)}`);
    }
  }

  /* ── resolución ───────────────────────────────────────────────── */

  /**
   * Devuelve el linaje de cada agente conocido. Los `childIds` se derivan de los
   * padres para que no puedan desincronizarse, y la profundidad se recalcula
   * subiendo el árbol (con corte de ciclos) en vez de confiar ciegamente en
   * spawnDepth, que sólo es un hint del CLI.
   */
  resolve(inputs: LineageInput[]): Map<string, Lineage> {
    const known = new Set(inputs.map((i) => i.key));
    const launched = new Set<string>();
    const parent = new Map<string, string | null>();
    const mission = new Map<string, string | null>();
    const squad = new Map<string, string | null>();
    const lead = new Map<string, boolean>();
    const role = new Map<string, AgentRole>();
    const worktree = new Map<string, SpawnWorktree>();
    const hintDepth = new Map<string, number>();

    for (const inp of inputs) {
      parent.set(inp.key, null);
      mission.set(inp.key, null);
      squad.set(inp.key, null);
      lead.set(inp.key, false);
      role.set(inp.key, 'agent');

      if (inp.metaPath) {
        const meta = this.readMeta(inp.metaPath);
        if (meta) {
          if (meta.description) mission.set(inp.key, oneLine(meta.description, 240));
          if (meta.spawnDepth !== null) hintDepth.set(inp.key, meta.spawnDepth);
          const owner = meta.toolUseId ? this.toolUseOwner.get(meta.toolUseId) : undefined;
          if (owner && owner !== inp.key && known.has(owner)) {
            parent.set(inp.key, owner);
          } else if (known.has(inp.sessionId) && inp.sessionId !== inp.key) {
            // Sin el tool_use indexado (no leímos esa parte del transcript del
            // padre) caemos a la sesión raíz dueña del directorio: siempre es un
            // ancestro real, aunque quizá no el inmediato.
            parent.set(inp.key, inp.sessionId);
          }
        } else if (known.has(inp.sessionId) && inp.sessionId !== inp.key) {
          parent.set(inp.key, inp.sessionId);
        }
        continue;
      }

      // Sesión raíz: sólo puede tener padre si ORCA la lanzó.
      // Tres formas de reconocer un spawn: por el sessionId que `bind`
      // resolvió, por el short id que imprimió `--bg`, o —hospedado, id
      // elegido por ORCA— porque el "short id" ES el session id.
      const spawn = this.spawns.find(
        (s) => s.sessionId === inp.sessionId
          || s.shortId === inp.sessionId
          || (inp.shortId !== null && s.shortId === inp.shortId),
      );
      if (spawn) {
        launched.add(inp.key);
        if (spawn.mission) mission.set(inp.key, spawn.mission);
        // El escuadrón no se hereda ni se adivina: o lo dijo el spawn, o no
        // hay escuadrón. Un subagente `Task` de un miembro trabaja PARA su
        // padre, no para el escuadrón, y meterlo dentro convertiría cualquier
        // fan-out interno en tres miembros más que el líder no pidió.
        if (spawn.squad) {
          squad.set(inp.key, spawn.squad);
          lead.set(inp.key, spawn.lead);
        }
        // El rol no se hereda ni se propaga hacia abajo: un subagente `Task` de
        // CAPCOM trabaja PARA el mando, no ES el mando, y dos sesiones con
        // role:'capcom' sería un hub que no sabe a cuál entregarle lo que
        // escribe el humano.
        if (spawn.role === 'capcom') role.set(inp.key, 'capcom');
        // El worktree tampoco baja a los subagentes: un `Task` corre en el
        // cwd de su padre, y aterrizar es cosa de la sesión que lo pidió.
        if (spawn.worktree && spawn.branch) worktree.set(inp.key, { path: spawn.worktree, branch: spawn.branch });
        if (spawn.parentId && known.has(spawn.parentId) && spawn.parentId !== inp.key) {
          parent.set(inp.key, spawn.parentId);
        }
      }
    }

    // Resolve ancestry after all roots, including children that precede them.
    const owned = (key: string): boolean => {
      const seen = new Set<string>();
      let current: string | null = key;
      while (current && !seen.has(current)) {
        if (launched.has(current)) return true;
        seen.add(current); current = parent.get(current) ?? null;
      }
      return false;
    };
    const out = new Map<string, Lineage>();
    const children = new Map<string, string[]>();
    for (const [key, p] of parent) {
      if (!p) continue;
      const list = children.get(p);
      if (list) list.push(key); else children.set(p, [key]);
    }

    for (const inp of inputs) {
      const key = inp.key;
      out.set(key, {
        origin: owned(key) ? 'orca' : 'external',
        parentId: parent.get(key) ?? null,
        depth: depthOf(key, parent, hintDepth),
        childIds: (children.get(key) ?? []).sort(),
        mission: mission.get(key) ?? null,
        squad: squad.get(key) ?? null,
        lead: lead.get(key) ?? false,
        role: role.get(key) ?? 'agent',
        worktree: worktree.get(key)?.path ?? null,
        branch: worktree.get(key)?.branch ?? null,
      });
    }
    return out;
  }
}

/** Sube por la cadena de padres. Corta ciclos: un log corrupto no cuelga nada. */
function depthOf(
  key: string, parent: Map<string, string | null>, hint: Map<string, number>,
): number {
  let depth = 0;
  let cur: string | null = key;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const p: string | null = parent.get(cur) ?? null;
    if (!p) break;
    depth++;
    cur = p;
    if (depth > 32) break;
  }
  if (depth === 0) return hint.get(key) ?? 0;
  return depth;
}

/** Sólo para el resumen de diagnóstico. */
export function refKey(ref: TranscriptRef): string {
  return ref.key;
}
