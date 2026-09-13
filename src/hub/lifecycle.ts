/**
 * Ciclo de vida de los agentes, como eventos que otros módulos del hub pueden
 * escuchar sin engancharse al `onEvent` de World.
 *
 * Es el punto de encuentro del squad "autonomy": el despertador de CAPCOM
 * (wake.ts), los presupuestos (budget.ts) y el diario (journal.ts) necesitan
 * los tres el mismo hecho — "este agente cambió de estado" — y cada uno lo
 * consume por su lado. Un único emisor tipado evita que tres módulos metan
 * tres `if (ev.kind === 'agent:state')` en server.ts.
 *
 * Se alimenta desde server.ts con `feed(ev, agent)`: el WorldEvent tal cual y
 * la instantánea del agente en ese momento (o null si ya no está).
 */

import type { Agent, WithdrawCause } from '../shared/types.ts';
import { WITHDRAW_CAUSES } from '../shared/types.ts';
import type { WorldEvent } from './world.ts';

export interface AgentStateChange {
  agent: Agent;
  from: string;
  to: string;
  at: number;
}

export interface LifecycleEvents {
  /** Un agente nuevo entró al mundo. */
  'agent:new': (agent: Agent, at: number) => void;
  /** Cambió de estado. `to` es `done | idle | blocked | dead | working | …`. */
  'agent:state': (change: AgentStateChange) => void;
  /**
   * Terminó un tramo de trabajo: pasó a `done`, `idle`, `blocked` o `dead`.
   * Es `agent:state` filtrado, porque es el caso que casi todos quieren.
   */
  'agent:finished': (change: AgentStateChange) => void;
  /** Salió del mundo (reaper, archivado, máquina caída). */
  'agent:gone': (agentId: string, projectId: string | null, at: number) => void;
  /** Un agente (o CAPCOM, con `from: 'ceo'`) levantó una pregunta al humano. */
  'escalation:new': (e: EscalationRaised) => void;
  /** Alguien la contestó: `by` es 'human' o 'ceo' (CAPCOM). */
  'escalation:answered': (e: EscalationAnswered) => void;
  /**
   * Dejó de existir sin respuesta: el agente siguió, el diálogo cambió, el
   * agente se fue, la sustituyó otra, caducó o alguien la descartó. `cause`
   * dice cuál (ver `WithdrawCause` en shared/types.ts). No es una pregunta sin
   * contestar: es una que nadie tenía que contestar ya.
   */
  'escalation:withdrawn': (e: EscalationWithdrawn) => void;
}

/**
 * Lo que un WorldEvent de escalación trae. `id` falta en las que levanta el
 * propio CAPCOM (world.ts lo omite a propósito para no triarlas en bucle) y
 * en las respuestas; el diario las casa por agente cuando no hay id.
 */
export interface EscalationRaised {
  id: string | null;
  agentId: string | null;
  projectId: string | null;
  machineId: string | null;
  question: string;
  urgency: string | null;
  options: string[];
  from: 'ceo' | null;
  at: number;
}

export interface EscalationAnswered {
  id: string | null;
  agentId: string | null;
  projectId: string | null;
  machineId: string | null;
  question: string | null;
  answer: string;
  by: 'human' | 'ceo';
  rememberAs: string | null;
  at: number;
}

export interface EscalationWithdrawn {
  id: string | null;
  agentId: string | null;
  projectId: string | null;
  machineId: string | null;
  cause: WithdrawCause;
  /** La prosa del que la retiró, tal cual; para leerla, no para clasificarla. */
  reason: string;
  at: number;
}

export const FINISHED_STATES: ReadonlySet<string> = new Set(['done', 'idle', 'blocked', 'dead']);

type Listener<K extends keyof LifecycleEvents> = LifecycleEvents[K];

export class AgentLifecycle {
  private readonly listeners = new Map<keyof LifecycleEvents, Set<unknown>>();

  on<K extends keyof LifecycleEvents>(kind: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(kind);
    if (!set) { set = new Set(); this.listeners.set(kind, set); }
    set.add(fn);
    return () => { set?.delete(fn); };
  }

  private emit<K extends keyof LifecycleEvents>(kind: K, ...args: Parameters<Listener<K>>): void {
    const set = this.listeners.get(kind);
    if (!set) return;
    for (const fn of [...set]) {
      // Un oyente que revienta no tumba al resto ni al hub.
      try { (fn as unknown as (...a: Parameters<Listener<K>>) => void)(...args); }
      catch (err) { console.warn('[lifecycle]', kind, 'listener falló:', err); }
    }
  }

  /** Traduce un WorldEvent a eventos tipados. Ignora lo que no conoce. */
  feed(ev: WorldEvent, agent: Agent | null | undefined): void {
    switch (ev.kind) {
      case 'agent:new':
        if (agent) this.emit('agent:new', agent, ev.at);
        return;
      case 'agent:state': {
        if (!agent) return;
        const d = (ev.data ?? {}) as { from?: string; to?: string };
        const change: AgentStateChange = {
          agent, from: d.from ?? '', to: d.to ?? agent.state, at: ev.at,
        };
        this.emit('agent:state', change);
        if (FINISHED_STATES.has(change.to)) this.emit('agent:finished', change);
        return;
      }
      case 'agent:gone':
      case 'agent:archived':
        if (ev.agentId) this.emit('agent:gone', ev.agentId, ev.projectId ?? null, ev.at);
        return;
      case 'escalation:new': {
        const d = (ev.data ?? {}) as { id?: unknown; urgency?: unknown; options?: unknown; from?: unknown };
        this.emit('escalation:new', {
          id: typeof d.id === 'string' ? d.id : null,
          agentId: ev.agentId ?? null, projectId: ev.projectId ?? null, machineId: ev.machineId ?? null,
          question: ev.text ?? '',
          urgency: typeof d.urgency === 'string' ? d.urgency : null,
          options: Array.isArray(d.options) ? d.options.filter((o): o is string => typeof o === 'string') : [],
          from: d.from === 'ceo' ? 'ceo' : null,
          at: ev.at,
        });
        return;
      }
      case 'escalation:answered': {
        const d = (ev.data ?? {}) as { id?: unknown; answer?: unknown; by?: unknown; rememberAs?: unknown };
        this.emit('escalation:answered', {
          id: typeof d.id === 'string' ? d.id : null,
          agentId: ev.agentId ?? null, projectId: ev.projectId ?? null, machineId: ev.machineId ?? null,
          question: ev.text ?? null,
          answer: typeof d.answer === 'string' ? d.answer : '',
          by: d.by === 'human' ? 'human' : 'ceo',
          rememberAs: typeof d.rememberAs === 'string' ? d.rememberAs : null,
          at: ev.at,
        });
        return;
      }
      case 'escalation:withdraw': {
        const d = (ev.data ?? {}) as { id?: unknown; cause?: unknown; reason?: unknown };
        // Un evento viejo (anterior a la causa) llega sin `data`: se anota
        // como retirada por el agente, que era lo único que existía entonces.
        const cause = (WITHDRAW_CAUSES as readonly unknown[]).includes(d.cause) ? d.cause as WithdrawCause : 'agent';
        this.emit('escalation:withdrawn', {
          id: typeof d.id === 'string' ? d.id : null,
          agentId: ev.agentId ?? null, projectId: ev.projectId ?? null, machineId: ev.machineId ?? null,
          cause, reason: typeof d.reason === 'string' ? d.reason : ev.text ?? '',
          at: ev.at,
        });
        return;
      }
      default:
        return;
    }
  }
}
