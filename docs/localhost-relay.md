# β0.3-01b localhost TCP リレー

2026-10-10。今回の完了範囲は himekami 上の実装・ローカル検証・この配備手順の作成。**以下の tadami 用コマンドはレビュー後の作業手順であり、今回実行していない。** tadami への SSH、systemd 有効化、パッケージ導入、コンテナ再作成は別途実施する。

## 採用構成

```text
ホストのブラウザー / SSH トンネル
  → 127.0.0.1:18080
  → socat（tadami-web-relay ユーザー、ホストの network namespace）
  → 検証済みの Web IPv4:8080
  → monitoring-api:8787 → Prometheus:9090

root resolver → 固定の Docker Unix socket を読み取り
              → /run/tadami-web-relay/target.json（期限付きのデータだけ）
非特権 supervisor → このデータを読み、socat と全子プロセスを管理
```

| 方式 | 評価 |
| --- | --- |
| socat + 小さな supervisor | 採用。実機で手動リレーが確認済み。bind、IPv4、接続数、接続期限を明示でき、接続先変更時に listener と既存接続をまとめて破棄できる |
| systemd-socket-proxyd + socket unit | systemd 同梱、イベント駆動で多数の接続に向く。今回は動的な宛先更新に加え、宛先不明時の socket 待受・再活性化も管理する必要があるため採用しない |

`systemd-socket-proxyd` の socket activation / 接続上限は [systemd 255 の公式マニュアルソース](https://github.com/systemd/systemd/blob/v255/man/systemd-socket-proxyd.xml)、socat の TCP / fork オプションは Ubuntu パッケージの `man socat` を参照。実機の OS は Ubuntu Server 24.04.5、Docker Engine 29.8.2 / Compose 5.6.0（ユーザー提示）。systemd 255 の機能を前提とし、導入前にバージョンを確認する。

### 権限と信頼境界

- `tadami-web-relay.service` は専用ユーザーで Python supervisor と socat を実行する。ログイン不可、ホームなし、Docker グループ所属なし。root での supervisor 起動もコードで拒否する。
- `tadami-web-relay-resolver.service` だけが root で `/run/docker.sock` を参照する。固定した `container ls --all`、`container inspect`、`network inspect` のみを実行し、コンテナや systemd の操作、任意の引数の受付はしない。Docker context・環境変数による接続先変更を除外し、CLI ごとに2秒の期限を設ける。Config.Env を取得せず、Docker の生出力をログに出さない。
- Docker socket 自体は読み取り専用 API ではなく、**補助処理は Docker 管理相当の信頼境界にある**。補助処理のコード・unit は root 所有、非特権ユーザーから書換不可とする。socket の chmod / ACL / グループ変更は不要。
- 共有ディレクトリは root:tadami-web-relay の0750、ファイルは0640。root だけが atomic rename で更新する。非特権側は所有者・通常ファイル・書込権限・サイズ・ハードリンク数・symlink を確認する。ファイルにはコンテナ ID、ネットワーク ID、IPv4、観測時刻だけを保存し、コマンドや秘密を渡さない。
- 非特権 unit は capabilities 空、NoNewPrivileges、rootfs と `/run` 読取専用、Docker socket 不可視、AF_INET のみ。AF_UNIX を作成できず、Docker socket への接続権限を持たない。補助 unit は AF_UNIX のみ。両者にプロセス数・メモリ・CPU・FD 上限を設定する。
- `PrivateNetwork=yes` はホストから bridge への通信を壊すため使わない。`IPAddressDeny=any` も動的 bridge 宛先を遮断するので使わない。これは完全な宛先別ファイアウォールではなく、固定コマンドと検証データによる接続先制限である。[systemd 255 の sandbox 設定](https://github.com/systemd/systemd/blob/v255/man/systemd.exec.xml)

### 識別・再照合・障害時の挙動

Compose の project=`tadami-web` / service=`web` ラベルを使い、停止済みも含め候補が厳密に1個のときだけ採用する。oneoff=False、Running=true、Paused=false、Restarting=false を確認する。名前には依存しない。[Docker のラベル・絞込み仕様](https://docs.docker.com/engine/manage-resources/labels/)

所属は `tadami-web_frontend` だけを許可し、network ID、Compose project/network ラベル、bridge / Internal=true / EnableIPv6=false、両 inspect の endpoint ID を照合する。IP は canonical な RFC1918 IPv4 のみ。空値、IPv6、hostname、port/CIDR 付き値、オプション・shell 文字列、loopback、link-local、グローバル IP を拒否する。frontend の単一 IPv4 subnet 内で、gateway/network/broadcast ではなく、network inspect の所属 IP と一致し、その IP が重複していないことも確認する。サブネット自体は固定しない。将来 RFC1918 以外や複数 subnet を使う場合は仕様変更のレビューが必要。

1回の照合が終わってから3秒待つ。非特権側は0.5秒ごとに状態を読む。コンテナ ID・network ID・IP のどれかが変われば socat と fork 子プロセスを停止し、新しい宛先で起動する。同一 IP が再割当てされてもコンテナ ID が変われば更新する。

未作成・停止・候補複数・不正 IP・Docker 停止・CLI timeout は即座に失効情報を書き、次の読取で待受と既存接続を閉じる。条件が戻れば自動復旧する。補助処理が異常終了・停止・凍結して更新できなくても、最後の情報は12秒で失効する。時計には suspend を含む `CLOCK_BOOTTIME` を使い、NTP に依存しない。OS 再起動で `/run` はクリアされる。

通常の Docker 応答では変更後おおむね3〜4秒、CLI が遅い場合はさらに各2秒の期限とプロセス停止時間が加わる。lease 失効後の検出は通常0.5秒以内、停止処理には最大4秒、unit 停止には6秒の上限がある。**ポーリング間の変更・IP再利用や inspect 間の競合を瞬時には防げない**。不一致は次回照合で閉じる。変更時には進行中の HTTP 接続も切断され、UI の次回取得で復旧する。

Docker と Web の起動完了を systemd 起動条件にしない。resolver の `After=docker.service` は順序だけであり、Docker を起動・停止・再起動しない。Web / API は既存 Compose の restart 設定を使う。サービスが active でも、有効な Web がなければ18080は待受しない。

プロセス自体の異常終了は `Restart=on-failure`、5秒から60秒へ4段階でバックオフ。300秒内の起動は5回まで。上限到達後は原因を直して `reset-failed` が必要。Docker / Web 不在は正常な待機状態なので、この起動回数を消費しない。[systemd 255 の再起動設定](https://github.com/systemd/systemd/blob/v255/man/systemd.service.xml)

## パッケージと配置

必要な Ubuntu パッケージは `python3`（標準ライブラリのみ）、`socat`、`systemd`。確認用に `curl` / `iproute2`（ss）。既存 `/usr/bin/docker` を利用し、Docker パッケージや daemon 設定は変更しない。必要な不足分だけレビュー後に導入する。

| Git 管理ファイル | tadami 配置先・権限 |
| --- | --- |
| `infra/relay/{relay_state,resolve,relay}.py` | `/usr/local/lib/tadami-web-relay/`、root:root、ディレクトリ0755 / ファイル0644 |
| `infra/relay/tadami-web-relay.service` | `/etc/systemd/system/`、root:root、0644 |
| `infra/relay/tadami-web-relay-resolver.service` | 同上 |
| `infra/relay/tadami-web-relay.sysusers.conf` | `/etc/sysusers.d/tadami-web-relay.conf`、root:root、0644 |
| `infra/web/compose.yaml` | 既存 Web checkout の同じ位置。web の ports を削除 |

設定はこれらの固定ポリシーと unit に集約する。IP を保存した env ファイルや Docker 認証情報は不要。**ファイル配置・daemon-reload・sysusers 作成だけではサービスは有効化されない**。resolver は独立した enable 対象を持たず、relay の Wants で起動し、PartOf により relay の stop/restart に追従する。

## 初回導入と手動 socat からの切替（後日 tadami で実施）

作業ディレクトリは既存リポジトリ root。手順は段階ごとに結果を確認して進める。既存 `api.env`、`.env`、稼働中の image ID/tag、Web の現行 Compose をバックアップする。`TCR_RELEASE` には**現在稼働中の、ローカルに存在するイメージの release**を設定する。今回のポート削除だけなら新しいイメージ build は不要であり、未ビルドの今回コミット SHA を image tag に指定しない。

### 1. 事前確認・ファイル配置（まだ有効化しない）

既存の手動 socat の UID / PID / 子 PID / コマンド、18080 の使用、Web と API の ID、監視基盤の ID と network 属性を記録する。秘密を含み得る inspect 全体や Compose 展開結果を公開しない。`getent passwd tadami-web-relay` で既存の同名ユーザーがある場合は、用途・ホーム・シェル・所属グループを確認し、別用途なら導入を止める。

```sh
systemd --version
command -v python3 socat docker curl ss
sudo ss -lntp 'sport = :18080'
docker compose -f infra/web/compose.yaml ps
docker network inspect tadami-web_frontend --format '{{.Id}} {{.Internal}} {{json .Labels}}'
docker network inspect tadami-monitoring_monitoring --format '{{.Id}} {{.Internal}}'

# 不足している場合のみ（Docker/監視パッケージを変更しない）:
sudo apt-get install --no-install-recommends python3 socat curl iproute2

sudo install -d -o root -g root -m 0755 /usr/local/lib/tadami-web-relay
sudo install -o root -g root -m 0644 infra/relay/relay_state.py infra/relay/resolve.py infra/relay/relay.py /usr/local/lib/tadami-web-relay/
sudo install -o root -g root -m 0644 infra/relay/tadami-web-relay.service infra/relay/tadami-web-relay-resolver.service /etc/systemd/system/
sudo install -o root -g root -m 0644 infra/relay/tadami-web-relay.sysusers.conf /etc/sysusers.d/tadami-web-relay.conf
sudo systemd-sysusers /etc/sysusers.d/tadami-web-relay.conf
getent passwd tadami-web-relay
id tadami-web-relay
sudo -u tadami-web-relay test ! -r /run/docker.sock
sudo -u tadami-web-relay test ! -w /run/docker.sock
sudo systemd-analyze verify /etc/systemd/system/tadami-web-relay.service /etc/systemd/system/tadami-web-relay-resolver.service
sudo systemctl daemon-reload
systemctl is-enabled tadami-web-relay.service
sudo /usr/bin/python3 -E -s -B /usr/local/lib/tadami-web-relay/resolve.py --check
```

初回 `is-enabled` は `disabled`（終了コード1）が期待値。ユーザーは nologin / `/nonexistent`、所属は専用グループだけで、Docker socket の読書き不可を必須とする。`SupplementaryGroups=` だけでは OS 側の既存グループ登録を消せないので、この確認を省略しない。`--check` は状態を読み、検証した JSON を表示するだけで、リレーや状態ファイルを作らない。失敗したら Compose ラベル・ネットワークを調べ、検証を無効化して回避しない。

`--check` の `ip` を用いてホストから `curl --fail --max-time 5 http://<検証済みIPv4>:8080/` も確認する。この段階で失敗する場合はリレー導入を進めず、Web の稼働状態とホスト→bridge 経路を調べる。

### 2. 手動リレーを停止

`sudo ss -lntp 'sport = :18080'` と `ps -eo user,pid,ppid,pgid,args` で対象を確認する。手動 socat の listener と、そのプロセスから fork された子だけに TERM を送る（`kill -TERM <確認済みPID...>`）。専用と確認できないプロセスグループへの kill や `killall socat` は使わない。`ss -lntp` と `ss -ntp` で listener と旧接続がなくなったことを確認する。ここから UI に短い停止時間が発生する。

### 3. Compose を更新し Web だけを再作成

レビュー済みの `infra/web/compose.yaml` を反映する。web の `ports: [127.0.0.1:18080:8080]` が削除され、API の network と既存 monitoring 参照に差分がないことを確認する。既存の override に ports が残っていれば、その設定も適用対象から除く。

```sh
export TCR_RELEASE='<existing-image-release>'
docker compose -f infra/web/compose.yaml config --quiet
docker compose -f infra/web/compose.yaml up -d --no-deps --no-build --pull never --force-recreate web
docker compose -f infra/web/compose.yaml ps
docker compose -f infra/web/compose.yaml logs --tail=50 web
docker inspect --format '{{.Id}} {{json .HostConfig.PortBindings}} {{json .NetworkSettings.Ports}} {{json .NetworkSettings.Networks}}' \
  "$(docker compose -f infra/web/compose.yaml ps -q web)"
sudo /usr/bin/python3 -E -s -B /usr/local/lib/tadami-web-relay/resolve.py --check
```

Web の HostPort が空であること（`8080/tcp:null` の EXPOSE 表示は可）、API の ID と既存監視基盤の ID/network が変わらないことを確認する。`--no-deps web` なので API を再作成しない。`docker compose down`、monitoring Compose の up/down、Docker 再起動は行わない。

### 4. リレーを起動し、疎通確認後に自動起動を有効化

```sh
sudo systemctl start tadami-web-relay.service
systemctl status tadami-web-relay.service tadami-web-relay-resolver.service --no-pager
sudo journalctl -u tadami-web-relay -u tadami-web-relay-resolver -n 100 --no-pager
sudo ss -4 -lntp 'sport = :18080'
sudo ss -6 -lntp 'sport = :18080'
curl --fail --max-time 10 http://127.0.0.1:18080/
curl --fail --max-time 10 -D - http://127.0.0.1:18080/api/monitoring/snapshot
sudo systemctl enable tadami-web-relay.service
systemctl is-enabled tadami-web-relay.service
```

curl の両方が200、API は `X-Tadami-Data-Origin: prometheus` と実データ・鮮度を確認する。IPv4 待受は `127.0.0.1:18080` だけ、IPv6 待受なし、API/9090/9100のホスト公開なしが受入条件。localhost 以外の tadami の LAN/WireGuard アドレスへ18080で直接接続できないことも確認する。unit の active だけでは成功と判定しない。

権限は `systemctl show tadami-web-relay -p User -p Group -p MainPID -p ControlGroup -p NoNewPrivileges -p RestrictAddressFamilies`、`ps -eo user,pid,ppid,args`、対象 `/proc/<pid>/status` の Uid/Gid/Groups/CapEff/NoNewPrivs と `/proc/<pid>/fd` で確認する。supervisor と socat は専用 UID、CapEff=0、NoNewPrivs=1、Docker socket FD がないことを確認する。`systemd-analyze security tadami-web-relay.service` は補助診断であり、スコアのために PrivateNetwork を有効化しない。

## 運用・追従確認

```sh
sudo systemctl stop tadami-web-relay.service
sudo systemctl start tadami-web-relay.service
sudo systemctl restart tadami-web-relay.service
sudo journalctl -u tadami-web-relay -u tadami-web-relay-resolver --since '10 minutes ago' -n 100 --no-pager
sudo journalctl -u tadami-web-relay -u tadami-web-relay-resolver -f
```

stop は PartOf により resolver も止める。start-limit 到達時は原因修正後に両 unit を `sudo systemctl reset-failed tadami-web-relay.service tadami-web-relay-resolver.service`、次に relay を start する。

IP 追従試験は、Web の ID/IP と `/run/tadami-web-relay/target.json` を記録し、上記の **web だけ**の `--force-recreate` を実施する。新 ID/IP に JSON とログが追従し、curl 両経路が復旧することを確認する。IP が同じならコンテナ ID による更新だけを確認したと記録し、無理にダミーコンテナや network 変更で IP を変えない。ローカルテストでは異なる IP の入力による更新を検証する。

Web 停止の確認が許可された作業時間には `docker compose -f infra/web/compose.yaml stop web`、18080 の消失、`start web` 後の自動復旧を確認する。resolver 停止時は `sudo systemctl stop tadami-web-relay-resolver.service` 後に lease 失効・待受消失を確認し、resolver の start で復旧を確認できる。**Docker daemon の停止試験は既存監視を巻き込むため tadami では行わない**。この経路はローカルの失敗/timeout 注入で検証する。

OS 再起動は別途承認された保守時に確認する（本作業から再起動しない）。起動後に `systemctl is-enabled/is-active tadami-web-relay`、両 unit の `journalctl -b`、上記 ss/curl、Web/API/既存監視の稼働を確認する。Docker 起動が遅れても resolver が待機して追従する。Web が以前手動 stop された場合、Compose の `unless-stopped` は起動しないので Web の復旧が必要。

ログは journald へ出力し、成功した再照合を毎回は記録しない。状態変化とエラーだけ、各 unit 最大20メッセージ/30秒。socat はアクセス本文を記録せず、同時32接続、接続期限3秒、無通信30秒で制限する。保存容量・保存期間・再起動を跨ぐ保存の有無は**既存 journald の制限**に従う。`journalctl --disk-usage` / `journalctl --list-boots` で確認し、本機能のためにホスト全体の journald 設定を変更しない。

| 症状 | 確認箇所 |
| --- | --- |
| resolver の revoked | Docker socket/daemon、候補数（停止済みを含む）、ラベル、frontend ID/属性、IP/subnet を `--check` と journal で確認 |
| active だが18080なし | target.json の有無・権限・更新、resolver の状態。Web の起動待ちは正常な待機 |
| socat の bind エラー / start-limit | 手動リレーや古い Compose ports の競合。対象を確認して止め、reset-failed 後に起動 |
| リレーは待受するが curl 失敗 | 検証済み IP:8080 への直接 curl、Web 状態、sandbox の実効設定。PrivateNetwork を有効化しない |
| UI 200 / API 502・504 | Web→API→Prometheus の既存経路と API ログ。リレーは HTTP status を加工しない |

### SSH トンネル（後日 himekami で実施）

```sh
ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:18080:127.0.0.1:18080 tadami
```

既存 host alias / SSH / WireGuard 設定を使う。Chrome で `http://127.0.0.1:18080` を表示し、実データ・定期更新を確認する。himekami の18080が使用中なら左側だけ18081に変更する。トンネル終了は Ctrl+C。将来のホスト kiosk URL は引き続き `http://127.0.0.1:18080`。

## 失敗時・ロールバック・削除

まずリレーだけを止める。

```sh
sudo systemctl disable --now tadami-web-relay.service
sudo systemctl stop tadami-web-relay-resolver.service
sudo ss -lntp 'sport = :18080'
```

Web / API / monitoring はこの操作では止まらない。復旧を優先する場合、Compose の ports は削除したままにして、検証済みの宛先に対する手動 socat へ戻せる。下記は `--check` 成功を条件にし、取得失敗時は実行しない。

```sh
set -o pipefail
relay_ip=$(sudo /usr/bin/python3 -E -s -B /usr/local/lib/tadami-web-relay/resolve.py --check \
  | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["ip"])') && \
sudo -u tadami-web-relay /usr/bin/socat -T 30 \
  'TCP4-LISTEN:18080,bind=127.0.0.1,reuseaddr,fork,max-children=32,backlog=32' \
  "TCP4:${relay_ip}:8080,connect-timeout=3"
```

この手動 fallback は IP 追従・自動起動を持たない。終了時は listener と fork 子の終了も確認する。curl と SSH 表示を再確認し、恒常化の問題を解決してから再切替する。UI を休止できるならリレー停止のままでも監視基盤は継続する。

以前の Compose をそのまま復元する必要がある場合は、リレーを止めたままバックアップの Compose / 既存 image release を復元し、`--no-deps --no-build --pull never --force-recreate web` で Web だけを再作成する。古い公開設定が実際に18080を確保した場合は手動/恒常リレーを同時起動しない。確保しない既知の症状が再現した場合は、ports を削除した構成と手動 fallback に戻す。API / 監視 Compose、既存監視ネットワーク、daemon / UFW / SSH / WireGuard 設定の変更で回避しない。

完全削除は停止・無効化後に行う。上表の `/etc/systemd/system/` の2 unit、`/etc/sysusers.d/tadami-web-relay.conf`、`/usr/local/lib/tadami-web-relay/` の3ファイルだけを削除し、空になった専用ディレクトリを削除する。`sudo systemctl daemon-reload` を実行し、専用アカウントのプロセス・他用途・所有ファイルがないことを確認して `sudo userdel tadami-web-relay`、専用 group が残る場合のみ `sudo groupdel tadami-web-relay`。共有の python3 / socat パッケージを無条件に削除しない。runtime directory は resolver 停止で削除され、既存 journal はホストの保存方針に従って残る。

## ローカル検証と実機未検証

`npm run test:relay` は Python 標準 unittest、`systemd-analyze verify`、識別・IP・権限・失効・再起動委譲の検査を行う。socat が PATH にある場合は実 TCP 試験も行う。インストールしない場合は `SOCAT_BINARY=/absolute/path/to/socat npm run test:relay`。実 TCP 試験は待受を固定したまま、bridge 宛先だけを127.0.0.2 / 127.0.0.3のローカル fixture に置換する。root や Docker を必要としない。socat がなければ実 TCP 2件は skip と表示される。

実行結果・未検証事項は [01b 検証記録](verification-beta-0.3-01b.md)。unit 構文検査は実 systemd sandbox の起動検証ではない。tadami のユーザー・socket 所有権・bridge 通信・AppArmor/cgroup・systemd バックオフ/起動制限・再起動後の復旧・実IP変更・長時間稼働はレビュー後に確認する。今回監視 Compose と Web/API アプリケーションの通信処理は変更しない。
