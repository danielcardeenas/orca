/**
 * Exponer el hub sin abrirlo.
 *
 * El hub se alcanza desde fuera de su máquina —una tailnet, un túnel— y ahí la
 * regla vieja («si viene de 127.0.0.1 lo escribió el dueño») deja de valer por
 * dos motivos distintos, y esta suite cubre los dos:
 *
 *   1. El hub escucha en 0.0.0.0, así que loopback ya no es toda la frontera.
 *   2. Un proxy en la misma máquina hace que TODO parezca loopback.
 *
 * El segundo es el peligroso: no da error, no deja rastro en el log, y
 * convierte `/mcp` y `/api/file` en endpoints públicos. Ver src/hub/auth.ts y
 * `remoteOf()` en src/hub/server.ts.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bindsLocalOnly, createAuth } from '../src/hub/auth.ts';
import { HubStore } from '../src/hub/persist.ts';
import { startHub } from '../src/hub/server.ts';
import { test, eq, ok } from './harness.ts';

/** Un home propio: generar un token no debe tocar el del humano. */
function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'orca-remote-'));
}

/** El auth de un hub que nadie ha configurado, escuchando donde se le diga. */
function unconfigured(home: string, host: string) {
  return createAuth({ ORCA_HOME: home } as NodeJS.ProcessEnv, { host });
}

export default {
  suite: 'Remote access: la puerta local sólo existe si la puerta es local',
  tests: [
    test('escuchando en local hay puerta anónima; en 0.0.0.0 no', () => {
      const home = sandbox();
      try {
        const local = unconfigured(home, '127.0.0.1');
        const exposed = unconfigured(home, '0.0.0.0');
        return ok('puerta',
          local.allowLoopbackAnonymous && !exposed.allowLoopbackAnonymous,
          `local=${local.allowLoopbackAnonymous} expuesto=${exposed.allowLoopbackAnonymous}`);
      } finally { rmSync(home, { recursive: true, force: true }); }
    }),

    test('sin decir dónde escucha se asume expuesto', () => {
      const home = sandbox();
      try {
        // Fallar cerrado: quien no dice dónde escucha no puede pedir que se le
        // suponga a salvo. Es la diferencia entre un olvido y una brecha.
        return eq('puerta', unconfigured(home, '').allowLoopbackAnonymous, false);
      } finally { rmSync(home, { recursive: true, force: true }); }
    }),

    test('expuesto, ni siquiera localhost entra sin token', () => {
      const home = sandbox();
      try {
        const auth = unconfigured(home, '0.0.0.0');
        const anon = auth.check(null, '127.0.0.1');
        const withToken = auth.check(auth.token, '127.0.0.1');
        return ok('check', !anon.ok && withToken.ok, `anon=${anon.ok} token=${withToken.ok}`);
      } finally { rmSync(home, { recursive: true, force: true }); }
    }),

    test('la tailnet no es loopback', () => (
      // La IP que reparte Tailscale. Si esto se colara como local, el hub
      // trataría a cualquier dispositivo de la tailnet como al dueño.
      eq('100.x', bindsLocalOnly('100.64.10.20'), false)
    )),

    test('una cabecera de proxy quita el pase de local', async () => {
      const home = sandbox();
      const hub = await startHub({
        port: 0, host: '127.0.0.1', quiet: true,
        auth: unconfigured(home, '127.0.0.1'),
        store: new HubStore({ dir: join(home, 'hub') }),
      });
      const base = `http://127.0.0.1:${hub.port}/api/history?from=0`;
      try {
        // Este hub tiene la puerta abierta: escucha en local y nadie lo
        // configuró. Es el caso en el que un `cloudflared` delante haría daño.
        const direct = await fetch(base);
        const proxied = await fetch(base, { headers: { 'x-forwarded-for': '203.0.113.9' } });
        const proxiedWithToken = await fetch(base, {
          headers: { 'x-forwarded-for': '203.0.113.9', 'x-orca-token': hub.auth.token },
        });
        return ok('proxy',
          direct.status === 200 && proxied.status === 401 && proxiedWithToken.status === 200,
          `directo=${direct.status} proxy=${proxied.status} proxy+token=${proxiedWithToken.status}`);
      } finally {
        await hub.close();
        rmSync(home, { recursive: true, force: true });
      }
    }),
  ],
};
