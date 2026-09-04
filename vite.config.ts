import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 4478,
    // Bind IPv4 explicitly: Vite 6 defaults to a localhost that resolves to ::1
    // only, which the test harness and any curl-based check cannot reach.
    host: '127.0.0.1',
    strictPort: false,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:4479', ws: true },
      '/api': { target: 'http://127.0.0.1:4479', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
});
