/**
 * public/sw.js — el service worker que hace instalable la consola.
 *
 * Se prueba el archivo REAL, el mismo que sirve el hub, cargándolo con un
 * `self`, un `caches` y un `fetch` de mentira. Copiar su lógica a un módulo de
 * pruebas habría dejado la copia pasando y el original haciendo otra cosa.
 *
 * Lo que se vigila es, en orden de gravedad:
 *
 *   1. El hub NUNCA se cachea. `/api`, `/ws` y `/mcp` ni se tocan: una consola
 *      de tiempo real sirviendo un mundo viejo desde una caché es peor que una
 *      consola caída, porque parece que funciona.
 *   2. Sin red, una navegación devuelve el index guardado — el arranque a
 *      LINK DOWN en vez del dinosaurio del navegador.
 *   3. El index se guarda bajo una sola clave, `/`, la pida quien la pida.
 *   4. El worker nuevo no toma el mando sin que se lo digan.
 *   5. La caché de assets se poda: un build tras otro no puede llenar el
 *      teléfono con javascript que ya no nombra nadie.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq, ok, test, type TestModule } from './harness.ts';

const SW = fileURLToPath(new URL('../public/sw.js', import.meta.url));
const ORIGIN = 'https://orca.test';

const INDEX_A = `<!doctype html><html><head>
  <link rel="manifest" href="/manifest.webmanifest">
  <script type="module" src="/assets/index-AAA.js"></script>
  <link rel="stylesheet" href="/assets/index-AAA.css"></head><body></body></html>`;
const INDEX_B = INDEX_A.replace(/AAA/g, 'BBB');

interface Req { method: string; url: string; mode?: string }
const get = (path: string, mode = 'cors'): Req => ({ method: 'GET', url: `${ORIGIN}${path}`, mode });
const urlOf = (r: Req | string) => (typeof r === 'string' ? new URL(r, ORIGIN).toString() : r.url);

/** Un CacheStorage suficiente: claves por url absoluta, cuerpos de texto. */
function fakeCaches(fetcher: (r: Req | string) => Promise<Response>) {
  const stores = new Map<string, Map<string, Response>>();
  const api = {
    async open(name: string) {
      let m = stores.get(name);
      if (!m) { m = new Map(); stores.set(name, m); }
      const store = m;
      return {
        async match(r: Req | string) { return store.get(urlOf(r)); },
        async put(r: Req | string, res: Response) { store.set(urlOf(r), res); },
        async add(r: Req | string) { const res = await fetcher(r); if (!res.ok) throw new Error('add'); store.set(urlOf(r), res); },
        async keys() { return [...store.keys()].map((url) => ({ url })); },
        async delete(r: Req | string) { return store.delete(urlOf(r)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name: string) { return stores.delete(name); },
    async match(r: Req | string) { for (const s of stores.values()) { const hit = s.get(urlOf(r)); if (hit) return hit; } return undefined; },
  };
  return { api, stores };
}

/** Carga sw.js en un mundo de mentira y devuelve los mandos. */
function loadSW(opts: { index?: string; offline?: boolean } = {}) {
  let index = opts.index ?? INDEX_A;
  let offline = opts.offline ?? false;
  let badGateway = false;
  let requests = 0;
  let skipped = 0;
  const listeners = new Map<string, ((e: unknown) => void)[]>();

  const fetcher = async (r: Req | string): Promise<Response> => {
    requests++;
    if (offline) throw new TypeError('offline');
    // Lo que devuelve `tailscale serve` cuando el hub detrás no está: una
    // respuesta de verdad, no un fallo de red.
    if (badGateway) return new Response('<html>Bad Gateway</html>', { status: 502 });
    const path = new URL(urlOf(r)).pathname;
    if (path === '/' || path === '/index.html') return new Response(index, { status: 200 });
    return new Response(`body:${path}`, { status: 200 });
  };

  const { api: caches, stores } = fakeCaches(fetcher);
  const self: Record<string, unknown> = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    location: { origin: ORIGIN },
    clients: { claim: async () => { /* nada que reclamar aquí */ } },
    skipWaiting: () => { skipped++; },
  };

  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'fetch', readFileSync(SW, 'utf8'))(self, caches, fetcher);

  const fire = async (type: string, event: Record<string, unknown>) => {
    for (const fn of listeners.get(type) ?? []) fn(event);
  };

  return {
    api: self['ORCA_SW'] as {
      policy(p: string): string;
      assetsIn(html: string): string[];
      prunable(urls: string[], html: string): string[];
      SHELL: string; ASSETS: string; SHELL_FILES: string[];
    },
    stores,
    skipped: () => skipped,
    requests: () => requests,
    setIndex: (html: string) => { index = html; },
    setOffline: (v: boolean) => { offline = v; },
    setBadGateway: (v: boolean) => { badGateway = v; },
    async install() { const waits: Promise<unknown>[] = []; await fire('install', { waitUntil: (p: Promise<unknown>) => waits.push(p) }); await Promise.all(waits); },
    async activate() { const waits: Promise<unknown>[] = []; await fire('activate', { waitUntil: (p: Promise<unknown>) => waits.push(p) }); await Promise.all(waits); },
    async message(data: unknown) { await fire('message', { data }); },
    /** Devuelve la Response si el worker contestó, o null si dejó pasar a la red. */
    async request(req: Req): Promise<Response | null> {
      let answer: Promise<Response> | null = null;
      await fire('fetch', { request: req, respondWith: (p: Promise<Response>) => { answer = p; } });
      return answer ? await answer : null;
    },
  };
}

/* ── El hub nunca se cachea ───────────────────────────────────────── */

async function passesHubThrough() {
  const sw = loadSW();
  const hub = ['/api/world', '/api/health', '/api/artifact/abc', '/ws/console', '/mcp'];
  const answered: string[] = [];
  for (const p of hub) if (await sw.request(get(p))) answered.push(p);
  return eq('el hub va siempre a la red, sin caché', answered, []);
}

function policyKnowsTheHub() {
  const { api } = loadSW();
  const wrong = ['/api', '/api/world', '/ws', '/ws/console', '/mcp', '/mcp/tools']
    .filter((p) => api.policy(p) !== 'pass');
  return eq('policy() marca `pass` para api/ws/mcp', wrong, []);
}

function policySortsTheRest() {
  const { api } = loadSW();
  const seen = {
    index: api.policy('/'),
    html: api.policy('/index.html'),
    asset: api.policy('/assets/index-AAA.js'),
    font: api.policy('/fonts/tiny5.woff2'),
    icon: api.policy('/icon-192.png'),
    sfx: api.policy('/sfx/packs/mac/manifest.json'),
    unknown: api.policy('/algo/que/no/existe'),
  };
  return eq('cada ruta a su estrategia', seen, {
    index: 'index', html: 'index', asset: 'immutable',
    font: 'shell', icon: 'shell', sfx: 'shell', unknown: 'pass',
  });
}

async function postIsNeverTouched() {
  const sw = loadSW();
  const res = await sw.request({ method: 'POST', url: `${ORIGIN}/api/recovery-images` });
  return ok('un POST no pasa por el worker', res === null);
}

async function otherOriginsAreNotOurs() {
  const sw = loadSW();
  const res = await sw.request({ method: 'GET', url: 'https://otro.example/x.js' });
  return ok('otro origen no pasa por el worker', res === null);
}

/* ── Sin red ──────────────────────────────────────────────────────── */

async function offlineNavigationServesTheIndex() {
  const sw = loadSW();
  await sw.install();
  sw.setOffline(true);
  const res = await sw.request(get('/', 'navigate'));
  const body = res ? await res.text() : '';
  return ok('sin red, una navegación devuelve el index guardado', body.includes('/assets/index-AAA.js'), body.slice(0, 40));
}

async function offlineDeepLinkServesTheIndex() {
  const sw = loadSW();
  await sw.install();
  sw.setOffline(true);
  const res = await sw.request(get('/agent/K9', 'navigate'));
  const body = res ? await res.text() : '';
  return ok('una ruta cualquiera también: el enrutado vive en el cliente', body.includes('index-AAA'));
}

async function offlineAssetsComeFromCache() {
  const sw = loadSW();
  await sw.install();
  sw.setOffline(true);
  const res = await sw.request(get('/assets/index-AAA.js'));
  return ok('sin red, el javascript del build sale de la caché', res !== null && res.ok);
}

async function badGatewayServesTheIndex() {
  const sw = loadSW();
  await sw.install();
  // El hub parado con `tailscale serve` delante: 502, no error de red.
  sw.setBadGateway(true);
  const res = await sw.request(get('/agent/K9', 'navigate'));
  const body = res ? await res.text() : '';
  return ok('un 502 del proxy tampoco gana al index guardado', body.includes('index-AAA'), body.slice(0, 60));
}

async function badGatewayShowsWhenThereIsNoCopy() {
  const sw = loadSW();
  sw.setBadGateway(true);
  const res = await sw.request(get('/', 'navigate'));
  return eq('sin copia, el error se ve tal cual', res?.status ?? 0, 502);
}

/* ── Una sola clave para el index ─────────────────────────────────── */

async function indexHasOneKey() {
  const sw = loadSW();
  await sw.install();
  // El centinela de hud/update.ts pide `/?update=…` cada minuto.
  await sw.request(get('/?update=abc'));
  await sw.request(get('/?update=def'));
  await sw.request(get('/otra/ruta', 'navigate'));
  const keys = [...sw.stores.get(sw.api.SHELL)!.keys()];
  const stray = keys.filter((k) => k.includes('?') || k.includes('/otra'));
  return eq('el index vive bajo una sola clave', { stray, index: keys.includes(`${ORIGIN}/`) }, { stray: [], index: true });
}

async function indexPrefersTheNetwork() {
  const sw = loadSW();
  await sw.install();
  sw.setIndex(INDEX_B);
  const res = await sw.request(get('/?update=abc'));
  const body = res ? await res.text() : '';
  return ok('con red, el index es el del hub, no el guardado', body.includes('index-BBB'), body.slice(0, 40));
}

/* ── Assets inmutables ────────────────────────────────────────────── */

async function assetsAreFetchedOnce() {
  const sw = loadSW();
  await sw.install();
  const before = sw.requests();
  await sw.request(get('/assets/index-AAA.js'));
  await sw.request(get('/assets/index-AAA.js'));
  return eq('un asset con hash se pide cero veces tras el precache', sw.requests() - before, 0);
}

/* ── Poda ─────────────────────────────────────────────────────────── */

function prunableDropsOrphans() {
  const { api } = loadSW();
  const cached = [`${ORIGIN}/assets/index-AAA.js`, `${ORIGIN}/assets/index-BBB.js`, `${ORIGIN}/icon.svg`];
  return eq('sobra lo que el index vivo ya no nombra', api.prunable(cached, INDEX_B), [`${ORIGIN}/assets/index-AAA.js`]);
}

async function activateSweepsOldBuilds() {
  const sw = loadSW();
  await sw.install();                       // el build viejo, en caché
  sw.setIndex(INDEX_B);                     // el hub sirve uno nuevo
  await sw.request(get('/assets/index-BBB.js'));
  await sw.request(get('/assets/index-BBB.css'));
  await sw.activate();
  const assets = sw.stores.get(sw.api.ASSETS)!;
  const left = [...assets.keys()].map((u) => new URL(u).pathname).sort();
  return eq('activar deja sólo los assets del build servido', left, ['/assets/index-BBB.css', '/assets/index-BBB.js']);
}

async function activateDropsForeignCaches() {
  const sw = loadSW();
  // Una caché que dejó una versión anterior del worker.
  sw.stores.set('orca-shell-v0', new Map([[`${ORIGIN}/`, new Response('viejo')]]));
  await sw.activate();
  return ok('las cachés de un worker anterior se borran', !sw.stores.has('orca-shell-v0'), [...sw.stores.keys()].join(','));
}

/* ── El relevo ────────────────────────────────────────────────────── */

async function neverTakesOverAlone() {
  const sw = loadSW();
  await sw.install();
  await sw.activate();
  return eq('instalar y activar no adelantan el relevo', sw.skipped(), 0);
}

async function takesOverWhenAsked() {
  const sw = loadSW();
  await sw.message({ t: 'otra:cosa' });
  const noise = sw.skipped();
  await sw.message({ t: 'orca:activate' });
  return eq('sólo `orca:activate` da el relevo', [noise, sw.skipped()], [0, 1]);
}

const mod: TestModule = {
  suite: 'sw',
  tests: [
    test('el hub va a la red', passesHubThrough),
    test('policy: api/ws/mcp', policyKnowsTheHub),
    test('policy: el resto', policySortsTheRest),
    test('POST intacto', postIsNeverTouched),
    test('otro origen intacto', otherOriginsAreNotOurs),
    test('offline: navegación', offlineNavigationServesTheIndex),
    test('offline: ruta profunda', offlineDeepLinkServesTheIndex),
    test('offline: assets', offlineAssetsComeFromCache),
    test('502: index guardado', badGatewayServesTheIndex),
    test('502: sin copia se ve', badGatewayShowsWhenThereIsNoCopy),
    test('index: una clave', indexHasOneKey),
    test('index: red primero', indexPrefersTheNetwork),
    test('assets: una sola descarga', assetsAreFetchedOnce),
    test('poda: huérfanos', prunableDropsOrphans),
    test('poda: al activar', activateSweepsOldBuilds),
    test('poda: cachés viejas', activateDropsForeignCaches),
    test('relevo: nunca solo', neverTakesOverAlone),
    test('relevo: bajo orden', takesOverWhenAsked),
  ],
};

mod.tests.push(test('push fallback and notification click reuse a window without trusting payload URLs', async () => {
  const handlers = new Map<string, (e: any) => void>();
  let shown: any, focused = 0, opened = '', message: any;
  const client = { url: ORIGIN + '/', focus: async () => { focused++; }, postMessage: (v: any) => { message = v; } };
  let clients = [client];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, fn: (e: any) => void) => handlers.set(t, fn),
    registration: { showNotification: async (_t: string, v: any) => { shown = v; } },
    clients: { matchAll: async () => clients, openWindow: async (url: string) => { opened = url; } },
  };
  new Function('self', 'caches', 'fetch', readFileSync(SW, 'utf8'))(self, {}, () => {});
  let wait: Promise<unknown> = Promise.resolve();
  const waitUntil = (p: Promise<unknown>) => { wait = p; };
  handlers.get('push')!({ data: { json() { throw new Error('bad'); } }, waitUntil }); await wait;
  if (shown.body !== 'An agent needs your input.') return ok('fallback', false);
  const notification = { data: { url: 'https://evil.test' }, close() {} };
  handlers.get('notificationclick')!({ notification, waitUntil }); await wait;
  if (focused !== 1 || message.t !== 'orca:queue') return ok('reuse', false);
  clients = []; handlers.get('notificationclick')!({ notification, waitUntil }); await wait;
  return eq('safe destination', opened, '/?queue=1');
}));

export default mod;
