import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BackendStack } from '../lib/backend-stack';
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

describe('BackendStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const env = { account: testConfig.account, region: testConfig.region };

    // Create dependency resources
    const depStack = new cdk.Stack(app, 'TestDepStack', { env });
    const vpc = new ec2.Vpc(depStack, 'Vpc', { maxAzs: 2 });
    const albSg = new ec2.SecurityGroup(depStack, 'AlbSg', {
      vpc,
      description: 'ALB SG',
    });
    const backendSg = new ec2.SecurityGroup(depStack, 'BackendSg', {
      vpc,
      description: 'Backend SG',
    });
    const secret = new secretsmanager.Secret(depStack, 'DbSecret', {
      secretObjectValue: {
        host: cdk.SecretValue.unsafePlainText('localhost'),
        port: cdk.SecretValue.unsafePlainText('5432'),
        username: cdk.SecretValue.unsafePlainText('admin'),
        password: cdk.SecretValue.unsafePlainText('password'),
        dbname: cdk.SecretValue.unsafePlainText('testdb'),
      },
    });
    const bucket = new s3.Bucket(depStack, 'DocsBucket');

    const stack = new BackendStack(app, 'TestBackendStack', {
      env,
      config: testConfig,
      vpc,
      albSecurityGroup: albSg,
      backendSecurityGroup: backendSg,
      databaseSecret: secret,
      documentsBucket: bucket,
    });
    template = Template.fromStack(stack);
  });

  test('creates an ECR repository', () => {
    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'komine-crm-backend',
    });
  });

  test('ECR repository has lifecycle rule to keep 10 images', () => {
    template.hasResourceProperties('AWS::ECR::Repository', {
      LifecyclePolicy: {
        LifecyclePolicyText: Match.serializedJson(Match.objectLike({
          rules: Match.arrayWith([
            Match.objectLike({
              selection: Match.objectLike({
                countNumber: 10,
                countType: 'imageCountMoreThan',
              }),
            }),
          ]),
        })),
      },
    });
  });

  test('creates an ECS cluster with Container Insights v2', () => {
    template.resourceCountIs('AWS::ECS::Cluster', 1);
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'komine-crm-cluster',
      ClusterSettings: Match.arrayWith([
        Match.objectLike({
          Name: 'containerInsights',
          Value: 'enhanced',
        }),
      ]),
    });
  });

  test('creates a Fargate task definition with correct resources', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '256',
      Memory: '512',
      Family: 'komine-crm-backend',
      NetworkMode: 'awsvpc',
      RequiresCompatibilities: ['FARGATE'],
    });
  });

  test('task definition container has correct port mapping', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'backend',
          Essential: true,
          PortMappings: Match.arrayWith([
            Match.objectLike({
              ContainerPort: 4000,
              Protocol: 'tcp',
            }),
          ]),
        }),
      ]),
    });
  });

  test('container has production environment variables', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'NODE_ENV', Value: 'production' }),
            Match.objectLike({ Name: 'PORT', Value: '4000' }),
          ]),
        }),
      ]),
    });
  });

  test('does not inject ALLOWED_ORIGINS when no origins configured (#11, #10 待ち)', () => {
    // domainName も allowedOrigins も無い既定 config では env を出さず、
    // 本番ドメイン未確定であることを CFN 差分で可視化する。
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'backend',
          Environment: Match.not(
            Match.arrayWith([Match.objectLike({ Name: 'ALLOWED_ORIGINS' })]),
          ),
        }),
      ]),
    });
  });

  test('container has secrets from Secrets Manager', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: 'DB_HOST' }),
            Match.objectLike({ Name: 'DB_PORT' }),
            Match.objectLike({ Name: 'DB_USERNAME' }),
            Match.objectLike({ Name: 'DB_PASSWORD' }),
            Match.objectLike({ Name: 'DB_NAME' }),
          ]),
        }),
      ]),
    });
  });

  test('creates a Fargate service with desired count 1', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'komine-crm-backend',
      DesiredCount: 1,
      LaunchType: 'FARGATE',
      EnableExecuteCommand: true,
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: {
          Enable: true,
          Rollback: true,
        },
      }),
    });
  });

  test('creates an internet-facing Application Load Balancer', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Name: 'komine-crm-alb',
      Scheme: 'internet-facing',
      Type: 'application',
    });
  });

  test('creates a target group with health check on /health', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Name: 'komine-crm-backend-tg',
      Port: 4000,
      Protocol: 'HTTP',
      TargetType: 'ip',
      HealthCheckPath: '/health',
      HealthCheckPort: '4000',
    });
  });

  test('creates an HTTP listener on port 80', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
    });
  });

  test('configures auto scaling with min 1 and max 3', () => {
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: 1,
      MaxCapacity: 3,
    });
  });

  test('configures CPU-based auto scaling at 70%', () => {
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        TargetValue: 70,
        PredefinedMetricSpecification: Match.objectLike({
          PredefinedMetricType: 'ECSServiceAverageCPUUtilization',
        }),
      }),
    });
  });

  test('creates a CloudWatch log group', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ecs/komine-crm-backend',
      RetentionInDays: 30,
    });
  });

  test('exports ALB DNS name', () => {
    template.hasOutput('AlbDnsName', {
      Export: { Name: 'KomineCrm-AlbDnsName' },
    });
  });

  test('exports ECR repository URI', () => {
    template.hasOutput('EcrRepositoryUri', {
      Export: { Name: 'KomineCrm-BackendEcrUri' },
    });
  });

  test('exports ECS cluster name', () => {
    template.hasOutput('ClusterName', {
      Export: { Name: 'KomineCrm-ClusterName' },
    });
  });
});

describe('BackendStack ALLOWED_ORIGINS injection (#11)', () => {
  const buildTemplate = (overrides: Partial<EnvironmentConfig>): Template => {
    const app = new cdk.App();
    const env = { account: testConfig.account, region: testConfig.region };
    const depStack = new cdk.Stack(app, 'TestDepStack', { env });
    const vpc = new ec2.Vpc(depStack, 'Vpc', { maxAzs: 2 });
    const albSg = new ec2.SecurityGroup(depStack, 'AlbSg', { vpc, description: 'ALB SG' });
    const backendSg = new ec2.SecurityGroup(depStack, 'BackendSg', { vpc, description: 'Backend SG' });
    const secret = new secretsmanager.Secret(depStack, 'DbSecret', {
      secretObjectValue: {
        host: cdk.SecretValue.unsafePlainText('localhost'),
        port: cdk.SecretValue.unsafePlainText('5432'),
        username: cdk.SecretValue.unsafePlainText('admin'),
        password: cdk.SecretValue.unsafePlainText('password'),
        dbname: cdk.SecretValue.unsafePlainText('testdb'),
      },
    });
    const bucket = new s3.Bucket(depStack, 'DocsBucket');
    const stack = new BackendStack(app, 'TestBackendStack', {
      env,
      config: { ...testConfig, ...overrides },
      vpc,
      albSecurityGroup: albSg,
      backendSecurityGroup: backendSg,
      databaseSecret: secret,
      documentsBucket: bucket,
    });
    return Template.fromStack(stack);
  };

  test('derives ALLOWED_ORIGINS from domainName (#10 連携)', () => {
    const template = buildTemplate({ domainName: 'crm.example.com' });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'backend',
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'ALLOWED_ORIGINS', Value: 'https://crm.example.com' }),
          ]),
        }),
      ]),
    });
  });

  test('merges explicit allowedOrigins with domainName-derived origin and dedupes', () => {
    const template = buildTemplate({
      domainName: 'crm.example.com',
      allowedOrigins: ['https://d111111abcdef8.cloudfront.net', 'https://crm.example.com'],
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'backend',
          Environment: Match.arrayWith([
            Match.objectLike({
              Name: 'ALLOWED_ORIGINS',
              // crm.example.com は重複排除され 1 回だけ
              Value: 'https://d111111abcdef8.cloudfront.net,https://crm.example.com',
            }),
          ]),
        }),
      ]),
    });
  });

  test('injects ALLOWED_ORIGINS from allowedOrigins alone (no domainName)', () => {
    const template = buildTemplate({
      allowedOrigins: ['https://d111111abcdef8.cloudfront.net'],
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'backend',
          Environment: Match.arrayWith([
            Match.objectLike({
              Name: 'ALLOWED_ORIGINS',
              Value: 'https://d111111abcdef8.cloudfront.net',
            }),
          ]),
        }),
      ]),
    });
  });
});

describe('BackendStack Supabase auth injection (#20)', () => {
  const buildTemplate = (overrides: Partial<EnvironmentConfig>): Template => {
    const app = new cdk.App();
    const env = { account: testConfig.account, region: testConfig.region };
    const depStack = new cdk.Stack(app, 'TestDepStack', { env });
    const vpc = new ec2.Vpc(depStack, 'Vpc', { maxAzs: 2 });
    const albSg = new ec2.SecurityGroup(depStack, 'AlbSg', { vpc, description: 'ALB SG' });
    const backendSg = new ec2.SecurityGroup(depStack, 'BackendSg', { vpc, description: 'Backend SG' });
    const secret = new secretsmanager.Secret(depStack, 'DbSecret', {
      secretObjectValue: {
        host: cdk.SecretValue.unsafePlainText('localhost'),
        port: cdk.SecretValue.unsafePlainText('5432'),
        username: cdk.SecretValue.unsafePlainText('admin'),
        password: cdk.SecretValue.unsafePlainText('password'),
        dbname: cdk.SecretValue.unsafePlainText('testdb'),
      },
    });
    const bucket = new s3.Bucket(depStack, 'DocsBucket');
    const stack = new BackendStack(app, 'TestBackendStack', {
      env,
      config: { ...testConfig, ...overrides },
      vpc,
      albSecurityGroup: albSg,
      backendSecurityGroup: backendSg,
      databaseSecret: secret,
      documentsBucket: bucket,
    });
    return Template.fromStack(stack);
  };

  test('does not inject Supabase env/secret when unconfigured (graceful 503)', () => {
    const template = buildTemplate({});
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'backend',
          Environment: Match.not(
            Match.arrayWith([Match.objectLike({ Name: 'SUPABASE_URL' })]),
          ),
          Secrets: Match.not(
            Match.arrayWith([Match.objectLike({ Name: 'SUPABASE_SERVICE_ROLE_KEY' })]),
          ),
        }),
      ]),
    });
  });

  test('injects SUPABASE_URL as plain env when supabaseUrl set', () => {
    const template = buildTemplate({ supabaseUrl: 'https://abcd.supabase.co' });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'backend',
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'SUPABASE_URL', Value: 'https://abcd.supabase.co' }),
          ]),
        }),
      ]),
    });
  });

  test('injects SUPABASE_SERVICE_ROLE_KEY from Secrets Manager when secret name set', () => {
    const template = buildTemplate({
      supabaseServiceRoleKeySecretName: 'komine-crm/supabase-service-role-key',
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'backend',
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: 'SUPABASE_SERVICE_ROLE_KEY' }),
          ]),
        }),
      ]),
    });
    // 実行ロールに当該 secret の読み取り権限が付与されること
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
          }),
        ]),
      }),
    });
  });
});
