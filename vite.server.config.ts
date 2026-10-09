import { defineConfig } from 'vite';

// Build Node entrypoints only; Vite is never a production server dependency.
export default defineConfig({
  envDir: false,
  envPrefix: [],
  build: {
    ssr: true,
    outDir: 'dist-server',
    sourcemap: false,
    rolldownOptions: {
      input: { api: 'server/index.ts', web: 'server/web-index.ts' },
      output: { entryFileNames: '[name].js' },
    },
  },
});
