import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './config';

export interface CicdStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly backendEcrArn: string;
  readonly frontendEcrArn: string;
  readonly ecsClusterArn: string;
  readonly backendServiceArn: string;
  readonly frontendServiceArn: string;
  readonly cloudFrontDistributionArn: string;
  /**
   * #11: iam:PassRole を ECS で使う 4 つの role に限定するため CicdStack に渡す。
   * Backend/Frontend stack の `taskRole` / `executionRole` ARN。
   */
  readonly backendTaskRoleArn: string;
  readonly backendExecutionRoleArn: string;
  readonly frontendTaskRoleArn: string;
  readonly frontendExecutionRoleArn: string;
}

/**
 * CI/CD Stack for Komine Cemetery CRM.
 *
 * Creates:
 * - GitHub Actions OIDC Provider
 * - IAM Role for GitHub Actions deploy (backend + frontend)
 * - Scoped permissions for ECR, ECS, CloudFront, Secrets Manager
 */
export class CicdStack extends cdk.Stack {
  public readonly githubOidcProvider: iam.OpenIdConnectProvider;
  public readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props);

    const {
      config,
      backendEcrArn,
      frontendEcrArn,
      ecsClusterArn,
      backendServiceArn,
      frontendServiceArn,
      cloudFrontDistributionArn,
      backendTaskRoleArn,
      backendExecutionRoleArn,
      frontendTaskRoleArn,
      frontendExecutionRoleArn,
    } = props;

    // GitHub Actions OIDC Provider
    this.githubOidcProvider = new iam.OpenIdConnectProvider(this, 'GithubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
    });

    // Trust policy: allow GitHub Actions from specific repos on main branch
    const { githubOwner, githubRepos } = config;
    const trustConditions: Record<string, string[]> = {
      'StringLike': [],
    };

    const repoPatterns = [
      `repo:${githubOwner}/${githubRepos.backend}:ref:refs/heads/main`,
      `repo:${githubOwner}/${githubRepos.frontend}:ref:refs/heads/main`,
    ];

    // IAM Deploy Role
    this.deployRole = new iam.Role(this, 'GithubActionsDeployRole', {
      roleName: 'komine-crm-github-actions-deploy',
      assumedBy: new iam.FederatedPrincipal(
        this.githubOidcProvider.openIdConnectProviderArn,
        {
          StringLike: {
            'token.actions.githubusercontent.com:sub': repoPatterns,
          },
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      maxSessionDuration: cdk.Duration.hours(1),
      description: 'Role for GitHub Actions to deploy Komine CRM',
    });

    // ECR permissions (push images)
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcrAuth',
      effect: iam.Effect.ALLOW,
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcrPush',
      effect: iam.Effect.ALLOW,
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:PutImage',
        'ecr:InitiateLayerUpload',
        'ecr:UploadLayerPart',
        'ecr:CompleteLayerUpload',
      ],
      resources: [backendEcrArn, frontendEcrArn],
    }));

    // ECS mutating actions: 対象 service ARN に限定 (#11)
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcsUpdateService',
      effect: iam.Effect.ALLOW,
      actions: [
        'ecs:UpdateService',
        'ecs:DescribeServices',
      ],
      resources: [backendServiceArn, frontendServiceArn],
    }));

    // TaskDefinition の Register/Deregister/Describe は AWS の仕様上リソースレベル制限不可。
    // 業務影響が低い (deploy role が prefixed family にしか触らない運用) ため、
    // wildcard で許可しつつ業務メタは PR review で担保する。
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcsTaskDefinitionManagement',
      effect: iam.Effect.ALLOW,
      actions: [
        'ecs:RegisterTaskDefinition',
        'ecs:DeregisterTaskDefinition',
        'ecs:DescribeTaskDefinition',
      ],
      resources: ['*'],
    }));

    // タスク一覧/詳細はクラスタ条件で限定
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcsListAndDescribeTasks',
      effect: iam.Effect.ALLOW,
      actions: ['ecs:ListTasks', 'ecs:DescribeTasks'],
      resources: ['*'],
      conditions: {
        ArnEquals: {
          'ecs:cluster': ecsClusterArn,
        },
      },
    }));

    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcsRunTask',
      effect: iam.Effect.ALLOW,
      actions: ['ecs:RunTask'],
      resources: ['*'],
      conditions: {
        ArnEquals: {
          'ecs:cluster': ecsClusterArn,
        },
      },
    }));

    // IAM PassRole は ECS Task role / Execution role の 4 ARN に限定 (#11)
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PassRole',
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [
        backendTaskRoleArn,
        backendExecutionRoleArn,
        frontendTaskRoleArn,
        frontendExecutionRoleArn,
      ],
      conditions: {
        StringEquals: {
          'iam:PassedToService': 'ecs-tasks.amazonaws.com',
        },
      },
    }));

    // CloudFront permissions (invalidation)
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudFrontInvalidation',
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudfront:CreateInvalidation',
        'cloudfront:GetInvalidation',
      ],
      resources: [cloudFrontDistributionArn],
    }));

    // CloudWatch Logs (for monitoring deploy progress)
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogs',
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:GetLogEvents',
        'logs:DescribeLogStreams',
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/ecs/komine-crm-*`,
      ],
    }));

    // ECS waiter (wait for service stability).
    // DescribeServices は EcsUpdateService 側で対象 service ARN に限定済みなので、
    // ここでは ELB の TargetHealth Describe のみ。これはリソースレベル制限非対応のため
    // wildcard を許容する。
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ElbWaiter',
      effect: iam.Effect.ALLOW,
      actions: ['elasticloadbalancing:DescribeTargetHealth'],
      resources: ['*'],
    }));

    // Outputs
    new cdk.CfnOutput(this, 'GithubOidcProviderArn', {
      value: this.githubOidcProvider.openIdConnectProviderArn,
      description: 'GitHub OIDC Provider ARN',
    });

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'Deploy role ARN for GitHub Actions',
      exportName: 'KomineCrm-DeployRoleArn',
    });
  }
}
