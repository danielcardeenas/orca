/**
 * ORCA — service worker.
 *
 * Existe por tres razones, en este orden:
 *
 *  1. Recibir notificaciones aunque la consola esté cerrada.
 *  2. Cuando el enlace se cae —la tailnet, el wifi del sitio, el portátil
 *     dormido— lo que sale es ORCA con su LINK DOWN, no el dinosaurio del
 *     navegador. La consola ya sabe decir que no hay hub; lo que no puede es
 *     decirlo si no llega a cargarse.
 *  3. El arranque desde la caché es instantáneo, que en un teléfono al que se
 *     mira diez segundos cada vez es la diferencia entre mirar y no mirar.
 *
 * ── Lo que NUNCA se cachea ───────────────────────────────────────────
 *
 * Todo lo que es el hub: `/api`, `/ws`, `/mcp`. Una consola de tiempo real
 * que sirve un mundo de hace cinco minutos desde una caché es peor que una
 * consola caída, porque parece que funciona. Aquí sólo se guarda el
 * instrumento —el html, el js, las fuentes, los iconos, los sonidos—, nunca
 * lo que el instrumento mide.
 *
 * ── Actualizaciones: el worker tampoco recarga solo ──────────────────
 *
 * La doctrina de `ui/hud/update.ts` es que la página no cambia bajo la mano
 * del operador: un build nuevo enciende una píldora y el clic es la recarga.
 * Un service worker con `skipWaiting()` en `install` rompe justo eso —el
 * siguiente fetch cambiaría de build a media frase—, así que aquí no lo hay:
 * el worker nuevo se queda en `waiting` hasta que la página le manda
 * `orca:activate`, que es lo que hace ese clic y nada más.
 *
 * Se prueba en test/sw.test.ts: las decisiones viven en funciones puras que
 * el test carga de ESTE archivo, no de una copia.
 */

/* eslint-env serviceworker */

const VERSION = 'v1';
const SHELL = `orca-shell-${VERSION}`;
const ASSETS = `orca-assets-${VERSION}`;
const MINE = new Set([SHELL, ASSETS]);

/**
 * El casco: lo que tiene nombre fijo y hace falta para pintar algo.
 * Los `/assets/*` no están aquí porque llevan hash en el nombre y no se
 * conocen sin leer el index; de eso se encarga `precache()`.
 */
const SHELL_FILES = [
  '/',
  '/recovery.js',
  '/recovery.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/fonts/tiny5.woff2',
  '/fonts/geist-mono.woff2',
];

/* ── Decisiones ───────────────────────────────────────────────────── */

/**
 * Qué hacer con una ruta. Cuatro respuestas y ninguna más:
 *
 *   pass       no es asunto nuestro: va a la red y no se guarda.
 *   immutable  `/assets/*`, con hash en el nombre: caché primero, para siempre.
 *   shell      nombre fijo: se sirve de caché y se revalida por detrás.
 *   index      el html: red primero, caché sólo si no hay red.
 *
 * `index` va a la red primero a propósito. El index es lo que apunta a los
 * assets con hash, o sea que es el build entero: servirlo de caché dejaría la
 * consola pegada a una versión vieja hasta que alguien vaciara datos del
 * sitio. Y es lo que lee el centinela de `hud/update.ts` para saber si hay
 * build nuevo; devolverle una copia sería mentirle.
 */
function policy(pathname) {
  if (pathname === '/api' || pathname.startsWith('/api/')) return 'pass';
  if (pathname === '/ws' || pathname.startsWith('/ws/')) return 'pass';
  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) return 'pass';
  if (pathname.startsWith('/assets/')) return 'immutable';
  if (pathname === '/' || pathname === '/index.html') return 'index';
  if (SHELL_FILES.includes(pathname)) return 'shell';
  if (pathname.startsWith('/fonts/') || pathname.startsWith('/sfx/')) return 'shell';
  /*
   * Cualquier otra cosa: a la red sin guardar. El hub contesta el index a
   * toda ruta desconocida (SPA), así que cachear por su url guardaría el
   * mismo html bajo veinte claves distintas. Las navegaciones a esas rutas
   * sí se atienden —ver el `fetch` de abajo—, pero bajo la clave `/`.
   */
  return 'pass';
}

/** Los `/assets/*` a los que apunta un index. La misma lectura que `buildFingerprint`. */
function assetsIn(html) {
  const seen = new Set();
  const re = /\b(?:src|href)=["']?(\/assets\/[^"'\s>]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) seen.add(m[1]);
  return [...seen];
}

/**
 * Qué sobra en la caché de assets. Cada build deja los suyos con un hash
 * nuevo, así que sin podar la caché crece un build tras otro en un teléfono
 * que nunca la vacía. Lo que el index vivo no nombra, ya no lo pide nadie.
 */
function prunable(cachedUrls, html) {
  const live = new Set(assetsIn(html));
  return cachedUrls.filter((u) => {
    let path;
    try { path = new URL(u, 'http://orca.local').pathname; } catch { return false; }
    return path.startsWith('/assets/') && !live.has(path);
  });
}

/* ── Instalación ──────────────────────────────────────────────────── */

/**
 * El casco, y además los assets del build que se está sirviendo ahora.
 *
 * Sin ese segundo paso el primer arranque sin red no pintaría nada: el index
 * estaría en caché y su javascript no. Se leen del propio index en vez de
 * mantener una lista con hashes que habría que regenerar en cada build — una
 * lista así se desactualiza el día que alguien construye sin acordarse.
 */
async function precache() {
  const cache = await caches.open(SHELL);
  // Individual y tolerante: un sfx que falte no puede tumbar la instalación
  // entera, que es lo que hace `addAll`.
  await Promise.all(SHELL_FILES.map((f) => cache.add(f).catch(() => { /* ya se pedirá */ })));
  try {
    const res = await fetch('/', { cache: 'no-store' });
    if (!res.ok) return;
    const paths = assetsIn(await res.text());
    const assets = await caches.open(ASSETS);
    await Promise.all(paths.map((p) => assets.add(p).catch(() => { /* ya se pedirá */ })));
  } catch { /* sin red en la instalación: se llenará al vuelo */ }
}

self.addEventListener('install', (e) => {
  // Sin skipWaiting: ver la cabecera. El worker nuevo espera al clic.
  e.waitUntil(precache());
});

/* ── Activación ───────────────────────────────────────────────────── */

async function sweep() {
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith('orca-') && !MINE.has(n)).map((n) => caches.delete(n)));
  try {
    const res = await fetch('/', { cache: 'no-store' });
    if (!res.ok) return;
    const html = await res.text();
    const assets = await caches.open(ASSETS);
    const keys = await assets.keys();
    for (const url of prunable(keys.map((r) => r.url), html)) await assets.delete(url);
  } catch { /* sin red: se poda en la siguiente activación */ }
}

self.addEventListener('activate', (e) => {
  // `claim()` para que la primera visita quede controlada sin recargar: es lo
  // que hace que el modo avión funcione ya en la segunda apertura, no en la
  // tercera. No provoca ningún cambio visible en la página.
  e.waitUntil(sweep().then(() => self.clients.claim()));
});

/* ── Tráfico ──────────────────────────────────────────────────────── */

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()).catch(() => { /* cuota */ });
  return res;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const live = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone()).catch(() => { /* cuota */ });
    return res;
  });
  if (hit) { live.catch(() => { /* revalidación fallida: da igual, ya hay copia */ }); return hit; }
  return live;
}

/**
 * El index, siempre bajo la clave `/`.
 *
 * El centinela lo pide como `/?update=…` para saltarse cachés intermedias y
 * una navegación puede llegar por cualquier ruta; las tres cosas son el mismo
 * documento y tienen que compartir una sola entrada, o la caché acabaría con
 * una copia por cada url que alguien haya abierto.
 */
async function indexFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) {
      cache.put('/', res.clone()).catch(() => { /* cuota */ });
      return res;
    }
    /*
     * Una respuesta que llega pero no sirve. El caso que importa no es raro,
     * es EL caso: la consola se publica en la tailnet con `tailscale serve`,
     * que sobrevive a ORCA porque vive en tailscaled. Con el portátil dormido
     * o el hub parado, abrir la app instalada no da un error de red —da un
     * 502 del proxy, con la página de Tailscale—, y sin esto la app arrancaría
     * a eso en vez de a su propio casco. Que es justo lo que el worker existe
     * para evitar.
     */
    const stale = await cache.match('/');
    if (stale) return stale;
    return res;
  } catch (err) {
    const hit = await cache.match('/');
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Una navegación es siempre el index, venga por la ruta que venga: el hub
  // contesta lo mismo y el enrutado vive en el cliente.
  const how = req.mode === 'navigate' ? 'index' : policy(url.pathname);

  if (how === 'pass') return;
  if (how === 'index') { e.respondWith(indexFirst(req)); return; }
  if (how === 'immutable') { e.respondWith(cacheFirst(req, ASSETS)); return; }
  e.respondWith(staleWhileRevalidate(req, SHELL));
});

/* ── El relevo ────────────────────────────────────────────────────── */

self.addEventListener('message', (e) => {
  // Lo manda `ui/pwa.ts` cuando el operador pulsa UPDATE AVAILABLE, y nadie más.
  if (e.data && e.data.t === 'orca:activate') self.skipWaiting();
});

// Para el test: las decisiones, sin navegador. No lo usa la consola.
self.ORCA_SW = { policy, assetsIn, prunable, SHELL, ASSETS, SHELL_FILES };

// Every push produces a visible notification, including malformed/empty payloads.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* safe fallback */ }
  event.waitUntil(self.registration.showNotification('ORCA · NEEDS YOU', {
    body: typeof data.body === 'string' ? data.body.slice(0, 160) : 'An agent needs your input.',
    icon: '/icon-192.png', badge: '/icon-192.png', tag: 'orca-human',
    data: { url: '/?queue=1' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ t: 'orca:queue' });
    } else await self.clients.openWindow('/?queue=1');
  })());
});
