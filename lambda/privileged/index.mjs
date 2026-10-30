// Privileged Cognito operations, kept out of the public-facing API function.
//
// Why this exists: AdminSetUserPassword + AdminInitiateAuth together can mint a session as
// any account, including the admin. Holding that on the same function that serves every
// anonymous GET means one bug there is a full account takeover. This function holds those
// permissions instead, is not reachable from the internet, and only accepts the handful of
// operations below. The API function may invoke it, nothing else may.
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  AdminDeleteUserCommand,
  AdminResetUserPasswordCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUserGlobalSignOutCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomBytes } from 'node:crypto';

const cognito = new CognitoIdentityProviderClient({});
const UserPoolId = process.env.USER_POOL_ID;
const ClientId = process.env.CLIENT_ID;

// Every account is Discord-native, so a pool username always looks like
// "discord-<Discord ID>@users.<site>.invalid" (the domain is set per site).
// Accounts created under an earlier domain of the site (DISCORD_EMAIL_LEGACY_DOMAINS) keep working.
const DOMAINS = [process.env.DISCORD_EMAIL_DOMAIN, ...String(process.env.DISCORD_EMAIL_LEGACY_DOMAINS || '').split(',')]
  .map((d) => String(d || '').toLowerCase()).filter(Boolean);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Without a configured domain nothing matches, so every operation is refused
const USERNAME_RE = DOMAINS.length ? new RegExp(`^discord-\\d{5,25}(?:${DOMAINS.map(escapeRe).join('|')})$`) : /(?!)/;
// Cognito subs as issued by this pool.
const UID_RE = /^[0-9a-fA-F-]{20,64}$/;

const checkUsername = (v) => {
  if (!USERNAME_RE.test(String(v ?? ''))) throw Object.assign(new Error('bad username'), { name: 'ValidationError' });
  return v;
};
const checkUid = (v) => {
  if (!UID_RE.test(String(v ?? ''))) throw Object.assign(new Error('bad uid'), { name: 'ValidationError' });
  return v;
};

const ops = {
  // Mint a Cognito session for a Discord-verified user (the caller does the verifying).
  async mintSession({ username }) {
    checkUsername(username);
    const Password = `Dc!${randomBytes(24).toString('base64url')}a1`;
    await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId, Username: username, Password, Permanent: true }));
    const r = await cognito.send(new AdminInitiateAuthCommand({
      UserPoolId,
      ClientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: username, PASSWORD: Password },
    }));
    return r.AuthenticationResult;
  },

  async createUser({ username, name }) {
    checkUsername(username);
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId,
      Username: username,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: username },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: String(name ?? '').slice(0, 40) },
      ],
    }));
    return { created: true };
  },

  async listUsers() {
    const users = [];
    let PaginationToken;
    do {
      const r = await cognito.send(new ListUsersCommand({ UserPoolId, Limit: 60, PaginationToken }));
      users.push(...(r.Users ?? []));
      PaginationToken = r.PaginationToken;
    } while (PaginationToken && users.length < 2000);
    return users;
  },

  async resetPassword({ uid }) {
    checkUid(uid);
    await cognito.send(new AdminResetUserPasswordCommand({ UserPoolId, Username: uid }));
    return { reset: true };
  },

  async setEnabled({ uid, enabled }) {
    checkUid(uid);
    await cognito.send(enabled
      ? new AdminEnableUserCommand({ UserPoolId, Username: uid })
      : new AdminDisableUserCommand({ UserPoolId, Username: uid }));
    return { enabled: Boolean(enabled) };
  },

  async globalSignOut({ uid }) {
    checkUid(uid);
    await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId, Username: uid }));
    return { signedOut: true };
  },

  async deleteUser({ uid }) {
    checkUid(uid);
    await cognito.send(new AdminDeleteUserCommand({ UserPoolId, Username: uid }));
    return { deleted: true };
  },
};

export const handler = async (event) => {
  const op = event?.op;
  const fn = Object.prototype.hasOwnProperty.call(ops, op) ? ops[op] : null;
  if (!fn) return { ok: false, name: 'UnknownOperation', message: `unknown operation: ${op}` };
  try {
    return { ok: true, result: await fn(event.args ?? {}) };
  } catch (e) {
    // Error names travel back so the caller can branch on them (UsernameExists, UserNotFound, ...)
    return { ok: false, name: e.name ?? 'Error', message: e.message ?? 'failed' };
  }
};
