# ディレクトリ構造

## 現在作成するファイル

```text
tadami-control-room/
├── README.md
└── docs/
    ├── design.md
    ├── directory-structure.md
    └── implementation-plan.md
```

以下は今後の実装先を示す設計であり、空のディレクトリや設定ファイルは今回作成しない。

## モック版の実装予定

```text
tadami-control-room/
├── README.md
├── docs/
├── package.json
├── package-lock.json
├── index.html
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── playwright.config.ts
├── eslint.config.js
├── .gitignore
├── public/
│   └── favicon.svg
├── src/
│   ├── main.tsx
│   ├── app/
│   │   ├── App.tsx
│   │   └── create-provider.ts
│   ├── config/
│   │   ├── monitoring.ts          # 更新間隔、閾値、対象ホストの表示設定
│   │   └── mock-targets.ts        # 架空の監視対象。実機の一覧と混同しない
│   ├── domain/
│   │   ├── monitoring.ts          # Snapshot、Observation などの共通型
│   │   ├── health.ts              # 個別・総合判定、鮮度判定
│   │   ├── metrics.ts             # 容量や使用率の計算
│   │   └── validation.ts          # Provider 境界での値の検証
│   ├── data/
│   │   ├── monitoring-provider.ts # 取得インターフェース
│   │   └── mock/
│   │       ├── mock-provider.ts
│   │       ├── fixtures.ts
│   │       ├── scenarios.ts
│   │       └── seeded-random.ts
│   ├── features/
│   │   └── dashboard/
│   │       ├── Dashboard.tsx
│   │       ├── use-monitoring.ts  # 取得・取消・更新・最終成功値の保持
│   │       ├── CpuPanel.tsx
│   │       ├── MemoryPanel.tsx
│   │       ├── StoragePanel.tsx
│   │       ├── UptimePanel.tsx
│   │       ├── ServicesPanel.tsx
│   │       └── MockScenarioControl.tsx
│   ├── components/
│   │   ├── ConsoleHeader.tsx
│   │   ├── ConsoleFooter.tsx
│   │   ├── Panel.tsx
│   │   ├── StatusLabel.tsx
│   │   ├── DataQualityNotice.tsx
│   │   └── TrendChart.tsx
│   ├── lib/
│   │   ├── format.ts              # 日本語日時、%、GiB、稼働時間
│   │   └── clock.ts               # モックとテストで差し替える時計
│   └── styles/
│       ├── tokens.css
│       ├── base.css
│       ├── layout.css
│       └── components.css
└── tests/
    ├── unit/                     # 計算、判定、鮮度、モックの整合性
    ├── integration/              # 取得失敗・遅延・復旧、更新の取消
    └── e2e/                      # 画面寸法、操作、モック表示の確認
```

小規模な単一アプリとして開始し、モノレポ管理ツールは導入しない。設定ファイルは実際のツール導入時に必要なものだけ作る。npm を初期案とし、依存関係をロックする。

## 実データ接続時の追加予定

```text
src/data/api/
└── api-provider.ts               # 同一オリジン API → 共通 Snapshot
server/
├── index.ts                      # 読み取り専用 API の起動
├── config.ts                     # サーバー側の接続設定・監視対象
├── routes/
│   └── monitoring.ts             # GET /api/monitoring/snapshot
└── prometheus/
    ├── client.ts                 # HTTP、タイムアウト、応答検証
    ├── queries.ts                # 許可した固定クエリのみ
    └── mapper.ts                 # 系列・ラベルから Snapshot へ変換
tests/contract/
└── monitoring-api.test.ts
.env.example                      # 値を含まない設定項目の説明
docs/operations.md                # 合意済みの配備・復旧手順
```

`server/` のコードや秘密情報をフロントエンドから import しない。API の型は `src/domain/` の環境非依存部分を共有し、実データ接続が確定した時点で必要なら `shared/` に移す。

依存方向は `画面 → 取得フック → Provider インターフェース` とする。MockProvider と ApiProvider の選択は `app/create-provider.ts` で行い、各パネルでモード分岐しない。判定・計算・書式処理は React に依存させず、テスト可能な関数として分離する。

Prometheus、Grafana、systemd、リバースプロキシなどの実機設定は、初期リポジトリに複製・新設しない。後続で必要になった場合も実機構成を確認した変更案として扱う。
