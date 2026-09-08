import type { Env, Principal } from './types.js';

/**
 * Account identity: users, login sessions, API tokens, single-use email links.
 *
 * The rule everything here follows: **the server never stores a value a client could
 * replay.** Passwords are PBKDF2 digests; every token — the login cookie, the reset link,
 * the API token — is generated with `crypto.getRandomValues`, handed to the client once,
 * and persisted only as its SHA-256 hash. Stealing this database gets an attacker nothing
 * they can present back to the service.
 */

const enc = new TextEncoder();

export const SESSION_COOKIE = 'sr_session';
export const SESSION_TTL_MS = 30 * 86_400_000;      // 30 days, absolute
export const REFRESH_AFTER_MS = 86_400_000;         // slide the expiry at most once a day
export const EMAIL_TOKEN_TTL_MS = 60 * 60_000;      // 1 hour: long enough to find the mail
export const API_TOKEN_PREFIX = 'srp_';

/** 256 bits from the CSPRNG, base64url. Guessing one is not a strategy. */
export function newToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Normalise before storing or comparing, so `Daniel@Example.com ` and `daniel@example.com`
 * cannot become two accounts. Everything downstream assumes this has run.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Deliberately permissive. Anything stricter rejects addresses that are legal and
 * deliverable; the real check is whether a verification email arrives.
 */
export function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export interface UserRow {
  user_id: string;
  email: string;
  email_verified_at: string | null;
  password_hash: string;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
  failed_attempts: number;
  locked_until: string | null;
}

// --- audit -------------------------------------------------------------------------

export type AuthEvent =
  | 'signup' | 'login_ok' | 'login_fail' | 'login_locked' | 'logout'
  | 'password_changed' | 'reset_requested' | 'reset_completed'
  | 'email_verified' | 'token_created' | 'token_revoked'
  | 'session_revoked' | 'account_deleted' | 'history_claimed' | 'rate_limited';

/**
 * Append-only record of who did what. Failures are swallowed on purpose: an audit write
 * that throws must not be able to block a logout or lock someone out of their account.
 */
export async function audit(
  env: Env, req: Request, event: AuthEvent,
  who: { userId?: string | null; email?: string | null } = {},
  detail?: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO auth_events (at, user_id, email, event, ip, user_agent, detail)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(
      new Date().toISOString(), who.userId ?? null, who.email ?? null, event,
      clientIp(req), (req.headers.get('User-Agent') ?? '').slice(0, 300), detail ?? null,
    ).run();
  } catch (err) {
    console.error('audit write failed', event, err);
  }
}

export const clientIp = (req: Request): string =>
  req.headers.get('CF-Connecting-IP') ?? req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';

// --- rate limiting -----------------------------------------------------------------

export interface RateLimit {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Fixed-window counter in D1.
 *
 * Kept in the database rather than in memory because Workers are stateless and spread
 * across colos — a per-isolate counter would reset constantly and limit nothing. A fixed
 * window lets up to 2x the limit straddle a boundary; that is a known and acceptable
 * imprecision for "slow down a password guesser", and simpler than a sliding log.
 */
export async function rateLimit(
  env: Env, bucket: string, limit: number, windowMs: number,
): Promise<RateLimit> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT count, window_start FROM rate_limits WHERE bucket = ?`,
  ).bind(bucket).first<{ count: number; window_start: string }>();

  const startedAt = row ? Date.parse(row.window_start) : 0;
  const fresh = !row || Number.isNaN(startedAt) || now - startedAt >= windowMs;

  if (fresh) {
    await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET count = 1, window_start = excluded.window_start`,
    ).bind(bucket, new Date(now).toISOString()).run();
    return { allowed: true, remaining: limit - 1, retryAfterSec: 0 };
  }

  const count = row.count + 1;
  await env.DB.prepare(`UPDATE rate_limits SET count = ? WHERE bucket = ?`).bind(count, bucket).run();
  const retryAfterSec = Math.max(1, Math.ceil((startedAt + windowMs - now) / 1000));
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSec };
}

/** Housekeeping for the nightly sweep; the table would otherwise grow without bound. */
export async function pruneAuthTables(env: Env): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM rate_limits WHERE window_start < ?`)
      .bind(new Date(Date.now() - 86_400_000).toISOString()),
    env.DB.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?`).bind(now),
    env.DB.prepare(`DELETE FROM auth_tokens WHERE expires_at < ?`).bind(now),
    // Ninety days of audit history: long enough to investigate, short enough that the
    // log does not itself become a long-lived record of someone's behaviour.
    env.DB.prepare(`DELETE FROM auth_events WHERE at < ?`)
      .bind(new Date(Date.now() - 90 * 86_400_000).toISOString()),
  ]);
}

// --- account lockout ---------------------------------------------------------------

export const MAX_FAILED_ATTEMPTS = 8;
export const LOCKOUT_MS = 15 * 60_000;

export function isLocked(user: UserRow): boolean {
  return Boolean(user.locked_until && Date.parse(user.locked_until) > Date.now());
}

export async function recordFailure(env: Env, user: UserRow): Promise<boolean> {
  const attempts = user.failed_attempts + 1;
  const lock = attempts >= MAX_FAILED_ATTEMPTS;
  await env.DB.prepare(
    `UPDATE users SET failed_attempts = ?, locked_until = ? WHERE user_id = ?`,
  ).bind(
    lock ? 0 : attempts,
    lock ? new Date(Date.now() + LOCKOUT_MS).toISOString() : user.locked_until,
    user.user_id,
  ).run();
  return lock;
}

export async function clearFailures(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE user_id = ?`,
  ).bind(userId).run();
}

// --- login sessions ----------------------------------------------------------------

export interface IssuedSession {
  token: string;
  expiresAt: string;
}

export async function createSession(env: Env, req: Request, userId: string): Promise<IssuedSession> {
  const token = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO auth_sessions (token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(
    await hashToken(token), userId, now.toISOString(), now.toISOString(), expiresAt,
    clientIp(req), (req.headers.get('User-Agent') ?? '').slice(0, 300),
  ).run();
  return { token, expiresAt };
}

export interface ResolvedSession {
  userId: string;
  tokenHash: string;
}

export async function resolveSession(env: Env, token: string): Promise<ResolvedSession | null> {
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare(
    `SELECT user_id, expires_at, revoked_at FROM auth_sessions WHERE token_hash = ?`,
  ).bind(tokenHash).first<{ user_id: string; expires_at: string; revoked_at: string | null }>();

  if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) return null;

  // Refresh at most daily. Writing on every request would turn each read into a write for
  // no benefit, and D1 writes are the expensive half.
  const shouldRefresh = Date.parse(row.expires_at) - Date.now() < SESSION_TTL_MS - REFRESH_AFTER_MS;
  if (shouldRefresh) {
    await env.DB.prepare(
      `UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?`,
    ).bind(
      new Date().toISOString(),
      new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      tokenHash,
    ).run();
  }
  return { userId: row.user_id, tokenHash };
}

export async function revokeSession(env: Env, tokenHash: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?`,
  ).bind(new Date().toISOString(), tokenHash).run();
}

/**
 * Cookie flags carry most of the session's security.
 *
 * HttpOnly keeps the value out of reach of any script, so an XSS bug cannot exfiltrate a
 * login the way it could read localStorage. SameSite=Strict means a request originating
 * from another site never carries it, which is the primary CSRF defence. Secure is
 * conditional only so that `wrangler dev` over plain http still works; every deployment
 * is https, so in production it is always set.
 */
export function sessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || null;
  }
  return null;
}

// --- API tokens --------------------------------------------------------------------

export interface IssuedApiToken {
  token: string;
  tokenHash: string;
}

export async function createApiToken(
  env: Env, userId: string, name: string, scope: 'read' | 'write', expiresAt: string | null,
): Promise<IssuedApiToken> {
  const token = `${API_TOKEN_PREFIX}${newToken()}`;
  const tokenHash = await hashToken(token);
  await env.DB.prepare(
    `INSERT INTO api_tokens (token_hash, user_id, name, scope, created_at, expires_at)
     VALUES (?,?,?,?,?,?)`,
  ).bind(tokenHash, userId, name.slice(0, 100), scope, new Date().toISOString(), expiresAt).run();
  return { token, tokenHash };
}

export interface ResolvedApiToken {
  userId: string;
  scope: 'read' | 'write';
}

export async function resolveApiToken(env: Env, token: string): Promise<ResolvedApiToken | null> {
  const row = await env.DB.prepare(
    `SELECT user_id, scope, expires_at, revoked_at FROM api_tokens WHERE token_hash = ?`,
  ).bind(await hashToken(token)).first<{
    user_id: string; scope: string; expires_at: string | null; revoked_at: string | null;
  }>();

  if (!row || row.revoked_at) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;

  // Best-effort usage stamp so a user can spot a token they no longer recognise.
  env.DB.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?`)
    .bind(new Date().toISOString(), await hashToken(token)).run()
    .catch(() => undefined);

  return { userId: row.user_id, scope: row.scope === 'write' ? 'write' : 'read' };
}

// --- single-use email links ---------------------------------------------------------

export async function createEmailToken(
  env: Env, userId: string, purpose: 'verify_email' | 'reset_password',
): Promise<string> {
  const token = newToken();
  // Only one live link per purpose: issuing a new reset must invalidate the previous one,
  // or an old email forwarded to the wrong person stays usable.
  await env.DB.prepare(
    `DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?`,
  ).bind(userId, purpose).run();
  await env.DB.prepare(
    `INSERT INTO auth_tokens (token_hash, user_id, purpose, created_at, expires_at)
     VALUES (?,?,?,?,?)`,
  ).bind(
    await hashToken(token), userId, purpose, new Date().toISOString(),
    new Date(Date.now() + EMAIL_TOKEN_TTL_MS).toISOString(),
  ).run();
  return token;
}

/** Consumes the token: valid exactly once, and only before it expires. */
export async function useEmailToken(
  env: Env, token: string, purpose: 'verify_email' | 'reset_password',
): Promise<string | null> {
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare(
    `SELECT user_id, expires_at, used_at FROM auth_tokens WHERE token_hash = ? AND purpose = ?`,
  ).bind(tokenHash, purpose).first<{ user_id: string; expires_at: string; used_at: string | null }>();

  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) return null;

  const { meta } = await env.DB.prepare(
    `UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`,
  ).bind(new Date().toISOString(), tokenHash).run();
  // Two concurrent redemptions race here; only the one that actually flipped the row wins.
  if (!meta?.changes) return null;

  return row.user_id;
}

/** Signing out everywhere. Used after a password change and on demand. */
export async function revokeAllSessions(env: Env, userId: string, except?: string): Promise<number> {
  const { meta } = await env.DB.prepare(
    `UPDATE auth_sessions SET revoked_at = ?
     WHERE user_id = ? AND revoked_at IS NULL AND token_hash != ?`,
  ).bind(new Date().toISOString(), userId, except ?? '').run();
  return meta?.changes ?? 0;
}

export const principalFor = (userId: string, deviceId: string): Principal => ({ userId, deviceId });
