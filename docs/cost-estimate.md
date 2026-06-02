# 本番月額コスト試算とコストガードレール (#13)

小嶺霊園CRM 本番環境（AWS / ap-northeast-1 Tokyo）の月額コスト試算、最適化シナリオ、
および AWS Budgets による予算アラート設定をまとめる。

- 換算: 1 USD = ¥150
- 利用想定: **スタッフ 3 名、業務時間のみ稼働**（平日 8:00–20:00 JST ≒ 60h/週 ≒ 36% uptime）
- 基準時点: PR #15（RDS Multi-AZ 化）マージ後の構成

> 数値は AWS 公開価格からの概算。実コストは AWS Budgets / Cost Explorer の実績で追跡し、
> 本ドキュメントと乖離が出たら更新する。

---

## 1. 現状（ベースライン）構成と内訳

| サービス | 構成 | 月額 USD |
|---|---|---:|
| RDS db.t4g.micro Multi-AZ + gp3 20GB | 24/7 | $34 |
| ECS Fargate Backend (0.25 vCPU / 512 MiB) | 24/7 × 1 task | $11 |
| ECS Fargate Frontend (同上) | 24/7 × 1 task | $11 |
| NAT Gateway × 1 | 24/7 | $46 |
| ALB × 2（backend + frontend） | 24/7 | $36 |
| CloudFront / S3 / ECR / Secrets / CloudWatch | 低トラフィック | $9 |
| **合計** | | **~$147 / ¥22K/月** |

コスト比率: **NAT 31% > ALB 24% > RDS 23% > Fargate 15% > その他 7%**

セキュリティ/監視を全部入りにした場合（WAF #9 / HTTPS #10 / 堅牢化 #11 / 監視 #12 / Multi-AZ #7）は
**~$180/月**。AWS Budgets の既定予算 `$200/月`（`monthlyCostBudgetUsd`）はこの全部入り構成に
安全マージンを乗せた値。

---

## 2. コスト最適化の効くレバー

| レバー | 月-削減 | 工数 | 備考 |
|---|---:|---|---|
| NAT Gateway スケジュール停止/再生成 | -$30〜45 | 大 | 業務時間のみ生成→破棄。VPC Endpoint 化は低トラフィックだと $40/月で逆転 |
| HA 緩和（Multi-AZ → Single-AZ + Stop/Start） | -$11〜25 | 中 | Multi-AZ は AWS 仕様で停止不可。Stop/Start 運用には Single-AZ 必須 |
| ALB 2個 → 1個に統合（path-based routing） | -$18 | 中 | CloudFront オリジン書き換えで対応可 |
| Fargate スケジュール scaling 0 ↔ 1 | -$13〜15 | 小 | EventBridge + ECS scheduled scaling。**業務時間外はアプリ停止**になる点に注意 |
| Aurora Serverless v2（min 0 ACU / auto-pause） | -$25〜30 | 大（移行） | アイドル時はストレージ料金のみ。DB 移行作業が重い |
| Savings Plans / RI（1年 No Upfront） | RDS/Fargate 分 -20〜30% | 小（購入） | 固定ワークロード分のみ。**前払い購入の意思決定が必要** |

---

## 3. シナリオ別月額試算

| シナリオ | RDS | Fargate | ALB | NAT | 月額 USD | 月額 JPY | 削減率 | 工数 | リスク |
|---|---|---|---|---|---:|---:|---:|---|---|
| **現状（PR #15 後）** | Multi-AZ 24/7 | 24/7 | 2個 | 24/7 | $147 | ¥22K | 基準 | - | - |
| **A: 低リスク最適化**（HA 維持） | Multi-AZ 24/7 | scheduled 36% | 1個 | 24/7 | $113 | ¥17K | -23% | 小 | ほぼ無 |
| **B: HA緩和 + 全スケジュール** | Single-AZ stop/start | scheduled 36% | 1個 | 24/7 | $79 | ¥12K | -46% | 中 | AZ障害時 数十分断 |
| **C: フル節約（NATもscheduled）** | Single-AZ stop/start | scheduled 36% | 1個 | scheduled 36% | **$50** | **¥7.5K** | **-66%** | 大 | NAT再生成時IP変動・運用増 |
| **D: Aurora Serverless v2** | ACU 0→1 自動 | scheduled 36% | 1個 | scheduled 36% | **$42** | **¥6.3K** | **-71%** | 大（移行） | コールドスタート数秒〜 |

### シナリオ B（バランス型）の内訳

```
RDS Single-AZ db.t4g.micro (Stop/Start)
  インスタンス: $14.60 × 0.36（停止時0）  = $5.3
  gp3 20GB: 停止中も課金                   = $2.3   小計 $7.6
Fargate (backend + frontend) scheduled
  $22.50 × 0.36                            = $8.1
ALB 統合 1個 24/7                          = $18.0
NAT Gateway 24/7                           = $45.3
CloudFront + S3 + ECR                      = $3
Secrets + CloudWatch Logs                  = $4
合計                                      ~$86 ≈ ¥13K
```

フル本番対応（WAF/HTTPS/堅牢化/監視/Multi-AZ 全部入り）で **~$180/月**、
最適化シナリオ C で **~$60/月**、その差 **月 $120（年 ¥21万）**。

---

## 4. コストガードレール（このリポで実装済み）

`lib/cost-stack.ts`（`KomineCostStack`）が AWS Budgets で月額コスト予算とアラートを設定する。

- **月額 COST 予算**: `config.monthlyCostBudgetUsd`（既定 `$200`）
- **通知**（`config.costAlertEmails` に 1 件以上のメールがあるとき）:
  - 実績 80% 超過 … 早期警告
  - 実績 100% 超過 … 予算超過
  - 予測 100% 到達 … このままだと月末に超過する見込み
- クレジット/返金は予算評価から除外（実請求額に近い値で判断）
- メール未設定時は**予算（コスト追跡）のみ**作成し通知は付けない
  （AWS Budgets は購読者 1 名以上が必須）。後から `costAlertEmails` を足せば有効化される。

### 有効化（通知を受け取る）手順

`lib/config.ts` の `prodConfig.costAlertEmails` に通知先を設定してデプロイするだけ:

```ts
costAlertEmails: ['ops@example.com'],
```

```bash
npx cdk diff KomineCostStack
npx cdk deploy KomineCostStack
```

> AWS Budgets 自体は account-level（全リージョン横断のコスト）リソース。stack のリージョンに依存しない。

---

## 5. 要 業務/運用判断（未実施・本 issue に残す項目）

以下は**コストと可用性/運用のトレードオフ判断が必要**なため、本 PR では実装せず方針決定待ち:

| 項目 | 必要な判断 | 効果の目安 |
|---|---|---|
| HA 方針（シナリオ A〜D の選択） | AZ 障害で数十分のサービス断を許容するか（Multi-AZ 維持 or Single-AZ + Stop/Start） | -$11〜25/月 |
| Fargate スケジュール scaling | **業務時間外（夜間・休日）にアプリを停止してよいか** | -$13〜15/月 |
| ALB 2個 → 1個 統合 | CloudFront オリジン書き換えのアーキ変更を許容するか | -$18/月 |
| Savings Plans / RI 購入 | 1 年コミットの前払い購入をするか | RDS/Fargate -20〜30% |
| RDS インスタンス right-size | 実負荷を見て `t4g.micro` 維持か変更か | 小 |

### 自動で実施しなかった理由

- いずれも「HA を犠牲にする」か「業務時間外のアプリ停止」「アーキ変更」「購入コミット」を伴い、
  業務側・運用側の合意が前提。`#13` の方針が確定したら実装 PR を起こす。
- 一方、**AWS Budgets 予算アラート**（§4）と**本試算ドキュメント**（§1–3）は HA に中立で
  業務判断不要のため先行投入した。

---

## 関連 issue

- `#7` Multi-AZ（PR #15）: シナリオ B/C/D 採用時は `prodConfig.dbMultiAz = false` 化が必要
- `#8` バックアップ強化: シナリオ D は Aurora が自動カバー
- `#9` WAF: +$8〜12/月 / `#10` HTTPS: ACM 無料 / `#11` 堅牢化: +$1〜2/月 / `#12` 監視: +$2〜3/月
- `#14` 本番化トラッキング（親）
