import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  BackupStack,
  BackupSecondaryVaultStack,
  PRIMARY_BACKUP_VAULT_NAME,
  SECONDARY_BACKUP_VAULT_NAME,
} from '../lib/backup-stack';
import { EnvironmentConfig } from '../lib/config';

const testConfig: EnvironmentConfig = {
  account: '123456789012',
  region: 'ap-northeast-1',
  vpcCidr: '10.0.0.0/16',
  dbInstanceClass: 't4g.micro',
  dbAllocatedStorage: 20,
  dbMultiAz: true,
  dbBackupRetentionDays: 30,
  dbPreferredBackupWindow: '17:00-18:00',
  dbBackupCrossRegion: 'ap-northeast-3',
  dbBackupCrossRegionRetentionDays: 30,
  backendDesiredCount: 1,
  frontendDesiredCount: 1,
  monthlyCostBudgetUsd: 200,
  githubOwner: 'test-owner',
  githubRepos: { backend: 'test-backend', frontend: 'test-frontend' },
};

const crossRegionVaultArn = `arn:aws:backup:${testConfig.dbBackupCrossRegion}:${testConfig.account}:backup-vault:${SECONDARY_BACKUP_VAULT_NAME}`;

describe('BackupSecondaryVaultStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackupSecondaryVaultStack(app, 'TestSecondaryVaultStack', {
      env: { account: testConfig.account, region: testConfig.dbBackupCrossRegion! },
      vaultName: SECONDARY_BACKUP_VAULT_NAME,
    });
    template = Template.fromStack(stack);
  });

  test('creates a backup vault with the configured name', () => {
    template.resourceCountIs('AWS::Backup::BackupVault', 1);
    template.hasResourceProperties('AWS::Backup::BackupVault', {
      BackupVaultName: SECONDARY_BACKUP_VAULT_NAME,
    });
  });

  test('retains the vault on stack deletion', () => {
    template.hasResource('AWS::Backup::BackupVault', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('outputs the vault ARN', () => {
    template.hasOutput('SecondaryVaultArn', {});
  });
});

describe('BackupStack (cross-region copy enabled)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackupStack(app, 'TestBackupStack', {
      env: { account: testConfig.account, region: testConfig.region },
      config: testConfig,
      crossRegionVaultArn,
    });
    template = Template.fromStack(stack);
  });

  test('creates the primary backup vault', () => {
    template.resourceCountIs('AWS::Backup::BackupVault', 1);
    template.hasResourceProperties('AWS::Backup::BackupVault', {
      BackupVaultName: PRIMARY_BACKUP_VAULT_NAME,
    });
  });

  test('primary vault is retained on stack deletion', () => {
    template.hasResource('AWS::Backup::BackupVault', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('creates a backup plan with daily 30-day retention rule', () => {
    template.resourceCountIs('AWS::Backup::BackupPlan', 1);
    template.hasResourceProperties('AWS::Backup::BackupPlan', {
      BackupPlan: Match.objectLike({
        BackupPlanName: 'komine-crm-rds-daily',
        BackupPlanRule: Match.arrayWith([
          Match.objectLike({
            RuleName: 'daily-30day',
            ScheduleExpression: 'cron(30 17 * * ? *)',
            Lifecycle: Match.objectLike({ DeleteAfterDays: 30 }),
            StartWindowMinutes: 60,
            CompletionWindowMinutes: 120,
          }),
        ]),
      }),
    });
  });

  test('rule has a cross-region copy action to the secondary vault', () => {
    template.hasResourceProperties('AWS::Backup::BackupPlan', {
      BackupPlan: Match.objectLike({
        BackupPlanRule: Match.arrayWith([
          Match.objectLike({
            CopyActions: Match.arrayWith([
              Match.objectLike({
                DestinationBackupVaultArn: crossRegionVaultArn,
                Lifecycle: Match.objectLike({ DeleteAfterDays: 30 }),
              }),
            ]),
          }),
        ]),
      }),
    });
  });

  test('selection targets resources by the komine:backup tag', () => {
    template.resourceCountIs('AWS::Backup::BackupSelection', 1);
    template.hasResourceProperties('AWS::Backup::BackupSelection', {
      BackupSelection: Match.objectLike({
        SelectionName: 'komine-crm-rds-selection',
        ListOfTags: Match.arrayWith([
          Match.objectLike({
            ConditionType: 'STRINGEQUALS',
            ConditionKey: 'komine:backup',
            ConditionValue: 'rds-primary',
          }),
        ]),
      }),
    });
  });

  test('outputs primary vault and plan ARNs', () => {
    template.hasOutput('PrimaryVaultArn', {});
    template.hasOutput('BackupPlanArn', {});
  });
});

describe('BackupStack (cross-region copy disabled)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackupStack(app, 'TestBackupStackNoCopy', {
      env: { account: testConfig.account, region: testConfig.region },
      config: { ...testConfig, dbBackupCrossRegion: undefined },
      crossRegionVaultArn: undefined,
    });
    template = Template.fromStack(stack);
  });

  test('plan rule has no copy actions when cross-region vault is absent', () => {
    const resources = template.findResources('AWS::Backup::BackupPlan');
    const planKeys = Object.keys(resources);
    expect(planKeys).toHaveLength(1);
    const planProps = resources[planKeys[0]].Properties.BackupPlan;
    const rule = planProps.BackupPlanRule[0];
    expect(rule.CopyActions ?? []).toEqual([]);
  });
});

describe('BackupStack honors custom retention values', () => {
  test('respects dbBackupCrossRegionRetentionDays override', () => {
    const app = new cdk.App();
    const stack = new BackupStack(app, 'TestBackupStackCustomRetention', {
      env: { account: testConfig.account, region: testConfig.region },
      config: { ...testConfig, dbBackupCrossRegionRetentionDays: 90 },
      crossRegionVaultArn,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Backup::BackupPlan', {
      BackupPlan: Match.objectLike({
        BackupPlanRule: Match.arrayWith([
          Match.objectLike({
            CopyActions: Match.arrayWith([
              Match.objectLike({
                Lifecycle: Match.objectLike({ DeleteAfterDays: 90 }),
              }),
            ]),
          }),
        ]),
      }),
    });
  });
});
