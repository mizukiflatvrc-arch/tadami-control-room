# β0.3 / 01a 検証記録

2026-10-09、himekami のみ。tadami への SSH、本番デプロイ、監視コンテナや既存ネットワークの操作、UFW / WireGuard / SSH / Eternal Terminal の変更、Xorg / ブラウザーのインストール、kiosk service の作成は行っていない。

## ローカル検証済み

最終の `npm run check` は終了コード 0。Node.js 22.23.2 / npm 10.9.8、既存の Playwright Chromium を使用。

| 検証 | 結果 |
| --- | --- |
| 監視基盤の既存静的検査 | PASS |
| Web Compose YAML / 厳密 schema / Dockerfile 検査 | PASS |
| TypeScript / ESLint | PASS、警告なし |
| Vitest | 11 ファイル、354 件 PASS |
| 通常ビルド | PASS、従来のモック成果物 dist/ |
| 既存 UI E2E | 13 件 PASS。画面寸法・異常・仮想時計 1 時間・アクセシビリティ等 |
| モック本番 preview | 1 件 PASS |
| 既存 API ブラウザー試験 | 5 件 PASS |
| 本番用ビルド | PASS、dist-web/ + dist-server/ |
| 本番成果物ブラウザー結合 | 3 件 PASS |
| 公開成果物の既知設定・検査用秘密値・source map 検査 | PASS |
| 単体 Compose 2.40.3 config / 展開結果検査 | PASS、daemon 未使用 |
| git diff --check / 監視基盤設定の無変更 | PASS |

ローカル HTTP とブラウザーの待受・子プロセスは sandbox の EPERM で拒否されたため、許可された実行環境で再実行した。Chromium の共有ライブラリ不足は、以前の検証で `/tmp/tadami-browser-libs/root/usr/lib/x86_64-linux-gnu` に展開済みの libnspr4 / libnss3 を `LD_LIBRARY_PATH` で**検証プロセスだけ**に指定して解消した。OS のパッケージ設定は変更せず、この一時パスをアプリ・テスト設定に含めていない。

```sh
LD_LIBRARY_PATH=/tmp/tadami-browser-libs/root/usr/lib/x86_64-linux-gnu npm run check
```

最初の全検証で、共有フィクスチャ API を使う並列画面試験 1 件が CPU 欠損表示で失敗した。trace に 503 BUSY があり、2 件の API 同時要求上限と React StrictMode の初回要求が並列画面試験で競合する可能性が確認された。単独再実行では 5 件 PASS。API の上限は維持し、`playwright.api.config.ts` の共有フィクスチャ画面試験を 1 worker / 直列実行へ変更した。変更後の全検証は PASS。Web proxy の同時要求上限・期限は専用 HTTP 試験で検証する。

本番形式の結合試験では、コンパイル済み API / Web を `/tmp` に複製し、API は Zod だけ、Web は node_modules なしで起動した。API / Web の実行に Vite / tsx / React 開発依存が不要なことを確認した。起動前には必須設定を渡さないコンパイル済み API が終了コード 1 で待受せず終了することも確認した。

上流は PC 内の**架空の Prometheus HTTP 応答**。本番 API 自体の header / 契約を検証するため通常 entry を使用しているが、実 Prometheus に接続した試験ではない。画面には「API 検証ホスト」「OS 未確認（フィクスチャ）」が表示される。数値は架空（CPU 20%、メモリ16GiB等）で、tadami の実測値として扱わない。

本番形式のブラウザー試験で確認したこと：同一オリジンだけの通信、API 契約、クエリー / 書き込み / 管理経路 / env ファイル拒否、初回障害の欠損、前回値保持、5 秒の自動更新による復旧、document 再読み込みが発生しないこと、新しい browser context からの復旧、サービス未設定表示、1280×1024 の全パネル収容、横方向のはみ出しなし、axe 違反なし。1280×1024 のキャプチャは目視でも確認した。

画面キャプチャは Git 管理外の `test-results/production/`、レポートは `playwright-report/production/`。画像は本番用アプリの架空 HTTP 応答による検証画面である。

秘密値の試験では、実際の秘密情報を使わず `VITE_DATA_SOURCE=mock`、`VITE_PROMETHEUS_URL=http://prometheus:9090/`、`VITE_PROMETHEUS_TOKEN=PRIVATE-BUILD-SENTINEL`、`TCR_PROMETHEUS_TOKEN=do-not-publish-secret` を環境に置いて本番ビルドを実行した。UI 成果物への指定値混入がないことを検査し、通常の本番ビルドのブラウザー試験でも API モード固定を確認した。任意の秘密情報を完全検出する scanner ではなく、build context の許可リストと公開変数無効化を主な保護とする。

Compose 検証は以前から `/tmp/tadami-monitoring-validation/docker-compose` に存在した公式単体バイナリ 2.40.3 を使用。元 Compose の `api.env` が himekami にないため、**一時コピーで env_file の path だけを api.env.example へ変更**し、project-directory を実際の `infra/web` に設定して `config --quiet` を実行した。展開 JSON でも web の唯一の HostIp=127.0.0.1 / HostPort=18080、API のポート非公開、frontend Internal=true、既存 monitoring を external として参照、UID/GID・read-only・cap_drop・no-new-privileges・ホストマウントなしを検査した。実機 Compose 5.6.0 と実際の api.env では再検証が必要。

## 実機確認済み（ユーザー報告）

Prometheus 3.13.4 / Node Exporter 1.12.1 の稼働、up=1、CPU 4 コア、約31.05GiB のメモリ、root FS `/dev/nvme0n1p2` / `/` / ext4 と容量一致、未マウント RAID1 の active 2/2 / failed=0 / degraded=0、7 collector 成功、filesystem error=0、マウント RW=0・詳細監査 PASS、内部ネットワーク、9090/9100 非公開と WireGuard 経由の直接接続不可。この作業では再検証していない。

## 未検証・配備前に必要な確認

Docker CLI / daemon / socket が himekami に存在しないため Docker build / pull / run を実行していない。Dockerfile の実ビルド、イメージの UID / rootfs / 資源・PID・ログ制限、healthcheck、内部 DNS、API→実 Prometheus、Web→API、internal network と localhost18080の転送、外部通信不可、ホスト bridge gateway の到達範囲は未検証。ローカル試験は Docker runtime の代用にしない。

イメージの digest は未固定で、脆弱性 scan は未実行。loopback の同一ホスト利用者、Docker 管理者、同じ bridge 内の参加者は信頼境界に含まれる。TLS / アプリ認証は loopback + SSH を前提として未導入。実データの鮮度・負荷下での期限・OOM・長時間運転、本体モニター・Xorg・実際のブラウザー再起動・自動起動、RAID API / UI とサービス計測方式は未検証 / 未実装。

配備前に Compose 5.6.0 の config、基底イメージと依存のセキュリティ、固定 release・前版の保存、既存ネットワークの Internal / DNS alias、localhost ポートと実 Snapshot、inspect による権限・公開範囲を確認する。internal と published ports が成立しない場合は非特権ホスト relay 案を別途レビューする。詳細な起動・停止・ロールバック・SSH トンネル・代替経路と 01b/01c の引き継ぎは [本番 Web 配備手順](production-web.md)。

## 変更ファイル

| 区分 | ファイル |
| --- | --- |
| 本番コンテナ・設定 | `.dockerignore`、`infra/web/Dockerfile`、`infra/web/compose.yaml`、`infra/web/.env.example`、`infra/web/api.env.example` |
| 本番配信・待受 | `server/web.ts`、`server/web-index.ts`、`server/config.ts`、`server/index.ts`、`.env.server.example` |
| ビルド・検証コマンド | `vite.config.ts`、`vite.server.config.ts`、`package.json`、`.gitignore`、`eslint.config.js` |
| 静的・成果物・結合検査 | `tools/production/check-config.ts`、`tools/production/check-build.ts`、`tools/production/test-stack.ts` |
| テスト | `tests/server/web.test.ts`、`tests/server/web-infrastructure.test.ts`、`tests/server/mapper.test.ts`、`tests/e2e/production.spec.ts`、`playwright.production.config.ts`、`playwright.api.config.ts`、`fixtures/prometheus/config.ts` |
| 文書 | `README.md`、`docs/api-design.md`、`docs/design.md`、`docs/directory-structure.md`、`docs/implementation-plan.md`、`docs/monitoring-infrastructure.md`、`docs/production-web.md`、この検証記録 |

`server/app.ts` と `server/prometheus/` の API ロジック、`src/` の UI・型、既存 `infra/monitoring/compose.yaml` / prometheus.yml / images.lock.json、依存と lockfile は変更していない。
