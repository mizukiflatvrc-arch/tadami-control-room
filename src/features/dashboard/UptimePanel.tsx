import { Panel } from '../../components/Panel';
import { DataQualityNotice } from '../../components/DataQualityNotice';
import { qualityAt } from '../../domain/health';
import type { MonitoringSnapshot } from '../../domain/monitoring';
import { dateTime, duration } from '../../lib/format';

export function UptimePanel({ snapshot, now, failed }: { snapshot: MonitoringSnapshot | null; now: number; failed: boolean }) {
  const item = snapshot?.uptime;
  const quality = qualityAt(item, now);
  const value = quality === 'unavailable' ? null : item?.value;
  const parts = value ? duration(value.seconds) : null;
  return <Panel number="04" title="稼働時間" detail="起動からの経過" className="uptime-panel">
    <div className="uptime-body">
      <p className="metric-label">連続稼働時間</p>
      <div className="uptime-value"><span className="mono">{parts?.days ?? '—'}</span><span>日</span><span className="mono">{parts?.hours ?? '—'}</span><span>時間</span><span className="mono">{parts?.minutes ?? '—'}</span><span>分</span></div>
      <div className="boot-time"><span>起動日時</span><span className="mono">{dateTime(value?.bootedAt)}</span></div>
      <DataQualityNotice quality={quality} observedAt={item?.observedAt} failed={failed && !!snapshot} />
    </div>
  </Panel>;
}
