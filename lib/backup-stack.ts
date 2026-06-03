import * as cdk from 'aws-cdk-lib/core';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './config';
import { BACKUP_SELECTION_TAG_KEY, BACKUP_SELECTION_TAG_VALUE } from './database-stack';

/** AWS Backup vault 名（プライマリ） */
export const PRIMARY_BACKUP_VAULT_NAME = 'komine-crm-backup-primary';
/** AWS Backup vault 名（クロスリージョン DR コピー先） */
export const SECONDARY_BACKUP_VAULT_NAME = 'komine-crm-backup-secondary';

export interface BackupSecondaryVaultStackProps extends cdk.StackProps {
  /** 受け側 vault 名（プライマリ stack から構築する ARN と一致させること） */
  readonly vaultName: string;
}

/**
 * クロスリージョン DR コピー先の AWS Backup vault のみを持つスタック。
 * プライマリリージョン外（例: ap-northeast-3 大阪）に配置する。
 *
 * このスタックには Plan/Selection を含めない（コピー先 vault としてのみ使用）。
 */
export class BackupSecondaryVaultStack extends cdk.Stack {
  public readonly backupVault: backup.BackupVault;

  constructor(scope: Construct, id: string, props: BackupSecondaryVaultStackProps) {
    super(scope, id, props);

    this.backupVault = new backup.BackupVault(this, 'Vault', {
      backupVaultName: props.vaultName,
      // DR バックアップ消失防止のため stack 削除後も保持
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'SecondaryVaultArn', {
      value: this.backupVault.backupVaultArn,
      description: 'Cross-region DR vault ARN (BackupStack の copyActions から参照)',
    });
  }
}

export interface BackupStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  /**
   * クロスリージョンコピー先 vault ARN。
   * config.dbBackupCrossRegion 未指定の場合は undefined を渡すこと（コピー無効化）。
   */
  readonly crossRegionVaultArn?: string;
}

/**
 * AWS Backup の本体スタック（プライマリリージョン）。
 *
 * 構成:
 * - プライマリ vault: `komine-crm-backup-primary`
 * - Backup plan: 毎日 17:30 UTC（JST 02:30）開始の日次バックアップ
 *   - プライマリ保持: config.dbBackupRetentionDays（本番 30 日）
 *   - クロスリージョンコピー: crossRegionVaultArn 指定時のみ有効
 * - Backup selection: `BACKUP_SELECTION_TAG_KEY = BACKUP_SELECTION_TAG_VALUE` タグを持つリソースを対象
 *
 * DatabaseStack 側で同タグを RDS インスタンスに付与しているので、
 * stack 間のリソース直接参照を作らずに疎結合で連携できる。
 */
export class BackupStack extends cdk.Stack {
  public readonly backupVault: backup.BackupVault;
  public readonly backupPlan: backup.BackupPlan;

  constructor(scope: Construct, id: string, props: BackupStackProps) {
    super(scope, id, props);

    const { config, crossRegionVaultArn } = props;

    this.backupVault = new backup.BackupVault(this, 'PrimaryVault', {
      backupVaultName: PRIMARY_BACKUP_VAULT_NAME,
      // 既存バックアップ消失防止のため stack 削除後も保持
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const copyActions: backup.BackupPlanCopyActionProps[] = crossRegionVaultArn
      ? [
          {
            destinationBackupVault: backup.BackupVault.fromBackupVaultArn(
              this,
              'CrossRegionVault',
              crossRegionVaultArn,
            ),
            deleteAfter: cdk.Duration.days(
              config.dbBackupCrossRegionRetentionDays ?? config.dbBackupRetentionDays,
            ),
          },
        ]
      : [];

    // #13 ②: offHoursSchedule 有効時は RDS が夜間・休日停止する。停止中スナップショットを
    // 避けるため、AWS Backup も DB 稼働中（平日業務時間内）に走らせる。
    // - 通常(24/7): RDS preferredBackupWindow (17:00-18:00 UTC = JST 02:00-03:00) 内で開始。
    // - offHours: JST 18:30（= 09:30 UTC）の平日に実行（RDS 自動バックアップ窓 18:00-18:30 の直後、
    //   RDS 停止 20:15 JST より前）。土日はデータ変更が無い（DB 停止）ので実行しない。
    const offHoursEnabled = config.offHoursSchedule?.enabled ?? false;
    const backupSchedule = offHoursEnabled
      ? events.Schedule.cron({ minute: '30', hour: '9', weekDay: 'MON-FRI' })
      : events.Schedule.cron({ minute: '30', hour: '17', day: '*', month: '*', year: '*' });

    this.backupPlan = new backup.BackupPlan(this, 'Plan', {
      backupPlanName: 'komine-crm-rds-daily',
      backupVault: this.backupVault,
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: 'daily-30day',
          scheduleExpression: backupSchedule,
          // 想定遅延 1h、想定完了 2h
          startWindow: cdk.Duration.hours(1),
          completionWindow: cdk.Duration.hours(2),
          deleteAfter: cdk.Duration.days(config.dbBackupRetentionDays),
          copyActions,
        }),
      ],
    });

    this.backupPlan.addSelection('RdsSelection', {
      backupSelectionName: 'komine-crm-rds-selection',
      resources: [
        backup.BackupResource.fromTag(BACKUP_SELECTION_TAG_KEY, BACKUP_SELECTION_TAG_VALUE),
      ],
    });

    new cdk.CfnOutput(this, 'PrimaryVaultArn', {
      value: this.backupVault.backupVaultArn,
      description: 'Primary AWS Backup vault ARN',
    });

    new cdk.CfnOutput(this, 'BackupPlanArn', {
      value: this.backupPlan.backupPlanArn,
      description: 'AWS Backup plan ARN',
    });
  }
}
