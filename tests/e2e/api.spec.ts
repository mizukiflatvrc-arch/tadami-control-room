import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mapSnapshot } from '../../server/prometheus/mapper';
import { fixtureConfig } from '../../fixtures/prometheus/config';
import { fixtureResults } from '../../fixtures/prometheus/responses';

for (const viewport of [{ width: 1280, height: 1024 }, { width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`API フィクスチャ経由の ${viewport.width}×${viewport.height} 表示`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const external: string[] = [];
    page.on('request', (request) => { if (!request.url().startsWith('http://127.0.0.1:5174/')) external.push(request.url()); });
    await page.goto('/?scenario=cpu-critical&source=mock');
    await expect(page.getByRole('button', { name: /再取得/ })).toBeEnabled();
    await expect(page.locator('.mock-badge')).toHaveText('API 検証データ（模擬）');
    await expect(page.getByRole('region', { name: /CPU/ }).locator('.metric-value')).toContainText('20.0');
    await expect(page.getByRole('region', { name: /メモリ/ }).locator('.metric-value')).toContainText('25.0');
    await expect(page.locator('.uptime-value')).toContainText('10');
    await expect(page.locator('.services-table')).toContainText('計測方式未確定');
    await expect(page.locator('.scenario-control')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    if (viewport.width === 1280) {
      const footer = (await page.locator('footer').boundingBox())!;
      expect(footer.y + footer.height).toBeLessThanOrEqual(viewport.height);
    }
    expect(external).toEqual([]);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('api-fixture.png'), fullPage: true });
  });
}

test('実データモードの初回失敗・成功・失敗後の前回値保持・復旧', async ({ page }) => {
  let failure = true;
  await page.route('**/api/monitoring/snapshot', async (route) => {
    const now = Date.now();
    await route.fulfill({ status: failure ? 502 : 200, contentType: 'application/json',
      headers: { 'X-Tadami-Data-Origin': 'prometheus' },
      body: JSON.stringify(failure ? { error: { code: 'UPSTREAM_FAILURE' } } : mapSnapshot(fixtureResults(now), fixtureConfig, now)),
    });
  });
  await page.goto('http://127.0.0.1:5175/?scenario=normal&source=mock');
  await expect(page.getByRole('status')).toContainText('観測値を取得できません');
  await expect(page.locator('.mock-badge')).toHaveText('実データ');
  await expect(page.locator('.host-line')).toContainText('OS 未確認');
  await expect(page.getByRole('region', { name: /CPU/ }).locator('.metric-value')).toContainText('—');
  await expect(page.locator('.scenario-control')).toHaveCount(0);
  failure = false;
  await page.getByRole('button', { name: /再取得/ }).click();
  await expect(page.getByRole('region', { name: /CPU/ }).locator('.metric-value')).toContainText('20.0');
  const fetched = await page.locator('.last-fetch').innerText();
  failure = true;
  await page.getByRole('button', { name: /再取得/ }).click();
  await expect(page.getByRole('status')).toContainText('前回値を表示しています');
  expect(await page.locator('.last-fetch').innerText()).toBe(fetched);
  await expect(page.getByRole('region', { name: /CPU/ }).locator('.metric-value')).toContainText('20.0');
  await expect(page.locator('.mock-badge')).toHaveText('実データ');
  failure = false;
  await page.getByRole('button', { name: /再取得/ }).click();
  await expect(page.locator('.error-detail')).toHaveCount(0);
});

test('実データモードは検証用サーバーの応答を拒否する', async ({ page }) => {
  // 5175 の proxy は検証用 API を指すが、データ種別ヘッダーが一致しない。
  await page.goto('http://127.0.0.1:5175/');
  await expect(page.locator('.error-detail')).toContainText('データ種別が設定と一致しません');
  await expect(page.locator('.mock-badge')).toHaveText('実データ');
  await expect(page.getByRole('region', { name: /CPU/ }).locator('.metric-value')).toContainText('—');
});
