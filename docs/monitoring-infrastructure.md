# β0.2 監視基盤：配備前の構成案と運用手順

2026-10-08 作成、10-09 子マウントの安全性調査・構成候補を追記。**2c6d87d の `/` 全体の ro,rslave 構成は実機で安全要件を満たさなかった。以下の代替構成は実機未検証であり、配備条件を満たすまで使用しない。** 本修正は作業用 PC でのファイル変更・静的検査まで。以下の実機コマンドは実行していない。tadami への SSH、コンテナ起動・停止、マウント操作、Docker デーモン設定、UFW・WireGuard の変更は行わない。実機での配備・検証は別途指示を受けて行う。

## 1. 確認済み情報と未確認情報

ユーザーから確認済みとして提示された構成：Ubuntu 24.04.5 LTS、Intel Core i5-7500 / 4 論理 CPU、メモリ約 31 GiB、OS 用 NVMe 約 232.9 GB、RAID1 `/dev/md0` 約 931.39 GiB / clean / 2 台中 2 台正常 / **未マウント**。Docker / Compose 導入済み、UFW 有効。既存の SSH・WireGuard・Eternal Terminal を維持する。

初回起動エラーの報告時に、ユーザーから **Docker Engine 29.8.2、Linux Kernel 6.8** が提示された（Ubuntu 24.04.5 LTS）。実機への接続による確認はしていない。Compose のバージョン、rootless・userns-remap・hidepid・AppArmor の設定、Docker の既存ネットワーク・ルーティング、NVMe のパーティション・実ファイルシステム・空き容量・データ用パスは未確認。上記の公称容量を監視値としてハードコードしない。

## 2. 配置とバージョン

| ファイル | 内容 |
| --- | --- |
| `infra/monitoring/compose.yaml` | 2 コンテナ、専用内部ネットワーク、権限・資源制限 |
| `infra/monitoring/prometheus.yml` | 固定ターゲットと 15 秒収集 |
| `infra/monitoring/images.lock.json` | バージョン・公式レジストリで確認した index / amd64 digest |
| `infra/monitoring/.env.example` | NVMe 上の保存先だけを指定するテンプレート。空欄のままでは起動不可 |
| `tools/monitoring/check-config.ts` | 通信・Docker 操作なしの静的安全検査 |
| `tools/monitoring/host-mount-policy.ts` | ホストマウントの許可リストと固定 probe パス |
| `tools/monitoring/check-host-mounts.ts` | 保存済み inspect / mountinfo の読み取り専用・子マウント検査。実機への接続・Docker 操作なし |

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

| ホスト → コンテナ | propagation / recursive | 読み取る理由 | リスク・条件 |
| --- | --- | --- | --- |
| `/proc/stat` → `/host/proc/stat` : ro | `rprivate` / `disabled` | CPU・起動時刻 | ホストの集計情報が見える |
| `/proc/meminfo` → `/host/proc/meminfo` : ro | `rprivate` / `disabled` | メモリ | ホストの集計情報が見える |
| `/proc/diskstats` → `/host/proc/diskstats` : ro | `rprivate` / `disabled` | NVMe 等の I/O | デバイス情報が見える |
| `/proc/mdstat` → `/host/proc/mdstat` : ro | `rprivate` / `disabled` | RAID1 の状態 | RAID 構成が見える |
| `/proc/1/mountinfo` → `/host/proc/1/mountinfo` : ro | `rprivate` / `disabled` | `/` の FS ラベル | ホストのマウント一覧が見える。ホスト PID 1 のファイルが読めることが必要 |
| `/sys` → `/host/sys` : ro | `rprivate` / `readonly` | CPU の topology / online / throttle、md RAID の degraded 状態など | ハードウェア情報が見える。強制 recursive read-only が必要 |
| `/var/lib/tadami-control-room/node-exporter-root-probe` → `/host/root` : ro | `rprivate` / `disabled` | 同じ FS 内の空ディレクトリで `statfs` し `/` の容量を取得 | ホスト `/` と同一 FS・NVMe 所在・信頼できる空ディレクトリを別途確認。子マウントは取り込まない |

ro は Unix socket 経由の操作まで防ぐ仕組みではない。probe にファイルや socket を置かず、ホストの `/`・`/run`・`/var/lib/docker`・`/var/lib/containerd` や Docker socket は渡さない。proc は上記5ファイルに限定し、他プロセスの root / cwd / fd 等の不要な経路を渡さない。集計情報・mountinfo・sysfs の情報露出は残るため、UID マッピング・hidepid・既存の特殊マウントを確認する。

ホスト `/proc/1/mountinfo` を bind 経由で読むため、選択した collector では `pid: host` を前提にしない。hidepid 等で読めなければ導入検証を中止し、欠損を正常と扱わない。権限を安易に追加しない。[filesystem collector の実装](https://github.com/prometheus/node_exporter/blob/v1.12.1/collector/filesystem_linux.go)

### 4.1 Docker 29.8.2 の仕様・実装と実機での問題

初回のエラーは `/` が Docker data-root `/var/lib/docker` を包含し、Engine が明示的な `rprivate` を拒否したことによる。2c6d87d は `/` の伝播を `rslave` に変更したが、その後ユーザーが Node Exporter のホスト PID の mountinfo を調べ、61 マウント中3件の rw を検出した：`/host/root/run/docker/netns/...` 2件、`/host/root/var/lib/docker/rootfs/overlayfs/...` 1件。inspect の `RW=false` だけで全子マウントを保証できないことが実機で確認された。[29.8.2 の daemon-root 検証](https://github.com/moby/moby/blob/docker-v29.8.2/daemon/volumes_linux.go)

公式仕様では bind は既存の子マウントも取り込み、read-only は既定で recursive read-only を best-effort で適用する。Kernel 5.12 以上が必要だが、バージョンだけで適用を証明できない。29.8.2 の `withMounts` は runtime の対応も調べて `rro` または `ro` を選び、`ReadOnlyForceRecursive` が true なら未対応時にエラーにする。[Docker recursive mounts](https://docs.docker.com/engine/storage/bind-mounts/#recursive-mounts)、[29.8.2 の OCI マウント生成](https://github.com/moby/moby/blob/docker-v29.8.2/daemon/oci_linux.go#L559)

`rslave` はホストからの新しい子マウントを伝播させる。runc の再帰属性設定は、その時点のマウントツリーへ `mount_setattr(..., AT_RECURSIVE, ...)` を実行するもので、後から来るマウントを常時 ro に変換する監視機構ではない。**検出された3件が後から伝播した可能性は実装と整合するが、採取時刻・runtime バージョン・初期状態がないため経路は断定しない。** 既定の recursive read-only のフォールバックの有無も未確認。いずれの場合も `/` 全体の ro,rslave を安全な構成として継続しない。[Docker propagation](https://docs.docker.com/engine/storage/bind-mounts/#configure-bind-propagation)、[runc の再帰属性設定](https://github.com/opencontainers/runc/blob/main/libcontainer/rootfs_linux.go#L1436)

Compose では `bind.recursive` が利用できる。[公式 schema](https://github.com/compose-spec/compose-spec/blob/main/schema/compose-spec.json) と [Compose 2.40.3 の buildBindOption](https://github.com/docker/compose/blob/v2.40.3/pkg/compose/create.go#L1136) を確認した。`readonly` は Engine の `ReadOnlyForceRecursive=true`、`disabled` は `NonRecursive=true` に対応する。実機の Compose バージョンは未確認なので、展開結果にキーが残り、起動後の HostConfig に変換された値が残ることも必須条件。未知のキーを削って起動しない。

### 4.2 採用候補：ルート FS 上の空ディレクトリを使う

Node Exporter 1.12.1 の filesystem collector はホスト `/proc/1/mountinfo` からラベルを取り、`--path.rootfs` と mountpoint を結合したパスで `statfs` を実行する。このため `/` の容量だけなら、ホスト `/` と同じファイルシステム上の専用ディレクトリを `/host/root` に bind して取得できる。通常のサブディレクトリへの `statfs` はファイルシステム全体の容量を返す。ラベルを変更せず、既存 API の device / mountpoint / fstype の固定照合も維持する。ただし同一 FS・サブボリューム・クォータ等による差がないことを実測する。[1.12.1 の filesystem collector](https://github.com/prometheus/node_exporter/blob/v1.12.1/collector/filesystem_linux.go#L101)

候補パスを固定し、`create_host_path: false` とする。存在しないディレクトリは自動作成されない。probe は root 所有、非 root から探索可能（例：0755）、空、socket・symlink・子マウントなしとし、親ディレクトリも信頼できる所有者・権限にする。Docker の実際の data-root / exec-root / containerd 管理領域と probe が包含関係にないことを確認する。`/var` 等が別 FS ならこの固定パスは使えず、`/` と同じ FS 上の別の候補を構成・許可リストごとレビューする。`/` や Docker 管理領域への置換は拒否する。

probe は `read_only: true` + `rprivate` + `recursive: disabled`。filesystem の mountpoint include は厳密に `^/$`（Compose 原文は `^/$$`）とし、probe がないパスで誤った FS の `statfs` をしない。CPU・メモリ・NVMe diskstats・稼働時間・未マウント RAID1 は従来の7 collector で維持する。proc は実装が読む5ファイルだけを ro・非再帰 bind し、ファイル内容をコピーして固定しない。Node Exporter 1.12.1 の依存 procfs 0.21.1 は通常のディレクトリにも初期化でき、実 procfs 以外なら `isReal=false` として扱い、必要なパスを読む。今回使う collector の参照先を実装から確認したが、個別 proc ファイルの bind の可読性・更新と7 collector の動作は実機で検証する。[procfs の初期化](https://github.com/prometheus/procfs/blob/v0.21.1/fs.go)、[ファイルシステム判定](https://github.com/prometheus/procfs/blob/v0.21.1/fs_statfs_type.go)、[CPU collector](https://github.com/prometheus/node_exporter/blob/v1.12.1/collector/cpu_linux.go)

`/sys` は CPU と RAID の参照に残し、`rprivate` に **`recursive: readonly`** を追加する。全ホスト bind は ro、非 root、capabilities 削除、no-new-privileges、内部ネットワーク、非公開ポートを維持する。`--collector.cpu.info` や別 collector の追加は、proc 許可リストとの対応を再レビューする。

対象は OS の `/` の FS 容量だけ。NVMe 上の別パーティションや別マウントの容量は今回の許可リストに含めない。追加が必要なら、その FS ごとに専用 probe とコンテナ内パス・ラベルの対応を設計する。未マウント RAID は状態監視を維持し、容量の代用値を作らない。ファイルシステム構成変更・コンテナ再作成・Docker/runtime 更新後は実マウントと容量の検証を再実施する。今回は probe 作成もマウント操作も行わない。

### 4.3 systemd サービス化との比較（未実装）

| 案 | Prometheus への経路 | 安全性・制約 |
| --- | --- | --- |
| Compose + 空の probe（今回の候補） | 既存の内部 bridge で `node-exporter:9100` | ホスト TCP ポート不要。ホスト `/` と同一 FS の probe と runtime の強制 RRO 対応が必要。別 FS 容量は別設計 |
| systemd + ホスト localhost TCP | コンテナからホスト localhost へは直接到達しない | `127.0.0.1:9100` だけでは現構成の scrape ができない。解決に host network や `0.0.0.0` を使わない。採用しない |
| systemd + 専用 Unix socket + 内部 proxy | ホストの専用 metrics socket → proxy コンテナ → 内部 bridge の Prometheus | ホスト TCP 待受不要。Docker socket は使わない。systemd の socket 権限、proxy の `/metrics` 限定転送、UID/GID、再起動・socket 再生成、scrape 制限を設計・検証する必要がある |

systemd 案では専用非 root ユーザー、空の `CapabilityBoundingSet`、`NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、Docker/containerd 管理領域の `InaccessiblePaths` を候補とする。ホストの CPU・proc・sys・statfs を参照できる sandbox とし、collector の可読性を実測する。**systemd の read-only 指定も後からの伝播を自動的に安全にする保証として扱わず、service の mount namespace を同様に監査する。** [systemd 255 の実行 sandbox 仕様](https://github.com/systemd/systemd/blob/v255/man/systemd.exec.xml)

Node Exporter 1.12.1 が使う exporter-toolkit 0.17.1 は systemd socket activation の listener を受け取れるので、Unix socket を使う構成は検討可能。Prometheus 側は通常の HTTP ターゲットを維持し、Unix socket に接続する専用 proxy が橋渡しする。サービス単体だけ作って通信経路が完成したことにはしない。今回は unit・proxy・Prometheus の接続先は変更しない。[依存バージョン](https://github.com/prometheus/node_exporter/blob/v1.12.1/go.mod)、[toolkit の socket activation](https://github.com/prometheus/exporter-toolkit/blob/v0.17.1/web/tls_config.go#L282)

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
npx vitest run tests/server/infrastructure.test.ts tests/server/host-mounts.test.ts
```

別途入手した公式 Compose CLI / promtool による構文検査（**コンテナを起動する `docker run … promtool` は今回使わない**）：

```sh
# 架空パスは展開確認専用。作成・起動には使用しない。
TCR_PROMETHEUS_DATA_DIR=/tmp/tadami-config-validation-only \
  docker compose -f infra/monitoring/compose.yaml config --quiet
promtool check config infra/monitoring/prometheus.yml
```

`config` は Docker デーモンに接続せず展開を確認できる。PC に既存の公式 checksum 照合済み Compose 2.40.3 と promtool 3.13.4 を置き、単体 CLI として検証する。`config --format json` の Node Exporter 7件に `rprivate`、sys の `recursive: readonly`、proc 5ファイルと probe の `recursive: disabled` が残ることも確認する。CLI の canonical 出力では `$` を再エスケープするため include は `^/$$` と表示され、`create_host_path: false` は省略され得る。実際の起動引数 `Config.Cmd` は `^/$` であることを第9節で検査する。[Compose 2.40.3 の canonical 出力処理](https://github.com/docker/compose/blob/v2.40.3/cmd/compose/config.go#L159)

ファイル存在・NVMe 所在・runtime の RRO 対応・疎通を構文検査だけで保証しない。安全検査は `ports`、host network / PID、権限追加、外部 scrape、管理 API の有効化、ルート・proc 全体の bind、RRO の省略などを拒否する。複数 Compose ファイルの override や外部環境で変更した最終構成は静的検査対象外なので、本番は本ファイルを明示し、展開結果と第9節の実マウント検査の両方をレビューする。

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

probe のために追加で確認する条件（今回は未実行）：

- ホスト `/` が監視対象の OS 用 NVMe 上であること。`findmnt -T /` と `lsblk` で辿る。NVMe の公称容量と FS 容量を混同しない。
- probe は root 所有の新しい空ディレクトリで、親にも他ユーザーの書き込み権限・ACL がなく、全経路に symlink がないこと。Prometheus データディレクトリは流用しない。
- `findmnt -T /` と `findmnt -T /var/lib/tadami-control-room/node-exporter-root-probe` の mount ID / device / fstype が一致し、別 FS・別 bind・別 subvolume・quota による差がなく、probe 自体・配下に子マウントがないこと。probe が未作成なら所在確認と別途許可された準備が先。
- Docker の実際の `DockerRootDir`、exec-root、containerd の保存領域と probe が包含関係にないこと。既定値だけで判断しない。
- Compose が `bind.recursive` を扱い、Docker が runtime の RRO 対応を認識すること。未対応時の起動エラーを ro へのフォールバックや権限追加で回避しない。

候補の調査・準備後の読み取り専用確認例：

```sh
findmnt -T / -o ID,TARGET,SOURCE,MAJ:MIN,FSTYPE,OPTIONS
findmnt -T /var/lib/tadami-control-room/node-exporter-root-probe -o ID,TARGET,SOURCE,MAJ:MIN,FSTYPE,OPTIONS
realpath /var/lib/tadami-control-room/node-exporter-root-probe
namei -l /var/lib/tadami-control-room/node-exporter-root-probe
getfacl -p /var/lib/tadami-control-room /var/lib/tadami-control-room/node-exporter-root-probe
find /var/lib/tadami-control-room/node-exporter-root-probe -mindepth 1 -maxdepth 1 -print
stat -f -c '%T %i %s %b %f %a' / /var/lib/tadami-control-room/node-exporter-root-probe
```

`realpath` は指定パスと一致し、空ディレクトリ確認は出力なし、statfs の FS ID・block size・総 block 数は一致すること。free / available は時刻差で変動するが、実測差を説明できること。`stat -f` の値は第9節で exporter の size / free / avail と照合する。これらの条件を満たせない場合は候補構成の配備を中止する。

確認後、別途配備が許可された場合だけ：Prometheus 用の専用の空ディレクトリを UID/GID `65534:65534`、mode `0750` で作る。probe は別の空ディレクトリとして root 所有・読み取りと探索のみ可能な権限で準備し、上の全条件を再確認する（rootless / userns-remap ならホスト UID は先に調整計画が必要）。既存ディレクトリへ再帰的 `chown` はしない。テンプレートから `infra/monitoring/.env` を作り保存先を明示する。以降の操作は同ディレクトリで行う。

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
```

確認条件：targets は 2 件とも up、node の up=1、CPU idle 系列数=4、メモリは約 31 GiB、`node_time_seconds - node_boot_time_seconds` が実機稼働時間と整合、NVMe の実 FS の device / mountpoint / fstype が正しい、md0 の系列が前述の期待と整合。CPU `rate(...[60s])` は 15 秒収集を複数回待ってから確認する。FS collector 失敗・device_error・OOM・sample_limit 超過がないことも確認する。`up=1` だけで各 collector や既存アプリが正常とは判断しない。

読み取り専用と伝播モードを別々に確認する。以下も将来の承認済み導入後の手順であり、本修正では実行しない。

```sh
# 完全な inspect を保存。これはコンテナ操作ではなく将来の読み取り専用調査例。
TCR_NODE_CONTAINER_ID=$(docker compose --env-file .env -f compose.yaml ps -q node-exporter)
docker inspect "$TCR_NODE_CONTAINER_ID" > /tmp/tcr-node.inspect.json
TCR_NODE_HOST_PID=$(docker inspect --format '{{.State.Pid}}' "$TCR_NODE_CONTAINER_ID")
# PID が正の整数・コンテナが Running であることを確認してから読む。
sudo cat "/proc/$TCR_NODE_HOST_PID/mountinfo" > /tmp/tcr-node.mountinfo
sudo cat /proc/1/mountinfo > /tmp/tcr-host.mountinfo
# 再採取した inspect と PID / StartedAt を比較。採取中に再起動した場合は取り直す。
docker inspect --format '{{.State.Pid}} {{.State.StartedAt}} {{.State.Running}}' "$TCR_NODE_CONTAINER_ID"
```

inspect から得る PID は **ホスト側 PID**。コンテナから bind された `/host/proc/.../mountinfo` を読んでコンテナ自身の mount namespace と混同しない。rootless 等で namespace が一致しない場合も検証を中止し、調査する。採取したファイルは安全に作業用 PC へ渡し、リポジトリルートで保存済みファイルだけを検査する（転送も今回は行わない）：

```sh
node --import tsx tools/monitoring/check-host-mounts.ts \
  /path/to/tcr-node.inspect.json /path/to/tcr-node.mountinfo /path/to/tcr-host.mountinfo
```

検査はエラー時に非0終了し、実機へ接続せず、Docker・shell・mount を実行しない。識別ラベルと稼働状態、`Config.Cmd` の `/` 限定収集、7件の bind 元・先、`RW=false` と `rprivate`、HostConfig の sys の `ReadOnlyForceRecursive=true`・proc 5ファイルと probe の `NonRecursive=true`、全 `/host` 配下と子マウントの ro / private、probe の子マウント不存在、Docker 領域・overlay・nsfs・proc/sys 経由の一般 FS の混入、host `/` と probe の FS と内部パス一致、proc/sys のホスト FS および proc ファイルの内部パス一致を検査する。空・不正・欠落・多重マウントも拒否する。superblock の rw と bind 本体の mount options の ro は区別する。[Docker の bind 確認方法](https://docs.docker.com/engine/storage/bind-mounts/#use-a-read-only-bind-mount)

**PASS は採取時点のマウント証拠だけで、安全性全体の保証ではない。** 第8節の NVMe 所在、root 所有・ACL・symlink・空ディレクトリの条件、実際の7 collector の成功、device_error=0、`mountpoint="/"` の size / free / avail とホスト statfs の整合も必須。inode や quota の意味、非 root での available の差も確認する。継続する通常の Docker 活動後にも再採取して検査し、ホストのマウント構成変更・コンテナ再作成・runtime 更新後も繰り返す。rw や Docker 領域の露出が1件でもあれば運用を承認せず、別途許可された対応で停止・調査する。`touch` 等の書き込み実験や修復操作は検査ツールに含めない。

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

- 構成ポリシー検査：成功。構成のテスト79ケースと、保存済みスナップショット検査のテスト34ケースが成功。後者は合成 inspect / mountinfo を使用し、報告された3件の rw を注入して拒否を確認した。実機の完全なスナップショットを検証した記録ではない。
- 本修正の型チェック・lint：成功。全テスト：9ファイル / 214ケース成功。HTTP fixture のローカル待受に必要な許可を使い作業用 PC で実行。tadami への接続・コンテナ操作・マウント操作・Docker / UFW / WireGuard の設定変更は未実施。
- Compose 2.40.3 の `config --quiet`：成功。canonical JSON の7件の bind、recursive 設定、容量許可リスト、既存安全設定も確認。未設定の保存先では起動できない設計を維持。
- promtool 3.13.4 の `check config`：成功。
- イメージ：公式レジストリの index / linux-amd64 digest を取得して固定。pull・実行は未実施。
- 本候補の probe の所在・権限・空ディレクトリ、個別 proc bind の更新、全子マウント ro、7 collector の実サンプル、容量の整合、ネットワーク分離、既存接続の維持：未検証。第8・9節の条件を満たすまで配備・運用を承認しない。

アプリを含む検証記録は [verification-beta-0.2.md](verification-beta-0.2.md) を参照。

本資料は配備準備であり、本番稼働済みの記録ではない。アプリのモック版は引き続き使用でき、実データモードへの切替・本番バックエンド配備は自動では行わない。
