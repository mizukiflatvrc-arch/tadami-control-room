# β0.2 監視基盤：配備前の構成案と運用手順

2026-10-08 作成、10-09 検証追記。**今回は作業用 PC でのファイル作成・静的検査まで。以下の実機コマンドは実行していない。** tadami への SSH、コンテナ起動、UFW・既存サービス・RAID の変更は行わない。実機での配備は別途指示を受けて行う。

## 1. 確認済み情報と未確認情報

ユーザーから確認済みとして提示された構成：Ubuntu 24.04.5 LTS、Intel Core i5-7500 / 4 論理 CPU、メモリ約 31 GiB、OS 用 NVMe 約 232.9 GB、RAID1 `/dev/md0` 約 931.39 GiB / clean / 2 台中 2 台正常 / **未マウント**。Docker / Compose 導入済み、UFW 有効。既存の SSH・WireGuard・Eternal Terminal を維持する。

実機の Docker Engine / Compose / Linux カーネルのバージョン、rootless・userns-remap・hidepid・AppArmor の設定、Docker の既存ネットワーク・ルーティング、NVMe のパーティション・実ファイルシステム・空き容量・データ用パスは未確認。上記の公称容量を監視値としてハードコードしない。

## 2. 配置とバージョン

| ファイル | 内容 |
| --- | --- |
| `infra/monitoring/compose.yaml` | 2 コンテナ、専用内部ネットワーク、権限・資源制限 |
| `infra/monitoring/prometheus.yml` | 固定ターゲットと 15 秒収集 |
| `infra/monitoring/images.lock.json` | バージョン・公式レジストリで確認した index / amd64 digest |
| `infra/monitoring/.env.example` | NVMe 上の保存先だけを指定するテンプレート。空欄のままでは起動不可 |
| `tools/monitoring/check-config.ts` | 通信・Docker 操作なしの静的安全検査 |

2026-10-08 に [公式ダウンロード一覧](https://prometheus.io/download/) を確認。最新通常版 3.15.0 に対し、今回は保守系列の **Prometheus 3.13.4 LTS** を選択。Node Exporter は **1.12.1**。タグだけでなく `@sha256:…` でマルチプラットフォームの index を固定し、`platform: linux/amd64` を指定する。ダイジェストは Quay の公開マニフェスト API で確認した。コンテナイメージの pull・実行はしていない。

- [Prometheus 3.13.4 リリース](https://github.com/prometheus/prometheus/releases/tag/v3.13.4)
- [Node Exporter 1.12.1 リリース](https://github.com/prometheus/node_exporter/releases/tag/v1.12.1)

導入直前にセキュリティ修正の有無を再確認する。更新は Compose とロックファイルの両方をレビューして行い、`latest` や自動更新ツールは使わない。ダイジェスト固定は脆弱性がないことの保証ではない。

## 3. 通信と既存サービスへの影響

```text
専用 bridge: tadami-monitoring_monitoring（internal: true）
  Prometheus:9090 ── 15 秒ごと ──> Node Exporter:9100
       └───────── 自己メトリクス localhost:9090

ホストへの ports マッピング: なし（IPv4 / IPv6 とも）
既存 Docker ネットワークへの接続: なし
```

`0.0.0.0:9090` / `:9100` はそれぞれの **コンテナのネットワーク名前空間内** の待受。ホスト LAN / インターネットへ公開しない。`network_mode: host`、固定ホスト IP、9090/9100 のポート転送、外部収集先は設定しない。イメージの `EXPOSE` メタデータだけではホスト公開にはならない。

内部 bridge は外部ネットワークへの経路を分離する。ただしホスト管理者や Docker 操作権限を持つユーザーに対する認証境界ではなく、ホストから bridge IP に到達できる場合もある。`attachable: false` も Docker 管理者の接続操作を禁止するものではない。内部参加者を信用できることが前提で、他のサービスは接続しない。[Docker bridge network](https://docs.docker.com/engine/network/drivers/bridge/)

Docker の公開ポートは UFW の期待する経路を通らないことがあるため、UFW のみを防御にしない。既存 daemon の firewall 無効化・直接ルーティング・ネットワークサブネットの競合（特に WireGuard）を導入前に確認する。将来 `up` すると Docker が専用 bridge とその分離ルールを作成する。UFW や既存 daemon の設定をこの手順で書き換えない。既存接続に影響が出たら監視スタックだけを停止する。[Docker と firewall / UFW](https://docs.docker.com/engine/network/packet-filtering-firewalls/)

Prometheus の認証・TLS はこの閉じた収集ネットワークには追加していない。管理 API、HTTP reload、remote-write receiver を有効化しない。将来の CONTROL ROOM API は配備方式を別途決め、内部の `http://prometheus:9090/` に接続する案とする。現在の作業用 PC の API からこの名前は解決できない。接続のためにポートを公開したり、通信先をブラウザーに埋め込んだりしない。Grafana、サービス監視、通知先は今回の Compose に含めない。

## 4. 収集対象と最小権限

| collector | 用途 / 主要メトリクス |
| --- | --- |
| cpu | `node_cpu_seconds_total`。4 論理 CPU の idle 比率から使用率を算出 |
| meminfo | `node_memory_MemTotal_bytes` / `node_memory_MemAvailable_bytes` |
| diskstats | `node_disk_*`。NVMe / md デバイスなどの I/O。SMART は含まない |
| filesystem | `node_filesystem_size_bytes` / `free_bytes` / `avail_bytes`。マウント済みの FS のみ |
| stat / time | `node_boot_time_seconds` / `node_time_seconds`。差分が稼働時間 |
| mdadm | `node_md_*`。未マウントでも存在する md RAID の状態 |

デフォルト collector を無効化し、上記の 7 種類のみ明示的に有効化する。systemd / textfile / timex は使用しない。Docker socket、D-Bus、ホスト PID / network 名前空間、`/dev/md0` の直接アクセス、`privileged`、追加 capability は不要として設定しない。

両コンテナは UID:GID `65534:65534`、`cap_drop: ALL`、`no-new-privileges`、読み取り専用 rootfs。Prometheus の書き込み先は専用データディレクトリのみ。メモリ上限は Prometheus 1 GiB / Node Exporter 128 MiB、CPU 上限はそれぞれ 1 / 0.5 CPU。PIDs も制限し、ログは各最大約 30 MB（10 MB × 3）。これらは初期上限で、実機の負荷・OOM・scrape 時間を確認して調整する。

Node Exporter に必要なホスト bind mount：

| ホスト → コンテナ | 読み取る理由 | リスク |
| --- | --- | --- |
| `/proc` → `/host/proc` : ro | CPU・メモリ・起動時刻・diskstats・mdstat・PID 1 の mountinfo | 他プロセスやホスト状態の情報が見える |
| `/sys` → `/host/sys` : ro | md RAID の degraded 状態など | ハードウェア情報が見える |
| `/` → `/host/root` : ro | ホストのマウント先で `statfs` し容量を取得 | 非 root でも読めるホストファイルがコンテナから見える。ro は機密性の保護ではない |

ro は Unix socket 経由の操作まで防ぐ仕組みではない。ルート配下の runtime socket などが UID 65534 から利用できないことも導入時に確認する。ホストファイルを広く見せるリスクを許容できない場合は、必要なマウント先を実機調査後に絞った別案をレビューする。

ホスト `/proc/1/mountinfo` を bind 経由で読むため、選択した collector では `pid: host` を前提にしない。hidepid 等で読めなければ導入検証を中止し、欠損を正常と扱わない。権限を安易に追加しない。[filesystem collector の実装](https://github.com/prometheus/node_exporter/blob/v1.12.1/collector/filesystem_linux.go)

bind propagation は `rprivate` とし、将来追加されたマウントを自動伝播させない。マウント変更時は再レビューと Node Exporter の再作成が必要。今回 RAID のマウントを作成することはない。入れ子のマウントも ro になることは Docker / kernel に依存するため、**kernel 5.12 以上かつ実際の全 `/host` 配下が ro であること**を導入条件にする。ルートの ro 表示だけで子マウントの安全性を判定しない。[Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)

## 5. RAID1 の扱い

1.12.1 の mdadm collector は `/proc/mdstat` と sysfs を読む。md デバイスがアクティブなら、FS が未マウントでも取得可能な設計。RAID のフォーマット、アセンブル、修復、同期開始、マウント、`mdadm` コマンドの実行は不要。[mdadm collector の実装](https://github.com/prometheus/node_exporter/blob/v1.12.1/collector/mdadm_linux.go)

導入後の確認候補（`device="md0"` は実出力のラベルを確認する）：

```promql
node_md_disks_required{job="tadami-node",instance="tadami",device="md0"}
node_md_disks{job="tadami-node",instance="tadami",device="md0",state="active"}
node_md_disks{job="tadami-node",instance="tadami",device="md0",state="failed"}
node_md_degraded{job="tadami-node",instance="tadami",device="md0"}
node_md_state{job="tadami-node",instance="tadami",device="md0"}
node_scrape_collector_success{job="tadami-node",instance="tadami",collector="mdadm"}
```

現状から期待する確認値は required=2、active=2、failed=0、degraded=0、collector_success=1。ただし **実機で取得するまで正常と断定しない**。系列不在は正常 0 ではなく不明。`mdadm --detail` の文字列 `clean` と `node_md_state` の state ラベルは同じ定義ではない。再同期・回復なども別に確認する。

未マウント `/dev/md0` に `node_filesystem_*` は期待しない。931.39 GiB を FS 総容量・空き容量として代用しない。MonitoringSnapshot v1 に RAID 状態フィールドはないため、今回のアプリのサービス状態やストレージ使用率に押し込めない。UI/API への RAID 表示追加と通知規則は別途設計する。

## 6. 保存先と保持容量

保持は `7d` と `1GB` の先に成立した条件で古いブロックを削除する。Prometheus の `GB` は 1024 基数（1 GiB）。これは **TSDB 保持ポリシーであり、ディレクトリ全体を絶対 1 GB 以下にするクォータではない**。WAL・Head・compaction の一時領域、イメージ、Docker ログ、バックアップは別途空き容量を必要とする。7 日分を必ず保持できる保証もない。厳密なファイルシステムクォータは未設定で、既存ディスク構成を今回変更しない。[Prometheus storage](https://prometheus.io/docs/prometheus/latest/storage/)

データは名前付き volume ではなく、確認済みの NVMe 上の専用パスを bind する。候補は `/var/lib/tadami-control-room/prometheus`。`findmnt` と `lsblk` でデバイスを辿り、**OS 用 NVMe 上であることを確認後**に `.env` へ設定する。RAID、ネットワーク FS、Docker の不明な data-root に暗黙保存しない。`create_host_path: false` により、パスの打ち間違いで root 所有ディレクトリを自動生成しない。

初期導入ではデータ用に少なくとも数 GiB の余裕と OS の運用余白を確保し、実測して容量警告の閾値を決める。既存のデータパス・シンボリックリンク・共有ディレクトリを流用しない。

## 7. PC 上でできる配備前検査

リポジトリルートで実行する。静的安全検査はネットワークや Docker を使用しない。

```sh
npm ci
npm run check:monitoring
npx vitest run tests/server/infrastructure.test.ts
```

別途入手した公式 Compose CLI / promtool による構文検査（**コンテナを起動する `docker run … promtool` は今回使わない**）：

```sh
# 架空パスは展開確認専用。作成・起動には使用しない。
TCR_PROMETHEUS_DATA_DIR=/tmp/tadami-config-validation-only \
  docker compose -f infra/monitoring/compose.yaml config --quiet
promtool check config infra/monitoring/prometheus.yml
```

`config` は Docker デーモンに接続せず展開を確認できる。今回 PC では `/tmp` に公式 checksum 照合済みの Compose 2.40.3 と promtool 3.13.4 を置き、単体 CLI として検証した。ファイル存在・NVMe 所在・カーネルの ro 適用・疎通をこれだけで保証しない。安全検査は `ports`、host network / PID、権限追加、外部 scrape、管理 API の有効化などを拒否する。複数 Compose ファイルの override や外部環境で変更した最終構成は検査対象外なので、本番は本ファイルを明示して起動し、展開結果もレビューする。

## 8. 実機での導入前確認（未実行）

以下は将来の導入担当者向け。今回は実行しない。

```sh
uname -r
docker version
docker compose version
docker info
lsblk -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS
findmnt -T /var/lib -o TARGET,SOURCE,FSTYPE,OPTIONS
df -h /var/lib
cat /proc/mdstat
cat /sys/block/md0/md/degraded
ss -lnt
sudo ufw status verbose
docker network ls
```

データ候補パスの親まで `findmnt -T` で確認し、最終的な専用ディレクトリ作成後も再確認する。LVM / 暗号化の場合は親デバイスまで追う。kernel、rootless / userns-remap、UID/GID マッピング、`/proc/1/mountinfo` の可読性、NVMe の残容量、既存ネットワークとのアドレス重複を記録する。不一致なら配備せず構成案を見直す。既存 SSH / WireGuard / Eternal Terminal の接続確認を前後で行う。取得した実機ログは秘密情報を点検し、無加工で Git に追加しない。

確認後、別途配備が許可された場合だけ：専用の空ディレクトリを UID/GID `65534:65534`、mode `0750` で作る（rootless / userns-remap ならホスト UID は先に調整計画が必要）。既存ディレクトリへ再帰的 `chown` はしない。テンプレートから `infra/monitoring/.env` を作り保存先を明示する。以降の操作は同ディレクトリで行う。

```sh
# 将来の承認済み配備時のみ。既存スタックへの一括操作はしない。
docker compose --env-file .env -f compose.yaml config --quiet
docker compose --env-file .env -f compose.yaml config --images
docker compose --env-file .env -f compose.yaml pull
docker compose --env-file .env -f compose.yaml up -d
```

`.env` と監視 DB / バックアップを Git に追加しない。OS 用 NVMe 以外への保存先変更は認めない。

## 9. 起動後の確認（未実行）

すべて `infra/monitoring/` で、承認済み導入後だけ実行する。

```sh
docker compose --env-file .env -f compose.yaml ps
docker compose --env-file .env -f compose.yaml logs --tail=100 prometheus node-exporter
docker compose --env-file .env -f compose.yaml exec -T prometheus \
  promtool check config /etc/prometheus/prometheus.yml
docker compose --env-file .env -f compose.yaml exec -T prometheus \
  wget -qO- http://localhost:9090/-/ready
docker compose --env-file .env -f compose.yaml exec -T prometheus \
  wget -qO- http://localhost:9090/api/v1/targets
docker compose --env-file .env -f compose.yaml exec -T prometheus \
  wget -qO- http://node-exporter:9100/metrics
docker compose --env-file .env -f compose.yaml exec -T prometheus \
  promtool query instant http://localhost:9090 'up{job="tadami-node",instance="tadami"}'
docker compose --env-file .env -f compose.yaml exec -T prometheus \
  promtool query instant http://localhost:9090 'count(node_cpu_seconds_total{job="tadami-node",instance="tadami",mode="idle"})'
docker compose --env-file .env -f compose.yaml exec -T node-exporter \
  cat /proc/self/mountinfo
```

確認条件：targets は 2 件とも up、node の up=1、CPU idle 系列数=4、メモリは約 31 GiB、`node_time_seconds - node_boot_time_seconds` が実機稼働時間と整合、NVMe の実 FS の device / mountpoint / fstype が正しい、md0 の系列が前述の期待と整合。CPU `rate(...[60s])` は 15 秒収集を複数回待ってから確認する。FS collector 失敗・device_error・OOM・sample_limit 超過がないことも確認する。`up=1` だけで各 collector や既存アプリが正常とは判断しない。

`/proc/self/mountinfo` の **全 `/host` 配下マウントの mount options が ro** であることを確認する（区切り `-` より前の options を見る。元 FS の superblock が rw でも bind の ro とは別）。rw があれば Node Exporter を停止して原因を調べる。

コンテナ ID を `docker compose … ps -q` で得て `docker inspect` し、PortBindings が空、Privileged=false、CapDrop=ALL、ReadonlyRootfs=true、指定ネットワークだけであることを確認。`docker network inspect tadami-monitoring_monitoring` は Internal=true であることを確認する。ホスト `ss` だけでは Docker の NAT 公開を検出しきれない。導入検証では LAN / 外部から tadami の 9090/9100 が到達不能なこと、既存管理接続が維持されることも確認する。異常時に UFW を無効化して対処しない。

## 10. バックアップ、停止、復旧

設定とイメージロックは Git で管理。7 日間の TSDB は短期データとし、損失許容度を導入時に確認する。初期方針は導入・更新前および必要に応じた日次の **Prometheus 停止中の完全コピー**。稼働中の単純コピーは避ける。今回 admin API を有効にしていないためオンライン snapshot API は使わない。

将来のバックアップ手順（データパスと別のバックアップ先を確認してから。以下の変数は自動読込されない）：

```sh
# 絶対パスを確認して明示する。DATA_DIR は .env と一致させる。
TCR_BACKUP_DATA_DIR=/var/lib/tadami-control-room/prometheus
TCR_BACKUP_DEST=/承認済みのバックアップ先
# 両パスと容量・権限を確認した後だけ実行。
docker compose --env-file .env -f compose.yaml stop -t 60 prometheus
sudo tar --numeric-owner --acls --xattrs -cpf "$TCR_BACKUP_DEST/prometheus-$(date +%Y%m%d-%H%M%S).tar" \
  -C "$TCR_BACKUP_DATA_DIR" .
docker compose --env-file .env -f compose.yaml start prometheus
```

停止完了・tar 終了コード・アーカイブ内容・checksum を確認し、同時点の設定 / image digest / 権限 / バージョンを記録する。アーカイブには WAL / chunks_head を含む全データを入れる。バックアップ先は TSDB ディレクトリの外に置き、アクセス制限・暗号化を適用する。NVMe 故障に備えるなら別の承認済み保存先へコピーする。未マウントの RAID をそのためにマウントしない。バックアップ保管量は 1GB 保持設定の対象外なので、例えば 7 世代で管理し、必要な空き容量を別途見積もる。自動バックアップジョブは未導入。

通常停止・再開：

```sh
docker compose --env-file .env -f compose.yaml stop -t 60
docker compose --env-file .env -f compose.yaml start
```

今回の監視コンテナ / ネットワークだけを撤去する場合は `docker compose --env-file .env -f compose.yaml down`。bind したデータは残る。`down -v`、Docker 全体の prune、既存サービスの停止は使わない。

復旧は停止後、障害時の DB を別名へ退避し削除しない。同じバージョンの設定・ロックを戻し、バックアップを **空の専用復旧ディレクトリ** に所有権を保持して展開する。NVMe 所在と UID/GID / mode を再確認し、`.env` の保存先を復旧先に変更、`config` を再検査して `up -d`。既存 DB の上に展開しない。起動後は第 9 節を再実施する。バージョンを下げる場合は異なる版が書いた DB の互換性を推測せず、旧版と同時点のバックアップを使う。

バックアップがなければ障害 DB を保全したうえで新しい空ディレクトリで再開する案を承認する。その場合、過去データは復元されない。RAID や既存サービスのデータを操作する復旧手順ではない。

## 11. 今回の検査結果と配備の条件

- 静的安全検査：成功。危険な変更を注入する 14 ケースのテストを追加。
- Compose 2.40.3 の `config --quiet`：成功。未設定の保存先では期待どおりエラー。
- promtool 3.13.4 の `check config`：成功。
- イメージ：公式レジストリの index / linux-amd64 digest を取得して固定。pull・実行は未実施。
- 実機での収集、権限、容量、RAID の実サンプル、ネットワーク分離、既存接続の維持：未検証。配備前後の確認が必要。

アプリを含む検証記録は [verification-beta-0.2.md](verification-beta-0.2.md) を参照。

本資料は配備準備であり、本番稼働済みの記録ではない。アプリのモック版は引き続き使用でき、実データモードへの切替・本番バックエンド配備は自動では行わない。
