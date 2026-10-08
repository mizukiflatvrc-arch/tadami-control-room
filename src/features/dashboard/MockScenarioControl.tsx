import { SCENARIOS, type Scenario } from '../../data/mock/scenarios';

export function MockScenarioControl({ scenario, onChange }: { scenario: Scenario; onChange: (scenario: Scenario) => void }) {
  return <aside className="scenario-control" aria-label="開発用シナリオ">
    <label htmlFor="scenario">模擬シナリオ</label>
    <select id="scenario" value={scenario} onChange={(event) => onChange(event.target.value as Scenario)}>
      {SCENARIOS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
    </select>
    <p>{SCENARIOS.find((item) => item.id === scenario)?.description}</p>
    <span className="dev-label">開発用</span>
  </aside>;
}
