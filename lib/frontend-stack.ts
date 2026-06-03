import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './config';

export interface FrontendStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly ecsCluster: ecs.ICluster;
  readonly frontendSecurityGroup: ec2.ISecurityGroup;
  /** 共有 ALB（BackendStack が作成）。CloudFront の単一オリジン兼 frontend ルートの ALB。 */
  readonly backendAlb: elbv2.IApplicationLoadBalancer;
  /** 共有 ALB の HTTP リスナー (#13 ③)。ここに frontend の catch-all ルールを追加する。 */
  readonly backendHttpListener: elbv2.IApplicationListener;
}

/**
 * Frontend Stack for Komine Cemetery CRM.
 *
 * Creates:
 * - ECR repository for frontend Docker images
 * - Fargate Service (reuses Backend's ECS Cluster)
 * - Frontend target group attached to the shared ALB via a catch-all (/*) rule (#13 ③)
 * - CloudFront distribution with a single origin (shared ALB does path-based routing)
 */
export class FrontendStack extends cdk.Stack {
  public readonly ecrRepository: ecr.Repository;
  public readonly frontendService: ecs.FargateService;
  public readonly distribution: cloudfront.Distribution;
  /** ECS task role (#11: PassRole 制限のため CicdStack に渡す) */
  public readonly taskRole: iam.IRole;
  /** ECS task execution role (#11: PassRole 制限のため CicdStack に渡す) */
  public readonly executionRole: iam.IRole;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const { config, vpc, ecsCluster, frontendSecurityGroup, backendAlb, backendHttpListener } = props;

    // ECR Repository
    this.ecrRepository = new ecr.Repository(this, 'FrontendRepo', {
      repositoryName: 'komine-crm-frontend',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          description: 'Keep last 10 images',
          maxImageCount: 10,
          rulePriority: 1,
        },
      ],
    });

    // CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, 'FrontendLogGroup', {
      logGroupName: '/ecs/komine-crm-frontend',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'FrontendTaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
      family: 'komine-crm-frontend',
    });

    // Container
    taskDefinition.addContainer('frontend', {
      image: ecs.ContainerImage.fromEcrRepository(this.ecrRepository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'frontend',
        logGroup,
      }),
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
        NEXT_PUBLIC_API_URL: `http://${backendAlb.loadBalancerDnsName}/api/v1`,
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(90),
      },
      portMappings: [
        { containerPort: 3000, protocol: ecs.Protocol.TCP },
      ],
    });

    // Expose task / execution role for CicdStack PassRole scoping (#11)
    this.taskRole = taskDefinition.taskRole;
    this.executionRole = taskDefinition.obtainExecutionRole();

    // Fargate Service (reuses Backend's ECS Cluster)
    this.frontendService = new ecs.FargateService(this, 'FrontendService', {
      cluster: ecsCluster,
      taskDefinition,
      desiredCount: config.frontendDesiredCount,
      securityGroups: [frontendSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      serviceName: 'komine-crm-frontend',
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });

    // #13 ③: 専用 ALB は廃止し、BackendStack の共有 ALB に frontend ターゲットグループを
    // catch-all ルール（/* → frontend）で接続する。/api/* ・ /api-docs* は共有リスナーの
    // 高優先度ルール（BackendStack, priority 10/20）で backend へ向くので、ここは
    // priority 100 で「それ以外すべて」を frontend に流す。
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'FrontendTargetGroup', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targetGroupName: 'komine-crm-frontend-tg',
      healthCheck: {
        path: '/',
        port: '3000',
        protocol: elbv2.Protocol.HTTP,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    targetGroup.addTarget(this.frontendService);

    new elbv2.ApplicationListenerRule(this, 'FrontendCatchAllRule', {
      listener: backendHttpListener,
      priority: 100,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    // Auto Scaling
    const scaling = this.frontendService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 3,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // #13 ②: 夜間・休日の自動停止でコスト削減（backend と同じスケジュール）。
    // 平日 startHourJst にタスク 1〜max、endHourJst に 0。timeZone 指定で cron は JST 解釈。
    const offHours = config.offHoursSchedule;
    if (offHours?.enabled) {
      scaling.scaleOnSchedule('StartBusinessHours', {
        schedule: appscaling.Schedule.cron({
          weekDay: 'MON-FRI',
          hour: String(offHours.startHourJst),
          minute: '0',
        }),
        timeZone: cdk.TimeZone.ASIA_TOKYO,
        minCapacity: 1,
        maxCapacity: 3,
      });
      scaling.scaleOnSchedule('StopOutsideBusinessHours', {
        schedule: appscaling.Schedule.cron({
          weekDay: 'MON-FRI',
          hour: String(offHours.endHourJst),
          minute: '0',
        }),
        timeZone: cdk.TimeZone.ASIA_TOKYO,
        minCapacity: 0,
        maxCapacity: 0,
      });
    }

    // CloudFront Distribution
    // #13 ③: オリジンは共有 ALB 1 個のみ。/api 系は ALB のリスナールールで backend へ
    // 振り分けられるため、CloudFront 側で backend/frontend を分ける behavior は不要。
    // 静的アセット (/_next/static/*) だけエッジキャッシュを効かせる。
    const albOrigin = new origins.HttpOrigin(backendAlb.loadBalancerDnsName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Komine Cemetery CRM',
      defaultBehavior: {
        origin: albOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
      additionalBehaviors: {
        '/_next/static/*': {
          origin: albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    // Outputs
    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
      exportName: 'KomineCrm-CloudFrontDomain',
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID',
      exportName: 'KomineCrm-CloudFrontDistributionId',
    });

    new cdk.CfnOutput(this, 'FrontendEcrRepositoryUri', {
      value: this.ecrRepository.repositoryUri,
      description: 'ECR repository URI for frontend images',
      exportName: 'KomineCrm-FrontendEcrUri',
    });

    new cdk.CfnOutput(this, 'FrontendServiceName', {
      value: this.frontendService.serviceName,
      description: 'Frontend ECS service name',
    });
  }
}
