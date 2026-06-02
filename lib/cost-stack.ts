import * as cdk from 'aws-cdk-lib/core';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './config';

export interface CostStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * Cost guardrail stack: AWS Budgets による月額コスト予算 + アラート (#13)。
 *
 * - 月額 COST 予算を `config.monthlyCostBudgetUsd` (USD) で作成。
 * - 通知（`config.costAlertEmails` が 1 件以上のとき）:
 *     - 実績 80%   超過 … 早期警告
 *     - 実績 100% 超過 … 予算超過
 *     - 予測 100% 到達 … このままだと月末に超過する見込み
 *   AWS Budgets の通知は購読者 1 名以上が必須のため、メール未設定時は
 *   通知を付けず予算（コスト追跡のみ）を作成する。後からメールを追加すれば有効化される。
 *
 * AWS Budgets はアカウント全体（全リージョン横断）のコストを対象とする account-level
 * リソースで、どのリージョンの stack から作成しても挙動は同じ。本構成では他 stack と
 * 揃えて Tokyo (ap-northeast-1) の app に配置する。
 *
 * クレジット/返金はコスト最適化判断を歪めるため除外し、「実際の請求額に近い」値を見る。
 * RI/Savings Plans の前払いは含める（既定）。月額試算とシナリオは docs/cost-estimate.md 参照。
 */
export class CostStack extends cdk.Stack {
  public readonly monthlyBudget: budgets.CfnBudget;

  constructor(scope: Construct, id: string, props: CostStackProps) {
    super(scope, id, props);

    const { config } = props;
    const emails = config.costAlertEmails ?? [];

    const subscribers: budgets.CfnBudget.SubscriberProperty[] = emails.map((address) => ({
      subscriptionType: 'EMAIL',
      address,
    }));

    // メールが設定されているときだけ通知を付ける（購読者 0 件の通知は AWS が拒否するため）。
    const notificationsWithSubscribers:
      | budgets.CfnBudget.NotificationWithSubscribersProperty[]
      | undefined =
      subscribers.length > 0
        ? [
            // 実績が予算の 80% を超えたら早期警告
            {
              notification: {
                notificationType: 'ACTUAL',
                comparisonOperator: 'GREATER_THAN',
                threshold: 80,
                thresholdType: 'PERCENTAGE',
              },
              subscribers,
            },
            // 実績が予算の 100% を超えたら超過通知
            {
              notification: {
                notificationType: 'ACTUAL',
                comparisonOperator: 'GREATER_THAN',
                threshold: 100,
                thresholdType: 'PERCENTAGE',
              },
              subscribers,
            },
            // 予測値が予算の 100% に到達（このままだと月末超過）したら事前警告
            {
              notification: {
                notificationType: 'FORECASTED',
                comparisonOperator: 'GREATER_THAN',
                threshold: 100,
                thresholdType: 'PERCENTAGE',
              },
              subscribers,
            },
          ]
        : undefined;

    this.monthlyBudget = new budgets.CfnBudget(this, 'MonthlyCostBudget', {
      budget: {
        budgetName: 'komine-crm-monthly-cost',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: config.monthlyCostBudgetUsd,
          unit: 'USD',
        },
        costTypes: {
          // コスト最適化判断を歪めないよう、クレジット/返金は予算評価から除外。
          includeCredit: false,
          includeRefund: false,
        },
      },
      notificationsWithSubscribers,
    });

    new cdk.CfnOutput(this, 'MonthlyBudgetName', {
      value: 'komine-crm-monthly-cost',
      description: 'AWS Budgets monthly cost budget name',
    });

    new cdk.CfnOutput(this, 'MonthlyBudgetLimitUsd', {
      value: String(config.monthlyCostBudgetUsd),
      description: 'Monthly cost budget limit in USD',
    });

    new cdk.CfnOutput(this, 'CostAlertSubscriberCount', {
      value: String(subscribers.length),
      description:
        'Number of email subscribers on the cost budget alerts (0 = tracking only, no notification)',
    });
  }
}
