import type { HistoryPoint } from '../domain/monitoring';
import { time } from '../lib/format';
import { MONITORING } from '../config/monitoring';

export function TrendChart({ points, label }: { points: HistoryPoint[]; label: string }) {
  const end = points.at(-1)?.at;
  const endAt = end ? Date.parse(end) : 0;
  const startAt = endAt - 900_000;
  let lastAt: number | null = null;
  const paths: string[] = [];
  let path = '';
  for (const point of points) {
    const at = Date.parse(point.at);
    const gap = lastAt != null && at - lastAt > MONITORING.historyStepMs * 1.5;
    if (point.value == null || gap) {
      if (path) paths.push(path);
      path = '';
    }
    if (point.value != null) {
      const x = ((at - startAt) / 900_000) * 470;
      const y = 2 + (1 - point.value / 100) * 56;
      path += `${path ? ' L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
    }
    lastAt = at;
  }
  if (path) paths.push(path);
  return <div className="trend">
    <div className="chart-plot">
      <div className="chart-y-axis" aria-hidden="true"><span>100</span><span>50</span><span>0</span></div>
      <svg viewBox="0 0 470 60" preserveAspectRatio="none" role="img" aria-label={`${label}の過去15分の履歴。縦軸0〜100%。${paths.length ? '欠損区間は線を切って表示。' : '履歴を取得できません。'}`}>
        {[2, 30, 58].map((y) => <line key={y} x1="0" x2="470" y1={y} y2={y} className="chart-grid" />)}
        {[0, 157, 313, 470].map((x) => <line key={x} x1={x} x2={x} y1="2" y2="58" className="chart-grid chart-vertical" />)}
        {paths.map((d, i) => <path key={i} d={d} className="chart-line" data-testid="trend-segment" />)}
      </svg>
      {!paths.length && <span className="chart-empty">履歴データなし</span>}
    </div>
    <div className="chart-times" aria-hidden="true"><span>{end ? time(startAt).slice(0, 5) : '15 分前'}</span><span>過去 15 分</span><span>{end ? time(end).slice(0, 5) : '現在'}</span></div>
  </div>;
}
