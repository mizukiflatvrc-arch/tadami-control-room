import { Panel } from '../../components/Panel';
import { StatusLabel } from '../../components/StatusLabel';
import { MONITORING } from '../../config/monitoring';
import { qualityAt, thresholdHealth } from '../../domain/health';
import { usagePercent } from '../../domain/metrics';
import type { MonitoringSnapshot } from '../../domain/monitoring';
import { gib, percent, time } from '../../lib/format';

export function StoragePanel({ snapshot, now, failed }: { snapshot: MonitoringSnapshot | null; now: number; failed: boolean }) {
  return <Panel number="03" title="ストレージ" detail="ファイルシステム使用状況" className="storage-panel">
    <div className="table-wrap"><table className="storage-table"><caption className="sr-only">ストレージ使用状況。容量は GiB 単位。</caption>
      <thead><tr><th scope="col">マウント先</th><th scope="col">使用量 / 総容量</th><th scope="col">利用可能量</th><th scope="col">使用率</th><th scope="col">判定 / 観測時刻</th></tr></thead>
      <tbody>{snapshot?.filesystems.map((fs) => {
        const quality = qualityAt(fs.capacity, now);
        const value = quality === 'unavailable' ? null : fs.capacity.value;
        const usage = value ? usagePercent(value.totalBytes, value.freeBytes) : null;
        const health = quality === 'fresh' && !failed ? thresholdHealth(usage, MONITORING.thresholds.storage) : 'unknown';
        return <tr key={fs.id}>
          <th scope="row" className="mountpoint">{fs.mountpoint}</th>
          <td data-label="使用量 / 総容量" className="mono">{value ? `${gib(value.totalBytes - value.freeBytes)} / ${gib(value.totalBytes)}` : '— / —'} <span className="muted">GiB</span></td>
          <td data-label="利用可能量" className="mono">{value ? gib(value.availableBytes) : '—'} <span className="muted">GiB</span></td>
          <td data-label="使用率"><div className="usage-cell"><span className="meter" aria-hidden="true"><span style={{ width: `${usage ?? 0}%` }} /></span><span className="mono">{percent(usage)} %</span></div></td>
          <td data-label="判定 / 観測時刻"><div className="row-status"><StatusLabel health={health} label={quality === 'unavailable' ? '取得不能' : failed ? '前回値' : quality === 'stale' ? '更新遅延' : undefined} /><span className="row-time mono">{time(fs.capacity.observedAt)}</span></div></td>
        </tr>;
      }) ?? <tr><td colSpan={5} className="empty-table">{failed ? '取得不能 — ストレージ情報がありません' : 'ストレージ情報を取得中…'}</td></tr>}</tbody>
    </table></div>
    <p className="table-note">容量は 1024 基数。予約領域のため、使用量と利用可能量の合計は総容量と異なります。</p>
  </Panel>;
}
