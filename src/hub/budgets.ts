/**
 * Budgets — how much a worker, a squad or a task may spend before the hub
 * says something, and when it stops them.
 *
 * A budget is a ceiling in dollars, in minutes, or both, hung on one of three
 * scopes: an agent, a squad (shared by every member) or a task (shared by
 * every agent assigned to it). Nothing here talks to a collector: the book
 * keeps the limits, watches the fleet on every hub sweep, and hands back
 * *events* — "warn CAPCOM", "stop this one" — that the server turns into a
 * `say`, a feed line and a `stop` command. That split is what makes it
 * testable with a fleet in a box and a clock in a variable.
 *
 * Spend is read the way the fleet actually reports it: Claude Code writes
 * `costUSD` at the end of a turn, so a live agent often shows $0 while it is
 * burning tokens. When the cost is still zero the book estimates from the
 * tokens it has seen, at a flat rate the operator can set, and says so in
 * every line it emits (`~$`). Time is wall-clock since the agent started.
 *
 * At 80 % of either ceiling CAPCOM gets one warning. At 100 % the book looks
 * for progress — tool calls or changed lines in the last few minutes — and an
 * agent that is still moving is reported, not stopped: a budget is a leash,
 * not a guillotine, and stopping a worker mid-edit to save forty cents is a
 * bad trade. An agent that is over budget *and* has gone quiet is stopped,
 * with the reason written where CAPCOM reads it, unless ORCA_BUDGET_ACTION
 * is `warn`.
 *
 * Environment:
 *   ORCA_DEFAULT_BUDGET_USD   ceiling for every worker that has none. Empty = none.
 *   ORCA_DEFAULT_BUDGET_MIN   same, in minutes.
 *   ORCA_BUDGET_ACTION        warn | stop (default stop) — what 100 % without progress does.
 *   ORCA_BUDGET_PROGRESS_MIN  minutes of silence before "no progress" (default 3).
 *   ORCA_BUDGET_USD_PER_MTOK  flat $/million tokens for the estimate while the
 *                             CLI has not written a cost yet (default 6).
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Agent } from '../shared/types.ts';
import { TERMINAL_STATES } from '../shared/types.ts';
import type { CapcomTask } from '../shared/tasks.ts';

/* ── Model ────────────────────────────────────────────────────────── */

/** A ceiling: null means "no limit on this axis". */
export interface BudgetLimit {
  usd: number | null;
  min: number | null;
}

export type BudgetScopeKind = 'agent' | 'squad' | 'task';

/** Where a limit hangs. `ref` is the agent id, the squad label or the task id. */
export interface BudgetScope {
  kind: BudgetScopeKind;
  ref: string;
}

export function scopeKey(s: BudgetScope): string { return `${s.kind}:${s.ref}`; }

export type BudgetAction = 'warn' | 'stop';

export interface BudgetConfig {
  defaultUsd: number | null;
  defaultMin: number | null;
  action: BudgetAction;
  /** How long an agent may go without a tool call or an edit before it counts as stalled. */
  progressMs: number;
  /** Flat $/1M tokens for the estimate while `costUSD` is still 0. */
  usdPerMTok: number;
}

export const WARN_AT = 0.8;
export const DEFAULT_PROGRESS_MIN = 3;
export const DEFAULT_USD_PER_MTOK = 6;

function envNumber(v: string | undefined, fallback: number | null): number | null {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The book's configuration, read from the environment once at startup. */
export function budgetConfig(env: NodeJS.ProcessEnv = process.env): BudgetConfig {
  const action = env['ORCA_BUDGET_ACTION']?.trim().toLowerCase();
  return {
    defaultUsd: envNumber(env['ORCA_DEFAULT_BUDGET_USD'], null),
    defaultMin: envNumber(env['ORCA_DEFAULT_BUDGET_MIN'], null),
    action: action === 'warn' ? 'warn' : 'stop',
    progressMs: (envNumber(env['ORCA_BUDGET_PROGRESS_MIN'], DEFAULT_PROGRESS_MIN) ?? DEFAULT_PROGRESS_MIN) * 60_000,
    usdPerMTok: envNumber(env['ORCA_BUDGET_USD_PER_MTOK'], DEFAULT_USD_PER_MTOK) ?? DEFAULT_USD_PER_MTOK,
  };
}

/** A limit as a tool hands it in: numbers, nulls, or nothing. */
export function budgetLimit(usd: unknown, min: unknown): BudgetLimit | { error: string } {
  const one = (v: unknown, name: string): number | null | { error: string } => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) return { error: `${name} must be a positive number, or null for no limit` };
    return n;
  };
  const u = one(usd, 'budget_usd');
  if (typeof u === 'object' && u !== null) return u;
  const m = one(min, 'budget_min');
  if (typeof m === 'object' && m !== null) return m;
  return { usd: u, min: m };
}

export function hasLimit(l: BudgetLimit | null | undefined): l is BudgetLimit {
  return !!l && (l.usd !== null || l.min !== null);
}

/* ── What the book reports ────────────────────────────────────────── */

/** One ceiling that applies to an agent, with the spend measured against it. */
export interface BudgetLine {
  /** `default` is the environment's ceiling standing in for a missing agent one. */
  scope: BudgetScopeKind | 'default';
  ref: string | null;
  limit_usd: number | null;
  limit_min: number | null;
  /** Spend of the whole scope: the agent alone, or the squad / task together. */
  spent_usd: number;
  /** True when any of the spend is a token estimate rather than a reported cost. */
  estimated: boolean;
  elapsed_min: number;
  /** Worst of the two axes, 0..∞ (1 = at the ceiling). */
  pct: number;
}

export type BudgetLevel = 'ok' | 'warn' | 'over';

/** An agent's budget picture, as inspect_agent and the console show it. */
export interface AgentBudget {
  spent_usd: number;
  estimated: boolean;
  elapsed_min: number;
  lines: BudgetLine[];
  /** Worst `pct` across lines. */
  pct: number;
  level: BudgetLevel;
  /** When the book last saw a tool call or an edit from it. */
  last_progress_at: number | null;
}

export interface ScopeBudget {
  scope: BudgetScope;
  limit: BudgetLimit;
  spent_usd: number;
  estimated: boolean;
  elapsed_min: number;
  pct: number;
  level: BudgetLevel;
  /** Agents the spend was summed over. */
  agent_ids: string[];
}

/** What the sweep hands the server. */
export type BudgetEvent =
  /** A scope crossed 80 %. */
  | { kind: 'warn'; scope: BudgetScope; text: string; agentIds: string[] }
  /** A scope crossed 100 %; says which agents are still moving and which are not. */
  | { kind: 'over'; scope: BudgetScope; text: string; agentIds: string[] }
  /** Stop this agent: over budget and no progress. The server dispatches it. */
  | { kind: 'stop'; scope: BudgetScope; agentId: string; reason: string; text: string };

/* ── The book ─────────────────────────────────────────────────────── */

interface Persisted {
  limits: Record<string, BudgetLimit>;
  /** Budgets handed in for an agent the ack only named by short id. */
  pendingByShortId: Record<string, BudgetLimit>;
  /** Notices already sent, so a restart does not repeat them. */
  fired: Record<string, { warn?: number; over?: number }>;
}

interface ProgressMark { toolCalls: number; lines: number; at: number }

export interface BudgetBookOptions {
  now?: () => number;
}

export class BudgetBook {
  readonly cfg: BudgetConfig;
  private limits = new Map<string, BudgetLimit>();
  private pendingByShortId = new Map<string, BudgetLimit>();
  private fired = new Map<string, { warn?: number; over?: number }>();
  /** Agents the book already asked the hub to stop. */
  private stopRequested = new Map<string, number>();
  private marks = new Map<string, ProgressMark>();
  private file: string | null;
  private now: () => number;

  constructor(dir: string | null, cfg: BudgetConfig = budgetConfig(), opts: BudgetBookOptions = {}) {
    this.cfg = cfg;
    this.now = opts.now ?? Date.now;
    this.file = dir ? path.join(dir, 'budgets.json') : null;
    if (this.file && fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Persisted>;
        for (const [k, v] of Object.entries(raw.limits ?? {})) if (hasLimit(v)) this.limits.set(k, { usd: v.usd ?? null, min: v.min ?? null });
        for (const [k, v] of Object.entries(raw.pendingByShortId ?? {})) if (hasLimit(v)) this.pendingByShortId.set(k, v);
        for (const [k, v] of Object.entries(raw.fired ?? {})) this.fired.set(k, v);
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
    this.limits.set(key, { usd: limit.usd, min: limit.min });
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
   * A budget for an agent the spawn ack could only name by short id. It is
   * moved onto the agent the first sweep that sees a session with that id.
   */
  setPendingByShortId(shortId: string, limit: BudgetLimit): void {
    if (!hasLimit(limit)) return;
    this.pendingByShortId.set(shortId, limit);
    this.save();
  }

  /* ── measurement ──────────────────────────────────────────────── */

  /** Dollars this agent has spent, estimated from tokens when the CLI has not said. */
  spend(a: Agent): { usd: number; estimated: boolean } {
    const m = a.metrics;
    if (m.costUSD > 0) return { usd: m.costUSD, estimated: false };
    const tokens = (m.inputTokens ?? 0) + (m.outputTokens ?? 0);
    if (tokens <= 0) return { usd: 0, estimated: false };
    return { usd: (tokens / 1_000_000) * this.cfg.usdPerMTok, estimated: true };
  }

  elapsedMs(a: Agent, now = this.now()): number {
    if (TERMINAL_STATES.has(a.state)) return Math.max(0, a.uptimeMs);
    return Math.max(a.uptimeMs, now - a.startedAt, 0);
  }

  private measure(agents: Agent[], now: number): { spent_usd: number; estimated: boolean; elapsed_min: number } {
    let spent = 0, estimated = false, started = Infinity;
    for (const a of agents) {
      const s = this.spend(a);
      spent += s.usd;
      estimated ||= s.estimated;
      started = Math.min(started, a.startedAt);
    }
    // El tiempo de un escuadrón o una tarea es el de pared desde el primer
    // lanzamiento, no la suma de los relojes: cuatro agentes en paralelo
    // durante diez minutos son diez minutos de espera, no cuarenta.
    const elapsed = agents.length === 1
      ? this.elapsedMs(agents[0]!, now)
      : agents.length ? Math.max(0, now - started) : 0;
    return { spent_usd: spent, estimated, elapsed_min: elapsed / 60_000 };
  }

  private pct(limit: BudgetLimit, spent_usd: number, elapsed_min: number): number {
    let p = 0;
    if (limit.usd !== null) p = Math.max(p, spent_usd / limit.usd);
    if (limit.min !== null) p = Math.max(p, elapsed_min / limit.min);
    return p;
  }

  private level(pct: number): BudgetLevel {
    return pct >= 1 ? 'over' : pct >= WARN_AT ? 'warn' : 'ok';
  }

  /** The agents a scope's spend is summed over. */
  private members(scope: BudgetScope, agents: Record<string, Agent>, tasks: Record<string, CapcomTask>): Agent[] {
    switch (scope.kind) {
      case 'agent': return this.continuationFamily(scope.ref, agents);
      case 'squad': return Object.values(agents).filter((a) => a.squad === scope.ref);
      case 'task': return (tasks[scope.ref]?.agentIds ?? []).map((id) => agents[id]).filter((a): a is Agent => !!a);
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
  private scopesOf(a: Agent, tasks: Record<string, CapcomTask>, agents: Record<string, Agent>): BudgetScope[] {
    const out: BudgetScope[] = this.continuationFamily(a.id, agents).map(a => ({ kind: 'agent', ref: a.id }));
    if (a.squad) out.push({ kind: 'squad', ref: a.squad });
    for (const t of Object.values(tasks)) {
      if (t.status === 'active' && t.agentIds.includes(a.id)) out.push({ kind: 'task', ref: t.id });
    }
    return out;
  }

  private defaultLimit(): BudgetLimit | null {
    const l = { usd: this.cfg.defaultUsd, min: this.cfg.defaultMin };
    return hasLimit(l) ? l : null;
  }

  scopeStatus(scope: BudgetScope, agents: Record<string, Agent>, tasks: Record<string, CapcomTask>, now = this.now()): ScopeBudget | null {
    const limit = this.get(scope);
    if (!limit) return null;
    const members = this.members(scope, agents, tasks);
    const m = this.measure(members, now);
    const pct = this.pct(limit, m.spent_usd, m.elapsed_min);
    return { scope, limit, ...m, pct, level: this.level(pct), agent_ids: members.map((a) => a.id) };
  }

  /** The whole picture for one agent: every ceiling that reaches it, and the worst. */
  agentStatus(a: Agent, agents: Record<string, Agent>, tasks: Record<string, CapcomTask>, now = this.now()): AgentBudget {
    const own = this.measure(this.continuationFamily(a.id, agents), now);
    const lines: BudgetLine[] = [];
    for (const scope of this.scopesOf(a, tasks, agents)) {
      const st = this.scopeStatus(scope, agents, tasks, now);
      if (st) {
        lines.push({
          scope: scope.kind, ref: scope.ref, limit_usd: st.limit.usd, limit_min: st.limit.min,
          spent_usd: st.spent_usd, estimated: st.estimated, elapsed_min: st.elapsed_min, pct: st.pct,
        });
      }
    }
    // El techo por defecto sólo cuenta para agentes sin techo propio: es el
    // que el operador puso para "cualquier worker", y un agente al que CAPCOM
    // ya le dio uno explícito tiene algo mejor.
    const dflt = this.defaultLimit();
    if (dflt && !this.continuationFamily(a.id, agents).some(member => this.get({ kind: 'agent', ref: member.id })) && a.role !== 'capcom') {
      lines.push({
        scope: 'default', ref: null, limit_usd: dflt.usd, limit_min: dflt.min,
        spent_usd: own.spent_usd, estimated: own.estimated, elapsed_min: own.elapsed_min,
        pct: this.pct(dflt, own.spent_usd, own.elapsed_min),
      });
    }
    const pct = lines.reduce((p, l) => Math.max(p, l.pct), 0);
    return {
      spent_usd: own.spent_usd, estimated: own.estimated, elapsed_min: own.elapsed_min,
      lines, pct, level: lines.length ? this.level(pct) : 'ok',
      last_progress_at: this.marks.get(a.id)?.at ?? null,
    };
  }

  /* ── progress ─────────────────────────────────────────────────── */

  private observeProgress(agents: Record<string, Agent>, now: number): void {
    for (const a of Object.values(agents)) {
      const lines = a.metrics.linesAdded + a.metrics.linesRemoved;
      const prev = this.marks.get(a.id);
      if (!prev) {
        // Primera vez que se le ve: se le concede el beneficio de la duda desde
        // su arranque, no desde este tick — un agente recién lanzado no ha
        // tenido tiempo de hacer nada.
        this.marks.set(a.id, { toolCalls: a.metrics.toolCalls, lines, at: Math.max(a.startedAt, now - 1) });
      } else if (a.metrics.toolCalls !== prev.toolCalls || lines !== prev.lines) {
        this.marks.set(a.id, { toolCalls: a.metrics.toolCalls, lines, at: now });
      }
    }
    for (const id of this.marks.keys()) if (!agents[id]) this.marks.delete(id);
  }

  /** True when the agent did something in the last `progressMs`. */
  recentProgress(agentId: string, now = this.now()): boolean {
    const m = this.marks.get(agentId);
    return !!m && now - m.at <= this.cfg.progressMs;
  }

  /* ── the sweep ────────────────────────────────────────────────── */

  /**
   * One pass over the fleet. Returns what the server must do; the book
   * remembers what it already said so the next pass says nothing twice.
   */
  tick(agents: Record<string, Agent>, tasks: Record<string, CapcomTask> = {}, now = this.now()): BudgetEvent[] {
    this.resolvePending(agents);
    this.observeProgress(agents, now);
    const events: BudgetEvent[] = [];

    // Scopes with a ceiling: every explicit one, plus the default one for
    // each live worker that has none of its own.
    const scopes: BudgetScope[] = this.all().map((e) => e.scope);
    const seen = new Set(scopes.map(scopeKey));
    if (this.defaultLimit()) {
      for (const a of Object.values(agents)) {
        if (a.role === 'capcom' || TERMINAL_STATES.has(a.state) || this.continuationFamily(a.id, agents).some(member => this.get({ kind: 'agent', ref: member.id }))) continue;
        const s: BudgetScope = { kind: 'agent', ref: a.id };
        if (!seen.has(scopeKey(s))) { scopes.push(s); seen.add(scopeKey(s)); }
      }
    }

    for (const scope of scopes) {
      const limit = this.get(scope) ?? this.defaultLimit();
      if (!limit) continue;
      const members = this.members(scope, agents, tasks);
      if (members.length === 0) continue;
      const live = members.filter((a) => !TERMINAL_STATES.has(a.state));
      const m = this.measure(members, now);
      const pct = this.pct(limit, m.spent_usd, m.elapsed_min);
      const key = scopeKey(scope);
      const fired = this.fired.get(key) ?? {};

      if (pct >= 1) {
        const moving = live.filter((a) => this.recentProgress(a.id, now));
        const stalled = live.filter((a) => !this.recentProgress(a.id, now));
        if (!fired.over) {
          fired.over = now;
          this.fired.set(key, fired);
          events.push({
            kind: 'over', scope, agentIds: live.map((a) => a.id),
            text: this.overText(scope, members, limit, m, pct, moving, stalled, now, agents, tasks),
          });
        }
        if (this.cfg.action === 'stop') {
          for (const a of stalled) {
            if (this.stopRequested.has(a.id)) continue;
            this.stopRequested.set(a.id, now);
            const reason = `over budget: ${this.figures(limit, m, pct)}; no tool calls or edits in the last ${this.progressLabel()}`;
            events.push({
              kind: 'stop', scope, agentId: a.id, reason,
              text: `[BUDGET STOP] ${this.who(scope, [a], agents)}${this.taskTag(scope, a, tasks)} · ${this.figures(limit, m, pct)}`
                + ` · no tool calls or edits in the last ${this.progressLabel()} · stopped by the hub.`
                + ' Raise it with set_budget and resume if the work must go on.',
            });
          }
        }
      } else if (pct >= WARN_AT && !fired.warn && live.length > 0) {
        fired.warn = now;
        this.fired.set(key, fired);
        events.push({
          kind: 'warn', scope, agentIds: live.map((a) => a.id),
          text: `[BUDGET 80%] ${this.who(scope, members, agents)}${this.taskTag(scope, members[0]!, tasks)} · ${this.figures(limit, m, pct)}`,
        });
      }
    }
    if (events.some((e) => e.kind !== 'stop')) this.save();
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
      case 'task': return `task ${scope.ref} (${names || 'nobody yet'})`;
    }
  }

  /** The task and squad an agent belongs to, minus the scope already named. */
  private taskTag(scope: BudgetScope, a: Agent, tasks: Record<string, CapcomTask>): string {
    const t = Object.values(tasks).find((x) => x.status === 'active' && x.agentIds.includes(a.id));
    const parts: string[] = [];
    if (t && scope.kind !== 'task') parts.push(`task ${t.id}`);
    if (a.squad && scope.kind !== 'squad') parts.push(`squad ${a.squad}`);
    return parts.length ? ` · ${parts.join(' · ')}` : '';
  }

  private figures(limit: BudgetLimit, m: { spent_usd: number; estimated: boolean; elapsed_min: number }, pct: number): string {
    const parts: string[] = [];
    const money = (n: number) => `$${n.toFixed(2)}`;
    if (limit.usd !== null) {
      parts.push(`${m.estimated ? '~' : ''}${money(m.spent_usd)} of ${money(limit.usd)} (${Math.round((m.spent_usd / limit.usd) * 100)}%)`);
    }
    if (limit.min !== null) {
      parts.push(`${Math.round(m.elapsed_min)}m of ${limit.min}m (${Math.round((m.elapsed_min / limit.min) * 100)}%)`);
    }
    if (limit.usd === null || limit.min === null) return parts.join(' · ');
    return `${parts.join(' · ')} · ${Math.round(pct * 100)}% used`;
  }

  private overText(
    scope: BudgetScope, members: Agent[], limit: BudgetLimit,
    m: { spent_usd: number; estimated: boolean; elapsed_min: number }, pct: number,
    moving: Agent[], stalled: Agent[], now: number,
    agents: Record<string, Agent>, tasks: Record<string, CapcomTask>,
  ): string {
    const head = `[BUDGET 100%] ${this.who(scope, members, agents)}${this.taskTag(scope, members[0]!, tasks)} · ${this.figures(limit, m, pct)}`;
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
