import type { MonitoringProvider } from '../monitoring-provider';
import type { Clock } from '../../lib/clock';
import { systemClock } from '../../lib/clock';
import { createFixture } from './fixtures';
import type { Scenario } from './scenarios';

export class MockProvider implements MonitoringProvider {
  private attempts = 0;
  private readonly bootAt: number;
  constructor(private scenario: Scenario = 'normal', private readonly clock: Clock = systemClock, private readonly seed = 1994) {
    this.bootAt = clock() - 12 * 86400_000 - 8 * 3600_000 - 32 * 60_000;
  }
  setScenario(scenario: Scenario) {
    this.scenario = scenario;
    this.attempts = 0;
  }
  async getSnapshot(signal: AbortSignal) {
    const scenario = this.scenario;
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException('取得を中止しました', 'AbortError')); return; }
      const cancel = () => {
        clearTimeout(timer);
        reject(new DOMException('取得を中止しました', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, scenario === 'timeout' ? 4_000 : 180);
      signal.addEventListener('abort', cancel, { once: true });
    });
    this.attempts += 1;
    if (scenario === 'failure' || (scenario === 'recovery' && this.attempts === 1)) throw new Error('模擬データの取得に失敗しました');
    return createFixture(this.clock(), scenario, this.seed, this.bootAt);
  }
}
