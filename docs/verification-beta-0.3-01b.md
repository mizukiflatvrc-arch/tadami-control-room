# β0.3-01b 検証記録

2026-10-10、himekami 上のみで実施。tadami への接続・操作、実機 systemd の有効化、Docker daemon / 監視 Compose / 既存ネットワーク / SSH / WireGuard / UFW の変更、Xorg の導入は行っていない。

## 結果

| 検証 | 結果 |
| --- | --- |
| Python リレーテスト | 15件 PASS（実 socat の TCP 試験2件を含む） |
| 識別ポリシー | Compose project/service/oneoff、単一候補、稼働状態、network ID/label/bridge/internal/IPv4/subnet/endpoint を確認。停止・不正・空・複数候補・重複 IP を拒否 |
| 期限と障害 | 失効・未来・NaN等の時刻を拒否。Docker 不在/終了失敗/timeout の注入で失効を確認。root-owned file 検査、atomic 更新、危険な書込権限/symlink 拒否を確認 |
| 実 socat の動作 | `127.0.0.1:18080` だけの待受を /proc/net/tcp で確認。127.0.0.2 / IPv6 ::1 への接続拒否、転送先切替、既存接続切断、失効後の待受消失、復旧、親異常終了時の子プロセス停止を確認 |
| 権限分離 | root 実行拒否、固定 Docker socket/引数/環境/timeout、unit の UID・capability・AF_INET 制限・socket 不可視・read-only 設定をコード/静的テストで確認 |
| systemd / Python 構文 | systemd 255 の `systemd-analyze verify` は終了0、警告なし。Python AST と unit と同じ Python flags の import/起動拒否を確認 |
| Web / monitoring 構成 | `check:web` / `check:monitoring` PASS。Web への127.0.0.1を含む ports 再追加を拒否。API の接続・既存 monitoring の参照を維持 |
| TypeScript / ESLint | PASS |
| Vitest | 11ファイル、355件 PASS |
| 通常ビルド / モック画面 | PASS。画面E2E 13件、ビルド済み preview 1件 PASS |
| API 画面 / 本番配信 | API 画面5件、本番成果物3件 PASS。Web/API の既存動作・取得失敗からの復旧を維持 |
| 本番ビルド / 成果物検査 | PASS |
| 差分検査 | `git diff --check` PASS。`infra/monitoring/`、アプリ本体、依存と lockfile に差分なし |

実行環境は `/usr/bin/python3` 3.12.3、systemd 255.4-1ubuntu8.17、Node.js 22.23.2、socat 1.8.0.0（Ubuntu パッケージ 1.8.0.0-4ubuntu0.1）、既存 Playwright Chromium。追加の Python / npm ライブラリは不要。

```sh
SOCAT_BINARY=/tmp/tadami-relay-packages/root/usr/bin/socat npm run test:relay
LD_LIBRARY_PATH=/tmp/tadami-browser-libs/root/usr/lib/x86_64-linux-gnu npm run check
systemd-analyze verify infra/relay/tadami-web-relay.service infra/relay/tadami-web-relay-resolver.service
```

`npm run check` 全体は終了0。標準 PATH に socat がないため、その実行内では TCP 2件を明示的に skip し、上記 `SOCAT_BINARY` を指定した独立実行で15件すべてを検証した。

実 TCP 試験では、production の bind・fork・接続上限・期限を使い、転送先だけをローカルの127.0.0.2 / 127.0.0.3上の fixture に置換した。異なる bridge IP とコンテナ/network ID の入力に応じた socat 再生成を確認したもので、実 Docker bridge のIP変更試験ではない。Web/API ブラウザー試験もローカルの架空 Prometheus HTTP 応答であり、実 Prometheus 接続ではない。

## 検証中の修正・環境対応

- 最初の unit 起動経路の確認で Python `-I` が隣接する共有モジュールを import できないことを検出し、root 所有のスクリプトディレクトリを使う `-E -s -B` に修正した。環境変数・ユーザー site の無効化は維持した。
- 実 TCP テストの連続実行で TIME_WAIT が事前の空きポート検査に影響したため、検査ソケットにも SO_REUSEADDR を設定した。既存 listener がある場合は依然として失敗し、他プロセスを停止しない。
- sandbox のソケット作成/localhost 待受/子プロセス制限による EPERM は、許可された実行環境で再検証して解消した。
- socat と Chromium に不足する libnspr4 / libnss3 は Ubuntu のパッケージを `/tmp` に取得・展開しただけ。OS へインストールせず、ライブラリパスは検証プロセスに限定した。環境修正後のテストは成功した。

## ユーザー確認済みの前提

tadami の Docker `HostConfig.PortBindings` にlocalhost18080があるが実際の割当てはなく、Web 内部IP:8080へホストから接続すると200。手動 socat を使うと Web / Monitoring API とも200、himekami の SSH トンネル経由で Chrome に実データ表示できる。これらはユーザー提示の実測結果で、この作業から実機を再検証していない。

## 実機未検証

- 専用アカウント作成、実 Docker socket 所有権、systemd sandbox 内の実効権限・mount・seccomp・cgroup・AppArmor、およびホストから internal bridge への到達性。
- 実 Docker Engine 29.8.2 / Compose 5.6.0 の inspect データとCLI設定検証、Webだけの再作成、実IP変更、旧接続の解放と実データ再取得。
- systemd の実際のバックオフ・start-limit・enable/stop/PartOf、OS 再起動後の自動復旧、Docker の起動遅延からの復旧、長時間負荷・ログ保存量。
- 実機の systemd 版リレー経由の curl、LAN/WireGuard アドレスでの待受不在、SSHトンネルからの表示。

Docker CLI / daemon は himekami にないため、今回 Docker build / run / compose config を実行していない。Docker 不在・停止は query の失敗/timeout を注入して検証した。tadami の Docker daemon 停止試験は既存監視に影響するので配備手順にも含めていない。

通常3秒間隔の再照合には検出窓があり、IP再利用を瞬時に識別する保証はない。root helper の最終情報は12秒で失効するが、非特権プロセスの再照合・停止処理の時間も加わる。サービスが active でも有効な対象がない間は待受しない。この挙動・start-limit からの復旧・失敗時の手動 socat fallback は [配備・運用手順](localhost-relay.md) に記載した。

## 変更ファイル

- `infra/relay/relay_state.py`、`resolve.py`、`relay.py`：識別/期限付き状態、root補助処理、非特権socat監督。
- `infra/relay/tadami-web-relay.service`、`tadami-web-relay-resolver.service`、`tadami-web-relay.sysusers.conf`：systemd と専用ユーザー定義。
- `infra/web/compose.yaml`：web のホストポート公開を削除。
- `tests/relay/test_relay.py`、`tests/server/web-infrastructure.test.ts`、`tools/production/check-config.ts`、`package.json`：回帰防止と検証コマンド。
- `README.md`、`docs/localhost-relay.md`、この記録、`docs/production-web.md`、`docs/design.md`、`docs/directory-structure.md`、`docs/implementation-plan.md`：現行構成・配備・復旧・後続範囲を記載。
