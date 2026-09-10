import { defineConfig, normalizePath, type Plugin } from 'vite';
import { relative, resolve } from 'node:path';

import { PORTS } from './src/shared/protocol.ts';

/**
 * Ports, and why they are not literals.
 *
 * The canonical pair lives in protocol.ts so collector, hub and UI cannot
 * drift apart; repeating 4478/4479 here was exactly that drift waiting to
 * happen. The env overrides exist for the visual harness: when it cannot have
 * the canonical ports — another worktree already holds them, or two agents are
 * shooting frames at once — it starts its own hub and Vite on free ones, and
 * the proxy below has to follow the hub it actually started. A Vite serving
 * this tree while proxying someone else's hub is the worst of the failures
 * here, because the frames come out looking plausible.
 */
const UI_PORT = Number(process.env['ORCA_UI_PORT'] ?? PORTS.ui);
const HUB_PORT = Number(process.env['ORCA_PORT'] ?? PORTS.hub);

/**
 * Dónde escucha el servidor de desarrollo, y por qué no basta con el hub.
 *
 * El hub escucha en 0.0.0.0 y sirve `dist/`, así que la consola construida ya
 * se alcanza desde la tailnet sin tocar nada. Vite no: se queda en 127.0.0.1 y
 * desde el móvil no hay nada en 4478. Para mirar la consola EN DESARROLLO
 * desde otro dispositivo hace falta abrirlo, y eso es una decisión, no un
 * default: `0.0.0.0` lo publica también en el wifi del bar, no sólo en la
 * tailnet. De ahí la variable — y de ahí que su valor por defecto siga siendo
 * el de siempre.
 *
 *   ORCA_UI_HOST=0.0.0.0             toda interfaz
 *   ORCA_UI_HOST=100.85.28.114       sólo la tailnet, que es lo que se quiere
 *
 * Vite no se reinicia solo al cambiar este archivo (ver updateSignal abajo):
 * relanza `npm run dev:ui` después de tocarlo.
 */
const UI_HOST = process.env['ORCA_UI_HOST'] ?? '127.0.0.1';

/**
 * The dev server never reloads the console on its own.
 *
 * `server.hmr: false` below stops Vite from sending `full-reload` (and js
 * updates) when a file changes. It could not be done from the page: in Vite
 * 6.4 the `vite:beforeFullReload` listeners run under `Promise.allSettled`,
 * so throwing from one no longer cancels the reload. With HMR off Vite still
 * invalidates its module graph on every change — the manual reload gets
 * fresh code — and the dev WebSocket stays up and still forwards `custom`
 * payloads. That is the channel this plugin uses: a file the running page
 * imports (or index.html, or anything under public/) changes, and the page
 * hears `orca:update` and lights "UPDATE AVAILABLE · CLICK TO RELOAD"
 * (src/ui/hud/update.ts). Editing a test or the hub sends nothing: the
 * module graph knows what the page is made of.
 *
 * The one reload left to Vite is its own restart (`vite.config.ts` edited,
 * or `npm run dev:ui` relaunched): its client polls until the server is back
 * and reloads then. Note that with HMR off Vite does not restart itself on a
 * config change either; relaunch `dev:ui` after editing this file.
 */
function updateSignal(): Plugin {
  return {
    name: 'orca:update-signal',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root;
      const index = normalizePath(resolve(root, 'index.html'));
      const publicDir = server.config.publicDir ? normalizePath(server.config.publicDir) + '/' : null;
      const matters = (file: string) =>
        file === index
        || (publicDir !== null && file.startsWith(publicDir))
        || (server.moduleGraph.getModulesByFile(file)?.size ?? 0) > 0;
      const signal = (raw: string) => {
        const file = normalizePath(raw);
        if (!matters(file)) return;
        server.ws.send({ type: 'custom', event: 'orca:update', data: { file: relative(root, file), at: Date.now() } });
      };
      server.watcher.on('change', signal);
      server.watcher.on('add', signal);
      server.watcher.on('unlink', signal);
    },
  };
}

export default defineConfig({
  root: '.',
  plugins: [updateSignal()],
  server: {
    port: UI_PORT,
    // Bind IPv4 explicitly: Vite 6 defaults to a localhost that resolves to ::1
    // only, which the test harness and any curl-based check cannot reach.
    host: UI_HOST,
    /*
     * MagicDNS names. Vite 6 rejects a Host header it does not know (DNS
     * rebinding), which turns `http://personal-mac-m4.tailnet.ts.net:4478`
     * into a blank page with the reason buried in the terminal. Numeric IPs
     * are allowed already; this adds the names Tailscale hands out.
     */
    allowedHosts: ['.ts.net'],
    strictPort: false,
    // No automatic reloads: see updateSignal() above.
    hmr: false,
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${HUB_PORT}`, ws: true },
      '/api': { target: `http://127.0.0.1:${HUB_PORT}`, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    /*
     * El build NO vacía dist/, y esto es lo que permite construir sobre una
     * consola que está siendo mirada.
     *
     * Con el vaciado por defecto, durante los segundos que dura el build la
     * consola viva se queda sin fuentes, sin sfx, sin `/sw.js` y sin index —y
     * si el build falla, dist queda vacío y lo que había en pie se cae—. Sin
     * vaciado el build es aditivo: los `/assets/*` nuevos llevan hash y
     * conviven con los de la generación anterior, así que la página que ya
     * está cargada conserva intacto lo suyo, y el index —lo único con nombre
     * fijo que decide qué build es— se reescribe al final. Un build roto no
     * llega a tocarlo: lo que se sirve sigue siendo el build bueno de antes.
     *
     * El precio es que dist/assets crecería sin fin, y por eso el barrido no
     * es opcional: `tools/publish.mjs` es quien construye de verdad, y borra
     * los assets que ya no referencia ni el index nuevo ni el anterior.
     * `npx vite build` a pelo funciona, pero deja basura detrás.
     */
    emptyOutDir: false,
  },
});
