import { capcomOf, capcomTurn } from '../../shared/capcom.ts';
import type { Agent } from '../../shared/types.ts';

/** Presentation only. Delivery receipts and historical compaction counts are
 * deliberately not inputs: neither proves that CAPCOM is receiving a turn. */
export interface CapcomFeedback {
  kind: 'loading' | 'reconnecting' | 'processing' | 'ready' | 'waiting' | 'error' | 'unavailable';
  label: string;
  detail: string;
  color: string;
}
export function capcomFeedback(input: {
  agents: Record<string, Agent>;
  linkUp: boolean;
  authed: boolean;
  seenLink: boolean;
  thinking: boolean;
  transition?: string | null;
  transitionError?: string | null;
  transitionUnconfirmed?: boolean;
}): CapcomFeedback {
  const state = (kind: CapcomFeedback['kind'], label: string, detail: string, color = 'var(--st-thinking)'): CapcomFeedback => ({ kind, label, detail, color });
  if (!input.authed) return state('error', 'ACCESS ERROR', 'Update the connection token in the handshake to reconnect.', 'var(--red)');
  if (!input.linkUp) return state(input.seenLink ? 'reconnecting' : 'loading', input.seenLink ? 'RECONNECTING' : 'CONNECTING',
    'Retrying automatically. Activity is unconfirmed; your draft is kept.');
  if (input.transitionError) return state('error', 'CHANGE ERROR', input.transitionError, 'var(--red)');
  if (input.transitionUnconfirmed) return state('loading', 'CHECKING SESSION', input.transition || 'Session status is unconfirmed. Checking again automatically.');
  if (input.transition) return state('processing', 'CHANGING SESSION', input.transition);
  const a = capcomOf(input.agents);
  if (a?.modelControl?.phase === 'failed') return state('error', 'MODEL ERROR', a.modelControl.detail || 'Open the model controls or terminal to review the failure.', 'var(--red)');
  if (a?.resetControl?.phase === 'failed') return state('error', 'NEW CAPCOM ERROR', a.resetControl.detail || 'Open the model controls or terminal to review the failure.', 'var(--red)');
  if (a?.modelControl?.phase === 'applying') return state('processing', 'CHANGING MODEL', a.modelControl.detail || 'Waiting for the CLI to confirm the model change.');
  if (a?.resetControl?.phase === 'applying') return state('processing', 'CLEARING CONTEXT', a.resetControl.detail || 'Waiting for the CLI to confirm the new session.');
  if (a?.state === 'blocked' && a.block?.kind === 'error') return state('error', 'CAPCOM ERROR', a.block.summary, 'var(--red)');
  if (a?.state === 'booting') return state('loading', 'STARTING', 'Waiting for CAPCOM activity. No reply confirmed yet.');
  const turn = capcomTurn(input.agents, { thinking: input.thinking });
  if (turn.kind === 'working') return state('processing', a?.block?.kind === 'peer' ? 'WAITING ON AGENT' : 'PROCESSING',
    a?.block?.kind === 'peer' ? a.block.summary : a?.toolDetail || turn.tool || 'CAPCOM is working.', a?.block?.kind === 'peer' ? 'var(--st-thinking)' : 'var(--lime)');
  if (turn.kind === 'thinking') return state('processing', 'THINKING', 'CAPCOM is processing. A reply has not finished.');
  if (turn.kind === 'waiting') return state('waiting', 'WAITING ON YOU', a?.block?.summary || 'CAPCOM needs your input.', 'var(--amber)');
  if (a?.modelControl?.phase === 'queued') return state('processing', 'MODEL CHANGE QUEUED', a.modelControl.detail || 'Waiting for the current turn to finish.');
  if (a?.resetControl?.phase === 'queued') return state('processing', 'NEW CAPCOM QUEUED', a.resetControl.detail || 'Waiting for CAPCOM to be idle.');
  if (a) return state('ready', 'READY', 'CAPCOM is idle. Ready for a message.', 'var(--lime)');
  return state('unavailable', 'NO ACTIVE SESSION', 'Waiting for CAPCOM to appear. Start one with orca capcom if needed.', 'var(--ink-dim)');
}
