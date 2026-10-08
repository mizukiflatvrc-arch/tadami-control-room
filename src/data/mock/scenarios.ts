export const SCENARIOS = [
  { id: 'normal', label: '正常', description: 'すべての観測値が正常範囲にあります。' },
  { id: 'warning', label: '注意', description: 'CPU 使用率が注意の閾値を超えています。' },
  { id: 'cpu-critical', label: 'CPU 高負荷', description: 'CPU 使用率が異常の閾値を超えています。' },
  { id: 'memory-critical', label: 'メモリ逼迫', description: 'メモリの利用可能量が少なくなっています。' },
  { id: 'storage-critical', label: 'ストレージ逼迫', description: 'データ領域の使用率が異常の閾値を超えています。' },
  { id: 'service-stopped', label: 'サービス停止', description: '稼働が期待されるサービスが停止しています。' },
  { id: 'service-failed', label: 'サービス異常', description: 'Web サーバーが異常状態です。' },
  { id: 'partial', label: '部分欠損', description: 'メモリ・一部ストレージ・サービスの観測値が欠損しています。' },
  { id: 'mixed', label: '異常と欠損', description: 'CPU の異常と、メモリの欠損が同時に発生しています。' },
  { id: 'history-gap', label: '履歴欠損', description: '履歴の欠損区間は線をつながずに表示します。' },
  { id: 'failure', label: '全取得失敗', description: '取得に失敗します。最後に取得できた値を保持します。' },
  { id: 'stale', label: '更新遅延', description: '取得は成功しますが、観測値は 60 秒前のままです。' },
  { id: 'timeout', label: 'タイムアウト', description: '応答を 4 秒遅延させ、3 秒の取得制限を確認します。' },
  { id: 'recovery', label: '復旧', description: '初回は取得失敗し、次回の自動更新で正常に復旧します。' },
  { id: 'many-rows', label: '多数・長い項目', description: 'ストレージ 10 行・サービス 20 行と長い名前の表示を確認します。' },
] as const;
export type Scenario = typeof SCENARIOS[number]['id'];
export function isScenario(value: string | null): value is Scenario {
  return SCENARIOS.some((scenario) => scenario.id === value);
}
