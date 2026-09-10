import { agentStopReason } from '../../shared/agent-stop.ts';
import type { Console } from '../console.ts';
import { hub } from '../net/client.ts';
import { store } from '../store.ts';
import { esc, stateWord } from '../util.ts';
import './agent-stop.css';

export function stopUnavailable(id: string): string | null {
  return !store.linkUp ? 'No link to the hub' : agentStopReason(store.world.agents[id], Object.values(store.world.missions ?? {}));
}

let current: HTMLDialogElement | null = null;
/** One explicit decision; never dispatch on opening, cancellation or repeated clicks. */
export function requestAgentStop(c: Pick<Console, 'note'>, id: string): void {
  if (current?.open) { current.focus(); return; }
  const unavailable = stopUnavailable(id);
  if (unavailable) { c.note(unavailable, 'warn'); return; }
  const a = store.world.agents[id]!;
  const resumeHint = a.runtime === 'claude' || a.runtime === 'codex'
    ? 'Use RESUME to continue with its context.' : 'The transcript remains available on disk.';
  const dialog = document.createElement('dialog');
  current = dialog;
  dialog.className = 'agent-stop';
  dialog.setAttribute('aria-labelledby', 'agent-stop-title');
  dialog.innerHTML = `<form class="sec">
    <h2 class="px" id="agent-stop-title">STOP ${esc(a.callsign)}?</h2>
    <p class="mono">${esc(stateWord(a))} · ${esc(a.runtime)}</p>
    <p class="mono">Ends this session, including its current turn. The conversation and files stay. ${resumeHint}</p>
    <label class="px" for="agent-stop-reason">REASON</label>
    <textarea class="input" id="agent-stop-reason" required maxlength="500" rows="2">Stopped manually by the operator</textarea>
    <p class="mono" role="status" aria-live="polite" data-status></p>
    <div class="row"><button class="btn" type="button" data-cancel autofocus>CANCEL</button><button class="slab-btn slab-btn--red slab-btn--sm" type="submit">CONFIRM STOP</button></div>
  </form>`;
  const form = dialog.querySelector('form')!;
  const reason = dialog.querySelector('textarea')!;
  const status = dialog.querySelector<HTMLElement>('[data-status]')!;
  const submit = dialog.querySelector<HTMLButtonElement>('[type=submit]')!;
  const cancel = dialog.querySelector<HTMLButtonElement>('[data-cancel]')!;
  let busy = false;
  let finished = false;
  const refresh = () => {
    if (busy || finished) return;
    const why = stopUnavailable(id);
    status.textContent = why ?? '';
    submit.disabled = !!why || !reason.value.trim();
  };
  const off = store.on(refresh);
  dialog.addEventListener('close', () => { off(); dialog.remove(); if (current === dialog) current = null; });
  dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
  // Keep window/global shortcuts out of the protected decision.
  dialog.addEventListener('keydown', e => e.stopPropagation());
  cancel.onclick = () => dialog.close();
  reason.oninput = refresh;
  form.onsubmit = async e => {
    e.preventDefault();
    if (busy || finished) return;
    refresh();
    if (submit.disabled) return;
    busy = true; submit.disabled = true; cancel.disabled = true; reason.disabled = true;
    status.textContent = 'Stop requested · waiting for the collector';
    try {
      // Same command/ack path as stop_agent; never remove, archive or delete a transcript.
      const out = await hub.cmd({ k: 'stop', agentId: id, reason: reason.value.trim() }) as { detail?: string } | undefined;
      finished = true;
      status.textContent = `Stop acknowledged${out?.detail ? ` · ${out.detail}` : ''}. Conversation kept. ${resumeHint}`;
      c.note(`stop acknowledged for ${a.callsign}: ${reason.value.trim()} · conversation kept`, 'warn');
      submit.hidden = true; cancel.textContent = 'CLOSE';
    } catch (error) {
      status.textContent = `Stop not confirmed: ${(error as Error).message}. Check the session before retrying.`;
      c.note(status.textContent, 'alert');
      // Explicit new decision required after an ambiguous timeout.
      finished = true; submit.hidden = true; cancel.textContent = 'CLOSE';
    } finally { busy = false; cancel.disabled = false; cancel.focus(); }
  };
  document.body.append(dialog);
  refresh();
  dialog.showModal();
}
