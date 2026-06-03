import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './config';

/**
 * Tag key used by AWS Backup selection to pick up the RDS instance.
 * BackupStack の BackupSelection と必ず一致させること。
 */
export const BACKUP_SELECTION_TAG_KEY = 'komine:backup';
export const BACKUP_SELECTION_TAG_VALUE = 'rds-primary';

export interface DatabaseStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly databaseSecurityGroup: ec2.ISecurityGroup;
  /**
   * VpcStack 側で作成した Secrets Manager rotation Lambda 用 SG (#11)。
   * stack 間の循環依存を避けるため呼び出し側で受け取る。
   */
  readonly secretsRotationSecurityGroup?: ec2.ISecurityGroup;
}

/**
 * Database Stack for Komine Cemetery CRM.
 *
 * Creates:
 * - RDS PostgreSQL 16 instance (Private Subnet)
 * - Secrets Manager secret for DB credentials
 * - SSM Parameter for DATABASE_URL (used by Prisma)
 */
export class DatabaseStack extends cdk.Stack {
  public readonly databaseInstance: rds.DatabaseInstance;
  public readonly databaseSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const { config, vpc, databaseSecurityGroup, secretsRotationSecurityGroup } = props;

    // #13 ②: offHoursSchedule 有効時は RDS が夜間・休日停止するため、停止中に当たる
    // バックアップ/メンテ窓では処理が走らない（自動バックアップもメンテも skip/defer）。
    // 窓を業務時間内（DB 稼働中）へ寄せる。日中は変更が業務時間内のみ発生するので、
    // 業務終了直前にバックアップを取れば PITR 上も十分。
    const offHoursEnabled = config.offHoursSchedule?.enabled ?? false;
    // 自動バックアップ窓（UTC, 30 分以上）。通常は config.dbPreferredBackupWindow（JST 02:00-03:00）。
    // 停止運用時は JST 18:00-18:30（= 09:00-09:30 UTC、業務終了前で DB 稼働中）。
    const backupWindow = offHoursEnabled ? '09:00-09:30' : config.dbPreferredBackupWindow;
    // メンテ窓（UTC）。通常は月 03:00-04:00 JST。停止運用時は月 13:00-14:00 JST
    // （= mon:04:00-mon:05:00 UTC、平日業務時間内で DB 稼働中）。backup 窓と非重複。
    const maintenanceWindow = offHoursEnabled ? 'mon:04:00-mon:05:00' : 'sun:18:00-sun:19:00';

    // Subnet group for RDS (Private Subnets)
    const subnetGroup = new rds.SubnetGroup(this, 'SubnetGroup', {
      vpc,
      description: 'Subnet group for Komine CRM RDS',
      subnetGroupName: 'komine-crm-db-subnet-group',
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // RDS PostgreSQL instance
    this.databaseInstance = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: new ec2.InstanceType(config.dbInstanceClass),
      vpc,
      subnetGroup,
      securityGroups: [databaseSecurityGroup],
      databaseName: 'komine_cemetery_crm',
      credentials: rds.Credentials.fromGeneratedSecret('komine_admin', {
        secretName: 'komine-crm/database-credentials',
      }),
      allocatedStorage: config.dbAllocatedStorage,
      maxAllocatedStorage: config.dbAllocatedStorage * 2,
      storageType: rds.StorageType.GP3,
      // #13 ②: Single-AZ（config.dbMultiAz=false）。RDS を停止可能にして夜間・休日の
      // 自動停止でコストを削減する。元の HA 最優先（Multi-AZ）方針は #7。
      multiAz: config.dbMultiAz,
      // メンテナンス窓（UTC）。offHours 運用時は DB 稼働中（業務時間内）の窓に切替。
      // 通常: sun:18:00-19:00 UTC = 月 03:00-04:00 JST。offHours: mon:04:00-05:00 UTC = 月 13:00-14:00 JST。
      preferredMaintenanceWindow: maintenanceWindow,
      // #8: バックアップ強化。
      // - 保持: config.dbBackupRetentionDays（本番 30 日）。PITR もこの期間内で可能。
      // - window: 通常は config.dbPreferredBackupWindow（JST 02:00-03:00）。offHours 運用時は
      //   DB 稼働中の JST 18:00-18:30 に切替（停止中だと自動バックアップが走らないため）。
      // - copyTagsToSnapshot: AWS Backup の tag-based 選択と整合させるため true。
      // - deleteAutomatedBackups: false にして instance 削除後も保持期間中は復旧可能に。
      backupRetention: cdk.Duration.days(config.dbBackupRetentionDays),
      preferredBackupWindow: backupWindow,
      copyTagsToSnapshot: true,
      deleteAutomatedBackups: false,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      storageEncrypted: true,
      monitoringInterval: cdk.Duration.seconds(60),
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      parameterGroup: new rds.ParameterGroup(this, 'ParameterGroup', {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_16,
        }),
        parameters: {
          'log_statement': 'ddl',
          'log_min_duration_statement': '1000',
        },
      }),
    });

    this.databaseSecret = this.databaseInstance.secret!;

    // AWS Backup の tag-based 選択用タグ（BackupStack の BackupSelection と整合）
    cdk.Tags.of(this.databaseInstance).add(BACKUP_SELECTION_TAG_KEY, BACKUP_SELECTION_TAG_VALUE);

    // Secrets Manager 自動ローテーションは **`SecretsRotationStack` で別 stack 化** (#18)。
    //
    // ここに `addRotationSingleUser` を置くと、内部で
    // `target.connections.allowDefaultPortFrom(rotationLambda)` が呼ばれて
    // DB SG (VpcStack) に DB port (DatabaseStack の token) 参照の ingress が追加され、
    // VpcStack ↔ DatabaseStack の循環参照になる。
    // SecretsRotationStack 側で secret を ARN import し、RotationSchedule を本 stack
    // 外に配置することで cycle を回避している。
    //
    // 受け側プロパティ (secretsRotationSecurityGroup) は VpcStack ↔ SecretsRotationStack
    // 連携用で本 stack では使わない。
    void secretsRotationSecurityGroup;

    // Outputs
    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: this.databaseInstance.dbInstanceEndpointAddress,
      description: 'RDS endpoint address',
    });

    new cdk.CfnOutput(this, 'DatabasePort', {
      value: this.databaseInstance.dbInstanceEndpointPort,
      description: 'RDS endpoint port',
    });

    new cdk.CfnOutput(this, 'DatabaseSecretArn', {
      value: this.databaseSecret.secretArn,
      description: 'ARN of the database credentials secret',
      exportName: 'KomineCrm-DatabaseSecretArn',
    });

    new cdk.CfnOutput(this, 'DatabaseInstanceArn', {
      value: this.databaseInstance.instanceArn,
      description: 'ARN of the RDS instance (AWS Backup selection で使用)',
      exportName: 'KomineCrm-DatabaseInstanceArn',
    });
  }
}
