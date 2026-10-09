import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: 'production.spec.ts',
  fullyParallel: false,
  workers: 1,
  use: { ...base.use, baseURL: 'http://127.0.0.1:5180', viewport: { width: 1280, height: 1024 } },
  webServer: { command: 'node --import tsx tools/production/test-stack.ts', url: 'http://127.0.0.1:5180', reuseExistingServer: false, timeout: 30_000 },
  outputDir: 'test-results/production',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/production', open: 'never' }]],
});
