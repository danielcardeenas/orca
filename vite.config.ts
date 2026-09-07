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
    host: '127.0.0.1',
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
  },
});
