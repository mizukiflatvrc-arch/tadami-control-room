import { useState } from 'react';
import { createProvider } from './create-provider';
import type { ProviderSelection } from './create-provider';
import { DATA_LABELS } from '../config/data-source';
import { MOCK_HOST } from '../config/mock-targets';
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
  if (source.mode === 'invalid') return <main className="console"><h1>TADAMI CONTROL ROOM</h1><p role="alert">{source.error}</p><p>設定を修正してから開発サーバーを再起動、または再ビルドしてください。</p></main>;
  return <MonitoringApp source={source} />;
}

function MonitoringApp({ source }: { source: Exclude<ProviderSelection, { mode: 'invalid' }> }) {
  const [scenario, setScenario] = useState(source.scenario);
  const monitoring = useMonitoring(source.provider);
  const { snapshot, loading, error, now } = monitoring;
  const summary = summarize(snapshot, now, !!error);
  const pending = !snapshot && loading && !error;
  const message = error ? `取得失敗 · ${snapshot ? '前回値を表示しています' : '観測値を取得できません'}` : pending ? '観測データを取得中' : summary.health === 'critical' ? `異常を検出しました${summary.incomplete ? ' / 一部取得不能' : ''}` : summary.health === 'unknown' ? '取得不能または更新遅延があります' : summary.health === 'warning' ? '注意が必要な項目があります' : 'すべての監視項目は正常です';
  const changeScenario = (next: Scenario) => {
    if (source.mode !== 'mock') return;
    source.provider.setScenario(next);
    setScenario(next);
    monitoring.restart();
  };
  return <div className="console">
    <a href="#main" className="skip-link">監視データへ移動</a>
    <ConsoleHeader now={now} host={snapshot?.host ?? (source.mode === 'mock' ? MOCK_HOST : undefined)} />
    <section className="overview" aria-label="監視概要">
      <span className={`mock-badge source-${source.mode}`}>{DATA_LABELS[source.mode].label}</span>
      <div className="overall-status"><span className="meta-label">総合判定</span><StatusLabel health={summary.health} label={pending ? '取得中' : undefined} /></div>
      <p className="overview-message" role="status" aria-live="polite">{message}</p>
      <div className="refresh-group"><span className="last-fetch">最終取得 <span className="mono">{time(snapshot?.fetchedAt)}</span></span><button type="button" onClick={monitoring.refresh} disabled={loading}><span aria-hidden="true">↻</span> {loading ? '取得中…' : '再取得'}</button></div>
      {error && <p className="error-detail">{error}。5 秒後に再試行します。</p>}
    </section>
    <Dashboard snapshot={snapshot} now={now} failed={!!error} />
    <ConsoleFooter mode={source.mode} />
    {import.meta.env.DEV && source.mode === 'mock' && <MockScenarioControl scenario={scenario} onChange={changeScenario} />}
  </div>;
}
