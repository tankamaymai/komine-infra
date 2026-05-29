import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface SecretsRotationStackProps extends cdk.StackProps {
  /** RDS が属する VPC (rotation lambda の配置先) */
  readonly vpc: ec2.IVpc;
  /**
   * Rotation lambda 用 SG。VpcStack 側で作成済みのもの。
   * VpcStack で DB SG への ingress (5432) も先行追加済みのため、
   * 本 stack 内では SG 操作を一切行わない（VpcStack → DatabaseStack の
   * 循環参照を避けるため）。
   */
  readonly secretsRotationSecurityGroup: ec2.ISecurityGroup;
  /** DatabaseStack で生成された DB credentials secret */
  readonly databaseSecret: secretsmanager.ISecret;
  /**
   * RDS DB instance identifier。SecretRotation の target に渡す。
   * AttachmentTargetType.RDS_DB_INSTANCE と組み合わせて lambda に DB 接続情報を伝える。
   */
  readonly databaseInstanceIdentifier: string;
}

/**
 * Secrets Manager 自動ローテーション専用 stack (#18)。
 *
 * **設計上の都合**:
 * `DatabaseInstance.addRotationSingleUser` を使うと、内部で
 * `target.connections.allowDefaultPortFrom(rotationLambda)` を呼ぶ。
 * これは DB SG (VpcStack 所属) に rotation lambda SG (DatabaseStack 所属)
 * からの ingress を追加し、port は DBInstance.Endpoint.Port (DatabaseStack の token)
 * を参照する。結果として VpcStack → DatabaseStack の参照が生まれ、既存の
 * DatabaseStack → VpcStack と合わせて **循環参照** になる。
 *
 * 解決策: lower-level な `SecretRotation` 構築 + ingress 追加を別場所へ。
 * - rotation lambda 用 SG は VpcStack で先行作成 (PR #17)
 * - DB SG → rotation SG の ingress (5432) も VpcStack で先行追加 (PR #17)
 * - 本 stack では SG 操作を行わず SecretRotation のみ構築
 * - target は DB instance identifier だけ提供（lambda は secret 内の host/port を読む）
 *
 * 30 日サイクル。ローテーション中のダウンタイムなし（single-user 方式）。
 */
export class SecretsRotationStack extends cdk.Stack {
  public readonly rotation: secretsmanager.SecretRotation;

  constructor(scope: Construct, id: string, props: SecretsRotationStackProps) {
    super(scope, id, props);

    const {
      vpc,
      secretsRotationSecurityGroup,
      databaseSecret,
      databaseInstanceIdentifier,
    } = props;

    // **循環参照対策 1**: `SecretRotation` は内部で
    // `target.connections.allowDefaultPortFrom(rotationLambdaSg)` を呼ぶ。実 DB instance を
    // target にすると DB SG (VpcStack) に rotation lambda SG からの ingress が追加され、
    // port が DBInstance.Endpoint.Port (DatabaseStack) 参照になって循環参照。
    // → 空 SG リストを持つ IConnectable で no-op 化する（ingress は VpcStack 側で
    //   PR #17 にて先行追加済み）。
    const noopTarget: ec2.IConnectable = {
      connections: new ec2.Connections({
        securityGroups: [],
        defaultPort: ec2.Port.tcp(5432),
      }),
    };

    // **循環参照対策 2**: `secret.addRotationSchedule` は secret の **所属 stack** に
    // RotationSchedule を配置する。databaseSecret は DatabaseStack 所属なので、
    // そのまま渡すと DatabaseStack に RotationSchedule が作られて、本 stack の
    // rotation lambda ARN を参照 → DatabaseStack → SecretsRotationStack の cycle。
    // → secret を ARN で **import** することで「本 stack 所属の参照」に変える。
    //   RotationSchedule は本 stack に配置され、lambda ARN は同一 stack 内で完結する。
    const importedSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedDbSecret',
      databaseSecret.secretArn,
    );

    this.rotation = new secretsmanager.SecretRotation(this, 'DbRotation', {
      secret: importedSecret,
      application: secretsmanager.SecretRotationApplication.POSTGRES_ROTATION_SINGLE_USER,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: secretsRotationSecurityGroup,
      automaticallyAfter: cdk.Duration.days(30),
      target: noopTarget,
    });

    new cdk.CfnOutput(this, 'RotatedSecretArn', {
      value: databaseSecret.secretArn,
      description: 'Secret ARN that has rotation enabled',
    });

    new cdk.CfnOutput(this, 'RotatedDatabaseInstanceId', {
      value: databaseInstanceIdentifier,
      description: 'DB instance identifier the rotated secret is attached to',
    });
  }
}
