import { MONITORING } from '../config/monitoring';
import { usagePercent } from './metrics';
import type { Health, MonitoringSnapshot, Observation, Quality, Service } from './monitoring';

export function qualityAt<T>(observation: Observation<T> | undefined, now: number): Quality {
  if (!observation || observation.value == null || !observation.observedAt || observation.quality === 'unavailable') return 'unavailable';
  const at = Date.parse(observation.observedAt);
  if (!Number.isFinite(at) || at > now + 1000) return 'unavailable';
  return observation.quality === 'stale' || now - at > MONITORING.staleMs ? 'stale' : 'fresh';
}
export function thresholdHealth(value: number | null, limits: readonly [number, number]): Health {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 100) return 'unknown';
  return value >= limits[1] ? 'critical' : value >= limits[0] ? 'warning' : 'normal';
}
export function serviceHealth(service: Service): Health {
  const value = service.state.value;
  if (!value || value === 'unknown') return 'unknown';
  if (value === 'failed') return 'critical';
  if (value === service.expectedState) return 'normal';
  return value === 'stopped' ? 'warning' : 'critical';
}
export function combineHealth(values: Health[]): Health {
  if (values.includes('critical')) return 'critical';
  if (!values.length || values.includes('unknown')) return 'unknown';
  return values.includes('warning') ? 'warning' : 'normal';
}
export function summarize(snapshot: MonitoringSnapshot | null, now: number, failed = false): { health: Health; incomplete: boolean } {
  if (!snapshot) return { health: 'unknown', incomplete: true };
  const observed = <T>(item: Observation<T>, health: Health): Health => qualityAt(item, now) === 'fresh' && !failed ? health : 'unknown';
  const memory = snapshot.memory.value;
  const states = [
    observed(snapshot.cpu, thresholdHealth(snapshot.cpu.value?.usagePercent ?? null, MONITORING.thresholds.cpu)),
    observed(snapshot.memory, thresholdHealth(memory ? usagePercent(memory.totalBytes, memory.availableBytes) : null, MONITORING.thresholds.memory)),
    observed(snapshot.uptime, 'normal'),
    ...(snapshot.services.length === 0 ? ['unknown' as const] : []),
    ...snapshot.filesystems.map(({ capacity }) => observed(capacity, thresholdHealth(capacity.value ? usagePercent(capacity.value.totalBytes, capacity.value.freeBytes) : null, MONITORING.thresholds.storage))),
    ...snapshot.services.map((service) => observed(service.state, serviceHealth(service))),
  ];
  return { health: combineHealth(states), incomplete: states.includes('unknown') };
}
