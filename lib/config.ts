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
  /**
   * RDS automated backup retention in days.
   * 本番は 30 日（PITR 可能期間も同じ）。
   */
  readonly dbBackupRetentionDays: number;
  /**
   * RDS preferred backup window (UTC, "HH:MM-HH:MM" 30 分以上).
   * 例: '17:00-18:00' UTC = 02:00-03:00 JST（業務時間外）。
   * maintenance window (sun:18:00-sun:19:00 UTC) と重複させないこと。
   */
  readonly dbPreferredBackupWindow: string;
  /**
   * クロスリージョン DR 用のスナップショットコピー先リージョン。
   * 例: 'ap-northeast-3' (大阪)。undefined のときはクロスリージョンコピー無効。
   */
  readonly dbBackupCrossRegion?: string;
  /**
   * Cross-region コピー先での保持日数（指定があれば一次より長期保管想定）。
   * default: dbBackupRetentionDays と同じ。
   */
  readonly dbBackupCrossRegionRetentionDays?: number;
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
  // バックアップ強化（#8）。
  // - 保持 30 日 / PITR 30 日相当
  // - backup window は JST 02:00-03:00（業務時間外、maintenance 窓と非重複）
  // - 大阪 (ap-northeast-3) へクロスリージョンコピーで DR
  dbBackupRetentionDays: 30,
  dbPreferredBackupWindow: '17:00-18:00',
  dbBackupCrossRegion: 'ap-northeast-3',
  dbBackupCrossRegionRetentionDays: 30,
  backendDesiredCount: 1,
  frontendDesiredCount: 1,
  githubOwner: 'tankamaymai',
  githubRepos: {
    backend: 'komine--cemetery-crm-backend',
    frontend: 'komine-frontend-crm-v2',
  },
};
