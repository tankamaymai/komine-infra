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
  /**
   * 本番 backend の CORS 許可オリジン (#11)。
   * backend は本番 (`NODE_ENV=production`) で `ALLOWED_ORIGINS` が空だと
   * Origin ヘッダ付きリクエストを全て reject するため、本番ドメインを必ず注入する。
   * `domainName` を設定すると `https://${domainName}` が自動で追加される
   * （#10 で ACM 証明書用に `domainName` を入れれば CORS も同時に通る）ので、
   * ここには CloudFront 既定ドメイン等の追加オリジンだけを列挙すればよい。
   * 例: ['https://d111111abcdef8.cloudfront.net']
   */
  readonly allowedOrigins?: string[];
  /**
   * Supabase プロジェクト URL (#20)。認証 (JWT 検証) に使う。機微情報ではないため
   * 平文 env (`SUPABASE_URL`) として注入する。未設定時は注入せず、backend は認証
   * エンドポイントで 503 を返す（graceful degradation）。
   */
  readonly supabaseUrl?: string;
  /**
   * Supabase service role key を保持する Secrets Manager secret の名前または ARN (#20)。
   * service role key は機微情報かつ Supabase 発行で AWS 側では生成できないため、
   * ops が事前に作成・投入した secret を名前で参照し `SUPABASE_SERVICE_ROLE_KEY` に注入する。
   * 未設定時は注入せず、backend は認証で 503 を返す。
   */
  readonly supabaseServiceRoleKeySecretName?: string;
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
  // CORS 許可オリジン (#11)。本番ドメイン確定 (#10) で `domainName` を設定すれば
  // `https://${domainName}` が自動追加される。CloudFront 既定ドメインなど追加分のみここに列挙。
  allowedOrigins: [],
  // Supabase 認証の本番設定 (#20)。値は operational のため未設定（設定するまで認証は 503）。
  // 例: supabaseUrl: 'https://xxxx.supabase.co',
  //     supabaseServiceRoleKeySecretName: 'komine-crm/supabase-service-role-key',
  githubOwner: 'tankamaymai',
  githubRepos: {
    backend: 'komine--cemetery-crm-backend',
    frontend: 'komine-frontend-crm-v2',
  },
};
