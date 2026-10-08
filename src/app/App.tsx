import { useState } from 'react';
import { createProvider } from './create-provider';
import { ConsoleHeader } from '../components/ConsoleHeader';
import { ConsoleFooter } from '../components/ConsoleFooter';
import { StatusLabel } from '../components/StatusLabel';
import { summarize } from '../domain/health';
import { time } from '../lib/format';
import { useMonitoring } from '../features/dashboard/use-monitoring';
import { Dashboard } from '../features/dashboard/Dashboard';
import { MockScenarioControl } from '../features/dashboard/MockScenarioControl';
import type { Scenario } from '../data/mock/scenarios';

export function App() {
  const [source] = useState(createProvider);
  const [scenario, setScenario] = useState(source.scenario);
  const monitoring = useMonitoring(source.provider);
  const { snapshot, loading, error, now } = monitoring;
  const summary = summarize(snapshot, now, !!error);
  const pending = !snapshot && loading && !error;
  const message = error ? `取得失敗 · ${snapshot ? '前回値を表示しています' : '観測値を取得できません'}` : pending ? '観測データを取得中' : summary.health === 'critical' ? `異常を検出しました${summary.incomplete ? ' / 一部取得不能' : ''}` : summary.health === 'unknown' ? '取得不能または更新遅延があります' : summary.health === 'warning' ? '注意が必要な項目があります' : 'すべての監視項目は正常です';
  const changeScenario = (next: Scenario) => {
    source.provider.setScenario(next);
    setScenario(next);
    monitoring.restart();
  };
  return <div className="console">
    <a href="#main" className="skip-link">監視データへ移動</a>
    <ConsoleHeader now={now} host={snapshot?.host} />
    <section className="overview" aria-label="監視概要">
      <span className="mock-badge">模擬データ</span>
      <div className="overall-status"><span className="meta-label">総合判定</span><StatusLabel health={summary.health} label={pending ? '取得中' : undefined} /></div>
      <p className="overview-message" role="status" aria-live="polite">{message}</p>
      <div className="refresh-group"><span className="last-fetch">最終取得 <span className="mono">{time(snapshot?.fetchedAt)}</span></span><button type="button" onClick={monitoring.refresh} disabled={loading}><span aria-hidden="true">↻</span> {loading ? '取得中…' : '再取得'}</button></div>
      {error && <p className="error-detail">{error}。5 秒後に再試行します。</p>}
    </section>
    <Dashboard snapshot={snapshot} now={now} failed={!!error} />
    <ConsoleFooter />
    {import.meta.env.DEV && <MockScenarioControl scenario={scenario} onChange={changeScenario} />}
  </div>;
}
