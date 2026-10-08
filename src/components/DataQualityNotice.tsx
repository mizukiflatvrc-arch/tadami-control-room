import type { Quality } from '../domain/monitoring';
import { time } from '../lib/format';

export function DataQualityNotice({ quality, observedAt, failed }: { quality: Quality; observedAt?: string | null; failed: boolean }) {
  return <div className={`observation-note ${quality !== 'fresh' || failed ? 'observation-warning' : ''}`}>
    <span>{failed ? '取得失敗 · 前回の観測値' : quality === 'stale' ? '更新遅延 · 前回の観測値' : quality === 'unavailable' ? '取得不能 · 観測値なし' : '観測時刻'}</span>
    <span className="mono">{time(observedAt)} <span className="muted">JST</span></span>
  </div>;
}
