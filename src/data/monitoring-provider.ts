import type { MonitoringSnapshot } from '../domain/monitoring';

export interface MonitoringProvider {
  getSnapshot(signal: AbortSignal): Promise<MonitoringSnapshot>;
}
