import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: 'api.spec.ts',
  use: { ...base.use, baseURL: 'http://127.0.0.1:5174' },
  webServer: [
    { command: 'npm run dev:fixture', url: 'http://127.0.0.1:5174', reuseExistingServer: false, timeout: 30_000 },
    { command: 'npm run dev -- --port 5175 --strictPort', env: { VITE_DATA_SOURCE: 'api' }, url: 'http://127.0.0.1:5175', reuseExistingServer: false, timeout: 30_000 },
  ],
  outputDir: 'test-results/api',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/api', open: 'never' }]],
});
