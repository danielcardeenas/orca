import type { Agent } from '../../shared/types.ts';
import { quotaIncident, type RecoveryDecision } from '../../shared/recovery.ts';
import type { Command } from '../../shared/protocol.ts';

/** Stable inputs: fleet updates must not overwrite the operator's chosen review time. */
export function mountAgentRecovery(host: HTMLElement, command: (c: Command) => Promise<unknown>, openAgent: (id: string) => void) {
  host.className = 'capcom__model';
  host.innerHTML = '<div class="mono" data-recovery-status role="status"></div><div class="row row--wrap"><label class="mono">Review at <input class="input" type="datetime-local" aria-label="Recovery review time" data-review-at></label><input class="input" aria-label="Reason for waiting" placeholder="Reason for waiting" data-reason><button class="chip" type="button" data-wait>WAIT</button><button class="chip" type="button" data-continued hidden>OPEN CONTINUED AGENT</button></div>';
  const status = host.querySelector<HTMLElement>('[data-recovery-status]')!;
  const at = host.querySelector<HTMLInputElement>('[data-review-at]')!;
  const reason = host.querySelector<HTMLInputElement>('[data-reason]')!;
  const wait = host.querySelector<HTMLButtonElement>('[data-wait]')!;
  const next = host.querySelector<HTMLButtonElement>('[data-continued]')!;
  let a: Agent | undefined; let connected = false; let busy = false; let disposed = false;
  let decision: RecoveryDecision | null = null; let error = ''; let lastRead = 0;
  function paint() {
    host.hidden = !a || (!quotaIncident(a) && !decision);
    status.textContent = error || (decision ? `${decision.action.toUpperCase()} · ${decision.phase} · ${decision.reason}${decision.reviewAt ? ` · review ${new Date(decision.reviewAt).toLocaleString()}` : ''}. ${decision.detail}` : 'Usage limit reached. Change model, review a provider handoff, or wait until a chosen review time.');
    wait.disabled = busy || !connected || !a || !quotaIncident(a) || (!!decision && ['applying', 'ready', 'resuming'].includes(decision.phase));
    next.hidden = !decision?.toId; next.onclick = () => { if (decision?.toId) openAgent(decision.toId); };
  }
  async function refresh() {
    if (!a || !connected || busy || disposed) return;
    const id = a.id; lastRead = Date.now();
    try { const data = await command({ k: 'recovery:status', agentId: id }) as { decision: RecoveryDecision | null }; if (!disposed && a?.id === id) { decision = data.decision; paint(); } }
    catch (e) { if (!disposed) { error = String(e); paint(); } }
  }
  wait.addEventListener('click', async () => {
    const incident = a && quotaIncident(a); if (!a || !incident) return;
    if (!at.value || !reason.value.trim()) { error = 'Choose a review time and explain why waiting is preferable.'; paint(); return; }
    busy = true; error = ''; paint();
    try { decision = await command({ k: 'recovery:decide', agentId: a.id, decision: { incident: incident.id, action: 'wait', reviewAt: new Date(at.value).getTime(), reason: reason.value } }) as RecoveryDecision; }
    catch (e) { error = String(e); }
    finally { busy = false; if (!disposed) paint(); }
  });
  return { update(agent: Agent | undefined, link: boolean) { a = agent; connected = link; paint(); if (a && (quotaIncident(a) || decision) && Date.now() - lastRead > 15000) void refresh(); }, dispose() { disposed = true; } };
}
