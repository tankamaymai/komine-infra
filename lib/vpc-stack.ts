import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './config';

export interface VpcStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * VPC Stack for Komine Cemetery CRM.
 *
 * Creates:
 * - VPC with 2 AZs
 * - Public subnets (for ALB)
 * - Private subnets with egress (for ECS tasks and RDS)
 * - 1 NAT Gateway (cost optimization)
 * - Security Groups for ALB, Backend ECS, Frontend ECS, RDS
 */
export class VpcStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly backendSecurityGroup: ec2.SecurityGroup;
  public readonly frontendSecurityGroup: ec2.SecurityGroup;
  public readonly databaseSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: VpcStackProps) {
    super(scope, id, props);

    const { config } = props;

    // VPC
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: 'komine-crm-vpc',
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // Security Group: ALB
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      securityGroupName: 'komine-crm-alb-sg',
      description: 'Security group for Application Load Balancer',
      allowAllOutbound: true,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP from anywhere',
    );
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from anywhere',
    );

    // Security Group: Backend ECS
    this.backendSecurityGroup = new ec2.SecurityGroup(this, 'BackendSg', {
      vpc: this.vpc,
      securityGroupName: 'komine-crm-backend-sg',
      description: 'Security group for Backend ECS tasks',
      allowAllOutbound: true,
    });
    this.backendSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(4000),
      'Allow traffic from ALB on port 4000',
    );

    // Security Group: Frontend ECS
    this.frontendSecurityGroup = new ec2.SecurityGroup(this, 'FrontendSg', {
      vpc: this.vpc,
      securityGroupName: 'komine-crm-frontend-sg',
      description: 'Security group for Frontend ECS tasks',
      allowAllOutbound: true,
    });
    this.frontendSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(3000),
      'Allow traffic from ALB on port 3000',
    );

    // Security Group: RDS
    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc: this.vpc,
      securityGroupName: 'komine-crm-database-sg',
      description: 'Security group for RDS PostgreSQL',
      allowAllOutbound: false,
    });
    this.databaseSecurityGroup.addIngressRule(
      this.backendSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow PostgreSQL from Backend ECS',
    );

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
      exportName: 'KomineCrm-VpcId',
    });

    new cdk.CfnOutput(this, 'VpcCidr', {
      value: this.vpc.vpcCidrBlock,
      description: 'VPC CIDR block',
    });
  }
}
