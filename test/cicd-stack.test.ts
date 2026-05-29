import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CicdStack } from '../lib/cicd-stack';
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
  githubOwner: 'test-owner',
  githubRepos: { backend: 'test-backend', frontend: 'test-frontend' },
};

describe('CicdStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const env = { account: testConfig.account, region: testConfig.region };

    const stack = new CicdStack(app, 'TestCicdStack', {
      env,
      config: testConfig,
      backendEcrArn: 'arn:aws:ecr:ap-northeast-1:123456789012:repository/komine-crm-backend',
      frontendEcrArn: 'arn:aws:ecr:ap-northeast-1:123456789012:repository/komine-crm-frontend',
      ecsClusterArn: 'arn:aws:ecs:ap-northeast-1:123456789012:cluster/komine-crm-cluster',
      backendServiceArn: 'arn:aws:ecs:ap-northeast-1:123456789012:service/komine-crm-cluster/komine-crm-backend',
      frontendServiceArn: 'arn:aws:ecs:ap-northeast-1:123456789012:service/komine-crm-cluster/komine-crm-frontend',
      cloudFrontDistributionArn: 'arn:aws:cloudfront::123456789012:distribution/E1234567890',
      backendTaskRoleArn: 'arn:aws:iam::123456789012:role/komine-backend-task-role',
      backendExecutionRoleArn: 'arn:aws:iam::123456789012:role/komine-backend-execution-role',
      frontendTaskRoleArn: 'arn:aws:iam::123456789012:role/komine-frontend-task-role',
      frontendExecutionRoleArn: 'arn:aws:iam::123456789012:role/komine-frontend-execution-role',
    });
    template = Template.fromStack(stack);
  });

  test('creates a GitHub OIDC provider', () => {
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
  });

  test('creates a deploy IAM role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'komine-crm-github-actions-deploy',
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Effect: 'Allow',
            Condition: Match.objectLike({
              StringLike: Match.objectLike({
                'token.actions.githubusercontent.com:sub': Match.arrayWith([
                  'repo:test-owner/test-backend:ref:refs/heads/main',
                  'repo:test-owner/test-frontend:ref:refs/heads/main',
                ]),
              }),
            }),
          }),
        ]),
      }),
    });
  });

  test('deploy role has ECR authorization permission', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'EcrAuth',
            Effect: 'Allow',
            Action: 'ecr:GetAuthorizationToken',
            Resource: '*',
          }),
        ]),
      }),
    });
  });

  test('deploy role has ECR push permissions scoped to repositories', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'EcrPush',
            Effect: 'Allow',
            Action: Match.arrayWith([
              'ecr:PutImage',
              'ecr:InitiateLayerUpload',
            ]),
            Resource: Match.arrayWith([
              'arn:aws:ecr:ap-northeast-1:123456789012:repository/komine-crm-backend',
              'arn:aws:ecr:ap-northeast-1:123456789012:repository/komine-crm-frontend',
            ]),
          }),
        ]),
      }),
    });
  });

  test('deploy role has ECS UpdateService scoped to specific service ARNs', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'EcsUpdateService',
            Effect: 'Allow',
            Action: Match.arrayWith(['ecs:UpdateService', 'ecs:DescribeServices']),
            Resource: Match.arrayWith([
              'arn:aws:ecs:ap-northeast-1:123456789012:service/komine-crm-cluster/komine-crm-backend',
              'arn:aws:ecs:ap-northeast-1:123456789012:service/komine-crm-cluster/komine-crm-frontend',
            ]),
          }),
        ]),
      }),
    });
  });

  test('deploy role keeps wildcard for ECS task definition management (AWS limitation)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'EcsTaskDefinitionManagement',
            Effect: 'Allow',
            Action: Match.arrayWith(['ecs:RegisterTaskDefinition', 'ecs:DeregisterTaskDefinition']),
            Resource: '*',
          }),
        ]),
      }),
    });
  });

  test('deploy role has ECS ListTasks/DescribeTasks scoped by cluster condition', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'EcsListAndDescribeTasks',
            Effect: 'Allow',
            Action: Match.arrayWith(['ecs:ListTasks', 'ecs:DescribeTasks']),
            Condition: Match.objectLike({
              ArnEquals: {
                'ecs:cluster': 'arn:aws:ecs:ap-northeast-1:123456789012:cluster/komine-crm-cluster',
              },
            }),
          }),
        ]),
      }),
    });
  });

  test('deploy role has ECS RunTask permission scoped to cluster', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'EcsRunTask',
            Effect: 'Allow',
            Action: 'ecs:RunTask',
            Condition: Match.objectLike({
              ArnEquals: {
                'ecs:cluster': 'arn:aws:ecs:ap-northeast-1:123456789012:cluster/komine-crm-cluster',
              },
            }),
          }),
        ]),
      }),
    });
  });

  test('deploy role has CloudFront invalidation permission', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'CloudFrontInvalidation',
            Effect: 'Allow',
            Action: Match.arrayWith([
              'cloudfront:CreateInvalidation',
            ]),
            Resource: 'arn:aws:cloudfront::123456789012:distribution/E1234567890',
          }),
        ]),
      }),
    });
  });

  test('deploy role has IAM PassRole scoped to the 4 ECS task/execution role ARNs', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'PassRole',
            Effect: 'Allow',
            Action: 'iam:PassRole',
            Resource: Match.arrayWith([
              'arn:aws:iam::123456789012:role/komine-backend-task-role',
              'arn:aws:iam::123456789012:role/komine-backend-execution-role',
              'arn:aws:iam::123456789012:role/komine-frontend-task-role',
              'arn:aws:iam::123456789012:role/komine-frontend-execution-role',
            ]),
            Condition: Match.objectLike({
              StringEquals: {
                'iam:PassedToService': 'ecs-tasks.amazonaws.com',
              },
            }),
          }),
        ]),
      }),
    });
  });

  test('ELB waiter is scoped narrowly (DescribeTargetHealth only)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'ElbWaiter',
            Effect: 'Allow',
            Action: 'elasticloadbalancing:DescribeTargetHealth',
          }),
        ]),
      }),
    });
  });

  test('exports deploy role ARN', () => {
    template.hasOutput('DeployRoleArn', {
      Export: { Name: 'KomineCrm-DeployRoleArn' },
    });
  });
});
