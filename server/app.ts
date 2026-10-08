import { createServer } from 'node:http';
import type { ServerConfig } from './config';
import { PrometheusClient, UpstreamError } from './prometheus/client';
import { buildQueries } from './prometheus/queries';
import { mapSnapshot } from './prometheus/mapper';

export function createMonitoringServer(config: ServerConfig, options: {
  client?: Pick<PrometheusClient, 'collect'>;
  clock?: () => number;
  provenance?: 'prometheus' | 'fixture';
} = {}) {
  const client = options.client ?? new PrometheusClient(config);
  const clock = options.clock ?? Date.now;
  let active = 0;
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Tadami-Data-Origin', options.provenance ?? 'prometheus');
    const send = (status: number, body: unknown) => {
      if (!response.destroyed) { response.statusCode = status; response.end(JSON.stringify(body)); }
    };
    let url: URL;
    try { url = new URL(request.url ?? '/', 'http://127.0.0.1'); }
    catch { request.resume(); send(400, { error: { code: 'INVALID_REQUEST' } }); return; }
    if (url.pathname !== '/api/monitoring/snapshot') { request.resume(); send(404, { error: { code: 'NOT_FOUND' } }); return; }
    if (request.method !== 'GET') { request.resume(); response.setHeader('Allow', 'GET'); send(405, { error: { code: 'METHOD_NOT_ALLOWED' } }); return; }
    if (url.search || request.headers['transfer-encoding'] || (request.headers['content-length'] && request.headers['content-length'] !== '0')) {
      request.resume(); send(400, { error: { code: 'PARAMETERS_NOT_ALLOWED' } }); return;
    }
    if (active >= 2) { send(503, { error: { code: 'BUSY' } }); return; }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.on('close', cancel);
    active += 1;
    try {
      const now = clock();
      const results = await client.collect(buildQueries(config, now), controller.signal);
      send(200, mapSnapshot(results, config, now, clock()));
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = error instanceof UpstreamError ? error.code : 'UPSTREAM_FAILURE';
        send(code === 'UPSTREAM_TIMEOUT' ? 504 : 502, { error: { code } });
      }
    } finally {
      active -= 1;
      response.off('close', cancel);
    }
  });
}
