# β0.2 作業用 PC 検証記録

2026-10-08〜09（JST）。実機接続・本番配備の記録ではない。

## 実施結果

| 検査 | 結果 |
| --- | --- |
| `npm run check:monitoring` | 成功。ポート非公開・内部通信・最小権限・イメージ固定・保持設定 |
| Compose 2.40.3 `config --quiet` | 成功。PC 内の架空パスによる構成展開のみ。デーモン未使用 |
| 保存先未設定での Compose 検査 | 必須環境変数エラーで拒否することを確認 |
| promtool 3.13.4 `check config` | 成功。公式リリースの SHA-256 を照合した単体バイナリーで実行 |
| `npm run typecheck` | 成功 |
| `npm run lint` | 成功、警告なし |
| `npm test` | 8 ファイル / 115 件成功。うち監視基盤の静的安全検査は 14 件 |
| `npm run build` | 成功。既定のモックモード |
| API モードの別ビルド | 成功。サーバー用のダミー URL / token と固定 PromQL が静的出力に含まれないことを確認 |
| `npm run test:e2e` | モック版 13 件成功 |
| `npm run test:preview` | ビルド済みモック版 1 件成功 |
| `npm run test:api` | API 接続版 5 件成功。実 Prometheus の代わりに PC 内の HTTP 応答フィクスチャを使用 |

Vitest では固定クエリー、ラベルのエスケープ、CPU / メモリ / FS / 稼働時間の変換、NaN / 欠損 / 重複 / 未来時刻、履歴欠損、上流障害と取消、認証情報の秘匿、任意クエリー・書込みメソッドの拒否、Provider の明示選択を検証した。安全検査では ports / host network / host PID / privileged / root user / capability / writable host mount / 管理 API / 外部 scrape 等の変更を拒否した。

実ブラウザーで fetch の呼び出し時の問題を検出し修正。修正後、実データモードの初回失敗→成功→取得失敗時の前回値保持→復旧、フィクスチャサーバーの誤接続拒否が成功した。失敗時もモックへ自動切替しない。

API フィクスチャの画面は 1280×1024 / 1280×900 / 390×844、モック版はこれに 320×740 / 768×1024 / 640×512 / 200% 拡大を加えて確認。CPU / メモリの履歴、5 パネル、常時データ種別表示、横はみ出し防止を検証し、1280×900 とスマートフォンの API 画面キャプチャも目視確認した。axe の対象検査では違反なし。

## 実行環境と範囲

Node.js 22.23.2 / npm 10.9.8、Chromium（Playwright）。不足するブラウザー共有ライブラリは PC の `/tmp` に展開したものを使用し、OS や tadami の設定は変更していない。HTTP とブラウザー検査は PC の loopback に一時サーバーを起動して実施。通常の sandbox では loopback listen が拒否されたため、許可された実行環境で再実行した。

Compose / promtool は `/tmp` の単体バイナリーで **構文検査のみ**。Docker デーモンへの操作、コンテナの pull / 起動、ホストメトリクス収集、実機接続はしていない。イメージのダイジェスト確認は公開 Quay レジストリの読み取りだけ。

スクリーンショットとレポートは `test-results/` / `playwright-report/`、API ビルド検証出力は `artifacts/api-build/`。いずれも Git 管理対象外。秘密情報は使わず、ビルド漏洩検査の値もダミー。

## 残る確認

- tadami の Docker / Compose / kernel、rootless / userns-remap / hidepid / AppArmor、各ホストマウントが子まで ro か。
- OS 用 NVMe 上の専用保存パス、空き容量、権限、実 FS の device / mountpoint / fstype。未マウント RAID は FS 使用量にしない。
- 実 Prometheus のクエリー実行、CPU 4 系列、約 31 GiB のメモリ、稼働時間、md0 の RAID メトリクス、scrape / timeout / 鮮度閾値の妥当性。
- LAN / 外部からの 9090 / 9100 非到達、既存 SSH / WireGuard / Eternal Terminal への影響がないこと。
- サービス状態の計測方式、RAID を表示する API / UI 契約、通知・Grafana・本番 API のアクセス制御と配備。
- バックアップ保存先と復元演習。7 日 / 1GB 保持は WAL 等を含む厳密なディスククォータではない。
- 実機画面、他ブラウザー、実時間での長時間試運転。モックの 1 時間試験は仮想時計による検証。
