# β0.2 読み取り専用 API と Provider

作業用 PC 上の実装。実 Prometheus / tadami に接続していない。監視基盤の配備案は [monitoring-infrastructure.md](monitoring-infrastructure.md) を参照。

## データ取得モード

| `VITE_DATA_SOURCE` | Provider / 常時表示 | 通信 |
| --- | --- | --- |
| 未指定 / `mock` | MockProvider / 模擬データ | なし。β0.1 のシナリオを維持 |
| `api` | ApiProvider / 実データ | 同一オリジンの固定 API のみ |
| `api-fixture` | ApiProvider / API 検証データ（模擬） | 開発時のみ。ローカルの HTTP 応答フィクスチャ |

不正な設定値は設定エラーとし、API 障害時を含めモックへ自動切替しない。URL の `source` / `scenario` は API モードを変更できない。ラベルは初回取得前・取得失敗後も選択したモードを明示する。「実データ」は取得経路の表示であり、取得成功や正常状態を意味しない。

フィクスチャは API と同じ変換経路を通るため Snapshot の `source` は `prometheus`。その代わり HTTP ヘッダー `X-Tadami-Data-Origin: fixture` と専用モードで必ず模擬表示し、通常 API は `prometheus` を返す。ApiProvider はモードとヘッダーの不一致、`source: mock`、契約違反を拒否する。これは設定取り違え対策で、サーバーの暗号学的な真正性を保証するものではない。

## 起動・設定

フィクスチャによる確認は `npm run dev:fixture` → `http://127.0.0.1:5174/`。架空の Prometheus HTTP 応答サーバー（動的 loopback ポート）、バックエンド（8787）、Vite（5174）を PC 内だけで起動する。`.env.server` を読み込まず、MockProvider も呼ばない。Ctrl+C で一括停止する。

実データ経路の設定手順は接続先の使用が許可された後に使う。今回は実機には接続しない。

1. `.env.server.example` を `.env.server` へコピーし、確認済みのサーバー設定を記入する。初期の必須項目は空で、未記入なら起動を拒否する。
2. `.env.local` に `VITE_DATA_SOURCE=api` だけを設定する。公開変数 `VITE_*` に接続先や認証を入れない。
3. `npm run dev:api` と `npm run dev` を別ターミナルで起動する。API は `127.0.0.1:8787`、UI は `127.0.0.1:5173`。Vite の `/api/` proxy は loopback の 8787 固定。本番 URL を Vite に渡さない。

`TCR_API_PORT` を変える場合はローカル proxy も合わせる必要がある。`.env.server` は Node.js の `--env-file` だけで読み込む。既に設定されたプロセス環境変数がある場合は Node.js の優先順にも注意する。`.env.server` を静的ホスティングへコピーしない。

| サーバー専用設定 | 契約 / 確認事項 |
| --- | --- |
| `TCR_PROMETHEUS_URL` | HTTP(S) の固定 URL。userinfo / query / fragment は禁止。TLS 検証を無効化しない |
| `TCR_METRIC_PROFILE` | 明示的に `node-exporter-v1`。実際の系列・ラベルとの一致は導入後に確認 |
| `TCR_HOST_ID` / `TCR_HOST_NAME` / `TCR_OS_LABEL` | 表示用の対象識別子。OS 未設定時は「OS 未確認」 |
| `TCR_PROMETHEUS_JOB` / `TCR_PROMETHEUS_INSTANCE` | 完全一致の対象ラベル。今回の Compose 案なら `tadami-node` / `tadami` |
| `TCR_CPU_RATE_WINDOW_SECONDS` | 整数 30〜3600。15 秒 scrape の構成案では 60 秒を初期候補にする |
| `TCR_FILESYSTEMS_JSON` | 1〜32 件の `{id,device,mountpoint,fstype}`。実出力を確認して指定。未マウント md0 を架空の FS として追加しない |
| `TCR_SERVICES_JSON` | 最大 64 件の `{id,name,expectedState}`。省略時は空。一覧・計測方式が未確定なら不明 |
| `TCR_PROMETHEUS_AUTH` | `none` / `bearer` / `basic`。token / username / password は `TCR_PROMETHEUS_*` のサーバー環境のみ |

## API の境界

`GET /api/monitoring/snapshot` だけを公開する。クエリーパラメーター・要求本文・他メソッドを許可せず、任意の PromQL / URL / 対象ホスト / 時間範囲は受け付けない。CORS は設定しない。成功時は既存 `MonitoringSnapshot` schemaVersion=1 を返す。`Cache-Control: no-store` を付ける。

固定エラーは 400（パラメーター等）、404（経路）、405（GET 以外）、502（上流障害・不正応答）、503（同時要求上限）、504（上流タイムアウト）。上流の応答本文・URL・認証情報をエラーに含めない。同時 Snapshot は 2 件、上流 query は各最大 4 並列。上流取得の合計期限は 2400ms、各 Prometheus query の timeout は 2s、応答は各 2MiB / 512 系列 / matrix 各 61 点まで。リダイレクトを拒否し、切断時には上流を中止する。

上流の全現在値クエリーが取得失敗なら HTTP エラー。正常な HTTP 応答でも系列が空なら取得成功とデータ欠損を区別し、`null` / unavailable とする。部分失敗では有効な項目を残す。UI は全取得失敗時に最終成功値を保持し、30 秒を超える元データを更新遅延にする。

今回のサーバーは **ローカル開発用の loopback 待受のみ**。ブラウザー側の本番アクセス制御、リバースプロキシ、TLS、本番コンテナ化は未実装で、LAN にそのまま公開する構成ではない。

## 固定クエリーと変換

公式 [Prometheus HTTP API](https://prometheus.io/docs/prometheus/latest/querying/api/) の `/api/v1/query` と `/api/v1/query_range` を使用する。

`server/prometheus/queries.ts` が 8 種類の値・観測時刻の instant query（16 本）と CPU / メモリ 2 種の値・観測時刻の range query（6 本）、合計 22 本を生成する。metric 名は固定。job / instance と FS の device / mountpoint / fstype はサーバー設定の文字列をエスケープして完全一致させる。

| 表示 | 値のクエリー / 変換 |
| --- | --- |
| CPU | 各 cpu の `rate(node_cpu_seconds_total{mode="idle",…}[Ns])` を取得し、`100 × (1 − 全系列の平均)` |
| メモリ | `node_memory_MemTotal_bytes` と `node_memory_MemAvailable_bytes`。使用量 = total − available |
| FS | `node_filesystem_size_bytes` / `free_bytes` / `avail_bytes`。使用量 = size − free、利用可能量 = avail |
| 稼働時間 | `node_time_seconds − node_boot_time_seconds`。ブラウザー時計で増加させない |
| サービス | 計測方式未確定。設定された行は `unknown` / unavailable / 観測時刻なし。`up` をサービス稼働状態に転用しない |

現在値の観測時刻は query の評価時刻ではなく、対応する元系列への `timestamp(...)` の値を採用する。複数要素の計算結果には最も古い元観測時刻を付ける。CPU の rate は Prometheus が計算し、履歴は過去 15 分・15 秒間隔・最大 61 点。履歴の鮮度はその評価時点に対して判定し、欠損を補間しない。[Prometheus functions](https://prometheus.io/docs/prometheus/latest/querying/functions/)

NaN / Inf / 負の容量 / 不整合な容量 / 重複系列 / 対象ラベル不一致 / 未来の観測時刻等は不明にする。想定外のホストから都合のよい 1 系列を選ばない。ただし CPU コア数の期待値は現在の契約にないため、全コア欠落の検知とは別に導入時に 4 系列であることを確認する。

## フィクスチャとテストの範囲

`fixtures/prometheus/responses.json` は vector / matrix の HTTP API 応答を保存し、テスト実行時刻へリベースする。CPU 2 系列 / メモリ 16 GiB など **架空の構成**で、ユーザーから提示された tadami の実測値とは異なる。正常、部分欠損、古い観測値、非有限数、重複、履歴欠損、取得失敗をローカルで再現する。

単体検査では固定クエリー・マッピング・契約・タイムアウト・認証情報の秘匿を確認し、HTTP 結合検査ではフィクスチャサーバー→PrometheusClient→Snapshot の経路を通す。ブラウザー検査では専用の模擬表示、実データモードの取得失敗／前回値保持／復旧、フィクスチャの誤接続拒否を確認する。

フィクスチャは PromQL エンジンではない。実 Prometheus 上の PromQL 実行結果、実機の device / fstype / mountpoint、CPU 全 4 系列、30 秒鮮度閾値と負荷時の取得期限、RAID 状態、既存サービスの計測方式は導入検証で確定する。型・画面の互換性を維持した段階であり、実機接続試験が完了したとは扱わない。
