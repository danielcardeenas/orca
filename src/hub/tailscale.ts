/**
 * ORCA por https, sin acordarse de nada.
 *
 * El hub escucha en `http://0.0.0.0:4479`, así que desde el teléfono se entra
 * por la IP de la tailnet y eso **no es contexto seguro**: `navigator.
 * serviceWorker` sencillamente no existe ahí, y sin él la consola no se puede
 * instalar (ver docs/PWA.md). Un comando lo arregla —`tailscale serve --bg
 * 4479`, que publica el mismo puerto por https con certificado real y sólo
 * dentro de la tailnet—, y un comando que hay que acordarse de teclear después
 * de cada reinicio es un comando que un día no se teclea.
 *
 * Así que lo hace el arranque. Tres cosas que esto NO es:
 *
 *   No abre nada nuevo. `serve` no es `funnel`: no sale a internet. Y la
 *   tailnet ya alcanzaba el 4479 por http, porque el hub escucha en 0.0.0.0.
 *   Lo único que cambia es que además hay TLS y un nombre. Por eso puede ir
 *   encendido por defecto sin que sea una decisión del operador: no amplía la
 *   superficie, la cifra.
 *
 *   No pisa nada. Si el 443 del nodo ya sirve otra cosa, se deja como está y
 *   se dice en una línea. Un arranque de ORCA no puede desconfigurar la
 *   tailnet de quien la usaba para otra cosa.
 *
 *   No tumba el arranque. Sin tailscale, con el backend parado, sin https
 *   habilitado en la tailnet o con un comando que falle, el hub sigue su
 *   camino y la consola sigue alcanzable por http como siempre.
 *
 * Y una que sí es, y conviene saberla: lo que deja puesto **sobrevive a
 * ORCA**. `--bg` vive en el estado de tailscaled, no en este proceso. Se
 * quita con `tailscale serve --https=443 off`. Retirarlo al salir sería peor:
 * bajo `tsx watch` el hub se reinicia cada vez que alguien toca `src/hub/*`,
 * y eso serían decenas de reconfiguraciones de la tailnet al día.
 *
 * `inspect()` es pura y `ensure()` recibe el ejecutor, así que todo esto se
 * prueba sin tocar la red (test/tailscale.test.ts).
 */

import { execFile } from 'node:child_process';

/** Lo poco que se mira de `tailscale serve status --json`. */
export interface ServeStatus {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

export type Verdict =
  /** El 443 ya apunta a nuestro puerto. No hay nada que hacer. */
  | { do: 'nothing'; why: 'ya-puesto' }
  /** No hay config de serve, o no toca el 443. Se puede poner. */
  | { do: 'serve' }
  /** El 443 sirve otra cosa. Ni tocarlo ni discutirlo. */
  | { do: 'nothing'; why: 'ocupado'; by: string };

/**
 * Qué hacer, dado lo que ya hay. La clave del mapa `Web` es `host:puerto`, así
 * que basta con mirar las que terminan en `:443`; el proxy es una url a
 * `127.0.0.1:<puerto>` y lo único que importa de ella es ese puerto.
 */
export function inspect(status: ServeStatus | null, port: number): Verdict {
  const web = status?.Web ?? {};
  for (const [hostPort, entry] of Object.entries(web)) {
    if (!hostPort.endsWith(':443')) continue;
    for (const handler of Object.values(entry?.Handlers ?? {})) {
      const proxy = handler?.Proxy;
      if (!proxy) continue;
      let target: URL;
      try { target = new URL(proxy); } catch { return { do: 'nothing', why: 'ocupado', by: proxy }; }
      if (target.port === String(port)) return { do: 'nothing', why: 'ya-puesto' };
      return { do: 'nothing', why: 'ocupado', by: proxy };
    }
  }
  return { do: 'serve' };
}

/** Un ejecutor de comandos: devuelve la salida, o lanza. Inyectable para el test. */
export type Exec = (args: string[]) => Promise<string>;

/**
 * Cuánto se le da a cada comando. Los dos `status` son lecturas locales y no
 * tienen excusa para tardar; el arranque no espera a nadie. `serve` sí la
 * tiene: la primera vez que se publica un nombre, tailscaled emite el
 * certificado TLS, y matarlo a los cinco segundos dejaría la consola sin https
 * justo el día que se estrena, con un error que no se parece en nada a la
 * causa.
 */
const READ_TIMEOUT_MS = 5_000;
const SERVE_TIMEOUT_MS = 30_000;

export function cli(bin = 'tailscale'): Exec {
  return (args) => new Promise<string>((resolve, reject) => {
    const timeout = args[0] === 'serve' && args[1] === '--bg' ? SERVE_TIMEOUT_MS : READ_TIMEOUT_MS;
    execFile(bin, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`${stderr || stdout || err.message}`.trim())); return; }
      resolve(stdout);
    });
  });
}

export interface EnsureResult {
  /** La url https del nodo, cuando quedó servida. */
  url: string | null;
  /** Una línea para el log. Siempre hay una: el silencio no explica nada. */
  note: string;
  /** ¿Se ejecutó `serve` en esta llamada? */
  served: boolean;
}

export interface EnsureOptions {
  port: number;
  exec: Exec;
  env?: NodeJS.ProcessEnv;
}

function parse(out: string): unknown {
  try { return JSON.parse(out); } catch { return null; }
}

/**
 * Deja el puerto del hub servido por https en la tailnet, si se puede y si no
 * hay nada en medio. Nunca lanza.
 */
export async function ensure({ port, exec, env = process.env }: EnsureOptions): Promise<EnsureResult> {
  if (env['ORCA_TAILSCALE'] === '0') return { url: null, served: false, note: 'https en la tailnet: desactivado (ORCA_TAILSCALE=0)' };

  let host: string | null = null;
  try {
    const raw = parse(await exec(['status', '--json'])) as { BackendState?: string; Self?: { DNSName?: string } } | null;
    if (!raw) return { url: null, served: false, note: 'https en la tailnet: no se pudo leer el estado de tailscale' };
    if (raw.BackendState !== 'Running') {
      return { url: null, served: false, note: `https en la tailnet: tailscale no está conectado (${raw.BackendState ?? 'sin estado'})` };
    }
    host = (raw.Self?.DNSName ?? '').replace(/\.$/, '') || null;
  } catch {
    // Sin binario, sin permisos, o el daemon no contesta. Ninguna es un error
    // de ORCA: la consola sigue en http.
    return { url: null, served: false, note: 'https en la tailnet: no disponible (sin tailscale)' };
  }

  let status: ServeStatus | null;
  try {
    status = parse(await exec(['serve', 'status', '--json'])) as ServeStatus | null;
  } catch {
    return { url: null, served: false, note: 'https en la tailnet: no se pudo leer la config de serve' };
  }

  const url = host ? `https://${host}` : null;
  const verdict = inspect(status, port);
  if (verdict.do === 'nothing') {
    return verdict.why === 'ya-puesto'
      ? { url, served: false, note: `https en la tailnet: ya servido${url ? ` → ${url}` : ''}` }
      : { url: null, served: false, note: `https en la tailnet: el 443 ya sirve ${verdict.by}; no se toca` };
  }

  try {
    await exec(['serve', '--bg', String(port)]);
  } catch (err) {
    /*
     * El motivo se repite tal cual: lo dice tailscale y lo dice mejor. Lo
     * único que se le añade es el siguiente paso cuando el motivo es el que
     * sale en una tailnet recién hecha —Serve apagado, que se enciende en el
     * panel—, porque «no está habilitado» sin decir dónde habilitarlo deja al
     * operador exactamente igual de atascado.
     */
    const why = (err instanceof Error ? err.message.split('\n')[0] : String(err)) ?? '';
    const hint = /not enabled|https.*not/i.test(why)
      ? '\n  actívalo en https://login.tailscale.com/admin/dns → HTTPS Certificates (y Serve en Settings → Features)'
      : '';
    return { url: null, served: false, note: `https en la tailnet: no se pudo servir (${why})${hint}` };
  }
  return { url, served: true, note: `https en la tailnet: servido${url ? ` → ${url}` : ''}  (quitar: tailscale serve --https=443 off)` };
}
