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

## 5. 最適化レバーの意思決定状況

業務担当の判断を得て、シナリオ **C 寄り**（HA 緩和 + 全スケジュール停止 + ALB 統合）で進める。
判断と実装状況は以下のとおり:

| レバー | 判断 | 状態 | 効果の目安 |
|---|---|---|---|
| ① HA 方針（Single-AZ 化） | **Single-AZ 採用**（AZ 障害時の一時停止を許容） | ✅ 実装（`dbMultiAz=false`） | -$17/月 |
| ② 夜間・休日の自動停止（Fargate + RDS） | **停止する**（業務時間外はアプリ・DB を落とす） | ✅ 実装（`offHoursSchedule`） | -$15〜24/月 |
| ③ ALB 2個 → 1個 統合 | **統合する**（クローズド運用で影響低） | ✅ 実装（共有 ALB + path ルーティング） | -$18/月 |
| NAT コスト削減 | **検討中**（NAT インスタンスは EC2 保守を嫌い保留） | ⏳ 保留 | -$30〜40/月 |
| Savings Plans / RI 購入 | スケジュール停止で稼働が減るため**不要寄り** | — 見送り | RDS/Fargate -20〜30% |
| RDS インスタンス right-size | 本番メトリクス取得後に評価 | ⏳ 後日 | 小 |

### ②の実装メモ（夜間・休日停止）

- **Fargate**: backend/frontend の ECS Application Auto Scaling scheduled action で、
  平日 `8:00 JST` に 1〜3 タスク、`20:00 JST` に 0 タスク（`Asia/Tokyo` 指定）。
  金曜 20:00 に 0 → 土日そのまま → 月曜 8:00 に復帰。
- **RDS**: `KomineOffHoursSchedulerStack`（EventBridge Scheduler + 軽量 Lambda）で
  平日 `7:45 JST` 起動 / `20:15 JST` 停止。RDS は起動に数分かかるため業務開始の少し前に起こす。
  保守レス優先で EC2 ではなく Lambda を採用。
- **Single-AZ 必須**: Multi-AZ の RDS は停止できないため、`dbMultiAz=true` と
  `offHoursSchedule.enabled=true` は両立しない（scheduler stack が synth 時にエラーで弾く）。
- **バックアップ/メンテ窓の移動**: 停止中は自動バックアップ・メンテが走らないため、
  `offHoursSchedule` 有効時は窓を業務時間内（DB 稼働中）へ寄せる:
  - RDS 自動バックアップ: JST 02:00-03:00 → **18:00-18:30**（業務終了前）
  - RDS メンテ: 月 03:00-04:00 JST → **月 13:00-14:00 JST**（平日業務時間内）
  - AWS Backup（#8）: 02:30 JST 毎日 → **18:30 JST 平日のみ**（DB 稼働中・データ変更後）
  > データは業務時間内のみ変化するので、終業前にバックアップを取れば PITR 上も十分。
- **既知の相互作用**: Secrets Manager の DB 認証情報ローテーション（#18, 30日周期）が
  夜間に走ると DB 停止中で失敗しうるが、リトライで次の稼働時間に成功する。問題が出れば
  ローテーション時刻を業務時間内に固定する。

### ③の実装メモ（ALB 統合）

- BackendStack の ALB（`komine-crm-alb`）を共有 ALB とし、専用の frontend ALB は廃止。
- 共有リスナー（HTTP:80）のルーティング:
  - `/api/*`（priority 10）・`/api-docs*`（priority 20）→ backend TG（BackendStack）
  - `/*`（priority 100, catch-all）→ frontend TG（FrontendStack が共有リスナーへ追加）
- CloudFront はオリジン 1 個（共有 ALB）に簡素化。`/api` の振り分けは ALB 側で行う。
  静的アセット（`/_next/static/*`）のみエッジキャッシュを維持。
- 可用性は不変（ALB は AWS 内部で複数 AZ 冗長）。クローズド運用で共有による影響は低。

### 残・保留

- **NAT** は NAT インスタンス（fck-nat, 月$3〜4・固定IP）が最有力だが、EC2 の OS 保守を
  避けたいとの方針で保留。NAT GW の IP は外向き送信元専用で、ユーザーの名前解決には無関係
  （現状 IP 固定に依存する外部連携も無し）。再開時は別 issue で扱う。

---

## 関連 issue

- `#7` Multi-AZ（PR #15）: #13 ① で方針見直し → `dbMultiAz=false`（Single-AZ）に変更
- `#8` バックアップ強化: #13 ② の停止運用に合わせて窓を業務時間内へ移動
- `#9` WAF: +$8〜12/月 / `#10` HTTPS: ACM 無料 / `#11` 堅牢化: +$1〜2/月 / `#12` 監視: +$2〜3/月
- `#14` 本番化トラッキング（親）
