import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // The deployable UI always uses the same-origin API. Ignore local .env files
  // and ALL public environment overrides in this mode.
  ...(mode === 'production-api' ? {
    envDir: false,
    envPrefix: [],
    define: { 'import.meta.env.VITE_DATA_SOURCE': JSON.stringify('api') },
  } : {}),
  // This is the LOCAL backend, not the Prometheus URL. No credentials enter Vite.
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api/': { target: 'http://127.0.0.1:8787', changeOrigin: true } } },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy: { '/api/': { target: 'http://127.0.0.1:8787', changeOrigin: true } } },
}));
