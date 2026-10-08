import { MockProvider } from '../data/mock/mock-provider';
import { isScenario } from '../data/mock/scenarios';
import type { Scenario } from '../data/mock/scenarios';
import { ApiProvider } from '../data/api/api-provider';
import { parseDataMode } from '../config/data-source';

export type ProviderSelection =
  | { mode: 'mock'; provider: MockProvider; scenario: Scenario }
  | { mode: 'api' | 'api-fixture'; provider: ApiProvider; scenario: 'normal' }
  | { mode: 'invalid'; error: string };

export function createProvider(): ProviderSelection {
  try {
    const mode = parseDataMode(import.meta.env.VITE_DATA_SOURCE, import.meta.env.DEV);
    if (mode !== 'mock') return { mode, provider: new ApiProvider(mode === 'api-fixture' ? 'fixture' : 'prometheus'), scenario: 'normal' };
    const candidate = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('scenario') : null;
    const scenario = isScenario(candidate) ? candidate : 'normal';
    return { mode, provider: new MockProvider(scenario), scenario };
  } catch (error) {
    return { mode: 'invalid', error: error instanceof Error ? error.message : 'データ取得設定を確認してください' };
  }
}
