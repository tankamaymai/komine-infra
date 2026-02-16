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
  backendDesiredCount: 1,
  frontendDesiredCount: 1,
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

    const stack = new DatabaseStack(app, 'TestDatabaseStack', {
      env,
      config: testConfig,
      vpc,
      databaseSecurityGroup: sg,
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
      MultiAZ: false,
      DeletionProtection: true,
      StorageEncrypted: true,
      BackupRetentionPeriod: 7,
      DBName: 'komine_cemetery_crm',
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

  test('outputs database endpoint and port', () => {
    template.hasOutput('DatabaseEndpoint', {});
    template.hasOutput('DatabasePort', {});
  });
});
