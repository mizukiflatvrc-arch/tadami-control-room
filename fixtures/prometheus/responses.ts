import raw from './responses.json' with { type: 'json' };
import { prometheusEnvelope, type QueryResults } from '../../server/prometheus/client';
import type { Query } from '../../server/prometheus/queries';
import { buildQueries } from '../../server/prometheus/queries';
import { fixtureConfig } from './config';

export const FIXTURE_TIME = 1791460800 * 1000;
export type FixtureScenario = 'normal' | 'partial' | 'stale' | 'nonfinite' | 'duplicate' | 'history-gap' | 'error';

const templates = new Map(Object.entries(raw).map(([id, value]) => [id, prometheusEnvelope.parse(value)]));

/** Rebase literal HTTP response fixtures, without importing any MockProvider code. */
export function fixtureResponse(query: Query, scenario: FixtureScenario = 'normal'): unknown {
  if (scenario === 'error') return { status: 'error', errorType: 'execution', error: 'fixture upstream failure' };
  const response = structuredClone(templates.get(query.id));
  if (!response) throw new Error(`Fixture missing: ${query.id}`);
  const shift = query.time - FIXTURE_TIME / 1000;
  const isObservation = query.id.endsWith('observedAt') || query.id.endsWith('historyObservedAt');
  if (response.data.resultType === 'vector') {
    for (const item of response.data.result) {
      item.value[0] += shift;
      if (isObservation || query.id === 'hostTime.value' || query.id === 'bootTime.value') item.value[1] = String(Number(item.value[1]) + shift);
      if (isObservation && scenario === 'stale') item.value[1] = String(Number(item.value[1]) - 60);
      if (scenario === 'nonfinite' && query.id === 'memoryAvailable.value') item.value[1] = 'NaN';
    }
    if (scenario === 'partial' && query.id.startsWith('memoryAvailable')) response.data.result = [];
    if (scenario === 'partial' && query.id.startsWith('filesystem')) response.data.result = response.data.result.filter((item) => item.metric.mountpoint === '/');
    if (scenario === 'duplicate' && query.id === 'memoryTotal.value') response.data.result.push(structuredClone(response.data.result[0]!));
  } else {
    for (const item of response.data.result) {
      item.values = item.values.map(([at, value]) => [at + shift, isObservation ? String(Number(value) + shift - (scenario === 'stale' ? 60 : 0)) : value]);
      if (scenario === 'history-gap') item.values = item.values.filter((_, index) => index < 24 || index > 34);
    }
  }
  return response;
}

export function fixtureResults(now = FIXTURE_TIME, scenario: FixtureScenario = 'normal'): QueryResults {
  return Object.fromEntries(buildQueries(fixtureConfig, now).map((query) => {
    const response = prometheusEnvelope.safeParse(fixtureResponse(query, scenario));
    return [query.id, response.success ? { ok: true, data: response.data.data } : { ok: false }];
  }));
}
