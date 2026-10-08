import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, type ReactNode } from 'react';
import { MockProvider } from '../../src/data/mock/mock-provider';
import { createFixture } from '../../src/data/mock/fixtures';
import { useMonitoring } from '../../src/features/dashboard/use-monitoring';
import { requestSnapshot } from '../../src/data/request-snapshot';

const epoch = Date.parse('2026-10-08T12:00:00Z');
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('取得・取消・復旧', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('取得失敗で最終値・稼働時間・取得時刻を保持し、次回成功で復旧する', async () => {
    const provider = new MockProvider();
    const { result, unmount } = renderHook(() => useMonitoring(provider));
    await advance(200);
    const previous = result.current.snapshot;
    expect(previous).not.toBeNull();
    provider.setScenario('failure');
    act(() => result.current.restart());
    await advance(200);
    expect(result.current.error).toContain('取得に失敗');
    expect(result.current.snapshot).toBe(previous);
    await advance(10_500);
    expect(result.current.snapshot).toBe(previous);
    provider.setScenario('normal');
    await advance(5_300);
    expect(result.current.error).toBeNull();
    expect(result.current.snapshot!.fetchedAt).not.toBe(previous!.fetchedAt);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('初回失敗から自動更新で復旧する', async () => {
    const provider = new MockProvider('recovery');
    const { result } = renderHook(() => useMonitoring(provider));
    await advance(200);
    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).not.toBeNull();
    await advance(5_200);
    expect(result.current.error).toBeNull();
    expect(result.current.snapshot).not.toBeNull();
  });

  it('手動再取得は進行中の取得を重複させない', async () => {
    const provider = new MockProvider();
    const get = vi.spyOn(provider, 'getSnapshot');
    const { result } = renderHook(() => useMonitoring(provider));
    act(() => { result.current.refresh(); result.current.refresh(); });
    expect(get).toHaveBeenCalledTimes(1);
    await advance(200);
    act(() => { result.current.refresh(); result.current.refresh(); });
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('タイムアウトで中止し、その後に再取得できる', async () => {
    const provider = new MockProvider('timeout');
    const { result } = renderHook(() => useMonitoring(provider));
    await advance(3_001);
    expect(result.current.error).toContain('タイムアウト');
    expect(result.current.loading).toBe(false);
    provider.setScenario('normal');
    act(() => result.current.restart());
    await advance(200);
    expect(result.current.error).toBeNull();
  });
  it('AbortSignal を無視する Provider でもタイムアウトする', async () => {
    const provider = { getSnapshot: () => new Promise<ReturnType<typeof createFixture>>(() => {}) };
    const pending = requestSnapshot(provider, new AbortController().signal);
    const assertion = expect(pending).rejects.toThrow('タイムアウト');
    await advance(3_001);
    await assertion;
  });
  it('切替後に古いリクエストが完了しても上書きしない', async () => {
    let finishOld: ((value: ReturnType<typeof createFixture>) => void) | undefined;
    const getSnapshot = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue(createFixture(epoch, 'cpu-critical'));
    const provider = { getSnapshot };
    const { result } = renderHook(() => useMonitoring(provider));
    await act(async () => result.current.restart());
    expect(result.current.snapshot!.cpu.value!.usagePercent).toBeGreaterThan(95);
    await act(async () => { finishOld!(createFixture(epoch)); });
    expect(result.current.snapshot!.cpu.value!.usagePercent).toBeGreaterThan(95);
  });
  it('非表示タブでは停止し、復帰直後に再取得する', async () => {
    const provider = new MockProvider();
    const get = vi.spyOn(provider, 'getSnapshot');
    const { result } = renderHook(() => useMonitoring(provider));
    await advance(200);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await advance(60_000);
    expect(get).toHaveBeenCalledTimes(1);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await advance(200);
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot!.fetchedAt).not.toBe(new Date(epoch + 180).toISOString());
  });
  it('StrictMode の再マウントでも進行中の取得を取り消す', async () => {
    const provider = new MockProvider();
    const get = vi.spyOn(provider, 'getSnapshot');
    const { result, unmount } = renderHook(() => useMonitoring(provider), { wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> });
    for (const call of get.mock.calls.slice(0, -1)) expect(call[0].aborted).toBe(true);
    await advance(200);
    expect(result.current.snapshot).not.toBeNull();
    act(() => result.current.refresh());
    const activeSignal = get.mock.calls.at(-1)![0];
    await act(async () => unmount());
    expect(activeSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('仮想時計で 1 時間更新しても履歴とタイマー数が増えない', async () => {
    const provider = new MockProvider();
    const { result, unmount } = renderHook(() => useMonitoring(provider));
    await advance(200);
    const firstUptime = result.current.snapshot!.uptime.value!.seconds;
    for (let minute = 0; minute < 60; minute += 1) {
      await advance(60_000);
      expect(result.current.snapshot!.history.cpu.length).toBeLessThanOrEqual(61);
      expect(result.current.snapshot!.history.memory.length).toBeLessThanOrEqual(61);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(3);
    }
    expect(result.current.snapshot!.uptime.value!.seconds - firstUptime).toBeGreaterThan(3590);
    await act(async () => unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
