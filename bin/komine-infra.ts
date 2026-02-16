#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { VpcStack } from '../lib/vpc-stack';
import { prodConfig } from '../lib/config';

const app = new cdk.App();

const env: cdk.Environment = {
  account: prodConfig.account,
  region: prodConfig.region,
};

// Phase 1: VPC + Network
const vpcStack = new VpcStack(app, 'KomineVpcStack', { env, config: prodConfig });

// Phase 2: Database + Storage (uncomment when ready)
// const databaseStack = new DatabaseStack(app, 'KomineDatabaseStack', {
//   env,
//   config: prodConfig,
//   vpc: vpcStack.vpc,
//   databaseSecurityGroup: vpcStack.databaseSecurityGroup,
// });

// Phase 3: Backend (uncomment when ready)
// const backendStack = new BackendStack(app, 'KomineBackendStack', {
//   env,
//   config: prodConfig,
//   vpc: vpcStack.vpc,
//   albSecurityGroup: vpcStack.albSecurityGroup,
//   backendSecurityGroup: vpcStack.backendSecurityGroup,
//   databaseSecret: databaseStack.databaseSecret,
// });

// Phase 4: Frontend (uncomment when ready)
// const frontendStack = new FrontendStack(app, 'KomineFrontendStack', {
//   env,
//   config: prodConfig,
//   vpc: vpcStack.vpc,
//   albSecurityGroup: vpcStack.albSecurityGroup,
//   frontendSecurityGroup: vpcStack.frontendSecurityGroup,
//   backendService: backendStack.backendService,
// });

app.synth();
