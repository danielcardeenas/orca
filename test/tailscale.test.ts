/**
 * hub/tailscale.ts — la consola por https sin teclear nada.
 *
 * Lo que hay que garantizar es sobre todo lo que NO pasa: que un arranque de
 * ORCA no desconfigura la tailnet de nadie, no se cae porque tailscale no esté,
 * y no vuelve a servir lo que ya está servido (bajo `tsx watch` el hub se
 * reinicia cada vez que alguien toca `src/hub/*`).
 *
 * El ejecutor de comandos es de mentira: aquí no se toca la red.
 */

import { ensure, inspect, type ServeStatus } from '../src/hub/tailscale.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const PORT = 4479;
const HOST = 'personal-mac-m4.tail7bfa77.ts.net';

const running = JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` } });
const serving = (proxy: string) => JSON.stringify({ Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: proxy } } } } });

/** Un tailscale de mentira: responde por subcomando y apunta lo que se le pidió. */
function fakeCli(answers: Record<string, string | Error>) {
  const ran: string[][] = [];
  const exec = async (args: string[]) => {
    ran.push(args);
    const key = args.slice(0, 2).join(' ');
    const a = answers[key] ?? answers[args[0]!] ?? '';
    if (a instanceof Error) throw a;
    return a;
  };
  return { exec, ran, serves: () => ran.filter((a) => a[0] === 'serve' && a[1] === '--bg') };
}

/* ── Lo que decide ────────────────────────────────────────────────── */

function inspectReadsTheConfig() {
  const seen = {
    vacio: inspect({}, PORT).do,
    nulo: inspect(null, PORT).do,
    nuestro: inspect(JSON.parse(serving(`http://127.0.0.1:${PORT}`)) as ServeStatus, PORT),
    ajeno: inspect(JSON.parse(serving('http://127.0.0.1:3000')) as ServeStatus, PORT),
    otroPuertoTLS: inspect({ Web: { [`${HOST}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }, PORT).do,
  };
  return eq('inspect() lee la config que ya hay', seen, {
    vacio: 'serve',
    nulo: 'serve',
    nuestro: { do: 'nothing', why: 'ya-puesto' },
    ajeno: { do: 'nothing', why: 'ocupado', by: 'http://127.0.0.1:3000' },
    // El 443 sigue libre aunque haya otra cosa en otro puerto TLS.
    otroPuertoTLS: 'serve',
  });
}

/* ── Lo que hace ──────────────────────────────────────────────────── */

async function servesWhenFree() {
  const t = fakeCli({ 'status --json': running, 'serve status': '{}' });
  const res = await ensure({ port: PORT, exec: t.exec, env: {} });
  return eq('sin config previa, sirve el puerto del hub', { serves: t.serves(), url: res.url, served: res.served },
    { serves: [['serve', '--bg', '4479']], url: `https://${HOST}`, served: true });
}

async function neverServesTwice() {
  const t = fakeCli({ 'status --json': running, 'serve status': serving(`http://127.0.0.1:${PORT}`) });
  const res = await ensure({ port: PORT, exec: t.exec, env: {} });
  return eq('si ya está servido, no se vuelve a servir', { serves: t.serves(), url: res.url },
    { serves: [], url: `https://${HOST}` });
}

async function neverStompsAnother() {
  const t = fakeCli({ 'status --json': running, 'serve status': serving('http://127.0.0.1:3000') });
  const res = await ensure({ port: PORT, exec: t.exec, env: {} });
  return ok('el 443 de otro no se toca', t.serves().length === 0 && res.url === null && res.note.includes('3000'), res.note);
}

async function quietWhenLoggedOut() {
  const t = fakeCli({ 'status --json': JSON.stringify({ BackendState: 'Stopped' }), 'serve status': '{}' });
  const res = await ensure({ port: PORT, exec: t.exec, env: {} });
  return ok('con tailscale parado no se ejecuta nada', t.serves().length === 0 && res.url === null, res.note);
}

async function offByEnv() {
  const t = fakeCli({ 'status --json': running, 'serve status': '{}' });
  const res = await ensure({ port: PORT, exec: t.exec, env: { ORCA_TAILSCALE: '0' } });
  return ok('ORCA_TAILSCALE=0 no ejecuta ni un comando', t.ran.length === 0 && res.url === null, res.note);
}

async function survivesNoBinary() {
  const t = fakeCli({ 'status --json': new Error('spawn tailscale ENOENT') });
  const res = await ensure({ port: PORT, exec: t.exec, env: {} });
  return ok('sin tailscale, el arranque sigue', res.url === null && res.served === false && res.note.length > 0, res.note);
}

async function survivesAFailedServe() {
  const t = fakeCli({
    'status --json': running,
    'serve status': '{}',
    'serve --bg': new Error('HTTPS must be enabled for your tailnet\nvisit the admin panel'),
  });
  const res = await ensure({ port: PORT, exec: t.exec, env: {} });
  return ok('si serve falla, se dice por qué y no se lanza', res.url === null && res.note.includes('HTTPS must be enabled'), res.note);
}

async function survivesGarbage() {
  const t = fakeCli({ 'status --json': 'no soy json' });
  const res = await ensure({ port: PORT, exec: t.exec, env: {} });
  return ok('una salida que no es json no rompe nada', res.url === null && res.served === false, res.note);
}

const mod: TestModule = {
  suite: 'tailscale',
  tests: [
    test('inspect', inspectReadsTheConfig),
    test('sirve si está libre', servesWhenFree),
    test('no sirve dos veces', neverServesTwice),
    test('no pisa a otro', neverStompsAnother),
    test('tailscale parado', quietWhenLoggedOut),
    test('ORCA_TAILSCALE=0', offByEnv),
    test('sin binario', survivesNoBinary),
    test('serve que falla', survivesAFailedServe),
    test('json roto', survivesGarbage),
  ],
};

export default mod;
