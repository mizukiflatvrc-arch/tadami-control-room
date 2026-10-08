import type { MonitoringProvider } from '../monitoring-provider';
import { validateSnapshot } from '../../domain/validation';

const ENDPOINT = '/api/monitoring/snapshot';

export class ApiProvider implements MonitoringProvider {
  constructor(private readonly origin: 'prometheus' | 'fixture' = 'prometheus', private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  async getSnapshot(signal: AbortSignal) {
    const response = await this.fetcher(ENDPOINT, {
      method: 'GET', signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      if (response.status === 504) throw new Error('監視 API の上流通信がタイムアウトしました');
      throw new Error(`監視 API から取得できません（HTTP ${response.status}）`);
    }
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('監視 API の応答形式が不正です');
    if (response.headers.get('x-tadami-data-origin') !== this.origin) throw new Error('監視 API のデータ種別が設定と一致しません');
    const snapshot = validateSnapshot(await response.json(), Date.now());
    if (snapshot.source !== 'prometheus') throw new Error('実データ用 API が模擬データを返しました');
    return snapshot;
  }
}
