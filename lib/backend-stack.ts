import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './config';

export interface BackendStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly albSecurityGroup: ec2.ISecurityGroup;
  readonly backendSecurityGroup: ec2.ISecurityGroup;
  readonly databaseSecret: secretsmanager.ISecret;
  readonly documentsBucket: s3.IBucket;
}

/**
 * Backend Stack for Komine Cemetery CRM.
 *
 * Creates:
 * - ECR repository for backend Docker images
 * - ECS Cluster + Fargate Service
 * - Application Load Balancer (public-facing)
 * - Auto Scaling based on CPU utilization
 * - CloudWatch log group
 */
export class BackendStack extends cdk.Stack {
  public readonly ecrRepository: ecr.Repository;
  public readonly ecsCluster: ecs.Cluster;
  public readonly backendService: ecs.FargateService;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  /** ECS task role (#11: PassRole 制限のため CicdStack に渡す) */
  public readonly taskRole: iam.IRole;
  /** ECS task execution role (#11: PassRole 制限のため CicdStack に渡す) */
  public readonly executionRole: iam.IRole;

  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

    const { config, vpc, albSecurityGroup, backendSecurityGroup, databaseSecret, documentsBucket } = props;

    // ECR Repository
    this.ecrRepository = new ecr.Repository(this, 'BackendRepo', {
      repositoryName: 'komine-crm-backend',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          description: 'Keep last 10 images',
          maxImageCount: 10,
          rulePriority: 1,
        },
      ],
    });

    // ECS Cluster
    this.ecsCluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: 'komine-crm-cluster',
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });

    // CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, 'BackendLogGroup', {
      logGroupName: '/ecs/komine-crm-backend',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'BackendTaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
      family: 'komine-crm-backend',
    });

    // Container
    const container = taskDefinition.addContainer('backend', {
      image: ecs.ContainerImage.fromEcrRepository(this.ecrRepository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'backend',
        logGroup,
      }),
      environment: {
        NODE_ENV: 'production',
        PORT: '4000',
      },
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(databaseSecret, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(databaseSecret, 'port'),
        DB_USERNAME: ecs.Secret.fromSecretsManager(databaseSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(databaseSecret, 'password'),
        DB_NAME: ecs.Secret.fromSecretsManager(databaseSecret, 'dbname'),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      portMappings: [
        { containerPort: 4000, protocol: ecs.Protocol.TCP },
      ],
    });

    // Grant S3 access to the task role
    documentsBucket.grantReadWrite(taskDefinition.taskRole);

    // Expose task / execution role for CicdStack PassRole scoping (#11)
    this.taskRole = taskDefinition.taskRole;
    this.executionRole = taskDefinition.obtainExecutionRole();

    // Fargate Service
    this.backendService = new ecs.FargateService(this, 'BackendService', {
      cluster: this.ecsCluster,
      taskDefinition,
      desiredCount: config.backendDesiredCount,
      securityGroups: [backendSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      serviceName: 'komine-crm-backend',
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
      minHealthyPercent: 100,
    });

    // Application Load Balancer
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      loadBalancerName: 'komine-crm-alb',
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'BackendTargetGroup', {
      vpc,
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targetGroupName: 'komine-crm-backend-tg',
      healthCheck: {
        path: '/health',
        port: '4000',
        protocol: elbv2.Protocol.HTTP,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    targetGroup.addTarget(this.backendService);

    // HTTP Listener (redirect to HTTPS when certificate is available)
    this.alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.forward([targetGroup]),
    });

    // Auto Scaling
    const scaling = this.backendService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 3,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // Outputs
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB DNS name',
      exportName: 'KomineCrm-AlbDnsName',
    });

    new cdk.CfnOutput(this, 'AlbUrl', {
      value: `http://${this.alb.loadBalancerDnsName}`,
      description: 'Backend API URL',
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: this.ecrRepository.repositoryUri,
      description: 'ECR repository URI for backend images',
      exportName: 'KomineCrm-BackendEcrUri',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.ecsCluster.clusterName,
      description: 'ECS cluster name',
      exportName: 'KomineCrm-ClusterName',
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: this.backendService.serviceName,
      description: 'Backend ECS service name',
    });
  }
}
