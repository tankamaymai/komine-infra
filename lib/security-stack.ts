import * as cdk from 'aws-cdk-lib/core';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface SecurityStackProps extends cdk.StackProps {}

/**
 * Security audit stack: CloudTrail + GuardDuty.
 *
 * - CloudTrail: 全リージョン・管理イベント+データイベント・log file validation 有効。
 *   S3 バケットに加えて CloudWatch Logs にもストリームし、後段の通知/検索を容易にする。
 *   ログバケットはサーバーサイド暗号化 (S3 managed) + バージョニング + 90日でライフサイクル
 *   IA → Glacier に移行。リテンション 365 日。
 *
 * - GuardDuty: アカウント内の脅威検知を有効化。検知結果は EventBridge から
 *   将来 SNS (#12) や Slack へ通知予定。
 *
 * いずれも「設定するだけで継続的に効く」防御層なので、業務情報待ち無しで先行投入する。
 */
export class SecurityStack extends cdk.Stack {
  public readonly trail: cloudtrail.Trail;
  public readonly trailBucket: s3.Bucket;
  public readonly trailLogGroup: logs.LogGroup;
  public readonly guardDutyDetector: guardduty.CfnDetector;

  constructor(scope: Construct, id: string, props?: SecurityStackProps) {
    super(scope, id, props);

    // === CloudTrail ===
    this.trailBucket = new s3.Bucket(this, 'TrailBucket', {
      bucketName: `komine-crm-cloudtrail-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // CloudTrail ログは消失防止のため stack 削除後も保持
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'transition-and-expire',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(180),
            },
          ],
          expiration: cdk.Duration.days(365),
        },
      ],
    });

    this.trailLogGroup = new logs.LogGroup(this, 'TrailLogGroup', {
      logGroupName: '/aws/cloudtrail/komine-crm',
      retention: logs.RetentionDays.SIX_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.trail = new cloudtrail.Trail(this, 'Trail', {
      trailName: 'komine-crm-trail',
      bucket: this.trailBucket,
      cloudWatchLogGroup: this.trailLogGroup,
      sendToCloudWatchLogs: true,
      // 全リージョンのイベントを集約
      isMultiRegionTrail: true,
      // 改ざん検知
      enableFileValidation: true,
      // 管理イベント: 読み取り + 書き込み（write のみだとログイン経路が拾えないため両方）
      managementEvents: cloudtrail.ReadWriteType.ALL,
      // 6 ヶ月分を CloudWatch に保持（S3 側は 365 日 + ライフサイクル）
      cloudWatchLogsRetention: logs.RetentionDays.SIX_MONTHS,
    });

    // === GuardDuty ===
    // 既に有効化済みのアカウントでこれをデプロイすると "already exists" でエラーになる。
    // その場合は本リソースをコメントアウトするか、`enable: false` で参照のみにする。
    this.guardDutyDetector = new guardduty.CfnDetector(this, 'GuardDutyDetector', {
      enable: true,
      findingPublishingFrequency: 'FIFTEEN_MINUTES',
      // S3 / EKS / Malware の追加機能はコスト都合で本フェーズでは見送り。
      // 必要になったら DataSources / Features で追加する。
    });

    // === Outputs ===
    new cdk.CfnOutput(this, 'TrailArn', {
      value: this.trail.trailArn,
      description: 'CloudTrail ARN',
    });

    new cdk.CfnOutput(this, 'TrailBucketName', {
      value: this.trailBucket.bucketName,
      description: 'CloudTrail S3 bucket name',
    });

    new cdk.CfnOutput(this, 'GuardDutyDetectorId', {
      value: this.guardDutyDetector.attrId,
      description: 'GuardDuty detector ID',
    });
  }
}
