import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';

export interface VersusArenaWafStackProps extends cdk.StackProps {
  /** Custom domain (apex) and its Route 53 hosted zone; enables the CloudFront certificate */
  domainName?: string;
  hostedZoneId?: string;
  /** Address alerted when the WAF starts blocking a lot of traffic */
  alertEmail?: string;
}

// CloudFront-scoped resources (WAF, TLS certificate) must live in us-east-1.
export class VersusArenaWafStack extends cdk.Stack {
  public readonly webAclArn: string;
  public readonly certificateArn?: string;

  constructor(scope: Construct, id: string, props?: VersusArenaWafStackProps) {
    super(scope, id, props);

    if (props?.domainName && props.hostedZoneId) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: props.domainName });
      const cert = new acm.Certificate(this, 'SiteCertificate', {
        domainName: props.domainName,
        subjectAlternativeNames: [`www.${props.domainName}`],
        validation: acm.CertificateValidation.fromDns(zone),
      });
      this.certificateArn = cert.certificateArn;
    }

    const visibility = (name: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
      cloudWatchMetricsEnabled: true,
      metricName: name,
      sampledRequestsEnabled: true,
    });
    const managed = (name: string, priority: number, overrides: string[] = []): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name,
          // Rules switched to "count" only where they would break legitimate features
          ruleActionOverrides: overrides.map((r) => ({ name: r, actionToUse: { count: {} } })),
        },
      },
      visibilityConfig: visibility(name),
    });
    const isApiWrite: wafv2.CfnWebACL.StatementProperty = {
      andStatement: {
        statements: [
          {
            byteMatchStatement: {
              fieldToMatch: { uriPath: {} },
              positionalConstraint: 'STARTS_WITH',
              searchString: '/api/',
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
          {
            notStatement: {
              statement: {
                byteMatchStatement: {
                  fieldToMatch: { method: {} },
                  positionalConstraint: 'EXACTLY',
                  searchString: 'GET',
                  textTransformations: [{ priority: 0, type: 'NONE' }],
                },
              },
            },
          },
        ],
      },
    };

    const acl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: visibility('VersusArenaWebAcl'),
      rules: [
        managed('AWSManagedRulesAmazonIpReputationList', 0),
        // Profile images and admin page saves are larger than the 8KB body rule allows
        managed('AWSManagedRulesCommonRuleSet', 1, ['SizeRestrictions_BODY']),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 2),
        {
          name: 'RateLimitPerIp',
          priority: 10,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' } },
          visibilityConfig: visibility('RateLimitPerIp'),
        },
        {
          name: 'RateLimitApiWritesPerIp',
          priority: 11,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 300, aggregateKeyType: 'IP', scopeDownStatement: isApiWrite } },
          visibilityConfig: visibility('RateLimitApiWritesPerIp'),
        },
      ],
    });
    this.webAclArn = acl.attrArn;

    // CloudFront WAF metrics only exist in us-east-1, so this alarm lives here with its own topic
    if (props?.alertEmail) {
      const topic = new sns.Topic(this, 'WafAlerts', { displayName: 'Site WAF alerts' });
      topic.addSubscription(new subs.EmailSubscription(props.alertEmail));
      new cw.Alarm(this, 'WafBlockedSpike', {
        alarmDescription: 'WAF is blocking an unusual amount of traffic (possible attack)',
        metric: new cw.Metric({
          namespace: 'AWS/WAFV2',
          metricName: 'BlockedRequests',
          // The metric is keyed by the ACL's generated name: "awswaf:<account>:webacl:<name>:"
          dimensionsMap: { WebACL: cdk.Fn.select(3, cdk.Fn.split(':', acl.attrLabelNamespace)), Rule: 'ALL' },
          statistic: 'Sum',
          period: cdk.Duration.minutes(15),
        }),
        threshold: 500,
        evaluationPeriods: 1,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cwActions.SnsAction(topic));
    }
  }
}
