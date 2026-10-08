import { MockProvider } from '../data/mock/mock-provider';
import { isScenario } from '../data/mock/scenarios';

export function createProvider() {
  const candidate = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('scenario') : null;
  const scenario = isScenario(candidate) ? candidate : 'normal';
  return { provider: new MockProvider(scenario), scenario };
}
