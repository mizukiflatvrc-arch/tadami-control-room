// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fixtureConfig } from '../../fixtures/prometheus/config';
import { FIXTURE_TIME, fixtureResults } from '../../fixtures/prometheus/responses';
import type { QueryResults } from '../../server/prometheus/client';
import { mapSnapshot } from '../../server/prometheus/mapper';
import { buildQueries, type QueryId } from '../../server/prometheus/queries';
import { readConfig } from '../../server/config';
import { GiB, usagePercent } from '../../src/domain/metrics';
import { summarize } from '../../src/domain/health';
import { validateSnapshot } from '../../src/domain/validation';

function vector(results: QueryResults, key: QueryId) {
  const result = results[key];
  if (!result?.ok || result.data.resultType !== 'vector') throw new Error('Invalid test fixture');
  return result.data.result;
}
const env = {
  TCR_PROMETHEUS_URL: 'http://127.0.0.1:9090/prometheus/', TCR_METRIC_PROFILE: 'node-exporter-v1',
  TCR_HOST_ID: 'test', TCR_HOST_NAME: '検証ホスト', TCR_PROMETHEUS_JOB: 'fixture-node',
  TCR_PROMETHEUS_INSTANCE: 'example.invalid:9100', TCR_CPU_RATE_WINDOW_SECONDS: '60',
  TCR_FILESYSTEMS_JSON: JSON.stringify(fixtureConfig.filesystems),
};

describe('明示的なサーバー設定と固定クエリ', () => {
  it('未確認の必須設定で起動せず、OS とサービスは推測しない', () => {
    expect(() => readConfig({})).toThrow('バックエンド設定');
    expect(() => readConfig({ ...env, TCR_FILESYSTEMS_JSON: '[]' })).toThrow();
    const config = readConfig(env);
    expect(config.host.osLabel).toBe('OS 未確認');
    expect(config.services).toEqual([]);
    expect(config.prometheusUrl).toBe('http://127.0.0.1:9090/prometheus/');
  });
  it.each(['ftp://example.invalid/', 'http://name:password@example.invalid/', 'https://example.invalid/?token=secret', 'https://example.invalid/#fragment'])('不正な URL を拒否する: %s', (url) => {
    expect(() => readConfig({ ...env, TCR_PROMETHEUS_URL: url })).toThrow();
  });
  it('未知のプロファイル・無効な計算窓・重複する対象を拒否する', () => {
    expect(() => readConfig({ ...env, TCR_METRIC_PROFILE: 'guess' })).toThrow();
    expect(() => readConfig({ ...env, TCR_CPU_RATE_WINDOW_SECONDS: '5m] or up' })).toThrow();
    expect(() => readConfig({ ...env, TCR_FILESYSTEMS_JSON: JSON.stringify([fixtureConfig.filesystems[0], fixtureConfig.filesystems[0]]) })).toThrow('重複');
  });
  it('認証情報はサーバーの Authorization だけに設定し、不備を値なしで報告する', () => {
    expect(readConfig({ ...env, TCR_PROMETHEUS_AUTH: 'bearer', TCR_PROMETHEUS_TOKEN: 'test-only-token' }).authorization).toBe('Bearer test-only-token');
    expect(readConfig({ ...env, TCR_PROMETHEUS_AUTH: 'basic', TCR_PROMETHEUS_USERNAME: 'test-user', TCR_PROMETHEUS_PASSWORD: 'test-password' }).authorization).toBe(`Basic ${Buffer.from('test-user:test-password').toString('base64')}`);
    expect(() => readConfig({ ...env, TCR_PROMETHEUS_AUTH: 'bearer', TCR_PROMETHEUS_TOKEN: 'do-not-print\nsecret' })).toThrow(/^認証設定を確認してください: TCR_PROMETHEUS_TOKEN$/);
  });
  it('クエリは22個に固定し、対象ラベルをエスケープして完全一致で選ぶ', () => {
    const job = 'node"} or up{job="injected\\\n';
    const config = { ...fixtureConfig, job };
    const queries = buildQueries(config, FIXTURE_TIME);
    expect(queries).toHaveLength(22);
    expect(queries.filter((item) => item.kind === 'range')).toHaveLength(6);
    for (const query of queries) {
      expect(query.expression).toContain(`job=${JSON.stringify(job)}`);
      expect(query.expression).toContain('instance="example.invalid:9100"');
      expect(query.time - query.start).toBe(900);
    }
    expect(queries.find((q) => q.id === 'cpuIdle.value')!.expression).toBe(`rate(node_cpu_seconds_total{job=${JSON.stringify(job)},instance="example.invalid:9100",mode="idle"}[60s])`);
    expect(queries.find((q) => q.id === 'filesystemSize.value')!.expression).toContain('device="/dev/example-data",mountpoint="/srv/example",fstype="xfs"');
  });
});

describe('Prometheus 応答から MonitoringSnapshot への変換', () => {
  it('CPU はコア平均、メモリと容量は bytes、稼働時間はホスト時計から求める', () => {
    const snapshot = mapSnapshot(fixtureResults(), fixtureConfig, FIXTURE_TIME);
    expect(snapshot.source).toBe('prometheus');
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.cpu.value!.usagePercent).toBeCloseTo(20);
    expect(snapshot.memory.value).toEqual({ totalBytes: 16 * GiB, availableBytes: 12 * GiB });
    const root = snapshot.filesystems[0]!.capacity.value!;
    expect(root).toEqual({ totalBytes: 100 * GiB, freeBytes: 40 * GiB, availableBytes: 35 * GiB });
    expect(usagePercent(root.totalBytes, root.freeBytes)).toBe(60);
    expect(snapshot.uptime.value!.seconds).toBe(864000);
    expect(snapshot.history.cpu).toHaveLength(61);
    expect(snapshot.history.cpu[0]!.value).toBeCloseTo(20);
    expect(snapshot.history.memory.at(-1)!.value).toBe(25);
    expect(validateSnapshot(snapshot, FIXTURE_TIME)).toEqual(snapshot);
  });
  it('取得時刻ではなく timestamp() の値で鮮度を判定する', () => {
    const snapshot = mapSnapshot(fixtureResults(FIXTURE_TIME, 'stale'), fixtureConfig, FIXTURE_TIME);
    expect(snapshot.fetchedAt).toBe(new Date(FIXTURE_TIME).toISOString());
    expect(snapshot.cpu.observedAt).toBe(new Date(FIXTURE_TIME - 65_000).toISOString());
    expect(snapshot.cpu.quality).toBe('stale');
    expect(snapshot.memory.quality).toBe('stale');
    expect(snapshot.history.cpu.every((point) => point.value === null)).toBe(true);
  });
  it('通信中に履歴の区切りを跨いでもクエリの時刻を使い、取得時刻は完了時とする', () => {
    const queriedAt = FIXTURE_TIME + 14_000;
    const fetchedAt = FIXTURE_TIME + 16_000;
    const snapshot = mapSnapshot(fixtureResults(queriedAt), fixtureConfig, queriedAt, fetchedAt);
    expect(snapshot.fetchedAt).toBe(new Date(fetchedAt).toISOString());
    expect(snapshot.history.cpu.at(-1)!.value).toBeCloseTo(20);
    expect(snapshot.history.cpu.at(-1)!.at).toBe(new Date(FIXTURE_TIME).toISOString());
  });
  it('未確定のサービスは不明、観測時刻なしとする', () => {
    const snapshot = mapSnapshot(fixtureResults(), fixtureConfig, FIXTURE_TIME);
    expect(snapshot.services[0]!.state).toEqual({ value: 'unknown', quality: 'unavailable', observedAt: null, reason: '計測方式未確定' });
    expect(summarize(snapshot, FIXTURE_TIME).health).toBe('unknown');
    const empty = mapSnapshot(fixtureResults(), { ...fixtureConfig, services: [] }, FIXTURE_TIME);
    expect(empty.services).toEqual([]);
    expect(summarize(empty, FIXTURE_TIME).health).toBe('unknown');
  });
  it('系列が欠損しても対象行を保持し、他の指標を表示できる', () => {
    const snapshot = mapSnapshot(fixtureResults(FIXTURE_TIME, 'partial'), fixtureConfig, FIXTURE_TIME);
    expect(snapshot.cpu.quality).toBe('fresh');
    expect(snapshot.memory.value).toBeNull();
    expect(snapshot.filesystems).toHaveLength(2);
    expect(snapshot.filesystems[1]!.capacity.quality).toBe('unavailable');
    expect(snapshot.filesystems[0]!.capacity.value).not.toBeNull();
  });
  it.each(['NaN', '+Inf', '-Inf', 'Infinity', '', ' ', '0xFF', '-1', '99999999999999999'])('不正なメモリ値 %s を欠損として扱う', (value) => {
    const results = fixtureResults();
    vector(results, 'memoryAvailable.value')[0]!.value[1] = value;
    expect(mapSnapshot(results, fixtureConfig, FIXTURE_TIME).memory.value).toBeNull();
  });
  it('重複系列・未来時刻・不正な容量関係を正常値にしない', () => {
    expect(mapSnapshot(fixtureResults(FIXTURE_TIME, 'duplicate'), fixtureConfig, FIXTURE_TIME).memory.value).toBeNull();
    const results = fixtureResults();
    vector(results, 'memoryAvailable.observedAt')[0]!.value[1] = String(FIXTURE_TIME / 1000 + 60);
    vector(results, 'filesystemAvailable.value')[0]!.value[1] = String(99 * GiB);
    vector(results, 'cpuIdle.value').push(structuredClone(vector(results, 'cpuIdle.value')[0]!));
    const snapshot = mapSnapshot(results, fixtureConfig, FIXTURE_TIME);
    expect(snapshot.memory.value).toBeNull();
    expect(snapshot.cpu.value).toBeNull();
    expect(snapshot.filesystems[0]!.capacity.value).toBeNull();
  });
  it('ホストとファイルシステムのラベルが一致しない系列を使用しない', () => {
    const results = fixtureResults();
    vector(results, 'memoryTotal.value')[0]!.metric.instance = 'other.invalid:9100';
    vector(results, 'filesystemSize.value')[0]!.metric.device = '/dev/other';
    const snapshot = mapSnapshot(results, fixtureConfig, FIXTURE_TIME);
    expect(snapshot.memory.value).toBeNull();
    expect(snapshot.filesystems[0]!.capacity.value).toBeNull();
  });
  it('履歴が欠けた区間を null で残し、ゼロで埋めない', () => {
    const snapshot = mapSnapshot(fixtureResults(FIXTURE_TIME, 'history-gap'), fixtureConfig, FIXTURE_TIME);
    expect(snapshot.history.cpu[25]!.value).toBeNull();
    expect(snapshot.history.memory[25]!.value).toBeNull();
    expect(snapshot.history.cpu[35]!.value).toBeCloseTo(20);
  });
  it('計測値はあっても時刻クエリが失敗したら鮮度を捏造しない', () => {
    const results = fixtureResults();
    results['cpuIdle.observedAt'] = { ok: false };
    results['memoryTotal.observedAt'] = { ok: false };
    const snapshot = mapSnapshot(results, fixtureConfig, FIXTURE_TIME);
    expect(snapshot.cpu.value).toBeNull();
    expect(snapshot.memory.value).toBeNull();
    expect(snapshot.uptime.value).not.toBeNull();
  });
});
