# RDS 復旧 Runbook

最終更新: 2026-05-29 / 対象: 本番 RDS `komine-crm` (PostgreSQL 16, ap-northeast-1)

このドキュメントは **DB が壊れた / 誤更新で過去状態に戻したい / リージョン障害で大阪に逃がしたい** ような場合の復旧手順をまとめたもの。issue #8 受け入れ条件「Runbook 通りに復元できること」の対象。

---

## 1. バックアップ構成サマリ

| 種別 | 場所 | 保持 | 起動契機 |
|---|---|---|---|
| RDS 自動バックアップ (PITR 可能) | ap-northeast-1 | 30 日 | 毎日 17:00-18:00 UTC (JST 02:00-03:00) 自動 |
| AWS Backup（プライマリ） | ap-northeast-1 vault `komine-crm-backup-primary` | 30 日 | 毎日 17:30 UTC 自動 |
| AWS Backup（クロスリージョンコピー） | ap-northeast-3 vault `komine-crm-backup-secondary` | 30 日 | プライマリ完了後コピー |
| 手動スナップショット | ap-northeast-1 | 無期限（手動削除まで） | 大規模変更前にオペが手動取得 |

- **PITR**: RDS 自動バックアップ有効中は、過去 30 日内の **任意秒** に復元可能（実装は **新規 RDS インスタンス**として復元）。
- **AWS Backup**: tag `komine:backup=rds-primary` を付けたリソースを Backup Plan が自動拾い。CDK 側で `DatabaseStack` がこのタグを付与。
- **手動スナップショット**: PR デプロイ前 / migration 前など、後悔したくないタイミングで取得しておくと事故時間が短縮される。

---

## 2. シナリオ別 復旧手順

### シナリオ A: 誤更新で過去状態に戻したい（同リージョン PITR）

> 例: 朝 10:00 (JST) に一括 UPDATE を流して大量の契約レコードを壊した。9:30 時点の状態に戻したい。

1. **書込を止める**（ECS backend service を停止 or 0 task に scale）。
   ```bash
   aws ecs update-service \
     --cluster komine-crm-cluster \
     --service komine-crm-backend \
     --desired-count 0
   ```
2. **PITR で新規インスタンスに復元**（既存 instance はそのまま残す）。
   - コンソール: RDS → 自動バックアップ → 該当 DB → "ポイントインタイムへ復元"
   - or CLI:
     ```bash
     aws rds restore-db-instance-to-point-in-time \
       --source-db-instance-identifier <ORIGINAL_ID> \
       --target-db-instance-identifier komine-crm-pitr-<YYYYMMDD-HHMM> \
       --restore-time 2026-MM-DDT00:30:00Z \
       --db-subnet-group-name komine-crm-db-subnet-group \
       --vpc-security-group-ids <SG_ID> \
       --no-publicly-accessible \
       --multi-az
     ```
3. 復元 instance の **endpoint と admin パスワード** を取得（admin の resetは別途必要なら `modify-db-instance --master-user-password`）。
4. 業務影響範囲を確認した上で **切替方針** を決定（次のどちらか）:
   - **(a) 復元 instance を本番に昇格**: 既存 instance を rename → 復元 instance を旧名に rename → Secrets Manager の host 値はそのまま再利用（rename で endpoint が継承される構成にしておく）
   - **(b) 必要レコードだけ pg_dump で差分復元**: 復元 instance から該当 table のみ COPY → 既存 instance に反映
5. ECS backend を再起動して整合性確認。
6. 復旧完了後、**復元元の不要 instance は手動スナップショット取ったうえで削除**。
7. issue 化: 原因分析と再発防止策（migration の dry-run 強化、危険 SQL の review プロセスなど）。

### シナリオ B: AWS Backup の最新コピーから新規復元（同リージョン）

> 例: PITR でも回復しないが、AWS Backup vault に直近のスナップショットがある。

1. AWS Backup コンソール → Vaults → `komine-crm-backup-primary` → 該当 recovery point を選択。
2. "Restore" → resource type RDS → 新 DB identifier を指定して復元。
3. 以下シナリオ A の手順 3 以降と同じ。

### シナリオ C: リージョン全停止 → ap-northeast-3 (大阪) で復旧

> 例: ap-northeast-1 が広域障害。大阪に逃がす。

1. ap-northeast-3 にスイッチ:
   ```bash
   export AWS_REGION=ap-northeast-3
   ```
2. AWS Backup コンソール → Vaults → `komine-crm-backup-secondary` → 最新 recovery point を確認（毎日コピーされている）。
3. RDS を **ap-northeast-3 内** で復元（subnet group/security group は事前に大阪側で用意しておく必要あり。**現状は未整備**）。
4. アプリ層（ECS backend / frontend）も ap-northeast-3 で立ち上げる必要があるが、これも **現状は未整備**。
5. **長期的には**: 別 issue（フォロー予定）で「大阪 warm standby」を整備する。本 Runbook の現スコープは "**バックアップが残っていること** と **マニュアルで復元できること** の保証" まで。

> ⚠️ シナリオ C は現状 **バックアップは残るが即時切替不可**。RTO ≒ 半日〜1日想定。完全な DR が必要なら別 issue 化。

### シナリオ D: instance ごと消えた / 削除した

1. RDS の **deletionProtection は有効** なので、コンソール / API での削除は基本的に弾かれる。
2. それでも消えた場合: 自動バックアップは `deleteAutomatedBackups: false` 設定で **instance 削除後も保持** されているはず。
3. RDS → 自動バックアップ → 該当 DB（"deleted" 表示）→ 復元。

---

## 3. 復元後の Secrets / ECS 設定差し替え

旧 instance を本番として残し、復元 instance を **別 endpoint で運用継続** する場合に必要。

1. 新 instance の endpoint / admin password を控える。
2. Secrets Manager `komine-crm/database-credentials` の値を更新:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id komine-crm/database-credentials \
     --secret-string '{"username":"komine_admin","password":"<NEW>","engine":"postgres","host":"<NEW_ENDPOINT>","port":5432,"dbname":"komine_cemetery_crm","dbInstanceIdentifier":"<NEW_ID>"}'
   ```
3. ECS backend service を force new deployment して新 secret を読み込ませる:
   ```bash
   aws ecs update-service \
     --cluster komine-crm-cluster \
     --service komine-crm-backend \
     --force-new-deployment
   ```
4. backend のヘルスチェック / `/health` で疎通確認。
5. frontend からログイン → 基本的な CRUD（区画一覧 / 詳細表示）を実機で確認。

---

## 4. 定期リハーサル

issue #8 受け入れ条件として **一度は実際に復元してアプリ稼働確認** が必要。

- 目標: 復元時間 **2 時間以内**、データ整合性 OK。
- 実施タイミング案: 四半期に 1 回（業務閑散期）。
- リハーサル手順:
  1. 当日朝の AWS Backup recovery point から **新規 instance** に復元（既存本番には触れない）。
  2. 別の Secrets を作成し、検証用 ECS service を 1 task だけ立ち上げ。
  3. 検証用 frontend から疎通 / 主要画面の表示確認。
  4. 完了後、検証用 ECS service と復元 instance を削除（手動スナップショット 1 件残してOK）。
  5. 所要時間と引っかかった点を本 Runbook に追記。

---

## 5. 関連リソース

- CDK: `lib/database-stack.ts`（自動バックアップ設定）, `lib/backup-stack.ts`（AWS Backup vault/plan）
- AWS マネジメントコンソール:
  - RDS: <https://ap-northeast-1.console.aws.amazon.com/rds/home>
  - AWS Backup: <https://ap-northeast-1.console.aws.amazon.com/backup/home>
- 関連 issue: zaitsu82/komine-infra #7 (Multi-AZ), #8 (本件), #14 (Tracking)
