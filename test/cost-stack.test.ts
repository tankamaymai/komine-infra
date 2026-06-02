import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CostStack } from '../lib/cost-stack';
import { EnvironmentConfig } from '../lib/config';

const baseConfig: EnvironmentConfig = {
  account: '123456789012',
  region: 'ap-northeast-1',
  vpcCidr: '10.0.0.0/16',
  dbInstanceClass: 't4g.micro',
  dbAllocatedStorage: 20,
  dbMultiAz: true,
  dbBackupRetentionDays: 30,
  dbPreferredBackupWindow: '17:00-18:00',
  backendDesiredCount: 1,
  frontendDesiredCount: 1,
  monthlyCostBudgetUsd: 200,
  githubOwner: 'test-owner',
  githubRepos: { backend: 'test-backend', frontend: 'test-frontend' },
};

const env = { account: '123456789012', region: 'ap-northeast-1' };

describe('CostStack', () => {
  describe('with alert emails configured', () => {
    let template: Template;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new CostStack(app, 'TestCostStack', {
        env,
        config: { ...baseConfig, costAlertEmails: ['ops@example.com', 'admin@example.com'] },
      });
      template = Template.fromStack(stack);
    });

    test('creates a single monthly COST budget with the configured USD limit', () => {
      template.resourceCountIs('AWS::Budgets::Budget', 1);
      template.hasResourceProperties('AWS::Budgets::Budget', {
        Budget: Match.objectLike({
          BudgetName: 'komine-crm-monthly-cost',
          BudgetType: 'COST',
          TimeUnit: 'MONTHLY',
          BudgetLimit: Match.objectLike({ Amount: 200, Unit: 'USD' }),
        }),
      });
    });

    test('excludes credits and refunds from the budget evaluation', () => {
      template.hasResourceProperties('AWS::Budgets::Budget', {
        Budget: Match.objectLike({
          CostTypes: Match.objectLike({ IncludeCredit: false, IncludeRefund: false }),
        }),
      });
    });

    test('configures 80% actual, 100% actual, and 100% forecasted notifications', () => {
      template.hasResourceProperties('AWS::Budgets::Budget', {
        NotificationsWithSubscribers: Match.arrayWith([
          Match.objectLike({
            Notification: Match.objectLike({
              NotificationType: 'ACTUAL',
              ComparisonOperator: 'GREATER_THAN',
              Threshold: 80,
              ThresholdType: 'PERCENTAGE',
            }),
          }),
          Match.objectLike({
            Notification: Match.objectLike({
              NotificationType: 'ACTUAL',
              Threshold: 100,
            }),
          }),
          Match.objectLike({
            Notification: Match.objectLike({
              NotificationType: 'FORECASTED',
              Threshold: 100,
            }),
          }),
        ]),
      });
    });

    test('attaches all configured emails as subscribers to each notification', () => {
      template.hasResourceProperties('AWS::Budgets::Budget', {
        NotificationsWithSubscribers: Match.arrayWith([
          Match.objectLike({
            Subscribers: Match.arrayWith([
              Match.objectLike({ SubscriptionType: 'EMAIL', Address: 'ops@example.com' }),
              Match.objectLike({ SubscriptionType: 'EMAIL', Address: 'admin@example.com' }),
            ]),
          }),
        ]),
      });
    });

    test('reports the subscriber count via output', () => {
      template.hasOutput('CostAlertSubscriberCount', {
        Value: '2',
      });
    });
  });

  describe('without alert emails (tracking only)', () => {
    let template: Template;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new CostStack(app, 'TestCostStackNoEmail', {
        env,
        config: { ...baseConfig, costAlertEmails: [] },
      });
      template = Template.fromStack(stack);
    });

    test('still creates the budget for cost tracking', () => {
      template.resourceCountIs('AWS::Budgets::Budget', 1);
      template.hasResourceProperties('AWS::Budgets::Budget', {
        Budget: Match.objectLike({ BudgetName: 'komine-crm-monthly-cost' }),
      });
    });

    test('does not attach any notifications (AWS requires >=1 subscriber)', () => {
      template.hasResourceProperties('AWS::Budgets::Budget', {
        NotificationsWithSubscribers: Match.absent(),
      });
    });

    test('reports zero subscribers via output', () => {
      template.hasOutput('CostAlertSubscriberCount', { Value: '0' });
    });
  });

  test('treats undefined costAlertEmails the same as empty (tracking only)', () => {
    const app = new cdk.App();
    const { costAlertEmails: _omit, ...configWithoutEmails } = baseConfig;
    const stack = new CostStack(app, 'TestCostStackUndefEmail', {
      env,
      config: configWithoutEmails,
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Budgets::Budget', 1);
    template.hasResourceProperties('AWS::Budgets::Budget', {
      NotificationsWithSubscribers: Match.absent(),
    });
  });

  test('honors a custom budget limit', () => {
    const app = new cdk.App();
    const stack = new CostStack(app, 'TestCostStackCustomLimit', {
      env,
      config: { ...baseConfig, monthlyCostBudgetUsd: 60 },
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: Match.objectLike({ Amount: 60 }) }),
    });
    template.hasOutput('MonthlyBudgetLimitUsd', { Value: '60' });
  });
});
