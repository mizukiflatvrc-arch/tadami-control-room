import { Panel } from '../../components/Panel';
import { StatusLabel } from '../../components/StatusLabel';
import { DataQualityNotice } from '../../components/DataQualityNotice';
import { TrendChart } from '../../components/TrendChart';
import { MONITORING } from '../../config/monitoring';
import { qualityAt, thresholdHealth } from '../../domain/health';
import type { MonitoringSnapshot } from '../../domain/monitoring';
import { percent } from '../../lib/format';

export function CpuPanel({ snapshot, now, failed }: { snapshot: MonitoringSnapshot | null; now: number; failed: boolean }) {
  const item = snapshot?.cpu;
  const quality = qualityAt(item, now);
  const value = quality === 'unavailable' ? null : item?.value?.usagePercent ?? null;
  const health = quality === 'fresh' && !failed ? thresholdHealth(value, MONITORING.thresholds.cpu) : 'unknown';
  return <Panel number="01" title="CPU" detail="全論理 CPU 平均" status={<StatusLabel health={health} label={quality === 'unavailable' ? '取得不能' : undefined} />}>
    <div className="metric-body">
      <div className="metric-summary"><div><span className="metric-label">使用率</span><div className="metric-value"><span className="mono">{percent(value)}</span><span className="unit">%</span></div></div><div className="metric-context">注意 ≥ 80%<br />異常 ≥ 95%</div></div>
      <TrendChart label="CPU 使用率" points={snapshot?.history.cpu ?? []} />
      <DataQualityNotice quality={quality} observedAt={item?.observedAt} failed={failed && !!snapshot} />
    </div>
  </Panel>;
}
