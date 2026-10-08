import { Panel } from '../../components/Panel';
import { StatusLabel } from '../../components/StatusLabel';
import { DataQualityNotice } from '../../components/DataQualityNotice';
import { TrendChart } from '../../components/TrendChart';
import { MONITORING } from '../../config/monitoring';
import { qualityAt, thresholdHealth } from '../../domain/health';
import { usagePercent } from '../../domain/metrics';
import type { MonitoringSnapshot } from '../../domain/monitoring';
import { gib, percent } from '../../lib/format';

export function MemoryPanel({ snapshot, now, failed }: { snapshot: MonitoringSnapshot | null; now: number; failed: boolean }) {
  const item = snapshot?.memory;
  const quality = qualityAt(item, now);
  const value = quality === 'unavailable' ? null : item?.value;
  const usage = value ? usagePercent(value.totalBytes, value.availableBytes) : null;
  const health = quality === 'fresh' && !failed ? thresholdHealth(usage, MONITORING.thresholds.memory) : 'unknown';
  return <Panel number="02" title="メモリ" detail="物理メモリ" status={<StatusLabel health={health} label={quality === 'unavailable' ? '取得不能' : undefined} />}>
    <div className="metric-body">
      <div className="metric-summary"><div><span className="metric-label">使用率</span><div className="metric-value"><span className="mono">{percent(usage)}</span><span className="unit">%</span></div></div><div className="metric-context">使用量 / 総容量<br /><strong className="mono">{value ? `${gib(value.totalBytes - value.availableBytes)} / ${gib(value.totalBytes)} GiB` : '— / — GiB'}</strong></div></div>
      <TrendChart label="メモリ使用率" points={snapshot?.history.memory ?? []} />
      <DataQualityNotice quality={quality} observedAt={item?.observedAt} failed={failed && !!snapshot} />
    </div>
  </Panel>;
}
