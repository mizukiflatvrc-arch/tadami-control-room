import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function ready(page: Page, scenario = 'normal') {
  await page.goto(`/?scenario=${scenario}`);
  await expect(page.getByRole('button', { name: '再取得', exact: false })).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
}
async function switchTo(page: Page, scenario: string) {
  await page.getByLabel('模擬シナリオ', { exact: true }).selectOption(scenario);
  await expect(page.getByRole('button', { name: '再取得', exact: false })).toBeEnabled();
}

for (const viewport of [{ width: 1280, height: 1024 }, { width: 1280, height: 900 }]) {
  test(`${viewport.width}×${viewport.height} に全パネルが収まる`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (!request.url().startsWith('http://127.0.0.1:5173/')) external.push(request.url()); });
    await ready(page);
    await expect(page.getByRole('status')).toHaveText('すべての監視項目は正常です');
    await expect(page.locator('main section')).toHaveCount(5);
    await expect(page.getByRole('img', { name: /過去15分/ })).toHaveCount(2);
    await noHorizontalOverflow(page);
    const footer = await page.locator('footer').boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(viewport.height);
    const control = await page.locator('.scenario-control').boundingBox();
    expect(control!.y + control!.height).toBeLessThanOrEqual(viewport.height);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`normal-${viewport.width}x${viewport.height}.png`), fullPage: true });
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 740 }, { width: 768, height: 1024 }, { width: 640, height: 512 }]) {
  test(`狭幅 ${viewport.width}×${viewport.height} で内容が欠けない`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await ready(page);
    await noHorizontalOverflow(page);
    await expect(page.getByRole('heading', { name: /稼働時間/ })).toBeVisible();
    await page.locator('footer').scrollIntoViewIfNeeded();
    await expect(page.locator('footer')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`normal-${viewport.width}x${viewport.height}.png`), fullPage: true });
  });
}

test('注意・異常・欠損・失敗・復旧を切り替えられる', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  for (const [scenario, message] of [
    ['warning', '注意が必要'], ['cpu-critical', '異常を検出'], ['memory-critical', '異常を検出'],
    ['storage-critical', '異常を検出'], ['service-stopped', '注意が必要'], ['service-failed', '異常を検出'],
    ['partial', '取得不能または更新遅延'], ['mixed', '一部取得不能'], ['stale', '取得不能または更新遅延'],
  ]) {
    await switchTo(page, scenario!);
    await expect(page.getByRole('status')).toContainText(message!);
  }
  await switchTo(page, 'partial');
  await expect(page.getByRole('region', { name: /メモリ/ }).locator('.metric-value')).toContainText('—');
  await expect(page.locator('.storage-table tbody tr')).toHaveCount(3);
  await expect(page.locator('.services-table tbody tr')).toHaveCount(4);
  await switchTo(page, 'mixed');
  await page.screenshot({ path: testInfo.outputPath('mixed.png'), fullPage: true });
  await switchTo(page, 'normal');
  const value = await page.getByRole('region', { name: /CPU/ }).locator('.metric-value').innerText();
  const uptime = await page.locator('.uptime-value').innerText();
  const fetched = await page.locator('.last-fetch').innerText();
  await switchTo(page, 'failure');
  await expect(page.getByRole('status')).toContainText('取得失敗');
  expect(await page.getByRole('region', { name: /CPU/ }).locator('.metric-value').innerText()).toBe(value);
  expect(await page.locator('.uptime-value').innerText()).toBe(uptime);
  expect(await page.locator('.last-fetch').innerText()).toBe(fetched);
  await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true });
  await switchTo(page, 'recovery');
  await expect(page.getByRole('status')).toContainText('取得失敗');
  await expect(page.getByRole('status')).toContainText('すべての監視項目は正常', { timeout: 8000 });
});

test('初回取得不能とタイムアウトから復旧できる', async ({ page }) => {
  await ready(page, 'failure');
  await expect(page.getByRole('status')).toContainText('観測値を取得できません');
  await expect(page.getByRole('region', { name: /CPU/ }).locator('.metric-value')).toContainText('—');
  await switchTo(page, 'timeout');
  await expect(page.locator('.error-detail')).toContainText('タイムアウト');
  await switchTo(page, 'normal');
  await expect(page.getByRole('status')).toContainText('すべての監視項目は正常');
});

test('欠損履歴は線を切る', async ({ page }, testInfo) => {
  await ready(page, 'history-gap');
  await expect(page.getByRole('region', { name: /CPU/ }).getByTestId('trend-segment')).toHaveCount(2);
  await expect(page.getByRole('region', { name: /メモリ/ }).getByTestId('trend-segment')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('history-gap.png'), fullPage: true });
});

test('長い名前・多数の行は縦方向に展開する', async ({ page }) => {
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await ready(page, 'many-rows');
    await expect(page.locator('.storage-table tbody tr')).toHaveCount(10);
    await expect(page.locator('.services-table tbody tr')).toHaveCount(20);
    await noHorizontalOverflow(page);
    await page.locator('.services-table tbody tr').last().scrollIntoViewIfNeeded();
    await expect(page.locator('.services-table tbody tr').last()).toBeInViewport();
  }
});

test('200% 拡大で横方向にはみ出さずに操作できる', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1024 });
  await ready(page);
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: '再取得', exact: false }).click();
  await expect(page.getByRole('button', { name: '再取得', exact: false })).toBeEnabled();
  await page.locator('footer').scrollIntoViewIfNeeded();
  await expect(page.locator('footer')).toBeInViewport();
});

test('キーボード操作と主要なアクセシビリティ検査', async ({ page }) => {
  await ready(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '監視データへ移動' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '再取得', exact: false })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '再取得', exact: false })).toBeEnabled();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('仮想時計による 1 時間連続更新でも DOM と履歴が増えない', async ({ page }) => {
  test.setTimeout(90_000);
  await page.clock.install({ time: new Date('2026-10-08T12:00:00Z') });
  await ready(page);
  const initialNodes = await page.locator('*').count();
  const initialTime = await page.locator('.last-fetch').innerText();
  for (let minute = 0; minute < 60; minute += 1) {
    await page.clock.runFor(60_000);
    expect(await page.locator('*').count()).toBeLessThanOrEqual(initialNodes + 2);
  }
  await expect(page.getByRole('status')).toHaveText('すべての監視項目は正常です');
  expect(await page.locator('.last-fetch').innerText()).not.toBe(initialTime);
  await expect(page.getByTestId('trend-segment')).toHaveCount(2);
});
