import type { ServerConfig } from '../config';

export const METRICS = {
  cpuIdle: 'node_cpu_seconds_total',
  memoryTotal: 'node_memory_MemTotal_bytes',
  memoryAvailable: 'node_memory_MemAvailable_bytes',
  filesystemSize: 'node_filesystem_size_bytes',
  filesystemFree: 'node_filesystem_free_bytes',
  filesystemAvailable: 'node_filesystem_avail_bytes',
  bootTime: 'node_boot_time_seconds',
  hostTime: 'node_time_seconds',
} as const;
export type MetricKey = keyof typeof METRICS;
export type QueryId = `${MetricKey}.${'value' | 'observedAt' | 'history' | 'historyObservedAt'}`;
export type Query = { id: QueryId; expression: string; kind: 'instant' | 'range'; time: number; start: number; step: 15 };
export const HISTORY_METRICS: readonly MetricKey[] = ['cpuIdle', 'memoryTotal', 'memoryAvailable'];

/** Only these templates generate PromQL. Labels are exact, escaped string literals. */
export function buildQueries(config: ServerConfig, now: number): Query[] {
  const scope = `job=${JSON.stringify(config.job)},instance=${JSON.stringify(config.instance)}`;
  const time = now / 1000;
  const end = Math.floor(time / 15) * 15;
  return (Object.keys(METRICS) as MetricKey[]).flatMap((key) => {
    const selectors = key.startsWith('filesystem')
      ? config.filesystems.map((fs) => `${METRICS[key]}{${scope},device=${JSON.stringify(fs.device)},mountpoint=${JSON.stringify(fs.mountpoint)},fstype=${JSON.stringify(fs.fstype)}}`)
      : [`${METRICS[key]}{${scope}${key === 'cpuIdle' ? ',mode="idle"' : ''}}`];
    const raw = selectors.length === 1 ? selectors[0]! : `(${selectors.join(' or ')})`;
    const value = key === 'cpuIdle' ? `rate(${raw}[${config.cpuRateWindowSeconds}s])` : raw;
    const observedAt = `timestamp(${raw})`;
    const query = (suffix: 'value' | 'observedAt' | 'history' | 'historyObservedAt', expression: string, kind: Query['kind']): Query => ({
      id: `${key}.${suffix}`, expression, kind, time: kind === 'range' ? end : time, start: end - 900, step: 15,
    });
    return [
      query('value', value, 'instant'), query('observedAt', observedAt, 'instant'),
      ...(HISTORY_METRICS.includes(key) ? [query('history', value, 'range'), query('historyObservedAt', observedAt, 'range')] : []),
    ];
  });
}
