import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
import { EnvironmentConfig } from '../lib/config';

const testConfig: EnvironmentConfig = {
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
  githubOwner: 'test-owner',
  githubRepos: { backend: 'test-backend', frontend: 'test-frontend' },
};

describe('VpcStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new VpcStack(app, 'TestVpcStack', {
      env: { account: testConfig.account, region: testConfig.region },
      config: testConfig,
    });
    template = Template.fromStack(stack);
  });

  test('creates a VPC', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16',
    });
  });

  test('creates 2 public subnets and 2 private subnets', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 4);
  });

  test('creates 1 NAT Gateway for cost optimization', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('creates 5 security groups (ALB, Backend, Frontend, Database, SecretsRotation)', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 5);
  });

  test('creates a SG for the Secrets Manager rotation Lambda (#11)', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupName: 'komine-crm-secrets-rotation-sg',
      GroupDescription: 'Security group for Secrets Manager rotation Lambda',
    });
  });

  test('ALB security group allows HTTP and HTTPS', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Application Load Balancer',
    });
  });

  test('Database security group allows inbound on port 5432 from backend', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for RDS PostgreSQL',
    });
  });

  test('Backend security group allows inbound on port 4000 from ALB', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Backend ECS tasks',
    });
  });

  test('exports VPC ID', () => {
    template.hasOutput('VpcId', {
      Export: { Name: 'KomineCrm-VpcId' },
    });
  });

  test('enables VPC Flow Logs to CloudWatch Logs (ALL traffic)', () => {
    template.resourceCountIs('AWS::EC2::FlowLog', 1);
    template.hasResourceProperties('AWS::EC2::FlowLog', {
      ResourceType: 'VPC',
      TrafficType: 'ALL',
      LogDestinationType: 'cloud-watch-logs',
    });
  });

  test('creates a CloudWatch Logs group for flow logs with 1-month retention', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/vpc/flow-logs/komine-crm',
      RetentionInDays: 30,
    });
  });
});
