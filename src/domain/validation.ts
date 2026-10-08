import { z } from 'zod';
import { MONITORING } from '../config/monitoring';
import type { HistoryPoint, MonitoringSnapshot, Observation } from './monitoring';

const iso = z.iso.datetime();
const nonnegative = z.number().nonnegative();
const rawObservation = z.object({
  value: z.unknown(), observedAt: z.string().nullable(),
  quality: z.enum(['fresh', 'stale', 'unavailable']), reason: z.string().nullable(),
});
const memoryValue = z.object({ totalBytes: z.number().positive(), availableBytes: nonnegative })
  .refine((v) => v.availableBytes <= v.totalBytes);
const capacityValue = z.object({ totalBytes: z.number().positive(), freeBytes: nonnegative, availableBytes: nonnegative })
  .refine((v) => v.availableBytes <= v.freeBytes && v.freeBytes <= v.totalBytes);
const snapshotSchema = z.object({
  schemaVersion: z.literal(1), source: z.enum(['mock', 'prometheus']),
  host: z.object({ id: z.string(), name: z.string(), osLabel: z.string() }), fetchedAt: iso,
  cpu: rawObservation, memory: rawObservation, uptime: rawObservation,
  filesystems: z.array(z.object({ id: z.string(), mountpoint: z.string(), capacity: rawObservation })).min(1),
  services: z.array(z.object({ id: z.string(), name: z.string(), expectedState: z.enum(['running', 'stopped']), state: rawObservation })).min(1),
  history: z.object({ cpu: z.array(z.unknown()), memory: z.array(z.unknown()) }),
});

function observation<T>(raw: z.infer<typeof rawObservation>, schema: z.ZodType<T>, now: number): Observation<T> {
  const parsed = schema.safeParse(raw.value);
  const validTime = iso.safeParse(raw.observedAt).success && Date.parse(raw.observedAt!) <= now + 1000;
  if (!parsed.success || !validTime || raw.quality === 'unavailable') {
    return { value: null, observedAt: validTime ? raw.observedAt : null, quality: 'unavailable', reason: raw.reason ?? '観測値を取得できません' };
  }
  return { ...raw, value: parsed.data };
}
function history(raw: unknown[], now: number): HistoryPoint[] {
  const pointSchema = z.object({ at: iso, value: z.unknown() });
  const points = new Map<string, HistoryPoint>();
  for (const entry of raw) {
    const result = pointSchema.safeParse(entry);
    if (!result.success) continue;
    const { at, value } = result.data;
    if (Date.parse(at) > now + 1000 || Date.parse(at) < now - 900_000) continue;
    const valid = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
    points.set(at, { at, value: valid ? value : null });
  }
  return [...points.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MONITORING.historyPoints);
}
export function validateSnapshot(input: unknown, now: number): MonitoringSnapshot {
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success || Date.parse(parsed.data.fetchedAt) > now + 1000) throw new Error('監視データの形式または時刻が不正です');
  const raw = parsed.data;
  if (new Set(raw.filesystems.map((v) => v.id)).size !== raw.filesystems.length || new Set(raw.services.map((v) => v.id)).size !== raw.services.length) throw new Error('監視対象の識別子が重複しています');
  return {
    ...raw,
    cpu: observation(raw.cpu, z.object({ usagePercent: z.number().min(0).max(100) }), now),
    memory: observation(raw.memory, memoryValue, now),
    uptime: observation(raw.uptime, z.object({ seconds: nonnegative, bootedAt: iso })
      .refine((v) => Date.parse(v.bootedAt) <= now), now),
    filesystems: raw.filesystems.map((fs) => ({ ...fs, capacity: observation(fs.capacity, capacityValue, now) })),
    services: raw.services.map((service) => ({ ...service, state: observation(service.state, z.enum(['running', 'stopped', 'failed', 'unknown']), now) })),
    history: { cpu: history(raw.history.cpu, now), memory: history(raw.history.memory, now) },
  };
}
