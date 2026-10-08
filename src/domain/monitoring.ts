export type Quality = 'fresh' | 'stale' | 'unavailable';
export type Health = 'normal' | 'warning' | 'critical' | 'unknown';
export type ServiceState = 'running' | 'stopped' | 'failed' | 'unknown';
export type Observation<T> = {
  value: T | null;
  observedAt: string | null;
  quality: Quality;
  reason: string | null;
};
export type HistoryPoint = { at: string; value: number | null };
export type Capacity = { totalBytes: number; freeBytes: number; availableBytes: number };
export type Filesystem = { id: string; mountpoint: string; capacity: Observation<Capacity> };
export type Service = {
  id: string;
  name: string;
  expectedState: 'running' | 'stopped';
  state: Observation<ServiceState>;
};
export type MonitoringSnapshot = {
  schemaVersion: 1;
  source: 'mock' | 'prometheus';
  host: { id: string; name: string; osLabel: string };
  fetchedAt: string;
  cpu: Observation<{ usagePercent: number }>;
  memory: Observation<{ totalBytes: number; availableBytes: number }>;
  filesystems: Filesystem[];
  uptime: Observation<{ seconds: number; bootedAt: string }>;
  services: Service[];
  history: { cpu: HistoryPoint[]; memory: HistoryPoint[] };
};
