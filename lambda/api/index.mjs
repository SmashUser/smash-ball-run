// Versus Arena API: a single Lambda function behind an HTTP API.
// Uses only the AWS SDK v3 bundled with the Node.js Lambda runtime (no build step).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RevokeTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { randomUUID, randomBytes, randomInt, createHash, createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

// Admin-level Cognito work runs in a separate function with its own role; this one cannot
// create users, set passwords or mint sessions by itself.
const lambdaClient = new LambdaClient({});
const PRIV_FUNCTION = process.env.PRIV_FUNCTION;
async function priv(op, args = {}) {
  const r = await lambdaClient.send(new InvokeCommand({
    FunctionName: PRIV_FUNCTION,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify({ op, args })),
  }));
  const out = r.Payload ? JSON.parse(Buffer.from(r.Payload).toString('utf8') || 'null') : null;
  if (r.FunctionError || !out) throw new Error(`privileged call failed: ${op}`);
  if (!out.ok) {
    const e = new Error(out.message);
    e.name = out.name;
    throw e;
  }
  return out.result;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = process.env.TABLE_NAME;

const INITIAL_RATING = 1500;
const ELO_K = 32;
const FREE_ROOM_OPEN_MS = 3 * 3600_000; // recruiting window
const FREE_ROOM_TTL_SEC = 48 * 3600; // kept visible in the list as finished
const MESSAGE_TTL_SEC = 7 * 86400;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const nowMs = () => Date.now();
const nowIso = () => new Date().toISOString();
const epoch = () => Math.floor(Date.now() / 1000);
const shortId = () => `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  },
  body: JSON.stringify(body),
});

// Sign-in endpoints run before any session exists, so they are throttled per source IP.
// Without this, repeated Discord callbacks can exhaust pool-wide Cognito quotas and lock
// everyone out of signing in.
// Mobile carriers put many people behind one address, so the general budget is generous;
// only the endpoint that writes to Cognito (and so can drain pool-wide quotas) is tight.
const AUTH_LIMIT_PER_MIN = 60;
const AUTH_COMPLETE_LIMIT_PER_MIN = 10;
async function throttleAuth(event, path) {
  const ip = event.requestContext?.http?.sourceIp ?? 'unknown';
  const minute = Math.floor(Date.now() / 60000);
  const heavy = path === '/api/auth/discord/complete';
  const limit = heavy ? AUTH_COMPLETE_LIMIT_PER_MIN : AUTH_LIMIT_PER_MIN;
  const r = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `RATEIP#${ip}${heavy ? '#complete' : ''}`, sk: String(minute) },
    UpdateExpression: 'ADD n :one SET #t = :ttl',
    ExpressionAttributeNames: { '#t': 'ttl' },
    ExpressionAttributeValues: { ':one': 1, ':ttl': epoch() + 120 },
    ReturnValues: 'UPDATED_NEW',
  }));
  if (r.Attributes.n > limit) throw new HttpError(429, 'アクセスが多すぎます。しばらく待ってから再度お試しください');
}

// Per-user write throttle (on top of the API Gateway stage limits)
const WRITE_LIMIT_PER_MIN = 60;
async function throttleWrites(ctx) {
  if (ctx.method === 'GET' || !ctx.claims?.sub) return;
  const minute = Math.floor(Date.now() / 60000);
  const r = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `RATE#${ctx.claims.sub}`, sk: String(minute) },
    UpdateExpression: 'ADD n :one SET #t = :ttl',
    ExpressionAttributeNames: { '#t': 'ttl' },
    ExpressionAttributeValues: { ':one': 1, ':ttl': epoch() + 120 },
    ReturnValues: 'UPDATED_NEW',
  }));
  if (r.Attributes.n > WRITE_LIMIT_PER_MIN) throw new HttpError(429, '操作が多すぎます。しばらく待ってから再度お試しください');
}

// ---------- DynamoDB helpers ----------
const get = async (pk, sk) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk, sk } }))).Item;
const put = (Item, ConditionExpression) => ddb.send(new PutCommand({ TableName: TABLE, Item, ConditionExpression }));
const del = (pk, sk) => ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk } }));
const transact = (TransactItems) =>
  ddb.send(new TransactWriteCommand({ TransactItems: TransactItems.map((t) => withTable(t)) }));
const withTable = (t) => {
  const [k] = Object.keys(t);
  return { [k]: { TableName: TABLE, ...t[k] } };
};
async function query(params) {
  const r = await ddb.send(new QueryCommand({ TableName: TABLE, ...params }));
  return r.Items ?? [];
}

// Sequential display numbers (match / room numbers)
async function nextNumber(name) {
  const r = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: 'COUNTER', sk: name },
      UpdateExpression: 'ADD n :one',
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return r.Attributes.n;
}

const strip = (item) => {
  if (!item) return item;
  const { pk, sk, rankpk, gsi1pk, gsi1sk, ttl, ...rest } = item;
  return rest;
};

// ---------- Validation ----------
function text(value, { name, max, min = 1, optional = false }) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) {
    if (optional) return '';
    throw new HttpError(400, `${name}を入力してください`);
  }
  if (v.length < min || v.length > max) throw new HttpError(400, `${name}は${min}〜${max}文字で入力してください`);
  return v;
}
function int(value, { name, min, max }) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name}は${min}〜${max}で指定してください`);
  return n;
}

// ---------- Users ----------
function requireUser(ctx) {
  if (!ctx.claims?.sub) throw new HttpError(401, 'ログインが必要です');
  return ctx.claims.sub;
}
const getProfile = (uid) => get(`USER#${uid}`, 'PROFILE');

// Search key for a player name: full/half width, upper/lower case and katakana/hiragana
// all compare equal, and spaces are ignored ("ヒカリ" finds "ひかり").
function nameKey(name) {
  return String(name ?? '').normalize('NFKC').toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, '');
}

// Numbers count real members only: accounts made through Discord sign-in. The admin and
// hand-made accounts (test accounts) get member number 0, which is never shown, and a room
// with no Discord account in it gets no match number.
const isDiscordAccount = (ctx) => isDiscordEmail(ctx.claims?.email);
const takesMemberNo = (ctx) => isDiscordAccount(ctx) && !isAdminSub(ctx.claims.sub);
// Accounts the operator creates by hand for automated checks (e-mail @example.com). They only
// ever match each other, and their rooms are listed only to them, so a check run on the live
// site never lands in a real player's room or clutters the public list.
const isTestAccount = (ctx) => /@example\.com$/i.test(String(ctx.claims?.email ?? ''));
// Before the site opens (HIDE_ADMIN_MATCHES), games between admins are rehearsals: they take no
// match number and the room list shows them to admins only
const HIDE_ADMIN_MATCHES = process.env.HIDE_ADMIN_MATCHES === '1';
const rehearsing = (sub) => HIDE_ADMIN_MATCHES && isAdminSub(sub);

async function ensureProfile(ctx) {
  const uid = requireUser(ctx);
  const existing = await getProfile(uid);
  if (existing) {
    // Profiles created before member numbers existed get one on first visit
    if (existing.memberNo == null) {
      const memberNo = takesMemberNo(ctx) ? await nextNumber('USER') : 0;
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { pk: existing.pk, sk: 'PROFILE' },
        UpdateExpression: 'SET memberNo = if_not_exists(memberNo, :m)',
        ExpressionAttributeValues: { ':m': memberNo },
      }));
      return getProfile(uid);
    }
    return existing;
  }
  const fallback = (ctx.claims.name || String(ctx.claims.email || 'player').split('@')[0]).slice(0, 20);
  const profile = {
    pk: `USER#${uid}`,
    sk: 'PROFILE',
    userId: uid,
    name: fallback || 'player',
    fighter: '',
    bio: '',
    rating: INITIAL_RATING,
    maxRating: INITIAL_RATING,
    wins: 0,
    losses: 0,
    rejectStages: [],
    rejectByFighter: {},
    points: 0,
    allowIntro: true,
    preComment: 'よろしくお願いします',
    postComment: 'ありがとうございました',
    createdAt: nowIso(),
  };
  // listed for player search
  Object.assign(profile, { gsi1pk: 'USER', gsi1sk: profile.createdAt, nameKey: nameKey(profile.name) });
  // Test accounts stay out of the ranking and search for real players
  if (isTestAccount(ctx)) profile.test = true;
  try {
    profile.memberNo = takesMemberNo(ctx) ? await nextNumber('USER') : 0;
    await put(profile, 'attribute_not_exists(pk)');
    return profile;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return getProfile(uid);
    throw e;
  }
}

const publicUser = (p) =>
  p && {
    userId: p.userId,
    name: p.name,
    fighter: p.fighter,
    bio: p.bio,
    rating: p.rating,
    maxRating: p.maxRating ?? p.rating,
    wins: p.wins,
    losses: p.losses,
    memberNo: p.memberNo,
    // Shown as a badge beside the name, so players can tell who runs the site (unless the site hides it)
    admin: !HIDE_ADMIN_BADGE && isAdminSub(p.userId),
    symbol: p.symbol ?? '',
    avatarV: p.avatarV ?? 0,
    allowIntro: p.allowIntro !== false,
    allowVideo: p.allowVideo === true,
    twitterId: p.twitterId ?? '',
    showRate: p.showRate !== false,
    ...matchPrefs(p),
    preComment: p.preComment ?? '',
    postComment: p.postComment ?? '',
    createdAt: p.createdAt,
  };
// Matchmaking preferences (rated battles)
//   rematch: allow / deny playing the same opponent twice in a row
//   conn:    wired / wired-deny (wired, refuses wireless opponents) / wireless
//   stream:  no / no-deny (refuses streamers) / yes
//   account: main / main-deny (refuses sub accounts) / sub
const PREF_VALUES = {
  rematch: ['allow', 'deny'],
  conn: ['wired', 'wired-deny', 'wireless'],
  stream: ['no', 'no-deny', 'yes'],
  account: ['main-deny', 'main', 'sub'],
};
function matchPrefs(p) {
  const pick = (k, d) => (PREF_VALUES[k].includes(p?.[k]) ? p[k] : d);
  return { rematch: pick('rematch', 'allow'), conn: pick('conn', 'wired'), stream: pick('stream', 'no'), account: pick('account', 'main-deny') };
}
function compatible(a, b) {
  const pa = matchPrefs(a);
  const pb = matchPrefs(b);
  if ((pa.conn === 'wired-deny' && pb.conn === 'wireless') || (pb.conn === 'wired-deny' && pa.conn === 'wireless')) return false;
  if ((pa.stream === 'no-deny' && pb.stream === 'yes') || (pb.stream === 'no-deny' && pa.stream === 'yes')) return false;
  if ((pa.account === 'main-deny' && pb.account === 'sub') || (pb.account === 'main-deny' && pa.account === 'sub')) return false;
  const consecutive = a.lastOpponentId === b.userId || b.lastOpponentId === a.userId;
  if (consecutive && (pa.rematch === 'deny' || pb.rematch === 'deny')) return false;
  return true;
}

// Fields only the owner sees (reject stages reach opponents through the match room only)
const privateUser = (p) => ({ ...publicUser(p), rejectStages: p.rejectStages ?? [], rejectByFighter: p.rejectByFighter ?? {}, friendCode: p.friendCode ?? '', points: p.points ?? 0, lastRoomId: p.lastRoomId ?? '', lastFighter: p.lastFighter ?? '', switches: p.switches ?? {} });

// The roster is fixed: anything else would end up in opponents' permanent match history
const FIGHTERS = ['マリオ', 'ドンキーコング', 'リンク', 'サムス', 'ダークサムス', 'ヨッシー', 'カービィ', 'フォックス', 'ピカチュウ', 'ルイージ', 'ネス', 'キャプテン・ファルコン', 'プリン', 'ピーチ', 'デイジー', 'クッパ', 'アイスクライマー', 'シーク', 'ゼルダ', 'ドクターマリオ', 'ピチュー', 'ファルコ', 'マルス', 'ルキナ', 'こどもリンク', 'ガノンドロフ', 'ミュウツー', 'ロイ', 'クロム', 'Mr.ゲーム&ウォッチ', 'メタナイト', 'ピット', 'ブラックピット', 'ゼロスーツサムス', 'ワリオ', 'スネーク', 'アイク', 'ポケモントレーナー', 'ディディーコング', 'リュカ', 'ソニック', 'デデデ', 'ピクミン&オリマー', 'ルカリオ', 'ロボット', 'トゥーンリンク', 'ウルフ', 'むらびと', 'ロックマン', 'Wii Fit トレーナー', 'ロゼッタ&チコ', 'リトル・マック', 'ゲッコウガ', 'Miiファイター', 'パルテナ', 'パックマン', 'ルフレ', 'シュルク', 'クッパJr.', 'ダックハント', 'リュウ', 'ケン', 'クラウド', 'カムイ', 'ベヨネッタ', 'インクリング', 'リドリー', 'シモン', 'リヒター', 'キングクルール', 'しずえ', 'ガオガエン', 'パックンフラワー', 'ジョーカー', '勇者', 'バンジョー&カズーイ', 'テリー', 'ベレト/ベレス', 'ミェンミェン', 'スティーブ/アレックス', 'セフィロス', 'ホムラ/ヒカリ', 'カズヤ', 'ソラ'];
const fighterOf = (v, { optional = false } = {}) => {
  const s = String(v ?? '').trim();
  if (!s) {
    if (optional) return '';
    throw new HttpError(400, 'キャラクターを選択してください');
  }
  if (!FIGHTERS.includes(s)) throw new HttpError(400, 'キャラクターの指定が不正です');
  return s;
};

const STAGES = ['終点', '戦場', 'ポケモンスタジアム2', '小戦場', 'ホロウバスティオン', '村と街', 'すま村'];
const MAX_REJECT = 2;

function cleanStages(list) {
  const stages = Array.isArray(list) ? [...new Set(list)] : [];
  if (stages.length > MAX_REJECT || stages.some((s) => !STAGES.includes(s))) {
    throw new HttpError(400, `拒否ステージは1キャラにつき${MAX_REJECT}つまで選択できます`);
  }
  return stages;
}

// Default reject stages + optional per-opponent-fighter overrides
async function updateStages(ctx) {
  const p = await ensureProfile(ctx);
  const stages = cleanStages(ctx.body.rejectStages);
  const byFighter = {};
  const raw = ctx.body.rejectByFighter && typeof ctx.body.rejectByFighter === 'object' ? ctx.body.rejectByFighter : {};
  const keys = Object.keys(raw);
  if (keys.length > 120) throw new HttpError(400, '設定が多すぎます');
  for (const k of keys) {
    if (typeof k !== 'string' || k.length > 40) continue;
    const s = cleanStages(raw[k]);
    if (s.length) byFighter[k] = s;
  }
  const r = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: p.pk, sk: 'PROFILE' },
      UpdateExpression: 'SET rejectStages = :s, rejectByFighter = :b',
      ExpressionAttributeValues: { ':s': stages, ':b': byFighter },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return privateUser(r.Attributes);
}

// Admins = the Cognito users listed in ADMIN_SUB, comma-separated (checked from the verified
// ID token; e-mail is not kept after Discord linking)
const ADMIN_SUBS = (process.env.ADMIN_SUB || '').split(',').map((s) => s.trim()).filter(Boolean);
const isAdminSub = (sub) => Boolean(sub) && ADMIN_SUBS.includes(sub);
const HIDE_ADMIN_BADGE = process.env.HIDE_ADMIN_BADGE === '1';
function isAdmin(ctx) {
  return isAdminSub(ctx.claims?.sub);
}
// Admin actions are written to an append-only trail so a compromised admin account
// leaves evidence of exactly what it touched. Kept for a year.
async function audit(ctx, action, detail = {}) {
  const at = nowIso();
  const who = await getProfile(ctx.claims.sub).catch(() => null);
  await put({
    pk: `AUDIT#${at}#${shortId()}`,
    sk: 'META',
    gsi1pk: 'AUDIT',
    gsi1sk: at,
    action,
    at,
    by: ctx.claims.sub,
    byName: who?.name ?? '',
    ...detail,
    ttl: epoch() + 365 * 86400,
  });
  // Best effort: the trail is the record, the mail is just the heads-up
  if (ALERT_TOPIC_ARN) {
    const lines = Object.entries(detail).map(([k, v]) => `${k}: ${v}`).join('\n');
    await sns.send(new PublishCommand({
      TopicArn: ALERT_TOPIC_ARN,
      Subject: `[${ALERT_TAG}] 管理操作: ${action}`,
      Message: `操作: ${action}\n実行者: ${who?.name ?? ''} (${ctx.claims.sub})\n日時: ${at}\n${lines}\n\n身に覚えがない場合は、Discordのパスワードと2要素認証をすぐに確認してください。`,
    })).catch(() => {});
  }
}

async function adminListAudit(ctx) {
  requireAdmin(ctx);
  const items = await query({
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': 'AUDIT' },
    ScanIndexForward: false,
    Limit: 200,
  });
  return { entries: items.map(strip) };
}

function requireAdmin(ctx) {
  requireUser(ctx);
  if (!isAdmin(ctx)) throw new HttpError(403, '管理者のみ利用できます');
}

async function getMe(ctx) {
  const p = await ensureProfile(ctx);
  const [current, mismatches, unreadReplies] = await Promise.all([
    activeCurrent(p.userId),
    query({ KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': p.pk, ':s': 'MISMATCH#' } }),
    query({ KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', FilterExpression: 'unread = :t', ExpressionAttributeValues: { ':p': p.pk, ':s': 'CONTACT#', ':t': true } }),
  ]);
  return {
    ...privateUser(p),
    currentMatchId: current?.matchId ?? null,
    // Rooms whose two reports disagree (shown on the owner's profile until resolved)
    mismatches: mismatches.map(({ matchId, matchNo }) => ({ matchId, matchNo: matchNo ?? null })),
    // Inquiries with a reply the player has not opened yet
    unreadReplies: unreadReplies.length,
    isAdmin: isAdmin(ctx),
    discordLinked: Boolean(p.discordId),
  };
}

// ---------- Site settings (editable from the admin page) ----------
const DOC_KEYS = ['about', 'terms', 'rules', 'faq', 'privacy', 'security', 'contact', 'links'];

async function getSite() {
  const s = await get('SITE', 'CONFIG');
  if (!s) return { site: null };
  const { updatedBy, ...site } = strip(s); // never expose who edited it
  return { site };
}

async function updateSite(ctx) {
  requireAdmin(ctx);
  const b = ctx.body;
  const site = {
    siteName: text(b.siteName, { name: 'サイト名', max: 40 }),
    homeIntro: text(b.homeIntro, { name: 'トップページ紹介文', max: 3000, optional: true }),
    footer: text(b.footer, { name: 'フッター文', max: 1000, optional: true }),
    notices: [],
    docs: {},
  };
  const notices = Array.isArray(b.notices) ? b.notices : [];
  if (notices.length > 20) throw new HttpError(400, 'お知らせは20件までです');
  site.notices = notices.map((n, i) => ({
    id: /^[\w-]{1,40}$/.test(n?.id) ? n.id : `n${Date.now().toString(36)}${i}`,
    at: text(n?.at, { name: 'お知らせの日付', max: 20 }),
    title: text(n?.title, { name: 'お知らせのタイトル', max: 100 }),
    body: text(n?.body, { name: 'お知らせの本文', max: 5000, optional: true }),
  }));
  for (const key of DOC_KEYS) {
    const d = b.docs?.[key];
    if (!d) continue;
    const sections = Array.isArray(d.sections) ? d.sections : [];
    if (sections.length > 30) throw new HttpError(400, '1ページの見出しは30個までです');
    site.docs[key] = {
      title: text(d.title, { name: 'ページタイトル', max: 40 }),
      lead: text(d.lead, { name: '冒頭文', max: 5000, optional: true }),
      sections: sections.map((s) => ({
        h: text(s?.h, { name: '見出し', max: 60 }),
        html: text(s?.html, { name: '本文', max: 20000, optional: true }),
      })),
    };
  }
  if (Buffer.byteLength(JSON.stringify(site)) > 350_000) throw new HttpError(400, '内容が大きすぎます');
  await put({ pk: 'SITE', sk: 'CONFIG', ...site, updatedAt: nowIso(), updatedBy: ctx.claims.sub });
  await audit(ctx, 'site.update', { siteName: site.siteName, notices: site.notices.length, docs: Object.keys(site.docs).join(',') });
  return { site: { ...site, updatedAt: nowIso() } };
}

async function updateMe(ctx) {
  const p = await ensureProfile(ctx);
  const name = text(ctx.body.name, { name: 'プレイヤー名', max: 20 });
  const bio = text(ctx.body.bio, { name: '自己紹介', max: 1000, optional: true });
  const friendCode = text(ctx.body.friendCode, { name: 'フレンドコード', max: 14, optional: true });
  if (friendCode && !/^\d{4}-\d{4}-\d{4}$/.test(friendCode)) throw new HttpError(400, 'フレンドコードは「XXXX-XXXX-XXXX」の形式で入力してください');
  const preComment = text(ctx.body.preComment, { name: '対戦前のコメント', max: 40, optional: true });
  const postComment = text(ctx.body.postComment, { name: '対戦後のコメント', max: 40, optional: true });
  const allowIntro = ctx.body.allowIntro !== false && ctx.body.allowIntro !== 'false';
  const allowVideo = ctx.body.allowVideo === true || ctx.body.allowVideo === 'true';
  const showRate = ctx.body.showRate !== false && ctx.body.showRate !== 'false';
  const prefs = matchPrefs(ctx.body);
  const twitterId = String(ctx.body.twitterId ?? '').trim().replace(/^@/, '');
  if (twitterId && !/^[A-Za-z0-9_]{1,15}$/.test(twitterId)) throw new HttpError(400, 'TwitterのユーザーIDは英数字と_の15文字以内で入力してください（@は不要です）');
  const symbol = text(ctx.body.symbol, { name: 'シンボル', max: 40, optional: true });
  if (symbol) {
    const owned = await get(p.pk, `SYMBOL#${symbol}`);
    if (!owned) throw new HttpError(400, '持っていないシンボルは設定できません');
  }
  const r = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: p.pk, sk: 'PROFILE' },
      // Attribute names via placeholders: several of these (e.g. "stream") are DynamoDB reserved words
      // (fighter is not set here: it comes from opponents' votes, see refreshVotedFighter)
      UpdateExpression: 'SET nameKey = :nk, gsi1pk = :ug, gsi1sk = if_not_exists(gsi1sk, :now), #n = :n, bio = :b, friendCode = :fc, preComment = :pre, postComment = :post, allowIntro = :ai, symbol = :sy, #av = :av, #sr = :sr, #rm = :rm, #cn = :cn, #st = :st, #ac = :ac, #tw = :tw',
      ExpressionAttributeNames: { '#n': 'name', '#av': 'allowVideo', '#sr': 'showRate', '#rm': 'rematch', '#cn': 'conn', '#st': 'stream', '#ac': 'account', '#tw': 'twitterId' },
      ExpressionAttributeValues: {
        ':nk': nameKey(name), ':ug': 'USER', ':now': nowIso(), ':n': name, ':b': bio, ':fc': friendCode, ':pre': preComment, ':post': postComment, ':ai': allowIntro, ':sy': symbol,
        ':av': allowVideo, ':sr': showRate, ':rm': prefs.rematch, ':cn': prefs.conn, ':st': prefs.stream, ':ac': prefs.account, ':tw': twitterId,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return privateUser(r.Attributes);
}

async function getUser(ctx, uid) {
  const p = await getProfile(uid);
  if (!p) throw new HttpError(404, 'プレイヤーが見つかりません');
  const [history, diaries, introCount, medals] = await Promise.all([
    query({
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': `USER#${uid}`, ':s': 'HIST#' },
      ScanIndexForward: false,
      Limit: 300,
    }),
    query({
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': `USER#${uid}`, ':s': 'DIARY#' },
      ScanIndexForward: false,
      Limit: 50,
      ProjectionExpression: 'diaryId, title, createdAt',
    }),
    ddb
      .send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
        ExpressionAttributeValues: { ':p': `USER#${uid}`, ':s': 'INTRO#' },
        Select: 'COUNT',
      }))
      .then((r) => r.Count ?? 0),
    // newest season first, highest medal first within it
    CLOSED.has('medals') ? [] : query({
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': `USER#${uid}`, ':s': 'MEDAL#' },
      ScanIndexForward: false,
    }),
  ]);
  return { user: publicUser(p), history: history.map(strip), diaries, introCount, medals: medals.map(({ season, threshold, at }) => ({ season, threshold, at })) };
}

// ---------- Switch settings ----------
// { opponent's 1st fighter: my 1st fighter }, up to 50
async function updateSwitches(ctx) {
  const p = await ensureProfile(ctx);
  const raw = ctx.body.switches;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'スイッチ設定の形式が不正です');
  const entries = Object.entries(raw);
  if (entries.length > MAX_SWITCHES) throw new HttpError(400, `スイッチ設定は${MAX_SWITCHES}体までです`);
  const switches = {};
  for (const [theirs, mine] of entries) switches[fighterOf(theirs)] = fighterOf(mine);
  const r = await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: p.pk, sk: 'PROFILE' },
    UpdateExpression: 'SET switches = :s', ExpressionAttributeValues: { ':s': switches }, ReturnValues: 'ALL_NEW',
  }));
  return privateUser(r.Attributes);
}

// ---------- Player search ----------
// Every registered player, not only those already in the ranking. Small communities, so the
// whole list is read and matched here; revisit (e.g. a prefix index) if it grows large.
async function searchUsers(ctx) {
  const q = nameKey(text(ctx.query.q, { name: '検索語', max: 40 }));
  const found = [];
  let startKey;
  let pages = 0;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :u',
      ExpressionAttributeValues: { ':u': 'USER' },
      ExclusiveStartKey: startKey,
    }));
    for (const p of r.Items ?? []) {
      if (p.test && !isTestAccount(ctx)) continue; // test accounts are listed to test accounts only
      if ((p.nameKey ?? nameKey(p.name)).includes(q)) found.push(p);
    }
    startKey = r.LastEvaluatedKey;
  } while (startKey && ++pages < 20);
  found.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  return { players: found.slice(0, 50).map(publicUser) };
}

// ---------- Seasons ----------
// The admin moves the site to the next season; medals are awarded within the current one.
async function currentSeason() {
  const s = await get('SEASON', 'CURRENT');
  return { no: s?.no ?? 1, name: s?.name ?? '', startedAt: s?.startedAt ?? null, endsAt: s?.endsAt ?? null };
}

// The current season's display name (e.g. "PRE STAGE"; empty = 第N期) and, when the end is
// known, its end date: the rating page announces both
async function adminSetSeasonEnd(ctx) {
  requireAdmin(ctx);
  const v = String(ctx.body.endsAt ?? '').trim();
  const endsAt = v ? new Date(v) : null;
  if (endsAt && Number.isNaN(endsAt.getTime())) throw new HttpError(400, '終了予定日時を正しく入力してください');
  const name = text(ctx.body.name, { name: 'シーズン名', max: 30, optional: true });
  const cur = (await get('SEASON', 'CURRENT')) ?? { pk: 'SEASON', sk: 'CURRENT', no: 1, startedAt: null };
  const iso = endsAt ? endsAt.toISOString() : null;
  await put({ ...cur, endsAt: iso, name });
  await audit(ctx, 'season.end', { season: cur.no, name, endsAt: iso ?? '' });
  return currentSeason();
}
const getSeason = () => currentSeason();

// Moving to the next season resets every rating and empties the ranking; each player's record
// of the closing season is kept (SEASON#nnnn under the player). Seasons only move forward.
// If the roll-over is interrupted, sending the same number again finishes it.
async function adminSetSeason(ctx) {
  requireAdmin(ctx);
  const no = Number(ctx.body.no);
  if (!Number.isInteger(no) || no < 1 || no > 9999) throw new HttpError(400, 'シーズン番号は1〜9999の整数で指定してください');
  const cur = await get('SEASON', 'CURRENT');
  const curNo = cur?.no ?? 1;
  const resume = no === curNo && cur?.rollover === 'running';
  if (!resume && no <= curNo) throw new HttpError(400, 'シーズンは現在より大きい番号にしか進められません');
  const prev = resume ? cur.prev : curNo;
  const startedAt = resume ? cur.startedAt : nowIso();
  const season = { pk: 'SEASON', sk: 'CURRENT', no, prev, startedAt, by: ctx.claims.sub };
  if (!resume) {
    // Keep the closing season's name and period for later display (the new season starts unnamed)
    await put({ pk: 'SEASON', sk: `ARCHIVE#${String(prev).padStart(4, '0')}`, no: prev, name: cur?.name ?? '', startedAt: cur?.startedAt ?? null, endedAt: startedAt });
  }
  await put({ ...season, rollover: 'running' });
  if (!resume) await audit(ctx, 'season.set', { from: prev, to: no });
  const { archived, reset } = await rolloverSeason(prev, no);
  await put({ ...season, rollover: 'done' });
  return { no, startedAt, archived, reset };
}

async function queryAll(params) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(new QueryCommand({ TableName: TABLE, ...params, ExclusiveStartKey }));
    out.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

const ignoreConditionFail = (e) => { if (e.name !== 'ConditionalCheckFailedException') throw e; return false; };

async function rolloverSeason(prev, no) {
  // Final standings of the closing season (read before anyone is reset)
  const ranked = await queryAll({ IndexName: 'rank', KeyConditionExpression: 'rankpk = :r', ExpressionAttributeValues: { ':r': 'RANK' }, ScanIndexForward: false });
  const rankOf = new Map(ranked.map((p, i) => [p.userId, i + 1]));
  const players = await queryAll({ IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :u', ExpressionAttributeValues: { ':u': 'USER' } });
  let archived = 0;
  let reset = 0;
  for (let i = 0; i < players.length; i += 25) {
    await Promise.all(players.slice(i, i + 25).map(async (p) => {
      if ((p.season ?? 0) >= no) return; // already started the new season
      // keep the record of anyone who played; written once, so a re-run never overwrites it
      if ((p.wins ?? 0) + (p.losses ?? 0) > 0) {
        const saved = await put({
          pk: p.pk, sk: `SEASON#${String(prev).padStart(4, '0')}`, season: prev,
          rating: p.rating, maxRating: p.maxRating ?? p.rating, wins: p.wins ?? 0, losses: p.losses ?? 0,
          rank: rankOf.get(p.userId) ?? null, at: nowIso(),
        }, 'attribute_not_exists(pk)').then(() => true, ignoreConditionFail);
        if (saved) archived++;
      }
      const done = await ddb.send(new UpdateCommand({
        TableName: TABLE, Key: { pk: p.pk, sk: 'PROFILE' },
        UpdateExpression: 'SET rating = :r, maxRating = :r, #w = :z, #l = :z, #s = :no REMOVE rankpk',
        ConditionExpression: 'attribute_not_exists(#s) OR #s < :no',
        ExpressionAttributeNames: { '#w': 'wins', '#l': 'losses', '#s': 'season' },
        ExpressionAttributeValues: { ':r': INITIAL_RATING, ':z': 0, ':no': no },
      })).then(() => true, ignoreConditionFail);
      if (done) reset++;
    }));
  }
  return { archived, reset };
}

// A medal for every 100 rating from 1600 reached during the season (kept once won)
const MEDAL_FROM = 1600;
async function awardMedals(uid, rating) {
  if (rating < MEDAL_FROM || CLOSED.has('medals')) return;
  const { no } = await currentSeason();
  const at = nowIso();
  const tiers = [];
  for (let r = MEDAL_FROM; r <= rating; r += 100) tiers.push(r);
  await Promise.all(tiers.map((threshold) => put(
    { pk: `USER#${uid}`, sk: `MEDAL#${String(no).padStart(4, '0')}#${threshold}`, season: no, threshold, at },
    'attribute_not_exists(pk)',
  ).catch((e) => { if (e.name !== 'ConditionalCheckFailedException') throw e; })));
}

// ---------- Introductions (written by past opponents) ----------
async function listIntros(ctx, uid) {
  const items = await query({
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': `USER#${uid}`, ':s': 'INTRO#' },
  });
  const intros = items.map(strip).sort((a, b) => b.at.localeCompare(a.at));
  const { recent, votes } = tallyVotes(intros);
  return { intros, votes, voters: recent.map((i) => ({ authorId: i.authorId, authorName: i.authorName, fighter: i.fighter })) };
}

// Character votes from the latest 10 intros (newest first; ties go to the most recently voted)
function tallyVotes(intros) {
  const recent = intros.filter((i) => i.fighter).slice(0, 10);
  const counts = {};
  for (const i of recent) counts[i.fighter] = (counts[i.fighter] ?? 0) + 1;
  const votes = Object.entries(counts)
    .map(([fighter, n]) => ({ fighter, percent: Math.round((n / recent.length) * 100) }))
    .sort((a, b) => b.percent - a.percent);
  return { recent, votes };
}

// The character shown for a player (profile, ranking, ...) is the top-voted one; '' until voted
async function refreshVotedFighter(uid) {
  const items = await query({
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': `USER#${uid}`, ':s': 'INTRO#' },
  });
  const { votes } = tallyVotes(items.sort((a, b) => b.at.localeCompare(a.at)));
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: `USER#${uid}`, sk: 'PROFILE' },
    UpdateExpression: 'SET fighter = :f', ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':f': votes[0]?.fighter ?? '' },
  })).catch((e) => { if (e.name !== 'ConditionalCheckFailedException') throw e; });
}

async function writeIntro(ctx, uid) {
  const p = await ensureProfile(ctx);
  if (p.userId === uid) throw new HttpError(400, '自分の紹介文は書けません');
  const target = await getProfile(uid);
  if (target?.allowIntro === false) throw new HttpError(403, 'このプレイヤーは紹介文を受け付けていません');
  const played = await query({
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    FilterExpression: 'opponentId = :o',
    ExpressionAttributeValues: { ':p': p.pk, ':s': 'HIST#', ':o': uid },
  });
  if (!played.length) throw new HttpError(403, 'レーティング対戦で対戦したプレイヤーにのみ書けます');
  const fighter = fighterOf(ctx.body.fighter, { optional: true });
  const body = text(ctx.body.text, { name: '紹介文', max: 500, optional: true });
  if (!fighter && !body) throw new HttpError(400, '使用キャラクターか紹介文を入力してください');
  await put({
    pk: `USER#${uid}`,
    sk: `INTRO#${p.userId}`,
    authorId: p.userId,
    authorName: p.name,
    authorFighter: p.fighter,
    fighter,
    text: body,
    at: nowIso(),
  });
  await refreshVotedFighter(uid);
  return listIntros(ctx, uid);
}

async function deleteIntro(ctx, uid, authorId) {
  const me = requireUser(ctx);
  if (me !== uid && me !== authorId) throw new HttpError(403, '削除できません');
  await del(`USER#${uid}`, `INTRO#${authorId}`);
  await refreshVotedFighter(uid);
  return listIntros(ctx, uid);
}

async function ranking(ctx) {
  const fighter = ctx.query.fighter;
  const params = {
    IndexName: 'rank',
    KeyConditionExpression: 'rankpk = :r',
    ExpressionAttributeValues: { ':r': 'RANK' },
    ScanIndexForward: false,
    Limit: fighter ? 500 : Math.min(Number(ctx.query.limit) || 100, 200),
  };
  if (fighter) {
    params.FilterExpression = 'fighter = :f';
    params.ExpressionAttributeValues[':f'] = fighter;
  }
  const items = (await query(params)).filter((p) => !p.test || isTestAccount(ctx));
  return { players: items.slice(0, 100).map(publicUser) };
}

// ---------- Rated matchmaking (room-host model, like the original) ----------
// "Find an opponent": join a compatible open room whose host has set a room ID;
// otherwise become the host of a new waiting room. The host keeps the room page
// open (its polling refreshes OPEN.lastSeen) and sets the in-game room ID.
const ROOM_PASSWORD = '1122'; // the in-game arena password: fixed by the rules and shown to both players, not a secret
// A waiting room stays joinable this long after the host's page last polled
// (phones stop polling while the screen is locked, e.g. while the host waits at the Switch)
const OPEN_STALE_MS = 5 * 60_000;
// Earliest a result may be reported after matching. Long enough that scripted win-trading
// cannot run in a loop, short enough that a genuine quick 2-0 is never blocked.
const MIN_MATCH_MS = 2 * 60_000;

// USER#x/CURRENT = the room a player is in. A player is released as soon as they have
// reported a result (the match stays open until the opponent's report agrees).
async function releaseCurrent(uids, matchId) {
  await Promise.all(uids.map((u) => ddb.send(new DeleteCommand({
    TableName: TABLE, Key: { pk: `USER#${u}`, sk: 'CURRENT' },
    ConditionExpression: 'matchId = :m', ExpressionAttributeValues: { ':m': matchId },
  })).catch((e) => { if (e.name !== 'ConditionalCheckFailedException') throw e; })));
}

// The player's current room, or null (also cleans up a pointer to a finished / already-reported match)
async function activeCurrent(uid) {
  const current = await get(`USER#${uid}`, 'CURRENT');
  if (!current) return null;
  const m = await get(`MATCH#${current.matchId}`, 'META');
  if (m && (m.status === 'waiting' || (m.status === 'playing' && !m.reports?.[uid]))) return current;
  await releaseCurrent([uid], current.matchId);
  return null;
}

// "おまかせ" is a pick like a fighter: the game's random select chooses the actual fighter
const OMAKASE = 'おまかせ';
const fighterOrOmakase = (v) => (v === OMAKASE ? OMAKASE : fighterOf(v));
// A switch never lands on the lobby fighter itself or on its echo fighter
const ECHO_PAIRS = [['ピーチ', 'デイジー'], ['マルス', 'ルキナ'], ['サムス', 'ダークサムス'], ['ピット', 'ブラックピット'],
  ['ロイ', 'クロム'], ['リュウ', 'ケン'], ['シモン', 'リヒター']];
const sameCharacter = (a, b) => a === b || ECHO_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
const MAX_SWITCHES = 50;

// What each side brings into the room: its lobby fighter, or what its switch setting picks
// against the other side's lobby fighter (never against the other's switch). A player who
// chose おまかせ does not switch.
// a, b: { lobby: fighter picked in the lobby, switches: { opponentFighter: myFighter } }
function decideFighters(a, b) {
  const pick = (side, theirs) => {
    const to = side.lobby !== OMAKASE && side.switches?.[theirs];
    return to && !sameCharacter(to, side.lobby) ? { first: to, switched: true, switchedFrom: side.lobby } : { first: side.lobby };
  };
  return [pick(a, b.lobby), pick(b, a.lobby)];
}
const fighterFields = (d) => ({
  fighter: d.first, nextFighter: d.first, switched: Boolean(d.switched), switchedFrom: d.switchedFrom ?? null,
});

const playerOf = (p, fighter) => ({
  userId: p.userId,
  name: p.name,
  fighter,
  nextFighter: fighter,
  rejectStages: p.rejectStages ?? [],
  rejectByFighter: p.rejectByFighter ?? {},
  preComment: p.preComment ?? '',
  postComment: p.postComment ?? '',
  friendCode: p.friendCode ?? '',
  symbol: p.symbol ?? '',
  conn: matchPrefs(p).conn,
  rating: p.rating,
  lobbyFighter: fighter,
});

async function enqueue(ctx) {
  const p = await ensureProfile(ctx);
  const current = await activeCurrent(p.userId);
  if (current) return { state: 'matched', matchId: current.matchId };
  const fighter = ctx.body.fighter === OMAKASE ? OMAKASE : fighterOf(ctx.body.fighter, { optional: true }) || p.fighter;
  if (!fighter) throw new HttpError(400, '1戦目に使用するキャラを選択してください');
  // Remember it so the lobby pre-selects the same character next time
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: p.pk, sk: 'PROFILE' },
    UpdateExpression: 'SET lastFighter = :f', ExpressionAttributeValues: { ':f': fighter },
  }));
  const rateLimit = Number(ctx.body.rateLimit) || 0; // 0 = anyone, else max rating difference
  if (![0, 50, 100, 150, 200, 250, 300, 350, 400].includes(rateLimit)) throw new HttpError(400, 'レート制限の値が不正です');
  const me = { userId: p.userId, rating: p.rating, rateLimit, ...matchPrefs(p), lastOpponentId: p.lastOpponentId ?? '' };

  // 1) Join an open room (closest rating first)
  const t = nowMs();
  const open = await query({ KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'OPEN' } });
  const test = isTestAccount(ctx);
  const candidates = open
    .filter((o) => o.hostId !== p.userId && o.roomCode && t - o.lastSeen < OPEN_STALE_MS)
    .filter((o) => Boolean(o.test) === test)
    .map((o) => ({ o, diff: Math.abs(o.rating - p.rating) }))
    .filter(({ o, diff }) => (!rateLimit || diff <= rateLimit) && (!o.rateLimit || diff <= o.rateLimit))
    .filter(({ o }) => compatible(me, { ...o, userId: o.hostId }))
    .sort((a, b) => a.diff - b.diff);
  for (const { o } of candidates.slice(0, 5)) {
    const matchedAt = nowIso();
    const [meta, host] = await Promise.all([get(`MATCH#${o.matchId}`, 'META'), getProfile(o.hostId)]);
    const hostInfo = meta?.playerInfo?.[o.hostId];
    if (!hostInfo || meta.status !== 'waiting') continue;
    const [dHost, dMe] = decideFighters(
      { lobby: hostInfo.lobbyFighter ?? hostInfo.fighter, switches: host?.switches },
      { lobby: fighter, switches: p.switches },
    );
    // A room hosted by an admin before opening gets its number only when a member joins it
    const adminOnly = rehearsing(o.hostId) && rehearsing(p.userId);
    const lateNo = !meta.matchNo && isDiscordAccount(ctx) && !adminOnly ? await nextNumber('MATCH') : null;
    try {
      await transact([
        { Delete: { Key: { pk: 'OPEN', sk: o.sk }, ConditionExpression: 'attribute_exists(pk)' } },
        {
          Update: {
            Key: { pk: `MATCH#${o.matchId}`, sk: 'META' },
            UpdateExpression: `SET #s = :playing, players = list_append(players, :me), playerInfo.#u = :info, playerInfo.#h = :hinfo, matchedAt = :t, gsi1pk = :g, gsi1sk = :t${lateNo ? ', matchNo = :no' : ''}${adminOnly ? ', adminOnly = :ao' : ''}`,
            ConditionExpression: '#s = :waiting',
            ExpressionAttributeNames: { '#s': 'status', '#u': p.userId, '#h': o.hostId },
            ExpressionAttributeValues: {
              ':playing': 'playing', ':waiting': 'waiting', ':me': [p.userId], ':t': matchedAt, ':g': 'MATCH',
              ':info': { ...playerOf(p, fighter), ...fighterFields(dMe) },
              ':hinfo': { ...hostInfo, ...fighterFields(dHost) },
              ...(lateNo ? { ':no': lateNo } : {}),
              ...(adminOnly ? { ':ao': true } : {}),
            },
          },
        },
        { Put: { Item: { pk: p.pk, sk: 'CURRENT', matchId: o.matchId }, ConditionExpression: 'attribute_not_exists(pk)' } },
      ]);
      return { state: 'matched', matchId: o.matchId };
    } catch (e) {
      if (e.name !== 'TransactionCanceledException') throw e; // someone else took it; try the next
    }
  }

  // 2) No room available: host a new one
  const matchId = randomUUID();
  const createdAt = nowIso();
  await transact([
    {
      Put: {
        Item: {
          pk: `MATCH#${matchId}`, sk: 'META', matchId, matchNo: isDiscordAccount(ctx) && !rehearsing(p.userId) ? await nextNumber('MATCH') : undefined, kind: 'rate',
          hostId: p.userId, players: [p.userId], playerInfo: { [p.userId]: playerOf(p, fighter) },
          status: 'waiting', reports: {}, createdAt, ...(test ? { test: true } : {}),
        },
      },
    },
    {
      Put: {
        Item: {
          pk: 'OPEN', sk: `MATCH#${matchId}`, matchId, hostId: p.userId, rating: p.rating, rateLimit,
          ...matchPrefs(p), lastOpponentId: p.lastOpponentId ?? '', roomCode: '', lastSeen: nowMs(), createdAt, ttl: epoch() + 3600,
          ...(test ? { test: true } : {}),
        },
      },
    },
    { Put: { Item: { pk: p.pk, sk: 'CURRENT', matchId }, ConditionExpression: 'attribute_not_exists(pk)' } },
  ]);
  return { state: 'hosting', matchId };
}

async function dequeue(ctx) {
  requireUser(ctx);
  return { state: 'idle' };
}

async function rateStatus(ctx) {
  const uid = requireUser(ctx);
  const current = await activeCurrent(uid);
  return current ? { state: 'matched', matchId: current.matchId } : { state: 'idle' };
}

async function loadMatch(id) {
  const m = await get(`MATCH#${id}`, 'META');
  if (!m) throw new HttpError(404, '対戦が見つかりません');
  return m;
}

async function listMatches(ctx) {
  const items = await query({
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': 'MATCH' },
    ScanIndexForward: false,
    Limit: 50,
  });
  // Rooms of test accounts are shown to test accounts only, admins' rehearsals to admins only
  const visible = items.filter((m) => (!m.test || isTestAccount(ctx)) && (!m.adminOnly || isAdmin(ctx)));
  return {
    // Public list: expose only display fields (no friend codes / settings)
    matches: visible.map(({ matchId, matchNo, status, players, playerInfo, winnerId, delta, createdAt, matchedAt }) => ({
      matchId, matchNo, status, players, winnerId, delta, createdAt, matchedAt,
      playerInfo: Object.fromEntries(players.map((u) => {
        const p = playerInfo[u] ?? {};
        return [u, { userId: u, name: p.name, fighter: p.fighter, rating: p.rating, wired: p.conn ? p.conn !== 'wireless' : false, switched: Boolean(p.switched) }];
      })),
    })),
  };
}

async function assertMatchMember(ctx, id) {
  const uid = requireUser(ctx);
  const m = await loadMatch(id);
  if (!m.players.includes(uid)) throw new HttpError(403, 'この対戦の参加者ではありません');
  return m;
}

// On a site with PUBLIC_ROOMS, anyone may look at a matched room and read its comments, like a
// public board (posting, reporting and the in-game room ID stay with the two players). Rooms of
// test accounts and admins' rehearsals stay with them.
const PUBLIC_ROOMS = process.env.PUBLIC_ROOMS === '1';
const canWatch = (ctx, m) => PUBLIC_ROOMS && m.players.length === 2
  && (!m.test || isTestAccount(ctx)) && (!m.adminOnly || isAdmin(ctx));
const isMember = (ctx, m) => Boolean(ctx.claims?.sub && m.players.includes(ctx.claims.sub));
function assertCanRead(ctx, m) {
  if (isMember(ctx, m) || canWatch(ctx, m)) return;
  requireUser(ctx);
  throw new HttpError(403, 'この対戦の参加者ではありません');
}

// What a spectator sees: no way into the in-game room, nothing about switch settings
async function publicMatchView(m) {
  const { room, ...view } = strip(m);
  if (view.correctedBy) view.correctedBy = true;
  const profiles = await Promise.all(view.players.map((u) => getProfile(u)));
  view.playerInfo = Object.fromEntries(view.players.map((u, i) => {
    const { friendCode, lobbyFighter, switchedFrom, ...p } = view.playerInfo[u] ?? {};
    return [u, { ...p, rating: profiles[i]?.rating ?? p.rating, name: profiles[i]?.name ?? p.name }];
  }));
  return view;
}

// The room shows each player's *current* rating (and name), not the one at matching time
async function getMatch(ctx, id) {
  const raw = await loadMatch(id);
  if (!isMember(ctx, raw)) {
    assertCanRead(ctx, raw);
    return publicMatchView(raw);
  }
  const m = strip(raw);
  // The waiting host's polling keeps the room joinable
  if (m.status === 'waiting' && m.hostId === ctx.claims.sub) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { pk: 'OPEN', sk: `MATCH#${id}` },
      UpdateExpression: 'SET lastSeen = :t', ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':t': nowMs() },
    })).catch(() => {});
  }
  m.roomPassword = ROOM_PASSWORD;
  // Players only need to know the admin decided it, not who the admin is
  if (m.correctedBy) m.correctedBy = true;
  const profiles = await Promise.all(m.players.map((u) => getProfile(u)));
  // The viewer's own "hide ratings" preference blanks both ratings in their room view
  const hideRate = profiles[m.players.indexOf(ctx.claims.sub)]?.showRate === false;
  m.players.forEach((u, i) => {
    const p = profiles[i];
    if (p && m.playerInfo[u]) Object.assign(m.playerInfo[u], { rating: hideRate ? null : p.rating, name: p.name });
  });
  return m;
}

// Each player's result is "win", "lose" or "cancel" (対戦中止), and can be re-pressed until the
// room ends. The room ends only when the two agree: win + lose settles the rating, cancel +
// cancel closes it with no change. Any other pair is a mismatch: the room stays open for a
// re-press, both players may already search for their next opponent, and both see a notice on
// their profile until it is resolved.
const agreed = (ra, rb) => (ra === 'win' && rb === 'lose') || (ra === 'lose' && rb === 'win') || (ra === 'cancel' && rb === 'cancel');
const bothCancelled = (m) => m.players.length === 2 && m.players.every((u) => m.reports?.[u] === 'cancel');

// USER#x/MISMATCH#matchId marks a room whose two reports disagree (shown on the owner's profile)
async function syncMismatch(id) {
  const m = await loadMatch(id);
  const [a, b] = m.players;
  const on = m.status === 'playing' && m.players.length === 2 && m.reports?.[a] && m.reports?.[b] && !agreed(m.reports[a], m.reports[b]);
  await Promise.all(m.players.map((u) => (on
    ? put({ pk: `USER#${u}`, sk: `MISMATCH#${id}`, matchId: id, matchNo: m.matchNo, at: nowIso() })
    : del(`USER#${u}`, `MISMATCH#${id}`))));
}

async function recordResult(uid, m, result) {
  const id = m.matchId;
  const r = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: m.pk, sk: 'META' },
      UpdateExpression: 'SET reports.#u = :r',
      ConditionExpression: '#s = :cur AND size(players) = :two AND attribute_not_exists(correctedBy)',
      ExpressionAttributeNames: { '#u': uid, '#s': 'status' },
      ExpressionAttributeValues: { ':r': result, ':cur': m.status, ':two': 2 },
      ReturnValues: 'ALL_NEW',
    }),
  );
  const updated = r.Attributes;
  const [a, b] = updated.players;
  const ra = updated.reports[a];
  const rb = updated.reports[b];
  // Whatever happens next, the player who pressed is free to search for the next opponent
  await releaseCurrent([uid], id);
  if (ra && rb && agreed(ra, rb)) {
    if (ra === 'cancel') {
      // Both pressed 対戦中止: the room ends (unless one of them re-pressed in the meantime)
      await ddb.send(new UpdateCommand({
        TableName: TABLE, Key: { pk: m.pk, sk: 'META' },
        UpdateExpression: 'SET #s = :c, finishedAt = :t',
        ConditionExpression: '#s = :cur AND reports.#a = :x AND reports.#b = :x',
        ExpressionAttributeNames: { '#s': 'status', '#a': a, '#b': b },
        ExpressionAttributeValues: { ':c': 'cancelled', ':t': nowIso(), ':cur': updated.status, ':x': 'cancel' },
      })).catch((e) => { if (e.name !== 'ConditionalCheckFailedException') throw e; });
      await releaseCurrent(updated.players, id);
    } else {
      // Two results for one player landing together: the one that loses the race re-reads the ratings and retries
      for (let attempt = 0; ; attempt++) {
        try {
          await settleMatch(updated, ra === 'win' ? a : b, { expectStatus: updated.status });
          break;
        } catch (e) {
          if (e.name !== 'TransactionCanceledException' || attempt >= 2) throw e;
          if ((await loadMatch(id)).status !== updated.status) break; // already settled by the other report
          await new Promise((res) => setTimeout(res, 100 + randomInt(300)));
        }
      }
    }
  }
  await syncMismatch(id);
  return strip(await loadMatch(id));
}

async function reportMatch(ctx, id) {
  const uid = requireUser(ctx);
  const result = ctx.body.result;
  if (result !== 'win' && result !== 'lose') throw new HttpError(400, 'result は win か lose です');
  const m = await loadMatch(id);
  if (!m.players.includes(uid)) throw new HttpError(403, 'この対戦の参加者ではありません');
  // Rooms cancelled under the old one-sided 対戦中止 can still be settled by agreeing reports;
  // a room both players cancelled is over
  const reportable = m.status === 'playing' || (m.status === 'cancelled' && m.players.length === 2 && !bothCancelled(m));
  if (!reportable) throw new HttpError(409, 'この対戦はすでに終了しています');
  // An admin decision (including a void) is final: the old reports must not settle it again
  if (m.correctedBy) throw new HttpError(409, '運営が結果を確定した対戦のため、報告できません');
  // A real set cannot finish in seconds; this is what makes win-trading slow enough to notice
  const since = m.matchedAt ? Date.now() - new Date(m.matchedAt).getTime() : Infinity;
  if (since < MIN_MATCH_MS) {
    const wait = Math.ceil((MIN_MATCH_MS - since) / 1000);
    throw new HttpError(409, `対戦開始から間もないため報告できません。あと約${wait}秒お待ちください`);
  }
  return recordResult(uid, m, result);
}

// Apply a result: Elo from the ratings the match was played at, history rows, close the room.
async function settleMatch(m, winner, { expectStatus, by } = {}) {
  const id = m.matchId;
  const loser = m.players.find((p) => p !== winner);
  const [pw, pl] = await Promise.all([getProfile(winner), getProfile(loser)]);
  // Snapshot taken when each player entered the room. Using live ratings would let a player
  // sit on an unreported loss, move their rating elsewhere, and report at a better exchange rate.
  const rw = m.playerInfo?.[winner]?.rating ?? pw.rating;
  const rl = m.playerInfo?.[loser]?.rating ?? pl.rating;
  const expected = 1 / (1 + 10 ** ((rl - rw) / 400));
  const { no: season } = await currentSeason();
  const delta = Math.max(1, Math.round(ELO_K * (1 - expected)));
  const at = nowIso();
  const hist = (owner, opp, res, d) => ({
    Put: {
      Item: {
        pk: `USER#${owner.userId}`, sk: `HIST#${at}#${id}`, matchId: id, matchNo: m.matchNo,
        myFighter: m.playerInfo[owner.userId]?.fighter, opponentId: opp.userId, opponentName: opp.name,
        opponentFighter: m.playerInfo[opp.userId]?.fighter, opponentRating: opp.rating,
        mySwitched: Boolean(m.playerInfo[owner.userId]?.switched), opponentSwitched: Boolean(m.playerInfo[opp.userId]?.switched),
        result: res, delta: d, ratingAfter: owner.rating + d, season, at,
      },
    },
  });
  const rate = (p, d, field, oppId) => ({
    Update: {
      Key: { pk: `USER#${p.userId}`, sk: 'PROFILE' },
      // Points: +5 for a win, +3 for a loss (spent on the gacha / minimum game)
      UpdateExpression: `SET rating = :nr, rankpk = :rk, maxRating = :mx, lastOpponentId = :lo, #season = :season ADD ${field} :one, points :pt`,
      ConditionExpression: 'rating = :old',
      ExpressionAttributeNames: { '#season': 'season' },
      ExpressionAttributeValues: {
        ':season': season, ':lo': oppId, ':nr': p.rating + d, ':old': p.rating, ':rk': 'RANK', ':one': 1,
        ':pt': field === 'wins' ? 5 : 3, ':mx': Math.max(p.rating + d, p.maxRating ?? INITIAL_RATING),
      },
    },
  });
  await transact([
    {
      Update: {
        Key: { pk: `MATCH#${id}`, sk: 'META' },
        UpdateExpression: `SET #s = :d, winnerId = :w, delta = :delta, #season = :season, finishedAt = :t, histAt = :t${by ? ', correctedBy = :by, correctedAt = :t' : ''}`,
        ConditionExpression: '#s = :expect',
        ExpressionAttributeNames: { '#s': 'status', '#season': 'season' },
        ExpressionAttributeValues: { ':d': 'done', ':w': winner, ':delta': delta, ':season': season, ':t': at, ':expect': expectStatus, ...(by ? { ':by': by } : {}) },
      },
    },
    rate(pw, delta, 'wins', pl.userId),
    rate(pl, -delta, 'losses', pw.userId),
    hist(pw, pl, 'win', delta),
    hist(pl, pw, 'lose', -delta),
  ]);
  // Only clear pointers to *this* match (a reporter may already be in a new room)
  await releaseCurrent(m.players, id);
  if (delta > 0) await awardMedals(winner, pw.rating + delta);
}

// ---------- Admin: correct a rated match result ----------
// result: '<winnerUserId>' or 'void'. A settled result is fully reverted first
// (ratings, win/loss counts, points, history), then the new result is applied.
async function adminListMatches(ctx) {
  requireAdmin(ctx);
  const items = await query({ IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :p', ExpressionAttributeValues: { ':p': 'MATCH' }, ScanIndexForward: false, Limit: 100 });
  return { matches: items.map(strip) };
}

async function adminSetResult(ctx, id) {
  requireAdmin(ctx);
  const m = await loadMatch(id);
  if (m.players.length !== 2) throw new HttpError(400, 'まだマッチングしていない部屋です');
  const target = ctx.body.result;
  if (target !== 'void' && !m.players.includes(target)) throw new HttpError(400, '結果の指定が不正です');

  // A season roll-over reset the ratings, so an old result can no longer be undone cleanly
  const { no: season } = await currentSeason();
  if (m.season && m.season !== season) throw new HttpError(400, '前のシーズンの対戦は修正できません');

  let status = m.status;
  if (status === 'done') {
    // Revert the applied result
    const w = m.winnerId;
    const l = m.players.find((p) => p !== w);
    const histSk = await query({
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', FilterExpression: 'matchId = :m',
      ExpressionAttributeValues: { ':p': `USER#${w}`, ':s': 'HIST#', ':m': id },
    });
    const sk = histSk[0]?.sk ?? (m.histAt ? `HIST#${m.histAt}#${id}` : `HIST#${m.finishedAt}#${id}`);
    const undo = (uid, d, field, pts) => ({
      Update: {
        Key: { pk: `USER#${uid}`, sk: 'PROFILE' },
        UpdateExpression: `ADD rating :d, ${field} :minus, points :pts`,
        ExpressionAttributeValues: { ':d': d, ':minus': -1, ':pts': -pts },
      },
    });
    await transact([
      {
        Update: {
          Key: { pk: m.pk, sk: 'META' },
          UpdateExpression: 'SET #s = :playing REMOVE winnerId, delta',
          ConditionExpression: '#s = :done AND winnerId = :w',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':playing': 'playing', ':done': 'done', ':w': w },
        },
      },
      // A result capped by the former same-opponent limit paid no points, so there are none to take back
      undo(w, -m.delta, 'wins', m.capped ? 0 : 5),
      undo(l, m.delta, 'losses', m.capped ? 0 : 3),
      { Delete: { Key: { pk: `USER#${w}`, sk } } },
      { Delete: { Key: { pk: `USER#${l}`, sk } } },
    ]);
    status = 'playing';
  } else if (status === 'disputed' || status === 'cancelled') {
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { pk: m.pk, sk: 'META' },
      UpdateExpression: 'SET #s = :playing', ConditionExpression: '#s = :cur',
      ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':playing': 'playing', ':cur': status },
    }));
    status = 'playing';
  }

  if (target === 'void') {
    await transact([
      {
        Update: {
          Key: { pk: m.pk, sk: 'META' },
          UpdateExpression: 'SET #s = :c, finishedAt = :t, correctedBy = :by, correctedAt = :t',
          ConditionExpression: '#s = :playing',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':c': 'cancelled', ':t': nowIso(), ':by': ctx.claims.sub, ':playing': 'playing' },
        },
      },
    ]);
    await releaseCurrent(m.players, id);
  } else {
    await settleMatch(await loadMatch(id), target, { expectStatus: 'playing', by: ctx.claims.sub });
  }
  await syncMismatch(id);
  await audit(ctx, 'match.setResult', {
    matchId: id,
    matchNo: m.matchNo ?? null,
    result: target === 'void' ? 'void' : 'winner',
    winner: target === 'void' ? '' : target,
    wasStatus: m.status,
  });
  return strip(await loadMatch(id));
}

async function setMatchRoom(ctx, id) {
  const uid = requireUser(ctx);
  const m = await loadMatch(id);
  if (!m.players.includes(uid)) throw new HttpError(403, 'この対戦の参加者ではありません');
  if (m.status === 'waiting' && m.hostId !== uid) throw new HttpError(403, '部屋IDを設定できるのは部屋を立てた人のみです');
  // In-game room IDs are alphanumeric; show them upper-cased like the original
  const roomId = String(ctx.body.roomId ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(roomId)) throw new HttpError(400, '部屋IDは英数字で入力してください');
  const room = { roomId, password: ROOM_PASSWORD, by: uid };
  const r = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: m.pk, sk: 'META' },
      UpdateExpression: 'SET room = :r',
      ConditionExpression: '#s IN (:waiting, :playing)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':r': room, ':playing': 'playing', ':waiting': 'waiting' },
      ReturnValues: 'ALL_NEW',
    }),
  );
  if (m.status === 'waiting') {
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { pk: 'OPEN', sk: `MATCH#${id}` },
      UpdateExpression: 'SET roomCode = :c, lastSeen = :t', ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':c': roomId, ':t': nowMs() },
    })).catch(() => {});
  }
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: `USER#${uid}`, sk: 'PROFILE' },
    UpdateExpression: 'SET lastRoomId = :r', ExpressionAttributeValues: { ':r': roomId },
  }));
  return { ...strip(r.Attributes), roomPassword: ROOM_PASSWORD };
}

async function setNextFighter(ctx, id) {
  const uid = requireUser(ctx);
  const m = await loadMatch(id);
  if (!m.players.includes(uid)) throw new HttpError(403, 'この対戦の参加者ではありません');
  const fighter = fighterOrOmakase(ctx.body.fighter);
  const r = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: m.pk, sk: 'META' },
      UpdateExpression: 'SET playerInfo.#u.nextFighter = :f',
      ConditionExpression: '#s = :playing',
      ExpressionAttributeNames: { '#u': uid, '#s': 'status' },
      ExpressionAttributeValues: { ':f': fighter, ':playing': 'playing' },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return strip(r.Attributes);
}

// 対戦中止. In a matched room it is a result like win / lose (the room ends when both press it);
// a host who is still waiting for an opponent deletes the room at once.
async function cancelMatch(ctx, id) {
  const uid = requireUser(ctx);
  const m = await loadMatch(id);
  if (!m.players.includes(uid)) throw new HttpError(403, 'この対戦の参加者ではありません');
  if (m.status === 'playing') {
    if (m.correctedBy) throw new HttpError(409, '運営が結果を確定した対戦のため、報告できません');
    return recordResult(uid, m, 'cancel');
  }
  await transact([
    {
      Update: {
        Key: { pk: m.pk, sk: 'META' },
        UpdateExpression: 'SET #s = :c, cancelledBy = :u, finishedAt = :t',
        ConditionExpression: '#s IN (:playing, :waiting)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':c': 'cancelled', ':u': uid, ':t': nowIso(), ':playing': 'playing', ':waiting': 'waiting' },
      },
    },
    ...(m.status === 'waiting' ? [{ Delete: { Key: { pk: 'OPEN', sk: `MATCH#${id}` } } }] : []),
  ]);
  await releaseCurrent(m.players, id);
  return strip(await loadMatch(id));
}

// ---------- Chat (shared by rated matches and free rooms) ----------
async function listMessages(pk, after) {
  const items = await query({
    KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b',
    // after must stay inside the MSG# range: 'META' sorts below 'MSG#' and would otherwise be returned
    ExpressionAttributeValues: { ':p': pk, ':a': /^MSG#/.test(after ?? '') ? after : 'MSG#', ':b': 'MSG#~' },
    Limit: 200,
  });
  return items.filter((i) => !after || i.sk > after).map((i) => ({ id: i.sk, ...strip(i) }));
}
async function postMessage(ctx, pk) {
  const p = await ensureProfile(ctx);
  const body = text(ctx.body.text, { name: 'メッセージ', max: 300 });
  const sk = `MSG#${String(nowMs()).padStart(15, '0')}#${randomBytes(3).toString('hex')}`;
  await put({ pk, sk, userId: p.userId, name: p.name, text: body, at: nowIso(), ttl: epoch() + MESSAGE_TTL_SEC });
  return { id: sk };
}

async function matchMessages(ctx, id) {
  assertCanRead(ctx, await loadMatch(id));
  return { messages: await listMessages(`MATCH#${id}`, ctx.query.after) };
}
async function postMatchMessage(ctx, id) {
  await assertMatchMember(ctx, id);
  return postMessage(ctx, `MATCH#${id}`);
}

// ---------- Free match rooms ----------
async function loadRoom(id) {
  const r = await get(`FREE#${id}`, 'META');
  if (!r) throw new HttpError(404, '募集が見つかりません');
  return r;
}
function assertRoomMember(room, uid) {
  if (room.hostId !== uid && room.guestId !== uid) throw new HttpError(403, 'この部屋の参加者ではありません');
}

async function listRooms() {
  const items = await query({
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    FilterExpression: '#t > :now',
    ExpressionAttributeNames: { '#t': 'ttl' },
    ExpressionAttributeValues: { ':p': 'FREE', ':now': epoch() },
    ScanIndexForward: false,
    Limit: 100,
  });
  return { rooms: items.map(publicRoom) };
}

async function createRoom(ctx) {
  const p = await ensureProfile(ctx);
  const roomId = shortId();
  const createdAt = nowIso();
  const room = {
    pk: `FREE#${roomId}`,
    sk: 'META',
    gsi1pk: 'FREE',
    gsi1sk: createdAt,
    roomId,
    roomNo: await nextNumber('FREE'),
    hostId: p.userId,
    hostName: p.name,
    hostFighter: p.fighter,
    hostRating: p.rating,
    title: text(ctx.body.title, { name: 'タイトル', max: 40, optional: true }) || 'フリー対戦',
    rule: text(ctx.body.rule, { name: '対戦ルール', max: 300, optional: true }),
    comment: text(ctx.body.comment, { name: 'コメント', max: 300, optional: true }),
    waitMin: [15, 30, 45, 60].includes(Number(ctx.body.waitMin)) ? Number(ctx.body.waitMin) : 15,
    rateLimit: [0, 100, 150, 200, 250, 300, 350, 400].includes(Number(ctx.body.rateLimit)) ? Number(ctx.body.rateLimit) : 0,
    games: [0, 3, 5, 7].includes(Number(ctx.body.games)) ? Number(ctx.body.games) : 0,
    method: ctx.body.method === 'friend' ? 'friend' : 'room',
    hostFriendCode: p.friendCode ?? '',
    status: 'open',
    createdAt,
    ttl: epoch() + FREE_ROOM_TTL_SEC,
  };
  // Room ID / password are only shown to the two players (see roomSecret)
  const secret = {
    roomCode: text(ctx.body.roomCode, { name: '部屋ID', max: 20, optional: true }),
    password: text(ctx.body.password, { name: 'パスワード', max: 20, optional: true }),
  };
  if (room.method === 'room' && !secret.roomCode) throw new HttpError(400, '部屋IDを入力してください');
  await put({ ...room, secret });
  return publicRoom(room);
}

const publicRoom = (r) => {
  const { secret, hostFriendCode, guestFriendCode, ...rest } = strip(r);
  return rest;
};

async function getRoom(ctx, id) {
  return publicRoom(await loadRoom(id));
}

async function roomSecret(ctx, id) {
  const uid = requireUser(ctx);
  const room = await loadRoom(id);
  assertRoomMember(room, uid);
  return { ...(room.secret ?? {}), hostFriendCode: room.hostFriendCode ?? '', guestFriendCode: room.guestFriendCode ?? '' };
}

async function joinRoom(ctx, id) {
  const p = await ensureProfile(ctx);
  const room = await loadRoom(id);
  if (room.hostId === p.userId) throw new HttpError(400, '自分の募集には参加できません');
  const openMs = (room.waitMin ?? FREE_ROOM_OPEN_MS / 60000) * 60000;
  if (Date.now() - new Date(room.createdAt).getTime() > openMs) throw new HttpError(409, '募集期限が過ぎています');
  if (room.rateLimit && Math.abs(p.rating - room.hostRating) > room.rateLimit) {
    throw new HttpError(403, `この募集はレート差${room.rateLimit}以内のプレイヤーのみ参加できます`);
  }
  const r = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: room.pk, sk: 'META' },
      UpdateExpression: 'SET #s = :m, guestId = :g, guestName = :gn, guestFighter = :gf, guestRating = :gr, guestFriendCode = :gfc, matchedAt = :t',
      ConditionExpression: '#s = :open',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':m': 'matched',
        ':open': 'open',
        ':g': p.userId,
        ':gn': p.name,
        ':gf': p.fighter,
        ':gr': p.rating,
        ':gfc': p.friendCode ?? '',
        ':t': nowIso(),
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return publicRoom(r.Attributes);
}

async function closeRoom(ctx, id) {
  const uid = requireUser(ctx);
  const room = await loadRoom(id);
  assertRoomMember(room, uid);
  const r = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: room.pk, sk: 'META' },
      UpdateExpression: 'SET #s = :c, closedAt = :t',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':c': 'closed', ':t': nowIso() },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return publicRoom(r.Attributes);
}

async function roomMessages(ctx, id) {
  const uid = requireUser(ctx);
  assertRoomMember(await loadRoom(id), uid);
  return { messages: await listMessages(`FREE#${id}`, ctx.query.after) };
}
async function postRoomMessage(ctx, id) {
  const uid = requireUser(ctx);
  const room = await loadRoom(id);
  assertRoomMember(room, uid);
  if (room.status === 'closed') throw new HttpError(409, 'この部屋は終了しています');
  return postMessage(ctx, `FREE#${id}`);
}

// ---------- Tournaments ----------
async function loadTournament(id) {
  const t = await get(`TOUR#${id}`, 'META');
  if (!t) throw new HttpError(404, '大会が見つかりません');
  return t;
}

async function listTournaments(ctx) {
  const since = new Date(Date.now() - (ctx.query.past ? 90 : 2) * 86400_000).toISOString();
  const items = await query({
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p AND gsi1sk >= :s',
    ExpressionAttributeValues: { ':p': 'TOUR', ':s': since },
    ProjectionExpression: 'tourId, title, startAt, #r, organizerId, organizerName, #cap, entryCount, #s, description',
    ExpressionAttributeNames: { '#r': 'rule', '#s': 'status', '#cap': 'capacity' },
    Limit: 100,
  });
  return { tournaments: items.map((t) => ({ ...t, description: (t.description || '').slice(0, 100) })) };
}

async function createTournament(ctx) {
  const p = await ensureProfile(ctx);
  const startDate = new Date(ctx.body.startAt);
  if (Number.isNaN(startDate.getTime())) throw new HttpError(400, '開催日時を正しく入力してください');
  if (startDate.getTime() < Date.now() - 3600_000) throw new HttpError(400, '開催日時は未来の日時にしてください');
  const tourId = shortId();
  const startAt = startDate.toISOString();
  const t = {
    pk: `TOUR#${tourId}`,
    sk: 'META',
    gsi1pk: 'TOUR',
    gsi1sk: `${startAt}#${tourId}`,
    tourId,
    title: text(ctx.body.title, { name: '大会名', max: 50 }),
    rule: text(ctx.body.rule, { name: 'ルール', max: 60 }),
    description: text(ctx.body.description, { name: '大会説明', max: 2000, optional: true }),
    capacity: int(ctx.body.capacity, { name: '定員', min: 2, max: 128 }),
    startAt,
    organizerId: p.userId,
    organizerName: p.name,
    entryCount: 0,
    status: 'recruiting',
    version: 0,
    createdAt: nowIso(),
  };
  await put(t);
  return strip(t);
}

async function getTournament(ctx, id) {
  const t = await loadTournament(id);
  const entries = await query({
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :e)',
    ExpressionAttributeValues: { ':p': t.pk, ':e': 'ENTRY#' },
  });
  return { tournament: strip(t), entries: entries.map(strip).sort((a, b) => a.at.localeCompare(b.at)) };
}

async function enterTournament(ctx, id) {
  const p = await ensureProfile(ctx);
  const t = await loadTournament(id);
  if (t.status !== 'recruiting') throw new HttpError(409, 'エントリー受付は終了しています');
  try {
    await transact([
      {
        Update: {
          Key: { pk: t.pk, sk: 'META' },
          UpdateExpression: 'ADD entryCount :one',
          ConditionExpression: '#s = :rec AND entryCount < #cap',
          ExpressionAttributeNames: { '#s': 'status', '#cap': 'capacity' },
          ExpressionAttributeValues: { ':one': 1, ':rec': 'recruiting' },
        },
      },
      {
        Put: {
          Item: {
            pk: t.pk,
            sk: `ENTRY#${p.userId}`,
            userId: p.userId,
            name: p.name,
            fighter: p.fighter,
            rating: p.rating,
            at: nowIso(),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      // Per-user index for the "participated tournaments" page
      { Put: { Item: { pk: p.pk, sk: `TENT#${id}`, tourId: id, title: t.title, startAt: t.startAt, at: nowIso() } } },
    ]);
  } catch (e) {
    if (e.name === 'TransactionCanceledException') throw new HttpError(409, '定員に達しているか、すでにエントリー済みです');
    throw e;
  }
  return getTournament(ctx, id);
}

async function leaveTournament(ctx, id) {
  const uid = requireUser(ctx);
  const t = await loadTournament(id);
  try {
    await transact([
      {
        Update: {
          Key: { pk: t.pk, sk: 'META' },
          UpdateExpression: 'ADD entryCount :minus',
          ConditionExpression: '#s = :rec',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':minus': -1, ':rec': 'recruiting' },
        },
      },
      { Delete: { Key: { pk: t.pk, sk: `ENTRY#${uid}` }, ConditionExpression: 'attribute_exists(pk)' } },
      { Delete: { Key: { pk: `USER#${uid}`, sk: `TENT#${id}` } } },
    ]);
  } catch (e) {
    if (e.name === 'TransactionCanceledException') throw new HttpError(409, 'エントリーを取り消せませんでした');
    throw e;
  }
  return getTournament(ctx, id);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE() % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function advance(rounds, r, i) {
  const winner = rounds[r][i].winner;
  if (r + 1 >= rounds.length) return;
  const next = rounds[r + 1][Math.floor(i / 2)];
  next[i % 2 === 0 ? 'p1' : 'p2'] = winner;
}

function buildBracket(playerIds) {
  let size = 2;
  while (size < playerIds.length) size *= 2;
  const half = size / 2;
  const players = shuffle([...playerIds]);
  const rounds = [];
  for (let n = half; n >= 1; n /= 2) rounds.push(Array.from({ length: n }, () => ({ p1: null, p2: null, winner: null })));
  for (let i = 0; i < half; i++) {
    rounds[0][i].p1 = players[i] ?? null;
    rounds[0][i].p2 = players[i + half] ?? null;
  }
  // Byes advance automatically
  rounds[0].forEach((m, i) => {
    if (m.p1 && !m.p2) {
      m.winner = m.p1;
      m.bye = true;
      advance(rounds, 0, i);
    }
  });
  return rounds;
}

async function startTournament(ctx, id) {
  const uid = requireUser(ctx);
  const { tournament: t, entries } = await getTournament(ctx, id);
  if (t.organizerId !== uid) throw new HttpError(403, '主催者のみ操作できます');
  if (t.status !== 'recruiting') throw new HttpError(409, 'すでに開始しています');
  if (entries.length < 2) throw new HttpError(400, '参加者が2名以上必要です');
  const bracket = buildBracket(entries.map((e) => e.userId));
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `TOUR#${id}`, sk: 'META' },
      UpdateExpression: 'SET #s = :run, bracket = :b, startedAt = :t, version = version + :one',
      ConditionExpression: '#s = :rec AND version = :v',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':run': 'running', ':rec': 'recruiting', ':b': bracket, ':t': nowIso(), ':one': 1, ':v': t.version },
    }),
  );
  return getTournament(ctx, id);
}

async function reportTournament(ctx, id) {
  const uid = requireUser(ctx);
  const t = await loadTournament(id);
  if (t.status !== 'running') throw new HttpError(409, '大会は進行中ではありません');
  const r = int(ctx.body.round, { name: 'round', min: 0, max: t.bracket.length - 1 });
  const i = int(ctx.body.index, { name: 'index', min: 0, max: t.bracket[r].length - 1 });
  const m = t.bracket[r][i];
  const winnerId = ctx.body.winnerId;
  if (!m.p1 || !m.p2) throw new HttpError(400, '対戦カードが確定していません');
  if (winnerId !== m.p1 && winnerId !== m.p2) throw new HttpError(400, '勝者が不正です');
  const isOrganizer = t.organizerId === uid;
  if (!isOrganizer && uid !== m.p1 && uid !== m.p2) throw new HttpError(403, '主催者または対戦者のみ報告できます');
  if (m.winner && !isOrganizer) throw new HttpError(409, '結果は報告済みです（修正は主催者のみ可能です）');
  if (m.winner && r + 1 < t.bracket.length && t.bracket[r + 1][Math.floor(i / 2)].winner)
    throw new HttpError(409, '次の試合が終わっているため修正できません');

  m.winner = winnerId;
  m.reportedBy = uid;
  advance(t.bracket, r, i);
  const finished = r === t.bracket.length - 1;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: t.pk, sk: 'META' },
      UpdateExpression: 'SET bracket = :b, #s = :st, championId = :c, version = version + :one',
      ConditionExpression: 'version = :v',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':b': t.bracket,
        ':st': finished ? 'finished' : 'running',
        ':c': finished ? winnerId : null,
        ':one': 1,
        ':v': t.version,
      },
    }),
  );
  return getTournament(ctx, id);
}

// ---------- Diaries ----------
async function listDiaries() {
  const items = await query({
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': 'DIARY' },
    ScanIndexForward: false,
    Limit: 50,
  });
  return { diaries: items.map((d) => ({ ...strip(d), body: d.body.slice(0, 120) })) };
}

async function createDiary(ctx) {
  const p = await ensureProfile(ctx);
  const createdAt = nowIso();
  const diaryId = shortId();
  const d = {
    pk: `USER#${p.userId}`,
    sk: `DIARY#${diaryId}`,
    gsi1pk: 'DIARY',
    gsi1sk: createdAt,
    diaryId,
    userId: p.userId,
    userName: p.name,
    userFighter: p.fighter,
    title: text(ctx.body.title, { name: 'タイトル', max: 60 }),
    body: text(ctx.body.body, { name: '本文', max: 5000 }),
    createdAt,
  };
  await put(d);
  return strip(d);
}

async function deleteDiary(ctx, uid, did) {
  if (requireUser(ctx) !== uid) throw new HttpError(403, '自分の日記のみ削除できます');
  await del(`USER#${uid}`, `DIARY#${did}`);
  return { ok: true };
}

// ---------- Diary likes & comments ----------
async function diaryDetail(ctx, uid, did) {
  const d = await get(`USER#${uid}`, `DIARY#${did}`);
  if (!d) throw new HttpError(404, '日記が見つかりません');
  const [likes, comments] = await Promise.all([
    query({ KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': `DLIKE#${did}` } }),
    query({ KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': `DCMT#${did}` } }),
  ]);
  return { ...strip(d), likes: likes.map(strip), comments: comments.map((c) => ({ id: c.sk, ...strip(c) })) };
}

async function likeDiary(ctx, uid, did) {
  const p = await ensureProfile(ctx);
  const d = await get(`USER#${uid}`, `DIARY#${did}`);
  if (!d) throw new HttpError(404, '日記が見つかりません');
  const existing = await get(`DLIKE#${did}`, p.pk);
  // Conditional, so two concurrent taps cannot both count: whichever loses the race is a no-op
  try {
    await transact([
      existing
        ? { Delete: { Key: { pk: `DLIKE#${did}`, sk: p.pk }, ConditionExpression: 'attribute_exists(pk)' } }
        : { Put: { Item: { pk: `DLIKE#${did}`, sk: p.pk, userId: p.userId, name: p.name, at: nowIso() }, ConditionExpression: 'attribute_not_exists(pk)' } },
      {
        Update: {
          Key: { pk: `USER#${uid}`, sk: `DIARY#${did}` },
          UpdateExpression: 'ADD likeCount :n',
          ExpressionAttributeValues: { ':n': existing ? -1 : 1 },
        },
      },
    ]);
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
  }
  return diaryDetail(ctx, uid, did);
}

async function deleteComment(ctx, uid, did, rawId) {
  const me = requireUser(ctx);
  const sk = decodeURIComponent(rawId);
  if (!/^C#\d{15}#[0-9a-f]{6}$/.test(sk)) throw new HttpError(400, 'コメントの指定が不正です');
  const c = await get(`DCMT#${did}`, sk);
  if (!c) throw new HttpError(404, 'コメントが見つかりません');
  // the diary's owner, the person who wrote the comment, or the admin
  if (me !== uid && me !== c.userId && !isAdmin(ctx)) throw new HttpError(403, 'このコメントは削除できません');
  await transact([
    { Delete: { Key: { pk: `DCMT#${did}`, sk }, ConditionExpression: 'attribute_exists(pk)' } },
    {
      Update: {
        Key: { pk: `USER#${uid}`, sk: `DIARY#${did}` },
        UpdateExpression: 'ADD commentCount :minus',
        ExpressionAttributeValues: { ':minus': -1 },
      },
    },
  ]);
  return diaryDetail(ctx, uid, did);
}

async function commentDiary(ctx, uid, did) {
  const p = await ensureProfile(ctx);
  const d = await get(`USER#${uid}`, `DIARY#${did}`);
  if (!d) throw new HttpError(404, '日記が見つかりません');
  const body = text(ctx.body.text, { name: 'コメント', max: 1000 });
  await transact([
    {
      Put: {
        Item: { pk: `DCMT#${did}`, sk: `C#${String(nowMs()).padStart(15, '0')}#${randomBytes(3).toString('hex')}`, userId: p.userId, name: p.name, text: body, at: nowIso() },
      },
    },
    {
      Update: {
        Key: { pk: `USER#${uid}`, sk: `DIARY#${did}` },
        UpdateExpression: 'ADD commentCount :one',
        ExpressionAttributeValues: { ':one': 1 },
      },
    },
  ]);
  return diaryDetail(ctx, uid, did);
}

// ---------- Character memos (private) ----------
async function listMemos(ctx) {
  const uid = requireUser(ctx);
  const items = await query({
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': `USER#${uid}`, ':s': 'MEMO#' },
  });
  return { memos: items.map(strip) };
}
async function saveMemo(ctx, idx) {
  const uid = requireUser(ctx);
  const fighter = fighterOf(ctx.body.fighter);
  const body = text(ctx.body.text, { name: 'メモ', max: 3000, optional: true });
  if (!body) await del(`USER#${uid}`, `MEMO#${idx}`);
  else await put({ pk: `USER#${uid}`, sk: `MEMO#${idx}`, idx, fighter, text: body, at: nowIso() });
  return listMemos(ctx);
}

// ---------- Profile image ----------
const s3 = new S3Client({});
// Read width/height from the JPEG's frame header, so a small file cannot claim huge dimensions
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

// Drop every metadata segment (EXIF incl. GPS location, XMP, comments: APP1..APP15, COM) before
// an image becomes public. The page re-encodes images anyway; this also covers direct uploads.
function stripJpegMetadata(buf) {
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xda) { parts.push(buf.subarray(i)); return Buffer.concat(parts); } // image data follows
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (!((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe)) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

async function uploadAvatar(ctx) {
  const p = await ensureProfile(ctx);
  const b64 = String(ctx.body.image || '').replace(/^data:image\/jpeg;base64,/, '');
  const raw = Buffer.from(b64, 'base64');
  if (raw.length < 100 || raw.length > 300_000 || raw[0] !== 0xff || raw[1] !== 0xd8) {
    throw new HttpError(400, '画像はJPEG形式・300KB以下にしてください');
  }
  const buf = stripJpegMetadata(raw);
  if (!buf) throw new HttpError(400, '画像を読み込めませんでした。別の画像でお試しください');
  const size = jpegSize(buf);
  if (!size || size.w > 1024 || size.h > 1024) throw new HttpError(400, '画像は1024x1024以内にしてください');
  await s3.send(new PutObjectCommand({
    Bucket: process.env.AVATAR_BUCKET,
    Key: `avatars/${p.userId}.jpg`,
    Body: buf,
    ContentType: 'image/jpeg',
    CacheControl: 'max-age=60',
  }));
  const r = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: p.pk, sk: 'PROFILE' },
    UpdateExpression: 'SET avatarV = :v',
    ExpressionAttributeValues: { ':v': nowMs() },
    ReturnValues: 'ALL_NEW',
  }));
  return privateUser(r.Attributes);
}

// ---------- Contact form ----------
const CONTACT_TYPES = ['不具合報告', '悪質利用者の報告', '要望', 'その他'];
async function postContact(ctx) {
  const p = await ensureProfile(ctx);
  const type = CONTACT_TYPES.includes(ctx.body.type) ? ctx.body.type : 'その他';
  const body = text(ctx.body.body, { name: '内容', max: 3000 });
  const at = nowIso();
  const id = shortId();
  await put({ pk: `CONTACT#${id}`, sk: 'META', gsi1pk: 'CONTACT', gsi1sk: at, type, body, userId: p.userId, name: p.name, email: isDiscordEmail(ctx.claims.email) ? '' : ctx.claims.email ?? '', at });
  // The sender's own list of inquiries (and where replies are flagged as unread)
  await put({ pk: p.pk, sk: `CONTACT#${id}`, contactId: id, at });
  return { ok: true };
}
async function listContacts(ctx) {
  requireAdmin(ctx);
  const items = await query({ IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :p', ExpressionAttributeValues: { ':p': 'CONTACT' }, ScanIndexForward: false, Limit: 200 });
  return { contacts: items.map((c) => ({ id: c.pk.slice(8), ...strip(c) })) };
}
async function deleteContact(ctx, id) {
  requireAdmin(ctx);
  const c = await get(`CONTACT#${id}`, 'META');
  await del(`CONTACT#${id}`, 'META');
  if (c?.userId) await del(`USER#${c.userId}`, `CONTACT#${id}`);
  await audit(ctx, 'contact.delete', { contactId: id });
  return listContacts(ctx);
}

// A reply from the operators. The sender sees it under マイページ → お問い合わせ履歴 (there is no
// e-mail to send it to); replies are signed "運営", never with the admin's name.
async function replyContact(ctx, id) {
  requireAdmin(ctx);
  const reply = text(ctx.body.text, { name: '返信', max: 2000 });
  const c = await get(`CONTACT#${id}`, 'META');
  if (!c) throw new HttpError(404, 'お問い合わせが見つかりません');
  const at = nowIso();
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: c.pk, sk: 'META' },
    UpdateExpression: 'SET replies = list_append(if_not_exists(replies, :none), :r)',
    ExpressionAttributeValues: { ':none': [], ':r': [{ text: reply, at }] },
  }));
  // Inquiries sent before replies existed have no pointer yet: this creates it
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: `USER#${c.userId}`, sk: `CONTACT#${id}` },
    UpdateExpression: 'SET contactId = :id, #at = if_not_exists(#at, :sent), unread = :t, repliedAt = :now',
    ExpressionAttributeNames: { '#at': 'at' },
    ExpressionAttributeValues: { ':id': id, ':sent': c.at, ':t': true, ':now': at },
  }));
  await audit(ctx, 'contact.reply', { contactId: id, target: c.userId, targetName: c.name ?? '' });
  return listContacts(ctx);
}

// The signed-in player's inquiries, newest first, with any replies
async function myContacts(ctx) {
  const uid = requireUser(ctx);
  const refs = await query({ KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': `USER#${uid}`, ':s': 'CONTACT#' } });
  const items = (await Promise.all(refs.map((r) => get(`CONTACT#${r.contactId}`, 'META')))).filter(Boolean);
  items.sort((a, b) => b.at.localeCompare(a.at));
  return {
    contacts: items.map((c) => ({
      id: c.pk.slice(8), type: c.type, body: c.body, at: c.at, replies: c.replies ?? [],
      unread: Boolean(refs.find((r) => r.contactId === c.pk.slice(8))?.unread),
    })),
  };
}
async function readMyContacts(ctx) {
  const uid = requireUser(ctx);
  const refs = await query({
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', FilterExpression: 'unread = :t',
    ExpressionAttributeValues: { ':p': `USER#${uid}`, ':s': 'CONTACT#', ':t': true },
  });
  await Promise.all(refs.map((r) => ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: r.pk, sk: r.sk }, UpdateExpression: 'REMOVE unread',
  }))));
  return { ok: true };
}

// ---------- Points: symbol gacha ----------
const SERIES = ['マリオ', 'ドンキーコング', 'ゼルダ', 'メトロイド', 'ヨッシー', 'カービィ', 'スターフォックス', 'ポケモン', 'MOTHER', 'F-ZERO',
  'アイスクライマー', 'ファイアーエムブレム', 'ゲーム&ウオッチ', 'パルテナ', 'ワリオ', 'メタルギア', 'ソニック', 'ピクミン', 'ロボット', 'どうぶつの森',
  'ロックマン', 'WiiFit', 'パンチアウト', 'ゼノブレイド', 'ダックハント', 'ストリートファイター', 'ファイナルファンタジー', 'ベヨネッタ', 'スプラトゥーン',
  '悪魔城ドラキュラ', 'ペルソナ', 'ドラゴンクエスト', 'バンジョー&カズーイ', '餓狼伝説', 'マインクラフト', '鉄拳', 'キングダムハーツ', 'パックマン'];
const GACHA_COST = 3;

async function spendPoints(p, cost) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: p.pk, sk: 'PROFILE' },
      UpdateExpression: 'ADD points :neg',
      ConditionExpression: 'points >= :cost',
      ExpressionAttributeValues: { ':neg': -cost, ':cost': cost },
    }));
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw new HttpError(409, `ポイントが足りません（${cost}ポイント必要です）`);
    throw e;
  }
}

async function gachaInfo(ctx) {
  const history = await query({ IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :p', ExpressionAttributeValues: { ':p': 'GACHA' }, ScanIndexForward: false, Limit: 50 });
  let mine = [];
  if (ctx.claims?.sub) {
    mine = await query({ KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': `USER#${ctx.claims.sub}`, ':s': 'SYMBOL#' } });
  }
  return { cost: GACHA_COST, history: history.map(strip), symbols: mine.map((s) => ({ symbol: s.symbol, count: s.count })) };
}

async function drawGacha(ctx) {
  const p = await ensureProfile(ctx);
  await spendPoints(p, GACHA_COST);
  const series = SERIES[randomBytes(4).readUInt32BE() % SERIES.length];
  const gold = randomBytes(1)[0] < 13; // ~5%
  const symbol = `${gold ? '金の' : ''}${series}シンボル`;
  const at = nowIso();
  await Promise.all([
    ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: p.pk, sk: `SYMBOL#${symbol}` },
      UpdateExpression: 'SET symbol = :s, gold = :g ADD #c :one',
      ExpressionAttributeNames: { '#c': 'count' },
      ExpressionAttributeValues: { ':s': symbol, ':g': gold, ':one': 1 },
    })),
    put({ pk: `GACHA#${shortId()}`, sk: 'META', gsi1pk: 'GACHA', gsi1sk: at, userId: p.userId, name: p.name, symbol, gold, at, ttl: epoch() + 30 * 86400 }),
  ]);
  return { symbol, gold, ...(await gachaInfo(ctx)) };
}

// ---------- Points: minimum game (lowest unique number wins the pot) ----------
const MIN_COST = 3;
const jstDate = (ms = Date.now()) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const jstHour = (ms = Date.now()) => new Date(ms + 9 * 3600_000).getUTCHours();

async function minimumResult(date) {
  const cached = await get(`MIN#${date}`, 'RESULT');
  if (cached) return strip(cached);
  const votes = await query({ KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': `MIN#${date}`, ':s': 'VOTE#' } });
  const counts = {};
  for (const v of votes) counts[v.n] = (counts[v.n] ?? 0) + 1;
  const unique = Object.keys(counts).map(Number).filter((n) => counts[n] === 1).sort((a, b) => a - b);
  const winning = unique[0] ?? null;
  const winner = winning == null ? null : votes.find((v) => v.n === winning);
  const result = {
    pk: `MIN#${date}`, sk: 'RESULT', date, participants: votes.length, number: winning,
    winnerId: winner?.userId ?? null, winnerName: winner?.name ?? null, prize: votes.length * MIN_COST,
  };
  try {
    const items = [{ Put: { Item: result, ConditionExpression: 'attribute_not_exists(pk)' } }];
    if (winner) items.push({ Update: { Key: { pk: `USER#${winner.userId}`, sk: 'PROFILE' }, UpdateExpression: 'ADD points :p', ExpressionAttributeValues: { ':p': result.prize } } });
    await transact(items);
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    return strip(await get(`MIN#${date}`, 'RESULT'));
  }
  return strip(result);
}

async function minimumInfo(ctx) {
  const uid = requireUser(ctx);
  const today = jstDate();
  const open = jstHour() < 22;
  const [mine, votes] = await Promise.all([
    get(`MIN#${today}`, `VOTE#${uid}`),
    ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': `MIN#${today}`, ':s': 'VOTE#' }, Select: 'COUNT' })),
  ]);
  const yesterday = jstDate(Date.now() - 86400_000);
  const results = [];
  if (!open) results.push(await minimumResult(today));
  results.push(await minimumResult(yesterday));
  return { date: today, open, cost: MIN_COST, myVote: mine?.n ?? null, participants: votes.Count ?? 0, results };
}

async function voteMinimum(ctx) {
  const p = await ensureProfile(ctx);
  if (jstHour() >= 22) throw new HttpError(409, '本日の投票は締め切りました（0時〜22時に投票できます）');
  const n = int(ctx.body.n, { name: '数字', min: 1, max: 100 });
  const today = jstDate();
  if (await get(`MIN#${today}`, `VOTE#${p.userId}`)) throw new HttpError(409, '本日はすでに投票済みです');
  await spendPoints(p, MIN_COST);
  try {
    await put({ pk: `MIN#${today}`, sk: `VOTE#${p.userId}`, userId: p.userId, name: p.name, n, at: nowIso(), ttl: epoch() + 7 * 86400 }, 'attribute_not_exists(pk)');
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw new HttpError(409, '本日はすでに投票済みです');
    throw e;
  }
  return minimumInfo(ctx);
}

// ---------- Rated-battle stats ----------
async function rateStats() {
  const t = nowMs();
  const [queue, recent] = await Promise.all([
    query({ KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'OPEN' } }),
    query({ IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :p AND gsi1sk >= :s', ExpressionAttributeValues: { ':p': 'MATCH', ':s': new Date(t - 30 * 60000).toISOString() } }),
  ]);
  const waiting = queue.filter((e) => !e.test && t - e.lastSeen < OPEN_STALE_MS).length;
  const playing = recent.filter((m) => !m.test && !m.adminOnly && m.status === 'playing').length * 2;
  return { waiting, playing, total: waiting + playing };
}

// ---------- Tournaments a player entered ----------
async function userTournaments(ctx, uid) {
  const entries = await query({ KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': `USER#${uid}`, ':s': 'TENT#' } });
  const tours = await Promise.all(entries.slice(-50).map((e) => get(`TOUR#${e.tourId}`, 'META')));
  const list = tours.filter(Boolean).map((t) => {
    let result = t.status === 'recruiting' ? 'エントリー中' : t.status === 'running' ? '進行中' : '';
    if (t.bracket) {
      const R = t.bracket.length;
      if (t.championId === uid) result = '優勝';
      else {
        for (let r = 0; r < R; r++) {
          const lost = t.bracket[r].find((m) => (m.p1 === uid || m.p2 === uid) && m.winner && m.winner !== uid);
          if (lost) { result = r === R - 1 ? '準優勝' : `ベスト${2 ** (R - r)}`; break; }
        }
      }
    }
    return { tourId: t.tourId, title: t.title, startAt: t.startAt, entryCount: t.entryCount, status: t.status, result };
  });
  return { tournaments: list.sort((a, b) => b.startAt.localeCompare(a.startAt)) };
}

// ---------- Admin: user management ----------
async function adminListUsers(ctx) {
  requireAdmin(ctx);
  const users = await priv('listUsers');
  const profiles = await Promise.all(users.map((u) => getProfile(u.Username).catch(() => null)));
  return {
    users: users.map((u, i) => {
      const attr = Object.fromEntries((u.Attributes ?? []).map((a) => [a.Name, a.Value]));
      const p = profiles[i];
      return {
        userId: attr.sub ?? u.Username,
        username: u.Username,
        email: isDiscordEmail(attr.email) ? '' : attr.email ?? '',
        emailVerified: attr.email_verified === 'true',
        status: u.UserStatus,
        enabled: u.Enabled,
        createdAt: u.UserCreateDate,
        name: p?.name ?? '',
        memberNo: p?.memberNo ?? null,
        discordId: p?.discordId ?? '',
        discordUsername: p?.discordUsername ?? '',
        discordGlobalName: p?.discordGlobalName ?? '',
        rating: p?.rating ?? null,
        wins: p?.wins ?? 0,
        losses: p?.losses ?? 0,
      };
    }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
  };
}
function targetUser(ctx, uid) {
  requireAdmin(ctx);
  if (uid === ctx.claims.sub) throw new HttpError(400, '自分自身のアカウントはこの画面から操作できません');
  // With several admins, none can suspend or delete another from the admin page
  if (isAdminSub(uid)) throw new HttpError(400, '管理者のアカウントはこの画面から操作できません');
  return uid;
}
async function adminResetPassword(ctx, uid) {
  targetUser(ctx, uid);
  if ((await getProfile(uid))?.discordId) throw new HttpError(400, 'Discordアカウントにはパスワードがありません');
  await priv('resetPassword', { uid });
  await audit(ctx, 'user.resetPassword', { target: uid, targetName: (await getProfile(uid))?.name ?? '' });
  return { ok: true };
}
async function adminSetEnabled(ctx, uid) {
  targetUser(ctx, uid);
  const enable = ctx.body.enabled === true;
  if (enable) {
    await del(`USER#${uid}`, 'BANNED');
    await priv('setEnabled', { uid, enabled: true });
  } else {
    // The BANNED row is what takes effect immediately; Cognito alone would leave the
    // already-issued ID token usable for up to an hour.
    await put({ pk: `USER#${uid}`, sk: 'BANNED', at: nowIso(), by: ctx.claims.sub });
    await priv('setEnabled', { uid, enabled: false });
    await priv('globalSignOut', { uid }).catch(() => {});
  }
  await audit(ctx, enable ? 'user.enable' : 'user.disable', { target: uid, targetName: (await getProfile(uid))?.name ?? '' });
  return { ok: true, enabled: enable };
}
async function adminDeleteUser(ctx, uid) {
  targetUser(ctx, uid);
  // The admin page sends this only after "削除" has been typed in (guards against mis-taps / stray calls)
  if (ctx.query.confirm !== 'delete') throw new HttpError(400, '確認のため「削除」と入力してください');
  const prof = await getProfile(uid);
  // Data first, and paged: if this fails halfway the account still exists in the admin list,
  // so the delete can simply be run again. Match history stays so opponents' records hold.
  const own = [];
  let startKey;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': `USER#${uid}` },
      ExclusiveStartKey: startKey,
    }));
    own.push(...(r.Items ?? []).filter((it) => !it.sk.startsWith('HIST#')));
    startKey = r.LastEvaluatedKey;
  } while (startKey);
  for (let i = 0; i < own.length; i += 20) {
    await Promise.all(own.slice(i, i + 20).map((it) => del(it.pk, it.sk)));
  }
  await del('QUEUE', `USER#${uid}`);
  // The profile image is public, so it goes too (older versions expire with the bucket's lifecycle rule)
  await s3.send(new DeleteObjectCommand({ Bucket: process.env.AVATAR_BUCKET, Key: `avatars/${uid}.jpg` }));
  // Then the identity. The Discord link is released last, so a half-finished delete never
  // leaves the Discord account free while its data is still here.
  await priv('globalSignOut', { uid }).catch(() => {});
  await priv('deleteUser', { uid }).catch((e) => {
    if (e.name !== 'UserNotFoundException') throw e;
  });
  if (prof?.discordId) await del(`DISCORD#${prof.discordId}`, 'LINK');
  // A deleted account's ID token stays valid for up to an hour; without this marker the next
  // request with it would recreate an empty profile (authenticate() refuses marked accounts)
  await put({ pk: `USER#${uid}`, sk: 'BANNED', deleted: true, at: nowIso(), by: ctx.claims.sub });
  await audit(ctx, 'user.delete', { target: uid, targetName: prof?.name ?? '', removed: own.length });
  return { ok: true, removed: own.length };
}

// ---------- Router ----------
const ID = '([A-Za-z0-9_-]+)';
const routes = [
  ['GET', /^\/api\/me$/, getMe],
  ['PUT', /^\/api\/me$/, updateMe],
  ['PUT', /^\/api\/me\/stages$/, updateStages],
  ['GET', /^\/api\/site$/, getSite],
  ['PUT', /^\/api\/admin\/site$/, updateSite],
  ['GET', /^\/api\/admin\/contacts$/, listContacts],
  ['GET', /^\/api\/admin\/audit$/, adminListAudit],
  ['GET', /^\/api\/admin\/users$/, adminListUsers],
  ['GET', /^\/api\/admin\/matches$/, adminListMatches],
  ['POST', new RegExp(`^/api/admin/matches/${ID}/result$`), adminSetResult],
  ['POST', new RegExp(`^/api/admin/users/${ID}/reset-password$`), adminResetPassword],
  ['POST', new RegExp(`^/api/admin/users/${ID}/enabled$`), adminSetEnabled],
  ['DELETE', new RegExp(`^/api/admin/users/${ID}$`), adminDeleteUser],
  ['DELETE', new RegExp(`^/api/admin/contacts/${ID}$`), deleteContact],
  ['POST', new RegExp(`^/api/admin/contacts/${ID}/reply$`), replyContact],
  ['GET', /^\/api\/me\/contacts$/, myContacts],
  ['POST', /^\/api\/me\/contacts\/read$/, readMyContacts],
  ['POST', /^\/api\/contact$/, postContact],
  ['PUT', /^\/api\/me\/avatar$/, uploadAvatar],
  ['GET', /^\/api\/me\/memos$/, listMemos],
  ['PUT', /^\/api\/me\/memos\/(\d{1,3})$/, saveMemo],
  ['GET', /^\/api\/gacha$/, gachaInfo],
  ['POST', /^\/api\/gacha$/, drawGacha],
  ['GET', /^\/api\/minimum$/, minimumInfo],
  ['POST', /^\/api\/minimum$/, voteMinimum],
  ['GET', /^\/api\/rate\/stats$/, rateStats],
  ['GET', new RegExp(`^/api/users/${ID}/tournaments$`), userTournaments],
  ['GET', new RegExp(`^/api/free/rooms/${ID}/secret$`), roomSecret],
  ['POST', new RegExp(`^/api/users/${ID}/diaries/${ID}/like$`), likeDiary],
  ['POST', new RegExp(`^/api/users/${ID}/diaries/${ID}/comments$`), commentDiary],
  ['DELETE', new RegExp(`^/api/users/${ID}/diaries/${ID}/comments/(.+)$`), deleteComment],
  ['GET', new RegExp(`^/api/users/${ID}$`), getUser],
  ['GET', new RegExp(`^/api/users/${ID}/intros$`), listIntros],
  ['POST', new RegExp(`^/api/users/${ID}/intros$`), writeIntro],
  ['DELETE', new RegExp(`^/api/users/${ID}/intros/${ID}$`), deleteIntro],
  ['POST', new RegExp(`^/api/matches/${ID}/room$`), setMatchRoom],
  ['POST', new RegExp(`^/api/matches/${ID}/fighter$`), setNextFighter],
  ['GET', /^\/api\/ranking$/, ranking],
  ['GET', /^\/api\/users$/, searchUsers],
  ['GET', /^\/api\/season$/, getSeason],
  ['PUT', /^\/api\/admin\/season$/, adminSetSeason],
  ['PUT', /^\/api\/admin\/season-end$/, adminSetSeasonEnd],
  ['PUT', /^\/api\/me\/switches$/, updateSwitches],

  ['POST', /^\/api\/rate\/queue$/, enqueue],
  ['DELETE', /^\/api\/rate\/queue$/, dequeue],
  ['GET', /^\/api\/rate\/status$/, rateStatus],
  ['GET', /^\/api\/matches$/, listMatches],
  ['GET', new RegExp(`^/api/matches/${ID}$`), getMatch],
  ['POST', new RegExp(`^/api/matches/${ID}/report$`), reportMatch],
  ['POST', new RegExp(`^/api/matches/${ID}/cancel$`), cancelMatch],
  ['GET', new RegExp(`^/api/matches/${ID}/messages$`), matchMessages],
  ['POST', new RegExp(`^/api/matches/${ID}/messages$`), postMatchMessage],

  ['GET', /^\/api\/free\/rooms$/, listRooms],
  ['POST', /^\/api\/free\/rooms$/, createRoom],
  ['GET', new RegExp(`^/api/free/rooms/${ID}$`), getRoom],
  ['POST', new RegExp(`^/api/free/rooms/${ID}/join$`), joinRoom],
  ['POST', new RegExp(`^/api/free/rooms/${ID}/close$`), closeRoom],
  ['GET', new RegExp(`^/api/free/rooms/${ID}/messages$`), roomMessages],
  ['POST', new RegExp(`^/api/free/rooms/${ID}/messages$`), postRoomMessage],

  ['GET', /^\/api\/tournaments$/, listTournaments],
  ['POST', /^\/api\/tournaments$/, createTournament],
  ['GET', new RegExp(`^/api/tournaments/${ID}$`), getTournament],
  ['POST', new RegExp(`^/api/tournaments/${ID}/entry$`), enterTournament],
  ['DELETE', new RegExp(`^/api/tournaments/${ID}/entry$`), leaveTournament],
  ['POST', new RegExp(`^/api/tournaments/${ID}/start$`), startTournament],
  ['POST', new RegExp(`^/api/tournaments/${ID}/result$`), reportTournament],

  ['GET', /^\/api\/diaries$/, listDiaries],
  ['POST', /^\/api\/diaries$/, createDiary],
  ['GET', new RegExp(`^/api/users/${ID}/diaries/${ID}$`), diaryDetail],
  ['DELETE', new RegExp(`^/api/users/${ID}/diaries/${ID}$`), deleteDiary],
];

// ---------- Session: Cognito tokens kept in HttpOnly cookies ----------
// The browser never sees the tokens. Writes require a double-submit CSRF token
// (readable cookie == X-CSRF-Token header) plus a same-origin Origin header.
const SITE_URL = process.env.SITE_URL; // e.g. https://xxxx.cloudfront.net/
const SITE_ORIGIN = SITE_URL ? new URL(SITE_URL).origin : '';
const CLIENT_ID = process.env.CLIENT_ID;
const ISSUER = `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.USER_POOL_ID}`;
const ORIGIN_SECRET = process.env.ORIGIN_SECRET;
// Must match the app client's refreshTokenValidity (a stale cookie would just fail to refresh)
const REFRESH_DAYS = 7;
const C_ID = '__Host-id';
const C_RT = '__Host-rt';
const C_CSRF = '__Host-csrf';

const cookie = (name, value, { maxAge, httpOnly = true, sameSite = 'Strict' } = {}) =>
  `${name}=${value}; Path=/; Secure; SameSite=${sameSite}${httpOnly ? '; HttpOnly' : ''}; Max-Age=${maxAge}`;
const clearCookie = (name) => `${name}=; Path=/; Secure; SameSite=Strict; Max-Age=0`;
const parseCookies = (list = []) => Object.fromEntries(list.flatMap((s) => s.split(';')).map((c) => {
  const i = c.indexOf('=');
  return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
}).filter(([k]) => k));

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

let jwkCache = {};
async function signingKey(kid) {
  if (!jwkCache[kid]) {
    const r = await fetch(`${ISSUER}/.well-known/jwks.json`);
    const { keys } = await r.json();
    jwkCache = Object.fromEntries(keys.map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
  }
  return jwkCache[kid];
}

// Returns { claims } for a valid token, { expired: true } for a well-signed expired one, or null.
async function verifyIdToken(token) {
  try {
    const [h, p, s] = String(token).split('.');
    if (!s) return null;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (header.alg !== 'RS256') return null;
    const key = await signingKey(header.kid);
    if (!key || !cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) return null;
    const c = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (c.iss !== ISSUER || c.aud !== CLIENT_ID || c.token_use !== 'id') return null;
    if (c.exp * 1000 < Date.now()) return { expired: true };
    return { claims: c };
  } catch {
    return null;
  }
}

async function refreshIdToken(refreshToken) {
  try {
    const r = await cognitoIdp.send(new InitiateAuthCommand({ ClientId: CLIENT_ID, AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: refreshToken } }));
    return r.AuthenticationResult?.IdToken ?? null;
  } catch {
    return null;
  }
}

// Resolve the caller from cookies, then make sure the account is still allowed in.
async function authenticate(cookies, setCookies) {
  const claims = await resolveClaims(cookies, setCookies);
  if (claims?.sub && (await get(`USER#${claims.sub}`, 'BANNED'))) {
    setCookies.push(clearCookie(C_ID), clearCookie(C_RT), clearCookie(C_CSRF));
    return undefined;
  }
  return claims;
}

// Reads the cookies, transparently refreshing an expired ID token.
async function resolveClaims(cookies, setCookies) {
  const id = cookies[C_ID];
  if (id) {
    const v = await verifyIdToken(id);
    if (v?.claims) return v.claims;
  }
  const rt = cookies[C_RT];
  if (!rt) return undefined;
  const idToken = await refreshIdToken(rt);
  const v = idToken && await verifyIdToken(idToken);
  if (!v?.claims) {
    setCookies.push(clearCookie(C_ID), clearCookie(C_RT), clearCookie(C_CSRF));
    return undefined;
  }
  setCookies.push(cookie(C_ID, idToken, { maxAge: 3600 }));
  return v.claims;
}

const redirect = (location, cookies = []) => ({ statusCode: 302, headers: { location, 'cache-control': 'no-store' }, cookies });
const safeReturn = (r) => (/^#\/[\w\-/%.]{0,200}$/.test(r ?? '') ? r : '#/');

async function authLogout(cookies) {
  if (cookies[C_RT]) {
    await cognitoIdp.send(new RevokeTokenCommand({ Token: cookies[C_RT], ClientId: CLIENT_ID })).catch(() => {});
  }
  return {
    body: { logoutUrl: SITE_URL },
    cookies: [clearCookie(C_ID), clearCookie(C_RT), clearCookie(C_CSRF)],
  };
}

// ---------- In-app sign-up / sign-in (Japanese UI, no hosted page) ----------
const cognitoIdp = new CognitoIdentityProviderClient({});
const sessionCookies = (t) => [
  cookie(C_ID, t.IdToken, { maxAge: 3600 }),
  cookie(C_RT, t.RefreshToken, { maxAge: REFRESH_DAYS * 86400 }),
  cookie(C_CSRF, randomBytes(24).toString('base64url'), { maxAge: 30 * 86400, httpOnly: false }),
];
// Discord accounts carry a non-deliverable synthetic address instead of a real e-mail
// ("@users.<something>.invalid", set per site; it is part of every account's sign-in name)
const DISCORD_EMAIL_DOMAIN = (process.env.DISCORD_EMAIL_DOMAIN || '').toLowerCase();
const discordEmail = (discordId) => {
  if (!DISCORD_EMAIL_DOMAIN) throw new Error('DISCORD_EMAIL_DOMAIN is not set');
  return `discord-${discordId}${DISCORD_EMAIL_DOMAIN}`;
};
function isDiscordEmail(v) { return Boolean(DISCORD_EMAIL_DOMAIN) && String(v ?? '').toLowerCase().endsWith(DISCORD_EMAIL_DOMAIN); }
// ---------- Discord sign-in (OAuth2, "identify" scope only, no e-mail) ----------
// Discord is not OIDC, so Cognito can't federate it directly. After verifying the user
// with Discord we map the Discord ID to a password-less Cognito user and mint Cognito
// tokens server-side (a throw-away random password set + ADMIN_USER_PASSWORD_AUTH,
// only possible with this function's IAM role). The session is then the usual cookies.
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_SECRET_PARAM = process.env.DISCORD_SECRET_PARAM || '';
const DISCORD_CALLBACK = `${SITE_URL}api/auth/discord/callback`;
// Members-only mode: the user must belong to this Discord server (checked on every sign-in;
// the server list is only checked, never stored)
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '';
async function inRequiredGuild(accessToken) {
  if (!DISCORD_GUILD_ID) return true;
  // Discord caps membership at 100 (200 with Nitro) and returns at most 200 per page,
  // so one page is enough today; paging keeps this correct if that ever changes.
  let after = '';
  for (let page = 0; page < 5; page++) {
    const url = `https://discord.com/api/users/@me/guilds?limit=200${after ? `&after=${after}` : ''}`;
    const r = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return false;
    const guilds = await r.json();
    if (!Array.isArray(guilds) || guilds.length === 0) return false;
    if (guilds.some((g) => g.id === DISCORD_GUILD_ID)) return true;
    if (guilds.length < 200) return false;
    after = guilds[guilds.length - 1].id;
  }
  return false;
}
const C_DOAUTH = '__Host-doauth';
const C_DPEND = '__Host-dpend';
const ssm = new SSMClient({});
const sns = new SNSClient({});
const ALERT_TOPIC_ARN = process.env.ALERT_TOPIC_ARN || '';
const ALERT_TAG = process.env.ALERT_TAG || 'site';
let discordSecretCache = null;
async function discordSecret() {
  if (!discordSecretCache) {
    const r = await ssm.send(new GetParameterCommand({ Name: DISCORD_SECRET_PARAM, WithDecryption: true }));
    discordSecretCache = r.Parameter.Value;
  }
  return discordSecretCache;
}
// Signing key for the short-lived Discord cookies. Deliberately NOT the origin secret:
// that value is a transport marker that sits in the CloudFront config and the Lambda
// environment, whereas this one mints sessions and never leaves SSM.
const COOKIE_KEY_PARAM = process.env.COOKIE_KEY_PARAM || '';
let cookieKeyCache = null;
async function cookieKey() {
  if (!cookieKeyCache) {
    const r = await ssm.send(new GetParameterCommand({ Name: COOKIE_KEY_PARAM, WithDecryption: true }));
    cookieKeyCache = Buffer.from(r.Parameter.Value, 'base64');
  }
  return cookieKeyCache;
}
// "purpose" is part of the MAC, so a cookie minted for one step cannot be replayed in another.
const sign = async (purpose, obj) => {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const mac = createHmac('sha256', await cookieKey()).update(`${purpose}.${body}`).digest('base64url');
  return `${body}.${mac}`;
};
const unsign = async (purpose, v) => {
  const [body, mac] = String(v ?? '').split('.');
  if (!body || !mac) return null;
  const expect = createHmac('sha256', await cookieKey()).update(`${purpose}.${body}`).digest('base64url');
  if (!safeEqual(mac, expect)) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString());
    return o.exp > Date.now() ? o : null;
  } catch {
    return null;
  }
};

async function discordAuthorize(q) {
  if (!DISCORD_CLIENT_ID) throw new HttpError(404, 'Discordログインは無効です');
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code', client_id: DISCORD_CLIENT_ID, redirect_uri: DISCORD_CALLBACK, scope: DISCORD_GUILD_ID ? 'identify guilds' : 'identify',
    state, prompt: 'none', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  const tmp = await sign('doauth', { state, verifier, ret: safeReturn(q.return), exp: Date.now() + 600_000 });
  return {
    webUrl: `https://discord.com/oauth2/authorize?${params}`,
    // Discord mobile app deep link (unofficial; the page falls back to webUrl if the app doesn't open)
    appUrl: `discord://-/oauth2/authorize?${params}`,
    cookie: cookie(C_DOAUTH, tmp, { maxAge: 600, sameSite: 'Lax' }),
  };
}

async function discordLogin(event) {
  const a = await discordAuthorize(event.queryStringParameters ?? {});
  return redirect(a.webUrl, [a.cookie]);
}

// Mobile: same as discordLogin but returns both URLs so the page can try the app first
async function discordStart(event) {
  const a = await discordAuthorize(event.queryStringParameters ?? {});
  return { body: { appUrl: a.appUrl, webUrl: a.webUrl }, cookies: [a.cookie] };
}

const cognitoSessionFor = (username) => priv('mintSession', { username });

// Discord handle / display name, kept for the admin user list only (never in public APIs); refreshed on every sign-in
async function saveDiscordName(uid, du) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: `USER#${uid}`, sk: 'PROFILE' },
    UpdateExpression: 'SET discordUsername = :u, discordGlobalName = :g', ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':u': String(du.username ?? '').slice(0, 40), ':g': String(du.global_name ?? '').slice(0, 40) },
  })).catch((e) => { if (e.name !== 'ConditionalCheckFailedException') throw e; });
}

async function discordCallback(event, cookies) {
  const q = event.queryStringParameters ?? {};
  const tmp = await unsign('doauth', cookies[C_DOAUTH]);
  const fail = (why) => redirect(`${SITE_URL}#/login?discord=${encodeURIComponent(why)}`, [clearCookie(C_DOAUTH)]);
  if (q.error) return fail('cancelled');
  if (!tmp || !q.code || !safeEqual(q.state, tmp.state)) return fail('state');
  const tok = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: q.code, redirect_uri: DISCORD_CALLBACK,
      client_id: DISCORD_CLIENT_ID, client_secret: await discordSecret(), code_verifier: tmp.verifier,
    }),
  }).then((r) => (r.ok ? r.json() : null));
  if (!tok?.access_token) return fail('token');
  const du = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${tok.access_token}` } }).then((r) => (r.ok ? r.json() : null));
  if (!du?.id || !/^\d{5,25}$/.test(du.id)) return fail('profile');
  if (!(await inRequiredGuild(tok.access_token))) return fail('guild');

  const link = await get(`DISCORD#${du.id}`, 'LINK');
  if (link) {
    await saveDiscordName(link.userId, du);
    const t = await cognitoSessionFor(link.username);
    return redirect(`${SITE_URL}${safeReturn(tmp.ret)}`, [clearCookie(C_DOAUTH), ...sessionCookies(t)]);
  }
  // New accounts: the Discord account must be at least 30 days old (sub-account / spam guard)
  const createdMs = Number(BigInt(du.id) >> 22n) + 1420070400000;
  if (Date.now() - createdMs < 30 * 86400_000) return fail('young');
  // First time: confirm the terms before creating the account
  const name = String(du.global_name || du.username || 'player').slice(0, 20);
  // One-shot: the matching row is deleted when redeemed, so a captured cookie is useless afterwards
  const nonce = randomBytes(18).toString('base64url');
  await put({ pk: `PEND#${nonce}`, sk: 'META', at: nowIso(), ttl: epoch() + 900 });
  const pend = await sign('dpend', { id: du.id, name, username: du.username || '', avatar: du.avatar || '', nonce, exp: Date.now() + 15 * 60_000 });
  return redirect(`${SITE_URL}#/discord-signup`, [clearCookie(C_DOAUTH), cookie(C_DPEND, pend, { maxAge: 900 })]);
}

async function discordComplete(event, cookies, b) {
  const p = await unsign('dpend', cookies[C_DPEND]);
  if (!p) throw new HttpError(400, 'Discordでの認証からやり直してください');
  if (b.agree !== true) throw new HttpError(400, '利用規約への同意が必要です');
  // Redeem the one-shot marker; a replay finds it gone and stops here
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE, Key: { pk: `PEND#${p.nonce}`, sk: 'META' }, ConditionExpression: 'attribute_exists(pk)',
    }));
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    throw new HttpError(400, 'Discordでの認証からやり直してください');
  }
  // This endpoint only ever creates a brand-new account: an existing one signs in through the callback
  if (await get(`DISCORD#${p.id}`, 'LINK')) throw new HttpError(409, 'このDiscordアカウントは登録済みです。ログインからやり直してください');
  // Pool usernames are e-mail addresses; Discord users get a non-deliverable synthetic one
  const username = discordEmail(p.id);
  try {
    await priv('createUser', { username, name: p.name });
  } catch (e) { if (e.name !== 'UsernameExistsException') throw e; }
  const t = await cognitoSessionFor(username);
  const sub = JSON.parse(Buffer.from(t.IdToken.split('.')[1], 'base64url').toString()).sub;
  await put({ pk: `DISCORD#${p.id}`, sk: 'LINK', username, userId: sub, at: nowIso() });
  // Pre-create the profile with the Discord display name (the e-mail claim marks a Discord
  // account, which is what earns a member number)
  await ensureProfile({ claims: { sub, name: p.name, email: username } });
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: `USER#${sub}`, sk: 'PROFILE' },
    UpdateExpression: 'SET discordId = :d', ExpressionAttributeValues: { ':d': p.id },
  }));
  await saveDiscordName(sub, { username: p.username, global_name: p.name });
  return { body: { ok: true }, cookies: [clearCookie(C_DPEND), ...sessionCookies(t)] };
}

// Pre-login forms have no session yet: require our exact Origin and a custom header
// (a cross-site page can't send either without a CORS preflight, which we never allow).
function checkAnonCsrf(event) {
  if (event.headers?.origin !== SITE_ORIGIN || !event.headers?.['x-csrf-token']) throw new HttpError(403, '不正なリクエストです');
}

// Features not opened yet (pre-release): tournaments, symbol gacha, minimum game
// Always closed on every site; a site can close more through CLOSED_FEATURES (comma-separated)
const CLOSED = new Set(['tournaments', 'gacha', 'minimum',
  ...(process.env.CLOSED_FEATURES || '').split(',').map((s) => s.trim()).filter(Boolean)]);
const CLOSED_PATHS = [
  ['tournaments', /^\/api\/tournaments(\/|$)|^\/api\/users\/[^/]+\/tournaments$/],
  ['gacha', /^\/api\/gacha(\/|$)/],
  ['minimum', /^\/api\/minimum(\/|$)/],
  ['diaries', /^\/api\/diaries(\/|$)|^\/api\/users\/[^/]+\/diaries(\/|$)/],
  ['free', /^\/api\/free(\/|$)/],
].filter(([feature]) => CLOSED.has(feature)).map(([, re]) => re);
const isClosedPath = (path) => CLOSED_PATHS.some((re) => re.test(path));

function checkCsrf(event, cookies) {
  const origin = event.headers?.origin;
  if (origin && origin !== SITE_ORIGIN) throw new HttpError(403, '不正なリクエストです');
  if (!safeEqual(event.headers?.['x-csrf-token'], cookies[C_CSRF])) throw new HttpError(403, '不正なリクエストです（ページを再読み込みしてください）');
}

export const handler = async (event) => {
  const setCookies = [];
  const respond = (status, body) => ({ ...json(status, body), cookies: setCookies });
  try {
    // Only CloudFront (which adds the secret header, behind WAF) may reach the API
    if (!safeEqual(event.headers?.['x-origin-verify'], ORIGIN_SECRET)) return json(403, { message: 'Forbidden' });

    const method = event.requestContext.http.method;
    const path = event.rawPath.replace(/\/+$/, '');
    const cookies = parseCookies(event.cookies);

    // Reject oversized payloads before anything parses them (the avatar upload is the only
    // large one, and the browser resizes it to a 200x200 JPEG first, so ~30KB in practice)
    if (event.body) {
      const bytes = event.isBase64Encoded ? Math.ceil(event.body.length * 3 / 4) : Buffer.byteLength(event.body);
      if (bytes > (path === '/api/me/avatar' ? 1_500_000 : 1_000_000)) {
        return respond(413, { message: 'データが大きすぎます' });
      }
    }

    if (path.startsWith('/api/auth/')) await throttleAuth(event, path);

    if (method === 'GET' && path === '/api/auth/discord/login') return await discordLogin(event);
    if (method === 'GET' && path === '/api/auth/discord/start') {
      const r = await discordStart(event);
      setCookies.push(...r.cookies);
      return respond(200, r.body);
    }
    if (method === 'GET' && path === '/api/auth/discord/callback') return await discordCallback(event, cookies);
    if (method === 'GET' && path === '/api/auth/discord/pending') {
      const p = await unsign('dpend', cookies[C_DPEND]);
      return respond(200, p ? { name: p.name } : { name: null });
    }
    if (method === 'POST' && path === '/api/auth/discord/complete') {
      checkAnonCsrf(event);
      let b = {};
      try { b = JSON.parse(event.body ?? '{}'); } catch { throw new HttpError(400, 'JSON が不正です'); }
      const r = await discordComplete(event, cookies, b ?? {});
      setCookies.push(...r.cookies);
      return respond(200, r.body);
    }
    if (method !== 'GET') checkCsrf(event, cookies);
    if (method === 'POST' && path === '/api/auth/logout') {
      const r = await authLogout(cookies);
      setCookies.push(...r.cookies);
      return respond(200, r.body);
    }

    if (isClosedPath(path)) return respond(404, { message: 'この機能は現在準備中です' });

    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
      } catch {
        throw new HttpError(400, 'JSON が不正です');
      }
    }
    const ctx = {
      method,
      path,
      body: body ?? {},
      query: event.queryStringParameters ?? {},
      claims: await authenticate(cookies, setCookies),
    };
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const match = path.match(re);
      if (match) {
        await throttleWrites(ctx);
        return respond(200, await fn(ctx, ...match.slice(1)));
      }
    }
    return respond(404, { message: 'Not found' });
  } catch (e) {
    if (e instanceof HttpError) return respond(e.status, { message: e.message });
    if (e.name === 'ConditionalCheckFailedException' || e.name === 'TransactionCanceledException') {
      return respond(409, { message: '状態が更新されました。画面を再読み込みしてください' });
    }
    console.error(e);
    return respond(500, { message: 'サーバーエラーが発生しました' });
  }
};
