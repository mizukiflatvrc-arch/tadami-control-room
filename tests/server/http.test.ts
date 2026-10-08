// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createMonitoringServer } from '../../server/app';
import { fixtureConfig } from '../../fixtures/prometheus/config';
import { createFixturePrometheusServer, closeServer, listenLocal } from '../../fixtures/prometheus/http-server';
import { fixtureResults, FIXTURE_TIME } from '../../fixtures/prometheus/responses';
import { UpstreamError } from '../../server/prometheus/client';
import { validateSnapshot } from '../../src/domain/validation';

const servers: Server[] = [];
async function start(server: Server) {
  servers.push(server);
  return listenLocal(server);
}
afterEach(async () => { await Promise.all(servers.splice(0).map(closeServer)); });

describe('読み取り専用 API', () => {
  it('実際のローカル HTTP を通してフィクスチャ→PrometheusClient→Snapshot を検証する', async () => {
    const upstreamUrl = await start(createFixturePrometheusServer());
    const apiUrl = await start(createMonitoringServer({ ...fixtureConfig, prometheusUrl: upstreamUrl }, { clock: () => FIXTURE_TIME, provenance: 'fixture' }));
    const response = await fetch(`${apiUrl}api/monitoring/snapshot`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-tadami-data-origin')).toBe('fixture');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const raw = await response.json();
    const snapshot = validateSnapshot(raw, FIXTURE_TIME);
    expect(snapshot.cpu.value!.usagePercent).toBeCloseTo(20);
    expect(snapshot.uptime.value!.seconds).toBe(864000);
    expect(snapshot.services[0]!.state.value).toBe('unknown');
    expect(JSON.stringify(raw)).not.toContain(upstreamUrl);
    expect(JSON.stringify(raw)).not.toContain('example.invalid');
  });
  it('任意クエリ・任意対象・別経路・書き込みメソッドを上流へ転送しない', async () => {
    const collect = vi.fn(async () => fixtureResults());
    const url = await start(createMonitoringServer(fixtureConfig, { client: { collect }, clock: () => FIXTURE_TIME }));
    for (const query of ['query=up', 'host=other', 'start=0&end=9999999', 'url=https://other.invalid', '%71uery=up']) {
      expect((await fetch(`${url}api/monitoring/snapshot?${query}`)).status).toBe(400);
    }
    expect((await fetch(`${url}api/v1/query?query=up`)).status).toBe(404);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const response = await fetch(`${url}api/monitoring/snapshot`, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET');
    }
    expect(collect).not.toHaveBeenCalled();
  });
  it.each([
    [new Error('https://private.invalid/ Bearer PRIVATE-SENTINEL'), 502, 'UPSTREAM_FAILURE'],
    [new UpstreamError('UPSTREAM_TIMEOUT'), 504, 'UPSTREAM_TIMEOUT'],
  ] as const)('失敗は固定されたエラーとして返す', async (error, status, code) => {
    const url = await start(createMonitoringServer({ ...fixtureConfig, authorization: 'Bearer PRIVATE-SENTINEL' }, { client: { collect: async () => { throw error; } } }));
    const response = await fetch(`${url}api/monitoring/snapshot`);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code } });
  });
  it('上流が失敗しても模擬データを返さない', async () => {
    const upstreamUrl = await start(createFixturePrometheusServer(() => 'error'));
    const url = await start(createMonitoringServer({ ...fixtureConfig, prometheusUrl: upstreamUrl }));
    const response = await fetch(`${url}api/monitoring/snapshot`);
    expect(response.status).toBe(502);
    expect(response.headers.get('x-tadami-data-origin')).toBe('prometheus');
    expect(await response.json()).toEqual({ error: { code: 'UPSTREAM_FAILURE' } });
  });
  it('切断したクライアントの上流要求を取り消す', async () => {
    let upstreamSignal: AbortSignal | undefined;
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const url = await start(createMonitoringServer(fixtureConfig, { client: { collect: (_, signal) => new Promise((_, reject) => {
      upstreamSignal = signal;
      started();
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }) } }));
    const controller = new AbortController();
    const pending = fetch(`${url}api/monitoring/snapshot`, { signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow();
    await ready;
    controller.abort();
    await assertion;
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
  });
});
