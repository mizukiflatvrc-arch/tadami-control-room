# β0.3 / 01a 本番 Web 配備基盤

01b 更新：localhost 接続は [恒常リレーの配備・運用手順](localhost-relay.md) に従う。Web の Docker ports は削除済み。手動 socat 経由の Web/API 実データ表示はユーザー確認済みで、systemd 版の実機切替は未実施。以下の01a時点の実機未検証記述は当時の記録。

2026-10-09。01a の成果物は himekami 上の実装とローカル検証。以下の tadami 用コマンドは**手順書であり今回実行していない**。既存の監視基盤・ネットワーク、SSH、WireGuard、Eternal Terminal、UFW を変更しない。Xorg、ブラウザー、systemd kiosk の導入は後続。

## 構成と選定理由

```text
将来: tadami 上の Xorg + 非特権 kiosk ブラウザー
現在の確認方法: himekami ブラウザー → SSH ローカル転送
                          ↓
             tadami 127.0.0.1:18080
             ホストの非特権 socat（01b）
                          ↓
新規 tadami-web プロジェクト
  web:8080 [React 静的成果物 + 固定 API proxy]
       │ 新規 tadami-web_frontend (internal: true)
  monitoring-api:8787 [既存の読み取り専用 API]
       │ 既存 tadami-monitoring_monitoring (external として参照)
既存 tadami-monitoring プロジェクト (internal: true)
  prometheus:9090 → node-exporter:9100
```

Web と API を分け、Web は Prometheus / Node Exporter のネットワークへ参加しない。API だけが既存ネットワークに参加する。`external: true` は既存ネットワークを管理対象外として参照する指定であり、外部通信を許す意味ではない。実際の `Internal=true` は配備前に inspect で確認する。[Docker Compose のネットワーク仕様](https://docs.docker.com/reference/compose-file/networks/)

配信には既存の Node.js と標準 HTTP / fs / fetch を用いる。外部の配信パッケージを追加せず、ビルド済みファイルと `GET /api/monitoring/snapshot` 一経路だけを扱う。Vite はビルド時だけ使用する（server build の `ssr` オプションは Node 向けのバンドル生成に使用し、React のサーバー描画は行わない）。Nginx なら配信機能や一般的な運用ノウハウを利用できるが、今回は別のイメージ更新・設定・非 root 書き込み領域の管理が増える。Node 配信の保守責任として、HTTP 境界・上限・切断・期限をテストし、定期的に Node と依存を更新する。Web の標準配信は圧縮・CDN・汎用 SPA routing を追加せず、localhost 専用の一画面に限定する。

API の PromQL、変換、型、鮮度、2 同時要求、4 並列上流取得、2400ms の上流期限を維持する。Web proxy も 2 同時要求・4000ms・2MiB 応答上限を設ける。要求から URL・クエリー・認証情報を作らず、ブラウザーの Cookie / Authorization / 転送ヘッダーを渡さない。API の status とデータ種別ヘッダーを維持し、誤ってフィクスチャ API を指定した場合は UI が拒否できる。静的ファイルは起動時の一覧に限定し、隠しファイル・source map・symlink は配信しない。存在しない `/api/*` を HTML へフォールバックしない。

## 成果物と設定

| ファイル | 内容 |
| --- | --- |
| `infra/web/Dockerfile` | npm ci、静的 UI / JS API の build、本番依存、Web / API の 2 target |
| `infra/web/compose.yaml` | 独立した Web プロジェクト。Docker のホスト公開ポートなし（01b） |
| `infra/web/.env.example` | Compose 補間用の固定リリース識別子 |
| `infra/web/api.env.example` | API の実行時だけ渡す tadami 用設定候補 |
| `.dockerignore` | build context の許可リスト。env、Git、AWS、ローカル成果物を除外 |
| `vite.config.ts` / `vite.server.config.ts` | API 固定 UI とコンパイル済み Node entry の生成 |
| `server/web.ts` / `server/web-index.ts` | 本番静的配信・一経路 proxy・終了処理 |
| `tools/production/` | 設定・成果物検査、localhost 限定の結合試験起動 |
| `tests/server/web*.test.ts` / `tests/e2e/production.spec.ts` | HTTP 境界、ネットワーク設定、ビルド済み画面の検証 |

本番ビルドは `npm run build:production`。`dist-web/` と `dist-server/` を生成する。`production-api` モードでは `.env` を読まず、Vite 公開変数を無効にし、取得方式を `api` に固定する。従来の `npm run dev` / `npm run build` の既定モック動作は維持する。Prometheus URL / token / password は `VITE_*` に格納しない。

両コンテナは UID/GID 1000:1000、rootfs read-only、cap_drop ALL、no-new-privileges。Web は 128MiB / 0.5 CPU、API は 256MiB / 1 CPU、各 PID 64、json-file 10MiB × 3。コンテナへホストマウント、Docker socket、X11 socket、ディスプレイデバイスを渡さず、tmpfs も不要。Healthcheck は Web のローカル静的配信と API のローカル TCP 待受だけを確認し、Prometheus を追加 scrape しない。**healthy は実データ接続成功を意味しない**。unhealthy だけでは Docker は自動再起動しない。プロセス終了時の restart と UI の自動再取得を利用する。

Node 基底イメージは `22.23.2-bookworm-slim` を固定。タグはレジストリで再発行でき、digest は未固定。配備前にタグの取得可能性・linux/amd64・脆弱性を確認し、取得した image ID / RepoDigest を記録する。必要な更新は Dockerfile と静的検査を同時にレビューする。[公式 Node イメージのタグ一覧](https://hub.docker.com/_/node/tags?name=22)

`api.env.example` の根拠はユーザー提示の実測値。root FS は `/dev/nvme0n1p2` / `/` / ext4、CPU window は 15 秒 scrape に対する 60 秒。`services=[]` は未設定として表示する。未マウント `/dev/md0` を FS 一覧に追加しない。RAID は現 API 契約に含まれず、mdadm の実測は後続 API / UI 拡張の根拠として保管する。公称容量・CPU コア数を観測値として埋め込まない。

`TCR_API_HOST` は未指定なら開発用 `127.0.0.1`。Compose だけが `0.0.0.0:8787` を指定し、API のホストポートは非公開。Web の固定上流は `http://monitoring-api:8787`。`TCR_WEB_API_ORIGIN` はローカル結合試験用のサーバー側上書きで、Compose では指定しない。要求やフロントエンドから変更できない。

## 配備前チェック

実施前に新規 Web コンテナの起動が許可されたこと、監視基盤が継続稼働していることを確認する。手順を monitoring Compose と混ぜず、既存サービスを再作成しない。

1. レビュー済みコミット、Node イメージ、lockfile、前版の image ID / 設定 / Compose を確保する。初回配備ならロールバック先は Web プロジェクトの停止。
2. リポジトリの作業差分、18080 の既存使用、Docker Engine / Compose、daemon の direct routing / userland-proxy / firewall backend、rootless / userns / AppArmor を確認する。今回はこれらの設定を変更しない。
3. `docker network inspect tadami-monitoring_monitoring` で Internal=true、既存参加者、Prometheus の `prometheus` DNS alias を確認する。ネットワークが存在しない場合は停止し、新規に同名で作成しない。
4. `infra/web/api.env` を権限 600 で準備する。実測ラベル、root FS、scrape 間隔、AUTH=none を照合する。不足・不正設定なら API は待受前に終了する。token 等を将来使う場合は、Docker 管理権限による inspect から見える env を信頼境界として扱い、別途 secret-file 設計を検討する。
5. himekami で `npm run check`、Docker のある環境で下記 Compose CLI 検証とイメージ build を行う。Docker の動作確認はこの実装のローカルテストで代用できない。

以下はリポジトリ root を cwd とする。`TCR_RELEASE` には配備対象コミット SHA を設定し、既存タグを再利用しない。`.env.example` を使う場合は値を記入した `infra/web/.env` を `--env-file` で指定する。

```sh
export TCR_RELEASE=<reviewed-commit-sha>
install -m 600 infra/web/api.env.example infra/web/api.env
docker compose -f infra/web/compose.yaml config --quiet
docker compose -f infra/web/compose.yaml build --pull
```

`config` の非 quiet 出力は env の値を含むため、認証導入後はそのまま共有しない。build に network が必要なのはレジストリと npm 取得時だけ。runtime は内部ネットワークに限定する。初回の設定コピー後は環境に合わせて確認・編集する。**更新時は既存 api.env を上書きしない**。

## 起動と実機の受け入れ検査（未実施）

01b の Compose では先に [リレー切替手順](localhost-relay.md) を確認する。既存配備の切替時はその手順の `--no-deps web` による再作成を使い、以下のプロジェクト全体の up は初回構築用とする。curl はホストリレー起動後に行う。

```sh
docker compose -f infra/web/compose.yaml up -d --no-build
docker compose -f infra/web/compose.yaml ps
docker compose -f infra/web/compose.yaml logs --tail=100 web monitoring-api
curl --fail --max-time 10 http://127.0.0.1:18080/
curl --fail --max-time 10 http://127.0.0.1:18080/api/monitoring/snapshot
```

受け入れ条件は、静的 UI 200 と Snapshot 200 の両方、`X-Tadami-Data-Origin: prometheus`、サービス一覧空、CPU 4 系列の元データ、約31.05GiB のメモリ、host と一致する root FS 容量・available、元観測時刻の鮮度。Snapshot の構造だけでは全 4 コアの収集を証明できない。既存 Prometheus の `up=1` と collector 成功を引き続き維持する。

`docker compose ... ps -q` の ID を使って `docker inspect` を保存し、次を確認する。env を含む inspect 全体の共有は避ける。

- web は frontend のみ、API は frontend と既存 monitoring のみ。frontend は Internal=true。既存 monitoring の属性と既存 2 コンテナは変更されていない。
- PortBindings は Web / API とも空。8080 / 8787 / 9090 / 9100 の HostPort がない。127.0.0.1:18080 はホストリレーだけが待受する。Dockerfile の EXPOSE はホスト公開ではない。
- Config.User=1000:1000、ReadonlyRootfs=true、CapDrop=ALL、no-new-privileges、資源・PID・ログ制限、Mounts が空、privileged=false、host network / PID 不使用。
- `ss -4 -lntp` の 127.0.0.1:18080、IPv6 待受なし、localhost curl の両方を確認する。
- API コンテナから `fetch('http://prometheus:9090/-/ready')`、名前解決、Snapshot を確認する。Web からは Prometheus の名前解決・接続が成立しないこと、各コンテナから不要な外部通信が成立しないことを確認する。内部 bridge の host gateway とホストの既存サービスへの到達可能性も調べる。
- himekami から tadami の WireGuard/LAN アドレスの 18080 / 8787 / 9090 / 9100 に直接接続できないことを確認する。localhost bind はインターネット向け公開の防止を目的とするが、daemon の direct routing 等も合わせて検査する。[Docker のポート公開仕様](https://docs.docker.com/engine/network/port-publishing/)

Web / API 障害は新規サービスだけで試験する。API を停止しても UI が表示され、取得エラー・前回値・遅延が表示されること、API の再起動・再作成後に名前解決を経て自動復旧することを確認する。既存 Prometheus / Node Exporter を止める試験は今回の手順に含めない。資源制限下での取得期限、OOM、有効 CPU / メモリ負荷、実時間の連続運転は未検証。

### internal network と公開ポート（01b で解決する対象）

ユーザーの実機確認では `HostConfig.PortBindings` に `127.0.0.1:18080:8080` が存在しても、`NetworkSettings.Ports` は `8080/tcp:null` でホストポートが割り当てられなかった。一方、ホスト→Web 内部 IPv4:8080 と手動 socat 経由では Web/API とも200、SSHトンネル経由の実データ表示が確認済み。

01b では Web Compose の ports を削除し、専用の非特権ホストリレーを採用する。root 補助処理が Compose ラベル・network・IPを検証し、IP変更に追従する。[選定理由・systemd unit・段階的切替・ロールバック](localhost-relay.md) を参照。frontend / monitoring は internal のまま維持し、監視 Compose、Docker daemon、UFW、SSH、WireGuard は変更しない。

## SSH トンネル

配備後に himekami で実行する手順。今回は SSH を実行していない。

```sh
ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:18080:127.0.0.1:18080 tadami
```

既存の SSH host alias / WireGuard 経路を使う。himekami のブラウザーから `http://127.0.0.1:18080` を開く。himekami 側の 18080 が使用中なら左側だけ 18081 に変更し、その URL を開く。SSH の `-g` は使わず、ローカル転送も loopback に限定する。トンネル停止は Ctrl+C。通常の SSH / Eternal Terminal / WireGuard 設定は変更しない。

## 停止・ロールバック

```sh
docker compose -f infra/web/compose.yaml stop
# 新規 Web コンテナと frontend を除去する場合のみ:
docker compose -f infra/web/compose.yaml down
```

対象は tadami-web のみ。外部扱いの monitoring ネットワークは down の削除対象にしない。`infra/monitoring/compose.yaml` で down しない。volume 削除・image prune・daemon 変更も不要。

更新前には前版の両 image ID とタグ、Compose / Dockerfile、api.env（権限600・非公開保管）を保存し、再 build で前版タグを上書きしない。失敗時は Web プロジェクトを停止し、前版のレビュー済み checkout / Compose と設定を用い、`TCR_RELEASE=<previous-sha>` に戻して `up -d --no-build`。前版イメージを残しておけばレジストリや npm を使わず復旧できる。初回導入時は Web プロジェクトを down して既存監視基盤のみへ戻す。localhost UI / API、公開ポート、既存監視の稼働を再確認する。

## 切り分け

| 症状 | 確認箇所 |
| --- | --- |
| Compose config / 起動拒否 | TCR_RELEASE、api.env の所在・権限、既存ネットワークの有無、API ログの不足フィールド名 |
| localhost UI に到達不能 | web の状態、内部8080、relay/resolver の journal、期限付き target、18080競合。01b 手順へ |
| UI は開くが 502/504 | API のプロセス、frontend DNS、API→Prometheus の DNS / ready、固定ラベル、上流期限 |
| 200 だが欠損・遅延 | 元系列、観測時刻、scrape失敗、時計差、device/mountpoint/fstype、容量整合性 |
| 503 BUSY | タブ数・同時要求、取得期限。上限を無条件に増やさない |
| メモリ不足 / 再起動 | OOMKilled、stats、PID、ログ、資源制限。観測と変更理由を記録 |
| データ種別不一致 | 正しい API に接続しているか。fixture ヘッダーを prometheus に置換しない |
| SSH 経由だけ失敗 | tadami localhost curl とトンネルの転送先・himekami ポートを分けて確認 |

UI の「実データ」表示は経路の設定であり取得成功の保証ではない。初回失敗は欠損、後続失敗は前回値とエラーを表示する。モックへ自動切替せず、ページ全体の再読み込みではなく 5 秒ごとの API 更新を使う。

## 未検証とセキュリティ上の限界

Docker CLI / daemon が himekami にないため、Docker build / pull / run、コンテナ内 UID・rootfs・資源制限・healthcheck・DNS・経路・ホストポートの実動作は未検証。YAML parser と厳密な schema / 変更拒否テストに加え、既存の単体 Compose 2.40.3 バイナリで設定例を用いた一時コピーの config を検証した。tadami の Compose 5.6.0 と実際の api.env による再検証は必要。実 Prometheus / tadami API 接続成功、実機ブラウザー・モニター・長時間運転は未検証。ローカル結果は [01a 検証記録](verification-beta-0.3-01a.md)。

loopback は同じホストのユーザー / プロセスからのアクセスを防がない。Docker 管理権限者は env と内部ネットワークにアクセスできる。internal bridge もホスト全体の隔離・同じ bridge 内の宛先別 ACL を保証しないため、API は Prometheus に加えて Node Exporter へも到達し得る。Web / API を侵害された場合のホスト bridge gateway の到達範囲は実機監査が必要。API の任意クエリー拒否はアプリケーション境界であり、侵害後の通信を保証しない。TLS / アプリ認証は loopback + SSH を前提として今回は追加しない。別の公開方式へ変更する際は設計を改める。

イメージ・依存の脆弱性スキャン、digest 固定、経路監査は配備前に必要。成果物検査は既知の設定名と検査用秘密値の混入を確認するもので、任意の秘密情報の完全検出ではない。build context 許可リストと公開変数無効化を主な保護とする。CSP は script / connect / font を同一オリジンに限定し、既存の React 表示に必要な inline style だけを許可する。

## キオスクへの引き継ぎ（後続）

後続で最小 Xorg + xinit/startx と Chromium または Firefox を**ホスト OS に**導入する方式を検討する。専用非特権 kiosk ユーザー、1280×1024、`http://127.0.0.1:18080` を使い、コンテナ IP をブラウザーへ渡さない。Snap の更新・sandbox・起動時間、ブラウザーのパッケージ選択、Xorg の logind / TTY 権限、TTY1 と既存 console の関係を実機で確認する。重量級 desktop / display manager を必要条件にしない。

後続で起動順序・API 起動待ち・TTY1 の自動起動・DPMS / 画面消灯防止・ブラウザーの異常終了と restart backoff・profile 所有権・ログサイズ・手動復旧・電源再投入を設計する。ブラウザー再起動後も同じ URL から再取得する。kiosk / Xorg 障害時に SSH・WireGuard・Docker を巻き込まない service 境界と非特権運用を検証する。X11 socket / display device / Docker socket を Web コンテナに渡さない。実時間の連続監視、実機の文字・欠損・鮮度・レイアウト、RAID 表示とサービス収集方式は後続課題。
