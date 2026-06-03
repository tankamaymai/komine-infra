import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './config';

export interface OffHoursSchedulerStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly databaseInstance: rds.IDatabaseInstance;
}

/**
 * Off-hours scheduler for RDS (#13 ②).
 *
 * 夜間・休日に RDS を自動停止し、業務開始前に起動してコストを削減する。
 * Fargate 側は各サービスの Application Auto Scaling scheduled action で 0 にスケールする
 * （backend-stack / frontend-stack）。RDS にはネイティブなスケジューラが無いため、
 * EventBridge Scheduler（timezone 対応）から軽量 Lambda を叩いて Start/Stop する。
 *
 * 設計判断:
 * - EC2 を持つ NAT インスタンス等と違い OS 保守が不要な Lambda を採用（保守レス優先）。
 * - Start/Stop API のパラメータ名（`DBInstanceIdentifier`）を SDK 経由で確実に渡すため、
 *   EventBridge Scheduler の universal target ではなく Lambda 経由にしている。
 * - Lambda は現在状態を確認してから操作する冪等実装（既に stopped/available なら skip）。
 *
 * スケジュール（`Asia/Tokyo`, 平日のみ。土日はそのまま停止）:
 * - RDS 起動: 業務開始 15 分前（startHourJst の前時:45）。RDS は起動に数分かかるため。
 * - RDS 停止: 業務終了 15 分後（endHourJst:15）。Fargate がドレインし接続が切れた後。
 *
 * ⚠️ Multi-AZ の RDS は AWS 仕様で停止できない。`dbMultiAz=true` のまま有効化すると
 *    停止が必ず失敗するため、synth 時にエラーで弾く。
 */
export class OffHoursSchedulerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OffHoursSchedulerStackProps) {
    super(scope, id, props);

    const { config, databaseInstance } = props;
    const offHours = config.offHoursSchedule;

    if (!offHours?.enabled) {
      // 無効時は何も作らない（24/7 稼働）。
      return;
    }

    if (config.dbMultiAz) {
      throw new Error(
        'offHoursSchedule.enabled=true は dbMultiAz=false（Single-AZ）が前提です。' +
          'Multi-AZ の RDS は停止できないため、両立できません。config.ts を確認してください。',
      );
    }

    const dbId = databaseInstance.instanceIdentifier;

    // === RDS Start/Stop Lambda ===
    const logGroup = new logs.LogGroup(this, 'SchedulerLogGroup', {
      logGroupName: '/aws/lambda/komine-crm-rds-scheduler',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'RdsSchedulerFn', {
      functionName: 'komine-crm-rds-scheduler',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      logGroup,
      environment: {
        DB_INSTANCE_IDENTIFIER: dbId,
      },
      // @aws-sdk/client-rds は Node.js 20 ランタイムに同梱されているため bundle 不要。
      code: lambda.Code.fromInline(`
const { RDSClient, StartDBInstanceCommand, StopDBInstanceCommand, DescribeDBInstancesCommand } = require('@aws-sdk/client-rds');
const client = new RDSClient({});
exports.handler = async (event) => {
  const id = process.env.DB_INSTANCE_IDENTIFIER;
  const action = event && event.action;
  const res = await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: id }));
  const status = res.DBInstances && res.DBInstances[0] && res.DBInstances[0].DBInstanceStatus;
  console.log('RDS scheduler', { id, action, status });
  if (action === 'start') {
    if (status === 'stopped') {
      await client.send(new StartDBInstanceCommand({ DBInstanceIdentifier: id }));
      return { started: id };
    }
    return { skipped: id, status, reason: 'not stopped' };
  }
  if (action === 'stop') {
    if (status === 'available') {
      await client.send(new StopDBInstanceCommand({ DBInstanceIdentifier: id }));
      return { stopped: id };
    }
    return { skipped: id, status, reason: 'not available' };
  }
  throw new Error('Unknown action: ' + action);
};
`),
    });

    // Start/Stop は対象 DB に限定。DescribeDBInstances はリソースレベル権限不可のため別 statement で *。
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rds:StartDBInstance', 'rds:StopDBInstance'],
        resources: [databaseInstance.instanceArn],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rds:DescribeDBInstances'],
        resources: ['*'],
      }),
    );

    // === EventBridge Scheduler ===
    // Scheduler が Lambda を invoke するための role。
    const schedulerRole = new iam.Role(this, 'SchedulerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Allows EventBridge Scheduler to invoke the RDS off-hours scheduler Lambda',
    });
    fn.grantInvoke(schedulerRole);

    // 業務開始 15 分前に起動（startHourJst の前時:45）/ 業務終了 15 分後に停止（endHourJst:15）。
    const startHour = (offHours.startHourJst + 23) % 24;
    const rdsStartCron = `cron(45 ${startHour} ? * MON-FRI *)`;
    const rdsStopCron = `cron(15 ${offHours.endHourJst} ? * MON-FRI *)`;

    new scheduler.CfnSchedule(this, 'RdsStartSchedule', {
      name: 'komine-crm-rds-start',
      description: 'Start RDS before business hours (weekdays)',
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: rdsStartCron,
      scheduleExpressionTimezone: cdk.TimeZone.ASIA_TOKYO.timezoneName,
      target: {
        arn: fn.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ action: 'start' }),
      },
    });

    new scheduler.CfnSchedule(this, 'RdsStopSchedule', {
      name: 'komine-crm-rds-stop',
      description: 'Stop RDS after business hours (weekdays); stays stopped over weekends',
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: rdsStopCron,
      scheduleExpressionTimezone: cdk.TimeZone.ASIA_TOKYO.timezoneName,
      target: {
        arn: fn.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ action: 'stop' }),
      },
    });

    new cdk.CfnOutput(this, 'RdsSchedulerFunctionName', {
      value: fn.functionName,
      description: 'RDS off-hours scheduler Lambda function name',
    });
  }
}
