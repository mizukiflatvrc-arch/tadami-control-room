import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.afterEach(async ({ request }) => { await request.post('http://127.0.0.1:5181/normal'); });

test('本番成果物: 同一オリジン・1280×1024・不正要求拒否（HTTP フィクスチャ）', async ({ page, request }, testInfo) => {
  const external: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => { if (!request.url().startsWith('http://127.0.0.1:5180/')) external.push(request.url()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?source=mock&scenario=failure');
  await expect(page.locator('.mock-badge')).toHaveText('実データ');
  await expect(page.locator('.host-line')).toContainText('API 検証ホスト');
  await expect(page.getByRole('region', { name: /CPU/ }).locator('.metric-value')).toContainText('20.0');
  await expect(page.locator('.services-table')).toContainText('監視対象・計測方式は未設定');
  await expect(page.locator('.scenario-control')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(1024);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const response = await request.get('/api/monitoring/snapshot');
  expect(response.ok()).toBe(true);
  expect(response.headers()['x-tadami-data-origin']).toBe('prometheus');
  expect((await response.json()).source).toBe('prometheus');
  expect((await request.get('/api/monitoring/snapshot?query=up')).status()).toBe(400);
  expect((await request.get('/api/v1/query?query=up')).status()).toBe(404);
  expect((await request.get('/.env.server')).status()).toBe(404);
  expect((await request.post('/api/monitoring/snapshot')).status()).toBe(405);
  await page.screenshot({ path: testInfo.outputPath('production-http-fixture-1280x1024.png'), fullPage: true });
});

test('API 障害→前回値保持→自動更新で復旧し、ページを再読み込みしない', async ({ page, request }) => {
  let documents = 0;
  page.on('request', (request) => { if (request.resourceType() === 'document') documents += 1; });
  await page.goto('/');
  await expect(page.getByRole('region', { name: /CPU/ }).locator('.metric-value')).toContainText('20.0');
  await request.post('http://127.0.0.1:5181/error');
  await expect(page.getByRole('status')).toContainText('前回値を表示しています', { timeout: 12_000 });
  await expect(page.locator('.mock-badge')).toHaveText('実データ');
  await expect(page.getByRole('region', { name: /CPU/ }).locator('.metric-value')).toContainText('20.0');
  await request.post('http://127.0.0.1:5181/normal');
  await expect(page.locator('.error-detail')).toHaveCount(0, { timeout: 12_000 });
  expect(documents).toBe(1);
});

test('初回障害は欠損を表示し、ブラウザー再起動相当の新しい context でも復旧する', async ({ page, request, browser }) => {
  await request.post('http://127.0.0.1:5181/error');
  await page.goto('/?source=mock');
  await expect(page.getByRole('status')).toContainText('観測値を取得できません');
  await expect(page.getByRole('region', { name: /CPU/ }).locator('.metric-value')).toContainText('—');
  await expect(page.locator('.mock-badge')).toHaveText('実データ');
  await request.post('http://127.0.0.1:5181/normal');
  const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
  try {
    const restarted = await context.newPage();
    await restarted.goto('http://127.0.0.1:5180/');
    await expect(restarted.getByRole('region', { name: /CPU/ }).locator('.metric-value')).toContainText('20.0');
  } finally { await context.close(); }
});
