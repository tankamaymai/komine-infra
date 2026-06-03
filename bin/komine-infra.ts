#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { VpcStack } from '../lib/vpc-stack';
import { DatabaseStack } from '../lib/database-stack';
import { StorageStack } from '../lib/storage-stack';
import { BackendStack } from '../lib/backend-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { CicdStack } from '../lib/cicd-stack';
import { SecurityStack } from '../lib/security-stack';
import { SecretsRotationStack } from '../lib/secrets-rotation-stack';
import { CostStack } from '../lib/cost-stack';
import { OffHoursSchedulerStack } from '../lib/off-hours-scheduler-stack';
import {
  BackupStack,
  BackupSecondaryVaultStack,
  SECONDARY_BACKUP_VAULT_NAME,
} from '../lib/backup-stack';
import { prodConfig } from '../lib/config';

const app = new cdk.App();

const env: cdk.Environment = {
  account: prodConfig.account,
  region: prodConfig.region,
};

// Phase 1: VPC + Network
const vpcStack = new VpcStack(app, 'KomineVpcStack', { env, config: prodConfig });

// Phase 2: Database + Storage
const databaseStack = new DatabaseStack(app, 'KomineDatabaseStack', {
  env,
  config: prodConfig,
  vpc: vpcStack.vpc,
  databaseSecurityGroup: vpcStack.databaseSecurityGroup,
  secretsRotationSecurityGroup: vpcStack.secretsRotationSecurityGroup,
});
databaseStack.addDependency(vpcStack);

const storageStack = new StorageStack(app, 'KomineStorageStack', { env });

// Phase 3: Backend
const backendStack = new BackendStack(app, 'KomineBackendStack', {
  env,
  config: prodConfig,
  vpc: vpcStack.vpc,
  albSecurityGroup: vpcStack.albSecurityGroup,
  backendSecurityGroup: vpcStack.backendSecurityGroup,
  databaseSecret: databaseStack.databaseSecret,
  documentsBucket: storageStack.documentsBucket,
});
backendStack.addDependency(vpcStack);
backendStack.addDependency(databaseStack);
backendStack.addDependency(storageStack);

// Phase 4: Frontend + CloudFront
const frontendStack = new FrontendStack(app, 'KomineFrontendStack', {
  env,
  config: prodConfig,
  vpc: vpcStack.vpc,
  ecsCluster: backendStack.ecsCluster,
  frontendSecurityGroup: vpcStack.frontendSecurityGroup,
  // #13 ③: ALB は backend と共有。専用 ALB は廃止し、共有リスナーに frontend ルートを追加。
  backendAlb: backendStack.alb,
  backendHttpListener: backendStack.httpListener,
});
frontendStack.addDependency(vpcStack);
frontendStack.addDependency(backendStack);

// Phase 4.5: Backup (AWS Backup vault + plan + cross-region copy)
// クロスリージョン DR の受け側 vault を別リージョン (ap-northeast-3) に配置。
// 別リージョン stack は CDK の依存解決対象外のため、初回は手動で先にデプロイすること:
//   `npx cdk deploy KomineBackupSecondaryVaultStack`
// （cdk diff/deploy では Region 違いで同時に走らない）。
let crossRegionVaultArn: string | undefined;
if (prodConfig.dbBackupCrossRegion) {
  new BackupSecondaryVaultStack(app, 'KomineBackupSecondaryVaultStack', {
    env: { account: prodConfig.account, region: prodConfig.dbBackupCrossRegion },
    vaultName: SECONDARY_BACKUP_VAULT_NAME,
  });

  crossRegionVaultArn = `arn:aws:backup:${prodConfig.dbBackupCrossRegion}:${prodConfig.account}:backup-vault:${SECONDARY_BACKUP_VAULT_NAME}`;
}

const backupStack = new BackupStack(app, 'KomineBackupStack', {
  env,
  config: prodConfig,
  crossRegionVaultArn,
});
backupStack.addDependency(databaseStack);

// Phase 5: CI/CD
const cicdStack = new CicdStack(app, 'KomineCicdStack', {
  env,
  config: prodConfig,
  backendEcrArn: backendStack.ecrRepository.repositoryArn,
  frontendEcrArn: frontendStack.ecrRepository.repositoryArn,
  ecsClusterArn: backendStack.ecsCluster.clusterArn,
  backendServiceArn: backendStack.backendService.serviceArn,
  frontendServiceArn: frontendStack.frontendService.serviceArn,
  cloudFrontDistributionArn: `arn:aws:cloudfront::${prodConfig.account}:distribution/${frontendStack.distribution.distributionId}`,
  backendTaskRoleArn: backendStack.taskRole.roleArn,
  backendExecutionRoleArn: backendStack.executionRole.roleArn,
  frontendTaskRoleArn: frontendStack.taskRole.roleArn,
  frontendExecutionRoleArn: frontendStack.executionRole.roleArn,
});
cicdStack.addDependency(backendStack);
cicdStack.addDependency(frontendStack);

// Phase 6: Security audit (CloudTrail + GuardDuty)
new SecurityStack(app, 'KomineSecurityStack', { env });

// Phase 7: Secrets Manager rotation (DB credentials, 30-day cycle)
// 専用 stack で持つことで DatabaseStack 内部での addRotationSingleUser がもたらす
// VpcStack ↔ DatabaseStack の循環参照を回避する。詳細は lib/secrets-rotation-stack.ts。
const secretsRotationStack = new SecretsRotationStack(app, 'KomineSecretsRotationStack', {
  env,
  vpc: vpcStack.vpc,
  secretsRotationSecurityGroup: vpcStack.secretsRotationSecurityGroup,
  databaseSecret: databaseStack.databaseSecret,
  databaseInstanceIdentifier: databaseStack.databaseInstance.instanceIdentifier,
});
secretsRotationStack.addDependency(vpcStack);
secretsRotationStack.addDependency(databaseStack);

// Phase 8: Cost guardrail (AWS Budgets 月額予算 + アラート)
// account-level リソースのため他 stack への依存は無し。
new CostStack(app, 'KomineCostStack', { env, config: prodConfig });

// Phase 9: Off-hours scheduler (#13 ②: 夜間・休日に RDS を自動停止)
// Fargate 側は backend/frontend stack の scheduled scaling で 0 にスケール。
// offHoursSchedule.enabled=false のときは中身を作らない（空 stack）。
const offHoursSchedulerStack = new OffHoursSchedulerStack(app, 'KomineOffHoursSchedulerStack', {
  env,
  config: prodConfig,
  databaseInstance: databaseStack.databaseInstance,
});
offHoursSchedulerStack.addDependency(databaseStack);

app.synth();
