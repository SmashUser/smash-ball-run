#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as cdk from 'aws-cdk-lib';
import { VersusArenaStack, SiteConfig } from '../lib/versus-arena-stack';
import { VersusArenaWafStack } from '../lib/waf-stack';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1';
const ctx = (key: string) => app.node.tryGetContext(key);

// Shared secret CloudFront sends to the API origin; the API rejects requests without it.
// One per site, generated once and kept locally (git-ignored) so deploys don't rotate it.
function originSecret(file: string): string {
  const p = path.join(__dirname, '..', file);
  if (!fs.existsSync(p)) fs.writeFileSync(p, crypto.randomBytes(32).toString('base64url'), { mode: 0o600 });
  return fs.readFileSync(p, 'utf8').trim();
}

interface SiteDef {
  stackId: string;
  /** Its own WAF stack, or "wafFrom": the stackId of a site whose WAF it shares */
  wafStackId?: string;
  wafFrom?: string;
  secretFile: string;
  domainName?: string;
  hostedZoneId?: string;
  /** Stacks that serve real players cannot be deleted by accident (CloudFormation termination protection) */
  protect?: boolean;
  site: SiteConfig;
}

// Part of every existing account's sign-in name: set once in cdk.json, never changed afterwards
const discordEmailDomain: string = ctx('discordEmailDomain') ?? '';
const pub = ctx('public') ?? {};

const sites: SiteDef[] = [
  // Public site: open to anyone with an old-enough Discord account
  {
    stackId: 'Smashballrun',
    wafStackId: 'SmashballrunWaf',
    secretFile: '.origin-secret-public',
    protect: true,
    domainName: pub.domainName || undefined,
    hostedZoneId: pub.hostedZoneId || undefined,
    site: sbrSite(),
  },
  // Verification environment for the public site: the same code and settings, its own data and
  // sign-in pool, so automated checks never touch real players. It shares the public site's WAF
  // (no extra cost) and stays out of search engines. Tests may swap its ADMIN_SUB freely.
  {
    stackId: 'SmashballrunStg',
    wafFrom: 'Smashballrun',
    secretFile: '.origin-secret-stg',
    site: {
      ...sbrSite(),
      title: 'Smash・Ball・Run 検証環境',
      description: 'Smash・Ball・Run の検証環境です。',
      defaultSiteName: 'SBR検証環境',
      // Shares the public site's Discord application and cookie key; sign-up markers are single-use
      // rows in each site's own table, so a cookie from one site is useless on the other
      adminSub: 'unset-staging',
      // Behaves like the site after opening
      hideAdminMatches: false,
      noindex: true,
      // Test traffic only: the default capacity
      apiRequestsPerSecond: undefined,
      apiConcurrency: undefined,
      alertEmail: undefined,
      alertTag: 'smashballrun-stg',
    },
  },
];

// The public site's configuration (its verification environment starts from the same one)
function sbrSite(): SiteConfig {
  return {
    title: pub.title ?? 'Smash・Ball・Run',
    description: pub.description ?? '',
    brand: {
      logo: 'assets/brand/smashballrun-logo.svg',
      mark: 'assets/brand/smashballrun-mark.svg',
      // The round SBR emblem
      icons: { png32: 'assets/brand/sbr-icon-32.png', png192: 'assets/brand/sbr-icon-192.png', appleTouch: 'assets/brand/sbr-apple-touch.png' },
      // A new file name so services that cached the old preview pick this one up
      ogImage: 'assets/brand/smashballrun-og2.png',
    },
    defaultSiteName: pub.title ?? 'Smash・Ball・Run',
    // A rated-matches-only revival: everything else stays 準備中 for now
    closed: ['diaries', 'free', 'links', 'medals', 'points', 'friendCode', 'profileFighter'],
    // The site's own Discord application (its name is what the consent screen shows)
    discordClientId: pub.discordClientId ?? '',
    discordGuildId: pub.discordGuildId ?? '',
    discordSecretParam: '/smashballrun/discord-client-secret',
    cookieKeyParam: '/smashballrun/cookie-signing-key',
    // The site's own sign-in domain; accounts made under an earlier one keep working
    discordEmailDomain: pub.discordEmailDomain ?? discordEmailDomain,
    legacyDiscordEmailDomains: pub.legacyDiscordEmailDomains ?? [],
    adminSub: pub.adminSub ?? '',
    hideAdminBadge: true,
    // Until the site opens; set "hideAdminMatches": false in cdk.json at release
    hideAdminMatches: pub.hideAdminMatches ?? true,
    edition: 'sbr',
    hideClosed: true,
    // Rooms are open to view, so room comments are a public board rather than private messages
    publicRooms: true,
    lockedDownDomain: true,
    // Launch-day headroom: about 600 players polling at once (see versus-arena-stack.ts)
    apiRequestsPerSecond: 150,
    apiConcurrency: 100,
    alertEmail: pub.alertEmail ?? ctx('alertEmail'),
    alertTag: 'smashballrun',
  };
}

const wafs = new Map<string, VersusArenaWafStack>();
for (const s of sites) {
  const shared = s.wafFrom ? wafs.get(s.wafFrom) : undefined;
  if (s.wafFrom && !shared) throw new Error(`${s.stackId}: no site "${s.wafFrom}" to share a WAF with`);
  const waf = shared ?? new VersusArenaWafStack(app, s.wafStackId!, {
    env: { account, region: 'us-east-1' },
    crossRegionReferences: true,
    domainName: s.domainName,
    hostedZoneId: s.hostedZoneId,
    alertEmail: s.site.alertEmail,
    terminationProtection: s.protect,
  });
  wafs.set(s.stackId, waf);
  new VersusArenaStack(app, s.stackId, {
    env: { account, region },
    crossRegionReferences: true,
    terminationProtection: s.protect,
    site: s.site,
    webAclArn: waf.webAclArn,
    originSecret: originSecret(s.secretFile),
    domainName: s.domainName,
    hostedZoneId: s.hostedZoneId,
    // A shared WAF stack's certificate belongs to the other site's domain
    certificateArn: shared ? undefined : waf.certificateArn,
  });
}
