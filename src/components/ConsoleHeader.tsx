import { dateTime } from '../lib/format';
import type { MonitoringSnapshot } from '../domain/monitoring';

export function ConsoleHeader({ now, host }: { now: number; host?: MonitoringSnapshot['host'] }) {
  return <header className="console-header">
    <div className="brand-row">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true"><path d="M1 1h38v38H1zM1 13h38M13 1v38" /><path d="M17 27h4l3-8 5 13 3-5h4" /></svg>
        <div><p className="eyebrow">自宅サーバー監視システム <span className="beta">β0.1</span></p><h1>TADAMI CONTROL ROOM</h1></div>
      </div>
      <div className="terminal-id"><strong>総合監視</strong><span>端末 <span className="mono">01 / TADAMI</span></span></div>
    </div>
    <div className="host-line"><div><span className="meta-label">監視対象</span><strong className="mono">{host?.name ?? 'tadami'}</strong><span className="os-label">{host?.osLabel ?? 'Ubuntu 24.04.5 LTS'}</span></div><div className="clock"><span className="meta-label">現在時刻</span><time className="mono" dateTime={new Date(now).toISOString()}>{dateTime(now)}</time><span className="muted">JST</span></div></div>
  </header>;
}
