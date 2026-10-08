import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: 'preview.spec.ts',
  use: { ...base.use, baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  outputDir: 'test-results/preview',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/preview', open: 'never' }]],
});
