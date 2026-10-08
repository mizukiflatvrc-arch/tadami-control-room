import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../src/data/api/api-provider';
import { parseDataMode } from '../../src/config/data-source';
import { createProvider } from '../../src/app/create-provider';
import { createFixture } from '../../src/data/mock/fixtures';

function response(source = 'prometheus', origin = 'prometheus') {
  return Response.json({ ...createFixture(Date.now()), source }, { headers: { 'X-Tadami-Data-Origin': origin } });
}
afterEach(() => { vi.unstubAllEnvs(); window.history.replaceState(null, '', '/'); });

describe('ApiProvider と明示的なモード切替', () => {
  it('同一オリジンの固定 API のみ取得し、応答を検証する', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response());
    const controller = new AbortController();
    const snapshot = await new ApiProvider('prometheus', fetcher).getSnapshot(controller.signal);
    expect(snapshot.source).toBe('prometheus');
    expect(fetcher).toHaveBeenCalledWith('/api/monitoring/snapshot', expect.objectContaining({ method: 'GET', signal: controller.signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json' } }));
  });
  it.each([
    () => Response.json({}, { status: 502 }),
    () => Response.json({}, { status: 504 }),
    () => new Response('<html>not an API</html>'),
    () => response('mock'),
    () => response('prometheus', 'fixture'),
    () => Response.json({}, { headers: { 'X-Tadami-Data-Origin': 'prometheus' } }),
  ])('失敗・形式不正・異なるデータ種別を模擬データで補わない', async (makeResponse) => {
    const fetcher = vi.fn<typeof fetch>(async () => makeResponse());
    await expect(new ApiProvider('prometheus', fetcher).getSnapshot(new AbortController().signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('フィクスチャ API は明示的な検証モードだけで受け付ける', async () => {
    const provider = new ApiProvider('fixture', vi.fn<typeof fetch>(async () => response('prometheus', 'fixture')));
    expect((await provider.getSnapshot(new AbortController().signal)).source).toBe('prometheus');
    expect(() => parseDataMode('api-fixture', false)).toThrow();
  });
  it('未設定時のみ既定の mock、不正値は mock にフォールバックしない', () => {
    expect(parseDataMode(undefined, true)).toBe('mock');
    expect(parseDataMode('mock', false)).toBe('mock');
    expect(parseDataMode('api', false)).toBe('api');
    expect(() => parseDataMode('ap1', true)).toThrow();
    expect(() => parseDataMode('', true)).toThrow();
    vi.stubEnv('VITE_DATA_SOURCE', 'ap1');
    expect(createProvider().mode).toBe('invalid');
  });
  it('URL の模擬シナリオ指定で API モードを変更できない', () => {
    vi.stubEnv('VITE_DATA_SOURCE', 'api');
    window.history.replaceState(null, '', '/?scenario=failure&source=mock');
    const source = createProvider();
    expect(source.mode).toBe('api');
    if (source.mode === 'api') expect(source.provider).toBeInstanceOf(ApiProvider);
  });
});
