import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

/** What differs between the sites built from this one codebase */
export interface SiteConfig {
  /** Page title and link-preview name */
  title: string;
  description: string;
  /** Site's own logo files under web/ (replaces assets/logo.png, which is then not shipped) */
  brand?: {
    logo: string;
    /** Browser tab icon: an SVG, or PNGs by size (plus the iOS home-screen icon) */
    mark: string;
    icons?: { png32: string; png192: string; appleTouch: string };
    ogImage: string;
  };
  /** Without a brand: ship a text logo instead of assets/logo.png */
  textLogo?: boolean;
  /** Site name shown until the admin sets one on the admin page */
  defaultSiteName?: string;
  discordClientId: string;
  /** '' = anyone with an old-enough Discord account; otherwise members of this server only */
  discordGuildId: string;
  discordSecretParam: string;
  /** Each site signs its Discord cookies with its own key */
  cookieKeyParam: string;
  /**
   * Domain of the non-deliverable address a Discord account's sign-in name carries, e.g.
   * "@users.example.invalid". Part of every existing account's name: never change it on a live site.
   */
  discordEmailDomain: string;
  /**
   * Shown as 準備中 on this site, beyond the ones closed everywhere (tournaments, gacha,
   * minimum). Features: 'diaries', 'free', 'links', 'medals'. Page elements: 'points', 'friendCode',
   * 'profileFighter' (the voted-character line on the profile edit page).
   */
  closed?: string[];
  /** Cognito sub(s) of the admin(s), comma-separated. A value matching nobody leaves the admin page locked. */
  adminSub: string;
  /** Do not mark the admin with a badge on profiles */
  hideAdminBadge?: boolean;
  /** Before opening: games between admins take no match number and are listed to admins only */
  hideAdminMatches?: boolean;
  /** Matched rooms and their comments can be viewed by anyone (a public board, not private messaging) */
  publicRooms?: boolean;
  /** Keep the site out of search engines (verification environments) */
  noindex?: boolean;
  /** The domain sends and receives no mail (SPF/DMARC/null MX against spoofing) and only Amazon may issue its certificates (CAA) */
  lockedDownDomain?: boolean;
  /** Which set of default page texts the site shows ('sbr' = the public rated-matches site) */
  edition?: string;
  /** Leave unavailable features out of the menus altogether instead of greying them out (準備中) */
  hideClosed?: boolean;
  alertEmail?: string;
  /** Short tag at the start of alert mail subjects, e.g. "[mysite] 管理操作: ..." */
  alertTag?: string;
}

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// Every site serves the same app; only the page shell differs: its name, the link-preview
// tags (crawlers do not run JavaScript, so these must be in the HTML itself) and the logo.
export function renderIndex(site: SiteConfig, siteUrl: string): string {
  let html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  // Fails loudly if the template drifts (a replacement may legitimately be a no-op, so check for
  // the text itself rather than for a change)
  const swap = (from: string | RegExp, to: string) => {
    const found = typeof from === 'string' ? html.includes(from) : from.test(html);
    if (!found) throw new Error(`index.html: no match for ${from}`);
    html = typeof from === 'string' ? html.split(from).join(to) : html.replace(from, to);
  };
  const title = escHtml(site.title);
  const description = escHtml(site.description);
  // The template carries neutral placeholders; every site fills in its own name and address
  swap('<title>Site</title>', `<title>${title}</title>`);
  swap('<meta name="description" content="Site description">', `<meta name="description" content="${description}">`);
  swap('<meta property="og:site_name" content="Site">', `<meta property="og:site_name" content="${title}">`);
  swap('<meta property="og:title" content="Site">', `<meta property="og:title" content="${title}">`);
  swap('<meta property="og:description" content="Site description">', `<meta property="og:description" content="${description}">`);
  swap('<meta property="og:url" content="https://example.com/">', `<meta property="og:url" content="${siteUrl}">`);
  if (site.brand) {
    swap(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${siteUrl}${site.brand.ogImage}">`);
    // The brand preview image is wide (1200x630), so link cards show it large
    swap('<meta name="twitter:card" content="summary">', '<meta name="twitter:card" content="summary_large_image">');
    const ic = site.brand.icons;
    swap('<link rel="icon" href="assets/logo.png">', ic
      ? `<link rel="icon" type="image/png" sizes="32x32" href="${ic.png32}">\n  <link rel="icon" type="image/png" sizes="192x192" href="${ic.png192}">\n  <link rel="apple-touch-icon" href="${ic.appleTouch}">`
      : `<link rel="icon" type="image/svg+xml" href="${site.brand.mark}">`);
    swap(/<a class="logo" href="#\/">[\s\S]*?<\/a>/,
      `<a class="logo" href="#/"><img class="brand-logo" src="${site.brand.logo}" alt="${title}"></a>`);
  } else if (site.textLogo) {
    swap(/\s*<meta property="og:image" content="[^"]*">/, '');
    swap(/\s*<link rel="icon" href="assets\/logo\.png">/, '');
    swap(/<a class="logo" href="#\/">[\s\S]*?<\/a>/, `<a class="logo" href="#/"><span class="logo-text">${title}</span></a>`);
  } else {
    swap('<meta property="og:image" content="https://example.com/assets/logo-mobile.png">',
      `<meta property="og:image" content="${siteUrl}assets/logo-mobile.png">`);
  }
  if (site.defaultSiteName) swap('<html lang="ja">', `<html lang="ja" data-site-name="${escHtml(site.defaultSiteName)}">`);
  if (site.noindex) {
    swap('<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n  <meta name="robots" content="noindex, nofollow">');
  }

  // Grey out the menu entries of features this site has closed (same look as 大会 etc.)
  const NAV: Record<string, string> = { free: '#/free', diaries: '#/diaries', links: '#/links' };
  const off = (label: string) => `<a class="nav-off" aria-disabled="true" title="準備中">${label}</a>`;
  for (const feature of site.closed ?? []) {
    const href = NAV[feature];
    if (!href) continue;
    if (!html.includes(`href="${href}"`)) throw new Error(`index.html: no menu entry for ${href}`);
    // header tabs and the short header link row: keep the label as is
    html = html.replace(new RegExp(`<a href="${href}" data-nav="[^"]*">([^<]*)</a>`, 'g'), (_, l) => off(l));
    html = html.replace(/<nav class="sub-nav">[\s\S]*?<\/nav>/, (block) =>
      block.replace(new RegExp(`<a href="${href}">([^<]*)</a>`, 'g'), (_, l) => off(l)));
    // the slide-in menu has room to say so in words
    html = html.replace(new RegExp(`<a href="${href}">([^<]*)</a>`, 'g'),
      (_, l) => `<a class="nav-off" aria-disabled="true">${l}（準備中）</a>`);
  }
  if (site.hideClosed) {
    // Drop every greyed-out entry (this site's and the ones closed everywhere), and size the
    // header tabs to what is left
    html = html.replace(/\s*<a class="nav-off"[^>]*>[^<]*<\/a>/g, '');
    if (!html.includes('<div class="tabs">')) throw new Error('index.html: no header tabs');
    html = html.replace(/<div class="tabs">([\s\S]*?)<\/div>/, (block, inner: string) =>
      block.replace('<div class="tabs">', `<div class="tabs tabs-n${(inner.match(/<a /g) ?? []).length}">`));
  }
  return html;
}

export interface VersusArenaStackProps extends cdk.StackProps {
  site: SiteConfig;
  /** CloudFront-scoped WAF web ACL (us-east-1) */
  webAclArn: string;
  /** Secret header value CloudFront sends to the API; the API rejects requests without it */
  originSecret: string;
  /** Optional custom domain (apex). www.<domain> and the *.cloudfront.net host redirect to it. */
  domainName?: string;
  hostedZoneId?: string;
  /** us-east-1 ACM certificate covering domainName and www.domainName */
  certificateArn?: string;
}

export class VersusArenaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VersusArenaStackProps) {
    super(scope, id, props);

    // ---------- Data ----------
    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // User data: never destroyed by a stack delete, and protected from a direct DeleteTable
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      globalSecondaryIndexes: [
        // Time-ordered feeds: FREE, TOUR, DIARY, MATCH, GACHA, CONTACT
        {
          indexName: 'gsi1',
          partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
        },
        // Rating ranking (only players with at least one rated match have rankpk)
        {
          indexName: 'rank',
          partitionKey: { name: 'rankpk', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'rating', type: dynamodb.AttributeType.NUMBER },
        },
      ],
    });

    // ---------- Buckets ----------
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    // Profile images (kept separate so site deploys never prune them).
    // User-uploaded content: retained on stack delete, like the table and the user pool.
    const avatarBucket = new s3.Bucket(this, 'AvatarBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      // Versions protect against mistakes, but a replaced or deleted image must not live on:
      // older versions go after 35 days (the same window as the table's point-in-time backups)
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(35), expiredObjectDeleteMarker: true }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // Images attached to inquiries: private, never behind CloudFront. Only the API reads them,
    // for the sender and the operators. Deleting the inquiry deletes them (no versioning).
    const contactBucket = new s3.Bucket(this, 'ContactBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---------- API (served same-origin under /api/* through CloudFront + WAF) ----------
    const api = new HttpApi(this, 'HttpApi', { createDefaultStage: true });
    const stage = api.defaultStage!.node.defaultChild as cdk.aws_apigatewayv2.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 100, throttlingRateLimit: 50 };
    // Access log for abuse investigation. Deliberately no headers, cookies, query strings or
    // request bodies (so session tokens can never end up in the log). IP is personal data:
    // keep it short-lived.
    const apiAccessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    stage.accessLogSettings = {
      destinationArn: apiAccessLogs.logGroupArn,
      format: JSON.stringify({
        t: '$context.requestTime',
        id: '$context.requestId',
        ip: '$context.identity.sourceIp',
        method: '$context.httpMethod',
        path: '$context.path',
        status: '$context.status',
        len: '$context.responseLength',
        ms: '$context.responseLatency',
        err: '$context.integrationErrorMessage',
      }),
    };

    // ---------- Security headers ----------
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          // Everything (pages, API, images) is same-origin: no inline script/style, no third parties
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data: blob:",
            "connect-src 'self'",
            "font-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            'upgrade-insecure-requests',
          ].join('; '),
        },
        strictTransportSecurity: { override: true, accessControlMaxAge: cdk.Duration.days(730), includeSubdomains: true, preload: true },
        frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
        contentTypeOptions: { override: true },
        referrerPolicy: { override: true, referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN },
        xssProtection: { override: true, protection: true, modeBlock: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', override: true },
          { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
          { header: 'Cross-Origin-Resource-Policy', value: 'same-origin', override: true },
        ],
      },
      // Don't advertise the origin (S3 / API Gateway)
      removeHeaders: ['Server', 'x-amz-server-side-encryption', 'x-amz-version-id', 'apigw-requestid'],
    });

    // API: never cached; forward cookies + the few headers the API needs (no Host)
    const apiOriginRequest = new cloudfront.OriginRequestPolicy(this, 'ApiOriginRequest', {
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('Origin', 'X-CSRF-Token', 'Content-Type'),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
    });

    // Custom domain: every other host name (www., *.cloudfront.net) is redirected to the apex.
    // On the apex, a page path typed without the "#" (e.g. /rules) opens that page instead of the
    // bucket's access error, and /favicon.ico is answered with the site's icon.
    const custom = props.domainName && props.certificateArn;
    const favicon = props.site.brand?.icons?.png32;
    const canonicalRedirect = custom
      ? [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: new cloudfront.Function(this, 'CanonicalHost', {
          runtime: cloudfront.FunctionRuntime.JS_2_0,
          code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var req = event.request;
  if (req.headers.host && req.headers.host.value === '${props.domainName}') {
    if (req.uri !== '/' && req.uri.indexOf('.') === -1 && req.uri.indexOf('/api/') !== 0) {
      return { statusCode: 302, statusDescription: 'Found', headers: { location: { value: 'https://${props.domainName}/#' + req.uri } } };
    }${favicon ? `
    if (req.uri === '/favicon.ico') req.uri = '/${favicon}';` : ''}
    return req;
  }
  var qs = Object.keys(req.querystring).map(function (k) { return k + '=' + req.querystring[k].value; }).join('&');
  return { statusCode: 301, statusDescription: 'Moved Permanently',
    headers: { location: { value: 'https://${props.domainName}' + req.uri + (qs ? '?' + qs : '') } } };
}`),
        }),
      }]
      : undefined;

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      webAclId: props.webAclArn,
      ...(custom ? {
        domainNames: [props.domainName!, `www.${props.domainName}`],
        certificate: acm.Certificate.fromCertificateArn(this, 'SiteCert', props.certificateArn!),
        // Only applies with a custom certificate (the default *.cloudfront.net one is fixed)
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      } : {}),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        functionAssociations: canonicalRedirect,
      },
      additionalBehaviors: {
        'avatars/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(avatarBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: securityHeaders,
          functionAssociations: canonicalRedirect,
        },
        'api/*': {
          origin: new origins.HttpOrigin(`${api.apiId}.execute-api.${this.region}.amazonaws.com`, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
            customHeaders: { 'X-Origin-Verify': props.originSecret },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: apiOriginRequest,
          responseHeadersPolicy: securityHeaders,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });
    const siteUrl = custom ? `https://${props.domainName}/` : `https://${distribution.distributionDomainName}/`;

    if (custom && props.hostedZoneId) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: props.domainName! });
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
      for (const [id, name] of [['Apex', props.domainName!], ['Www', `www.${props.domainName}`]]) {
        new route53.ARecord(this, `${id}A`, { zone, recordName: name, target });
        new route53.AaaaRecord(this, `${id}Aaaa`, { zone, recordName: name, target });
      }
      if (props.site.lockedDownDomain) {
        // Nobody may send mail as this domain, it accepts none (RFC 7505 null MX), and certificates
        // for it may only come from Amazon (ACM), never as wildcards
        new route53.TxtRecord(this, 'Spf', { zone, recordName: props.domainName!, values: ['v=spf1 -all'] });
        new route53.TxtRecord(this, 'Dmarc', { zone, recordName: `_dmarc.${props.domainName}`, values: ['v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s'] });
        new route53.MxRecord(this, 'NullMx', { zone, recordName: props.domainName!, values: [{ priority: 0, hostName: '.' }] });
        new route53.CaaRecord(this, 'Caa', {
          zone,
          recordName: props.domainName!,
          values: [
            { flag: 0, tag: route53.CaaTag.ISSUE, value: 'amazon.com' },
            { flag: 0, tag: route53.CaaTag.ISSUEWILD, value: ';' },
          ],
        });
      }
    }

    // ---------- Auth ----------
    const userPool = new cognito.UserPool(this, 'UserPool', {
      // Discord-only: accounts are created server-side; public SignUp is closed
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 8, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // An email change only takes effect after the new address is verified
      keepOriginal: { email: true },
      // Accounts: never destroyed by a stack delete, and protected from a direct DeleteUserPool
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const { discordClientId, discordSecretParam, cookieKeyParam } = props.site;

    // Rejects every sign-up except server-side AdminCreateUser (Discord sign-in), inside Cognito itself
    const preSignUpFn = new lambda.Function(this, 'PreSignUpFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'presignup')),
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
    });
    userPool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, preSignUpFn);

    // No hosted login UI / OAuth: tokens are minted server-side only (ADMIN_USER_PASSWORD_AUTH,
    // IAM-only) and refreshed/revoked through the Cognito API; the browser only holds HttpOnly cookies.
    const client = userPool.addClient('WebClient', {
      generateSecret: false,
      authFlows: { adminUserPassword: true }, // server-side only (legacy e-mail sign-in + Discord sessions)
      disableOAuth: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      idTokenValidity: cdk.Duration.hours(1),
      // 7 days: a member who leaves the Discord server loses access within a week
      // (membership is re-checked whenever they sign in again)
      refreshTokenValidity: cdk.Duration.days(7),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });

    // ---------- API function ----------
    // Who may use the admin page. No default, so a misconfigured deploy locks the admin page
    // rather than handing it to someone.
    const { adminSub, discordEmailDomain } = props.site;
    if (!adminSub) throw new Error('site.adminSub is required (the admin account\'s Cognito sub)');
    if (!/^@[a-z0-9.-]+\.invalid$/.test(discordEmailDomain ?? '')) {
      throw new Error('site.discordEmailDomain must look like "@users.example.invalid" (and never change on a live site)');
    }

    // Cognito operations that can create accounts or mint sessions live here, away from the
    // function that serves anonymous traffic. Not reachable from the internet: only the API
    // function may invoke it, and it accepts a fixed list of operations.
    const privFn = new lambda.Function(this, 'PrivilegedFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'privileged')),
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        CLIENT_ID: client.userPoolClientId,
        DISCORD_EMAIL_DOMAIN: discordEmailDomain,
      },
      logGroup: new logs.LogGroup(this, 'PrivilegedLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    // Session minting for Discord sign-in, plus the admin user-management actions
    userPool.grant(privFn,
      'cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminInitiateAuth',
      'cognito-idp:ListUsers', 'cognito-idp:AdminDeleteUser', 'cognito-idp:AdminResetUserPassword',
      'cognito-idp:AdminDisableUser', 'cognito-idp:AdminEnableUser', 'cognito-idp:AdminUserGlobalSignOut');

    const apiFn = new lambda.Function(this, 'ApiFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'api')),
      memorySize: 512,
      // Ordinary requests finish in well under a second; the season roll-over walks every
      // player, so allow up to just below API Gateway's 30-second limit.
      timeout: cdk.Duration.seconds(29),
      // No reserved concurrency: this account's total Lambda concurrency is 10, which already
      // caps the blast radius if someone floods the API by hitting execute-api directly.
      // If that account quota is ever raised, set a reservation here to keep the cap.
      environment: {
        TABLE_NAME: table.tableName,
        AVATAR_BUCKET: avatarBucket.bucketName,
        CONTACT_BUCKET: contactBucket.bucketName,
        SITE_URL: siteUrl,
        USER_POOL_ID: userPool.userPoolId,
        CLIENT_ID: client.userPoolClientId,
        ORIGIN_SECRET: props.originSecret,
        // Discord sign-in: client ID via context, client secret in SSM (SecureString), never in code
        DISCORD_CLIENT_ID: discordClientId,
        // Members-only: sign-in requires membership of this Discord server ('' = anyone)
        DISCORD_GUILD_ID: props.site.discordGuildId,
        CLOSED_FEATURES: (props.site.closed ?? []).join(','),
        DISCORD_SECRET_PARAM: discordSecretParam,
        // Signs the short-lived Discord cookies. Separate from ORIGIN_SECRET on purpose:
        // that one is a transport marker, this one can mint sessions.
        COOKIE_KEY_PARAM: cookieKeyParam,
        PRIV_FUNCTION: privFn.functionName,
        // Only these Cognito users (subs, comma-separated) can use the admin page
        ADMIN_SUB: adminSub,
        HIDE_ADMIN_BADGE: props.site.hideAdminBadge ? '1' : '',
        HIDE_ADMIN_MATCHES: props.site.hideAdminMatches ? '1' : '',
        PUBLIC_ROOMS: props.site.publicRooms ? '1' : '',
        DISCORD_EMAIL_DOMAIN: discordEmailDomain,
        ALERT_TAG: props.site.alertTag ?? 'site',
      },
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    // Only the operations the function actually performs (no Scan, no BatchWriteItem)
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
        'dynamodb:DeleteItem', 'dynamodb:TransactWriteItems', 'dynamodb:ConditionCheckItem'],
      resources: [table.tableArn, `${table.tableArn}/index/*`],
    }));
    avatarBucket.grantPut(apiFn, 'avatars/*');
    avatarBucket.grantDelete(apiFn, 'avatars/*'); // account deletion removes the public image
    contactBucket.grantPut(apiFn, 'contact/*');
    contactBucket.grantRead(apiFn, 'contact/*');
    contactBucket.grantDelete(apiFn, 'contact/*');
    // Read the Discord client secret (SecureString with the AWS-managed SSM key)
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${discordSecretParam}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter${cookieKeyParam}`,
      ],
    }));
    // The public function holds no Cognito permissions of its own: it asks the privileged
    // function instead, and that one decides what it is willing to do.
    privFn.grantInvoke(apiFn);

    // Authentication/authorization is enforced in the function (cookie session + CSRF + origin secret)
    api.addRoutes({
      path: '/api/{proxy+}',
      methods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.PUT, HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('ApiIntegration', apiFn),
    });

    // ---------- Deploy frontend + runtime config ----------
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      destinationBucket: siteBucket,
      sources: [
        // A site with its own logo does not host the original image logo at all (not merely
        // leave it unreferenced), and other sites do not carry its brand files either
        s3deploy.Source.asset(path.join(__dirname, '..', 'web'), {
          exclude: props.site.brand || props.site.textLogo
            ? ['index.html', 'assets/logo.png', 'assets/logo-mobile.png']
            : ['index.html', 'assets/brand/*'],
        }),
        s3deploy.Source.data('index.html', renderIndex(props.site, siteUrl)),
        // Where to report a security problem (RFC 9116), pointing at this site's own pages
        s3deploy.Source.data('.well-known/security.txt', [
          `Contact: ${siteUrl}#/contact`,
          'Expires: 2027-10-26T00:00:00Z',
          'Preferred-Languages: ja, en',
          `Policy: ${siteUrl}#/terms`,
          '',
        ].join('\n')),
        // Crawlers may read everything, except on a site kept out of search engines
        s3deploy.Source.data('robots.txt', `User-agent: *\n${props.site.noindex ? 'Disallow: /' : 'Allow: /'}\n`),
        s3deploy.Source.jsonData('config.json', {
          discordEnabled: Boolean(discordClientId),
          // The sign-in page says whether Discord server membership is checked
          guildOnly: Boolean(props.site.discordGuildId),
          edition: props.site.edition ?? '',
          publicRooms: Boolean(props.site.publicRooms),
          closed: ['tournaments', 'gacha', 'minimum', ...(props.site.closed ?? [])],
        }),
      ],
      distribution,
      distributionPaths: ['/*'],
      // Browsers must revalidate (ETag) so a deploy is visible immediately
      cacheControl: [s3deploy.CacheControl.noCache()],
    });

    // ---------- Alerting ----------
    // One topic, one confirmed e-mail subscription; every alarm below notifies it.
    const alertEmail: string = props.site.alertEmail ?? '';
    if (alertEmail) {
      const topic = new sns.Topic(this, 'Alerts', { displayName: 'Site alerts' });
      topic.addSubscription(new subs.EmailSubscription(alertEmail));
      const action = new cwActions.SnsAction(topic);
      const alarm = (id: string, description: string, metric: cw.Metric, threshold: number) => {
        new cw.Alarm(this, id, {
          alarmDescription: description,
          metric,
          threshold,
          evaluationPeriods: 1,
          comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        }).addAlarmAction(action);
      };
      const fiveMin = { period: cdk.Duration.minutes(5), statistic: 'Sum' };
      // Something is broken: unhandled errors, or Lambda refusing work
      alarm('ApiErrors', 'API function is throwing errors', apiFn.metricErrors(fiveMin), 5);
      alarm('ApiThrottles', 'API function is being throttled (traffic beyond capacity)', apiFn.metricThrottles(fiveMin), 0);
      alarm('Api5xx', 'API gateway is returning 5xx responses', new cw.Metric({
        namespace: 'AWS/ApiGateway', metricName: '5xx', dimensionsMap: { ApiId: api.apiId }, ...fiveMin,
      }), 5);
      // Traffic far above anything the site produces normally (~1k/hour at peak)
      alarm('TrafficSpike', 'Unusual request volume (possible abuse or runaway polling)', apiFn.metricInvocations({
        period: cdk.Duration.hours(1), statistic: 'Sum',
      }), 20000);
      // Writes being rejected by DynamoDB would silently lose user actions
      alarm('TableThrottles', 'DynamoDB requests are being throttled', new cw.Metric({
        namespace: 'AWS/DynamoDB', metricName: 'ThrottledRequests', dimensionsMap: { TableName: table.tableName }, ...fiveMin,
      }), 0);
      // Admin actions mail the same address, so a compromised admin account is noticed
      // immediately rather than only being discoverable in the audit trail afterwards.
      apiFn.addEnvironment('ALERT_TOPIC_ARN', topic.topicArn);
      topic.grantPublish(apiFn);
      new cdk.CfnOutput(this, 'AlertTopic', { value: topic.topicArn });
    }

    new cdk.CfnOutput(this, 'SiteUrl', { value: siteUrl });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
