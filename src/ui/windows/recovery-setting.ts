import type { Command } from '../../shared/protocol.ts';
import { toggle } from '../controls.ts';

export function mountRecoverySetting(host: HTMLElement, command: (cmd: Command) => Promise<unknown>, connected: () => boolean) {
  host.innerHTML = '<div class="set__row"><span class="px px--tiny set__lab">RECOVERY</span><div data-switch></div></div><p class="mono set__hint">When an agent reaches its usage limit, ask its lead or CAPCOM to choose a model change, provider handoff, or wait. Applies to the whole fleet, including agents already blocked.</p><p class="mono set__hint">Turning this off stops new automatic reviews. Recorded decisions and scheduled reviews continue.</p><p class="mono set__hint" role="status" aria-live="polite" data-status></p><button class="btn" type="button" data-retry hidden>RETRY</button>';
  const status = host.querySelector<HTMLElement>('[data-status]')!;
  const retry = host.querySelector<HTMLButtonElement>('[data-retry]')!;
  let saved: boolean | undefined; let busy = false; let disposed = false; let revision = 0;
  const control = toggle({ name: 'automaticRecovery', label: 'AUTOMATIC REVIEW', onChange: on => { void save(on); } });
  const button = control.el as HTMLButtonElement;
  // toggle's keyboard handler invokes click explicitly, so guard disabled clicks too.
  button.addEventListener('click', e => { if (button.disabled) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  host.querySelector('[data-switch]')!.appendChild(button);
  function paint() { button.disabled = busy || saved === undefined || !connected(); }
  async function refresh() {
    if (busy || disposed) return;
    if (!connected()) { status.textContent = 'Reconnect to read or change this fleet setting.'; paint(); return; }
    const version = ++revision;
    try {
      const data = await command({ k: 'recovery:settings' }) as { automatic: boolean };
      if (disposed || version !== revision) return;
      saved = data.automatic; control.set(saved); retry.hidden = true;
      status.textContent = `${saved ? 'On' : 'Off'} · Saved on the hub. Changes apply immediately and survive restarts.`;
    } catch (e) {
      if (disposed || version !== revision) return;
      saved = undefined; status.textContent = `Could not read settings: ${String(e)}`; retry.hidden = false;
    }
    paint();
  }
  async function save(on: boolean) {
    if (busy || saved === undefined || !connected()) return;
    ++revision; busy = true; status.textContent = 'Saving…'; retry.hidden = true; paint();
    try {
      const data = await command({ k: 'recovery:settings', automatic: on }) as { automatic: boolean };
      if (!disposed) { saved = data.automatic; control.set(saved); status.textContent = `${saved ? 'On' : 'Off'} · Saved for the whole fleet. Applies immediately.`; }
    } catch (e) {
      if (!disposed) { control.set(saved); saved = undefined; status.textContent = `Save unconfirmed. Reload the setting before trying again: ${String(e)}`; retry.hidden = false; }
    } finally { busy = false; if (!disposed) paint(); }
  }
  retry.addEventListener('click', () => { void refresh(); });
  paint(); void refresh();
  const timer = window.setInterval(() => { void refresh(); }, 10000);
  return { refresh, dispose() { disposed = true; ++revision; window.clearInterval(timer); control.dispose(); } };
}
