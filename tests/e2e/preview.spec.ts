import { test, expect } from '@playwright/test';

test('ビルド済みのモック版が正常に起動し、開発用操作を含まない', async ({ page }, testInfo) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (!request.url().startsWith('http://127.0.0.1:4173/')) external.push(request.url()); });
  await page.setViewportSize({ width: 1280, height: 900 });
  // Production ignores development-only scenario parameters.
  await page.goto('/?scenario=failure');
  await expect(page.getByRole('status')).toHaveText('すべての監視項目は正常です');
  await expect(page.locator('.mock-badge')).toHaveText('模擬データ');
  await expect(page.getByLabel('模擬シナリオ', { exact: true })).toHaveCount(0);
  await expect(page.locator('main section')).toHaveCount(5);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('preview-1280x900.png'), fullPage: true });
});
