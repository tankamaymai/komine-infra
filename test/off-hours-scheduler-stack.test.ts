import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as rds from 'aws-cdk-lib/aws-rds';
import { OffHoursSchedulerStack } from '../lib/off-hours-scheduler-stack';
import { EnvironmentConfig } from '../lib/config';

const env = { account: '123456789012', region: 'ap-northeast-1' };

const baseConfig: EnvironmentConfig = {
  account: '123456789012',
  region: 'ap-northeast-1',
  vpcCidr: '10.0.0.0/16',
  dbInstanceClass: 't4g.micro',
  dbAllocatedStorage: 20,
  dbMultiAz: false,
  dbBackupRetentionDays: 30,
  dbPreferredBackupWindow: '17:00-18:00',
  backendDesiredCount: 1,
  frontendDesiredCount: 1,
  monthlyCostBudgetUsd: 200,
  offHoursSchedule: { enabled: true, startHourJst: 8, endHourJst: 20 },
  githubOwner: 'test-owner',
  githubRepos: { backend: 'test-backend', frontend: 'test-frontend' },
};

/** Build an imported RDS instance to feed the scheduler stack. */
function makeDbInstance(scope: cdk.Stack): rds.IDatabaseInstance {
  return rds.DatabaseInstance.fromDatabaseInstanceAttributes(scope, 'Db', {
    instanceIdentifier: 'komine-crm-db',
    instanceEndpointAddress: 'db.example.com',
    port: 5432,
    securityGroups: [],
  });
}

describe('OffHoursSchedulerStack', () => {
  describe('enabled (Single-AZ)', () => {
    let template: Template;

    beforeAll(() => {
      const app = new cdk.App();
      const ref = new cdk.Stack(app, 'Ref', { env });
      const stack = new OffHoursSchedulerStack(app, 'TestOffHours', {
        env,
        config: baseConfig,
        databaseInstance: makeDbInstance(ref),
      });
      template = Template.fromStack(stack);
    });

    test('creates a Node.js 20 Lambda with the DB identifier in env', () => {
      template.resourceCountIs('AWS::Lambda::Function', 1);
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'komine-crm-rds-scheduler',
        Runtime: 'nodejs20.x',
        Environment: Match.objectLike({
          Variables: Match.objectLike({ DB_INSTANCE_IDENTIFIER: 'komine-crm-db' }),
        }),
      });
    });

    test('grants start/stop scoped to the DB and describe on *', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ['rds:StartDBInstance', 'rds:StopDBInstance'],
              // 対象 DB の ARN にスコープ（partition は Ref で解決される）
              Resource: {
                'Fn::Join': [
                  '',
                  ['arn:', { Ref: 'AWS::Partition' }, ':rds:ap-northeast-1:123456789012:db:komine-crm-db'],
                ],
              },
            }),
            Match.objectLike({
              Action: 'rds:DescribeDBInstances',
              Resource: '*',
            }),
          ]),
        }),
      });
    });

    test('creates start and stop schedules in Asia/Tokyo with correct crons', () => {
      template.resourceCountIs('AWS::Scheduler::Schedule', 2);
      // 起動: 業務開始(08:00)の15分前 = 07:45 JST 平日
      template.hasResourceProperties('AWS::Scheduler::Schedule', {
        Name: 'komine-crm-rds-start',
        ScheduleExpression: 'cron(45 7 ? * MON-FRI *)',
        ScheduleExpressionTimezone: 'Asia/Tokyo',
        FlexibleTimeWindow: { Mode: 'OFF' },
        Target: Match.objectLike({ Input: '{"action":"start"}' }),
      });
      // 停止: 業務終了(20:00)の15分後 = 20:15 JST 平日
      template.hasResourceProperties('AWS::Scheduler::Schedule', {
        Name: 'komine-crm-rds-stop',
        ScheduleExpression: 'cron(15 20 ? * MON-FRI *)',
        ScheduleExpressionTimezone: 'Asia/Tokyo',
        Target: Match.objectLike({ Input: '{"action":"stop"}' }),
      });
    });

    test('the scheduler invoke role is assumed by EventBridge Scheduler', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'sts:AssumeRole',
              Principal: Match.objectLike({ Service: 'scheduler.amazonaws.com' }),
            }),
          ]),
        }),
      });
    });
  });

  test('derives cron times from a custom business window', () => {
    const app = new cdk.App();
    const ref = new cdk.Stack(app, 'Ref', { env });
    const stack = new OffHoursSchedulerStack(app, 'TestOffHoursCustom', {
      env,
      config: { ...baseConfig, offHoursSchedule: { enabled: true, startHourJst: 9, endHourJst: 18 } },
      databaseInstance: makeDbInstance(ref),
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'komine-crm-rds-start',
      ScheduleExpression: 'cron(45 8 ? * MON-FRI *)',
    });
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'komine-crm-rds-stop',
      ScheduleExpression: 'cron(15 18 ? * MON-FRI *)',
    });
  });

  test('creates nothing when offHoursSchedule is disabled', () => {
    const app = new cdk.App();
    const ref = new cdk.Stack(app, 'Ref', { env });
    const stack = new OffHoursSchedulerStack(app, 'TestOffHoursDisabled', {
      env,
      config: { ...baseConfig, offHoursSchedule: { enabled: false, startHourJst: 8, endHourJst: 20 } },
      databaseInstance: makeDbInstance(ref),
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Lambda::Function', 0);
    template.resourceCountIs('AWS::Scheduler::Schedule', 0);
  });

  test('throws when enabled together with Multi-AZ (cannot stop a Multi-AZ RDS)', () => {
    const app = new cdk.App();
    const ref = new cdk.Stack(app, 'Ref', { env });
    expect(
      () =>
        new OffHoursSchedulerStack(app, 'TestOffHoursMultiAz', {
          env,
          config: { ...baseConfig, dbMultiAz: true },
          databaseInstance: makeDbInstance(ref),
        }),
    ).toThrow(/Single-AZ/);
  });
});
