import { MONITORING } from '../../src/config/monitoring';
import type { HistoryPoint, MonitoringSnapshot, Observation } from '../../src/domain/monitoring';
import { validateSnapshot } from '../../src/domain/validation';
import type { ServerConfig } from '../config';
import type { PromData, QueryResults } from './client';
import type { MetricKey, QueryId } from './queries';

type Labels = Record<string, string>;
type Reading = { value: number; observedAt: number };
type VectorEntry = Extract<PromData, { resultType: 'vector' }>['result'][number];
type MatrixEntry = Extract<PromData, { resultType: 'matrix' }>['result'][number];

function number(value: string | undefined): number | null {
  if (value == null || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function unavailable<T>(reason = '対象系列が欠損・重複しているか、取得値が不正です'): Observation<T> {
  return { value: null, observedAt: null, quality: 'unavailable', reason };
}
function observation<T>(value: T, observedAt: number, now: number): Observation<T> {
  if (observedAt < 0 || observedAt * 1000 > now + 1000) return unavailable();
  const stale = now - observedAt * 1000 > MONITORING.staleMs;
  return { value, observedAt: new Date(observedAt * 1000).toISOString(), quality: stale ? 'stale' : 'fresh', reason: stale ? '元メトリクスの更新が遅延しています' : null };
}
function scoped(labels: Labels, config: ServerConfig) {
  return labels.job === config.job && labels.instance === config.instance;
}
function entries(results: QueryResults, id: QueryId): VectorEntry[] {
  const result = results[id];
  return result?.ok && result.data.resultType === 'vector' ? result.data.result : [];
}
function gauge(results: QueryResults, key: MetricKey, config: ServerConfig, filter: (labels: Labels) => boolean = () => true): Reading | null {
  const choose = (id: QueryId) => entries(results, id).filter((entry) => scoped(entry.metric, config) && filter(entry.metric));
  const values = choose(`${key}.value`);
  const times = choose(`${key}.observedAt`);
  if (values.length !== 1 || times.length !== 1) return null;
  const value = number(values[0]!.value[1]);
  const observedAt = number(times[0]!.value[1]);
  return value == null || observedAt == null || observedAt < 0 || observedAt > times[0]!.value[0] + 1 ? null : { value, observedAt };
}
function cpuReadings(results: QueryResults, config: ServerConfig): Reading[] {
  const values = entries(results, 'cpuIdle.value').filter((entry) => scoped(entry.metric, config));
  const times = entries(results, 'cpuIdle.observedAt').filter((entry) => scoped(entry.metric, config));
  const validCore = (entry: VectorEntry) => !!entry.metric.cpu && entry.metric.mode === 'idle';
  if (!values.length || !values.every(validCore) || !times.every(validCore)) return [];
  const ids = values.map((entry) => entry.metric.cpu!);
  if (new Set(ids).size !== ids.length || times.length !== ids.length) return [];
  const readings = ids.map((cpu) => gauge(results, 'cpuIdle', config, (labels) => labels.cpu === cpu && labels.mode === 'idle'));
  return readings.every((item) => item && item.value >= 0 && item.value <= 1) ? readings as Reading[] : [];
}

function matrix(results: QueryResults, id: QueryId, config: ServerConfig): MatrixEntry[] {
  const result = results[id];
  return result?.ok && result.data.resultType === 'matrix' ? result.data.result.filter((entry) => scoped(entry.metric, config)) : [];
}
function historyValue(entry: MatrixEntry | undefined, at: number): number | null {
  const matches = entry?.values.filter(([time]) => time === at) ?? [];
  return matches.length === 1 ? number(matches[0]![1]) : null;
}
function fresh(value: number | null, at: number) {
  return value != null && value >= 0 && value <= at + 1 && at - value <= MONITORING.staleMs / 1000;
}

function histories(results: QueryResults, config: ServerConfig, now: number): MonitoringSnapshot['history'] {
  const end = Math.floor(now / 15000) * 15;
  const cpu = matrix(results, 'cpuIdle.history', config);
  const cpuTimes = matrix(results, 'cpuIdle.historyObservedAt', config);
  const coreIds = cpu.map((entry) => entry.metric.cpu);
  const uniqueCores = cpu.length > 0 && cpu.every((entry) => entry.metric.cpu && entry.metric.mode === 'idle') && new Set(coreIds).size === cpu.length && cpuTimes.length === cpu.length;
  const memTotal = matrix(results, 'memoryTotal.history', config);
  const memAvailable = matrix(results, 'memoryAvailable.history', config);
  const memTotalTimes = matrix(results, 'memoryTotal.historyObservedAt', config);
  const memAvailableTimes = matrix(results, 'memoryAvailable.historyObservedAt', config);
  const memoryUnique = [memTotal, memAvailable, memTotalTimes, memAvailableTimes].every((list) => list.length === 1);
  const cpuHistory: HistoryPoint[] = [];
  const memoryHistory: HistoryPoint[] = [];
  for (let i = 0; i < 61; i += 1) {
    const at = end - (60 - i) * 15;
    const iso = new Date(at * 1000).toISOString();
    const rates = cpu.map((entry) => {
      const stamps = cpuTimes.filter((item) => item.metric.cpu === entry.metric.cpu && item.metric.mode === 'idle');
      const rate = historyValue(entry, at);
      return stamps.length === 1 && fresh(historyValue(stamps[0], at), at) && rate != null && rate >= 0 && rate <= 1 ? rate : null;
    });
    cpuHistory.push({ at: iso, value: uniqueCores && rates.every((rate) => rate != null) ? 100 * (1 - (rates as number[]).reduce((sum, rate) => sum + rate, 0) / rates.length) : null });
    const total = historyValue(memTotal[0], at);
    const available = historyValue(memAvailable[0], at);
    const valid = memoryUnique && total != null && available != null && total > 0 && available >= 0 && available <= total && fresh(historyValue(memTotalTimes[0], at), at) && fresh(historyValue(memAvailableTimes[0], at), at);
    memoryHistory.push({ at: iso, value: valid ? (1 - available / total) * 100 : null });
  }
  return { cpu: cpuHistory, memory: memoryHistory };
}

export function mapSnapshot(results: QueryResults, config: ServerConfig, queriedAt: number, fetchedAt = queriedAt): MonitoringSnapshot {
  const now = fetchedAt;
  const cpu = cpuReadings(results, config);
  const total = gauge(results, 'memoryTotal', config);
  const available = gauge(results, 'memoryAvailable', config);
  const hostTime = gauge(results, 'hostTime', config);
  const bootTime = gauge(results, 'bootTime', config);
  const bootDate = bootTime ? new Date(bootTime.value * 1000) : null;
  const snapshot: MonitoringSnapshot = {
    schemaVersion: 1, source: 'prometheus', host: { ...config.host }, fetchedAt: new Date(now).toISOString(),
    cpu: cpu.length ? observation({ usagePercent: 100 * (1 - cpu.reduce((sum, item) => sum + item.value, 0) / cpu.length) }, Math.min(...cpu.map((item) => item.observedAt)), now) : unavailable(),
    memory: total && available ? observation({ totalBytes: total.value, availableBytes: available.value }, Math.min(total.observedAt, available.observedAt), now) : unavailable(),
    uptime: hostTime && bootTime && bootDate && Number.isFinite(bootDate.getTime())
      ? observation({ seconds: hostTime.value - bootTime.value, bootedAt: bootDate.toISOString() }, Math.min(hostTime.observedAt, bootTime.observedAt), now) : unavailable(),
    filesystems: config.filesystems.map((fs) => {
      const filter = (labels: Labels) => labels.mountpoint === fs.mountpoint && labels.device === fs.device && labels.fstype === fs.fstype;
      const size = gauge(results, 'filesystemSize', config, filter);
      const free = gauge(results, 'filesystemFree', config, filter);
      const available = gauge(results, 'filesystemAvailable', config, filter);
      return { id: fs.id, mountpoint: fs.mountpoint, capacity: size && free && available ? observation({ totalBytes: size.value, freeBytes: free.value, availableBytes: available.value }, Math.min(size.observedAt, free.observedAt, available.observedAt), now) : unavailable() };
    }),
    services: config.services.map((service) => ({ ...service, state: { value: 'unknown', quality: 'unavailable', observedAt: null, reason: '計測方式未確定' } })),
    history: histories(results, config, queriedAt),
  };
  return validateSnapshot(snapshot, now);
}
