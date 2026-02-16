/**
 * Environment configuration for Komine Cemetery CRM infrastructure.
 */
export interface EnvironmentConfig {
  /** AWS Account ID */
  readonly account: string;
  /** AWS Region */
  readonly region: string;
  /** VPC CIDR block */
  readonly vpcCidr: string;
  /** RDS instance class */
  readonly dbInstanceClass: string;
  /** RDS allocated storage in GB */
  readonly dbAllocatedStorage: number;
  /** Backend ECS desired task count */
  readonly backendDesiredCount: number;
  /** Frontend ECS desired task count */
  readonly frontendDesiredCount: number;
  /** Custom domain name (optional) */
  readonly domainName?: string;
}

export const prodConfig: EnvironmentConfig = {
  account: process.env.CDK_DEFAULT_ACCOUNT!,
  region: 'ap-northeast-1',
  vpcCidr: '10.0.0.0/16',
  dbInstanceClass: 'db.t4g.micro',
  dbAllocatedStorage: 20,
  backendDesiredCount: 1,
  frontendDesiredCount: 1,
};
