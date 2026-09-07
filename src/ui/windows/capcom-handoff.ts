import { handoffReason, type CapcomHandoff } from '../../shared/handoff.ts';
import { esc, clock } from '../util.ts';

export function handoffNotice(h: CapcomHandoff): string {
  const button = (file: string | null, label: string) => file
    ? `<button class="chip" type="button" data-handoff-file="${esc(file)}">${label}</button>` : '';
  return `<aside class="capcom__handoff" aria-label="CAPCOM session handoff">
    <div class="px capcom__handoff-title">SESSION CHANGED <time datetime="${new Date(h.at).toISOString()}" title="${esc(new Date(h.at).toLocaleString())}">${clock(h.at)}</time></div>
    <div class="mono capcom__handoff-models">${esc(h.fromModel ?? h.fromRuntime)} → ${esc(h.toModel ?? h.toRuntime)}</div>
    <p class="mono">${esc(handoffReason(h))}. ${h.historyPath ? 'Earlier messages are archived. Load them in TALK or open the original history below.' : 'No earlier-history link was recorded.'}</p>
    <div class="capcom__handoff-actions">${button(h.historyPath, 'OPEN PREVIOUS CONVERSATION')}${button(h.checkpointPath, 'HANDOFF NOTES')}</div>
  </aside>`;
}
