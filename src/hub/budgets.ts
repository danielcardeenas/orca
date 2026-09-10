/**
 * Budgets — how much a worker, a squad or a mission may consume before the hub
 * says something, and when it stops them.
 *
 * ## La unidad
 *
 * El techo por defecto se mide en TOKENS, no en dólares. Quien opera ORCA lo
 * hace con suscripciones de Claude Code y de Codex: los dólares que un CLI
 * escribe en su transcript no salen de su bolsillo, y un aviso en dinero le
 * pide que reaccione a un número que no paga. Lo que sí se agota es cuota, y
 * la cuota se mide en tokens.
 *
 * Tokens de ENTRADA + SALIDA + LECTURA DE CACHÉ. No sólo los de salida: un
 * agente que lanza veinte subagentes escribe poco y lee muchísimo, que es
 * exactamente la forma del incidente que este archivo existe para frenar. Los
 * de razonamiento no se suman porque ya vienen dentro de los de salida
 * (`output_tokens_details.thinking_tokens`) y contarlos sería contarlos dos
 * veces. Y son MEDIDOS: salen del transcript, no de una tarifa inventada, así
 * que la cifra no puede quedarse corta como se quedaba la estimación en
 * dólares.
 *
 * El dinero sigue en el modelo de datos, apagado: `ORCA_BUDGET_MONEY=1` lo
 * enciende para un proyecto que sí consuma API de pago. Apagado, un techo en
 * dólares se guarda y no se evalúa.
 *
 * ## El tiempo
 *
 * `budget_min` mide minutos ACTIVOS, no minutos desde el lanzamiento. Un
 * agente ocho horas en idle no consume nada, y avisar de él es ruido; el libro
 * acumula tiempo sólo mientras le ve en `booting`, `thinking` o `working`, en
 * su propia pasada. Por eso funciona igual con Claude, con Codex o con
 * cualquier otro CLI: no depende de que el runtime escriba una duración.
 *
 * Un reloj de pared producía esto, en vivo, sobre agentes ya detenidos:
 *
 *   [BUDGET 100%] CG · $3.88 of $12.00 (32%) · 478m of 60m (796%) · 796% used
 *   · still making progress (CG 0s ago); not stopped.
 *
 * El 32 % era el consumo de verdad; el 796 % era el reloj de un muerto. Y el
 * "0s ago" era el libro sembrando su marca de progreso en `now` la primera vez
 * que veía a un agente — un hub reiniciado daba por fresca a toda la flota.
 * Las marcas se siembran ahora en la última actividad real (`updatedAt`), que
 * para un agente muerto es vieja, que es la verdad.
 *
 * ## Quien ya fue detenido no vuelve a avisar
 *
 * Un ámbito sin nadie vivo no emite nada, y `retire()` saca a un agente del
 * ciclo en el momento en que se despacha su parada, sin esperar a que el
 * estado llegue por el collector. Trece avisos seguidos sobre dos escuadrones
 * que el operador había parado hacía horas no son trece sucesos: son un
 * defecto.
 *
 * ## La descendencia
 *
 * Un subagente `Task` no tiene presupuesto propio: lo que gasta se carga a su
 * ancestro EN TIEMPO REAL, en la misma pasada, sumando su subárbol vivo. Ésa
 * es la razón de que un lead pudiera llegar al 618 % antes del primer aviso.
 * Un agente que ORCA lanzó como sesión completa sí es sujeto de presupuesto
 * propio, y no se carga a quien lo lanzó: para eso está el techo de escuadrón.
 *
 * Además hay un freno: número máximo de descendientes `Task` vivos y
 * profundidad máxima de anidamiento. Al alcanzarlo se dice, con el nombre del
 * ancestro y qué hacer, en vez de dejar que la flota se multiplique callada.
 *
 * ## La política
 *
 * Al 80 % de cualquier techo CAPCOM recibe un aviso. Al 100 % el libro busca
 * progreso — llamadas de herramienta o líneas cambiadas en los últimos
 * minutos — y a quien sigue moviéndose se le reporta, no se le para: un
 * presupuesto es una correa, no una guillotina. Al que se pasó y se calló se
 * le para, salvo con `ORCA_BUDGET_ACTION=warn`.
 *
 * Nada de esto se dispara por reloj sobre un ámbito parado: un aviso exige que
 * alguien vivo esté consumiendo, o que la medida haya subido desde la pasada
 * anterior.
 *
 * Environment:
 *   ORCA_BUDGET_MONEY          1 = el eje en dólares cuenta (por defecto no).
 *   ORCA_DEFAULT_BUDGET_TOKENS techo en tokens para todo worker sin techo propio. Vacío = ninguno.
 *   ORCA_DEFAULT_BUDGET_USD    igual, en dólares. Sólo con ORCA_BUDGET_MONEY=1.
 *   ORCA_DEFAULT_BUDGET_MIN    igual, en minutos ACTIVOS.
 *   ORCA_BUDGET_ACTION         warn | stop (por defecto stop) — qué hace el 100 % sin progreso.
 *   ORCA_BUDGET_PROGRESS_MIN   minutos de silencio antes de "sin progreso" (por defecto 3).
 *   ORCA_BUDGET_USD_PER_MTOK   $/millón de tokens para estimar mientras el CLI no ha escrito coste (por defecto 6).
 *   ORCA_MAX_DESCENDANTS       subagentes Task vivos bajo un agente antes de avisar (por defecto 8).
 *   ORCA_MAX_AGENT_DEPTH       generaciones de subagentes Task permitidas (por defecto 2).
 *   ORCA_SWARM_ACTION          warn | stop (por defecto warn) — qué hace alcanzar el freno.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Agent } from '../shared/types.ts';
import { TERMINAL_STATES } from '../shared/types.ts';
import type { CapcomMission } from '../shared/missions.ts';
import { adviceFor, CONSUMING_STATES, isLiveAgent, type LivenessView } from './liveness.ts';

/* ── Model ────────────────────────────────────────────────────────── */

/** A ceiling: null means "no limit on this axis". */
export interface BudgetLimit {
  /** Tokens in + out + cache read. The default unit. */
  tokens: number | null;
  /** Dollars. Inert unless ORCA_BUDGET_MONEY=1. */
  usd: number | null;
  /** Minutes the agent was seen working. */
  min: number | null;
}

export type BudgetScopeKind = 'agent' | 'squad' | 'mission';

/** Where a limit hangs. `ref` is the agent id, the squad label or the mission id. */
export interface BudgetScope {
  kind: BudgetScopeKind;
  ref: string;
}

export function scopeKey(s: BudgetScope): string { return `${s.kind}:${s.ref}`; }

export type BudgetAction = 'warn' | 'stop';

export interface BudgetConfig {
  /** True when the dollar axis is evaluated at all. */
  money: boolean;
  defaultTokens: number | null;
  defaultUsd: number | null;
  defaultMin: number | null;
  action: BudgetAction;
  /** How long an agent may go without a tool call or an edit before it counts as stalled. */
  progressMs: number;
  /** Flat $/1M tokens for the estimate while `costUSD` is still 0. */
  usdPerMTok: number;
  /** Live `Task` descendants allowed under one agent. */
  maxDescendants: number;
  /** Generations of `Task` subagents allowed below one session. */
  maxDepth: number;
  /** What reaching either brake does. */
  swarmAction: BudgetAction;
}

export const WARN_AT = 0.8;
export const DEFAULT_PROGRESS_MIN = 3;
export const DEFAULT_USD_PER_MTOK = 6;
export const DEFAULT_MAX_DESCENDANTS = 8;
export const DEFAULT_MAX_DEPTH = 2;

/**
 * Una lectura de caché no cuesta lo que una de entrada; para la ESTIMACIÓN en
 * dólares se pondera a la décima parte, que es la proporción que cobran los
 * proveedores. El eje en tokens no pondera nada: ahí la pregunta es cuánta
 * cuota se ha movido, y un token leído de caché se movió igual.
 */
const CACHE_USD_WEIGHT = 0.1;

/** Un hueco mayor que esto entre dos pasadas no fue trabajo: fue el hub sin mirar. */
const ACTIVE_SAMPLE_CAP_MS = 60_000;

function envNumber(v: string | undefined, fallback: number | null): number | null {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFlag(v: string | undefined): boolean {
  const s = v?.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** The book's configuration, read from the environment once at startup. */
export function budgetConfig(env: NodeJS.ProcessEnv = process.env): BudgetConfig {
  const action = env['ORCA_BUDGET_ACTION']?.trim().toLowerCase();
  const swarm = env['ORCA_SWARM_ACTION']?.trim().toLowerCase();
  return {
    money: envFlag(env['ORCA_BUDGET_MONEY']),
    defaultTokens: envNumber(env['ORCA_DEFAULT_BUDGET_TOKENS'], null),
    defaultUsd: envNumber(env['ORCA_DEFAULT_BUDGET_USD'], null),
    defaultMin: envNumber(env['ORCA_DEFAULT_BUDGET_MIN'], null),
    action: action === 'warn' ? 'warn' : 'stop',
    progressMs: (envNumber(env['ORCA_BUDGET_PROGRESS_MIN'], DEFAULT_PROGRESS_MIN) ?? DEFAULT_PROGRESS_MIN) * 60_000,
    usdPerMTok: envNumber(env['ORCA_BUDGET_USD_PER_MTOK'], DEFAULT_USD_PER_MTOK) ?? DEFAULT_USD_PER_MTOK,
    maxDescendants: envNumber(env['ORCA_MAX_DESCENDANTS'], DEFAULT_MAX_DESCENDANTS) ?? DEFAULT_MAX_DESCENDANTS,
    maxDepth: envNumber(env['ORCA_MAX_AGENT_DEPTH'], DEFAULT_MAX_DEPTH) ?? DEFAULT_MAX_DEPTH,
    swarmAction: swarm === 'stop' ? 'stop' : 'warn',
  };
}

/** A limit as a tool hands it in: numbers, nulls, or nothing. */
export function budgetLimit(tokens: unknown, usd: unknown, min: unknown): BudgetLimit | { error: string } {
  const one = (v: unknown, name: string): number | null | { error: string } => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) return { error: `${name} must be a positive number, or null for no limit` };
    return n;
  };
  const t = one(tokens, 'budget_tokens');
  if (typeof t === 'object' && t !== null) return t;
  const u = one(usd, 'budget_usd');
  if (typeof u === 'object' && u !== null) return u;
  const m = one(min, 'budget_min');
  if (typeof m === 'object' && m !== null) return m;
  return { tokens: t, usd: u, min: m };
}

export function hasLimit(l: BudgetLimit | null | undefined): l is BudgetLimit {
  return !!l && (l.tokens !== null || l.usd !== null || l.min !== null);
}

/** A limit as it is normalised off disk or off a tool: every axis present. */
function normalizeLimit(l: Partial<BudgetLimit> | null | undefined): BudgetLimit {
  return { tokens: l?.tokens ?? null, usd: l?.usd ?? null, min: l?.min ?? null };
}

/* ── What the book reports ────────────────────────────────────────── */

/** The consumption of a set of agents, in every unit the book knows. */
export interface Consumption {
  /** Input + output + cache-read tokens. Measured, never estimated. */
  tokens: number;
  spent_usd: number;
  /**
   * True when part of `spent_usd` came from the token estimate rather than a
   * cost the CLI wrote. The figure is then a FLOOR: the truth is that or more.
   */
  estimated: boolean;
  /** Minutes the book actually saw these agents working. */
  active_min: number;
  /** Live `Task` subagents whose consumption is folded in. */
  descendants: number;
}

/** One ceiling that applies to an agent, with the consumption measured against it. */
export interface BudgetLine {
  /** `default` is the environment's ceiling standing in for a missing agent one. */
  scope: BudgetScopeKind | 'default';
  ref: string | null;
  limit_tokens: number | null;
  limit_usd: number | null;
  limit_min: number | null;
  /** Consumption of the whole scope: the agent and its brood, or the squad / mission together. */
  tokens: number;
  spent_usd: number;
  estimated: boolean;
  active_min: number;
  descendants: number;
  /** Worst of the axes in play, 0..∞ (1 = at the ceiling). */
  pct: number;
}

export type BudgetLevel = 'ok' | 'warn' | 'over';

/** An agent's budget picture, as inspect_agent and the console show it. */
export interface AgentBudget extends Consumption {
  lines: BudgetLine[];
  /** Worst `pct` across lines. */
  pct: number;
  level: BudgetLevel;
  /** When the book last saw a tool call or an edit from it. */
  last_progress_at: number | null;
  /** The brake: live brood and how deep it nests. */
  brood: BroodStatus;
  /**
   * True when el libro no le cuenta como vivo: terminó, alguien lo paró, o su
   * máquina no está conectada. Mientras siga así no genera un solo aviso.
   */
  retired: boolean;
}

export interface ScopeBudget extends Consumption {
  scope: BudgetScope;
  limit: BudgetLimit;
  pct: number;
  level: BudgetLevel;
  /** The agents that ARE the scope. Their brood is charged to them, not listed here. */
  agent_ids: string[];
}

/** What lives below one session through the native `Task` tool. */
export interface BroodStatus {
  /** Live `Task` descendants, whole subtree. */
  live: number;
  /** Every `Task` descendant ever seen under it, live or finished. */
  total: number;
  /** Deepest live generation: 1 = children, 2 = grandchildren. */
  depth: number;
  over_count: boolean;
  over_depth: boolean;
}

const NO_BROOD: BroodStatus = { live: 0, total: 0, depth: 0, over_count: false, over_depth: false };

/** What the sweep hands the server. */
export type BudgetEvent =
  /** A scope crossed 80 %. */
  | { kind: 'warn'; scope: BudgetScope; text: string; agentIds: string[]; pct: number; label: string }
  /** A scope crossed 100 %; says which agents are still moving and which are not. */
  | { kind: 'over'; scope: BudgetScope; text: string; agentIds: string[]; pct: number; label: string }
  /** Stop this agent: over budget and no progress. The server dispatches it. */
  | { kind: 'stop'; scope: BudgetScope; agentId: string; reason: string; text: string; pct: number; label: string }
  /**
   * An agent's `Task` brood hit the cap. `stopIds` is what the server should
   * stop — the ancestor, and only when ORCA_SWARM_ACTION=stop, because a
   * native subagent has no session the hub can end.
   */
  | { kind: 'swarm'; agentId: string; brood: BroodStatus; text: string; stopIds: string[] };

/* ── The book ─────────────────────────────────────────────────────── */

interface Persisted {
  limits: Record<string, Partial<BudgetLimit>>;
  /** Budgets handed in for an agent the ack only named by short id. */
  pendingByShortId: Record<string, Partial<BudgetLimit>>;
  /** Notices already sent, so a restart does not repeat them. */
  fired: Record<string, { warn?: number; over?: number }>;
  /** Minutes seen working, per agent, so a hub restart does not reset the clock. */
  activeMs: Record<string, number>;
  /** Agents taken out of the cycle by a stop. They never warn again. */
  retired: string[];
}

interface ProgressMark { toolCalls: number; lines: number; at: number }

export interface BudgetBookOptions {
  now?: () => number;
  /**
   * De dónde sale la respuesta a "¿sigue existiendo?". El hub la ata al estado
   * de sus máquinas; una prueba con la flota en un objeto puede no darla, y
   * entonces vale el criterio mínimo: terminado o retirado.
   */
  liveness?: () => Omit<LivenessView, 'retired'>;
}

export class BudgetBook {
  readonly cfg: BudgetConfig;
  private limits = new Map<string, BudgetLimit>();
  private pendingByShortId = new Map<string, BudgetLimit>();
  private fired = new Map<string, { warn?: number; over?: number }>();
  /** Agents the book already asked the hub to stop. */
  private stopRequested = new Map<string, number>();
  private marks = new Map<string, ProgressMark>();
  /** Ms each agent was seen in a consuming state, and when it was last sampled. */
  private active = new Map<string, { ms: number; at: number }>();
  /** What each scope measured on the previous sweep, to tell growth from a clock. */
  private seen = new Map<string, { tokens: number; usd: number; min: number }>();
  /** Agents whose brood is already over the cap, so the notice is said once. */
  private swarmFired = new Set<string>();
  /**
   * Agents out of the cycle for good: someone stopped them. Persisted, because
   * a hub restart must not resurrect a dead agent's budget.
   */
  private retiredIds = new Set<string>();
  private file: string | null;
  private now: () => number;
  private livenessView: (() => Omit<LivenessView, 'retired'>) | null;

  constructor(dir: string | null, cfg: BudgetConfig = budgetConfig(), opts: BudgetBookOptions = {}) {
    this.cfg = cfg;
    this.now = opts.now ?? Date.now;
    this.livenessView = opts.liveness ?? null;
    this.file = dir ? path.join(dir, 'budgets.json') : null;
    if (this.file && fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Persisted>;
        for (const [k, v] of Object.entries(raw.limits ?? {})) {
          const l = normalizeLimit(v);
          if (hasLimit(l)) this.limits.set(k, l);
        }
        for (const [k, v] of Object.entries(raw.pendingByShortId ?? {})) {
          const l = normalizeLimit(v);
          if (hasLimit(l)) this.pendingByShortId.set(k, l);
        }
        for (const [k, v] of Object.entries(raw.fired ?? {})) this.fired.set(k, v);
        for (const [k, v] of Object.entries(raw.activeMs ?? {})) {
          if (Number.isFinite(v) && v > 0) this.active.set(k, { ms: v, at: this.now() });
        }
        for (const id of raw.retired ?? []) if (typeof id === 'string') this.retiredIds.add(id);
      } catch {
        // Un libro ilegible no tumba el hub: se parte de cero y se sobreescribe
        // en la primera anotación.
      }
    }
  }

  /* ── limits ───────────────────────────────────────────────────── */

  set(scope: BudgetScope, limit: BudgetLimit): void {
    const key = scopeKey(scope);
    if (!hasLimit(limit)) { this.clear(scope); return; }
    this.limits.set(key, normalizeLimit(limit));
    // Un techo nuevo vuelve a armar los avisos: subirlo es justo lo que CAPCOM
    // hace para dejar seguir a un agente, y merece oír de nuevo al 80 %.
    this.fired.delete(key);
    this.save();
  }

  clear(scope: BudgetScope): void {
    const key = scopeKey(scope);
    this.limits.delete(key);
    this.fired.delete(key);
    this.save();
  }

  get(scope: BudgetScope): BudgetLimit | null {
    return this.limits.get(scopeKey(scope)) ?? null;
  }

  /** Every limit on the book, for the console and for `list_fleet`. */
  all(): { scope: BudgetScope; limit: BudgetLimit }[] {
    return [...this.limits.entries()].map(([k, limit]) => {
      const i = k.indexOf(':');
      return { scope: { kind: k.slice(0, i) as BudgetScopeKind, ref: k.slice(i + 1) }, limit };
    });
  }

  /**
   * Sacar agentes del ciclo de presupuesto para siempre.
   *
   * Lo llama el hub en cuanto DESPACHA una parada — `stop_agent`, `stop_squad`
   * o la suya propia —, sin esperar a que el estado `dead` llegue por el
   * collector, que puede tardar o no llegar nunca si la sesión de tmux se fue
   * antes. Un agente retirado no cuenta como vivo, no dispara avisos y no se
   * le vuelve a pedir la parada. Su consumo sigue sumando allí donde ya sumaba:
   * lo que gastó, gastado está.
   */
  retire(agentIds: string | string[]): void {
    const ids = Array.isArray(agentIds) ? agentIds : [agentIds];
    let changed = false;
    for (const id of ids) if (id && !this.retiredIds.has(id)) { this.retiredIds.add(id); changed = true; }
    if (changed) this.save();
  }

  /** True when a stop already took this agent out of the cycle. */
  retired(agentId: string): boolean { return this.retiredIds.has(agentId); }

  /**
   * A budget for an agent the spawn ack could only name by short id. It is
   * moved onto the agent the first sweep that sees a session with that id.
   */
  setPendingByShortId(shortId: string, limit: BudgetLimit): void {
    if (!hasLimit(limit)) return;
    this.pendingByShortId.set(shortId, normalizeLimit(limit));
    this.save();
  }

  /* ── measurement ──────────────────────────────────────────────── */

  /**
   * The ceiling as it is actually evaluated: with the money off, a dollar
   * ceiling is remembered and ignored.
   */
  private effective(limit: BudgetLimit): BudgetLimit {
    return this.cfg.money ? limit : { tokens: limit.tokens, usd: null, min: limit.min };
  }

  /** Tokens this agent has pushed through a model: in + out + cache read. */
  tokensOf(a: Agent): number {
    const m = a.metrics;
    return (m.inputTokens ?? 0) + (m.outputTokens ?? 0) + (m.cacheReadTokens ?? 0);
  }

  /** Dollars this agent has spent, estimated from tokens when the CLI has not said. */
  spend(a: Agent): { usd: number; estimated: boolean } {
    const m = a.metrics;
    if (m.costUSD > 0) return { usd: m.costUSD, estimated: false };
    const weighted = (m.inputTokens ?? 0) + (m.outputTokens ?? 0) + (m.cacheReadTokens ?? 0) * CACHE_USD_WEIGHT;
    if (weighted <= 0) return { usd: 0, estimated: false };
    return { usd: (weighted / 1_000_000) * this.cfg.usdPerMTok, estimated: true };
  }

  /**
   * Minutes the book has SEEN this agent working. Zero for one that has been
   * idle since it started: the ceiling is on consumption, and idling consumes
   * nothing.
   */
  activeMs(agentId: string): number {
    return this.active.get(agentId)?.ms ?? 0;
  }

  /**
   * El subárbol de subagentes `Task` bajo una sesión. No incluye a los agentes
   * que ORCA lanzó como sesiones propias: ésos tienen presupuesto suyo y su
   * gasto no se carga a quien los lanzó.
   */
  private broodOf(id: string, agents: Record<string, Agent>): { agent: Agent; gen: number }[] {
    const byParent = new Map<string, Agent[]>();
    for (const a of Object.values(agents)) {
      if (!a.subagent || !a.parentId) continue;
      const list = byParent.get(a.parentId);
      if (list) list.push(a); else byParent.set(a.parentId, [a]);
    }
    const out: { agent: Agent; gen: number }[] = [];
    const seen = new Set<string>([id]);
    let frontier = [id];
    for (let gen = 1; gen <= 64 && frontier.length; gen++) {
      const next: string[] = [];
      for (const parent of frontier) {
        for (const child of byParent.get(parent) ?? []) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          out.push({ agent: child, gen });
          next.push(child.id);
        }
      }
      frontier = next;
    }
    return out;
  }

  /** The brake's reading for one session. */
  broodStatus(a: Agent, agents: Record<string, Agent>, now = this.now()): BroodStatus {
    if (a.subagent) return NO_BROOD;
    const brood = this.broodOf(a.id, agents);
    if (brood.length === 0) return NO_BROOD;
    // El contador muere con la sesión. Un subagente `Task` no tiene vida
    // propia: existe dentro del turno de su padre, así que si el padre se paró
    // la cría entera se fue con él, diga lo que diga su último estado conocido.
    const live = this.alive(a, now) ? brood.filter((b) => this.alive(b.agent, now)) : [];
    const depth = live.reduce((d, b) => Math.max(d, b.gen), 0);
    return {
      live: live.length, total: brood.length, depth,
      over_count: live.length > this.cfg.maxDescendants,
      over_depth: depth > this.cfg.maxDepth,
    };
  }

  /**
   * Todo lo que se cobra a un conjunto de sujetos: ellos y su descendencia
   * `Task`. Un Set, porque en un escuadrón el subárbol del líder puede tocar a
   * los miembros y nadie debe contarse dos veces.
   */
  private charged(subjects: Agent[], agents: Record<string, Agent>, now = this.now()): { all: Agent[]; descendants: number } {
    const byId = new Map<string, Agent>();
    for (const s of subjects) byId.set(s.id, s);
    let descendants = 0;
    for (const s of subjects) {
      const parentAlive = this.alive(s, now);
      for (const b of this.broodOf(s.id, agents)) {
        if (byId.has(b.agent.id)) continue;
        byId.set(b.agent.id, b.agent);
        // Lo que gastó sigue contando —gastado está—, pero sólo se cuenta como
        // VIVA la cría de un padre que también lo está.
        if (parentAlive && this.alive(b.agent, now)) descendants++;
      }
    }
    return { all: [...byId.values()], descendants };
  }

  private measure(subjects: Agent[], agents: Record<string, Agent>, now = this.now()): Consumption {
    const { all, descendants } = this.charged(subjects, agents, now);
    let tokens = 0, spent = 0, estimated = false, activeMs = 0;
    for (const a of all) {
      tokens += this.tokensOf(a);
      const s = this.spend(a);
      spent += s.usd;
      estimated ||= s.estimated;
      activeMs += this.activeMs(a.id);
    }
    return { tokens, spent_usd: spent, estimated, active_min: activeMs / 60_000, descendants };
  }

  private pct(limit: BudgetLimit, c: Consumption): number {
    const l = this.effective(limit);
    let p = 0;
    if (l.tokens !== null) p = Math.max(p, c.tokens / l.tokens);
    if (l.usd !== null) p = Math.max(p, c.spent_usd / l.usd);
    if (l.min !== null) p = Math.max(p, c.active_min / l.min);
    return p;
  }

  private level(pct: number): BudgetLevel {
    return pct >= 1 ? 'over' : pct >= WARN_AT ? 'warn' : 'ok';
  }

  /** The agents a scope IS. Their brood is charged to them by `measure`. */
  private members(scope: BudgetScope, agents: Record<string, Agent>, missions: Record<string, CapcomMission>): Agent[] {
    switch (scope.kind) {
      case 'agent': return this.continuationFamily(scope.ref, agents);
      case 'squad': return Object.values(agents).filter((a) => a.squad === scope.ref && !a.subagent);
      case 'mission': return (missions[scope.ref]?.agentIds ?? []).map((id) => agents[id]).filter((a): a is Agent => !!a);
    }
  }

  private continuationFamily(id: string, agents: Record<string, Agent>): Agent[] {
    const ids = new Set([id]);
    for (let pass = 0; pass < 100; pass++) {
      const size = ids.size;
      for (const a of Object.values(agents)) if (a.continuation && (ids.has(a.id) || ids.has(a.continuation.fromId))) { ids.add(a.id); ids.add(a.continuation.fromId); }
      if (ids.size === size) break;
    }
    return [...ids].map(id => agents[id]).filter((a): a is Agent => !!a);
  }

  /** The scopes whose ceilings apply to this agent, closest first. */
  private scopesOf(a: Agent, missions: Record<string, CapcomMission>, agents: Record<string, Agent>): BudgetScope[] {
    const out: BudgetScope[] = this.continuationFamily(a.id, agents).map(a => ({ kind: 'agent', ref: a.id }));
    if (a.squad) out.push({ kind: 'squad', ref: a.squad });
    for (const m of Object.values(missions)) {
      if (m.status === 'active' && m.agentIds.includes(a.id)) out.push({ kind: 'mission', ref: m.id });
    }
    return out;
  }

  private defaultLimit(): BudgetLimit | null {
    const l = { tokens: this.cfg.defaultTokens, usd: this.cfg.defaultUsd, min: this.cfg.defaultMin };
    return hasLimit(this.effective(l)) ? l : null;
  }

  scopeStatus(scope: BudgetScope, agents: Record<string, Agent>, missions: Record<string, CapcomMission>, now = this.now()): ScopeBudget | null {
    const limit = this.get(scope);
    if (!limit) return null;
    const members = this.members(scope, agents, missions);
    const m = this.measure(members, agents, now);
    const pct = this.pct(limit, m);
    return { scope, limit, ...m, pct, level: this.level(pct), agent_ids: members.map((a) => a.id) };
  }

  /** The whole picture for one agent: every ceiling that reaches it, and the worst. */
  agentStatus(a: Agent, agents: Record<string, Agent>, missions: Record<string, CapcomMission>, now = this.now()): AgentBudget {
    const family = this.continuationFamily(a.id, agents);
    const own = this.measure(family, agents, now);
    const lines: BudgetLine[] = [];
    for (const scope of this.scopesOf(a, missions, agents)) {
      const st = this.scopeStatus(scope, agents, missions, now);
      if (st) {
        lines.push({
          scope: scope.kind, ref: scope.ref,
          limit_tokens: st.limit.tokens, limit_usd: st.limit.usd, limit_min: st.limit.min,
          tokens: st.tokens, spent_usd: st.spent_usd, estimated: st.estimated,
          active_min: st.active_min, descendants: st.descendants, pct: st.pct,
        });
      }
    }
    // El techo por defecto sólo cuenta para agentes sin techo propio: es el
    // que el operador puso para "cualquier worker", y un agente al que CAPCOM
    // ya le dio uno explícito tiene algo mejor. Un subagente `Task` no es
    // sujeto de presupuesto: ya se le cobra a su ancestro.
    const dflt = this.defaultLimit();
    if (dflt && !a.subagent && !family.some(member => this.get({ kind: 'agent', ref: member.id })) && a.role !== 'capcom') {
      lines.push({
        scope: 'default', ref: null,
        limit_tokens: dflt.tokens, limit_usd: dflt.usd, limit_min: dflt.min,
        ...own, pct: this.pct(dflt, own),
      });
    }
    const pct = lines.reduce((p, l) => Math.max(p, l.pct), 0);
    return {
      ...own,
      lines, pct, level: lines.length ? this.level(pct) : 'ok',
      last_progress_at: this.marks.get(a.id)?.at ?? null,
      brood: this.broodStatus(a, agents, now),
      retired: !this.alive(a, now),
    };
  }

  /* ── progress ─────────────────────────────────────────────────── */

  private observeProgress(agents: Record<string, Agent>, now: number): void {
    const moved: string[] = [];
    for (const a of Object.values(agents)) {
      const lines = a.metrics.linesAdded + a.metrics.linesRemoved;
      const prev = this.marks.get(a.id);
      if (!prev) {
        // Primera vez que se le ve: la marca se siembra en su ÚLTIMA ACTIVIDAD
        // REAL, no en este tick. Sembrarla en `now` daba por fresca a toda la
        // flota cada vez que el hub reiniciaba, y el aviso llegaba diciendo
        // "still making progress (CG 0s ago)" de un agente muerto hacía horas.
        // `updatedAt` es lo último que el collector vio de él; para un agente
        // recién lanzado es ahora, y para un muerto es viejo, que es la verdad
        // en los dos casos.
        const seenAt = Math.max(a.startedAt, a.updatedAt || 0);
        this.marks.set(a.id, { toolCalls: a.metrics.toolCalls, lines, at: Math.min(now - 1, seenAt || now - 1) });
      } else if (a.metrics.toolCalls !== prev.toolCalls || lines !== prev.lines) {
        this.marks.set(a.id, { toolCalls: a.metrics.toolCalls, lines, at: now });
        moved.push(a.id);
      }
    }
    for (const id of this.marks.keys()) if (!agents[id]) this.marks.delete(id);
    // Un entierro se deshace solo. Si alguien retiró a un agente y el agente
    // sigue haciendo llamadas de herramienta o cambiando líneas, la parada no
    // surtió efecto y darle por ido es el error caro: vuelve al ciclo.
    let revived = false;
    for (const id of moved) if (this.retiredIds.delete(id)) revived = true;
    if (revived) this.save();
  }

  /**
   * Acumula tiempo ACTIVO. Se mide por observación y no por reloj de pared:
   * sólo corre mientras el agente está pensando, trabajando o arrancando. Un
   * hueco largo entre pasadas —el hub reiniciado— no se cobra.
   */
  private observeActive(agents: Record<string, Agent>, now: number): void {
    for (const a of Object.values(agents)) {
      const prev = this.active.get(a.id);
      const working = CONSUMING_STATES.has(a.state);
      const delta = prev && working ? Math.min(Math.max(0, now - prev.at), ACTIVE_SAMPLE_CAP_MS) : 0;
      this.active.set(a.id, { ms: (prev?.ms ?? 0) + delta, at: now });
    }
    for (const id of this.active.keys()) if (!agents[id]) this.active.delete(id);
    // Un agente archivado ya no está en la flota: su retiro deja de hacer
    // falta y el conjunto no crece sin fin.
    for (const id of this.retiredIds) if (!agents[id]) this.retiredIds.delete(id);
  }

  /** True when the agent did something in the last `progressMs`. */
  recentProgress(agentId: string, now = this.now()): boolean {
    const m = this.marks.get(agentId);
    return !!m && now - m.at <= this.cfg.progressMs;
  }

  /**
   * El guardián, delante de todo. Un agente que no está vivo no cuenta como
   * miembro, no consume, no dispara avisos y no se cuenta en la cría de nadie.
   * Cuando el hub le da la vista de sus máquinas, "vivo" incluye que la
   * máquina esté conectada y que un agente que dice trabajar lo esté haciendo
   * de verdad; sin ella queda el criterio mínimo, que es el que basta para una
   * flota en un objeto.
   */
  private alive(a: Agent, now = this.now()): boolean {
    if (TERMINAL_STATES.has(a.state) || this.retiredIds.has(a.id)) return false;
    const view = this.livenessView?.();
    return view ? isLiveAgent(a, { ...view, retired: (id) => this.retiredIds.has(id) }, now) : true;
  }

  /** Por qué el libro no cuenta a este agente. Null cuando sí cuenta. */
  notLive(a: Agent, now = this.now()): boolean { return !this.alive(a, now); }

  /* ── the sweep ────────────────────────────────────────────────── */

  /**
   * One pass over the fleet. Returns what the server must do; the book
   * remembers what it already said so the next pass says nothing twice.
   */
  tick(agents: Record<string, Agent>, missions: Record<string, CapcomMission> = {}, now = this.now()): BudgetEvent[] {
    this.resolvePending(agents);
    this.observeProgress(agents, now);
    this.observeActive(agents, now);
    const events: BudgetEvent[] = [];

    // Scopes with a ceiling: every explicit one, plus the default one for
    // each live worker that has none of its own.
    const scopes: BudgetScope[] = this.all().map((e) => e.scope);
    const seen = new Set(scopes.map(scopeKey));
    if (this.defaultLimit()) {
      for (const a of Object.values(agents)) {
        if (a.role === 'capcom' || a.subagent || !this.alive(a, now)) continue;
        if (this.continuationFamily(a.id, agents).some(member => this.get({ kind: 'agent', ref: member.id }))) continue;
        const s: BudgetScope = { kind: 'agent', ref: a.id };
        if (!seen.has(scopeKey(s))) { scopes.push(s); seen.add(scopeKey(s)); }
      }
    }

    for (const scope of scopes) {
      const limit = this.get(scope) ?? this.defaultLimit();
      if (!limit || !hasLimit(this.effective(limit))) continue;
      const members = this.members(scope, agents, missions);
      if (members.length === 0) continue;
      const live = members.filter((a) => this.alive(a, now));
      const m = this.measure(members, agents, now);
      const pct = this.pct(limit, m);
      const key = scopeKey(scope);

      // Nadie vivo, nada que decir. Un escuadrón que el operador paró hace
      // horas no vuelve a hablar: ni al 80 %, ni al 100 %, ni nunca.
      if (live.length === 0) { this.seen.set(key, { tokens: m.tokens, usd: m.spent_usd, min: m.active_min }); continue; }

      // El reloj no dispara nada por sí solo. Un ámbito cuyos agentes vivos
      // están todos parados y cuya medida no ha subido desde la pasada
      // anterior no da noticia: es exactamente el agente ocho horas en idle
      // que disparaba tres avisos seguidos.
      const prev = this.seen.get(key);
      const grew = !!prev && (m.tokens > prev.tokens + 1e-9 || m.spent_usd > prev.usd + 1e-9 || m.active_min > prev.min + 1e-9);
      const consuming = live.some((a) => CONSUMING_STATES.has(a.state));
      this.seen.set(key, { tokens: m.tokens, usd: m.spent_usd, min: m.active_min });
      if (!consuming && !grew) continue;

      const fired = this.fired.get(key) ?? {};

      if (pct >= 1) {
        const moving = live.filter((a) => this.recentProgress(a.id, now));
        const stalled = live.filter((a) => !this.recentProgress(a.id, now));
        if (!fired.over) {
          fired.over = now;
          this.fired.set(key, fired);
          events.push({
            kind: 'over', scope, agentIds: live.map((a) => a.id), pct,
            label: this.who(scope, members, agents),
            text: this.overText(scope, members, limit, m, pct, moving, stalled, now, agents, missions),
          });
        }
        if (this.cfg.action === 'stop') {
          for (const a of stalled) {
            if (this.stopRequested.has(a.id)) continue;
            this.stopRequested.set(a.id, now);
            // Pedir la parada ya le saca del ciclo: el aviso no se repite
            // aunque el `dead` tarde en llegar, o no llegue nunca.
            this.retiredIds.add(a.id);
            const reason = `over budget: ${this.figures(limit, m, pct)}; no tool calls or edits in the last ${this.progressLabel()}`;
            events.push({
              kind: 'stop', scope, agentId: a.id, reason, pct, label: a.callsign,
              text: `[BUDGET STOP] ${this.who(scope, [a], agents)}${this.missionTag(scope, a, missions)} · ${this.figures(limit, m, pct)}`
                + ` · no tool calls or edits in the last ${this.progressLabel()} · stopped by the hub.`
                + ' Raise it with set_budget and resume if the work must go on.',
            });
          }
        }
      } else if (pct >= WARN_AT && !fired.warn && live.length > 0) {
        fired.warn = now;
        this.fired.set(key, fired);
        events.push({
          kind: 'warn', scope, agentIds: live.map((a) => a.id), pct,
          label: this.who(scope, members, agents),
          text: `[BUDGET 80%] ${this.who(scope, members, agents)}${this.missionTag(scope, members[0]!, missions)} · ${this.figures(limit, m, pct)}`,
        });
      }
    }

    events.push(...this.broodTick(agents, now));
    if (events.some((e) => e.kind !== 'stop')) this.save();
    return events;
  }

  /**
   * El freno. Se dice una vez por agente mientras esté por encima, y se re-arma
   * cuando su descendencia baja: así una tanda que termina no deja el aviso
   * gastado para la siguiente.
   */
  private broodTick(agents: Record<string, Agent>, now: number): BudgetEvent[] {
    const events: BudgetEvent[] = [];
    for (const a of Object.values(agents)) {
      if (a.subagent || !this.alive(a, now)) continue;
      const brood = this.broodStatus(a, agents, now);
      const over = brood.over_count || brood.over_depth;
      if (!over) { this.swarmFired.delete(a.id); continue; }
      if (this.swarmFired.has(a.id)) continue;
      this.swarmFired.add(a.id);
      const why: string[] = [];
      if (brood.over_count) why.push(`${brood.live} live Task subagents (cap ${this.cfg.maxDescendants})`);
      if (brood.over_depth) why.push(`nested ${brood.depth} deep (cap ${this.cfg.maxDepth})`);
      const stopping = this.cfg.swarmAction === 'stop';
      events.push({
        kind: 'swarm', agentId: a.id, brood,
        stopIds: stopping ? [a.id] : [],
        text: `[SWARM CAP] ${a.callsign}${a.squad ? ` · squad ${a.squad}` : ''} · ${why.join(' · ')}`
          + ` · their tokens already count against ${a.callsign}.`
          + (stopping
            ? ' ORCA_SWARM_ACTION=stop: stopping the parent session, which is the only thing the hub can end — a native Task subagent has no session of its own.'
            // El consejo se filtra por lo que de verdad alcanza a ESTE agente:
            // recomendar interrupt_agent a una sesión sin pane era mandar al
            // operador a un callejón.
            : ` The hub cannot stop a native Task subagent. Use ${adviceFor(a)}.`)
          + ` Raise the caps with ORCA_MAX_DESCENDANTS / ORCA_MAX_AGENT_DEPTH.`,
      });
    }
    for (const id of [...this.swarmFired]) if (!agents[id]) this.swarmFired.delete(id);
    return events;
  }

  private resolvePending(agents: Record<string, Agent>): void {
    if (this.pendingByShortId.size === 0) return;
    let changed = false;
    for (const a of Object.values(agents)) {
      if (!a.shortId) continue;
      const limit = this.pendingByShortId.get(a.shortId);
      if (!limit) continue;
      this.pendingByShortId.delete(a.shortId);
      this.limits.set(scopeKey({ kind: 'agent', ref: a.id }), limit);
      changed = true;
    }
    if (changed) this.save();
  }

  /* ── wording ──────────────────────────────────────────────────── */

  private progressLabel(): string {
    const min = this.cfg.progressMs / 60_000;
    return Number.isInteger(min) ? `${min} min` : `${Math.round(this.cfg.progressMs / 1000)} s`;
  }

  private who(scope: BudgetScope, members: Agent[], agents: Record<string, Agent>): string {
    const names = members.map((a) => agents[a.id]?.callsign ?? a.callsign).join(', ');
    switch (scope.kind) {
      case 'agent': return names || scope.ref;
      case 'squad': return `squad ${scope.ref} (${names || 'nobody yet'})`;
      case 'mission': return `mission ${scope.ref} (${names || 'nobody yet'})`;
    }
  }

  /** The mission and squad an agent belongs to, minus the scope already named. */
  private missionTag(scope: BudgetScope, a: Agent, missions: Record<string, CapcomMission>): string {
    const t = Object.values(missions).find((x) => x.status === 'active' && x.agentIds.includes(a.id));
    const parts: string[] = [];
    if (t && scope.kind !== 'mission') parts.push(`mission ${t.id}`);
    if (a.squad && scope.kind !== 'squad') parts.push(`squad ${a.squad}`);
    return parts.length ? ` · ${parts.join(' · ')}` : '';
  }

  /**
   * Las cifras de una línea. En tokens porque ésa es la unidad; en dólares
   * sólo con el dinero encendido, y entonces con `≥` cuando parte de la cifra
   * es una estimación — un número que se queda corto es peor que ninguno, así
   * que se dice que es un suelo y no un total.
   */
  private figures(limit: BudgetLimit, c: Consumption, pct: number): string {
    const l = this.effective(limit);
    const parts: string[] = [];
    if (l.tokens !== null) {
      parts.push(`${fmtTokens(c.tokens)} of ${fmtTokens(l.tokens)} tokens (${Math.round((c.tokens / l.tokens) * 100)}%)`);
    }
    if (l.usd !== null) {
      const money = (n: number) => `$${n.toFixed(2)}`;
      parts.push(`${c.estimated ? '≥' : ''}${money(c.spent_usd)} of ${money(l.usd)} (${Math.round((c.spent_usd / l.usd) * 100)}%)`);
    }
    if (l.min !== null) {
      parts.push(`${Math.round(c.active_min)}m of ${l.min}m active (${Math.round((c.active_min / l.min) * 100)}%)`);
    }
    if (c.descendants > 0) parts.push(`includes ${c.descendants} live Task subagent${c.descendants === 1 ? '' : 's'}`);
    const axes = [l.tokens, l.usd, l.min].filter((v) => v !== null).length;
    return axes > 1 ? `${parts.join(' · ')} · ${Math.round(pct * 100)}% used` : parts.join(' · ');
  }

  private overText(
    scope: BudgetScope, members: Agent[], limit: BudgetLimit,
    c: Consumption, pct: number,
    moving: Agent[], stalled: Agent[], now: number,
    agents: Record<string, Agent>, missions: Record<string, CapcomMission>,
  ): string {
    const head = `[BUDGET 100%] ${this.who(scope, members, agents)}${this.missionTag(scope, members[0]!, missions)} · ${this.figures(limit, c, pct)}`;
    const notes: string[] = [];
    if (moving.length) {
      const ages = moving.map((a) => {
        const at = this.marks.get(a.id)?.at ?? now;
        return `${a.callsign} ${Math.max(0, Math.round((now - at) / 1000))}s ago`;
      });
      notes.push(`still making progress (${ages.join(', ')}); not stopped. Use stop_agent, or raise it with set_budget.`);
    }
    if (stalled.length) {
      notes.push(this.cfg.action === 'stop'
        ? `no progress in the last ${this.progressLabel()} from ${stalled.map((a) => a.callsign).join(', ')}: stopping.`
        : `no progress in the last ${this.progressLabel()} from ${stalled.map((a) => a.callsign).join(', ')}; ORCA_BUDGET_ACTION=warn, so not stopped.`);
    }
    if (!moving.length && !stalled.length) notes.push('nobody alive in it.');
    return `${head} · ${notes.join(' ')}`;
  }

  /* ── disk ─────────────────────────────────────────────────────── */

  private save(): void {
    if (!this.file) return;
    const data: Persisted = {
      limits: Object.fromEntries(this.limits),
      pendingByShortId: Object.fromEntries(this.pendingByShortId),
      fired: Object.fromEntries(this.fired),
      activeMs: Object.fromEntries([...this.active].filter(([, v]) => v.ms > 0).map(([k, v]) => [k, Math.round(v.ms)])),
      retired: [...this.retiredIds],
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // El presupuesto vive también en memoria; perder el disco no lo anula.
    }
  }
}

/** 12.4M, 840k, 912 — un número de tokens que se lee de un vistazo. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}
