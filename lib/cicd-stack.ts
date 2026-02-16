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

    // ECS permissions (update service, run task for migration)
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcsUpdateService',
      effect: iam.Effect.ALLOW,
      actions: [
        'ecs:UpdateService',
        'ecs:DescribeServices',
        'ecs:DescribeTaskDefinition',
        'ecs:RegisterTaskDefinition',
        'ecs:DeregisterTaskDefinition',
        'ecs:ListTasks',
        'ecs:DescribeTasks',
      ],
      resources: ['*'],
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

    // IAM PassRole (for ECS task execution)
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PassRole',
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: ['*'],
      conditions: {
        StringLike: {
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

    // ECS waiter (wait for service stability)
    this.deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcsWaiter',
      effect: iam.Effect.ALLOW,
      actions: [
        'ecs:DescribeServices',
        'elasticloadbalancing:DescribeTargetHealth',
      ],
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
