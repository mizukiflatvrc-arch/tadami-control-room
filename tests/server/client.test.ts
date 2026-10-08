// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureConfig } from '../../fixtures/prometheus/config';
import { fixtureResponse, FIXTURE_TIME } from '../../fixtures/prometheus/responses';
import { buildQueries } from '../../server/prometheus/queries';
import { PrometheusClient, UPSTREAM_TIMEOUT_MS } from '../../server/prometheus/client';

afterEach(() => vi.useRealTimers());
const query = buildQueries(fixtureConfig, FIXTURE_TIME).find((item) => item.id === 'memoryTotal.value')!;

describe('Prometheus HTTP クライアント', () => {
  it('GET の固定経路・パス接頭辞・サーバー認証だけを送信する', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(fixtureResponse(query)));
    const client = new PrometheusClient({ ...fixtureConfig, prometheusUrl: 'https://example.invalid/prom/', authorization: 'Bearer test-only-token' }, fetcher);
    await client.collect([query], new AbortController().signal);
    const [target, options] = fetcher.mock.calls[0]!;
    const url = new URL(String(target));
    expect(url.pathname).toBe('/prom/api/v1/query');
    expect(url.searchParams.get('query')).toBe(query.expression);
    expect(url.searchParams.get('time')).toBe(String(FIXTURE_TIME / 1000));
    expect(options!.method).toBe('GET');
    expect(options!.redirect).toBe('error');
    expect(options!.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer test-only-token' });
    expect(url.toString()).not.toContain('test-only-token');
  });
  it.each([
    () => Response.json({ error: 'upstream-secret' }, { status: 401 }),
    () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{invalid', { headers: { 'content-type': 'application/json' } }),
    () => Response.json({ status: 'error', error: 'upstream-secret' }),
    () => Response.json({ status: 'success', data: { resultType: 'scalar', result: [1, '2'] } }),
    () => Response.json({ ...(fixtureResponse(query) as object), warnings: ['partial response'] }),
    () => new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
  ])('不正・非成功・部分応答を拒否し、上流のエラー内容は返さない', async (response) => {
    const client = new PrometheusClient(fixtureConfig, vi.fn<typeof fetch>(async () => response()));
    await expect(client.collect([query], new AbortController().signal)).rejects.toThrow(/^Prometheus からデータを取得できません$/);
  });
  it('最大4並列と全体タイムアウトを守り、残りの要求を中止する', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_, init) => new Promise((_, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const pending = new PrometheusClient(fixtureConfig, fetcher).collect(buildQueries(fixtureConfig, FIXTURE_TIME), new AbortController().signal);
    const assertion = expect(pending).rejects.toThrow('タイムアウト');
    expect(fetcher).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS);
    await assertion;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('開始前の取消では上流に接続しない', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(new PrometheusClient(fixtureConfig, fetcher).collect([query], controller.signal)).rejects.toThrow('中止');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('一部のクエリだけ失敗した場合に他の結果を保持する', async () => {
    const queries = buildQueries(fixtureConfig, FIXTURE_TIME).filter((item) => item.id.endsWith('.value'));
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const expression = new URL(String(input)).searchParams.get('query');
      const matching = queries.find((item) => item.expression === expression)!;
      return matching.id === 'memoryTotal.value' ? new Response('', { status: 500 }) : Response.json(fixtureResponse(matching));
    });
    const results = await new PrometheusClient(fixtureConfig, fetcher).collect(queries, new AbortController().signal);
    expect(results['memoryTotal.value']).toEqual({ ok: false });
    expect(results['cpuIdle.value']!.ok).toBe(true);
  });
});
