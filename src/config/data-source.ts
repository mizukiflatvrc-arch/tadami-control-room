export type DataMode = 'mock' | 'api' | 'api-fixture';

export function parseDataMode(value: string | undefined, development: boolean): DataMode {
  if (value === undefined || value === 'mock') return 'mock';
  if (value === 'api') return 'api';
  if (value === 'api-fixture' && development) return 'api-fixture';
  throw new Error('データ取得設定が不正です。VITE_DATA_SOURCE に mock または api を指定してください。');
}

export const DATA_LABELS: Record<DataMode, { label: string; detail: string }> = {
  mock: { label: '模擬データ', detail: '機器構成・観測値は架空です' },
  api: { label: '実データ', detail: 'Prometheus 経由 · 接続先はサーバー側設定' },
  'api-fixture': { label: 'API 検証データ（模擬）', detail: '応答フィクスチャによる接続試験です' },
};
