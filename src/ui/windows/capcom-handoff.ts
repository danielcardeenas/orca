import { handoffReason, type CapcomHandoff } from '../../shared/handoff.ts';
import { esc } from '../util.ts';
import { noticeHtml } from './notice.ts';

/**
 * El acta de un cambio de sesión, plegada a una línea.
 *
 * Dice dónde quedó la conversación anterior y por qué cambió el mando, que es
 * exactamente lo que se quiere leer una vez y no volver a ver. Ver `notice.ts`.
 */
export function handoffNotice(h: CapcomHandoff): string {
  const button = (file: string | null, label: string) => file
    ? `<button class="chip" type="button" data-handoff-file="${esc(file)}">${label}</button>` : '';
  return noticeHtml({
    id: `handoff:${h.id}`,
    className: 'capcom__handoff',
    ariaLabel: 'CAPCOM session handoff',
    title: 'SESSION CHANGED',
    summary: `${h.fromModel ?? h.fromRuntime} → ${h.toModel ?? h.toRuntime}`,
    when: h.at,
    body: `${esc(handoffReason(h))}. ${h.historyPath ? 'Earlier messages are archived. Load them in TALK or open the original history below.' : 'No earlier-history link was recorded.'}`,
    actions: `${button(h.historyPath, 'OPEN PREVIOUS CONVERSATION')}${button(h.checkpointPath, 'HANDOFF NOTES')}`,
  });
}
