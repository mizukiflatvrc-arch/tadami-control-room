import { MOCK_FILESYSTEMS, MOCK_HOST, MOCK_SERVICES } from '../../config/mock-targets';
import { MONITORING } from '../../config/monitoring';
import { GiB } from '../../domain/metrics';
import type { MonitoringSnapshot, Observation } from '../../domain/monitoring';
import type { Scenario } from './scenarios';
import { noise } from './seeded-random';

export function createFixture(now: number, scenario: Scenario = 'normal', seed = 1994, bootAt = now - 12 * 86400_000 - 8 * 3600_000 - 32 * 60_000): MonitoringSnapshot {
  const observed = scenario === 'stale' ? now - 60_000 : now;
  const at = new Date(observed).toISOString();
  const obs = <T>(value: T): Observation<T> => ({ value, observedAt: at, quality: 'fresh', reason: null });
  const missing = <T>(): Observation<T> => ({ value: null, observedAt: null, quality: 'unavailable', reason: '観測値が欠損しています' });
  const end = Math.floor(observed / MONITORING.historyStepMs) * MONITORING.historyStepMs;
  const history = Array.from({ length: MONITORING.historyPoints }, (_, i) => {
    const pointAt = end - (MONITORING.historyPoints - 1 - i) * MONITORING.historyStepMs;
    const slot = Math.floor(pointAt / MONITORING.historyStepMs);
    const baseCpu = 16 + Math.sin(slot * 0.23) * 6 + noise(seed, slot) * 12;
    const baseMemory = 41 + Math.sin(slot * 0.07) * 2 + noise(seed + 1, slot) * 0.6;
    const recent = i > 44;
    return {
      at: new Date(pointAt).toISOString(),
      cpu: recent && (scenario === 'cpu-critical' || scenario === 'mixed') ? 97.2 + noise(seed, slot) : recent && scenario === 'warning' ? 84.3 + noise(seed, slot) : baseCpu,
      memory: recent && scenario === 'memory-critical' ? 96.8 + noise(seed, slot) : baseMemory,
    };
  });
  const last = history.at(-1)!;
  const snapshot: MonitoringSnapshot = {
    schemaVersion: 1, source: 'mock', host: { ...MOCK_HOST }, fetchedAt: new Date(now).toISOString(),
    cpu: obs({ usagePercent: last.cpu }),
    memory: obs({ totalBytes: 32 * GiB, availableBytes: (1 - last.memory / 100) * 32 * GiB }),
    filesystems: MOCK_FILESYSTEMS.map((fs) => {
      const usedPercent = scenario === 'storage-critical' && fs.id === 'data' ? 94.6 : fs.usedPercent;
      return { id: fs.id, mountpoint: fs.mountpoint, capacity: obs({ totalBytes: fs.sizeGiB * GiB, freeBytes: fs.sizeGiB * GiB * (1 - usedPercent / 100), availableBytes: fs.sizeGiB * GiB * (1 - usedPercent / 100 - 0.02) }) };
    }),
    uptime: obs({ seconds: Math.max(0, Math.floor((observed - bootAt) / 1000)), bootedAt: new Date(bootAt).toISOString() }),
    services: MOCK_SERVICES.map((service) => ({ ...service, state: obs(service.expectedState) })),
    history: {
      cpu: history.map((p, i) => ({ at: p.at, value: scenario === 'history-gap' && i >= 24 && i <= 34 ? null : p.cpu })),
      memory: history.map((p, i) => ({ at: p.at, value: scenario === 'history-gap' && i >= 24 && i <= 34 ? null : p.memory })),
    },
  };
  if (scenario === 'partial' || scenario === 'mixed') {
    snapshot.memory = missing();
    snapshot.history.memory = snapshot.history.memory.map((p) => ({ ...p, value: null }));
  }
  if (scenario === 'partial') {
    snapshot.filesystems[1]!.capacity = missing();
    snapshot.services[1]!.state = missing();
  }
  if (scenario === 'service-stopped') snapshot.services[0]!.state = obs('stopped');
  if (scenario === 'service-failed') snapshot.services[0]!.state = obs('failed');
  if (scenario === 'many-rows') {
    snapshot.filesystems = Array.from({ length: 10 }, (_, i) => ({ ...snapshot.filesystems[i % 3]!, id: `volume-${i}`, mountpoint: `/srv/archive/研究記録の長いディレクトリ名/observation-records-volume-${i}` }));
    snapshot.services = Array.from({ length: 20 }, (_, i) => ({ ...snapshot.services[i % 4]!, id: `service-${i}`, name: `観測記録の長期保存およびバックアップ検証サービス-${i}` }));
  }
  return snapshot;
}
