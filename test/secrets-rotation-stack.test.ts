import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SecretsRotationStack } from '../lib/secrets-rotation-stack';

describe('SecretsRotationStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const env = { account: '123456789012', region: 'ap-northeast-1' };

    // Synthesize a dummy VPC + SG + secret in a separate stack to mirror real wiring
    const depStack = new cdk.Stack(app, 'DepStack', { env });
    const vpc = new ec2.Vpc(depStack, 'Vpc', { maxAzs: 2 });
    const rotationSg = new ec2.SecurityGroup(depStack, 'RotationSg', {
      vpc,
      description: 'Rotation SG',
    });
    const secret = new secretsmanager.Secret(depStack, 'DbSecret', {
      secretName: 'komine-crm/database-credentials',
    });

    const stack = new SecretsRotationStack(app, 'TestSecretsRotationStack', {
      env,
      vpc,
      secretsRotationSecurityGroup: rotationSg,
      databaseSecret: secret,
      databaseInstanceIdentifier: 'komine-crm-db',
    });
    template = Template.fromStack(stack);
  });

  test('creates the rotation lambda via the SAM application', () => {
    template.resourceCountIs('AWS::Serverless::Application', 1);
    template.hasResourceProperties('AWS::Serverless::Application', {
      // endpoint は Fn::Join で動的構築されるため key の存在のみ確認
      Parameters: Match.objectLike({
        endpoint: Match.anyValue(),
        vpcSubnetIds: Match.anyValue(),
        vpcSecurityGroupIds: Match.anyValue(),
      }),
    });
  });

  test('rotation runs on a 30-day cycle', () => {
    template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 1);
    template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
      RotationRules: Match.objectLike({
        ScheduleExpression: 'rate(30 days)',
      }),
    });
  });

  test('places the rotation schedule in this stack (not the secret\'s stack) to avoid cycle', () => {
    // ImportedDbSecret + RotationSchedule の両方が本 stack に配置されていることを
    // resource path で確認（cycle 回避の核心）。
    const resources = template.findResources('AWS::SecretsManager::RotationSchedule');
    const keys = Object.keys(resources);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/ImportedDbSecret/);
  });

  test('outputs the rotated secret ARN and DB identifier', () => {
    template.hasOutput('RotatedSecretArn', {});
    template.hasOutput('RotatedDatabaseInstanceId', {
      Value: 'komine-crm-db',
    });
  });
});
