import { Panel } from '../../components/Panel';
import { StatusLabel } from '../../components/StatusLabel';
import { qualityAt, serviceHealth } from '../../domain/health';
import type { MonitoringSnapshot } from '../../domain/monitoring';
import { time } from '../../lib/format';

export function ServicesPanel({ snapshot, now, failed }: { snapshot: MonitoringSnapshot | null; now: number; failed: boolean }) {
  return <Panel number="05" title="サービス状態" detail="期待状態との照合">
    <div className="table-wrap"><table className="services-table"><caption className="sr-only">サービス状態と確認時刻</caption>
      <thead><tr><th scope="col">サービス名</th><th scope="col">状態</th><th scope="col">確認時刻</th></tr></thead>
      <tbody>{snapshot?.services.length === 0 && <tr><td colSpan={3} className="empty-table">不明 — 監視対象・計測方式は未設定です</td></tr>}{snapshot?.services.map((service) => {
        const quality = qualityAt(service.state, now);
        const valid = quality === 'fresh' && !failed;
        const health = valid ? serviceHealth(service) : 'unknown';
        const state = service.state.value;
        const label = state === 'unknown' ? '不明' : quality === 'unavailable' ? '取得不能' : state === 'running' ? '稼働中' : state === 'failed' ? '異常' : '停止';
        return <tr key={service.id}><th scope="row">{service.name}{service.expectedState === 'stopped' && <span className="expected-stop">停止を予定</span>}</th><td><StatusLabel health={health} label={label} />{state === 'unknown' && <span className="previous-state">{service.state.reason}</span>}{quality !== 'unavailable' && !valid && <span className="previous-state">{failed ? '前回の状態' : '更新遅延'}</span>}</td><td className="mono row-time">{time(service.state.observedAt)}</td></tr>;
      }) ?? <tr><td colSpan={3} className="empty-table">{failed ? '取得不能 — サービス情報がありません' : 'サービス情報を取得中…'}</td></tr>}</tbody>
    </table></div>
  </Panel>;
}
