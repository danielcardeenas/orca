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
