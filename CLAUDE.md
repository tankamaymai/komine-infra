# CLAUDE.md — komine-infra

AWS CDK (TypeScript) による小峰霊園CRMのインフラストラクチャ定義。

## Project Structure

```
komine-infra/
├── bin/komine-infra.ts        # CDK App entry point
├── lib/
│   ├── config.ts              # Environment configuration (EnvironmentConfig)
│   ├── vpc-stack.ts           # Phase 1: VPC, Subnets, NAT, Security Groups
│   ├── database-stack.ts      # Phase 2: RDS PostgreSQL + Secrets Manager
│   ├── storage-stack.ts       # Phase 2: S3 buckets
│   ├── backend-stack.ts       # Phase 3: ECR + ECS Fargate + ALB
│   ├── frontend-stack.ts      # Phase 4: ECR + ECS Fargate + ALB + CloudFront
│   └── cicd-stack.ts          # Phase 5: GitHub OIDC + IAM Deploy Role
├── github-workflows/
│   ├── deploy-backend.yml     # GitHub Actions template for backend deploy
│   └── deploy-frontend.yml    # GitHub Actions template for frontend deploy
├── test/
│   ├── komine-infra.test.ts   # VPC Stack tests
│   ├── database-stack.test.ts # Database Stack tests
│   ├── storage-stack.test.ts  # Storage Stack tests
│   ├── backend-stack.test.ts  # Backend Stack tests
│   ├── frontend-stack.test.ts # Frontend Stack tests
│   └── cicd-stack.test.ts     # CI/CD Stack tests
├── cdk.json                   # CDK configuration + feature flags
├── jest.config.js             # Jest configuration (ts-jest)
└── tsconfig.json              # TypeScript configuration (commonjs)
```

## Commands

```bash
npm run build        # Compile TypeScript
npm test             # Run Jest tests
npx cdk synth        # Synthesize CloudFormation template
npx cdk diff         # Compare with deployed stack
npx cdk deploy       # Deploy stack to AWS
npx cdk destroy      # Remove deployed stack
```

## Stack Architecture

```
KomineVpcStack        → VPC, Subnets (2 AZ), NAT Gateway, Security Groups
KomineDatabaseStack   → RDS PostgreSQL 16, Secrets Manager, Parameter Group
KomineStorageStack    → S3 bucket (documents), lifecycle rules, versioning
KomineBackendStack    → ECR, ECS Cluster, Fargate Service, ALB, Auto Scaling
KomineFrontendStack   → ECR, ECS Fargate, Frontend ALB, CloudFront (path routing)
KomineCicdStack       → GitHub OIDC Provider, IAM Deploy Role
```

## CI/CD

GitHub Actions-based deployment using OIDC authentication (no long-lived credentials).

**Workflow templates** are in `github-workflows/`. Copy to each repo's `.github/workflows/`:
- `deploy-backend.yml` → `komine--cemetery-crm-backend`
- `deploy-frontend.yml` → `komine-frontend-crm-v2`

**Deploy flow**:
1. Push to main → Run tests
2. Build Docker image → Push to ECR
3. (Backend only) Run Prisma migration via ECS RunTask
4. Update ECS task definition → Deploy new service
5. (Frontend only) Invalidate CloudFront cache

## Key Design Decisions

- **Region**: ap-northeast-1 (Tokyo)
- **Environment**: prod only (minimal configuration)
- **NAT Gateway**: 1 (cost optimization)
- **Module system**: CommonJS (required for ts-node compatibility with CDK CLI)
- **Database**: RDS PostgreSQL (migrating from Supabase; auth remains on Supabase)
- **Compute**: ECS Fargate (backend has existing Dockerfile)
- **CI/CD**: GitHub Actions + OIDC (no access keys)

## Configuration

All environment-specific values are in `lib/config.ts`. The `EnvironmentConfig` interface defines the shape; `prodConfig` provides production values.

## Testing

Tests use `aws-cdk-lib/assertions` Template matching. Run with `npm test`.

## Conventions

- **Code**: English (variable names, function names, comments)
- **Stack naming**: `Komine{Purpose}Stack`
- **Resource naming prefix**: `komine-crm-`
- Import paths: No `.js` extension (CommonJS module resolution)
