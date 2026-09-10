import { authedUrl } from './net/client.ts';
import { toggle } from './controls.ts';
import type { mountWakeLock } from './wake-lock.ts';

async function api(method: string, value?: unknown) {
  const response = await fetch(authedUrl('/api/push')!, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(value ? { body: JSON.stringify(value) } : {}), cache: 'no-store',
  });
  if (!response.ok) throw new Error(response.status === 503 ? 'Push unavailable in this hub.' : 'Could not save notifications. Check the hub connection and retry.');
  return response.json() as Promise<{ publicKey: string }>;
}
export function mountPushSettings(el: HTMLElement, wake: ReturnType<typeof mountWakeLock>) {
  el.innerHTML = `<div class="sec__k px">THIS DEVICE</div>
    <div class="set__row"><label class="px px--tiny set__lab">PUSH</label><button type="button" class="btn" data-push disabled>CHECKING…</button></div>
    <p class="px px--tiny set__hint" data-push-hint role="status">Alerts when an agent needs you, even with ORCA closed.</p>
    <div class="set__row"><label class="px px--tiny set__lab">SCREEN</label><div data-wake></div></div>
    <p class="px px--tiny set__hint">Keep the screen awake while the installed app is visible.</p>`;
  const button = el.querySelector<HTMLButtonElement>('[data-push]')!;
  const hint = el.querySelector<HTMLElement>('[data-push-hint]')!;
  const control = toggle({ name: 'wakeLock', label: 'KEEP AWAKE', checked: wake.enabled, onChange: on => wake.set(on) });
  el.querySelector('[data-wake]')!.append(control.el);
  let registration: ServiceWorkerRegistration | undefined;
  let sub: PushSubscription | null = null;
  let disposed = false;
  const supported = isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const paint = () => { button.textContent = sub ? 'DISABLE PUSH' : 'ENABLE PUSH'; button.disabled = !registration; };
  if (!supported) {
    button.textContent = 'UNAVAILABLE';
    hint.textContent = 'Push needs HTTPS and browser support. On iPhone, open ORCA from the Home Screen.';
  } else {
    void navigator.serviceWorker.getRegistration('/').then(async r => {
      if (disposed) return;
      registration = r?.active ? r : undefined;
      sub = await registration?.pushManager.getSubscription() ?? null;
      if (disposed) return;
      if (!registration) hint.textContent = 'Install the production app, then reopen settings once it is ready.';
      else if (sub) { await api('POST', sub.toJSON()); }
      if (!disposed) paint();
    }).catch(() => { paint(); hint.textContent = 'Could not sync notifications. Check your connection and reopen settings.'; });
  }
  button.onclick = () => {
    if (!registration) return;
    const r = registration;
    button.disabled = true;
    // Permission must start in the click stack, before the network request (iOS).
    const permission = sub ? Promise.resolve('granted') : Notification.requestPermission();
    void permission.then(async grant => {
      if (sub) {
        await api('DELETE', { endpoint: sub.endpoint });
        await sub.unsubscribe(); sub = null;
        hint.textContent = 'Notifications disabled on this device.';
      } else {
        if (grant !== 'granted') throw new Error('Notifications not allowed. Change the permission in browser settings to enable them.');
        const { publicKey } = await api('GET');
        const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        const created = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
        try { await api('POST', created.toJSON()); }
        catch (err) { await created.unsubscribe(); throw err; }
        sub = created;
        hint.textContent = 'Notifications enabled on this device.';
      }
    }).catch(err => { hint.textContent = err instanceof Error ? err.message : 'Could not change notifications. Retry.'; }).finally(() => { if (!disposed) paint(); });
  };
  return () => { disposed = true; button.onclick = null; control.dispose(); };
}

/** Reconcile an existing subscription after the hub comes back; never request permission. */
export async function syncPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const r = await navigator.serviceWorker.getRegistration('/');
  const s = await r?.pushManager.getSubscription();
  if (s) await api('POST', s.toJSON());
}
