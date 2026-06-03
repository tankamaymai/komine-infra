import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FrontendStack } from '../lib/frontend-stack';
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

describe('FrontendStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const env = { account: testConfig.account, region: testConfig.region };

    // Create dependency resources
    const depStack = new cdk.Stack(app, 'TestDepStack', { env });
    const vpc = new ec2.Vpc(depStack, 'Vpc', { maxAzs: 2 });
    const cluster = new ecs.Cluster(depStack, 'Cluster', { vpc });
    const frontendSg = new ec2.SecurityGroup(depStack, 'FrontendSg', {
      vpc,
      description: 'Frontend SG',
    });
    const albSg = new ec2.SecurityGroup(depStack, 'AlbSg', {
      vpc,
      description: 'ALB SG',
    });
    const backendAlb = new elbv2.ApplicationLoadBalancer(depStack, 'BackendAlb', {
      vpc,
      internetFacing: true,
    });
    const backendListener = backendAlb.addListener('L', {
      port: 80,
      defaultAction: elbv2.ListenerAction.fixedResponse(200),
    });

    const stack = new FrontendStack(app, 'TestFrontendStack', {
      env,
      config: testConfig,
      vpc,
      ecsCluster: cluster,
      frontendSecurityGroup: frontendSg,
      backendAlb,
      backendHttpListener: backendListener,
    });
    template = Template.fromStack(stack);
  });

  test('creates an ECR repository', () => {
    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'komine-crm-frontend',
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

  test('creates a Fargate task definition with correct resources', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '256',
      Memory: '512',
      Family: 'komine-crm-frontend',
      NetworkMode: 'awsvpc',
      RequiresCompatibilities: ['FARGATE'],
    });
  });

  test('container has port 3000 mapping', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'frontend',
          PortMappings: Match.arrayWith([
            Match.objectLike({
              ContainerPort: 3000,
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
            Match.objectLike({ Name: 'PORT', Value: '3000' }),
            Match.objectLike({ Name: 'HOSTNAME', Value: '0.0.0.0' }),
          ]),
        }),
      ]),
    });
  });

  test('creates a Fargate service with desired count 1', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'komine-crm-frontend',
      DesiredCount: 1,
      LaunchType: 'FARGATE',
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: {
          Enable: true,
          Rollback: true,
        },
      }),
    });
  });

  test('does not create its own ALB and attaches a /* catch-all rule to the shared listener (#13 ③)', () => {
    // 専用 ALB は廃止し共有 ALB を使う。frontend stack には LoadBalancer は無い。
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 100,
      Conditions: Match.arrayWith([
        Match.objectLike({
          Field: 'path-pattern',
          PathPatternConfig: Match.objectLike({ Values: ['/*'] }),
        }),
      ]),
    });
  });

  test('creates a target group with health check on /', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Name: 'komine-crm-frontend-tg',
      Port: 3000,
      Protocol: 'HTTP',
      TargetType: 'ip',
      HealthCheckPath: '/',
      HealthCheckPort: '3000',
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

  test('creates a CloudFront distribution', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Comment: 'Komine Cemetery CRM',
        HttpVersion: 'http2and3',
        PriceClass: 'PriceClass_200',
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          AllowedMethods: Match.arrayWith(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']),
        }),
      }),
    });
  });

  test('CloudFront uses a single origin; ALB does the /api routing (#13 ③)', () => {
    const dist = template.findResources('AWS::CloudFront::Distribution');
    const cfg = Object.values(dist)[0].Properties.DistributionConfig;
    // オリジンは共有 ALB 1 個のみ。
    expect((cfg.Origins || []).length).toBe(1);
    // /api 系の behavior は CloudFront には持たない（ALB のリスナールールで振り分ける）。
    const patterns = (cfg.CacheBehaviors || []).map((b: { PathPattern: string }) => b.PathPattern);
    expect(patterns).not.toContain('/api/*');
    expect(patterns).not.toContain('/api-docs*');
  });

  test('CloudFront has /_next/static/* behavior with caching', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/_next/static/*',
            ViewerProtocolPolicy: 'redirect-to-https',
            AllowedMethods: ['GET', 'HEAD'],
          }),
        ]),
      }),
    });
  });

  test('creates a CloudWatch log group', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ecs/komine-crm-frontend',
      RetentionInDays: 30,
    });
  });

  test('exports CloudFront domain name', () => {
    template.hasOutput('CloudFrontDomainName', {
      Export: { Name: 'KomineCrm-CloudFrontDomain' },
    });
  });

  test('exports CloudFront distribution ID', () => {
    template.hasOutput('CloudFrontDistributionId', {
      Export: { Name: 'KomineCrm-CloudFrontDistributionId' },
    });
  });

  test('exports frontend ECR repository URI', () => {
    template.hasOutput('FrontendEcrRepositoryUri', {
      Export: { Name: 'KomineCrm-FrontendEcrUri' },
    });
  });
});

describe('FrontendStack off-hours scheduling (#13 ②)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const env = { account: testConfig.account, region: testConfig.region };
    const depStack = new cdk.Stack(app, 'DepStack', { env });
    const vpc = new ec2.Vpc(depStack, 'Vpc', { maxAzs: 2 });
    const cluster = new ecs.Cluster(depStack, 'Cluster', { vpc });
    const frontendSg = new ec2.SecurityGroup(depStack, 'FrontendSg', { vpc, description: 'Frontend SG' });
    const albSg = new ec2.SecurityGroup(depStack, 'AlbSg', { vpc, description: 'ALB SG' });
    const backendAlb = new elbv2.ApplicationLoadBalancer(depStack, 'BackendAlb', { vpc, internetFacing: true });
    const backendListener = backendAlb.addListener('L', {
      port: 80,
      defaultAction: elbv2.ListenerAction.fixedResponse(200),
    });
    const stack = new FrontendStack(app, 'OffHoursFrontendStack', {
      env,
      config: { ...testConfig, offHoursSchedule: { enabled: true, startHourJst: 8, endHourJst: 20 } },
      vpc,
      ecsCluster: cluster,
      frontendSecurityGroup: frontendSg,
      backendAlb,
      backendHttpListener: backendListener,
    });
    template = Template.fromStack(stack);
  });

  test('adds scheduled scale-up at 08:00 and scale-to-zero at 20:00 JST on weekdays', () => {
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      ScheduledActions: Match.arrayWith([
        Match.objectLike({
          ScheduledActionName: 'StartBusinessHours',
          Schedule: 'cron(0 8 ? * MON-FRI *)',
          Timezone: 'Asia/Tokyo',
          ScalableTargetAction: Match.objectLike({ MinCapacity: 1, MaxCapacity: 3 }),
        }),
        Match.objectLike({
          ScheduledActionName: 'StopOutsideBusinessHours',
          Schedule: 'cron(0 20 ? * MON-FRI *)',
          Timezone: 'Asia/Tokyo',
          ScalableTargetAction: Match.objectLike({ MinCapacity: 0, MaxCapacity: 0 }),
        }),
      ]),
    });
  });
});
