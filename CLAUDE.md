# CLAUDE.md — komine-infra

AWS CDK (TypeScript) による小峰霊園CRMのインフラストラクチャ定義。

## Project Structure

```
komine-infra/
├── bin/komine-infra.ts       # CDK App entry point
├── lib/
│   ├── config.ts             # Environment configuration (EnvironmentConfig)
│   ├── vpc-stack.ts          # Phase 1: VPC, Subnets, NAT, Security Groups
│   ├── database-stack.ts     # Phase 2: RDS PostgreSQL + Secrets Manager
│   ├── storage-stack.ts      # Phase 2: S3 buckets
│   ├── backend-stack.ts      # Phase 3: ECR + ECS Fargate + ALB (planned)
│   ├── frontend-stack.ts     # Phase 4: ECR + ECS Fargate + CloudFront (planned)
│   └── pipeline-stack.ts     # Phase 5: CI/CD pipeline (planned)
├── test/
│   ├── komine-infra.test.ts  # VPC Stack tests
│   ├── database-stack.test.ts # Database Stack tests
│   └── storage-stack.test.ts  # Storage Stack tests
├── cdk.json                  # CDK configuration + feature flags
├── jest.config.js            # Jest configuration (ts-jest)
└── tsconfig.json             # TypeScript configuration (commonjs)
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
KomineBackendStack    → ECR, ECS Fargate, ALB for backend (planned)
KomineFrontendStack   → ECR, ECS Fargate, CloudFront for frontend (planned)
KominePipelineStack   → CI/CD pipeline (planned)
```

## Key Design Decisions

- **Region**: ap-northeast-1 (Tokyo)
- **Environment**: prod only (minimal configuration)
- **NAT Gateway**: 1 (cost optimization)
- **Module system**: CommonJS (required for ts-node compatibility with CDK CLI)
- **Database**: RDS PostgreSQL (migrating from Supabase; auth remains on Supabase)
- **Compute**: ECS Fargate (backend has existing Dockerfile)

## Configuration

All environment-specific values are in `lib/config.ts`. The `EnvironmentConfig` interface defines the shape; `prodConfig` provides production values.

## Testing

Tests use `aws-cdk-lib/assertions` Template matching. Run with `npm test`.

## Conventions

- **Code**: English (variable names, function names, comments)
- **Stack naming**: `Komine{Purpose}Stack`
- **Resource naming prefix**: `komine-crm-`
- Import paths: No `.js` extension (CommonJS module resolution)
