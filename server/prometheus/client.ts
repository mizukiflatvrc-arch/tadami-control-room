import { z } from 'zod';
import type { ServerConfig } from '../config';
import type { Query, QueryId } from './queries';

const sample = z.tuple([z.number().nonnegative(), z.string()]);
const metric = z.record(z.string(), z.string());
const vector = z.object({ resultType: z.literal('vector'), result: z.array(z.object({ metric, value: sample })).max(512) });
const matrix = z.object({ resultType: z.literal('matrix'), result: z.array(z.object({ metric, values: z.array(sample).max(61) })).max(512) });
export const prometheusEnvelope = z.object({ status: z.literal('success'), data: z.discriminatedUnion('resultType', [vector, matrix]), warnings: z.array(z.string()).optional() });
export type PromData = z.infer<typeof prometheusEnvelope>['data'];
export type QueryResult = { ok: true; data: PromData } | { ok: false };
export type QueryResults = Partial<Record<QueryId, QueryResult>>;

export class UpstreamError extends Error {
  constructor(public readonly code: 'UPSTREAM_FAILURE' | 'UPSTREAM_TIMEOUT') {
    super(code === 'UPSTREAM_TIMEOUT' ? 'Prometheus の応答がタイムアウトしました' : 'Prometheus からデータを取得できません');
  }
}

export const UPSTREAM_TIMEOUT_MS = 2400;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamError('UPSTREAM_FAILURE');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new UpstreamError('UPSTREAM_FAILURE');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class PrometheusClient {
  constructor(private readonly config: ServerConfig, private readonly fetcher: typeof fetch = fetch) {}

  private async query(query: Query, signal: AbortSignal): Promise<PromData> {
    const url = new URL(query.kind === 'instant' ? 'api/v1/query' : 'api/v1/query_range', this.config.prometheusUrl);
    url.searchParams.set('query', query.expression);
    url.searchParams.set('timeout', '2s');
    if (query.kind === 'instant') url.searchParams.set('time', String(query.time));
    else {
      url.searchParams.set('start', String(query.start));
      url.searchParams.set('end', String(query.time));
      url.searchParams.set('step', String(query.step));
    }
    const response = await this.fetcher(url, {
      method: 'GET', signal, redirect: 'error',
      headers: { Accept: 'application/json', ...(this.config.authorization ? { Authorization: this.config.authorization } : {}) },
    });
    const parsed = prometheusEnvelope.safeParse(await readJson(response));
    if (!parsed.success || parsed.data.warnings?.length || parsed.data.data.resultType !== (query.kind === 'instant' ? 'vector' : 'matrix')) throw new UpstreamError('UPSTREAM_FAILURE');
    return parsed.data.data;
  }

  async collect(queries: readonly Query[], signal: AbortSignal): Promise<QueryResults> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), UPSTREAM_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, deadline.signal]);
    const results: QueryResults = {};
    let cursor = 0;
    try {
      const worker = async () => {
        while (cursor < queries.length && !combined.aborted) {
          const query = queries[cursor++]!;
          try { results[query.id] = { ok: true, data: await this.query(query, combined) }; }
          catch { results[query.id] = { ok: false }; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, queries.length) }, worker));
      if (signal.aborted) throw new DOMException('取得を中止しました', 'AbortError');
      if (deadline.signal.aborted) throw new UpstreamError('UPSTREAM_TIMEOUT');
      const current = queries.filter((query) => query.id.endsWith('.value'));
      if (!current.some((query) => results[query.id]?.ok)) throw new UpstreamError('UPSTREAM_FAILURE');
      return results;
    } finally { clearTimeout(timer); }
  }
}
