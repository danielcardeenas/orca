import { store } from '../store.ts';
import { esc } from '../util.ts';

/** Local echo and collector receipts, shared by every conversation entry point. */
export function mountDelivery(host: HTMLElement, agentId: string | null, taskId?: () => string | null) {
  const render = () => {
    const messages = store.outgoing.filter((m) => m.agentId === agentId && (m.taskId ?? null) === (taskId?.() ?? null)).slice(-3);
    host.hidden = !messages.length;
    host.innerHTML = messages.map((m) => {
      const label = m.status === 'sending' ? 'SENDING…'
        : m.status === 'failed' ? 'DELIVERY UNCONFIRMED'
        : m.status === 'accepted' ? 'ACCEPTED BY COMMAND'
        : `SENT TO AGENT · ${((m.elapsedMs ?? 0) / 1000).toFixed(1)}s`;
      return `<div class="delivery__message"><div class="px px--tiny" style="color:var(${m.status === 'failed' ? '--amber' : '--ink-dim'})">${esc(label)}</div><div class="mono">${esc(m.text)}</div>${m.detail ? `<div class="mono" style="color:var(--amber)">${esc(m.detail)}</div>` : ''}</div>`;
    }).join('');
    host.scrollTop = host.scrollHeight;
  };
  host.classList.add('delivery');
  host.setAttribute('role', 'log');
  host.setAttribute('aria-live', 'polite');
  const off = store.on((e) => { if (e.k === 'delivery' || e.k === 'tasks') render(); });
  render();
  return off;
}
