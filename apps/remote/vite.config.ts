import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Studio Core (dev: `pnpm dev:core`). REST and the realtime WebSocket share the /api prefix. */
const CORE = 'http://127.0.0.1:47321';
const proxy = { '/api': { target: CORE, ws: true } };

export default defineConfig({
  // Served by Studio Core at /remote/ in production.
  base: '/remote/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: ['es2022', 'safari16'],
  },
  server: { host: '127.0.0.1', port: 5174, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4174, strictPort: true, proxy },
});
