/** A visible installed console may hold the display; hidden pages release it. */
export function mountWakeLock() {
  const display = matchMedia('(display-mode: standalone), (display-mode: fullscreen)');
  let lock: WakeLockSentinel | null = null;
  let pending = false;
  let disposed = false;
  let enabled = true;
  try { enabled = localStorage.getItem('orca.wake') !== 'off'; } catch { /* private mode */ }
  const wanted = () => enabled && !disposed && document.visibilityState === 'visible' &&
    (display.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
  async function sync() {
    if (!wanted()) { const old = lock; lock = null; await old?.release().catch(() => {}); return; }
    if (lock || pending || !('wakeLock' in navigator)) return;
    pending = true;
    try {
      const next = await navigator.wakeLock.request('screen');
      if (!wanted()) { await next.release(); return; }
      lock = next;
      next.addEventListener('release', () => { if (lock === next) lock = null; });
    } catch { /* OS battery policy and unsupported contexts are normal. */ }
    finally { pending = false; }
  }
  const changed = () => { void sync(); };
  document.addEventListener('visibilitychange', changed);
  display.addEventListener('change', changed);
  changed();
  return {
    get enabled() { return enabled; },
    set(on: boolean) { enabled = on; try { localStorage.setItem('orca.wake', on ? 'on' : 'off'); } catch { /* private mode */ } changed(); },
    dispose() { disposed = true; document.removeEventListener('visibilitychange', changed); display.removeEventListener('change', changed); changed(); },
  };
}
