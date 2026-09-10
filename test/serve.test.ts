/**
 * El hub sirviendo la consola construida.
 *
 * Esto es lo que convierte "accesible desde donde estés" en un proceso: el hub
 * en un VPS o detrás de un túnel, los collectors marcando hacia fuera desde el
 * portátil, y la consola alcanzable desde el teléfono sin abrir un puerto en
 * ninguna máquina.
 *
 * Servir archivos desde un proceso que además acepta websockets de máquinas
 * remotas es exactamente donde aparecen los path traversal, así que la mitad
 * de estas pruebas son intentos de salirse de dist/.
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHub } from '../src/hub/server.ts';
import { PROTOCOL_VERSION, type ServerFrame } from '../src/shared/protocol.ts';
import { isSupervised } from '../src/shared/restart.ts';
import { ok, eq, test, freePort, type TestModule } from './harness.ts';

/**
 * El servido estático mira `dist/` relativo al módulo, así que no se puede
 * apuntar a un directorio temporal sin reescribirlo. Estas pruebas ejercen el
 * hub real y aceptan las dos respuestas legítimas: la consola si está
 * construida, o el 404 con la pista si no.
 */
async function withHub<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const port = await freePort();
  const hub = await startHub({ port, host: '127.0.0.1', quiet: true });
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await hub.close();
  }
}

/** Un canario fuera de dist/ que ninguna respuesta debe contener nunca. */
const CANARY_DIR = join(tmpdir(), 'orca-serve-test');
const CANARY = join(CANARY_DIR, 'secreto.txt');
const CANARY_TEXT = 'ESTO-NO-DEBE-SALIR-JAMAS-POR-HTTP';

const TRAVERSALS = [
  '/../../../../etc/passwd',
  '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  '/assets/../../../../etc/passwd',
  '/..%2f..%2f..%2fetc%2fpasswd',
  '/....//....//etc/passwd',
  `/../../../..${CANARY}`,
  `/%2e%2e${CANARY}`,
];

const tests = [
  test('las rutas de api siguen respondiendo con el estático activo', () => withHub(async (base) => {
    const r = await fetch(`${base}/api/health`);
    const body = await r.json() as { ok?: boolean };
    return ok('las rutas de api siguen respondiendo',
      r.status === 200 && body.ok === true, `http ${r.status}`);
  })),

  test('una ruta desconocida no devuelve un error de servidor', () => withHub(async (base) => {
    const r = await fetch(`${base}/una/ruta/que/no/existe`);
    // 200 con el index (SPA) o 404 con la pista; nunca un 5xx.
    return ok('una ruta desconocida no devuelve un error de servidor',
      r.status === 200 || r.status === 404, `http ${r.status}`);
  })),

  test('ningún path traversal filtra un archivo de fuera de dist', () => withHub(async (base) => {
    mkdirSync(CANARY_DIR, { recursive: true });
    writeFileSync(CANARY, CANARY_TEXT);
    try {
      const leaks: string[] = [];
      for (const path of TRAVERSALS) {
        const r = await fetch(`${base}${path}`);
        const body = await r.text();
        if (body.includes(CANARY_TEXT) || /^root:/m.test(body)) leaks.push(path);
      }
      return ok('ningún path traversal filtra un archivo de fuera de dist',
        leaks.length === 0,
        leaks.length ? `FILTRÓ: ${leaks.join(', ')}` : `${TRAVERSALS.length} intentos, ninguno filtró`);
    } finally {
      rmSync(CANARY_DIR, { recursive: true, force: true });
    }
  })),

  test('un traversal nunca devuelve un 5xx (no rompe el proceso)', () => withHub(async (base) => {
    const codes: number[] = [];
    for (const path of TRAVERSALS) {
      const r = await fetch(`${base}${path}`);
      codes.push(r.status);
    }
    return ok('un traversal nunca devuelve un 5xx',
      codes.every((c) => c < 500), `códigos: ${[...new Set(codes)].join(', ')}`);
  })),

  test('una url mal codificada se rechaza sin lanzar', () => withHub(async (base) => {
    // %zz no es escapado válido: decodeURIComponent lanza.
    const r = await fetch(`${base}/%zz%zz`);
    return ok('una url mal codificada se rechaza sin lanzar',
      r.status < 500, `http ${r.status}`);
  })),

  /*
   * La PWA. Chrome sólo instala la consola si el manifest llega con su tipo;
   * y como manifest, iconos y fuentes tienen nombre fijo, no pueden ir como
   * immutable o un cambio se queda pegado un año. Sin dist/ construido estas
   * pruebas no tienen qué medir y lo dicen.
   */
  test('el manifest de la PWA se sirve con su tipo, no como binario', () => withHub(async (base) => {
    const r = await fetch(`${base}/manifest.webmanifest`);
    if (r.status === 404) return ok('el manifest de la PWA se sirve con su tipo', true, 'sin dist/, nada que medir');
    const type = r.headers.get('content-type') ?? '';
    const m = await r.json() as { icons?: { src: string }[]; start_url?: string };
    return ok('el manifest de la PWA se sirve con su tipo',
      type.startsWith('application/manifest+json') && m.start_url === '/' && (m.icons?.length ?? 0) >= 3,
      `content-type ${type}, ${m.icons?.length ?? 0} iconos`);
  })),

  test('cada icono del manifest existe donde el manifest dice', () => withHub(async (base) => {
    const r = await fetch(`${base}/manifest.webmanifest`);
    if (r.status === 404) return ok('cada icono del manifest existe', true, 'sin dist/, nada que medir');
    const m = await r.json() as { icons: { src: string; type: string }[] };
    const missing: string[] = [];
    for (const icon of m.icons) {
      const ir = await fetch(`${base}${icon.src}`);
      const type = ir.headers.get('content-type') ?? '';
      if (ir.status !== 200 || !type.startsWith(icon.type)) missing.push(`${icon.src} (${ir.status} ${type})`);
    }
    return ok('cada icono del manifest existe',
      missing.length === 0, missing.length ? missing.join(', ') : `${m.icons.length} iconos`);
  })),

  test('sólo los assets con hash son immutable; el resto se revalida', () => withHub(async (base) => {
    const idx = await fetch(`${base}/`);
    if (idx.status === 404) return ok('sólo los assets con hash son immutable', true, 'sin dist/, nada que medir');
    const html = await idx.text();
    const asset = /\/assets\/[^"']+\.js/.exec(html)?.[0];
    const [manifest, hashed] = await Promise.all([
      fetch(`${base}/manifest.webmanifest`),
      asset ? fetch(`${base}${asset}`) : Promise.resolve(null),
    ]);
    // Sólo interesan las cabeceras, pero un cuerpo sin consumir mantiene vivo el
    // socket y el cierre del hub se queda esperándolo. Se descarta explícitamente.
    await Promise.all([manifest, hashed].map((r) => r?.body?.cancel() ?? Promise.resolve()));
    const cc = (r: Response | null): string => r?.headers.get('cache-control') ?? '';
    return ok('sólo los assets con hash son immutable',
      cc(idx) === 'no-store' && !cc(manifest).includes('immutable') && (!hashed || cc(hashed).includes('immutable')),
      `index "${cc(idx)}", manifest "${cc(manifest)}", asset "${cc(hashed)}"`);
  })),

  test('un archivo sin cambios responde 304 a If-Modified-Since', () => withHub(async (base) => {
    const first = await fetch(`${base}/icon.svg`);
    if (first.status === 404) return ok('un archivo sin cambios responde 304', true, 'sin dist/, nada que medir');
    const stamp = first.headers.get('last-modified') ?? '';
    const again = await fetch(`${base}/icon.svg`, { headers: { 'if-modified-since': stamp } });
    return ok('un archivo sin cambios responde 304',
      stamp !== '' && again.status === 304, `last-modified "${stamp}", segunda respuesta http ${again.status}`);
  })),

  /*
   * La otra mitad del aviso de actualización. Publicar cambia dist/ y la
   * consola lo ve sola; lo que ninguna recarga arregla es un hub que sigue
   * corriendo el código de antes, así que el hub lo dice él mismo nada más
   * conectar.
   *
   * Se prueban LAS DOS puertas a propósito. Una consola de navegador entra
   * con el token en la query y el hub le manda el mundo sin esperar `hello`;
   * todo lo demás entra saludando. Cablear el aviso en una sola de las dos
   * es un fallo que las pruebas por WebSocket no ven —entran por la del
   * `hello`— mientras la consola de verdad, que entra por la otra, no se
   * entera de nada. Pasó al escribir esto.
   */
  ...(['query', 'hello'] as const).map((puerta) =>
    test(`el hub dice qué código corre a una consola que entra por ${puerta}`, async () => {
      const port = await freePort();
      const hub = await startHub({ port, host: '127.0.0.1', quiet: true });
      try {
        const { WebSocket } = await import('ws');
        const token = hub.auth.token ?? '';
        const url = `ws://127.0.0.1:${port}/ws/console${puerta === 'query' ? `?token=${encodeURIComponent(token)}` : ''}`;
        const ws = new WebSocket(url);
        const seen: ServerFrame[] = [];
        const arrived = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), 8000);
          ws.on('open', () => {
            if (puerta === 'hello') ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token }));
          });
          ws.on('message', (data) => {
            let frame: ServerFrame;
            try { frame = JSON.parse(String(data)) as ServerFrame; } catch { return; }
            seen.push(frame);
            if (frame.t === 'server') { clearTimeout(t); resolve(true); }
          });
          ws.on('error', () => { clearTimeout(t); resolve(false); });
        });
        ws.close();
        const rev = seen.find((f) => f.t === 'server');
        // Primero lo que se pinta, luego lo que se avisa.
        const order = seen.findIndex((f) => f.t === 'world') < seen.findIndex((f) => f.t === 'server');
        // `restartable` es si este proceso puede darse el relevo, y eso no es
        // una opinión del hub: es si hay un supervisor delante ahora mismo.
        const offer = rev?.t === 'server' && rev.restartable === isSupervised(process.env);
        return ok(`el hub dice qué código corre (${puerta})`,
          arrived && rev?.t === 'server' && /^[0-9a-f]{12}$/.test(rev.rev) && rev.stale === false && order && offer,
          `frames=${seen.map((f) => f.t).join(',')} rev=${rev?.t === 'server' ? rev.rev : '—'} restartable=${rev?.t === 'server' ? rev.restartable : '—'}`);
      } finally {
        await hub.close();
      }
    })),

  test('el websocket sigue vivo con el servido estático delante', () => withHub(async (base) => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/console');
    const opened = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 4000);
      ws.on('open', () => { clearTimeout(t); resolve(true); });
      ws.on('error', () => { clearTimeout(t); resolve(false); });
    });
    ws.close();
    return eq('el websocket sigue vivo con el servido estático delante', opened, true);
  })),
];

const suite: TestModule = { suite: 'hub · sirviendo la consola', tests };
export default suite;
