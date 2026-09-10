/**
 * El panel pidiendo su tablero: fallo, reconexión y reintento.
 *
 * Esto existe por un fallo real. El panel pedía el tablero UNA vez al montar y
 * se tragaba el error, esperando a que un push lo arreglara. El hub sólo
 * empuja cuando el tablero CAMBIA, así que una petición perdida —el hub
 * reiniciándose, el handshake sin terminar— dejaba la sección diciendo
 * «ASKING THE HUB…» para siempre, con el operador creyendo que no había
 * propuestas. Ocurrió el 2026-09-08.
 *
 * Se prueba sin navegador: la lógica que importa es CUÁNDO se pide y CUÁNTAS
 * veces, y eso es la máquina de estados que hay debajo del DOM. Lo que sí se
 * comprueba en el navegador (`hud-improve.shots.ts`) es cómo se ve.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ok, test, type TestModule } from './harness.ts';

/** Los mismos escalones que usa `hud/improve.ts`. */
const RETRY_MS = [700, 1_500, 3_000, 6_000, 12_000];

/**
 * La máquina de estados del panel, aislada.
 *
 * Es una copia deliberada de la lógica de `mountImprove`: montar el panel
 * entero pediría un DOM, y lo que se está probando —no pedir dos veces a la
 * vez, no gastar reintentos sin enlace, volver a pedir al reconectar— no
 * necesita uno. Si las dos versiones divergen, divergen en el navegador, y
 * `hud-improve.shots.ts` fotografía ese lado.
 */
function panel(deps: { fetch(): Promise<unknown>; now(): number; linkUp(): boolean }) {
  let asking = false;
  let attempt = 0;
  let timer: { at: number; fn: () => void } | null = null;
  let error: string | null = null;
  let board: unknown = null;
  const asks: number[] = [];

  function ask(): void {
    if (asking) return;
    asking = true;
    timer = null;
    asks.push(deps.now());
    void deps.fetch()
      .then((b) => { board = b; attempt = 0; error = null; })
      .catch((err: unknown) => {
        error = err instanceof Error ? err.message : String(err);
        if (deps.linkUp() && attempt < RETRY_MS.length) {
          timer = { at: deps.now() + RETRY_MS[attempt++]!, fn: ask };
        }
      })
      .finally(() => { asking = false; });
  }

  return {
    ask,
    onLink(up: boolean) { if (up) { attempt = 0; ask(); } else timer = null; },
    /** Dispara lo vencido. Devuelve cuántos temporizadores saltaron. */
    tick(now: number): number {
      let fired = 0;
      while (timer && timer.at <= now) { const t = timer; timer = null; t.fn(); fired++; }
      return fired;
    },
    pending: () => timer !== null,
    state: () => ({ board, error, attempt, asks: asks.length }),
  };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

const tests = [
  test('a first request that fails is retried, with growing waits, and then lands', async () => {
    let now = 0;
    let fails = 3;
    const p = panel({
      now: () => now,
      linkUp: () => true,
      fetch: () => (fails-- > 0 ? Promise.reject(new Error('not connected')) : Promise.resolve({ ok: true })),
    });
    p.ask();
    await settle();
    const afterFirst = p.state();

    // Tres fallos, tres esperas crecientes, y a la cuarta entra.
    for (const wait of RETRY_MS.slice(0, 3)) {
      now += wait;
      p.tick(now);
      await settle();
    }
    const end = p.state();
    return ok('the board arrives without anyone touching anything',
      afterFirst.board === null && afterFirst.error === 'not connected'
      && end.board !== null && end.error === null && end.asks === 4 && !p.pending(),
      `${end.asks} attempts`);
  }),

  test('with the link down it does not burn retries: it waits for the reconnection', async () => {
    let now = 0;
    let up = false;
    let attempts = 0;
    const p = panel({
      now: () => now,
      linkUp: () => up,
      fetch: () => { attempts++; return up ? Promise.resolve({ ok: true }) : Promise.reject(new Error('not connected')); },
    });
    p.ask();
    await settle();
    const offline = p.state();

    // Media hora sin enlace: ni un intento más, y ningún temporizador vivo.
    now += 30 * 60_000;
    p.tick(now);
    await settle();
    const quiet = p.state();

    // Vuelve el enlace: se pide, y esta vez llega.
    up = true;
    p.onLink(true);
    await settle();
    const back = p.state();

    return ok('one try offline, none wasted, and one on reconnect',
      offline.asks === 1 && quiet.asks === 1 && !p.pending()
      && back.asks === 2 && back.board !== null && back.error === null && attempts === 2,
      `${attempts} fetches`);
  }),

  test('a reconnection re-reads the board: a restarted hub pushes nothing', async () => {
    let now = 0;
    let served = 0;
    const p = panel({ now: () => now, linkUp: () => true, fetch: () => Promise.resolve({ n: ++served }) });
    p.ask();
    await settle();
    p.onLink(true);
    await settle();
    p.onLink(true);
    await settle();
    return ok('every reconnection asks again',
      p.state().asks === 3 && (p.state().board as { n: number }).n === 3, `${served} served`);
  }),

  test('two triggers at once are one request: reading the board never doubles up', async () => {
    let now = 0;
    let inFlight = 0;
    let peak = 0;
    const p = panel({
      now: () => now,
      linkUp: () => true,
      fetch: () => {
        inFlight++; peak = Math.max(peak, inFlight);
        return new Promise((res) => setTimeout(() => { inFlight--; res({ ok: true }); }, 5));
      },
    });
    // El montaje pide, y el evento de enlace llega justo detrás.
    p.ask();
    p.onLink(true);
    p.ask();
    await new Promise((r) => setTimeout(r, 20));
    return ok('one in flight at a time, and nothing generated',
      peak === 1 && p.state().asks === 1, `${p.state().asks} asks, peak ${peak}`);
  }),

  test('reading the board is `improve:get` and nothing else: it never launches a review', () => {
    /*
     * La regla vive aquí porque es la que un arreglo apresurado rompería: si
     * alguien decide que «para tener propuestas hay que pedir una revisión»,
     * la sección lanzaría un agente cada vez que la consola se reconecta. El
     * camino de traer el tablero sólo puede leer.
     */
    const src = readSource();
    const from = src.indexOf('function askBoard');
    const body = src.slice(from, src.indexOf('\n  }', from));
    const calls = [...body.matchAll(/hub\.improve(\w*)\(/g)].map((m) => `hub.improve${m[1]}()`);
    // Y el enlace, al volver, llama a `askBoard` y no a otra cosa.
    const onLink = src.slice(src.indexOf("if (e.k === 'link')"), src.indexOf("if (e.k === 'improve')"));
    return ok('the fetch path only ever reads, on mount and on reconnect',
      calls.length === 1 && calls[0] === 'hub.improve()'
      && onLink.includes('askBoard()') && !/hub\.improve\w+\(/.test(onLink),
      `askBoard calls: ${calls.join(', ') || 'none'}`);
  }),
];

/** El texto del módulo del panel, para comprobar reglas que son de forma. */
function readSource(): string {
  return readFileSync(fileURLToPath(new URL('../src/ui/hud/improve.ts', import.meta.url)), 'utf8');
}

export default { suite: 'AUTOMEJORA · el panel pide su tablero', tests } satisfies TestModule;
