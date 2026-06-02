import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DatabaseStack } from '../lib/database-stack';
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

describe('DatabaseStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const env = { account: testConfig.account, region: testConfig.region };

    // Create a VPC for testing
    const vpcStack = new cdk.Stack(app, 'TestVpcStack', { env });
    const vpc = new ec2.Vpc(vpcStack, 'Vpc', { maxAzs: 2 });
    const sg = new ec2.SecurityGroup(vpcStack, 'DbSg', {
      vpc,
      description: 'Test DB SG',
    });
    const rotationSg = new ec2.SecurityGroup(vpcStack, 'RotationSg', {
      vpc,
      description: 'Test rotation SG',
    });

    const stack = new DatabaseStack(app, 'TestDatabaseStack', {
      env,
      config: testConfig,
      vpc,
      databaseSecurityGroup: sg,
      secretsRotationSecurityGroup: rotationSg,
    });
    template = Template.fromStack(stack);
  });

  test('creates an RDS PostgreSQL instance', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      DBInstanceClass: 'db.t4g.micro',
      AllocatedStorage: '20',
      StorageType: 'gp3',
      MultiAZ: true,
      DeletionProtection: true,
      StorageEncrypted: true,
      BackupRetentionPeriod: 30,
      DBName: 'komine_cemetery_crm',
      PreferredMaintenanceWindow: 'sun:18:00-sun:19:00',
      PreferredBackupWindow: '17:00-18:00',
      CopyTagsToSnapshot: true,
      DeleteAutomatedBackups: false,
    });
  });

  test('applies the AWS Backup selection tag to the RDS instance', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Tags: Match.arrayWith([
        Match.objectLike({ Key: 'komine:backup', Value: 'rds-primary' }),
      ]),
    });
  });

  test('honors dbMultiAz=false when explicitly disabled', () => {
    const app = new cdk.App();
    const env = { account: testConfig.account, region: testConfig.region };
    const vpcStack = new cdk.Stack(app, 'AltVpcStack', { env });
    const vpc = new ec2.Vpc(vpcStack, 'Vpc', { maxAzs: 2 });
    const sg = new ec2.SecurityGroup(vpcStack, 'DbSg', { vpc, description: 'Test DB SG' });
    const rotationSg = new ec2.SecurityGroup(vpcStack, 'RotationSg', {
      vpc,
      description: 'Test rotation SG',
    });

    const stack = new DatabaseStack(app, 'AltDatabaseStack', {
      env,
      config: { ...testConfig, dbMultiAz: false },
      vpc,
      databaseSecurityGroup: sg,
      secretsRotationSecurityGroup: rotationSg,
    });
    const altTemplate = Template.fromStack(stack);
    altTemplate.hasResourceProperties('AWS::RDS::DBInstance', {
      MultiAZ: false,
    });
  });

  test('creates a DB subnet group in private subnets', () => {
    template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
    template.hasResourceProperties('AWS::RDS::DBSubnetGroup', {
      DBSubnetGroupName: 'komine-crm-db-subnet-group',
    });
  });

  test('creates a Secrets Manager secret for credentials', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'komine-crm/database-credentials',
      GenerateSecretString: Match.objectLike({
        SecretStringTemplate: '{"username":"komine_admin"}',
        GenerateStringKey: 'password',
        ExcludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\',
      }),
    });
  });

  test('enables Performance Insights', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      EnablePerformanceInsights: true,
    });
  });

  test('sets max allocated storage for auto-scaling', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      MaxAllocatedStorage: 40,
    });
  });

  test('creates a parameter group with logging settings', () => {
    template.resourceCountIs('AWS::RDS::DBParameterGroup', 1);
    template.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Family: Match.stringLikeRegexp('postgres16'),
      Parameters: Match.objectLike({
        log_statement: 'ddl',
        log_min_duration_statement: '1000',
      }),
    });
  });

  test('exports database secret ARN', () => {
    template.hasOutput('DatabaseSecretArn', {
      Export: { Name: 'KomineCrm-DatabaseSecretArn' },
    });
  });

  test('exports database instance ARN for AWS Backup integration', () => {
    template.hasOutput('DatabaseInstanceArn', {
      Export: { Name: 'KomineCrm-DatabaseInstanceArn' },
    });
  });

  test('outputs database endpoint and port', () => {
    template.hasOutput('DatabaseEndpoint', {});
    template.hasOutput('DatabasePort', {});
  });

  test('Secrets Manager rotation lives in SecretsRotationStack, not here', () => {
    // 循環参照を避けるため RotationSchedule は SecretsRotationStack に配置される (#18)。
    // DatabaseStack 側には作らない。詳細は lib/secrets-rotation-stack.ts のコメント参照。
    template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 0);
  });

  test('honors a custom backup retention / window from config', () => {
    const app = new cdk.App();
    const env = { account: testConfig.account, region: testConfig.region };
    const vpcStack = new cdk.Stack(app, 'AltBackupVpcStack', { env });
    const vpc = new ec2.Vpc(vpcStack, 'Vpc', { maxAzs: 2 });
    const sg = new ec2.SecurityGroup(vpcStack, 'DbSg', { vpc, description: 'Test DB SG' });

    const stack = new DatabaseStack(app, 'AltBackupDatabaseStack', {
      env,
      config: {
        ...testConfig,
        dbBackupRetentionDays: 14,
        dbPreferredBackupWindow: '18:00-19:00',
      },
      vpc,
      databaseSecurityGroup: sg,
    });
    const altTemplate = Template.fromStack(stack);
    altTemplate.hasResourceProperties('AWS::RDS::DBInstance', {
      BackupRetentionPeriod: 14,
      PreferredBackupWindow: '18:00-19:00',
    });
  });
});
