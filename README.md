# TADAMI CONTROL ROOM

自宅サーバー `tadami` 専用の日本語監視 Web アプリケーション。
白背景・黒文字・細い罫線を基調に、1990 年代の研究施設の監視端末を思わせる独自 UI を構築する。

現在は **β0.3 / 01a の本番 Web 配備準備版**。開発用モックを維持し、本番用の React 静的ビルド、読み取り専用 API、分離した Web / API コンテナ構成を追加した。Prometheus / Node Exporter はユーザー報告により tadami で配備・実機検証済み。Web / API の実機配備・接続は未実施。既定の開発画面は「模擬データ」、本番ビルドは API モードに固定する。

| 項目 | 方針 |
| --- | --- |
| 開発環境 | 作業用 PC。初期版はモックデータのみで動作 |
| 本番対象 | `tadami` / Ubuntu 24.04.5 LTS（ユーザー確認済み構成。今回の実機アクセスなし） |
| 基準画面 | 本体モニター 1280×1024、5:4 |
| 初期表示 | CPU・メモリ・ストレージ・稼働時間・サービス状態 |
| 監視基盤 | Prometheus + Node Exporter は実機配備済み（ユーザー報告）。Web / API は配備準備 |
| UI | 独立した Web アプリ。日本語、白黒、細い罫線 |

設計文書は次の順に参照する。

1. [アプリケーション設計](docs/design.md)：構成、画面、データ契約、状態表示。
2. [ディレクトリ構造](docs/directory-structure.md)：実装予定の配置と責務。
3. [実装計画](docs/implementation-plan.md)：段階別作業、完了条件、実データ接続までの確認事項。
4. [β0.2 API 設計・設定](docs/api-design.md)：モード選択、固定クエリー、フィクスチャ。
5. [監視基盤の運用手順](docs/monitoring-infrastructure.md)：イメージ固定、権限、NVMe 保存、安全検査、バックアップ・復旧。
6. [β0.3 / 01a 本番 Web 配備手順](docs/production-web.md)：構成、設定、配備前検査、SSH トンネル、停止・ロールバック、キオスクへの引き継ぎ。
7. [01a 検証記録](docs/verification-beta-0.3-01a.md)：ローカル検証と未検証の区別。

## 開発環境での起動

Node.js 22.12 以上の 22 系、または 24 以上と npm を使用する。検証環境は Node.js 22.23.2 / npm 10.9.8。nvm を使う場合は `nvm use` で `.nvmrc` のバージョンを選べる。

```sh
npm ci
npm run dev
```

ブラウザーで **http://127.0.0.1:5173/** を開く。停止はターミナルで Ctrl+C。開発サーバーはループバックのみで待ち受ける。環境変数・認証情報・監視サーバーへの接続は不要。

画面下部の「模擬シナリオ」で、正常・注意・CPU 高負荷・メモリ逼迫・ストレージ逼迫・サービス停止／異常・部分欠損・異常と欠損・履歴欠損・全取得失敗・更新遅延・タイムアウト・復旧・多数の行を切り替えられる。

- 「全取得失敗」では最終成功値と取得時刻を保持する。初回失敗を確認する場合は `http://127.0.0.1:5173/?scenario=failure` を開く。
- 「更新遅延」では取得時刻は更新されるが、観測値は 60 秒古い状態になる。
- 「タイムアウト」では 3 秒後に取得失敗となる。
- 「復旧」は最初の取得だけ失敗し、次の自動更新で正常に戻る。「正常」への切替でも即座に再取得できる。
- 「多数・長い項目」はストレージ 10 行・サービス 20 行。ページ全体を縦スクロールする。

シナリオ選択と URL パラメーターはモックモードの開発時だけ有効。既定のビルド済み画面は正常シナリオのモック版として動作する。

## Prometheus がない PC で API 接続を確認する

```sh
npm run dev:fixture
```

**http://127.0.0.1:5174/** を開く。PC 内の HTTP 応答フィクスチャを読み取り専用バックエンドと ApiProvider に通す。「API 検証データ（模擬）」を常時表示し、Ctrl+C で一括停止する。8787 / 5174 が未使用であることが必要。実 Prometheus、tadami、Docker への接続はない。

通常は `VITE_DATA_SOURCE=mock`（未指定も mock）。実データ用は `api` を明示し、`.env.server` にサーバー専用の確認済み設定を用意して `npm run dev:api` と `npm run dev` を起動する。**今回は実機へ接続しない**。具体的な設定項目・失敗時動作は [API 設計](docs/api-design.md) を参照。取得失敗時のモックへの自動切替はない。接続先・認証情報を `VITE_*` に入れない。

## 監視基盤の設定を安全確認する

```sh
npm run check:monitoring
```

Docker や通信を使わず、Compose のポート非公開・内部ネットワーク・最小権限・イメージ固定・15 秒収集・7 日 / 1GB 保持を検査する。設定は [infra/monitoring/compose.yaml](infra/monitoring/compose.yaml)、実機確認・バックアップ・停止復旧の手順は [監視基盤の運用手順](docs/monitoring-infrastructure.md)。本作業では既存コンテナを操作しない。

## ビルド済み画面の確認

```sh
npm run build
npm run preview
```

http://127.0.0.1:4173/ を開く。生成先は `dist/`。ローカル確認用であり、本番サーバーへのデプロイは行わない。

## 本番用成果物の準備

```sh
npm run check:web
npm run build:production
npm run test:production
```

`dist-web/` は API モード固定の静的 UI、`dist-server/` はコンパイル済み Node API / 配信処理。`test:production` は localhost の架空 HTTP 応答による試験で、実 Prometheus 接続の確認ではない。Docker の構成は [infra/web/compose.yaml](infra/web/compose.yaml)、詳細は [本番 Web 配備手順](docs/production-web.md)。公開候補は tadami の `127.0.0.1:18080` のみ。内部ネットワークと公開ポートの実動作は配備時に確認する。Xorg・ブラウザーは後続でホスト OS に導入し、同じ URL を表示する。

## 検証コマンド

```sh
npm run typecheck
npm run lint
npm test
npx playwright install chromium
npm run test:e2e
npm run build
npm run test:preview
npm run test:api
npm run check:monitoring
npm run check:web
npm run build:production
npm run test:production
```

Chromium が利用可能になった後は `npm run check` で一括実行できる。`test:preview` はビルド後に実行し、生成された静的ファイルの起動も確認する。ブラウザーテストは必要に応じて開発／プレビューサーバーを自動起動する。Linux で Chromium の共有ライブラリが不足する場合は、**作業用 PC 上で** Playwright の依存ライブラリを準備する必要がある。

テスト結果・失敗時トレース・画面キャプチャは `test-results/`、HTML レポートは `playwright-report/` に生成する。これらは Git 管理対象外。画面キャプチャは 1280×1024、1280×900、390×844、320×740、768×1024、640×512 と異常シナリオを含む。

β0.1 の検証記録は [verification.md](docs/verification.md)、β0.2 は [verification-beta-0.2.md](docs/verification-beta-0.2.md) を参照。

## 実装の構成

- `src/domain/`：データ契約、取得値の検証、負荷・鮮度判定。React 非依存。
- `src/data/`：`MonitoringProvider` とモック実装、タイムアウト処理。
- `src/features/dashboard/`：5 パネルと更新用フック。
- `src/components/`：罫線パネル、状態ラベル、SVG グラフ、ヘッダー／フッター。
- `src/styles/`：配色・フォント・レスポンシブレイアウト。
- `server/`：固定クエリー、上流応答検証、Snapshot 変換、API、静的配信・固定 proxy。
- `fixtures/prometheus/`：架空の HTTP 応答とテストサーバー。
- `infra/monitoring/`：実機配備済み監視基盤の Compose / Prometheus 設定・イメージロック（ユーザー報告）。
- `infra/web/`：Web / API の本番配備構成と実行時設定テンプレート。
- `tests/`：計算・状態遷移・HTTP・設定安全性・ブラウザーの検証。

5 秒間隔で取得し、進行中の要求を重複させない。非表示タブでは停止、復帰時に再取得する。取得失敗では前回値を保持し、観測から 30 秒を超えると更新遅延とする。履歴は最大 61 点で、欠損を線でつながない。UI の閾値は `src/config/monitoring.ts` で管理する。

日本語フォントは OS 内の Noto Sans CJK JP・游ゴシック・ヒラギノ・メイリオなどを優先する。該当フォントがない場合のみ、同梱の Noto Sans JP Variable を同一オリジンから配信する。外部 CDN・外部画像には依存しない。モックモードでは API 通信もない。フォントのライセンスは [SIL Open Font License 1.1](public/NotoSansJP-LICENSE.txt) を参照。

## 後続作業

01a の Docker イメージ build / 起動と tadami の localhost ポート・内部 DNS・実 Prometheus 接続・権限・資源制限を実機で確認する。既存監視基盤はユーザーの実測報告を反映したが、この作業で再検証していない。01b・01c で最小 Xorg・ホスト側キオスクブラウザー・起動権限・TTY・画面消灯防止・自動復旧を扱う。サービス収集方式、RAID の API/UI 拡張、実時間の長時間稼働も後続。

今回は tadami への SSH、本番デプロイ、既存監視コンテナの操作、SSH・WireGuard・Eternal Terminal・UFW の設定変更、Xorg・ブラウザーの導入を行っていない。
