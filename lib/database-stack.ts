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

    const { config, vpc, databaseSecurityGroup } = props;

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
      // #7: HA 最優先方針。config.dbMultiAz で切替可だが本番は常に true。
      multiAz: config.dbMultiAz,
      // メンテナンス窓は UTC 指定。`sun:18:00-sun:19:00 UTC` = 月曜 03:00-04:00 JST
      // （霊園の業務時間外・最オフピーク帯）。
      preferredMaintenanceWindow: 'sun:18:00-sun:19:00',
      // #8: バックアップ強化。
      // - 保持: config.dbBackupRetentionDays（本番 30 日）。PITR もこの期間内で可能。
      // - window: config.dbPreferredBackupWindow（17:00-18:00 UTC = JST 02:00-03:00）。
      //   maintenance 窓 (sun:18:00-sun:19:00 UTC) と非重複に設定。
      // - copyTagsToSnapshot: AWS Backup の tag-based 選択と整合させるため true。
      // - deleteAutomatedBackups: false にして instance 削除後も保持期間中は復旧可能に。
      backupRetention: cdk.Duration.days(config.dbBackupRetentionDays),
      preferredBackupWindow: config.dbPreferredBackupWindow,
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
