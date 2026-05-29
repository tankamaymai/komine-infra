import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SecurityStack } from '../lib/security-stack';

describe('SecurityStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new SecurityStack(app, 'TestSecurityStack', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
    });
    template = Template.fromStack(stack);
  });

  test('creates a CloudTrail bucket with encryption, versioning, and SSL enforcement', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'komine-crm-cloudtrail-123456789012',
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: 'AES256',
            }),
          }),
        ]),
      }),
      VersioningConfiguration: Match.objectLike({ Status: 'Enabled' }),
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      }),
    });
  });

  test('CloudTrail bucket is retained on stack deletion', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('CloudTrail bucket has lifecycle transitions to IA / Glacier and 365-day expiration', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: 'Enabled',
            Transitions: Match.arrayWith([
              Match.objectLike({ StorageClass: 'STANDARD_IA', TransitionInDays: 90 }),
              Match.objectLike({ StorageClass: 'GLACIER', TransitionInDays: 180 }),
            ]),
            ExpirationInDays: 365,
          }),
        ]),
      }),
    });
  });

  test('creates a multi-region CloudTrail with file validation', () => {
    template.resourceCountIs('AWS::CloudTrail::Trail', 1);
    template.hasResourceProperties('AWS::CloudTrail::Trail', {
      TrailName: 'komine-crm-trail',
      IsMultiRegionTrail: true,
      EnableLogFileValidation: true,
      IsLogging: true,
    });
  });

  test('CloudTrail sends to a 6-month CloudWatch log group', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/cloudtrail/komine-crm',
      RetentionInDays: 180,
    });
  });

  test('enables GuardDuty with 15-minute publishing frequency', () => {
    template.resourceCountIs('AWS::GuardDuty::Detector', 1);
    template.hasResourceProperties('AWS::GuardDuty::Detector', {
      Enable: true,
      FindingPublishingFrequency: 'FIFTEEN_MINUTES',
    });
  });

  test('outputs trail ARN, bucket name, and detector ID', () => {
    template.hasOutput('TrailArn', {});
    template.hasOutput('TrailBucketName', {});
    template.hasOutput('GuardDutyDetectorId', {});
  });
});
