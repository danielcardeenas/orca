/// <reference types="vite/client" />
/**
 * The update sentinel: "UPDATE AVAILABLE · CLICK TO RELOAD".
 *
 * The console never reloads itself. A reload in the middle of a sentence to
 * CAPCOM is a lost sentence and a lost train of thought, and with several
 * workers editing the UI at once the page was flashing every few seconds.
 * So the page only ever changes under the operator's hand: something says a
 * newer build exists, this pill lights up, and the click is the reload.
 * Drafts (drafts.ts) come back on the other side either way.
 *
 * ── The signal, in development ───────────────────────────────────────
 *
 * Vite's own HMR client cannot be the one that stops the reload: in Vite
 * 6.4 `notifyListeners('vite:beforeFullReload')` runs the listeners with
 * `Promise.allSettled`, so a listener that throws — the trick that used to
 * cancel it — is swallowed and `pageReload()` runs anyway. What does work
 * is `server.hmr: false` in vite.config.ts: with it the server never sends
 * `full-reload` (nor js updates), while it still invalidates its module
 * graph on every file change, so the manual reload gets fresh code. The
 * signal then comes from a small plugin in the same file: it watches the
 * files the running page actually imports and sends a custom `orca:update`
 * event down the dev WebSocket, which stays connected with HMR off and
 * still forwards `custom` payloads. Instant, no polling, and only for files
 * that matter to this page — editing a test or the hub lights nothing.
 *
 * ── The signal, in production ────────────────────────────────────────
 *
 * The hub serves dist/ with three cache policies (src/hub/server.ts):
 * `index.html` is `no-store`, and the `/assets/*` it points at carry a
 * content hash in the name. So the set of `/assets/*` paths in the index
 * *is* the build id. The sentinel remembers the set the page was loaded
 * with (read from `<head>`) and, every minute, when the tab comes back into
 * view, and when the link to the hub comes back up (a hub restart is when a
 * new build lands), fetches the index again and compares. In development
 * the index has no hashed assets, so that baseline is empty and the poll
 * never starts.
 *
 * ── La otra mitad: el hub ────────────────────────────────────────────
 *
 * Recargar actualiza la consola y nada más. El hub carga su código al
 * arrancar y no lo vuelve a mirar, así que después de publicar puede quedar
 * un bundle nuevo hablando con un proceso viejo — y el síntoma de eso no se
 * parece a la causa. Por eso hay una segunda píldora, con un texto distinto
 * porque la acción es distinta: ésta no se arregla con un clic, se arregla
 * reiniciando ORCA. El hub la manda (`server` en shared/protocol.ts,
 * hub/source-rev.ts); aquí sólo se pinta.
 *
 * `buildFingerprint` and `createUpdateSentinel` are DOM-free so the logic
 * is tested in test/update.test.ts without a browser.
 */

import { drafts } from '../drafts.ts';
import { hub } from '../net/client.ts';
import { store } from '../store.ts';
import { activatePending, registerServiceWorker } from '../pwa.ts';

/** The hashed asset paths an index.html refers to, sorted, one per line. Empty when there are none. */
export function buildFingerprint(html: string): string {
  const seen = new Set<string>();
  const re = /\b(?:src|href)=["']?(\/assets\/[^"'\s>]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) seen.add(m[1]!);
  return [...seen].sort().join('\n');
}

export interface SentinelIO {
  /** The current index.html, or null when it could not be read (offline, 5xx). */
  fetchIndex(): Promise<string | null>;
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

export interface UpdateSentinel {
  available(): boolean;
  /** Why the build is newer: a file path in dev, `build` in production. */
  reason(): string | null;
  /** Something outside said a newer build exists. Idempotent. */
  mark(reason: string): void;
  /** Compare the served index with the baseline. Resolves to `available()`. */
  check(): Promise<boolean>;
  /** Poll every `intervalMs` — only with a hashed baseline, and only until a build shows up. */
  start(): void;
  stop(): void;
  onChange(fn: (reason: string) => void): void;
}

export const UPDATE_POLL_MS = 60_000;

/**
 * Cuánto se espera a que el enlace se caiga después de pedir el relevo. Un hub
 * que iba a reiniciarse lo hace en menos de un segundo; pasado esto, lo que
 * hubo es un frame que no llegó o un hub que dijo que no.
 */
export const RESTART_GIVE_UP_MS = 15_000;

export function createUpdateSentinel(baseline: string, io: SentinelIO, intervalMs = UPDATE_POLL_MS): UpdateSentinel {
  let reason: string | null = null;
  let timer: number | null = null;
  let checking: Promise<boolean> | null = null;
  const listeners: ((reason: string) => void)[] = [];

  const sentinel: UpdateSentinel = {
    available: () => reason !== null,
    reason: () => reason,
    mark(why) {
      if (reason !== null) return;
      reason = why;
      sentinel.stop();
      for (const fn of listeners) fn(why);
    },
    check() {
      if (reason !== null || !baseline) return Promise.resolve(reason !== null);
      // One fetch in flight: a burst of triggers (visible + link up) is one request.
      if (checking) return checking;
      checking = (async () => {
        try {
          const html = await io.fetchIndex();
          const now = html ? buildFingerprint(html) : '';
          if (now && now !== baseline) sentinel.mark('build');
        } catch { /* offline or a 5xx: nothing to say; the next check will */ }
        finally { checking = null; }
        return reason !== null;
      })();
      return checking;
    },
    start() {
      if (timer !== null || reason !== null || !baseline) return;
      const tick = () => {
        timer = io.set(() => { void sentinel.check().then(() => { if (timer !== null) tick(); }); }, intervalMs);
      };
      tick();
    },
    stop() {
      if (timer !== null) io.clear(timer);
      timer = null;
    },
    onChange(fn) { listeners.push(fn); },
  };
  return sentinel;
}

/**
 * La píldora del servidor: se enciende cuando el hub dice que lo que corre ya
 * no es lo que hay escrito.
 *
 * Es un botón sólo cuando puede serlo. Un hub bajo `tools/supervise.mjs` sabe
 * pedirse el relevo (shared/restart.ts) y entonces el clic lo reinicia de
 * verdad; sin supervisor no hay nada que pulsar y el aviso se queda en lo que
 * era, un cartel que dice qué hacer en la terminal. Ofrecer un botón que no
 * puede funcionar es peor que no ofrecerlo: el operador cree que ya está.
 *
 * El relevo no tiene ack —lo que contestaría es justo lo que se muere—, así
 * que la confirmación es el enlace: cae, vuelve, y ahí sí se recarga sola.
 * Recargar aquí no rompe la doctrina, la cumple: el clic ES la autorización, y
 * dejar la consola vieja hablando con el hub nuevo sería la única forma de que
 * ese clic terminara en algo peor de lo que arregló. Si el enlace no llega a
 * caerse, no pasó nada y la píldora vuelve a ofrecerlo.
 */
function mountServerPill(host: HTMLElement, ask: () => void): () => void {
  const el = document.createElement('button');
  el.className = 'update update--server';
  el.type = 'button';
  el.hidden = true;
  host.appendChild(el);

  /** `asked`: se pidió y el enlace sigue arriba. `down`: ya cayó; al volver, recarga. */
  let phase: 'idle' | 'asked' | 'down' = 'idle';
  let giveUp: number | null = null;

  const label = (text: string) => {
    el.innerHTML = `<i class="update__dot" aria-hidden="true"></i>${text}`;
  };

  const paint = () => {
    const s = store.server;
    el.hidden = s?.stale !== true;
    if (phase !== 'idle') {
      el.disabled = true;
      label('RESTARTING ORCA · WAITING FOR THE LINK');
      el.title = 'El hub se está reiniciando. La consola se recargará sola en cuanto vuelva.';
      return;
    }
    el.disabled = s?.restartable !== true;
    label(s?.restartable === true ? 'SERVER CODE CHANGED · CLICK TO RESTART' : 'SERVER CODE CHANGED · RESTART ORCA');
    el.title = s?.restartable === true
      ? 'Se public\u00f3 c\u00f3digo del hub o del collector despu\u00e9s de que este proceso arrancara. '
        + 'El clic los reinicia y recarga la consola; los agentes no se tocan.'
      : 'Se public\u00f3 c\u00f3digo del hub o del collector despu\u00e9s de que este proceso arrancara. '
        + 'Recargar la p\u00e1gina no lo aplica y este hub no corre bajo supervisor: rein\u00edcialo con npm run prod.';
  };

  el.addEventListener('click', () => {
    if (phase !== 'idle' || store.server?.restartable !== true) return;
    // Lo que se estuviera escribiendo, al disco antes de que se caiga el cable.
    drafts.flush();
    phase = 'asked';
    paint();
    ask();
    // Si el enlace ni se inmuta, no pasó nada: se devuelve el botón en vez de
    // dejar al operador mirando un "reiniciando" que no reinicia.
    giveUp = window.setTimeout(() => {
      if (phase !== 'asked') return;
      phase = 'idle';
      paint();
    }, RESTART_GIVE_UP_MS);
  });

  paint();
  const off = store.on((e) => {
    if (e.k === 'server') { paint(); return; }
    if (e.k !== 'link') return;
    if (phase === 'asked' && !e.up) { phase = 'down'; return; }
    if (phase === 'down' && e.up) {
      if (giveUp !== null) window.clearTimeout(giveUp);
      location.reload();
    }
  });

  return () => {
    if (giveUp !== null) window.clearTimeout(giveUp);
    off();
    el.remove();
  };
}

/** The pill in the HUD. Hidden until a build shows up; the click is the reload. */
export function mountUpdate(host: HTMLElement): { sentinel: UpdateSentinel; dispose(): void } {
  const el = document.createElement('button');
  el.className = 'update px';
  el.type = 'button';
  el.hidden = true;
  el.innerHTML = `<i class="update__dot" aria-hidden="true"></i>UPDATE AVAILABLE · CLICK TO RELOAD`;
  host.appendChild(el);

  const sentinel = createUpdateSentinel(buildFingerprint(document.head.innerHTML), {
    fetchIndex: async () => {
      // The hub answers `/` with dist/index.html and `no-store`; the query defeats any cache in between.
      const res = await fetch(`/?update=${Date.now().toString(36)}`, { cache: 'no-store', credentials: 'same-origin' });
      return res.ok ? res.text() : null;
    },
    set: (fn, ms) => window.setTimeout(fn, ms),
    clear: (h) => window.clearTimeout(h),
  });

  sentinel.onChange((why) => {
    el.hidden = false;
    el.title = why === 'build' ? 'The hub is serving a newer build' : `Changed: ${why}`;
  });
  el.addEventListener('click', () => {
    // The last keystrokes may still be inside the debounce; land them first.
    drafts.flush();
    /*
     * And hand over to the waiting service worker before reloading, or the
     * reload would be served by the old one from the old cache and the pill
     * would need a second click. Resolves right away when there is no worker
     * (development, or an origin without https), so the reload is never held.
     */
    void activatePending().then(() => location.reload(), () => location.reload());
  });

  /*
   * The installable console (docs/PWA.md). Registering here and not in main.ts
   * is deliberate: the worker's only visible effect is this pill, and a worker
   * waiting to take over is exactly what the pill announces. Development and
   * plain http do nothing — see pwa.ts.
   */
  registerServiceWorker((why) => sentinel.mark(why));

  // Development: the plugin in vite.config.ts says which file changed.
  import.meta.hot?.on('orca:update', (data: { file?: string } | undefined) => sentinel.mark(data?.file ?? 'source'));

  // Production: poll, and look again at the moments a build is likely to have landed.
  sentinel.start();
  const onVisible = () => { if (document.visibilityState === 'visible') void sentinel.check(); };
  document.addEventListener('visibilitychange', onVisible);
  const off = store.on((e) => { if (e.k === 'link' && e.up) void sentinel.check(); });

  const unmountServer = mountServerPill(host, () => hub.restart());

  return {
    sentinel,
    dispose() {
      unmountServer();
      sentinel.stop();
      document.removeEventListener('visibilitychange', onVisible);
      off();
      el.remove();
    },
  };
}
