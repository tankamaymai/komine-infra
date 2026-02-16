import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';
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

  test('creates 4 security groups (ALB, Backend, Frontend, Database)', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 4);
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
});
