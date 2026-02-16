import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { StorageStack } from '../lib/storage-stack';

describe('StorageStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new StorageStack(app, 'TestStorageStack', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
    });
    template = Template.fromStack(stack);
  });

  test('creates an S3 bucket', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
  });

  test('bucket has versioning enabled', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: {
        Status: 'Enabled',
      },
    });
  });

  test('bucket blocks all public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('bucket uses S3-managed encryption', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          },
        ],
      },
    });
  });

  test('bucket has lifecycle rules for cost optimization', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'transition-to-ia',
            Status: 'Enabled',
            Transitions: [
              Match.objectLike({
                StorageClass: 'STANDARD_IA',
                TransitionInDays: 90,
              }),
            ],
          }),
          Match.objectLike({
            Id: 'cleanup-noncurrent-versions',
            Status: 'Enabled',
            NoncurrentVersionExpiration: Match.objectLike({
              NoncurrentDays: 30,
            }),
          }),
        ]),
      },
    });
  });

  test('bucket enforces SSL via bucket policy', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: {
              Bool: { 'aws:SecureTransport': 'false' },
            },
          }),
        ]),
      }),
    });
  });

  test('exports bucket name and ARN', () => {
    template.hasOutput('DocumentsBucketName', {
      Export: { Name: 'KomineCrm-DocumentsBucketName' },
    });
    template.hasOutput('DocumentsBucketArn', {
      Export: { Name: 'KomineCrm-DocumentsBucketArn' },
    });
  });
});
