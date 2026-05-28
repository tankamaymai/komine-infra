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
  /**
   * Whether the RDS instance uses Multi-AZ deployment.
   * 本番では HA 最優先方針のため true を推奨（同期スタンバイ + 自動フェイルオーバー）。
   * コスト影響: インスタンス/ストレージがほぼ 2 倍。
   */
  readonly dbMultiAz: boolean;
  /** Backend ECS desired task count */
  readonly backendDesiredCount: number;
  /** Frontend ECS desired task count */
  readonly frontendDesiredCount: number;
  /** Custom domain name (optional) */
  readonly domainName?: string;
  /** GitHub organization/owner for OIDC trust */
  readonly githubOwner: string;
  /** GitHub repository names for OIDC trust */
  readonly githubRepos: {
    readonly backend: string;
    readonly frontend: string;
  };
}

export const prodConfig: EnvironmentConfig = {
  account: process.env.CDK_DEFAULT_ACCOUNT!,
  region: 'ap-northeast-1',
  vpcCidr: '10.0.0.0/16',
  dbInstanceClass: 't4g.micro',
  dbAllocatedStorage: 20,
  // 本番は HA 最優先方針で Multi-AZ 有効化（#7）。
  // コスト最適化（インスタンスクラス見直し含む）は #13 で扱う。
  dbMultiAz: true,
  backendDesiredCount: 1,
  frontendDesiredCount: 1,
  githubOwner: 'tankamaymai',
  githubRepos: {
    backend: 'komine--cemetery-crm-backend',
    frontend: 'komine-frontend-crm-v2',
  },
};
